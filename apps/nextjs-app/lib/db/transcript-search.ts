import "server-only";

import { db, items, itemTextChunks } from "@streamystats/database";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { getItemEmbeddingComparison } from "./embedding-comparison";
import { getStatisticsExclusions } from "./exclusions";
import { anyWording, saysWordForWord } from "./full-text";
import { rankWindowsByWords } from "./keyword-rank";
import {
  exactFirst,
  fuseChunkRankings,
  type TranscriptMatch,
} from "./transcript-rank";

export { formatTimestamp } from "./transcript-rank";

/**
 * Titles' best windows, best first; whether a window holds every word of the
 * query, and the titles whose dialogue says it word for word (first among
 * the matches, in their order): what a remembered line looks like (see plot
 * search).
 */
export type WindowMatches = TranscriptMatch[] & {
  complete: boolean;
  exact: string[];
};

/** Windows each ranking reads, at least; more when more titles are asked for. */
const POOL = 50;
const KIND_LITERALS = {
  transcript: "'transcript'",
  synopsis: "'synopsis'",
  reference: "'reference'",
} as const;

/**
 * Hybrid search over an item's text windows: full-text for exact wording
 * (quotes, names) and vectors for paraphrased memories, fused by rank. Only
 * libraries the user may see, and only items still in the library.
 * Transcript windows are dialogue, with when it is said; synopsis windows are
 * the plot: the synopsis whole and paragraph by paragraph (no times) and
 * each part of the scene notes (with its times); reference windows are the
 * plot from Wikipedia, whole and by paragraph.
 */
export async function searchTextWindows({
  kind,
  serverId,
  userId,
  query,
  embedding,
  limit,
}: {
  kind: "transcript" | "synopsis" | "reference";
  serverId: number;
  /** The viewer; omitted for admins, who see every library. */
  userId?: string;
  query: string;
  embedding: number[] | null;
  limit: number;
}): Promise<WindowMatches> {
  const { itemLibraryExclusion } = await getStatisticsExclusions(
    serverId,
    userId,
  );
  const visible: SQL[] = [
    eq(itemTextChunks.serverId, serverId),
    // A literal, not a parameter, so the planner can use that kind's own
    // partial HNSW index (one per kind and dimension).
    sql`${itemTextChunks.kind} = ${sql.raw(KIND_LITERALS[kind])}`,
    isNull(items.deletedAt),
  ];
  if (itemLibraryExclusion) visible.push(itemLibraryExclusion);

  const columns = {
    id: itemTextChunks.id,
    itemId: itemTextChunks.itemId,
    startMs: itemTextChunks.startMs,
    endMs: itemTextChunks.endMs,
    text: itemTextChunks.text,
  };
  const tsQuery = anyWording(query);
  // A title has several windows, so read enough of them for `limit` titles.
  const pool = Math.max(POOL, limit * 3);

  // By the query's words, weighted by how rare (see rankWindowsByWords).
  const textRanking = rankWindowsByWords({
    kind,
    serverId,
    query,
    visible,
    limit: pool,
    allWords: () =>
      db
        .select(columns)
        .from(itemTextChunks)
        .innerJoin(items, eq(items.id, itemTextChunks.itemId))
        .where(
          and(...visible, sql`${itemTextChunks.searchVector} @@ ${tsQuery}`),
        )
        .orderBy(
          desc(sql`ts_rank_cd(${itemTextChunks.searchVector}, ${tsQuery})`),
        )
        .limit(pool),
  });

  const vectorRanking = async () => {
    if (!embedding) return [];
    const { distance, dimensionFilter } = getItemEmbeddingComparison(
      embedding,
      itemTextChunks.embedding,
    );
    return db
      .select(columns)
      .from(itemTextChunks)
      .innerJoin(items, eq(items.id, itemTextChunks.itemId))
      .where(and(...visible, dimensionFilter))
      .orderBy(asc(distance))
      .limit(pool);
  };

  // Dialogue that says the query word for word: the words that count, in
  // order, as many words apart as in the query (Postgres's phrase match, on
  // the stemmed words the index keeps). Titles saying it come first: a
  // remembered line ranked by its words is often a few places down, under
  // titles that use the same words apart. Only with two words or more that
  // count; one is no phrase, and the word ranking has it already.
  // Those saying every word as typed, stopwords too, before those the phrase
  // query lets through with other words where the query has stopwords. Then
  // the earliest first: a line said word for word in several titles is
  // mostly a famous one the later titles quote ("You're gonna need a bigger
  // boat" in a dozen films and episodes after Jaws), or a catchphrase, first
  // said in the episode that coined it.
  const exactRanking = async () => {
    if (kind !== "transcript") return [];
    const phrase = anyWording(query, "phraseto_tsquery");
    return db
      .select(columns)
      .from(itemTextChunks)
      .innerJoin(items, eq(items.id, itemTextChunks.itemId))
      .where(
        and(
          ...visible,
          sql`numnode(phraseto_tsquery('english', ${query})) >= 3`,
          sql`${itemTextChunks.searchVector} @@ ${phrase}`,
        ),
      )
      .orderBy(
        desc(saysWordForWord(query, sql`${itemTextChunks.text}`)),
        // Undated titles last (ascending puts nulls last).
        asc(
          sql`coalesce(${items.premiereDate}, make_date(${items.productionYear}, 1, 1))`,
        ),
        desc(sql`ts_rank_cd(${itemTextChunks.searchVector}, ${phrase})`),
      )
      .limit(pool);
  };

  const [words, vectors, exact] = await Promise.all([
    textRanking,
    vectorRanking(),
    exactRanking(),
  ]);
  const fused = fuseChunkRankings([words.rows, vectors], limit);
  const sayers = fuseChunkRankings([exact], limit);
  return Object.assign(
    sayers.length > 0 ? exactFirst(sayers, fused, limit) : fused,
    { complete: words.complete, exact: sayers.map((m) => m.itemId) },
  );
}

/** What was said: the dialogue windows, with when. */
export function searchTranscripts(
  args: Omit<Parameters<typeof searchTextWindows>[0], "kind">,
): Promise<TranscriptMatch[]> {
  return searchTextWindows({ ...args, kind: "transcript" });
}

/** Item rows for matches, in match order. */
export async function getMatchedItems(itemIds: string[]) {
  if (itemIds.length === 0) return [];
  const rows = await db.select().from(items).where(inArray(items.id, itemIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return itemIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

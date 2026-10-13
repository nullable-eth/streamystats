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
import { fuseChunkRankings, type TranscriptMatch } from "./transcript-rank";

export { formatTimestamp } from "./transcript-rank";

const POOL = 50;

/**
 * Hybrid search over an item's text windows: full-text for exact wording
 * (quotes, names) and vectors for paraphrased memories, fused by rank. Only
 * libraries the user may see, and only items still in the library.
 * Transcript windows are dialogue, with when it is said; synopsis windows are
 * the plot, whole and paragraph by paragraph, with no timestamps.
 */
export async function searchTextWindows({
  kind,
  serverId,
  userId,
  query,
  embedding,
  limit,
}: {
  kind: "transcript" | "synopsis";
  serverId: number;
  /** The viewer; omitted for admins, who see every library. */
  userId?: string;
  query: string;
  embedding: number[] | null;
  limit: number;
}): Promise<TranscriptMatch[]> {
  const { itemLibraryExclusion } = await getStatisticsExclusions(
    serverId,
    userId,
  );
  const visible: SQL[] = [
    eq(itemTextChunks.serverId, serverId),
    // A literal, not a parameter, so the planner can use that kind's own
    // partial HNSW index (one per kind and dimension).
    sql`${itemTextChunks.kind} = ${sql.raw(kind === "synopsis" ? "'synopsis'" : "'transcript'")}`,
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
  const tsQuery = sql`websearch_to_tsquery('english', ${query})`;

  const textRanking = db
    .select(columns)
    .from(itemTextChunks)
    .innerJoin(items, eq(items.id, itemTextChunks.itemId))
    .where(and(...visible, sql`${itemTextChunks.searchVector} @@ ${tsQuery}`))
    .orderBy(desc(sql`ts_rank_cd(${itemTextChunks.searchVector}, ${tsQuery})`))
    .limit(POOL);

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
      .limit(POOL);
  };

  const rankings = await Promise.all([textRanking, vectorRanking()]);
  return fuseChunkRankings(rankings, limit);
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

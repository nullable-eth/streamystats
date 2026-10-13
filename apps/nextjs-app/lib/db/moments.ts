import "server-only";

import { db, items, itemTextChunks } from "@streamystats/database";
import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { getStatisticsExclusions } from "./exclusions";
import { findTitle } from "./synopsis-lookup";
import { bestLine, fuseByBestRank } from "./transcript-rank";

/** A point in a title where something is said, for jumping straight to it. */
export interface Moment {
  itemId: string;
  /** When the matching line starts; the window's start if no line matched. */
  startMs: number;
  /** The end of the dialogue window the moment is in. */
  endMs: number | null;
  /** "line": `startMs` is the matching line; "window": the window it is in. */
  precision: "line" | "window";
  /** The matching line of dialogue (two when it runs over a subtitle break). */
  line: string | null;
}

/**
 * Locate a moment to the line: among the transcript lines said within the
 * window, the one the query points at (see bestLine). Lines and their start
 * times are stored per transcript (content, one cue per line, and
 * cue_starts_ms); transcripts indexed before line times were kept have none
 * until their next check, and stay at window precision.
 */
export async function locateMoment(
  window: { itemId: string; startMs: number; endMs: number | null },
  query: string,
): Promise<Moment> {
  const rows = await db.execute<{ ms: number; text: string }>(sql`
    SELECT l.ms, l.text
    FROM item_texts t,
      unnest(string_to_array(t.content, E'\\n'), t.cue_starts_ms) AS l(text, ms)
    WHERE t.item_id = ${window.itemId}
      AND t.kind = 'transcript'
      AND t.cue_starts_ms IS NOT NULL
      AND l.ms >= ${window.startMs}
      AND l.ms <= ${window.endMs ?? window.startMs}
    ORDER BY l.ms
  `);
  const line = bestLine([...rows], query);
  return {
    itemId: window.itemId,
    startMs: line?.ms ?? window.startMs,
    endMs: window.endMs,
    precision: line ? "line" : "window",
    line: line?.text ?? null,
  };
}

/**
 * Where in some titles a query is said or happens, best first: their
 * dialogue windows ranked by exact wording and by meaning, each located to
 * the line. Searches every window of the titles exactly (no index), which is
 * cheap for one title or one series.
 */
export async function findMoments({
  serverId,
  itemIds,
  query,
  embedding,
  limit,
}: {
  serverId: number;
  itemIds: string[];
  query: string;
  embedding: number[] | null;
  limit: number;
}): Promise<Moment[]> {
  if (itemIds.length === 0) return [];
  const scope: SQL[] = [
    eq(itemTextChunks.serverId, serverId),
    sql`${itemTextChunks.kind} = 'transcript'`,
    inArray(itemTextChunks.itemId, itemIds),
  ];
  const columns = {
    id: itemTextChunks.id,
    itemId: itemTextChunks.itemId,
    startMs: itemTextChunks.startMs,
    endMs: itemTextChunks.endMs,
  };
  const tsQuery = sql`websearch_to_tsquery('english', ${query})`;
  // The words in the order given: a quoted line, not just its words scattered
  // over a window full of common ones.
  const phraseQuery = sql`phraseto_tsquery('english', ${query})`;
  const pool = Math.max(limit * 5, 20);

  const [byPhrase, byWords, byMeaning] = await Promise.all([
    db
      .select(columns)
      .from(itemTextChunks)
      .where(and(...scope, sql`${itemTextChunks.searchVector} @@ ${phraseQuery}`))
      .orderBy(
        desc(sql`ts_rank_cd(${itemTextChunks.searchVector}, ${phraseQuery})`),
      )
      .limit(pool),
    db
      .select(columns)
      .from(itemTextChunks)
      .where(and(...scope, sql`${itemTextChunks.searchVector} @@ ${tsQuery}`))
      .orderBy(
        desc(sql`ts_rank_cd(${itemTextChunks.searchVector}, ${tsQuery})`),
      )
      .limit(pool),
    embedding
      ? db
          .select(columns)
          .from(itemTextChunks)
          .where(
            and(
              ...scope,
              sql`vector_dims(${itemTextChunks.embedding}) = ${embedding.length}`,
            ),
          )
          // Not the indexed expression: an exact scan of these titles' windows.
          .orderBy(
            asc(
              sql`${itemTextChunks.embedding} <=> ${JSON.stringify(embedding)}::vector`,
            ),
          )
          .limit(pool)
      : Promise.resolve([]),
  ]);

  const windows = new Map(
    [...byPhrase, ...byWords, ...byMeaning].map((w) => [w.id, w]),
  );
  const ranked = fuseByBestRank(
    [byPhrase, byWords, byMeaning].map((list) => list.map((w) => String(w.id))),
    limit,
  );
  return Promise.all(
    ranked.flatMap(({ id }) => {
      const w = windows.get(Number(id));
      return w && w.startMs !== null
        ? [
            locateMoment(
              { itemId: w.itemId, startMs: w.startMs, endMs: w.endMs },
              query,
            ),
          ]
        : [];
    }),
  );
}

/**
 * The titles a moment search covers: a movie or episode by id, every episode
 * of a series, or (by title, for the chat) a movie, a series, one of its
 * seasons or one episode. Only titles the viewer may see.
 */
export async function momentScope({
  serverId,
  userId,
  itemId,
  title,
  season,
  episode,
}: {
  serverId: number;
  userId?: string;
  itemId?: string;
  title?: string;
  season?: number;
  episode?: number;
}): Promise<{ id: string; name: string; type: string }[]> {
  const { itemLibraryExclusion } = await getStatisticsExclusions(
    serverId,
    userId,
  );
  const visible: SQL[] = [
    eq(items.serverId, serverId),
    sql`${items.deletedAt} IS NULL`,
  ];
  if (itemLibraryExclusion) visible.push(itemLibraryExclusion);

  let target: { id: string; name: string; type: string } | undefined;
  if (itemId) {
    [target] = await db
      .select({ id: items.id, name: items.name, type: items.type })
      .from(items)
      .where(and(...visible, eq(items.id, itemId)))
      .limit(1);
  } else if (title) {
    target = (await findTitle({ serverId, userId, title })).match;
  }
  if (!target) return [];
  if (target.type !== "Series") return [target];

  const conditions: SQL[] = [
    ...visible,
    eq(items.type, "Episode"),
    eq(items.seriesId, target.id),
    gt(items.parentIndexNumber, 0),
  ];
  if (season !== undefined)
    conditions.push(eq(items.parentIndexNumber, season));
  if (episode !== undefined) conditions.push(eq(items.indexNumber, episode));
  return db
    .select({ id: items.id, name: items.name, type: items.type })
    .from(items)
    .where(and(...conditions));
}

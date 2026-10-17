import "server-only";

import { db, items, itemTextChunks } from "@streamystats/database";
import { and, asc, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import { wordings } from "@/lib/number-words";
import { getStatisticsExclusions } from "./exclusions";
import { anyWording } from "./full-text";
import { findTitle } from "./synopsis-lookup";
import { bestLine, fuseByBestRank } from "./transcript-rank";

/** A point in a title where something is said, for jumping straight to it. */
export interface Moment {
  itemId: string;
  /** When the matching line starts; the window's start if no line matched. */
  startMs: number;
  /** The end of the window (dialogue, or a scene) the moment is in. */
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
  // The query as typed first, then with its numbers in the other wording.
  const line = wordings(query)
    .map((w) => bestLine([...rows], w))
    .find(Boolean);
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
 * dialogue windows ranked by exact wording and by meaning, and their scene
 * notes (the plot part by part, with times) for what happens rather than
 * what is said, each located to the line within it. Searches every window
 * of the titles exactly (no index), which is cheap for one title or one
 * series.
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
    inArray(itemTextChunks.itemId, itemIds),
  ];
  const dialogue = sql`${itemTextChunks.kind} = 'transcript'`;
  // Scene notes are the plot windows with times; the synopsis has none.
  const scenes = sql`${itemTextChunks.kind} = 'synopsis' AND ${itemTextChunks.startMs} IS NOT NULL`;
  const columns = {
    id: itemTextChunks.id,
    itemId: itemTextChunks.itemId,
    startMs: itemTextChunks.startMs,
    endMs: itemTextChunks.endMs,
  };
  const tsQuery = anyWording(query);
  // The words in the order given: a quoted line, not just its words scattered
  // over a window full of common ones.
  const phraseQuery = anyWording(query, "phraseto_tsquery");
  const pool = Math.max(limit * 5, 20);

  const byText = (kind: SQL, match: SQL) =>
    db
      .select(columns)
      .from(itemTextChunks)
      .where(
        and(...scope, kind, sql`${itemTextChunks.searchVector} @@ ${match}`),
      )
      .orderBy(desc(sql`ts_rank_cd(${itemTextChunks.searchVector}, ${match})`))
      .limit(pool);
  const byMeaning = (kind: SQL) =>
    embedding
      ? db
          .select(columns)
          .from(itemTextChunks)
          .where(
            and(
              ...scope,
              kind,
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
      : Promise.resolve([]);

  const lists = await Promise.all([
    byText(dialogue, phraseQuery),
    byText(dialogue, tsQuery),
    byMeaning(dialogue),
    byText(scenes, tsQuery),
    byMeaning(scenes),
  ]);
  const windows = new Map(lists.flat().map((w) => [w.id, w]));
  // Twice as many as wanted: a scene and a dialogue window can lead to the
  // same line.
  const ranked = fuseByBestRank(
    lists.map((list) => list.map((w) => String(w.id))),
    limit * 2,
  );
  const located = await Promise.all(
    ranked.flatMap(({ id, rank }) => {
      const w = windows.get(Number(id));
      return w && w.startMs !== null
        ? [
            locateMoment(
              { itemId: w.itemId, startMs: w.startMs, endMs: w.endMs },
              query,
            ).then((moment) => ({ moment, rank })),
          ]
        : [];
    }),
  );
  // Of windows ranked alike, one with a line saying what the query asks
  // beats one that only reads like it: a stretch of "Oh! EVE. Whoa!" is near
  // any query naming EVE by meaning.
  const vague = (m: Moment) => Number(m.precision === "window");
  const seen = new Set<string>();
  return located
    .sort((a, b) => a.rank - b.rank || vague(a.moment) - vague(b.moment))
    .map(({ moment }) => moment)
    .filter((m) => {
      const key = `${m.itemId}:${m.startMs}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
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

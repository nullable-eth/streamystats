import "server-only";

import { db, items, itemTextChunks } from "@streamystats/database";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { getStatisticsExclusions } from "./exclusions";

export interface TitleMention {
  itemId: string;
  /** Matching windows of each kind, and whether the title or description matches. */
  dialogue: number;
  plot: number;
  wikipedia: number;
  description: boolean;
  /** The best matching dialogue and plot passages, the match in **bold**. */
  evidence: {
    source: "dialogue" | "plot";
    /** The dialogue window's span; null for plot passages. */
    startMs: number | null;
    endMs: number | null;
    text: string;
  }[];
}

/**
 * Every title whose dialogue, plot notes, Wikipedia plot, or title and
 * description mention a word or phrase (Postgres full text, so any word form:
 * "quantum computer" also finds "quantum computing"). Unlike the ranked
 * searches, nothing that matches is left out below `limit`. Titles mentioned
 * in their plot, Wikipedia plot or description come first (the topic is likely
 * central), then by how many passages mention it. Only items the viewer may see.
 */
export async function titlesMentioning({
  serverId,
  userId,
  phrase,
  types,
  limit,
}: {
  serverId: number;
  /** The viewer; omitted for admins, who see every library. */
  userId?: string;
  phrase: string;
  types: string[];
  limit: number;
}): Promise<{ total: number; titles: TitleMention[] }> {
  const { itemLibraryExclusion } = await getStatisticsExclusions(
    serverId,
    userId,
  );
  const visible: SQL[] = [
    eq(items.serverId, serverId),
    isNull(items.deletedAt),
    inArray(items.type, types),
  ];
  if (itemLibraryExclusion) visible.push(itemLibraryExclusion);
  const query = sql`websearch_to_tsquery('english', ${phrase})`;

  const rows = await db.execute<{
    id: string;
    dialogue: number;
    plot: number;
    wikipedia: number;
    description: boolean;
    total: number;
  }>(sql`
    WITH windows AS (
      SELECT ${itemTextChunks.itemId} AS item_id,
        count(*) FILTER (WHERE ${itemTextChunks.kind} = 'transcript')::int AS dialogue,
        count(*) FILTER (WHERE ${itemTextChunks.kind} = 'synopsis')::int AS plot,
        count(*) FILTER (WHERE ${itemTextChunks.kind} = 'reference')::int AS wikipedia
      FROM ${itemTextChunks}
      WHERE ${itemTextChunks.serverId} = ${serverId}
        AND ${itemTextChunks.searchVector} @@ ${query}
      GROUP BY 1)
    SELECT ${items.id} AS id,
      coalesce(w.dialogue, 0) AS dialogue,
      coalesce(w.plot, 0) AS plot,
      coalesce(w.wikipedia, 0) AS wikipedia,
      coalesce(${items.searchVector} @@ ${query}, false) AS description,
      count(*) OVER ()::int AS total
    FROM ${items}
    LEFT JOIN windows w ON w.item_id = ${items.id}
    WHERE ${and(...visible)}
      AND (w.item_id IS NOT NULL OR ${items.searchVector} @@ ${query})
    ORDER BY (coalesce(w.plot, 0) + coalesce(w.wikipedia, 0) > 0
              OR coalesce(${items.searchVector} @@ ${query}, false)) DESC,
      coalesce(w.dialogue, 0) + coalesce(w.plot, 0) + coalesce(w.wikipedia, 0) DESC
    LIMIT ${limit}
  `);
  const found = Array.from(rows);
  if (found.length === 0) return { total: 0, titles: [] };

  // Each title's best dialogue window and best plot window (notes or Wikipedia).
  const passages = await db.execute<{
    item_id: string;
    kind: string;
    start_ms: number | null;
    end_ms: number | null;
    text: string;
  }>(sql`
    SELECT DISTINCT ON (${itemTextChunks.itemId}, ${itemTextChunks.kind} = 'transcript')
      ${itemTextChunks.itemId} AS item_id, ${itemTextChunks.kind} AS kind,
      ${itemTextChunks.startMs} AS start_ms, ${itemTextChunks.endMs} AS end_ms,
      ts_headline('english', ${itemTextChunks.text}, ${query},
        'MaxWords=30, MinWords=12, MaxFragments=1, StartSel=**, StopSel=**') AS text
    FROM ${itemTextChunks}
    WHERE ${inArray(
      itemTextChunks.itemId,
      found.map((r) => r.id),
    )}
      AND ${itemTextChunks.searchVector} @@ ${query}
    ORDER BY ${itemTextChunks.itemId}, ${itemTextChunks.kind} = 'transcript',
      ts_rank_cd(${itemTextChunks.searchVector}, ${query}) DESC
  `);
  const evidence = new Map<string, TitleMention["evidence"]>();
  for (const p of passages) {
    const list = evidence.get(p.item_id) ?? [];
    list.push({
      source: p.kind === "transcript" ? "dialogue" : "plot",
      startMs: p.kind === "transcript" ? p.start_ms : null,
      endMs: p.kind === "transcript" ? p.end_ms : null,
      text: p.text,
    });
    evidence.set(p.item_id, list);
  }

  return {
    total: found[0].total,
    titles: found.map((r) => ({
      itemId: r.id,
      dialogue: r.dialogue,
      plot: r.plot,
      wikipedia: r.wikipedia,
      description: r.description,
      evidence: evidence.get(r.id) ?? [],
    })),
  };
}

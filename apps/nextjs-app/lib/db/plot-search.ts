import "server-only";

import { db, items, libraries } from "@streamystats/database";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { getItemEmbeddingComparison } from "./embedding-comparison";
import { getStatisticsExclusions } from "./exclusions";
import { locateMoment } from "./moments";
import type { SearchResult } from "./search";
import {
  type ItemResultRow,
  itemResultColumns,
  toItemResult,
} from "./search-result";
import { fuseByBestRank, type TranscriptMatch } from "./transcript-rank";
import { searchTextWindows } from "./transcript-search";

export type PlotSearchType = "Movie" | "Series" | "Episode";

const POOL = 50;

/**
 * Titles that match a description of their story, best first. Three rankings
 * are fused: the item vectors (overview, details and, once the knowledge
 * index has written one, the plot synopsis), the plot windows (the synopsis
 * whole and by paragraph, and the scene notes part by part, so one plot
 * point can match) and the transcript windows (what was said), each title by
 * its best rank in any of them: a title one ranking puts first is not buried
 * under titles several rankings put halfway down. Only items the viewer may
 * see.
 *
 * A title found through its dialogue or its scene notes carries the moment
 * in `metadata`, from whichever of the two ranked it higher: `momentMs`
 * (when the matching line, or its window, starts) and `momentPrecision`
 * ("line" or "window"), so a client can start playback there.
 */
export async function searchByPlot({
  serverId,
  viewerUserId,
  query,
  embedding,
  types,
  limit,
}: {
  serverId: number;
  viewerUserId?: string;
  query: string;
  embedding: number[];
  types: PlotSearchType[];
  limit: number;
}): Promise<SearchResult[]> {
  if (types.length === 0) return [];

  const { itemLibraryExclusion } = await getStatisticsExclusions(
    serverId,
    viewerUserId,
  );
  const visible: SQL[] = [
    eq(items.serverId, serverId),
    isNull(items.deletedAt),
    inArray(items.type, types),
  ];
  if (itemLibraryExclusion) visible.push(itemLibraryExclusion);

  const { distance, dimensionFilter } = getItemEmbeddingComparison(embedding);
  // Only movies and episodes have transcripts and synopses.
  const hasTexts = types.some((t) => t !== "Series");
  const windows = (kind: "synopsis" | "transcript") =>
    hasTexts
      ? searchTextWindows({
          kind,
          serverId,
          userId: viewerUserId,
          query,
          embedding,
          limit: POOL,
        })
      : Promise.resolve([]);
  const [byStory, byPlot, byDialogue] = await Promise.all([
    db
      .select({ id: items.id })
      .from(items)
      .where(and(...visible, dimensionFilter))
      .orderBy(asc(distance))
      .limit(POOL),
    windows("synopsis"),
    windows("transcript"),
  ]);

  const fused = fuseByBestRank(
    [
      byStory.map((r) => r.id),
      byPlot.map((m) => m.itemId),
      byDialogue.map((m) => m.itemId),
    ],
    POOL * 3,
  );
  if (fused.length === 0) return [];

  // The visibility filter again: window matches are not filtered by type.
  const rows = await db.execute<ItemResultRow>(sql`
    SELECT ${itemResultColumns}
    FROM ${items}
    LEFT JOIN ${libraries} ON ${items.libraryId} = ${libraries.id}
    WHERE ${and(
      inArray(
        items.id,
        fused.map((f) => f.id),
      ),
      ...visible,
    )}
  `);
  const byId = new Map([...rows].map((row) => [row.id, row]));
  const results = fused
    .flatMap(({ id, score }) => {
      const row = byId.get(id);
      return row ? [toItemResult(row, score)] : [];
    })
    .slice(0, limit);

  // Each title's best timed window: a dialogue window, or a scene of its
  // notes (synopsis windows have no times), from the higher of the two.
  const timed = new Map<string, TranscriptMatch["moments"][number]>();
  const byRank = [byDialogue, byPlot]
    .flatMap((list) => list.map((match, rank) => ({ match, rank })))
    .sort((a, b) => a.rank - b.rank);
  for (const { match } of byRank) {
    const window = match.moments.find((w) => w.startMs !== null);
    if (window && !timed.has(match.itemId)) timed.set(match.itemId, window);
  }
  return Promise.all(
    results.map(async (result) => {
      const window = timed.get(result.id);
      if (!window || window.startMs === null) return result;
      const moment = await locateMoment(
        { itemId: result.id, startMs: window.startMs, endMs: window.endMs },
        query,
      );
      return {
        ...result,
        metadata: {
          ...result.metadata,
          momentMs: String(moment.startMs),
          momentPrecision: moment.precision,
        },
      };
    }),
  );
}

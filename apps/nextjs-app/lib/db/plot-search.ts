import "server-only";

import { db, items, libraries } from "@streamystats/database";
import { and, asc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { getItemEmbeddingComparison } from "./embedding-comparison";
import { getStatisticsExclusions } from "./exclusions";
import type { SearchResult } from "./search";
import {
  type ItemResultRow,
  itemResultColumns,
  toItemResult,
} from "./search-result";
import { fuseItemRankings } from "./transcript-rank";
import { searchTranscripts } from "./transcript-search";

export type PlotSearchType = "Movie" | "Series" | "Episode";

const POOL = 50;

/**
 * Titles that match a description of their story, best first. Two rankings
 * are fused: the item vectors (overview, details and, once the knowledge
 * index has written one, the plot synopsis) and the transcript windows (what
 * was said). Only items the viewer may see.
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
  const [byStory, byDialogue] = await Promise.all([
    db
      .select({ id: items.id })
      .from(items)
      .where(and(...visible, dimensionFilter))
      .orderBy(asc(distance))
      .limit(POOL),
    // Only movies and episodes have transcripts.
    types.some((t) => t !== "Series")
      ? searchTranscripts({
          serverId,
          userId: viewerUserId,
          query,
          embedding,
          limit: POOL,
        })
      : [],
  ]);

  const fused = fuseItemRankings(
    [byStory.map((r) => r.id), byDialogue.map((m) => m.itemId)],
    POOL * 2,
  );
  if (fused.length === 0) return [];

  // The visibility filter again: transcript matches are not filtered by type.
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
  return fused
    .flatMap(({ id, score }) => {
      const row = byId.get(id);
      return row ? [toItemResult(row, score)] : [];
    })
    .slice(0, limit);
}

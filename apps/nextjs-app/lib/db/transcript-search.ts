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
 * Hybrid search over transcript windows: full-text for exact wording (quotes,
 * names) and vectors for paraphrased memories, fused by rank. Only libraries
 * the user may see, and only items still in the library.
 */
export async function searchTranscripts({
  serverId,
  userId,
  query,
  embedding,
  limit,
}: {
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
    isNull(items.deletedAt),
  ];
  if (itemLibraryExclusion) visible.push(itemLibraryExclusion);

  const columns = {
    id: itemTextChunks.id,
    itemId: itemTextChunks.itemId,
    startMs: itemTextChunks.startMs,
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

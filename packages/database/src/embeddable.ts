import { inArray, sql, type SQL } from "drizzle-orm";
import { items } from "./schema";

/** Item types that can get an item embedding. */
export const EMBEDDABLE_ITEM_TYPES = ["Movie", "Series", "Episode"] as const;
/** Item types with their own subtitles: transcripts and synopses. */
export const KNOWLEDGE_ITEM_TYPES = ["Movie", "Episode"] as const;

/**
 * Items that get an embedding: the selected types (all three by default),
 * still in the library. Episodes are where a faint memory usually points
 * ("the one where they swap bodies"), and a rated episode says which
 * *content* a viewer liked. Soft-deleted items are neither embedded nor
 * counted.
 */
export function embeddableItemCondition(
  types: readonly string[] = EMBEDDABLE_ITEM_TYPES
): SQL {
  if (types.length === 0) return sql`false`;
  return sql`(${inArray(items.type, [...types])} AND ${items.deletedAt} IS NULL)`;
}

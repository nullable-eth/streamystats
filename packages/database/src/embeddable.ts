import { sql, type SQL } from "drizzle-orm";
import { items } from "./schema";

/**
 * Items that get an embedding: every movie, series and episode. Episodes are
 * where a faint memory usually points ("the one where they swap bodies"), and
 * a rated episode says which *content* a viewer liked, which only that
 * episode's own embedding can capture.
 */
export function embeddableItemCondition(): SQL {
  return sql`${items.type} IN ('Movie', 'Series', 'Episode')`;
}

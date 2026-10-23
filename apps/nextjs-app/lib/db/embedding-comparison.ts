import { items } from "@streamystats/database/schema";
import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export function getItemEmbeddingComparison(
  embedding: number[],
  column: AnyPgColumn = items.embedding,
) {
  if (embedding.length === 0 || !embedding.every(Number.isFinite)) {
    throw new Error("Embedding must contain finite numbers");
  }

  // PostgreSQL requires literal type modifiers. Use the same dimension literal
  // in the predicate so prepared queries can match the partial HNSW index.
  const dimensions = sql.raw(String(embedding.length));

  return {
    distance: sql<number>`(${column}::vector(${dimensions})) <=> (${JSON.stringify(embedding)}::vector(${dimensions}))`,
    dimensionFilter: sql`vector_dims(${column}) = ${dimensions}`,
  };
}

import "server-only";

import { type SQL, sql } from "drizzle-orm";
import { wordings } from "@/lib/number-words";

/**
 * A full-text query that matches the phrase in any of its wordings, numbers
 * as digits or as words (see wordings): "60% of the time" also finds
 * "Sixty percent of the time". Parsed as a web search, or as the words in
 * order with `phraseto_tsquery`.
 */
export function anyWording(
  phrase: string,
  parse: "websearch_to_tsquery" | "phraseto_tsquery" = "websearch_to_tsquery",
): SQL {
  const queries = wordings(phrase).map(
    (w) => sql`${sql.raw(parse)}('english', ${w})`,
  );
  return sql`(${sql.join(queries, sql` || `)})`;
}

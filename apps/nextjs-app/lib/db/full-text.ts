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

/** Text as its words: lowercase, one space apart and on either side. */
const asWords = (text: SQL) =>
  sql`(' ' || btrim(regexp_replace(lower(translate(${text}, '’‘', '''''')), '[^[:alnum:]'']+', ' ', 'g')) || ' ')`;

/**
 * Whether `text` says the phrase word for word in any of its wordings: every
 * word as typed, stopwords too, in order, with case and punctuation aside.
 * Stricter than a phrase query, which keeps only the words that count and
 * lets any word stand where the phrase has a stopword: "I will look for you,
 * I will find you" matches "Where would you look? The ghetto. I'll find
 * him".
 */
export function saysWordForWord(phrase: string, text: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM unnest(${sql.param(wordings(phrase))}::text[]) AS w(phrase)
    WHERE position(${asWords(sql`w.phrase`)} IN ${asWords(text)}) > 0)`;
}

/**
 * Whether `text` may say the phrase word for word: its words in order, with
 * anything between, in any of its wordings (ILIKE, so cheap enough to rule
 * out most texts before saysWordForWord reads each one as words).
 */
export function hasWordsInOrder(phrase: string, text: SQL): SQL {
  const patterns = wordings(phrase).map(
    (w) =>
      `%${(w.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).join("%").replaceAll("'", "_")}%`,
  );
  return sql`${text} ILIKE ANY (${sql.param(patterns)}::text[])`;
}

import "server-only";

import { COMMON_TERM_WINDOWS, db } from "@streamystats/database";
import { and, type SQL, sql } from "drizzle-orm";
import { wordings } from "@/lib/number-words";

export type WindowRow = {
  id: number;
  itemId: string;
  startMs: number | null;
  endMs: number | null;
  text: string;
};

/** Windows of a ranking, and whether any window holds every word of the query. */
export interface WordRanking {
  rows: WindowRow[];
  complete: boolean;
}

/** Windows scored on their rare words, before the rest of the words are counted in. */
const CANDIDATES = 2000;
/** The number of windows of a kind, when it hasn't been counted yet (only the scale of the weights). */
const UNCOUNTED_WINDOWS = 100_000;

/** A stemmed word as a tsquery operand. */
const tsquery = (term: string) => `'${term.replace(/'/g, "''")}'`;

/**
 * Windows of one kind ranked by the words of a query, each weighted by how
 * rare it is among that kind's windows (an inverse document frequency, as in
 * BM25), so a window needs some of the words, not all of them. Postgres's own
 * full-text query wants every word (websearch_to_tsquery joins them with AND),
 * which no window of a sentence-long description holds, and it ranks without
 * any notion of rarity (ts_rank_cd), so "Why so serious?" weighs the same in
 * all of the 19,000 windows that say "serious".
 *
 * The query's words are stemmed as the index stems them, in every number
 * wording (see wordings). Windows are found through their rare words: those
 * in no more than COMMON_TERM_WINDOWS windows of the kind (the common ones are
 * counted daily into item_text_common_terms; a word found more often than that
 * is set aside here too). The best CANDIDATES of them are then scored on all
 * the query's words, and a window holding every one of them (in one of the
 * query's wordings) scores double; between equals, the one with the words
 * closest together (ts_rank_cd).
 * With no rare word ("Why so serious?" is only "serious"), `allWords` ranks:
 * the windows with every word, as Postgres ranks them.
 *
 * `kind` is spliced in as a literal, so the kind's own full-text index is
 * used; `visible` limits the windows to those the viewer may see (it may name
 * item_text_chunks and items).
 */
export async function rankWindowsByWords({
  kind,
  serverId,
  query,
  visible,
  limit,
  allWords,
}: {
  kind: "transcript" | "synopsis" | "reference";
  serverId: number;
  query: string;
  visible: SQL[];
  limit: number;
  allWords: () => Promise<WindowRow[]>;
}): Promise<WordRanking> {
  // Each wording's words, as the index stems them.
  const worded = Array.from(
    await db.execute<{ wording: number; term: string }>(sql`
      SELECT DISTINCT w.n::int AS wording, unnest(tsvector_to_array(to_tsvector('english', w.text))) AS term
      FROM unnest(${sql.param(wordings(query))}::text[]) WITH ORDINALITY AS w(text, n)`),
  );
  const terms = [...new Set(worded.map((r) => r.term))];
  if (terms.length === 0) return { rows: [], complete: false };

  const counted = new Map(
    Array.from(
      await db.execute<{ term: string; windows: number }>(sql`
        SELECT term, windows FROM item_text_common_terms
        WHERE kind = ${kind} AND (term = '' OR term = ANY(${sql.param(terms)}::text[]))`),
    ).map((r) => [r.term, Number(r.windows)]),
  );
  const total = counted.get("") ?? UNCOUNTED_WINDOWS;
  const common = terms.filter((t) => counted.has(t));
  const rare = terms.filter((t) => !counted.has(t));
  if (rare.length === 0) {
    const rows = await allWords();
    return { rows, complete: rows.length > 0 };
  }

  const k = sql.raw(`'${kind}'`);
  const rows = Array.from(
    await db.execute<WindowRow & { complete: boolean }>(sql`
      WITH hits AS (
        SELECT t.term, x.id
        FROM unnest(${sql.param(rare.map(tsquery))}::text[], ${sql.param(rare)}::text[]) AS t(query, term)
        CROSS JOIN LATERAL (
          SELECT c.id FROM item_text_chunks c
          WHERE c.kind = ${k} AND c.server_id = ${serverId} AND c.search_vector @@ t.query::tsquery
          LIMIT ${COMMON_TERM_WINDOWS + 1}::int
        ) AS x
      ),
      found AS (SELECT term, count(*) AS n FROM hits GROUP BY term),
      weights AS (
        SELECT term, ln((${total}::float8 + 1) / (least(n, ${total}::float8) + 1)) AS w FROM found
        UNION ALL
        SELECT term, ln((${total}::float8 + 1) / (least(n, ${total}::float8) + 1))
        FROM unnest(${sql.param(common)}::text[], ${sql.param(common.map((t) => counted.get(t) ?? 0))}::int[]) AS t(term, n)
      ),
      -- Each wording's words that occur in the kind at all (one in none, a
      -- misspelling say, can't be held). Words go together by wording: "60%
      -- of the time" is there as "sixty percent of the time", no "60" beside.
      worded AS (
        SELECT t.wording, t.term
        FROM unnest(${sql.param(worded.map((r) => r.wording))}::int[], ${sql.param(worded.map((r) => r.term))}::text[]) AS t(wording, term)
        JOIN weights USING (term)
      ),
      candidates AS (
        SELECT h.id FROM hits h JOIN found f USING (term) JOIN weights w USING (term)
        WHERE f.n <= ${COMMON_TERM_WINDOWS}::int
        GROUP BY h.id ORDER BY sum(w.w) DESC, h.id LIMIT ${CANDIDATES}::int
      ),
      scored AS (
        SELECT c.id,
          (SELECT coalesce(sum(w.w), 0) FROM weights w WHERE w.term = ANY (v.lexemes)) AS score,
          coalesce((SELECT bool_or(g.held) FROM (
            SELECT bool_and(wd.term = ANY (v.lexemes)) AS held FROM worded wd GROUP BY wd.wording) g), false) AS complete,
          -- Between windows with the same words: the one with them closest together.
          coalesce(ts_rank_cd(x.search_vector, (
            SELECT string_agg('(' || g.terms || ')', ' | ') FROM (
              SELECT string_agg(quote_literal(wd.term), ' & ') AS terms FROM worded wd GROUP BY wd.wording) g)::tsquery), 0) AS near
        FROM candidates c
        JOIN item_text_chunks x ON x.id = c.id
        CROSS JOIN LATERAL (SELECT tsvector_to_array(x.search_vector) AS lexemes) AS v
      )
      SELECT item_text_chunks.id, item_text_chunks.item_id AS "itemId",
             item_text_chunks.start_ms AS "startMs", item_text_chunks.end_ms AS "endMs",
             item_text_chunks.text, s.complete
      FROM scored s
      JOIN item_text_chunks ON item_text_chunks.id = s.id
      JOIN items ON items.id = item_text_chunks.item_id
      WHERE ${and(...visible)}
      ORDER BY s.score * (CASE WHEN s.complete THEN 2 ELSE 1 END) DESC, s.near DESC, item_text_chunks.id
      LIMIT ${limit}::int`),
  );
  return {
    rows: rows.map(({ complete: _, ...row }) => row),
    complete: rows.some((r) => r.complete),
  };
}

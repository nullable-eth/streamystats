import { COMMON_TERM_WINDOWS, db } from "@streamystats/database";
import { sql } from "drizzle-orm";

/** The kinds of search window (see knowledge-jobs.ts). */
const KINDS = ["transcript", "synopsis", "reference"] as const;
/** How old the word counts may get before they are counted again. */
const REFRESH_AFTER_MS = 20 * 60 * 60_000;

let indexesEnsured = false;

/**
 * A full-text (GIN) index per kind of window, beside the one over all of
 * them: keyword search looks a word up in one kind, and in the shared index
 * a word rare in the plot windows can have thousands of matches in the
 * dialogue to wade through. Built CONCURRENTLY, so searches and the job go
 * on meanwhile (a few minutes on a large library); one left invalid by an
 * interrupted build is rebuilt.
 */
export async function ensureSearchIndexes(): Promise<void> {
  if (indexesEnsured) return;
  for (const kind of KINDS) {
    const name = `item_text_chunks_${kind}_search_idx`;
    const [row] = Array.from(
      await db.execute<{ valid: boolean }>(sql`
        SELECT ix.indisvalid AS valid FROM pg_class c JOIN pg_index ix ON ix.indexrelid = c.oid WHERE c.relname = ${name}`)
    );
    if (row?.valid) continue;
    if (row) await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`));
    await db.execute(
      sql.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name} ON item_text_chunks USING gin (search_vector) WHERE kind = '${kind}'`)
    );
  }
  indexesEnsured = true;
}

/**
 * The words too common to rank by, counted again for each kind whose counts
 * are missing or older than REFRESH_AFTER_MS: every word in more than
 * COMMON_TERM_WINDOWS of its windows, and under the empty word the number of
 * windows (see item_text_common_terms). One pass of ts_stat over the kind's
 * full-text vectors: about a minute for half a million dialogue windows.
 * Returns the kinds counted.
 */
export async function refreshCommonTerms(force = false): Promise<string[]> {
  const fresh = new Map(
    Array.from(
      await db.execute<{ kind: string; at: Date }>(sql`
        SELECT kind, min(refreshed_at) AS at FROM item_text_common_terms GROUP BY kind`)
    ).map((r) => [r.kind, new Date(r.at).getTime()])
  );
  const counted: string[] = [];
  for (const kind of KINDS) {
    const at = fresh.get(kind);
    if (!force && at !== undefined && Date.now() - at < REFRESH_AFTER_MS) continue;
    const stat = `SELECT search_vector FROM item_text_chunks WHERE kind = '${kind}'`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM item_text_common_terms WHERE kind = ${kind}`);
      await tx.execute(sql`
        INSERT INTO item_text_common_terms (kind, term, windows)
        SELECT ${kind}, word, ndoc FROM ts_stat(${stat}) WHERE ndoc > ${COMMON_TERM_WINDOWS}`);
      await tx.execute(sql`
        INSERT INTO item_text_common_terms (kind, term, windows)
        SELECT ${kind}, '', count(*)::int FROM item_text_chunks WHERE kind = ${kind}`);
    });
    counted.push(kind);
  }
  return counted;
}

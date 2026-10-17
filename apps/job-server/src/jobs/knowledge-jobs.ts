import { createHash } from "node:crypto";
import {
  db,
  itemTextChunks,
  itemTexts,
  items,
  type ItemText,
  KNOWLEDGE_ITEM_TYPES,
  servers,
} from "@streamystats/database";
import { and, eq, sql } from "drizzle-orm";
import { JellyfinClient } from "../jellyfin/client";
import {
  type EmbeddingSettings,
  embedTexts,
  getEmbeddingSettings,
} from "../knowledge/embed";
import {
  chunkCues,
  cleanCues,
  type Cue,
  MIN_TRANSCRIPT_WORDS,
  parseSrt,
  rankTranscriptStreams,
  wordCount,
} from "../knowledge/subtitles";
import {
  getKnowledgeModels,
  isUsable,
  type KnowledgeModel,
  modelLabel,
  parallelOf,
  rewritesOf,
  writePlotWithModels,
  writersFor,
} from "../knowledge/models";
import {
  characterNames,
  formatScenes,
  parseScenes,
  sceneWindows,
  synopsisWindows,
  transcriptParts,
} from "../knowledge/synopsis";
import { articlesByImdbId, plotsOf } from "../knowledge/wikipedia";
import type { PgBossJob, ServerIdJobData } from "../types/job-status";
import { logJobResult } from "./job-logger";

export const KNOWLEDGE_INDEX_JOB_NAME = "knowledge-index-sync";

/** Leave room under the queue's 2h expiry; the next run continues. */
const RUN_BUDGET_MS = 90 * 60_000;
const ITEMS_PER_QUERY = 25;
const EMBED_BATCH = 32;
const MAX_TRACKS_TRIED = 3;

type Outcome = "indexed" | "unchanged" | "missing";

type ItemRow = {
  id: string;
  name: string;
  type: string;
  series_name: string | null;
  parent_index_number: number | null;
  index_number: number | null;
  production_year: number | null;
  overview: string | null;
};

type DueItem = ItemRow & {
  imdb_id: string | null;
  /** Its Wikipedia plot is to be looked up (again). */
  reference_due: boolean;
};

/** Dialogue; the plot as the model wrote it; the plot as people wrote it (Wikipedia's). */
type WindowKind = "transcript" | "synopsis" | "reference";

const ensuredIndexes = new Set<string>();

/**
 * Partial HNSW index per dimension, as for items.embedding, and per kind of
 * window: dialogue and plot summaries sit in different parts of the vector
 * space, and one shared graph searched with a kind filter missed the best
 * synopsis windows entirely. Replaces the earlier shared index.
 */
function ensureChunkIndex(dimensions: number, kind: WindowKind): Promise<void> {
  // One at a time: titles are indexed concurrently with a hosted model.
  const run = indexing.then(() => createChunkIndex(dimensions, kind));
  indexing = run.catch(() => {});
  return run;
}
let indexing = Promise.resolve();

async function createChunkIndex(dimensions: number, kind: WindowKind): Promise<void> {
  const key = `${kind}:${dimensions}`;
  if (ensuredIndexes.has(key)) return;
  const n = sql.raw(String(dimensions));
  await db.execute(sql`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${sql.raw(`item_text_chunks_${kind}_embedding_${dimensions}_idx`)}
    ON item_text_chunks USING hnsw ((embedding::vector(${n})) vector_cosine_ops)
    WHERE vector_dims(embedding) = ${n} AND kind = ${sql.raw(`'${kind}'`)}
  `);
  ensuredIndexes.add(key);
  if (ensuredIndexes.has(`transcript:${dimensions}`) && ensuredIndexes.has(`synopsis:${dimensions}`)) {
    await db.execute(
      sql`DROP INDEX CONCURRENTLY IF EXISTS ${sql.raw(`item_text_chunks_embedding_${dimensions}_idx`)}`
    );
  }
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Embed in batches; the window index for the dimension exists afterwards. */
async function embedAll(
  embedding: EmbeddingSettings,
  texts: string[],
  kind: WindowKind
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    vectors.push(...(await embedTexts(embedding, texts.slice(i, i + EMBED_BATCH))));
  }
  for (const d of new Set(vectors.map((v) => v.length))) await ensureChunkIndex(d, kind);
  return vectors;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function titleOf(item: ItemRow): string {
  if (item.type !== "Episode") {
    return item.production_year ? `${item.name} (${item.production_year})` : item.name;
  }
  const s = String(item.parent_index_number ?? 0).padStart(2, "0");
  const e = String(item.index_number ?? 0).padStart(2, "0");
  return `${item.series_name ?? "Unknown series"} S${s}E${e} "${item.name}"`;
}

/** What scene notes are written from, kept as their source: the transcript, and the Wikipedia plot when there was one. */
const plotBasis = (transcriptHash: string, reference: ItemText | undefined) =>
  reference?.status === "ready" && reference.contentHash ? `${transcriptHash}:${reference.contentHash}` : transcriptHash;

/**
 * Selected movies/episodes that need work: never looked at; no usable subtitle a
 * day ago (a subtitle downloader may have fetched one since); a weekly re-check for upgraded
 * subtitles; a transcript indexed before line timings were kept; scene
 * notes (and the synopsis written with them) that one of the `usable` models
 * writes (see writersFor): missing, or by a writer one was asked to replace;
 * or, with Wikipedia plots on, a plot never looked up, missing for a month
 * (an article may have been written since) or three months old. Notes whose writing
 * failed wait a day; titles already taken this run (`taken`) wait for the next.
 */
async function dueItems(
  serverId: number,
  types: readonly string[],
  usable: KnowledgeModel[],
  withReferences: boolean,
  taken: Set<string>
): Promise<DueItem[]> {
  const allowed: readonly string[] = KNOWLEDGE_ITEM_TYPES;
  const selected = types.filter((t) => allowed.includes(t));
  if (selected.length === 0) return [];
  const replaced = rewritesOf(usable);
  const rewrite = replaced.length > 0 ? sql`s.written_by IN ${replaced}` : sql`false`;
  const fresh = sql`i.id <> ALL(${sql.param([...taken])}::text[])`;
  const referenceDue = sql`(${withReferences} AND (r.id IS NULL
    OR r.checked_at < now() - CASE WHEN r.status = 'ready' THEN interval '90 days' ELSE interval '30 days' END))`;
  const rows = await db.execute<DueItem>(sql`
    SELECT i.id, i.name, i.type, i.series_name, i.parent_index_number,
           i.index_number, i.production_year, i.overview,
           i.provider_ids->>'Imdb' AS imdb_id, ${referenceDue} AS reference_due
    FROM items i
    LEFT JOIN item_texts t ON t.item_id = i.id AND t.kind = 'transcript'
    LEFT JOIN item_texts s ON s.item_id = i.id AND s.kind = 'scenes'
    LEFT JOIN item_texts r ON r.item_id = i.id AND r.kind = 'reference'
    WHERE i.server_id = ${serverId}
      AND i.deleted_at IS NULL
      AND i.type IN ${selected}
      AND ${fresh}
      AND (
        t.id IS NULL
        OR (t.status <> 'ready' AND t.checked_at < now() - interval '1 day')
        OR (t.status = 'ready' AND t.checked_at < now() - interval '7 days')
        OR (t.status = 'ready' AND t.cue_starts_ms IS NULL)
        OR (${usable.length > 0} AND t.status = 'ready'
            AND (s.id IS NULL OR s.status <> 'ready' OR ${rewrite})
            AND (s.id IS NULL OR s.checked_at < now() - interval '1 day'))
        OR ${referenceDue}
      )
    ORDER BY (t.id IS NULL) DESC, i.date_created DESC NULLS LAST
    LIMIT ${ITEMS_PER_QUERY}
  `);
  return Array.from(rows);
}

async function getText(itemId: string, kind: string): Promise<ItemText | undefined> {
  const [row] = await db
    .select()
    .from(itemTexts)
    .where(and(eq(itemTexts.itemId, itemId), eq(itemTexts.kind, kind)))
    .limit(1);
  return row;
}

async function saveText(
  serverId: number,
  itemId: string,
  kind: string,
  values: Partial<Pick<ItemText, "status" | "source" | "content" | "contentHash" | "cueStartsMs" | "writtenBy">> & {
    status: string;
  }
): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(itemTexts)
    .values({ serverId, itemId, kind, ...values, checkedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: [itemTexts.itemId, itemTexts.kind],
      set: { ...values, checkedAt: now, updatedAt: now },
    })
    .returning({ id: itemTexts.id });
  return row.id;
}

/** The best full-dialogue track that really is one (forced tracks are too short). */
async function readTranscript(
  client: JellyfinClient,
  itemId: string,
  previous: ItemText | undefined,
  languages: string[]
): Promise<{ ref: string; cues: Cue[] } | "unchanged" | null> {
  const media = await client.getPrimaryMediaSource(itemId);
  if (!media) return null;
  const candidates = rankTranscriptStreams(media.streams, media.id, languages);
  if (
    previous?.status === "ready" &&
    previous.cueStartsMs &&
    previous.source === candidates[0]?.ref
  ) {
    return "unchanged";
  }
  for (const candidate of candidates.slice(0, MAX_TRACKS_TRIED)) {
    const cues = cleanCues(parseSrt(await client.getSubtitleSrt(itemId, media.id, candidate.index)));
    if (wordCount(cues) >= MIN_TRANSCRIPT_WORDS) return { ref: candidate.ref, cues };
  }
  return null;
}

async function indexTranscript(
  serverId: number,
  client: JellyfinClient,
  embedding: EmbeddingSettings,
  languages: string[],
  item: DueItem
): Promise<Outcome> {
  const previous = await getText(item.id, "transcript");
  const read = await readTranscript(client, item.id, previous, languages);

  if (read === "unchanged") {
    await saveText(serverId, item.id, "transcript", { status: "ready" });
    return "unchanged";
  }
  if (!read) {
    const id = await saveText(serverId, item.id, "transcript", {
      status: "missing",
      source: null,
      content: "",
      contentHash: null,
      cueStartsMs: null,
    });
    await db.delete(itemTextChunks).where(eq(itemTextChunks.itemTextId, id));
    return "missing";
  }

  // One line per cue, with when each is said: a match can be located to
  // the moment, not just its window.
  const content = read.cues.map((c) => c.text).join("\n");
  const cueStartsMs = read.cues.map((c) => c.startMs);
  const contentHash = hash(content);
  if (previous?.status === "ready" && previous.contentHash === contentHash) {
    // Same words from a re-timed or relocated file: no re-embedding.
    await saveText(serverId, item.id, "transcript", { status: "ready", source: read.ref, cueStartsMs });
    return "unchanged";
  }

  const chunks = chunkCues(read.cues);
  const vectors = await embedAll(embedding, chunks.map((c) => c.text), "transcript");

  await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(itemTexts)
      .values({
        serverId,
        itemId: item.id,
        kind: "transcript",
        status: "ready",
        source: read.ref,
        content,
        contentHash,
        cueStartsMs,
        checkedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [itemTexts.itemId, itemTexts.kind],
        set: { status: "ready", source: read.ref, content, contentHash, cueStartsMs, checkedAt: now, updatedAt: now },
      })
      .returning({ id: itemTexts.id });
    await tx.delete(itemTextChunks).where(eq(itemTextChunks.itemTextId, row.id));
    await tx.insert(itemTextChunks).values(
      chunks.map((chunk, i) => ({
        itemTextId: row.id,
        serverId,
        itemId: item.id,
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        text: chunk.text,
        embedding: vectors[i],
      }))
    );
  });
  return "indexed";
}

type PlotText = { id: number; itemId: string; kind: string; content: string };

/**
 * A plot text as search windows, replacing any it had: the synopsis or the
 * Wikipedia plot whole and by paragraph (see synopsisWindows), or each part
 * of the scene notes with its times. The Wikipedia plot ranks on its own, so
 * a title it matches is found even where the model's synopsis left the plot
 * point out, and one both match ranks higher.
 */
async function indexPlotWindows(
  serverId: number,
  embedding: EmbeddingSettings,
  text: PlotText,
  title: string
): Promise<void> {
  const windows =
    text.kind === "scenes"
      ? sceneWindows(title, parseScenes(text.content))
      : synopsisWindows(title, text.content).map((w) => ({ text: w, startMs: null, endMs: null }));
  const kind: WindowKind = text.kind === "reference" ? "reference" : "synopsis";
  const vectors = await embedAll(embedding, windows.map((w) => w.text), kind);
  await db.transaction(async (tx) => {
    await tx.delete(itemTextChunks).where(eq(itemTextChunks.itemTextId, text.id));
    if (windows.length === 0) return;
    await tx.insert(itemTextChunks).values(
      windows.map((w, i) => ({
        itemTextId: text.id,
        serverId,
        itemId: text.itemId,
        kind,
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.text,
        embedding: vectors[i],
      }))
    );
  });
}

/**
 * Wikipedia plots for a batch of items, looked up together, each stored as
 * the item's "reference" text and indexed as search windows of its own. An
 * item without an English article with a Plot section is marked missing.
 */
async function indexReferences(serverId: number, embedding: EmbeddingSettings, batch: DueItem[]): Promise<number> {
  const articles = await articlesByImdbId(batch.flatMap((item) => (item.imdb_id ? [item.imdb_id] : [])));
  const plots = await plotsOf([...new Set(articles.values())]);
  let found = 0;
  for (const item of batch) {
    const article = item.imdb_id ? articles.get(item.imdb_id) : undefined;
    const plot = article ? plots.get(article) : undefined;
    if (!plot) {
      const id = await saveText(serverId, item.id, "reference", { status: "missing", source: null, content: "", contentHash: null });
      await db.delete(itemTextChunks).where(eq(itemTextChunks.itemTextId, id));
      continue;
    }
    const previous = await getText(item.id, "reference");
    const contentHash = hash(plot.plot);
    const id = await saveText(serverId, item.id, "reference", {
      status: "ready",
      source: plot.source,
      content: plot.plot,
      contentHash,
    });
    if (previous?.contentHash !== contentHash) {
      try {
        await indexPlotWindows(serverId, embedding, { id, itemId: item.id, kind: "reference", content: plot.plot }, titleOf(item));
      } catch (error) {
        // The plot stands; the backlog pass retries its windows.
        console.warn(`[knowledge] serverId=${serverId} item=${item.id} reference windows: ${errorText(error)}`);
      }
    }
    found++;
  }
  return found;
}

/**
 * Character names from the title's own cast. Not the series' for an episode:
 * a model told of a regular who is not in the episode puts them in it.
 */
async function charactersOf(item: ItemRow): Promise<string[]> {
  const rows = await db.execute<{ role: string }>(sql`
    SELECT role FROM item_people
    WHERE type = 'Actor' AND role <> '' AND item_id = ${item.id}
    ORDER BY sort_order NULLS LAST
  `);
  return characterNames(Array.from(rows, (r) => r.role));
}

/**
 * Write the scene notes and the synopsis summarised from them, and re-queue
 * the item for embedding, so the plot becomes part of the item vector that
 * search and recommendations already use; then index both as search windows
 * of their own, by whichever of the `usable` models writersFor picks: notes
 * already there are kept unless a model was asked to replace their writer's.
 */
async function indexSynopsis(
  serverId: number,
  usable: KnowledgeModel[],
  embedding: EmbeddingSettings,
  item: DueItem
): Promise<boolean> {
  const transcript = await getText(item.id, "transcript");
  if (transcript?.status !== "ready" || !transcript.contentHash || !transcript.cueStartsMs) return false;
  const reference = await getText(item.id, "reference");
  const basis = plotBasis(transcript.contentHash, reference);
  const previous = await getText(item.id, "scenes");
  const writers = writersFor(previous, usable);
  if (writers.length === 0) return false;

  const title = titleOf(item);
  const saved: PlotText[] = [];
  try {
    const { scenes, synopsis, model } = await writePlotWithModels(
      writers,
      {
        title,
        overview: item.overview,
        characters: await charactersOf(item),
        reference: reference?.status === "ready" ? reference.content : null,
      },
      transcriptParts(transcript.content.split("\n"), transcript.cueStartsMs)
    );
    for (const [kind, content] of [
      ["scenes", formatScenes(scenes)],
      ["synopsis", synopsis],
    ] as const) {
      const id = await saveText(serverId, item.id, kind, {
        status: "ready",
        source: basis,
        content,
        contentHash: hash(content),
        writtenBy: modelLabel(model),
      });
      saved.push({ id, itemId: item.id, kind, content });
    }
    await db.update(items).set({ processed: false }).where(eq(items.id, item.id));
  } catch (error) {
    // Back off a day rather than retrying failing models every run; notes
    // already there stay until replaced.
    await saveText(serverId, item.id, "scenes", { status: previous?.status === "ready" ? "ready" : "missing" });
    throw error;
  }

  for (const text of saved) {
    try {
      await indexPlotWindows(serverId, embedding, text, title);
    } catch (error) {
      // The text stands; the backlog pass retries its windows.
      console.warn(
        `[knowledge] serverId=${serverId} item=${item.id} ${text.kind} windows: ${errorText(error)}`
      );
    }
  }
  return true;
}

type PlotTextRow = ItemRow & { text_id: number; kind: string; content: string };

/**
 * Plot texts without search windows: written before they existed, or their
 * embedding failed. Those that failed this run (`failed`) wait for the next.
 */
async function plotTextsWithoutWindows(serverId: number, failed: Set<number>): Promise<PlotTextRow[]> {
  const rows = await db.execute<PlotTextRow>(sql`
    SELECT s.id AS text_id, s.kind, s.content, i.id, i.name, i.type, i.series_name,
           i.parent_index_number, i.index_number, i.production_year, i.overview
    FROM item_texts s
    JOIN items i ON i.id = s.item_id
    WHERE s.server_id = ${serverId}
      AND s.kind IN ('synopsis', 'scenes', 'reference')
      AND s.status = 'ready'
      AND btrim(s.content) <> ''
      AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM item_text_chunks c WHERE c.item_text_id = s.id)
      AND s.id <> ALL(${sql.param([...failed])}::int[])
    LIMIT ${ITEMS_PER_QUERY}
  `);
  return Array.from(rows);
}

export async function knowledgeIndexJob(job: PgBossJob<ServerIdJobData>) {
  const startTime = Date.now();
  const { serverId } = job.data;
  const counts = { indexed: 0, unchanged: 0, missing: 0, synopses: 0, references: 0, windows: 0, errors: 0 };
  let lastError: string | null = null;

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server?.knowledgeIndexEnabled) return { skipped: "disabled" };

  const embedding = await getEmbeddingSettings(serverId);
  if (!embedding) {
    await logJobResult(job.id, KNOWLEDGE_INDEX_JOB_NAME, "completed", { serverId, skipped: "embeddings not configured" }, 0);
    return { skipped: "embeddings not configured" };
  }
  const withReferences = server.knowledgeWikipedia;
  const client = JellyfinClient.fromServer(server);
  // Transcripts in the language people search in. A transcript picked
  // under an earlier choice is replaced at its weekly re-check.
  const languages = await client.getMetadataLanguageCodes().catch(() => ["en", "eng"]);

  const listed = await getKnowledgeModels(serverId);
  console.info(
    `[knowledge] serverId=${serverId} action=start synopses=${listed.map(modelLabel).join(" > ") || "off"} wikipedia=${withReferences} language=${languages.join("/")}`
  );
  // So the settings show the run as going from its start, not its first batch.
  await logJobResult(job.id, KNOWLEDGE_INDEX_JOB_NAME, "processing", { serverId, ...counts, lastError }, 0);
  try {
    // Plot texts still without search windows: embedding only, no model calls.
    const failed = new Set<number>();
    backlog: while (Date.now() - startTime < RUN_BUDGET_MS) {
      const rows = await plotTextsWithoutWindows(serverId, failed);
      if (rows.length === 0) break;
      for (const row of rows) {
        try {
          await indexPlotWindows(
            serverId,
            embedding,
            { id: row.text_id, itemId: row.id, kind: row.kind, content: row.content },
            titleOf(row)
          );
          counts.windows++;
        } catch (error) {
          counts.errors++;
          lastError = `${titleOf(row)}: ${errorText(error)}`;
          console.warn(`[knowledge] serverId=${serverId} item=${row.id} error=${lastError}`);
          failed.add(row.text_id);
          // The text's own failure leaves the rest to go on; the embedding
          // server's (it fails a word too) leaves them for the next run.
          if (!(await embedTexts(embedding, ["test"]).then(() => true, () => false))) break backlog;
        }
      }
    }

    const taken = new Set<string>();
    while (Date.now() - startTime < RUN_BUDGET_MS) {
      // Read again each batch (and each title, below): models rest, settings change.
      const usable = (await getKnowledgeModels(serverId)).filter((m) => isUsable(m));
      // Enough titles at once for the model taking most; each model is sent
      // no more requests at once than it takes (see parallelOf).
      const concurrency = Math.max(1, ...usable.map(parallelOf));
      const batch = await dueItems(serverId, server.knowledgeItemTypes, usable, withReferences, taken);
      if (batch.length === 0) break;
      for (const item of batch) taken.add(item.id);
      const lookUp = batch.filter((item) => item.reference_due);
      if (lookUp.length > 0) {
        try {
          counts.references += await indexReferences(serverId, embedding, lookUp);
        } catch (error) {
          // Wikipedia unreachable: stop rather than write notes without the
          // plots, which they would then lack for good. The next run retries.
          counts.errors++;
          lastError = `Wikipedia plots: ${errorText(error)}`;
          console.warn(`[knowledge] serverId=${serverId} error=${lastError}`);
          break;
        }
      }
      const indexItem = async (item: DueItem) => {
        try {
          counts[await indexTranscript(serverId, client, embedding, languages, item)]++;
          // A batch for a local model can take hours: a model turned off or
          // resting since it began is not tried.
          const current = (await getKnowledgeModels(serverId)).filter((m) => isUsable(m));
          if (await indexSynopsis(serverId, current, embedding, item)) {
            counts.synopses++;
          }
        } catch (error) {
          counts.errors++;
          lastError = `${titleOf(item)}: ${errorText(error)}`;
          console.warn(`[knowledge] serverId=${serverId} item=${item.id} error=${lastError}`);
          // Never let one bad item stall the queue: stamp it as checked so it
          // waits for the next re-check instead of coming straight back.
          const transcript = await getText(item.id, "transcript");
          await saveText(serverId, item.id, "transcript", { status: transcript?.status ?? "error" });
        }
      };
      // `concurrency` workers taking titles off the batch while the run has time;
      // titles left over stay due for the next run.
      const inTime = () => Date.now() - startTime < RUN_BUDGET_MS;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (let item = batch.shift(); item && inTime(); item = batch.shift()) await indexItem(item);
        })
      );
      await logJobResult(job.id, KNOWLEDGE_INDEX_JOB_NAME, "processing", { serverId, ...counts, lastError }, Date.now() - startTime);
    }
    await logJobResult(job.id, KNOWLEDGE_INDEX_JOB_NAME, "completed", { serverId, ...counts, lastError }, Date.now() - startTime);
    console.info(`[knowledge] serverId=${serverId} action=done ${JSON.stringify(counts)}`);
    return counts;
  } catch (error) {
    await logJobResult(job.id, KNOWLEDGE_INDEX_JOB_NAME, "failed", { serverId, ...counts }, Date.now() - startTime, error instanceof Error ? error : String(error));
    throw error;
  }
}

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
  type ChatSettings,
  formatScenes,
  getChatSettings,
  parseScenes,
  sceneWindows,
  synopsisWindows,
  transcriptParts,
  writeScenes,
  writeSynopsis,
} from "../knowledge/synopsis";
import type { PgBossJob, ServerIdJobData } from "../types/job-status";
import { logJobResult } from "./job-logger";

export const KNOWLEDGE_INDEX_JOB_NAME = "knowledge-index-sync";

/** Leave room under the queue's 2h expiry; the next run continues. */
const RUN_BUDGET_MS = 90 * 60_000;
const ITEMS_PER_QUERY = 25;
const EMBED_BATCH = 32;
const MAX_TRACKS_TRIED = 3;

type Outcome = "indexed" | "unchanged" | "missing";

type DueItem = {
  id: string;
  name: string;
  type: string;
  series_name: string | null;
  parent_index_number: number | null;
  index_number: number | null;
  production_year: number | null;
  overview: string | null;
};

type WindowKind = "transcript" | "synopsis";

const ensuredIndexes = new Set<string>();

/**
 * Partial HNSW index per dimension, as for items.embedding, and per kind of
 * window: dialogue and plot summaries sit in different parts of the vector
 * space, and one shared graph searched with a kind filter missed the best
 * synopsis windows entirely. Replaces the earlier shared index.
 */
async function ensureChunkIndex(dimensions: number, kind: WindowKind): Promise<void> {
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

function titleOf(item: DueItem): string {
  if (item.type !== "Episode") {
    return item.production_year ? `${item.name} (${item.production_year})` : item.name;
  }
  const s = String(item.parent_index_number ?? 0).padStart(2, "0");
  const e = String(item.index_number ?? 0).padStart(2, "0");
  return `${item.series_name ?? "Unknown series"} S${s}E${e} "${item.name}"`;
}

/**
 * Selected movies/episodes that need work: never looked at; no usable subtitle a
 * day ago (a subtitle downloader may have fetched one since); a weekly re-check for upgraded
 * subtitles; a transcript indexed before line timings were kept; or, with a
 * chat model, scene notes (and the synopsis written with them) missing or
 * written from an older transcript.
 */
async function dueItems(
  serverId: number,
  types: readonly string[],
  withSynopses: boolean
): Promise<DueItem[]> {
  const allowed: readonly string[] = KNOWLEDGE_ITEM_TYPES;
  const selected = types.filter((t) => allowed.includes(t));
  if (selected.length === 0) return [];
  const rows = await db.execute<DueItem>(sql`
    SELECT i.id, i.name, i.type, i.series_name, i.parent_index_number,
           i.index_number, i.production_year, i.overview
    FROM items i
    LEFT JOIN item_texts t ON t.item_id = i.id AND t.kind = 'transcript'
    LEFT JOIN item_texts s ON s.item_id = i.id AND s.kind = 'scenes'
    WHERE i.server_id = ${serverId}
      AND i.deleted_at IS NULL
      AND i.type IN ${selected}
      AND (
        t.id IS NULL
        OR (t.status <> 'ready' AND t.checked_at < now() - interval '1 day')
        OR (t.status = 'ready' AND t.checked_at < now() - interval '7 days')
        OR (t.status = 'ready' AND t.cue_starts_ms IS NULL)
        OR (${withSynopses} AND t.status = 'ready'
            AND (s.id IS NULL OR s.source IS DISTINCT FROM t.content_hash)
            AND (s.id IS NULL OR s.checked_at < now() - interval '1 day'))
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
  values: Partial<Pick<ItemText, "status" | "source" | "content" | "contentHash" | "cueStartsMs">> & {
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
 * A plot text as search windows of the plot ranking, replacing any it had:
 * the synopsis whole and by paragraph (see synopsisWindows), or each part of
 * the scene notes with its times.
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
  const vectors = await embedAll(embedding, windows.map((w) => w.text), "synopsis");
  await db.transaction(async (tx) => {
    await tx.delete(itemTextChunks).where(eq(itemTextChunks.itemTextId, text.id));
    if (windows.length === 0) return;
    await tx.insert(itemTextChunks).values(
      windows.map((w, i) => ({
        itemTextId: text.id,
        serverId,
        itemId: text.itemId,
        kind: "synopsis",
        startMs: w.startMs,
        endMs: w.endMs,
        text: w.text,
        embedding: vectors[i],
      }))
    );
  });
}

/**
 * Write the scene notes and the synopsis summarised from them, and re-queue
 * the item for embedding, so the plot becomes part of the item vector that
 * search and recommendations already use; then index both as search windows
 * of their own.
 */
async function indexSynopsis(
  serverId: number,
  chat: ChatSettings,
  embedding: EmbeddingSettings,
  item: DueItem
): Promise<boolean> {
  const transcript = await getText(item.id, "transcript");
  if (transcript?.status !== "ready" || !transcript.contentHash || !transcript.cueStartsMs) return false;
  const previous = await getText(item.id, "scenes");
  if (previous?.status === "ready" && previous.source === transcript.contentHash) return false;

  const title = titleOf(item);
  const saved: PlotText[] = [];
  try {
    const parts = transcriptParts(transcript.content.split("\n"), transcript.cueStartsMs);
    const scenes = await writeScenes(chat, title, item.overview, parts);
    const synopsis = await writeSynopsis(chat, title, item.overview, scenes);
    for (const [kind, content] of [
      ["scenes", formatScenes(scenes)],
      ["synopsis", synopsis],
    ] as const) {
      const id = await saveText(serverId, item.id, kind, {
        status: "ready",
        source: transcript.contentHash,
        content,
        contentHash: hash(content),
      });
      saved.push({ id, itemId: item.id, kind, content });
    }
    await db.update(items).set({ processed: false }).where(eq(items.id, item.id));
  } catch (error) {
    // Back off a day rather than retrying a failing model every run.
    await saveText(serverId, item.id, "scenes", { status: "missing" });
    throw error;
  }

  for (const text of saved) {
    try {
      await indexPlotWindows(serverId, embedding, text, title);
    } catch (error) {
      // The text stands; the backlog pass retries its windows.
      console.warn(
        `[knowledge] serverId=${serverId} item=${item.id} ${text.kind} windows: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return true;
}

type PlotTextRow = DueItem & { text_id: number; kind: string; content: string };

/** Plot texts without search windows: written before they existed, or their embedding failed. */
async function plotTextsWithoutWindows(serverId: number): Promise<PlotTextRow[]> {
  const rows = await db.execute<PlotTextRow>(sql`
    SELECT s.id AS text_id, s.kind, s.content, i.id, i.name, i.type, i.series_name,
           i.parent_index_number, i.index_number, i.production_year, i.overview
    FROM item_texts s
    JOIN items i ON i.id = s.item_id
    WHERE s.server_id = ${serverId}
      AND s.kind IN ('synopsis', 'scenes')
      AND s.status = 'ready'
      AND btrim(s.content) <> ''
      AND i.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM item_text_chunks c WHERE c.item_text_id = s.id)
    LIMIT ${ITEMS_PER_QUERY}
  `);
  return Array.from(rows);
}

export async function knowledgeIndexJob(job: PgBossJob<ServerIdJobData>) {
  const startTime = Date.now();
  const { serverId } = job.data;
  const counts = { indexed: 0, unchanged: 0, missing: 0, synopses: 0, windows: 0, errors: 0 };
  let lastError: string | null = null;

  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server?.knowledgeIndexEnabled) return { skipped: "disabled" };

  const embedding = await getEmbeddingSettings(serverId);
  if (!embedding) {
    await logJobResult(job.id, KNOWLEDGE_INDEX_JOB_NAME, "completed", { serverId, skipped: "embeddings not configured" }, 0);
    return { skipped: "embeddings not configured" };
  }
  const chat = await getChatSettings(serverId);
  const client = JellyfinClient.fromServer(server);
  // Transcripts in the language people search in. A transcript picked
  // under an earlier choice is replaced at its weekly re-check.
  const languages = await client.getMetadataLanguageCodes().catch(() => ["en", "eng"]);

  console.info(
    `[knowledge] serverId=${serverId} action=start synopses=${chat ? chat.model : "off"} language=${languages.join("/")}`
  );
  try {
    // Plot texts still without search windows: embedding only, no model calls.
    backlog: while (Date.now() - startTime < RUN_BUDGET_MS) {
      const rows = await plotTextsWithoutWindows(serverId);
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
          // Most likely the embedding server: leave the rest for the next run.
          counts.errors++;
          lastError = `${titleOf(row)}: ${error instanceof Error ? error.message : String(error)}`;
          console.warn(`[knowledge] serverId=${serverId} item=${row.id} error=${lastError}`);
          break backlog;
        }
      }
    }

    while (Date.now() - startTime < RUN_BUDGET_MS) {
      const batch = await dueItems(serverId, server.knowledgeItemTypes, chat !== null);
      if (batch.length === 0) break;
      for (const item of batch) {
        try {
          counts[await indexTranscript(serverId, client, embedding, languages, item)]++;
          if (chat && (await indexSynopsis(serverId, chat, embedding, item))) counts.synopses++;
        } catch (error) {
          counts.errors++;
          lastError = `${titleOf(item)}: ${error instanceof Error ? error.message : String(error)}`;
          console.warn(`[knowledge] serverId=${serverId} item=${item.id} error=${lastError}`);
          // Never let one bad item stall the queue: stamp it as checked so it
          // waits for the next re-check instead of coming straight back.
          const transcript = await getText(item.id, "transcript");
          await saveText(serverId, item.id, "transcript", { status: transcript?.status ?? "error" });
        }
      }
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

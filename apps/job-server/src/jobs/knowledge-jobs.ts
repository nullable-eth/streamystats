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
import { type ChatSettings, getChatSettings, writeSynopsis } from "../knowledge/synopsis";
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

const ensuredDimensions = new Set<number>();

/** Partial HNSW index per dimension, the same scheme as items.embedding. */
async function ensureChunkIndex(dimensions: number): Promise<void> {
  if (ensuredDimensions.has(dimensions)) return;
  const n = sql.raw(String(dimensions));
  await db.execute(sql`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${sql.raw(`item_text_chunks_embedding_${dimensions}_idx`)}
    ON item_text_chunks USING hnsw ((embedding::vector(${n})) vector_cosine_ops)
    WHERE vector_dims(embedding) = ${n}
  `);
  ensuredDimensions.add(dimensions);
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

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
 * day ago (Bazarr may have fetched one since); a weekly re-check for upgraded
 * subtitles; or, with a chat model, a synopsis missing or written from an
 * older transcript.
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
    LEFT JOIN item_texts s ON s.item_id = i.id AND s.kind = 'synopsis'
    WHERE i.server_id = ${serverId}
      AND i.deleted_at IS NULL
      AND i.type IN ${selected}
      AND (
        t.id IS NULL
        OR (t.status <> 'ready' AND t.checked_at < now() - interval '1 day')
        OR (t.status = 'ready' AND t.checked_at < now() - interval '7 days')
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
  values: Partial<Pick<ItemText, "status" | "source" | "content" | "contentHash">> & {
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
  previous: ItemText | undefined
): Promise<{ ref: string; cues: Cue[] } | "unchanged" | null> {
  const media = await client.getPrimaryMediaSource(itemId);
  if (!media) return null;
  const candidates = rankTranscriptStreams(media.streams, media.id);
  if (previous?.status === "ready" && previous.source === candidates[0]?.ref) {
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
  item: DueItem
): Promise<Outcome> {
  const previous = await getText(item.id, "transcript");
  const read = await readTranscript(client, item.id, previous);

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
    });
    await db.delete(itemTextChunks).where(eq(itemTextChunks.itemTextId, id));
    return "missing";
  }

  const content = read.cues.map((c) => c.text).join("\n");
  const contentHash = hash(content);
  if (previous?.status === "ready" && previous.contentHash === contentHash) {
    // Same words from a re-timed or relocated file: no re-embedding.
    await saveText(serverId, item.id, "transcript", { status: "ready", source: read.ref });
    return "unchanged";
  }

  const chunks = chunkCues(read.cues);
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    vectors.push(...(await embedTexts(embedding, chunks.slice(i, i + EMBED_BATCH).map((c) => c.text))));
  }
  const dimensions = new Set(vectors.map((v) => v.length));
  for (const d of dimensions) await ensureChunkIndex(d);

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
        checkedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [itemTexts.itemId, itemTexts.kind],
        set: { status: "ready", source: read.ref, content, contentHash, checkedAt: now, updatedAt: now },
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

/**
 * Write the synopsis and re-queue the item for embedding, so the plot becomes
 * part of the item vector that search and recommendations already use.
 */
async function indexSynopsis(serverId: number, chat: ChatSettings, item: DueItem): Promise<boolean> {
  const transcript = await getText(item.id, "transcript");
  if (transcript?.status !== "ready" || !transcript.contentHash) return false;
  const synopsis = await getText(item.id, "synopsis");
  if (synopsis?.status === "ready" && synopsis.source === transcript.contentHash) return false;

  try {
    const content = await writeSynopsis(chat, titleOf(item), item.overview, transcript.content);
    await saveText(serverId, item.id, "synopsis", {
      status: "ready",
      source: transcript.contentHash,
      content,
      contentHash: hash(content),
    });
    await db.update(items).set({ processed: false }).where(eq(items.id, item.id));
    return true;
  } catch (error) {
    // Back off a day rather than retrying a failing model every run.
    await saveText(serverId, item.id, "synopsis", { status: "missing" });
    throw error;
  }
}

export async function knowledgeIndexJob(job: PgBossJob<ServerIdJobData>) {
  const startTime = Date.now();
  const { serverId } = job.data;
  const counts = { indexed: 0, unchanged: 0, missing: 0, synopses: 0, errors: 0 };
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

  console.info(`[knowledge] serverId=${serverId} action=start synopses=${chat ? chat.model : "off"}`);
  try {
    while (Date.now() - startTime < RUN_BUDGET_MS) {
      const batch = await dueItems(serverId, server.knowledgeItemTypes, chat !== null);
      if (batch.length === 0) break;
      for (const item of batch) {
        try {
          counts[await indexTranscript(serverId, client, embedding, item)]++;
          if (chat && (await indexSynopsis(serverId, chat, item))) counts.synopses++;
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

import "server-only";

import {
  db,
  items,
  itemTexts,
  jobResults,
  KNOWLEDGE_ITEM_TYPES,
  knowledgeModels,
  servers,
} from "@streamystats/database";
import {
  and,
  type Column,
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { type MissingSummary, summarizeMissing } from "@/lib/knowledge-missing";
import { defaultParallel } from "@/lib/knowledge-writers";
import { listKnowledgeModels } from "./knowledge-models";

/**
 * Where a server's movies and episodes stand in the knowledge index, for the
 * selected types. Each is in one of four tiers, by what search knows of it:
 * a synopsis written with a Wikipedia plot, one written from the subtitles
 * alone, the subtitles alone (the synopsis still to be written), or neither.
 */
export interface KnowledgeTypeStatus {
  type: (typeof KNOWLEDGE_ITEM_TYPES)[number];
  enabled: boolean;
  /** In the library. */
  total: number;
  /** A synopsis, and a Wikipedia plot. */
  best: number;
  /** A synopsis without a Wikipedia plot. */
  good: number;
  /** Subtitles read; the synopsis still to be written. */
  dialogue: number;
  /**
   * No subtitles read, but a Wikipedia text: its article's plot, or its
   * summary in its series' episode list. That text is searchable.
   */
  wikipediaOnly: number;
  /** No subtitles read (not yet, or none readable) and no Wikipedia text. */
  titleOnly: number;
  /** With a Wikipedia text, whatever else they have: how far Wikipedia reaches. */
  wikipedia: number;
  /** Not read yet. */
  unread: number;
  /** Read, but no readable full-dialogue subtitles: checked again daily. */
  noSubtitles: number;
  /** Synopses whose writing failed in the last day: tried again a day later. */
  failed: number;
  /**
   * Subtitles read, but every model that writes synopses declined it (its
   * provider's content filter refused): waits for a model that hasn't.
   */
  declined: number;
  /** Synopses a model was asked to replace (in AI Models), still to be rewritten. */
  rewrites: number;
  /** Not looked up on Wikipedia yet. */
  wikipediaPending: number;
}

/** A model that writes synopses, as the job will use it. */
export interface KnowledgeWriter {
  name: string;
  atOnce: number;
  /** ISO time it rests until after a failure of its own. */
  restingUntil: string | null;
  lastError: string | null;
}

export interface KnowledgeIndexStatus {
  enabled: boolean;
  embeddingsConfigured: boolean;
  /** Plots are fetched from Wikipedia. */
  wikipedia: boolean;
  byType: KnowledgeTypeStatus[];
  /** Who writes synopses, in order: the models turned on, or the chat model when none are listed. */
  writers: KnowledgeWriter[];
  /** The latest run, or the one running now. */
  lastRun: {
    at: string;
    running: boolean;
    synopses: number;
    subtitles: number;
    plots: number;
    errors: number;
    lastError: string | null;
  } | null;
  /** Enabled items with no full text subtitle, grouped by series and movie. */
  missing: MissingSummary;
}

/** How long a run may last (the job's budget): a run logged since then may still be going. */
const RUN_MS = 90 * 60_000;

export async function getKnowledgeIndexStatus(
  serverId: number,
): Promise<KnowledgeIndexStatus> {
  const [server] = await db
    .select({
      enabled: servers.knowledgeIndexEnabled,
      types: servers.knowledgeItemTypes,
      wikipedia: servers.knowledgeWikipedia,
      embeddingModel: servers.embeddingModel,
      chatModel: servers.chatModel,
      chatName: servers.chatName,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  const enabledTypes: readonly string[] = server?.types ?? KNOWLEDGE_ITEM_TYPES;

  const inLibrary = and(
    eq(items.serverId, serverId),
    isNull(items.deletedAt),
    inArray(items.type, [...KNOWLEDGE_ITEM_TYPES]),
  );

  const [tiers, models, [run], missingRows] = await Promise.all([
    db.execute<Omit<KnowledgeTypeStatus, "enabled"> & { type: string }>(sql`
      SELECT ${items.type} AS type,
        count(*)::int AS total,
        count(*) FILTER (WHERE s.status = 'ready' AND r.status = 'ready')::int AS best,
        count(*) FILTER (WHERE s.status = 'ready' AND r.status IS DISTINCT FROM 'ready')::int AS good,
        count(*) FILTER (WHERE s.status IS DISTINCT FROM 'ready' AND t.status = 'ready')::int AS dialogue,
        count(*) FILTER (WHERE s.status IS DISTINCT FROM 'ready' AND t.status IS DISTINCT FROM 'ready'
                         AND r.status = 'ready')::int AS "wikipediaOnly",
        count(*) FILTER (WHERE s.status IS DISTINCT FROM 'ready' AND t.status IS DISTINCT FROM 'ready'
                         AND r.status IS DISTINCT FROM 'ready')::int AS "titleOnly",
        count(*) FILTER (WHERE r.status = 'ready')::int AS wikipedia,
        count(*) FILTER (WHERE t.id IS NULL)::int AS unread,
        count(*) FILTER (WHERE t.status <> 'ready')::int AS "noSubtitles",
        count(*) FILTER (WHERE t.status = 'ready' AND s.status <> 'ready' AND s.status <> 'declined'
                         AND s.checked_at > now() - interval '1 day')::int AS failed,
        count(*) FILTER (WHERE t.status = 'ready' AND s.status = 'declined')::int AS declined,
        count(*) FILTER (WHERE s.status = 'ready' AND s.written_by IN (
          SELECT unnest(m.rewrite_from) FROM ${knowledgeModels} m
          WHERE m.server_id = ${serverId} AND m.enabled))::int AS rewrites,
        count(*) FILTER (WHERE r.id IS NULL)::int AS "wikipediaPending"
      FROM ${items}
      LEFT JOIN ${itemTexts} t ON t.item_id = ${items.id} AND t.kind = 'transcript'
      LEFT JOIN ${itemTexts} s ON s.item_id = ${items.id} AND s.kind = 'scenes'
      LEFT JOIN ${itemTexts} r ON r.item_id = ${items.id} AND r.kind = 'reference'
      WHERE ${inLibrary}
      GROUP BY ${items.type}
    `),
    listKnowledgeModels(serverId),
    db
      .select({
        status: jobResults.status,
        result: jobResults.result,
        createdAt: jobResults.createdAt,
      })
      .from(jobResults)
      .where(
        and(
          eq(jobResults.jobName, "knowledge-index-sync"),
          sql`${jobResults.result}->>'serverId' = ${String(serverId)}`,
        ),
      )
      .orderBy(desc(jobResults.createdAt))
      .limit(1),
    enabledTypes.length === 0
      ? Promise.resolve([])
      : db
          .select({
            name: items.name,
            seriesName: items.seriesName,
            season: items.parentIndexNumber,
            episode: items.indexNumber,
            year: items.productionYear,
          })
          .from(itemTexts)
          .innerJoin(items, eq(items.id, itemTexts.itemId))
          .where(
            and(
              inLibrary,
              inArray(items.type, [...enabledTypes]),
              eq(itemTexts.kind, "transcript"),
              eq(itemTexts.status, "missing"),
            ),
          )
          .orderBy(
            items.seriesName,
            items.parentIndexNumber,
            items.indexNumber,
            items.name,
          ),
  ]);

  const rows = Array.from(tiers);
  const empty = {
    total: 0,
    best: 0,
    good: 0,
    dialogue: 0,
    wikipediaOnly: 0,
    titleOnly: 0,
    wikipedia: 0,
    unread: 0,
    noSubtitles: 0,
    failed: 0,
    declined: 0,
    rewrites: 0,
    wikipediaPending: 0,
  };
  const writers: KnowledgeWriter[] =
    models.length > 0
      ? models
          .filter((m) => m.enabled)
          .map((m) => ({
            name: m.name || m.model,
            atOnce: m.parallelRequests ?? defaultParallel(m.provider),
            restingUntil: m.restingUntil,
            lastError: m.lastError,
          }))
      : server?.chatModel
        ? [
            {
              name: server.chatName || server.chatModel,
              atOnce: 1,
              restingUntil: null,
              lastError: null,
            },
          ]
        : [];
  const result = (run?.result ?? {}) as Record<string, unknown>;
  const number = (key: string) =>
    typeof result[key] === "number" ? (result[key] as number) : 0;

  return {
    enabled: server?.enabled ?? false,
    embeddingsConfigured: Boolean(server?.embeddingModel),
    wikipedia: server?.wikipedia ?? false,
    byType: KNOWLEDGE_ITEM_TYPES.map((type) => ({
      ...empty,
      ...rows.find((r) => r.type === type),
      type,
      enabled: enabledTypes.includes(type),
    })),
    writers,
    lastRun: run
      ? {
          at: run.createdAt.toISOString(),
          running:
            run.status === "processing" &&
            Date.now() - run.createdAt.getTime() < RUN_MS,
          synopses: number("synopses"),
          subtitles: number("indexed"),
          plots: number("references"),
          errors: number("errors"),
          lastError:
            typeof result.lastError === "string" ? result.lastError : null,
        }
      : null,
    missing: summarizeMissing(missingRows),
  };
}

/** Where a movie's or episode's synopsis stands, or a series' episodes'. */
export interface SynopsisQueue {
  /** The knowledge index is on. */
  enabled: boolean;
  written: number;
  /** Asked to be written next. */
  next: number;
  /** Subtitles read, waiting in the queue. */
  waiting: number;
  /** Every model that writes synopses declined it (a content filter). */
  declined: number;
  /** No readable subtitles: none can be written. */
  noSubtitles: number;
  /** Of those, with a Wikipedia text that is searchable. */
  wikipedia: number;
}

/** How far a movie's or episode's synopsis is, or a series' episodes'. */
export type SynopsisState = {
  /** Movies and episodes counted: 1, or a series' episodes. */
  total: number;
  /** With a synopsis; `best` of them with a Wikipedia plot too. */
  written: number;
  best: number;
  /** Asked to be written next. */
  next: number;
  /** Subtitles read, the synopsis waiting in the queue. */
  waiting: number;
  /** Every model that writes synopses declined it (a content filter). */
  declined: number;
  /** No subtitles, but a Wikipedia text (an article's plot, an episode list's summary). */
  wikipedia: number;
};

/** A movie, episode or series (by the id given), and its episodes in the library. */
const itemAndEpisodes = (x: SQL, id: SQL | Column) => sql`
  ${x}.deleted_at IS NULL
  AND ((${x}.id = ${id} AND ${x}.type IN ('Movie', 'Episode'))
    OR (${x}.series_id = ${id} AND ${x}.type = 'Episode'))`;

/**
 * How far an item's synopsis is, to sort by: 0 waiting, 1 next in the queue,
 * 2 written, 3 written with a Wikipedia plot; a series', its episodes'
 * average. Null without subtitles, or declined by every model: when none can
 * be written.
 */
export const synopsisProgress = (id: SQL | Column) => sql`(
  SELECT avg(CASE WHEN s.status = 'ready' AND r.status = 'ready' THEN 3 WHEN s.status = 'ready' THEN 2
                  WHEN s.status = 'wanted' THEN 1 WHEN s.status = 'declined' THEN NULL
                  WHEN t.status = 'ready' THEN 0 END)
  FROM ${items} x
  LEFT JOIN ${itemTexts} t ON t.item_id = x.id AND t.kind = 'transcript'
  LEFT JOIN ${itemTexts} s ON s.item_id = x.id AND s.kind = 'scenes'
  LEFT JOIN ${itemTexts} r ON r.item_id = x.id AND r.kind = 'reference'
  WHERE ${itemAndEpisodes(sql`x`, id)})`;

/** Where each item's synopsis stands (a series': its episodes'), by id. */
export async function getSynopsisStates(
  itemIds: string[],
): Promise<Map<string, SynopsisState>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db.execute<SynopsisState & { id: string }>(sql`
    SELECT o.id,
      count(*)::int AS total,
      count(*) FILTER (WHERE s.status = 'ready')::int AS written,
      count(*) FILTER (WHERE s.status = 'ready' AND r.status = 'ready')::int AS best,
      count(*) FILTER (WHERE s.status = 'wanted')::int AS next,
      count(*) FILTER (WHERE t.status = 'ready' AND s.status IS DISTINCT FROM 'ready'
        AND s.status IS DISTINCT FROM 'wanted' AND s.status IS DISTINCT FROM 'declined')::int AS waiting,
      count(*) FILTER (WHERE t.status = 'ready' AND s.status = 'declined')::int AS declined,
      count(*) FILTER (WHERE t.status IS DISTINCT FROM 'ready' AND s.status IS DISTINCT FROM 'ready'
        AND r.status = 'ready')::int AS wikipedia
    FROM ${items} o
    JOIN ${items} x ON ${itemAndEpisodes(sql`x`, sql`o.id`)}
    LEFT JOIN ${itemTexts} t ON t.item_id = x.id AND t.kind = 'transcript'
    LEFT JOIN ${itemTexts} s ON s.item_id = x.id AND s.kind = 'scenes'
    LEFT JOIN ${itemTexts} r ON r.item_id = x.id AND r.kind = 'reference'
    WHERE o.id IN ${itemIds}
    GROUP BY o.id
  `);
  return new Map(Array.from(rows, ({ id, ...state }) => [id, state]));
}

/** The movie or episode itself, or a series' episodes, in the library. */
const queueScope = (serverId: number, itemId: string) => sql`
  ${items.serverId} = ${serverId} AND ${items.deletedAt} IS NULL
  AND ((${items.id} = ${itemId} AND ${items.type} IN ('Movie', 'Episode'))
    OR (${items.seriesId} = ${itemId} AND ${items.type} = 'Episode'))`;

export async function getSynopsisQueue(
  serverId: number,
  itemId: string,
): Promise<SynopsisQueue> {
  const [[row], [server]] = await Promise.all([
    db.execute<Omit<SynopsisQueue, "enabled">>(sql`
      SELECT
        count(*) FILTER (WHERE s.status = 'ready')::int AS written,
        count(*) FILTER (WHERE s.status = 'wanted')::int AS next,
        count(*) FILTER (WHERE t.status = 'ready' AND s.status IS DISTINCT FROM 'ready'
          AND s.status IS DISTINCT FROM 'wanted' AND s.status IS DISTINCT FROM 'declined')::int AS waiting,
        count(*) FILTER (WHERE t.status = 'ready' AND s.status = 'declined')::int AS declined,
        count(*) FILTER (WHERE t.status IS DISTINCT FROM 'ready'
          AND s.status IS DISTINCT FROM 'ready')::int AS "noSubtitles",
        count(*) FILTER (WHERE t.status IS DISTINCT FROM 'ready'
          AND s.status IS DISTINCT FROM 'ready' AND r.status = 'ready')::int AS wikipedia
      FROM ${items}
      LEFT JOIN ${itemTexts} t ON t.item_id = ${items.id} AND t.kind = 'transcript'
      LEFT JOIN ${itemTexts} s ON s.item_id = ${items.id} AND s.kind = 'scenes'
      LEFT JOIN ${itemTexts} r ON r.item_id = ${items.id} AND r.kind = 'reference'
      WHERE ${queueScope(serverId, itemId)}
    `),
    db
      .select({ enabled: servers.knowledgeIndexEnabled })
      .from(servers)
      .where(eq(servers.id, serverId)),
  ]);
  return {
    enabled: server?.enabled ?? false,
    written: row?.written ?? 0,
    next: row?.next ?? 0,
    waiting: row?.waiting ?? 0,
    declined: row?.declined ?? 0,
    noSubtitles: row?.noSubtitles ?? 0,
    wikipedia: row?.wikipedia ?? 0,
  };
}

/**
 * Put a movie's or episode's synopsis, or a series' episodes' still to be
 * written, at the front of the queue: the knowledge index writes them on its
 * next pass. Those already written are left as they are, and so are those every
 * model declined (they wait for a model that hasn't). How many were asked.
 */
export async function writeSynopsesNext(
  serverId: number,
  itemId: string,
): Promise<number> {
  const rows = await db.execute(sql`
    INSERT INTO ${itemTexts} (server_id, item_id, kind, status, checked_at)
    SELECT ${serverId}, ${items.id}, 'scenes', 'wanted', 'epoch'
    FROM ${items}
    JOIN ${itemTexts} t ON t.item_id = ${items.id} AND t.kind = 'transcript' AND t.status = 'ready'
    LEFT JOIN ${itemTexts} s ON s.item_id = ${items.id} AND s.kind = 'scenes'
    WHERE ${queueScope(serverId, itemId)}
      AND s.status IS DISTINCT FROM 'ready' AND s.status IS DISTINCT FROM 'wanted'
      AND s.status IS DISTINCT FROM 'declined'
    ON CONFLICT (item_id, kind) DO UPDATE SET status = 'wanted', checked_at = 'epoch'
    RETURNING 1
  `);
  return Array.from(rows).length;
}

export async function setKnowledgeIndexEnabled(
  serverId: number,
  enabled: boolean,
) {
  await db
    .update(servers)
    .set({ knowledgeIndexEnabled: enabled })
    .where(eq(servers.id, serverId));
}

/** Which item types get transcripts and synopses. */
export async function setKnowledgeItemTypes(serverId: number, types: string[]) {
  const allowed: readonly string[] = KNOWLEDGE_ITEM_TYPES;
  await db
    .update(servers)
    .set({ knowledgeItemTypes: types.filter((t) => allowed.includes(t)) })
    .where(eq(servers.id, serverId));
}

/**
 * Whether plots are fetched from Wikipedia. Turned off, the plots fetched so
 * far go too; synopses already written with them stay as they are.
 */
export async function setKnowledgeWikipedia(
  serverId: number,
  enabled: boolean,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(servers)
      .set({ knowledgeWikipedia: enabled })
      .where(eq(servers.id, serverId));
    if (!enabled) {
      await tx
        .delete(itemTexts)
        .where(
          and(
            eq(itemTexts.serverId, serverId),
            eq(itemTexts.kind, "reference"),
          ),
        );
    }
  });
}

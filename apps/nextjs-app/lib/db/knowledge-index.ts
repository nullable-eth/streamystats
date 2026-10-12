import "server-only";

import {
  db,
  items,
  itemTexts,
  KNOWLEDGE_ITEM_TYPES,
  servers,
} from "@streamystats/database";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export interface KnowledgeTypeStatus {
  type: (typeof KNOWLEDGE_ITEM_TYPES)[number];
  enabled: boolean;
  /** Items of this type in the library. */
  total: number;
  /** Looked at by the job so far (any outcome). */
  checked: number;
  transcripts: number;
  synopses: number;
  /** Checked, but no full text subtitle: Bazarr's to-do list. */
  missing: number;
}

export interface KnowledgeIndexStatus {
  enabled: boolean;
  embeddingsConfigured: boolean;
  chatConfigured: boolean;
  byType: KnowledgeTypeStatus[];
  /** Up to 10 enabled items with no full text subtitle, for Bazarr. */
  missingExamples: string[];
}

export async function getKnowledgeIndexStatus(
  serverId: number,
): Promise<KnowledgeIndexStatus> {
  const [server] = await db
    .select({
      enabled: servers.knowledgeIndexEnabled,
      types: servers.knowledgeItemTypes,
      embeddingModel: servers.embeddingModel,
      chatModel: servers.chatModel,
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

  const [totals, counts, examples] = await Promise.all([
    db
      .select({ type: items.type, n: sql<number>`count(*)::int` })
      .from(items)
      .where(inLibrary)
      .groupBy(items.type),
    db
      .select({
        type: items.type,
        kind: itemTexts.kind,
        status: itemTexts.status,
        n: sql<number>`count(*)::int`,
      })
      .from(itemTexts)
      .innerJoin(items, eq(items.id, itemTexts.itemId))
      .where(inLibrary)
      .groupBy(items.type, itemTexts.kind, itemTexts.status),
    enabledTypes.length === 0
      ? Promise.resolve([])
      : db
          .select({
            name: items.name,
            seriesName: items.seriesName,
            season: items.parentIndexNumber,
            episode: items.indexNumber,
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
          )
          .limit(10),
  ]);

  const count = (type: string, kind: string, status?: string) =>
    counts
      .filter(
        (c) =>
          c.type === type &&
          c.kind === kind &&
          (status === undefined || c.status === status),
      )
      .reduce((sum, c) => sum + c.n, 0);

  return {
    enabled: server?.enabled ?? false,
    embeddingsConfigured: Boolean(server?.embeddingModel),
    chatConfigured: Boolean(server?.chatModel),
    byType: KNOWLEDGE_ITEM_TYPES.map((type) => ({
      type,
      enabled: enabledTypes.includes(type),
      total: totals.find((t) => t.type === type)?.n ?? 0,
      checked: count(type, "transcript"),
      transcripts: count(type, "transcript", "ready"),
      synopses: count(type, "synopsis", "ready"),
      missing: count(type, "transcript", "missing"),
    })),
    missingExamples: examples.map((e) =>
      e.seriesName
        ? `${e.seriesName} S${String(e.season ?? 0).padStart(2, "0")}E${String(e.episode ?? 0).padStart(2, "0")}`
        : e.name,
    ),
  };
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

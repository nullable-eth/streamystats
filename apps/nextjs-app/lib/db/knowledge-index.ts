import "server-only";

import { db, items, itemTexts, servers } from "@streamystats/database";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export interface KnowledgeIndexStatus {
  enabled: boolean;
  embeddingsConfigured: boolean;
  chatConfigured: boolean;
  /** Movies and episodes in the library. */
  total: number;
  transcripts: number;
  synopses: number;
  /** Checked, but no full text subtitle: Bazarr's to-do list. */
  missing: number;
  missingExamples: string[];
}

export async function getKnowledgeIndexStatus(
  serverId: number,
): Promise<KnowledgeIndexStatus> {
  const [server] = await db
    .select({
      enabled: servers.knowledgeIndexEnabled,
      embeddingModel: servers.embeddingModel,
      chatModel: servers.chatModel,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  const inLibrary = and(
    eq(items.serverId, serverId),
    isNull(items.deletedAt),
    inArray(items.type, ["Movie", "Episode"]),
  );

  const [[{ total }], counts, examples] = await Promise.all([
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(items)
      .where(inLibrary),
    db
      .select({
        kind: itemTexts.kind,
        status: itemTexts.status,
        n: sql<number>`count(*)::int`,
      })
      .from(itemTexts)
      .innerJoin(items, eq(items.id, itemTexts.itemId))
      .where(inLibrary)
      .groupBy(itemTexts.kind, itemTexts.status),
    db
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

  const count = (kind: string, status: string) =>
    counts.find((c) => c.kind === kind && c.status === status)?.n ?? 0;

  return {
    enabled: server?.enabled ?? false,
    embeddingsConfigured: Boolean(server?.embeddingModel),
    chatConfigured: Boolean(server?.chatModel),
    total,
    transcripts: count("transcript", "ready"),
    synopses: count("synopsis", "ready"),
    missing: count("transcript", "missing"),
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

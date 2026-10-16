import "server-only";

import { db, itemTexts, knowledgeModels } from "@streamystats/database";
import { and, asc, eq, sql } from "drizzle-orm";
import type { ChatAIConfig, ChatProvider } from "./server";

/**
 * The models the knowledge index writes scene notes and synopses with, tried
 * in order (see the job's knowledge/models.ts): the first not resting after a
 * failure of its own gets the title, the next one gets it if that fails.
 * Secrets stay on the server.
 */
export interface KnowledgeModelPublic {
  id: number;
  name: string | null;
  /** Off: kept, but not tried. */
  enabled: boolean;
  provider: ChatProvider;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  /**
   * Titles whose current notes it wrote, by provider and model as the notes
   * record them: notes written for it elsewhere count, and another account's
   * copy of the same model shows the same count.
   */
  titles: number;
  /** ISO time it rests until after a failure of its own, if it is resting. */
  restingUntil: string | null;
  lastError: string | null;
}

export async function listKnowledgeModels(
  serverId: number,
): Promise<KnowledgeModelPublic[]> {
  const rows = await db
    .select()
    .from(knowledgeModels)
    .where(eq(knowledgeModels.serverId, serverId))
    .orderBy(asc(knowledgeModels.position), asc(knowledgeModels.id));
  const written = await db
    .select({ by: itemTexts.writtenBy, n: sql<number>`count(*)::int` })
    .from(itemTexts)
    .where(
      and(
        eq(itemTexts.serverId, serverId),
        eq(itemTexts.kind, "scenes"),
        eq(itemTexts.status, "ready"),
      ),
    )
    .groupBy(itemTexts.writtenBy);
  const titlesBy = new Map(written.map((w) => [w.by, w.n]));
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    provider: r.provider as ChatProvider,
    baseUrl: r.baseUrl,
    model: r.model,
    hasApiKey: Boolean(r.apiKey),
    titles: titlesBy.get(`${r.provider}:${r.model}`) ?? 0,
    restingUntil:
      r.unavailableUntil && r.unavailableUntil > now
        ? r.unavailableUntil.toISOString()
        : null,
    lastError: r.lastError,
  }));
}

/** A model's saved settings with its key, for a connection test. */
export async function getKnowledgeModelConfig(
  serverId: number,
  id: number,
): Promise<ChatAIConfig | null> {
  const [r] = await db
    .select()
    .from(knowledgeModels)
    .where(
      and(eq(knowledgeModels.serverId, serverId), eq(knowledgeModels.id, id)),
    );
  return r
    ? {
        provider: r.provider as ChatProvider,
        baseUrl: r.baseUrl ?? "",
        apiKey: r.apiKey ?? undefined,
        model: r.model,
      }
    : null;
}

/**
 * Add a model at the end of the list, or change one (an empty key keeps the
 * saved one). A changed model is no longer resting: the fix may be the change.
 */
export async function saveKnowledgeModel(
  serverId: number,
  input: ChatAIConfig & { id?: number },
) {
  const values = {
    provider: input.provider,
    name: input.name?.trim() || null,
    baseUrl: input.baseUrl.replace(/\/+$/, "") || null,
    model: input.model,
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey } : {}),
  };
  if (input.id !== undefined) {
    await db
      .update(knowledgeModels)
      .set({
        ...values,
        unavailableUntil: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeModels.serverId, serverId),
          eq(knowledgeModels.id, input.id),
        ),
      );
    return;
  }
  const [{ next }] = await db
    .select({
      next: sql<number>`coalesce(max(${knowledgeModels.position}) + 1, 0)::int`,
    })
    .from(knowledgeModels)
    .where(eq(knowledgeModels.serverId, serverId));
  await db
    .insert(knowledgeModels)
    .values({ ...values, serverId, position: next });
}

export async function removeKnowledgeModel(serverId: number, id: number) {
  await db
    .delete(knowledgeModels)
    .where(
      and(eq(knowledgeModels.serverId, serverId), eq(knowledgeModels.id, id)),
    );
}

/** Turn a model off (kept, not tried) or back on; back on, it is no longer resting. */
export async function setKnowledgeModelEnabled(
  serverId: number,
  id: number,
  enabled: boolean,
) {
  await db
    .update(knowledgeModels)
    .set({
      enabled,
      ...(enabled ? { unavailableUntil: null, lastError: null } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(eq(knowledgeModels.serverId, serverId), eq(knowledgeModels.id, id)),
    );
}

/** Swap a model with its neighbour above (-1) or below (1). */
export async function moveKnowledgeModel(
  serverId: number,
  id: number,
  direction: -1 | 1,
) {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: knowledgeModels.id })
      .from(knowledgeModels)
      .where(eq(knowledgeModels.serverId, serverId))
      .orderBy(asc(knowledgeModels.position), asc(knowledgeModels.id));
    const order = rows.map((r) => r.id);
    const at = order.indexOf(id);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    for (const [position, rowId] of order.entries()) {
      await tx
        .update(knowledgeModels)
        .set({ position })
        .where(eq(knowledgeModels.id, rowId));
    }
  });
}

/** The list as a backup keeps it: no keys, no counts. */
export async function exportKnowledgeModels(serverId: number) {
  return (await listKnowledgeModels(serverId)).map(
    ({ name, enabled, provider, baseUrl, model }) => ({
      name,
      enabled,
      provider,
      baseUrl,
      model,
    }),
  );
}

/**
 * Restore a backup's list in place of the server's, keys to be entered again
 * (an older backup's prices and budgets are ignored).
 */
export async function replaceKnowledgeModels(
  serverId: number,
  models: {
    name?: string | null;
    enabled?: boolean;
    provider: string;
    baseUrl: string | null;
    model: string;
  }[],
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(knowledgeModels)
      .where(eq(knowledgeModels.serverId, serverId));
    if (models.length === 0) return;
    await tx.insert(knowledgeModels).values(
      models.map((m, position) => ({
        serverId,
        position,
        name: m.name ?? null,
        enabled: m.enabled ?? true,
        provider: m.provider,
        baseUrl: m.baseUrl,
        model: m.model,
      })),
    );
  });
}

import "server-only";

import { db, knowledgeModels } from "@streamystats/database";
import { and, asc, eq, sql } from "drizzle-orm";
import type { ChatAIConfig, ChatProvider } from "./server";

/**
 * The models the knowledge index writes scene notes and synopses with, tried
 * in order (see the job's knowledge/models.ts): the first with budget left
 * this month that is not resting after a failure of its own gets the title,
 * the next one gets it if that fails. Secrets stay on the server.
 */
export interface KnowledgeModelPublic {
  id: number;
  provider: ChatProvider;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  /** USD per million tokens. */
  inputPrice: number;
  outputPrice: number;
  /** USD per calendar month (UTC); null: no limit. */
  monthlyBudget: number | null;
  spentThisMonth: number;
  titlesThisMonth: number;
  /** ISO time it rests until after a failure of its own, if it is resting. */
  restingUntil: string | null;
  lastError: string | null;
}

export interface KnowledgeModelInput extends ChatAIConfig {
  inputPrice: number;
  outputPrice: number;
  monthlyBudget: number | null;
}

const thisMonth = () => new Date().toISOString().slice(0, 7);

export async function listKnowledgeModels(
  serverId: number,
): Promise<KnowledgeModelPublic[]> {
  const rows = await db
    .select()
    .from(knowledgeModels)
    .where(eq(knowledgeModels.serverId, serverId))
    .orderBy(asc(knowledgeModels.position), asc(knowledgeModels.id));
  const month = thisMonth();
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider as ChatProvider,
    baseUrl: r.baseUrl,
    model: r.model,
    hasApiKey: Boolean(r.apiKey),
    inputPrice: r.inputPrice,
    outputPrice: r.outputPrice,
    monthlyBudget: r.monthlyBudget,
    spentThisMonth: r.spentMonth === month ? r.spent : 0,
    titlesThisMonth: r.spentMonth === month ? r.titles : 0,
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
  input: KnowledgeModelInput & { id?: number },
) {
  const values = {
    provider: input.provider,
    baseUrl: input.baseUrl.replace(/\/+$/, "") || null,
    model: input.model,
    inputPrice: input.inputPrice,
    outputPrice: input.outputPrice,
    monthlyBudget: input.monthlyBudget,
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

/** The list as a backup keeps it: no keys, no spend. */
export async function exportKnowledgeModels(serverId: number) {
  return (await listKnowledgeModels(serverId)).map(
    ({ provider, baseUrl, model, inputPrice, outputPrice, monthlyBudget }) => ({
      provider,
      baseUrl,
      model,
      inputPrice,
      outputPrice,
      monthlyBudget,
    }),
  );
}

/** Restore a backup's list in place of the server's, keys to be entered again. */
export async function replaceKnowledgeModels(
  serverId: number,
  models: {
    provider: string;
    baseUrl: string | null;
    model: string;
    inputPrice?: number;
    outputPrice?: number;
    monthlyBudget?: number | null;
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
        provider: m.provider,
        baseUrl: m.baseUrl,
        model: m.model,
        inputPrice: m.inputPrice ?? 0,
        outputPrice: m.outputPrice ?? 0,
        monthlyBudget: m.monthlyBudget ?? null,
      })),
    );
  });
}

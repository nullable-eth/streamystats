import "server-only";

import { db, itemTexts, knowledgeModels } from "@streamystats/database";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  rewriteLoops,
  withoutLoops,
  writerLabel,
} from "@/lib/knowledge-writers";
import type { ChatAIConfig, ChatProvider } from "./server";

/**
 * The models the knowledge index writes scene notes and synopses with (see
 * the job's knowledge/models.ts). A title without notes goes to the first not
 * resting after a failure of its own, and to the next if that fails; notes
 * already written are replaced only by a model asked to replace their
 * writer's. Secrets stay on the server.
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
  /** Writers whose notes it replaces. */
  rewriteFrom: string[];
  /** Requests it is sent at once; null: its provider's default. */
  parallelRequests: number | null;
  /** ISO time it rests until after a failure of its own, if it is resting. */
  restingUntil: string | null;
  lastError: string | null;
}

/** Who wrote the server's current notes, and for how many titles, most first. */
export async function listNoteWriters(
  serverId: number,
): Promise<{ label: string; titles: number }[]> {
  const rows = await db
    .select({ label: itemTexts.writtenBy, titles: sql<number>`count(*)::int` })
    .from(itemTexts)
    .where(
      and(
        eq(itemTexts.serverId, serverId),
        eq(itemTexts.kind, "scenes"),
        eq(itemTexts.status, "ready"),
        isNotNull(itemTexts.writtenBy),
      ),
    )
    .groupBy(itemTexts.writtenBy)
    .orderBy(desc(sql`count(*)`));
  return rows.flatMap((r) =>
    r.label ? [{ label: r.label, titles: r.titles }] : [],
  );
}

/** The synopsis written last, and by whom: whether synopses are coming in. */
export async function latestSynopsis(
  serverId: number,
): Promise<{ at: string; by: string | null } | null> {
  const [row] = await db
    .select({ at: itemTexts.updatedAt, by: itemTexts.writtenBy })
    .from(itemTexts)
    .where(
      and(
        eq(itemTexts.serverId, serverId),
        eq(itemTexts.kind, "scenes"),
        eq(itemTexts.status, "ready"),
      ),
    )
    .orderBy(desc(itemTexts.updatedAt))
    .limit(1);
  return row ? { at: row.at.toISOString(), by: row.by } : null;
}

export async function listKnowledgeModels(
  serverId: number,
): Promise<KnowledgeModelPublic[]> {
  const rows = await db
    .select()
    .from(knowledgeModels)
    .where(eq(knowledgeModels.serverId, serverId))
    .orderBy(asc(knowledgeModels.position), asc(knowledgeModels.id));
  const titlesBy = new Map(
    (await listNoteWriters(serverId)).map((w) => [w.label, w.titles]),
  );
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    provider: r.provider as ChatProvider,
    baseUrl: r.baseUrl,
    model: r.model,
    hasApiKey: Boolean(r.apiKey),
    titles: titlesBy.get(writerLabel(r)) ?? 0,
    rewriteFrom: r.rewriteFrom,
    parallelRequests: r.parallelRequests,
    restingUntil:
      r.unavailableUntil && r.unavailableUntil > now
        ? r.unavailableUntil.toISOString()
        : null,
    lastError: r.lastError,
  }));
}

/** Requests at once as entered: a whole number from 1 to 64, else the provider's default. */
const requestsAtOnce = (n: unknown) =>
  typeof n === "number" && Number.isInteger(n) && n >= 1
    ? Math.min(n, 64)
    : null;

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
 * One changed to another model no longer replaces anyone's notes: that was
 * asked of the old one.
 */
export async function saveKnowledgeModel(
  serverId: number,
  input: ChatAIConfig & { id?: number; parallelRequests?: number | null },
) {
  const values = {
    provider: input.provider,
    name: input.name?.trim() || null,
    baseUrl: input.baseUrl.replace(/\/+$/, "") || null,
    model: input.model,
    parallelRequests: requestsAtOnce(input.parallelRequests),
    ...(input.apiKey?.trim() ? { apiKey: input.apiKey } : {}),
  };
  if (input.id !== undefined) {
    const [saved] = await db
      .select({
        provider: knowledgeModels.provider,
        model: knowledgeModels.model,
      })
      .from(knowledgeModels)
      .where(
        and(
          eq(knowledgeModels.serverId, serverId),
          eq(knowledgeModels.id, input.id),
        ),
      );
    const another = saved && writerLabel(saved) !== writerLabel(input);
    await db
      .update(knowledgeModels)
      .set({
        ...values,
        ...(another ? { rewriteFrom: [] } : {}),
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

/**
 * Have a model replace a writer's notes, as it gets to them and any that
 * writer adds later, or stop. Refused when it would replace its own,
 * directly or round a loop.
 */
export async function setKnowledgeModelRewrite(
  serverId: number,
  id: number,
  from: string,
  on: boolean,
) {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(knowledgeModels)
      .where(eq(knowledgeModels.serverId, serverId));
    const model = rows.find((r) => r.id === id);
    if (!model) return;
    const rest = model.rewriteFrom.filter((l) => l !== from);
    if (on && rewriteLoops(rows, from, writerLabel(model))) {
      throw new Error("A model cannot replace its own notes, even in a loop");
    }
    await tx
      .update(knowledgeModels)
      .set({ rewriteFrom: on ? [...rest, from] : rest, updatedAt: new Date() })
      .where(eq(knowledgeModels.id, id));
  });
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
    ({
      name,
      enabled,
      provider,
      baseUrl,
      model,
      rewriteFrom,
      parallelRequests,
    }) => ({
      name,
      enabled,
      provider,
      baseUrl,
      model,
      rewriteFrom,
      parallelRequests,
    }),
  );
}

/**
 * Restore a backup's list in place of the server's, keys to be entered again
 * (an older backup's prices and budgets are ignored), less any rewrites that
 * would loop.
 */
export async function replaceKnowledgeModels(
  serverId: number,
  models: {
    name?: string | null;
    enabled?: boolean;
    provider: string;
    baseUrl: string | null;
    model: string;
    rewriteFrom?: string[];
    parallelRequests?: number | null;
  }[],
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(knowledgeModels)
      .where(eq(knowledgeModels.serverId, serverId));
    if (models.length === 0) return;
    await tx.insert(knowledgeModels).values(
      withoutLoops(models).map((m, position) => ({
        serverId,
        position,
        name: m.name ?? null,
        enabled: m.enabled ?? true,
        provider: m.provider,
        baseUrl: m.baseUrl,
        model: m.model,
        rewriteFrom: m.rewriteFrom,
        parallelRequests: requestsAtOnce(m.parallelRequests),
      })),
    );
  });
}

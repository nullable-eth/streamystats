import { db, knowledgeModels, servers } from "@streamystats/database";
import axios from "axios";
import { asc, eq, sql } from "drizzle-orm";
import { type ChatSettings, type Scene, type TitleInfo, type Usage, writePlot } from "./synopsis";

/**
 * The models the knowledge index writes with, in the order the server lists
 * them: a title goes to the first usable one (budget left this month, not
 * resting after a failure of its own) and on to the next if it fails, so
 * several accounts, a free tier or a local model can share the work. With
 * none listed, the AI Chat model writes, without a budget.
 */
export interface KnowledgeModel extends ChatSettings {
  /** null: the AI Chat model, standing in when none is listed. */
  id: number | null;
  /** USD per million tokens. */
  inputPrice: number;
  outputPrice: number;
  /** USD per calendar month (UTC); null: no limit. */
  monthlyBudget: number | null;
  spentMonth: string | null;
  spent: number;
  unavailableUntil: Date | null;
}

/** How long a model that failed on its own account rests, unless it asks for longer. */
const REST_MS = 60 * 60_000;

/** Who wrote a title's notes, as kept with them. */
export const modelLabel = (m: ChatSettings) => `${m.provider}:${m.model}`;

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

export async function getKnowledgeModels(serverId: number): Promise<KnowledgeModel[]> {
  const rows = await db
    .select()
    .from(knowledgeModels)
    .where(eq(knowledgeModels.serverId, serverId))
    .orderBy(asc(knowledgeModels.position), asc(knowledgeModels.id));
  if (rows.length > 0) return rows;
  const [s] = await db
    .select({ provider: servers.chatProvider, baseUrl: servers.chatBaseUrl, apiKey: servers.chatApiKey, model: servers.chatModel })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!s?.provider || !s.model) return [];
  return [
    {
      ...s,
      provider: s.provider,
      model: s.model,
      id: null,
      inputPrice: 0,
      outputPrice: 0,
      monthlyBudget: null,
      spentMonth: null,
      spent: 0,
      unavailableUntil: null,
    },
  ];
}

export const spentThisMonth = (m: KnowledgeModel, now = new Date()) => (m.spentMonth === monthOf(now) ? m.spent : 0);

export const costOf = (m: KnowledgeModel, usage: Usage) =>
  (usage.inputTokens * m.inputPrice + usage.outputTokens * m.outputPrice) / 1e6;

/** Not resting after a failure of its own, and with budget left this month. */
export function isUsable(m: KnowledgeModel, now = new Date()): boolean {
  if (m.unavailableUntil && m.unavailableUntil > now) return false;
  return m.monthlyBudget === null || spentThisMonth(m, now) < m.monthlyBudget;
}

/**
 * How long a failure benches the model, or null when it is the title's
 * (too long for the model, an answer that could not be read, a timeout):
 * a rejected key or unknown model, no credit or quota left, rate limits that
 * outlast the retries, a server error, or no answer at all.
 */
export function restFor(failure: { status?: number; body: string; retryAfterSeconds?: number; timedOut?: boolean }) {
  const rest = Math.max(REST_MS, (failure.retryAfterSeconds ?? 0) * 1000);
  if (failure.timedOut) return null;
  if (failure.status === undefined) return rest;
  if ([401, 402, 403, 404, 429].includes(failure.status) || failure.status >= 500) return rest;
  if (failure.status === 400 && /credit|billing|quota|balance/i.test(failure.body)) return rest;
  return null;
}

/** An HTTP failure's status and body (a streamed response's too); undefined status for no answer. */
async function failureOf(error: unknown) {
  if (!axios.isAxiosError(error)) return { status: 0, body: error instanceof Error ? error.message : String(error) };
  const timedOut = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
  const response = error.response;
  if (!response) return { status: undefined, body: error.message, timedOut };
  let body: unknown = response.data;
  if (body && typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
    let text = "";
    for await (const chunk of body as AsyncIterable<Buffer | string>) {
      text += chunk.toString();
      if (text.length > 2000) break;
    }
    body = text;
  }
  return {
    status: response.status,
    body: typeof body === "string" ? body : JSON.stringify(body ?? ""),
    retryAfterSeconds: Number(response.headers?.["retry-after"]) || undefined,
    timedOut,
  };
}

/** A request's cost, added to its model's spend this month. */
async function spend(model: KnowledgeModel, usage: Usage) {
  const now = new Date();
  const month = monthOf(now);
  const cost = costOf(model, usage);
  model.spent = spentThisMonth(model, now) + cost;
  model.spentMonth = month;
  if (model.id === null) return;
  const sameMonth = sql`${knowledgeModels.spentMonth} = ${month}`;
  await db
    .update(knowledgeModels)
    .set({
      spent: sql`CASE WHEN ${sameMonth} THEN ${knowledgeModels.spent} ELSE 0 END + ${cost}`,
      titles: sql`CASE WHEN ${sameMonth} THEN ${knowledgeModels.titles} ELSE 0 END`,
      spentMonth: month,
    })
    .where(eq(knowledgeModels.id, model.id));
}

/**
 * A title's scene notes and synopsis from the first usable model that writes
 * them. A model that fails moves the title on to the next; one that failed on
 * its own account (see restFor) also rests, so the titles after it skip it.
 */
export async function writePlotWithModels(
  models: KnowledgeModel[],
  info: TitleInfo,
  parts: Scene[]
): Promise<{ scenes: Scene[]; synopsis: string; model: KnowledgeModel }> {
  let lastError: unknown = new Error("No knowledge index model is usable: all are over budget or resting");
  for (const model of models) {
    if (!isUsable(model)) continue;
    try {
      const plot = await writePlot(model, info, parts, (usage) => spend(model, usage));
      if (model.id !== null) {
        await db
          .update(knowledgeModels)
          .set({ titles: sql`${knowledgeModels.titles} + 1` })
          .where(eq(knowledgeModels.id, model.id));
      }
      return { ...plot, model };
    } catch (error) {
      lastError = error;
      const failure = await failureOf(error);
      const rest = restFor(failure);
      if (rest === null) continue;
      model.unavailableUntil = new Date(Date.now() + rest);
      if (model.id !== null) {
        await db
          .update(knowledgeModels)
          .set({
            unavailableUntil: model.unavailableUntil,
            lastError: `${failure.status ?? "no answer"}: ${failure.body}`.slice(0, 500),
          })
          .where(eq(knowledgeModels.id, model.id));
      }
    }
  }
  throw lastError;
}

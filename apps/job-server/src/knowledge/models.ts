import { db, knowledgeModels, servers } from "@streamystats/database";
import axios from "axios";
import { asc, eq, sql } from "drizzle-orm";
import { MAX_WAIT_MS, waitAsked } from "./retry";
import { type ChatSettings, type Scene, type TitleInfo, writePlot } from "./synopsis";

/**
 * The models the knowledge index writes with, in the order the server lists
 * them: a title goes to the first one not resting after a failure of its own
 * and on to the next if it fails, so several accounts, a free tier or a local
 * model can share the work. With none listed, the AI Chat model writes.
 */
export interface KnowledgeModel extends ChatSettings {
  /** null: the AI Chat model, standing in when none is listed. */
  id: number | null;
  unavailableUntil: Date | null;
}

/** How long a rejected key, unknown model or empty account rests. */
const REST_MS = 60 * 60_000;
/** How long a busy or unreachable model rests, and a rate-limited one that does not say. */
const SHORT_REST_MS = 15 * 60_000;

/** Who wrote a title's notes, as kept with them. */
export const modelLabel = (m: ChatSettings) => `${m.provider}:${m.model}`;

export async function getKnowledgeModels(serverId: number): Promise<KnowledgeModel[]> {
  const rows = await db
    .select()
    .from(knowledgeModels)
    .where(eq(knowledgeModels.serverId, serverId))
    .orderBy(asc(knowledgeModels.position), asc(knowledgeModels.id));
  // Listed ones turned off are not tried; the chat model stands in only for an empty list.
  if (rows.length > 0) return rows.filter((r) => r.enabled);
  const [s] = await db
    .select({ provider: servers.chatProvider, baseUrl: servers.chatBaseUrl, apiKey: servers.chatApiKey, model: servers.chatModel })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!s?.provider || !s.model) return [];
  return [{ ...s, provider: s.provider, model: s.model, id: null, unavailableUntil: null }];
}

/** Not resting after a failure of its own. */
export const isUsable = (m: KnowledgeModel, now = new Date()) => !m.unavailableUntil || m.unavailableUntil <= now;

/**
 * How long a failure benches the model, or null when it is the title's (too
 * long for the model, an answer that could not be read, a timeout). A rate
 * limit rests it until the provider says it resets, or SHORT_REST_MS when it
 * does not say or the retries ran out; a server error or no answer, at least
 * SHORT_REST_MS; a rejected key, unknown model or no credit, REST_MS.
 */
export function restFor(failure: { status?: number; body: string; waitMs?: number | null; timedOut?: boolean }) {
  if (failure.timedOut) return null;
  const asked = failure.waitMs ?? 0;
  if (failure.status === 429) return asked > MAX_WAIT_MS ? asked : SHORT_REST_MS;
  if (failure.status === undefined || failure.status >= 500) return Math.max(SHORT_REST_MS, asked);
  if ([401, 402, 403, 404].includes(failure.status)) return REST_MS;
  if (failure.status === 400 && /credit|billing|quota|balance/i.test(failure.body)) return REST_MS;
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
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  return { status: response.status, body: text, waitMs: waitAsked(response.headers ?? {}, text), timedOut };
}

/** What an error body says, without the JSON around it (OpenRouter puts the provider's reason in metadata.raw). */
export function messageOf(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error ?? parsed;
    const said = [error?.message, error?.metadata?.raw].filter((s) => typeof s === "string" && s);
    if (said.length > 0) return said.join(": ");
  } catch {}
  return body;
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
  let lastError: unknown = new Error("No knowledge index model is usable: all are resting");
  for (const model of models) {
    if (!isUsable(model)) continue;
    try {
      const plot = await writePlot(model, info, parts);
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
            lastError: `${failure.status ?? "no answer"}: ${messageOf(failure.body)}`.slice(0, 500),
          })
          .where(eq(knowledgeModels.id, model.id));
      }
    }
  }
  throw lastError;
}

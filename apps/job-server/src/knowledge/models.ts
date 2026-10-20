import { db, knowledgeModels, servers } from "@streamystats/database";
import axios from "axios";
import { asc, eq } from "drizzle-orm";
import { MAX_WAIT_MS, waitAsked } from "./retry";
import { type ChatSettings, type Scene, type TitleInfo, writePlot } from "./synopsis";

/**
 * The models the knowledge index writes with, in the order the server lists
 * them: a title without notes goes to the first one not resting after a
 * failure of its own and on to the next if it fails, so several accounts, a
 * free tier or a local model can share the work. With none listed, the AI
 * Chat model writes.
 */
export interface KnowledgeModel extends ChatSettings {
  /** null: the AI Chat model, standing in when none is listed. */
  id: number | null;
  unavailableUntil: Date | null;
  /** Writers whose notes it replaces, as asked in the settings. */
  rewriteFrom: string[];
  /** Requests it is sent at once; null: its provider's default (see parallelOf). */
  parallelRequests: number | null;
}

/** How long a rejected key, unknown model or empty account rests. */
const REST_MS = 60 * 60_000;
/** How long a busy or unreachable model rests, and a rate-limited one that does not say. */
export const SHORT_REST_MS = 15 * 60_000;
/**
 * Titles in a row a model may fail on what look like the titles' own accounts
 * (a bad request, an answer that can't be read, a timeout) before the failures
 * count as the model's: one failing every title is broken, not the titles.
 */
const STRIKES = 3;
/** Per model: its title failures in a row (and, for the AI Chat model, when its rest ends). */
const strikes = new Map<string, number>();
const chatBenchedUntil = new Map<string, number>();
const keyOf = (model: KnowledgeModel) => (model.id === null ? `chat:${modelLabel(model)}` : `id:${model.id}`);

/**
 * No model wrote the title. `titlesFault`: every model tried failed on the
 * title's account, so the title waits before it is tried again; otherwise the
 * models were resting or failed on their own (a rate limit, a server error,
 * a model failing every title), and the title stays due for when one is back.
 */
export class WriteFailure extends Error {
  constructor(
    readonly cause: unknown,
    readonly titlesFault: boolean
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Requests a hosted API is sent at once unless set; a local server is sent one. */
const HOSTED_PARALLEL = 4;

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
  return [{ ...s, provider: s.provider, model: s.model, id: null, unavailableUntil: null, rewriteFrom: [], parallelRequests: null }];
}

/** Writers whose notes the models replace, never their own. */
export const rewritesOf = (models: KnowledgeModel[]) =>
  [...new Set(models.flatMap((m) => m.rewriteFrom.filter((l) => l !== modelLabel(m))))];

/**
 * Which of `models` (the usable ones, in order) write a title's notes. None
 * yet: any, in order. Notes by a writer a model was asked to replace: those
 * models. Otherwise none: notes once written are kept, whatever the list's
 * order and whatever subtitles or Wikipedia plot turn up later (new subtitles
 * mostly differ in wording and timing; a rewrite is asked for when one is
 * worth it).
 */
export function writersFor(
  previous: { status: string; writtenBy: string | null } | undefined,
  models: KnowledgeModel[]
): KnowledgeModel[] {
  if (previous?.status !== "ready") return models;
  const by = previous.writtenBy;
  return models.filter((m) => by !== null && by !== modelLabel(m) && m.rewriteFrom.includes(by));
}

/** Requests a model is sent at once: as set, or by default 4 to Anthropic and Gemini, 1 to others. */
export const parallelOf = (m: KnowledgeModel) =>
  m.parallelRequests ?? (["anthropic", "gemini"].includes(m.provider) ? HOSTED_PARALLEL : 1);

/** Each model's requests in flight (by id; the chat model by its label) and titles waiting for one. */
const slots = new Map<number | string, { running: number; waiting: (() => void)[] }>();

/** `work` once the model has a request free; told whether it had to wait. */
export async function inSlot<T>(model: KnowledgeModel, work: (waited: boolean) => Promise<T>): Promise<T> {
  const key = model.id ?? modelLabel(model);
  const slot = slots.get(key) ?? { running: 0, waiting: [] };
  slots.set(key, slot);
  let waited = false;
  while (slot.running >= parallelOf(model)) {
    waited = true;
    await new Promise<void>((wake) => slot.waiting.push(wake));
  }
  slot.running++;
  try {
    return await work(waited);
  } finally {
    slot.running--;
    slot.waiting.shift()?.();
  }
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
 * them, once it has a request free (see parallelOf). A model that fails moves
 * the title on to the next; one that failed on its own account (see restFor)
 * also rests, so the titles after it skip it.
 */
export async function writePlotWithModels(
  models: KnowledgeModel[],
  info: TitleInfo,
  parts: Scene[]
): Promise<{ scenes: Scene[]; synopsis: string; model: KnowledgeModel }> {
  let lastError: unknown = new Error("No knowledge index model is usable: all are resting");
  let tried = false;
  let modelsFault = false;
  for (const model of models) {
    if (!isUsable(model)) continue;
    const written = await inSlot(model, async (waited) => {
      // Another title's request may have rested it meanwhile.
      if (waited && model.id !== null) {
        const [now] = await db
          .select({ until: knowledgeModels.unavailableUntil })
          .from(knowledgeModels)
          .where(eq(knowledgeModels.id, model.id));
        model.unavailableUntil = now?.until ?? null;
        if (!isUsable(model)) return null;
      }
      try {
        const plot = await writePlot(model, info, parts);
        strikes.delete(keyOf(model));
        return { ...plot, model };
      } catch (error) {
        lastError = error;
        tried = true;
        if (await restAfter(model, error)) modelsFault = true;
        return null;
      }
    });
    if (written) return written;
  }
  throw new WriteFailure(lastError, tried && !modelsFault);
}

/** Whether the model is resting now, by its saved rest: settings may have lifted it since. */
async function resting(model: KnowledgeModel): Promise<boolean> {
  if (model.id === null) return (chatBenchedUntil.get(keyOf(model)) ?? 0) > Date.now();
  const [row] = await db
    .select({ until: knowledgeModels.unavailableUntil })
    .from(knowledgeModels)
    .where(eq(knowledgeModels.id, model.id));
  return !!row?.until && row.until.getTime() > Date.now();
}

/**
 * Rest a model after a failure of its own (see restFor). A title's failure
 * leaves it be, unless it is the model's STRIKES-th in a row. Returns whether
 * the failure was the model's: it rested, or was already resting (another
 * title's request benched it while this one was in flight).
 */
async function restAfter(model: KnowledgeModel, error: unknown): Promise<boolean> {
  const key = keyOf(model);
  if (await resting(model)) return true;
  const failure = await failureOf(error);
  let rest = restFor(failure);
  let said = `${failure.status ?? "no answer"}: ${messageOf(failure.body)}`;
  if (rest === null) {
    const inRow = (strikes.get(key) ?? 0) + 1;
    strikes.set(key, inRow);
    if (inRow < STRIKES) return false;
    rest = SHORT_REST_MS;
    said = `failed ${inRow} titles in a row, the last with ${said}`;
  }
  strikes.delete(key);
  model.unavailableUntil = new Date(Date.now() + rest);
  if (model.id === null) {
    chatBenchedUntil.set(key, model.unavailableUntil.getTime());
    return true;
  }
  await db
    .update(knowledgeModels)
    .set({ unavailableUntil: model.unavailableUntil, lastError: said.slice(0, 500) })
    .where(eq(knowledgeModels.id, model.id));
  return true;
}

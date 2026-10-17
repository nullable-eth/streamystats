import { db, servers } from "@streamystats/database";
import axios from "axios";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import { TIMEOUT_CONFIG } from "../jobs/config";
import { trimToFit } from "./fit";

/**
 * Batch text embedding with the server's configured embedding provider, the
 * same model and endpoints the item embedding job uses, so chunk vectors are
 * comparable to query vectors embedded by the chat tools.
 */
export interface EmbeddingSettings {
  provider: "openai-compatible" | "ollama" | "voyage" | "gemini";
  baseUrl: string;
  apiKey?: string;
  model: string;
  dimensions?: number;
}

export async function getEmbeddingSettings(
  serverId: number
): Promise<EmbeddingSettings | null> {
  const [s] = await db
    .select({
      provider: servers.embeddingProvider,
      baseUrl: servers.embeddingBaseUrl,
      apiKey: servers.embeddingApiKey,
      model: servers.embeddingModel,
      dimensions: servers.embeddingDimensions,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!s?.provider || !s.baseUrl || !s.model) return null;
  const provider =
    s.provider === "openai" ? "openai-compatible" : s.provider;
  if (
    provider !== "openai-compatible" &&
    provider !== "ollama" &&
    provider !== "voyage" &&
    provider !== "gemini"
  ) {
    return null;
  }
  return {
    provider,
    baseUrl: s.baseUrl.replace(/\/+$/, ""),
    apiKey: s.apiKey?.trim() || undefined,
    model: s.model,
    dimensions: s.dimensions ?? undefined,
  };
}

function isVector(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every(Number.isFinite);
}

function vectors(raw: unknown, expected: number): number[][] {
  if (!Array.isArray(raw) || raw.length !== expected) {
    throw new Error(`Embedding response did not contain ${expected} vectors`);
  }
  return raw.map((v) => {
    if (!isVector(v)) throw new Error("Embedding response contained an invalid vector");
    return v;
  });
}

/** How embedding servers say an input is longer than they take (llama.cpp, OpenAI, Ollama, Voyage, Gemini). */
const TOO_LONG = /too (large|long)|context length|maximum.*tokens|token limit|exceeds|input length/i;
const tooLong = (error: unknown) => {
  const body = axios.isAxiosError(error) ? JSON.stringify(error.response?.data ?? "") : "";
  return TOO_LONG.test(`${error instanceof Error ? error.message : String(error)} ${body}`);
};
/** The longest text each endpoint took after rejecting a longer one: later texts are cut to it first. */
const fits = new Map<string, number>();
/** Shorter than this, a rejected text is not too long: something else is wrong. */
const MIN_FIT_CHARS = 200;

/**
 * Vectors for texts, in order. A text the endpoint rejects as too long is cut
 * in half until it is taken, so one long text never fails the rest; the
 * length taken is kept for the endpoint's later texts.
 */
export async function embedTexts(settings: EmbeddingSettings, texts: string[]): Promise<number[][]> {
  const endpoint = `${settings.provider} ${settings.baseUrl} ${settings.model}`;
  const max = fits.get(endpoint);
  const fitted = max ? texts.map((t) => trimToFit(t, max)) : texts;
  try {
    return await requestVectors(settings, fitted);
  } catch (error) {
    if (!tooLong(error)) throw error;
  }
  const vectors: number[][] = [];
  for (let text of fitted) {
    for (let cut = false; ; cut = true) {
      try {
        vectors.push(...(await requestVectors(settings, [text])));
        if (cut) fits.set(endpoint, Math.min(fits.get(endpoint) ?? Number.POSITIVE_INFINITY, text.length));
        break;
      } catch (error) {
        if (!tooLong(error) || text.length < MIN_FIT_CHARS) throw error;
        text = trimToFit(text, Math.floor(text.length / 2));
      }
    }
  }
  return vectors;
}

async function requestVectors(settings: EmbeddingSettings, texts: string[]): Promise<number[][]> {
  const { provider, baseUrl, apiKey, model, dimensions } = settings;
  const timeout = TIMEOUT_CONFIG.DEFAULT;
  const bearer = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

  switch (provider) {
    case "openai-compatible": {
      const client = new OpenAI({ apiKey: apiKey ?? "not-needed", baseURL: baseUrl, timeout });
      const create = (withDimensions: boolean) =>
        client.embeddings.create({
          model,
          input: texts,
          encoding_format: "float",
          ...(withDimensions && dimensions ? { dimensions } : {}),
        });
      // Some OpenAI-compatible servers reject `dimensions`; retry without.
      const res = await create(true).catch(() => create(false));
      return vectors(res.data.map((d) => d.embedding), texts.length);
    }
    case "ollama": {
      const res = await axios.post(
        `${baseUrl}/api/embed`,
        { model, input: texts, keep_alive: "5m" },
        { headers: bearer, timeout }
      );
      return vectors(res.data?.embeddings, texts.length);
    }
    case "voyage": {
      const res = await axios.post(
        `${baseUrl}/embeddings`,
        {
          model,
          input: texts,
          input_type: "document",
          ...(dimensions ? { output_dimension: dimensions } : {}),
        },
        { headers: bearer, timeout }
      );
      const data: unknown = res.data?.data;
      return vectors(
        Array.isArray(data) ? data.map((d) => d?.embedding) : data,
        texts.length
      );
    }
    case "gemini": {
      const name = model.startsWith("models/") ? model : `models/${model}`;
      const res = await axios.post(
        `${baseUrl}/${name}:batchEmbedContents`,
        {
          requests: texts.map((text) => ({
            model: name,
            content: { parts: [{ text }] },
            taskType: "SEMANTIC_SIMILARITY",
            ...(dimensions ? { outputDimensionality: dimensions } : {}),
          })),
        },
        { headers: apiKey ? { "x-goog-api-key": apiKey } : {}, timeout }
      );
      const data: unknown = res.data?.embeddings;
      return vectors(
        Array.isArray(data) ? data.map((d) => d?.values) : data,
        texts.length
      );
    }
  }
}

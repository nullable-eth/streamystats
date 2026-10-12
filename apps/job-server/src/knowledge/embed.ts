import { db, servers } from "@streamystats/database";
import axios from "axios";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import { TIMEOUT_CONFIG } from "../jobs/config";

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

export async function embedTexts(
  settings: EmbeddingSettings,
  texts: string[]
): Promise<number[][]> {
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

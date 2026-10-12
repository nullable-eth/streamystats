import { db, servers } from "@streamystats/database";
import axios from "axios";
import { eq } from "drizzle-orm";
import OpenAI from "openai";

/**
 * Plot synopses written by the server's configured chat model from an item's
 * transcript. No outside source is involved: the transcript is the evidence,
 * and the model only condenses it.
 */
export interface ChatSettings {
  provider: string;
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
}

const TIMEOUT_MS = 15 * 60_000;
const FULL_CHARS = 120_000;
const SHORT_CHARS = 30_000;

export async function getChatSettings(serverId: number): Promise<ChatSettings | null> {
  const [s] = await db
    .select({
      provider: servers.chatProvider,
      baseUrl: servers.chatBaseUrl,
      apiKey: servers.chatApiKey,
      model: servers.chatModel,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!s?.provider || !s.model) return null;
  return { provider: s.provider, baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model };
}

/** Keep the opening and the ending, which carry the setup and the payoff. */
export function fitTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) return transcript;
  const half = Math.floor(maxChars / 2);
  return `${transcript.slice(0, half)}\n[...]\n${transcript.slice(-half)}`;
}

export function synopsisPrompt(title: string, overview: string | null, transcript: string): string {
  return [
    `Title: ${title}`,
    overview ? `Official overview: ${overview}` : null,
    "",
    "Dialogue transcript (from subtitles, no speaker names):",
    transcript,
    "",
    "Write the complete plot synopsis of this title in 200-400 words of plain prose.",
    "Name the setting, the main characters, what happens, every twist and how it ends.",
    "Use only what the transcript and overview support; never invent events.",
    "Reply with the synopsis only: no heading, no preamble, no notes.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Reasoning models may prefix their answer with a thinking block. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function complete(chat: ChatSettings, prompt: string): Promise<string> {
  const base = chat.baseUrl?.replace(/\/+$/, "");
  switch (chat.provider) {
    case "anthropic": {
      const res = await axios.post(
        `${base || "https://api.anthropic.com"}/v1/messages`,
        { model: chat.model, max_tokens: 2048, messages: [{ role: "user", content: prompt }] },
        {
          headers: { "x-api-key": chat.apiKey ?? "", "anthropic-version": "2023-06-01" },
          timeout: TIMEOUT_MS,
        }
      );
      const blocks: unknown = res.data?.content;
      return Array.isArray(blocks)
        ? blocks.map((b) => (typeof b?.text === "string" ? b.text : "")).join("")
        : "";
    }
    case "gemini": {
      const name = chat.model.startsWith("models/") ? chat.model : `models/${chat.model}`;
      const res = await axios.post(
        `${base || "https://generativelanguage.googleapis.com/v1beta"}/${name}:generateContent`,
        { contents: [{ role: "user", parts: [{ text: prompt }] }] },
        { headers: { "x-goog-api-key": chat.apiKey ?? "" }, timeout: TIMEOUT_MS }
      );
      const parts: unknown = res.data?.candidates?.[0]?.content?.parts;
      return Array.isArray(parts)
        ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
    }
    default: {
      // "openai-compatible" and "ollama" (its OpenAI-compatible /v1 API).
      const client = new OpenAI({
        apiKey: chat.apiKey || "not-needed",
        baseURL: base || (chat.provider === "ollama" ? "http://localhost:11434/v1" : undefined),
        timeout: TIMEOUT_MS,
        maxRetries: 1,
      });
      const res = await client.chat.completions.create({
        model: chat.model,
        messages: [{ role: "user", content: prompt }],
      });
      return res.choices[0]?.message?.content ?? "";
    }
  }
}

/**
 * Synopsis of a transcript. Tries the whole transcript first; a model whose
 * context window is too small gets a shorter head-and-tail cut instead.
 */
export async function writeSynopsis(
  chat: ChatSettings,
  title: string,
  overview: string | null,
  transcript: string
): Promise<string> {
  let lastError: unknown;
  for (const maxChars of [FULL_CHARS, SHORT_CHARS]) {
    try {
      const text = stripThinking(
        await complete(chat, synopsisPrompt(title, overview, fitTranscript(transcript, maxChars)))
      );
      if (text.split(/\s+/).length >= 50) return text;
      lastError = new Error("Chat model returned an empty or too-short synopsis");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

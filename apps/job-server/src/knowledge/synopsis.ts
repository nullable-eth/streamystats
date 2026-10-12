import { db, servers } from "@streamystats/database";
import axios from "axios";
import { eq } from "drizzle-orm";

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
  // Optional override for the synopsis model only, e.g. a plain
  // OpenAI-compatible endpoint when the chat model sits behind an agent
  // gateway that would narrate instead of answering. Defaults to AI Chat.
  const { KNOWLEDGE_SYNOPSIS_BASE_URL: url, KNOWLEDGE_SYNOPSIS_MODEL: model } = process.env;
  if (url) {
    return {
      provider: "openai-compatible",
      baseUrl: url,
      apiKey: process.env.KNOWLEDGE_SYNOPSIS_API_KEY || s?.apiKey || null,
      model: model || s?.model || "default",
    };
  }
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
    "Reply with the synopsis between <synopsis> and </synopsis>, nothing else.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * The synopsis itself: drops a reasoning model's thinking block and any
 * chatter around the <synopsis> tags (agent gateways like to narrate).
 */
export function extractSynopsis(text: string): string {
  const answer = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const tagged = /<synopsis>([\s\S]*?)(?:<\/synopsis>|$)/i.exec(answer);
  return (tagged ? tagged[1] : answer).trim();
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
      // A synopsis needs no reasoning: ask templates that support it (Qwen3,
      // llama.cpp, vLLM) to skip thinking, which otherwise costs thousands of
      // tokens per item. Servers that reject the extra field get a plain retry.
      const url = `${base || (chat.provider === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1")}/chat/completions`;
      const headers = chat.apiKey ? { Authorization: `Bearer ${chat.apiKey}` } : {};
      const body = { model: chat.model, messages: [{ role: "user", content: prompt }] };
      const post = (extra: object) =>
        axios.post(url, { ...body, ...extra }, { headers, timeout: TIMEOUT_MS });
      const res = await post({ chat_template_kwargs: { enable_thinking: false } }).catch(
        (error: unknown) => {
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          if (status === 400 || status === 422) return post({});
          throw error;
        }
      );
      const content: unknown = res.data?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : "";
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
      const text = extractSynopsis(
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

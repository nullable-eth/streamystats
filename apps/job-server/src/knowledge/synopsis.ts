import { db, servers } from "@streamystats/database";
import axios from "axios";
import { eq } from "drizzle-orm";

/**
 * The plot, written from an item's transcript by the server's knowledge index
 * model, or its AI Chat model when none is set. No outside source is
 * involved: the transcript is the evidence. Asked to condense a whole film at
 * once, a mid-size model drops plot points and invents others (a wrong
 * killer, an ending that never happens); put a few minutes of dialogue at a
 * time into plot language, it stays faithful. So the story is written up
 * part by part, as scene notes with their times, and the synopsis is
 * summarised from the notes.
 */
export interface ChatSettings {
  provider: string;
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
}

const TIMEOUT_MS = 15 * 60_000;
/** A part of the story: a few minutes of dialogue, a scene or two. */
const PART_MS = 8 * 60_000;
const PART_CHARS = 12_000;
/** The notes on earlier parts each part is written with; the latest kept. */
const STORY_SO_FAR_CHARS = 16_000;
/** Faithful rather than creative; server defaults are often 0.8-1.0. */
const TEMPERATURE = 0.3;

/** Scene notes on one part of the story, or that part's dialogue. */
export interface Scene {
  startMs: number;
  /** When the part's last line starts. */
  endMs: number;
  text: string;
}

export async function getChatSettings(serverId: number): Promise<ChatSettings | null> {
  const [s] = await db
    .select({
      synopsisProvider: servers.synopsisProvider,
      synopsisBaseUrl: servers.synopsisBaseUrl,
      synopsisApiKey: servers.synopsisApiKey,
      synopsisModel: servers.synopsisModel,
      chatProvider: servers.chatProvider,
      chatBaseUrl: servers.chatBaseUrl,
      chatApiKey: servers.chatApiKey,
      chatModel: servers.chatModel,
    })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (s?.synopsisProvider && s.synopsisModel) {
    return {
      provider: s.synopsisProvider,
      baseUrl: s.synopsisBaseUrl,
      apiKey: s.synopsisApiKey,
      model: s.synopsisModel,
    };
  }
  if (!s?.chatProvider || !s.chatModel) return null;
  return {
    provider: s.chatProvider,
    baseUrl: s.chatBaseUrl,
    apiKey: s.chatApiKey,
    model: s.chatModel,
  };
}

/** Endpoints that rejected the sampling hints; not sent to them again. */
const plainEndpoints = new Set<string>();

/**
 * The synopsis as search windows: the whole of it, for the story as a whole,
 * and each paragraph on its own, so a single plot point (a twist in the last
 * scene) is not drowned out by the rest. Each starts with the title, which a
 * paragraph on its own rarely names.
 */
export function synopsisWindows(title: string, synopsis: string): string[] {
  const whole = synopsis.trim();
  if (!whole) return [];
  const paragraphs = whole
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const windows = paragraphs.length > 1 ? [whole, ...paragraphs] : [whole];
  return windows.map((w) => `${title}: ${w}`);
}

/** Each scene's notes as a search window of its own, with its times. */
export function sceneWindows(title: string, scenes: Scene[]): Scene[] {
  return scenes.map((s) => ({ ...s, text: `${title}: ${s.text}` }));
}

/** A transcript's lines (one per subtitle cue) in parts of a few minutes. */
export function transcriptParts(lines: string[], startsMs: number[]): Scene[] {
  const parts: Scene[] = [];
  for (let i = 0; i < Math.min(lines.length, startsMs.length); i++) {
    const part = parts.at(-1);
    if (
      part &&
      startsMs[i] - part.startMs < PART_MS &&
      part.text.length + lines[i].length < PART_CHARS
    ) {
      part.text += `\n${lines[i]}`;
      part.endMs = startsMs[i];
    } else {
      parts.push({ startMs: startsMs[i], endMs: startsMs[i], text: lines[i] });
    }
  }
  return parts;
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};

/** Scene notes as stored: each part under its times, [hh:mm:ss-hh:mm:ss]. */
export function formatScenes(scenes: Scene[]): string {
  // The end rounded up, so the part's last line stays inside it.
  return scenes
    .map((s) => `[${clock(s.startMs)}-${clock(Math.ceil(s.endMs / 1000) * 1000)}]\n${s.text}`)
    .join("\n\n");
}

export function parseScenes(content: string): Scene[] {
  const ms = (h: string, m: string, s: string) => ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000;
  const headers = [...content.matchAll(/^\[(\d+):(\d\d):(\d\d)-(\d+):(\d\d):(\d\d)\]$/gm)];
  return headers.map((h, i) => ({
    startMs: ms(h[1], h[2], h[3]),
    endMs: ms(h[4], h[5], h[6]),
    text: content.slice((h.index ?? 0) + h[0].length, headers[i + 1]?.index ?? content.length).trim(),
  }));
}

export function scenePrompt(
  title: string,
  overview: string | null,
  storySoFar: Scene[],
  part: Scene,
  partNumber: number,
  parts: number
): string {
  return [
    `Title: ${title}`,
    overview ? `Official overview: ${overview}` : null,
    storySoFar.length ? `\nThe story so far (your notes on the earlier parts):\n${formatScenes(storySoFar)}` : null,
    `\nDialogue from ${clock(part.startMs)} to ${clock(part.endMs)}, part ${partNumber} of ${parts} (from subtitles, no speaker names):`,
    part.text,
    "",
    "Write what happens in this part, in order, as short factual sentences, one per line.",
    "Name who does what to whom. State any reveal, death, twist or hidden identity plainly.",
    "Only what this dialogue shows; when it is unclear who speaks or what happens, leave it out rather than guess.",
    "Reply with the lines between <notes> and </notes>, nothing else.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function synopsisPrompt(title: string, overview: string | null, scenes: Scene[]): string {
  return [
    `Title: ${title}`,
    overview ? `Official overview: ${overview}` : null,
    "",
    "Scene notes, in story order, each part under its time:",
    formatScenes(scenes),
    "",
    // A word limit alone is ignored: the model copies the notes out whole.
    "Summarise the story from these notes: for each part, at most three sentences on what matters to the story (who does what, any reveal, death or twist), and for the last part, how it ends.",
    "Write it as plain prose paragraphs, one per part, without the times. Add nothing the notes do not say.",
    "Reply with the synopsis between <synopsis> and </synopsis>, nothing else.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * The answer inside <tag>: drops a reasoning model's thinking block and any
 * chatter around the tags (agent gateways like to narrate).
 */
export function extractTagged(text: string, tag: string): string {
  const answer = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const tagged = new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|$)`, "i").exec(answer);
  return (tagged ? tagged[1] : answer).trim();
}

async function complete(chat: ChatSettings, prompt: string): Promise<string> {
  const base = chat.baseUrl?.replace(/\/+$/, "");
  switch (chat.provider) {
    case "anthropic": {
      const res = await axios.post(
        `${base || "https://api.anthropic.com"}/v1/messages`,
        {
          model: chat.model,
          max_tokens: 4096,
          temperature: TEMPERATURE,
          messages: [{ role: "user", content: prompt }],
        },
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
        {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: TEMPERATURE },
        },
        { headers: { "x-goog-api-key": chat.apiKey ?? "" }, timeout: TIMEOUT_MS }
      );
      const parts: unknown = res.data?.candidates?.[0]?.content?.parts;
      return Array.isArray(parts)
        ? parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
        : "";
    }
    default: {
      // "openai-compatible" and "ollama" (its OpenAI-compatible /v1 API).
      // A chat completion at a low temperature. Plot notes need no
      // reasoning, so templates that support it (Qwen3/DeepSeek on llama.cpp,
      // vLLM, SGLang, LM Studio) are asked to skip thinking, which otherwise
      // costs thousands of tokens per call. An endpoint that rejects either
      // (some reasoning models take no temperature) gets a plain retry and is
      // never sent them again.
      const url = `${base || (chat.provider === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1")}/chat/completions`;
      const headers = chat.apiKey ? { Authorization: `Bearer ${chat.apiKey}` } : {};
      const body = { model: chat.model, messages: [{ role: "user", content: prompt }] };
      const post = (extra: object) =>
        axios.post(url, { ...body, ...extra }, { headers, timeout: TIMEOUT_MS });
      const endpoint = `${url} ${chat.model}`;
      const hints = plainEndpoints.has(endpoint)
        ? {}
        : { temperature: TEMPERATURE, chat_template_kwargs: { enable_thinking: false } };
      const res = await post(hints).catch(
        (error: unknown) => {
          const status = axios.isAxiosError(error) ? error.response?.status : undefined;
          if ("temperature" in hints && (status === 400 || status === 422)) {
            plainEndpoints.add(endpoint);
            return post({});
          }
          throw error;
        }
      );
      const content: unknown = res.data?.choices?.[0]?.message?.content;
      return typeof content === "string" ? content : "";
    }
  }
}

/**
 * Scene notes for a transcript's parts, in order, each written with the notes
 * on the parts before it so names and threads carry over. A part with no
 * notes (music, credits) is left out.
 */
export async function writeScenes(
  chat: ChatSettings,
  title: string,
  overview: string | null,
  parts: Scene[]
): Promise<Scene[]> {
  const scenes: Scene[] = [];
  for (const [i, part] of parts.entries()) {
    let storySoFar = scenes;
    while (formatScenes(storySoFar).length > STORY_SO_FAR_CHARS) storySoFar = storySoFar.slice(1);
    const text = extractTagged(
      await complete(chat, scenePrompt(title, overview, storySoFar, part, i + 1, parts.length)),
      "notes"
    );
    if (text) scenes.push({ startMs: part.startMs, endMs: part.endMs, text });
  }
  if (scenes.length === 0) throw new Error("Chat model returned no scene notes");
  return scenes;
}

/** The synopsis, summarised from the scene notes. */
export async function writeSynopsis(
  chat: ChatSettings,
  title: string,
  overview: string | null,
  scenes: Scene[]
): Promise<string> {
  const text = extractTagged(await complete(chat, synopsisPrompt(title, overview, scenes)), "synopsis");
  if (text.split(/\s+/).length < 20) throw new Error("Chat model returned an empty or too-short synopsis");
  return text;
}

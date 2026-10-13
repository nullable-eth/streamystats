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
 * summarised from the notes. A hosted model with a long context window gets
 * the whole transcript, already cut into those parts, in one request: seeing
 * the whole story helps it tell who is who.
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
const MAX_TOKENS = 4096;
/** Notes on every part of a long film, and the synopsis. */
const WHOLE_TITLE_MAX_TOKENS = 32_000;
const MAX_CHARACTERS = 40;

/** What the model is told about a title besides its dialogue. */
export interface TitleInfo {
  title: string;
  overview: string | null;
  /** Character names from the cast, so speakers can be told apart. */
  characters: string[];
}

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

/** Endpoints that rejected the sampling hints (see complete); not sent to them again. */
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

/**
 * Character names from cast roles: "Rick Sanchez / Morty Smith (voice)" is
 * two characters, credited notes dropped.
 */
export function characterNames(roles: string[]): string[] {
  const names = roles.flatMap((role) =>
    role
      .split("/")
      .map((name) => name.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
  );
  return [...new Set(names)].slice(0, MAX_CHARACTERS);
}

/** Hosted models with long context windows write a whole title in one request. */
export function writesWholeTitles(chat: ChatSettings): boolean {
  return chat.provider === "anthropic" || chat.provider === "gemini";
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

function about(info: TitleInfo): (string | null)[] {
  return [
    `Title: ${info.title}`,
    info.overview ? `Official overview: ${info.overview}` : null,
    info.characters.length ? `Characters: ${info.characters.join(", ")}` : null,
  ];
}

const WRITE_NOTES = [
  "Name who does what to whom. State any reveal, death, twist or hidden identity plainly.",
  "Only what the dialogue shows; when it is unclear who speaks or what happens, leave it out rather than guess.",
];

const SUMMARY =
  "for each part, at most three sentences on what matters to the story (who does what, any reveal, death or twist), and for the last part, how it ends.";

export function scenePrompt(
  info: TitleInfo,
  storySoFar: Scene[],
  part: Scene,
  partNumber: number,
  parts: number
): string {
  return [
    ...about(info),
    storySoFar.length ? `\nThe story so far (your notes on the earlier parts):\n${formatScenes(storySoFar)}` : null,
    `\nDialogue from ${clock(part.startMs)} to ${clock(part.endMs)}, part ${partNumber} of ${parts} (from subtitles, no speaker names):`,
    part.text,
    "",
    "Write what happens in this part, in order, as short factual sentences, one per line.",
    ...WRITE_NOTES,
    "Reply with the lines between <notes> and </notes>, nothing else.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function synopsisPrompt(info: TitleInfo, scenes: Scene[]): string {
  return [
    ...about(info),
    "",
    "Scene notes, in story order, each part under its time:",
    formatScenes(scenes),
    "",
    // A word limit alone is ignored: the model copies the notes out whole.
    `Summarise the story from these notes: ${SUMMARY}`,
    "Write it as plain prose paragraphs, one per part, without the times. Add nothing the notes do not say.",
    "Reply with the synopsis between <synopsis> and </synopsis>, nothing else.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** The whole title in one request: notes on each part, then the synopsis. */
export function wholeTitlePrompt(info: TitleInfo, parts: Scene[]): string {
  return [
    ...about(info),
    "",
    `Dialogue transcript (from subtitles, often without speaker names), in ${parts.length} parts with their times:`,
    ...parts.map(
      (p, i) => `<part n="${i + 1}" time="${clock(p.startMs)}-${clock(p.endMs)}">\n${p.text}\n</part>`
    ),
    "",
    "For each part, write what happens in it, in order, as short factual sentences, one per line, each event in the part where it happens.",
    ...WRITE_NOTES,
    "Use the whole transcript to work out who is speaking and who people are.",
    `Then summarise the story from your notes: ${SUMMARY} Write it as plain prose paragraphs, without the times.`,
    'Reply with <notes n="1">...</notes> for every part, in order, then <synopsis>...</synopsis>, nothing else.',
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Scene notes and synopsis out of a whole-title answer, on the parts' times.
 * A part's notes run from its opening tag to the next part or the synopsis:
 * models sometimes close them with the input's </part>, or not at all, or
 * open a later part with <part n="2"> instead of <notes n="2">.
 */
export function parseWholeTitle(answer: string, parts: Scene[]): { scenes: Scene[]; synopsis: string } {
  const text = answer.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const synopsisAt = text.search(/<synopsis>/i);
  const body = synopsisAt >= 0 ? text.slice(0, synopsisAt) : text;
  const opens = [...body.matchAll(/<(?:notes|part)\s+n=["']?(\d+)["']?[^>]*>/gi)];
  const notes = new Map(
    opens.map((m, i) => [
      Number(m[1]),
      body
        .slice((m.index ?? 0) + m[0].length, opens[i + 1]?.index ?? body.length)
        .replace(/<\/(?:notes|part)>/gi, "")
        .trim(),
    ])
  );
  const scenes = parts.flatMap((p, i) => {
    const notesText = notes.get(i + 1);
    return notesText ? [{ startMs: p.startMs, endMs: p.endMs, text: notesText }] : [];
  });
  const synopsis = /<synopsis>([\s\S]*?)(?:<\/synopsis>|$)/i.exec(text)?.[1]?.trim() ?? "";
  return { scenes, synopsis };
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

/**
 * Rate limits and overload (429, 503, 529) and dropped connections: wait as
 * asked, or back off, and try again. A timeout is not retried.
 */
async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const response = axios.isAxiosError(error) ? error.response : undefined;
      const dropped = axios.isAxiosError(error) && !response && error.code !== "ECONNABORTED";
      if (attempt >= 6 || !(dropped || [429, 503, 529].includes(response?.status ?? 0))) throw error;
      const after = Number(response?.headers?.["retry-after"]);
      const seconds = after > 0 ? after : 5 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    }
  }
}

/** The fields of Anthropic's and Gemini's stream events that carry text. */
type StreamEvent = {
  type?: string;
  error?: { message?: string };
  delta?: { text?: unknown };
  candidates?: { content?: { parts?: { text?: unknown }[] } }[];
};

/** The text of a server-sent event stream, each event's `data` read by `text`. */
export async function readEvents(
  stream: AsyncIterable<Buffer | string>,
  text: (event: StreamEvent) => string
): Promise<string> {
  let buffer = "";
  let out = "";
  const take = (block: string) => {
    for (const line of block.split("\n")) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (data && data !== "[DONE]") out += text(JSON.parse(data));
    }
  };
  for await (const chunk of stream) {
    buffer += chunk.toString().replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      take(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  take(buffer);
  return out;
}

/**
 * One completion. Sent at a low temperature, and to OpenAI-compatible
 * templates that support it (Qwen3/DeepSeek on llama.cpp, vLLM, SGLang, LM
 * Studio) with thinking off: plot notes need no reasoning, which otherwise
 * costs thousands of tokens per call. An endpoint that rejects these hints
 * (current Claude models and some reasoning models take no temperature) gets
 * a plain retry and is never sent them again.
 */
async function complete(chat: ChatSettings, prompt: string, maxTokens = MAX_TOKENS): Promise<string> {
  const endpoint = `${chat.provider} ${chat.baseUrl ?? ""} ${chat.model}`;
  const hinted = !plainEndpoints.has(endpoint);
  try {
    return await withRetries(() => send(chat, prompt, maxTokens, hinted));
  } catch (error) {
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    if (!hinted || (status !== 400 && status !== 422)) throw error;
    plainEndpoints.add(endpoint);
    return withRetries(() => send(chat, prompt, maxTokens, false));
  }
}

async function send(chat: ChatSettings, prompt: string, maxTokens: number, hinted: boolean): Promise<string> {
  const base = chat.baseUrl?.replace(/\/+$/, "");
  const temperature = hinted ? { temperature: TEMPERATURE } : {};
  switch (chat.provider) {
    // Hosted models stream: a whole title's notes take minutes to write, and
    // networks drop a connection that stays silent that long.
    case "anthropic": {
      const res = await axios.post(
        `${base || "https://api.anthropic.com"}/v1/messages`,
        {
          model: chat.model,
          max_tokens: maxTokens,
          ...temperature,
          stream: true,
          messages: [{ role: "user", content: prompt }],
        },
        {
          headers: { "x-api-key": chat.apiKey ?? "", "anthropic-version": "2023-06-01" },
          responseType: "stream",
          timeout: TIMEOUT_MS,
        }
      );
      return readEvents(res.data, (event) => {
        if (event.type === "error") throw new Error(event.error?.message ?? "Stream error");
        return event.type === "content_block_delta" && typeof event.delta?.text === "string"
          ? event.delta.text
          : "";
      });
    }
    case "gemini": {
      const name = chat.model.startsWith("models/") ? chat.model : `models/${chat.model}`;
      const res = await axios.post(
        `${base || "https://generativelanguage.googleapis.com/v1beta"}/${name}:streamGenerateContent?alt=sse`,
        {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { ...temperature, maxOutputTokens: maxTokens },
        },
        { headers: { "x-goog-api-key": chat.apiKey ?? "" }, responseType: "stream", timeout: TIMEOUT_MS }
      );
      return readEvents(res.data, (event) => {
        const parts = event.candidates?.[0]?.content?.parts ?? [];
        return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      });
    }
    default: {
      // "openai-compatible" and "ollama" (its OpenAI-compatible /v1 API).
      const url = `${base || (chat.provider === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1")}/chat/completions`;
      const res = await axios.post(
        url,
        {
          model: chat.model,
          messages: [{ role: "user", content: prompt }],
          ...(hinted ? { ...temperature, chat_template_kwargs: { enable_thinking: false } } : {}),
        },
        { headers: chat.apiKey ? { Authorization: `Bearer ${chat.apiKey}` } : {}, timeout: TIMEOUT_MS }
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
export async function writeScenes(chat: ChatSettings, info: TitleInfo, parts: Scene[]): Promise<Scene[]> {
  const scenes: Scene[] = [];
  for (const [i, part] of parts.entries()) {
    let storySoFar = scenes;
    while (formatScenes(storySoFar).length > STORY_SO_FAR_CHARS) storySoFar = storySoFar.slice(1);
    const text = extractTagged(
      await complete(chat, scenePrompt(info, storySoFar, part, i + 1, parts.length)),
      "notes"
    );
    if (text) scenes.push({ startMs: part.startMs, endMs: part.endMs, text });
  }
  return scenes;
}

/** The synopsis, summarised from the scene notes. */
export async function writeSynopsis(chat: ChatSettings, info: TitleInfo, scenes: Scene[]): Promise<string> {
  return extractTagged(await complete(chat, synopsisPrompt(info, scenes)), "synopsis");
}

/**
 * Scene notes and the synopsis for a transcript's parts: in one request for a
 * hosted model, part by part otherwise.
 */
export async function writePlot(
  chat: ChatSettings,
  info: TitleInfo,
  parts: Scene[]
): Promise<{ scenes: Scene[]; synopsis: string }> {
  let plot: { scenes: Scene[]; synopsis: string };
  let answer = "";
  if (writesWholeTitles(chat)) {
    answer = await complete(chat, wholeTitlePrompt(info, parts), WHOLE_TITLE_MAX_TOKENS);
    plot = parseWholeTitle(answer, parts);
  } else {
    const scenes = await writeScenes(chat, info, parts);
    plot = { scenes, synopsis: scenes.length ? await writeSynopsis(chat, info, scenes) : "" };
  }
  if (plot.scenes.length === 0) {
    throw new Error(`Chat model returned no scene notes${answer ? `: ${answer.slice(0, 300)}` : ""}`);
  }
  if (plot.synopsis.split(/\s+/).length < 20) throw new Error("Chat model returned an empty or too-short synopsis");
  return plot;
}

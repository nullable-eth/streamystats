/**
 * Turning a library subtitle track into a searchable transcript: choose the
 * track, parse SRT, strip what is not dialogue, and cut it into windows.
 * Pure functions; the job does the I/O.
 */
import { isRecord } from "../jellyfin/ratings-parse";

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleCandidate {
  index: number;
  /** Stable identity of the track; a change means the transcript is stale. */
  ref: string;
}

/** A transcript shorter than this is a forced/signs track or a broken file. */
export const MIN_TRANSCRIPT_WORDS = 150;

const CHUNK_MAX_MS = 120_000;
const CHUNK_MAX_CHARS = 1_500;
const CHUNK_OVERLAP_MS = 15_000;

const NOT_DIALOGUE_TITLE = /forced|foreign|signs?\b|songs?\b|commentary/i;
const ADVERT =
  /opensubtitles|subtitles? (by|downloaded)|sync(ed)? (and|&) correct|addic7ed|subscene|www\.|https?:/i;

function lang(code: unknown): string | null {
  if (typeof code !== "string" || code.length === 0) return null;
  const c = code.toLowerCase();
  return c === "en" ? "eng" : c;
}

function field(stream: unknown, key: string): unknown {
  return isRecord(stream) ? stream[key] : undefined;
}

/**
 * Full-dialogue text subtitle tracks, best first. The spoken language (the
 * default audio track's) wins, then English; external files (a subtitle downloader's
 * sidecars) beat embedded tracks; forced, signs and commentary tracks are
 * never a transcript.
 */
export function rankTranscriptStreams(
  streams: unknown[],
  mediaSourceId: string
): SubtitleCandidate[] {
  const audio =
    streams.find((s) => field(s, "Type") === "Audio" && field(s, "IsDefault")) ??
    streams.find((s) => field(s, "Type") === "Audio");
  const spoken = lang(field(audio, "Language"));

  return streams
    .filter((s) => {
      const title = `${field(s, "Title") ?? ""} ${field(s, "DisplayTitle") ?? ""}`;
      return (
        field(s, "Type") === "Subtitle" &&
        field(s, "IsTextSubtitleStream") === true &&
        field(s, "IsForced") !== true &&
        typeof field(s, "Index") === "number" &&
        !NOT_DIALOGUE_TITLE.test(title)
      );
    })
    .map((s) => {
      const language = lang(field(s, "Language"));
      const score =
        (spoken && language === spoken ? 100 : 0) +
        (language === "eng" ? 50 : 0) +
        (field(s, "IsExternal") === true ? 10 : 0) +
        (field(s, "IsHearingImpaired") === true ? 0 : 5);
      const index = Number(field(s, "Index"));
      const path = field(s, "Path");
      return {
        score,
        candidate: {
          index,
          ref: `${mediaSourceId}:${index}:${typeof path === "string" ? path : "embedded"}`,
        },
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((r) => r.candidate);
}

const TIME =
  /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;

function ms(h: string, m: string, s: string, f: string): number {
  return ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f.padEnd(3, "0"));
}

export function parseSrt(srt: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of srt.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => TIME.test(l));
    if (at < 0) continue;
    const t = TIME.exec(lines[at]);
    if (!t) continue;
    cues.push({
      startMs: ms(t[1], t[2], t[3], t[4]),
      endMs: ms(t[5], t[6], t[7], t[8]),
      text: lines.slice(at + 1).join("\n"),
    });
  }
  return cues;
}

/** Keep only spoken words: no markup, sound effects, lyrics or adverts. */
export function cleanCues(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const text = cue.text
      .replace(/<[^>]*>|\{[^}]*\}/g, "")
      .split("\n")
      .filter((line) => !line.includes("♪") && !ADVERT.test(line))
      .map((line) =>
        line
          .replace(/\[[^\]]*\]|\([^)]*\)/g, "")
          .replace(/^\s*-\s*/, "")
          .trim()
      )
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || out.at(-1)?.text === text) continue;
    out.push({ ...cue, text });
  }
  return out;
}

export function wordCount(cues: Cue[]): number {
  return cues.reduce((n, c) => n + c.text.split(" ").length, 0);
}

/**
 * About two minutes of dialogue per window, overlapping by ~15s so a line that
 * straddles a boundary is whole in at least one window.
 */
export function chunkCues(cues: Cue[]): Cue[] {
  const chunks: Cue[] = [];
  let start = 0;
  while (start < cues.length) {
    let end = start;
    let chars = cues[start].text.length;
    while (
      end + 1 < cues.length &&
      cues[end + 1].endMs - cues[start].startMs <= CHUNK_MAX_MS &&
      chars + cues[end + 1].text.length <= CHUNK_MAX_CHARS
    ) {
      end++;
      chars += cues[end].text.length + 1;
    }
    const window = cues.slice(start, end + 1);
    chunks.push({
      startMs: window[0].startMs,
      endMs: window[window.length - 1].endMs,
      text: window.map((c) => c.text).join(" "),
    });
    if (end + 1 >= cues.length) break;
    const overlapFrom = cues[end].endMs - CHUNK_OVERLAP_MS;
    let next = end + 1;
    while (next - 1 > start && cues[next - 1].startMs >= overlapFrom) next--;
    start = next;
  }
  return chunks;
}

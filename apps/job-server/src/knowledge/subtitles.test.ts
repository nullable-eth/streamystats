import { describe, expect, test } from "bun:test";
import { chunkCues, cleanCues, parseSrt, rankTranscriptStreams, wordCount } from "./subtitles";

const SRT = `\uFEFF1\r
00:00:01,000 --> 00:00:03,500\r
<i>- Where are we?</i>\r
- [ENGINE HUMMING] On the ship.\r
\r
2
00:00:04,000 --> 00:00:05,000
♪ la la la ♪

3
00:00:05,000 --> 00:00:06,000
(SIGHS)

4
00:00:06,000 --> 00:00:07,250
{\\an8}Lana's at the farm.

5
00:00:07,300 --> 00:00:08,000
Lana's at the farm.

6
01:02:03,4 --> 01:02:04,5
Subtitles by OpenSubtitles.org
`;

describe("parseSrt + cleanCues", () => {
  test("parses times and keeps dialogue and sound descriptions, not lyrics or adverts", () => {
    const cues = cleanCues(parseSrt(SRT));
    expect(cues.map((c) => c.text)).toEqual([
      "Where are we? [ENGINE HUMMING] On the ship.",
      "(SIGHS)",
      "Lana's at the farm.",
    ]);
    expect(cues[0]).toMatchObject({ startMs: 1000, endMs: 3500 });
  });

  test("parses short millisecond fields", () => {
    const [cue] = parseSrt("1\n01:02:03,4 --> 01:02:04,5\nHi\n");
    expect(cue.startMs).toBe(3_723_400);
    expect(cue.endMs).toBe(3_724_500);
  });
});

describe("rankTranscriptStreams", () => {
  const streams = [
    { Type: "Audio", Language: "eng", IsDefault: true, Index: 1 },
    { Type: "Subtitle", Index: 2, Language: "eng", IsTextSubtitleStream: true, IsForced: true },
    { Type: "Subtitle", Index: 3, Language: "eng", IsTextSubtitleStream: false },
    { Type: "Subtitle", Index: 4, Language: "spa", IsTextSubtitleStream: true },
    { Type: "Subtitle", Index: 5, Language: "eng", IsTextSubtitleStream: true, Title: "English (Signs & Songs)" },
    { Type: "Subtitle", Index: 6, Language: "eng", IsTextSubtitleStream: true },
    { Type: "Subtitle", Index: 7, Language: "en", IsTextSubtitleStream: true, IsExternal: true, Path: "/m/a.en.srt" },
  ];

  test("prefers the spoken language, external files, and skips forced/image/signs tracks", () => {
    expect(rankTranscriptStreams(streams, "ms1").map((c) => c.index)).toEqual([7, 6, 4]);
  });

  test("SDH tracks beat plain ones, flagged or titled", () => {
    const sdh = [
      { Type: "Subtitle", Index: 1, Language: "eng", IsTextSubtitleStream: true, IsExternal: true, Path: "/m/a.en.srt" },
      { Type: "Subtitle", Index: 2, Language: "eng", IsTextSubtitleStream: true, IsExternal: true, Path: "/m/a.en.hi.srt", IsHearingImpaired: true },
      { Type: "Subtitle", Index: 3, Language: "eng", IsTextSubtitleStream: true, Title: "English SDH" },
      { Type: "Subtitle", Index: 4, Language: "eng", IsTextSubtitleStream: true },
    ];
    expect(rankTranscriptStreams(sdh, "ms1").map((c) => c.index)).toEqual([2, 1, 3, 4]);
  });

  test("a dubbed release: the metadata language beats the default audio's", () => {
    // An Italian release with English audio as the second track.
    const dubbed = [
      { Type: "Subtitle", Index: 0, Language: "eng", IsTextSubtitleStream: true, IsExternal: true, Path: "/m/c.en.srt" },
      { Type: "Audio", Index: 2, Language: "ita", IsDefault: true },
      { Type: "Audio", Index: 3, Language: "eng" },
      { Type: "Subtitle", Index: 4, Language: "ita", IsTextSubtitleStream: true, IsForced: true },
      { Type: "Subtitle", Index: 5, Language: "eng", IsTextSubtitleStream: true, Title: "English Forced" },
      { Type: "Subtitle", Index: 6, Language: "ita", IsTextSubtitleStream: true },
      { Type: "Subtitle", Index: 7, Language: "eng", IsTextSubtitleStream: true },
    ];
    expect(rankTranscriptStreams(dubbed, "ms1", ["en", "eng"]).map((c) => c.index)).toEqual([0, 7, 6]);
    // An Italian-language server keeps the Italian track.
    expect(rankTranscriptStreams(dubbed, "ms1", ["it", "ita"]).map((c) => c.index)).toEqual([6, 0, 7]);
  });

  test("ref changes when the file changes", () => {
    expect(rankTranscriptStreams(streams, "ms1")[0].ref).toBe("v2:ms1:7:/m/a.en.srt");
  });
});

describe("chunkCues", () => {
  const cues = Array.from({ length: 80 }, (_, i) => ({
    startMs: i * 5000,
    endMs: i * 5000 + 4000,
    text: `line ${i}`,
  }));

  test("windows of up to two minutes that overlap and cover every cue", () => {
    const chunks = chunkCues(cues);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.endMs - c.startMs).toBeLessThanOrEqual(120_000);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startMs).toBeLessThan(chunks[i - 1].endMs);
    }
    expect(chunks.at(-1)?.text.endsWith("line 79")).toBe(true);
    expect(wordCount(cues)).toBe(160);
  });

  test("always makes progress on a single huge cue", () => {
    const big = [{ startMs: 0, endMs: 1, text: "x".repeat(5000) }, { startMs: 2, endMs: 3, text: "y" }];
    expect(chunkCues(big).map((c) => c.text.length)).toEqual([5000, 1]);
  });
});

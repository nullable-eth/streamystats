import { describe, expect, test } from "bun:test";
import {
  characterNames,
  formatScenes,
  parseScenes,
  parseWholeTitle,
  readEvents,
  sceneWindows,
  synopsisWindows,
  transcriptParts,
  wholeTitlePrompt,
} from "./synopsis";

const moon = { title: "Moon (2009)", overview: null, characters: [] };

describe("synopsisWindows", () => {
  test("the whole synopsis, then each paragraph, all titled", () => {
    expect(synopsisWindows("Moon (2009)", "Sam works alone.\n\nHe finds a clone.\n \nHe escapes.")).toEqual([
      "Moon (2009): Sam works alone.\n\nHe finds a clone.\n \nHe escapes.",
      "Moon (2009): Sam works alone.",
      "Moon (2009): He finds a clone.",
      "Moon (2009): He escapes.",
    ]);
  });

  test("one paragraph is one window; nothing is none", () => {
    expect(synopsisWindows("T", " One paragraph. ")).toEqual(["T: One paragraph."]);
    expect(synopsisWindows("T", "  ")).toEqual([]);
  });
});

describe("scenes", () => {
  const minute = 60_000;

  test("a transcript's lines in parts of a few minutes, each with its times", () => {
    const parts = transcriptParts(["Hello.", "Who are you?", "Later."], [0, 5 * minute, 9 * minute]);
    expect(parts).toEqual([
      { startMs: 0, endMs: 5 * minute, text: "Hello.\nWho are you?" },
      { startMs: 9 * minute, endMs: 9 * minute, text: "Later." },
    ]);
  });

  test("a part also ends when its dialogue runs long", () => {
    const line = "x".repeat(7_000);
    expect(transcriptParts([line, line], [0, 1000]).map((p) => p.startMs)).toEqual([0, 1000]);
  });

  test("stored with their times and read back, the last line kept inside", () => {
    const scenes = [
      { startMs: 4_000, endMs: 574_500, text: "Rick seals the house.\nCousin Nicky appears." },
      { startMs: 561_000, endMs: 1_109_000, text: "Beth shoots Mr. Poopybutthole." },
    ];
    const stored = formatScenes(scenes);
    expect(stored).toBe(
      "[00:00:04-00:09:35]\nRick seals the house.\nCousin Nicky appears.\n\n[00:09:21-00:18:29]\nBeth shoots Mr. Poopybutthole."
    );
    expect(parseScenes(stored)).toEqual([{ ...scenes[0], endMs: 575_000 }, scenes[1]]);
  });

  test("each scene is a titled window with its times", () => {
    expect(sceneWindows("Moon (2009)", [{ startMs: 0, endMs: 9, text: "Sam finds a clone." }])).toEqual([
      { startMs: 0, endMs: 9, text: "Moon (2009): Sam finds a clone." },
    ]);
  });
});

describe("characterNames", () => {
  test("splits shared roles, drops credit notes and repeats", () => {
    expect(
      characterNames(["Rick Sanchez / Morty Smith (voice)", "Jerry Smith (voice)", "Rick Sanchez", "", " (uncredited)"])
    ).toEqual(["Rick Sanchez", "Morty Smith", "Jerry Smith"]);
  });
});

describe("whole title in one request", () => {
  const parts = [
    { startMs: 0, endMs: 470_000, text: "Who are you?" },
    { startMs: 480_000, endMs: 950_000, text: "Keep Summer safe." },
  ];

  test("the transcript in numbered parts with their times, and the cast", () => {
    const prompt = wholeTitlePrompt({ ...moon, characters: ["Sam Bell", "GERTY"] }, parts);
    expect(prompt).toContain("Characters: Sam Bell, GERTY");
    expect(prompt).toContain('<part n="2" time="00:08:00-00:15:50">\nKeep Summer safe.\n</part>');
  });

  test("no overview or characters when there are none", () => {
    const prompt = wholeTitlePrompt(moon, parts);
    expect(prompt).not.toContain("Official overview");
    expect(prompt).not.toContain("Characters");
  });

  test("without a reference plot, only what the transcript shows", () => {
    const prompt = wholeTitlePrompt(moon, parts);
    expect(prompt).not.toContain("<reference>");
    expect(prompt).toContain("Only what the transcript shows");
  });

  test("with one, the plot before the transcript, for who and what; the transcript for when", () => {
    const prompt = wholeTitlePrompt({ ...moon, reference: "Sam discovers he is a clone." }, parts);
    expect(prompt).toContain("<reference>\nSam discovers he is a clone.\n</reference>");
    expect(prompt.indexOf("<reference>")).toBeLessThan(prompt.indexOf("Dialogue transcript"));
    expect(prompt).toContain("Use the reference plot to know who people are and what happens");
    expect(prompt).not.toContain("Only what the transcript shows");
  });

  test("notes closed with </part>, or not closed, or opened as <part>", () => {
    const answer =
      '<notes n="1">\nWho are you?\n</part>\n<part n="2">\nRick tells the car to keep Summer safe.\n<synopsis>Rick and Morty leave.</synopsis>';
    expect(parseWholeTitle(answer, parts).scenes.map((s) => s.text)).toEqual([
      "Who are you?",
      "Rick tells the car to keep Summer safe.",
    ]);
  });

  test("a reasoning model's thinking block is not notes", () => {
    const answer = '<think>Part 1 is <notes n="1">Sam</notes>?</think><notes n="1">Sam wakes.</notes><synopsis>Sam wakes.</synopsis>';
    expect(parseWholeTitle(answer, parts).scenes.map((s) => s.text)).toEqual(["Sam wakes."]);
  });

  test("notes land on their parts' times; a part with none is left out", () => {
    const answer =
      'Sure.\n<notes n="2">Rick tells the car to keep Summer safe.</notes>\n<synopsis>Rick and Morty leave.</synopsis>';
    expect(parseWholeTitle(answer, parts)).toEqual({
      scenes: [{ startMs: 480_000, endMs: 950_000, text: "Rick tells the car to keep Summer safe." }],
      synopsis: "Rick and Morty leave.",
    });
  });
});

describe("readEvents", () => {
  test("joins the text of events split across chunks", async () => {
    async function* chunks() {
      yield 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Rick "}}\n\nevent: ping\ndata: {"type":"ping"}\n\ndata: {"type":"content_block_de';
      yield 'lta","delta":{"text":"leaves."}}\n\n';
    }
    const text = await readEvents(chunks(), (e) => (typeof e.delta?.text === "string" ? e.delta.text : ""));
    expect(text).toBe("Rick leaves.");
  });

  test("an error event fails the request", async () => {
    async function* chunks() {
      yield 'data: {"type":"error","error":{"message":"Overloaded"}}\n\n';
    }
    const read = readEvents(chunks(), (e) => {
      if (e.type === "error") throw new Error(e.error?.message);
      return "";
    });
    await expect(read).rejects.toThrow("Overloaded");
  });
});

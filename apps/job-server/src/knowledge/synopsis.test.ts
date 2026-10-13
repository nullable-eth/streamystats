import { describe, expect, test } from "bun:test";
import {
  extractTagged,
  formatScenes,
  parseScenes,
  sceneWindows,
  scenePrompt,
  synopsisPrompt,
  synopsisWindows,
  transcriptParts,
} from "./synopsis";

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

  test("the first part has no story so far; later parts carry the notes before them", () => {
    const part = { startMs: 0, endMs: 1000, text: "Hello." };
    expect(scenePrompt("Moon (2009)", null, [], part, 1, 2)).not.toContain("story so far");
    const later = scenePrompt("Moon (2009)", "Sam is alone.", [{ ...part, text: "Sam wakes." }], part, 2, 2);
    expect(later).toContain("[00:00:00-00:00:01]\nSam wakes.");
    expect(later).toContain("part 2 of 2");
  });

  test("the synopsis prompt omits the overview line when there is none", () => {
    expect(synopsisPrompt("Moon (2009)", null, [{ startMs: 0, endMs: 0, text: "Sam." }])).not.toContain(
      "Official overview"
    );
  });
});

describe("extractTagged", () => {
  test("drops a reasoning model's thinking block", () => {
    expect(extractTagged("<think>hmm\nok</think>\n\nTwo astronauts...", "synopsis")).toBe("Two astronauts...");
  });

  test("keeps only the tagged answer, without the chatter around it", () => {
    expect(
      extractTagged("I'll work from the transcript.\n<synopsis>\nTwo astronauts...\n</synopsis>\nDone.", "synopsis")
    ).toBe("Two astronauts...");
    expect(extractTagged("<notes>Cut off at the end", "notes")).toBe("Cut off at the end");
  });
});

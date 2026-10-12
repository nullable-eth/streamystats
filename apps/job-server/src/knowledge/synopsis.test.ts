import { describe, expect, test } from "bun:test";
import { extractSynopsis, fitTranscript, synopsisPrompt } from "./synopsis";

describe("synopsis helpers", () => {
  test("keeps the opening and the ending of a long transcript", () => {
    const fitted = fitTranscript(`${"a".repeat(100)}${"z".repeat(100)}`, 40);
    expect(fitted).toBe(`${"a".repeat(20)}\n[...]\n${"z".repeat(20)}`);
    expect(fitTranscript("short", 40)).toBe("short");
  });

  test("drops a reasoning model's thinking block", () => {
    expect(extractSynopsis("<think>hmm\nok</think>\n\nTwo astronauts...")).toBe("Two astronauts...");
  });

  test("keeps only the tagged synopsis, without the chatter around it", () => {
    expect(
      extractSynopsis("I'll work from the transcript.\n<synopsis>\nTwo astronauts...\n</synopsis>\nDone.")
    ).toBe("Two astronauts...");
    expect(extractSynopsis("<synopsis>Cut off at the end")).toBe("Cut off at the end");
  });

  test("omits the overview line when there is none", () => {
    expect(synopsisPrompt("Moon (2009)", null, "hello")).not.toContain("Official overview");
  });
});

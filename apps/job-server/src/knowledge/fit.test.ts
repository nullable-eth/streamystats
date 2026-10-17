import { expect, test } from "bun:test";
import { splitToFit, trimToFit } from "./fit";

test("a text that fits stays whole", () => {
  expect(splitToFit("  Short plot.  ", 100)).toEqual(["Short plot."]);
});

test("a long text splits at paragraphs, then sentences, then words, every piece fitting", () => {
  const paragraphs = `${"a ".repeat(30).trim()}.\n\n${"b ".repeat(30).trim()}.`;
  expect(splitToFit(paragraphs, 70)).toEqual([`${"a ".repeat(30).trim()}.`, `${"b ".repeat(30).trim()}.`]);
  const sentences = "One two three. Four five six. Seven eight nine.";
  expect(splitToFit(sentences, 30)).toEqual(["One two three. Four five six.", "Seven eight nine."]);
  const words = "word ".repeat(500);
  const pieces = splitToFit(words, 64);
  expect(pieces.every((p) => p.length <= 64 && !p.startsWith(" ") && p.startsWith("word"))).toBe(true);
  expect(pieces.join(" ")).toBe(words.trim());
  expect(splitToFit("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});

test("trimming keeps the start, ending at a word", () => {
  expect(trimToFit("The quick brown fox", 12)).toBe("The quick");
  expect(trimToFit("short", 12)).toBe("short");
});

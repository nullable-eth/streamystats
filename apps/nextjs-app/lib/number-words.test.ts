import { expect, test } from "bun:test";
import {
  digitNumbers,
  spellNumbers,
  wordings,
  writtenSpeech,
} from "./number-words";

test("digits as words, as subtitles write them", () => {
  expect(spellNumbers("60% of the time, it works every time")).toBe(
    "sixty percent of the time, it works every time",
  );
  expect(spellNumbers("I have 3 kids and 65 cows")).toBe(
    "I have three kids and sixty-five cows",
  );
  expect(spellNumbers("Room 101, 205 miles")).toBe(
    "Room one hundred one, two hundred five miles",
  );
  // Times, decimals and long numbers stay as they are.
  expect(spellNumbers("at 10:30, 3.5 kg, 1985, 1,000")).toBe(
    "at 10:30, 3.5 kg, 1985, 1,000",
  );
});

test("words as digits, from ten up, and percent", () => {
  expect(digitNumbers("Sixty percent of the time")).toBe("60% of the time");
  expect(digitNumbers("sixty-five or twenty one, fifteen")).toBe(
    "65 or 21, 15",
  );
  // Everyday small numbers stay words.
  expect(digitNumbers("one of the two")).toBe("one of the two");
});

test("a query in each wording, once", () => {
  expect(wordings("60% of the time")).toEqual([
    "60% of the time",
    "sixty percent of the time",
  ]);
  expect(wordings("no numbers here")).toEqual(["no numbers here"]);
});

test("speech as subtitles write it", () => {
  expect(writtenSpeech("Life, uh, finds a way.")).toBe("Life, finds a way.");
  expect(writtenSpeech("Um... I'm gonna need a bigger boat")).toBe(
    "I'm going to need a bigger boat",
  );
  expect(writtenSpeech("I dunno, 'cause I wanna")).toBe(
    "I don't know, because I want to",
  );
  // Words that only start like a hesitation stay.
  expect(writtenSpeech("Uhura hums an aria")).toBe("Uhura hums an aria");
});

test("a line in its written form too", () => {
  expect(wordings("You're gonna need a bigger boat.")).toEqual([
    "You're gonna need a bigger boat.",
    "You're going to need a bigger boat.",
  ]);
});

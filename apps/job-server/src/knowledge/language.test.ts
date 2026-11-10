import { describe, expect, test } from "bun:test";
import { readsAs } from "./language";

const repeat = (lines: string[], n: number) => Array.from({ length: n }, (_, i) => lines[i % lines.length]);
const english = repeat(
  ["I don't know what you want from me.", "We have to go, it's the only way.", "[door slams]", "Is that your car?", "No, it's not mine."],
  120
);
const danish = repeat(["Jeg ved ikke, hvad du vil.", "Det er en howdah-pistol, og den er gammel.", "Vi har ikke tid til det her."], 150);
const french = repeat(["Je ne sais pas ce que tu veux.", "C'est un bureau, pas deux.", "Il est modifié, en fait."], 150);
const czech = repeat(["Ta hlava je trošičku oddělená.", "Já jsem ho viděl na fotografiích v jednom kostele.", "A je tam čára, jo."], 150);
const bulgarian = repeat(["Спазмът може да означава тумор.", "Наблюдавай я до 14:00."], 200);

describe("readsAs", () => {
  test("English dialogue reads as English, labelled either way", () => {
    expect(readsAs(english, ["en", "eng"])).toBe(true);
    expect(readsAs(english, ["eng"])).toBe(true);
  });

  test("a track labelled English that is another language does not", () => {
    expect(readsAs(danish, ["en"])).toBe(false);
    expect(readsAs(french, ["en"])).toBe(false);
    expect(readsAs(bulgarian, ["en"])).toBe(false);
    expect(readsAs(czech, ["en"])).toBe(false);
  });

  test("each language against its own words", () => {
    expect(readsAs(danish, ["da"])).toBe(true);
    expect(readsAs(french, ["fre"])).toBe(true);
    expect(readsAs(english, ["fr"])).toBe(false);
  });

  test("too little to judge, or sound descriptions only: no verdict against it", () => {
    expect(readsAs(danish.slice(0, 60), ["en"])).toBe(true);
    expect(readsAs(repeat(["[seal barking]", "(waves crashing)", "♪ la la la ♪"], 400), ["en"])).toBe(true);
    // A description whose bracket the line never closes is still a description.
    expect(readsAs(repeat(["[campfire continues", "[faint gentle lake water lapping]"], 400), ["en"])).toBe(true);
  });

  test("a language it has no words for is never judged", () => {
    expect(readsAs(danish, ["ja"])).toBe(true);
  });
});

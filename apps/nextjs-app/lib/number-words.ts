/**
 * Numbers as said and as written: subtitles write "Sixty percent of the time"
 * where a user types "60% of the time", or "60%" where they type "sixty
 * percent". Full-text search matches neither to the other, so a query is
 * also searched in its other wording (see wordings).
 */

const ONES =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " ",
  );
const TENS = "  twenty thirty forty fifty sixty seventy eighty ninety".split(
  " ",
);

/** 0 to 999 in words, as subtitles write them: "sixty-five", "two hundred five". */
function spell(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100)
    return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${spell(n % 100)}` : ""}`;
}

/** Whole numbers up to 999 in words, and "%" as "percent"; times, decimals and longer numbers are left be. */
export const spellNumbers = (text: string) =>
  text.replace(
    /(?<![\d.,:])(\d{1,3})(?![\d]|[.,:]\d)(\s?%)?/g,
    (_, n: string, percent?: string) =>
      `${spell(Number(n))}${percent ? " percent" : ""}`,
  );

const tensWord = TENS.slice(2).join("|");
const NUMBER_WORDS = new RegExp(
  `\\b(?:(${tensWord})(?:[\\s-](${ONES.slice(1, 10).join("|")}))?|(${ONES.slice(10).join("|")}))\\b`,
  "gi",
);

/**
 * Numbers from ten to ninety-nine in digits, and "percent" as "%". Smaller
 * ones are left as words: "one" and "two" are everyday words far more often
 * than numbers.
 */
export const digitNumbers = (text: string) =>
  text
    .replace(NUMBER_WORDS, (_, tens?: string, unit?: string, teen?: string) => {
      if (teen) return String(ONES.indexOf(teen.toLowerCase()));
      const t = TENS.indexOf((tens as string).toLowerCase()) * 10;
      return String(t + (unit ? ONES.indexOf(unit.toLowerCase()) : 0));
    })
    .replace(/\s*\bper ?cent\b/gi, "%");

/** Hesitations said but seldom written: subtitles leave out most "uh"s. */
const FILLERS =
  /(?<![\p{L}'])(?:u+h+|u+m+|uhm|e+rm|a+h|h+m+|m+h*m+)(?![\p{L}'])[\s,.…-]*/giu;

/** Speech as subtitles often write it out. */
const WRITTEN_OUT: [RegExp, string][] = [
  [/\bgonna\b/gi, "going to"],
  [/\bwanna\b/gi, "want to"],
  [/\bgotta\b/gi, "got to"],
  [/\bgimme\b/gi, "give me"],
  [/\blemme\b/gi, "let me"],
  [/\bkinda\b/gi, "kind of"],
  [/\bsorta\b/gi, "sort of"],
  [/\boutta\b/gi, "out of"],
  [/\bdunno\b/gi, "don't know"],
  [/(?<![\p{L}'])(?:'cause|cuz)(?![\p{L}'])/giu, "because"],
];

/**
 * A line as subtitles tend to write it: "uh" and "um" left out, "gonna" as
 * "going to". People quote "Life, uh, finds a way", the subtitle says "life
 * finds a way"; they type "you're gonna need a bigger boat", it says "going
 * to need".
 */
export const writtenSpeech = (text: string) =>
  WRITTEN_OUT.reduce(
    (t, [said, written]) => t.replace(said, written),
    text.replace(FILLERS, ""),
  ).trim();

/** A query as typed, with its numbers in the other wording, and as subtitles write speech, each once. */
export const wordings = (query: string) => [
  ...new Set([
    query,
    spellNumbers(query),
    digitNumbers(query),
    writtenSpeech(query),
  ]),
];

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

/** A query as typed and with its numbers in the other wording, each once. */
export const wordings = (query: string) => [
  ...new Set([query, spellNumbers(query), digitNumbers(query)]),
];

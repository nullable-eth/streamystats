/**
 * Whether a subtitle track's text is in the language it was chosen for.
 * Tracks are often labelled wrong: an "English" track that is Danish, French
 * or Bulgarian, or a mis-encoded one, would be indexed and summarised as if it
 * were the library's language. The most common words of a language make up a
 * large share of any dialogue in it (in English, "the", "you", "I" and the like
 * are about a fifth of every word) and almost none of another language's, so a
 * share near zero means the text plainly isn't that language.
 */

/** The most frequent words of each language, lower case. */
const COMMON_WORDS: Record<string, string> = {
  en: "the you i to a and it of that is in what we me this he for my your have don't on be not do was are know with it's just but can no so all i'm",
  de: "ich die und du das nicht ist der sie es zu ein was wir mit den mir in sie ja auf mich dich so aber hier",
  fr: "je de est pas le vous la que tu un et les il ce ne à c'est en on me une qui pour bien moi",
  es: "que de no el la y es en lo un por qué los se con para una me te mi está bien eso",
  it: "che di non è il la per un e mi sono ma ti lo una in cosa ho si come questo bene io",
  pt: "que não de o a é você e um eu para com se do uma me isso está em os na por",
  nl: "ik je het de een niet is van en dat wat ze we in op hij zijn er maar met",
  sv: "jag det är du inte att och en på som har vi för med vad den här så kan till",
  da: "jeg det er du ikke at og en på har vi til der med som hvad den så kan for",
  nb: "jeg det er du ikke å og en på har vi til som med deg hva den så kan for meg",
  pl: "nie to się w i na jest że z co jak tak mnie mi ja ale do już tu by",
  ru: "не я что в и ты на это он с вы мы как а то но так да меня все",
};
/** ISO 639-1 and -2 codes as Jellyfin gives them, to the keys above. */
const CODES: Record<string, string> = {
  eng: "en", ger: "de", deu: "de", fre: "fr", fra: "fr", spa: "es", ita: "it", por: "pt", dut: "nl", nld: "nl",
  swe: "sv", dan: "da", nor: "nb", nob: "nb", no: "nb", nn: "nb", nno: "nb", pol: "pl", rus: "ru",
};
const LISTS = new Map(Object.entries(COMMON_WORDS).map(([k, v]) => [k, new Set(v.split(" "))]));

/** Text with sound descriptions, speaker labels and song lines left out: what is said. */
function spokenWords(lines: string[]): string[] {
  const said = lines
    .join("\n")
    .replace(/\[[^\]\n]*(?:\]|$)|\([^)\n]*(?:\)|$)|^.*♪.*$/gm, " ")
    .replace(/’/g, "'")
    .toLowerCase();
  return said.match(/[\p{L}']+/gu) ?? [];
}

/**
 * Fewer spoken words than this and the text is too little to judge: a film
 * without dialogue has only sound descriptions and words like "beep".
 */
const MIN_WORDS = 500;
/**
 * A share of the language's common words below this: plainly another
 * language. Measured on 15,000 English transcripts: every English one at 0.15
 * or more, every one in another language (Danish, Czech, French, Bulgarian,
 * Arabic, Albanian, mis-encoded Chinese) under 0.1.
 */
const MIN_SHARE = 0.1;

/**
 * False when the lines are plainly not in the first of `languages` this
 * knows, true otherwise (including when it can't tell: too few words, or a
 * language it has no word list for).
 */
export function readsAs(lines: string[], languages: readonly string[]): boolean {
  const key = languages.map((l) => CODES[l.toLowerCase()] ?? l.toLowerCase()).find((l) => LISTS.has(l));
  if (!key) return true;
  const words = spokenWords(lines);
  if (words.length < MIN_WORDS) return true;
  const common = LISTS.get(key)!;
  let n = 0;
  for (const w of words) if (common.has(w)) n++;
  return n / words.length >= MIN_SHARE;
}

/**
 * The longest text sent to the embedding model, in characters: about 2,000
 * tokens of English, inside common embedding models' limits (8,192 tokens for
 * OpenAI's and BGE-M3; a llama.cpp server takes no more than its batch size,
 * 4,096 in the embeddings image). Longer texts are split into windows that
 * fit; an endpoint that still rejects one as too long gets it cut until it
 * takes it (see embedTexts).
 */
export const MAX_EMBED_CHARS = 8_000;

/** A text in pieces of at most `max` characters, split at a paragraph, line, sentence or word where it can be. */
export function splitToFit(text: string, max = MAX_EMBED_CHARS): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const head = rest.slice(0, max + 1);
    const cut = ["\n\n", "\n", ". ", " "].map((sep) => head.lastIndexOf(sep)).find((at) => at >= max / 2);
    const end = cut === undefined ? max : cut + 1;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** The start of a text, at most `max` characters, ending at a word where it can. */
export function trimToFit(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max + 1);
  const at = head.lastIndexOf(" ");
  return (at >= max / 2 ? head.slice(0, at) : text.slice(0, max)).trim();
}

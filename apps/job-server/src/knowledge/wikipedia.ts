import axios from "axios";
import { withRetries } from "./synopsis";

/**
 * Plots from Wikipedia, a reference for the knowledge index: written by people
 * who watched the title, they say who people are and what happens, including
 * what the dialogue never says. An item's IMDb id finds its English article
 * through Wikidata, and the article's Plot section, as plain text, is the
 * reference. Both are read for a batch of items at once. Wikipedia's text is
 * CC BY-SA: the source kept with it is the revision's permanent link.
 */
export interface WikipediaPlot {
  /** Permanent link to the revision the plot was read from. */
  source: string;
  plot: string;
}

const WIKIDATA = "https://query.wikidata.org/sparql";
const WIKIPEDIA = "https://en.wikipedia.org/w/api.php";
/** Wikimedia asks every client to say who it is and how to reach its makers. */
const HEADERS = { "User-Agent": "Streamystats knowledge index (https://github.com/fredrikburmester/streamystats)" };
const TIMEOUT_MS = 60_000;
/** Whole articles per request: few enough to stay under the API's response limit. */
const ARTICLES_PER_REQUEST = 20;
/** Shorter is a stub ("This section needs a plot summary"), not a plot. */
const MIN_PLOT_WORDS = 50;
const PLOT_HEADING = /^==\s*(?:plot|plot summary|synopsis|summary|story)\s*==\s*$/im;

/** English Wikipedia article titles by IMDb id, for the ids that have one. */
export async function articlesByImdbId(imdbIds: string[]): Promise<Map<string, string>> {
  // Only well-formed ids go into the query.
  const ids = [...new Set(imdbIds.filter((id) => /^tt\d+$/.test(id)))];
  if (ids.length === 0) return new Map();
  const query = `SELECT ?imdb ?article WHERE {
    VALUES ?imdb { ${ids.map((id) => `"${id}"`).join(" ")} }
    ?item wdt:P345 ?imdb .
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  }`;
  const res = await withRetries(() =>
    axios.get(WIKIDATA, { params: { query, format: "json" }, headers: HEADERS, timeout: TIMEOUT_MS })
  );
  const bindings: { imdb: { value: string }; article: { value: string } }[] = res.data?.results?.bindings ?? [];
  return new Map(
    bindings.map((b) => [b.imdb.value, decodeURIComponent(b.article.value.split("/wiki/")[1] ?? "").replace(/_/g, " ")])
  );
}

/** The plots of articles by title; an article without a Plot section is left out. */
export async function plotsOf(titles: string[]): Promise<Map<string, WikipediaPlot>> {
  const plots = new Map<string, WikipediaPlot>();
  for (let i = 0; i < titles.length; i += ARTICLES_PER_REQUEST) {
    const res = await withRetries(() =>
      axios.get(WIKIPEDIA, {
        params: {
          action: "query",
          format: "json",
          formatversion: 2,
          prop: "revisions",
          rvprop: "ids|content",
          rvslots: "main",
          titles: titles.slice(i, i + ARTICLES_PER_REQUEST).join("|"),
        },
        headers: HEADERS,
        timeout: TIMEOUT_MS,
      })
    );
    const asked = new Map<string, string>(
      (res.data?.query?.normalized ?? []).map((n: { from: string; to: string }) => [n.to, n.from])
    );
    for (const page of res.data?.query?.pages ?? []) {
      const revision = page.revisions?.[0];
      const plot = plotSection(revision?.slots?.main?.content ?? "");
      if (!plot) continue;
      const source = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title.replace(/ /g, "_"))}&oldid=${revision.revid}`;
      plots.set(asked.get(page.title) ?? page.title, { source, plot });
    }
  }
  return plots;
}

/** An article's Plot section as plain text, or null if it has none worth the name. */
export function plotSection(wikitext: string): string | null {
  const heading = PLOT_HEADING.exec(wikitext);
  if (!heading) return null;
  const rest = wikitext.slice(heading.index + heading[0].length);
  const end = rest.search(/^==[^=]/m);
  const plot = plainText(end >= 0 ? rest.slice(0, end) : rest);
  return plot.split(/\s+/).length >= MIN_PLOT_WORDS ? plot : null;
}

/**
 * Wiki markup as plain text, paragraphs kept: links as their text; templates
 * (citations, notes, hatnotes), references, images, comments, subheadings and
 * formatting dropped.
 */
export function plainText(wikitext: string): string {
  let text = wikitext
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/'{2,}/g, "")
    // The one kind of template that is text: an apostrophe after italics.
    .replace(/\{\{'(s?)\}\}/g, "'$1");
  // Innermost templates first, until none are left.
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(/\{\{[^{}]*\}\}/g, "");
  }
  return text
    .replace(/\[\[(?:File|Image):(?:[^[\]]|\[\[[^\]]*\]\])*\]\]/gi, "")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/\[https?:\/\/[^\s\]]+\s([^\]]*)\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&amp;/g, "&")
    .replace(/^=+[^=\n]*=+\s*$/gm, "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

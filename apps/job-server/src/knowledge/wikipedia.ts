import axios from "axios";
import { withRetries } from "./retry";

/**
 * Plots from Wikipedia, a reference for the knowledge index: written by people
 * who watched the title, they say who people are and what happens, including
 * what the dialogue never says. An item's IMDb id finds its English article
 * through Wikidata, and the article's Plot section, as plain text, is the
 * reference. An episode without an article of its own is looked up in its
 * series' episode lists instead (see listedEpisodesOf). Both are read for a
 * batch of items at once. Wikipedia's text is CC BY-SA: the source kept with
 * it is the revision's permanent link.
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
/** An episode list's summary is short by design; shorter than this says next to nothing. */
export const MIN_SUMMARY_WORDS = 15;
/** Pages read for one series' episodes at most: a long-running series may have an article per season. */
const MAX_LIST_PAGES = 80;
const PLOT_HEADING = /^==\s*(?:plot|plot summary|synopsis|summary|story)\s*==\s*$/im;

/** A Wikipedia page as read: its title after redirects, its revision and its wikitext. */
export interface Page {
  title: string;
  revid: number;
  text: string;
}

const permalink = (page: Page, anchor?: string | null) =>
  `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title.replace(/ /g, "_"))}&oldid=${page.revid}${anchor ? `#${anchor}` : ""}`;

/** An English Wikipedia article's title from its URL. */
const articleTitle = (url: string) => decodeURIComponent(url.split("/wiki/")[1] ?? "").replace(/_/g, " ");

async function sparql(query: string): Promise<Record<string, { value: string } | undefined>[]> {
  const res = await withRetries(() =>
    axios.get(WIKIDATA, { params: { query, format: "json" }, headers: HEADERS, timeout: TIMEOUT_MS })
  );
  return res.data?.results?.bindings ?? [];
}

/** Pages by the title they were asked for, redirects followed; a page that doesn't exist is left out. */
async function pagesOf(titles: string[]): Promise<Map<string, Page>> {
  const pages = new Map<string, Page>();
  const unique = [...new Set(titles)];
  for (let i = 0; i < unique.length; i += ARTICLES_PER_REQUEST) {
    const chunk = unique.slice(i, i + ARTICLES_PER_REQUEST);
    const res = await withRetries(() =>
      axios.get(WIKIPEDIA, {
        params: {
          action: "query",
          format: "json",
          formatversion: 2,
          redirects: 1,
          prop: "revisions",
          rvprop: "ids|content",
          rvslots: "main",
          titles: chunk.join("|"),
        },
        headers: HEADERS,
        timeout: TIMEOUT_MS,
      })
    );
    const renamed = new Map<string, string>();
    for (const r of [...(res.data?.query?.normalized ?? []), ...(res.data?.query?.redirects ?? [])]) {
      renamed.set(r.from, r.to);
    }
    const read = new Map<string, Page>();
    for (const page of res.data?.query?.pages ?? []) {
      const revision = page.revisions?.[0];
      if (page.missing || !revision) continue;
      read.set(page.title, { title: page.title, revid: revision.revid, text: revision.slots?.main?.content ?? "" });
    }
    for (const title of chunk) {
      let to = title;
      for (let hops = 0; hops < 4 && renamed.has(to); hops++) to = renamed.get(to) ?? to;
      const page = read.get(to.replace(/#.*$/, ""));
      if (page) pages.set(title, page);
    }
  }
  return pages;
}

/** English Wikipedia article titles by IMDb id, for the ids that have one. */
export async function articlesByImdbId(imdbIds: string[]): Promise<Map<string, string>> {
  // Only well-formed ids go into the query.
  const ids = [...new Set(imdbIds.filter((id) => /^tt\d+$/.test(id)))];
  if (ids.length === 0) return new Map();
  const bindings = await sparql(`SELECT ?imdb ?article WHERE {
    VALUES ?imdb { ${ids.map((id) => `"${id}"`).join(" ")} }
    ?item wdt:P345 ?imdb .
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  }`);
  const articles = new Map<string, string>();
  for (const b of bindings) if (b.imdb && b.article) articles.set(b.imdb.value, articleTitle(b.article.value));
  return articles;
}

/** The plots of articles by title; an article without a Plot section is left out. */
export async function plotsOf(titles: string[]): Promise<Map<string, WikipediaPlot>> {
  const plots = new Map<string, WikipediaPlot>();
  for (const [asked, page] of await pagesOf(titles)) {
    const plot = plotSection(page.text);
    if (plot) plots.set(asked, { source: permalink(page), plot });
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
 * formatting dropped; a line break as a space.
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
    .replace(/<br\s*\/?>/gi, " ")
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

// --- Episode lists -----------------------------------------------------------

/** A series' ids, any of which finds it on Wikidata. */
export interface SeriesIds {
  imdb?: string | null;
  tvdb?: string | null;
  tmdb?: string | null;
}

/** An episode as a series' episode list on Wikipedia gives it: one {{Episode list}} row. */
export interface ListedEpisode {
  /** The season it is listed under, from the page's title or the heading above it; null if neither says. */
  season: number | null;
  /** Its number in the season (EpisodeNumber2), and in the series (EpisodeNumber). */
  number: number | null;
  overall: number | null;
  title: string;
  /** When it first aired, as YYYY-MM-DD. */
  aired: string | null;
  /** The row's ShortSummary as plain text; empty when it has none. */
  summary: string;
  /** Permanent link to the page revision, at the row. */
  source: string;
}

/**
 * Wikidata properties a series is found by, per id kind (IMDb, TheTVDB series,
 * TMDb TV series), and the shape each id takes.
 */
const SERIES_ID_PROPERTIES = [
  ["imdb", "P345", /^tt\d+$/],
  ["tvdb", "P4835", /^\d+$/],
  ["tmdb", "P4983", /^\d+$/],
] as const;

/**
 * Pages that may list a series' episodes, by the caller's key: from Wikidata,
 * the series' English article, its list of episodes (P1811) and its season
 * articles (television series seasons that are part of the series, P179); and
 * the usual title of a list, "List of <series> episodes", which Wikidata often
 * lacks. A series found by none of its ids gets none.
 */
async function seriesPages(series: Map<string, SeriesIds>): Promise<Map<string, Set<string>>> {
  const pages = new Map<string, Set<string>>();
  const add = (key: string, title: string | undefined) => {
    if (!title) return;
    const set = pages.get(key) ?? new Set<string>();
    set.add(title);
    pages.set(key, set);
  };
  const found = new Set<string>();
  for (const [kind, property, shape] of SERIES_ID_PROPERTIES) {
    const byId = new Map<string, string[]>();
    for (const [key, ids] of series) {
      const id = ids[kind]?.trim();
      if (found.has(key) || !id || !shape.test(id)) continue;
      byId.set(id, [...(byId.get(id) ?? []), key]);
    }
    if (byId.size === 0) continue;
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const rows = await sparql(`SELECT ?id ?article ?list ?season WHERE {
        VALUES ?id { ${ids
          .slice(i, i + 100)
          .map((id) => `"${id}"`)
          .join(" ")} }
        ?series wdt:${property} ?id .
        OPTIONAL { ?article schema:about ?series ; schema:isPartOf <https://en.wikipedia.org/> . }
        OPTIONAL { ?series wdt:P1811 ?l . ?list schema:about ?l ; schema:isPartOf <https://en.wikipedia.org/> . }
        OPTIONAL { ?s wdt:P179 ?series ; wdt:P31 wd:Q3464665 .
                   ?season schema:about ?s ; schema:isPartOf <https://en.wikipedia.org/> . }
      }`);
      for (const row of rows) {
        for (const key of byId.get(row.id?.value ?? "") ?? []) {
          found.add(key);
          const article = row.article ? articleTitle(row.article.value) : undefined;
          add(key, article);
          if (article) {
            add(key, `List of ${article} episodes`);
            add(key, `List of ${article.replace(/ \([^)]*\)$/, "")} episodes`);
          }
          add(key, row.list ? articleTitle(row.list.value) : undefined);
          add(key, row.season ? articleTitle(row.season.value) : undefined);
        }
      }
    }
  }
  return pages;
}

/** A page's links to the pages that list a season's episodes: transcluded pages, and Main and Further hatnotes. */
export function linkedSeasonPages(wikitext: string): string[] {
  const titles = new Set<string>();
  for (const m of wikitext.matchAll(/\{\{\s*:([^{}|]+)\}\}/g)) titles.add(m[1].trim());
  for (const m of wikitext.matchAll(/\{\{\s*(?:main|main article|further|see also)\s*\|([^{}]+)\}\}/gi)) {
    for (const part of m[1].split("|")) if (!part.includes("=")) titles.add(part.trim());
  }
  return [...titles].filter((t) => /\b(?:season|series|episodes)\b|\(\d{4}\)/i.test(t));
}

/** The {{Episode list}} templates in wikitext (and the /sublist variant): where each starts, and its body. */
function episodeTemplates(wikitext: string): { at: number; body: string }[] {
  const found: { at: number; body: string }[] = [];
  const start = /\{\{\s*Episode[ _]list(?:\/sublist)?\s*\|/gi;
  for (let m = start.exec(wikitext); m; m = start.exec(wikitext)) {
    let depth = 0;
    let i = m.index;
    for (; i < wikitext.length - 1; i++) {
      const two = wikitext.slice(i, i + 2);
      if (two === "{{") {
        depth++;
        i++;
      } else if (two === "}}") {
        depth--;
        i++;
        if (depth === 0) break;
      }
    }
    found.push({ at: m.index, body: wikitext.slice(m.index + 2, i - 1) });
    start.lastIndex = i;
  }
  return found;
}

/** A template's named parameters, lower-cased: split at the pipes outside nested templates and links. */
function templateParams(body: string): Map<string, string> {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") {
      depth++;
      current += two;
      i++;
    } else if (two === "}}" || two === "]]") {
      depth--;
      current += two;
      i++;
    } else if (body[i] === "|" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += body[i];
    }
  }
  parts.push(current);
  const params = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq > 0) params.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  return params;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const iso = (y: string | number, m: string | number, d: string | number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** An air date as YYYY-MM-DD: {{Start date|2009|4|8}}, "April 8, 2009" or "8 April 2009". */
export function airDate(value: string | undefined): string | null {
  if (!value) return null;
  const template = /\{\{\s*(?:start date|dts|film date)\s*\|\s*(\d{4})\s*\|\s*(\d{1,2})\s*\|\s*(\d{1,2})/i.exec(value);
  if (template) return iso(template[1], template[2], template[3]);
  const text = plainText(value).toLowerCase();
  const mdy = /([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/.exec(text);
  if (mdy && MONTHS.includes(mdy[1])) return iso(mdy[3], MONTHS.indexOf(mdy[1]) + 1, mdy[2]);
  const dmy = /(\d{1,2})\s+([a-z]+)\s+(\d{4})/.exec(text);
  if (dmy && MONTHS.includes(dmy[2])) return iso(dmy[3], MONTHS.indexOf(dmy[2]) + 1, dmy[1]);
  const isoText = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return isoText ? iso(isoText[1], isoText[2], isoText[3]) : null;
}

const SEASON_IN_TITLE = /\((\d{4}) season\)|\b(?:season|series) (\d+)\b/i;
const SEASON_IN_HEADING = /\b(?:season|series)\s+(\d+)\b|^(\d{4})\b/i;

/** The season a row is listed under: the page's own (a season article), or the nearest heading above it that names one. */
function seasonAt(page: Page, at: number): number | null {
  const own = SEASON_IN_TITLE.exec(page.title);
  if (own) return Number(own[1] ?? own[2]);
  const headings = [...page.text.slice(0, at).matchAll(/^==+\s*(.*?)\s*==+\s*$/gm)];
  for (let i = headings.length - 1; i >= 0; i--) {
    const season = SEASON_IN_HEADING.exec(plainText(headings[i][1]));
    if (season) return Number(season[1] ?? season[2]);
  }
  return null;
}

const whole = (value: string | undefined) => {
  const n = Number.parseInt(plainText(value ?? ""), 10);
  return Number.isFinite(n) ? n : null;
};

/** A page's {{Episode list}} rows. */
export function episodeListEntries(page: Page): ListedEpisode[] {
  return episodeTemplates(page.text).map(({ at, body }) => {
    const params = templateParams(body);
    const overall = whole(params.get("episodenumber"));
    return {
      season: seasonAt(page, at),
      number: whole(params.get("episodenumber2")),
      overall,
      title: plainText(params.get("title") ?? params.get("rtitle") ?? "").replace(/^"+|"+$/g, ""),
      aired: airDate(params.get("originalairdate")),
      summary: plainText((params.get("shortsummary") ?? "").replace(/<br\s*\/?>/gi, "\n")),
      source: permalink(page, overall === null ? null : `ep${overall}`),
    };
  });
}

/**
 * The episodes a series' Wikipedia pages list, by the caller's key: the rows
 * of its article, its list of episodes and its season articles (seriesPages),
 * and of the season pages those lead to (linkedSeasonPages), each page read once.
 */
export async function listedEpisodesOf(series: Map<string, SeriesIds>): Promise<Map<string, ListedEpisode[]>> {
  const candidates = await seriesPages(series);
  const read = await pagesOf([...candidates.values()].flatMap((set) => [...set]));
  const more = new Set<string>();
  for (const set of candidates.values()) {
    for (const title of set) for (const linked of linkedSeasonPages(read.get(title)?.text ?? "")) more.add(linked);
  }
  for (const [title, page] of await pagesOf([...more].filter((t) => !read.has(t)))) read.set(title, page);

  const listed = new Map<string, ListedEpisode[]>();
  for (const [key, set] of candidates) {
    const titles = [...set];
    for (const title of [...set]) {
      for (const linked of linkedSeasonPages(read.get(title)?.text ?? "")) titles.push(linked);
    }
    const seen = new Set<string>();
    const rows: ListedEpisode[] = [];
    for (const title of titles) {
      const page = read.get(title);
      if (!page || seen.has(page.title) || seen.size >= MAX_LIST_PAGES) continue;
      seen.add(page.title);
      rows.push(...episodeListEntries(page));
    }
    listed.set(key, rows);
  }
  return listed;
}

// --- Matching an episode to its row ------------------------------------------

/** An episode as the library knows it. */
export interface LibraryEpisode {
  season: number | null;
  number: number | null;
  title: string | null;
  /** When it first aired, as YYYY-MM-DD. */
  aired: string | null;
}

const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A file-name placeholder rather than a title: "MythBusters - S2009E05 -", "Episode 5". */
const placeholder = (title: string | null) =>
  !title || /\bS\d+\s*E\d+\b/i.test(title) || /^(?:episode|ep\.?)\s*\d+$/i.test(title.trim()) || !normalize(title);

/** Letter pairs, for spellings that differ by a letter or two ("Thinnergy", "Thinergy"). */
const pairs = (s: string) => {
  const compact = normalize(s).replace(/ /g, "");
  return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, i) => compact.slice(i, i + 2)));
};

/**
 * Whether two titles name the same episode: the same once normalized, most of
 * the shorter one's words in the other ("Fun Run" in "Fun Run / Dunder Mifflin
 * Infinity"), or spelled nearly alike.
 */
export function titlesAgree(a: string, b: string): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  if (!x || !y) return false;
  if (x === y) return true;
  const words = (s: string) => new Set(s.split(" ").filter((w) => w.length > 2));
  const [wx, wy] = [words(x), words(y)];
  if (wx.size > 0 && wy.size > 0) {
    const shared = [...wx].filter((w) => wy.has(w)).length;
    if (shared / Math.min(wx.size, wy.size) >= 0.5) return true;
  }
  const [px, py] = [pairs(a), pairs(b)];
  if (px.size < 4 || py.size < 4) return false;
  const common = [...px].filter((p) => py.has(p)).length;
  return (2 * common) / (px.size + py.size) >= 0.8;
}

const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * The row an episode is, among its series' rows, or null when none can be
 * told for sure. First by air date (a day either way, for time zones): the one
 * row that day, unless its title disagrees with the episode's; then by season
 * and number, only when the titles agree (numbering differs between sources:
 * double episodes, specials, a revival's seasons); then by title alone, when
 * one row has it. An episode whose title is a placeholder is told by its air
 * date only. A file of several episodes ("A / B") is each of its parts.
 */
export function matchListedEpisode(rows: ListedEpisode[], episode: LibraryEpisode): ListedEpisode[] {
  const parts = episode.title && !placeholder(episode.title) ? episode.title.split(/\s+\/\s+/) : [null];
  if (parts.length > 1) {
    const found = parts.map((part) => matchOne(rows, { ...episode, title: part }));
    const unique = [...new Set(found.filter((row): row is ListedEpisode => row !== null))];
    if (unique.length > 0) return unique;
  }
  const one = matchOne(rows, episode);
  return one ? [one] : [];
}

function matchOne(rows: ListedEpisode[], episode: LibraryEpisode): ListedEpisode | null {
  const titled = !placeholder(episode.title);
  const agrees = (row: ListedEpisode) => titled && !!row.title && titlesAgree(row.title, episode.title ?? "");
  const only = (found: ListedEpisode[]) => (found.length === 1 ? found[0] : null);

  if (episode.aired) {
    const sameDay = rows.filter((row) => row.aired && daysApart(row.aired, episode.aired ?? "") <= 1);
    if (titled) {
      const named = sameDay.filter(agrees);
      if (named.length > 0) return only(named);
      if (sameDay.length === 1 && !sameDay[0].title) return sameDay[0];
    } else if (sameDay.length > 0) {
      return only(sameDay);
    }
  }
  if (!titled) return null;
  if (episode.season !== null && episode.number !== null) {
    const numbered = rows.filter((row) => row.season === episode.season && row.number === episode.number && agrees(row));
    if (numbered.length > 0) return only(numbered);
  }
  return only(rows.filter((row) => !!row.title && normalize(row.title) === normalize(episode.title ?? "")));
}

/**
 * An episode's summary from its rows: their summaries together (a file of
 * several episodes has several), with the first row's link, or null when they
 * say too little to go on.
 */
export function listedSummary(rows: ListedEpisode[]): WikipediaPlot | null {
  const summaries = rows.map((row) => row.summary).filter(Boolean);
  const plot = summaries.join("\n\n");
  if (rows.length === 0 || plot.split(/\s+/).filter(Boolean).length < MIN_SUMMARY_WORDS) return null;
  return { source: rows[0].source, plot };
}

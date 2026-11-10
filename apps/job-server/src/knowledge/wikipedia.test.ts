import { describe, expect, test } from "bun:test";
import {
  airDate,
  episodeListEntries,
  type ListedEpisode,
  linkedSeasonPages,
  listedSummary,
  matchListedEpisode,
  plainText,
  plotSection,
  titlesAgree,
} from "./wikipedia";

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

describe("plotSection", () => {
  const article = `{{Short description|2009 film}}
{{Infobox film | name = Moon }}
'''''Moon''''' is a 2009 film.

== Plot ==
[[Sam Rockwell|Sam Bell]] works alone on the Moon.<ref>{{cite web |url=https://example.com |title=Moon}}</ref> ${words(60)}

=== Ending ===
He sends the clone<!-- not the original --> to Earth.

== Cast ==
* Sam Rockwell as Sam Bell
`;

  test("the Plot section as plain text, up to the next section, subsections included", () => {
    const plot = plotSection(article);
    expect(plot).toStartWith(`Sam Bell works alone on the Moon. ${words(60)}`);
    expect(plot).toEndWith("\n\nHe sends the clone to Earth.");
    expect(plot).not.toContain("Cast");
  });

  test("other names for the section", () => {
    expect(plotSection(`== Synopsis ==\n${words(60)}`)).toBe(words(60));
    expect(plotSection(`==Plot summary==\n${words(60)}`)).toBe(words(60));
  });

  test("none without a plot section, or with a stub", () => {
    expect(plotSection(`== Production ==\n${words(60)}`)).toBeNull();
    expect(plotSection("== Plot ==\n{{Expand section|date=May 2020}}\nSam works.\n== Cast ==")).toBeNull();
  });
});

describe("plainText", () => {
  test("links as their text; images, references, templates and formatting dropped", () => {
    expect(
      plainText(
        `[[File:Moon.jpg|thumb|The base, [[Sarang]]]]On [[Sarang (base)|Sarang]], [[GERTY]] helps ''Sam''.{{efn|In the {{lang|ko|original}}.}}<ref name="a" /> See [https://example.com the site].`
      )
    ).toBe("On Sarang, GERTY helps Sam. See the site.");
    expect(plainText("The ''Axiom''{{'}}s captain and the ''Axiom''{{'s}} robots.")).toBe(
      "The Axiom's captain and the Axiom's robots."
    );
  });

  test("paragraphs kept, lines within one joined, entities read", () => {
    expect(plainText("Sam wakes\nin the infirmary.\n\n\nHe meets&nbsp;himself&ndash;older.")).toBe(
      "Sam wakes in the infirmary.\n\nHe meets himself–older."
    );
  });

  test("a line break is a space", () => {
    expect(plainText("Myths tested:<br />Can a car fly?<br/>Can it float?")).toBe("Myths tested: Can a car fly? Can it float?");
  });
});

describe("episode lists", () => {
  const season = {
    title: "MythBusters (2009 season)",
    revid: 42,
    text: [
      "{{Short description|Season of MythBusters}}",
      "==Episode overview==",
      "{{Episode table |background=#000080 |overall=5 |season=5 |title=27 |airdate=20",
      "|episodes =",
      "{{Episode list",
      "|EpisodeNumber   = 115",
      "|EpisodeNumber2  = 1",
      "|Title           = Demolition Derby Special",
      "|OriginalAirDate = {{Start date|2009|4|8}}",
      "|ShortSummary    = '''Myths tested''':<br />Will moving passengers keep a bus from [[Rollover|flipping]]?<br />Can two big rigs flatten a car?<ref>{{cite web|url=https://example.com}}</ref>",
      "}}",
      "{{Episode list",
      "|EpisodeNumber   = 117",
      "|EpisodeNumber2  = 3",
      '|Title           = "Banana Slip/Double Dip"{{efn|Also aired as "Banana Slip".}}',
      "|OriginalAirDate = April 22, 2009",
      "|ShortSummary    = Can a banana peel really cause one to slip?",
      "}}",
      "}}",
    ].join("\n"),
  };

  test("a season article's rows: number, title, air date, summary as text, a link to the row", () => {
    const [first, second] = episodeListEntries(season);
    expect(first).toEqual({
      season: 2009,
      number: 1,
      overall: 115,
      title: "Demolition Derby Special",
      aired: "2009-04-08",
      summary: "Myths tested: Will moving passengers keep a bus from flipping? Can two big rigs flatten a car?",
      source: "https://en.wikipedia.org/w/index.php?title=MythBusters_(2009_season)&oldid=42#ep115",
    });
    expect(second).toMatchObject({ number: 3, title: "Banana Slip/Double Dip", aired: "2009-04-22" });
  });

  test("a list's rows take their season from the heading above them; the sublist variant counts", () => {
    const list = {
      title: "List of ReBoot episodes",
      revid: 7,
      text: [
        "== Episodes ==",
        "=== Season 1 (1994–95) ===",
        "{{Episode list/sublist|List of ReBoot episodes",
        "|EpisodeNumber=1 |EpisodeNumber2=1 |Title=[[The Tearing]] |OriginalAirDate={{Start date|1994|9|10}}",
        "|ShortSummary=Megabyte tries to open a portal to the Supercomputer.",
        "}}",
        "=== Season 2 (1995–96) ===",
        "{{Episode list/sublist|List of ReBoot episodes",
        "|EpisodeNumber=14 |EpisodeNumber2=1 |Title=Infected |OriginalAirDate=9 September 1995",
        "|ShortSummary=Bob is infected by a virus.",
        "}}",
      ].join("\n"),
    };
    expect(episodeListEntries(list).map((r) => [r.season, r.number, r.title, r.aired])).toEqual([
      [1, 1, "The Tearing", "1994-09-10"],
      [2, 1, "Infected", "1995-09-09"],
    ]);
  });

  test("air dates in the forms lists use", () => {
    expect(airDate("{{Start date|1987|04|05}}")).toBe("1987-04-05");
    expect(airDate("{{Start date|2009|4|8|df=y}}")).toBe("2009-04-08");
    expect(airDate("April 22, 2009")).toBe("2009-04-22");
    expect(airDate("22 April 2009")).toBe("2009-04-22");
    expect(airDate("TBA")).toBeNull();
    expect(airDate(undefined)).toBeNull();
  });

  test("a list's links to its season pages: transcluded, or in a Main or Further hatnote", () => {
    expect(
      linkedSeasonPages(
        [
          "{{:MythBusters (2009 season)}}",
          "{{Main|The Big Bang Theory season 1}}",
          "{{Main|Characters of The Big Bang Theory}}",
          "{{further|The Office (American TV series) season 4|The Office (American TV series) season 5}}",
        ].join("\n")
      )
    ).toEqual([
      "MythBusters (2009 season)",
      "The Big Bang Theory season 1",
      "The Office (American TV series) season 4",
      "The Office (American TV series) season 5",
    ]);
  });
});

describe("titlesAgree", () => {
  test("the same title written differently", () => {
    expect(titlesAgree("Ándale", "Andale")).toBe(true);
    expect(titlesAgree("Thinergy", "Thinnergy")).toBe(true);
    expect(titlesAgree("Cyber Discount Day", "CyberDiscountDay")).toBe(true);
    expect(titlesAgree("Fun Run", "Fun Run / Dunder Mifflin Infinity")).toBe(true);
    expect(titlesAgree("Pilot (Part 1)", "Pilot")).toBe(true);
  });

  test("different episodes", () => {
    expect(titlesAgree("Here's Lookin' at You, Kid", "Life's a Beach")).toBe(false);
    expect(titlesAgree("Night Out", "Job Fair")).toBe(false);
    expect(titlesAgree("", "Pilot")).toBe(false);
  });
});

describe("matchListedEpisode", () => {
  const row = (r: Partial<ListedEpisode>): ListedEpisode => ({
    season: 1,
    number: null,
    overall: null,
    title: "",
    aired: null,
    summary: "s",
    source: "link",
    ...r,
  });
  const rows = [
    row({ number: 1, title: "Pilot", aired: "2005-03-24" }),
    row({ number: 2, title: "Diversity Day", aired: "2005-03-29" }),
    row({ number: 3, title: "Health Care", aired: "2005-04-05" }),
    row({ number: 4, title: "The Alliance", aired: "2005-04-12" }),
    row({ number: 5, title: "Basketball", aired: "2005-04-19" }),
    row({ number: 6, title: "Hot Girl", aired: "2005-04-19" }),
  ];
  const ep = (e: Partial<Parameters<typeof matchListedEpisode>[1]>) => ({
    season: 1,
    number: null,
    title: null,
    aired: null,
    ...e,
  });
  const titles = (found: ListedEpisode[]) => found.map((r) => r.title);

  test("by air date, a day either way, when the title agrees", () => {
    expect(titles(matchListedEpisode(rows, ep({ title: "Diversity Day", aired: "2005-03-30" })))).toEqual([
      "Diversity Day",
    ]);
  });

  test("two the same day: the one the title names", () => {
    expect(titles(matchListedEpisode(rows, ep({ title: "Hot Girl", aired: "2005-04-19" })))).toEqual(["Hot Girl"]);
  });

  test("a placeholder title: by air date when one row aired then, else by season and number", () => {
    expect(titles(matchListedEpisode(rows, ep({ title: "The Office - S01E03 -", aired: "2005-04-05" })))).toEqual([
      "Health Care",
    ]);
    expect(matchListedEpisode(rows, ep({ title: "The Office - S01E05 -", aired: "2005-04-19" }))).toEqual([]);
    expect(titles(matchListedEpisode(rows, ep({ title: "The Office - S01E05 -", aired: "2005-04-19", number: 5 })))).toEqual(
      ["Basketball"]
    );
    // A file date as the air date (metadata missing): no row aired then, so the number tells.
    expect(titles(matchListedEpisode(rows, ep({ title: "The Office - S01E03 -", aired: "2015-09-10", number: 3 })))).toEqual(
      ["Health Care"]
    );
  });

  test("an air date whose row has another title is not trusted", () => {
    expect(matchListedEpisode(rows, ep({ title: "Lez Be Friends", aired: "2005-04-12", number: 4 }))).toEqual([]);
  });

  test("by season and number only when the title agrees", () => {
    expect(titles(matchListedEpisode(rows, ep({ title: "The Alliance", number: 4 })))).toEqual(["The Alliance"]);
    expect(matchListedEpisode(rows, ep({ title: "Night Out", number: 4 }))).toEqual([]);
  });

  test("by title alone, when one row has it", () => {
    expect(titles(matchListedEpisode(rows, ep({ title: "Basketball", season: 9 })))).toEqual(["Basketball"]);
  });

  test("a file of two episodes is both", () => {
    expect(titles(matchListedEpisode(rows, ep({ title: "Pilot / Diversity Day", aired: "2005-03-24" })))).toEqual([
      "Pilot",
      "Diversity Day",
    ]);
  });
});

describe("listedSummary", () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
  const row = (summary: string, source: string): ListedEpisode => ({
    season: 1,
    number: 1,
    overall: 1,
    title: "t",
    aired: null,
    summary,
    source,
  });

  test("the rows' summaries together, with the first row's link", () => {
    expect(listedSummary([row(words(10), "a"), row(words(10), "b")])).toEqual({
      source: "a",
      plot: `${words(10)}\n\n${words(10)}`,
    });
  });

  test("none when they say too little", () => {
    expect(listedSummary([row("TBA", "a")])).toBeNull();
    expect(listedSummary([])).toBeNull();
  });
});

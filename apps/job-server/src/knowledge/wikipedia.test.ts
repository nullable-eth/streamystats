import { describe, expect, test } from "bun:test";
import { plainText, plotSection } from "./wikipedia";

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
});

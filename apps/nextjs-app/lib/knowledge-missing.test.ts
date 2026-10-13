import { describe, expect, test } from "bun:test";
import { type MissingRow, summarizeMissing } from "./knowledge-missing";

const ep = (
  seriesName: string,
  season: number,
  episode: number,
): MissingRow => ({
  name: `${seriesName} ${season}x${episode}`,
  seriesName,
  season,
  episode,
  year: null,
});

describe("summarizeMissing", () => {
  test("collapses consecutive episodes into ranges, per season", () => {
    const rows = [3, 4, 5, 9, 10, 11, 16, 24].map((e) => ep("24", 1, e));
    rows.push(ep("24", 2, 2), ep("24", 2, 4));
    const { series } = summarizeMissing(rows);
    expect(series).toEqual([
      {
        name: "24",
        count: 10,
        episodes: "S01E03–E05, E09–E11, E16, E24 · S02E02, E04",
      },
    ]);
  });

  test("series with the most missing come first, then by name", () => {
    const rows = [
      ep("Alpha", 1, 1),
      ep("Beta", 1, 1),
      ep("Beta", 1, 2),
      ep("Gamma", 1, 1),
    ];
    expect(summarizeMissing(rows).series.map((s) => s.name)).toEqual([
      "Beta",
      "Alpha",
      "Gamma",
    ]);
  });

  test("movies are listed by name with their year", () => {
    const { movies, series } = summarizeMissing([
      {
        name: "Zodiac",
        seriesName: null,
        season: null,
        episode: null,
        year: 2007,
      },
      {
        name: "Alien",
        seriesName: null,
        season: null,
        episode: null,
        year: 1979,
      },
    ]);
    expect(series).toEqual([]);
    expect(movies).toEqual([
      { name: "Alien", year: 1979 },
      { name: "Zodiac", year: 2007 },
    ]);
  });

  test("episodes without numbers are counted, not dropped", () => {
    const { series } = summarizeMissing([
      ep("Show", 1, 1),
      {
        name: "Special",
        seriesName: "Show",
        season: null,
        episode: null,
        year: null,
      },
    ]);
    expect(series[0]).toEqual({
      name: "Show",
      count: 2,
      episodes: "S01E01 · 1 without episode numbers",
    });
  });
});

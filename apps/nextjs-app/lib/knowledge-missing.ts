/**
 * Items that have no full text subtitle, grouped the way a subtitle
 * downloader is worked through: one line per series (most missing first,
 * episodes collapsed into ranges) and one per movie.
 */
export interface MissingRow {
  name: string;
  seriesName: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
}

export interface MissingSeries {
  name: string;
  count: number;
  /** e.g. "S01E03–E05, E09 · S02E02" */
  episodes: string;
}

export interface MissingMovie {
  name: string;
  year: number | null;
}

export interface MissingSummary {
  series: MissingSeries[];
  movies: MissingMovie[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Collapse one season's episode numbers into ranges: 3,4,5,9 → E03–E05, E09. */
function episodeRanges(episodes: number[]): string {
  const sorted = [...new Set(episodes)].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const e of [...sorted.slice(1), Number.NaN]) {
    if (e === prev + 1) {
      prev = e;
      continue;
    }
    runs.push(
      start === prev ? `E${pad(start)}` : `E${pad(start)}–E${pad(prev)}`,
    );
    start = e;
    prev = e;
  }
  return runs.join(", ");
}

export function summarizeMissing(rows: MissingRow[]): MissingSummary {
  const bySeries = new Map<string, Map<number, number[]>>();
  const unnumbered = new Map<string, number>();
  const movies: MissingMovie[] = [];

  for (const row of rows) {
    if (!row.seriesName) {
      movies.push({ name: row.name, year: row.year });
      continue;
    }
    if (row.season === null || row.episode === null) {
      unnumbered.set(row.seriesName, (unnumbered.get(row.seriesName) ?? 0) + 1);
      continue;
    }
    const seasons = bySeries.get(row.seriesName) ?? new Map<number, number[]>();
    seasons.set(row.season, [...(seasons.get(row.season) ?? []), row.episode]);
    bySeries.set(row.seriesName, seasons);
  }

  const names = new Set([...bySeries.keys(), ...unnumbered.keys()]);
  const series = [...names].map((name) => {
    const seasons = bySeries.get(name) ?? new Map<number, number[]>();
    const parts = [...seasons.entries()]
      .sort(([a], [b]) => a - b)
      .map(([season, episodes]) => `S${pad(season)}${episodeRanges(episodes)}`);
    const extra = unnumbered.get(name) ?? 0;
    if (extra > 0) parts.push(`${extra} without episode numbers`);
    const count =
      [...seasons.values()].reduce((n, e) => n + new Set(e).size, 0) + extra;
    return { name, count, episodes: parts.join(" · ") };
  });

  series.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  movies.sort((a, b) => a.name.localeCompare(b.name));
  return { series, movies };
}

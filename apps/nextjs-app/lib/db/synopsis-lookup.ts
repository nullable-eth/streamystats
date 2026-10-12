import "server-only";

import { db, items, itemTexts } from "@streamystats/database";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { getStatisticsExclusions } from "./exclusions";

export interface SynopsisLookup {
  itemId: string;
  title: string;
  series: string | null;
  episode: string | null;
  isLastEpisodeOfSeason: boolean;
  isLastEpisodeOfSeries: boolean;
  /** The stored plot synopsis, or null if the knowledge index has none yet. */
  synopsis: string | null;
  overview: string | null;
}

const pad = (n: number | null) => String(n ?? 0).padStart(2, "0");

/**
 * The stored synopsis of a movie, or of one episode of a series: a given
 * season/episode, the last episode of a season, or (by default) the series'
 * last episode -- which is what "does it end on a cliffhanger?" needs.
 * Specials (season 0) are ignored. Only libraries the user may see.
 */
export async function lookupSynopsis({
  serverId,
  userId,
  title,
  season,
  episode,
  position,
}: {
  serverId: number;
  userId: string;
  title: string;
  season?: number;
  episode?: number;
  position: "first" | "last";
}): Promise<SynopsisLookup | null> {
  const { itemLibraryExclusion } = await getStatisticsExclusions(
    serverId,
    userId,
  );
  const visible: SQL[] = [
    eq(items.serverId, serverId),
    isNull(items.deletedAt),
  ];
  if (itemLibraryExclusion) visible.push(itemLibraryExclusion);

  const [match] = await db
    .select({ id: items.id, name: items.name, type: items.type })
    .from(items)
    .where(
      and(
        ...visible,
        inArray(items.type, ["Movie", "Series"]),
        ilike(items.name, `%${title}%`),
      ),
    )
    .orderBy(
      desc(sql`lower(${items.name}) = lower(${title})`),
      asc(sql`length(${items.name})`),
    )
    .limit(1);
  if (!match) return null;

  let target: {
    id: string;
    title: string;
    series: string | null;
    episode: string | null;
  } = { id: match.id, title: match.name, series: null, episode: null };
  let isLastEpisodeOfSeason = false;
  let isLastEpisodeOfSeries = false;

  if (match.type === "Series") {
    const episodes = await db
      .select({
        id: items.id,
        name: items.name,
        season: items.parentIndexNumber,
        number: items.indexNumber,
      })
      .from(items)
      .where(
        and(
          ...visible,
          eq(items.type, "Episode"),
          eq(items.seriesId, match.id),
          gt(items.parentIndexNumber, 0),
        ),
      )
      .orderBy(asc(items.parentIndexNumber), asc(items.indexNumber));
    if (episodes.length === 0) return null;

    const inSeason =
      season === undefined
        ? episodes
        : episodes.filter((e) => e.season === season);
    const chosen =
      episode !== undefined
        ? inSeason.find((e) => e.number === episode)
        : position === "first"
          ? inSeason[0]
          : inSeason.at(-1);
    if (!chosen) return null;

    const seasonEpisodes = episodes.filter((e) => e.season === chosen.season);
    isLastEpisodeOfSeason = seasonEpisodes.at(-1)?.id === chosen.id;
    isLastEpisodeOfSeries = episodes.at(-1)?.id === chosen.id;
    target = {
      id: chosen.id,
      title: chosen.name,
      series: match.name,
      episode: `S${pad(chosen.season)}E${pad(chosen.number)}`,
    };
  }

  const [row] = await db
    .select({ overview: items.overview, synopsis: itemTexts.content })
    .from(items)
    .leftJoin(
      itemTexts,
      and(
        eq(itemTexts.itemId, items.id),
        eq(itemTexts.kind, "synopsis"),
        eq(itemTexts.status, "ready"),
      ),
    )
    .where(eq(items.id, target.id))
    .limit(1);

  return {
    itemId: target.id,
    title: target.title,
    series: target.series,
    episode: target.episode,
    isLastEpisodeOfSeason,
    isLastEpisodeOfSeries,
    synopsis: row?.synopsis || null,
    overview: row?.overview ?? null,
  };
}

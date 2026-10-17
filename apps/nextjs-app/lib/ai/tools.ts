import "server-only";

import { db, items, libraries, sessions, users } from "@streamystats/database";
import type { Item } from "@streamystats/database/schema";
import { tool } from "ai";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { embedTextForServer } from "@/lib/ai/embed-text";
import { getItemEmbeddingComparison } from "@/lib/db/embedding-comparison";
import { getHistoryByFilters } from "@/lib/db/history";
import {
  findItemsByCharacter,
  findItemsByPerson,
} from "@/lib/db/item-people-search";
import { titlesMentioning } from "@/lib/db/mentions";
import { findMoments, locateMoment, momentScope } from "@/lib/db/moments";
import { searchByPlot } from "@/lib/db/plot-search";
import { getRatedItems } from "@/lib/db/rated-items";
import { alternate } from "@/lib/db/rating-signals-pick";
import { getSimilarSeries } from "@/lib/db/similar-series-statistics";
import {
  getSimilarItemsForItem,
  getSimilarStatistics,
} from "@/lib/db/similar-statistics";
import { getMostWatchedItems } from "@/lib/db/statistics";
import { lookupSynopsis } from "@/lib/db/synopsis-lookup";
import {
  formatTimestamp,
  getMatchedItems,
  searchTranscripts,
} from "@/lib/db/transcript-search";
import {
  getUserStatsSummaryForServer,
  getUsers,
  getUserWatchStats,
} from "@/lib/db/users";

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

type FormattableItem = Pick<
  Item,
  | "id"
  | "name"
  | "productionYear"
  | "communityRating"
  | "genres"
  | "primaryImageTag"
  | "seriesId"
  | "seriesPrimaryImageTag"
> & {
  type: string | null;
  overview?: string | null;
};

function formatItem(
  item: FormattableItem,
  stats?: { playCount?: number; playDuration?: number },
) {
  const base = {
    id: item.id,
    name: item.name,
    type: item.type,
    year: item.productionYear,
    rating: item.communityRating,
    genres: item.genres,
    overview: item.overview?.slice(0, 200),
    primaryImageTag: item.primaryImageTag,
    seriesId: item.seriesId,
    seriesPrimaryImageTag: item.seriesPrimaryImageTag,
  };
  if (stats) {
    return {
      ...base,
      playCount: stats.playCount,
      watchTime: stats.playDuration
        ? formatDuration(stats.playDuration)
        : undefined,
    };
  }
  return base;
}

/** Series, season and episode for an episode, so results name the show. */
function episodeOf(
  item: Pick<Item, "type" | "seriesName" | "parentIndexNumber" | "indexNumber">,
) {
  if (item.type !== "Episode") return {};
  const pad = (n: number | null) => String(n ?? 0).padStart(2, "0");
  return {
    series: item.seriesName,
    episode: `S${pad(item.parentIndexNumber)}E${pad(item.indexNumber)}`,
  };
}

function getHolidayHintScore(item: Item): number {
  const haystack = `${item.name ?? ""}\n${item.overview ?? ""}`.toLowerCase();
  const keywords = [
    "christmas",
    "xmas",
    "holiday",
    "santa",
    "reindeer",
    "elf",
    "grinch",
    "nativity",
    "yuletide",
    "snowman",
    "mistletoe",
  ];
  const keywordHits = keywords.reduce(
    (sum, k) => sum + (haystack.includes(k) ? 1 : 0),
    0,
  );

  const genreHits = Array.isArray(item?.genres)
    ? item.genres.reduce(
        (sum: number, g: string) =>
          sum +
          (typeof g === "string" &&
          ["holiday", "christmas"].includes(g.toLowerCase())
            ? 1
            : 0),
        0,
      )
    : 0;

  return keywordHits + genreHits * 2;
}

/** Most titles one ranked search returns. */
const MAX_TITLES = 50;
const titleLimit = (fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(MAX_TITLES)
    .optional()
    .default(fallback)
    .describe(
      `Number of titles, up to ${MAX_TITLES}: ask for more when the user wants any or every title about something`,
    );

const limitSchema = z.object({
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("Number of items to return"),
});

const limitTypeSchema = z.object({
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("Number of items to return"),
  type: z
    .enum(["Movie", "Series", "all"])
    .optional()
    .default("all")
    .describe("Filter by item type"),
});

export function createChatTools(
  serverId: number,
  userId: string,
  isAdmin: boolean = false,
) {
  return {
    getUserMostWatchedMovies: tool({
      description:
        "Get the user's most watched movies ordered by total watch time",
      inputSchema: limitSchema,
      execute: async ({ limit }: z.infer<typeof limitSchema>) => {
        const result = await getMostWatchedItems({ serverId, userId });
        const movies = result.Movie.slice(0, limit);
        return {
          movies: movies.map((m) =>
            formatItem(m, {
              playCount: m.totalPlayCount,
              playDuration: m.totalPlayDuration,
            }),
          ),
          message:
            movies.length > 0
              ? `Found ${movies.length} most watched movies`
              : "No movies watched yet",
        };
      },
    }),

    getUserMostWatchedSeries: tool({
      description:
        "Get the user's most watched TV series ordered by total watch time",
      inputSchema: limitSchema,
      execute: async ({ limit }: z.infer<typeof limitSchema>) => {
        const result = await getMostWatchedItems({ serverId, userId });
        const series = result.Series.slice(0, limit);
        return {
          series: series.map((s) =>
            formatItem(s, {
              playCount: s.totalPlayCount,
              playDuration: s.totalPlayDuration,
            }),
          ),
          message:
            series.length > 0
              ? `Found ${series.length} most watched series`
              : "No series watched yet",
        };
      },
    }),

    getPersonalizedRecommendations: tool({
      description:
        "Get personalized movie and series recommendations from the library, seeded by what the user rated highly (4+ stars, likes, favorites) and their watch history, using AI embeddings. Only returns items the user has not watched or rated. Each recommendation includes a 'reason' field and a 'basedOn' array with the rated or watched items that led to it. Always use this data when presenting recommendations to explain what they're based on.",
      inputSchema: limitTypeSchema,
      execute: async ({ limit, type }: z.infer<typeof limitTypeSchema>) => {
        const [movieRecs, seriesRecs] = await Promise.all([
          type === "Series"
            ? Promise.resolve([])
            : getSimilarStatistics({ serverId, userId, limit: limit * 2 }),
          type === "Movie"
            ? Promise.resolve([])
            : getSimilarSeries({ serverId, userId, limit: limit * 2 }),
        ]);

        const filtered = alternate<
          (typeof movieRecs)[number] | (typeof seriesRecs)[number]
        >(movieRecs, seriesRecs);

        const enrichedRecs = filtered.slice(0, limit).map((r) => {
          const recGenres = new Set(r.item.genres || []);
          const basedOnItems = r.basedOn.slice(0, 3);

          const sharedGenres = basedOnItems.flatMap((b) =>
            (b.genres || []).filter((g) => recGenres.has(g)),
          );
          const uniqueSharedGenres = [...new Set(sharedGenres)];

          let reason = "";
          const themes = r.matchedThemes ?? [];
          if (themes.length > 0) {
            reason = `Matches the user's stated interest in ${themes
              .slice(0, 3)
              .join(", ")}`;
          } else if (basedOnItems.length > 0) {
            const baseNames = basedOnItems.map((b) => b.name);
            if (basedOnItems.length === 1) {
              reason = `Similar to "${baseNames[0]}"`;
            } else {
              reason = `Similar to "${baseNames
                .slice(0, -1)
                .join('", "')}" and "${baseNames[baseNames.length - 1]}"`;
            }
            if (uniqueSharedGenres.length > 0) {
              reason += ` (shared: ${uniqueSharedGenres
                .slice(0, 3)
                .join(", ")})`;
            }
          } else {
            reason = "Popular on this server";
          }

          return {
            ...formatItem(r.item),
            similarityPercent: Math.round(r.similarity * 100),
            reason,
            basedOn: basedOnItems.map((b) => ({
              name: b.name,
              type: b.type,
              genres: b.genres?.slice(0, 3),
            })),
            sharedGenres: uniqueSharedGenres.slice(0, 5),
          };
        });

        return {
          recommendations: enrichedRecs,
          message:
            enrichedRecs.length > 0
              ? `Found ${enrichedRecs.length} personalized recommendations with reasoning`
              : "Unable to generate recommendations. Make sure embeddings are configured and you have watch history or ratings.",
        };
      },
    }),

    getRatedItems: tool({
      description:
        "Get the movies, series and individual episodes the user has explicitly rated (Jellyfin Enhanced star reviews on a 0-5 scale, plus Jellyfin likes, dislikes and favorites), with each item's overview. Ratings are the strongest signal of taste: a highly rated episode shows which themes the user enjoys, even when the series as a whole is not a favorite. Use this to understand what the user likes before searching the library (e.g. with searchLibraryBySemanticQuery or getSimilarToItem) for things they have not seen.",
      inputSchema: z.object({
        minRating: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .default(4)
          .describe("Lowest rating to include (0-5 stars)"),
        maxRating: z
          .number()
          .min(0)
          .max(5)
          .optional()
          .default(5)
          .describe("Highest rating to include (0-5 stars)"),
        type: z
          .enum(["Movie", "Series", "Episode", "all"])
          .optional()
          .default("all")
          .describe("Filter by item type"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .optional()
          .default(25)
          .describe("Number of items to return, highest rated first"),
      }),
      execute: async ({ minRating, maxRating, type, limit }) => {
        const rated = await getRatedItems({
          serverId,
          userId,
          minRating,
          maxRating,
          type: type === "all" ? null : type,
          limit,
        });
        return {
          items: rated.map((r) => ({
            ...formatItem({ ...r.item, overview: r.item.overview }),
            overview: r.item.overview?.slice(0, 300),
            seriesName: r.item.seriesName,
            season: r.item.parentIndexNumber,
            episode: r.item.indexNumber,
            userRating: r.rating,
            userReview: r.review?.slice(0, 300) ?? undefined,
          })),
          message:
            rated.length > 0
              ? `Found ${rated.length} rated items`
              : "No rated items found in that range",
        };
      },
    }),

    getRecentlyAddedItems: tool({
      description: "Get recently added movies and series to the library",
      inputSchema: z.object({
        limit: z
          .number()
          .optional()
          .default(20)
          .describe("Number of items to return"),
        type: z
          .enum(["Movie", "Series", "all"])
          .optional()
          .default("all")
          .describe("Filter by item type"),
      }),
      execute: async ({
        limit,
        type,
      }: {
        limit: number;
        type: "Movie" | "Series" | "all";
      }) => {
        const conditions = [
          eq(items.serverId, serverId),
          isNotNull(items.dateCreated),
        ];
        if (type !== "all") {
          conditions.push(eq(items.type, type));
        } else {
          conditions.push(inArray(items.type, ["Movie", "Series"]));
        }

        const recentItems = await db
          .select()
          .from(items)
          .where(and(...conditions))
          .orderBy(desc(items.dateCreated))
          .limit(limit);

        return {
          items: recentItems.map((item) => ({
            ...formatItem(item),
            addedDate: item.dateCreated?.toISOString().split("T")[0],
          })),
          message: `Found ${recentItems.length} recently added ${
            type === "all" ? "items" : `${type.toLowerCase()}s`
          }`,
        };
      },
    }),

    searchItems: tool({
      description: "Search for movies and series by name or genre",
      inputSchema: z.object({
        query: z.string().describe("Search query for item name"),
        type: z
          .enum(["Movie", "Series", "all"])
          .optional()
          .default("all")
          .describe("Filter by type"),
        limit: z.number().optional().default(20).describe("Number of results"),
      }),
      execute: async ({
        query,
        type,
        limit,
      }: {
        query: string;
        type: "Movie" | "Series" | "all";
        limit: number;
      }) => {
        const conditions = [
          eq(items.serverId, serverId),
          ilike(items.name, `%${query}%`),
        ];
        if (type !== "all") {
          conditions.push(eq(items.type, type));
        } else {
          conditions.push(inArray(items.type, ["Movie", "Series"]));
        }

        const results = await db
          .select()
          .from(items)
          .where(and(...conditions))
          .orderBy(desc(items.communityRating))
          .limit(limit);

        return {
          items: results.map((item) => formatItem(item)),
          message:
            results.length > 0
              ? `Found ${results.length} items matching "${query}"`
              : `No items found matching "${query}"`,
        };
      },
    }),

    findItemsByPerson: tool({
      description:
        "Find movies or TV series connected to one or more people, such as actors, directors, writers, or producers. Every requested person must be connected to each returned item. Use this for questions like 'movies with Ana de Armas', 'movies with Ana de Armas and Chris Evans', 'what is Pedro Pascal in?', or 'films directed by Christopher Nolan'. Actor credits are searched by default.",
      inputSchema: z.object({
        personNames: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe(
            "Names or partial names of the people to search for. Returned items must match every person.",
          ),
        creditType: z
          .enum(["Actor", "Director", "Writer", "Producer", "all"])
          .optional()
          .default("Actor")
          .describe(
            "Credit type to search. Use Actor for starring/with questions, a specific crew type when requested, or all for any connection.",
          ),
        type: z
          .enum(["Movie", "Series", "all"])
          .optional()
          .default("all")
          .describe("Filter by media type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(20)
          .describe("Number of items to return"),
      }),
      execute: async ({ personNames, creditType, type, limit }) => {
        const results = await findItemsByPerson({
          serverId,
          personNames,
          creditType,
          type,
          limit,
        });

        return {
          items: results.map(({ item, credits }) => ({
            ...formatItem(item),
            matchedCredits: credits,
          })),
          personNames,
          message:
            results.length > 0
              ? `Found ${results.length} items connected to ${personNames.join(
                  " and ",
                )}`
              : `No items found connected to ${personNames.join(" and ")}`,
        };
      },
    }),

    findItemsByCharacter: tool({
      description:
        "Find the movie or TV series a fictional character appears in. Use this for questions like 'which TV show is Walter White from?', 'what movie has Tony Stark?', or 'where does Eleven appear?'. Returns the matching character roles and the actors who played them.",
      inputSchema: z.object({
        characterName: z
          .string()
          .describe("Name or partial name of the character to search for"),
        type: z
          .enum(["Movie", "Series", "all"])
          .optional()
          .default("all")
          .describe("Filter by media type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(20)
          .describe("Number of items to return"),
      }),
      execute: async ({ characterName, type, limit }) => {
        const results = await findItemsByCharacter({
          serverId,
          characterName,
          type,
          limit,
        });

        return {
          items: results.map(({ item, credits }) => ({
            ...formatItem(item),
            matchedCredits: credits,
          })),
          characterName,
          message:
            results.length > 0
              ? `Found ${results.length} items featuring character "${characterName}"`
              : `No items found featuring character "${characterName}"`,
        };
      },
    }),

    getUserWatchStatistics: tool({
      description:
        "Get overall watch statistics for the user including total watch time and streaks",
      inputSchema: z.object({}),
      execute: async () => {
        const stats = await getUserWatchStats({ serverId, userId });
        return {
          totalWatchTime: formatDuration(stats.total_watch_time),
          totalWatchTimeSeconds: stats.total_watch_time,
          totalPlays: stats.total_plays,
          longestStreak: stats.longest_streak,
          message: `User has watched ${formatDuration(
            stats.total_watch_time,
          )} total with ${stats.total_plays} plays`,
        };
      },
    }),

    getWatchtimeByInterval: tool({
      description:
        "Get watchtime statistics for users within a specific date range. Can filter by user and item type. Returns results sorted by watchtime (highest first). ALWAYS use this tool when asked about watchtime for a specific time period (yesterday, last week, this month, etc.) or when asked 'who watched the most' for any time period. Examples: 'who watched the most yesterday?', 'how much did user X watch last week?', 'who watched the most movies this month?'",
      inputSchema: z.object({
        startDate: z.string().describe("Start date in ISO format (YYYY-MM-DD)"),
        endDate: z.string().describe("End date in ISO format (YYYY-MM-DD)"),
        userId: z
          .string()
          .optional()
          .describe(
            "Optional user ID to filter by specific user. If not provided, returns data for all users.",
          ),
        itemType: z
          .enum(["Movie", "Series", "Episode", "all"])
          .optional()
          .default("all")
          .describe("Filter by item type. Defaults to 'all'."),
      }),
      execute: async ({
        startDate,
        endDate,
        userId: inputUserId,
        itemType,
      }) => {
        const effectiveUserId = isAdmin ? inputUserId : userId;
        const results = await getUserStatsSummaryForServer({
          serverId,
          startDate,
          endDate,
          userId: effectiveUserId,
          itemType: itemType || "all",
        });

        return {
          users: results.map((user) => ({
            userId: user.userId,
            userName: user.userName,
            watchTime: formatDuration(user.totalWatchTime),
            watchTimeSeconds: user.totalWatchTime,
            playCount: user.sessionCount,
          })),
          message:
            results.length > 0
              ? `Found ${results.length} user${
                  results.length === 1 ? "" : "s"
                } with watchtime data`
              : "No watchtime data found for the specified criteria",
        };
      },
    }),

    getHistoryByFilters: tool({
      description:
        "Get playback history with filters for user, item type, and time interval. Use this to see what specific items were watched during a time period. Can be combined with getUserWatchStatistics to get detailed viewing information.",
      inputSchema: z.object({
        userId: z
          .string()
          .optional()
          .describe(
            "Optional user ID to filter by specific user. If not provided, returns history for all users.",
          ),
        itemType: z
          .enum(["Movie", "Series", "Episode", "all"])
          .optional()
          .default("all")
          .describe("Filter by item type. Defaults to 'all'."),
        startDate: z
          .string()
          .optional()
          .describe("Start date in ISO format (YYYY-MM-DD). Optional."),
        endDate: z
          .string()
          .optional()
          .describe("End date in ISO format (YYYY-MM-DD). Optional."),
        limit: z
          .number()
          .optional()
          .default(50)
          .describe(
            "Maximum number of history items to return. Defaults to 50.",
          ),
      }),
      execute: async ({
        userId: inputUserId,
        itemType,
        startDate,
        endDate,
        limit,
      }) => {
        const effectiveUserId = isAdmin ? inputUserId : userId;
        const history = await getHistoryByFilters({
          serverId,
          userId: effectiveUserId,
          itemType: itemType || "all",
          startDate,
          endDate,
          limit: limit || 50,
        });

        return {
          history: history.map((item) => {
            const seriesId =
              item.item?.seriesId || item.session.seriesId || null;
            const seriesName =
              item.item?.seriesName || item.session.seriesName || null;
            const seasonId =
              item.item?.seasonId || item.session.seasonId || null;
            const seasonName = item.item?.seasonName || null;
            const episodeNumber = item.item?.indexNumber || null;
            const seasonNumber = item.item?.parentIndexNumber || null;

            return {
              itemName: item.item?.name || item.session.itemName || "Unknown",
              itemId: item.item?.id || item.session.itemId,
              itemType: item.item?.type || "Unknown",
              userName: item.user?.name || item.session.userName || "Unknown",
              userId: item.user?.id || item.session.userId,
              watchDate: item.session.startTime
                ? item.session.startTime.toISOString()
                : null,
              watchDuration: item.session.playDuration || 0,
              watchDurationFormatted: formatDuration(
                item.session.playDuration || 0,
              ),
              completionPercentage: item.session.percentComplete || 0,
              deviceName: item.session.deviceName,
              clientName: item.session.clientName,
              seriesId,
              seriesName,
              seasonId,
              seasonName,
              episodeNumber,
              seasonNumber,
              ...(seriesName && {
                displayName: `${seriesName}${
                  seasonNumber && episodeNumber
                    ? ` - S${seasonNumber}E${episodeNumber}`
                    : seasonNumber
                      ? ` - Season ${seasonNumber}`
                      : ""
                } - ${item.item?.name || item.session.itemName || "Unknown"}`,
              }),
            };
          }),
          message:
            history.length > 0
              ? `Found ${history.length} history item${
                  history.length === 1 ? "" : "s"
                }`
              : "No history found for the specified criteria",
        };
      },
    }),

    getAvailableUsers: tool({
      description:
        "Get list of all users on this server (for finding users to get shared recommendations with)",
      inputSchema: z.object({}),
      execute: async () => {
        const allUsers = await getUsers({ serverId });
        const visibleUsers = isAdmin
          ? allUsers.filter((u) => !u.isHidden && !u.isDisabled)
          : allUsers.filter(
              (u) => u.id === userId && !u.isHidden && !u.isDisabled,
            );
        return {
          users: visibleUsers.map((u) => ({ id: u.id, name: u.name })),
          message: `Found ${visibleUsers.length} user${
            visibleUsers.length === 1 ? "" : "s"
          }`,
        };
      },
    }),

    getSharedRecommendations: tool({
      description:
        "Get movie/series recommendations that both the current user and another user would enjoy based on their overlapping watch history",
      inputSchema: z.object({
        otherUserName: z
          .string()
          .describe(
            "Name of the other user to find shared recommendations with",
          ),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Number of recommendations"),
      }),
      execute: async ({
        otherUserName,
        limit,
      }: {
        otherUserName: string;
        limit: number;
      }) => {
        const otherUser = await db.query.users.findFirst({
          where: and(
            eq(users.serverId, serverId),
            ilike(users.name, `%${otherUserName}%`),
          ),
        });

        if (!otherUser) {
          return {
            recommendations: [],
            message: `Could not find user "${otherUserName}"`,
          };
        }

        const [currentUserRecs, otherUserRecs] = await Promise.all([
          getSimilarStatistics({ serverId, userId, limit: 50 }),
          getSimilarStatistics({
            serverId,
            userId: otherUser.id,
            limit: 50,
          }),
        ]);

        const currentUserRecIds = new Set(
          currentUserRecs.map((r) => r.item.id),
        );
        const sharedRecs = otherUserRecs
          .filter((r) => currentUserRecIds.has(r.item.id))
          .slice(0, limit);

        if (sharedRecs.length < limit) {
          const currentUserWatched = await db
            .select({ itemId: sessions.itemId })
            .from(sessions)
            .where(
              and(eq(sessions.serverId, serverId), eq(sessions.userId, userId)),
            )
            .groupBy(sessions.itemId);

          const otherUserWatched = await db
            .select({ itemId: sessions.itemId })
            .from(sessions)
            .where(
              and(
                eq(sessions.serverId, serverId),
                eq(sessions.userId, otherUser.id),
              ),
            )
            .groupBy(sessions.itemId);

          const currentWatchedIds = new Set(
            currentUserWatched.map((w) => w.itemId),
          );
          const bothWatched = otherUserWatched
            .filter((w) => w.itemId && currentWatchedIds.has(w.itemId))
            .map((w) => w.itemId)
            .filter(Boolean) as string[];

          if (bothWatched.length > 0) {
            const sharedGenres = await db
              .select({ genres: items.genres })
              .from(items)
              .where(inArray(items.id, bothWatched.slice(0, 20)));

            const genreCounts = new Map<string, number>();
            for (const item of sharedGenres) {
              if (item.genres) {
                for (const genre of item.genres) {
                  genreCounts.set(genre, (genreCounts.get(genre) || 0) + 1);
                }
              }
            }

            const topGenres = [...genreCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([genre]) => genre);

            if (topGenres.length > 0) {
              const existingIds = new Set([
                ...sharedRecs.map((r) => r.item.id),
                ...bothWatched,
              ]);

              const genreRecs = await db
                .select()
                .from(items)
                .where(
                  and(
                    eq(items.serverId, serverId),
                    inArray(items.type, ["Movie", "Series"]),
                    sql`${items.genres} && ARRAY[${sql.join(
                      topGenres.map((g) => sql`${g}`),
                      sql`, `,
                    )}]::text[]`,
                  ),
                )
                .orderBy(desc(items.communityRating))
                .limit(limit - sharedRecs.length + 10);

              const additionalRecs = genreRecs
                .filter((item) => !existingIds.has(item.id))
                .slice(0, limit - sharedRecs.length);

              return {
                recommendations: [
                  ...sharedRecs.map((r) => ({
                    ...formatItem(r.item),
                    sharedMatch: true,
                  })),
                  ...additionalRecs.map((item) => ({
                    ...formatItem(item),
                    sharedMatch: false,
                    basedOnSharedGenres: topGenres,
                  })),
                ],
                otherUser: otherUser.name,
                sharedGenres: topGenres,
                message: `Found recommendations for you and ${otherUser.name}`,
              };
            }
          }
        }

        return {
          recommendations: sharedRecs.map((r) => ({
            ...formatItem(r.item),
            similarity: Math.round(r.similarity * 100),
          })),
          otherUser: otherUser.name,
          message:
            sharedRecs.length > 0
              ? `Found ${sharedRecs.length} shared recommendations for you and ${otherUser.name}`
              : "No strong shared recommendations found. Try watching more content together!",
        };
      },
    }),

    getLibraries: tool({
      description: "Get list of media libraries on the server",
      inputSchema: z.object({}),
      execute: async () => {
        const libs = await db
          .select()
          .from(libraries)
          .where(eq(libraries.serverId, serverId));

        return {
          libraries: libs.map((l) => ({
            id: l.id,
            name: l.name,
            type: l.type,
          })),
          message: `Found ${libs.length} libraries`,
        };
      },
    }),

    getSimilarToItem: tool({
      description:
        "Get items similar to a specific movie or series. Returns a 'sourceItem' showing what the search was based on, and similar items with a 'reason' field explaining the connection. Use when user asks 'what should I watch after X' or 'find movies like X'. Always mention the sourceItem when presenting results.",
      inputSchema: z.object({
        itemName: z
          .string()
          .describe("Name of the movie or series to find similar items for"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Number of similar items to return"),
      }),
      execute: async ({
        itemName,
        limit,
      }: {
        itemName: string;
        limit: number;
      }) => {
        const foundItems = await db
          .select()
          .from(items)
          .where(
            and(
              eq(items.serverId, serverId),
              ilike(items.name, `%${itemName}%`),
              inArray(items.type, ["Movie", "Series"]),
            ),
          )
          .orderBy(desc(items.communityRating))
          .limit(1);

        if (foundItems.length === 0) {
          return {
            similar: [],
            message: `Could not find "${itemName}" in the library`,
          };
        }

        const sourceItem = foundItems[0];
        const similarItems = await getSimilarItemsForItem(
          serverId,
          sourceItem.id,
          limit,
        );

        const enrichedSimilar = similarItems.map((r) => {
          const sourceGenres = new Set(sourceItem.genres || []);
          const recGenres = r.item.genres || [];
          const sharedGenres = recGenres.filter((g) => sourceGenres.has(g));

          let reason = `Similar to "${sourceItem.name}"`;
          if (sharedGenres.length > 0) {
            reason += ` - both are ${sharedGenres.slice(0, 3).join(", ")} ${
              r.item.type === "Movie" ? "movies" : "series"
            }`;
          }
          if (sourceItem.productionYear && r.item.productionYear) {
            const yearDiff = Math.abs(
              sourceItem.productionYear - r.item.productionYear,
            );
            if (yearDiff <= 5) {
              reason += `, from the same era (${r.item.productionYear})`;
            }
          }

          return {
            ...formatItem(r.item),
            similarityPercent: Math.round(r.similarity * 100),
            reason,
            sharedGenres,
          };
        });

        return {
          sourceItem: formatItem(sourceItem),
          similar: enrichedSimilar,
          message:
            enrichedSimilar.length > 0
              ? `Found ${enrichedSimilar.length} items similar to "${sourceItem.name}"`
              : `No similar items found for "${sourceItem.name}". Embeddings may not be configured.`,
        };
      },
    }),

    getItemsByGenre: tool({
      description: "Get movies or series filtered by genre",
      inputSchema: z.object({
        genre: z
          .string()
          .describe("Genre to filter by (e.g., 'Action', 'Comedy', 'Drama')"),
        type: z.enum(["Movie", "Series", "all"]).optional().default("all"),
        limit: z.number().optional().default(20),
      }),
      execute: async ({
        genre,
        type,
        limit,
      }: {
        genre: string;
        type: "Movie" | "Series" | "all";
        limit: number;
      }) => {
        const conditions = [
          eq(items.serverId, serverId),
          sql`${genre} = ANY(${items.genres})`,
        ];
        if (type !== "all") {
          conditions.push(eq(items.type, type));
        } else {
          conditions.push(inArray(items.type, ["Movie", "Series"]));
        }

        const results = await db
          .select()
          .from(items)
          .where(and(...conditions))
          .orderBy(desc(items.communityRating))
          .limit(limit);

        return {
          items: results.map((item) => formatItem(item)),
          genre,
          message:
            results.length > 0
              ? `Found ${results.length} ${
                  type === "all" ? "items" : `${type.toLowerCase()}s`
                } in ${genre}`
              : `No items found in genre "${genre}"`,
        };
      },
    }),

    getTopRatedItems: tool({
      description: "Get top rated movies or series by community rating",
      inputSchema: z.object({
        type: z.enum(["Movie", "Series", "all"]).optional().default("all"),
        limit: z.number().optional().default(20),
        minRating: z
          .number()
          .optional()
          .default(7)
          .describe("Minimum rating (0-10)"),
      }),
      execute: async ({
        type,
        limit,
        minRating,
      }: {
        type: "Movie" | "Series" | "all";
        limit: number;
        minRating: number;
      }) => {
        const conditions = [
          eq(items.serverId, serverId),
          isNotNull(items.communityRating),
          sql`${items.communityRating} >= ${minRating}`,
        ];
        if (type !== "all") {
          conditions.push(eq(items.type, type));
        } else {
          conditions.push(inArray(items.type, ["Movie", "Series"]));
        }

        const results = await db
          .select()
          .from(items)
          .where(and(...conditions))
          .orderBy(desc(items.communityRating))
          .limit(limit);

        return {
          items: results.map((item) => formatItem(item)),
          message: `Found ${results.length} top-rated items (${minRating}+ rating)`,
        };
      },
    }),

    searchLibraryBySemanticQuery: tool({
      description:
        "Semantic search across the user's library using embeddings. Use this for theme-based queries like 'Christmas movie I have', 'cozy winter movie', or 'something like a heist thriller'. To identify a title from what happens in it, use findTitleByPlot instead. Use type 'all' when it is unclear whether it was a movie, a series or a single episode, or when the user wants any or every title about a theme (with a higher limit). Returns items from the library ranked by semantic similarity.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("What the user is looking for (theme/query)"),
        type: z
          .enum(["Movie", "Series", "Episode", "all"])
          .optional()
          .default("Movie")
          .describe("Filter by item type ('all' includes episodes)"),
        limit: titleLimit(10),
      }),
      execute: async ({
        query,
        type,
        limit,
      }: {
        query: string;
        type: "Movie" | "Series" | "Episode" | "all";
        limit: number;
      }) => {
        const embed = await embedTextForServer({
          serverId,
          text: query,
        });

        // Fallback: embeddings not configured, do a best-effort keyword/genre search.
        if (!embed.ok) {
          const lowered = query.toLowerCase();
          const isHolidayQuery =
            lowered.includes("christmas") ||
            lowered.includes("xmas") ||
            lowered.includes("holiday");

          const conditions = [eq(items.serverId, serverId)];
          if (type !== "all") {
            conditions.push(eq(items.type, type));
          } else {
            conditions.push(inArray(items.type, ["Movie", "Series"]));
          }

          if (isHolidayQuery) {
            conditions.push(
              sql`(${items.name} ILIKE '%christmas%' OR ${items.overview} ILIKE '%christmas%' OR ${items.name} ILIKE '%holiday%' OR ${items.overview} ILIKE '%holiday%' OR ${items.name} ILIKE '%xmas%' OR ${items.overview} ILIKE '%xmas%' OR ${items.genres} && ARRAY['Holiday','Christmas']::text[])`,
            );
          } else {
            conditions.push(
              sql`(${items.name} ILIKE ${`%${query}%`} OR ${
                items.overview
              } ILIKE ${`%${query}%`})`,
            );
          }

          const results = await db
            .select()
            .from(items)
            .where(and(...conditions))
            .orderBy(desc(items.communityRating))
            .limit(limit);

          return {
            items: results.map((item) => ({
              ...formatItem(item),
              reason: `Matched text/metadata for "${query}"`,
            })),
            message:
              results.length > 0
                ? `Found ${results.length} items matching "${query}" (fallback search)`
                : `No items found matching "${query}". ${
                    embed.reason === "not_configured" ? embed.error : ""
                  }`.trim(),
            usedEmbeddings: false,
          };
        }

        const { distance, dimensionFilter } = getItemEmbeddingComparison(
          embed.embedding,
        );
        const similarity = sql<number>`1 - (${distance})`;

        const conditions = [
          eq(items.serverId, serverId),
          isNull(items.deletedAt),
          isNotNull(items.embedding),
          dimensionFilter,
        ];
        if (type !== "all") {
          conditions.push(eq(items.type, type));
        } else {
          conditions.push(inArray(items.type, ["Movie", "Series", "Episode"]));
        }

        const candidates = await db
          .select({
            item: items,
            similarity,
          })
          .from(items)
          .where(and(...conditions))
          .orderBy(asc(distance), desc(items.communityRating))
          .limit(Math.max(limit * 12, 50));

        const ranked = candidates
          .map((c) => {
            const sim = Number(c.similarity);
            const hint = getHolidayHintScore(c.item);
            const bonus = Math.min(0.12, hint * 0.02);
            return {
              ...c,
              similarity: sim,
              holidayHintScore: hint,
              finalScore: sim + bonus,
            };
          })
          .sort((a, b) => b.finalScore - a.finalScore)
          .slice(0, limit);

        return {
          items: ranked.map((r) => ({
            ...formatItem(r.item),
            ...episodeOf(r.item),
            similarityPercent: Math.round(r.similarity * 100),
            reason: `Semantic match for "${query}"`,
          })),
          message:
            ranked.length > 0
              ? `Found ${ranked.length} semantically similar items for "${query}"`
              : `No items found for "${query}" (embeddings search)`,
          usedEmbeddings: true,
        };
      },
    }),

    findTitleByPlot: tool({
      description:
        "Find a movie, series or episode in the library from a description of what happens in it: a scene, a twist, a character's fate, how it ends, or a half-remembered line. It searches the plot synopses (whole and paragraph by paragraph) and the dialogue as well as the overviews, so it finds titles from details their official description leaves out. Describe the events in plain words, as the user remembers them. Use type 'all' unless the user is sure whether it was a movie or an episode. Returns titles best first; for any or every title about a topic, raise the limit.",
      inputSchema: z.object({
        description: z.string().describe("What happens, in the user's words"),
        type: z
          .enum(["Movie", "Series", "Episode", "all"])
          .optional()
          .default("all")
          .describe("Filter by item type"),
        limit: titleLimit(8),
      }),
      execute: async ({
        description,
        type,
        limit,
      }: {
        description: string;
        type: "Movie" | "Series" | "Episode" | "all";
        limit: number;
      }) => {
        const embed = await embedTextForServer({ serverId, text: description });
        if (!embed.ok) return { items: [], message: embed.error };
        const found = await searchByPlot({
          serverId,
          viewerUserId: userId,
          query: description,
          embedding: embed.embedding,
          types: type === "all" ? ["Movie", "Series", "Episode"] : [type],
          limit,
        });
        const matched = await getMatchedItems(found.map((r) => r.id));
        return {
          items: matched.map((item) => ({
            ...formatItem(item),
            ...episodeOf(item),
          })),
          message:
            matched.length > 0
              ? `Found ${matched.length} titles whose story matches "${description}", best first. Confirm the best one with its overview, or with getPlotSynopsis when the detail is not in the overview.`
              : `No title in the library matches "${description}".`,
        };
      },
    }),

    findMoment: tool({
      description:
        "Find when something is said or happens in a movie, series or episode the user names, e.g. 'when does Neo meet the Architect in The Matrix Reloaded' or 'where is the line \"I'll be back\" in The Terminator'. Searches that title's dialogue and its plot notes, scene by scene, and returns timestamps (hh:mm:ss) with the matching line. It works from what is said: a scene nobody talks in is not found.",
      inputSchema: z.object({
        title: z.string().describe("Movie or series name"),
        description: z.string().describe("The line, or what happens"),
        season: z.number().optional().describe("Season number, for a series"),
        episode: z
          .number()
          .optional()
          .describe("Episode number within the season"),
      }),
      execute: async ({
        title,
        description,
        season,
        episode,
      }: {
        title: string;
        description: string;
        season?: number;
        episode?: number;
      }) => {
        const scope = await momentScope({
          serverId,
          userId,
          title,
          season,
          episode,
        });
        if (scope.length === 0) {
          return {
            moments: [],
            message: `Nothing in the library matches "${title}".`,
          };
        }
        const embed = await embedTextForServer({ serverId, text: description });
        const moments = await findMoments({
          serverId,
          itemIds: scope.map((s) => s.id),
          query: description,
          embedding: embed.ok ? embed.embedding : null,
          limit: 3,
        });
        const titles = await getMatchedItems([
          ...new Set(moments.map((m) => m.itemId)),
        ]);
        const byId = new Map(titles.map((item) => [item.id, item]));
        return {
          moments: moments.flatMap((m) => {
            const item = byId.get(m.itemId);
            return item
              ? [
                  {
                    ...formatItem(item),
                    ...episodeOf(item),
                    at: formatTimestamp(m.startMs),
                    precision: m.precision,
                    line: m.line,
                  },
                ]
              : [];
          }),
          message:
            moments.length > 0
              ? "Times are when the matching dialogue is said, best first. Precision 'window' means only the stretch (two minutes of dialogue, or a scene of a few minutes) is known."
              : `No dialogue in "${title}" matches "${description}". Only titles with a transcript can be searched this way.`,
        };
      },
    }),

    getPlotSynopsis: tool({
      description:
        "Get the full plot synopsis (spoilers included) of a movie, or of one episode of a series in the library. For a series, it defaults to the series' last episode; pass season to get that season's last episode, or season and episode for a specific one, or position 'first'. Use it to answer how something ends, whether a series or season ends on a cliffhanger, or to recap an episode before the user resumes a show. Only reveal endings when the user asked about them.",
      inputSchema: z.object({
        title: z.string().describe("Movie or series name"),
        season: z.number().optional().describe("Season number"),
        episode: z
          .number()
          .optional()
          .describe("Episode number within the season"),
        position: z
          .enum(["first", "last"])
          .optional()
          .default("last")
          .describe("Which episode when no episode number is given"),
      }),
      execute: async ({
        title,
        season,
        episode,
        position,
      }: {
        title: string;
        season?: number;
        episode?: number;
        position: "first" | "last";
      }) => {
        const found = await lookupSynopsis({
          serverId,
          userId,
          title,
          season,
          episode,
          position,
        });
        if (!found) {
          return {
            message: `Nothing in the library matches "${title}"${season ? ` season ${season}` : ""}${episode ? ` episode ${episode}` : ""}.`,
          };
        }
        const notes = [
          found.synopsis
            ? "Synopsis written by a model from the subtitles; it may simplify or get minor details wrong."
            : "No synopsis has been indexed for this item yet (it needs a full subtitle).",
          found.wikipediaPlot
            ? "wikipediaPlot is the plot from Wikipedia, written by people who watched it: prefer it where the two differ, and link wikipediaSource when quoting it."
            : null,
          !found.synopsis && !found.wikipediaPlot
            ? "Only the spoiler-free overview is available."
            : null,
        ];
        return { ...found, message: notes.filter(Boolean).join(" ") };
      },
    }),

    searchTranscripts: tool({
      description:
        "Search the dialogue of every movie and episode in the library (indexed from their subtitles). Use it to find which title has a remembered line or quote, or a scene the user half-remembers (what was said, names mentioned, a situation). Put exact remembered wording in double quotes for a phrase match. Returns the best matching titles with their moments: 'at' is when the matching line is said, 'line' the line, and 'dialogue' the two minutes of dialogue around it. Subtitles carry no speaker names or setting, so the dialogue alone does not say who speaks a line, to whom, or where. To list every title that mentions something, use findTitlesMentioning.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("Remembered line, quote or description of the scene"),
        limit: titleLimit(8),
      }),
      execute: async ({ query, limit }: { query: string; limit: number }) => {
        const embed = await embedTextForServer({ serverId, text: query });
        const matches = await searchTranscripts({
          serverId,
          userId,
          query,
          embedding: embed.ok ? embed.embedding : null,
          limit,
        });
        const matched = await getMatchedItems(matches.map((m) => m.itemId));
        // Each window pinned to its matching line, so 'at' is when it is said.
        const moments = new Map(
          await Promise.all(
            matches.map(
              async (m) =>
                [
                  m.itemId,
                  await Promise.all(
                    m.moments.map(async (w) => {
                      if (w.startMs === null) return { dialogue: w.text };
                      const at = await locateMoment(
                        {
                          itemId: m.itemId,
                          startMs: w.startMs,
                          endMs: w.endMs,
                        },
                        query,
                      );
                      return {
                        at: formatTimestamp(at.startMs),
                        line: at.line ?? undefined,
                        dialogue: w.text,
                      };
                    }),
                  ),
                ] as const,
            ),
          ),
        );
        return {
          items: matched.map((item) => ({
            ...formatItem(item),
            ...episodeOf(item),
            moments: moments.get(item.id) ?? [],
          })),
          message:
            matched.length > 0
              ? `Found ${matched.length} titles whose dialogue matches "${query}"`
              : `No dialogue matches "${query}". Transcripts exist only for titles with a full text subtitle, once the knowledge index has run.`,
        };
      },
    }),

    findTitlesMentioning: tool({
      description:
        "List every movie, series and episode whose dialogue, plot notes, Wikipedia plot, or title and description mention a word, name or phrase, in any word form ('quantum computer' also finds 'quantum computing'). Unlike the ranked searches, nothing that mentions it is left out, so use it whenever the user wants any or every title about a specific topic, term or name; add findTitleByPlot and searchLibraryBySemanticQuery for titles about the theme that never name it. Put a phrase in double quotes to keep its words together, and separate alternatives with OR. Each title says how many passages mention it in each source and shows the best matching line and plot passage: a mention in the plot or description suggests the topic is central, a single line of dialogue a passing one.",
      inputSchema: z.object({
        phrase: z
          .string()
          .describe('Words to find, e.g. "quantum computer" OR qubit'),
        type: z
          .enum(["Movie", "Series", "Episode", "all"])
          .optional()
          .default("all")
          .describe("Filter by item type"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe("Most titles to list, up to 100"),
      }),
      execute: async ({
        phrase,
        type,
        limit,
      }: {
        phrase: string;
        type: "Movie" | "Series" | "Episode" | "all";
        limit: number;
      }) => {
        const { total, titles } = await titlesMentioning({
          serverId,
          userId,
          phrase,
          types: type === "all" ? ["Movie", "Series", "Episode"] : [type],
          limit,
        });
        const matched = await getMatchedItems(titles.map((t) => t.itemId));
        const byId = new Map(titles.map((t) => [t.itemId, t]));
        // Dialogue evidence pinned to its matching line, so 'at' is when it is said.
        await Promise.all(
          titles.flatMap((t) =>
            t.evidence.map(async (e) => {
              if (e.startMs === null || e.endMs === null) return;
              const at = await locateMoment(
                { itemId: t.itemId, startMs: e.startMs, endMs: e.endMs },
                phrase,
              );
              e.startMs = at.startMs;
            }),
          ),
        );
        return {
          items: matched.map((item) => {
            const t = byId.get(item.id);
            return {
              ...formatItem(item),
              ...episodeOf(item),
              mentions: {
                dialogue: t?.dialogue ?? 0,
                plot: t?.plot ?? 0,
                wikipedia: t?.wikipedia ?? 0,
                description: t?.description ?? false,
              },
              evidence: (t?.evidence ?? []).map((e) => ({
                source: e.source,
                at: e.startMs === null ? undefined : formatTimestamp(e.startMs),
                text: e.text,
              })),
            };
          }),
          message:
            total === 0
              ? `Nothing in the library mentions ${phrase}.`
              : total > matched.length
                ? `${total} titles mention ${phrase}; showing the first ${matched.length}. Raise the limit to see the rest.`
                : `${total} titles mention ${phrase}.`,
        };
      },
    }),
  };
}

export type ChatTools = ReturnType<typeof createChatTools>;

import "server-only";

import { items, libraries } from "@streamystats/database";
import { sql } from "drizzle-orm";
import type { SearchResult } from "./search";

/** What an item search result is built from; select it with `itemResultColumns`. */
export type ItemResultRow = {
  id: string;
  name: string;
  type: string;
  series_name: string | null;
  season_name: string | null;
  index_number: number | null;
  parent_index_number: number | null;
  production_year: number | null;
  primary_image_tag: string | null;
  series_primary_image_tag: string | null;
  series_id: string | null;
  library_name: string | null;
};

/** The columns of an `ItemResultRow`; the query must LEFT JOIN libraries. */
export const itemResultColumns = sql`
  ${items.id} as id,
  ${items.name} as name,
  ${items.type} as type,
  ${items.seriesName} as series_name,
  ${items.seasonName} as season_name,
  ${items.indexNumber} as index_number,
  ${items.parentIndexNumber} as parent_index_number,
  ${items.productionYear} as production_year,
  ${items.primaryImageTag} as primary_image_tag,
  ${items.seriesPrimaryImageTag} as series_primary_image_tag,
  ${items.seriesId} as series_id,
  ${libraries.name} as library_name`;

export function toItemResult(item: ItemResultRow, rank: number): SearchResult {
  let subtitle = "";
  if (item.type === "Episode" && item.series_name) {
    subtitle = item.series_name;
    if (item.parent_index_number !== null && item.index_number !== null) {
      subtitle += ` - S${item.parent_index_number}E${item.index_number}`;
    }
  } else if (item.type === "Season" && item.series_name) {
    subtitle = item.series_name;
  } else if (item.production_year) {
    subtitle = String(item.production_year);
  }

  // Use series image for episodes if available
  const imageId =
    item.type === "Episode" && item.series_id ? item.series_id : item.id;
  const imageTag =
    item.type === "Episode" && item.series_primary_image_tag
      ? item.series_primary_image_tag
      : item.primary_image_tag;

  return {
    id: item.id,
    type: "item",
    subtype: item.type,
    title: item.name,
    subtitle,
    imageId,
    imageTag: imageTag ?? undefined,
    href: `/library/${item.id}`,
    metadata: {
      ...(item.library_name ? { libraryName: item.library_name } : {}),
    },
    rank,
  };
}

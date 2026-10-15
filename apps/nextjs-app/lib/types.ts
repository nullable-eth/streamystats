import type { Server as DatabaseServer } from "@streamystats/database";

// Re-export types from database
export type {
  Activity,
  Item,
  Library,
  Server,
  Session,
  User,
} from "@streamystats/database";

export type ServerPublic = Omit<
  DatabaseServer,
  "apiKey" | "embeddingApiKey" | "chatApiKey"
> & {
  hasEmbeddingApiKey: boolean;
  hasChatApiKey: boolean;
};

// Type definitions for library statistics
export interface AggregatedLibraryStatistics {
  movies_count: number;
  episodes_count: number;
  series_count: number;
  libraries_count: number;
  users_count: number;
  total_items: number;
  total_watch_time: number;
  total_play_count: number;
}

// Type definitions for item watch statistics
export interface ItemWatchStats {
  item_id: string;
  item: Item;
  total_watch_time: number;
  watch_count: number;
  unique_viewers: number;
  last_watched?: string | null;
  first_watched?: string | null;
}

export interface ItemWatchStatsResponse {
  data: ItemWatchStats[];
  page: number;
  per_page: number;
  total_pages: number;
  total_items: number;
}

export interface WatchTimePerDay {
  date: string;
  watchTime: number;
  playCount: number;
  watchtime_by_type?: Array<{
    item_type: string;
    total_duration: number;
  }>;
}

export interface UserActivityPerDay {
  date: string;
  activeUsers: number;
  active_users: number;
}

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";

// Route-level tests for /api/search?mode=plot: auth, embedding and the two
// searches are mocked; what is tested is parameter handling and the response.

let embedResult:
  | { ok: true; embedding: number[] }
  | { ok: false; error: string; reason: "not_configured" | "request_failed" };
let plotCalls: { types: string[]; viewerUserId?: string; query: string }[];
let titleCalls: number;

const item = (id: string, subtype: string) => ({
  id,
  type: "item" as const,
  subtype,
  title: id,
  href: `/library/${id}`,
});

// Module mocks are process-wide under `bun test`; keep backup.test.ts's export.
mock.module("@/lib/api-auth", () => ({
  requireAdmin: async () => ({ error: null }),
  requireAuth: async () => ({
    error: null,
    session: { id: "admin-1", name: "Admin", serverId: 1, isAdmin: true },
  }),
}));
mock.module("@/lib/ai/embed-text", () => ({
  embedTextForServer: async () => embedResult,
}));
mock.module("@/lib/db/plot-search", () => ({
  searchByPlot: async (args: {
    types: string[];
    viewerUserId?: string;
    query: string;
  }) => {
    plotCalls.push(args);
    return [
      item("movie-1", "Movie"),
      item("episode-1", "Episode"),
      item("series-1", "Series"),
    ].filter((i) => args.types.includes(i.subtype));
  },
}));
mock.module("@/lib/db/search", () => ({
  globalSearch: async () => {
    titleCalls++;
    return {
      items: [item("title-1", "Movie")],
      users: [],
      watchlists: [],
      activities: [],
      sessions: [],
      actors: [],
      total: 1,
    };
  },
}));

const { GET } = await import("../search/route");

function get(query: string) {
  const nextUrl = new URL(`http://streamystats.test/api/search?${query}`);
  return GET({ nextUrl, headers: new Headers() } as unknown as NextRequest);
}

describe("GET /api/search mode=plot", () => {
  beforeEach(() => {
    embedResult = { ok: true, embedding: [0.1, 0.2, 0.3] };
    plotCalls = [];
    titleCalls = 0;
  });

  test("returns Jellyfin ids by type from the plot search", async () => {
    const res = await get("q=astronauts+share+a+body&mode=plot&format=ids");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.movies).toEqual(["movie-1"]);
    expect(data.series).toEqual(["series-1"]);
    expect(data.episodes).toEqual(["episode-1"]);
    expect(plotCalls).toHaveLength(1);
    expect(plotCalls[0].types).toEqual(["Movie", "Series", "Episode"]);
    // Admins see every library.
    expect(plotCalls[0].viewerUserId).toBeUndefined();
    expect(titleCalls).toBe(0);
  });

  test("the type filter narrows the item types searched", async () => {
    const res = await get("q=heist&mode=plot&type=movies");
    const { data } = await res.json();
    expect(plotCalls[0].types).toEqual(["Movie"]);
    expect(data.items.map((i: { id: string }) => i.id)).toEqual(["movie-1"]);
  });

  test("non-media types have no plot to search", async () => {
    const res = await get("q=heist&mode=plot&type=actors&format=ids");
    const { data } = await res.json();
    expect(plotCalls[0].types).toEqual([]);
    expect(data.total).toBe(0);
  });

  test("without an embedding model it says so", async () => {
    embedResult = {
      ok: false,
      reason: "not_configured",
      error: "Embeddings are not configured for this server.",
    };
    const res = await get("q=heist&mode=plot&format=ids");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not configured");
    expect(body.data.movies).toEqual([]);
  });

  test("an unreachable embedding model is a 502", async () => {
    embedResult = { ok: false, reason: "request_failed", error: "timeout" };
    const res = await get("q=heist&mode=plot");
    expect(res.status).toBe(502);
  });

  test("rejects an unknown mode", async () => {
    const res = await get("q=heist&mode=vibes");
    expect(res.status).toBe(400);
  });

  test("title search is the default and unchanged", async () => {
    const res = await get("q=matrix&format=ids");
    const { data } = await res.json();
    expect(data.movies).toEqual(["title-1"]);
    expect(titleCalls).toBe(1);
    expect(plotCalls).toHaveLength(0);
  });
});

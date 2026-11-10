import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { NextRequest } from "next/server";

// Route-level tests for /api/moments: auth, embedding and the moment search
// are mocked; what is tested is parameter handling and the response.

let scope: { id: string; name: string; type: string }[];
let embedOk: boolean;
let findCalls: {
  itemIds: string[];
  embedding: number[] | null;
  limit: number;
}[];

// Module mocks are process-wide under `bun test`; keep the other tests' exports.
mock.module("@/lib/api-auth", () => ({
  requireAdmin: async () => ({ error: null }),
  requireAuth: async () => ({
    error: null,
    session: { id: "user-1", name: "User", serverId: 1, isAdmin: false },
  }),
}));
mock.module("@/lib/ai/embed-text", () => ({
  embedTextForServer: async () =>
    embedOk
      ? { ok: true, embedding: [0.1, 0.2] }
      : { ok: false, reason: "not_configured", error: "no embeddings" },
}));
mock.module("@/lib/db/moments", () => ({
  momentScope: async () => scope,
  findMoments: async (args: {
    itemIds: string[];
    embedding: number[] | null;
    limit: number;
  }) => {
    findCalls.push(args);
    return [
      {
        itemId: args.itemIds[0],
        startMs: 1_592_000,
        endMs: 1_650_000,
        precision: "line",
        line: "60% of the time, it works every time.",
      },
    ];
  },
}));

const { GET } = await import("../moments/route");

function get(query: string) {
  const nextUrl = new URL(`http://streamystats.test/api/moments?${query}`);
  return GET({ nextUrl, headers: new Headers() } as unknown as NextRequest);
}

describe("GET /api/moments", () => {
  beforeEach(() => {
    scope = [{ id: "movie-1", name: "Anchorman", type: "Movie" }];
    embedOk = true;
    findCalls = [];
  });

  test("returns the moments with their times", async () => {
    const res = await get("itemId=movie-1&q=60%25+of+the+time");
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.itemId).toBe("movie-1");
    expect(data.moments[0]).toMatchObject({
      startMs: 1_592_000,
      precision: "line",
    });
    expect(findCalls[0]).toMatchObject({ itemIds: ["movie-1"], limit: 3 });
  });

  test("a series searches every episode in scope", async () => {
    scope = [
      { id: "ep-1", name: "Pilot", type: "Episode" },
      { id: "ep-2", name: "Two", type: "Episode" },
    ];
    await get("itemId=series-1&q=hello&limit=5");
    expect(findCalls[0].itemIds).toEqual(["ep-1", "ep-2"]);
    expect(findCalls[0].limit).toBe(5);
  });

  test("without an embedding model the wording alone is searched", async () => {
    embedOk = false;
    await get("itemId=movie-1&q=hello");
    expect(findCalls[0].embedding).toBeNull();
  });

  test("needs itemId and q", async () => {
    expect((await get("q=hello")).status).toBe(400);
    expect((await get("itemId=movie-1")).status).toBe(400);
  });

  test("an item the user cannot see is not found", async () => {
    scope = [];
    expect((await get("itemId=hidden&q=hello")).status).toBe(404);
  });
});

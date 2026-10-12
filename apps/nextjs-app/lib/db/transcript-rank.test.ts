import { describe, expect, test } from "bun:test";
import { formatTimestamp, fuseChunkRankings } from "./transcript-rank";

const chunk = (id: number, itemId: string) => ({
  id,
  itemId,
  startMs: id * 1000,
  text: `c${id}`,
});

describe("fuseChunkRankings", () => {
  test("a chunk found by both rankings beats one found by either alone", () => {
    const text = [chunk(1, "a"), chunk(2, "b")];
    const vector = [chunk(3, "c"), chunk(2, "b")];
    expect(fuseChunkRankings([text, vector], 3).map((m) => m.itemId)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  test("groups chunks by item and keeps the two best moments", () => {
    const [match] = fuseChunkRankings(
      [[chunk(1, "a"), chunk(2, "a"), chunk(3, "a")]],
      5,
    );
    expect(match.moments.map((m) => m.text)).toEqual(["c1", "c2"]);
  });

  test("respects the limit", () => {
    expect(fuseChunkRankings([[chunk(1, "a"), chunk(2, "b")]], 1)).toHaveLength(
      1,
    );
  });
});

test("formatTimestamp", () => {
  expect(formatTimestamp(3_723_400)).toBe("01:02:03");
});

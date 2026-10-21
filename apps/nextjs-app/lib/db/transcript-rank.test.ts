import { describe, expect, test } from "bun:test";
import {
  bestLine,
  exactFirst,
  formatTimestamp,
  fuseByBestRank,
  fuseChunkRankings,
  fuseItemRankings,
} from "./transcript-rank";

const chunk = (id: number, itemId: string) => ({
  id,
  itemId,
  startMs: id * 1000,
  endMs: id * 1000 + 500,
  text: `c${id}`,
});

describe("fuseChunkRankings", () => {
  test("a title one ranking puts first beats titles both put lower", () => {
    // An exact line (text first) over windows that match by meaning twice.
    const text = [chunk(1, "quote"), chunk(2, "b"), chunk(3, "c")];
    const vector = [chunk(4, "d"), chunk(2, "b"), chunk(3, "c")];
    expect(fuseChunkRankings([text, vector], 3).map((m) => m.itemId)).toEqual([
      "quote",
      "d",
      "b",
    ]);
  });

  test("at the same best rank, the one both rankings found comes first", () => {
    const text = [chunk(1, "a"), chunk(2, "b")];
    const vector = [chunk(2, "b"), chunk(3, "c")];
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

describe("exactFirst", () => {
  test("titles holding the line come first, each once, with their own windows", () => {
    const exact = fuseChunkRankings(
      [[chunk(7, "quote"), chunk(8, "homage")]],
      5,
    );
    const fused = fuseChunkRankings(
      [[chunk(1, "near"), chunk(2, "quote"), chunk(3, "other")]],
      5,
    );
    const order = exactFirst(exact, fused, 5);
    expect(order.map((m) => m.itemId)).toEqual([
      "quote",
      "homage",
      "near",
      "other",
    ]);
    expect(order[0].moments.map((m) => m.text)).toEqual(["c7"]);
  });

  test("respects the limit", () => {
    const exact = fuseChunkRankings([[chunk(1, "a"), chunk(2, "b")]], 5);
    expect(exactFirst(exact, [], 1).map((m) => m.itemId)).toEqual(["a"]);
  });
});

describe("fuseItemRankings", () => {
  test("an item in both rankings beats the top of either alone", () => {
    expect(
      fuseItemRankings(
        [
          ["a", "b"],
          ["c", "b"],
        ],
        3,
      ).map((r) => r.id),
    ).toEqual(["b", "a", "c"]);
  });

  test("respects the limit and scores in descending order", () => {
    const fused = fuseItemRankings([["a", "b", "c"]], 2);
    expect(fused.map((r) => r.id)).toEqual(["a", "b"]);
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });
});

describe("fuseByBestRank", () => {
  test("a title one ranking puts first beats titles several put lower", () => {
    // RRF would put b and c (in two rankings each) above a.
    const rankings = [
      ["a", "b", "c"],
      ["x", "b", "c"],
      ["y", "c", "b"],
    ];
    expect(fuseItemRankings(rankings, 3).map((r) => r.id)[0]).toBe("b");
    const fused = fuseByBestRank(rankings, 6);
    expect(fused.map((r) => r.id)).toEqual(["a", "x", "y", "b", "c"]);
    expect(fused.map((r) => r.rank)).toEqual([0, 0, 0, 1, 1]);
  });

  test("ties at the same best rank go to the one more rankings agree on", () => {
    const fused = fuseByBestRank(
      [
        ["a", "b"],
        ["b", "a"],
        ["c", "a"],
      ],
      3,
    );
    expect(fused.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("a weighted ranking's places count further down", () => {
    // Weighted 3, the first two rankings' first places count as third: the
    // last ranking's first and second come before them.
    const fused = fuseByBestRank(
      [["plot"], ["story"], ["line", "close"]],
      4,
      [3, 3, 1],
    );
    expect(fused.map((r) => r.id)).toEqual(["line", "close", "plot", "story"]);
    expect(fused.map((r) => r.rank)).toEqual([0, 1, 2, 2]);
  });
});

describe("bestLine", () => {
  const lines = [
    { ms: 1000, text: "They've done studies, you know." },
    { ms: 2500, text: "60% of the time," },
    { ms: 3200, text: "it works every time." },
    { ms: 4000, text: "That doesn't make sense." },
  ];

  test("a quote split over two subtitle lines starts at the first", () => {
    expect(bestLine(lines, "60% of the time it works every time")).toEqual({
      ms: 2500,
      text: "60% of the time, it works every time.",
    });
  });

  test("a whole line starts at itself, not at the line before", () => {
    expect(bestLine(lines, "That doesn't make sense.")).toEqual({
      ms: 4000,
      text: "That doesn't make sense.",
    });
  });

  test("the line sharing the most words when it is not verbatim", () => {
    expect(bestLine(lines, "studies show it works")?.ms).toBe(1000);
  });

  test("no line for a description that shares a word with one by chance", () => {
    const scene = [...lines, { ms: 5000, text: "Wouldn't you say?" }];
    expect(
      bestLine(scene, "when does Allen say goodbye to his wife"),
    ).toBeNull();
  });

  test("no line for a paraphrase that shares no words", () => {
    expect(bestLine(lines, "a cologne made of panther")).toBeNull();
  });
});

test("formatTimestamp", () => {
  expect(formatTimestamp(3_723_400)).toBe("01:02:03");
});

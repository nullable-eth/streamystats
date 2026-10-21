import { describe, expect, test } from "bun:test";
import { reorderByPassages } from "./rerank-order";

describe("reorderByPassages", () => {
  test("the top titles by their best passage; the rest as they were", () => {
    const order = ["old", "afterlife", "junipero", "far"];
    const passages = [
      { id: "old", text: "Guy and Prisca die on the beach." },
      { id: "junipero", text: "Kelly visits Yorkie in hospital." },
      { id: "junipero", text: "San Junipero is a simulation for the dying." },
      { id: "afterlife", text: "Alice finds a beach where Arcadia should be." },
    ];
    expect(reorderByPassages(order, 3, passages, [-5, -2, 0.2, -6.8])).toEqual([
      "junipero",
      "old",
      "afterlife",
      "far",
    ]);
  });

  test("a title without a passage, or equal scores, keeps its fused place", () => {
    expect(
      reorderByPassages(["a", "b", "c"], 3, [{ id: "c", text: "x" }], [1]),
    ).toEqual(["c", "a", "b"]);
    expect(
      reorderByPassages(
        ["a", "b"],
        2,
        [
          { id: "a", text: "x" },
          { id: "b", text: "y" },
        ],
        [0, 0],
      ),
    ).toEqual(["a", "b"]);
  });

  test("a pinned title keeps its place; the others are reordered around it", () => {
    const passages = [
      { id: "storm", text: "We're gonna need a bigger boat." },
      { id: "clerks", text: "Salsa shark. We're gonna need a bigger boat." },
      { id: "jaws", text: "You're going to need a bigger boat." },
      { id: "boat", text: "A boat at sea." },
    ];
    expect(
      reorderByPassages(
        ["jaws", "boat", "clerks", "storm", "far"],
        4,
        passages,
        [3, 2, 1, -4],
        new Set(["jaws", "clerks"]),
      ),
    ).toEqual(["jaws", "storm", "clerks", "boat", "far"]);
  });
});

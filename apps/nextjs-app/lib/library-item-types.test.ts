import { describe, expect, test } from "bun:test";
import { libraryItemType } from "./library-item-types";

describe("libraryItemType", () => {
  test("keeps the types the list can be narrowed to", () => {
    expect(libraryItemType("Series")).toBe("Series");
    expect(libraryItemType("Movie")).toBe("Movie");
    expect(libraryItemType("Episode")).toBe("Episode");
  });

  test("drops anything else, so the list shows every item", () => {
    expect(libraryItemType(undefined)).toBeUndefined();
    expect(libraryItemType("")).toBeUndefined();
    expect(libraryItemType("series")).toBeUndefined();
    expect(libraryItemType("Season")).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { idsIn, resolveItemLink } from "./chat-item-links";

const DIE_HARD = "2a332225956c949c9af57abe8d112db4";
const DWIGHT = "7ad5e299642fa01b7ff2516d03f9fec4";

describe("item links in the chat", () => {
  const known = idsIn([
    { items: [{ id: DIE_HARD, name: "Die Hard" }] },
    { moments: [{ itemId: "7AD5E299-642F-A01B-7FF2-516D03F9FEC4" }] },
  ]);
  const names = new Map([[DIE_HARD, "Die Hard"]]);

  test("ids anywhere in the tool results, dashed or not", () => {
    expect([...known].sort()).toEqual([DIE_HARD, DWIGHT].sort());
  });

  test("a known id stands", () => {
    expect(resolveItemLink(DIE_HARD, "Die Hard", known, names)).toBe(DIE_HARD);
  });

  test("a miscopied id: by the item's name", () => {
    // The 2026-10-23 chat: "c9" dropped from the middle.
    expect(
      resolveItemLink(
        "2a332225956c949af57abe8d112db4",
        "Die Hard",
        known,
        names,
      ),
    ).toBe(DIE_HARD);
  });

  test("a miscopied id: by the one known id a few characters away", () => {
    expect(
      resolveItemLink(
        "7ad5e299642fa01b7ff2516d03f9fe",
        "Dwight Christmas",
        known,
        names,
      ),
    ).toBe(DWIGHT);
  });

  test("an id no tool result holds, near none: no link", () => {
    expect(
      resolveItemLink("0123456789abcdef0123456789abcdef", "Jaws", known, names),
    ).toBeNull();
  });
});

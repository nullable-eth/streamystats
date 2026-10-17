import { describe, expect, test } from "bun:test";
import { rewriteLoops, withoutLoops } from "./knowledge-rewrites";

const model = (name: string, rewriteFrom: string[] = []) => ({
  provider: "p",
  model: name,
  rewriteFrom,
});

describe("replacing another writer's notes", () => {
  test("a model never replaces its own", () => {
    expect(rewriteLoops([], "p:claude", "p:claude")).toBe(true);
  });

  test("nor notes that would come back to it round a loop", () => {
    const listed = [model("claude", ["p:gemma"]), model("gemma", ["p:qwen"])];
    expect(rewriteLoops(listed, "p:claude", "p:gemma")).toBe(true);
    expect(rewriteLoops(listed, "p:claude", "p:qwen")).toBe(true);
    expect(rewriteLoops(listed, "p:qwen", "p:claude")).toBe(false);
    expect(rewriteLoops(listed, "p:sonnet", "p:qwen")).toBe(false);
  });

  test("a restored list keeps its rewrites, less loops and repeats", () => {
    const restored = withoutLoops([
      { ...model("claude"), rewriteFrom: ["p:gemma", "p:gemma", 3] },
      { ...model("gemma"), rewriteFrom: ["p:claude", "p:gemma"] },
      { provider: "p", model: "qwen" },
    ]);
    expect(restored.map((m) => m.rewriteFrom)).toEqual([["p:gemma"], [], []]);
  });
});

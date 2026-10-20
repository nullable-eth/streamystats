import { describe, expect, test } from "bun:test";
import { runPool } from "./pool";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Items 0..n-1 in batches, each fetch taking a few ms like a query. */
function source(n: number, batch: number) {
  let next = 0;
  let fetches = 0;
  return {
    get fetches() {
      return fetches;
    },
    fetch: async () => {
      fetches++;
      await sleep(3);
      const items = Array.from({ length: Math.min(batch, n - next) }, (_, i) => next + i);
      next += items.length;
      return items;
    },
  };
}

/** Work that records how many items are in flight. */
function tracker(duration: (item: number) => number) {
  const done: number[] = [];
  let inFlight = 0;
  let most = 0;
  return {
    done,
    get most() {
      return most;
    },
    work: async (item: number) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await sleep(duration(item));
      inFlight--;
      done.push(item);
    },
  };
}

describe("runPool", () => {
  test("works every item once, never more than size() at a time", async () => {
    const src = source(23, 5);
    const t = tracker((i) => (i % 3) * 4 + 2);
    await runPool({ fetch: src.fetch, work: t.work, size: () => 3, inTime: () => true });
    expect([...t.done].sort((a, b) => a - b)).toEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(t.most).toBe(3);
  });

  test("keeps the pool full: a slow item doesn't hold up the next batch", async () => {
    // Each batch of 5 has one slow item. Batch by batch, every batch waits for
    // its slow one: 6 × 120 ms. A full pool spreads them: about (6 × 120 + 24 × 10) / 3.
    const src = source(30, 5);
    const t = tracker((i) => (i % 5 === 0 ? 120 : 10));
    const start = Date.now();
    await runPool({ fetch: src.fetch, work: t.work, size: () => 3, inTime: () => true });
    expect(t.done).toHaveLength(30);
    expect(Date.now() - start).toBeLessThan(560);
  });

  test("grows to a larger size() read after a fetch", async () => {
    const src = source(20, 4);
    const t = tracker(() => 15);
    await runPool({ fetch: src.fetch, work: t.work, size: () => (src.fetches > 1 ? 5 : 2), inTime: () => true });
    expect(t.done).toHaveLength(20);
    expect(t.most).toBe(5);
  });

  test("starts nothing once the time is up, leaving the rest", async () => {
    const src = source(50, 5);
    const t = tracker(() => 10);
    const start = Date.now();
    await runPool({ fetch: src.fetch, work: t.work, size: () => 2, inTime: () => Date.now() - start < 35 });
    expect(t.done.length).toBeGreaterThan(0);
    expect(t.done.length).toBeLessThan(20);
  });

  test("nothing due: no work", async () => {
    const t = tracker(() => 1);
    await runPool({ fetch: async () => [], work: t.work, size: () => 4, inTime: () => true });
    expect(t.done).toHaveLength(0);
  });

  test("a failed fetch ends the run once the items in flight are done", async () => {
    let fetches = 0;
    const t = tracker(() => 20);
    const run = runPool({
      fetch: async () => {
        if (++fetches > 1) throw new Error("db down");
        return [1, 2, 3];
      },
      work: t.work,
      size: () => 2,
      inTime: () => true,
    });
    await expect(run).rejects.toThrow("db down");
    expect([...t.done].sort()).toEqual([1, 2, 3]);
  });
});

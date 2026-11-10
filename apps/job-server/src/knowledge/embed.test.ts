import { afterAll, expect, test } from "bun:test";

const { embedTexts } = await import("./embed");

// An embedding server that, like llama.cpp, rejects inputs longer than it takes.
const LIMIT = 1_000;
const seen: number[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const { input } = (await req.json()) as { input: string[] };
    seen.push(...input.map((t) => t.length));
    if (input.some((t) => t.length > LIMIT)) {
      return Response.json({ error: { message: `input (${LIMIT + 1} tokens) is too large to process` } }, { status: 400 });
    }
    return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
  },
});
afterAll(() => server.stop());
const settings = { provider: "openai-compatible" as const, baseUrl: `http://localhost:${server.port}/v1`, model: "m" };

test("a text too long for the endpoint is cut until it is taken, without failing the rest", async () => {
  const vectors = await embedTexts(settings, ["short", "word ".repeat(1_000)]);
  expect(vectors).toHaveLength(2);
  expect(seen.at(-1)).toBeLessThanOrEqual(LIMIT);
  // Later texts are cut to what it took before they are sent.
  seen.length = 0;
  await embedTexts(settings, ["word ".repeat(1_000)]);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toBeLessThanOrEqual(LIMIT);
});

test("other failures are not mistaken for length", async () => {
  await expect(embedTexts({ ...settings, baseUrl: "http://localhost:1/v1" }, ["short"])).rejects.toThrow();
});

import { describe, expect, mock, test } from "bun:test";
import { AxiosError, type AxiosResponse } from "axios";

// Each model's "request": what it answers, or how it fails.
const answers = new Map<string, () => { scenes: never[]; synopsis: string }>();
mock.module("./synopsis", () => ({
  writePlot: async (chat: { model: string }, _info: unknown, _parts: unknown, used: (u: unknown) => void) => {
    await used({ inputTokens: 1_000_000, outputTokens: 100_000 });
    return answers.get(chat.model)?.() ?? { scenes: [], synopsis: "ok" };
  },
}));
const { costOf, isUsable, messageOf, restFor, spentThisMonth, writePlotWithModels } = await import("./models");

const now = new Date("2026-10-15T12:00:00Z");
const model = (name: string, extra = {}) => ({
  id: null,
  provider: "openai-compatible",
  baseUrl: null,
  apiKey: null,
  model: name,
  inputPrice: 3,
  outputPrice: 15,
  monthlyBudget: null as number | null,
  spentMonth: null as string | null,
  spent: 0,
  unavailableUntil: null as Date | null,
  ...extra,
});
const httpError = (status: number, data: unknown) =>
  new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    status,
    data,
    headers: {},
  } as AxiosResponse);

describe("budgets", () => {
  test("cost from the tokens at the model's prices", () => {
    expect(costOf(model("m"), { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(4.5);
  });

  test("spend counts in its month only; a new month starts from zero", () => {
    expect(spentThisMonth(model("m", { spentMonth: "2026-10", spent: 7 }), now)).toBe(7);
    expect(spentThisMonth(model("m", { spentMonth: "2026-09", spent: 7 }), now)).toBe(0);
  });

  test("usable: budget left this month and not resting", () => {
    expect(isUsable(model("m"), now)).toBe(true);
    expect(isUsable(model("m", { monthlyBudget: 5, spentMonth: "2026-10", spent: 5 }), now)).toBe(false);
    expect(isUsable(model("m", { monthlyBudget: 5, spentMonth: "2026-09", spent: 5 }), now)).toBe(true);
    expect(isUsable(model("m", { unavailableUntil: new Date("2026-10-15T13:00:00Z") }), now)).toBe(false);
    expect(isUsable(model("m", { unavailableUntil: new Date("2026-10-15T11:00:00Z") }), now)).toBe(true);
  });
});

describe("restFor", () => {
  test("the model's failures rest it an hour, or as long as it asks", () => {
    for (const status of [401, 402, 403, 404, 429, 500, 529]) expect(restFor({ status, body: "" })).toBe(3_600_000);
    expect(restFor({ status: 400, body: '{"error":{"message":"Your credit balance is too low"}}' })).toBe(3_600_000);
    expect(restFor({ status: undefined, body: "ECONNREFUSED" })).toBe(3_600_000);
    expect(restFor({ status: 429, body: "", retryAfterSeconds: 7200 })).toBe(7_200_000);
  });

  test("the title's do not: too long, bad request, timeout", () => {
    expect(restFor({ status: 400, body: "prompt is too long: 250000 tokens > 200000 maximum" })).toBeNull();
    expect(restFor({ status: 413, body: "" })).toBeNull();
    expect(restFor({ status: undefined, body: "timeout", timedOut: true })).toBeNull();
  });
});

describe("writePlotWithModels", () => {
  test("a model out of credit rests, and the title goes to the next", async () => {
    answers.set("claude", () => {
      throw httpError(400, { error: { message: "Your credit balance is too low" } });
    });
    const claude = model("claude");
    const qwen = model("qwen", { inputPrice: 0, outputPrice: 0 });
    const written = await writePlotWithModels([claude, qwen], { title: "T", overview: null, characters: [] }, []);
    expect(written.model).toBe(qwen);
    expect(claude.unavailableUntil?.getTime()).toBeGreaterThan(Date.now());
    // Spend is counted even for the failed request.
    expect(claude.spent).toBeCloseTo(4.5);
  });

  test("a title one model cannot write goes to the next without resting it", async () => {
    answers.set("small", () => {
      throw new Error("Chat model returned no scene notes");
    });
    const small = model("small");
    const written = await writePlotWithModels([small, model("big")], { title: "T", overview: null, characters: [] }, []);
    expect(written.model.model).toBe("big");
    expect(small.unavailableUntil).toBeNull();
  });

  test("over budget or resting models are skipped; none left fails the title", async () => {
    const spent = model("a", { monthlyBudget: 1, spentMonth: new Date().toISOString().slice(0, 7), spent: 1 });
    const resting = model("b", { unavailableUntil: new Date(Date.now() + 60_000) });
    await expect(
      writePlotWithModels([spent, resting], { title: "T", overview: null, characters: [] }, [])
    ).rejects.toThrow("No knowledge index model is usable");
  });
});

describe("messageOf", () => {
  test("an error body's message, with OpenRouter's provider reason", () => {
    expect(messageOf('{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}')).toBe(
      "Your credit balance is too low"
    );
    expect(
      messageOf('{"error":{"message":"Provider returned error","code":429,"metadata":{"raw":"model is rate-limited upstream"}}}')
    ).toBe("Provider returned error: model is rate-limited upstream");
    expect(messageOf("Bad Gateway")).toBe("Bad Gateway");
  });
});

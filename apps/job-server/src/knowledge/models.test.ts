import { describe, expect, mock, test } from "bun:test";
import { AxiosError, type AxiosResponse } from "axios";

// Each model's "request": what it answers, or how it fails.
const answers = new Map<string, () => { scenes: never[]; synopsis: string }>();
// The rest of the module stays real: the mock outlives this file in a run.
const synopsis = await import("./synopsis");
mock.module("./synopsis", () => ({
  ...synopsis,
  writePlot: async (chat: { model: string }) => answers.get(chat.model)?.() ?? { scenes: [], synopsis: "ok" },
}));
const { inSlot, isUsable, messageOf, parallelOf, restFor, rewritesOf, WriteFailure, writePlotWithModels, writersFor } = await import(
  "./models"
);
const { durationMs, waitAsked } = await import("./retry");

const now = new Date("2026-10-15T12:00:00Z");
const model = (name: string, extra = {}) => ({
  id: null,
  provider: "openai-compatible",
  baseUrl: null,
  apiKey: null,
  model: name,
  unavailableUntil: null as Date | null,
  rewriteFrom: [] as string[],
  parallelRequests: null as number | null,
  ...extra,
});
const httpError = (status: number, data: unknown, headers = {}) =>
  new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
    status,
    data,
    headers,
  } as AxiosResponse);
const HOUR = 3_600_000;
const MINUTES_15 = 900_000;

test("usable: not resting", () => {
  expect(isUsable(model("m"), now)).toBe(true);
  expect(isUsable(model("m", { unavailableUntil: new Date("2026-10-15T13:00:00Z") }), now)).toBe(false);
  expect(isUsable(model("m", { unavailableUntil: new Date("2026-10-15T11:00:00Z") }), now)).toBe(true);
});

describe("waitAsked", () => {
  const at = now.getTime();
  test("Retry-After, in seconds or as a date", () => {
    expect(waitAsked({ "retry-after": "30" }, "", at)).toBe(30_000);
    expect(waitAsked({ "retry-after": "Thu, 15 Oct 2026 12:05:00 GMT" }, "", at)).toBe(300_000);
  });

  test("X-RateLimit-Reset as epoch milliseconds (OpenRouter, also from its error body), epoch or relative seconds", () => {
    const midnight = Date.parse("2026-10-16T00:00:00Z");
    expect(waitAsked({ "x-ratelimit-reset": String(midnight) }, "", at)).toBe(12 * HOUR);
    expect(waitAsked({ "x-ratelimit-reset": String(midnight / 1000) }, "", at)).toBe(12 * HOUR);
    expect(waitAsked({ "x-ratelimit-reset": "20" }, "", at)).toBe(20_000);
    const body = JSON.stringify({
      error: {
        message: "Rate limit exceeded: free-models-per-day",
        code: 429,
        metadata: { headers: { "X-RateLimit-Limit": "50", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(midnight) } },
      },
    });
    expect(waitAsked({}, body, at)).toBe(12 * HOUR);
  });

  test("the reset of whichever limit is used up: Anthropic's times, OpenAI's durations", () => {
    expect(
      waitAsked(
        {
          "anthropic-ratelimit-requests-remaining": "10",
          "anthropic-ratelimit-requests-reset": "2026-10-15T12:00:01Z",
          "anthropic-ratelimit-output-tokens-remaining": "0",
          "anthropic-ratelimit-output-tokens-reset": "2026-10-15T12:00:40Z",
        },
        "",
        at
      )
    ).toBe(40_000);
    expect(
      waitAsked(
        {
          "x-ratelimit-remaining-requests": "0",
          "x-ratelimit-reset-requests": "6m0s",
          "x-ratelimit-remaining-tokens": "5000",
          "x-ratelimit-reset-tokens": "1.5s",
        },
        "",
        at
      )
    ).toBe(360_000);
  });

  test("Gemini's retryDelay; nothing when nothing says", () => {
    expect(waitAsked({}, '{"error":{"details":[{"retryDelay": "43s"}]}}', at)).toBe(43_000);
    expect(waitAsked({ "x-ratelimit-remaining-requests": "3" }, "Too many requests", at)).toBeNull();
  });

  test("durations", () => {
    expect(durationMs("1h2m3s")).toBe(3_723_000);
    expect(durationMs("200ms")).toBe(200);
    expect(durationMs("soon")).toBeNull();
  });
});

describe("restFor", () => {
  test("a rate limit rests until it resets, or 15 minutes when it does not say", () => {
    expect(restFor({ status: 429, body: "", waitMs: 12 * HOUR })).toBe(12 * HOUR);
    expect(restFor({ status: 429, body: "" })).toBe(MINUTES_15);
    // A short wait was already retried in place.
    expect(restFor({ status: 429, body: "", waitMs: 20_000 })).toBe(MINUTES_15);
  });

  test("busy or unreachable rests a while; a rejected key, unknown model or no credit, an hour", () => {
    for (const status of [500, 503, 529]) expect(restFor({ status, body: "" })).toBe(MINUTES_15);
    expect(restFor({ status: 503, body: "", waitMs: 2 * HOUR })).toBe(2 * HOUR);
    expect(restFor({ status: undefined, body: "ECONNREFUSED" })).toBe(MINUTES_15);
    for (const status of [401, 402, 403, 404]) expect(restFor({ status, body: "" })).toBe(HOUR);
    expect(restFor({ status: 400, body: '{"error":{"message":"Your credit balance is too low"}}' })).toBe(HOUR);
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
    const qwen = model("qwen");
    const written = await writePlotWithModels([claude, qwen], { title: "T", overview: null, characters: [] }, []);
    expect(written.model).toBe(qwen);
    expect(claude.unavailableUntil?.getTime()).toBeGreaterThan(Date.now());
  });

  test("a model out of its daily quota rests until it resets", async () => {
    const reset = Date.now() + 5 * HOUR;
    answers.set("free", () => {
      throw httpError(429, { error: { message: "Rate limit exceeded" } }, { "x-ratelimit-reset": String(reset) });
    });
    const free = model("free");
    await writePlotWithModels([free, model("paid")], { title: "T", overview: null, characters: [] }, []);
    expect(Math.abs((free.unavailableUntil?.getTime() ?? 0) - reset)).toBeLessThan(1000);
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

  test("resting models are skipped; none left fails the title, which stays due", async () => {
    const resting = model("b", { unavailableUntil: new Date(Date.now() + 60_000) });
    const write = writePlotWithModels([resting], { title: "T", overview: null, characters: [] }, []);
    await expect(write).rejects.toThrow("No knowledge index model is usable");
    await expect(write).rejects.toMatchObject({ titlesFault: false });
  });

  test("a rate limit is the model's: the title stays due", async () => {
    answers.set("busy", () => {
      throw httpError(429, {});
    });
    const write = writePlotWithModels([model("busy")], { title: "T", overview: null, characters: [] }, []);
    await expect(write).rejects.toBeInstanceOf(WriteFailure);
    await expect(write).rejects.toMatchObject({ titlesFault: false });
  });

  /** Each title as the job writes it: the model read afresh, how its failure counts. */
  const titlesFaults = async (name: string, titles: number) => {
    const faults: boolean[] = [];
    for (let i = 0; i < titles; i++) {
      try {
        await writePlotWithModels([model(name)], { title: `T${i}`, overview: null, characters: [] }, []);
        faults.push(false);
      } catch (error) {
        faults.push((error as InstanceType<typeof WriteFailure>).titlesFault);
      }
    }
    return faults;
  };

  test("a model failing every title is broken: the third failure in a row rests it, and the titles after aren't blamed", async () => {
    answers.set("broken", () => {
      throw httpError(400, { error: { message: "Unsupported parameter: temperature" } });
    });
    expect(await titlesFaults("broken", 4)).toEqual([true, true, false, false]);
  });

  test("a title it writes clears the count", async () => {
    let calls = 0;
    answers.set("flaky", () => {
      if (++calls === 3) return { scenes: [], synopsis: "ok" };
      throw new Error("Chat model returned an empty or too-short synopsis");
    });
    // fail, fail, write, fail: the last is the first in a row again.
    expect(await titlesFaults("flaky", 4)).toEqual([true, true, false, true]);
  });
});

describe("refusals", () => {
  const info = { title: "MythBusters S2009E06", overview: null, characters: [] };
  const usagePolicy = () =>
    httpError(502, {
      error: {
        message:
          'claude exited 1: {"is_error":true,"result":"API Error: Claude Code is unable to respond to this request, which appears to violate our Usage Policy (https://www.anthropic.com/legal/aup)."}',
      },
    });
  const keeper = (by: string[] = []) => {
    const kept: string[] = [];
    return {
      kept,
      refusals: {
        by: new Set(by),
        record: async (m: { provider: string; model: string }) => {
          kept.push(`${m.provider}:${m.model}`);
        },
      },
    };
  };

  test("a model that declines a title neither rests nor is blamed; the next model writes it", async () => {
    answers.set("max", () => {
      throw usagePolicy();
    });
    const max = model("max");
    const { kept, refusals } = keeper();
    const written = await writePlotWithModels([max, model("local")], info, [], refusals);
    expect(written.model.model).toBe("local");
    expect(max.unavailableUntil).toBeNull();
    expect(kept).toEqual(["openai-compatible:max"]);
  });

  test("every model declined: the title waits as declined, no model rests", async () => {
    answers.set("max", () => {
      throw usagePolicy();
    });
    const max = model("max");
    const write = writePlotWithModels([max], info, [], keeper().refusals);
    await expect(write).rejects.toMatchObject({ declined: true, titlesFault: true });
    expect(max.unavailableUntil).toBeNull();
  });

  test("a model that declined the title before is not asked again", async () => {
    let asked = 0;
    answers.set("max", () => {
      asked++;
      return { scenes: [], synopsis: "ok" };
    });
    const write = writePlotWithModels([model("max")], info, [], keeper(["openai-compatible:max"]).refusals);
    await expect(write).rejects.toMatchObject({ declined: true });
    await expect(write).rejects.toThrow("declined it before");
    expect(asked).toBe(0);
  });

  test("refusals are not strikes: a model declining title after title is not rested", async () => {
    answers.set("strict", () => {
      throw usagePolicy();
    });
    for (let i = 0; i < 4; i++) {
      const strict = model("strict");
      const write = writePlotWithModels([strict], { ...info, title: `T${i}` }, [], keeper().refusals);
      await expect(write).rejects.toMatchObject({ declined: true, titlesFault: true });
      expect(strict.unavailableUntil).toBeNull();
    }
  });

  test("declined by one, failed otherwise by another: not declined", async () => {
    answers.set("max", () => {
      throw usagePolicy();
    });
    answers.set("small", () => {
      throw new Error("Chat model returned no scene notes");
    });
    const write = writePlotWithModels([model("max"), model("small")], info, [], keeper().refusals);
    await expect(write).rejects.toMatchObject({ declined: false, titlesFault: true });
  });

  test("a real server error still rests the model", async () => {
    answers.set("down", () => {
      throw httpError(502, "Bad Gateway");
    });
    const down = model("down");
    const write = writePlotWithModels([down], info, [], keeper().refusals);
    await expect(write).rejects.toMatchObject({ declined: false, titlesFault: false });
    expect(down.unavailableUntil?.getTime()).toBeGreaterThan(Date.now());
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

describe("who writes a title's notes", () => {
  const label = (m: string) => `openai-compatible:${m}`;
  const claude = model("claude", { rewriteFrom: [label("gemma")] });
  const [gemma, qwen] = [model("gemma"), model("qwen")];
  const usable = [qwen, gemma, claude];
  const notes = (writtenBy: string | null) => ({ status: "ready", writtenBy });
  const names = (models: { model: string }[]) => models.map((m) => m.model);

  test("missing notes: any, in the list's order", () => {
    expect(names(writersFor(undefined, usable))).toEqual(["qwen", "gemma", "claude"]);
    expect(names(writersFor({ status: "missing", writtenBy: null }, usable))).toEqual(["qwen", "gemma", "claude"]);
  });

  test("notes once written are kept, whatever the list's order", () => {
    expect(writersFor(notes(label("claude")), usable)).toEqual([]);
    expect(writersFor(notes(label("qwen")), [claude, gemma, qwen])).toEqual([]);
    expect(writersFor(notes(null), usable)).toEqual([]);
  });

  test("notes by a writer a model was asked to replace: that model", () => {
    expect(names(writersFor(notes(label("gemma")), usable))).toEqual(["claude"]);
    // Resting (not among the usable): left as they are.
    expect(writersFor(notes(label("gemma")), [qwen, gemma])).toEqual([]);
  });

  test("never its own notes, whatever it was asked", () => {
    const self = model("claude", { rewriteFrom: [label("claude")] });
    expect(writersFor(notes(label("claude")), [self])).toEqual([]);
    expect(rewritesOf([self, claude])).toEqual([label("gemma")]);
  });
});

describe("requests at once", () => {
  test("as set, or 4 to a hosted API and 1 to others", () => {
    expect(parallelOf(model("claude", { provider: "anthropic" }))).toBe(4);
    expect(parallelOf(model("gemini", { provider: "gemini" }))).toBe(4);
    expect(parallelOf(model("qwen"))).toBe(1);
    expect(parallelOf(model("qwen", { parallelRequests: 3 }))).toBe(3);
  });

  test("a model is sent no more at once than it takes", async () => {
    const qwen = model("qwen-slots", { parallelRequests: 2 });
    let running = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const work = (waited: boolean) => {
      running++;
      most = Math.max(most, running);
      return new Promise<boolean>((done) =>
        releases.push(() => {
          running--;
          done(waited);
        })
      );
    };
    const titles = [inSlot(qwen, work), inSlot(qwen, work), inSlot(qwen, work)];
    await Bun.sleep(0);
    expect(releases).toHaveLength(2);
    releases.shift()?.();
    await Bun.sleep(0);
    expect(releases).toHaveLength(2);
    for (const release of releases.splice(0)) release();
    expect(await Promise.all(titles)).toEqual([false, false, true]);
    expect(most).toBe(2);
  });
});

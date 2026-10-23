import axios from "axios";

/** The longest a request waits to be retried; a model asked to wait longer rests instead (see models.ts). */
export const MAX_WAIT_MS = 60_000;

type Headers = Record<string, unknown>;

const header = (headers: Headers, name: string): string | undefined => {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] === undefined ? undefined : String(value[0]);
  return value === undefined || value === null ? undefined : String(value);
};

/** "6m0s", "1.5s", "200ms", "1h2m3s" as milliseconds. */
export function durationMs(text: string): number | null {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  return parts.reduce((ms, [, n, u]) => ms + Number(n) * unit[u as keyof typeof unit], 0);
}

/**
 * How long a rate-limited answer asks to wait, in milliseconds, from the first
 * of the usual signals it carries: Retry-After (seconds or a date);
 * X-RateLimit-Reset (OpenRouter's epoch milliseconds, or epoch or relative
 * seconds; OpenRouter repeats its headers in the error body's metadata); the
 * reset of whichever limit is used up, as Anthropic
 * (anthropic-ratelimit-*-reset, a time) and OpenAI or Groq
 * (x-ratelimit-reset-*, a duration) report it; Gemini's retryDelay in the
 * body. Null when it gives none.
 */
export function waitAsked(headers: Headers, body = "", now = Date.now()): number | null {
  const ms = (wait: number) => Math.max(0, Math.round(wait));

  const retryAfter = header(headers, "retry-after");
  if (retryAfter) {
    if (/^\d+(\.\d+)?$/.test(retryAfter.trim())) return ms(Number(retryAfter) * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return ms(at - now);
  }

  const reset = Number(header(headers, "x-ratelimit-reset") ?? /"x-ratelimit-reset"\s*:\s*"?(\d+)/i.exec(body)?.[1]);
  if (reset > 0) return ms(reset > 1e12 ? reset - now : reset > 1e9 ? reset * 1000 - now : reset * 1000);

  const usedUp: number[] = [];
  for (const limit of ["requests", "tokens", "input-tokens", "output-tokens"]) {
    if (header(headers, `anthropic-ratelimit-${limit}-remaining`) === "0") {
      const at = Date.parse(header(headers, `anthropic-ratelimit-${limit}-reset`) ?? "");
      if (!Number.isNaN(at)) usedUp.push(at - now);
    }
    if (header(headers, `x-ratelimit-remaining-${limit}`) === "0") {
      const wait = durationMs(header(headers, `x-ratelimit-reset-${limit}`) ?? "");
      if (wait !== null) usedUp.push(wait);
    }
  }
  if (usedUp.length > 0) return ms(Math.max(...usedUp));

  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return delay ? ms(Number(delay[1]) * 1000) : null;
}

/**
 * Rate limits and overload (429, 503, 529) and dropped connections: wait as
 * asked, or back off, and try again. A timeout is not retried, nor a wait
 * longer than MAX_WAIT_MS: the caller decides what to do meanwhile.
 */
export async function withRetries<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const response = axios.isAxiosError(error) ? error.response : undefined;
      const dropped = axios.isAxiosError(error) && !response && error.code !== "ECONNABORTED";
      if (attempt >= 6 || !(dropped || [429, 503, 529].includes(response?.status ?? 0))) throw error;
      // A streamed body is left for the caller to read.
      const body = typeof response?.data === "string" ? response.data : response?.data?.pipe ? "" : JSON.stringify(response?.data ?? "");
      const asked = response ? waitAsked(response.headers as Headers, body) : null;
      if (asked !== null && asked > MAX_WAIT_MS) throw error;
      await new Promise((resolve) => setTimeout(resolve, asked ?? 5_000 * 2 ** attempt));
    }
  }
}

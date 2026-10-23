/**
 * The models that write synopses, as the job treats them (see the job's
 * knowledge/models.ts). A writer is "provider:model", as synopses record it.
 */
export const writerLabel = (m: { provider: string; model: string }) =>
  `${m.provider}:${m.model}`;

/** Requests a model is sent at once unless set: 4 to Anthropic and Gemini, 1 to others. */
export const defaultParallel = (provider: string) =>
  provider === "anthropic" || provider === "gemini" ? 4 : 1;

interface Rewriting {
  provider: string;
  model: string;
  /** Writers whose notes it already replaces. */
  rewriteFrom: string[];
}

/**
 * Whether the model writing as `to` replacing `from`'s notes would have a
 * model replace its own, directly or round a loop (A replacing B's while B
 * replaces A's), so the same titles are rewritten for ever.
 */
export function rewriteLoops(
  models: Rewriting[],
  from: string,
  to: string,
): boolean {
  const seen = new Set<string>();
  const next = [to];
  for (let at = next.pop(); at !== undefined; at = next.pop()) {
    if (at === from) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const m of models) {
      if (m.rewriteFrom.includes(at)) next.push(writerLabel(m));
    }
  }
  return false;
}

/** A restored list's rewrites, less any that would loop. */
export function withoutLoops<T extends Omit<Rewriting, "rewriteFrom">>(
  models: (T & { rewriteFrom?: unknown })[],
): (T & { rewriteFrom: string[] })[] {
  const kept = models.map((m) => ({ ...m, rewriteFrom: [] as string[] }));
  models.forEach((m, i) => {
    const asked = Array.isArray(m.rewriteFrom) ? m.rewriteFrom : [];
    for (const from of asked) {
      if (
        typeof from === "string" &&
        !kept[i].rewriteFrom.includes(from) &&
        !rewriteLoops(kept, from, writerLabel(m))
      ) {
        kept[i].rewriteFrom.push(from);
      }
    }
  });
  return kept;
}

/**
 * Item links in the chat: the model writes `[Name](item://id)` with an id it
 * copied from a tool result, and now and then miscopies one (a 32-character
 * id with two characters dropped), which made a card linking to no item.
 * Every link is checked against the ids the conversation's tool results hold.
 */

/** An item id as Jellyfin writes it: 32 hex characters, sometimes dashed. */
const ITEM_ID =
  /(?<![0-9a-f])[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/gi;

/** A miscopied id this close to exactly one known id is taken to mean it. */
const MAX_TYPOS = 4;

const normalize = (id: string) => id.replace(/-/g, "").toLowerCase();

/** Every item id anywhere in the tool results, normalized. */
export function idsIn(outputs: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const output of outputs) {
    for (const match of JSON.stringify(output ?? null).match(ITEM_ID) ?? []) {
      ids.add(normalize(match));
    }
  }
  return ids;
}

/** Edit distance, giving up past `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, current[j]);
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

/**
 * The item a link means: its id when a tool result holds it; else the one
 * item of that name the results hold; else the one known id within a few
 * characters of it. Null when none fits: the link is shown as its name.
 */
export function resolveItemLink(
  linkId: string,
  linkName: string,
  known: ReadonlySet<string>,
  namesById: ReadonlyMap<string, string>,
): string | null {
  const id = normalize(linkId);
  if (known.has(id)) return id;
  const name = linkName.trim().toLowerCase();
  const named = [...namesById].filter(
    ([, n]) => n.trim().toLowerCase() === name,
  );
  if (name && named.length === 1) return normalize(named[0][0]);
  const close = [...known]
    .map((k) => ({ k, d: distance(id, k, MAX_TYPOS) }))
    .filter((c) => c.d <= MAX_TYPOS)
    .sort((a, b) => a.d - b.d);
  if (close.length === 1 || (close.length > 1 && close[0].d < close[1].d)) {
    return close[0].k;
  }
  return null;
}

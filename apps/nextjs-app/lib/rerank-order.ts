/** Pure helpers for reranking (no network). */

/**
 * `order` with its first `top` reordered by their best passage's reranker
 * score; the rest after, as they were. A title without passages keeps its
 * place after the reranked ones. A `pinned` title keeps its own place, and
 * the others are reordered around it.
 */
export function reorderByPassages(
  order: string[],
  top: number,
  passages: { id: string; text: string }[],
  scores: number[],
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  const head = order.slice(0, top);
  const best = new Map<string, number>();
  passages.forEach((p, i) => {
    best.set(
      p.id,
      Math.max(best.get(p.id) ?? Number.NEGATIVE_INFINITY, scores[i]),
    );
  });
  const ranked = head
    .map((id, i) => ({
      id,
      i,
      score: best.get(id) ?? Number.NEGATIVE_INFINITY,
    }))
    .filter((r) => !pinned.has(r.id))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.id);
  return [
    ...head.map((id) => (pinned.has(id) ? id : (ranked.shift() as string))),
    ...order.slice(top),
  ];
}

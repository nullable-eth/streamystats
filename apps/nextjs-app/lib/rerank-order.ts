/** Pure helpers for reranking (no network). */

/**
 * `order` with its first `top` reordered by their best passage's reranker
 * score; the rest after, as they were. A title without passages keeps its
 * place after the reranked ones.
 */
export function reorderByPassages(
  order: string[],
  top: number,
  passages: { id: string; text: string }[],
  scores: number[],
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
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.id);
  return [...ranked, ...order.slice(top)];
}

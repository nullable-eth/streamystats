/** Pure ranking helpers for transcript search (no database access). */
const RRF_K = 60;

export interface TranscriptMatch {
  itemId: string;
  score: number;
  moments: { startMs: number; text: string }[];
}

/**
 * Reciprocal rank fusion of ranked chunk lists, grouped by item: an item
 * scores by its best chunks, and keeps its two best moments as evidence.
 */
export function fuseChunkRankings(
  rankings: { id: number; itemId: string; startMs: number; text: string }[][],
  limit: number,
): TranscriptMatch[] {
  const chunks = new Map<
    number,
    { itemId: string; startMs: number; text: string; score: number }
  >();
  for (const ranking of rankings) {
    ranking.forEach((c, rank) => {
      const entry = chunks.get(c.id) ?? { ...c, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      chunks.set(c.id, entry);
    });
  }
  const byItem = new Map<string, TranscriptMatch>();
  for (const c of [...chunks.values()].sort((a, b) => b.score - a.score)) {
    const match = byItem.get(c.itemId) ?? {
      itemId: c.itemId,
      score: 0,
      moments: [],
    };
    if (match.moments.length < 2) {
      match.score += c.score;
      match.moments.push({ startMs: c.startMs, text: c.text });
    }
    byItem.set(c.itemId, match);
  }
  return [...byItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function formatTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

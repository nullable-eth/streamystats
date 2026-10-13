/** Pure ranking helpers for transcript search (no database access). */
const RRF_K = 60;

export interface TranscriptMatch {
  itemId: string;
  score: number;
  /** Times are null for windows with none (the synopsis, not its scenes). */
  moments: { startMs: number | null; endMs: number | null; text: string }[];
}

/**
 * Reciprocal rank fusion of ranked chunk lists, grouped by item: an item
 * scores by its best chunks, and keeps its two best moments as evidence.
 */
export function fuseChunkRankings(
  rankings: {
    id: number;
    itemId: string;
    startMs: number | null;
    endMs: number | null;
    text: string;
  }[][],
  limit: number,
): TranscriptMatch[] {
  const chunks = new Map<
    number,
    {
      itemId: string;
      startMs: number | null;
      endMs: number | null;
      text: string;
      score: number;
    }
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
      match.moments.push({ startMs: c.startMs, endMs: c.endMs, text: c.text });
    }
    byItem.set(c.itemId, match);
  }
  return [...byItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Reciprocal rank fusion of ranked item id lists: an item near the top of
 * several rankings beats one found by a single ranking.
 */
export function fuseItemRankings(
  rankings: string[][],
  limit: number,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Fuse ranked item id lists by each item's best rank in any of them, so a
 * title that one ranking puts first is not buried under titles several
 * rankings put halfway down. Ties go to the item the rankings agree on more
 * (reciprocal rank fusion), which is also its score.
 */
export function fuseByBestRank(
  rankings: string[][],
  limit: number,
): { id: string; score: number }[] {
  const consensus = new Map(
    fuseItemRankings(rankings, Number.POSITIVE_INFINITY).map((r) => [
      r.id,
      r.score,
    ]),
  );
  const best = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((id, rank) => {
      best.set(id, Math.min(best.get(id) ?? rank, rank));
    });
  }
  return [...best]
    .sort(
      (a, b) =>
        a[1] - b[1] || (consensus.get(b[0]) ?? 0) - (consensus.get(a[0]) ?? 0),
    )
    .slice(0, limit)
    .map(([id]) => ({ id, score: consensus.get(id) ?? 0 }));
}

const STOPWORDS = new Set(
  "the and you that was for are with his her they this have from not but what all were when there can who will one just into out about then them she him does did has had its your our yeah well".split(
    " ",
  ),
);

/** Lower case, letters and digits only, single spaces. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

function contentWords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * The line of dialogue a query points at, among one window's lines: the
 * query as a phrase first, then the most of its words. A remembered line is
 * often split over two subtitle lines, so each line is also tried together
 * with the next; the time is when the first of them starts. Null when no
 * line shares at least a third of the query's words: a description of a
 * scene shares a word or two with many lines by chance ("when does he say
 * goodbye to his wife" and "Wouldn't you say?"), and then the window's start
 * is the better answer.
 */
export function bestLine(
  lines: { ms: number; text: string }[],
  query: string,
): { ms: number; text: string } | null {
  const phrase = normalize(query);
  const wanted = contentWords(query);
  let best: { i: number; span: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    for (const span of [1, 2]) {
      if (i + span > lines.length) break;
      const text = lines
        .slice(i, i + span)
        .map((l) => l.text)
        .join(" ");
      let score = [...contentWords(text)].filter((w) => wanted.has(w)).length;
      if (phrase.length >= 8 && normalize(text).includes(phrase)) score += 100;
      // A pair has to add something over either of its lines alone, so a
      // line is timed from itself, not from the line before it.
      const ownsPair =
        span === 1 &&
        best?.span === 2 &&
        best.i === i - 1 &&
        score === best.score;
      if (score > (best?.score ?? 0) || ownsPair) best = { i, span, score };
    }
  }
  if (!best || best.score < wanted.size / 3) return null;
  return {
    ms: lines[best.i].ms,
    text: lines
      .slice(best.i, best.i + best.span)
      .map((l) => l.text)
      .join(" "),
  };
}

export function formatTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

import "server-only";

/** A reranker as saved in the settings (see getRerankerConfig). */
export interface Reranker {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

/** Plot search waits no longer than this; past it, it keeps its own order. */
const TIMEOUT_MS = 8000;

/**
 * How well each document answers the query, from a cross-encoder reranker:
 * one number per document, in their order, higher is better (the scale is the
 * model's own). Speaks the Jina/Cohere /rerank shape that llama.cpp
 * (--reranking), Infinity, TEI, vLLM, Jina and Cohere all serve:
 * POST {baseUrl}/rerank {model, query, documents} ->
 * {results: [{index, relevance_score}]}. Throws on any failure.
 */
export async function rerank(
  reranker: Reranker,
  query: string,
  documents: string[],
  timeoutMs = TIMEOUT_MS,
): Promise<number[]> {
  if (documents.length === 0) return [];
  const res = await fetch(`${reranker.baseUrl.replace(/\/+$/, "")}/rerank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(reranker.apiKey
        ? { Authorization: `Bearer ${reranker.apiKey}` }
        : {}),
    },
    body: JSON.stringify({
      model: reranker.model,
      query,
      documents,
      top_n: documents.length,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(
      `reranker answered ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as {
    results?: { index: number; relevance_score?: number; score?: number }[];
  };
  if (!Array.isArray(body.results)) {
    throw new Error("reranker answered without results");
  }
  const scores = documents.map(() => Number.NEGATIVE_INFINITY);
  for (const r of body.results) {
    const score = r.relevance_score ?? r.score;
    if (typeof score === "number" && r.index >= 0 && r.index < scores.length) {
      scores[r.index] = score;
    }
  }
  return scores;
}

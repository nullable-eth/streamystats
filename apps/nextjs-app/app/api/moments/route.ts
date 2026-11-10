import type { NextRequest } from "next/server";
import { embedTextForServer } from "@/lib/ai/embed-text";
import { requireAuth } from "@/lib/api-auth";
import { findMoments, momentScope } from "@/lib/db/moments";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * GET /api/moments
 * Where in a title something is said or happens, to start playback there.
 *
 * Query params:
 * - itemId: Jellyfin ID of a movie or episode, or of a series to search all
 *   its episodes (required)
 * - q: the line, or what happens (required)
 * - limit: moments to return, best first (default 3, max 10)
 *
 * Moments come from the title's transcript, so they cover what is said;
 * titles without one return none. Each moment has `itemId` (the episode, for
 * a series), `startMs` (when the matching line starts, or its two-minute
 * window when no single line matches: `precision` "line" or "window"),
 * `endMs` (the window's end) and `line` (the matching dialogue).
 *
 * Example:
 *   GET /api/moments?itemId=abc123&q=60%25%20of%20the%20time%20it%20works%20every%20time
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth.error) return auth.error;
  const { session } = auth;

  const params = request.nextUrl.searchParams;
  const itemId = params.get("itemId");
  const query = params.get("q")?.trim();
  if (!itemId || !query) {
    return jsonResponse({ error: "itemId and q are required" }, 400);
  }
  const limit = Math.min(
    10,
    Math.max(1, Number.parseInt(params.get("limit") ?? "3", 10) || 3),
  );

  const scope = await momentScope({
    serverId: session.serverId,
    userId: session.isAdmin ? undefined : session.id,
    itemId,
  });
  if (scope.length === 0) {
    return jsonResponse({ error: "Item not found" }, 404);
  }

  // Without an embedding model the exact wording still finds a line.
  const embed = await embedTextForServer({
    serverId: session.serverId,
    text: query,
  });
  const moments = await findMoments({
    serverId: session.serverId,
    itemIds: scope.map((s) => s.id),
    query,
    embedding: embed.ok ? embed.embedding : null,
    limit,
  });
  return jsonResponse({ data: { itemId, moments } });
}

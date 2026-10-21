"use server";

import { rerank } from "@/lib/ai/rerank";
import {
  clearRerankerConfig,
  getRerankerConfig,
  type RerankerConfig,
  saveRerankerConfig,
} from "@/lib/db/server";
import { isUserAdmin } from "@/lib/db/users";

async function requireAdmin(serverId: number) {
  if (!(await isUserAdmin(serverId))) {
    throw new Error("Admin privileges required");
  }
}

export async function saveRerankerConfigAction(
  serverId: number,
  config: RerankerConfig,
) {
  await requireAdmin(serverId);
  await saveRerankerConfig({ serverId, config });
}

export async function clearRerankerConfigAction(serverId: number) {
  await requireAdmin(serverId);
  await clearRerankerConfig({ serverId });
}

/**
 * Ask the reranker to tell a passage that answers a query from one that
 * doesn't. Without a new key, the saved one, for the same address only.
 */
export async function testRerankerAction(
  serverId: number,
  config: RerankerConfig,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin(serverId);
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  let apiKey = config.apiKey || null;
  if (!apiKey) {
    const saved = await getRerankerConfig({ serverId });
    if (saved && saved.baseUrl === baseUrl) apiKey = saved.apiKey;
  }
  try {
    const [right, wrong] = await rerank(
      { baseUrl, apiKey, model: config.model },
      "a robot left alone on Earth cleans up the trash",
      [
        "WALL-E compacts garbage on an abandoned Earth for 700 years.",
        "A family drives across the country to a beauty pageant.",
      ],
      15_000,
    );
    return right > wrong
      ? { success: true, message: "The reranker works." }
      : {
          success: false,
          message:
            "The reranker answered, but scored the wrong passage higher: is the model a reranker?",
        };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

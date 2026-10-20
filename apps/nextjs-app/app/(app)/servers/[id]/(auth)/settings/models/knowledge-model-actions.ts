"use server";

import { revalidatePath } from "next/cache";
import {
  getKnowledgeModelConfig,
  moveKnowledgeModel,
  removeKnowledgeModel,
  saveKnowledgeModel,
  setKnowledgeModelEnabled,
  setKnowledgeModelRewrite,
} from "@/lib/db/knowledge-models";
import { type ChatAIConfig, testChatConnection } from "@/lib/db/server";
import { isUserAdmin } from "@/lib/db/users";
import { startKnowledgeRun } from "@/lib/knowledge-run";

async function requireAdmin(serverId: number) {
  if (!(await isUserAdmin(serverId))) {
    throw new Error("Admin privileges required");
  }
}

const refresh = (serverId: number) =>
  revalidatePath(`/servers/${serverId}/settings/models`);

export async function saveKnowledgeModelAction(
  serverId: number,
  input: ChatAIConfig & { id?: number; parallelRequests?: number | null },
) {
  await requireAdmin(serverId);
  await saveKnowledgeModel(serverId, input);
  refresh(serverId);
  await startKnowledgeRun(serverId);
}

export async function removeKnowledgeModelAction(serverId: number, id: number) {
  await requireAdmin(serverId);
  await removeKnowledgeModel(serverId, id);
  refresh(serverId);
}

export async function setKnowledgeModelEnabledAction(
  serverId: number,
  id: number,
  enabled: boolean,
) {
  await requireAdmin(serverId);
  await setKnowledgeModelEnabled(serverId, id, enabled);
  refresh(serverId);
  if (enabled) await startKnowledgeRun(serverId);
}

export async function setKnowledgeModelRewriteAction(
  serverId: number,
  id: number,
  from: string,
  on: boolean,
) {
  await requireAdmin(serverId);
  await setKnowledgeModelRewrite(serverId, id, from, on);
  refresh(serverId);
  if (on) await startKnowledgeRun(serverId);
}

export async function moveKnowledgeModelAction(
  serverId: number,
  id: number,
  direction: -1 | 1,
) {
  await requireAdmin(serverId);
  await moveKnowledgeModel(serverId, id, direction);
  refresh(serverId);
}

/** Test settings as entered; without a new key, a listed model's saved one (same provider and address only). */
export async function testKnowledgeModelAction(
  serverId: number,
  config: ChatAIConfig,
  id?: number,
): Promise<{ success: boolean; message: string }> {
  await requireAdmin(serverId);
  if (!config.apiKey && id !== undefined) {
    const saved = await getKnowledgeModelConfig(serverId, id);
    if (
      saved?.provider === config.provider &&
      saved.baseUrl.replace(/\/+$/, "") === config.baseUrl.replace(/\/+$/, "")
    ) {
      return testChatConnection({
        config: { ...config, apiKey: saved.apiKey },
      });
    }
  }
  return testChatConnection({ config });
}

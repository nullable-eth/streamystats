"use server";

import { revalidatePath } from "next/cache";
import {
  setKnowledgeIndexEnabled,
  setKnowledgeItemTypes,
  setKnowledgeWikipedia,
} from "@/lib/db/knowledge-index";
import { isUserAdmin } from "@/lib/db/users";

export async function setKnowledgeIndexEnabledAction(
  serverId: number,
  enabled: boolean,
) {
  if (!(await isUserAdmin(serverId))) {
    throw new Error("Admin privileges required");
  }
  await setKnowledgeIndexEnabled(serverId, enabled);
  revalidatePath(`/servers/${serverId}/settings/ai`);
}

export async function setKnowledgeItemTypesAction(
  serverId: number,
  types: string[],
) {
  if (!(await isUserAdmin(serverId))) {
    throw new Error("Admin privileges required");
  }
  await setKnowledgeItemTypes(serverId, types);
  revalidatePath(`/servers/${serverId}/settings/ai`);
}

export async function setKnowledgeWikipediaAction(
  serverId: number,
  enabled: boolean,
) {
  if (!(await isUserAdmin(serverId))) {
    throw new Error("Admin privileges required");
  }
  await setKnowledgeWikipedia(serverId, enabled);
  revalidatePath(`/servers/${serverId}/settings/ai`);
}

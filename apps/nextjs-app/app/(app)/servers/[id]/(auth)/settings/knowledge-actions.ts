"use server";

import { revalidatePath } from "next/cache";
import { setKnowledgeIndexEnabled } from "@/lib/db/knowledge-index";
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

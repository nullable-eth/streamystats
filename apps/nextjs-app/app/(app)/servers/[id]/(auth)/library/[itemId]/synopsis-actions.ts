"use server";

import { revalidatePath } from "next/cache";
import { writeSynopsesNext } from "@/lib/db/knowledge-index";
import { isUserAdmin } from "@/lib/db/users";

/** Put the item's synopses still to be written at the front of the queue; how many. */
export async function writeSynopsesNextAction(
  serverId: number,
  itemId: string,
): Promise<number> {
  if (!(await isUserAdmin(serverId))) {
    throw new Error("Admin privileges required");
  }
  const asked = await writeSynopsesNext(serverId, itemId);
  revalidatePath(`/servers/${serverId}/library/${itemId}`);
  return asked;
}

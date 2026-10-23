import { db, itemTextChunks } from "@streamystats/database";
import { inArray, sql } from "drizzle-orm";

/**
 * Hand an item's knowledge index texts (subtitles read, synopsis, Wikipedia
 * plot), their search windows, the models' refusals to write it and the texts
 * it must not use to the item Jellyfin re-added it as, such as after the file
 * was moved or renamed, so it isn't read and written again.
 * A ready text replaces one the new item has that isn't ready; one the new
 * item already has ready stays. Returns how many texts moved.
 */
export async function moveKnowledgeTexts(oldItemId: string, newItemId: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM item_texts n USING item_texts o
      WHERE n.item_id = ${newItemId} AND o.item_id = ${oldItemId}
        AND o.kind = n.kind AND o.status = 'ready' AND n.status <> 'ready'`);
    const moved = await tx.execute<{ id: number }>(sql`
      UPDATE item_texts o SET item_id = ${newItemId}
      WHERE o.item_id = ${oldItemId}
        AND NOT EXISTS (SELECT 1 FROM item_texts n WHERE n.item_id = ${newItemId} AND n.kind = o.kind)
      RETURNING o.id`);
    const ids = Array.from(moved, (r) => r.id);
    if (ids.length > 0) {
      await tx.update(itemTextChunks).set({ itemId: newItemId }).where(inArray(itemTextChunks.itemTextId, ids));
    }
    // The same title: the models that declined it would decline it again.
    await tx.execute(sql`
      UPDATE knowledge_refusals o SET item_id = ${newItemId}
      WHERE o.item_id = ${oldItemId}
        AND NOT EXISTS (SELECT 1 FROM knowledge_refusals n WHERE n.item_id = ${newItemId} AND n.model = o.model)`);
    // And the texts it must not use: the same files are still wrong for it.
    await tx.execute(sql`
      UPDATE knowledge_rejected_texts o SET item_id = ${newItemId}
      WHERE o.item_id = ${oldItemId}
        AND NOT EXISTS (SELECT 1 FROM knowledge_rejected_texts n
                        WHERE n.item_id = ${newItemId} AND n.kind = o.kind AND n.content_hash = o.content_hash)`);
    return ids.length;
  });
}

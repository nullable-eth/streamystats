-- Episodes without a Wikipedia article of their own are now also looked up in
-- their series' episode lists: look again at those found missing before,
-- rather than in up to 30 days.
UPDATE "item_texts" SET "checked_at" = 'epoch'
WHERE "kind" = 'reference' AND "status" = 'missing'
  AND "item_id" IN (SELECT "id" FROM "items" WHERE "type" = 'Episode');

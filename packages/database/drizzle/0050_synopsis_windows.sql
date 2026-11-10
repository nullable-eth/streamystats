ALTER TABLE "item_text_chunks" ALTER COLUMN "start_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "item_text_chunks" ALTER COLUMN "end_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "item_text_chunks" ADD COLUMN "kind" text DEFAULT 'transcript' NOT NULL;--> statement-breakpoint
ALTER TABLE "item_texts" ADD COLUMN "cue_starts_ms" integer[];--> statement-breakpoint
CREATE INDEX "item_text_chunks_text_idx" ON "item_text_chunks" USING btree ("item_text_id");
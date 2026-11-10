CREATE TABLE "knowledge_rejected_texts" (
	"item_id" text NOT NULL,
	"kind" text NOT NULL,
	"content_hash" text NOT NULL,
	"reason" text,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_rejected_texts_item_id_kind_content_hash_pk" PRIMARY KEY("item_id","kind","content_hash")
);
--> statement-breakpoint
ALTER TABLE "knowledge_rejected_texts" ADD CONSTRAINT "knowledge_rejected_texts_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
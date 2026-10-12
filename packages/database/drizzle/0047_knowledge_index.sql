CREATE TABLE "item_text_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_text_id" integer NOT NULL,
	"server_id" integer NOT NULL,
	"item_id" text NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
--> statement-breakpoint
CREATE TABLE "item_texts" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"item_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"source" text,
	"content" text DEFAULT '' NOT NULL,
	"content_hash" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_texts_item_kind_unique" UNIQUE("item_id","kind")
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "knowledge_index_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_text_chunks" ADD CONSTRAINT "item_text_chunks_item_text_id_item_texts_id_fk" FOREIGN KEY ("item_text_id") REFERENCES "public"."item_texts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_text_chunks" ADD CONSTRAINT "item_text_chunks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_text_chunks" ADD CONSTRAINT "item_text_chunks_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_texts" ADD CONSTRAINT "item_texts_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_texts" ADD CONSTRAINT "item_texts_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_text_chunks_item_idx" ON "item_text_chunks" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "item_text_chunks_server_idx" ON "item_text_chunks" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "item_text_chunks_search_idx" ON "item_text_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "item_texts_server_kind_idx" ON "item_texts" USING btree ("server_id","kind");
CREATE TABLE "knowledge_refusals" (
	"item_id" text NOT NULL,
	"model" text NOT NULL,
	"reason" text,
	"refused_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_refusals_item_id_model_pk" PRIMARY KEY("item_id","model")
);
--> statement-breakpoint
ALTER TABLE "knowledge_refusals" ADD CONSTRAINT "knowledge_refusals_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;
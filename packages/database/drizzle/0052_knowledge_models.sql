CREATE TABLE "knowledge_models" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"position" integer NOT NULL,
	"provider" text NOT NULL,
	"base_url" text,
	"api_key" text,
	"model" text NOT NULL,
	"input_price" double precision DEFAULT 0 NOT NULL,
	"output_price" double precision DEFAULT 0 NOT NULL,
	"monthly_budget" double precision,
	"spent_month" text,
	"spent" double precision DEFAULT 0 NOT NULL,
	"titles" integer DEFAULT 0 NOT NULL,
	"unavailable_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_texts" ADD COLUMN "written_by" text;--> statement-breakpoint
ALTER TABLE "knowledge_models" ADD CONSTRAINT "knowledge_models_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_models_server_idx" ON "knowledge_models" USING btree ("server_id","position");--> statement-breakpoint
-- The knowledge index model, where one was set, becomes the first (and only) one in the list.
INSERT INTO "knowledge_models" ("server_id", "position", "provider", "base_url", "api_key", "model")
SELECT "id", 0, "synopsis_provider", "synopsis_base_url", "synopsis_api_key", "synopsis_model" FROM "servers"
WHERE "synopsis_provider" IS NOT NULL AND "synopsis_model" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN "synopsis_provider";--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN "synopsis_base_url";--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN "synopsis_api_key";--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN "synopsis_model";
CREATE TABLE "user_item_ratings" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"rating" double precision NOT NULL,
	"review" text,
	"rated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_item_ratings_unique" UNIQUE("server_id","user_id","source","source_key")
);
--> statement-breakpoint
CREATE TABLE "user_recommendation_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"likes_text" text DEFAULT '' NOT NULL,
	"dislikes_text" text DEFAULT '' NOT NULL,
	"like_themes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dislike_themes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"use_watch_history" boolean DEFAULT true NOT NULL,
	"exclude_started" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_recommendation_profiles_server_user_unique" UNIQUE("server_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "user_item_ratings" ADD CONSTRAINT "user_item_ratings_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_item_ratings" ADD CONSTRAINT "user_item_ratings_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_recommendation_profiles" ADD CONSTRAINT "user_recommendation_profiles_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_item_ratings_server_user_rating_idx" ON "user_item_ratings" USING btree ("server_id","user_id","rating");--> statement-breakpoint
CREATE INDEX "user_item_ratings_item_idx" ON "user_item_ratings" USING btree ("item_id");
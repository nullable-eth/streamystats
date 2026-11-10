ALTER TABLE "knowledge_models" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "knowledge_models" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "chat_name" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "embedding_name" text;
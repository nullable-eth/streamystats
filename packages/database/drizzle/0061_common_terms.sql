CREATE TABLE "item_text_common_terms" (
	"kind" text NOT NULL,
	"term" text NOT NULL,
	"windows" integer NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_text_common_terms_kind_term_pk" PRIMARY KEY("kind","term")
);

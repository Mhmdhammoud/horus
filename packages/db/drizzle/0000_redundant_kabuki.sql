CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"timestamp" timestamp with time zone,
	"relevance" real DEFAULT 0 NOT NULL,
	"payload" jsonb,
	"links" jsonb,
	"provenance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"statement" text NOT NULL,
	"score" real DEFAULT 0 NOT NULL,
	"supporting_evidence" uuid[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investigations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"incident_input" jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"summary" text,
	"narrative" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_cache" (
	"provider" text NOT NULL,
	"cache_key" text NOT NULL,
	"payload" jsonb,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_cache_provider_cache_key_pk" PRIMARY KEY("provider","cache_key")
);
--> statement-breakpoint
CREATE TABLE "queue_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_name" text NOT NULL,
	"producer_symbol" text,
	"producer_file" text,
	"worker_symbol" text,
	"worker_file" text,
	"source" text DEFAULT 'stitcher' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"last_indexed_at" timestamp with time zone,
	"axon_status" jsonb,
	"stale" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repositories_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_investigation_idx" ON "evidence" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "hypotheses_investigation_idx" ON "hypotheses" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "queue_edges_queue_name_idx" ON "queue_edges" USING btree ("queue_name");
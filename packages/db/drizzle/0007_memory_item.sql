CREATE TABLE "memory_item" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"claim" text NOT NULL,
	"scope" text NOT NULL,
	"source" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real NOT NULL,
	"status" text DEFAULT 'fresh' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_verified_hash" text,
	"org_id" text,
	"workspace_id" text,
	"repo" text NOT NULL,
	"user_id" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "memory_link" (
	"id" text PRIMARY KEY NOT NULL,
	"from_memory_id" text NOT NULL,
	"rel" text NOT NULL,
	"to_kind" text NOT NULL,
	"to_ref" text NOT NULL,
	"to_file_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"memory_id" text NOT NULL,
	"action" text NOT NULL,
	"actor" jsonb NOT NULL,
	"from_status" text,
	"to_status" text,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_link" ADD CONSTRAINT "memory_link_from_memory_id_memory_item_id_fk" FOREIGN KEY ("from_memory_id") REFERENCES "public"."memory_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_audit" ADD CONSTRAINT "memory_audit_memory_id_memory_item_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."memory_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_item_repo_idx" ON "memory_item" USING btree ("repo");--> statement-breakpoint
CREATE INDEX "memory_item_scope_idx" ON "memory_item" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "memory_item_status_idx" ON "memory_item" USING btree ("status");--> statement-breakpoint
CREATE INDEX "memory_item_tenancy_idx" ON "memory_item" USING btree ("org_id","workspace_id","repo","user_id");--> statement-breakpoint
CREATE INDEX "memory_link_from_idx" ON "memory_link" USING btree ("from_memory_id");--> statement-breakpoint
CREATE INDEX "memory_link_to_idx" ON "memory_link" USING btree ("to_kind","to_ref");--> statement-breakpoint
CREATE INDEX "memory_audit_memory_idx" ON "memory_audit" USING btree ("memory_id");

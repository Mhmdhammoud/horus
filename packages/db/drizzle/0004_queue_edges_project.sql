ALTER TABLE "queue_edges" ADD COLUMN "project" text;--> statement-breakpoint
CREATE INDEX "queue_edges_source_project_idx" ON "queue_edges" ("source","project");

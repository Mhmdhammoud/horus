ALTER TABLE "incident_memory" ADD COLUMN "project" text;--> statement-breakpoint
UPDATE "incident_memory" im
SET "project" = (
  SELECT i.incident_input->>'repo'
  FROM "investigations" i
  WHERE i.id = im.investigation_id
    AND i.incident_input->>'repo' IS NOT NULL
)
WHERE im.investigation_id IS NOT NULL AND im.project IS NULL;--> statement-breakpoint
CREATE INDEX "incident_memory_project_idx" ON "incident_memory" ("project");

ALTER TABLE "memory_item" ADD COLUMN "signature" text;--> statement-breakpoint
ALTER TABLE "memory_item" ADD COLUMN "tags" text[];--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_item_signature_idx" ON "memory_item" ("signature");

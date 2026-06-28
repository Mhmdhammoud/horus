CREATE TABLE "outcome_label" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"investigation_id" uuid,
	"project" text,
	"resolved" text NOT NULL,
	"confirmed_cause" text,
	"note" text,
	"source" text NOT NULL,
	"payload" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outcome_label" ADD CONSTRAINT "outcome_label_investigation_id_investigations_id_fk" FOREIGN KEY ("investigation_id") REFERENCES "public"."investigations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outcome_label_investigation_idx" ON "outcome_label" USING btree ("investigation_id");--> statement-breakpoint
CREATE INDEX "outcome_label_project_idx" ON "outcome_label" USING btree ("project");--> statement-breakpoint
CREATE INDEX "outcome_label_at_idx" ON "outcome_label" USING btree ("at");

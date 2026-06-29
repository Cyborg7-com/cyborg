-- Scheduler phase 2 (#619): run-history table + schedule lifecycle columns.
--
-- Additive + backward-compatible. IF NOT EXISTS / guarded constraint + column
-- adds keep this a safe no-op on a DB that already has them (matching the repo's
-- hand-applied-prod convention — see 0001_message_search_tsv.sql /
-- 0002_webhooks_and_message_card.sql). The PG `schedule_runs` table is a
-- write-only mirror for visibility; the daemon's SQLite stays authoritative.

CREATE TABLE IF NOT EXISTS "schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"status" text NOT NULL,
	"skip_reason" text,
	"agent_id" text,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "max_runs" integer;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "run_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "catch_up" boolean DEFAULT true NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedule_runs_schedule" ON "schedule_runs" USING btree ("schedule_id","started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedule_runs_workspace" ON "schedule_runs" USING btree ("workspace_id","started_at");

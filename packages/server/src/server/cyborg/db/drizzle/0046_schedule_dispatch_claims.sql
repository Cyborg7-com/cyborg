-- 0044_schedule_dispatch_claims.sql
-- Cross-daemon exactly-once guard for the RAW-PROMPT cron path (schedules whose
-- task_id IS NULL — e.g. "every morning DM Seb a market brief").
--
-- The PER-TASK path already has an atomic cross-process guard (claimTaskDispatch,
-- the tasks.last_dispatched_at window). The raw-prompt path had ONLY an in-PROCESS
-- inFlight Set, so when the SAME due schedule is present on more than one daemon
-- EACH daemon fired it → duplicate channel posts + duplicate visible cybo sessions.
--
-- This table is the per-(schedule, fired-slot) atomic claim: the daemon that wins
-- a slot INSERTs its (schedule_id, scheduled_for) row; every other daemon conflicts
-- on the primary key and skips the fire. Mirrors the claimTaskDispatch primitive.
--
-- Additive + IDEMPOTENT (CREATE TABLE / CONSTRAINT IF NOT EXISTS), matching the
-- repo's hand-applied-prod convention (see 0004_schedule_runs_and_lifecycle.sql /
-- 0022_tasks_watcher_dispatch.sql). Safe to run twice.

CREATE TABLE IF NOT EXISTS "schedule_dispatch_claims" (
	"schedule_id" text NOT NULL,
	"scheduled_for" bigint NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	CONSTRAINT "schedule_dispatch_claims_pkey" PRIMARY KEY ("schedule_id","scheduled_for")
);
--> statement-breakpoint
-- Deleting a schedule clears its dispatch claims (no orphan rows the cron runner
-- would never revisit). Guarded so a re-run is a no-op on an already-migrated DB.
DO $$ BEGIN
	ALTER TABLE "schedule_dispatch_claims" ADD CONSTRAINT "schedule_dispatch_claims_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

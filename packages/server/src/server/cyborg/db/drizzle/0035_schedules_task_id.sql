-- schedules.task_id: per-task scheduling. A schedule may be BOUND to a task —
-- the cron runner then fires that task (run as its assignee cybo, unattended),
-- respecting the workspace agent_autonomy_enabled toggle — instead of delivering
-- the schedule's raw prompt as a cybo turn. NULL = a raw-prompt cybo schedule
-- (today's behaviour, unchanged).
--
-- FK ON DELETE CASCADE: deleting the task drops its schedule, so the runner never
-- fires against a ghost task (mirrors the cybo/channel FK guards on this table).
-- Index idx_schedules_task backs the relay's denormalization of a task's bound
-- schedule onto the wire Task (task list/detail), looked up by task_id.
--
-- Additive + backward-compatible + IDEMPOTENT (ADD COLUMN / CREATE INDEX IF NOT
-- EXISTS), matching the repo's hand-applied-prod convention — see
-- 0033_terminal_aliases.sql / 0028_daemon_access_requests.sql and
-- drizzle/RUNBOOK.md. Hand-authored because drizzle-kit generate is blocked by the
-- pre-existing 0008/0009/0010 snapshot collision; the runtime migrator applies
-- plain .sql + _journal.json. Safe no-op on a DB that already has the column.
--
-- BACK-COMPAT: existing schedule rows get task_id = NULL (raw-prompt schedules),
-- so the runner's behaviour for them is unchanged.
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "task_id" text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "schedules" ADD CONSTRAINT "schedules_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_task" ON "schedules" USING btree ("task_id");

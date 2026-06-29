-- 0022_tasks_watcher_dispatch.sql
-- Tasks Phase 2 (channel watcher) + Phase 3 (agent execute-dispatch).
--
-- Additive + IDEMPOTENT (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS),
-- matching the repo's hand-applied-prod convention. Hand-authored because
-- drizzle-kit generate is blocked by the pre-existing 0008/0009/0010 snapshot
-- collision; the runtime migrator applies plain .sql + _journal.json. Safe to
-- run twice.

-- Phase 2: per-channel auto-tasks (watcher) switch. NULL/false = OFF (opt-in).
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "auto_tasks_enabled" boolean;
--> statement-breakpoint

-- Phase 2: the channel a watcher-created task is bound to (where to post results).
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "channel_id" text;
--> statement-breakpoint
-- Phase 2: optional board priority (free text, e.g. low|medium|high|urgent).
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "priority" text;
--> statement-breakpoint

-- Phase 3: atomic dispatch claim (NULL/stale => claimable) + recurrence guards.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "last_dispatched_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "recurrence_spawned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "recurrence_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Phase 3: due-task selection by the schedule-runner tick (status + dueAt window).
CREATE INDEX IF NOT EXISTS "idx_tasks_due" ON "tasks" USING btree ("status","due_at");
--> statement-breakpoint
-- Phase 3: owned-task catch-up by assignee on daemon reconnect.
CREATE INDEX IF NOT EXISTS "idx_tasks_assignee" ON "tasks" USING btree ("workspace_id","assignee_id");

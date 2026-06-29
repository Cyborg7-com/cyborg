-- 0030_cycles_modules.sql
-- Tasks Redesign P0 — cycles (sprints) + modules (feature groupings).
--
-- Additive + IDEMPOTENT (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS), matching the repo's hand-applied-prod convention. Hand-authored
-- (drizzle-kit generate blocked by the pre-existing snapshot collision); the
-- runtime migrator applies plain .sql + _journal.json. Safe to run twice.

-- Cycles (sprints): a time-boxed bucket of a project's tasks. A task is in at most
-- one cycle (tasks.cycle_id below), so this is a plain table, not a join.
CREATE TABLE IF NOT EXISTS "cycles" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "tasks_projects"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"description" text,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"owned_by" text,
	"sort_order" real,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Single cycle per task. ON DELETE SET NULL so deleting a cycle un-buckets its
-- tasks rather than deleting them.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "cycle_id" text REFERENCES "cycles"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Modules (feature groupings): a many-to-many bucket of a project's tasks
-- (task_modules join), with its own lifecycle status.
CREATE TABLE IF NOT EXISTS "modules" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "tasks_projects"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"description" text,
	"start_date" timestamp with time zone,
	"target_date" timestamp with time zone,
	"status" text DEFAULT 'planned' NOT NULL,
	"lead" text,
	"sort_order" real,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint

-- Join table: which tasks belong to which modules (many-to-many).
CREATE TABLE IF NOT EXISTS "task_modules" (
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"module_id" text NOT NULL REFERENCES "modules"("id") ON DELETE CASCADE,
	CONSTRAINT "task_modules_pkey" PRIMARY KEY ("task_id","module_id")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_cycles_project" ON "cycles" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_modules_project" ON "modules" USING btree ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_modules_module" ON "task_modules" USING btree ("module_id");

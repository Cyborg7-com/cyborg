-- 0028_tasks_projects_states.sql
-- Tasks Redesign P0 — Plane-style projects + workflow states + task hierarchy.
--
-- Additive + IDEMPOTENT (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS), matching the repo's hand-applied-prod convention. Hand-authored
-- because drizzle-kit generate is blocked by the pre-existing 0008/0009/0010
-- snapshot collision; the runtime migrator applies plain .sql + _journal.json.
-- Safe to run twice.

-- One Tasks-project per chat project (1:1 via chat_project_id), plus a synthetic
-- per-workspace "Inbox" (chat_project_id NULL). identifier is the task-key prefix
-- (uppercase, <=8, unique per workspace); sequence_counter is the high-water mark
-- handed out as the next task's per-project sequence_id.
CREATE TABLE IF NOT EXISTS "tasks_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"chat_project_id" text UNIQUE REFERENCES "projects"("id") ON DELETE CASCADE,
	"identifier" text NOT NULL,
	"sequence_counter" integer DEFAULT 0 NOT NULL,
	"cycles_enabled" boolean DEFAULT true NOT NULL,
	"modules_enabled" boolean DEFAULT true NOT NULL,
	"pages_enabled" boolean DEFAULT true NOT NULL,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- Per-project workflow states (the board columns). group buckets a state into one
-- of Plane's five canonical phases (backlog|unstarted|started|completed|cancelled)
-- so logic (and the legacy tasks.status mirror) can reason about progress.
CREATE TABLE IF NOT EXISTS "task_states" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "tasks_projects"("id") ON DELETE CASCADE,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"group" text NOT NULL,
	"sequence" real NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	CONSTRAINT "task_states_group_valid" CHECK ("group" IN ('backlog', 'unstarted', 'started', 'completed', 'cancelled'))
);
--> statement-breakpoint

-- The Tasks-project a task belongs to. ON DELETE CASCADE so a deleted Tasks-project
-- takes its tasks with it. Nullable for back-compat; 0031 backfills every row.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "project_id" text REFERENCES "tasks_projects"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- Sub-task parent (self-FK). ON DELETE SET NULL so deleting a parent promotes its
-- children to top-level rather than cascade-deleting them.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "parent_id" text REFERENCES "tasks"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Workflow state. ON DELETE SET NULL so deleting a state un-sets it. The legacy
-- free-text status column stays as the watcher/back-compat mirror of state.group.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "state_id" text REFERENCES "task_states"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Per-project human-facing sequence number (the N in "ENG-N"). Nullable until
-- assigned; 0031 backfills via ROW_NUMBER over created_at.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sequence_id" integer;
--> statement-breakpoint

-- Board column fetch (a project's tasks grouped by state).
CREATE INDEX IF NOT EXISTS "idx_tasks_project_state" ON "tasks" USING btree ("project_id","state_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_projects_workspace" ON "tasks_projects" USING btree ("workspace_id");
--> statement-breakpoint
-- The task-key prefix must be unique within a workspace.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_tasks_projects_workspace_identifier" ON "tasks_projects" USING btree ("workspace_id","identifier");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_states_project" ON "task_states" USING btree ("project_id");

-- 0039_github_bidirectional_pr.sql
-- GitHub integration Plane-parity: bidirectional issue sync direction + per-binding
-- issue state overrides, project-level PR-state → task-state mapping, a PR↔task
-- back-link table, and a personal-account OAuth connection table.
--
-- Additive + IDEMPOTENT (ALTER ... ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF
-- NOT EXISTS), matching 0034's hand-applied-prod convention. Hand-authored because
-- drizzle-kit generate is blocked by the pre-existing 0008/0009/0010 snapshot
-- collision; the runtime migrator applies plain .sql + _journal.json. Safe to run
-- twice.
--
-- Extends the inbound-only GitHub → Tasks sync (0034). Plain `text` is used for the
-- state-id columns (no DB FK) for parity with github_repo_syncs.installation_id:
-- the sync engine resolves-or-skips a stale state id at event time rather than
-- cascade-dropping a binding when a state is deleted.

-- Per-binding sync direction + issue state overrides (Image #4 "Select issue sync
-- direction" + "Configure Issue Sync State"). 'inbound' keeps the existing GH→Tasks
-- one-way behavior; 'bidirectional' enables write-back (wave 2). The two state ids
-- override getGithubSyncStates' default open/closed resolution when set.
ALTER TABLE "github_repo_syncs" ADD COLUMN IF NOT EXISTS "sync_direction" text DEFAULT 'inbound' NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_repo_syncs" ADD COLUMN IF NOT EXISTS "issue_open_state_id" text;
--> statement-breakpoint
ALTER TABLE "github_repo_syncs" ADD COLUMN IF NOT EXISTS "issue_closed_state_id" text;
--> statement-breakpoint

-- Project-level PR-state → task-state map (Image #3 "Pull Request State Mapping").
-- pr_state is one of the 6 GitHub PR states (DRAFT_MR_OPENED, MR_OPENED,
-- MR_READY_FOR_MERGE, MR_REVIEW_REQUESTED, MR_MERGED, MR_CLOSED). skip_backward
-- prevents a PR update from moving a task to an earlier state group. ON DELETE
-- CASCADE on tasks_project_id drops a project's mappings with the project.
CREATE TABLE IF NOT EXISTS "github_pr_state_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"tasks_project_id" text NOT NULL REFERENCES "tasks_projects"("id") ON DELETE CASCADE,
	"pr_state" text NOT NULL,
	"task_state_id" text,
	"skip_backward" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One row per synced GitHub pull request, back-linking it to the task it tracks.
-- ON DELETE CASCADE on both FKs: dropping the repo binding or the task removes the
-- link. The sync engine's hot path is (repo_sync_id, pr_number).
CREATE TABLE IF NOT EXISTS "github_pr_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_sync_id" text NOT NULL REFERENCES "github_repo_syncs"("id") ON DELETE CASCADE,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"pr_number" integer NOT NULL,
	"github_pr_id" text NOT NULL,
	"pr_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One row per personal GitHub account a workspace user connected via OAuth (Image
-- #3 "Connect Personal Account"). access_token is stored as returned by GitHub —
-- TODO(security): encrypt at rest in a follow-up. ON DELETE CASCADE on workspace_id.
CREATE TABLE IF NOT EXISTS "github_user_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL,
	"github_login" text NOT NULL,
	"access_token" text NOT NULL,
	"scopes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_github_pr_state_mappings_workspace" ON "github_pr_state_mappings" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_pr_state_mappings_project" ON "github_pr_state_mappings" USING btree ("tasks_project_id");
--> statement-breakpoint
-- A project maps each PR state at most once.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_pr_state_mappings_project_state" ON "github_pr_state_mappings" USING btree ("tasks_project_id","pr_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_pr_syncs_reposync" ON "github_pr_syncs" USING btree ("repo_sync_id");
--> statement-breakpoint
-- The sync engine's hot path: find the task for an inbound (binding, PR number).
-- UNIQUE so concurrent PR webhooks can't create duplicate links.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_pr_syncs_reposync_number" ON "github_pr_syncs" USING btree ("repo_sync_id","pr_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_user_connections_workspace" ON "github_user_connections" USING btree ("workspace_id");
--> statement-breakpoint
-- One personal connection per (workspace, user).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_user_connections_workspace_user" ON "github_user_connections" USING btree ("workspace_id","user_id");

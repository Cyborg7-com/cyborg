-- 0034_github_sync.sql
-- GitHub App → Tasks one-way issue sync (GH issues → Cyborg7 tasks).
--
-- Additive + IDEMPOTENT (CREATE TABLE/INDEX IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention. Hand-authored because drizzle-kit generate is
-- blocked by the pre-existing 0008/0009/0010 snapshot collision; the runtime
-- migrator applies plain .sql + _journal.json. Safe to run twice.
--
-- Modeled on the inbound webhooks/webhook_deliveries pair: GitHub is the source of
-- truth, the relay/daemon never writes back to GitHub in this phase.

-- One row per GitHub App INSTALLATION a workspace authorized. installation_id is
-- GitHub's numeric id (text — an opaque handle we mint tokens against). A workspace
-- may install the App on several accounts, so it is NOT unique per workspace; the
-- installation id itself is globally unique.
CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"installation_id" text NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text DEFAULT 'User' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One row per (repository ↔ Tasks-project) binding. A repo binds at the
-- tasks_project level (1 repo ↔ 1 tasks-project). ON DELETE CASCADE on
-- tasks_project_id so deleting a Tasks-project drops its bindings (and their
-- issue-sync rows). installation_id is plain text (not an FK) so a de-installed
-- account doesn't cascade-drop a binding the user may re-authorize.
CREATE TABLE IF NOT EXISTS "github_repo_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"installation_id" text NOT NULL,
	"tasks_project_id" text NOT NULL REFERENCES "tasks_projects"("id") ON DELETE CASCADE,
	"repo_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"repo_url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One row per synced GitHub issue, back-linking it to the task it created. ON
-- DELETE CASCADE on both FKs: dropping the repo binding or the task removes the
-- link. The receiver's hot path is (repo_sync_id, issue_number).
CREATE TABLE IF NOT EXISTS "github_issue_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_sync_id" text NOT NULL REFERENCES "github_repo_syncs"("id") ON DELETE CASCADE,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"issue_number" integer NOT NULL,
	"github_issue_id" text NOT NULL,
	"issue_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_github_installations_workspace" ON "github_installations" USING btree ("workspace_id");
--> statement-breakpoint
-- GitHub's installation id is globally unique; one row per install id.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_installations_installation" ON "github_installations" USING btree ("installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_repo_syncs_workspace" ON "github_repo_syncs" USING btree ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_repo_syncs_installation" ON "github_repo_syncs" USING btree ("installation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_repo_syncs_project" ON "github_repo_syncs" USING btree ("tasks_project_id");
--> statement-breakpoint
-- A repo binds to a given project at most once.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_repo_syncs_project_repo" ON "github_repo_syncs" USING btree ("tasks_project_id","repo_id");
--> statement-breakpoint
-- One link per (binding, task).
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_issue_syncs_reposync_task" ON "github_issue_syncs" USING btree ("repo_sync_id","task_id");
--> statement-breakpoint
-- The receiver's hot path: find the task for an inbound (binding, issue number).
-- UNIQUE so concurrent webhooks for the same issue can't create duplicate tasks.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_github_issue_syncs_reposync_number" ON "github_issue_syncs" USING btree ("repo_sync_id","issue_number");

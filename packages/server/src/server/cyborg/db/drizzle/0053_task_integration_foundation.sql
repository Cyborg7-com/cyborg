-- 0053_task_integration_foundation.sql
-- Provider-generic task-integration foundation — the DATA LAYER for the next wave of
-- external task providers (Jira + ClickUp task sync). The generic counterpart of the
-- github_* sync tables (0034/0039): every table carries a `provider` discriminator so
-- ONE set of tables serves all providers. PURELY ADDITIVE — the live github_* tables
-- are left untouched (explicit decision: don't migrate live GitHub sync; new providers
-- get these new generic tables).
--
-- Additive + IDEMPOTENT (CREATE TABLE/INDEX IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention (see 0034_github_sync.sql / 0047_slack_bridge.sql).
-- Hand-authored because drizzle-kit generate is blocked by the pre-existing
-- 0008/0009/0010 snapshot collision; the runtime migrator applies plain .sql +
-- _journal.json (no per-migration meta/*_snapshot.json since 0011). Safe to run twice.
--
-- This locks the STORAGE contract ONLY. The adapters, webhook routes, OAuth, echo
-- guard, and UI ship in a SECOND change built on top of this data layer — nothing
-- here reads/writes any provider at runtime yet.
--
-- Tables:
--   project_syncs — the binding of a Cyborg tasks-project to an external provider
--     project (Jira project/board, ClickUp list). installation_id is loose text (no FK)
--     — parity with github_repo_syncs: a de-authorized install doesn't cascade-drop a
--     binding. UNIQUE(tasks_project_id, provider, external_project_id): a given external
--     project binds to a given (project, provider) at most once. index(provider,
--     external_project_id) serves the inbound webhook binding lookup (webhooks arrive
--     with only provider + external ids).
--   task_item_syncs — one row per synced external item ↔ Cyborg task. item_number is
--     TEXT (Jira PROJ-123 / ClickUp task id — not integers, unlike GitHub);
--     provider_item_id is the opaque stable id; last_synced_hash is the engine's durable
--     echo backstop. FKs CASCADE on binding + task. UNIQUE(project_sync_id, task_id) =
--     one link per (binding, task); UNIQUE(project_sync_id, item_type, item_number) =
--     the receiver's hot inbound key (concurrent webhooks can't dup a task).
--   status_mappings — per-binding source-status → Cyborg task-state map. task_state_id
--     is loose text (no FK) — resolve-or-fallback at event time.
--     UNIQUE(project_sync_id, source_status_name): each source status maps once.
--   provider_user_connections — reverse Cyborg-user → provider-user map for outbound
--     assignee write-back (wave 2). UNIQUE(workspace_id, provider, cyborg_user_id).

CREATE TABLE IF NOT EXISTS "project_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"installation_id" text,
	"tasks_project_id" text NOT NULL REFERENCES "tasks_projects"("id") ON DELETE CASCADE,
	"external_project_id" text NOT NULL,
	"external_project_name" text,
	"external_url" text,
	"sync_direction" text DEFAULT 'inbound' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_syncs_workspace" ON "project_syncs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_syncs_installation" ON "project_syncs" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_syncs_project" ON "project_syncs" USING btree ("tasks_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_project_syncs_project_provider_external" ON "project_syncs" USING btree ("tasks_project_id","provider","external_project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_syncs_provider_external" ON "project_syncs" USING btree ("provider","external_project_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_item_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_sync_id" text NOT NULL REFERENCES "project_syncs"("id") ON DELETE CASCADE,
	"task_id" text NOT NULL REFERENCES "tasks"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"item_type" text NOT NULL,
	"item_number" text NOT NULL,
	"provider_item_id" text NOT NULL,
	"item_url" text,
	"last_synced_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_item_syncs_projectsync_task" ON "task_item_syncs" USING btree ("project_sync_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_task_item_syncs_projectsync_item" ON "task_item_syncs" USING btree ("project_sync_id","item_type","item_number");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"project_sync_id" text NOT NULL REFERENCES "project_syncs"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"source_status_id" text,
	"source_status_name" text NOT NULL,
	"task_state_id" text,
	"skip_backward" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_status_mappings_workspace" ON "status_mappings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_status_mappings_projectsync" ON "status_mappings" USING btree ("project_sync_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_status_mappings_projectsync_source" ON "status_mappings" USING btree ("project_sync_id","source_status_name");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_user_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"cyborg_user_id" text NOT NULL,
	"external_user_id" text NOT NULL,
	"external_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_user_connections_workspace" ON "provider_user_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_provider_user_connections_ws_provider_user" ON "provider_user_connections" USING btree ("workspace_id","provider","cyborg_user_id");

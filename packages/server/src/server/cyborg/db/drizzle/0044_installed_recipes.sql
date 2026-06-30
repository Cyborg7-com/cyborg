-- 0044_installed_recipes.sql
-- Built-in integrations (recipes): one row per recipe install in a workspace.
--
-- A "recipe" is a preset automation (registry id: standup | retro | blocker_sweep)
-- that, when enabled, provisions a cybo (preset soul + permissions) + N schedules +
-- channel memberships. This row records the install; the provisioned ids (cybo_id +
-- schedule_ids) are stamped once the daemon creates them. Disabling deletes the cybo
-- (its FK cascade removes the schedules + channel memberships) and flips the row to
-- enabled=false, cybo_id=NULL, schedule_ids='[]' — kept for history, never hard-deleted.
--
-- Additive + IDEMPOTENT (CREATE TABLE/INDEX IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention — see 0043_composio_tools.sql / 0034_github_sync.sql.
-- Hand-authored because drizzle-kit generate is blocked by a pre-existing snapshot
-- collision; the runtime migrator applies plain .sql + _journal.json. A brand-new
-- table touches nothing existing, so a re-run is a safe no-op.
--
-- cybo_id is plain text (NOT an FK to cybos): a deleted cybo must NOT cascade-drop
-- this history row; the disable path nulls it explicitly, and a stale id
-- resolves-or-skips at read time (the loose coupling github_repo_syncs.installation_id
-- uses). workspace_id keeps its FK ON DELETE CASCADE so deleting a workspace cleans up.

CREATE TABLE IF NOT EXISTS "installed_recipes" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"recipe_id" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cybo_id" text,
	"schedule_ids" jsonb DEFAULT '[]'::jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One ACTIVE install per (workspace, recipe). Partial: only enabled rows
-- participate, so a disabled history row may sit alongside a fresh re-enable;
-- enableRecipe's INSERT ... ON CONFLICT targets exactly this partial index.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_installed_recipes_active" ON "installed_recipes" USING btree ("workspace_id","recipe_id") WHERE "enabled";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_installed_recipes_ws" ON "installed_recipes" USING btree ("workspace_id");

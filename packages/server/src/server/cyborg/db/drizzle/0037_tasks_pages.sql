-- tasks_pages: project pages (wiki/docs). A rich-text document scoped to a
-- project, with public/private visibility + archive. `content` is the serialized
-- editor doc (TipTap JSON) stored as text; "" = a blank page.
--
-- Additive + backward-compatible + IDEMPOTENT (CREATE TABLE IF NOT EXISTS),
-- matching the repo's hand-applied-prod convention — see 0033_terminal_aliases.sql
-- / 0031_cycles_modules.sql and drizzle/RUNBOOK.md. The runtime migrator applies
-- plain .sql + _journal.json. Safe no-op on a DB that already has it.
--
-- BACK-COMPAT: a brand-new table touched by nothing else. The project_id /
-- workspace_id FKs cascade-delete a project's pages with the project/workspace.
CREATE TABLE IF NOT EXISTS "tasks_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"owned_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tasks_pages" ADD CONSTRAINT "tasks_pages_project_id_tasks_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."tasks_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tasks_pages" ADD CONSTRAINT "tasks_pages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_pages_project" ON "tasks_pages" ("project_id");

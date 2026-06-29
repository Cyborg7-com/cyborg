-- tasks_pages nesting: self-referential page hierarchy (Notion/Plane subpages).
--
-- Adds tasks_pages.parent_id (nullable self-FK → tasks_pages.id, ON DELETE SET
-- NULL so deleting a parent ORPHANS children to root, never cascade-deletes a
-- subtree) + tasks_pages.sort_order (sibling ordering, default 0) + an index on
-- parent_id for the children lookup.
--
-- Additive + backward-compatible + IDEMPOTENT (ADD COLUMN IF NOT EXISTS / the
-- DO $$ EXCEPTION guard), matching the repo's hand-applied-prod convention — see
-- 0037_tasks_pages.sql / 0038_tasks_pages_icon.sql and drizzle/RUNBOOK.md. The
-- runtime migrator applies plain .sql + _journal.json. Safe no-op on a DB that
-- already has the columns.
--
-- BACK-COMPAT: both columns are read by nothing pre-existing; old rows get
-- parent_id = NULL (root pages) and sort_order = 0. No NOT NULL backfill on
-- parent_id, so this is non-blocking on a live prod table.
ALTER TABLE "tasks_pages" ADD COLUMN IF NOT EXISTS "parent_id" text;--> statement-breakpoint
ALTER TABLE "tasks_pages" ADD COLUMN IF NOT EXISTS "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "tasks_pages" ADD CONSTRAINT "tasks_pages_parent_id_tasks_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks_pages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_pages_parent" ON "tasks_pages" ("parent_id");

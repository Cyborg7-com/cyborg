-- 0023_tasks_sort_archive_draft_startdate.sql
-- Tasks Phase 0 (Plane plane UI backend foundation).
--
-- Additive + IDEMPOTENT (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS),
-- matching the repo's hand-applied-prod convention. Hand-authored because
-- drizzle-kit generate is blocked by the pre-existing 0008/0009/0010 snapshot
-- collision; the runtime migrator applies plain .sql + _journal.json. Safe to
-- run twice (the sort_order backfill only touches rows still NULL).

-- Manual ordering within a (workspace,status) lane for drag-reorder layouts.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "sort_order" integer;
--> statement-breakpoint
-- Optional planned start of work (left edge of a Gantt bar; due_at is the right).
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "start_date" timestamp with time zone;
--> statement-breakpoint
-- Soft-archive timestamp. NULL = active; set = archived/hidden from default views.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
-- Draft flag for tasks not yet committed to the board.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "is_draft" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Backfill sort_order for existing rows: a stable 1..N sequence per
-- (workspace_id, status) lane ordered by created_at. Only fills rows still NULL,
-- so re-running is a no-op once every row has a value.
UPDATE "tasks" AS t
SET "sort_order" = s.rn
FROM (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "workspace_id", "status"
      ORDER BY "created_at"
    ) AS rn
  FROM "tasks"
  WHERE "sort_order" IS NULL
) AS s
WHERE t."id" = s."id" AND t."sort_order" IS NULL;
--> statement-breakpoint

-- Ordered fetch of a status lane for drag-reorder layouts.
CREATE INDEX IF NOT EXISTS "idx_tasks_workspace_sort" ON "tasks" USING btree ("workspace_id","status","sort_order");

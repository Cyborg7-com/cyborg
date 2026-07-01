-- 0049_task_labels_unique.sql
-- Enforce Django get_or_create semantics for task labels: exactly one label per
-- (project_id, case-insensitive name). task_labels had NO unique constraint, so the
-- non-atomic "look up by name else INSERT" resolver duplicated labels under races,
-- stale UI catalogs, and blind agent calls (e.g. 10x "Engeneering" in one project).
--
-- Additive + IDEMPOTENT, matching the repo's hand-applied-prod convention. A plain
-- unique index FAILS while duplicates exist, so this DEDUPS first, then creates the
-- index. Safe to run twice: after the first run there are no duplicates and the
-- index already exists, so every statement is a no-op.
--
-- ⚠️ This migration MUTATES existing label data on deploy — it merges duplicate
-- labels into one canonical row per (project, lower(name)) and repoints task
-- assignments onto it. Canonical row = the earliest by (sort_order, id) so the
-- oldest label (and its casing) wins; ties broken by id.

-- Step 1 — collapse duplicate assignee rows so at most ONE remains per
-- (task_id, canonical group). A task assigned to two DIFFERENT duplicate labels of
-- the same group (e.g. label 2 and label 3, both → canonical 1) with no canonical
-- assignment yet would otherwise have BOTH rows repointed to (task_id, 1) in Step 2's
-- single UPDATE — a self-collision on the task_label_assignees PK that fails the
-- migration. row_number keeps the assignee already on the canonical label if present,
-- else the one whose label sorts first (sort_order, id); the rest are deleted here.
WITH canon AS (
  SELECT
    id,
    sort_order,
    first_value(id) OVER (
      PARTITION BY project_id, lower(name)
      ORDER BY sort_order, id
    ) AS canonical_id
  FROM task_labels
),
ranked AS (
  SELECT
    tla.task_id,
    tla.label_id,
    row_number() OVER (
      PARTITION BY tla.task_id, c.canonical_id
      ORDER BY (tla.label_id = c.canonical_id) DESC, c.sort_order, c.id
    ) AS rn
  FROM task_label_assignees tla
  JOIN canon c ON c.id = tla.label_id
)
DELETE FROM task_label_assignees tla
 USING ranked r
 WHERE tla.task_id = r.task_id
   AND tla.label_id = r.label_id
   AND r.rn > 1;
--> statement-breakpoint

-- Step 2 — repoint the surviving duplicate assignees to their canonical label id.
-- After Step 1 there is at most one survivor per (task_id, canonical group), so this
-- UPDATE can never produce two rows with the same (task_id, canonical_id).
WITH canon AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY project_id, lower(name)
      ORDER BY sort_order, id
    ) AS canonical_id
  FROM task_labels
)
UPDATE task_label_assignees tla
   SET label_id = c.canonical_id
  FROM canon c
 WHERE c.id = tla.label_id
   AND c.canonical_id <> tla.label_id;
--> statement-breakpoint

-- Step 3 — delete the now-unreferenced duplicate label rows, keeping the canonical.
WITH canon AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY project_id, lower(name)
      ORDER BY sort_order, id
    ) AS canonical_id
  FROM task_labels
)
DELETE FROM task_labels tl
 USING canon c
 WHERE c.id = tl.id
   AND c.canonical_id <> tl.id;
--> statement-breakpoint

-- Step 4 — the constraint itself. Now that each (project_id, lower(name)) is unique,
-- this succeeds and becomes the resolver's ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_task_labels_project_lower_name"
  ON "task_labels" ("project_id", lower("name"));

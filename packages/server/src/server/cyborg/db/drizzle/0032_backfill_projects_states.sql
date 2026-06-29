-- 0031_backfill_projects_states.sql
-- Tasks Redesign P0 — forward-only backfill so the Tasks app isn't blank after
-- 0028–0030 (which only add empty structure). Creates one tasks_project per
-- existing chat project, a per-workspace "Inbox" for orphan tasks, five default
-- workflow states per project, then assigns every existing task a project, a
-- state, and a per-project sequence_id.
--
-- Idempotent + run-twice clean: every INSERT uses ON CONFLICT DO NOTHING with a
-- deterministic id derived from the source row, and every UPDATE is guarded by
-- "WHERE ... IS NULL" so a second run touches nothing. New rows created AFTER
-- this backfill get their project/state/sequence from the app layer, not here.

-- ── 1. One tasks_project per existing chat project ──
-- Deterministic id 'tp_' || project.id so re-running conflicts on the PK (no dup).
-- identifier = uppercased, non-alphanumerics stripped, truncated to 8 chars
-- ('base'); empty/degenerate names fall back to 'PROJ'. The identifier MUST be
-- unique per (workspace_id, identifier) or the unique index aborts the whole
-- migration, so it is made injective per workspace BY CONSTRUCTION (no reliance on
-- ON CONFLICT for the unique index, which a single INSERT can't arbiter alongside
-- the PK):
--   • A base used by exactly one project in the workspace stays bare (e.g. 'ENG').
--   • Any base shared by >1 project — OR equal to the reserved 'INBOX' (step 2's
--     synthetic project) — is suffixed with that project's workspace-global ordinal
--     'grn' (unique 1..N per workspace) behind a '-' delimiter: 'left(base, k)-grn'.
-- Why this can never collide within a workspace:
--   • Suffixed ids contain a '-'; bare ids (sanitized to [A-Z0-9]) never do, so the
--     two sets are disjoint — and a project named "Inbox" can't hit the synthetic
--     'INBOX' either, since 'INBOX' is forced into the suffixed set.
--   • Among bare ids only single-holder bases survive, so distinct bases ⇒ distinct.
--   • Among suffixed ids the trailing '-grn' is globally unique per workspace, so
--     they're distinct regardless of how the prefix truncates.
-- Length cap: k = GREATEST(8 - length(grn) - 1, 0) reserves room for '-' + grn, so
-- the result is always <= 8 chars even when grn is large (up to 9,999,999 rows).
INSERT INTO "tasks_projects" ("id", "workspace_id", "chat_project_id", "identifier", "sequence_counter", "created_at", "updated_at")
SELECT
	'tp_' || d."id",
	d."workspace_id",
	d."id",
	CASE
		WHEN d."cnt" = 1 AND d."base" <> 'INBOX' THEN d."base"
		ELSE left(d."base", GREATEST(8 - length(d."grn"::text) - 1, 0)) || '-' || d."grn"::text
	END,
	0,
	now(),
	now()
FROM (
	SELECT
		p2."id",
		p2."workspace_id",
		COALESCE(NULLIF(left(regexp_replace(upper(p2."name"), '[^A-Z0-9]', '', 'g'), 8), ''), 'PROJ') AS "base",
		-- how many projects in this workspace share the same base (>1 ⇒ suffix).
		COUNT(*) OVER (
			PARTITION BY p2."workspace_id", COALESCE(NULLIF(left(regexp_replace(upper(p2."name"), '[^A-Z0-9]', '', 'g'), 8), ''), 'PROJ')
		) AS "cnt",
		-- workspace-global ordinal: unique 1..N per workspace, the disambiguator.
		ROW_NUMBER() OVER (PARTITION BY p2."workspace_id" ORDER BY p2."id") AS "grn"
	FROM "projects" p2
) AS d
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ── 2. One synthetic "Inbox" tasks_project per workspace (orphan tasks) ──
-- Deterministic id 'tp_inbox_' || workspace.id; chat_project_id NULL. Only for
-- workspaces that actually have tasks (keeps empty workspaces clean).
INSERT INTO "tasks_projects" ("id", "workspace_id", "chat_project_id", "identifier", "sequence_counter", "created_at", "updated_at")
SELECT DISTINCT
	'tp_inbox_' || t."workspace_id",
	t."workspace_id",
	NULL,
	'INBOX',
	0,
	now(),
	now()
FROM "tasks" t
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ── 3. Five default workflow states per tasks_project ──
-- Deterministic ids 'ts_' || project.id || '_' || group so re-running conflicts on
-- the PK. is_default on the unstarted (Todo) state. sequence orders the columns.
INSERT INTO "task_states" ("id", "project_id", "workspace_id", "name", "color", "group", "sequence", "is_default")
SELECT 'ts_' || tp."id" || '_backlog',   tp."id", tp."workspace_id", 'Backlog',     '#9ca3af', 'backlog',   1, false FROM "tasks_projects" tp
UNION ALL
SELECT 'ts_' || tp."id" || '_unstarted', tp."id", tp."workspace_id", 'Todo',        '#3b82f6', 'unstarted', 2, true  FROM "tasks_projects" tp
UNION ALL
SELECT 'ts_' || tp."id" || '_started',   tp."id", tp."workspace_id", 'In Progress', '#f59e0b', 'started',   3, false FROM "tasks_projects" tp
UNION ALL
SELECT 'ts_' || tp."id" || '_completed', tp."id", tp."workspace_id", 'Done',        '#22c55e', 'completed', 4, false FROM "tasks_projects" tp
UNION ALL
SELECT 'ts_' || tp."id" || '_cancelled', tp."id", tp."workspace_id", 'Cancelled',   '#ef4444', 'cancelled', 5, false FROM "tasks_projects" tp
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- ── 4. Backfill tasks.project_id ──
-- A task's project = its channel's chat-project (via channel_projects -> the
-- tasks_project we created in step 1), else the workspace Inbox. Guarded by
-- project_id IS NULL so a second run is a no-op.
UPDATE "tasks" t
SET "project_id" = COALESCE(
	(
		SELECT 'tp_' || cp."project_id"
		FROM "channel_projects" cp
		WHERE cp."channel_id" = t."channel_id"
	),
	'tp_inbox_' || t."workspace_id"
)
WHERE t."project_id" IS NULL;
--> statement-breakpoint

-- ── 5. Backfill tasks.state_id from the legacy free-text status ──
-- pending/todo -> unstarted, in_progress/pending_review -> started,
-- done -> completed, cancelled -> cancelled, anything else -> unstarted.
-- Guarded by state_id IS NULL (and project_id NOT NULL from step 4).
UPDATE "tasks" t
SET "state_id" = 'ts_' || t."project_id" || '_' || (
	CASE
		WHEN t."status" IN ('in_progress', 'pending_review') THEN 'started'
		WHEN t."status" = 'done' THEN 'completed'
		WHEN t."status" = 'cancelled' THEN 'cancelled'
		ELSE 'unstarted'
	END
)
WHERE t."state_id" IS NULL AND t."project_id" IS NOT NULL;
--> statement-breakpoint

-- ── 6. Backfill tasks.sequence_id (per-project, continuing past existing ids) ──
-- Guarded by sequence_id IS NULL so a second run leaves existing numbers intact.
-- On a partial DB a project may already hold some numbered tasks; number only the
-- NULL rows 1..K per project, then offset by that project's current MAX existing
-- sequence_id (0 when none) so backfilled rows never collide with pre-assigned ids.
UPDATE "tasks" t
SET "sequence_id" = s."base" + s."rn"
FROM (
	SELECT
		n."id",
		COALESCE(mx."max_seq", 0) AS "base",
		ROW_NUMBER() OVER (
			PARTITION BY n."project_id" ORDER BY n."created_at", n."id"
		) AS "rn"
	FROM "tasks" n
	LEFT JOIN (
		SELECT "project_id", MAX("sequence_id") AS "max_seq"
		FROM "tasks"
		WHERE "project_id" IS NOT NULL AND "sequence_id" IS NOT NULL
		GROUP BY "project_id"
	) AS mx ON mx."project_id" = n."project_id"
	WHERE n."sequence_id" IS NULL AND n."project_id" IS NOT NULL
) AS s
WHERE t."id" = s."id" AND t."sequence_id" IS NULL;
--> statement-breakpoint

-- ── 7. Advance each tasks_project.sequence_counter to its max assigned sequence ──
-- GREATEST keeps the larger of the current counter and the observed max, so a
-- second run (or new app-assigned rows past the backfill) can never shrink it.
UPDATE "tasks_projects" tp
SET "sequence_counter" = GREATEST(tp."sequence_counter", m."max_seq")
FROM (
	SELECT "project_id", MAX("sequence_id") AS "max_seq"
	FROM "tasks"
	WHERE "project_id" IS NOT NULL AND "sequence_id" IS NOT NULL
	GROUP BY "project_id"
) AS m
WHERE tp."id" = m."project_id";

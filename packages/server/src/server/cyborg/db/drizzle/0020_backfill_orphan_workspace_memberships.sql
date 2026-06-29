-- Data backfill: repair orphan workspaces missing their OWNER membership row.
--
-- Root cause (fixed in code by fix/canonical-email-identity, #878):
-- DualStorage.createWorkspace ran the PG `createWorkspace` insert and the owner
-- `addMember` as two SEPARATE fire-and-forget awaits. If addMember failed after
-- the workspace insert, the workspace was left with ZERO membership rows — an
-- orphan its own owner could never see (getWorkspacesForUser inner-joins
-- memberships). The code is now atomic (createWorkspaceAtomic), so NO NEW
-- orphans are produced; this migration repairs the EXISTING real-user orphans
-- (the audit found 2 such rows; `system`-owned workspaces are skipped).
--
-- This replaces the ad-hoc scripts/backfill-orphan-workspace-memberships.sql
-- with a versioned, auto-applied migration. It is a pure forward DML migration:
-- Drizzle's runtime migrator wraps each migration in its own transaction, so no
-- BEGIN/COMMIT and no preview SELECTs here. Idempotent via ON CONFLICT DO
-- NOTHING (PK is (workspace_id, user_id)) — re-running is a safe no-op.

INSERT INTO "memberships" ("workspace_id", "user_id", "role", "membership_type", "joined_at")
SELECT w."id", w."owner_id", 'owner', 'active', now()
FROM "workspaces" w
WHERE w."owner_id" IS NOT NULL
  AND w."owner_id" <> 'system'
  AND EXISTS (SELECT 1 FROM "users" u WHERE u."id" = w."owner_id")
  AND NOT EXISTS (
    SELECT 1 FROM "memberships" m
    WHERE m."workspace_id" = w."id"
      AND m."user_id" = w."owner_id"
  )
ON CONFLICT ("workspace_id", "user_id") DO NOTHING;

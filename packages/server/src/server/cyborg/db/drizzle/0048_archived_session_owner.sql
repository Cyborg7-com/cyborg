-- 0048_archived_session_owner.sql
-- IDOR fix: record the OWNER of an archived session.
--
-- archived_sessions had no owner column, so restore_session / import_session /
-- list_archived_sessions had nothing to authorize against — any spawn-scoped
-- member could restore another member's archived session and read its full
-- transcript (the now-gated fetch_agent_timeline passes once the transcript is
-- hydrated into a live agent stamped with the RESTORER as initiator). We now
-- capture the live binding's initiator at archive/import time so restore/import/
-- list can gate to the OWNER or a workspace owner/admin.
--
-- initiated_by is a LOCAL daemon id; initiated_by_email bridges it to the
-- caller's cloud account across the divergent local/cloud id namespaces (same
-- #810 bridge agent_bindings.initiated_by_email uses).
--
-- Additive + IDEMPOTENT (ADD COLUMN IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention. Both columns are nullable: rows archived before
-- this migration have NULL owner and fall through to the workspace owner/admin
-- gate only (fail-closed for plain members).

ALTER TABLE "archived_sessions" ADD COLUMN IF NOT EXISTS "initiated_by" text;--> statement-breakpoint
ALTER TABLE "archived_sessions" ADD COLUMN IF NOT EXISTS "initiated_by_email" text;

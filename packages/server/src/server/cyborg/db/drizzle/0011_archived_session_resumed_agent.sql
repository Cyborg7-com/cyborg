-- Resume-without-loss (data-loss fix): resuming an archived session used to
-- hard-DELETE its history row, so if the resumed live session then died the
-- session was lost forever. The fix keeps the row and links it to the live agent
-- via resumed_agent_id; the daemon hides it from history only while that agent's
-- binding exists, and revives it (clears this column) on re-archive.
--
-- Additive + IDEMPOTENT (ADD COLUMN IF NOT EXISTS) — a nullable column on an
-- existing table touches no data and is a safe no-op if already present, matching
-- the repo's hand-applied-prod convention.
ALTER TABLE "archived_sessions" ADD COLUMN IF NOT EXISTS "resumed_agent_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_archived_sessions_resumed_agent" ON "archived_sessions" USING btree ("resumed_agent_id");

-- Webhook-triggered cybo runs (#620, scheduler phase 3 — reactive triggers):
-- a webhook config can name a cybo to FIRE on each incoming event, with a prompt
-- template rendered from the (hostile) event payload, instead of only rendering a
-- card.
--
-- Additive + backward-compatible + IDEMPOTENT (ADD COLUMN IF NOT EXISTS), matching
-- the repo's hand-applied-prod convention — see 0005_daemon_access_scopes.sql /
-- 0004_schedule_runs_and_lifecycle.sql. Safe no-op on a DB that already has the
-- columns.
--
-- BACK-COMPAT: both columns are NULLABLE with no default, so every PRE-EXISTING
-- webhook row stays `trigger_cybo_id IS NULL` → card-only, exactly as today (no
-- regression). A row only fires a cybo once an admin sets `trigger_cybo_id`.
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "trigger_cybo_id" text;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "prompt_template" text;

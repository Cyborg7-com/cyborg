-- Cybo Autonomy S2 — the per-cybo autonomy dial.
--
-- Adds cybos.autonomy_level (L0..L5): the cybo's disposition, replacing the inert
-- behavior_mode string (which is kept read-only/deprecated, never renamed — renaming
-- a persisted column is breaking, cybo-types.ts header rule). The effective agency in
-- a channel is min(cyboLevel, channelCeiling); the channel side (regime /
-- max_autonomy_level) lands in a later slice.
--
-- Additive + idempotent (ADD COLUMN IF NOT EXISTS) + a behavior-preserving backfill
-- (responsive→L1, proactive→L3) so no cybo changes disposition. Hand-applied-prod
-- convention: never run against the prod RDS by hand; the deploy migrator applies it.
ALTER TABLE "cybos" ADD COLUMN IF NOT EXISTS "autonomy_level" text;

UPDATE "cybos"
SET "autonomy_level" = CASE "behavior_mode" WHEN 'proactive' THEN 'L3' ELSE 'L1' END
WHERE "autonomy_level" IS NULL;

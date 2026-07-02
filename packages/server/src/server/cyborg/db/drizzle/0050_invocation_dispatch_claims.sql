-- 0050_invocation_dispatch_claims.sql
-- Cross-daemon exactly-once guard for the @MENTION + channel-WATCHER paths (#16).
--
-- Twin of 0046_schedule_dispatch_claims.sql (the cron path). The mention/watch
-- invocation guards (cybo-mention-invoke.ts) were IN-PROCESS only — a per-process
-- Set — so the SAME channel message reaching more than one daemon (relay replay /
-- reconnect, or a daemon serving local clients while relay-connected), OR the same
-- daemon after a worker restart that cleared the Set, double-fired the cybo →
-- duplicate ephemeral sessions ("sessions keep multiplying").
--
-- This table is the per-invocation atomic claim: the daemon that wins INSERTs its
-- claim_key row; every other daemon conflicts on the primary key and skips the fire.
-- claim_key is the guard's own key — "<messageId>:<cyboId>" for a mention,
-- "watch:<messageId>" for a watcher (disjoint namespaces share one table). Mirrors
-- the claimScheduleDispatch primitive.
--
-- Additive + IDEMPOTENT (CREATE TABLE IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention. Safe to run twice.

CREATE TABLE IF NOT EXISTS "invocation_dispatch_claims" (
	"claim_key" text PRIMARY KEY NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text
);

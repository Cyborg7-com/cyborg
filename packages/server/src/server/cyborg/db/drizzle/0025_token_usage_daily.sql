-- Daily token ledger for the Home contribution heatmap. agent_sessions stores
-- CUMULATIVE per-session token totals (overwritten each turn), so it cannot
-- represent true per-day usage — a session's whole total lumps onto its start
-- day and gets superseded on reuse. This table accumulates per-day token DELTAS
-- (recordAgentSessionUsage adds new_cumulative − last_seen to the current UTC
-- day), so the heatmap reflects tokens actually burned each day and the history
-- persists. Forward-only (past cumulative data can't be reconstructed).
--
-- Additive + IDEMPOTENT, matching the repo convention. Hand-authored because
-- drizzle-kit generate is blocked by the pre-existing 0008/0009/0010 snapshot
-- collision; the runtime migrator applies plain .sql + _journal.json.

CREATE TABLE IF NOT EXISTS "token_usage_daily" (
	"workspace_id" text NOT NULL,
	"day" date NOT NULL,
	"tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "token_usage_daily_workspace_id_day_pk" PRIMARY KEY("workspace_id","day")
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "token_usage_daily" ADD CONSTRAINT "token_usage_daily_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

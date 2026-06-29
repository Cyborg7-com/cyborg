-- agent_sessions usage columns. The table existed but was never written; we are
-- now the first writer (session-history for the Home "This week" stats). Adds
-- denormalized provider/cybo identity + cumulative token/cost usage + updated_at,
-- and the workspace+created_at index the weekly aggregate scans.
--
-- Additive + IDEMPOTENT (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS),
-- matching the repo's hand-applied-prod convention. Hand-authored because
-- drizzle-kit generate is blocked by the pre-existing 0008/0009/0010 snapshot
-- collision; the runtime migrator applies plain .sql + _journal.json.

ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "cybo_id" text;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "input_tokens" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "output_tokens" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "cached_input_tokens" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "total_cost_usd" double precision DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_sessions_workspace_created" ON "agent_sessions" USING btree ("workspace_id","created_at");

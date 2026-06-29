-- Index backing the per-cybo "last active" aggregate. pg-sync.getCybos now LEFT
-- JOINs a `max(updated_at) GROUP BY cybo_id` subquery over agent_sessions to
-- surface lastActiveAt on the cybo roster; without this index that GROUP BY is a
-- full-table scan. agent_sessions.cybo_id is nullable (non-cybo sessions), and
-- the subquery filters cybo_id IS NOT NULL, so a partial index keeps it lean.
--
-- Additive + IDEMPOTENT (CREATE INDEX IF NOT EXISTS), matching the repo's
-- hand-applied-prod convention (see 0021). No column changes — cybo_id and
-- updated_at already exist (added in 0021).

CREATE INDEX IF NOT EXISTS "idx_agent_sessions_cybo" ON "agent_sessions" USING btree ("cybo_id") WHERE "cybo_id" IS NOT NULL;

-- One-time backfill of token_usage_daily from existing agent_sessions, so the
-- Home heatmap isn't blank right after 0025 (the ledger starts empty + is
-- forward-only). Buckets each session's cumulative input+output onto its
-- created_at UTC day — the prior heatmap's semantics (imperfect for multi-day
-- sessions, but it recovers the visible history users already had).
--
-- Idempotent + overlap-safe: GREATEST keeps the larger of an already-recorded
-- post-0025 delta vs the cumulative snapshot for the same day, so re-running can't
-- shrink a bucket and the (full) cumulative wins over a partial same-day delta.
-- New deltas recorded AFTER this backfill still add normally going forward.

INSERT INTO token_usage_daily (workspace_id, day, tokens)
SELECT
	workspace_id,
	(created_at AT TIME ZONE 'UTC')::date AS day,
	sum(input_tokens + output_tokens)::bigint AS tokens
FROM agent_sessions
WHERE (input_tokens + output_tokens) > 0
GROUP BY workspace_id, (created_at AT TIME ZONE 'UTC')::date
ON CONFLICT (workspace_id, day)
DO UPDATE SET tokens = GREATEST(token_usage_daily.tokens, EXCLUDED.tokens);

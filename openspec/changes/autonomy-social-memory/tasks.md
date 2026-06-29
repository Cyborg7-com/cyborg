## 1. Memory table + migration

- [ ] 1.1 Add `cyboMemories` pgTable to `packages/server/src/server/cyborg/db/schema.ts`: `id`,
      `cybo_id`, `workspace_id`, `kind` (text: observation|reflection), `content` (text),
      `embedding` (`vector(1536)`), `importance` (integer 1–10), `source_ids` (jsonb/text[]),
      `created_at`/`last_access` (bigint epoch-ms, matching `composio_connections`); indexes
      `idx_cybo_memories_cybo` (btree on cybo_id) + an ivfflat/hnsw index on `embedding`.
- [ ] 1.2 Hand-author `db/drizzle/0030_cybo_memories.sql`: `CREATE EXTENSION IF NOT EXISTS vector;` +
      `CREATE TABLE IF NOT EXISTS cybo_memories (...)` + `CREATE INDEX IF NOT EXISTS ...`, all idempotent
      (mirror the 0029 header convention). Append one row to `db/drizzle/meta/_journal.json` with
      `when` > `1783000005000` (above 0029).
- [ ] 1.3 Typecheck: `cd packages/server && npm run typecheck`

## 2. Memory store CRUD

- [ ] 2.1 Add `cybo-memory-store.ts` in `packages/server/src/server/cyborg/`: `insertMemory`
      (observation/reflection, embedding + LLM-rated importance), `fetchCandidates` (recent +
      top-importance + nearest-cosine window for a cybo), `bumpLastAccess`.
- [ ] 2.2 PG-gated round-trip test (`describe.skipIf(!process.env.DATABASE_URL)`, repo convention):
      insert an observation, fetch it back by `cybo_id`, assert all fields intact + `kind="observation"`,
      then `bumpLastAccess` updates the column.
- [ ] 2.3 Run: `cd packages/server && DATABASE_URL=$DATABASE_URL npx vitest run src/server/cyborg/cybo-memory-store.test.ts --reporter=verbose`

## 3. Retrieval scorer (pure, deterministic)

- [ ] 3.1 Add `cybo-memory-retrieval.ts`: pure `scoreMemory({nowMs, memory, queryEmbedding})` =
      `recency(0.995^hoursSinceLastAccess) + importance/10 + cosine`, each normalized to [0,1], α=1;
      and `topK(candidates, query, nowMs, k)` returning the highest composite scores. No I/O, no clock read.
- [ ] 3.2 Unit tests (no DB): (a) recency term equals `0.995^hours` exactly and a 1h memory beats a 10h
      memory; (b) composite ordering across hand-fixed high-importance/high-cosine/high-recency fixtures
      matches the summed normalized terms; (c) deterministic (same input → same order, no random tie-break).
- [ ] 3.3 Run: `cd packages/server && npx vitest run src/server/cyborg/cybo-memory-retrieval.test.ts --reporter=verbose`

## 4. Mandatory reflection (trigger + synthesis)

- [ ] 4.1 Add `cybo-reflection.ts`: pure `shouldReflect(accumulatedImportance, threshold)` predicate +
      `synthesizeReflections(memories)` (LLM synthesis → 1–3 belief memories citing `source_ids`,
      stored as `kind:"reflection"`, accumulator reset). Threshold operator-overridable (~150 default).
- [ ] 4.2 Unit test (no LLM for the predicate): `shouldReflect` returns true at/above threshold, false
      below; a synthesis test (stubbed LLM/embedder) asserts stored reflections have `kind="reflection"`,
      non-empty `source_ids`, and the accumulator resets.
- [ ] 4.3 Run: `cd packages/server && npx vitest run src/server/cyborg/cybo-reflection.test.ts --reporter=verbose`

## 5. 2-party conversation FSM

- [ ] 5.1 Add `cybo-conversation-fsm.ts`: pure reducer `transition(state, event)` over
      `invited → participating → left` (at most one active conversation per cybo; illegal transitions
      rejected); `closeConversation` summarizes + embeds the transcript as an observation memory.
- [ ] 5.2 Unit tests: legal path `invite→accept→leave` reaches `left`; illegal `accept` from `left`
      (or with an active conversation) is rejected and state unchanged; close writes a summary observation
      memory with the conversation's source message ids (stubbed embedder).
- [ ] 5.3 Run: `cd packages/server && npx vitest run src/server/cyborg/cybo-conversation-fsm.test.ts --reporter=verbose`

## 6. Tick scheduler + budget cost-governor

- [ ] 6.1 Add `cybo-tick-scheduler.ts`: pure `withinBudget(spent, caps)` → allow | deny-with-reason
      (`token-cap`/`turn-cap`); the tick loop runs the cheap speak-gate over candidates and charges the
      expensive turn to ONLY the selected speaker; enforces the internal docs L4 budgets
      (200 turns/session, ≤4h window, 2M tokens/session, per-pair 1/60s, `monthly_spend_cap`).
- [ ] 6.2 Unit tests (no clock dependence — spent/caps passed in): token cap reached → deny `token-cap`;
      turn cap reached → deny `turn-cap`; a tick over N candidates charges exactly one expensive turn
      (only the chosen speaker pays).
- [ ] 6.3 Run: `cd packages/server && npx vitest run src/server/cyborg/cybo-tick-scheduler.test.ts --reporter=verbose`

## 7. Full suite + typecheck gate

- [ ] 7.1 Run all S5 pure tests together:
      `cd packages/server && npx vitest run src/server/cyborg/cybo-memory-retrieval.test.ts src/server/cyborg/cybo-reflection.test.ts src/server/cyborg/cybo-conversation-fsm.test.ts src/server/cyborg/cybo-tick-scheduler.test.ts --reporter=verbose`
- [ ] 7.2 Typecheck the package: `cd packages/server && npm run typecheck`

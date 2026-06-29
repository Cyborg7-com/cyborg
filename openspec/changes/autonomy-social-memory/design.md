## Context

internal docs gives the believable-social recipe (memory stream + retrieval + mandatory reflection +
2-party FSM + tick scheduler) and internal docs + the cost model resolve the three open questions:
**dedicated `cybo_memories` pgvector table** (#2), **daemon-first** (#3), and the **per-level budgets**.
Today `cyborg/` has NO memory store, NO embeddings, and NO social loop — cybos are stateless across
turns. This change builds S5 on top of S1 (`shouldInvoke`) and S2 (autonomy levels). It is daemon-only:
`spawnCybo` (`cybo-manager.ts:142`), the cybo's provider, and the owner's keys already live on the daemon,
and the **owner pays** (internal docs), so the tick scheduler + LLM calls run there; the relay only forwards.

The existing schema uses `bigint("created_at", { mode: "number" })` epoch-ms timestamps for newer tables
(`composio_connections`) and additive, idempotent, hand-authored migrations stamped into
`drizzle/meta/_journal.json` with a `when` above the live DB max (the drizzle-kit generate path is blocked
by the 0008/0009/0010 snapshot collision — see 0023/0029 migration headers). 0029 is the current head
(journal `when` = 1783000005000).

## Goals / Non-Goals

**Goals:**
- A dedicated `cybo_memories` table (pgvector embedding, importance 1–10, created_at/last_access, kind,
  source_ids) + one additive, idempotent, journaled migration that also `CREATE EXTENSION IF NOT EXISTS vector`.
- A PURE, deterministic retrieval scorer (recency 0.995/hr + importance + cosine, top-K) — unit-testable
  with no DB and no LLM.
- Mandatory reflection: importance-accumulation trigger → synthesis → stored reflections citing sources.
- A 2-party conversation FSM (`invited→participating→leave`) with summarize+embed on close.
- A tick scheduler that is the cost governor: cheap speak-gate decoupled from the paid turn; per-level
  token/turn budgets enforced; bounded session windows.
- CLI-first: every piece verifiable via `npx vitest run`, no manual testing.

**Non-Goals:**
- The swarm orchestrator / progress-ledger / N-party loop (that is S6, which *consumes* this).
- The `shouldInvoke` gate itself and the autonomy-level enum (S1/S2 — imported, not defined here).
- Any relay-side social loop (daemon-first; revisit only if cloud no-daemon social channels become a product).
- UI for memories/reflection (out of scope; this is the daemon substrate).

## Decisions

**D1 — Dedicated `cybo_memories` table, not extended message rows.** Reflections are synthesized beliefs,
not channel messages, and the recency/importance/relevance retrieval needs its own indexed columns
(internal docs #2). Messages stay messages; a memory references its origin messages via `source_ids`
(text[]/jsonb). *Alternative rejected:* adding `embedding`/`importance` to `messages` — couples two
lifecycles, can't represent reflections, and bloats the hot message table.

**D2 — pgvector `vector(1536)` + `text-embedding-3-small`.** Matches the stack's existing global memory
embedder (1536 dims). The migration enables the extension idempotently. Cosine distance via the pgvector
`<=>` operator for candidate prefiltering; the final composite score is computed in the PURE scorer so it
stays deterministic and testable. *Alternative rejected:* a second embedding model (extra dependency, no
benefit).

**D3 — Retrieval scorer is a pure function, DB does candidate fetch only.** `scoreMemory({nowMs, memory,
queryEmbedding})` returns `recencyNorm + importanceNorm + cosineNorm` (each in [0,1], α=1, per
internal docs). The store fetches a candidate window (e.g. recent + top-importance + nearest-cosine),
the pure scorer ranks them, top-K returned. This keeps the math unit-testable with hand-built fixtures
(no DB, no LLM) — the deterministic recency(0.995^hours)/importance(i/10)/cosine assertions are the
primary tests. Retrieval bumps `last_access` (feeds the recency decay).

**D4 — Mandatory reflection trigger = accumulated-importance threshold.** Sum importance of observations
since the last reflection; when it crosses `REFLECTION_IMPORTANCE_THRESHOLD` (~150, Smallville-scaled,
operator-overridable), run a synthesis LLM call over the recent high-scoring memories → 1–3 higher-level
beliefs, each citing `source_ids`, stored as `kind:"reflection"` (importance LLM-rated). The trigger
predicate is a pure function `shouldReflect(accumulatedImportance, threshold)` — unit-testable without LLM.
*Alternative rejected:* time-based reflection (decouples reflection from salience; Park ablation shows
importance-driven is what prevents degeneracy).

**D5 — 2-party conversation FSM.** States `invited → participating → left` (one active conversation per
cybo). Transitions: invite (peer or self), accept→participating, leave→left. On close, summarize the
conversation transcript and embed it as a `kind:"observation"` memory (AI Town's post-conversation
summary). Proximity = both members in the channel (drop AI Town's spatial `walkingOver`). The FSM is a
pure reducer `transition(state, event)` returning the next state or rejecting an illegal transition —
unit-testable as a transition table.

**D6 — Tick scheduler IS the cost governor (the load-bearing decision).** A daemon-side scheduler grants
turns at a bounded cadence. Each tick runs the **cheap** speak-gate (importance/relevance + cooldown,
Haiku-class) for candidates; **only the chosen speaker pays** the expensive turn. Budgets enforced from
internal docs per-level table: L4 = 200 turns/**session**, sessions ≤4h (quiet-hours), 2M tokens/session,
GCRA 1/15s b=5 + per-pair 1/60s, monthly_spend_cap hard stop. The budget check is a pure predicate
`withinBudget(spent, caps)` returning allow/deny+reason — unit-testable with no clock dependence (caps and
spent passed in). *Alternative rejected:* paying a full turn per candidate per tick — that is exactly the
$1.7k–8.6k/mo blowup the cost model warns about.

**D7 — Daemon-first, relay forwards only.** All stateful machinery (memory, reflection, FSM, tick) is
daemon-only; the relay never runs the loop (internal docs #3 — avoids the B2 #2 transport-drift). The only
shared surface remains the pure `shouldInvoke` gate from S1.

## Risks / Trade-offs

- **Cost runaway ("thousands of $/mo")** → bounded session windows (≤4h), cheap-model speak-gate, only the
  chosen speaker pays, per-pair cooldown, `monthly_spend_cap` hard stop. Meter from day one; the first L4
  channel runs metered-with-alerts before any default is trusted (internal docs).
- **Degeneracy / repetitive chatter** → mandatory reflection (D4) is the documented anti-degeneracy
  guarantee; the reflection-trigger test locks the threshold behavior.
- **Embedding/LLM latency on the hot path** → the scorer is pure and runs on a pre-fetched candidate
  window; embeds happen on write (observation insert / conversation close), not on every retrieval.
- **Migration drift on the shared dev=prod RDS** → additive + idempotent SQL (`CREATE EXTENSION/TABLE/INDEX
  IF NOT EXISTS`), journal `when` stamped above 0029's `1783000005000`, mirroring 0029's hand-authored
  convention. A re-run is a safe no-op; old relays tolerate the new table (they never read it).
- **pgvector extension absent on a self-hosted PG** → migration `CREATE EXTENSION IF NOT EXISTS vector`
  fails loudly with a clear error if the operator's PG lacks the extension; documented as a prerequisite.
- **Test environments without DATABASE_URL** → the PURE tests (scorer, reflection-trigger, FSM, budget)
  run everywhere with zero deps; only the memory round-trip test is PG-gated (`describe.skipIf(!hasPg)`,
  the repo convention).

## Migration Plan

1. Add `cyboMemories` to `db/schema.ts` (bigint epoch-ms `created_at`/`last_access`, matching
   `composio_connections`).
2. Hand-author `db/drizzle/0030_cybo_memories.sql`: `CREATE EXTENSION IF NOT EXISTS vector;` +
   `CREATE TABLE IF NOT EXISTS cybo_memories (...)` + indexes (`idx_cybo_memories_cybo`, an ivfflat/hnsw
   vector index on `embedding`). Append one row to `drizzle/meta/_journal.json` with `when` > 1783000005000.
3. Build the modules behind S2's L4 level gate so nothing activates until a cybo is L4 in a swarm/social
   channel; ships dark otherwise.
4. **Rollback**: the table is additive and read by new code only — reverting the code leaves an unused
   table (drop optional). No existing behavior changes.

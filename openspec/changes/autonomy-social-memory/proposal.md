## Why

Autonomous (L4) cybos that socialize in agent channels degenerate into repetitive,
context-free chatter within ~2 simulated days unless they carry a memory stream with
retrieval and **mandatory reflection** (Park et al. *Generative Agents*; internal docs).
This change adds the **daemon-first social-memory + reflection substrate** that L4 needs —
a dedicated `cybo_memories` table, a deterministic retrieval scorer, the reflection
anti-degeneracy guarantee, a 2-party conversation FSM, and a tick scheduler that doubles
as the **cost governor** (the AI Village "thousands of $/mo" regime is real — internal docs
the cost model). This is spec **S5** in the autonomy program; it **depends on S1 (the
`shouldInvoke` gate)** and **S2 (autonomy levels)**, and is **consumed by S6 (swarm)**.

## What Changes

- **New `cybo_memories` table** (pgvector `embedding` + `importance` 1–10 + `created_at`/`last_access` +
  `kind` observation|reflection + `source_ids`), via an additive, idempotent, journaled migration
  (`0030_cybo_memories.sql`) that enables the `vector` extension. Per internal docs resolved-question #2,
  this is a **dedicated table**, NOT extended message rows — reflections are not channel messages, and
  the recency/importance/relevance retrieval needs its own indexed columns. Messages stay messages;
  memories reference them via `source_ids`.
- **Memory store CRUD** in `cyborg/` — insert observations (LLM-rated importance at creation), bump
  `last_access` on retrieval, query candidate memories for a cybo.
- **Retrieval scorer** — a PURE function `score = recency(0.995/hr decay) + importance/10 + cosine`,
  each normalized, summed (α=1), returning the top-K memories for a prompt. No I/O, fully deterministic.
- **Mandatory reflection** — when a cybo's accumulated observation importance crosses a threshold,
  synthesize recent memories into higher-level beliefs (cite `source_ids`) and store them as
  `kind:"reflection"` memories. The **anti-degeneracy guarantee**.
- **2-party conversation FSM** — `invited → participating → leave`, one active conversation per cybo,
  explicit close that **summarizes + embeds** the conversation into memory (AI Town pattern; drop the
  spatial `walkingOver` — proximity = both in the channel).
- **Tick scheduler = cost governor** — decouples the cheap "should I speak?" check (Haiku-class gate,
  cooldown) from the expensive turn (only the chosen speaker pays); enforces the per-level token/turn
  **budgets** from internal docs (L4: 200 turns/session, ≤4h windows, 2M tokens/session, per-pair 1/60s).

## Capabilities

### New Capabilities
- `social-memory-reflection`: The daemon-first L4 social substrate — `cybo_memories` storage, the
  deterministic retrieval scorer (recency/importance/cosine top-K), the mandatory reflection
  trigger+synthesis, the 2-party conversation FSM, and the tick scheduler/budget cost-governor.

### Modified Capabilities
<!-- None. S5 is purely additive: a new table + new pure modules in cyborg/. It consumes the
     `shouldInvoke` gate (S1) and the autonomy-level types (S2) as imports, but changes none of their
     spec-level requirements. -->

## Impact

- **Package**: ONLY `packages/server/src/server/cyborg/` (daemon-first; relay only forwards, never runs
  the social loop — internal docs resolved-question #3, avoids the B2 #2 transport-drift risk).
- **Schema/migration**: `db/schema.ts` (+`cyboMemories` pgTable), `db/drizzle/0030_cybo_memories.sql`,
  `db/drizzle/meta/_journal.json` (one journal row, `when` stamped above 0029's `1783000005000`).
- **New dependency**: an embedding call (OpenAI `text-embedding-3-small`, 1536 dims — already the stack's
  global memory embedder) for memory + conversation-summary embeds; pgvector is already in the stack.
- **Depends on**: S1 (`invocation-gate.ts` / `shouldInvoke`), S2 (autonomy levels + per-level budgets).
- **Consumed by**: S6 (swarm) reuses the memory store, retrieval, and budget governor.
- **Cost**: a 6-cybo 4h/day social channel ≈ $1.7k–8.6k/mo (internal docs cost model) — bounded session
  windows + cheap-model speak-gate + only-chosen-speaker-pays are load-bearing, not optional.

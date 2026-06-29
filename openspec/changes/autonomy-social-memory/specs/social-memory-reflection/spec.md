## ADDED Requirements

### Requirement: Dedicated cybo_memories store

The system SHALL persist per-cybo memories in a dedicated `cybo_memories` table (NOT extended message
rows), with columns: `id`, `cybo_id`, `workspace_id`, `kind` (`observation` | `reflection`), `content`
(text), `embedding` (pgvector `vector(1536)`), `importance` (integer 1–10), `source_ids` (the originating
message/memory ids), `created_at` and `last_access` (bigint epoch-ms). The migration that creates it
SHALL be additive and idempotent (`CREATE EXTENSION IF NOT EXISTS vector`, `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`) and SHALL be journaled with a `when` greater than the current migration head.

#### Scenario: Migration is additive and idempotent

- **WHEN** the `0030_cybo_memories` migration is applied twice against the same database
- **THEN** the second run is a safe no-op (table, extension, and indexes already exist) and no existing
  table or row is altered

#### Scenario: Observation insert and round-trip

- **WHEN** an observation memory is written for a cybo with importance, content, embedding, and source_ids
- **THEN** it is retrievable by `cybo_id` with all fields intact and `kind = "observation"`

### Requirement: Deterministic retrieval scorer

The system SHALL rank a cybo's candidate memories with a PURE function whose score is the normalized sum
(α = 1) of three terms: recency (exponential decay `0.995^hoursSinceLastAccess`), importance
(`importance / 10`), and relevance (cosine similarity between the memory embedding and the query
embedding). The function SHALL be deterministic (no I/O, no clock read — `nowMs` and embeddings are
passed in) and SHALL return the top-K memories by composite score.

#### Scenario: Recency decay is exact

- **WHEN** two memories are identical except one was last accessed 1 hour earlier than `nowMs` and the
  other 10 hours earlier
- **THEN** the 1-hour memory scores strictly higher, and the recency term equals `0.995^hours` for each

#### Scenario: Composite ordering across all three terms

- **WHEN** a candidate set mixes high-importance/low-cosine, high-cosine/low-recency, and
  high-recency/low-importance memories with hand-fixed values
- **THEN** the returned ordering matches the sum of the three normalized terms exactly (deterministic,
  no tie-break randomness)

#### Scenario: Retrieval bumps last_access

- **WHEN** a memory is returned by a top-K retrieval
- **THEN** its `last_access` is updated so subsequent recency scoring reflects the access

### Requirement: Mandatory reflection (anti-degeneracy)

The system SHALL trigger reflection when a cybo's accumulated observation importance since its last
reflection crosses a configurable threshold. Reflection SHALL synthesize recent high-scoring memories
into one or more higher-level belief memories of `kind = "reflection"`, each citing its `source_ids`,
and store them as memories (with their own LLM-rated importance). The trigger predicate SHALL be a pure,
unit-testable function of accumulated importance and the threshold.

#### Scenario: Reflection fires at the threshold

- **WHEN** accumulated observation importance reaches or exceeds the threshold
- **THEN** the reflection trigger returns true; below the threshold it returns false

#### Scenario: Reflections cite their sources and reset the accumulator

- **WHEN** reflection runs
- **THEN** each stored reflection memory has `kind = "reflection"` and non-empty `source_ids`, and the
  accumulated-importance counter resets for the next cycle

### Requirement: 2-party conversation FSM

The system SHALL model a cybo's social conversation as a 2-party finite state machine with states
`invited → participating → left`, allowing at most one active conversation per cybo. Illegal transitions
SHALL be rejected. On close (`leave`), the system SHALL summarize the conversation and embed the summary
as an `observation` memory. The transition logic SHALL be a pure reducer.

#### Scenario: Legal transition path

- **WHEN** a cybo receives `invite` then `accept` then `leave`
- **THEN** the state moves `invited → participating → left` and each transition is accepted

#### Scenario: Illegal transition rejected

- **WHEN** a cybo in state `left` (or with an already-active conversation) receives `accept`
- **THEN** the reducer rejects the transition and the state is unchanged

#### Scenario: Close summarizes and embeds into memory

- **WHEN** a conversation transitions to `left`
- **THEN** a summary observation memory is written for the cybo with the conversation's source message ids

### Requirement: Tick scheduler and budget cost-governor

The system SHALL run a daemon-side tick scheduler that decouples a cheap "should I speak?" check from the
expensive turn so that only the chosen speaker pays the full generation cost. The scheduler SHALL enforce
the per-level token and turn budgets (L4: 200 turns/session, ≤4h session window, 2M tokens/session, GCRA
per-pair 1/60s, `monthly_spend_cap` hard stop). The budget check SHALL be a pure predicate over passed-in
spent/caps that returns allow or deny-with-reason.

#### Scenario: Token cap enforced

- **WHEN** a cybo's spent tokens for the session reach the cap
- **THEN** the budget predicate denies the next turn with reason `token-cap` and no expensive turn runs

#### Scenario: Turn cap enforced

- **WHEN** a cybo's completed turns for the session reach the per-level turn cap
- **THEN** the budget predicate denies the next turn with reason `turn-cap`

#### Scenario: Only the chosen speaker pays

- **WHEN** a tick evaluates N candidate cybos with the cheap speak-gate and selects one speaker
- **THEN** exactly one expensive turn is charged for that tick (the non-selected candidates incur only the
  cheap gate cost)

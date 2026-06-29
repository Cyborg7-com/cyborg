# Design — autonomy-invocation-gate (S1 / Phase 0)

## Context

`internal docs` §4 audit: invocation is NOT centralized — 8 `spawnCybo` sites, ~7 decision
functions duplicated across the daemon (`message-router`) and relay (`cybo-mention-invoke`)
transports, with the anti-loop firewall enforced by call-graph topology rather than an
explicit gate. `internal docs` §A elevates this to the keystone (Phase 0) and gives the
concrete `shouldInvoke` signature + the 10-row migration table reproduced below.

The only reference for "a pure module imported by both daemon and relay-light" already in
the tree is `packages/server/src/server/cyborg/chain-router.ts` (zero deps, zero I/O, all
effects in caller callbacks). `invocation-gate.ts` follows that exact contract.

## Goals / Non-Goals

**Goals (this change):**
- One PURE `shouldInvoke` adjudicating every wake path; firewall as an explicit typed branch.
- Anti-loop primitives as O(1) checks fed in by the caller (gate stays pure/stateless).
- Migrate all 10 deciders in SHADOW MODE — gate computed, inline authoritative, divergence
  logged. Zero behavior change, proven by golden + differential tests.

**Non-Goals (deferred to later slices):**
- Flipping the gate to authoritative (separate change, after 0 prod divergence).
- Per-cybo levels / per-channel regimes / DB columns → **S2 dials-schema**.
- Durable shared dedup+rate store (fixes restart / multi-daemon races, B2 #4/#5) → hardening slice.
- Memory / reflection / FSM / tick scheduler / orchestrator → S3–S6.

## Key decisions

### D1 — Pure, stateless gate; caller supplies the state.
The gate does NO I/O. The stateful reads stay at the call sites (PG autonomy switch, GCRA
TAT, breaker FSM, dedup guard) and are passed IN as plain fields (`rate.conformant`,
`breakerOpen`, `spent`, `depth`, `fanoutSoFar`). This is why P0 alone does **not** fix the
concurrency races — it makes the *policy* uniform; the *races* need the later durable-store
slice. Being explicit prevents a false sense of safety (per `internal docs` §5).

### D2 — Firewall becomes one explicit branch.
`authorType: "human" | "agent"` is a discriminant on the request. The rule
`agent ∧ regime≠"swarm" ⇒ invoke=false (reason:"firewall")` is a single line guarded by a
property test, replacing the 8×2 implicit routing. The relay's `authorType:"human"` literal
(`relay-standalone.ts:4075` / the `cybo-mention-invoke` check ≈`:620`) becomes the **only**
author-classification point, feeding the gate.

### D3 — Anti-loop = the proven minimal stack (all O(1)), from `internal docs` §B.
- **TTL depth counter + fan-out cap** — `depth<=0 ⇒ depth-exhausted`;
  `fanoutSoFar>=caps.fanout ⇒ fanout-cap`. `childDepth = human ? TTL0 : depth-1` (a human
  seed resets; an agent-triggered wake decrements). A1's well-founded ranking proves any
  reactive chain ≤ `ttl₀`. For P0, non-swarm regimes never admit agent authors (firewall),
  so these are dormant-but-present, exercised by swarm-regime unit tests.
- **GCRA token-bucket verdict** — per `(cybo,channel)` + per-pair `(A→B)`; the caller
  precomputes conformance, the gate just honors `rate.conformant`.
- **Circuit-breaker on unproductive turns** — caller owns the closed/open/half-open FSM;
  the gate honors `breakerOpen`.

### D4 — Mention/slash bypass autonomous budgets (preserve today).
A human explicitly asking is not rate-limited by the autonomous stack. `triggerType` of
`mention`/`slash` skips the budget/GCRA/breaker gates in P0 to reproduce current behavior.

### D5 — Shadow mode, decider-at-a-time.
Each call site computes both decisions, **uses the inline one**, and logs divergence with a
stable prefix (`[invocation-gate-shadow]`) carrying decider name + both verdicts + reason.
One decider per task → independently revertible, independently verifiable against the
goldens. Flip is a future change.

## `shouldInvoke` — signature (Phase 0, from internal docs)

```ts
// invocation-gate.ts — PURE (no I/O, no daemon deps), like chain-router.ts.
// Importable by daemon (message-router) AND the relay-light bundle (cybo-mention-invoke).
type AuthorType = "human" | "agent";          // ← the firewall, now an explicit field
type TriggerType = "mention" | "passive" | "self" | "peer" | "cron" | "task" | "webhook" | "slash";
type ChannelRegime = "mention-only" | "open" | "swarm";

interface InvocationRequest {
  workspaceAutonomyOn: boolean;               // global kill switch (getWorkspaceAutonomyEnabled)
  channel: { regime: ChannelRegime; maxAutonomyLevel: Level };
  cybo:    { id: string; defaultAutonomyLevel: Level };
  authorType: AuthorType;
  triggerType: TriggerType;
  depth: number;                              // TTL on the message envelope (human seed = ttl₀)
  fanoutSoFar: number;                        // cybos already woken by THIS message
  caps: { fanout: number; turns: number; tokens: number };
  spent: { turns: number; tokens: number };
  rate: { conformant: boolean };              // GCRA verdict for (cybo,channel)+per-pair (caller precomputes)
  breakerOpen: boolean;                       // per-cybo unproductive-turn circuit-breaker
}
type InvocationDecision =
  | { invoke: true; effectiveLevel: Level; childDepth: number }
  | { invoke: false; reason: BlockReason };   // reason → telemetry + (sometimes) a channel notice

function shouldInvoke(r: InvocationRequest): InvocationDecision {
  if (!r.workspaceAutonomyOn && r.triggerType !== "mention") return no("autonomy-off");
  // FIREWALL — explicit. An agent-authored post may wake a cybo ONLY in a swarm channel.
  if (r.authorType === "agent" && r.channel.regime !== "swarm") return no("firewall");
  // Anti-loop (the proven primitives, all O(1)):
  if (r.authorType === "agent" && r.depth <= 0)          return no("depth-exhausted");   // TTL
  if (r.authorType === "agent" && r.fanoutSoFar >= r.caps.fanout) return no("fanout-cap");
  if (r.spent.turns >= r.caps.turns || r.spent.tokens >= r.caps.tokens) return no("budget");
  if (!r.rate.conformant) return no("rate-limited");       // GCRA
  if (r.breakerOpen)      return no("breaker-open");        // unproductive-turn FSM
  // mention-only regime: only an explicit @mention/DM/slash gets through.
  if (r.channel.regime === "mention-only" && r.triggerType !== "mention" && r.triggerType !== "slash")
    return no("mention-only-regime");
  const effectiveLevel = min(r.cybo.defaultAutonomyLevel, r.channel.maxAutonomyLevel); // ← placement
  if (effectiveLevel === Level.Silent) return no("level-silent");
  // childDepth: human seed resets to ttl₀; an agent-triggered wake decrements.
  const childDepth = r.authorType === "human" ? TTL0 : r.depth - 1;
  return { invoke: true, effectiveLevel, childDepth };
}
```

`BlockReason = "autonomy-off" | "firewall" | "depth-exhausted" | "fanout-cap" | "budget" |
"rate-limited" | "breaker-open" | "mention-only-regime" | "level-silent"`.

**P0 defaults that reproduce today:** every channel is treated as `regime:"open"` with
`maxAutonomyLevel` high enough that `min()` never lowers the current outcome; mention/slash
bypass budgets (D4); `caps`/`spent`/`rate`/`breaker` are populated from the values the call
site already reads so the gate's verdict equals the inline verdict. The behavior dials
(real regimes, real levels) arrive in S2+.

## Migration list (the 10 deciders — internal docs)

| Decider (today gates inline/duplicated) | file:line | Today's inline gates → replaced by `shouldInvoke` |
|---|---|---|
| `message-router.invokeMentionedCybos` | `message-router.ts:695` | pg-present, member, dedup → gate (authorType=human) |
| `message-router.invokeChannelWatchers` | `:837` | autonomy switch, firewall(implicit), auto_tasks, rate-limit, guard |
| `message-router.runWatcherFailover` | `:1024` | (per-candidate) → gate inside the `attempt` callback |
| `cybo-mention-invoke.invokeMentionedCybosViaRelay` | `cybo-mention-invoke.ts:613` | explicit `authorType!=="human"` → gate |
| `cybo-mention-invoke.invokeChannelWatchersViaRelay` | `:912` | autonomy(relay), auto_tasks, rate-limit → gate |
| `cybo-mention-invoke.forwardWatchToChain` | `:1068` | per-candidate → gate in `attempt` |
| `dispatcher.handleInvokeCyboMention` | `dispatcher.ts:5921` | dedup, native-harness gap → gate (defense-in-depth re-check) |
| `dispatcher.handleInvokeChannelWatch` | `:6012` | re-read autonomy, watch guard → gate |
| `dispatcher.handleSlashCommand` / `handleAskCybo` | `:1445` / `:2068` | only `/ask` reaches spawn; route its decision (triggerType="slash") |
| `schedule-runner.fire` · `task-dispatch.dispatchTaskToAgent` | `schedule-runner.ts:421` · `task-dispatch.ts:232` | triggerType="cron"/"task", authorType="agent", autonomous |

## Test strategy (the P0 contract — no manual testing)

- **Golden (characterization) FIRST** — freeze current invoke/skip + reason across the
  matrix on both transports (task 1).
- **Differential** — the gate reproduces every golden byte-identically (task 5).
- **Firewall property** — `∀ agent ∧ regime≠swarm ⇒ invoke=false` (task 4).
- **Anti-loop unit tests** — TTL/fan-out/GCRA/breaker/budget/min/bypass (task 3).
- All via `npx vitest run src/server/cyborg/invocation-gate*`; lint `pnpm --filter
  @getpaseo/server lint` (oxlint/oxfmt); typecheck `npx tsc --noEmit`.

## Risks / Mitigations

- **Hot-path / firewall proximity** → shadow mode keeps inline authoritative; only logging
  added. The flip is a separate, evidence-gated change.
- **Fail-open on missing `messageId`** (current behavior) → preserved in P0; the durable
  dedup store that closes it is a later hardening slice (not this change).
- **No DB migration in this change** → all new config (levels/regimes) is S2; this change
  touches no Drizzle schema, so there is no migration-numbering collision risk here.

## Open questions (do NOT resolve here — they belong to later slices)

- Default `ttl₀`, fan-out `f`, GCRA `(r,b)`, per-level budgets — defaulted in `internal docs`
  §"cost/perf"; *wired* in S2+/swarm, not P0.
- Where author classification ultimately lives if cloud-only (no-daemon) social channels
  become a product (daemon-first decided for now).

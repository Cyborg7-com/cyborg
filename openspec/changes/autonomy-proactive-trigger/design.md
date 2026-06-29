# Design — autonomy-proactive-trigger (S4)

## Position in the autonomy stack

```
S1 invocation-gate.ts  shouldInvoke()   ← the ONE adjudicator (firewall, regime, min(), depth, budgets)
S2 levels/regime       min(cybo,channel) ← supplies effectiveLevel; L3 unlocks this trigger
S4 proactive-trigger.ts (THIS)            ← decides a cybo WANTS to speak; emits triggerType="self" → S1
S5 social (L4)         memory/reflection/FSM/tick  (reuses this scorer as its "should I speak?" gate)
S6 swarm (L5)          orchestrator/budgets        (reuses this scorer for agent-initiated turns)
```

**Separation of powers (the load-bearing invariant):** this module answers *"do I want to speak?"*
(intrinsic motivation). S1 answers *"may I speak?"* (policy). They never merge — the scorer's output
is an **input** to `shouldInvoke`, exactly as `internal docs` §C P2 states: "Inner Thoughts leaves
cross-agent arbitration emergent → S1 IS the arbitration layer it's missing." This keeps the firewall
and the budgets in one tested place (S1) and the personality/motivation math here.

## The math (internal docs P2)

```
score   = (relevance + novelty + infoGain − redundancy) · 1.02^(t−τ)   # silence amplification d_p
Δu      = score − crowdRedundancy(N)                                    # built-in anti-spam term
pSpeak  = σ(λ · Δu) = 1 / (1 + e^(−λ·Δu))                               # QRE logit speak-gate
pVol    = N ≤ 1 ? 1 : 1 − (c/b)^(1/(N−1))                               # volunteer-dilemma N-scaler
effective = pSpeak · pVol
speak   = roll === undefined ? effective ≥ imThreshold : roll < effective
```

- **Silence amplification** `1.02^(t−τ)` (`t−τ` = seconds since the cybo last spoke / channel went
  quiet) guarantees a relevant-but-not-screaming point *eventually* clears the bar — it breaks
  silence without a separate timer. `t−τ=0` ⇒ factor exactly 1 (no double-count of a fresh turn).
- **Crowd redundancy** and the **volunteer N-scaler** are two anti-spam levers that compose: the first
  lowers `Δu` (the marginal value of *yet another* cybo saying it), the second lowers the firing
  probability as the pool of eligible volunteers grows. Both are required by the task spec; both are
  tested by the "crowd raises the bar" assertion.
- **Determinism for tests.** No internal RNG. Default = **threshold mode** (`effective ≥ imThreshold`)
  — fully deterministic. The **System-1 stochastic** path is opt-in via an injected `roll ∈ [0,1)`
  (`system1Prob` chooses, upstream, whether to sample); injecting `roll` keeps the unit test
  deterministic while still exercising the sampling branch.

## Personality (knobs travel with the cybo)

`λ` (chattiness — QRE inverse temperature), `imThreshold` (min `effective` to fire), `system1Prob`
(probability the caller uses the fast stochastic path). Sourced from the cybo via
`resolveProactivePersonality(cybo)`, **seeded from the existing `behavior_mode`** so the feature is
inert on today's data: `responsive → {low λ, high threshold}`, `proactive → {higher λ, lower
threshold}`. New explicit knobs override the seed; all values clamped. This reuses the `behavior_mode`
seed that `internal docs` §2 already earmarks as the L1/L3 seed — no schema churn required for S4.

## D4 unification — one provenance source, two derived flags

Today `spawnCybo` takes **independent** `autonomous` (Composio caller-binding,
`cybo-manager.ts:134/177`) and `unattended` (claude `bypassPermissions` + visible session, `:160/288`)
booleans. They both encode *"no live human invoker"* but are set by hand:

```
mention/slash/watcher:  ephemeral:true                       autonomous = (absent) false
task-dispatch:          ephemeral:true,  autonomous:true
schedule-runner:        unattended:true, autonomous:true
```

The new L3 self-trigger is a third system-initiated source — without paying D4 it would have to
remember to set BOTH flags. Fix:

```ts
type SpawnPosture = { autonomous: boolean; unattended: boolean };
function deriveSpawnPosture(trigger: TriggerType, opts?: { ephemeral?: boolean }): SpawnPosture {
  const humanInvoker = trigger === "mention" || trigger === "slash";
  const autonomous = !humanInvoker;            // no caller identity ⇒ drop caller-bound Composio
  const unattended = autonomous && !opts?.ephemeral; // no prompt-answerer, but visible (not internal)
  return { autonomous, unattended };
}
```

Invariant **`unattended ⟹ autonomous`** (a run with no one to answer prompts also has no human
invoker). `schedule-runner` (`trigger="cron"` → `{T,T}`) and `task-dispatch`
(`trigger="task", ephemeral:true` → `{T,F}`) adopt it with byte-identical output; the L3 path uses
`deriveSpawnPosture("self")` → `{T,T}`. The two booleans stop being two: one is derived from the
other through a single provenance source. (Scope stays in `cyborg/`; `spawnCybo`'s signature keeps
both fields for now — only the *derivation* is unified, so Paseo-adjacent surface is untouched.)

## Integration flow (task 6)

```
human posts (handleChannelMessage)
  └─ L3 wake path (message-router, level-gated to L3 by S2)
       └─ for each eligible cybo:
            signals = cheap cosine over pgvector memory + recent transcript   (caller-supplied)
            d = decideProactive({signals, ctx, personality})
            if (!d.speak) continue                                            # silent — no spawn
            req = { ...S2 level/regime, authorType, triggerType:"self", depth, … }
            if (shouldInvoke(req).invoke)                                     # S1 adjudicates
               spawnCybo({ ...deriveSpawnPosture("self") })                   # {autonomous,unattended}
```

The scorer never calls `spawnCybo`; every spawn flows through `shouldInvoke`. This is what makes S4 a
*policy value* on top of S1 rather than a new wake path — the exact maintainability goal of
`internal docs` §A.

## Testing strategy (CLI-first, deterministic)

All in `proactive-trigger.test.ts`, sharded by `-t` per task (see `tasks.md`). Pure functions →
fixed inputs → fixed outputs, no timers, no RNG (injected `roll` only). The S1 integration test uses a
stub/real `shouldInvoke` to prove the trigger is **consumed through** the gate (a `self` request that
the firewall can still veto), never authoritative.

## Risks / overlaps

- **With S1 (gate consumer):** S4 imports S1's `TriggerType` + `InvocationRequest` + `shouldInvoke`.
  If S1's union or request shape shifts, task 6 rebases (tasks 1–5 are independent). The firewall must
  treat `triggerType="self"` as agent-initiated for budget/depth purposes — S1 owns that branch; S4
  only *supplies* the request. Coordinate the `self` semantics with S1.
- **With S6 (swarm):** S6 reuses this scorer as the per-cybo "should I speak?" gate inside the swarm
  loop. Keep the module PURE and free of channel-regime assumptions so S6 can call it with swarm
  `ctx`/budgets unchanged. The crowd-redundancy + N-scaler terms are exactly what a swarm needs — do
  not special-case non-swarm here.
- **D4 scope creep:** the unification is deliberately limited to a pure `deriveSpawnPosture` + adopting
  it at the two existing system-triggered sites. We do NOT remove the `spawnCybo` fields or touch the
  human-invoker (mention/slash) sites in this change.
- **Cost:** L3 budget is 100 turns/day, 1M tok/day, GCRA 1/20s b=4 (`internal docs` iter4 table) — all
  enforced by S1, not here. S4 must not duplicate budget logic.

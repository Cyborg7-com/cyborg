# Change: autonomy-proactive-trigger (S4 — P2 / L3 "speak unprompted")

## Status

Proposed. Depends on **S1** (the pure `invocation-gate.ts` / `shouldInvoke`) and **S2**
(per-cybo `autonomy_level` + per-channel regime / `min()`). Package scope: **ONLY**
`packages/server/src/server/cyborg/`.

## Why

`internal docs` §C (P2) and `internal docs` §2 (L3 Proactive) define the next behavior change
*inside* the now-central invocation gate: a cybo that **speaks without being addressed**. Today a
cybo only wakes on an explicit `@`-mention or the `auto_tasks` watcher (which can only create/update
tasks, never freely reply). There is **no intrinsic-motivation trigger** — nothing that lets an L3
cybo decide, on its own, that an un-addressed message is worth a reply, while *not* turning every
channel into agent spam.

We also carry the **D4 debt**: `spawnCybo` exposes **two independent booleans** that both encode
"no live human invoker", set by hand at each call site and easy to desync:

| Call site | flags today | meaning |
|---|---|---|
| `@`-mention / watcher / slash (`message-router:798/1044`, `dispatcher:2068/5971/6056`) | `ephemeral:true` | human invoker present (`autonomous=false`) |
| task dispatch (`task-dispatch:232`) | `ephemeral:true, autonomous:true` | system-triggered, hidden |
| schedule (`schedule-runner:426`) | `unattended:true, autonomous:true` | system-triggered, visible |

`autonomous` (Composio: drop caller-bound toolkits, `cybo-manager.ts:134/177`) and `unattended`
(scheduled: claude `bypassPermissions`, visible session, `cybo-manager.ts:160/288`) are conceptually
the same axis — *is a human invoker present?* — but live as two flags. The **L3 self-trigger is a
new system-initiated source** that is BOTH autonomous AND unattended, so without paying D4 we'd add a
third hand-set-both-flags call site. We unify them: **derive both from one trigger-provenance source**
(`unattended ⟹ autonomous`).

## What changes

1. **A PURE proactive-trigger scorer** (`proactive-trigger.ts`, no I/O — sibling of S1's
   `invocation-gate.ts`). Inner-Thoughts intrinsic motivation
   `score = relevance + novelty + infoGain − redundancy`, with **silence amplification**
   `d_p = 1.02^(t−τ)` (eventually breaks silence).
2. **The QRE speak-gate** `P(speak) = σ(λ·Δu)` (logistic / logit quantal-response), where `Δu`
   subtracts a **crowd-redundancy** anti-spam term, plus the **volunteer-dilemma N-scaler**
   `p* = 1 − (c/b)^{1/(N−1)}` (more eligible cybos → each speaks less). The decision is **PURE and
   deterministic**: threshold mode by default (`effective ≥ imThreshold`), optional injected `roll`
   for the System-1 stochastic path (no internal RNG → tests are deterministic).
3. **Personality knobs** (`λ` chattiness, `imThreshold`, `system1Prob`) **sourced from the cybo**
   (`resolveProactivePersonality`), seeded from the existing `behavior_mode` (`responsive`→calm,
   `proactive`→chatty) so the change ships inert until S2 levels are wired.
4. **D4 unification** — one pure `deriveSpawnPosture(triggerType, {ephemeral})` returning
   `{autonomous, unattended}` with the invariant **`unattended ⟹ autonomous`**, adopted by
   `schedule-runner`, `task-dispatch`, and the new L3 self-trigger. The two hand-set booleans stop
   being independent.
5. **Integration behind the S1 gate.** The trigger is consumed THROUGH `shouldInvoke` with
   `triggerType="self"`: this module decides whether a cybo *wants* to speak; S1 decides whether it
   *may* (firewall, regime, `min(cybo,channel)`, depth/TTL, budgets). The scorer NEVER bypasses the
   gate.

## Non-goals

- No L4 social loop (memory / reflection / 2-party FSM / tick scheduler) — that is S5 (P3).
- No swarm / orchestrator (S6 / P4).
- No new embedding pipeline — `relevance/novelty/infoGain/redundancy` are **inputs** the caller
  supplies (cheap cosine over existing pgvector memory + recent transcript); this change only scores
  and gates them.
- No change to the `@`-mention or slash paths (human invoker present → `autonomous=false` unchanged).

## Impact

- New (cyborg-owned): `proactive-trigger.ts` + `proactive-trigger.test.ts`.
- Touched (cyborg-owned): `schedule-runner.ts`, `task-dispatch.ts` (adopt `deriveSpawnPosture`),
  the L3 wake path in `message-router.ts` (emit a `triggerType="self"` request to S1).
- No Paseo files; no relay duplication (daemon-first per `internal docs` §iter4 Q3).
- Behavior is flag/level-gated: with no cybo at L3 and no workspace autonomy, the scorer is never
  reached → zero behavior change until S2 enables a level.

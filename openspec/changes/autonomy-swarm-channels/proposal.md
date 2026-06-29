## Why

Today the agent→agent firewall is absolute and implicit: human posts flow through
`handleChannelMessage` (which can wake cybos), cybo/agent posts flow through
`handleAgentMessage` (which never wakes anyone), so a cybo can never react to another
cybo — guaranteed by call-graph topology, not by an explicit gate (`message-router.ts`
loop-prevention comments at `:827`, `:860`). That firewall is the right default, but it
also makes "pure-agent" channels — where cybos collaborate on a problem without a human in
the loop — structurally impossible. Lifting it naively is the textbook failure case:
infinite politeness loops (CAMEL), hallucination cascades (Project Sid / AI Village's
fake 93-person list that burned 8+ agent-hours), and "thousands of $/month" runaway cost
(internal docs–7). This change lifts the firewall **only inside opt-in `swarm` channels,
behind a flag**, replacing it with a *formally-bounded* depth counter + an OR-combined
budget stack + an orchestrator, so any agent→agent cascade is **provably terminating** and
cost-capped (internal docs/§C, internal docs). This is the last and most dangerous
autonomy phase (P4/L5); it ships dark, daemon-first, after the gate (S1), levels/regime
(S2), proactive (S4), and social memory (S5) land.

## What Changes

- **Swarm channel regime (firewall-lift).** Add a `swarm` channel regime that the S1
  invocation-gate (`shouldInvoke`) treats as the ONLY regime where `authorType: "agent"`
  posts may wake a cybo. Everywhere else the firewall stays intact (blast-radius
  containment). The lift is gated on an explicit `depth` counter (TTL on the message
  envelope) + a fan-out cap `f=1`, NOT on removing the author check.
- **Depth-bounded termination.** Every agent-triggered wake inherits `parent.depth − 1`,
  dropped at 0; a human seed resets to `ttl₀ = 6`. A1's well-founded ranking proves every
  reactive chain ≤ `ttl₀`, timing-independent. Total fan-out bounded by `Σ_{d=0}^{ttl₀} fᵈ`
  (= 7 at `f=1`, not 127).
- **Per-thread Orchestrator + progress ledger.** One lightweight orchestrator per swarm
  thread runs a Magentic-One progress ledger each turn (satisfied? looping? progress?
  who-next? what-instruction?) and selects the next single speaker (fan-out cap `f=1`).
- **Stride scheduler speaker-selection.** Virtual-time / stride scheduler (= Linux CFS)
  weighted by relevance — proportional-fair, anti-starvation, "just spoke → wait" falls out
  free. NOT decentralized handoffs (which ping-pong).
- **OR-combined budget stack (any one fires → thread stops).** max turns/thread (`ttl₀ = 6`),
  stall-counter ≤ 2, token/$ cap per thread, per-pair cooldown `1/60s` (A↔B ping-pong
  killer), per-cybo consecutive-reply cap, and an explicit `done`-token.
- **Novelty + SPRT stopping (NOT consensus).** Stop on embedding-novelty collapse + a
  Sequential Probability Ratio Test, never on agreement — C2's debate-as-martingale proves
  symmetric agreement rounds don't improve accuracy.
- **Contagion control.** Keep unverified claims sub-critical via citation-gating + the
  fan-out cap so `β·λ_max(A) < γ` — one cybo's hallucination can't infect the channel.
- **Cheap Critic circuit-breaker.** A small/cheap-model judge that can force-terminate a
  stalled/sycophantic thread (participants can't be trusted to notice they're stuck).
- **Flag-gated, daemon-first.** Entire regime behind a per-workspace experimental flag;
  all stateful machinery runs on the daemon (S5's social loop home), the relay only forwards.

## Capabilities

### New Capabilities
- `swarm-channels`: the L5 experimental swarm-channel regime — firewall-lift via the S1
  gate's explicit depth counter + fan-out cap, a per-thread orchestrator with a progress
  ledger, a stride scheduler, the OR-combined budget stack, novelty/SPRT stopping,
  contagion control, and the Critic circuit-breaker. All in `packages/server/src/server/cyborg/`.

### Modified Capabilities
<!-- None at the spec level: this change DEPENDS ON (does not re-spec) the S1 invocation-gate,
     S2 levels/regime, S4 proactive, and S5 social-memory capabilities. It extends the gate's
     `swarm` branch and consumes S5's per-cybo memory, but does not change their requirements. -->

## Impact

- **Code (ONLY `packages/server/src/server/cyborg/`):** new `swarm-orchestrator.ts`,
  `stride-scheduler.ts`, `swarm-budget.ts`, `novelty-stop.ts`, `swarm-critic.ts`,
  `contagion-guard.ts`; the S1 `invocation-gate.ts` gains the `swarm` regime + `depth`/`fanout`
  branch (already specced in S1, exercised here); `db/schema.ts` gains the swarm-thread
  ledger + per-thread budget/spend columns; channel regime enum extended with `swarm`.
- **Depends on:** S1 (invocation-gate — the depth/fanout firewall branch), S2 (channel
  regime + `min(cybo,channel)` placement), S4 (proactive trigger machinery), S5 (per-cybo
  social memory the orchestrator cites). Lands LAST in the autonomy roadmap.
- **No new runtime deps:** all primitives are O(1)-state (TTL int, GCRA float, stride
  pass-number, SPRT log-likelihood-ratio accumulator). The Critic + novelty embeddings reuse
  the cheap-model + pgvector path already in S5.
- **Rollout:** ships behind a per-workspace experimental flag (default OFF), daemon-first;
  the relay only forwards. No behavior change until a workspace opts a channel into `swarm`.
- **Safety contract:** termination, cost-cap, ping-pong, stall, and novelty-stop are proven
  by tests (see tasks.md / design.md), NEVER by manual observation.

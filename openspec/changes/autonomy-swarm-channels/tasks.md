# Tasks — S6 swarm-channels (L5, experimental)

Loop-resolvable, dependency-ordered. Package: ONLY `packages/server/src/server/cyborg/`.
Depends on S1 (invocation-gate), S2 (regime/levels), S4 (proactive), S5 (social memory).
Ships behind a per-workspace experimental flag (default OFF), daemon-first.

**Testing law:** the loop bounds are PROVEN by tests, never observed manually. Every task
ends with an exact `npx vitest run …` (run from `packages/server`). NO manual testing.

## 1. Swarm regime + gate depth-lift

- [ ] 1.1 Add `swarm` to the channel-regime enum (`db/schema.ts`) + the per-workspace
  experimental swarm flag (default OFF); migration for the regime column + flag.
- [ ] 1.2 Exercise the S1 `invocation-gate.ts` `swarm` branch: confirm `authorType:"agent"`
  is refused (`firewall`) for `regime!=="swarm"`, refused (`depth-exhausted`) at `depth<=0`,
  refused (`fanout-cap`) at `fanoutSoFar>=caps.fanout`, and that a human seed resets
  `childDepth=ttl₀` while an agent wake decrements. Flag OFF ⇒ firewall-equivalent.
- [ ] 1.3 Plumb the `depth` counter onto the message envelope so a reactive child inherits
  `parent.depth-1` across daemon forwarding; fail-CLOSED (stop) on missing thread state.
- [ ] 1.4 **TERMINATION property test (THE point):** `npx vitest run src/server/cyborg/invocation-gate.swarm.test.ts -t "termination"` — simulate every agent→agent cascade shape from a human seed at `ttl₀=6`, `f=1`; **assert no run exceeds the depth bound** (≤ `ttl₀` reactive hops) and total wakes ≤ `Σfᵈ`.

## 2. Orchestrator + progress ledger

- [ ] 2.1 `swarm-orchestrator.ts` — one orchestrator per thread; per-turn progress ledger
  (satisfied / looping / progress / who-next / instruction); emits exactly one next speaker
  or a stop. Persist the ledger row + stall-counter to `db/schema.ts`.
- [ ] 2.2 Wire the orchestrator as the ONLY speaker-handoff path in swarm channels (no
  decentralized handoffs); it consults `shouldInvoke` (defense-in-depth) before each wake.
- [ ] 2.3 Orchestrator stops on satisfied-goal / done-token.
- [ ] 2.4 Test: `npx vitest run src/server/cyborg/swarm-orchestrator.test.ts` — exactly one
  speaker per turn (`f=1`); ledger row persisted; stop on satisfied/done-token.

## 3. Stride scheduler

- [ ] 3.1 `stride-scheduler.ts` — pure virtual-time stride scheduler (pass/stride, weight =
  relevance score); pick min-pass, advance `pass += stride`. No daemon deps (like chain-router).
- [ ] 3.2 Test: `npx vitest run src/server/cyborg/stride-scheduler.test.ts` — just-spoke cybo
  waits (no consecutive monopoly); weights 3:1 ⇒ ~3× selections (proportional fairness);
  anti-starvation floor (every candidate eventually selected).

## 4. OR-combined budget stack

- [ ] 4.1 `swarm-budget.ts` — OR-combined checks (max turns/thread `ttl₀=6`, stall-counter
  `≤2`, token/$ cap, per-pair cooldown `1/60s` GCRA, per-cybo consecutive-reply cap,
  done-token). Pure verdict fn; stateful TAT/stall reads passed in (reuse S1 Slice-4 store).
- [ ] 4.2 Human mention/slash bypasses the autonomous budgets (preserve today's behavior).
- [ ] 4.3 **NO-RUNAWAY / cost-cap test:** `npx vitest run src/server/cyborg/swarm-budget.test.ts -t "cost-cap"` — drive token/$ to the per-thread cap; **assert the thread stops** (reason `budget`) and no further cybo is woken.
- [ ] 4.4 **PING-PONG test:** `npx vitest run src/server/cyborg/swarm-budget.test.ts -t "ping-pong"` — A↔B reply faster than `1/60s`; assert the second is `rate-limited` and the lock cannot form.
- [ ] 4.5 **STALL-COUNTER test:** `npx vitest run src/server/cyborg/swarm-budget.test.ts -t "stall"` — >2 no-progress turns ⇒ force-stop (reason `stall`).

## 5. Novelty / SPRT stopping

- [ ] 5.1 `novelty-stop.ts` — embedding-novelty (reuse S5 pgvector path) + SPRT accumulator;
  stop ONLY when novelty collapses AND SPRT crosses accept boundary. NOT consensus. Gate the
  stop on the Critic verification step (avoid premature termination, MAST FM-3.1).
- [ ] 5.2 **NOVELTY-STOP test:** `npx vitest run src/server/cyborg/novelty-stop.test.ts` — declining-novelty stream ⇒ stop (reason `novelty-stop`); consensus-but-still-novel stream ⇒ does NOT stop on agreement.

## 6. Critic + contagion guard

- [ ] 6.1 `swarm-critic.ts` — cheap-model Critic circuit-breaker; can force-terminate a
  stalled/sycophantic thread out-of-band (reason `critic`).
- [ ] 6.2 `contagion-guard.ts` — citation-gating (uncited factual claim flagged, not
  propagated) + fan-out cap to keep `β·λ_max<γ`; treat other cybos' claims as observations.
- [ ] 6.3 Test: `npx vitest run src/server/cyborg/swarm-critic.test.ts` — Critic force-
  terminates a stalled thread despite remaining budget; uncited claim is gated.
- [ ] 6.4 Flag + daemon-first integration: `npx vitest run src/server/cyborg/swarm-channels.integration.test.ts` — flag OFF ⇒ firewall-equivalent (no thread starts); flag ON ⇒ full bounded swarm runs daemon-side, relay only forwards.

## 7. Verification

- [ ] 7.1 `openspec validate autonomy-swarm-channels --strict` passes.
- [ ] 7.2 Full safety suite green: `npx vitest run src/server/cyborg/ -t "swarm"` — termination,
  cost-cap, ping-pong, stall, novelty-stop all pass. No manual testing performed.

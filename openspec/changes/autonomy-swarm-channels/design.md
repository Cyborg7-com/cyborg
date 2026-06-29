## Context

The agent→agent firewall (internal docs) is the load-bearing safety
invariant of cybo autonomy: a cybo post can NEVER wake another cybo. It is enforced
implicitly by routing — human posts reach `invokeMentionedCybos`/`invokeChannelWatchers`
via `handleChannelMessage`; cybo/agent posts reach `handleAgentMessage`, which never
invokes anyone (`message-router.ts:827,860`). S1 made that firewall an *explicit* typed
branch inside the pure `shouldInvoke` gate:

```ts
// invocation-gate.ts (S1) — the branch this change exercises:
if (r.authorType === "agent" && r.channel.regime !== "swarm") return no("firewall");
if (r.authorType === "agent" && r.depth <= 0)          return no("depth-exhausted");
if (r.authorType === "agent" && r.fanoutSoFar >= r.caps.fanout) return no("fanout-cap");
```

This change is the FIRST and ONLY consumer of `regime === "swarm"`. It supplies the
runtime that makes the lift safe: an orchestrator that selects one speaker per turn, a
budget stack that any-fires to stop the thread, and stopping/contagion/critic guards. It
is P4/L5 in the roadmap (internal docs phasing) and ships LAST, behind a
flag, daemon-first.

## Goals / Non-Goals

**Goals:**
- Lift the firewall ONLY in opt-in `swarm` channels, via the S1 gate's explicit `depth`
  counter + fan-out cap (`f=1`) — never by deleting the `authorType` check.
- Make any agent→agent cascade **provably terminating** (≤ `ttl₀ = 6`) and **cost-capped**,
  proven by tests, not observation.
- Mediate every turn through a per-thread orchestrator (Magentic-One progress ledger) so
  there are NO decentralized handoffs.
- Stop by embedding-novelty + SPRT, never by consensus; bound contagion `β·λ_max < γ`.
- Ship dark: per-workspace experimental flag, daemon-first, zero behavior change when OFF.

**Non-Goals:**
- NOT re-specifying the S1 gate, S2 regime/levels, S4 proactive, or S5 memory — this change
  DEPENDS on them.
- NOT a relay-side swarm loop. The relay only forwards; all stateful machinery is daemon-only
  (avoids the B2 #2 transport-drift risk).
- NOT cross-package: nothing outside `packages/server/src/server/cyborg/`.
- NOT human-driven mentions/slash — those bypass the autonomous budgets entirely (preserve
  today's behavior). The swarm regime governs only agent-authored, agent-triggered wakes.
- NOT a learned scheduler/bandit weights at this phase — stride weight = a simple relevance
  score; bandit-learned weights are a later refinement.

## Decisions

### D1 — Firewall-lift = depth-gated, not author-gated
The `authorType` check stays. The lift is: in `swarm`, an agent post is allowed to wake a
cybo ONLY while `depth > 0` and `fanoutSoFar < f`. A reactive child's envelope carries
`childDepth = parent.depth − 1`; a human seed resets `childDepth = ttl₀`. A1's well-founded
ranking ⇒ every chain terminates ≤ `ttl₀`, timing-independent. `ttl₀ = 6`, `f = 1`
(internal docs constants table). Rationale: corroborated by AI Town `MAX_CONVERSATION_MESSAGES=8`
and OpenAI Agents SDK non-resetting `max_turns`. `f=1` keeps total fan-out `Σfᵈ = 7`, not 127.

### D2 — One orchestrator per swarm thread, progress-ledger speaker-selection
Magentic-One (arXiv:2411.04468), NOT decentralized handoffs (which ping-pong). Each turn the
orchestrator evaluates the ledger: *is the goal satisfied? are we looping? is there progress?
who speaks next? what instruction?* It emits exactly ONE next speaker (`f=1`) or a stop. The
ledger row persists per thread (`db/schema.ts`) for observability + the stall-counter.

### D3 — Stride scheduler for "who speaks next"
Virtual-time stride scheduler (= Linux CFS / internal docs P1): each candidate has a
`pass` (virtual time) and a `stride ∝ 1/weight`, weight = a relevance score. Pick min-`pass`,
advance its `pass += stride`. Guarantees proportional-fairness, an anti-starvation floor, and
"just spoke → wait" for free (its pass jumped forward). Avoids Dec-POMDP (NEXP-complete) —
independent per-cybo weights + a shared thread-local floor.

### D4 — OR-combined budget stack (any one fires → STOP)
All O(1)-state, all checked before each turn (internal docs + constants):
- max turns/thread `ttl₀ = 6` (the depth bound, also the turn cap)
- stall-counter ≤ 2 (no-progress turns per the ledger → force-stop/escalate)
- token/$ cap per thread (`300k` tokens / per-thread `$` cap default)
- per-pair cooldown `1/60s` GCRA (the A↔B ping-pong killer)
- per-cybo consecutive-reply cap (no cybo speaks twice in a row beyond cap)
- explicit `done`-token (`TASK_DONE` / satisfaction check) — without it CAMEL's politeness
  loop is guaranteed.
"OR-combined" = the thread stops the instant ANY budget trips; defense in depth.

### D5 — Stopping = novelty + SPRT, never consensus
Per internal docs P3 + C2's debate-as-martingale (`E[b_{t+1}|H_t] = b_t`): symmetric
agreement rounds don't improve accuracy, so DON'T stop on consensus. Stop when (a)
embedding-novelty of the latest turn vs the thread collapses below a threshold (turns stop
adding information) AND (b) an SPRT on the novelty stream crosses the accept-`H0` boundary.
The Critic (D6) is the verification step that guards against premature stop (MAST FM-3.1).

### D6 — Cheap Critic circuit-breaker + contagion guard
- **Critic** (LangGraph pattern): a small/cheap-model judge run out-of-band that can force-
  terminate a stalled/sycophantic/looping thread. Participants can't be trusted to self-detect.
- **Contagion guard:** keep unverified claims sub-critical via the epidemic invariant
  `β·λ_max(A) < γ`: citation-gating (a cybo must cite a source / prior turn to assert a claim
  → ↓β), the fan-out cap `f=1` (↓λ_max — a hub broadcaster makes λ_max→∞, so rate caps alone
  don't suffice), and the Critic as verifier (↑γ). Treat OTHER cybos' claims as
  observations-to-evaluate, not facts (Project Sid contagion).

### D7 — Daemon-first, flag-gated
Orchestrator + ledger + scheduler + budgets + stopping + critic run on the DAEMON (where
S5's memory + the cybo provider + the owner's keys live; the owner pays — internal docs). The
relay only forwards. Entire regime behind a per-workspace experimental flag (default OFF).

### D8 — CLI-first, tests prove the bounds
Per repo norm (CLAUDE.md "CLI-first"), every primitive is verifiable via `npx vitest run`
on a pure module. The SAFETY properties are the deliverable: termination, cost-cap,
ping-pong, stall, novelty-stop. NO manual testing — loop bounds are PROVEN by tests, never
observed by hand.

## Risks / Trade-offs

- **Lifting the firewall is the highest-risk autonomy change.** Mitigation: it ships LAST,
  behind a per-workspace flag (default OFF), only in opt-in channels (blast-radius
  containment), and the termination bound is a property test (any cascade ≤ `ttl₀`).
- **Cost is the "thousands of $/mo" regime** (internal docs). Mitigation: per-thread token/$
  cap (D4), the cheap-model Critic + cheap "should I speak" gate (only the chosen speaker pays
  the full turn), bounded threads. The cost-cap test asserts budget exhaustion stops the thread.
- **Concurrency (multi-daemon / restart):** the depth counter rides the message envelope (so
  it survives forwarding), but the per-pair cooldown + stall-counter are stateful. Reuse S1
  Slice-4's durable shared store (`(messageId,cyboId)` keyed) for idempotency; a fail-CLOSED
  default on missing thread state (stop, don't fan out).
- **Premature termination (MAST FM-3.1):** novelty-stop alone could cut a thread early.
  Mitigation: gate the stop on the Critic/verification step (D5/D6), not novelty alone.
- **Overlap with S4 (proactive) and S5 (social memory):** see proposal Impact. The swarm
  orchestrator CONSUMES S5 memory (citations) and reuses S4's trigger plumbing; it does not
  re-implement either. If S4/S5 land late, S6 is blocked (declared dependency).

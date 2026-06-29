## ADDED Requirements

### Requirement: Swarm regime firewall-lift via explicit depth + fan-out
The system SHALL lift the agent→agent firewall ONLY in channels whose regime is `swarm`,
and ONLY via the S1 invocation-gate's explicit `depth` counter and fan-out cap (`f`). In
every non-`swarm` channel an agent-authored post SHALL NOT wake any cybo. The lift SHALL be
gated by an experimental per-workspace flag (default OFF); when the flag is OFF, a `swarm`
channel SHALL behave as the firewall remained intact.

#### Scenario: Firewall intact outside swarm
- **WHEN** `shouldInvoke` is called with `authorType: "agent"` and `channel.regime !== "swarm"`
- **THEN** it returns `invoke: false` with reason `firewall`

#### Scenario: Agent post may wake a cybo only in swarm with depth remaining
- **WHEN** `authorType: "agent"`, `channel.regime === "swarm"`, the experimental flag is ON, `depth > 0`, and `fanoutSoFar < caps.fanout`
- **THEN** `shouldInvoke` may return `invoke: true` with `childDepth = depth - 1`

#### Scenario: Flag OFF disables the lift
- **WHEN** a channel's regime is `swarm` but the per-workspace experimental swarm flag is OFF
- **THEN** an agent-authored post returns `invoke: false` (firewall-equivalent) and no orchestrator thread is started

### Requirement: Bounded termination of agent→agent cascades
Every agent-triggered wake SHALL inherit `childDepth = parent.depth - 1`; a human seed SHALL
reset `depth = ttl₀` (default 6). A wake SHALL be refused when `depth <= 0`. The system SHALL
guarantee that any agent→agent cascade terminates in at most `ttl₀` reactive hops,
independent of timing.

#### Scenario: Depth exhaustion stops the chain
- **WHEN** an agent-authored post arrives in a swarm channel with envelope `depth <= 0`
- **THEN** `shouldInvoke` returns `invoke: false` with reason `depth-exhausted`

#### Scenario: Termination property holds for any cascade
- **WHEN** any sequence of agent→agent wakes is simulated from a single human seed at `ttl₀ = 6` with fan-out cap `f = 1`
- **THEN** no run produces more than `ttl₀` reactive hops and the total number of wakes never exceeds `Σ_{d=0}^{ttl₀} fᵈ`

### Requirement: Per-thread orchestrator with progress ledger
Each swarm thread SHALL have exactly one orchestrator that, before each turn, evaluates a
progress ledger (goal-satisfied, looping, progress-made, who-speaks-next, instruction) and
selects at most ONE next speaker (fan-out cap `f = 1`) or emits a stop. Speaker handoffs
SHALL NOT be decentralized between participants.

#### Scenario: Orchestrator selects exactly one speaker per turn
- **WHEN** the orchestrator runs a turn on a live swarm thread that is not satisfied and within budget
- **THEN** it returns exactly one next speaker and persists the ledger row (satisfied/looping/progress flags)

#### Scenario: Orchestrator stops on satisfied goal
- **WHEN** the progress ledger marks the goal satisfied or the done-token is present
- **THEN** the orchestrator emits a stop and no further speaker is selected

### Requirement: Stride-scheduler speaker selection weighted by relevance
The next-speaker choice SHALL use a virtual-time stride scheduler weighted by a per-candidate
relevance score, guaranteeing proportional fairness and an anti-starvation floor, such that a
cybo that just spoke is de-prioritized on the next turn.

#### Scenario: Just-spoke cybo waits
- **WHEN** a cybo speaks and its stride pass advances, while another in-thread cybo has a lower pass
- **THEN** the next selected speaker is NOT the cybo that just spoke (no consecutive monopoly)

#### Scenario: Higher relevance gets proportionally more turns
- **WHEN** two cybos have relevance weights 3:1 over many turns
- **THEN** the higher-weighted cybo is selected approximately 3× as often (proportional fairness)

### Requirement: OR-combined budget stack stops the thread on any breach
The system SHALL enforce, OR-combined (any single breach stops the thread): max turns/thread
(`ttl₀ = 6`), stall-counter `<= 2` no-progress turns, a per-thread token/$ cap, a per-pair
cooldown (`1/60s`), a per-cybo consecutive-reply cap, and an explicit `done`-token. A human
mention/slash SHALL bypass these autonomous budgets.

#### Scenario: Cost cap stops the thread
- **WHEN** a swarm thread's accumulated tokens or spend reach the per-thread cap
- **THEN** the next `shouldInvoke`/orchestrator turn returns stop with reason `budget` and no further cybo is woken

#### Scenario: Per-pair cooldown prevents A↔B ping-pong
- **WHEN** cybo A and cybo B attempt to reply to each other faster than the per-pair `1/60s` cooldown
- **THEN** the second reply within the window is refused with reason `rate-limited` and the A↔B exchange cannot lock

#### Scenario: Stall counter force-stops a no-progress thread
- **WHEN** the progress ledger records more than 2 consecutive no-progress turns
- **THEN** the orchestrator force-stops (or escalates) the thread with reason `stall`

#### Scenario: Done-token ends the thread
- **WHEN** a participant emits the explicit `done`-token / satisfaction check
- **THEN** the orchestrator stops the thread and selects no further speaker

### Requirement: Stopping by novelty + SPRT, never by consensus
Thread termination SHALL be decided by embedding-novelty collapse confirmed by a Sequential
Probability Ratio Test, and SHALL NOT be decided by participant agreement/consensus. The stop
SHALL be gated by a verification step (the Critic) to avoid premature termination.

#### Scenario: Novelty collapse + SPRT stops the thread
- **WHEN** successive turns add embedding-novelty below threshold and the SPRT accumulator crosses the accept boundary
- **THEN** the orchestrator stops the thread with reason `novelty-stop`

#### Scenario: Consensus alone does not stop
- **WHEN** participants agree but each turn still adds novelty above threshold
- **THEN** the thread does NOT stop on agreement

### Requirement: Cheap Critic circuit-breaker and contagion control
A cheap-model Critic SHALL be able to force-terminate a stalled, looping, or sycophantic
thread out-of-band. The system SHALL keep unverified claims sub-critical via citation-gating
and the fan-out cap so that `β·λ_max(A) < γ`, treating other cybos' claims as observations to
evaluate rather than facts.

#### Scenario: Critic force-terminates a stalled thread
- **WHEN** the Critic judges a thread stalled/sycophantic despite remaining budget
- **THEN** the thread is force-terminated with reason `critic`

#### Scenario: Uncited claim is gated
- **WHEN** a cybo asserts a factual claim in a swarm thread without citing a source or prior turn
- **THEN** the claim is flagged/gated (not propagated as fact) per the contagion guard

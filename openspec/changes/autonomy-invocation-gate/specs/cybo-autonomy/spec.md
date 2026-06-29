# Spec delta — cybo-autonomy (invocation gate)

## ADDED Requirements

### Requirement: Pure invocation gate
The system SHALL provide a single pure function `shouldInvoke(request)` in
`packages/server/src/server/cyborg/invocation-gate.ts` that decides whether a cybo wakes
to act. The module SHALL have zero I/O and zero daemon/storage/relay imports (same purity
contract as `chain-router.ts`) so it is importable by both the daemon and the relay-light
bundle. All stateful inputs (autonomy switch, GCRA verdict, breaker state, budgets, depth,
fan-out) SHALL be passed in by the caller; the gate SHALL NOT read them itself.

#### Scenario: Gate is pure and importable by both transports
- **WHEN** `invocation-gate.ts` is imported
- **THEN** it pulls in no daemon, storage, relay, or network module
- **AND** `shouldInvoke` returns a decision computed only from its argument
- **AND** the same call with the same `InvocationRequest` always returns the same `InvocationDecision`

#### Scenario: Decision shape
- **WHEN** `shouldInvoke` returns an allow decision
- **THEN** it is `{ invoke: true, effectiveLevel, childDepth }`
- **WHEN** it returns a block decision
- **THEN** it is `{ invoke: false, reason }` where `reason` is a typed `BlockReason`

### Requirement: Explicit author firewall
The gate SHALL enforce the anti-loop firewall as an explicit `authorType` branch: an
agent-authored post SHALL NOT wake a cybo unless the channel regime is `swarm`. This
replaces the implicit call-graph routing that previously enforced the invariant.

#### Scenario: Agent author blocked outside swarm
- **WHEN** `authorType="agent"` and `channel.regime` is `mention-only` or `open`
- **THEN** the decision is `{ invoke: false, reason: "firewall" }`

#### Scenario: Agent author allowed in swarm regime
- **WHEN** `authorType="agent"` and `channel.regime="swarm"` and no other gate blocks
- **THEN** the firewall branch does not block and evaluation continues to the anti-loop checks

#### Scenario: Firewall holds for all non-firewall fields (property)
- **WHEN** `authorType="agent"` and `channel.regime≠"swarm"` for any combination of the other request fields
- **THEN** the decision is always `{ invoke: false, reason: "firewall" }`

### Requirement: Anti-loop primitives as O(1) checks
The gate SHALL enforce, as O(1) checks on caller-supplied state, in this order after the
firewall: TTL depth exhaustion, fan-out cap, budget (turns/tokens), GCRA rate conformance,
and the unproductive-turn circuit-breaker. On an allow decision it SHALL compute
`childDepth` as `TTL0` for a human author and `depth - 1` for an agent author.

#### Scenario: TTL depth exhausted
- **WHEN** `authorType="agent"` and `depth <= 0`
- **THEN** the decision is `{ invoke: false, reason: "depth-exhausted" }`

#### Scenario: Fan-out cap reached
- **WHEN** `authorType="agent"` and `fanoutSoFar >= caps.fanout`
- **THEN** the decision is `{ invoke: false, reason: "fanout-cap" }`

#### Scenario: Budget exhausted
- **WHEN** `spent.turns >= caps.turns` or `spent.tokens >= caps.tokens`
- **THEN** the decision is `{ invoke: false, reason: "budget" }`

#### Scenario: Rate limited by GCRA
- **WHEN** `rate.conformant` is false
- **THEN** the decision is `{ invoke: false, reason: "rate-limited" }`

#### Scenario: Circuit-breaker open
- **WHEN** `breakerOpen` is true
- **THEN** the decision is `{ invoke: false, reason: "breaker-open" }`

#### Scenario: childDepth propagation
- **WHEN** the decision allows invocation and `authorType="human"`
- **THEN** `childDepth = TTL0`
- **WHEN** the decision allows invocation and `authorType="agent"`
- **THEN** `childDepth = depth - 1`

### Requirement: Effective level and regime placement
The gate SHALL compute `effectiveLevel = min(cybo.defaultAutonomyLevel,
channel.maxAutonomyLevel)` and block when it is `Silent`. In a `mention-only` regime only
`mention` or `slash` triggers SHALL pass; mention and slash triggers SHALL bypass the
autonomous budget/GCRA/breaker checks (a human explicitly asked). The global autonomy
kill switch SHALL block all non-mention triggers when off.

#### Scenario: min(cybo,channel) placement
- **WHEN** `cybo.defaultAutonomyLevel` is higher than `channel.maxAutonomyLevel`
- **THEN** `effectiveLevel` equals `channel.maxAutonomyLevel`

#### Scenario: Effective level silent blocks
- **WHEN** `effectiveLevel` resolves to `Silent`
- **THEN** the decision is `{ invoke: false, reason: "level-silent" }`

#### Scenario: Mention-only regime admits only mention or slash
- **WHEN** `channel.regime="mention-only"` and `triggerType` is `passive`, `self`, `peer`, `cron`, `task`, or `webhook`
- **THEN** the decision is `{ invoke: false, reason: "mention-only-regime" }`
- **WHEN** `channel.regime="mention-only"` and `triggerType` is `mention` or `slash` and no other gate blocks
- **THEN** the regime check does not block

#### Scenario: Autonomy kill switch off
- **WHEN** `workspaceAutonomyOn` is false and `triggerType≠"mention"`
- **THEN** the decision is `{ invoke: false, reason: "autonomy-off" }`

### Requirement: Shadow-mode migration of all deciders
The system SHALL migrate every invocation decider in the migration table (the
`message-router` watchers and mention path, the `cybo-mention-invoke` relay paths, the
`dispatcher` receivers, the slash `/ask` path, and the cron/task dispatchers) to call
`shouldInvoke` alongside its existing inline logic. Each migrated decider SHALL use the
inline decision as authoritative and SHALL log any divergence between the gate verdict and
the inline verdict. This change SHALL NOT alter the runtime behavior of any decider.

#### Scenario: Gate runs but inline stays authoritative
- **WHEN** a migrated decider evaluates whether to invoke a cybo
- **THEN** it computes both the inline decision and the gate decision
- **AND** it acts on the inline decision
- **AND** the observable invoke/skip behavior is unchanged from before the migration

#### Scenario: Divergence is logged
- **WHEN** the gate decision differs from the inline decision at a migrated call site
- **THEN** a divergence record is logged with the decider name, both verdicts, and the gate reason

### Requirement: Behavior-preserving characterization
The current invoke/skip decisions SHALL be frozen as golden characterization tests before
any decider is migrated, and a differential test SHALL prove `shouldInvoke` reproduces
every golden decision (verdict + reason) byte-identically, establishing the migration as a
pure refactor.

#### Scenario: Golden matrix captured before migration
- **WHEN** the golden tests run against the current inline logic
- **THEN** they record the invoke/skip decision and reason for the matrix
  `{mention, watcher} × {human, agent} × autonomy{on,off} × auto_tasks{on,off} × rate{ok,limited} × member{yes,no,cross-workspace}` on both transports

#### Scenario: Gate matches the golden baseline
- **WHEN** every golden row is fed through `shouldInvoke`
- **THEN** the gate's verdict and reason match the frozen golden baseline for every row

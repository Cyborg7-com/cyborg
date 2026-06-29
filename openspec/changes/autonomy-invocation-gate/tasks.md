# Tasks — autonomy-invocation-gate (S1 / Phase 0)

Ordered, independently-completable steps. Each task is small enough to finish in one
loop iteration and names the **exact** verification command (no manual testing). All work
is confined to `packages/server/`; run commands from that package root unless noted.

Shorthand: `VITEST=npx vitest run` (from `packages/server/`).

---

- [ ] **1. Golden characterization tests (capture TODAY's behavior FIRST).**
  Before touching any decider, write `src/server/cyborg/invocation-gate.golden.test.ts`
  that drives the *current* inline logic and records the invoke/skip decision + reason
  for the full matrix: `{mention, watcher} × {human, agent} × autonomy{on,off} ×
  auto_tasks{on,off} × rate{ok,limited} × member{yes,no,cross-workspace}`, on BOTH
  transports (daemon `message-router` + relay `cybo-mention-invoke`). Extract the inline
  predicates behind small testable shims if needed (no behavior change). These goldens
  are the P0 contract; commit them red→green as the frozen baseline.
  - Verify: `npx vitest run src/server/cyborg/invocation-gate.golden.test.ts`

- [ ] **2. Create the pure gate + types.**
  Add `src/server/cyborg/invocation-gate.ts` with the `shouldInvoke` signature from
  `design.md` (AuthorType / TriggerType / ChannelRegime / Level enums, InvocationRequest,
  InvocationDecision, BlockReason). PURE: zero imports of daemon/storage/relay code (mirror
  `chain-router.ts`). Implement the branch order exactly: autonomy-off → firewall →
  depth → fan-out → budget → GCRA → breaker → mention-only-regime → `min()` →
  level-silent → childDepth. For P0, defaults reproduce today (non-swarm ⇒ firewall
  blocks agent authors; mention/slash bypass autonomous budgets).
  - Verify: `npx vitest run src/server/cyborg/invocation-gate.test.ts` (next task adds it);
    typecheck: `npx tsc --noEmit -p packages/server/tsconfig.json`

- [ ] **3. Unit tests for the gate + each anti-loop primitive.**
  Add `src/server/cyborg/invocation-gate.test.ts` covering: TTL depth counter
  (`depth<=0 ⇒ depth-exhausted`; `childDepth = human?TTL0 : depth-1`), fan-out cap
  (`fanoutSoFar>=caps.fanout ⇒ fanout-cap`), GCRA verdict passthrough
  (`rate.conformant=false ⇒ rate-limited`), circuit-breaker (`breakerOpen ⇒
  breaker-open`), budget (`spent.turns/tokens>=caps ⇒ budget`), `min(cybo,channel)`
  placement, mention/slash budget-bypass, and the autonomy-off kill switch.
  - Verify: `npx vitest run src/server/cyborg/invocation-gate.test.ts`

- [ ] **4. Firewall property test (the invariant that replaces 8×2 implicit routing).**
  In the gate test (or a sibling `invocation-gate.firewall.test.ts`), add a property test:
  `∀ InvocationRequest with authorType="agent" ∧ channel.regime≠"swarm" ⇒ invoke=false
  ∧ reason="firewall"` (fuzz all other fields). This single test guards what was an
  untestable topological accident.
  - Verify: `npx vitest run src/server/cyborg/invocation-gate.firewall.test.ts`
    (or the matching `-t firewall` filter if folded into the main test file)

- [ ] **5. Differential test (gate reproduces the goldens byte-identically).**
  Add a test that feeds every golden row through `shouldInvoke` and asserts the verdict +
  reason match the frozen baseline from task 1. This proves the migration is a pure
  refactor before any call site flips.
  - Verify: `npx vitest run src/server/cyborg/invocation-gate.golden.test.ts`

- [ ] **6. Shadow-wire `message-router.invokeChannelWatchers` (`:837`).**
  Build the `InvocationRequest` from the call site's already-read state (PG autonomy
  switch, member, rate verdict, dedup), call `shouldInvoke`, **use the inline decision**,
  and `log` divergence (`[invocation-gate-shadow] decider=invokeChannelWatchers
  inline=… gate=… reason=…`) when they differ. No control-flow change.
  - Verify: `npx vitest run src/server/cyborg/invocation-gate.golden.test.ts &&
    npx vitest run src/server/cyborg/message-router`

- [ ] **7. Shadow-wire `message-router.invokeMentionedCybos` (`:695`).**
  Same pattern (`authorType=human`, `triggerType=mention`). Inline authoritative;
  divergence logged.
  - Verify: `npx vitest run src/server/cyborg/message-router`

- [ ] **8. Shadow-wire `message-router.runWatcherFailover` (`:1024`).**
  Call `shouldInvoke` per-candidate inside the `attempt` callback; log divergence.
  - Verify: `npx vitest run src/server/cyborg/message-router`

- [ ] **9. Shadow-wire `cybo-mention-invoke.invokeMentionedCybosViaRelay` (`:613`).**
  The relay `authorType!=="human"` literal (≈`:620`) becomes the single classification
  point feeding `shouldInvoke`. Inline authoritative; divergence logged.
  - Verify: `npx vitest run src/server/cyborg/cybo-mention-invoke`

- [ ] **10. Shadow-wire `cybo-mention-invoke.invokeChannelWatchersViaRelay` (`:912`).**
  - Verify: `npx vitest run src/server/cyborg/cybo-mention-invoke`

- [ ] **11. Shadow-wire `cybo-mention-invoke.forwardWatchToChain` (`:1068`).**
  Per-candidate gate call in the `attempt` callback (mirrors task 8 on the relay side).
  - Verify: `npx vitest run src/server/cyborg/cybo-mention-invoke`

- [ ] **12. Shadow-wire `dispatcher.handleInvokeCyboMention` (`:5921`).**
  Defense-in-depth re-check: build the request, call the gate, log divergence; preserve
  the existing dedup + native-harness-gap guards as authoritative.
  - Verify: `npx vitest run src/server/cyborg/dispatcher`

- [ ] **13. Shadow-wire `dispatcher.handleInvokeChannelWatch` (`:6012`).**
  Keep the daemon's live PG autonomy re-read (`:6028`) as authoritative; gate runs beside it.
  - Verify: `npx vitest run src/server/cyborg/dispatcher`

- [ ] **14. Shadow-wire the slash path `dispatcher.handleSlashCommand` /
  `handleAskCybo` (`:1445` / `:2068`).**
  Only `/ask` reaches `spawnCybo`; route its decision through the gate with
  `triggerType="slash"`. Inline authoritative; divergence logged.
  - Verify: `npx vitest run src/server/cyborg/dispatcher`

- [ ] **15. Shadow-wire cron/task: `schedule-runner.fire` (`schedule-runner.ts:421`) +
  `task-dispatch.dispatchTaskToAgent` (`task-dispatch.ts:232`).**
  `triggerType="cron"`/`"task"`, `authorType="agent"`, autonomous budgets; inline
  authoritative; divergence logged.
  - Verify: `npx vitest run src/server/cyborg/schedule-runner &&
    npx vitest run src/server/cyborg/task-dispatch`

- [ ] **16. Full gate suite + lint + typecheck (green gate before handing off).**
  - Verify: `npx vitest run src/server/cyborg/invocation-gate` (all gate tests) `&&`
    `pnpm --filter @getpaseo/server lint` (oxlint/oxfmt) `&&`
    `npx tsc --noEmit -p packages/server/tsconfig.json`

- [ ] **17. Validate the OpenSpec change.**
  - Verify (repo root): `openspec validate autonomy-invocation-gate --strict`

---

### Done = all 17 boxes checked

Each of tasks 6–15 is one decider (loop-resolvable in isolation); the gate + tests
(1–5) land first so every wiring task has a differential oracle. The flip-to-authoritative
step is intentionally a **separate future change** (after prod shadow logs show 0
divergence), per `internal docs` §"Rollout sequence".

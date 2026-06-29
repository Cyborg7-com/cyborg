# Change: autonomy-invocation-gate (S1 / Phase 0)

## Why

Today "should this cybo wake up and speak?" is decided by **8 `spawnCybo` sites across
4 modules and ~7 decision functions duplicated over 2 transports** (daemon-local
`message-router` + cloud `cybo-mention-invoke`), plus the `dispatcher` receivers, the
slash path, and cron/task. The anti-loop firewall (no agent post may wake a cybo) is an
**implicit call-graph accident** — it holds only because human posts route through
`handleChannelMessage` (can invoke) and agent posts route through `handleAgentMessage`
(never invokes). That is B2's #1 instability source: untestable, scattered, and the one
invariant the comments say "we must NOT break."

Adding the planned Cybo-Autonomy feature (per-cybo levels, per-channel regimes,
`min(cybo,channel)` placement, the swarm mode) on this surface means duplicating the new
policy across ~7 functions × 2 transports, **including near the firewall**. Not
maintainable. This change extracts the keystone so every later autonomy slice (S2–S6) is
a policy change in **one** pure function, not code sprayed everywhere.

See `internal docs` §A (the `shouldInvoke` signature +
the 10-row migration table) and `internal docs` §4 (the audit).

## What Changes

- **NEW pure module** `packages/server/src/server/cyborg/invocation-gate.ts` exporting
  `shouldInvoke(req): InvocationDecision` — zero I/O, zero daemon deps (same purity
  contract as `chain-router.ts`), importable by both the daemon and the relay-light
  bundle. It makes the firewall an **explicit `authorType: "human" | "agent"` branch**,
  computes `min(cybo,channel)`, and enforces the anti-loop primitives as **O(1) checks
  fed in by the caller**: TTL depth counter + fan-out cap, GCRA token-bucket verdict
  (per `(cybo,channel)` + per-pair), and a circuit-breaker on unproductive turns.
- **SHADOW-MODE migration** of all 10 deciders (the internal docs table:
  `message-router` ×3, `cybo-mention-invoke` ×3, `dispatcher` receivers ×2, slash,
  cron/task) to call `shouldInvoke` alongside the existing inline logic — **decide both
  ways, use the inline result, log any divergence**. Zero behavior change.
- **Golden characterization tests** that freeze today's invoke/skip decisions BEFORE any
  call site is touched, a **differential** test proving the gate reproduces them
  byte-identically, a **firewall property test** (`∀ authorType=agent ∧ regime≠swarm ⇒
  invoke=false`), and **unit tests for each anti-loop primitive**.

**Explicitly NOT in this change** (deferred): flipping the gate to authoritative;
per-cybo levels / per-channel regimes / DB schema (that is **S2 dials-schema**); the
durable shared dedup+rate store that fixes the restart/multi-daemon races (S-hardening);
any social/swarm machinery (S3–S6). This change is a **pure refactor with shadow
telemetry** — the gate is computed but never authoritative.

## Impact

- **Affected package (ONLY):** `packages/server/src/server/cyborg/`.
- **New files:** `invocation-gate.ts`, `invocation-gate.test.ts`.
- **Edited files (shadow-mode call only, no behavior change):** `message-router.ts`,
  `cybo-mention-invoke.ts`, `dispatcher.ts`, `schedule-runner.ts`, `task-dispatch.ts`.
- **Risk:** near-zero — the inline decision stays authoritative; the gate's verdict is
  logged-only. The firewall and all current guards are untouched at runtime.
- **Blocks:** S2 (dials-schema), S3–S6 (levels/regime/proactive/social/swarm) — they all
  land as behavior changes *inside* this now-central gate.
- **Depends on:** nothing.

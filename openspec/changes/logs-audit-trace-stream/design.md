# Design — logs-audit-trace-stream

## Context

The Logs tab today renders `logState.entries`, fed by two client paths only:
`client.on("agent_stream", …)` (agent timeline) and `client.on("task_event", …)`
(the `task-event-log.ts` pipeline). The server emits the latter from exactly two
seams that already exist and are proven:

- **Daemon:** `MessageRouter.broadcastTaskEvent()` → `this.broadcast.toWorkspace(ws, taskEventBroadcast(event))`
  (`message-router.ts` ~1789).
- **Relay:** `emitTaskEventForWorkspace()` / inline watcher `emitTaskEvent` →
  `broadcastToGuests(ws, taskEventBroadcast(event))` (`relay-standalone.ts` ~581 / ~4908).

Both consume the pure envelope from `task-event-log.ts`. The client ingests it in
`ws-client.ts` (~1919, the `cyborg:task_event` branch) and `app.svelte.ts` (~1966,
`logState.push`). This change clones that proven pipeline for a sibling
`cyborg:audit_event` rather than overloading `task_event` (which is purpose-built
for `category:"task"` and whose payload IS a pre-formatted task line).

## The inventory that drives the design (re-route vs add)

The research classified every high-value cybo trace. Summary of WHERE the data is
and what each event needs:

| Theme | Representative existing trace(s) | Today | Action |
|---|---|---|---|
| **context injection** | `buildCyboPrompt` result in `spawnCybo` (`cybo-manager.ts:178`) | **not logged anywhere** | **ADD** emit (preview+len+hash) |
| **tool/MCP injection** | `mcpServers` assembly + `cyborg7` base url (`cybo-manager.ts:182-189,238`); Composio mint (`composio-mcp.ts`, branch) | **not logged** (only branch `cybo-manager.ts:154` warn on mint failure) | **ADD** emit (server names + base url, redacted) |
| **spawn lifecycle** | lazy-restore `message-router.ts:1167`; ephemeral watchdog `:1264`; teardown `:658` | daemon.log-only | **RE-ROUTE** + add spawn start/success (spawn itself is unlogged) |
| **invocation decisions** | mention/watcher failures `message-router.ts:759/774/1073/1105`; relay `cybo-mention-invoke.ts:621-1107`; firewall = `RateLimiter` (no logs of its own, decided at call sites); autonomy gate silent returns `message-router.ts:857`, `relay-standalone.ts:4984`, `dispatcher.ts:6816` | daemon.log-only or **completely silent** | **RE-ROUTE** (silent gates → `debug`, verbose-only) |
| **errors/failures** | `reportCyboSpawnFailure` `message-router.ts:1105`; credential-missing `cybo-openai-compatible.ts:294`; Composio mint failure `cybo-manager.ts:154` (branch); `daemon_telemetry` relay-only `relay-standalone.ts:9183` | daemon.log / relay-CloudWatch | **RE-ROUTE** |
| **daemon operations** | credential set/remove `cybo-credentials.ts:361/375`; reaper kills `agent-backend-reaper.ts:216-298`, `pty-host-reaper.ts:108-152`; session-safety quarantine `session-safety.ts:144-198`; schedule skips `schedule-runner.ts:160-547` | daemon.log-only | **RE-ROUTE** |

**Conclusion:** the ONLY new instrumentation is the spawn context/tool snapshot
(the single biggest blind spot). Everything else is a re-route of an already-written
pino call through a structured sink.

## The event model

`audit-event-log.ts` (pure, sibling of `task-event-log.ts`):

```ts
export type AuditLevel = "debug" | "info" | "warn" | "error";
export type AuditCategory =
  | "context_injection"
  | "tool_injection"
  | "spawn_lifecycle"
  | "invocation_decision"
  | "daemon_operation"
  | "failure";

export type AuditEvent = {
  kind: string;            // fine-grained discriminant, e.g. "spawn.context", "reaper.kill"
  category: AuditCategory;
  level: AuditLevel;
  workspaceId: string;
  daemonId?: string | null;
  agentId?: string | null;     // == sessionId for the session-viewer tie-in
  cyboId?: string | null;
  userId?: string | null;
  channelId?: string | null;
  payload: Record<string, unknown>;  // redacted, capped — see below
};

export interface AuditEventLine extends AuditEvent {
  // server-formatted human line so the pane renders with zero client logic,
  // exactly like TaskEventLogLine
  source: string;    // actor/subsystem shown in the Source column
  message: string;
}

export function formatAuditEvent(e: AuditEvent): AuditEventLine; // PURE
export interface AuditEventBroadcast { type: "cyborg:audit_event"; payload: AuditEventLine }
export function auditEventBroadcast(e: AuditEvent): AuditEventBroadcast;
```

`timestamp` is assigned client-side at `logState.push` (same as task events today),
so the formatter stays clock-free and pure.

## The auditSink adapter (re-route mechanism)

`audit-sink.ts` exposes one function the seams already in scope can call:

```ts
export interface AuditSink {
  emit(event: AuditEvent): void;   // best-effort, never throws
}
```

- On the **daemon**, the sink is backed by `MessageRouter.broadcast.toWorkspace`
  (a new `broadcastAuditEvent` method mirroring `broadcastTaskEvent` — try/caught,
  best-effort).
- On the **relay**, by `broadcastToGuests` (a new `emitAuditEventForWorkspace`
  mirroring `emitTaskEventForWorkspace`).
- The existing pino call is **kept**; the re-route is one extra `sink.emit({...})`
  next to it. Pattern at each site: keep `logger.warn({…}, "…")`, add
  `auditSink.emit({ category, level, kind, workspaceId, …, payload })`.

This is a deliberate, minimal seam — NOT a generic "tap every pino log" interceptor
(that would pull untyped Paseo `agent/` logs into the workspace stream and break the
package boundary). Only the explicitly-chosen `cyborg/` traces are re-routed.

## Verbosity & flood control (the owner's explicit concern)

1. **Levels.** Every event has a level. The Logs pane's default level filter already
   excludes nothing, so the default is changed to **exclude `debug`** for audit
   categories. `info` = meaningful operations (spawn, teardown, credential change,
   reaper kill, real failures). `debug` = high-frequency low-signal (autonomy-gate
   silent skips, dedup-guard returns, per-stream broadcast warnings).
2. **Verbose gate.** `debug`-level audit events are emitted ONLY when
   `CYBORG7_AUDIT_VERBOSE` is set (env, default off). When off, the silent hot-path
   gates emit nothing — identical to today's behavior, zero flood risk.
3. **Redaction (non-negotiable).** The system prompt is NEVER shipped in full:
   `payload.promptPreview` = first 280 chars, `payload.promptLength`, and
   `payload.promptSha256` = first 12 hex of the digest (lets you diff "did this
   session get a different prompt?" without shipping kilobytes). API keys,
   Composio `ck_` consumer keys, scoped MCP tokens, and the `?...` query string of
   the `cyborg7` / scoped MCP URLs are stripped to host+path before emit. A
   redaction allow-list lives in `audit-event-log.ts` and is unit-tested.
4. **Caps.** `payload` is capped (e.g. JSON-serialized ≤ 4 KB, same spirit as the
   client-log message/stack caps), and the client `logState` already caps entries at
   500 with FIFO trim — audit events share that cap, so memory is bounded.
5. **Trust boundary / capability gate.** Audit events are workspace-scoped (only
   broadcast to that workspace's members, same as task events) AND only surfaced to
   members holding the admin/audit capability (ties into the daemon-access scopes
   model). Non-admins never see daemon internals.

## Session-viewer tie-in (contract, not the viewer)

`context_injection`, `tool_injection`, and `spawn_lifecycle` events carry the
spawn's `agentId` (which equals the provider `sessionId` for cybo sessions). The UI
filter helper exposes `filterAuditBySession(entries, agentId)`. The read-only
session viewer (sibling spec `sessions-readonly-viewer`) deep-links into LogsPane
pre-filtered to a session, answering "what context + tools did THIS session get"
in one click from its transcript. This change ships the field + the pure filter and
a test; the viewer itself is out of scope.

## UI changes

- `LogCategory` (agents-plugin `state.svelte.ts`) gains the six audit categories;
  `LogEntry` gains optional `daemonId`, `agentId`, `cyboId`, `kind`, `payload` (the
  ingest currently DROPS these — `app.svelte.ts:1967` only forwards
  `level/category/source/message`). The new `client.on("audit_event", …)` handler
  forwards the full structured line.
- `LogsPane` adds Session / Cybo / Daemon / Kind dropdown filters (the existing
  Level + Category + Agent + time + search remain), and the expand-row shows the
  redacted `payload` as a JSON block (so an owner can read the prompt preview,
  hash, and `mcpServers` list inline).

## Alternatives considered

- **Overload `cyborg:task_event`.** Rejected — its payload is a pre-formatted task
  line with `category:"task"` baked in; bolting audit fields on it muddies a clean,
  shipped contract and forces the watcher pane semantics onto unrelated events.
- **Generic pino→broadcast tap.** Rejected — it would sweep Paseo `agent/` upstream
  logs into the workspace stream (boundary violation), can't redact safely, and
  floods. The explicit per-site sink is auditable and bounded.
- **Persist audit events to PG.** Deferred — the Logs tab is a live stream today;
  historical replay is a separate concern (and a retention/PII discussion). This
  change keeps parity with task events (in-memory, capped).

## CLI-first verification

Every behavior is checkable headless (no UI needed):

- `formatAuditEvent` purity + redaction unit tests (`audit-event-log.test.ts`).
- A `spawnCybo` test asserting it emits `context_injection` + `tool_injection`
  events with the right structured fields and **no secret substrings** in the
  serialized payload.
- A verbosity test: `debug` events suppressed when `CYBORG7_AUDIT_VERBOSE` unset,
  emitted when set.
- A pure filter test: `filterAuditBySession` / `filterAudit({session,cybo,daemon,kind,level})`
  returns the right subset.

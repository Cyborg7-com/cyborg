# Change: logs-audit-trace-stream

## Why

The owner spent weeks debugging cybo **context**, **tool/MCP injection**, and
invocation problems, and instrumented the daemon heavily to do it. But almost none
of that instrumentation reaches the **Logs tab** (`LogsPane.svelte`). Today the
Logs tab is fed by exactly one structured channel — `cyborg:task_event` (the
`task-event-log.ts` watcher/task pipeline) — plus client-side `agent_stream`
mirroring. Everything else the owner added is a pino `logger.*` call that goes to
`$PASEO_HOME/daemon.log` / Logfire and is **invisible in the UI**.

So an owner asking the two questions the Logs tab should answer —
**(a) what CONTEXT (system/platform prompt + tools) did this cybo session actually
get?** and **(b) what OPERATIONS did the daemon perform (spawns, teardowns, reaper
kills, credential changes, gate decisions)?** — cannot answer either from the UI.

The research (the GitHub issue body carries the full inventory) found:

- **The single biggest gap is a total blind spot, not a re-routing problem:**
  `spawnCybo` (`cybo-manager.ts`) emits **zero** log lines. The exact
  `systemPrompt` it built (`buildCyboPrompt`) and the exact `mcpServers` map it
  injected (the `cyborg7` MCP base URL + the cybo's own `mcp_servers` +, on the
  Composio branch, the scoped toolkit servers) are **computed and thrown away** —
  not in daemon.log, not anywhere. This is precisely "what context + tools did this
  session get," and it is unrecoverable today.
- **Everything else already exists as a pino call** and just needs surfacing:
  ~40 high-value traces across credential events, reaper kills, session-safety
  quarantine, schedule skips, mention/watcher decisions, the rate-limit "firewall,"
  and the autonomy gate — all daemon.log-only.

The work is therefore **mostly SURFACING + STRUCTURING, not new instrumentation.**
One new emit (spawn context/tool snapshot) + a re-route of existing pino traces
through the broadcast channel the Logs tab already consumes.

## What Changes

- **NEW pure module** `packages/server/src/server/cyborg/audit-event-log.ts`
  (sibling of `task-event-log.ts`): a discriminated-union `AuditEvent` type +
  `formatAuditEvent` formatter + `auditEventBroadcast` envelope
  (`{ type: "cyborg:audit_event", payload: AuditEventLine }`). Zero I/O, zero clock —
  unit-testable in isolation, identical shape on the daemon and relay paths.
- **NEW structured event kinds**, grouped by the owner's themes:
  `context_injection`, `tool_injection`, `spawn_lifecycle`, `invocation_decision`,
  `daemon_operation`, `failure`. Each carries
  `{ kind, level, category, timestamp, daemonId, agentId/sessionId?, cyboId?, userId?,
  workspaceId, channelId?, payload }`.
- **ONE new emit (the only added instrumentation):** at the end of `spawnCybo`,
  emit a `context_injection` event (system-prompt **preview + length + sha256
  prefix**, soul source, workspace/channel context) and a `tool_injection` event
  (the `mcpServers` server names, the `cyborg7` base URL, Composio toolkits) —
  **secrets redacted** (api keys, `ck_` consumer keys, scoped MCP tokens never
  shipped). This makes a session's exact context auditable/diffable without shipping
  kilobytes or leaking credentials.
- **RE-ROUTE (no new logging logic):** a thin `auditSink` adapter lets the existing
  pino traces in `cyborg/` (credential set/remove, reaper kills, session-safety,
  schedule skips, mention/watcher failures, rate-limit blocks, autonomy-gate skips)
  ALSO emit a structured `AuditEvent`. The pino lines stay (ops still get
  daemon.log); the same event is additionally broadcast.
- **TRANSPORT (extend, don't replace):** broadcast `cyborg:audit_event` through the
  **same two seams** task events already use — daemon
  `MessageRouter.broadcast.toWorkspace`, relay `broadcastToGuests` — plus the
  matching `ws-client.ts` wire branch and an `app.svelte` ingest handler.
- **UI:** widen `LogEntry`/`LogCategory` (in the agents-plugin state) with the audit
  categories + the structured context fields (currently dropped at ingest), and
  extend `LogsPane` filters to slice by **session / cybo / daemon / kind / level**
  and show the redacted payload in the expand-row.
- **VERBOSITY controls (so it doesn't flood):** every audit event has a level; the
  Logs default filter excludes `debug`; high-frequency low-signal events (the silent
  autonomy-gate skips, per-stream broadcast warnings, dedup-guard returns) emit at
  `debug` and ONLY when `CYBORG7_AUDIT_VERBOSE` is on; secrets are redacted;
  payloads are capped. Audit events are workspace-scoped (same trust boundary as
  task events) and gated behind an admin/audit capability.
- **Session-viewer tie-in (integration point only):** every context/tool/lifecycle
  event carries a stable `agentId`/`sessionId`, and the Logs filter exposes a
  "filter by session" API so the read-only session viewer (sibling spec
  `sessions-readonly-viewer`) can deep-link from a transcript to that session's
  audit trail. This change specs the **field + filter contract**, not the viewer.

**Explicitly NOT in this change:** the read-only session viewer UI itself
(`sessions-readonly-viewer`); persisting audit events to PG/SQLite for historical
replay (this is a live in-memory stream, same as task events today); per-event
retention policy; any new instrumentation beyond the single spawn context/tool
snapshot; modifying anything under `packages/server/src/server/agent/` (Paseo
upstream — untouched).

## Impact

- **Affected packages (ONLY):** `packages/server/src/server/cyborg/` and
  `packages/ui/`.
- **New files:** `cyborg/audit-event-log.ts`, `cyborg/audit-event-log.test.ts`,
  `cyborg/audit-sink.ts` (+ test); UI filter helper + test.
- **Edited (server):** `cybo-manager.ts` (the one new emit), `message-router.ts` &
  `relay-standalone.ts` (audit broadcast seam, mirroring the task-event seam),
  `cybo-credentials.ts` / reapers / `session-safety.ts` / `schedule-runner.ts` /
  `cybo-mention-invoke.ts` (re-route their existing pino calls through `auditSink`).
- **Edited (ui):** `ws-client.ts` (wire branch), `state/app.svelte.ts` (ingest),
  agents-plugin `state.svelte.ts` (`LogEntry`/`LogCategory` widening),
  `LogsPane.svelte` (filters + expand-row payload).
- **Risk:** low. The new emit is best-effort/try-caught (a spawn never fails because
  an audit broadcast threw, exactly like the task-event seam). Re-routing keeps the
  pino lines intact, so ops visibility is unchanged. No Paseo `agent/` code touched;
  no WS schema break (additive new message type).
- **Depends on:** nothing. **Relates to:** `sessions-readonly-viewer` (consumes the
  per-session audit filter), the `autonomy-*` changes (their gate decisions become
  `invocation_decision` audit events once those gates exist).

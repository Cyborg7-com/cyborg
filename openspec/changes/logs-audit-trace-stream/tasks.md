# Tasks — logs-audit-trace-stream

Ordered, independently-completable steps. Each is small enough to finish in one loop
iteration and names the **exact** verification command (no manual testing). Server
work is confined to `packages/server/src/server/cyborg/` (Paseo `agent/` is
untouched); UI work to `packages/ui/`.

Shorthand: `VITEST=npx vitest run` (from `packages/server/` or `packages/ui/` as noted).

---

- [x] **1. Pure audit-event module + formatter.**
      Add `src/server/cyborg/audit-event-log.ts` with `AuditLevel`, `AuditCategory`
      (the six categories), `AuditEvent`, `AuditEventLine`, `formatAuditEvent` (PURE,
      no clock/I/O), `AuditEventBroadcast`, and `auditEventBroadcast`. Mirror the shape
      and doc-comment style of `task-event-log.ts`.
  - Verify (after task 2): `cd packages/server && npx vitest run src/server/cyborg/audit-event-log.test.ts`
  - Typecheck: `cd packages/server && npx tsc --noEmit`

- [x] **2. Formatter + redaction unit tests.**
      Add `src/server/cyborg/audit-event-log.test.ts`: purity (same input → same
      output), envelope shape, and **redaction** — an event whose payload contains an
      MCP URL with a query string, an api-key field, a `ck_` key, and a scoped token
      produces a line with none of those secret substrings. Include the
      `context_injection` prompt-preview/length/hash shape and assert the full prompt is
      absent.
  - Verify: `cd packages/server && npx vitest run src/server/cyborg/audit-event-log.test.ts`

- [x] **3. Audit sink + verbosity gate.**
      Add `src/server/cyborg/audit-sink.ts`: `AuditSink` interface (`emit(event)` —
      best-effort, never throws) and a factory binding it to a broadcast function. Gate
      `debug`-level events behind `CYBORG7_AUDIT_VERBOSE` (helper `isAuditVerbose()`).
      Add `audit-sink.test.ts`: emit-never-throws (broadcast throws → caller fine);
      `debug` suppressed when env unset, emitted when set; payload size-cap truncation.
  - Verify: `cd packages/server && npx vitest run src/server/cyborg/audit-sink.test.ts`

- [x] **4. Daemon + relay broadcast seams.**
      Add `MessageRouter.broadcastAuditEvent(event)` (mirror `broadcastTaskEvent` ~
      `message-router.ts:1789`, try/caught, `this.broadcast.toWorkspace`) and
      `emitAuditEventForWorkspace(workspaceId, event)` on the relay (mirror
      `emitTaskEventForWorkspace` ~ `relay-standalone.ts:581`, `broadcastToGuests`).
      Wire each as the backing broadcast for an `AuditSink`.
  - Verify: `cd packages/server && npx vitest run src/server/cyborg/message-router.test.ts` (add a case asserting an emitted audit event fans to `toWorkspace` for the right workspace only); `npx tsc --noEmit`

- [x] **5. NEW emit — spawn context + tool snapshot (the only added instrumentation).**
      In `cybo-manager.ts` `spawnCybo`, after `createAgent` returns, emit a
      `context_injection` event (`promptPreview`/`promptLength`/`promptSha256`, soul
      source, workspace/channel) and a `tool_injection` event (`mcpServers` server
      names, `cyborg7` base URL host+path, Composio toolkits) via an optional
      `auditSink` param (undefined ⇒ no-op, so existing callers/tests are unchanged).
      Both carry `agentId`, `cyboId`, `workspaceId`, `channelId`.
  - Verify: `cd packages/server && npx vitest run src/server/cyborg/cybo-manager.test.ts` — add a test passing a capturing `auditSink` and asserting both events fire with the right ids, the prompt preview is truncated, the full prompt is absent, and the serialized payload contains no secret substring.

- [x] **6. Re-route existing daemon traces (no new logging logic).**
      Add a `sink.emit({...})` next to the existing pino calls (keep the pino line) for:
      credential set/remove (`cybo-credentials.ts:361/375` → `daemon_operation`);
      reaper kills (`agent-backend-reaper.ts:255/295`, `pty-host-reaper.ts:149` →
      `daemon_operation`); session-safety quarantine (`session-safety.ts:144/148/150`
      → `daemon_operation`); schedule skips (`schedule-runner.ts:160/205/220/499` →
      `invocation_decision`/`daemon_operation`); mention/watcher failures
      (`cybo-mention-invoke.ts` failures → `invocation_decision`/`failure`); the
      rate-limit "firewall" call sites (`message-router.ts:886` already a task_event —
      also emit `invocation_decision` at `debug`). Silent autonomy-gate returns
      (`message-router.ts:857`, `relay-standalone.ts:4984`, `dispatcher.ts:6816`) emit a
      `debug` `invocation_decision`.
  - Verify: `cd packages/server && npx vitest run src/server/cyborg/` — add focused tests for at least the credential and reaper re-routes asserting an audit event is emitted with the matching category. Confirm no `agent/` file changed: `git diff --name-only | grep -q '^packages/server/src/server/agent/' && echo FAIL || echo OK`

- [x] **7. Wire type + client ingest.**
      In `packages/ui/src/lib/ws-client.ts` add the `cyborg:audit_event` branch (mirror
      the `cyborg:task_event` branch ~1919), an `AuditEventPayload` interface, and a
      `CyborgEventMap` entry. In `state/app.svelte.ts` add
      `client.on("audit_event", …)` forwarding the FULL line (not just
      level/category/source/message) into `logState`.
  - Verify: `cd packages/ui && npx vitest run` (add a ws-client test asserting an `cyborg:audit_event` frame emits the typed `audit_event` with structured fields intact); `npx svelte-check` (or repo typecheck).

- [x] **8. Widen LogEntry / LogCategory + audit state fields.**
      In the agents-plugin `state.svelte.ts`, add the six audit categories to
      `LogCategory` and optional `daemonId`/`agentId`/`cyboId`/`kind`/`payload` to
      `LogEntry`; add a `push` overload (or `pushAudit`) that retains them. Keep the 500
      FIFO cap.
  - Verify: `cd packages/ui && npx vitest run src/lib/plugins/agents/state.test.ts` (add/extend asserting an audit entry retains its structured fields and the cap still trims).

- [x] **9. Pure audit filter helper + tests.**
      Add a pure `filterAudit(entries, { session, cybo, daemon, kind, level })` (and
      `filterAuditBySession`) helper in `packages/ui/` (no Svelte deps). Filter by
      session returns only that `agentId`; combined filter ANDs supplied criteria and
      ignores omitted ones.
  - Verify: `cd packages/ui && npx vitest run` (the filter test) — this is the CLI-first proof the stream is queryable by session/cybo/daemon/kind/level.

- [x] **10. LogsPane filters + expand-row payload.**
      Extend `LogsPane.svelte`: add Session / Cybo / Daemon / Kind dropdown filters
      (reuse `FilterDropdown`), default the level filter to exclude `debug`, and render
      the redacted `payload` as a JSON block in the expand-row. Wire filters to
      `filterAudit`.
  - Verify: `cd packages/ui && npx vitest run` + repo typecheck. (Visual QA optional;
    the filter logic is already proven headless in task 9.)

- [x] **11. Validate the OpenSpec change.**
  - Verify: `openspec validate logs-audit-trace-stream --strict`

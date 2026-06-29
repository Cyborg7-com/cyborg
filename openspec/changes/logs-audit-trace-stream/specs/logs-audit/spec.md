# Spec delta — logs-audit (audit trace stream)

## ADDED Requirements

### Requirement: Pure audit-event formatter
The system SHALL provide a pure module
`packages/server/src/server/cyborg/audit-event-log.ts` exporting an `AuditEvent`
discriminated union, a `formatAuditEvent(event)` formatter, and an
`auditEventBroadcast(event)` envelope builder
(`{ type: "cyborg:audit_event", payload: AuditEventLine }`). The module SHALL have
zero I/O and zero clock (timestamp assigned downstream at ingest), mirroring the
purity contract of `task-event-log.ts`, so it is unit-testable in isolation and
identical on the daemon and relay transports.

#### Scenario: Formatter is pure
- **WHEN** `formatAuditEvent` is called twice with the same `AuditEvent`
- **THEN** it returns an identical `AuditEventLine` both times
- **AND** it performs no I/O and reads no clock

#### Scenario: Envelope shape
- **WHEN** `auditEventBroadcast(event)` is called
- **THEN** it returns `{ type: "cyborg:audit_event", payload }` where `payload` is the formatted line
- **AND** the payload carries `kind`, `category`, `level`, `workspaceId`, `source`, `message`, and the optional structured ids (`daemonId`, `agentId`, `cyboId`, `userId`, `channelId`) and `payload` object

### Requirement: Audit event categories
The `AuditEvent` `category` field SHALL be one of `context_injection`,
`tool_injection`, `spawn_lifecycle`, `invocation_decision`, `daemon_operation`, or
`failure`, and each event SHALL carry a `level` of `debug`, `info`, `warn`, or
`error`. These categories SHALL be the grouping a Logs-tab consumer filters by.

#### Scenario: Category is constrained
- **WHEN** an `AuditEvent` is constructed
- **THEN** its `category` is one of the six defined audit categories
- **AND** its `level` is one of `debug`, `info`, `warn`, `error`

### Requirement: Context-injection audit on spawn
When a cybo is spawned, the system SHALL emit a `context_injection` audit event
capturing the system/platform prompt the cybo received. The event SHALL carry the
spawn's `agentId`, `cyboId`, `workspaceId`, optional `channelId`, and a `payload`
with a prompt **preview** (truncated), the prompt **length**, and a **hash prefix**
of the full prompt. The event SHALL NOT carry the full prompt text.

#### Scenario: Spawn emits a context-injection event
- **WHEN** `spawnCybo` completes building the system prompt and creating the agent
- **THEN** a `context_injection` audit event is emitted with `category: "context_injection"`
- **AND** its `agentId` equals the spawned agent's id and `cyboId` equals the cybo's id
- **AND** its `payload` contains `promptPreview`, `promptLength`, and `promptSha256`
- **AND** its `payload` does NOT contain the full system prompt

### Requirement: Tool/MCP-injection audit on spawn
When a cybo is spawned, the system SHALL emit a `tool_injection` audit event
capturing the MCP servers injected into the spawn. The `payload` SHALL list the MCP
server names, the `cyborg7` MCP base URL (host + path only), and any Composio
toolkits, with all secrets removed.

#### Scenario: Spawn emits a tool-injection event
- **WHEN** `spawnCybo` assembles the `mcpServers` map and creates the agent
- **THEN** a `tool_injection` audit event is emitted with `category: "tool_injection"`
- **AND** its `payload` lists the injected MCP server names including `cyborg7` when a base URL was provided
- **AND** the `cyborg7` URL in the payload is reduced to host and path with no query string

### Requirement: Secret redaction
The audit formatter SHALL strip secrets from every event payload before it is
broadcast: API keys, Composio `ck_` consumer keys, scoped MCP tokens, and the query
string of any `cyborg7`/scoped MCP URL SHALL NOT appear in any emitted
`AuditEventLine`. The redaction allow-list SHALL live in `audit-event-log.ts`.

#### Scenario: Secrets never reach the wire
- **WHEN** an audit event payload contains an MCP URL with an `agentId`/token query string or an api-key field
- **THEN** the formatted `AuditEventLine` contains neither the query string nor the api-key value
- **AND** a serialized scan of the payload finds no `ck_` consumer key and no scoped token

### Requirement: Re-route existing daemon traces through the audit sink
The system SHALL provide an `AuditSink` whose `emit(event)` is best-effort and never
throws, and SHALL re-route the selected existing `cyborg/` pino traces
(credential set/remove, reaper kills, session-safety quarantine, schedule skips,
mention/watcher failures, rate-limit blocks, autonomy-gate skips) through it as
structured `AuditEvent`s. The original pino log calls SHALL remain so daemon.log /
Logfire visibility is unchanged. No code under `packages/server/src/server/agent/`
SHALL be modified.

#### Scenario: Re-routed trace emits an audit event alongside the pino line
- **WHEN** a re-routed `cyborg/` trace fires (e.g. a reaper kills an orphaned backend)
- **THEN** the existing pino log line is still written
- **AND** an `AuditEvent` with the matching `category` and `level` is emitted to the sink

#### Scenario: Sink never breaks the caller
- **WHEN** `AuditSink.emit` is called and the underlying broadcast throws
- **THEN** the error is swallowed and the calling operation completes normally

#### Scenario: Paseo agent code untouched
- **WHEN** the re-route is implemented
- **THEN** no file under `packages/server/src/server/agent/` is modified

### Requirement: Audit broadcast transport
The system SHALL broadcast `cyborg:audit_event` through the same two workspace
seams used by `cyborg:task_event`: a daemon `broadcastAuditEvent` over
`MessageRouter.broadcast.toWorkspace`, and a relay `emitAuditEventForWorkspace` over
`broadcastToGuests`. Audit events SHALL be scoped to the event's workspace only.

#### Scenario: Daemon broadcasts to the workspace
- **WHEN** the daemon emits an audit event for a workspace
- **THEN** it is sent via `broadcast.toWorkspace` for that workspace id only
- **AND** clients in other workspaces do not receive it

#### Scenario: Relay broadcasts to guests
- **WHEN** the relay emits an audit event for a workspace
- **THEN** it is fanned out via `broadcastToGuests` for that workspace

### Requirement: Client ingest of audit events
The client SHALL handle the `cyborg:audit_event` wire type in `ws-client.ts` and
push the full structured line into `logState`, including the structured ids
(`daemonId`, `agentId`, `cyboId`, `kind`, `payload`) that the existing task-event
ingest drops. `LogEntry` and `LogCategory` SHALL be widened to carry the audit
categories and these fields.

#### Scenario: Audit line reaches logState with structured context
- **WHEN** the client receives a `cyborg:audit_event` frame
- **THEN** a `LogEntry` is pushed into `logState` whose `category` is the audit category
- **AND** the entry retains the `agentId`, `cyboId`, `daemonId`, `kind`, and `payload` fields

### Requirement: Verbosity controls
The system SHALL gate `debug`-level audit events behind the `CYBORG7_AUDIT_VERBOSE`
environment flag (default off): when unset, no `debug`-level audit event is emitted;
when set, they are emitted. The Logs tab default level filter SHALL exclude `debug`.
Every audit `payload` SHALL be size-capped before emit.

#### Scenario: Debug events suppressed by default
- **WHEN** `CYBORG7_AUDIT_VERBOSE` is unset and a `debug`-level audit event would be emitted
- **THEN** no audit event is broadcast for it

#### Scenario: Debug events emitted when verbose
- **WHEN** `CYBORG7_AUDIT_VERBOSE` is set and a `debug`-level audit event is produced
- **THEN** the audit event is broadcast

#### Scenario: Payload is capped
- **WHEN** an audit event payload exceeds the size cap
- **THEN** the emitted payload is truncated to within the cap

### Requirement: Filterable by session, cybo, daemon, kind, and level
The Logs tab SHALL filter the audit stream by session (`agentId`), cybo, daemon,
kind, and level, via a pure filter helper that is unit-testable independent of the
UI. The session filter SHALL be the contract the read-only session viewer
(`sessions-readonly-viewer`) uses to deep-link a session's audit trail.

#### Scenario: Filter by session returns only that session's events
- **WHEN** the audit entries are filtered by a given `agentId`
- **THEN** only entries whose `agentId` equals it are returned

#### Scenario: Combined filter narrows correctly
- **WHEN** the audit entries are filtered by `{ cyboId, daemonId, kind, level }`
- **THEN** only entries matching all supplied criteria are returned
- **AND** omitted criteria do not constrain the result

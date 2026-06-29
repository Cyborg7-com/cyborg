# sessions-readonly-viewer (delta)

A strictly read-only viewer for any session shown in the daemon-detail audit list — the transcript up
to now plus, for ephemeral sessions, the full injected context (system prompt, available tools, routed
prompt). Opening a session never attaches, revives, or mutates it.

## ADDED Requirements

### Requirement: Ephemeral injected context is captured durably at spawn
The daemon SHALL persist, when an ephemeral cybo session is spawned (a `/slash command` or `@mention`
turn, `persistSession:false`), the injected **system/platform prompt**, the **MCP servers/tools made
available**, and the **routed prompt** (both the raw routed text and the fully framed prompt) in a durable
owner-scoped store keyed by the session's agent id. This store SHALL NOT be deleted when the ephemeral
agent is torn down, even though the agent's binding and provider session are deleted.

#### Scenario: Ephemeral context survives teardown
- **WHEN** an ephemeral cybo turn completes and the agent is torn down (its `agent_bindings` row and
  provider session are deleted)
- **THEN** the captured context record (system prompt, MCP servers/tools, raw + framed routed prompt) for
  that agent id is still readable from the durable store

#### Scenario: Capture records the tools that were made available
- **WHEN** a cybo is spawned with a set of MCP servers (e.g. a `cyborg7` HTTP server plus any cybo-defined
  servers)
- **THEN** the captured record lists those servers (name, type, and any scoped url/toolkit restriction) as
  "tools made available" for that session

### Requirement: Read RPC serves the ephemeral context bundle
The daemon SHALL expose a read-only RPC (`cyborg:fetch_session_context`) that, for a given workspace +
agent id, returns the captured context bundle for an ephemeral session, or null for an ordinary
(non-ephemeral) agent. The RPC SHALL be authorized by the daemon audit-visibility predicate and SHALL be
forwarded to the owning daemon through the relay. Serving the bundle SHALL NOT attach, load, or revive the
agent.

#### Scenario: Owner fetches an ephemeral session's context
- **WHEN** a daemon owner/admin with audit scope requests the context for an ephemeral session
- **THEN** the response contains the session's system prompt, MCP servers/tools, and raw + framed routed
  prompt, and no agent is loaded or revived as a result

#### Scenario: Ordinary agent has no ephemeral context
- **WHEN** the context RPC is called for a normal (non-ephemeral) workspace agent
- **THEN** the response context is null and the viewer falls back to showing only the transcript

#### Scenario: Unauthorized requester is rejected
- **WHEN** a requester without audit scope over the daemon requests a session's context
- **THEN** the request is rejected and no context is returned

### Requirement: Transcript is readable for any audit-visible session without revival
The existing timeline read RPC (`cyborg:fetch_agent_timeline`) SHALL serve the durable transcript for any
session the requester may see per the daemon audit-visibility predicate — including active, internal, and
torn-down ephemeral sessions whose live binding no longer exists. The read SHALL come from the durable
timeline store and SHALL NOT call any agent-loading/revive path.

#### Scenario: Transcript of a torn-down ephemeral session is served
- **WHEN** an audit-scoped owner requests the timeline for an ephemeral session after it was torn down
- **THEN** the turn's messages are returned from the durable store even though the agent binding was
  deleted, and no agent is loaded or revived

#### Scenario: Reading another user's session transcript
- **WHEN** an audit-scoped owner/admin requests the timeline for a session started by another user
- **THEN** the transcript is returned read-only, scoped by the audit-visibility predicate, without
  attaching to or modifying the session

### Requirement: The viewer is strictly read-only and attach-free
The read-only session viewer SHALL render the transcript using the agent stream view in read-only mode
(no rewind affordance) and SHALL NOT mount any composer/input box, attach control, revive/resume control,
or model/mode/thinking/archive control. Opening a session SHALL issue only read RPCs
(`cyborg:fetch_agent_timeline`, `cyborg:fetch_session_context`) and SHALL NOT issue any RPC that revives
or mutates the session.

#### Scenario: Opening a session does not revive it
- **WHEN** a user opens a session in the read-only viewer
- **THEN** no agent is attached, loaded, or revived, no provider session is created, and the session's
  liveness is unchanged

#### Scenario: No interaction affordances are present
- **WHEN** the read-only viewer is shown for any session (active, internal, ephemeral, or another user's)
- **THEN** there is no input box, attach, revive, rewind, or model/mode control, and the user can only
  read the transcript (and, for ephemeral, the context panel)

### Requirement: Ephemeral context panel surfaces prompt and tools
For an ephemeral session, the viewer SHALL display a context panel alongside the transcript with three
labelled sections: the **system/platform prompt** the session received, the **tools/MCP servers** that
were made available, and the **prompt that was routed in** (raw and framed). For non-ephemeral sessions
the panel SHALL be absent and only the transcript SHALL be shown.

#### Scenario: Auditing what context a cybo received
- **WHEN** an owner opens an ephemeral cybo session in the viewer
- **THEN** the context panel shows the injected system prompt, the list of available tools/MCP servers,
  and the routed prompt, so the owner can audit exactly what context and tools the cybo got

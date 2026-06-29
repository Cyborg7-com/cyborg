# Spec delta — daemon-session-audit

## ADDED Requirements

### Requirement: Owner-audit daemon session listing
The system SHALL provide a `cyborg:list_daemon_sessions` request
`{ requestId, workspaceId, daemonId }` answered by
`cyborg:list_daemon_sessions_response` `{ requestId, daemonId, sessions: DaemonSessionAuditRow[] }`.
When the caller is authorized (see the gate requirement), the response SHALL include EVERY
session bound to that daemon in the workspace — including ephemeral/internal summons and
sessions launched by OTHER users — with NO `initiated_by` (per-user) filter and NO
`ephemeral` filter. This is a distinct message from `cyborg:list_agents`; the existing
`cyborg:list_agents` handler, its `ephemeral` filter, and its caller-scoping SHALL remain
unchanged.

#### Scenario: Owner sees all sessions including ephemeral and other users'
- **WHEN** the daemon owner sends `cyborg:list_daemon_sessions` for their daemon `D`
- **AND** `D` has three sessions: one ephemeral summon, one launched by another user, and one launched by the owner
- **THEN** the response `sessions` contains all three rows
- **AND** the ephemeral summon's row has `ephemeral: true`

#### Scenario: Ephemeral and internal flags are surfaced for badging
- **WHEN** an authorized auditor lists sessions on a daemon
- **THEN** each row carries `ephemeral` (true for slash/mention summons) and `internal` (the Paseo internal flag when the session is live) so the client can badge them

#### Scenario: Other daemons are not included
- **WHEN** an authorized auditor lists sessions for daemon `D`
- **AND** a session is bound to a different daemon `E` in the same workspace
- **THEN** the `E` session is NOT in the `D` response

#### Scenario: The scoped list is unchanged for the same caller
- **WHEN** any member sends the ordinary `cyborg:list_agents` request
- **THEN** they receive only their own + channel-bound + unattributable sessions, with ephemeral summons excluded, exactly as before this change

### Requirement: Audit listing is gated to the daemon admin scope
The audit listing SHALL be authorized only for a caller holding the `admin` daemon scope on
the target daemon — which the daemon **owner** holds implicitly. A caller without it SHALL
receive a `cyborg:error` with code `forbidden` and SHALL NOT receive any session rows. The
gate SHALL be enforced in the dispatcher handler; in cloud mode it SHALL ALSO be enforced at
the relay boundary before the request is forwarded to any daemon. In single-tenant (solo)
mode with no shared daemon-access store, the local caller SHALL be permitted.

#### Scenario: Non-admin member is denied
- **WHEN** a workspace member with only `chat`, `spawn`, or `terminal` scope (or no grant) on daemon `D` sends `cyborg:list_daemon_sessions` for `D`
- **THEN** the response is `cyborg:error` with code `forbidden`
- **AND** no session rows are returned

#### Scenario: Explicit admin grantee is allowed
- **WHEN** a member who is not the owner but holds the `admin` scope on `D` sends the request
- **THEN** the audit listing is returned

#### Scenario: Relay rejects a non-admin before forwarding
- **WHEN** a guest without the `admin` scope on `D` sends `cyborg:list_daemon_sessions` through the cloud relay
- **THEN** the relay rejects it and does NOT forward the request to daemon `D`

#### Scenario: Solo mode permits the local host
- **WHEN** the daemon runs with no shared daemon-access store (solo)
- **AND** the local caller sends `cyborg:list_daemon_sessions` for the local daemon
- **THEN** the audit listing is returned

### Requirement: Offline audit answered from the durable mirror
When the target daemon is not connected, the cloud relay SHALL answer an authorized
`cyborg:list_daemon_sessions` from the persistent session mirror, returning ALL bindings for
that daemon — including ephemeral and other users' — WITHOUT applying the per-user
`offlineBindingVisible` scoping, since authorization was already established. Initiator
identity SHALL be resolved to the viewer's global account id so rows group by owner.

#### Scenario: Offline daemon still yields the full audit list
- **WHEN** an authorized auditor requests sessions for a daemon that is currently offline
- **THEN** the relay returns the daemon's persisted sessions from the mirror, including ephemeral and other users' sessions

#### Scenario: Offline path keeps the gate
- **WHEN** a non-admin requests sessions for an offline daemon
- **THEN** the relay returns `forbidden` and does NOT read or return mirror rows

### Requirement: Audit listing exposes session metadata only
The audit listing SHALL expose, per session: `agentId`, `provider`, `channelId`, `cyboId`,
`cyboName`, `cyboAvatar`, `initiatedBy`, `initiatedByEmail`, `lifecycle`, `model`, `modeId`,
`availableModes`, `thinkingOptionId`, `cwd`, `daemonId`, `daemonLocal`, `ephemeral`, and
`internal`. It SHALL NOT include any session message/transcript body, prompt text, tool
calls or results, terminal I/O, or system prompt. Opening a row navigates to the existing
read-only session view keyed by `agentId`; the audit grants visibility, not control.

#### Scenario: No content is leaked in the listing
- **WHEN** an authorized auditor receives the session rows
- **THEN** each row carries only the metadata fields above
- **AND** no message text, prompt, tool output, or terminal output is present in the response

### Requirement: Audit results do not pollute the scoped client store
The client SHALL keep the audit listing in state local to the daemon-detail view and SHALL
NOT merge audit rows into the global agents store that feeds the chat sidebar. The daemon
owner / admin SHALL see the audit listing in the daemon-detail Sessions section grouped by
owning user with ephemeral rows badged; a non-owner / non-admin SHALL see the existing
daemon-scoped view over the already-scoped agents store, unchanged.

#### Scenario: Owner view renders the audit list badged
- **WHEN** the daemon owner opens the daemon-detail Sessions section
- **THEN** it shows sessions for all users on the daemon, grouped by owner, with ephemeral summons badged "Ephemeral"

#### Scenario: Non-owner view is unchanged and the sidebar is untouched
- **WHEN** a member without the `admin` scope opens the same daemon-detail view
- **THEN** the Sessions section shows only the sessions the scoped list already returned to them
- **AND** the chat sidebar's agents list is unchanged for both the owner and the non-owner

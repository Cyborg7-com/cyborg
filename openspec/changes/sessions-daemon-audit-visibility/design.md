# Design — sessions-daemon-audit-visibility

## Context

Session listing today has FIVE scoping seams (mapped during investigation):

1. **Local daemon** — `dispatcher.ts handleListAgents` (`:4410-4451`): reads
   `agent_bindings` via `storage.getAgentsByWorkspace`, drops `b.ephemeral` (`:4421`),
   then keeps only channel-bound + unattributed + the caller's own bindings (`:4431-4437`).
   It joins live state per-row via `agentManager.getAgent(b.agent_id)` (NOT
   `listAgents()` — so the `!internal` filter at `agent-manager.ts:619` is not even on this
   path; the binding-level `ephemeral` flag is the relevant audit dimension).
2. **Paseo AgentManager** — `listAgents()` drops `internal` (`:619`) and subscriber replay
   skips `internal` for global subscribers (`:600-603`). This is upstream `agent/` code —
   we DO NOT touch it.
3. **Cloud relay** — `relay-standalone.ts` fans `cyborg:list_agents` out to all daemons
   (`:2225`), merges per-daemon responses, and for offline daemons answers from the PG
   mirror scoped by `guestEmail` via `offlineBindingVisible` (`relay-offline-agent-rows.ts:65-75`).
4. **UI sidebar** — `session-scope.ts filterMine` keeps mine + channel-bound + unattributed.
5. **DaemonDetail** — passes the already-scoped `workspaceState.agents` to
   `SessionList scope="daemon"`, which `filterByDaemon` + `groupByOwner`. So even the owner
   only sees what seam #1/#3 already returned to them.

The audit gate authority already exists: `pg.getUserDaemonScopes(workspaceId, daemonId, userId)`
returns the full `DAEMON_SCOPES` set for the daemon **owner** (`pg-sync.ts:4635`) or the
grant row's scopes otherwise; `DaemonScope = "chat" | "spawn" | "terminal" | "admin"`.
`canUserAccessDaemon` = "has any scope". The dispatcher already reaches this via
`this.storage.pg` (`dispatcher.ts:5167, 6908`).

`agent_bindings` (storage.ts:413) carries `agent_id, channel_id, daemon_id, initiated_by,
ephemeral (0|1)` — everything the audit row needs except the live `internal` flag, which
comes from the joined `ManagedAgent`.

## Goals / Non-Goals

**Goals**
- Give the daemon owner / `admin`-grantee a listing of ALL sessions on a daemon, including
  ephemeral/internal and other users', for accountability.
- Reuse the existing daemon-access scope authority for the gate.
- Zero change to the scoped lists that feed the chat sidebar and to Paseo `agent/`.

**Non-Goals**
- No transcript/message/terminal-content exposure (that is the *read-only viewer* sibling).
- No workspace-wide firehose (that is Settings → Logs, #704).
- No new persistence — the audit reads the same `agent_bindings` + live state.

## Decision 1 — new message type, not a flag on `cyborg:list_agents`

The audit is **daemon-scoped** (one daemon), while `cyborg:list_agents` is **workspace-scoped**
and fans out across all daemons. More importantly, the UI pipes the `list_agents` result into
the global `workspaceState.agents` store, which feeds the chat sidebar's `filterMine`. If the
audit reused that message and that store, an unscoped audit result would leak every user's
ephemeral sessions into everyone's sidebar (re-triggering the 2026-06-12 ghost-session flood).

A separate `cyborg:list_daemon_sessions` keeps the audit result in LOCAL component state,
physically separate from the scoped global store. Rejected alternative: an `includeInternal` +
`auditDaemonId` flag on `cyborg:list_agents` — smaller protocol surface, but it couples the
sensitive audit path to the hot, broadly-consumed list and invites exactly the leak above.

## Decision 2 — gate on the `admin` daemon scope (owner implicit)

Seeing every user's sessions (incl. ephemeral) on a host is the same trust tier as host
control. `admin` is already the RCE-grade scope (terminal/host-update). The daemon **owner**
holds the full scope set implicitly (`pg-sync.ts:4635`), so `scopes.has("admin")` admits both
the owner and explicitly-trusted admins, and excludes `chat`/`spawn`/`terminal`-only grantees.
Enforced **twice** (defense in depth): at the relay boundary before forwarding (cloud), and in
the dispatcher handler (local + as the daemon's own check). Solo mode (no `storage.pg`) is
single-tenant — the local caller is the host user, so the audit is permitted.

## Decision 3 — preserve the scoped path byte-for-byte

`handleListAgents`, its `!b.ephemeral` and caller filters, `offlineBindingVisible`,
`filterMine`, and `SessionList scope="daemon"|"mine"` are all unchanged. The audit is purely
additive: a new handler, a new relay route, a new `auditAgentRows`, a new `scope="audit"`.
Non-owners get exactly today's behavior.

## The audit listing CONTRACT (also the read-only-viewer sibling contract)

`cyborg:list_daemon_sessions_response.payload = { requestId, daemonId, sessions: DaemonSessionAuditRow[] }`.

Each `DaemonSessionAuditRow` exposes, for EVERY session bound to the target daemon
(no user scoping, no ephemeral drop):

| field             | source                                   | notes                                        |
| ----------------- | ---------------------------------------- | -------------------------------------------- |
| `agentId`         | `b.agent_id`                             | the session id — open target for the viewer  |
| `provider`        | `b.provider`                             |                                              |
| `channelId`       | `b.channel_id`                           | null for personal/ephemeral                  |
| `cyboId`          | `b.cybo_id`                              |                                              |
| `cyboName`        | cybo info map                            | denormalized label                           |
| `cyboAvatar`      | cybo info map                            |                                              |
| `initiatedBy`     | `b.initiated_by` (daemon-local user id)  | who launched it; null = unattributed/legacy  |
| `initiatedByEmail`| `getUserById(initiated_by)?.email`       | cross-namespace identity for "You" grouping  |
| `lifecycle`       | live `ManagedAgent.lifecycle` else `"unknown"` |                                        |
| `model`           | live / `b.model`                         |                                              |
| `modeId`/`availableModes`/`thinkingOptionId` | live fields            | `liveAgentFields` reuse                       |
| `cwd`             | live / `b.cwd`                           |                                              |
| `daemonId`        | `b.daemon_id ?? serverId`                | always equals the requested `daemonId`       |
| `daemonLocal`     | `live != null`                           |                                              |
| **`ephemeral`**   | `b.ephemeral === 1`                      | NEW — badge slash/mention summons            |
| **`internal`**    | `live?.internal ?? false`               | NEW — Paseo `internal` flag when live        |

**NOT exposed** (read-only viewer boundary): message/transcript bodies, prompt text, tool
calls/results, terminal I/O, system prompt, env/secrets. The audit LIST is metadata only;
opening a row navigates to the existing read-only session view (sibling spec) keyed by
`agentId`, which renders the transcript without input — the audit grants *visibility*, not
control. `ephemeral`/`internal` are optional on the UI `Agent` type and absent from the
scoped `cyborg:list_agents` rows, so they never appear in the sidebar.

## Risks

- **Leak into the scoped store** — mitigated by Decision 1 (separate message + local-only
  UI state; explicit test that `workspaceState.agents` is unchanged).
- **Gate bypass in cloud** — mitigated by enforcing at BOTH relay and dispatcher; tests for a
  non-admin rejection at each layer.
- **Cross-daemon id divergence** — `initiated_by` is a daemon-local id; `initiatedByEmail` +
  `resolveInitiatedByToGlobalId` (already used by `list_agents`) bridge it so a cross-daemon
  auditor groups rows under the right user.
- **Sessions without a cyborg binding** — raw Paseo agents spawned outside the cyborg path
  have no `agent_bindings` row and won't appear. Acceptable: cybo/slash/mention sessions
  (the audit's subject) always create a binding. Documented as the contract boundary.
- **Old daemon** — doesn't handle the new type → never answers; UI falls back to
  `scope="daemon"` over the scoped list. Backward compatible.

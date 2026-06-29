# Change: sessions-daemon-audit-visibility

## Why

A daemon runs sessions for **every** workspace member who has access to it, plus the
**ephemeral** contexts spawned per `/slash command` and per cybo `@mention`. The daemon's
owner is the person whose machine this is — they are accountable for what runs on it — yet
today they cannot see the full picture:

1. **Ephemeral sessions are hidden everywhere.** `spawnCybo({ ephemeral: true })` sets the
   Paseo agent `internal: true` (`agent-manager.ts:2454`) AND the binding `ephemeral` flag.
   `AgentManager.listAgents()` drops `internal` agents (`agent-manager.ts:619`), the global
   subscriber replay skips them (`:600-603`), and the cyborg list path drops `ephemeral`
   bindings (`dispatcher.ts:4421`). So a slash/mention summon is invisible at BOTH the
   ManagedAgent and binding levels — by design, to keep the chat sidebar uncluttered.
2. **The list is scoped to the current user.** `handleListAgents` returns only the caller's
   own + channel-bound + unattributable bindings (`dispatcher.ts:4431-4437`); the cloud
   offline path scopes by `guestEmail` (`relay-offline-agent-rows.ts:65-75`). The
   DaemonDetail "Sessions" section feeds off `workspaceState.agents`, which is exactly that
   already-scoped list — so even the owner sees only *their* sessions on *their* machine.

The daemon owner (and `admin`-scoped daemon-access grantees) need an **audit** lens: ALL
sessions on that daemon — every user's, including ephemeral/internal ones — so they can
verify nobody is doing anything weird on their host. This must NOT weaken the existing
scoped lists that feed the chat sidebar, and must NOT remove the `!internal` / `!ephemeral`
filters that keep ghost summons out of normal listings (the 2026-06-12 ghost-session
incident). The fix is a **separate, opt-in, gated audit path**, not a change to the
default list.

## What Changes

- **NEW message pair** (`cyborg-messages.ts`, extended — `cyborg:*` only):
  `cyborg:list_daemon_sessions` `{ requestId, workspaceId, daemonId }` →
  `cyborg:list_daemon_sessions_response` `{ requestId, daemonId, sessions: DaemonSessionAuditRow[] }`.
  A NEW request type, not a flag on `cyborg:list_agents` — the audit is daemon-scoped (one
  daemon, not workspace-wide), and its result must NOT flow into the global
  `workspaceState.agents` store that feeds the scoped chat sidebar.
- **NEW dispatcher handler** `handleListDaemonSessions` (in `cyborg/dispatcher.ts`, our
  seam — Paseo's `agent/` is untouched). It (a) enforces the audit gate via the existing
  daemon-access authority `pg.getUserDaemonScopes(workspaceId, daemonId, callerId)` requiring
  the `admin` scope (owner has it implicitly); (b) on pass, lists ALL bindings for that
  daemon with **no** `!ephemeral` and **no** caller filter; (c) projects each to a
  `DaemonSessionAuditRow` that additionally carries `ephemeral` and `internal` badges.
  The existing `handleListAgents` and its `!ephemeral` / caller filters are **unchanged**.
- **Relay routing + gate (cloud)** in `relay-standalone.ts`: route
  `cyborg:list_daemon_sessions` to the single `targetDaemonId = daemonId`, enforcing the same
  `admin`-scope gate at the relay boundary BEFORE forwarding (mirrors the terminal/admin
  scope gating at `:2194-2210`). When the daemon is offline, answer from the PG mirror with
  a NEW `auditAgentRows()` that — gate already passed — does NOT apply `offlineBindingVisible`
  and does NOT drop ephemeral rows; reuse `resolveInitiatedByToGlobalId` so rows group under
  "You".
- **UI** (`packages/ui`): `client.listDaemonSessions(wsId, daemonId)`; DaemonDetail fetches
  the audit list into LOCAL component state (never the global store) when
  `owned || hasAdminScope(daemonId)`, and renders it via SessionList `scope="audit"` —
  grouped by owning user with an **Ephemeral** badge on ephemeral/internal rows. A non-owner
  (or non-admin) keeps today's exact behavior: SessionList `scope="daemon"` over the
  already-scoped `workspaceState.agents`.

## Impact

- Affected specs: NEW capability `daemon-session-audit`.
- Affected code (all our seams, no Paseo `agent/` edits):
  - `packages/server/src/server/cyborg/cyborg-messages.ts` (new message schemas)
  - `packages/server/src/server/cyborg/dispatcher.ts` (new handler + case)
  - `packages/server/src/server/cyborg/relay-standalone.ts` (route + gate + offline)
  - `packages/server/src/server/cyborg/relay-offline-agent-rows.ts` (new `auditAgentRows`)
  - `packages/ui/src/lib/ws-client.ts`, `components/daemon/{DaemonDetail,SessionList}.svelte`,
    `plugins/agents/types.ts` (optional `ephemeral`/`internal` row fields)
- Security: the audit listing exposes session **metadata** for all users on a daemon. It is
  gated to the `admin` daemon scope (= owner-or-trusted), the same tier that already grants
  host control (RCE). It exposes NO message/transcript/prompt/terminal content — metadata
  only. See the read-only viewer contract in `design.md`.
- Backward compatible: a new optional message type; old daemons that don't handle it simply
  never answer, and the UI falls back to the scoped `scope="daemon"` view.

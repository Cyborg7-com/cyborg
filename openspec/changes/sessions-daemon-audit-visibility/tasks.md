# Tasks — sessions-daemon-audit-visibility

Ordered, loop-resolvable. CLI-first: every server slice lands with a vitest before the UI
slice that consumes it. Run server tests with
`npx vitest run packages/server/src/server/cyborg/dispatcher.test.ts` (and the relay/offline
specs noted per task). Do NOT touch `packages/server/src/server/agent/` — extend in
`cyborg/` only.

## 1. Protocol — message schemas

- [ ] 1.1 In `packages/server/src/server/cyborg/cyborg-messages.ts` add
  `CyborgListDaemonSessionsRequestSchema` = `{ type: "cyborg:list_daemon_sessions", requestId, workspaceId, daemonId }`
  and `CyborgListDaemonSessionsResponseSchema` =
  `{ type: "cyborg:list_daemon_sessions_response", payload: { requestId, daemonId, sessions: z.array(...) } }`.
  Export both and register them in the union list alongside `CyborgListAgentsRequestSchema`.
- [ ] 1.2 Define the `DaemonSessionAuditRow` shape (Zod object) per the contract in
  `design.md` — the existing agent-list row fields PLUS `ephemeral: z.boolean()` and
  `internal: z.boolean()`.
- [ ] 1.3 `npx vitest run packages/server/src/server/cyborg/cyborg-messages.test.ts` (or add
  one): the new schemas parse a valid request/response and reject a missing `daemonId`.

## 2. Server — dispatcher audit handler (the core)

- [ ] 2.1 In `cyborg/dispatcher.ts` add `case "cyborg:list_daemon_sessions":` →
  `handleListDaemonSessions(msg, auth, emit)`.
- [ ] 2.2 Implement the **gate**: `const pg = this.storage.pg`. If `pg` present, require
  `(await pg.getUserDaemonScopes(workspaceId, daemonId, auth.user.id)).has("admin")`
  (owner gets the full scope set implicitly, so this also passes the owner). If `pg` is
  absent (solo / single-tenant host), permit the local caller. On fail, emit
  `cyborg:error` `{ requestId, code: "forbidden" }` and return.
- [ ] 2.3 Implement the **listing**: `getAgentsByWorkspace(workspaceId)` filtered to
  `(b.daemon_id ?? this.serverId) === daemonId`, with **NO** `!b.ephemeral` filter and
  **NO** caller (`initiated_by`) filter. Map each via a new `toDaemonSessionAuditRow(b, cyboInfo)`
  that reuses `liveAgentFields` + the `initiatedBy`/`initiatedByEmail`/cybo-name denorm and
  adds `ephemeral: b.ephemeral === 1` and `internal: live?.internal ?? false`.
- [ ] 2.4 Leave `handleListAgents` and its `!b.ephemeral` (`:4421`) + caller filter
  (`:4431-4437`) **untouched** — assert this in review.
- [ ] 2.5 Tests in `dispatcher.test.ts`:
  - **owner-audit returns all**: seed 3 bindings on daemon D — one ephemeral, one
    `initiated_by = otherUser`, one `initiated_by = owner`; call as the daemon owner →
    response `sessions` contains all 3; the ephemeral row has `ephemeral: true`.
  - **non-owner scoped/denied**: call `cyborg:list_daemon_sessions` as a member with no
    `admin` scope on D → `cyborg:error` `forbidden` (and the member's own normal
    `cyborg:list_agents` STILL returns only their own session — proving the scoped path is
    untouched).
  - **gate**: a member granted exactly the `admin` scope on D (not owner) → audit succeeds;
    a member granted only `chat`/`spawn`/`terminal` → `forbidden`.
  - **other-daemon isolation**: a binding on daemon E is NOT returned when auditing D.

## 3. Relay — cloud routing + gate + offline

- [ ] 3.1 In `relay-standalone.ts` register `cyborg:list_daemon_sessions` for single-daemon
  routing to `targetDaemonId = inner.daemonId` (NOT the `list_agents` fan-out branch).
- [ ] 3.2 Enforce the gate at the relay boundary BEFORE forwarding:
  `getUserDaemonScopes(workspace, daemonId, guest.userId)` must include `admin` (mirror the
  terminal/admin scope gate at `:2194-2210`); else `respondError`/`cyborg:error forbidden`.
- [ ] 3.3 Offline fallback: when the target daemon is not connected, answer from the PG
  mirror using a NEW `auditAgentRows(bindings)` in `relay-offline-agent-rows.ts` that does
  **NOT** apply `offlineBindingVisible` and does **NOT** drop ephemeral (the gate already
  passed). Run rows through `resolveInitiatedByToGlobalId` so they group under "You".
- [ ] 3.4 Tests: `relay-offline-agent-rows.test.ts` — `auditAgentRows` returns ephemeral +
  other-users' rows (no `guestEmail` scoping); a relay-level test that a non-admin guest is
  rejected before any daemon forward.

## 4. UI — client + DaemonDetail + SessionList

- [ ] 4.1 `packages/ui/src/lib/ws-client.ts`: add
  `listDaemonSessions(workspaceId, daemonId): Promise<DaemonSessionAuditRow[]>` calling
  `request("cyborg:list_daemon_sessions", ...)`.
- [ ] 4.2 `plugins/agents/types.ts`: add optional `ephemeral?: boolean` and
  `internal?: boolean` to the `Agent` row (audit-only; absent on the scoped list).
- [ ] 4.3 `components/daemon/SessionList.svelte`: add `scope="audit"` — same
  `groupByOwner` grouping as `scope="daemon"`, but render an **Ephemeral** badge on rows
  where `agent.ephemeral || agent.internal`. `scope="daemon"` and `scope="mine"` render
  unchanged.
- [ ] 4.4 `components/daemon/DaemonDetail.svelte`: when `owned || daemonState`-resolved
  `admin` scope for `daemonId`, fetch `client.listDaemonSessions(wsId, daemonId)` into a
  LOCAL `$state` (NOT `workspaceState.agents`) and pass it to `<SessionList scope="audit" .../>`;
  otherwise keep the current `<SessionList scope="daemon" sessions={workspaceState.agents} .../>`.
  Re-fetch on `daemonId` change / when the daemon comes online; guard stale responses like
  the existing provider/cli probes.
- [ ] 4.5 Copy: the Sessions section sub-header reflects the lens ("All sessions on this
  daemon, including ephemeral summons" for audit; today's text for the scoped view).

## 5. Verify + docs

- [ ] 5.1 `npx vitest run packages/server/src/server/cyborg` green; `pnpm --filter @cyborg7/ui... typecheck`.
- [ ] 5.2 `openspec validate sessions-daemon-audit-visibility --strict` passes.
- [ ] 5.3 Manual sanity: as owner, the DaemonDetail Sessions section shows another user's
  session and an ephemeral mention summon badged "Ephemeral"; as a non-admin member it shows
  only their own (unchanged). The chat sidebar (`workspaceState.agents`) is unchanged in both.

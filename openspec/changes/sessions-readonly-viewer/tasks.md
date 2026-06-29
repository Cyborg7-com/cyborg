# Tasks — sessions-readonly-viewer

Ordered so each task is independently loop-resolvable (compiles + passes its own check) and the next
builds on the previous. Server tasks land first (CLI-first), UI last.

> Boundary check before every task: server edits stay inside
> `packages/server/src/server/cyborg/` (the durable timeline in `agent/` is read-only here and must
> NOT be modified — it already captures the messages). UI edits stay inside `packages/ui/`.
> Authz for "sessions the owner can see" is owned by **`sessions-daemon-audit-visibility`** — import
> its predicate; do not re-derive it.

## 1. Durable capture store for ephemeral injected context

- [x] 1.1 Add an `ephemeral_session_context` table in `cyborg/storage.ts` keyed by `agent_id`, columns:
      `workspace_id`, `channel_id`, `cybo_id`, `system_prompt`, `mcp_servers_json`, `routed_prompt`,
      `raw_prompt`, `created_at`. Mirror it through `DualStorage` (SQLite write + async PG fire-and-forget)
      the same way other cyborg tables are.
- [x] 1.2 Add storage methods: `saveEphemeralSessionContext(row)`, `getEphemeralSessionContext(agentId)`,
      and a GC method `pruneEphemeralSessionContext(...)` (TTL or "prune with the agent's timeline rows").
- [x] 1.3 Verify: a unit test inserts a context row, reads it back by `agentId`, and confirms GC removes
      it past the retention bound. (`pnpm -C packages/server test`)

## 2. Capture at spawn (system prompt + mcpServers + routed prompt)

- [x] 2.1 In `cyborg/cybo-manager.ts` `spawnCybo`, when `ephemeral === true`, call
      `saveEphemeralSessionContext` with the in-scope `systemPrompt` (from `buildCyboPrompt`) and the
      assembled `mcpServers` map (the same value passed to `createAgent`; on the composio branch this is the
      output of `injectComposioMcpServers`). Serialize `mcpServers` to `mcp_servers_json` as
      `[{name, type, url?, toolkit?}]`.
- [x] 2.2 Thread the routed prompt into the capture: in `cyborg/message-router.ts` `routeToAgent`
      (the @mention path) and `cyborg/dispatcher.ts` `handleInvokeCyboMention` (the relay slash path), pass
      the **framed** prompt and the **raw** prompt so the context row records both `routed_prompt` and
      `raw_prompt`.
- [x] 2.3 In `cyborg/message-router.ts` `teardownEphemeralAgent`, confirm it deletes `agent_bindings`
      but **does NOT** delete `ephemeral_session_context` (add a regression test asserting the context row
      survives teardown).
- [x] 2.4 Verify (server test): drive an ephemeral cybo turn to completion + teardown, then assert
      `getEphemeralSessionContext(agentId)` returns the captured system prompt, mcpServers, and routed/raw
      prompt. (`pnpm -C packages/server test`)

## 3. Read RPC for the ephemeral context bundle

- [x] 3.1 Add `cyborg:fetch_session_context` request/response schemas in `cyborg/cyborg-messages.ts`:
      request `{ requestId, workspaceId, agentId }`; response `{ requestId, context: {...} | null }`.
- [x] 3.2 Add `handleFetchSessionContext` in `cyborg/dispatcher.ts`: authorize via the
      `sessions-daemon-audit-visibility` predicate, return `getEphemeralSessionContext(agentId)` (or `null`
      for non-ephemeral agents). **Pure read — never call `ensureAgentLoaded`.**
- [x] 3.3 Add `cyborg:fetch_session_context` to `DAEMON_FORWARD_TYPES` in `cyborg/relay-standalone.ts`
      (resolves to the owning daemon like `fetch_agent_timeline`; scope `chat`).
- [x] 3.4 Verify (server test): the owner gets the context for an ephemeral session; an ordinary live
      agent returns `context: null`. (`pnpm -C packages/server test`)

## 4. Make the transcript reachable for audit-visible / ephemeral sessions (attach-free)

- [x] 4.1 In `cyborg/dispatcher.ts` `handleFetchAgentTimeline`: when `getAgentBinding(agentId)` is
      absent, resolve the session via the audit-visibility predicate + `ephemeral_session_context` (for the
      workspace scope) and, if authorized, serve `durableTimelineStore.fetchCommitted(...)`. Keep all
      existing live-path behavior for bound agents. Do **not** add any `ensureAgentLoaded` call.
- [x] 4.2 Verify (server test): `fetch_agent_timeline` returns the turn's items for an ephemeral session
      **after** teardown (binding deleted). (`pnpm -C packages/server test`)
- [x] 4.3 Verify (no-revive test): spy on `resumeAgentFromPersistence`/`ensureAgentLoaded`; issue
      `fetch_agent_timeline` + `fetch_session_context` against a dormant and an ephemeral session; assert
      neither spy fires, no provider session is created, and `agentManager.getAgent(agentId)` stays
      undefined.
- [x] 4.4 Verify (authz test): a requester without audit scope is rejected for both read RPCs; a scoped
      owner/admin is allowed.

## 5. Read-only viewer UI (no composer, no attach)

- [x] 5.1 Add `client.ts` read wrappers in `packages/ui`: `fetchSessionContext(workspaceId, agentId)`
      (reuse the existing `fetchAgentTimeline` wrapper for the transcript).
- [x] 5.2 Build the read-only viewer surface (route/overlay opened from the daemon-detail audit list
      row provided by `sessions-daemon-audit-visibility`). Mount `AgentStreamView` with `onRewind` **omitted**
      and **no `AgentComposer`**. Drive it with `fetchAgentTimeline` / `loadOlderAgentTimeline` only.
- [x] 5.3 For ephemeral sessions (context !== null), render a collapsible **Context** panel with three
      labelled sections: **System prompt**, **Tools available** (the mcpServers list), **Received prompt**
      (raw + framed). Theme tokens only; no hardcoded colors/sizes.
- [x] 5.4 Assert the viewer mounts NONE of: `AgentComposer`, model/mode/thinking selectors, rewind,
      archive — i.e. it issues no RPC that can revive the session.
- [~] 5.5 e2e (Playwright, worker-scoped test-daemon fixture): open an ephemeral session from the audit
  list → assert the transcript renders, the Context panel shows system prompt + tools + received prompt,
  and there is **no** input box / attach affordance; reload and assert it re-reads without reviving.
  **DEFERRED — gated on the sibling `sessions-daemon-audit-visibility` audit-list entry point, which is
  not yet on `cyborg7` (there is no UI path to _open_ the viewer from). The no-revive / no-composer
  contract that 5.5 verifies is covered deterministically meanwhile by:**
  (a) the server no-revive spy test (`sessions-readonly-viewer.test.ts` — `ensureAgentLoaded` /
  `resumeAgentFromPersistence` never fire, `getAgent` stays undefined), and
  (b) the UI source-scan lock `readonly-session-viewer.source.test.ts` (no composer / no `onRewind` / no
  mutating RPC; only the two pure-read RPCs). The Playwright spec lands with the audit-list merge.

## CLI-first verification (exact invocations)

```bash
# server: capture + read RPCs + attach-free, all the new assertions:
pnpm -C packages/server test -- sessions-readonly-viewer

# UI e2e (the single new spec):
cd packages/ui && npx playwright test e2e/sessions-readonly-viewer.spec.ts

# regression gate:
pnpm -C packages/server test && cd packages/ui && npx playwright test
```

# Design — sessions-readonly-viewer

## Investigation findings (what exists today)

### The transcript read path already avoids revive
- `cyborg:fetch_agent_timeline` → `CyborgDispatcher.handleFetchAgentTimeline`
  (`packages/server/src/server/cyborg/dispatcher.ts`). It reads the live in-memory window via
  `agentManager.getAgent(agentId)` (a passive lookup) and falls back to
  `durableTimelineStore.fetchCommitted(...)`. It **never** calls `ensureAgentLoaded`. Pagination
  (`cursor`/`limit`/`direction:"older"`) is in place; the scroll-up "load older" path was fixed
  (`fix(agents): lazy-load older session history on scroll-up`).
- Durable store: `SqliteAgentTimelineStore` (`cyborg/sqlite-timeline-store.ts`), single table
  `agent_timeline_rows(agent_id, seq, timestamp, item_json)`. Wired in `bootstrap.ts`. `recordTimeline`
  (`agent/agent-manager.ts`) appends durably for **every** agent including `internal`/ephemeral — there
  is **no** `internal`/`persistSession` guard on the durable write. `closeAgent`/`teardownEphemeralAgent`
  delete only the in-memory timeline; **durable rows survive**.
- **The one gate that blocks ephemeral reads:** `handleFetchAgentTimeline` authorizes with
  `storage.getAgentBinding(agentId)` (must exist + match workspace). `teardownEphemeralAgent`
  (`cyborg/message-router.ts`) calls `deleteAgentBinding` → the binding is gone, so the durable rows
  become unreachable through the API even though they exist on disk.

### The revive path to avoid
`CyborgDispatcher.ensureAgentLoaded` → `agent/agent-loading.ts` → `AgentManager.resumeAgentFromPersistence`.
Invoked only by **mutating** handlers: `handleSendAgentPrompt` (prompt), `set_agent_model` /
`set_agent_mode` / `set_agent_thinking` / `rewind` / `archive`. **No read RPC calls it.** In the UI, the
**only** thing that triggers it is `AgentComposer` → `sendAgentPrompt` → `cyborg:send_agent_prompt`. So
"attach-free" = "issue no mutating RPC and never mount the composer."

### `AgentStreamView` is already a read-only-capable renderer
`packages/ui/src/lib/plugins/agents/components/AgentStreamView.svelte` is a pure scroll/renderer with no
input box. Its JSDoc literally says omitting `onRewind` yields "a read-only viewer surface." Its only
outbound call is `loadOlderAgentTimeline` (a pure `fetch_agent_timeline` read) on scroll-near-top.
`AgentComposer` is mounted **separately** by the agent page (`routes/workspace/[id]/agent/[agentId]/+page.svelte`),
not by `AgentStreamView`.

### What ephemeral context is lost
- `persistSession:false` (set in `cybo-manager.ts` for ephemeral) deletes only the **provider** session
  file (Claude jsonl / Pi `--no-session`). The durable timeline is independent and **keeps** the turn's
  user/assistant/tool messages.
- **(a) system/platform prompt** — `buildCyboPrompt` result → `agent_bindings.system_prompt`, **deleted
  on teardown** with the binding.
- **(b) mcpServers/tools** — assembled in `spawnCybo` (`cybo.mcp_servers` JSON + synthetic `cyborg7` HTTP
  server; on the composio branch via `injectComposioMcpServers`), passed to the provider, **never
  persisted**.
- **(c) routed prompt** — the timeline stores only the **raw** user text (`rawPrompt` →
  `user_message`); the **fully framed** prompt (`buildMentionPrompt`: roster + transcript + routed text)
  passed to `streamAgent` is **never persisted**.
- No existing table durably holds (a)+(b)+(c) past teardown. A **new** table is required.

## Decisions

### D1 — New durable capture store `ephemeral_session_context`, written at spawn, NOT deleted on teardown
Keyed by `agent_id`. Columns: `agent_id`, `workspace_id`, `channel_id`, `cybo_id`, `system_prompt`,
`mcp_servers_json`, `routed_prompt`, `raw_prompt`, `created_at`. Written inside `spawnCybo` (where
`systemPrompt` and the `mcpServers` map are both in scope) and the routed/raw prompt threaded from the
`routeToAgent` caller (`message-router.ts` for @mention, `dispatcher.handleInvokeCyboMention` for the
relay slash path). Lives in `cyborg/storage.ts` behind `DualStorage` (SQLite cache + optional PG mirror)
like the other cyborg tables. `teardownEphemeralAgent` continues to delete `agent_bindings` but **must
not** touch this table. GC: prune a context row when its `agent_timeline_rows` are pruned, or by TTL,
so the store stays bounded.

Rationale: capture-at-spawn is the only point where all three pieces co-exist before teardown destroys
them. Keeping it out of `agent_bindings` (which is intentionally deleted) is what makes the audit
durable. `mcp_servers_json` stores the assembled server configs (names + types + scoped URLs / toolkit
restriction) — that is "the tools made available"; the provider's runtime-resolved tool enumeration is
not knowable at spawn and is explicitly out of scope.

### D2 — Reuse `cyborg:fetch_agent_timeline` for the transcript; loosen authz to the audit predicate, attach-free
Extend `handleFetchAgentTimeline`: if `getAgentBinding(agentId)` is absent, resolve the session via the
**audit-visibility predicate** from `sessions-daemon-audit-visibility` (does this requester have audit
scope over this daemon/session?) plus the `ephemeral_session_context`/durable rows for the workspace
binding. If authorized, serve `durableTimelineStore.fetchCommitted(...)`. The handler still **never**
calls `ensureAgentLoaded`. This keeps one transcript code path for live and ephemeral.

Note on scope: the relay has no scope narrower than `chat`, and `chat` also authorizes prompting.
Read-only is therefore enforced at the **handler + UI layer** (which RPCs exist / are issued), not by a
distinct relay scope. The viewer issues only read RPCs; the composer (the sole revive trigger) is never
mounted.

### D3 — New read RPC `cyborg:fetch_session_context` for the ephemeral bundle
`request: { requestId, workspaceId, agentId }` → `response: { requestId, context: { systemPrompt,
mcpServers: Array<{name, type, url?, toolkit?}>, routedPrompt, rawPrompt, cyboId, channelId, createdAt }
| null }`. `null` for ordinary (non-ephemeral) agents — the viewer then shows transcript only. Added to
`DAEMON_FORWARD_TYPES` (scope `chat`) so guests are forwarded to the owning daemon, authorized by the
same audit predicate as D2.

### D4 — Read-only UI surface: `AgentStreamView` (no composer) + ephemeral context panel
A dedicated read-only viewer (route/overlay opened from the audit list row) that:
- mounts `AgentStreamView` with `onRewind` **omitted** and **no `AgentComposer`** — the transcript only;
- drives it with `fetchAgentTimeline` / `loadOlderAgentTimeline` (pure reads) and the passive
  workspace-level `agent_stream` broadcast for any still-live session (no per-agent attach);
- for ephemeral sessions, calls `fetchSessionContext` and renders a collapsible **Context** panel with
  three labelled sections — **System prompt**, **Tools available**, **Received prompt** (raw + framed).

It deliberately mounts **none** of the mutating affordances (composer, model/mode/thinking selectors,
rewind, archive). This is the fix for the prior "live:false read-only view never built because attach
dropped it" note: the read path here is structurally attach-free.

## CLI-first verification
- **Server (context + transcript served post-teardown):** spawn an ephemeral cybo turn, let it complete
  and tear down, then assert as the daemon owner: `fetch_agent_timeline` returns the turn's items from
  the durable store (binding already deleted) **and** `fetch_session_context` returns the captured
  `systemPrompt` + `mcpServers` + `routedPrompt`.
- **Read-only / no-revive flag test:** spy on `resumeAgentFromPersistence` / `ensureAgentLoaded`; issue
  the two read RPCs against a dormant + an ephemeral session and assert neither is called, no provider
  session is created, and `agentManager.getAgent` stays undefined (no revive, no mutation).
- **Authz test:** a requester WITHOUT audit scope over the daemon is rejected for both read RPCs; a
  scoped owner/admin is allowed (predicate from `sessions-daemon-audit-visibility`).

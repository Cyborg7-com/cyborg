# sessions-readonly-viewer — Read-only session viewer (timeline + full ephemeral context)

## Why

The daemon-detail audit list (delivered by the sibling change **`sessions-daemon-audit-visibility`**)
lets a daemon owner/admin SEE every session a daemon is running — active, **ephemeral** (the
temporary context a `/slash command` or cybo `@mention` spins up for one turn), and **another
user's**. But seeing a row is not the same as being able to audit it. Today there is **no way to
open a session and read what it actually did**, and for ephemeral cybo turns there is **no way to
recover the context the cybo was given** — by the time anyone looks, the agent is already torn down.

Two concrete gaps make this impossible right now:

1. **The transcript is reachable in principle but gated shut for ephemeral sessions.** The durable
   timeline store (`SqliteAgentTimelineStore`, table `agent_timeline_rows`) physically holds rows for
   **every** agent id including `internal`/ephemeral ones — `recordTimeline` writes durably with no
   `internal` guard, and `closeAgent`/`teardownEphemeralAgent` delete only the *in-memory* window, not
   the durable rows. **But** `dispatcher.handleFetchAgentTimeline` authorizes via
   `storage.getAgentBinding(agentId)`, and `teardownEphemeralAgent` calls `deleteAgentBinding` — so a
   torn-down ephemeral session has rows on disk that the read API refuses to serve.

2. **The injected context the ephemeral session received is not persisted.** For a cybo turn:
   - the **system/platform prompt** (`buildCyboPrompt`) is written to `agent_bindings.system_prompt`
     but **deleted on teardown** with the binding;
   - the **MCP servers/tools** made available (`mcpServers` assembled in `spawnCybo`; on the composio
     branch via `injectComposioMcpServers`) are **never persisted** — discarded after spawn;
   - the **fully framed routed prompt** (`buildMentionPrompt` output: roster + transcript + the routed
     text) is **never persisted** — only the *raw* user text lands in the timeline as a `user_message`.

   So even if we expose the transcript, we cannot answer the actual audit question: *what context and
   what tools did this cybo get?* (This is the same class of gap noted for terminal I/O — runtime
   context not persisted.)

This change makes the audit list rows **openable** as a **strictly read-only** viewer: the transcript
up to now, plus — for ephemeral sessions — a context panel showing the injected system prompt, the
tools that were available, and the prompt that was routed in. **No input box, no attach, no revive.**

## What Changes

1. **Capture the ephemeral injected context at spawn** into a new durable, owner-scoped store
   (`ephemeral_session_context`, keyed by `agent_id`), written inside `spawnCybo` where the three
   values are in scope, and threaded the routed/raw prompt from the `routeToAgent` caller. This store
   is **NOT deleted by `teardownEphemeralAgent`** (unlike `agent_bindings`), with a retention/GC bound
   so it cannot grow without limit. All in `packages/server/src/server/cyborg/`.

2. **Make the durable transcript reachable for any audit-visible session, attach-free.** Loosen the
   timeline read authz so that when there is no live `agent_bindings` row, the handler resolves the
   session through the audit-visibility predicate (sibling change) + the new context store and serves
   the durable rows. The read path **never** calls `ensureAgentLoaded` / `resumeAgentFromPersistence`
   — it stays a pure read, exactly as `handleFetchAgentTimeline` already is.

3. **A new read RPC for the ephemeral context bundle** — `cyborg:fetch_session_context` — returning
   `{ systemPrompt, mcpServers, routedPrompt, rawPrompt, cyboId, channelId, createdAt }` for ephemeral
   sessions (null for ordinary agents, which only need the transcript). Forwarded daemon-ward through
   the relay like `fetch_agent_timeline`.

4. **A read-only UI surface** that mounts the existing `AgentStreamView` in read-only mode (omit
   `onRewind`; **do not** mount `AgentComposer`) for the transcript, plus a context panel (System
   prompt / Tools available / Received prompt) for ephemeral sessions. Opening a session issues **only**
   the two pure-read RPCs (`fetch_agent_timeline`, `fetch_session_context`) and never any RPC that
   revives the agent.

## Impact

- **Affected specs:** new capability `sessions-readonly-viewer`.
- **Depends on:** **`sessions-daemon-audit-visibility`** — provides (a) the clickable session rows in
  the daemon-detail list and (b) the authz predicate ("sessions this owner/admin may see") that this
  viewer's loosened timeline authz is scoped by. This change is inert without that list to click from.
- **Package boundary:** server work stays in `packages/server/src/server/cyborg/` (capture store,
  message types, dispatcher handlers, relay forward); the durable timeline in
  `packages/server/src/server/agent/` is **not modified** (it already captures the messages). UI work
  stays in `packages/ui/`.
- **Affected files (new/edited):**
  - `cyborg/storage.ts` + DualStorage — new `ephemeral_session_context` table + read/write/GC methods.
  - `cyborg/cybo-manager.ts` — capture systemPrompt + mcpServers at spawn.
  - `cyborg/message-router.ts` + `cyborg/dispatcher.ts` (`handleInvokeCyboMention`) — thread the
    routed/raw prompt into the capture; do NOT delete the context on teardown.
  - `cyborg/cyborg-messages.ts` — `cyborg:fetch_session_context` request/response schemas; reuse
    `cyborg:fetch_agent_timeline`.
  - `cyborg/dispatcher.ts` — `handleFetchSessionContext`; loosen `handleFetchAgentTimeline` authz for
    audit-visible/ephemeral sessions (attach-free).
  - `cyborg/relay-standalone.ts` — add `cyborg:fetch_session_context` to `DAEMON_FORWARD_TYPES`
    (scope `chat`, read-only at the handler/UI layer).
  - `packages/ui/` — read-only viewer surface reusing `AgentStreamView` (no composer) + ephemeral
    context panel; client wrappers for the two read RPCs.
- **Risk:** (1) **growth/PII** — captured prompts/tools may contain secrets; the store needs the same
  access scoping as the audit list + a retention bound. (2) **Authz widening** — loosening timeline
  authz must stay strictly inside the audit-visibility predicate or it leaks other agents' transcripts.
  (3) **mcpServers ≠ resolved tool list** — we persist the server *configs* available at spawn (names,
  types, scoped URLs / toolkit restrictions), not the provider's runtime-resolved tool enumeration;
  the panel is labelled "tools made available" accordingly.

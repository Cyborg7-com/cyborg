import { z } from "zod";

// ─── Daemon → Relay ─────────────────────────────────────────────────

// Daemon-reported metadata. `host`/`platform`/`arch` describe the machine
// (location); `cyboInstalled` is a capability flag detected once at boot.
// Runtime stats (cpu/memMb/agents/queueDepth) are refreshed each heartbeat.
// NOTE: deliberately NOT `.passthrough()` — extra fields the daemon may send
// (e.g. the live `cybos` agent map) are stripped here exactly as before, so
// they never leak into the persisted `daemons.meta` jsonb or the relay's
// Redis snapshot.
export const DaemonMetaSchema = z.object({
  cpu: z.number().optional(),
  memMb: z.number().optional(),
  agents: z.number().optional(),
  queueDepth: z.number().optional(),
  host: z.string().optional(),
  platform: z.string().optional(),
  arch: z.string().optional(),
  cyboInstalled: z.boolean().optional(),
  // Running daemon CLI version (#663) — lets the UI flag outdated daemons and
  // show the "N daemons outdated → Update" aggregate. Optional/back-compat.
  version: z.string().optional(),
  // DualStorage mode the daemon runs in ('solo' = SQLite only, 'connected' =
  // SQLite cache + shared PG). Persisted to daemons.deployment_mode for the
  // superadmin overview. Optional/back-compat: older daemons omit it (NULL =
  // unknown). Constrained so a malformed value can't poison the column.
  deploymentMode: z.enum(["solo", "connected"]).optional(),
  // Cybo runtime capability (internal docs auth-UX item 3): is the runtime
  // CONFIGURED (≥1 listed model — credentials present, NOT validated; the
  // runtime lists models without checking keys), and for which backends?
  // Refreshed each heartbeat (auth changes at runtime via `cybo login`);
  // absent on daemons older than this field or pre-settle.
  cyboRuntime: z
    .object({
      configured: z.boolean(),
      modelCount: z.number(),
      backends: z.array(z.object({ backend: z.string(), modelCount: z.number() })),
    })
    .optional(),
  // Usage-metrics heartbeat (round 1, relay-receive side). Live counts the daemon
  // reports each heartbeat for the superadmin usage dashboard. Optional/back-compat:
  // older daemons omit them (treated as unknown, not zero). Without these fields
  // declared they'd be stripped by this strict (non-passthrough) schema — see the
  // NOTE above — so they MUST be listed to survive into daemons.meta.
  activeSessionCount: z.number().int().nonnegative().optional(),
  activeCyboCount: z.number().int().nonnegative().optional(),
  // Deployment edition the daemon runs as. Persisted to daemons.deployment_edition
  // (alongside the jsonb copy) for a cheap GROUP BY edition. Constrained so a
  // malformed value can't poison the column. Optional/back-compat: older daemons
  // omit it (NULL = unknown).
  edition: z.enum(["saas", "selfhost", "opensource"]).optional(),
});

export type DaemonMeta = z.infer<typeof DaemonMetaSchema>;

export const DaemonHelloSchema = z.object({
  type: z.literal("daemon_hello"),
  daemonId: z.string(),
  token: z.string(),
  workspaceIds: z.array(z.string()),
  label: z.string().optional(),
  meta: DaemonMetaSchema.optional(),
  // Installed/ready provider ids (e.g. ["claude","pi"]) so the relay can route a
  // cybo mention to a daemon that can actually run the cybo's harness (#697).
  // Additive + optional: older daemons omit it → the relay degrades to the
  // capability-blind pick. Never break the WS schema (CLAUDE.md).
  providers: z.array(z.string()).optional(),
});

export const RelayForwardSchema = z.object({
  type: z.literal("relay_forward"),
  workspaceId: z.string(),
  message: z.record(z.unknown()),
});

export const RelaySyncRequestSchema = z.object({
  type: z.literal("relay_sync_request"),
  workspaceId: z.string(),
  sinceSeq: z.number(),
});

// Cybo data read over the relay (daemon → relay → PG). A cybo's MCP tools run on
// the daemon, but a CLOUD workspace's channels/messages live only in the relay's
// PG (the daemon has no DATABASE_URL and the sync stream carries messages, not
// the channel catalog) — so the daemon asks the relay, exactly like the UI does.
export const CyboReadRequestSchema = z.object({
  type: z.literal("cybo_read_request"),
  requestId: z.string(),
  workspaceId: z.string(),
  cyboId: z.string(),
  kind: z.enum([
    "channels",
    "history",
    "search",
    "tasks",
    "members",
    "roster",
    "projects",
    // kind:"pages" — list a Tasks-project's pages (docs); kind:"page" — read one
    // page by id. Both owner-scoped relay-side (a cybo inherits its owner's page
    // visibility), so a cloud daemon (no PG handle) can surface documented Pages.
    "pages",
    "page",
  ]),
  // kind:"history"/"search"/"members" params
  channelId: z.string().optional(),
  limit: z.number().optional(),
  // kind:"page" — the page id to read.
  pageId: z.string().optional(),
  // kind:"search" — text to match within the (membership-gated) channel
  query: z.string().optional(),
  // kind:"tasks" filters (mirror cyborg7_list_tasks). status/assigneeId map to the
  // shared getTasks filter; projectId/state/priority/label are the Tasks Redesign
  // (Plane-style) filters the MCP readTasks forwards — additive + optional, so an
  // old daemon/relay simply omits them. Required on the wire schema or zod strips
  // them before handleCyboRead ever sees them.
  status: z.string().optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  state: z.string().optional(),
  priority: z.string().optional(),
  label: z.string().optional(),
});

export const CyboReadResponseSchema = z.object({
  type: z.literal("cybo_read_response"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  // kind:"channels" — workspace channels with the cybo's membership flag
  channels: z
    .array(z.object({ id: z.string(), name: z.string(), isMember: z.boolean() }))
    .optional(),
  // kind:"history" — chronological-agnostic raw rows (daemon formats)
  messages: z
    .array(
      z.object({
        id: z.string(),
        from_id: z.string(),
        from_name: z.string().nullable().optional(),
        text: z.string(),
        created_at: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .optional(),

  // kind:"tasks" — workspace tasks from the shared PG (the same rows the UI sees).
  // The Tasks Redesign (Plane-style) projection mirrors the relay's mapTask snake_
  // case readback so the cybo's list_tasks surfaces the same rich shape the UI gets:
  // the per-project sequence id, workflow state, priority, project, and the label/
  // module id sets. All additive + optional, so an old relay (thin rows) still
  // validates and the daemon-side formatter falls back to the raw id.
  tasks: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        assignee_id: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        due_at: z.number().nullable().optional(),
        created_at: z.union([z.string(), z.number()]).optional(),
        sequence_id: z.number().nullable().optional(),
        state_id: z.string().nullable().optional(),
        priority: z.string().nullable().optional(),
        project_id: z.string().nullable().optional(),
        label_ids: z.array(z.string()).optional(),
        module_ids: z.array(z.string()).optional(),
      }),
    )
    .optional(),

  // kind:"members" — the channel's members (humans + cybos) from the shared PG, so
  // the cybo's cyborg7_list_channel_members surfaces the same roster the UI sees.
  // memberType distinguishes a human user row from a cybo row; name/role are the
  // display fields (nullable: a user may have no display name, a cybo no role).
  members: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        memberType: z.enum(["user", "cybo"]),
      }),
    )
    .optional(),

  // kind:"projects" — the workspace's Tasks-projects from the shared PG (same rows
  // the UI/board see), so the cybo's cyborg7_list_projects works on a cloud daemon
  // with no PG handle. `id` is the tasks_projects.id; `chatProjectId` is null for
  // the synthetic Inbox (`isInbox` true). `name` is the linked chat project's name,
  // or "Inbox". All additive + optional so an old relay still validates.
  projects: z
    .array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        name: z.string(),
        color: z.string().nullable(),
        isInbox: z.boolean(),
        chatProjectId: z.string().nullable(),
      }),
    )
    .optional(),

  // kind:"pages" — a Tasks-project's pages VISIBLE to the cybo's owner (public +
  // legacy null-owner + the owner's own), as a compact hierarchy projection (no
  // body) so the cybo can see the doc tree. `parentId` null = a root page.
  pages: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        parentId: z.string().nullable(),
        icon: z.string().nullable(),
      }),
    )
    .optional(),

  // kind:"page" — a single page WITH its body content (the document text), gated
  // by the same owner visibility as `pages`. Null when the page is missing/hidden.
  page: z
    .object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      parentId: z.string().nullable(),
      icon: z.string().nullable(),
    })
    .nullable()
    .optional(),
});

// Cybo task WRITES over the relay (daemon → relay → PG). Same rationale as
// cybo_read: a cloud daemon's task tools wrote ITS local SQLite only — tasks a
// cybo created never reached the shared PG (invisible to the UI) and vice
// versa. The relay validates (cybo belongs to the workspace + its platform
// permissions allow task writes) and mutates PG directly, exactly like the UI's
// guest path. Old relays without this handler simply never answer — the daemon
// times out and falls back to its local write (today's behavior).
export const CyboWriteRequestSchema = z.object({
  type: z.literal("cybo_write_request"),
  requestId: z.string(),
  workspaceId: z.string(),
  // The cybo on whose behalf the write runs. OPTIONAL: a NON-cybo (plain) agent
  // writes with no cyboId and instead carries `createdBy` (its spawning user) — the
  // relay then validates that user as a workspace member and records the task under
  // them. A cybo write still sends cyboId (unchanged). Additive + backward compat:
  // an old daemon always sends cyboId; an old relay ignores `createdBy`.
  cyboId: z.string().optional(),
  // Tasks Phase 0 ops (archive/delete) ride the cybo write path too:
  //  - "delete_task" hard-deletes a workspace-anchored task (pg.deleteTask).
  //  - archive/unarchive REUSE "update_task" with `archivedAt` (no new kind), so an
  //    old relay that lacks delete_task still archives via the update path.
  kind: z.enum(["create_task", "update_task", "delete_task"]),
  // The acting agent (recorded as the task creator).
  agentId: z.string().optional(),
  // Owner override for a NON-cybo (user-owned) write: the spawning user's id. When
  // present (and cyboId is absent) the relay attributes the task to this user. A
  // cybo write omits it and the relay derives created_by from agentId/cyboId.
  createdBy: z.string().optional(),
  // create_task
  title: z.string().optional(),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  dueAt: z.number().optional(),
  // Tasks Phase 2 (watcher): optional channel binding + board priority. Additive
  // and optional, so an old daemon/relay simply omits them. Required on the wire
  // schema or zod strips them before handleCyboWrite ever sees them. Nullable to
  // match the storage layer's `string | null` (DualStorage/pg-sync.createTask).
  channelId: z.string().nullish(),
  priority: z.string().nullish(),
  // Tasks Redesign — Plane-style task fields over the cybo write path, so a cybo's
  // task tools can set the same fields the UI can. Additive + nullish so an old
  // daemon/relay simply omits them; required on the wire schema or zod strips them
  // before handleCyboWrite sees them. `labels` are label NAMES (auto-created in the
  // project's catalog), resolved to ids by the relay handler.
  projectId: z.string().nullish(),
  parentId: z.string().nullish(),
  stateId: z.string().nullish(),
  startDate: z.number().nullish(),
  labels: z.array(z.string()).optional(),
  cycleId: z.string().nullish(),
  moduleIds: z.array(z.string()).optional(),
  // update_task
  taskId: z.string().optional(),
  status: z.string().optional(),
  result: z.string().optional(),
  // Soft-archive toggle (Tasks Phase 0), forwarded on the update_task kind: epoch ms
  // to archive, null to restore. Additive + nullish so an old daemon/relay simply
  // omits it; required on the wire schema or zod strips it before handleCyboWrite
  // sees it. The MCP cyborg7_archive_task tool sets this on an update_task write.
  archivedAt: z.number().nullish(),
});

export const CyboWriteResponseSchema = z.object({
  type: z.literal("cybo_write_response"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  task: z.object({ id: z.string(), title: z.string(), status: z.string() }).optional(),
});

// Agent-generated image upload over the relay (daemon → relay → S3). An agent
// (Codex / imagegen skill) emits an image as a LOCAL file path the daemon owns
// but the browser/relay can't read; only the relay holds the S3 credentials. The
// daemon ships the bytes inline and the relay PUTs them to S3, returning the
// public URL so the daemon can rewrite the timeline item's markdown token to a
// reachable URL (which the session/chat renderer embeds inline). Old relays
// without this handler never answer — the daemon times out and leaves the token
// as-is (today's broken-but-safe behavior). Mirrors cybo_read/write.
export const UploadImageRequestSchema = z.object({
  type: z.literal("upload_image_request"),
  requestId: z.string(),
  // base64-encoded image bytes (no data: prefix).
  dataBase64: z.string(),
  mimeType: z.string(),
  filename: z.string(),
});

export const UploadImageResponseSchema = z.object({
  type: z.literal("upload_image_response"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  url: z.string().optional(),
  key: z.string().optional(),
});

// ─── Relay → Daemon ─────────────────────────────────────────────────

export const RelaySubscribedSchema = z.object({
  type: z.literal("relay_subscribed"),
  workspaceIds: z.array(z.string()),
  daemonId: z.string(),
});

export const RelayMessageSchema = z.object({
  type: z.literal("relay_message"),
  workspaceId: z.string(),
  fromDaemonId: z.string(),
  seq: z.number(),
  message: z.record(z.unknown()),
});

export const RelaySyncResponseSchema = z.object({
  type: z.literal("relay_sync_response"),
  workspaceId: z.string(),
  messages: z.array(z.record(z.unknown())),
});

export const RelayErrorSchema = z.object({
  type: z.literal("relay_error"),
  error: z.string(),
});

// ─── Heartbeat ─────────────────────────────────────────────────────

export const RelayHeartbeatSchema = z.object({
  type: z.literal("relay_heartbeat"),
  daemonId: z.string(),
  status: z.string().optional(),
  meta: DaemonMetaSchema.optional(),
  // Current ready provider ids, re-sent every heartbeat so host login/logout
  // (e.g. `claude login`) propagates to the relay's per-daemon view WITHOUT a
  // reconnect (internal docs #2). daemon_hello sets the initial value; this keeps
  // it live for the life of a long-held connection. Additive + optional: older
  // daemons omit it → the relay keeps the last hello value (unchanged behavior).
  providers: z.array(z.string()).optional(),
});

// ─── Cross-daemon agent forwarding ─────────────────────────────────

export const AgentPromptForwardSchema = z.object({
  type: z.literal("cyborg:agent_prompt_forward"),
  agentId: z.string(),
  workspaceId: z.string(),
  prompt: z.string(),
  fromDaemonId: z.string(),
});

export const PermissionResponseForwardSchema = z.object({
  type: z.literal("cyborg:permission_response_forward"),
  agentId: z.string(),
  workspaceId: z.string(),
  permissionRequestId: z.string(),
  response: z.record(z.unknown()),
  fromDaemonId: z.string(),
});

export const CancelAgentForwardSchema = z.object({
  type: z.literal("cyborg:cancel_agent_forward"),
  agentId: z.string(),
  workspaceId: z.string(),
  fromDaemonId: z.string(),
});

// #591: clear an agent's derived attention flag on the owning daemon. Same
// envelope as the cancel forward (agent-scoped, routed to the owning daemon).
export const ClearAttentionForwardSchema = z.object({
  type: z.literal("cyborg:clear_attention_forward"),
  agentId: z.string(),
  workspaceId: z.string(),
  fromDaemonId: z.string(),
});

// ─── Types ──────────────────────────────────────────────────────────

export type DaemonHello = z.infer<typeof DaemonHelloSchema>;
export type RelayForward = z.infer<typeof RelayForwardSchema>;
export type RelaySyncRequest = z.infer<typeof RelaySyncRequestSchema>;
export type RelaySubscribed = z.infer<typeof RelaySubscribedSchema>;
export type RelayMessage = z.infer<typeof RelayMessageSchema>;
export type RelaySyncResponse = z.infer<typeof RelaySyncResponseSchema>;
export type RelayError = z.infer<typeof RelayErrorSchema>;
export type RelayHeartbeat = z.infer<typeof RelayHeartbeatSchema>;
export type AgentPromptForward = z.infer<typeof AgentPromptForwardSchema>;
export type PermissionResponseForward = z.infer<typeof PermissionResponseForwardSchema>;
export type CancelAgentForward = z.infer<typeof CancelAgentForwardSchema>;
export type ClearAttentionForward = z.infer<typeof ClearAttentionForwardSchema>;

export type CyboReadRequest = z.infer<typeof CyboReadRequestSchema>;
export type CyboReadResponse = z.infer<typeof CyboReadResponseSchema>;
export type CyboWriteRequest = z.infer<typeof CyboWriteRequestSchema>;
export type CyboWriteResponse = z.infer<typeof CyboWriteResponseSchema>;
export type UploadImageRequest = z.infer<typeof UploadImageRequestSchema>;
export type UploadImageResponse = z.infer<typeof UploadImageResponseSchema>;

export type DaemonToRelay =
  | DaemonHello
  | RelayForward
  | RelaySyncRequest
  | RelayHeartbeat
  | CyboReadRequest
  | CyboWriteRequest
  | UploadImageRequest;
export type RelayToDaemon =
  | RelaySubscribed
  | RelayMessage
  | RelaySyncResponse
  | RelayError
  | CyboReadResponse
  | CyboWriteResponse
  | UploadImageResponse;

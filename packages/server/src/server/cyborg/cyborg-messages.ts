import { TerminalStateSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import {
  AUTONOMY_LEVELS,
  BEHAVIOR_MODES,
  LLM_AUTH_MODES,
  PLATFORM_PERMISSIONS,
} from "./cybo-types.js";

// Shared cybo capability field schemas (power-source, behavior, permissions).
const LlmAuthModeSchema = z.enum(LLM_AUTH_MODES);
const BehaviorModeSchema = z.enum(BEHAVIOR_MODES);
// Per-cybo autonomy dial (L0..L5). Nullable so a client can explicitly clear it
// (reset to "fall back from behavior_mode"); optional so it can be omitted.
const AutonomyLevelSchema = z.enum(AUTONOMY_LEVELS);
const MonthlySpendCapSchema = z.number().int().nonnegative().nullable();
const PlatformPermissionsSchema = z.array(z.enum(PLATFORM_PERMISSIONS));

// Agent mode descriptor (mirrors AgentMode in agent-sdk-types). Carries the
// provider's real mode list to the UI so the composer's mode pill reflects the
// actual modes instead of the generic default/bypass fallback.
const AgentModeSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  colorTier: z.string().optional(),
});

// ─── Attachments ─────────────────────────────────────────────────────

export const AttachmentSchema = z.object({
  key: z.string(),
  name: z.string(),
  type: z.string(),
  size: z.number(),
  url: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
  blurhash: z.string().optional(),
  // Media (video/audio) metadata — additive, backward-compatible. Old clients
  // that omit these still .parse() successfully.
  duration: z.number().nonnegative().optional(), // media length in SECONDS (video/audio)
  posterKey: z.string().optional(), // S3 key of a client-generated poster frame (video only)
  poster: z.string().optional(), // poster URL — client may deliver a public-read URL with zero relay change
});

// ─── Unfurls (URL link previews, Tier 2) ──────────────────────────────
// Mirrors the server `Unfurl` interface in cyborg/unfurl.ts. Passthrough so
// added engine fields don't fail validation on older clients.

export const UnfurlMediaSchema = z.object({
  url: z.string(),
  type: z.enum(["image", "video", "gif"]),
  width: z.number().optional(),
  height: z.number().optional(),
  thumbnail: z.string().optional(),
});

export const UnfurlSchema = z
  .object({
    url: z.string(),
    platform: z.enum(["x", "youtube", "vimeo", "github", "generic"]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    imageWidth: z.number().optional(),
    imageHeight: z.number().optional(),
    siteName: z.string().optional(),
    favicon: z.string().optional(),
    type: z.enum(["link", "image", "video"]).optional(),
    author: z
      .object({
        name: z.string().optional(),
        handle: z.string().optional(),
        url: z.string().optional(),
        avatar: z.string().optional(),
      })
      .optional(),
    media: z.array(UnfurlMediaSchema).optional(),
    github: z
      .object({
        kind: z.enum(["repo", "pr", "issue"]),
        state: z.enum(["open", "closed", "merged", "draft"]).optional(),
        number: z.number().optional(),
        stars: z.number().optional(),
        language: z.string().optional(),
        owner: z.string().optional(),
        repo: z.string().optional(),
        comments: z.number().optional(),
      })
      .optional(),
    publishedAt: z.string().optional(),
  })
  .passthrough();

// ─── Message cards (structured rich embeds, e.g. release cards) ───────
// A first-class structured card attached to a message (messages.card jsonb),
// rendered by the client instead of the plain text body. Today the only variant
// is a GitHub release card synthesized by the inbound webhook endpoint. Mirrors
// the server `ReleaseCard` interface in cyborg/webhook-card.ts. Passthrough so
// future card fields don't fail validation on older relays/clients.
export const ReleaseCardSchema = z
  .object({
    kind: z.literal("release"),
    repo: z.string(),
    repoUrl: z.string(),
    tag: z.string(),
    name: z.string().nullable(),
    body: z.string().nullable(),
    url: z.string(),
    prerelease: z.boolean(),
    draft: z.boolean(),
    author: z.object({ login: z.string(), avatarUrl: z.string().nullable() }).nullable(),
    publishedAt: z.string().nullable(),
  })
  .passthrough();

// Generic event card (every non-release GitHub event — PRs, issues, pushes, CI,
// deploys). One shape; `kind` + `accent` (a state key) drive the icon/color.
export const CardFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
  href: z.string().nullable().optional(),
});
export const EventCardSchema = z
  .object({
    kind: z.enum(["pull_request", "issues", "push", "workflow_run", "deployment", "generic"]),
    repo: z.string(),
    repoUrl: z.string(),
    icon: z.string(),
    eventLabel: z.string(),
    accent: z.enum(["open", "merged", "closed", "neutral", "success", "failure", "pending"]),
    badge: z.string().nullable(),
    title: z.string(),
    url: z.string(),
    body: z.string().nullable(),
    fields: z.array(CardFieldSchema),
    author: z.object({ login: z.string(), avatarUrl: z.string().nullable() }).nullable(),
    timestamp: z.string().nullable(),
  })
  .passthrough();

// A signed interactive button on a card (#600). `token` is opaque (the client
// echoes it verbatim); `forActor` is a render hint only — never trusted for authz.
export const SignedCardActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  style: z.enum(["primary", "danger", "default"]).optional(),
  token: z.string(),
  forActor: z.string().optional(),
});

// In-channel tool-approval card (#600). Mirrors ApprovalCard in webhook-card.ts.
export const ApprovalCardSchema = z
  .object({
    kind: z.literal("approval"),
    title: z.string(),
    toolName: z.string(),
    detail: z.string().nullable(),
    agentName: z.string().nullable(),
    actions: z.array(SignedCardActionSchema).optional(),
    resolution: z
      .object({
        state: z.enum(["approved", "denied", "expired"]),
        byUserId: z.string().nullable(),
        byName: z.string().nullable().optional(),
        at: z.number(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

// Union of all card variants, discriminated on `kind` (faster parse + clearer
// errors than a plain union). EventCard's `kind` is an enum of its event types;
// release / approval are literals — all disjoint, so the discriminator resolves
// unambiguously.
export const MessageCardSchema = z.discriminatedUnion("kind", [
  ReleaseCardSchema,
  EventCardSchema,
  ApprovalCardSchema,
]);

// Emitted fire-and-forget after a human message's URLs are unfurled. Scoped to
// the channel (channelId set) or to the DM pair (toId/fromId set). Additive —
// clients that don't handle it ignore the type.
export const CyborgMessageUnfurledSchema = z.object({
  type: z.literal("cyborg:message_unfurled"),
  payload: z.object({
    messageId: z.string(),
    workspaceId: z.string(),
    channelId: z.string().optional(),
    toId: z.string().optional(),
    fromId: z.string().optional(),
    unfurls: z.array(UnfurlSchema),
  }),
});

// ─── Channel Messages ────────────────────────────────────────────────

export const CyborgChannelMessageSchema = z.object({
  type: z.literal("cyborg:channel_message"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  channelId: z.string(),
  text: z.string(),
  mentions: z.array(z.string()).optional(),
  parentId: z.string().optional(),
  attachments: z.array(AttachmentSchema).max(10).optional(),
  // #602 — when true, the text came from a composer prompt TEMPLATE and is
  // expanded SERVER-SIDE on send: {channel}/{user}/{date} are substituted with
  // the final, HTML-escaped context (see prompt-template-expand.ts). Only set by
  // the composer when a template was inserted, so a normal message that happens
  // to contain a literal "{date}" is never rewritten. Optional + backward-
  // compatible (old clients omit it → no expansion).
  expandTemplate: z.boolean().optional(),
});

export const CyborgChannelMessageBroadcastSchema = z.object({
  type: z.literal("cyborg:channel_message_broadcast"),
  payload: z.object({
    id: z.string(),
    workspaceId: z.string(),
    channelId: z.string(),
    fromId: z.string(),
    fromType: z.enum(["human", "agent"]),
    fromName: z.string().optional(),
    text: z.string(),
    mentions: z.array(z.string()).optional(),
    parentId: z.string().nullable().optional(),
    attachments: z.array(AttachmentSchema).nullable().optional(),
    unfurls: z.array(UnfurlSchema).nullable().optional(),
    // Structured rich card (e.g. a GitHub release card from a webhook). Rendered
    // instead of the plain text body; carried through persist + broadcast.
    card: MessageCardSchema.nullable().optional(),
    // Origin marker: "mcp" for messages posted via the MCP write tools,
    // "webhook" for inbound-webhook posts; absent/null for organic messages.
    source: z.string().nullable().optional(),
    // The daemon that produced this message (e.g. a slash AI result), so the
    // profile sheet can show which daemon ran it. Absent for organic messages.
    daemonId: z.string().nullable().optional(),
    seq: z.number(),
    createdAt: z.number(),
  }),
});

// ─── Direct Messages ─────────────────────────────────────────────────

export const CyborgDmSchema = z.object({
  type: z.literal("cyborg:dm"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  toId: z.string(),
  text: z.string(),
  attachments: z.array(AttachmentSchema).max(10).optional(),
});

export const CyborgDmBroadcastSchema = z.object({
  type: z.literal("cyborg:dm_broadcast"),
  payload: z.object({
    id: z.string(),
    workspaceId: z.string(),
    fromId: z.string(),
    fromType: z.enum(["human", "agent"]),
    fromName: z.string().optional(),
    toId: z.string(),
    text: z.string(),
    attachments: z.array(AttachmentSchema).nullable().optional(),
    unfurls: z.array(UnfurlSchema).nullable().optional(),
    seq: z.number(),
    createdAt: z.number(),
  }),
});

// ─── Typing ──────────────────────────────────────────────────────────

export const CyborgTypingSchema = z.object({
  type: z.literal("cyborg:typing"),
  workspaceId: z.string(),
  channelId: z.string(),
  // DM typing: when set, this typing event targets a single peer instead of a
  // channel. The relay scopes the broadcast to sender + peer only.
  toId: z.string().optional(),
  // Thread-typing scope (#11 thread-typing): when set, the sender is composing a
  // reply in this root's thread, so receivers route the indicator to the open
  // thread panel rather than the channel/DM composer.
  parentId: z.string().optional(),
});

export const CyborgTypingBroadcastSchema = z.object({
  type: z.literal("cyborg:typing_broadcast"),
  payload: z.object({
    workspaceId: z.string(),
    channelId: z.string(),
    fromId: z.string(),
    fromName: z.string().optional(),
    // Present for DM typing; lets the client route the indicator to the DM
    // surface and the relay scope delivery to the two participants.
    toId: z.string().optional(),
    // Echoed thread scope (#11 thread-typing) — present when the sender is typing
    // in a thread; the client matches it against the open thread's root id.
    parentId: z.string().optional(),
  }),
});

// ─── Slash-command progress (server → clients) ───────────────────────
// Broadcast so the UI can show a loading state in the channel while an AI slash
// command (/summarize etc.) runs. `phase` is "generating" at inference start and
// "done"/"error" at the end. The actual result arrives separately as a normal
// channel message; this is purely the transient progress signal. (W1 consumes it.)
export const CyborgSlashCommandProgressBroadcastSchema = z.object({
  type: z.literal("cyborg:slash_command_progress"),
  payload: z.object({
    workspaceId: z.string(),
    channelId: z.string(),
    // Command keyword without the leading "/", e.g. "summarize".
    trigger: z.string(),
    phase: z.enum(["generating", "done", "error"]),
    // The originating request, so a client can correlate with its own dispatch.
    requestId: z.string().optional(),
  }),
});
export type CyborgSlashCommandProgressBroadcast = z.infer<
  typeof CyborgSlashCommandProgressBroadcastSchema
>;

// ─── Reactions ───────────────────────────────────────────────────────

export const CyborgReactionSchema = z.object({
  type: z.literal("cyborg:reaction"),
  workspaceId: z.string(),
  messageId: z.string(),
  emoji: z.string(),
});

export const CyborgReactionBroadcastSchema = z.object({
  type: z.literal("cyborg:reaction_broadcast"),
  payload: z.object({
    workspaceId: z.string(),
    messageId: z.string(),
    fromId: z.string(),
    emoji: z.string(),
  }),
});

// ─── History Fetch ───────────────────────────────────────────────────

export const CyborgFetchMessagesRequestSchema = z.object({
  type: z.literal("cyborg:fetch_messages"),
  requestId: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  before: z.string().optional(),
  limit: z.number().optional(),
});

export const CyborgFetchThreadRequestSchema = z.object({
  type: z.literal("cyborg:fetch_thread"),
  requestId: z.string(),
  workspaceId: z.string(),
  parentId: z.string(),
});

export const CyborgMarkReadSchema = z.object({
  type: z.literal("cyborg:mark_read"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  channelId: z.string(),
  lastReadAt: z.number().optional(),
});

// Mark-unread-from-post for a channel (N4): the channel analogue of
// mark_thread_unread. Rewinds the viewer's last_read_at to just BEFORE the
// chosen post (beforeAt = post.created_at ms) so that post and everything after
// it count as unread ("I'll deal with this later").
export const CyborgMarkChannelUnreadSchema = z.object({
  type: z.literal("cyborg:mark_channel_unread"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  channelId: z.string(),
  // Epoch ms (a post's created_at) — integer, so a float can't land as a timestamp.
  beforeAt: z.number().int(),
});

export const CyborgFetchUnreadSchema = z.object({
  type: z.literal("cyborg:fetch_unread"),
  requestId: z.string(),
  workspaceId: z.string(),
});

// Home "This week" aggregate request. Answered by the relay (cloud) or a
// connected daemon (local) — both call PgSync.getWorkspaceHomeStats.
export const CyborgWorkspaceStatsSchema = z.object({
  type: z.literal("cyborg:workspace_stats"),
  requestId: z.string(),
  workspaceId: z.string(),
  // Time window for the scalar tiles + top agents (heatmap is always a year).
  range: z.enum(["today", "week", "month", "year"]).optional(),
});

export const CyborgWorkspaceStatsResponseSchema = z.object({
  type: z.literal("cyborg:workspace_stats_response"),
  payload: z.object({
    requestId: z.string().optional(),
    sessionsThisWeek: z.number(),
    tokensThisWeek: z.number(),
    agentHoursThisWeek: z.number(),
    tasksShippedThisWeek: z.number(),
    dailyActivity: z.array(z.object({ day: z.string(), count: z.number() })),
    topAgents: z.array(
      z.object({
        provider: z.string().nullable(),
        cyboId: z.string().nullable(),
        sessions: z.number(),
        tokens: z.number(),
      }),
    ),
  }),
});

export const CyborgSetNotificationPrefSchema = z.object({
  type: z.literal("cyborg:set_notification_pref"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  scopeId: z.string(),
  preference: z.enum(["all", "mentions_only", "muted"]),
});

export const CyborgFetchNotificationPrefsSchema = z.object({
  type: z.literal("cyborg:fetch_notification_prefs"),
  requestId: z.string(),
  workspaceId: z.string(),
});

// ─── Composer drafts (server-side draft sync, #610) ──────────────
// Upsert the caller's draft for a (workspace, scope). `scope` is the opaque
// conversation key (channel:<id> / dm:<peerId> / thread:<rootId>). `updatedAt`
// (epoch ms) is the client's edit time — the reconcile tiebreaker on the other
// device (newest write wins). Fire-and-forget like set_notification_pref, so
// requestId is optional.
export const CyborgDraftSetSchema = z.object({
  type: z.literal("cyborg:draft_set"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  scope: z.string(),
  text: z.string(),
  // Epoch ms — an integer; reject floats so a bad client can't store a fractional
  // timestamp that skews the newest-wins reconcile.
  updatedAt: z.number().int(),
});

// Clear the caller's draft for a (workspace, scope) — on send or explicit clear.
export const CyborgDraftClearSchema = z.object({
  type: z.literal("cyborg:draft_clear"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  scope: z.string(),
});

// Fetch all of the caller's drafts in a workspace, to seed a fresh device on
// workspace load.
export const CyborgFetchDraftsSchema = z.object({
  type: z.literal("cyborg:fetch_drafts"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgFetchActivitySchema = z.object({
  type: z.literal("cyborg:fetch_activity"),
  requestId: z.string(),
  workspaceId: z.string(),
  before: z.number().optional(),
  unreadOnly: z.boolean().optional(),
  limit: z.number().optional(),
});

export const CyborgSearchSchema = z.object({
  type: z.literal("cyborg:search"),
  requestId: z.string(),
  workspaceId: z.string(),
  query: z.string(),
  limit: z.number().optional(),
});

export const CyborgMarkActivityReadSchema = z.object({
  type: z.literal("cyborg:mark_activity_read"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  eventId: z.string().optional(), // omit to mark all in the workspace read
});

export const CyborgEditMessageSchema = z.object({
  type: z.literal("cyborg:edit_message"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  messageId: z.string(),
  text: z.string(),
});

export const CyborgDeleteMessageSchema = z.object({
  type: z.literal("cyborg:delete_message"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  messageId: z.string(),
});

export const CyborgPinMessageSchema = z.object({
  type: z.literal("cyborg:pin_message"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  channelId: z.string(),
  messageId: z.string(),
  pinned: z.boolean(),
});

export const CyborgPinMessageBroadcastSchema = z.object({
  type: z.literal("cyborg:pin_message_broadcast"),
  payload: z.object({
    workspaceId: z.string(),
    channelId: z.string(),
    messageId: z.string(),
    pinnedAt: z.number().nullable(),
    pinnedBy: z.string().nullable(),
  }),
});

// ─── Saved messages (#609 — personal bookmarks) ─────────────────────────────
// A PRIVATE per-user bookmark list, distinct from channel pins above (which are
// shared). save_message TOGGLES on/off via `saved`; list_saved returns the
// caller's saved messages in a workspace, newest-saved first. The broadcast is
// PER-USER (cross-device sync of MY saves) — only ever sent back to the saver's
// own sockets, never fanned out to the workspace.
export const CyborgSaveMessageSchema = z.object({
  type: z.literal("cyborg:save_message"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  messageId: z.string(),
  saved: z.boolean(),
});

export const CyborgSaveMessageResponseSchema = z.object({
  type: z.literal("cyborg:save_message_response"),
  payload: z.object({
    requestId: z.string().optional(),
    messageId: z.string(),
    saved: z.boolean(),
  }),
});

export const CyborgSaveMessageBroadcastSchema = z.object({
  type: z.literal("cyborg:save_message_broadcast"),
  payload: z.object({
    workspaceId: z.string(),
    messageId: z.string(),
    saved: z.boolean(),
  }),
});

export const CyborgListSavedRequestSchema = z.object({
  type: z.literal("cyborg:list_saved"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
});

export const CyborgListSavedResponseSchema = z.object({
  type: z.literal("cyborg:list_saved_response"),
  payload: z.object({
    requestId: z.string().optional(),
    // Full message rows (mapMessage wire shape), newest-saved first. `z.any()`
    // mirrors CyborgSyncResponseSchema's message array — message-shape evolution
    // is owned elsewhere; this list stays decoupled from it.
    messages: z.array(z.any()),
  }),
});

// ─── Terminal sessions over the cloud relay (#654) ──────────────────────────
// Client → daemon: start/input/resize/kill. Daemon → client: terminal_output /
// terminal_exit (high-frequency stream, coalesced daemon-side). Sessions are
// daemon-scoped (NOT in PG); `daemonId` targets which daemon runs the PTY (the
// relay gates it with the spawn daemon-access check #31) and routes follow-up
// messages to the same daemon. See the PR body for the full message contract.
export const CyborgStartTerminalRequestSchema = z.object({
  type: z.literal("cyborg:start_terminal"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
  cwd: z.string().nullable().optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  // Stable per-mount subscriber id (internal docs GAP-1 fix). The client mints one
  // id per TerminalView mount and reuses it for the matching detach so the daemon
  // can drop EXACTLY this view's attacher on unmount — the per-dispatch emit
  // closure is NOT reference-stable across RPCs, so detach can't match by emit.
  // Additive + optional: old clients omit it (detach falls back to a no-op).
  attachId: z.string().optional(),
});

export const CyborgStartTerminalResponseSchema = z.object({
  type: z.literal("cyborg:start_terminal_response"),
  payload: z.object({
    requestId: z.string().optional(),
    ok: z.boolean(),
    terminalId: z.string().optional(),
    error: z.string().optional(),
  }),
});

export const CyborgTerminalInputSchema = z.object({
  type: z.literal("cyborg:terminal_input"),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
  terminalId: z.string(),
  data: z.string(),
});

export const CyborgTerminalResizeSchema = z.object({
  type: z.literal("cyborg:terminal_resize"),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
  terminalId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

export const CyborgKillTerminalSchema = z.object({
  type: z.literal("cyborg:kill_terminal"),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
  terminalId: z.string(),
});

// Watch an EXISTING daemon-scoped session (internal docs). The daemon registers a
// viewer that owns its own Paseo subscription (terminal.ts subscribe()), which
// re-delivers a fresh screen `snapshot` on EVERY subscribe — that snapshot frame
// (cyborg:terminal_snapshot), NOT a separate ack, is what repaints a returning/
// extra viewer. So there is no `*_response` on the critical path: the client waits
// for the snapshot. Carries the stable per-mount `attachId` so the matching
// unsubscribe drops exactly this view (the per-dispatch emit closure isn't
// reference-stable across RPCs on the cloud/relay path). Daemon-scoped control op
// (explicit daemonId), gated by daemon access; the daemon owner-locks as a 2nd
// gate.
export const CyborgSubscribeTerminalSchema = z.object({
  type: z.literal("cyborg:subscribe_terminal"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
  terminalId: z.string(),
  attachId: z.string().optional(),
});

// Stop watching a LIVE session without killing it (internal docs). The unsubscribe
// counterpart of subscribe_terminal. Drops this view's viewer (and its Paseo
// subscription) so a truly abandoned pty can be idle-reaped once it exits; the pty
// KEEPS RUNNING (unsubscribe is NOT kill). Matched by attachId (the per-dispatch
// emit closure isn't reference-stable across RPCs). Daemon-scoped, daemon-access
// gated, owner-locked on the daemon. Fire-and-forget.
export const CyborgUnsubscribeTerminalSchema = z.object({
  type: z.literal("cyborg:unsubscribe_terminal"),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
  terminalId: z.string(),
  attachId: z.string().optional(),
});

export const CyborgAttachTerminalResponseSchema = z.object({
  type: z.literal("cyborg:attach_terminal_response"),
  payload: z.object({
    requestId: z.string().optional(),
    ok: z.boolean(),
    terminalId: z.string().optional(),
    error: z.string().optional(),
    // Additive (#750, internal docs): true → live re-attach (pty alive, keep
    // typing); false → post-restart HISTORY (pty died with a prior daemon, this is
    // a read-only final scrollback). Absent → old daemon / live (treat as live for
    // backward-compat). Old clients ignore unknown fields.
    live: z.boolean().optional(),
    // Why a non-live session ended — present only with live === false.
    endedReason: z.enum(["shell_exit", "daemon_restart"]).optional(),
  }),
});

// Explicitly forget a persisted dead terminal (#750, internal docs): a user
// dismissing a history row deletes its on-disk sidecar + scrollback log so it
// stops surfacing. Daemon-scoped control op (carries an explicit daemonId), gated
// by daemon access; the daemon owner-locks against the persisted owner.
export const CyborgForgetTerminalSchema = z.object({
  type: z.literal("cyborg:forget_terminal"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
  terminalId: z.string(),
});

export const CyborgForgetTerminalResponseSchema = z.object({
  type: z.literal("cyborg:forget_terminal_response"),
  payload: z.object({
    requestId: z.string().optional(),
    terminalId: z.string(),
    ok: z.boolean(),
  }),
});

// ─── Terminal DIRECTORY (workspace-scoped session list) ─────────────────────
// Out-of-band terminals (created via the CLI `cyborg:start_terminal`, or by
// another of this user's clients) are tracked in the daemon's controller but were
// invisible to a UI that only renders the terminals IT itself opened (client-side
// localStorage list). This list/feed surfaces the daemon's ACTUAL tracked sessions
// for a workspace so any client can render + manage them. Owner-scoped: a terminal
// is private to whoever opened it, so the daemon returns only the caller's own
// sessions and scopes the change feed by `toUserId`.

// One directory entry — the minimal pointer a sidebar row needs (terminalId +
// daemon + cwd-derived title). `live` distinguishes a running pty from a
// post-restart history record (#750).
export const CyborgTerminalDirEntrySchema = z.object({
  terminalId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  title: z.string().optional(),
  startedAt: z.number().optional(),
  live: z.boolean(),
});

// Client → daemon: pull the caller's tracked sessions for a workspace. Daemon-
// scoped (carries an explicit daemonId on the cloud/relay path so it reaches the
// owning daemon); gated by daemon access, owner-scoped in the controller.
export const CyborgListTerminalsRequestSchema = z.object({
  type: z.literal("cyborg:list_terminals"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgListTerminalsResponseSchema = z.object({
  type: z.literal("cyborg:list_terminals_response"),
  payload: z.object({
    requestId: z.string().optional(),
    workspaceId: z.string(),
    terminals: z.array(CyborgTerminalDirEntrySchema),
  }),
});

// Daemon → client PUSH: the workspace's terminal directory changed (a session
// started or exited). `toUserId` scopes delivery to the owner — the relay filters
// on it exactly like the output/exit/snapshot stream. Carries the full snapshot
// for the workspace so a client replaces its cached directory wholesale.
export const CyborgTerminalsChangedSchema = z.object({
  type: z.literal("cyborg:terminals_changed"),
  payload: z.object({
    workspaceId: z.string(),
    terminals: z.array(CyborgTerminalDirEntrySchema),
    toUserId: z.string().optional(),
  }),
});

// Daemon → client stream. `toUserId` scopes delivery to the terminal's owner
// (a terminal is private to whoever opened it); the relay filters on it.
export const CyborgTerminalOutputSchema = z.object({
  type: z.literal("cyborg:terminal_output"),
  payload: z.object({
    terminalId: z.string(),
    data: z.string(),
    toUserId: z.string().optional(),
    // Set ONLY on a re-attach history-replay frame (internal docs #5): the pty
    // cols/rows the replayed scrollback bytes were CAPTURED at. Those bytes encode
    // that width's wrap + cursor layout, so a client whose terminal is now a
    // DIFFERENT width (e.g. opened a mobile session on desktop, #48) must reproduce
    // them at this width FIRST, then resize to let the emulator reflow — writing
    // old-width bytes straight into a wider grid desyncs cursor positioning and
    // garbles the buffer. Absent on live output and fresh starts. Additive +
    // backward-compatible: a client that ignores them gets today's behavior. The
    // fields MUST be in the schema or the relay's Zod parse strips them off the wire.
    replayCols: z.number().int().positive().optional(),
    replayRows: z.number().int().positive().optional(),
  }),
});

export const CyborgTerminalExitSchema = z.object({
  type: z.literal("cyborg:terminal_exit"),
  payload: z.object({
    terminalId: z.string(),
    code: z.number().nullable(),
    toUserId: z.string().optional(),
  }),
});

// Daemon → client SCREEN SNAPSHOT (internal docs Phase 0). Paseo's terminal engine
// re-delivers a full `{type:"snapshot", state, revision}` on EVERY subscribe()
// (terminal.ts:998) — the self-heal payload that lets a returning/extra viewer
// repaint the whole screen without replaying a scrollback byte buffer. The cyborg
// controller now CONSUMES that snapshot (previously dropped) and forwards it here.
// `state` is Paseo's `TerminalState` (cells + cursor + scrollback) — plain JSON
// (z.infer of TerminalStateSchema: numbers/strings/booleans/arrays only, NO
// Buffers/typed-arrays), so it survives the daemon→relay→client JSON hop intact.
// Owner-scoped like output/exit via `toUserId`. Additive + backward-compatible:
// clients that don't yet handle it simply ignore it (Phase 0 ships dark).
export const CyborgTerminalSnapshotSchema = z.object({
  type: z.literal("cyborg:terminal_snapshot"),
  payload: z.object({
    terminalId: z.string(),
    state: TerminalStateSchema,
    // Monotonic state revision from Paseo (terminal.ts stateRevision). Lets a
    // future client discard a stale snapshot that races a newer one. Optional —
    // Paseo may omit it in "ready" mode.
    revision: z.number().optional(),
    // Set on the FIRST snapshot of a re-attach where the daemon already replayed the
    // full scrollback ring as a cyborg:terminal_output history frame (internal docs
    // #5). The byte replay reproduced the authoritative terminal state (scrollback +
    // screen + cursor + alt-screen mode), so the client treats this snapshot as
    // confirmatory and SKIPS its term.reset()+repaint — resetting would clobber the
    // just-rebuilt scrollback. Absent/false on a fresh start or a snapshot with no
    // preceding replay, where the client repaints from the snapshot as before.
    historyReplayed: z.boolean().optional(),
    toUserId: z.string().optional(),
  }),
});

// Signed interactive action (#600). The client returns the opaque `token` from a
// card button verbatim; the server verifies signature + actor + expiry before
// executing. Dual-routed: handled in BOTH dispatcher.ts and relay-standalone.ts.
export const CyborgMessageActionSchema = z.object({
  type: z.literal("cyborg:message_action"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  messageId: z.string(),
  actionId: z.string(),
  token: z.string(),
});

export const CyborgMessageActionResponseSchema = z.object({
  type: z.literal("cyborg:message_action_response"),
  payload: z.object({
    requestId: z.string().optional(),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
});

// Broadcast after an action resolves a card → clients re-render the settled
// state (resolution set, buttons cleared). Channel-scoped like the message.
export const CyborgMessageCardUpdatedSchema = z.object({
  type: z.literal("cyborg:message_card_updated"),
  payload: z.object({
    workspaceId: z.string(),
    channelId: z.string().nullable(),
    messageId: z.string(),
    card: MessageCardSchema.nullable(),
  }),
});

export const CyborgFetchMessagesResponseSchema = z.object({
  type: z.literal("cyborg:fetch_messages_response"),
  payload: z.object({
    requestId: z.string(),
    messages: z.array(
      z.object({
        id: z.string(),
        channelId: z.string().nullable(),
        fromId: z.string(),
        fromType: z.enum(["human", "agent"]),
        fromName: z.string().optional(),
        toId: z.string().nullable().optional(),
        text: z.string(),
        mentions: z.array(z.string()).nullable().optional(),
        parentId: z.string().nullable().optional(),
        unfurls: z.array(UnfurlSchema).nullable().optional(),
        card: MessageCardSchema.nullable().optional(),
        source: z.string().nullable().optional(),
        seq: z.number(),
        createdAt: z.number(),
      }),
    ),
    hasMore: z.boolean(),
  }),
});

// ─── Sync (reconnection) ────────────────────────────────────────────

export const CyborgSyncRequestSchema = z.object({
  type: z.literal("cyborg:sync"),
  requestId: z.string(),
  workspaceId: z.string(),
  lastSeq: z.number(),
});

export const CyborgSyncResponseSchema = z.object({
  type: z.literal("cyborg:sync_response"),
  payload: z.object({
    requestId: z.string(),
    mode: z.enum(["delta", "snapshot"]),
    messages: z.array(z.any()),
    agents: z
      .array(
        z.object({
          agentId: z.string(),
          status: z.string(),
        }),
      )
      .optional(),
  }),
});

// ─── Channels ────────────────────────────────────────────────────────

export const CyborgCreateChannelRequestSchema = z.object({
  type: z.literal("cyborg:create_channel"),
  requestId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  isPrivate: z.boolean().optional(),
  instructions: z.string().optional(),
});

export const CyborgCreateChannelResponseSchema = z.object({
  type: z.literal("cyborg:create_channel_response"),
  payload: z.object({
    requestId: z.string(),
    channel: z.object({
      id: z.string(),
      workspaceId: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      isPrivate: z.boolean(),
      instructions: z.string().nullable(),
      createdBy: z.string(),
      createdAt: z.number(),
    }),
  }),
});

// #608 — Group DMs. A group DM is created via its OWN message (never
// create_channel with type:'group_dm', which the relay/dispatcher reject), with
// the participant user-ids (the OTHER members; the creator is implicit). 2–8
// others. The server derives the name (members' display names, sorted) and
// returns the resulting hidden group_dm channel.
export const CyborgCreateGroupDmRequestSchema = z.object({
  type: z.literal("cyborg:create_group_dm"),
  requestId: z.string(),
  workspaceId: z.string(),
  participants: z.array(z.string()).min(1).max(8),
});

export const CyborgCreateGroupDmResponseSchema = z.object({
  type: z.literal("cyborg:create_group_dm_response"),
  payload: z.object({
    requestId: z.string(),
    channel: z.object({
      id: z.string(),
      workspaceId: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      isPrivate: z.boolean().optional(),
      instructions: z.string().nullable().optional(),
      createdBy: z.string().optional(),
      createdAt: z.number().optional(),
      type: z.string(),
      isHidden: z.boolean(),
    }),
  }),
});

export const CyborgFetchChannelsRequestSchema = z.object({
  type: z.literal("cyborg:fetch_channels"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgFetchChannelsResponseSchema = z.object({
  type: z.literal("cyborg:fetch_channels_response"),
  payload: z.object({
    requestId: z.string(),
    channels: z.array(
      z.object({
        id: z.string(),
        workspaceId: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        isPrivate: z.boolean(),
        instructions: z.string().nullable(),
        createdBy: z.string(),
        createdAt: z.number(),
        // #608: channel kind + browser visibility. Optional/backward-compatible
        // — older daemons omit them → a regular, visible channel.
        type: z.string().optional(),
        isHidden: z.boolean().optional(),
      }),
    ),
  }),
});

// ─── Workspaces ──────────────────────────────────────────────────────

export const CyborgCreateWorkspaceRequestSchema = z.object({
  type: z.literal("cyborg:create_workspace"),
  requestId: z.string(),
  name: z.string(),
  settings: z
    .object({
      defaultAgentModel: z.string().optional(),
      maxAgents: z.number().optional(),
      allowMemberAgentCreation: z.boolean().optional(),
      agentPermissionMode: z.enum(["ask", "auto"]).optional(),
    })
    .optional(),
});

export const CyborgCreateWorkspaceResponseSchema = z.object({
  type: z.literal("cyborg:create_workspace_response"),
  payload: z.object({
    requestId: z.string(),
    workspace: z.object({
      id: z.string(),
      name: z.string(),
      ownerId: z.string(),
      settings: z.any(),
      createdAt: z.number(),
    }),
  }),
});

export const CyborgFetchWorkspacesRequestSchema = z.object({
  type: z.literal("cyborg:fetch_workspaces"),
  requestId: z.string(),
});

export const CyborgFetchWorkspacesResponseSchema = z.object({
  type: z.literal("cyborg:fetch_workspaces_response"),
  payload: z.object({
    requestId: z.string(),
    workspaces: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        ownerId: z.string(),
        role: z.enum(["owner", "admin", "member", "viewer"]),
        settings: z.any(),
        createdAt: z.number(),
      }),
    ),
  }),
});

export const CyborgWorkspaceSettingsSchema = z
  .object({
    defaultAgentModel: z.string().optional(),
    maxAgents: z.number().optional(),
    allowMemberAgentCreation: z.boolean().optional(),
    agentPermissionMode: z.enum(["ask", "auto"]).optional(),
    agentWorkspaceContext: z.string().optional(),
    publicChannelCreatePolicy: z.enum(["everyone", "admins", "owner"]).optional(),
    privateChannelCreatePolicy: z.enum(["everyone", "admins", "owner"]).optional(),
  })
  .passthrough();

export const CyborgUpdateWorkspaceRequestSchema = z.object({
  type: z.literal("cyborg:update_workspace"),
  requestId: z.string(),
  workspaceId: z.string(),
  name: z.string().optional(),
  avatarUrl: z.string().nullable().optional(),
  settings: CyborgWorkspaceSettingsSchema.optional(),
});

export const CyborgUpdateWorkspaceResponseSchema = z.object({
  type: z.literal("cyborg:update_workspace_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
  }),
});

export const CyborgDeleteWorkspaceRequestSchema = z.object({
  type: z.literal("cyborg:delete_workspace"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgDeleteWorkspaceResponseSchema = z.object({
  type: z.literal("cyborg:delete_workspace_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
  }),
});

// ─── Account deletion (App-Store Guideline 5.1.1(v)) ─────────────────
// Auth REQUIRED. Permanently deletes ONLY the authenticated user's own
// account — no workspaceId/userId in the request, the relay always acts on
// guest.userId so a caller can never delete someone else. No request body
// beyond the type/requestId.
export const CyborgDeleteAccountRequestSchema = z.object({
  type: z.literal("cyborg:delete_account"),
  requestId: z.string(),
});

export const CyborgDeleteAccountResponseSchema = z.object({
  type: z.literal("cyborg:delete_account_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
  }),
});

// ─── Members ─────────────────────────────────────────────────────────

export const CyborgInviteMemberRequestSchema = z.object({
  type: z.literal("cyborg:invite_member"),
  requestId: z.string(),
  workspaceId: z.string(),
  email: z.string(),
  role: z.enum(["admin", "member", "viewer"]).optional(),
});

export const CyborgInviteMemberResponseSchema = z.object({
  type: z.literal("cyborg:invite_member_response"),
  payload: z.object({
    requestId: z.string(),
    membership: z.object({
      workspaceId: z.string(),
      userId: z.string(),
      role: z.string(),
      joinedAt: z.number(),
    }),
    // Full invite flow: the persisted invitation's token id and its shareable
    // landing URL (`${BASE}/invite/${token}`), returned ALONGSIDE the membership.
    invitationId: z.string(),
    inviteUrl: z.string(),
  }),
});

// ─── Invitations (full invite flow) ──────────────────────────────────

export const CyborgResendInvitationRequestSchema = z.object({
  type: z.literal("cyborg:resend_invitation"),
  requestId: z.string(),
  workspaceId: z.string(),
  invitationId: z.string(),
});

export const CyborgResendInvitationResponseSchema = z.object({
  type: z.literal("cyborg:resend_invitation_response"),
  payload: z.object({
    requestId: z.string(),
    invitationId: z.string(),
    sentAt: z.number(),
  }),
});

export const CyborgAcceptInvitationRequestSchema = z.object({
  type: z.literal("cyborg:accept_invitation"),
  requestId: z.string(),
  invitationToken: z.string(),
});

export const CyborgAcceptInvitationResponseSchema = z.object({
  type: z.literal("cyborg:accept_invitation_response"),
  payload: z.object({
    requestId: z.string(),
    membership: z.object({
      workspaceId: z.string(),
      userId: z.string(),
      role: z.string(),
      joinedAt: z.number(),
    }),
    workspaceId: z.string(),
  }),
});

export const CyborgListPendingInvitationsRequestSchema = z.object({
  type: z.literal("cyborg:list_pending_invitations"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgListPendingInvitationsResponseSchema = z.object({
  type: z.literal("cyborg:list_pending_invitations_response"),
  payload: z.object({
    requestId: z.string(),
    invitations: z.array(
      z.object({
        id: z.string(),
        email: z.string(),
        role: z.string(),
        createdAt: z.number(),
        expiresAt: z.number(),
        createdByName: z.string().optional(),
      }),
    ),
  }),
});

export const CyborgCancelInvitationRequestSchema = z.object({
  type: z.literal("cyborg:cancel_invitation"),
  requestId: z.string(),
  workspaceId: z.string(),
  invitationId: z.string(),
});

export const CyborgCancelInvitationResponseSchema = z.object({
  type: z.literal("cyborg:cancel_invitation_response"),
  payload: z.object({
    requestId: z.string(),
    invitationId: z.string(),
  }),
});

export const CyborgRemoveMemberRequestSchema = z.object({
  type: z.literal("cyborg:remove_member"),
  requestId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
});

export const CyborgRemoveMemberResponseSchema = z.object({
  type: z.literal("cyborg:remove_member_response"),
  payload: z.object({
    requestId: z.string(),
    removed: z.boolean(),
  }),
});

export const CyborgUpdateRoleRequestSchema = z.object({
  type: z.literal("cyborg:update_role"),
  requestId: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  role: z.enum(["admin", "member", "viewer"]),
});

export const CyborgUpdateRoleResponseSchema = z.object({
  type: z.literal("cyborg:update_role_response"),
  payload: z.object({
    requestId: z.string(),
    updated: z.boolean(),
  }),
});

// ─── Tasks ───────────────────────────────────────────────────────────

export const CyborgCreateTaskRequestSchema = z.object({
  type: z.literal("cyborg:create_task"),
  requestId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  dueAt: z.number().optional(),
  // Tasks Phase 2 (watcher) — optional channel binding (where execute-dispatch
  // posts results) + board priority. Optional so existing clients still validate.
  channelId: z.string().optional(),
  priority: z.string().optional(),
  // Tasks Redesign — Plane-style task fields. ALL optional + additive so an old
  // caller (title/description only) still validates. The dispatcher/relay resolves
  // these against the project's catalog: projectId picks the Tasks-project (else
  // the channel's project, else the workspace Inbox); parentId makes this a
  // sub-task; stateId picks the workflow state (else the project default);
  // startDate is planned start (epoch ms); labels are label NAMES auto-created in
  // the project's label catalog (NOT ids); cycleId is the single sprint bucket;
  // moduleIds are the modules this task belongs to.
  projectId: z.string().optional(),
  parentId: z.string().nullable().optional(),
  stateId: z.string().optional(),
  startDate: z.number().nullable().optional(),
  labels: z.array(z.string()).optional(),
  cycleId: z.string().nullable().optional(),
  moduleIds: z.array(z.string()).optional(),
});

export const CyborgCreateTaskResponseSchema = z.object({
  type: z.literal("cyborg:create_task_response"),
  payload: z.object({
    requestId: z.string(),
    task: z
      .object({
        id: z.string(),
        workspaceId: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        status: z.string(),
        assigneeId: z.string().nullable(),
        createdBy: z.string(),
        dueAt: z.number().nullable(),
        createdAt: z.number(),
        updatedAt: z.number(),
        // Tasks Redesign readback — the relay `mapTask` denormalizes these from
        // the row + join tables. Optional so an old relay (no Plane columns) still
        // validates. `.passthrough()` keeps any extra mapTask columns (sort_order,
        // start_date, …) intact.
        priority: z.string().nullable().optional(),
        project_id: z.string().nullable().optional(),
        parent_id: z.string().nullable().optional(),
        state_id: z.string().nullable().optional(),
        sequence_id: z.number().nullable().optional(),
        cycle_id: z.string().nullable().optional(),
        label_ids: z.array(z.string()).optional(),
        module_ids: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
});

export const CyborgUpdateTaskRequestSchema = z.object({
  type: z.literal("cyborg:update_task"),
  requestId: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
  status: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  assigneeId: z.string().nullable().optional(),
  result: z.string().optional(),
  // Due date on update (epoch ms). Nullable so the detail card can clear it.
  // Optional so existing clients still validate; without this Zod strips dueAt
  // before any handler sees it, so a due-date edit silently never persists.
  dueAt: z.number().nullable().optional(),
  // Tasks Phase 2 (watcher) — optional channel binding + board priority on update.
  // Optional so existing clients still validate.
  channelId: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  // Tasks Redesign — Plane-style task fields on update. ALL optional + additive.
  // Pass null to clear a scalar (parentId/startDate/cycleId/stateId/projectId); an
  // empty `labels`/`moduleIds` array clears all of that set. `labels` are label
  // NAMES (auto-created in the project's catalog), resolved to ids by the handler.
  projectId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  stateId: z.string().nullable().optional(),
  startDate: z.number().nullable().optional(),
  labels: z.array(z.string()).optional(),
  cycleId: z.string().nullable().optional(),
  moduleIds: z.array(z.string()).optional(),
});

export const CyborgUpdateTaskResponseSchema = z.object({
  type: z.literal("cyborg:update_task_response"),
  payload: z.object({
    requestId: z.string(),
    task: z
      .object({
        id: z.string(),
        workspaceId: z.string(),
        title: z.string(),
        description: z.string().nullable(),
        status: z.string(),
        assigneeId: z.string().nullable(),
        createdBy: z.string(),
        dueAt: z.number().nullable(),
        result: z.string().nullable(),
        createdAt: z.number(),
        updatedAt: z.number(),
        // Tasks Redesign readback (see create_task_response). Optional + passthrough
        // so an old relay still validates and any extra mapTask columns survive.
        priority: z.string().nullable().optional(),
        project_id: z.string().nullable().optional(),
        parent_id: z.string().nullable().optional(),
        state_id: z.string().nullable().optional(),
        sequence_id: z.number().nullable().optional(),
        cycle_id: z.string().nullable().optional(),
        label_ids: z.array(z.string()).optional(),
        module_ids: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
});

export const CyborgFetchTasksRequestSchema = z.object({
  type: z.literal("cyborg:fetch_tasks"),
  requestId: z.string(),
  workspaceId: z.string(),
  status: z.string().optional(),
  assigneeId: z.string().optional(),
  // Tasks Phase 0 (Plane plane UI) — opaque cursor pagination. `limit` caps the
  // page size; `cursor` is the opaque token from a prior response's nextCursor.
  // Both optional so existing clients (no pagination) keep the full-list behavior.
  limit: z.number().optional(),
  cursor: z.string().optional(),
  // Tasks Redesign — Plane-style scoping filters. ALL optional + additive; an
  // omitted filter is not applied, so existing full-workspace fetches are
  // unchanged. parentId scopes to a parent's sub-tasks; the rest scope to a
  // project / workflow state / cycle / module.
  projectId: z.string().optional(),
  parentId: z.string().optional(),
  stateId: z.string().optional(),
  cycleId: z.string().optional(),
  moduleId: z.string().optional(),
});

export const CyborgFetchTasksResponseSchema = z.object({
  type: z.literal("cyborg:fetch_tasks_response"),
  payload: z.object({
    requestId: z.string(),
    tasks: z.array(z.any()),
    // Tasks Phase 0 — opaque cursor for the next page, or null when the page is
    // the last one. Optional for back-compat with clients that ignore it.
    nextCursor: z.string().nullable().optional(),
  }),
});

// ─── Tasks Phase 0 (Plane plane UI) — reorder / bulk / delete / archive ───────

// Drag-reorder a task within (workspace, status) lane. The client names the
// neighbours it was dropped between; the server computes a sortOrder between them
// (fractional or compact-renumber). At least one of beforeId/afterId is set unless
// the lane was empty.
export const CyborgReorderTaskRequestSchema = z.object({
  type: z.literal("cyborg:reorder_task"),
  requestId: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
  // The task this one now sits AFTER (its upper neighbour) / BEFORE (lower
  // neighbour). Either, both, or neither (lane edges).
  beforeId: z.string().optional(),
  afterId: z.string().optional(),
});

export const CyborgReorderTaskResponseSchema = z.object({
  type: z.literal("cyborg:reorder_task_response"),
  payload: z.object({
    requestId: z.string(),
    task: z.any(),
  }),
});

// Bulk-edit a selection of tasks in one pass (status/priority/assignee/due/archive).
// Every field optional; only the present ones are applied to every task.
export const CyborgBulkUpdateTasksRequestSchema = z.object({
  type: z.literal("cyborg:bulk_update_tasks"),
  requestId: z.string(),
  workspaceId: z.string(),
  taskIds: z.array(z.string()),
  updates: z.object({
    status: z.string().optional(),
    priority: z.string().nullable().optional(),
    assigneeId: z.string().nullable().optional(),
    dueAt: z.number().nullable().optional(),
    archivedAt: z.number().nullable().optional(),
  }),
});

export const CyborgBulkUpdateTasksResponseSchema = z.object({
  type: z.literal("cyborg:bulk_update_tasks_response"),
  payload: z.object({
    requestId: z.string(),
    tasks: z.array(z.any()),
  }),
});

// Hard-delete a task (irreversible). Distinct from archive (soft hide).
export const CyborgDeleteTaskRequestSchema = z.object({
  type: z.literal("cyborg:delete_task"),
  requestId: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
});

export const CyborgDeleteTaskResponseSchema = z.object({
  type: z.literal("cyborg:delete_task_response"),
  payload: z.object({
    requestId: z.string(),
    taskId: z.string(),
    deleted: z.boolean(),
  }),
});

// Soft-archive / un-archive a task (sets/clears archivedAt). Hides it from default
// views without deleting the row.
export const CyborgArchiveTaskRequestSchema = z.object({
  type: z.literal("cyborg:archive_task"),
  requestId: z.string(),
  workspaceId: z.string(),
  taskId: z.string(),
  archived: z.boolean(),
});

export const CyborgArchiveTaskResponseSchema = z.object({
  type: z.literal("cyborg:archive_task_response"),
  payload: z.object({
    requestId: z.string(),
    task: z.any(),
  }),
});

// List the workspace's Tasks-projects (the CLI / UI project picker source). Carries
// only the workspaceId; the relay scopes the result to the projects the caller may
// see (Inbox + channel-tagged projects they're a member of + everything for owner/
// admin). `id` is the tasks_projects.id ("tp_…"); both it and `chatProjectId` (null
// for the synthetic Inbox) resolve back through create_task / fetch_tasks. `name` is
// the linked chat project's name, or "Inbox" for the synthetic project.
export const CyborgFetchTasksProjectsRequestSchema = z.object({
  type: z.literal("cyborg:fetch_tasks_projects"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgFetchTasksProjectsResponseSchema = z.object({
  type: z.literal("cyborg:fetch_tasks_projects_response"),
  payload: z.object({
    requestId: z.string(),
    projects: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        name: z.string(),
        color: z.string().nullable(),
        isInbox: z.boolean(),
        chatProjectId: z.string().nullable(),
      }),
    ),
  }),
});

// ─── Tasks Redesign catalog reads (board/detail) ─────────────────────────────
// Five read-only catalog fetches that back the board columns / detail pickers /
// activity feed. Each carries the CHAT projectId (the id the UI routes on, from
// cyborg:fetch_projects) — NOT a workspaceId — so the relay/dispatcher resolve it
// to the tasks_projects.id and gate visibility on the project, not workspace
// membership. The response payloads mirror the client's camelCase shapes in
// packages/ui/src/lib/core/types.ts (TaskState/TaskLabel/Cycle/Module/
// TaskActivity); timestamp columns ride the wire as epoch ms numbers (or null).

// A project's workflow states (board columns), ordered by `sequence` server-side.
export const CyborgFetchProjectStatesRequestSchema = z.object({
  type: z.literal("cyborg:fetch_project_states"),
  requestId: z.string(),
  projectId: z.string(),
});

export const CyborgFetchProjectStatesResponseSchema = z.object({
  type: z.literal("cyborg:fetch_project_states_response"),
  payload: z.object({
    requestId: z.string(),
    states: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        workspaceId: z.string(),
        name: z.string(),
        color: z.string(),
        group: z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]),
        sequence: z.number(),
        isDefault: z.boolean(),
      }),
    ),
  }),
});

// A project's label catalog (tags), ordered by `sortOrder` server-side.
export const CyborgFetchProjectLabelsRequestSchema = z.object({
  type: z.literal("cyborg:fetch_project_labels"),
  requestId: z.string(),
  projectId: z.string(),
});

export const CyborgFetchProjectLabelsResponseSchema = z.object({
  type: z.literal("cyborg:fetch_project_labels_response"),
  payload: z.object({
    requestId: z.string(),
    labels: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        workspaceId: z.string(),
        name: z.string(),
        color: z.string(),
        sortOrder: z.number(),
      }),
    ),
  }),
});

// A project's cycles (sprints). Dates are epoch ms (null when unset).
export const CyborgFetchCyclesRequestSchema = z.object({
  type: z.literal("cyborg:fetch_cycles"),
  requestId: z.string(),
  projectId: z.string(),
});

export const CyborgFetchCyclesResponseSchema = z.object({
  type: z.literal("cyborg:fetch_cycles_response"),
  payload: z.object({
    requestId: z.string(),
    cycles: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        workspaceId: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        startDate: z.number().nullable(),
        endDate: z.number().nullable(),
        ownedBy: z.string().nullable(),
        sortOrder: z.number().nullable(),
        archivedAt: z.number().nullable(),
        createdAt: z.number(),
      }),
    ),
  }),
});

// A project's modules (feature groupings). Dates are epoch ms (null when unset).
export const CyborgFetchModulesRequestSchema = z.object({
  type: z.literal("cyborg:fetch_modules"),
  requestId: z.string(),
  projectId: z.string(),
});

export const CyborgFetchModulesResponseSchema = z.object({
  type: z.literal("cyborg:fetch_modules_response"),
  payload: z.object({
    requestId: z.string(),
    modules: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        workspaceId: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        startDate: z.number().nullable(),
        targetDate: z.number().nullable(),
        status: z.string(),
        lead: z.string().nullable(),
        sortOrder: z.number().nullable(),
        archivedAt: z.number().nullable(),
      }),
    ),
  }),
});

// ─── Cycles catalog CRUD ────────────────────────────────────────────────────
// `projectId` is the CHAT project id (the relay resolves it to tasks_projects).
// The response carries the created/updated row in the same shape fetch_cycles uses.
const CycleObjectSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  startDate: z.number().nullable(),
  endDate: z.number().nullable(),
  ownedBy: z.string().nullable(),
  sortOrder: z.number().nullable(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
});

export const CyborgCreateCycleRequestSchema = z.object({
  type: z.literal("cyborg:create_cycle"),
  requestId: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  startDate: z.number().nullable().optional(),
  endDate: z.number().nullable().optional(),
});

export const CyborgCreateCycleResponseSchema = z.object({
  type: z.literal("cyborg:create_cycle_response"),
  payload: z.object({
    requestId: z.string(),
    cycle: CycleObjectSchema,
  }),
});

export const CyborgUpdateCycleRequestSchema = z.object({
  type: z.literal("cyborg:update_cycle"),
  requestId: z.string(),
  cycleId: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  startDate: z.number().nullable().optional(),
  endDate: z.number().nullable().optional(),
});

export const CyborgUpdateCycleResponseSchema = z.object({
  type: z.literal("cyborg:update_cycle_response"),
  payload: z.object({
    requestId: z.string(),
    cycle: CycleObjectSchema,
  }),
});

export const CyborgDeleteCycleRequestSchema = z.object({
  type: z.literal("cyborg:delete_cycle"),
  requestId: z.string(),
  cycleId: z.string(),
});

export const CyborgDeleteCycleResponseSchema = z.object({
  type: z.literal("cyborg:delete_cycle_response"),
  payload: z.object({
    requestId: z.string(),
    deleted: z.boolean(),
  }),
});

// ─── Project pages catalog CRUD ─────────────────────────────────────────────
// A project's pages (wiki/docs). `content` is serialized editor JSON (TipTap),
// "" = a blank page. `projectId` is the CHAT project id (the relay resolves it to
// tasks_projects). Timestamps are epoch ms; archivedAt null = not archived.
const PageObjectSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  content: z.string(),
  visibility: z.enum(["private", "public"]),
  // Optional page icon: a single emoji glyph (Plane's page logo). Null = none.
  icon: z.string().nullable(),
  // Self-referential parent for nesting; null = a root page.
  parentId: z.string().nullable(),
  // Sibling ordering within a parent (lower first).
  sortOrder: z.number(),
  ownedBy: z.string().nullable(),
  archivedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// A project's pages. Returns ALL pages (the UI filters archived itself).
export const CyborgFetchPagesRequestSchema = z.object({
  type: z.literal("cyborg:fetch_pages"),
  requestId: z.string(),
  projectId: z.string(),
});

export const CyborgFetchPagesResponseSchema = z.object({
  type: z.literal("cyborg:fetch_pages_response"),
  payload: z.object({
    requestId: z.string(),
    pages: z.array(PageObjectSchema),
  }),
});

export const CyborgFetchPageRequestSchema = z.object({
  type: z.literal("cyborg:fetch_page"),
  requestId: z.string(),
  pageId: z.string(),
});

export const CyborgFetchPageResponseSchema = z.object({
  type: z.literal("cyborg:fetch_page_response"),
  payload: z.object({
    requestId: z.string(),
    // null when the page is missing / not visible.
    page: PageObjectSchema.nullable(),
  }),
});

export const CyborgCreatePageRequestSchema = z.object({
  type: z.literal("cyborg:create_page"),
  requestId: z.string(),
  projectId: z.string(),
  title: z.string().optional(),
  // Nest the new page under this parent (same project). Absent/null = a root page.
  parentId: z.string().nullable().optional(),
});

export const CyborgCreatePageResponseSchema = z.object({
  type: z.literal("cyborg:create_page_response"),
  payload: z.object({
    requestId: z.string(),
    page: PageObjectSchema,
  }),
});

export const CyborgUpdatePageRequestSchema = z.object({
  type: z.literal("cyborg:update_page"),
  requestId: z.string(),
  pageId: z.string(),
  title: z.string().optional(),
  content: z.string().optional(),
  visibility: z.enum(["private", "public"]).optional(),
  // Set a single emoji glyph, or null to clear the icon. Absent = leave as-is.
  icon: z.string().nullable().optional(),
  // Re-parent the page (same project); null = move to root. Absent = leave as-is.
  // A cycle (parent === self or a descendant) is rejected server-side.
  parentId: z.string().nullable().optional(),
  // Reorder among siblings (lower first). Absent = leave as-is.
  sortOrder: z.number().optional(),
});

export const CyborgUpdatePageResponseSchema = z.object({
  type: z.literal("cyborg:update_page_response"),
  payload: z.object({
    requestId: z.string(),
    page: PageObjectSchema,
  }),
});

export const CyborgSetPageArchivedRequestSchema = z.object({
  type: z.literal("cyborg:set_page_archived"),
  requestId: z.string(),
  pageId: z.string(),
  archived: z.boolean(),
});

export const CyborgSetPageArchivedResponseSchema = z.object({
  type: z.literal("cyborg:set_page_archived_response"),
  payload: z.object({
    requestId: z.string(),
    page: PageObjectSchema,
  }),
});

export const CyborgDeletePageRequestSchema = z.object({
  type: z.literal("cyborg:delete_page"),
  requestId: z.string(),
  pageId: z.string(),
});

export const CyborgDeletePageResponseSchema = z.object({
  type: z.literal("cyborg:delete_page_response"),
  payload: z.object({
    requestId: z.string(),
    deleted: z.boolean(),
  }),
});

// ─── Modules catalog CRUD ───────────────────────────────────────────────────
const ModuleObjectSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  startDate: z.number().nullable(),
  targetDate: z.number().nullable(),
  status: z.string(),
  lead: z.string().nullable(),
  sortOrder: z.number().nullable(),
  archivedAt: z.number().nullable(),
});

export const CyborgCreateModuleRequestSchema = z.object({
  type: z.literal("cyborg:create_module"),
  requestId: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
});

export const CyborgCreateModuleResponseSchema = z.object({
  type: z.literal("cyborg:create_module_response"),
  payload: z.object({
    requestId: z.string(),
    module: ModuleObjectSchema,
  }),
});

export const CyborgUpdateModuleRequestSchema = z.object({
  type: z.literal("cyborg:update_module"),
  requestId: z.string(),
  moduleId: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  status: z.string().optional(),
});

export const CyborgUpdateModuleResponseSchema = z.object({
  type: z.literal("cyborg:update_module_response"),
  payload: z.object({
    requestId: z.string(),
    module: ModuleObjectSchema,
  }),
});

export const CyborgDeleteModuleRequestSchema = z.object({
  type: z.literal("cyborg:delete_module"),
  requestId: z.string(),
  moduleId: z.string(),
});

export const CyborgDeleteModuleResponseSchema = z.object({
  type: z.literal("cyborg:delete_module_response"),
  payload: z.object({
    requestId: z.string(),
    deleted: z.boolean(),
  }),
});

// A single task's activity feed (history), ordered by `epoch` server-side.
export const CyborgFetchTaskActivityRequestSchema = z.object({
  type: z.literal("cyborg:fetch_task_activity"),
  requestId: z.string(),
  taskId: z.string(),
});

export const CyborgFetchTaskActivityResponseSchema = z.object({
  type: z.literal("cyborg:fetch_task_activity_response"),
  payload: z.object({
    requestId: z.string(),
    activity: z.array(
      z.object({
        id: z.string(),
        taskId: z.string(),
        workspaceId: z.string(),
        actorId: z.string().nullable(),
        verb: z.enum(["created", "updated"]),
        field: z.string().nullable(),
        oldValue: z.string().nullable(),
        newValue: z.string().nullable(),
        commentHtml: z.string().nullable(),
        epoch: z.number(),
      }),
    ),
  }),
});

// ─── Task links (external URLs attached to a task) ──────────────────────────
// The wire `taskId` keys every link op; the relay/dispatcher resolves the task to
// its project and gates visibility (same gate as fetch_task_activity). A link is
// {id,url,title?,createdBy,createdAt}; `title` is the optional display label.
const TaskLinkObjectSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
});

export const CyborgAddTaskLinkRequestSchema = z.object({
  type: z.literal("cyborg:add_task_link"),
  requestId: z.string(),
  taskId: z.string(),
  url: z.string(),
  title: z.string().nullable().optional(),
});

export const CyborgAddTaskLinkResponseSchema = z.object({
  type: z.literal("cyborg:add_task_link_response"),
  payload: z.object({
    requestId: z.string(),
    link: TaskLinkObjectSchema,
  }),
});

export const CyborgRemoveTaskLinkRequestSchema = z.object({
  type: z.literal("cyborg:remove_task_link"),
  requestId: z.string(),
  linkId: z.string(),
});

export const CyborgRemoveTaskLinkResponseSchema = z.object({
  type: z.literal("cyborg:remove_task_link_response"),
  payload: z.object({
    requestId: z.string(),
    deleted: z.boolean(),
  }),
});

export const CyborgFetchTaskLinksRequestSchema = z.object({
  type: z.literal("cyborg:fetch_task_links"),
  requestId: z.string(),
  taskId: z.string(),
});

export const CyborgFetchTaskLinksResponseSchema = z.object({
  type: z.literal("cyborg:fetch_task_links_response"),
  payload: z.object({
    requestId: z.string(),
    links: z.array(TaskLinkObjectSchema),
  }),
});

// ─── Task attachments (S3 asset rows) ───────────────────────────────────────
// The actual upload goes through the existing HTTP presign route (POST
// /api/assets/presign → S3 PUT); the client uploads the bytes, then calls
// add_task_attachment with the resulting key+url to persist the row. Gated by the
// task's project visibility, like links/activity. `key` is the S3 asset key, `url`
// the delivery URL, `name`/`size`/`contentType` the file metadata.
const TaskAttachmentObjectSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  assetKey: z.string(),
  url: z.string(),
  name: z.string(),
  size: z.number(),
  contentType: z.string().nullable(),
  uploadedBy: z.string(),
  createdAt: z.number(),
});

export const CyborgAddTaskAttachmentRequestSchema = z.object({
  type: z.literal("cyborg:add_task_attachment"),
  requestId: z.string(),
  taskId: z.string(),
  key: z.string(),
  url: z.string(),
  name: z.string(),
  size: z.number(),
  contentType: z.string().nullable().optional(),
});

export const CyborgAddTaskAttachmentResponseSchema = z.object({
  type: z.literal("cyborg:add_task_attachment_response"),
  payload: z.object({
    requestId: z.string(),
    attachment: TaskAttachmentObjectSchema,
  }),
});

export const CyborgRemoveTaskAttachmentRequestSchema = z.object({
  type: z.literal("cyborg:remove_task_attachment"),
  requestId: z.string(),
  attachmentId: z.string(),
});

export const CyborgRemoveTaskAttachmentResponseSchema = z.object({
  type: z.literal("cyborg:remove_task_attachment_response"),
  payload: z.object({
    requestId: z.string(),
    deleted: z.boolean(),
  }),
});

export const CyborgFetchTaskAttachmentsRequestSchema = z.object({
  type: z.literal("cyborg:fetch_task_attachments"),
  requestId: z.string(),
  taskId: z.string(),
});

export const CyborgFetchTaskAttachmentsResponseSchema = z.object({
  type: z.literal("cyborg:fetch_task_attachments_response"),
  payload: z.object({
    requestId: z.string(),
    attachments: z.array(TaskAttachmentObjectSchema),
  }),
});

// Broadcast to workspace guests when a task is created, updated, or deleted, so
// open task views update live without a manual refetch. The `task` shape mirrors
// the object returned by create_task / update_task (relay `mapTask`); `op` lets the
// client distinguish an insert from an in-place update from a removal. For a
// "deleted" op only `id` is meaningful (the client drops the row by id).
// `.passthrough()` so the new Phase 0 columns (sortOrder/startDate/archivedAt/
// isDraft) ride along on created/updated without a per-field schema bump, and so a
// partial `{ id }` payload (recurrence-spawned child, delete) still validates.
export const CyborgTasksChangedSchema = z.object({
  type: z.literal("cyborg:tasks_changed"),
  payload: z.object({
    workspaceId: z.string(),
    op: z.enum(["created", "updated", "deleted"]),
    task: z
      .object({
        id: z.string(),
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        description: z.string().nullable().optional(),
        status: z.string().optional(),
        assigneeId: z.string().nullable().optional(),
        createdBy: z.string().optional(),
        dueAt: z.number().nullable().optional(),
        result: z.string().nullable().optional(),
        createdAt: z.number().optional(),
        updatedAt: z.number().optional(),
        // Tasks Redesign readback — denormalized by the relay `mapTask`. All
        // optional (a partial `{ id }` delete payload still validates); `.passthrough()`
        // above already lets them ride along, named here so the contract is explicit.
        priority: z.string().nullable().optional(),
        project_id: z.string().nullable().optional(),
        parent_id: z.string().nullable().optional(),
        state_id: z.string().nullable().optional(),
        sequence_id: z.number().nullable().optional(),
        cycle_id: z.string().nullable().optional(),
        label_ids: z.array(z.string()).optional(),
        module_ids: z.array(z.string()).optional(),
      })
      .passthrough(),
  }),
});

// A page was created/updated/archived/deleted server-side → workspace guests with
// an open pages view refetch. Mirrors cyborg:tasks_changed. The full row rides
// along for created/updated/archived; a "deleted" op sends only `{ id }`.
export const CyborgPagesChangedSchema = z.object({
  type: z.literal("cyborg:pages_changed"),
  payload: z.object({
    workspaceId: z.string(),
    projectId: z.string(),
    op: z.enum(["created", "updated", "deleted"]),
    page: z
      .object({
        id: z.string(),
        projectId: z.string().optional(),
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        visibility: z.enum(["private", "public"]).optional(),
        parentId: z.string().nullable().optional(),
        sortOrder: z.number().optional(),
        ownedBy: z.string().nullable().optional(),
        archivedAt: z.number().nullable().optional(),
        createdAt: z.number().optional(),
        updatedAt: z.number().optional(),
      })
      .passthrough(),
  }),
});

// ─── License pool + allocation (per-workspace seat model, spec §4.3) ──────────
// A POOL is the caller's seat ENTITLEMENT on a rail (iOS tier product / Stripe
// sub); ALLOCATIONS spend seats on specific workspaces. A workspace is Pro iff it
// has an honored allocation from a good-standing pool. Caller identity = the
// authed socket's userId, so fetch needs no workspaceId; allocate/deallocate are
// OWNER-ONLY on the relay. These shapes MUST match the ws-client `LicensePoolResponse`
// / `LicenseAllocationResponse` byte-for-byte (relay-standalone Unit E handlers).

// The caller's seat entitlement on one rail, as the relay reports it.
export const CyborgLicensePoolSchema = z.object({
  seatCount: z.number(),
  status: z.string(),
  currentPeriodEnd: z.number().nullable(),
  rail: z.enum(["ios", "stripe"]),
  cancelAtPeriodEnd: z.boolean(),
});

// One workspace the caller OWNS. `state` + `trialEndsAt` mirror getLicenseStatus
// so the allocation panel can show "Trial/Paused" per row without a per-workspace
// fetch_license round-trip.
export const CyborgOwnedWorkspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.enum(["trialing", "active", "paused"]),
  trialEndsAt: z.number().nullable(),
});

// The per-workspace license payload (mirror of getLicenseStatus) returned by the
// allocate/deallocate handlers so the gate mirror updates without a refetch.
export const CyborgLicensePayloadSchema = z.object({
  state: z.enum(["trialing", "active", "paused"]),
  plan: z.string(),
  trialEndsAt: z.number().nullable(),
  currentPeriodEnd: z.number().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  status: z.string().nullable(),
});

export const CyborgFetchLicensePoolRequestSchema = z.object({
  type: z.literal("cyborg:fetch_license_pool"),
  requestId: z.string(),
});

export const CyborgFetchLicensePoolResponseSchema = z.object({
  type: z.literal("cyborg:fetch_license_pool_response"),
  payload: z.object({
    requestId: z.string().optional(),
    pool: CyborgLicensePoolSchema.nullable(),
    allocations: z.array(z.object({ workspaceId: z.string() })),
    ownedWorkspaces: z.array(CyborgOwnedWorkspaceSchema),
  }),
});

export const CyborgAllocateLicenseRequestSchema = z.object({
  type: z.literal("cyborg:allocate_license"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgDeallocateLicenseRequestSchema = z.object({
  type: z.literal("cyborg:deallocate_license"),
  requestId: z.string(),
  workspaceId: z.string(),
});

// Shared response for both allocate + deallocate. On a rejected mutation the
// relay still RESOLVES this response (not a cyborg:error) with `error` set to a
// code (no_free_seat | not_owner | no_pool | already_active_other_rail) and an
// unchanged pool/allocations — the client branches on `error`.
const LicenseAllocationResponsePayload = z.object({
  requestId: z.string().optional(),
  workspaceId: z.string(),
  license: CyborgLicensePayloadSchema,
  pool: CyborgLicensePoolSchema.nullable(),
  allocations: z.array(z.object({ workspaceId: z.string() })),
  error: z.string().optional(),
});

export const CyborgAllocateLicenseResponseSchema = z.object({
  type: z.literal("cyborg:allocate_license_response"),
  payload: LicenseAllocationResponsePayload,
});

export const CyborgDeallocateLicenseResponseSchema = z.object({
  type: z.literal("cyborg:deallocate_license_response"),
  payload: LicenseAllocationResponsePayload,
});

// ─── Agents ──────────────────────────────────────────────────────────

export const CyborgCreateAgentRequestSchema = z.object({
  type: z.literal("cyborg:create_agent"),
  requestId: z.string(),
  workspaceId: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  cwd: z.string(),
  systemPrompt: z.string().optional(),
  channelId: z.string().optional(),
  title: z.string().optional(),
  daemonId: z.string().optional(),
});

export const CyborgListAgentsRequestSchema = z.object({
  type: z.literal("cyborg:list_agents"),
  requestId: z.string(),
  workspaceId: z.string(),
  cyboId: z.string().optional(),
});

// Daemon-owner audit (sessions-daemon-audit-visibility / #993): list ALL sessions
// bound to ONE daemon — including ephemeral/internal summons and OTHER users' — for
// the daemon owner / `admin`-scoped grantee. A DISTINCT message from
// cyborg:list_agents (which is workspace-scoped, fanned across daemons, and
// caller-scoped). Its result stays in the daemon-detail's LOCAL state, never the
// global agents store that feeds the chat sidebar.
export const CyborgListDaemonSessionsRequestSchema = z.object({
  type: z.literal("cyborg:list_daemon_sessions"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string(),
});

// One audit row = the agent-list row fields PLUS the `ephemeral`/`internal` badges.
// Metadata ONLY — NO transcript/prompt/tool/terminal/system-prompt content (the
// read-only viewer sibling owns content; opening a row navigates there by agentId).
export const DaemonSessionAuditRowSchema = z.object({
  agentId: z.string(),
  provider: z.string(),
  channelId: z.string().nullable().optional(),
  cyboId: z.string().nullable().optional(),
  cyboName: z.string().nullable().optional(),
  cyboAvatar: z.string().nullable().optional(),
  initiatedBy: z.string().nullable().optional(),
  initiatedByEmail: z.string().nullable().optional(),
  lifecycle: z.string(),
  model: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  availableModes: z.array(AgentModeSchema).optional(),
  thinkingOptionId: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  daemonId: z.string().nullable().optional(),
  daemonLocal: z.boolean().optional(),
  // NEW: badge slash/mention summons (ephemeral binding) and Paseo internal agents.
  ephemeral: z.boolean(),
  internal: z.boolean(),
});

export const CyborgListDaemonSessionsResponseSchema = z.object({
  type: z.literal("cyborg:list_daemon_sessions_response"),
  payload: z.object({
    requestId: z.string(),
    daemonId: z.string(),
    sessions: z.array(DaemonSessionAuditRowSchema),
  }),
});

export const CyborgSendAgentPromptRequestSchema = z.object({
  type: z.literal("cyborg:send_agent_prompt"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  prompt: z.string(),
  // #579: images/files handed to the agent. Images become vision content
  // blocks (Claude); text files become excerpts; everything is rendered as a
  // text reference for providers without image support. Same shape as channel
  // attachments, capped to keep the prompt payload bounded.
  attachments: z.array(AttachmentSchema).max(10).optional(),
});

export const CyborgCreateAgentResponseSchema = z.object({
  type: z.literal("cyborg:create_agent_response"),
  payload: z.object({
    requestId: z.string(),
    agent: z.object({
      agentId: z.string(),
      provider: z.string(),
      lifecycle: z.string(),
      model: z.string().nullable().optional(),
      modeId: z.string().nullable().optional(),
      availableModes: z.array(AgentModeSchema).optional(),
      thinkingOptionId: z.string().nullable().optional(),
      cwd: z.string().nullable().optional(),
      daemonLocal: z.boolean().optional(),
    }),
  }),
});

export const CyborgListAgentsResponseSchema = z.object({
  type: z.literal("cyborg:list_agents_response"),
  payload: z.object({
    requestId: z.string(),
    agents: z.array(
      z.object({
        agentId: z.string(),
        provider: z.string(),
        lifecycle: z.string(),
        channelId: z.string().nullable().optional(),
        model: z.string().nullable().optional(),
        modeId: z.string().nullable().optional(),
        availableModes: z.array(AgentModeSchema).optional(),
        thinkingOptionId: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        daemonLocal: z.boolean().optional(),
        // Derived "needs attention" signal (#591): the daemon's edge-triggered
        // attention flag (running→idle = "finished", →error) so the agents list
        // can badge a background agent that finished/errored without a
        // per-agent fetch_agent_state round-trip. Same shape the single-agent
        // fetch_agent_state response already carries. Optional + additive:
        // older daemons omit it → the UI shows no derived badge.
        attention: z
          .object({
            requiresAttention: z.boolean(),
            reason: z.string().nullable().optional(),
          })
          .optional(),
      }),
    ),
  }),
});

// ─── Agent State & Timeline ──────────────────────────────────────────

export const CyborgFetchAgentStateRequestSchema = z.object({
  type: z.literal("cyborg:fetch_agent_state"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
});

export const CyborgFetchAgentStateResponseSchema = z.object({
  type: z.literal("cyborg:fetch_agent_state_response"),
  payload: z.object({
    requestId: z.string(),
    agent: z
      .object({
        agentId: z.string(),
        provider: z.string(),
        lifecycle: z.string(),
        model: z.string().nullable().optional(),
        modeId: z.string().nullable().optional(),
        availableModes: z.array(AgentModeSchema).optional(),
        thinkingOptionId: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        cyboId: z.string().nullable().optional(),
        cyboSlug: z.string().nullable().optional(),
        channelId: z.string().nullable().optional(),
        daemonLocal: z.boolean(),
        createdAt: z.string().optional(),
        lastUserMessageAt: z.string().nullable().optional(),
        attention: z
          .object({
            requiresAttention: z.boolean(),
            reason: z.string().nullable().optional(),
          })
          .optional(),
        usage: z
          .object({
            inputTokens: z.number().optional(),
            outputTokens: z.number().optional(),
            totalCostUsd: z.number().optional(),
            contextWindowUsedTokens: z.number().optional(),
            contextWindowMaxTokens: z.number().optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable(),
  }),
});

export const CyborgFetchAgentTimelineRequestSchema = z.object({
  type: z.literal("cyborg:fetch_agent_timeline"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  cursor: z.string().optional(),
  limit: z.number().optional(),
  // "older" pages BACKWARD from `cursor` (scroll-up lazy-load of past history).
  // Omitted/"newer" keeps the legacy behavior (tail when no cursor, after when set).
  direction: z.enum(["older", "newer"]).optional(),
});

export const CyborgFetchAgentTimelineResponseSchema = z.object({
  type: z.literal("cyborg:fetch_agent_timeline_response"),
  payload: z.object({
    requestId: z.string(),
    items: z.array(z.record(z.unknown())),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    // Backward (older-history) pagination: cursor to page further back + whether
    // any older entries remain. Optional for back-compat with older daemons.
    olderCursor: z.string().nullable().optional(),
    hasOlder: z.boolean().optional(),
  }),
});

// Read-only session viewer (#994): fetch the captured INJECTED CONTEXT bundle for
// an ephemeral cybo session (system prompt + tools made available + routed/raw
// prompt). Pure read — never attaches/revives the agent. Returns context:null for
// a non-ephemeral agent (the viewer then shows only the transcript).
export const CyborgFetchSessionContextRequestSchema = z.object({
  type: z.literal("cyborg:fetch_session_context"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
});

export const CyborgSessionContextMcpServerSchema = z.object({
  name: z.string(),
  type: z.string(),
  url: z.string().optional(),
  toolkit: z.string().optional(),
});

export const CyborgFetchSessionContextResponseSchema = z.object({
  type: z.literal("cyborg:fetch_session_context_response"),
  payload: z.object({
    requestId: z.string(),
    context: z
      .object({
        systemPrompt: z.string().nullable(),
        mcpServers: z.array(CyborgSessionContextMcpServerSchema),
        routedPrompt: z.string().nullable(),
        rawPrompt: z.string().nullable(),
        cyboId: z.string().nullable(),
        channelId: z.string().nullable(),
        createdAt: z.number(),
      })
      .nullable(),
  }),
});

export const CyborgAgentStreamSchema = z.object({
  type: z.literal("cyborg:agent_stream"),
  payload: z.object({
    agentId: z.string(),
    workspaceId: z.string(),
    event: z.record(z.unknown()),
    // The agent's binding channel (null for a DM turn, where emitAgentStream
    // steers the relay flush to the DM via privateToEmail instead). Optional for
    // backward-compat with older daemons.
    channelId: z.string().nullable().optional(),
    // Cybo identity carried so the relay flush persists the cybo NAME + id instead
    // of the raw agent UUID (workspace-relay flushPendingAgentMessage).
    cyboId: z.string().nullable().optional(),
    cyboName: z.string().nullable().optional(),
    // Set for a private/DM agent turn so the relay scopes the reply to the
    // initiator (broadcastAgentReply → dm_broadcast) instead of the workspace.
    privateToEmail: z.string().nullable().optional(),
  }),
});

export const CyborgAgentStatusSchema = z.object({
  type: z.literal("cyborg:agent_status"),
  payload: z.object({
    agentId: z.string(),
    workspaceId: z.string(),
    status: z.enum(["idle", "running", "error"]),
    error: z.string().optional(),
    // Session-history identity carried for the relay's agent_sessions writer
    // (Home "This week" stats). Optional/backward-compatible: older daemons omit
    // them, so the relay records the session with what it has (provider null).
    channelId: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    cyboId: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    userId: z.string().nullable().optional(),
    // A solo daemon's userId is a daemon-local SQLite id, not the global PG
    // account id. Carry the email so the relay can resolve it to the global id
    // before writing agent_sessions (avoids cross-id mismatch in PG queries).
    userEmail: z.string().nullable().optional(),
    sessionType: z.string().optional(),
  }),
});

// ─── Agent Permission / Cancel ──────────────────────────────────────

export const CyborgAgentPermissionResponseSchema = z.object({
  type: z.literal("cyborg:agent_permission_response"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  agentId: z.string(),
  permissionRequestId: z.string(),
  response: z.object({
    behavior: z.enum(["allow", "deny"]),
    selectedActionId: z.string().optional(),
    updatedInput: z.record(z.unknown()).optional(),
    message: z.string().optional(),
    interrupt: z.boolean().optional(),
  }),
});

export const CyborgCancelAgentSchema = z.object({
  type: z.literal("cyborg:cancel_agent"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  agentId: z.string(),
});

// Clear an agent's derived "needs attention" flag (#591) on the OWNING daemon —
// the authoritative store (Paseo agent-manager). Sent when the agent is viewed,
// so the finished/error badge doesn't resurrect from the next list snapshot.
// Fire-and-forget like cancel_agent; the daemon re-broadcasts the cleared state.
export const CyborgClearAttentionSchema = z.object({
  type: z.literal("cyborg:clear_attention"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  agentId: z.string(),
});

// ─── Providers ──────────────────────────────────────────────────────

export const CyborgListProvidersRequestSchema = z.object({
  type: z.literal("cyborg:list_providers"),
  requestId: z.string(),
});

// Classified reason a provider is unusable. Mirrors
// cyborg/provider-error-classify.ts + the UI ProviderReasonKind — keep in sync.
export const ProviderReasonKindSchema = z.enum([
  "usage_gated",
  "auth_invalid",
  "not_configured",
  "expired",
  "rate_limited",
  "unknown",
]);

export const CyborgListProvidersResponseSchema = z.object({
  type: z.literal("cyborg:list_providers_response"),
  payload: z.object({
    requestId: z.string(),
    providers: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string(),
        available: z.boolean(),
        models: z.array(
          z.object({
            id: z.string(),
            label: z.string().optional(),
            isDefault: z.boolean().optional(),
          }),
        ),
        modes: z.array(
          z.object({
            id: z.string(),
            label: z.string(),
            description: z.string(),
          }),
        ),
        defaultModeId: z.string().nullable(),
        // EXACT user-facing reason a provider is unusable + its classified kind,
        // so the UI shows the right remedy. Backward-compatible (optional).
        unavailableReason: z.string().nullable().optional(),
        reasonKind: ProviderReasonKindSchema.nullable().optional(),
      }),
    ),
  }),
});

// ─── Members ────────────────────────────────────────────────────────

export const CyborgListMembersRequestSchema = z.object({
  type: z.literal("cyborg:list_members"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgListMembersResponseSchema = z.object({
  type: z.literal("cyborg:list_members_response"),
  payload: z.object({
    requestId: z.string(),
    members: z.array(
      z.object({
        userId: z.string(),
        email: z.string(),
        name: z.string().nullable(),
        role: z.string(),
        joinedAt: z.number(),
      }),
    ),
  }),
});

// ─── Agent Controls (model / mode / thinking / commands) ───────────

export const CyborgSetAgentModelSchema = z.object({
  type: z.literal("cyborg:set_agent_model"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  modelId: z.string().nullable(),
});

export const CyborgSetAgentModeSchema = z.object({
  type: z.literal("cyborg:set_agent_mode"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  modeId: z.string(),
});

export const CyborgSetAgentThinkingSchema = z.object({
  type: z.literal("cyborg:set_agent_thinking"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  thinkingOptionId: z.string().nullable(),
});

export const CyborgListCommandsSchema = z.object({
  type: z.literal("cyborg:list_commands"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
});

// Rewind ('rewind to here') — roll an agent/cybo session back to before a prior
// turn (issue #649). `messageId` is the Paseo agent-TIMELINE user-message id
// (the `messageId` carried on a `user_message` timeline item from
// cyborg:fetch_agent_timeline), NOT a channel chat message id. `mode` defaults to
// "conversation" on the client because that is the only mode every provider
// supports (pi — which runs cybos — supports conversation only; files/both are
// Claude-only). The server forwards it straight to Paseo's agentManager.rewind.
export const CyborgRewindAgentSchema = z.object({
  type: z.literal("cyborg:rewind_agent"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  messageId: z.string(),
  mode: z.enum(["conversation", "files", "both"]).optional(),
});

// Reload/restart a session in place (#592): recover a wedged agent without
// losing its identity. Calls Paseo's reloadAgentSession (cancel in-flight run →
// close → resume/recreate). rehydrateFromDisk wipes the in-memory timeline,
// mints a new epoch and re-streams provider history (for a desynced session).
export const CyborgReloadSessionSchema = z.object({
  type: z.literal("cyborg:reload_session"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  rehydrateFromDisk: z.boolean().optional(),
});

export const CyborgReloadSessionResponseSchema = z.object({
  type: z.literal("cyborg:reload_session_response"),
  payload: z.object({
    requestId: z.string(),
    status: z.string(),
  }),
});

export const CyborgSetAgentModelResponseSchema = z.object({
  type: z.literal("cyborg:set_agent_model_response"),
  payload: z.object({
    requestId: z.string(),
    status: z.string(),
  }),
});

export const CyborgSetAgentModeResponseSchema = z.object({
  type: z.literal("cyborg:set_agent_mode_response"),
  payload: z.object({
    requestId: z.string(),
    status: z.string(),
  }),
});

export const CyborgSetAgentThinkingResponseSchema = z.object({
  type: z.literal("cyborg:set_agent_thinking_response"),
  payload: z.object({
    requestId: z.string(),
    status: z.string(),
  }),
});

export const CyborgRewindAgentResponseSchema = z.object({
  type: z.literal("cyborg:rewind_agent_response"),
  payload: z.object({
    requestId: z.string(),
    status: z.string(),
  }),
});

export const CyborgListCommandsResponseSchema = z.object({
  type: z.literal("cyborg:list_commands_response"),
  payload: z.object({
    requestId: z.string(),
    commands: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        argumentHint: z.string(),
      }),
    ),
  }),
});

// #581: @-file/dir autocomplete in the agent composer. The client sends the text
// after the `@` as `query`; the daemon searches the agent's workspace cwd and
// returns file/directory entries to insert into the prompt.
export const CyborgDirectorySuggestionsSchema = z.object({
  type: z.literal("cyborg:directory_suggestions"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
  query: z.string(),
});

export const CyborgDirectorySuggestionsResponseSchema = z.object({
  type: z.literal("cyborg:directory_suggestions_response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(
      z.object({
        path: z.string(),
        kind: z.enum(["file", "directory"]),
      }),
    ),
    error: z.string().nullable(),
  }),
});

// ─── Error ───────────────────────────────────────────────────────────

export const CyborgErrorSchema = z.object({
  type: z.literal("cyborg:error"),
  payload: z.object({
    requestId: z.string().optional(),
    code: z.string(),
    message: z.string(),
    // Optional enrichment for provider/backend spawn refusals so the UI can show
    // the exact remedy (e.g. "add usage" vs "reconnect"). Backward-compatible.
    reasonKind: ProviderReasonKindSchema.optional(),
    unavailableReason: z.string().optional(),
    backend: z.string().optional(),
  }),
});

// ─── Daemons ──────────────────────────────────────────────────────────

export const CyborgListDaemonsRequestSchema = z.object({
  type: z.literal("cyborg:list_daemons"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
});

export const CyborgListDaemonsResponseSchema = z.object({
  type: z.literal("cyborg:list_daemons_response"),
  requestId: z.string().optional(),
  daemons: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      ownerId: z.string(),
      status: z.string(),
      lastSeenAt: z.number().nullable(),
      meta: z
        .object({
          cpu: z.number().optional(),
          memMb: z.number().optional(),
          agents: z.number().optional(),
          queueDepth: z.number().optional(),
          host: z.string().optional(),
          platform: z.string().optional(),
          arch: z.string().optional(),
          cyboInstalled: z.boolean().optional(),
        })
        .nullable()
        .optional(),
    }),
  ),
  // Workspace-level slash AI config (admin-controlled). Present so W0/W3 can render
  // the current default daemon + ordered fallbacks + model without a second call.
  workspaceSlashConfig: z
    .object({
      defaultSlashDaemonId: z.string().nullable(),
      fallbackDaemons: z.array(z.string()),
      model: z.object({ provider: z.string(), model: z.string() }).nullable(),
    })
    .optional(),
});

// ─── Workspace slash-command AI config (admin/owner only) ─────────────
// Set the workspace's default slash daemon + ordered fallback daemons + preferred
// model. Daemons must belong to / be accessible by the workspace. `model` is
// "provider/model" (or null to clear → auto-resolve). Omitted fields are left as-is.
export const CyborgSetWorkspaceSlashConfigRequestSchema = z.object({
  type: z.literal("cyborg:set_workspace_slash_config"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  defaultSlashDaemonId: z.string().nullable().optional(),
  fallbackDaemons: z.array(z.string()).optional(),
  model: z.string().nullable().optional(),
});

export const CyborgSetWorkspaceSlashConfigResponseSchema = z.object({
  type: z.literal("cyborg:set_workspace_slash_config_response"),
  requestId: z.string().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
  config: z
    .object({
      defaultSlashDaemonId: z.string().nullable(),
      fallbackDaemons: z.array(z.string()),
      model: z.object({ provider: z.string(), model: z.string() }).nullable(),
    })
    .optional(),
});

// Read the workspace slash AI config (for the AI settings tab). Any workspace
// member may read it; only owner/admin may set it (see the Set schema above).
export const CyborgGetWorkspaceSlashConfigRequestSchema = z.object({
  type: z.literal("cyborg:get_workspace_slash_config"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
});

export const CyborgGetWorkspaceSlashConfigResponseSchema = z.object({
  type: z.literal("cyborg:get_workspace_slash_config_response"),
  requestId: z.string().optional(),
  config: z.object({
    defaultSlashDaemonId: z.string().nullable(),
    fallbackDaemons: z.array(z.string()),
    model: z.object({ provider: z.string(), model: z.string() }).nullable(),
  }),
});

// ─── Workspace agent autonomy (admin/owner only) ──────────────────────
// Per-workspace master switch for UN-mentioned channel watchers. DEFAULT ON.
// When OFF, the channel auto-tasks watcher is gated off workspace-wide; @-mentions
// are UNAFFECTED — a directly tagged agent always responds. Any member may read it
// (Get); only owner/admin may set it (Set).
export const CyborgSetWorkspaceAutonomyRequestSchema = z.object({
  type: z.literal("cyborg:set_workspace_autonomy"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  enabled: z.boolean(),
});

export const CyborgSetWorkspaceAutonomyResponseSchema = z.object({
  type: z.literal("cyborg:set_workspace_autonomy_response"),
  requestId: z.string().optional(),
  ok: z.boolean(),
  enabled: z.boolean().optional(),
  error: z.string().optional(),
});

export const CyborgGetWorkspaceAutonomyRequestSchema = z.object({
  type: z.literal("cyborg:get_workspace_autonomy"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
});

export const CyborgGetWorkspaceAutonomyResponseSchema = z.object({
  type: z.literal("cyborg:get_workspace_autonomy_response"),
  requestId: z.string().optional(),
  enabled: z.boolean(),
  error: z.string().optional(),
});

// Outbound: autonomy was toggled — fan out to a workspace's guests (and forwarded
// to its daemons) so every open client reflects the new switch state without a refetch.
export const CyborgWorkspaceAutonomyUpdatedSchema = z.object({
  type: z.literal("cyborg:workspace_autonomy_updated"),
  payload: z.object({
    workspaceId: z.string(),
    enabled: z.boolean(),
  }),
});

// ─── Session aliases (per-user, display-only) ─────────────────────────
// Personal cosmetic label for an agent session. Per-user (uses guest.userId),
// not shared. An empty/whitespace alias clears it (back to the default name).
export const CyborgSetSessionAliasRequestSchema = z.object({
  type: z.literal("cyborg:set_session_alias"),
  requestId: z.string().optional(),
  agentId: z.string(),
  alias: z.string(),
});

export const CyborgSetSessionAliasResponseSchema = z.object({
  type: z.literal("cyborg:set_session_alias_response"),
  requestId: z.string().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const CyborgGetSessionAliasesRequestSchema = z.object({
  type: z.literal("cyborg:get_session_aliases"),
  requestId: z.string().optional(),
});

export const CyborgGetSessionAliasesResponseSchema = z.object({
  type: z.literal("cyborg:get_session_aliases_response"),
  requestId: z.string().optional(),
  aliases: z.record(z.string()),
});

// ─── Terminal aliases (per-user, display-only, cross-device synced) ────
// Personal cosmetic label for a terminal session. Per-user (uses guest.userId),
// not shared. An empty/whitespace alias clears it (back to the pty title). The
// optional workspaceId is a routing hint so the server can fan the change out to
// the user's OTHER connected clients live — it is NOT part of the storage key
// (aliases are keyed by user + terminalId only).
export const CyborgSetTerminalAliasRequestSchema = z.object({
  type: z.literal("cyborg:set_terminal_alias"),
  requestId: z.string().optional(),
  terminalId: z.string(),
  alias: z.string(),
  workspaceId: z.string().optional(),
});

export const CyborgSetTerminalAliasResponseSchema = z.object({
  type: z.literal("cyborg:set_terminal_alias_response"),
  requestId: z.string().optional(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const CyborgGetTerminalAliasesRequestSchema = z.object({
  type: z.literal("cyborg:get_terminal_aliases"),
  requestId: z.string().optional(),
});

export const CyborgGetTerminalAliasesResponseSchema = z.object({
  type: z.literal("cyborg:get_terminal_aliases_response"),
  requestId: z.string().optional(),
  aliases: z.record(z.string()),
});

// Server → client live broadcast: a terminal alias changed on one of the user's
// devices. `toUserId` scopes delivery to that user (owner-scoped, exactly like
// terminals_changed). An empty `alias` means the alias was cleared.
export const CyborgTerminalAliasChangedSchema = z.object({
  type: z.literal("cyborg:terminal_alias_changed"),
  payload: z.object({
    terminalId: z.string(),
    alias: z.string(),
    toUserId: z.string().optional(),
  }),
});

// ─── Daemon Access ────────────────────────────────────────────────────

export const CyborgFetchDaemonInfoRequestSchema = z.object({
  type: z.literal("cyborg:fetch_daemon_info"),
  requestId: z.string().optional(),
});

export const CyborgGrantDaemonAccessRequestSchema = z.object({
  type: z.literal("cyborg:grant_daemon_access"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string(),
  userId: z.string(),
});

// Idempotent scoped set (#705): the authoritative daemon-access mutation. An
// empty `scopes` revokes. Scope strings are validated against the closed set.
export const CyborgSetDaemonAccessRequestSchema = z.object({
  type: z.literal("cyborg:set_daemon_access"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string(),
  userId: z.string(),
  scopes: z.array(z.enum(["chat", "spawn", "terminal", "admin"])),
});

export const CyborgRevokeDaemonAccessRequestSchema = z.object({
  type: z.literal("cyborg:revoke_daemon_access"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string(),
  userId: z.string(),
});

export const CyborgFetchDaemonAccessRequestSchema = z.object({
  type: z.literal("cyborg:fetch_daemon_access"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
});

// Rename a daemon from the UI (#441) — owner-only; sets the sticky
// label_user_set flag so hello upserts never overwrite it.
export const CyborgRenameDaemonRequestSchema = z.object({
  type: z.literal("cyborg:rename_daemon"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string(),
  label: z.string().trim().min(1).max(64),
});

// ─── Daemon Access Requests (REQUEST → NOTIFY → APPROVE half of #705) ──
//
// A non-owner asks a daemon OWNER for access at a requested set of scopes; the
// owner approves (running the existing grant) or denies. The serialized request
// row the UI consumes — createdAt/resolvedAt are epoch-ms numbers (the WS layer
// serializes Dates to numbers), so this is the wire shape, not the DB row.
export const DaemonAccessRequestPayloadSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  daemonId: z.string(),
  requesterId: z.string(),
  requesterName: z.string().nullable(),
  scopes: z.array(z.enum(["chat", "spawn", "terminal", "admin"])),
  status: z.enum(["pending", "approved", "denied"]),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  createdAt: z.number(),
});

// Requester → owner: ask for access at the requested scopes. Scope strings are
// validated against the closed set, exactly like set_daemon_access.
export const CyborgRequestDaemonAccessRequestSchema = z.object({
  type: z.literal("cyborg:request_daemon_access"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  daemonId: z.string(),
  scopes: z.array(z.enum(["chat", "spawn", "terminal", "admin"])),
});

export const CyborgRequestDaemonAccessResponseSchema = z.object({
  type: z.literal("cyborg:request_daemon_access_response"),
  requestId: z.string().optional(),
  request: DaemonAccessRequestPayloadSchema,
});

// Owner → resolve a pending request. approve runs setDaemonAccess with the
// requested scopes (or `scopes` override if the owner adjusted them); deny grants
// nothing. Owner-only (gated at the relay/dispatcher).
export const CyborgResolveDaemonAccessRequestRequestSchema = z.object({
  type: z.literal("cyborg:resolve_daemon_access_request"),
  // RPC correlation id (every cyborg:* RPC carries this). DISTINCT from the
  // request being resolved, which travels as `requestIdToResolve` so the two
  // don't collide on the wire.
  requestId: z.string().optional(),
  workspaceId: z.string(),
  requestIdToResolve: z.string(),
  decision: z.enum(["approve", "deny"]),
  scopes: z.array(z.enum(["chat", "spawn", "terminal", "admin"])).optional(),
});

export const CyborgResolveDaemonAccessRequestResponseSchema = z.object({
  type: z.literal("cyborg:resolve_daemon_access_request_response"),
  requestId: z.string().optional(),
  request: DaemonAccessRequestPayloadSchema,
});

// Owner inbox + requester outbox: the PENDING requests the caller should see
// (requests for daemons they own, plus their own outgoing requests).
export const CyborgFetchDaemonAccessRequestsRequestSchema = z.object({
  type: z.literal("cyborg:fetch_daemon_access_requests"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
});

export const CyborgFetchDaemonAccessRequestsResponseSchema = z.object({
  type: z.literal("cyborg:fetch_daemon_access_requests_response"),
  requestId: z.string().optional(),
  requests: z.array(DaemonAccessRequestPayloadSchema),
});

// Live push (no requestId): a request was created or resolved — sent to the owner
// (on create) and the requester (on resolve) so inboxes/badges update in realtime.
export const CyborgDaemonAccessRequestChangedSchema = z.object({
  type: z.literal("cyborg:daemon_access_request_changed"),
  request: DaemonAccessRequestPayloadSchema,
});

// ─── Daemon workspace serving (owner limits which workspaces a daemon serves) ──

export const CyborgListDaemonWorkspacesRequestSchema = z.object({
  type: z.literal("cyborg:list_daemon_workspaces"),
  requestId: z.string().optional(),
  daemonId: z.string(),
});

export const CyborgListDaemonWorkspacesResponseSchema = z.object({
  type: z.literal("cyborg:list_daemon_workspaces_response"),
  requestId: z.string().optional(),
  workspaces: z.array(
    z.object({
      workspaceId: z.string(),
      name: z.string(),
      enabled: z.boolean(),
    }),
  ),
});

export const CyborgSetDaemonWorkspaceRequestSchema = z.object({
  type: z.literal("cyborg:set_daemon_workspace"),
  requestId: z.string().optional(),
  daemonId: z.string(),
  workspaceId: z.string(),
  enabled: z.boolean(),
});

export const CyborgSetDaemonWorkspaceResponseSchema = z.object({
  type: z.literal("cyborg:set_daemon_workspace_response"),
  requestId: z.string().optional(),
  ok: z.literal(true),
});

// ─── Pairing ─────────────────────────────────────────────────────────

export const CyborgGetPairingInfoSchema = z.object({
  type: z.literal("cyborg:get_pairing_info"),
  requestId: z.string().optional(),
});

export type CyborgGetPairingInfo = z.infer<typeof CyborgGetPairingInfoSchema>;

export const CyborgDevTokenRequestSchema = z.object({
  type: z.literal("cyborg:dev_token"),
  requestId: z.string().optional(),
  email: z.string().email(),
  name: z.string().optional(),
});

export type CyborgDevTokenRequest = z.infer<typeof CyborgDevTokenRequestSchema>;

// ─── Recent working directories ─────────────────────────────────────

export const CyborgListRecentCwdsRequestSchema = z.object({
  type: z.literal("cyborg:list_recent_cwds"),
  requestId: z.string(),
});

export const CyborgListRecentCwdsResponseSchema = z.object({
  type: z.literal("cyborg:list_recent_cwds_response"),
  payload: z.object({
    requestId: z.string(),
    home: z.string(),
    recent: z.array(z.string()),
  }),
});

// ─── Archived Sessions ────────────────────────────────────────────

export const CyborgArchiveAgentRequestSchema = z.object({
  type: z.literal("cyborg:archive_agent"),
  requestId: z.string(),
  workspaceId: z.string(),
  agentId: z.string(),
});

export const CyborgArchiveAgentResponseSchema = z.object({
  type: z.literal("cyborg:archive_agent_response"),
  payload: z.object({
    requestId: z.string(),
    sessionId: z.string(),
  }),
});

export const CyborgListArchivedSessionsRequestSchema = z.object({
  type: z.literal("cyborg:list_archived_sessions"),
  requestId: z.string(),
  workspaceId: z.string(),
  // Keyset pagination (additive, back-compat). `limit` caps the page size;
  // `cursor` is the opaque token from a prior response's `nextCursor`. Both
  // optional — an omitted limit keeps the legacy full-list behavior. `limit` is
  // constrained to a positive integer so a malformed/0/negative value can't
  // produce a degenerate query. Bounds the formerly-unbounded archived list.
  limit: z.number().int().positive().optional(),
  cursor: z.string().optional(),
});

export const CyborgListArchivedSessionsResponseSchema = z.object({
  type: z.literal("cyborg:list_archived_sessions_response"),
  payload: z.object({
    requestId: z.string(),
    sessions: z.array(
      z.object({
        id: z.string(),
        provider: z.string(),
        providerHandleId: z.string(),
        title: z.string().nullable(),
        cwd: z.string().nullable(),
        model: z.string().nullable(),
        cyboId: z.string().nullable(),
        archivedAt: z.number(),
        // Owning daemon, stamped by the relay's fan-out aggregator (each daemon
        // archives to its OWN SQLite). Optional for back-compat: the daemon
        // itself doesn't know its relay id, and solo/single-daemon clients don't
        // need it. The client uses it to scope + route a restore to the daemon
        // that actually holds the archived session (#593).
        daemonId: z.string().nullable().optional(),
      }),
    ),
    // Opaque cursor for the next (older) page, or null when this is the last
    // page. Optional for back-compat with clients that ignore it / older daemons
    // that never set it.
    nextCursor: z.string().nullable().optional(),
  }),
});

// Config overrides applied when RESUMING an archived session (#593). All
// optional — omitting them (or the whole object) resumes on the session's
// archived config, exactly as before. These map 1:1 onto the inherited
// AgentSessionConfig fields that Paseo's resumeAgentFromPersistence merges.
export const CyborgResumeOverridesSchema = z.object({
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().nullable().optional(),
});

export const CyborgRestoreSessionRequestSchema = z.object({
  type: z.literal("cyborg:restore_session"),
  requestId: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  // The daemon that owns the archived session (from list_archived_sessions).
  // Optional: when omitted the relay resolves the sole connected workspace
  // daemon (and requires it when several are online). Carried so the relay can
  // scope-check the RIGHT daemon (spawn scope) and route the restore to it.
  daemonId: z.string().optional(),
  // Optional model/mode/thinking overrides (#593). Omitted ⇒ archived config.
  overrides: CyborgResumeOverridesSchema.optional(),
});

export const CyborgRestoreSessionResponseSchema = z.object({
  type: z.literal("cyborg:restore_session_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
  }),
});

// ─── Import Session (bring a LOCAL provider transcript into the workspace) ──
//
// A user picks a recent local provider session (Claude/Codex/OpenCode/Pi) from
// the importable-sessions picker and imports it INTO a Cyborg workspace. The
// owning daemon resumes the provider transcript into a LIVE agent (via the same
// Paseo importProviderSession primitive restore_session uses) AND records a
// Cyborg archived_sessions row — mirrored to PG via DualStorage — so the session
// is durable, lands in the CLOUD archived-session history once it's no longer
// live, and is re-resumable from any device via the existing restore_session
// path. The archive write is IDEMPOTENT on (workspace, provider,
// providerHandleId): re-importing the same transcript reuses the existing row +
// its still-live agent instead of duplicating either.
export const CyborgImportSessionRequestSchema = z.object({
  type: z.literal("cyborg:import_session"),
  requestId: z.string(),
  workspaceId: z.string(),
  // Originating channel, so the imported agent's binding is anchored to the
  // channel the user imported from (parity with create_agent). Optional.
  channelId: z.string().optional(),
  provider: z.string(),
  providerHandleId: z.string(),
  // Recorded working directory of the provider session. Required for OpenCode
  // (its handle can't be resolved without a cwd) and pins the resumed agent to
  // the original directory; optional for providers that persist the cwd.
  cwd: z.string().optional(),
  // The daemon that owns the local provider transcript (from the importable
  // sessions list). Optional: the relay resolves the sole connected workspace
  // daemon when omitted. Mirrors restore_session's daemonId routing.
  daemonId: z.string().optional(),
});

export const CyborgImportSessionResponseSchema = z.object({
  type: z.literal("cyborg:import_session_response"),
  payload: z.object({
    requestId: z.string(),
    // The live agent the imported transcript resumed into.
    agentId: z.string(),
    // The archived_sessions row id (durable, re-resumable via restore_session).
    sessionId: z.string(),
  }),
});

// ─── Projects ─────────────────────────────────────────────────────

export const CyborgCreateProjectRequestSchema = z.object({
  type: z.literal("cyborg:create_project"),
  requestId: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  color: z.string(),
});

export const CyborgCreateProjectResponseSchema = z.object({
  type: z.literal("cyborg:create_project_response"),
  payload: z.object({
    requestId: z.string(),
    project: z.object({
      id: z.string(),
      name: z.string(),
      color: z.string(),
      createdAt: z.number(),
    }),
  }),
});

export const CyborgFetchProjectsRequestSchema = z.object({
  type: z.literal("cyborg:fetch_projects"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgFetchProjectsResponseSchema = z.object({
  type: z.literal("cyborg:fetch_projects_response"),
  payload: z.object({
    requestId: z.string(),
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        color: z.string(),
        createdAt: z.number(),
      }),
    ),
    channelProjects: z.array(
      z.object({
        channelId: z.string(),
        projectId: z.string(),
      }),
    ),
  }),
});

export const CyborgUpdateProjectRequestSchema = z.object({
  type: z.literal("cyborg:update_project"),
  requestId: z.string(),
  projectId: z.string(),
  name: z.string(),
  color: z.string(),
});

export const CyborgUpdateProjectResponseSchema = z.object({
  type: z.literal("cyborg:update_project_response"),
  payload: z.object({ requestId: z.string() }),
});

export const CyborgDeleteProjectRequestSchema = z.object({
  type: z.literal("cyborg:delete_project"),
  requestId: z.string(),
  projectId: z.string(),
});

export const CyborgDeleteProjectResponseSchema = z.object({
  type: z.literal("cyborg:delete_project_response"),
  payload: z.object({ requestId: z.string() }),
});

export const CyborgSetChannelProjectRequestSchema = z.object({
  type: z.literal("cyborg:set_channel_project"),
  requestId: z.string(),
  channelId: z.string(),
  projectId: z.string().nullable(),
});

export const CyborgSetChannelProjectResponseSchema = z.object({
  type: z.literal("cyborg:set_channel_project_response"),
  payload: z.object({ requestId: z.string() }),
});

// Tasks Phase 2 — per-channel auto-tasks (channel watcher) opt-in switch. The
// watcher auto-spawns a cybo on un-mentioned human chatter ONLY when this is
// explicitly enabled (default OFF, per schema.ts auto_tasks_enabled contract).
// Same edit gate as cyborg:set_channel_slash_command_model.
export const CyborgSetChannelAutoTasksRequestSchema = z.object({
  type: z.literal("cyborg:set_channel_auto_tasks"),
  requestId: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  enabled: z.boolean(),
});

export const CyborgSetChannelAutoTasksResponseSchema = z.object({
  type: z.literal("cyborg:set_channel_auto_tasks_response"),
  payload: z.object({
    requestId: z.string(),
    channelId: z.string(),
    enabled: z.boolean(),
  }),
});

// ─── Cybos ──────────────────────────────────────────────────────────

export const CyborgCreateCyboRequestSchema = z.object({
  type: z.literal("cyborg:create_cybo"),
  requestId: z.string(),
  workspaceId: z.string(),
  slug: z.string().min(1).max(60),
  name: z.string().min(1).max(100),
  soul: z.string().min(1).max(50000),
  provider: z.string(),
  model: z.string().optional(),
  description: z.string().max(500).optional(),
  avatar: z.string().optional(),
  role: z.string().max(100).optional(),
  llmAuthMode: LlmAuthModeSchema.optional(),
  behaviorMode: BehaviorModeSchema.optional(),
  // The cybo's home daemon, chosen at creation. Nullable/optional: omit to fall
  // back to the sponsor/selected daemon.
  homeDaemonId: z.string().nullable().optional(),
  autonomyLevel: AutonomyLevelSchema.nullable().optional(),
  monthlySpendCap: MonthlySpendCapSchema.optional(),
  platformPermissions: PlatformPermissionsSchema.optional(),
  // Specialized tools: a map of custom MCP servers ({type,url}/{command,args})
  // merged into the spawned cybo's agent config alongside the cyborg7 server.
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export const CyborgCreateCyboResponseSchema = z.object({
  type: z.literal("cyborg:create_cybo_response"),
  payload: z.object({
    requestId: z.string(),
    cybo: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      provider: z.string(),
      model: z.string().nullable().optional(),
      isDefault: z.boolean(),
    }),
  }),
});

// ─── Provider credentials (per-daemon encrypted store, internal docs) ──
//
// Daemon-scoped RPCs: these MUST be handled by the daemon that holds the
// credential (the store is per-daemon, internal docs), so each carries an
// explicit `daemonId` and is forwarded to that daemon (DAEMON_FORWARD_TYPES) —
// the relay never reads/writes the secret. ADDITIVE `cyborg:*` only.
//
// SECRET HYGIENE (internal docs): the credential is NEVER echoed in any
// response. set/remove return `{ ok: true }`; list returns METADATA ONLY
// (providerId, type, expires) — never key/token/access/refresh.

// The secret-bearing credential payload accepted by `set` — mirrors the stored
// `CyboCredential` union (cybo-credentials.ts) minus `cli` (cli stores nothing).
const ProviderCredentialPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api"),
    key: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("oauth"),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number().int().nonnegative(),
    accountId: z.string().optional(),
    enterpriseUrl: z.string().optional(),
  }),
  z.object({
    type: z.literal("wellknown"),
    key: z.string().min(1),
    token: z.string().min(1),
  }),
]);

export const CyborgSetCyboCredentialRequestSchema = z.object({
  type: z.literal("cyborg:set_cybo_credential"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string(),
  providerId: z.string().min(1),
  credential: ProviderCredentialPayloadSchema,
});

export const CyborgSetCyboCredentialResponseSchema = z.object({
  type: z.literal("cyborg:set_cybo_credential_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.literal(true),
  }),
});

export const CyborgRemoveCyboCredentialRequestSchema = z.object({
  type: z.literal("cyborg:remove_cybo_credential"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string(),
  providerId: z.string().min(1),
});

export const CyborgRemoveCyboCredentialResponseSchema = z.object({
  type: z.literal("cyborg:remove_cybo_credential_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.literal(true),
  }),
});

export const CyborgListProviderAuthRequestSchema = z.object({
  type: z.literal("cyborg:list_provider_auth"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string(),
});

export const CyborgListProviderAuthResponseSchema = z.object({
  type: z.literal("cyborg:list_provider_auth_response"),
  payload: z.object({
    requestId: z.string(),
    // METADATA ONLY — no key, no token, no access/refresh.
    credentials: z.array(
      z.object({
        providerId: z.string(),
        type: z.enum(["api", "oauth", "wellknown"]),
        expires: z.number().optional(),
      }),
    ),
  }),
});

export const CyborgFetchCybosRequestSchema = z.object({
  type: z.literal("cyborg:fetch_cybos"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgFetchCybosResponseSchema = z.object({
  type: z.literal("cyborg:fetch_cybos_response"),
  payload: z.object({
    requestId: z.string(),
    cybos: z.array(
      z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
        avatar: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        provider: z.string(),
        model: z.string().nullable().optional(),
        // Read path is lenient (display/prefill) — strict enums are enforced on
        // the create/update request schemas, not when echoing stored values back.
        llmAuthMode: z.string().optional(),
        behaviorMode: z.string().optional(),
        homeDaemonId: z.string().nullable().optional(),
        autonomyLevel: z.string().nullable().optional(),
        monthlySpendCap: z.number().nullable().optional(),
        platformPermissions: z.array(z.string()).optional(),
        isDefault: z.boolean(),
        createdAt: z.number(),
        // Provenance of disk cybos: isLocal=true entries can only spawn on
        // their home daemon (daemonId). Absent from older daemons — clients
        // fall back to the previous behavior.
        isLocal: z.boolean().optional(),
        daemonId: z.string().nullable().optional(),
        // epoch ms — max(agent_sessions.updated_at) for this cybo, computed
        // server-side on the PG/relay path. Additive/optional: absent on older
        // daemons and on the SQLite-only path (no session aggregate), and null
        // when the cybo has no sessions. Kept optional + nullable per the
        // never-break-WS-schema rule (packages/server CLAUDE.md).
        lastActiveAt: z.number().nullable().optional(),
      }),
    ),
  }),
});

export const CyborgUpdateCyboRequestSchema = z.object({
  type: z.literal("cyborg:update_cybo"),
  requestId: z.string(),
  workspaceId: z.string(),
  cyboId: z.string(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  avatar: z.string().nullable().optional(),
  role: z.string().max(100).nullable().optional(),
  soul: z.string().min(1).max(50000).optional(),
  provider: z.string().optional(),
  model: z.string().nullable().optional(),
  llmAuthMode: LlmAuthModeSchema.optional(),
  behaviorMode: BehaviorModeSchema.optional(),
  homeDaemonId: z.string().nullable().optional(),
  autonomyLevel: AutonomyLevelSchema.nullable().optional(),
  monthlySpendCap: MonthlySpendCapSchema.optional(),
  platformPermissions: PlatformPermissionsSchema.optional(),
  mcpServers: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const CyborgUpdateCyboResponseSchema = z.object({
  type: z.literal("cyborg:update_cybo_response"),
  payload: z.object({
    requestId: z.string(),
    cybo: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      provider: z.string(),
      model: z.string().nullable().optional(),
    }),
  }),
});

// Single-cybo fetch — the ONLY read path that returns the full `soul`. The list
// (fetch_cybos) omits soul to keep listings light; the editor lazily loads it.
export const CyborgFetchCyboRequestSchema = z.object({
  type: z.literal("cyborg:fetch_cybo"),
  requestId: z.string(),
  workspaceId: z.string(),
  cyboId: z.string(),
});

export const CyborgFetchCyboResponseSchema = z.object({
  type: z.literal("cyborg:fetch_cybo_response"),
  payload: z.object({
    requestId: z.string(),
    cybo: z
      .object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
        avatar: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        provider: z.string(),
        model: z.string().nullable().optional(),
        soul: z.string(),
        mcpServers: z.record(z.string(), z.unknown()).nullable().optional(),
        // Lenient read path (see fetch_cybos_response).
        llmAuthMode: z.string().optional(),
        behaviorMode: z.string().optional(),
        homeDaemonId: z.string().nullable().optional(),
        autonomyLevel: z.string().nullable().optional(),
        monthlySpendCap: z.number().nullable().optional(),
        platformPermissions: z.array(z.string()).optional(),
        isLocal: z.boolean().optional(),
        isDefault: z.boolean(),
        createdAt: z.number(),
      })
      .nullable(),
  }),
});

// Snapshot a local (disk) cybo into the workspace DB — one-way, disk → DB. The
// daemon reads soul.md off disk; the relay forwards this to the owning daemon.
export const CyborgImportCyboRequestSchema = z.object({
  type: z.literal("cyborg:import_cybo"),
  requestId: z.string(),
  workspaceId: z.string(),
  slug: z.string().min(1).max(60),
});

export const CyborgImportCyboResponseSchema = z.object({
  type: z.literal("cyborg:import_cybo_response"),
  payload: z.object({
    requestId: z.string(),
    cybo: z.object({
      id: z.string(),
      slug: z.string(),
      name: z.string(),
      provider: z.string(),
      model: z.string().nullable().optional(),
      isDefault: z.boolean(),
    }),
  }),
});

export const CyborgDeleteCyboRequestSchema = z.object({
  type: z.literal("cyborg:delete_cybo"),
  requestId: z.string(),
  workspaceId: z.string(),
  cyboId: z.string(),
});

export const CyborgDeleteCyboResponseSchema = z.object({
  type: z.literal("cyborg:delete_cybo_response"),
  payload: z.object({
    requestId: z.string(),
    deleted: z.boolean(),
  }),
});

export const CyborgSpawnCyboRequestSchema = z.object({
  type: z.literal("cyborg:spawn_cybo"),
  requestId: z.string(),
  workspaceId: z.string(),
  cyboIdOrSlug: z.string(),
  channelId: z.string().optional(),
  // Optional: when omitted the daemon spawns the cybo in its own sandboxed dir
  // (~/.cybo/agents/<id>) instead of the user's HOME.
  cwd: z.string().optional(),
  daemonId: z.string().optional(),
  // Relay-enriched (cloud): the cybo resolved from PG (StoredCybo shape). A SOLO
  // daemon (no PG) or any daemon whose local SQLite lacks this cybo would otherwise
  // throw "Cybo not found". Kept loose; the daemon casts to StoredCybo.
  resolvedCybo: z.record(z.string(), z.unknown()).optional(),
});

// Cloud cybo-mention invocation: the relay resolved "@cybo" in a channel
// message against the channel's cybo members and forwards spawn+prompt to the
// slash-style-picked daemon. The daemon spawns the cybo EPHEMERAL bound to the
// channel (the /ask machinery) and routes the prompt; failures emit a
// cyborg:cybo_mention_notice broadcast (author-only ephemeral note, P2).
export const CyborgInvokeCyboMentionRequestSchema = z.object({
  type: z.literal("cyborg:invoke_cybo_mention"),
  workspaceId: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  // The mentioning message — dedup key (one invocation per messageId+cyboId).
  // Optional for relays predating the field; those invokes can't be deduped.
  messageId: z.string().optional(),
  cyboId: z.string(),
  prompt: z.string(),
  rawPrompt: z.string().optional(),
  // PG-resolved cybo (StoredCybo shape, kept loose like spawn_cybo's) — the
  // target daemon's SQLite may not have the row.
  resolvedCybo: z.record(z.string(), z.unknown()).optional(),
});

// Tasks Phase 2 (watcher) cloud forward: the relay watched an un-mentioned human
// message in a channel with auto_tasks_enabled, resolved the first online cybo in
// the channel's failover chain, built the watcher prompt, and forwards spawn+prompt
// to that cybo's OWNING daemon. The daemon spawns the cybo EPHEMERAL bound to the
// channel and routes the prompt — identical tail to invoke_cybo_mention. Travels
// as a relay→daemon inner RPC (relay_rpc.inner), NOT a DAEMON_FORWARD_TYPES guest
// op, exactly like cyborg:invoke_cybo_mention (internal docs).
export const CyborgInvokeChannelWatchRequestSchema = z.object({
  type: z.literal("cyborg:invoke_channel_watch"),
  workspaceId: z.string(),
  channelId: z.string(),
  channelName: z.string(),
  // The triggering message — dedup key (one watch spawn per messageId, namespace
  // "watch:<messageId>"). Optional for relays predating the field.
  messageId: z.string().optional(),
  cyboId: z.string(),
  // Pre-built watcher prompt (relay builds it with buildWatcherPrompt and forwards
  // it, so the daemon does not rebuild channel/task context) + the raw human text.
  prompt: z.string(),
  rawPrompt: z.string().optional(),
  // PG-resolved cybo (StoredCybo shape, kept loose like spawn_cybo's) — the
  // target daemon's SQLite may not have the row.
  resolvedCybo: z.record(z.string(), z.unknown()).optional(),
});

export const CyborgSpawnCyboResponseSchema = z.object({
  type: z.literal("cyborg:spawn_cybo_response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    cyboId: z.string(),
    cyboSlug: z.string(),
    provider: z.string(),
    model: z.string().nullable().optional(),
  }),
});

// ─── Schedules (recurring cybo runs) ──────────────────────────────────
// Human-facing CRUD over the schedules already executed by the per-daemon
// ScheduleRunner (internal docs). The clock stays on the daemon; in cloud mode
// the relay forwards writes to the owning daemon and answers list straight from
// the PG mirror. Cron-only in phase 1 (the runner is cron-only).

// A single schedule as the UI sees it (the StoredSchedule row + the cybo's
// display name, resolved server-side so the client needn't join).
export const CyborgScheduleViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  cyboId: z.string(),
  cyboName: z.string().nullable(),
  channelId: z.string().nullable(),
  // Per-task scheduling: the task this schedule fires (run as its assignee cybo,
  // unattended). null = a raw-prompt cybo schedule. Optional so older payloads
  // still validate.
  taskId: z.string().nullable().optional(),
  cron: z.string(),
  timezone: z.string().nullable(),
  prompt: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  // Phase 2 (#619) — all optional so older clients/payloads still validate.
  // maxRuns/runCount expose one-shot lifecycle; catchUp the catch-up policy;
  // stale flags a schedule whose owning daemon is gone (overdue + no live daemon).
  maxRuns: z.number().nullable().optional(),
  runCount: z.number().optional(),
  catchUp: z.boolean().optional(),
  stale: z.boolean().optional(),
  createdBy: z.string(),
  createdAt: z.number(),
});

// One run-history row as the UI sees it (the "Last runs" drawer, #619). Closed-set
// status + skip_reason; epoch-ms timestamps to match the schedule view.
export const CyborgScheduleRunViewSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  scheduledFor: z.number().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  skipReason: z.enum(["license_paused", "overlap", "unauthorized"]).nullable(),
  agentId: z.string().nullable(),
  error: z.string().nullable(),
});

export const CyborgListScheduleRunsRequestSchema = z.object({
  type: z.literal("cyborg:list_schedule_runs"),
  requestId: z.string(),
  workspaceId: z.string(),
  scheduleId: z.string(),
  limit: z.number().int().positive().max(100).optional(),
  daemonId: z.string().optional(),
});

export const CyborgScheduleRunsResponseSchema = z.object({
  type: z.literal("cyborg:schedule_runs_response"),
  payload: z.object({
    requestId: z.string(),
    scheduleId: z.string(),
    runs: z.array(CyborgScheduleRunViewSchema),
  }),
});

export const CyborgCreateScheduleRequestSchema = z.object({
  type: z.literal("cyborg:create_schedule"),
  requestId: z.string(),
  workspaceId: z.string(),
  cyboIdOrSlug: z.string(),
  cron: z.string(),
  prompt: z.string(),
  channelId: z.string().nullable().optional(),
  // Per-task scheduling: bind this schedule to a task (fired as its assignee cybo,
  // unattended). Omitted/null = a raw-prompt cybo schedule (unchanged).
  taskId: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  // Phase 2 (#619) — lifecycle. maxRuns: a positive cap on total fires (1 = a
  // one-shot that deactivates after running); omitted/null = recurring forever.
  // catchUp: false skips a stale schedule to its next future slot instead of
  // firing late (default true). Both optional → unchanged for existing clients.
  maxRuns: z.number().int().positive().nullable().optional(),
  catchUp: z.boolean().optional(),
  // Cloud: target daemon for the schedule. Omitted → relay picks (mention-style).
  daemonId: z.string().optional(),
  // Relay-enriched (cloud), like spawn_cybo: the PG-resolved cybo so a daemon
  // whose SQLite lacks the row can still create the schedule.
  resolvedCybo: z.record(z.string(), z.unknown()).optional(),
});

export const CyborgListSchedulesRequestSchema = z.object({
  type: z.literal("cyborg:list_schedules"),
  requestId: z.string(),
  workspaceId: z.string(),
  // Optional filter: only this cybo's schedules (the editor's Schedule section).
  cyboId: z.string().optional(),
});

export const CyborgUpdateScheduleRequestSchema = z.object({
  type: z.literal("cyborg:update_schedule"),
  requestId: z.string(),
  workspaceId: z.string(),
  scheduleId: z.string(),
  // All optional — only the provided fields change. cron change recomputes next.
  cron: z.string().optional(),
  prompt: z.string().optional(),
  channelId: z.string().nullable().optional(),
  // Per-task scheduling — rebind (or unbind, via null) the schedule's task.
  taskId: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  daemonId: z.string().optional(),
});

// Pause/resume in one RPC: enabled=false pauses, enabled=true resumes.
export const CyborgSetScheduleEnabledRequestSchema = z.object({
  type: z.literal("cyborg:set_schedule_enabled"),
  requestId: z.string(),
  workspaceId: z.string(),
  scheduleId: z.string(),
  enabled: z.boolean(),
  daemonId: z.string().optional(),
});

export const CyborgDeleteScheduleRequestSchema = z.object({
  type: z.literal("cyborg:delete_schedule"),
  requestId: z.string(),
  workspaceId: z.string(),
  scheduleId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgRunScheduleOnceRequestSchema = z.object({
  type: z.literal("cyborg:run_schedule_once"),
  requestId: z.string(),
  workspaceId: z.string(),
  scheduleId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgScheduleListResponseSchema = z.object({
  type: z.literal("cyborg:schedule_list_response"),
  payload: z.object({
    requestId: z.string(),
    schedules: z.array(CyborgScheduleViewSchema),
  }),
});

// Ack for a single schedule mutation (create/update/set_enabled/delete/run_once).
// `schedule` is the resulting row for create/update/set_enabled; null for delete
// and run_once. `ok:false` carries a human-readable error (e.g. offline daemon).
export const CyborgScheduleMutatedResponseSchema = z.object({
  type: z.literal("cyborg:schedule_mutated"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    op: z.enum(["create", "update", "set_enabled", "delete", "run_once"]),
    scheduleId: z.string().nullable(),
    schedule: CyborgScheduleViewSchema.nullable().optional(),
    error: z.string().optional(),
  }),
});

// ─── Scheduled messages (user "send later", #607) ──────────────────────
// A user-facing "send this message later" feature — distinct from the recurring
// cybo `schedules` above (cronExpr automation). create/list/cancel are
// DUAL-ROUTED through dispatcher.ts (local daemon) AND relay-standalone.ts
// (cloud). The closed-set error_code follows the Mattermost ScheduledPost lesson:
// a failed scheduled send is SHOWN, never silently dropped.

// Closed set of failure reasons. Kept in lockstep with the server enums
// (storage.ts / schema.ts) and the UI copy (types.ts).
export const ScheduledMessageErrorCodeSchema = z.enum([
  "channel_archived",
  "no_permission",
  "user_deleted",
  "channel_not_found",
  "unknown_error",
]);

// One scheduled message as the client sees it. Lifecycle is DERIVED from
// processedAt + errorCode (no status enum): pending (processedAt null), sent
// (processedAt set, errorCode null), failed (errorCode non-null).
export const CyborgScheduledMessageViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  // EXACTLY ONE of channelId / toId is set (a channel post vs a DM peer).
  channelId: z.string().nullable(),
  toId: z.string().nullable(),
  fromId: z.string(),
  text: z.string(),
  mentions: z.array(z.string()).nullable(),
  sendAt: z.number(), // epoch ms — when the runner fires it
  processedAt: z.number().nullable(), // null = pending; set = sent or failed
  errorCode: ScheduledMessageErrorCodeSchema.nullable(), // non-null = failed
  createdAt: z.number(),
});

export const CyborgScheduleMessageCreateRequestSchema = z.object({
  type: z.literal("cyborg:schedule_message_create"),
  requestId: z.string(),
  workspaceId: z.string(),
  // EXACTLY ONE of channelId / toId — a channel post or a DM to a peer.
  channelId: z.string().optional(),
  toId: z.string().optional(),
  text: z.string(),
  // Epoch ms; must be in the future (the server re-validates).
  sendAt: z.number(),
  mentions: z.array(z.string()).optional(),
});

export const CyborgScheduleMessageListRequestSchema = z.object({
  type: z.literal("cyborg:schedule_message_list"),
  requestId: z.string(),
  workspaceId: z.string(),
});

export const CyborgScheduleMessageCancelRequestSchema = z.object({
  type: z.literal("cyborg:schedule_message_cancel"),
  requestId: z.string(),
  workspaceId: z.string(),
  id: z.string(),
});

// Create ack: ok + the created row (so the client folds it into the list).
export const CyborgScheduleMessageCreateResponseSchema = z.object({
  type: z.literal("cyborg:schedule_message_create_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    op: z.literal("create"),
    message: CyborgScheduledMessageViewSchema.optional(),
    error: z.string().optional(),
  }),
});

export const CyborgScheduleMessageListResponseSchema = z.object({
  type: z.literal("cyborg:schedule_message_list_response"),
  payload: z.object({
    requestId: z.string(),
    messages: z.array(CyborgScheduledMessageViewSchema),
  }),
});

export const CyborgScheduleMessageCancelResponseSchema = z.object({
  type: z.literal("cyborg:schedule_message_cancel_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    op: z.literal("cancel"),
    id: z.string(),
    error: z.string().optional(),
  }),
});

// Pushed to the author when a scheduled send FAILED at fire time. The payload is
// the updated row (processedAt set, errorCode non-null) so the Scheduled list
// flips pending → failed live. A SUCCESSFUL send arrives as a normal
// channel/dm broadcast (no dedicated event).
export const CyborgScheduleMessageFailedSchema = z.object({
  type: z.literal("cyborg:schedule_message_failed"),
  payload: CyborgScheduledMessageViewSchema,
});

// ─── Outgoing webhooks (Plane-grade, #598) ─────────────────────────────
// Workspace+channel-scoped OUTBOUND webhooks: a message create/edit/delete in
// the channel POSTs a signed event to `url`. These are WORKSPACE-LEVEL config
// (like channels/cybos): the cloud relay authorizes + mutates PG directly (guest
// switch), and the local daemon mirrors via dispatcher.ts. NOT a daemon-forward.
// The signing secret is generated server-side, stored HASHED, and returned to the
// client ONCE on create — never re-shown, never logged.

// Per-event-type enable flags. Absent flag = not delivered (opt-in per event).
export const CyborgWebhookEventFlagsSchema = z.object({
  "message.created": z.boolean().optional(),
  "message.updated": z.boolean().optional(),
  "message.deleted": z.boolean().optional(),
});

// Client-safe view of an outgoing webhook — NEVER carries the secret. epoch-ms
// timestamps. Mirrors StoredOutgoingWebhook in pg-sync.ts.
export const CyborgOutgoingWebhookViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  name: z.string(),
  url: z.string(),
  events: CyborgWebhookEventFlagsSchema,
  isActive: z.boolean(),
  failureCount: z.number(),
  lastTriggeredAt: z.number().nullable(),
  lastSuccessAt: z.number().nullable(),
  lastFailureAt: z.number().nullable(),
  lastError: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const CyborgCreateOutgoingWebhookRequestSchema = z.object({
  type: z.literal("cyborg:create_outgoing_webhook"),
  requestId: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  url: z.string(),
  name: z.string().optional(),
  // Omitted → server default (message.created only).
  events: CyborgWebhookEventFlagsSchema.optional(),
});

export const CyborgUpdateOutgoingWebhookRequestSchema = z.object({
  type: z.literal("cyborg:update_outgoing_webhook"),
  requestId: z.string(),
  workspaceId: z.string(),
  id: z.string(),
  // All optional — only the provided fields change.
  name: z.string().optional(),
  url: z.string().optional(),
  events: CyborgWebhookEventFlagsSchema.optional(),
  isActive: z.boolean().optional(),
  // true → rotate the signing secret (a fresh raw secret is returned ONCE).
  regenerateSecret: z.boolean().optional(),
});

export const CyborgDeleteOutgoingWebhookRequestSchema = z.object({
  type: z.literal("cyborg:delete_outgoing_webhook"),
  requestId: z.string(),
  workspaceId: z.string(),
  id: z.string(),
});

export const CyborgFetchOutgoingWebhooksRequestSchema = z.object({
  type: z.literal("cyborg:fetch_outgoing_webhooks"),
  requestId: z.string(),
  workspaceId: z.string(),
  // Optional filter to one channel's webhooks.
  channelId: z.string().optional(),
});

// Create/update ack. `webhook` is the resulting view; `secret` is the raw signing
// secret, present ONLY on create and on a regenerate (shown to the user once,
// never persisted in plaintext or re-returned). ok:false carries `error`.
export const CyborgOutgoingWebhookMutatedResponseSchema = z.object({
  type: z.literal("cyborg:outgoing_webhook_mutated"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    op: z.enum(["create", "update", "delete"]),
    id: z.string().nullable(),
    webhook: CyborgOutgoingWebhookViewSchema.nullable().optional(),
    secret: z.string().optional(),
    error: z.string().optional(),
  }),
});

export const CyborgFetchOutgoingWebhooksResponseSchema = z.object({
  type: z.literal("cyborg:fetch_outgoing_webhooks_response"),
  payload: z.object({
    requestId: z.string(),
    webhooks: z.array(CyborgOutgoingWebhookViewSchema),
  }),
});

// ─── Prompt templates (#602 — reusable composer snippets) ─────────────
// WORKSPACE-SCOPED CRUD for reusable composer message bodies. A member creates a
// named template; the composer's slash menu lists them as a secondary group and
// inserts the body, which is expanded on SEND (prompt-template-expand.ts).
// Routed relay-side (PG-direct) + in the local dispatcher — NOT a daemon op
// (it's workspace config, like channels). DISTINCT from the scheduler's
// webhooks.prompt_template column.

// Name/body bounds shared by create + update (mirrors the storage TEXT columns
// and the author-time validator's MAX_TEMPLATE_LEN). A name is a stable
// per-workspace handle (unique index); the body is the reusable snippet.
const PROMPT_TEMPLATE_NAME = z.string().min(1).max(100);
const PROMPT_TEMPLATE_BODY = z.string().min(1).max(10_000);

// One prompt template as the client sees it (epoch-ms createdAt; createdBy may be
// null after the author leaves — the row is workspace-owned).
export const CyborgPromptTemplateViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  body: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
});

export const CyborgCreatePromptTemplateRequestSchema = z.object({
  type: z.literal("cyborg:create_prompt_template"),
  requestId: z.string(),
  workspaceId: z.string(),
  name: PROMPT_TEMPLATE_NAME,
  body: PROMPT_TEMPLATE_BODY,
});

export const CyborgUpdatePromptTemplateRequestSchema = z.object({
  type: z.literal("cyborg:update_prompt_template"),
  requestId: z.string(),
  workspaceId: z.string(),
  id: z.string(),
  // Both optional — a rename, a body edit, or both. At least one is required (the
  // handler rejects an empty patch).
  name: PROMPT_TEMPLATE_NAME.optional(),
  body: PROMPT_TEMPLATE_BODY.optional(),
});

export const CyborgDeletePromptTemplateRequestSchema = z.object({
  type: z.literal("cyborg:delete_prompt_template"),
  requestId: z.string(),
  workspaceId: z.string(),
  id: z.string(),
});

export const CyborgListPromptTemplatesRequestSchema = z.object({
  type: z.literal("cyborg:list_prompt_templates"),
  requestId: z.string(),
  workspaceId: z.string(),
});

// Create/update ack: ok + the row (so the client folds it into the list); a name
// clash or validation failure returns ok:false + error.
export const CyborgCreatePromptTemplateResponseSchema = z.object({
  type: z.literal("cyborg:create_prompt_template_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    op: z.literal("create"),
    template: CyborgPromptTemplateViewSchema.optional(),
    error: z.string().optional(),
  }),
});

export const CyborgUpdatePromptTemplateResponseSchema = z.object({
  type: z.literal("cyborg:update_prompt_template_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    op: z.literal("update"),
    template: CyborgPromptTemplateViewSchema.optional(),
    error: z.string().optional(),
  }),
});

export const CyborgDeletePromptTemplateResponseSchema = z.object({
  type: z.literal("cyborg:delete_prompt_template_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    op: z.literal("delete"),
    id: z.string(),
    error: z.string().optional(),
  }),
});

export const CyborgListPromptTemplatesResponseSchema = z.object({
  type: z.literal("cyborg:list_prompt_templates_response"),
  payload: z.object({
    requestId: z.string(),
    templates: z.array(CyborgPromptTemplateViewSchema),
  }),
});

// ─── Slash commands ───────────────────────────────────────────────────

export const CyborgSlashCommandRequestSchema = z.object({
  type: z.literal("cyborg:slash_command"),
  requestId: z.string().optional(),
  workspaceId: z.string(),
  channelId: z.string(),
  // Command keyword without the leading "/", e.g. "summarize".
  trigger: z.string(),
  // Explicitly targeted agents/cybos (for "/ask @a @b ..."). Empty/omitted =
  // let the command resolve its own default target (e.g. the summarizer cybo).
  targets: z.array(z.string()).optional(),
  // Free-text remainder after the trigger (and after any @targets).
  args: z.string().optional(),
  daemonId: z.string().optional(),
  // ── Relay-enriched payload (cloud) ──
  // The cloud relay resolves the channel + recent transcript from PG and embeds
  // them here BEFORE forwarding to the target daemon. A SOLO daemon (no PG) can't
  // see cloud-only channels, so without this it answered "channel not found" /
  // "no recent messages" for every cloud group slash command (the 10-release bug).
  // Absent in solo (no-relay) deployments, where the daemon resolves locally.
  resolvedChannel: z
    .object({
      id: z.string(),
      workspace_id: z.string(),
      name: z.string(),
      // The per-CHANNEL slash model override (channels.slash_command_model, a
      // "provider/model" string). It lives ONLY in PG, so a PG-blind cloud daemon
      // can't read it — the relay forwards it here so the dispatcher honors the
      // channel override (channel > workspace > auto). null/absent = no override.
      slash_command_model: z.string().nullable().optional(),
      // The channel's agent guidelines (channels.instructions — "Guidelines for
      // agents acting in this channel"). Forwarded (length-capped by the relay) so
      // slash-command prompts honor the owner's format/limit rules — a PG-blind
      // cloud daemon can't read them itself. null/absent = none set.
      instructions: z.string().nullable().optional(),
    })
    .optional(),
  // Recent messages, oldest-first (StoredMessage shape from pg.getMessages). Kept
  // loose here — the daemon casts to its StoredMessage row type when formatting.
  resolvedMessages: z.array(z.record(z.string(), z.unknown())).optional(),
  // The workspace's configured slash model (Settings → AI). A SOLO daemon (no PG)
  // can't read workspaces.slash_command_model itself, so the relay forwards it —
  // without this the command auto-resolves to a default (Haiku) and silently
  // ignores the admin's choice. null/absent = no workspace default set.
  workspaceSlashModel: z.object({ provider: z.string(), model: z.string() }).nullable().optional(),
  // /catchup only: the caller's last_read_at (epoch ms) for this channel,
  // resolved by the relay (which has PG) so a PG-blind daemon knows the unread
  // boundary. null = never read (digest from the channel start). For /catchup the
  // relay also fills resolvedMessages with the since-last-read slice (not recent-N).
  catchupSince: z.number().nullable().optional(),
});

export const CyborgSlashCommandResponseSchema = z.object({
  type: z.literal("cyborg:slash_command_response"),
  payload: z.object({
    requestId: z.string().optional(),
    ok: z.boolean(),
    trigger: z.string(),
    // Agent ids the command dispatched a turn to.
    dispatched: z.array(z.string()),
    error: z.string().optional(),
    // Ephemeral notices about clamped/ignored args (e.g. "/summarize 99999").
    // Requester-only, never persisted; absent on clean input and from old daemons.
    warnings: z.array(z.string()).optional(),
  }),
});

// /catchup digest result — EPHEMERAL to the caller (toUserId), rendered
// client-side and NEVER persisted (a personal "what you missed" digest would
// pollute the very channel it summarizes if posted). The relay scopes delivery
// to toUserId, exactly like cyborg:cybo_mention_notice.
export const CyborgCatchupResultSchema = z.object({
  type: z.literal("cyborg:catchup_result"),
  payload: z.object({
    requestId: z.string().optional(),
    toUserId: z.string(),
    workspaceId: z.string(),
    channelId: z.string(),
    channelName: z.string(),
    // ok=false carries an error/empty reason in `text` (e.g. "all caught up").
    ok: z.boolean(),
    // The markdown digest (ok=true) or the human reason (ok=false).
    text: z.string(),
    // How many unread messages were digested (0 when caught up).
    unreadCount: z.number(),
  }),
});

// ─── Auth ─────────────────────────────────────────────────────────────

export const CyborgAuthRequestSchema = z.object({
  type: z.literal("cyborg:auth"),
  token: z.string(),
  requestId: z.string().optional(),
});

// ─── Cybo CLI (PI) status ────────────────────────────────────────────
// Daemon-side probe of the `pi` CLI (Cybos run on PI). Forwarded to the
// owning daemon so the host environment is the one inspected.

export const CyborgCyboCliStatusRequestSchema = z.object({
  type: z.literal("cyborg:cybo_cli_status"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgCyboCliStatusResponseSchema = z.object({
  type: z.literal("cyborg:cybo_cli_status_response"),
  payload: z.object({
    requestId: z.string(),
    installed: z.boolean(),
    version: z.string().nullable().optional(),
    path: z.string().nullable().optional(),
  }),
});

// Install/upgrade the host cybo/PI CLI to the latest on THIS daemon's machine.
export const CyborgCyboCliUpdateRequestSchema = z.object({
  type: z.literal("cyborg:cybo_cli_update"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgCyboCliUpdateResponseSchema = z.object({
  type: z.literal("cyborg:cybo_cli_update_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    installed: z.boolean(),
    version: z.string().nullable().optional(),
    error: z.string().optional(),
    // Exact remedial command for the host's OWNING package manager (pnpm/bun/
    // npm) — the client's "Show command" fallback. Optional: older daemons
    // don't send it; clients keep their npm default.
    command: z.string().optional(),
  }),
});

// On-demand provider re-check on THIS daemon (Settings → Daemon → "Re-check
// providers"). The provider snapshot's verdicts are sticky — a settled
// "unavailable" never re-probes — so this forces a refreshSnapshotForCwd and
// returns the settled statuses, healing a stale snapshot without a restart.
export const CyborgRefreshProvidersRequestSchema = z.object({
  type: z.literal("cyborg:refresh_providers"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgRefreshProvidersResponseSchema = z.object({
  type: z.literal("cyborg:refresh_providers_response"),
  payload: z.object({
    requestId: z.string(),
    providers: z.array(z.object({ provider: z.string(), status: z.string() })),
  }),
});

// Read-only "latest published @cyborg7/cybo version" check via the daemon's npm
// (so it reflects what THIS daemon would install). Drives the "update available?"
// comparison in the UI.
export const CyborgCyboCliLatestRequestSchema = z.object({
  type: z.literal("cyborg:cybo_cli_latest"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgCyboCliLatestResponseSchema = z.object({
  type: z.literal("cyborg:cybo_cli_latest_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    latest: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  }),
});

// ─── Remote daemon update (epic #661 part 2, #663) ──────────────────────────
// Owner-/grant-gated control to run the daemon's own self-update (#662's
// `cyborg daemon update`) from the UI — same shape as the Cybo-runtime update
// trio, but the daemon RESTARTS, so the response is "accepted/restarting" (the
// WS drops mid-update) and the new version surfaces via the next heartbeat.
export const CyborgUpdateDaemonRequestSchema = z.object({
  type: z.literal("cyborg:update_daemon"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgUpdateDaemonResponseSchema = z.object({
  type: z.literal("cyborg:update_daemon_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    // True once the self-update launched and the daemon is restarting; the
    // client then watches for the daemon coming back online with a new version
    // (heartbeat), NOT a synchronous version on this about-to-die socket.
    restarting: z.boolean().optional(),
    error: z.string().optional(),
    // Manual fallback command when the self-update couldn't even launch.
    command: z.string().optional(),
  }),
});

export const CyborgDaemonUpdateLatestRequestSchema = z.object({
  type: z.literal("cyborg:daemon_update_latest"),
  requestId: z.string(),
  workspaceId: z.string(),
  daemonId: z.string().optional(),
});

export const CyborgDaemonUpdateLatestResponseSchema = z.object({
  type: z.literal("cyborg:daemon_update_latest_response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    latest: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
  }),
});

// ─── Unions ──────────────────────────────────────────────────────────

export const CyborgInboundSchemas = [
  CyborgAuthRequestSchema,
  CyborgChannelMessageSchema,
  CyborgDmSchema,
  CyborgTypingSchema,
  CyborgReactionSchema,
  CyborgFetchMessagesRequestSchema,
  CyborgFetchThreadRequestSchema,
  CyborgEditMessageSchema,
  CyborgDeleteMessageSchema,
  CyborgPinMessageSchema,
  CyborgSaveMessageSchema,
  CyborgListSavedRequestSchema,
  CyborgMessageActionSchema,
  CyborgStartTerminalRequestSchema,
  CyborgTerminalInputSchema,
  CyborgTerminalResizeSchema,
  CyborgKillTerminalSchema,
  CyborgSubscribeTerminalSchema,
  CyborgUnsubscribeTerminalSchema,
  CyborgForgetTerminalSchema,
  CyborgListTerminalsRequestSchema,
  CyborgMarkReadSchema,
  CyborgMarkChannelUnreadSchema,
  CyborgFetchUnreadSchema,
  CyborgWorkspaceStatsSchema,
  CyborgFetchActivitySchema,
  CyborgMarkActivityReadSchema,
  CyborgSetNotificationPrefSchema,
  CyborgFetchNotificationPrefsSchema,
  CyborgDraftSetSchema,
  CyborgDraftClearSchema,
  CyborgFetchDraftsSchema,
  CyborgSyncRequestSchema,
  CyborgCreateChannelRequestSchema,
  CyborgCreateGroupDmRequestSchema,
  CyborgFetchChannelsRequestSchema,
  CyborgCreateWorkspaceRequestSchema,
  // update_workspace was missing from this union: the dispatcher has a route
  // case + handler for it, but the WS validation layer rejected it before it
  // got there (unknown_schema), so workspace settings (e.g. trialDismissed)
  // could never be saved in local-daemon mode. Cloud mode worked because the
  // relay handles it in its own switch.
  CyborgUpdateWorkspaceRequestSchema,
  CyborgFetchWorkspacesRequestSchema,
  CyborgInviteMemberRequestSchema,
  CyborgResendInvitationRequestSchema,
  CyborgAcceptInvitationRequestSchema,
  CyborgListPendingInvitationsRequestSchema,
  CyborgCancelInvitationRequestSchema,
  CyborgRemoveMemberRequestSchema,
  CyborgUpdateRoleRequestSchema,
  CyborgCreateTaskRequestSchema,
  CyborgUpdateTaskRequestSchema,
  CyborgFetchTasksRequestSchema,
  CyborgReorderTaskRequestSchema,
  CyborgBulkUpdateTasksRequestSchema,
  CyborgDeleteTaskRequestSchema,
  CyborgArchiveTaskRequestSchema,
  CyborgFetchTasksProjectsRequestSchema,
  CyborgFetchProjectStatesRequestSchema,
  CyborgFetchProjectLabelsRequestSchema,
  CyborgFetchCyclesRequestSchema,
  CyborgFetchModulesRequestSchema,
  CyborgCreateCycleRequestSchema,
  CyborgUpdateCycleRequestSchema,
  CyborgDeleteCycleRequestSchema,
  CyborgFetchPagesRequestSchema,
  CyborgFetchPageRequestSchema,
  CyborgCreatePageRequestSchema,
  CyborgUpdatePageRequestSchema,
  CyborgSetPageArchivedRequestSchema,
  CyborgDeletePageRequestSchema,
  CyborgCreateModuleRequestSchema,
  CyborgUpdateModuleRequestSchema,
  CyborgDeleteModuleRequestSchema,
  CyborgFetchTaskActivityRequestSchema,
  CyborgAddTaskLinkRequestSchema,
  CyborgRemoveTaskLinkRequestSchema,
  CyborgFetchTaskLinksRequestSchema,
  CyborgAddTaskAttachmentRequestSchema,
  CyborgRemoveTaskAttachmentRequestSchema,
  CyborgFetchTaskAttachmentsRequestSchema,
  CyborgCreateAgentRequestSchema,
  CyborgListAgentsRequestSchema,
  CyborgListDaemonSessionsRequestSchema,
  CyborgSendAgentPromptRequestSchema,
  CyborgListProvidersRequestSchema,
  CyborgListMembersRequestSchema,
  CyborgAgentPermissionResponseSchema,
  CyborgCancelAgentSchema,
  CyborgClearAttentionSchema,
  CyborgSetAgentModelSchema,
  CyborgReloadSessionSchema,
  CyborgSetAgentModeSchema,
  CyborgSetAgentThinkingSchema,
  CyborgRewindAgentSchema,
  CyborgListCommandsSchema,
  CyborgDirectorySuggestionsSchema,
  CyborgListDaemonsRequestSchema,
  CyborgSetWorkspaceSlashConfigRequestSchema,
  CyborgGetWorkspaceSlashConfigRequestSchema,
  CyborgSetWorkspaceAutonomyRequestSchema,
  CyborgGetWorkspaceAutonomyRequestSchema,
  CyborgSetSessionAliasRequestSchema,
  CyborgGetSessionAliasesRequestSchema,
  CyborgSetTerminalAliasRequestSchema,
  CyborgGetTerminalAliasesRequestSchema,
  CyborgCreateCyboRequestSchema,
  CyborgSetCyboCredentialRequestSchema,
  CyborgRemoveCyboCredentialRequestSchema,
  CyborgListProviderAuthRequestSchema,
  CyborgFetchCybosRequestSchema,
  CyborgFetchCyboRequestSchema,
  CyborgImportCyboRequestSchema,
  CyborgCyboCliStatusRequestSchema,
  CyborgCyboCliUpdateRequestSchema,
  CyborgCyboCliLatestRequestSchema,
  CyborgUpdateDaemonRequestSchema,
  CyborgDaemonUpdateLatestRequestSchema,
  CyborgRefreshProvidersRequestSchema,
  CyborgUpdateCyboRequestSchema,
  CyborgDeleteCyboRequestSchema,
  CyborgSpawnCyboRequestSchema,
  CyborgCreateScheduleRequestSchema,
  CyborgListSchedulesRequestSchema,
  CyborgUpdateScheduleRequestSchema,
  CyborgSetScheduleEnabledRequestSchema,
  CyborgDeleteScheduleRequestSchema,
  CyborgRunScheduleOnceRequestSchema,
  CyborgListScheduleRunsRequestSchema,
  CyborgScheduleMessageCreateRequestSchema,
  CyborgScheduleMessageListRequestSchema,
  CyborgScheduleMessageCancelRequestSchema,
  CyborgCreateOutgoingWebhookRequestSchema,
  CyborgUpdateOutgoingWebhookRequestSchema,
  CyborgDeleteOutgoingWebhookRequestSchema,
  CyborgFetchOutgoingWebhooksRequestSchema,
  CyborgCreatePromptTemplateRequestSchema,
  CyborgUpdatePromptTemplateRequestSchema,
  CyborgDeletePromptTemplateRequestSchema,
  CyborgListPromptTemplatesRequestSchema,
  CyborgSlashCommandRequestSchema,
  CyborgFetchAgentStateRequestSchema,
  CyborgFetchAgentTimelineRequestSchema,
  CyborgFetchSessionContextRequestSchema,
  CyborgGetPairingInfoSchema,
  CyborgDevTokenRequestSchema,
  CyborgListRecentCwdsRequestSchema,
  CyborgArchiveAgentRequestSchema,
  CyborgListArchivedSessionsRequestSchema,
  CyborgRestoreSessionRequestSchema,
  CyborgImportSessionRequestSchema,
  CyborgCreateProjectRequestSchema,
  CyborgFetchProjectsRequestSchema,
  CyborgUpdateProjectRequestSchema,
  CyborgDeleteProjectRequestSchema,
  CyborgSetChannelProjectRequestSchema,
  CyborgSetChannelAutoTasksRequestSchema,
  CyborgFetchDaemonInfoRequestSchema,
  CyborgGrantDaemonAccessRequestSchema,
  CyborgSetDaemonAccessRequestSchema,
  CyborgRevokeDaemonAccessRequestSchema,
  CyborgFetchDaemonAccessRequestSchema,
  CyborgRequestDaemonAccessRequestSchema,
  CyborgResolveDaemonAccessRequestRequestSchema,
  CyborgFetchDaemonAccessRequestsRequestSchema,
  CyborgRenameDaemonRequestSchema,
  CyborgListDaemonWorkspacesRequestSchema,
  CyborgSetDaemonWorkspaceRequestSchema,
  CyborgDeleteAccountRequestSchema,
  CyborgFetchLicensePoolRequestSchema,
  CyborgAllocateLicenseRequestSchema,
  CyborgDeallocateLicenseRequestSchema,
] as const;

export const CyborgOutboundSchemas = [
  CyborgWorkspaceStatsResponseSchema,
  CyborgChannelMessageBroadcastSchema,
  CyborgDmBroadcastSchema,
  CyborgMessageUnfurledSchema,
  CyborgTypingBroadcastSchema,
  CyborgSlashCommandProgressBroadcastSchema,
  CyborgReactionBroadcastSchema,
  CyborgSaveMessageResponseSchema,
  CyborgSaveMessageBroadcastSchema,
  CyborgListSavedResponseSchema,
  CyborgFetchMessagesResponseSchema,
  CyborgSyncResponseSchema,
  CyborgCreateChannelResponseSchema,
  CyborgCreateGroupDmResponseSchema,
  CyborgFetchChannelsResponseSchema,
  CyborgCreateWorkspaceResponseSchema,
  CyborgFetchWorkspacesResponseSchema,
  CyborgInviteMemberResponseSchema,
  CyborgResendInvitationResponseSchema,
  CyborgAcceptInvitationResponseSchema,
  CyborgListPendingInvitationsResponseSchema,
  CyborgCancelInvitationResponseSchema,
  CyborgRemoveMemberResponseSchema,
  CyborgUpdateRoleResponseSchema,
  CyborgCreateTaskResponseSchema,
  CyborgUpdateTaskResponseSchema,
  CyborgFetchTasksResponseSchema,
  CyborgReorderTaskResponseSchema,
  CyborgBulkUpdateTasksResponseSchema,
  CyborgDeleteTaskResponseSchema,
  CyborgArchiveTaskResponseSchema,
  CyborgFetchTasksProjectsResponseSchema,
  CyborgFetchProjectStatesResponseSchema,
  CyborgFetchProjectLabelsResponseSchema,
  CyborgFetchCyclesResponseSchema,
  CyborgFetchModulesResponseSchema,
  CyborgCreateCycleResponseSchema,
  CyborgUpdateCycleResponseSchema,
  CyborgDeleteCycleResponseSchema,
  CyborgFetchPagesResponseSchema,
  CyborgFetchPageResponseSchema,
  CyborgCreatePageResponseSchema,
  CyborgUpdatePageResponseSchema,
  CyborgSetPageArchivedResponseSchema,
  CyborgDeletePageResponseSchema,
  CyborgCreateModuleResponseSchema,
  CyborgUpdateModuleResponseSchema,
  CyborgDeleteModuleResponseSchema,
  CyborgFetchTaskActivityResponseSchema,
  CyborgAddTaskLinkResponseSchema,
  CyborgRemoveTaskLinkResponseSchema,
  CyborgFetchTaskLinksResponseSchema,
  CyborgAddTaskAttachmentResponseSchema,
  CyborgRemoveTaskAttachmentResponseSchema,
  CyborgFetchTaskAttachmentsResponseSchema,
  CyborgTasksChangedSchema,
  CyborgPagesChangedSchema,
  CyborgCreateAgentResponseSchema,
  CyborgListAgentsResponseSchema,
  CyborgListDaemonSessionsResponseSchema,
  CyborgAgentStreamSchema,
  CyborgAgentStatusSchema,
  CyborgListProvidersResponseSchema,
  CyborgListMembersResponseSchema,
  CyborgSetAgentModelResponseSchema,
  CyborgReloadSessionResponseSchema,
  CyborgSetAgentModeResponseSchema,
  CyborgSetAgentThinkingResponseSchema,
  CyborgRewindAgentResponseSchema,
  CyborgListCommandsResponseSchema,
  CyborgDirectorySuggestionsResponseSchema,
  CyborgListDaemonsResponseSchema,
  CyborgSetWorkspaceSlashConfigResponseSchema,
  CyborgGetWorkspaceSlashConfigResponseSchema,
  CyborgSetWorkspaceAutonomyResponseSchema,
  CyborgGetWorkspaceAutonomyResponseSchema,
  CyborgWorkspaceAutonomyUpdatedSchema,
  CyborgSetSessionAliasResponseSchema,
  CyborgGetSessionAliasesResponseSchema,
  CyborgSetTerminalAliasResponseSchema,
  CyborgGetTerminalAliasesResponseSchema,
  CyborgCreateCyboResponseSchema,
  CyborgSetCyboCredentialResponseSchema,
  CyborgRemoveCyboCredentialResponseSchema,
  CyborgListProviderAuthResponseSchema,
  CyborgFetchCybosResponseSchema,
  CyborgFetchCyboResponseSchema,
  CyborgImportCyboResponseSchema,
  CyborgCyboCliStatusResponseSchema,
  CyborgCyboCliUpdateResponseSchema,
  CyborgCyboCliLatestResponseSchema,
  CyborgUpdateDaemonResponseSchema,
  CyborgDaemonUpdateLatestResponseSchema,
  CyborgRefreshProvidersResponseSchema,
  CyborgUpdateCyboResponseSchema,
  CyborgDeleteCyboResponseSchema,
  CyborgSpawnCyboResponseSchema,
  CyborgScheduleListResponseSchema,
  CyborgScheduleMutatedResponseSchema,
  CyborgScheduleRunsResponseSchema,
  CyborgScheduleMessageCreateResponseSchema,
  CyborgScheduleMessageListResponseSchema,
  CyborgScheduleMessageCancelResponseSchema,
  CyborgScheduleMessageFailedSchema,
  CyborgOutgoingWebhookMutatedResponseSchema,
  CyborgFetchOutgoingWebhooksResponseSchema,
  CyborgCreatePromptTemplateResponseSchema,
  CyborgUpdatePromptTemplateResponseSchema,
  CyborgDeletePromptTemplateResponseSchema,
  CyborgListPromptTemplatesResponseSchema,
  CyborgSlashCommandResponseSchema,
  CyborgFetchAgentStateResponseSchema,
  CyborgFetchAgentTimelineResponseSchema,
  CyborgFetchSessionContextResponseSchema,
  CyborgListRecentCwdsResponseSchema,
  CyborgArchiveAgentResponseSchema,
  CyborgListArchivedSessionsResponseSchema,
  CyborgRestoreSessionResponseSchema,
  CyborgImportSessionResponseSchema,
  CyborgCreateProjectResponseSchema,
  CyborgFetchProjectsResponseSchema,
  CyborgUpdateProjectResponseSchema,
  CyborgDeleteProjectResponseSchema,
  CyborgSetChannelProjectResponseSchema,
  CyborgSetChannelAutoTasksResponseSchema,
  CyborgRequestDaemonAccessResponseSchema,
  CyborgResolveDaemonAccessRequestResponseSchema,
  CyborgFetchDaemonAccessRequestsResponseSchema,
  CyborgDaemonAccessRequestChangedSchema,
  CyborgListDaemonWorkspacesResponseSchema,
  CyborgSetDaemonWorkspaceResponseSchema,
  CyborgDeleteAccountResponseSchema,
  CyborgFetchLicensePoolResponseSchema,
  CyborgAllocateLicenseResponseSchema,
  CyborgDeallocateLicenseResponseSchema,
  CyborgListTerminalsResponseSchema,
  CyborgTerminalsChangedSchema,
  CyborgTerminalAliasChangedSchema,
  CyborgErrorSchema,
] as const;

// Inferred types
export type CyborgChannelMessage = z.infer<typeof CyborgChannelMessageSchema>;
export type CyborgScheduleView = z.infer<typeof CyborgScheduleViewSchema>;
export type CyborgCreateScheduleRequest = z.infer<typeof CyborgCreateScheduleRequestSchema>;
export type CyborgListSchedulesRequest = z.infer<typeof CyborgListSchedulesRequestSchema>;
export type CyborgUpdateScheduleRequest = z.infer<typeof CyborgUpdateScheduleRequestSchema>;
export type CyborgSetScheduleEnabledRequest = z.infer<typeof CyborgSetScheduleEnabledRequestSchema>;
export type CyborgDeleteScheduleRequest = z.infer<typeof CyborgDeleteScheduleRequestSchema>;
export type CyborgRunScheduleOnceRequest = z.infer<typeof CyborgRunScheduleOnceRequestSchema>;
export type CyborgListScheduleRunsRequest = z.infer<typeof CyborgListScheduleRunsRequestSchema>;
export type CyborgScheduleRunView = z.infer<typeof CyborgScheduleRunViewSchema>;
export type ScheduledMessageErrorCode = z.infer<typeof ScheduledMessageErrorCodeSchema>;
export type CyborgScheduledMessageView = z.infer<typeof CyborgScheduledMessageViewSchema>;
export type CyborgScheduleMessageCreateRequest = z.infer<
  typeof CyborgScheduleMessageCreateRequestSchema
>;
export type CyborgScheduleMessageListRequest = z.infer<
  typeof CyborgScheduleMessageListRequestSchema
>;
export type CyborgScheduleMessageCancelRequest = z.infer<
  typeof CyborgScheduleMessageCancelRequestSchema
>;
export type CyborgOutgoingWebhookView = z.infer<typeof CyborgOutgoingWebhookViewSchema>;
export type CyborgCreateOutgoingWebhookRequest = z.infer<
  typeof CyborgCreateOutgoingWebhookRequestSchema
>;
export type CyborgUpdateOutgoingWebhookRequest = z.infer<
  typeof CyborgUpdateOutgoingWebhookRequestSchema
>;
export type CyborgDeleteOutgoingWebhookRequest = z.infer<
  typeof CyborgDeleteOutgoingWebhookRequestSchema
>;
export type CyborgFetchOutgoingWebhooksRequest = z.infer<
  typeof CyborgFetchOutgoingWebhooksRequestSchema
>;
export type CyborgPromptTemplateView = z.infer<typeof CyborgPromptTemplateViewSchema>;
export type CyborgCreatePromptTemplateRequest = z.infer<
  typeof CyborgCreatePromptTemplateRequestSchema
>;
export type CyborgUpdatePromptTemplateRequest = z.infer<
  typeof CyborgUpdatePromptTemplateRequestSchema
>;
export type CyborgDeletePromptTemplateRequest = z.infer<
  typeof CyborgDeletePromptTemplateRequestSchema
>;
export type CyborgListPromptTemplatesRequest = z.infer<
  typeof CyborgListPromptTemplatesRequestSchema
>;
export type CyborgFetchSessionContextRequest = z.infer<
  typeof CyborgFetchSessionContextRequestSchema
>;
export type CyborgFetchSessionContextResponse = z.infer<
  typeof CyborgFetchSessionContextResponseSchema
>;
export type CyborgSessionContextMcpServer = z.infer<typeof CyborgSessionContextMcpServerSchema>;
export type CyborgSlashCommand = z.infer<typeof CyborgSlashCommandRequestSchema>;
export type CyborgDm = z.infer<typeof CyborgDmSchema>;
export type CyborgTyping = z.infer<typeof CyborgTypingSchema>;
export type CyborgReaction = z.infer<typeof CyborgReactionSchema>;
export type CyborgFetchMessagesRequest = z.infer<typeof CyborgFetchMessagesRequestSchema>;
export type CyborgFetchThreadRequest = z.infer<typeof CyborgFetchThreadRequestSchema>;
export type CyborgPinMessage = z.infer<typeof CyborgPinMessageSchema>;
export type CyborgSaveMessage = z.infer<typeof CyborgSaveMessageSchema>;
export type CyborgListSavedRequest = z.infer<typeof CyborgListSavedRequestSchema>;
export type CyborgMessageAction = z.infer<typeof CyborgMessageActionSchema>;
export type CyborgStartTerminalRequest = z.infer<typeof CyborgStartTerminalRequestSchema>;
export type CyborgTerminalInput = z.infer<typeof CyborgTerminalInputSchema>;
export type CyborgTerminalResize = z.infer<typeof CyborgTerminalResizeSchema>;
export type CyborgKillTerminal = z.infer<typeof CyborgKillTerminalSchema>;
export type CyborgSubscribeTerminal = z.infer<typeof CyborgSubscribeTerminalSchema>;
export type CyborgUnsubscribeTerminal = z.infer<typeof CyborgUnsubscribeTerminalSchema>;
export type CyborgForgetTerminal = z.infer<typeof CyborgForgetTerminalSchema>;
export type CyborgListTerminalsRequest = z.infer<typeof CyborgListTerminalsRequestSchema>;
export type CyborgTerminalDirEntry = z.infer<typeof CyborgTerminalDirEntrySchema>;
export type CyborgTerminalsChanged = z.infer<typeof CyborgTerminalsChangedSchema>;
export type CyborgTerminalAliasChanged = z.infer<typeof CyborgTerminalAliasChangedSchema>;
export type CyborgTasksChanged = z.infer<typeof CyborgTasksChangedSchema>;
export type SignedCardAction = z.infer<typeof SignedCardActionSchema>;
export type CyborgEditMessage = z.infer<typeof CyborgEditMessageSchema>;
export type CyborgDeleteMessage = z.infer<typeof CyborgDeleteMessageSchema>;
export type CyborgMarkRead = z.infer<typeof CyborgMarkReadSchema>;
export type CyborgMarkChannelUnread = z.infer<typeof CyborgMarkChannelUnreadSchema>;
export type CyborgFetchUnread = z.infer<typeof CyborgFetchUnreadSchema>;
export type CyborgFetchActivity = z.infer<typeof CyborgFetchActivitySchema>;
export type CyborgSearch = z.infer<typeof CyborgSearchSchema>;
export type CyborgMarkActivityRead = z.infer<typeof CyborgMarkActivityReadSchema>;
export type CyborgSetNotificationPref = z.infer<typeof CyborgSetNotificationPrefSchema>;
export type CyborgFetchNotificationPrefs = z.infer<typeof CyborgFetchNotificationPrefsSchema>;
export type CyborgDraftSet = z.infer<typeof CyborgDraftSetSchema>;
export type CyborgDraftClear = z.infer<typeof CyborgDraftClearSchema>;
export type CyborgFetchDrafts = z.infer<typeof CyborgFetchDraftsSchema>;
export type CyborgSyncRequest = z.infer<typeof CyborgSyncRequestSchema>;
export type CyborgCreateChannelRequest = z.infer<typeof CyborgCreateChannelRequestSchema>;
export type CyborgCreateGroupDmRequest = z.infer<typeof CyborgCreateGroupDmRequestSchema>;
export type CyborgCreateGroupDmResponse = z.infer<typeof CyborgCreateGroupDmResponseSchema>;
export type CyborgFetchChannelsRequest = z.infer<typeof CyborgFetchChannelsRequestSchema>;
export type CyborgCreateWorkspaceRequest = z.infer<typeof CyborgCreateWorkspaceRequestSchema>;
export type CyborgFetchWorkspacesRequest = z.infer<typeof CyborgFetchWorkspacesRequestSchema>;
export type CyborgInviteMemberRequest = z.infer<typeof CyborgInviteMemberRequestSchema>;
export type CyborgResendInvitationRequest = z.infer<typeof CyborgResendInvitationRequestSchema>;
export type CyborgAcceptInvitationRequest = z.infer<typeof CyborgAcceptInvitationRequestSchema>;
export type CyborgListPendingInvitationsRequest = z.infer<
  typeof CyborgListPendingInvitationsRequestSchema
>;
export type CyborgCancelInvitationRequest = z.infer<typeof CyborgCancelInvitationRequestSchema>;
export type CyborgCreateTaskRequest = z.infer<typeof CyborgCreateTaskRequestSchema>;
export type CyborgUpdateTaskRequest = z.infer<typeof CyborgUpdateTaskRequestSchema>;
export type CyborgFetchTasksRequest = z.infer<typeof CyborgFetchTasksRequestSchema>;
export type CyborgReorderTaskRequest = z.infer<typeof CyborgReorderTaskRequestSchema>;
export type CyborgBulkUpdateTasksRequest = z.infer<typeof CyborgBulkUpdateTasksRequestSchema>;
export type CyborgDeleteTaskRequest = z.infer<typeof CyborgDeleteTaskRequestSchema>;
export type CyborgArchiveTaskRequest = z.infer<typeof CyborgArchiveTaskRequestSchema>;
export type CyborgFetchProjectStatesRequest = z.infer<typeof CyborgFetchProjectStatesRequestSchema>;
export type CyborgFetchProjectLabelsRequest = z.infer<typeof CyborgFetchProjectLabelsRequestSchema>;
export type CyborgFetchCyclesRequest = z.infer<typeof CyborgFetchCyclesRequestSchema>;
export type CyborgFetchModulesRequest = z.infer<typeof CyborgFetchModulesRequestSchema>;
export type CyborgCreateCycleRequest = z.infer<typeof CyborgCreateCycleRequestSchema>;
export type CyborgUpdateCycleRequest = z.infer<typeof CyborgUpdateCycleRequestSchema>;
export type CyborgDeleteCycleRequest = z.infer<typeof CyborgDeleteCycleRequestSchema>;
export type CyborgFetchPagesRequest = z.infer<typeof CyborgFetchPagesRequestSchema>;
export type CyborgFetchPageRequest = z.infer<typeof CyborgFetchPageRequestSchema>;
export type CyborgCreatePageRequest = z.infer<typeof CyborgCreatePageRequestSchema>;
export type CyborgUpdatePageRequest = z.infer<typeof CyborgUpdatePageRequestSchema>;
export type CyborgSetPageArchivedRequest = z.infer<typeof CyborgSetPageArchivedRequestSchema>;
export type CyborgDeletePageRequest = z.infer<typeof CyborgDeletePageRequestSchema>;
export type CyborgCreateModuleRequest = z.infer<typeof CyborgCreateModuleRequestSchema>;
export type CyborgUpdateModuleRequest = z.infer<typeof CyborgUpdateModuleRequestSchema>;
export type CyborgDeleteModuleRequest = z.infer<typeof CyborgDeleteModuleRequestSchema>;
export type CyborgFetchTaskActivityRequest = z.infer<typeof CyborgFetchTaskActivityRequestSchema>;
export type CyborgAddTaskLinkRequest = z.infer<typeof CyborgAddTaskLinkRequestSchema>;
export type CyborgRemoveTaskLinkRequest = z.infer<typeof CyborgRemoveTaskLinkRequestSchema>;
export type CyborgFetchTaskLinksRequest = z.infer<typeof CyborgFetchTaskLinksRequestSchema>;
export type CyborgAddTaskAttachmentRequest = z.infer<typeof CyborgAddTaskAttachmentRequestSchema>;
export type CyborgRemoveTaskAttachmentRequest = z.infer<
  typeof CyborgRemoveTaskAttachmentRequestSchema
>;
export type CyborgFetchTaskAttachmentsRequest = z.infer<
  typeof CyborgFetchTaskAttachmentsRequestSchema
>;
export type CyborgFetchLicensePoolRequest = z.infer<typeof CyborgFetchLicensePoolRequestSchema>;
export type CyborgAllocateLicenseRequest = z.infer<typeof CyborgAllocateLicenseRequestSchema>;
export type CyborgDeallocateLicenseRequest = z.infer<typeof CyborgDeallocateLicenseRequestSchema>;
export type CyborgRequestDaemonAccessRequest = z.infer<
  typeof CyborgRequestDaemonAccessRequestSchema
>;
export type CyborgResolveDaemonAccessRequestRequest = z.infer<
  typeof CyborgResolveDaemonAccessRequestRequestSchema
>;
export type CyborgFetchDaemonAccessRequestsRequest = z.infer<
  typeof CyborgFetchDaemonAccessRequestsRequestSchema
>;
// The serialized daemon-access-request row the UI consumes (the wire shape; Dates
// are epoch-ms numbers). serializeDaemonAccessRequest builds this from a DB row.
export type DaemonAccessRequestPayload = z.infer<typeof DaemonAccessRequestPayloadSchema>;

// Convert a daemon_access_requests DB row (Date timestamps) to the wire payload
// (epoch-ms numbers), normalizing scopes/status to the closed enums. Shared by the
// relay + dispatcher so both emit an identical shape. Defensive: unknown scope
// strings are dropped and a non-pending/approved/denied status falls back to
// "pending" (a stored row should never have either, but the wire schema is closed).
export function serializeDaemonAccessRequest(row: {
  id: string;
  workspaceId: string;
  daemonId: string;
  requesterId: string;
  requesterName: string | null;
  scopes: string[];
  status: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}): DaemonAccessRequestPayload {
  const scopes = row.scopes.filter(
    (s): s is "chat" | "spawn" | "terminal" | "admin" =>
      s === "chat" || s === "spawn" || s === "terminal" || s === "admin",
  );
  let status: "pending" | "approved" | "denied" = "pending";
  if (row.status === "approved") status = "approved";
  else if (row.status === "denied") status = "denied";
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    daemonId: row.daemonId,
    requesterId: row.requesterId,
    requesterName: row.requesterName,
    scopes,
    status,
    resolvedBy: row.resolvedBy,
    resolvedAt: row.resolvedAt ? row.resolvedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  };
}

export type CyborgListDaemonSessionsRequest = z.infer<typeof CyborgListDaemonSessionsRequestSchema>;
export type DaemonSessionAuditRow = z.infer<typeof DaemonSessionAuditRowSchema>;

export type CyborgInboundMessage = z.infer<(typeof CyborgInboundSchemas)[number]>;
export type CyborgOutboundMessage = z.infer<(typeof CyborgOutboundSchemas)[number]>;

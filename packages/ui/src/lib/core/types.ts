export interface CyborgUser {
  id: string;
  email: string;
  name: string | null;
  image?: string | null;
  imageUrl?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  avatarUrl: string | null;
  role: "owner" | "admin" | "member" | "viewer";
  settings: WorkspaceSettings;
  createdAt: number;
}

export type ChannelCreatePolicy = "everyone" | "admins" | "owner";

export interface WorkspaceSettings {
  defaultAgentModel?: string;
  maxAgents?: number;
  allowMemberAgentCreation?: boolean;
  agentPermissionMode?: "ask" | "auto";
  agentWorkspaceContext?: string;
  // When false, this workspace's channel-watcher autonomy is off: agents only
  // respond when @-mentioned (the automatic watcher that creates/updates tasks
  // is disabled). Absent/null = on (the default). Owner/admin gated.
  agentAutonomyEnabled?: boolean;
  publicChannelCreatePolicy?: ChannelCreatePolicy;
  privateChannelCreatePolicy?: ChannelCreatePolicy;
  // Hide the trial bar for this workspace. Stored in workspaces.settings jsonb —
  // the server schema is .passthrough(), so no migration or server change needed.
  trialDismissed?: boolean;
}

export interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  instructions: string | null;
  createdBy: string;
  createdAt: number;
  projectId?: string | null;
  // Per-channel override for channel AI commands (/summarize etc.); null/absent =
  // inherit the user's default (then auto-resolve). Optional for older payloads.
  slashCommandModel?: { provider: string; model: string } | null;
  // Soft-delete / archive (P2 #3). Archived channels keep their history but are
  // excluded from the active channel list. Optional so older relay payloads
  // (which omit it) deserialize cleanly as not-archived.
  isArchived?: boolean;
  // Channel kind (#608): "regular" for ordinary channels, "group_dm" for the
  // hidden multi-party DM channels (Mattermost parity). A group_dm lists under
  // the DM section, never in the channel browser/project lists. Optional so
  // older relay payloads (which omit it) deserialize as a regular channel.
  type?: "regular" | "group_dm";
  // Hidden from the channel browser (#608). Group DMs set this true; regular
  // channels stay false. Optional/backward-compatible — older payloads omit it.
  isHidden?: boolean;
  // Per-channel auto-tasks (channel watcher) opt-in switch. When true, a cybo may
  // act autonomously on un-mentioned human chatter; default OFF (opt-in). Optional
  // so older relay payloads (which omit it) deserialize as not-enabled.
  autoTasksEnabled?: boolean;
}

export interface ChannelMember {
  userId: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  joinedAt: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  reacted: boolean;
  reactorNames?: string[];
}

export interface Attachment {
  key: string; // storage key (S3) or synthetic id for inline/dev attachments
  name: string;
  type: string; // MIME type
  size: number;
  url: string; // S3/CloudFront URL, or a data: URL in local/dev mode
  width?: number; // intrinsic pixel width (images AND video)
  height?: number; // intrinsic pixel height (images AND video)
  blurhash?: string;
  // Media (video/audio) metadata — additive, backward-compatible. Older
  // messages simply omit these.
  duration?: number; // media length in SECONDS (video/audio)
  posterKey?: string; // S3 key of a client-generated poster/thumbnail frame (video only)
  poster?: string; // poster URL for delivery (video only)
  // Signed WebP thumbnail variant URLs (M7) — derived at serialization, not
  // stored. BlurHashImage emits a <picture> srcset so the browser picks the
  // smallest variant that fits; falls back to `url` (full-res) if absent/404.
  thumbnails?: { w360?: string; w720?: string; w1080?: string };
}

// ─── URL unfurls / link previews (Tier 2) ───
// Shape mirrors the server `Unfurl` (relay-standalone unfurl engine). Attached
// to a message at serialization (`messages.unfurls` jsonb) and patched live via
// the `cyborg:message_unfurled` broadcast after the relay's async fetch. All
// fields optional/backward-compatible — older messages simply have no unfurls.
export interface UnfurlMedia {
  url: string;
  type: "image" | "video" | "gif";
  width?: number;
  height?: number;
  thumbnail?: string;
}

export interface UnfurlAuthor {
  name?: string;
  handle?: string;
  url?: string;
  avatar?: string;
}

export interface UnfurlGithub {
  kind: "repo" | "pr" | "issue";
  state?: string;
  number?: number;
  stars?: number;
  language?: string;
  owner?: string;
  repo?: string;
  comments?: number;
}

export interface Unfurl {
  url: string;
  platform?: "x" | "youtube" | "vimeo" | "github" | "generic";
  title?: string;
  description?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  siteName?: string;
  favicon?: string;
  type?: "link" | "image" | "video";
  author?: UnfurlAuthor;
  media?: UnfurlMedia[];
  github?: UnfurlGithub;
  publishedAt?: string;
}

// ─── Message cards (structured rich embeds) ───────────────────────────
// A first-class structured card rendered by the client instead of the plain text
// body — Slack-Block-Kit / Discord-embed style. Today the only variant is a
// GitHub release card synthesized by the inbound webhook endpoint. Mirrors the
// server `ReleaseCard` (cyborg/webhook-card.ts).
export interface ReleaseCard {
  kind: "release";
  repo: string;
  repoUrl: string;
  tag: string;
  name: string | null;
  body: string | null;
  url: string;
  prerelease: boolean;
  draft: boolean;
  author: { login: string; avatarUrl: string | null } | null;
  publishedAt: string | null;
}

// State key for an event card's accent; EventCard.svelte maps it to a color
// (GitHub's Primer palette). Mirrors server `CardAccent`.
export type CardAccent =
  | "open"
  | "merged"
  | "closed"
  | "neutral"
  | "success"
  | "failure"
  | "pending";

export interface CardField {
  label: string;
  value: string;
  href?: string | null;
}

// Generic GitHub event card (every non-release event). One shape, rendered by
// EventCard.svelte. Mirrors server `EventCard` (cyborg/webhook-card.ts).
export interface EventCard {
  kind:
    | "pull_request"
    | "pull_request_review"
    | "issues"
    | "push"
    | "workflow_run"
    | "deployment"
    | "generic";
  repo: string;
  repoUrl: string;
  icon: string;
  eventLabel: string;
  accent: CardAccent;
  badge: string | null;
  title: string;
  url: string;
  body: string | null;
  fields: CardField[];
  author: { login: string; avatarUrl: string | null } | null;
  timestamp: string | null;
  // Slack-style actor verb for the header subtitle, e.g. "opened", "merged",
  // "approved". Combined with `author` → "{actorAction} by @login". Mirrors
  // server `EventCard.actorAction`. Null/absent for cards with no actor phrasing.
  actorAction?: string | null;
}

// A signed interactive button on a card (#600). Mirrors server `SignedCardAction`
// (cyborg/webhook-card.ts). `token` is echoed back verbatim via cyborg:message_action;
// `forActor` is a RENDER HINT only (the UI disables the button for other users) —
// authorization is enforced by the token's actor-lock server-side.
export interface SignedCardAction {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  token: string;
  forActor?: string;
}

// In-channel tool-approval card (#600). Mirrors server `ApprovalCard`.
export interface ApprovalCard {
  kind: "approval";
  title: string;
  toolName: string;
  detail: string | null;
  agentName: string | null;
  actions?: SignedCardAction[];
  resolution?: {
    state: "approved" | "denied" | "expired";
    byUserId: string | null;
    byName?: string | null;
    at: number;
  } | null;
}

export type MessageCard = ReleaseCard | EventCard | ApprovalCard;

export interface Message {
  id: string;
  workspaceId?: string;
  channelId: string | null;
  fromId: string;
  fromType: "human" | "agent" | "system";
  fromName?: string;
  toId?: string | null;
  text: string;
  mentions?: string[] | null;
  parentId?: string | null;
  attachments?: Attachment[] | null;
  // Link previews for URLs in `text`. Server-fetched (OG/oEmbed), arrives either
  // inline on the message or live via the cyborg:message_unfurled broadcast.
  unfurls?: Unfurl[] | null;
  // Structured rich card (e.g. a GitHub release card from a webhook). When set,
  // the client renders the card instead of the plain text body.
  card?: MessageCard | null;
  reactions?: Reaction[];
  pinnedAt?: number | null;
  pinnedBy?: string | null;
  // Origin marker: "mcp" for messages posted via the MCP write tools (badge
  // in ChatMessage); absent/null for organic messages.
  source?: string | null;
  // Daemon that produced this message (slash AI result) — shown in the result's
  // profile sheet. Absent for organic messages.
  daemonId?: string | null;
  // Thread metadata (set on top-level messages that have replies).
  replyCount?: number;
  lastReplyAt?: number | null;
  // ─── MESSAGE-RENDER P0: thread-reply indicator ───
  // Distinct thread participants (name + avatar) for the stacked-avatar
  // indicator. Optional — falls back to the plain "N replies" pill when absent.
  threadParticipants?: { name: string; image?: string | null }[] | null;
  updatedAt?: number | null;
  // Soft-deleted tombstone: render "(message deleted)" in place instead of
  // removing it (Mattermost-style). text/reactions are cleared when deleted.
  deleted?: boolean;
  // System-alert discriminator. Set on a "system" message to let the renderer
  // attach a contextual CTA — e.g. "no_daemon_configured" shows a "Configure AI"
  // button linking to Settings → AI. Absent on normal messages.
  alertType?: "no_daemon_configured" | "slash_daemons_offline" | null;
  // Optimistic send lifecycle for the LOCAL author's own messages. Absent on
  // server-originated/reconciled rows. "pending" = optimistic bubble awaiting the
  // server echo; "sent" = reconciled (brief check, then it fades); "failed" = the
  // echo never arrived within the watchdog window, so a Retry affordance shows.
  // Purely a UI marker — never persisted, never sent to the relay.
  sendStatus?: "pending" | "sent" | "failed";
  // Client-generated id (#501) stamped on the optimistic bubble and echoed by the
  // relay on the broadcast, so the echo reconciles to its EXACT optimistic row —
  // disambiguates two identical consecutive sends / a retried send (content match
  // on fromId+text could swap or miss the wrong bubble). Absent from older relays'
  // echoes (reconciliation then falls back to fromId+text). Never persisted.
  clientMsgId?: string | null;
  seq: number;
  createdAt: number;
}

// Plane-style task priority. "none" is the unset default; the four ranked
// levels mirror Plane's board. Kept as a named union so the detail card / board
// can type their pickers against it.
export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

export interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  // Legacy lifecycle mirror. The relay keeps `status` in sync with the
  // workflow state's phase bucket; new code should prefer `stateId`.
  status: string;
  assigneeId: string | null;
  createdBy: string;
  dueAt: number | null;
  result?: string | null;
  // ─── Tasks Redesign (Plane-shaped) readback ─────────────────────────
  // All additive + optional: an old relay (no Plane columns) omits them, and
  // older UI code that only reads the base fields still compiles. The relay's
  // `mapTask` denormalizes these onto every create/update/fetch task payload.
  // Board priority. Absent on legacy rows / older relays.
  priority?: TaskPriority | null;
  // Tasks-project this task belongs to (else workspace Inbox). Null/absent =
  // unassigned/legacy.
  projectId?: string | null;
  // Parent task id when this is a sub-task; null/absent for top-level tasks.
  parentId?: string | null;
  // Workflow state (board column) id; null/absent falls back to `status`.
  stateId?: string | null;
  // Per-workspace monotonic task number (the "#42" badge).
  sequenceId?: number | null;
  // Planned start (epoch ms); null/absent = unset.
  startDate?: number | null;
  // Single sprint bucket id; null/absent = not in a cycle.
  cycleId?: string | null;
  // Label ids assigned to this task (denormalized; empty when none).
  labelIds?: string[];
  // Module ids this task belongs to (denormalized; empty when none).
  moduleIds?: string[];
  // Per-task scheduling — a READ-ONLY summary of the schedule bound to this task
  // (its cron/timezone/enabled/nextRunAt), denormalized by the relay so the board
  // /detail can render a cadence chip without a second round-trip. null/absent when
  // no schedule is bound (or an older relay omits it). The chip is derived from
  // `cronExpr`/`timezone` via cronToLabel; editing a schedule goes through the
  // cyborg:*_schedule RPCs, not this field.
  schedule?: {
    cronExpr: string;
    timezone: string | null;
    enabled: boolean;
    nextRunAt: number | null;
  } | null;
  createdAt: number;
  updatedAt: number;
}

// ─── Tasks Redesign supporting catalog shapes ─────────────────────────
// Per-project metadata referenced by a task's stateId / labelIds / cycleId /
// moduleIds. Field names mirror the server's Drizzle rows (db/schema.ts) so a
// future catalog RPC can return them verbatim. Defined here so the board /
// detail card can type their pickers; the create/update RPCs accept label
// NAMES (auto-created), not ids.

// A workflow state (board column). `group` is the canonical Plane phase bucket.
export interface TaskState {
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  color: string;
  group: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
  sequence: number;
  isDefault: boolean;
}

// A per-project free-form label (tag).
export interface TaskLabel {
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  color: string;
  sortOrder: number;
}

// A sprint bucket. Dates are epoch ms (null when unset).
export interface Cycle {
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  startDate: number | null;
  endDate: number | null;
  ownedBy: string | null;
  sortOrder: number | null;
  archivedAt: number | null;
  createdAt: number;
}

// A project page (wiki/doc): a rich-text document scoped to a project, with
// public/private visibility + archive. All timestamps are epoch ms.
export interface Page {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  content: string; // serialized TipTap JSON, "" = blank
  visibility: "private" | "public";
  icon: string | null; // optional emoji glyph (Plane's page logo); null = none
  ownedBy: string | null;
  archivedAt: number | null; // null = not archived
  parentId: string | null; // null = root-level; otherwise the id of the parent page
  sortOrder: number | null; // position among siblings (ascending; null sorts last)
  createdAt: number;
  updatedAt: number;
}

// A feature grouping (many-to-many bucket of a project's tasks).
export interface Module {
  id: string;
  projectId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  startDate: number | null;
  targetDate: number | null;
  status: string;
  lead: string | null;
  sortOrder: number | null;
  archivedAt: number | null;
}

// A single row in a task's activity feed (the detail card's history). Field names
// mirror the server's Drizzle row (db/schema.ts `taskActivity`). An attribute
// change (`field`/`oldValue`/`newValue`) and a comment (`commentHtml`) are the two
// shapes; the others are null for whichever this row isn't. `epoch` is the
// fractional sort key (ms since epoch) the feed orders by.
export interface TaskActivity {
  id: string;
  taskId: string;
  workspaceId: string;
  actorId: string | null;
  verb: "created" | "updated";
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  commentHtml: string | null;
  epoch: number;
}

// An external link attached to a task (the detail card's "Links" group). Mirrors
// the server's `task_links` row; `title` is the optional display label.
export interface TaskLink {
  id: string;
  taskId: string;
  url: string;
  title: string | null;
  createdBy: string;
  createdAt: number;
}

// A file attachment on a task (the detail card's "Attachments" group). The bytes
// live in S3 (`assetKey`); the client uploads via the presign route, then persists
// this row. `url` is the delivery URL (echoed from the add call / derived from the
// key where S3 is configured). Mirrors the server's `task_attachments` row.
export interface TaskAttachment {
  id: string;
  taskId: string;
  assetKey: string;
  url: string;
  name: string;
  size: number;
  contentType: string | null;
  uploadedBy: string;
  createdAt: number;
}

export interface Membership {
  workspaceId: string;
  userId: string;
  role: string;
  joinedAt: number;
}

// ─── Scheduled messages (#607 — user send-later) ─────────────────────
// A chat message queued to send at a future time. The server stores it and
// fires it at `sendAt`; the UI creates it via cyborg:schedule_message_create,
// lists pending/sent/failed rows via cyborg:schedule_message_list, and cancels
// a pending row via cyborg:schedule_message_cancel. EXACTLY ONE of channelId /
// toId identifies the target (a channel or a DM peer).
//
// Lifecycle (derived from processedAt + errorCode, NOT a status enum):
//   PENDING  processedAt === null
//   SENT     processedAt !== null && errorCode === null
//   FAILED   errorCode !== null  (processedAt is also set at fire time)
// Only PENDING rows are cancelable.
export type ScheduledMessageErrorCode =
  | "channel_archived"
  | "no_permission"
  | "user_deleted"
  | "channel_not_found"
  | "unknown_error";

export interface ScheduledMessage {
  id: string;
  workspaceId: string;
  channelId: string | null;
  toId: string | null;
  fromId: string;
  text: string;
  mentions: string[] | null;
  sendAt: number; // epoch ms — when the server will fire the send
  processedAt: number | null; // null = pending; set = sent or failed
  errorCode: ScheduledMessageErrorCode | null; // non-null = failed
  createdAt: number;
}

// #602 — a reusable composer prompt template. Workspace-scoped, member-authored
// named message body the composer's slash menu lists + inserts. The body may
// contain {channel}/{user}/{date}, expanded server-side on send. Mirrors the
// server's CyborgPromptTemplateView (epoch-ms createdAt; createdBy nullable once
// the author leaves — the row is workspace-owned).
export interface PromptTemplate {
  id: string;
  workspaceId: string;
  name: string;
  body: string;
  createdBy: string | null;
  createdAt: number;
}

export interface WorkspaceMember {
  userId: string;
  email: string;
  name: string | null;
  image?: string | null;
  imageUrl?: string | null;
  role: string;
  membershipType: "active" | "invited";
  joinedAt: number;
}

export interface TypingEvent {
  workspaceId: string;
  channelId: string;
  fromId: string;
  fromName?: string;
  // Present for DM typing: the recipient peer. When set, the event targets a DM
  // surface (in-conversation line + sidebar dots) rather than a channel.
  toId?: string;
  // Thread-typing scope (#11 thread-typing): present when the sender is composing
  // a reply in this root's thread. Routes the indicator to the open thread panel.
  parentId?: string;
}

export interface ReactionEvent {
  workspaceId: string;
  messageId: string;
  fromId: string;
  fromName?: string;
  emoji: string;
  action?: "added" | "removed";
}

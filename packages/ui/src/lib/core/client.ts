import type {
  Workspace,
  WorkspaceSettings,
  Channel,
  Message,
  Attachment,
  Task,
  TaskPriority,
  TaskState,
  TaskLabel,
  Cycle,
  Page,
  Module,
  TaskActivity,
  Membership,
  TypingEvent,
  ReactionEvent,
  WorkspaceMember,
  ScheduledMessage,
  PromptTemplate,
} from "./types.js";
export interface ThreadSummary {
  root: Message | null;
  replyCount: number;
  lastReplyAt: number;
  participants: string[];
  unreadReplies: number;
  unreadMentions: number;
}

// The relay's `mapTask` readback (relay-standalone). Legacy fields come back
// camelCase, but the Tasks Redesign (Plane-shaped) projection rides along in
// snake_case (project_id / parent_id / state_id / sequence_id / cycle_id /
// label_ids / module_ids). `mapRawTask` normalizes those onto the camelCase
// `Task` model so callers never see two casings. All Plane fields are optional —
// an old relay omits them entirely.
type RawTask = Task & {
  project_id?: string | null;
  parent_id?: string | null;
  state_id?: string | null;
  sequence_id?: number | null;
  cycle_id?: string | null;
  label_ids?: string[];
  module_ids?: string[];
};

function mapRawTask(t: RawTask): Task {
  // Pull `schedule` out of `rest` so it is NOT spread blindly: a partial broadcast
  // (reorder/recurrence-spawn `{ id }`, or any path that omits the field) must not
  // carry an explicit `schedule: undefined`/`null` that the app merge would use to
  // blank an existing cadence chip. We only emit `schedule` when the relay actually
  // sent one (defense in depth alongside the server denormalize on the edit paths).
  const {
    project_id,
    parent_id,
    state_id,
    sequence_id,
    cycle_id,
    label_ids,
    module_ids,
    schedule,
    ...rest
  } = t;
  const mapped: Task = {
    ...rest,
    // Prefer the snake_case readback; fall back to any camelCase the relay
    // already supplied so this stays robust to a future relay that emits both.
    projectId: project_id ?? rest.projectId ?? null,
    parentId: parent_id ?? rest.parentId ?? null,
    stateId: state_id ?? rest.stateId ?? null,
    sequenceId: sequence_id ?? rest.sequenceId ?? null,
    cycleId: cycle_id ?? rest.cycleId ?? null,
    labelIds: label_ids ?? rest.labelIds ?? [],
    moduleIds: module_ids ?? rest.moduleIds ?? [],
  };
  // Per-task scheduling — set `schedule` whenever the relay actually sent the field
  // (including an explicit `null`, which signals a detached schedule and must clear
  // the chip). Only an OMITTED field (`undefined`, a partial broadcast that carried
  // no schedule) is dropped, so the merge in app.svelte.ts can't blank a live chip.
  if (schedule !== undefined) mapped.schedule = schedule;
  return mapped;
}

export interface McpToken {
  id: string;
  name: string;
  identityType: string;
  identityId: string;
  scopes: string[];
  enabled: boolean;
  lastUsedAt: number | null;
  createdAt: number;
}

// ─── Webhooks (inbound, GitHub-style config) ─────────────────────────

export interface Webhook {
  id: string;
  channelId: string;
  workspaceId: string;
  name: string;
  // Whether a signing secret is set — the value itself is never returned.
  hasSecret: boolean;
  contentType: string;
  // "release" (only release events) | "all" (everything) | "select" (allowlist).
  eventMode: string;
  events: string[];
  active: boolean;
  createdBy: string;
  lastDeliveryAt: number | null;
  createdAt: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  channelId: string;
  event: string | null;
  action: string | null;
  requestHeaders: Record<string, string> | null;
  requestBody: string | null;
  responseStatus: number;
  responseBody: string | null;
  ok: boolean;
  redeliveredFrom: string | null;
  createdAt: number;
}

export interface McpListResponse {
  enabled: boolean;
  tokens: McpToken[];
  connectionUrl: string | null;
  identities: {
    self: { id: string; name: string } | null;
    cybos: Array<{ id: string; name: string }>;
  };
}

// The serialized daemon-access-request row the UI consumes (#705 REQUEST →
// NOTIFY → APPROVE). createdAt/resolvedAt are epoch-ms numbers (the server
// serializes Date columns to numbers on the wire). Mirrors the server's
// DaemonAccessRequestPayload (cyborg-messages.ts).
export interface DaemonAccessRequestView {
  id: string;
  workspaceId: string;
  daemonId: string;
  requesterId: string;
  requesterName: string | null;
  scopes: Array<"chat" | "spawn" | "terminal" | "admin">;
  status: "pending" | "approved" | "denied";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
}

export interface SlackEventMap {
  channel_message: Message;
  dm: Message;
  // Author-only ephemeral notice about a cybo @-mention that couldn't invoke
  // (not a channel member / no runnable daemon / spawn failed). Rendered as a
  // LOCAL system note in the channel — never persisted.
  cybo_mention_notice: {
    toUserId: string;
    workspaceId: string;
    channelId: string;
    text: string;
  };
  // /catchup digest — personal ephemeral result, scoped to the caller (toUserId).
  // Rendered client-side (a sheet), NEVER persisted. ok=false → `text` is a
  // human reason ("all caught up" / an error); unreadCount=0 when caught up.
  catchup_result: {
    requestId?: string;
    toUserId: string;
    workspaceId: string;
    channelId: string;
    channelName: string;
    ok: boolean;
    text: string;
    unreadCount: number;
  };
  typing: TypingEvent;
  reaction: ReactionEvent;
  delete_message: { messageId: string; workspaceId: string };
  edit_message: { messageId: string; workspaceId: string; text: string };
  pin_message: {
    messageId: string;
    channelId: string;
    workspaceId: string;
    pinnedAt: number | null;
    pinnedBy: string | null;
  };
  read: {
    workspaceId: string;
    channelId?: string;
    dmPeerId?: string;
    lastReadAt: number;
  };
  activity_new: {
    id: string;
    workspaceId: string;
    eventType: string;
    // 'message' | 'task' | 'daemon' (free text). Lets the live handler route a
    // task notification into the feed by source kind, not just by eventType.
    sourceType?: string;
    sourceId: string;
    channelId: string | null;
    previewText: string | null;
    actorId: string | null;
    actorName: string | null;
    createdAt: number;
  };
  // Live push (#705 REQUEST → NOTIFY → APPROVE): a daemon-access request was
  // created (→ owner) or resolved (→ requester). The payload IS the serialized
  // request row the inbox renders. Pushed per-user, not workspace-wide.
  daemon_access_request_changed: { request: DaemonAccessRequestView };
  notification_pref_changed: { workspaceId: string; scopeId: string; preference: string };
  // Server-side draft sync (#610): a composer draft created/updated/cleared on
  // the user's OTHER device. text === null means it was sent or cleared there.
  draft_changed: { workspaceId: string; scope: string; text: string | null; updatedAt: number };
  members_updated: { workspaceId: string; members: WorkspaceMember[] };
  // Agent autonomy was toggled by an owner/admin → patch the workspace's
  // settings.agentAutonomyEnabled live so the toggle reflects across devices.
  workspace_autonomy_updated: { workspaceId: string; enabled: boolean };
  // A task was created, updated, or deleted server-side → patch the board live.
  // Carries the full row so a client can upsert it (created/updated) or drop it
  // (deleted) from workspaceState.tasks without a refetch (the relay fans this out
  // to every member of the workspace).
  tasks_changed: { workspaceId: string; op: "created" | "updated" | "deleted"; task: Task };
  // A page was created/updated/archived/deleted server-side → workspace members
  // with an open pages view refetch. The full row rides along (created/updated);
  // a "deleted" op sends only `{ id }`. The list view's own refetch hooks in.
  pages_changed: {
    workspaceId: string;
    projectId: string;
    op: "created" | "updated" | "deleted";
    page: Partial<Page> & { id: string };
  };
  daemon_status: { daemonId: string; status: "online" | "offline" };
  channel_created: { channel: Channel };
  // #608: a group DM was created → add it to the sidebar's DM section, but ONLY
  // for its members (a hidden channel must never surface for a non-member).
  // memberIds is the authoritative member list (creator + participants).
  group_dm_created: { channel: Channel; memberIds: string[] };
  channel_updated: { channel: Channel };
  channel_deleted: { channelId: string; workspaceId: string };
  channel_member_added: { channelId: string; userId: string; workspaceId: string };
  channel_member_removed: { channelId: string; userId: string; workspaceId: string };
  channel_cybo_added: { channelId: string; cyboId: string; workspaceId: string };
  channel_cybo_removed: { channelId: string; cyboId: string; workspaceId: string };
  // #640: a cybo's editable display fields changed → patch the workspace roster.
  cybo_updated: {
    cybo: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      avatar: string | null;
      role: string | null;
      provider: string;
      model: string | null;
      // #636: provider readiness, recomputed against the post-edit provider.
      readiness?: "ready" | "needs-daemon" | "created";
    };
  };
  // #644: a cybo was created → append it to the workspace roster live.
  cybo_created: {
    cybo: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      avatar: string | null;
      role: string | null;
      provider: string;
      model: string | null;
      isDefault: boolean;
      createdAt: number;
      // #636: provider readiness at creation time ("needs-daemon" if nothing
      // reachable can run it yet — surfaced as a banner, never blocked).
      readiness?: "ready" | "needs-daemon" | "created";
    };
  };
  // #644: a cybo was deleted → drop it from the workspace roster live.
  cybo_deleted: { cyboId: string };
  thread_updated: {
    toUserId: string;
    rootId: string;
    channelId: string | null;
    unread_replies: number;
    unread_mentions: number;
    previous_unread_replies: number;
    previous_unread_mentions: number;
    last_reply_at: number;
  };
  thread_read_changed: {
    toUserId: string;
    rootId: string;
    unread_replies: number;
    unread_mentions: number;
    previous_unread_replies: number;
    previous_unread_mentions: number;
  };
  thread_follow_changed: { toUserId: string; rootId: string; following: boolean };
  // A scheduled message (#607) FAILED at fire time. The payload is the updated
  // row (processedAt set, errorCode non-null) so the Scheduled list flips it from
  // pending → failed live. Successful sends arrive as a normal channel/dm
  // broadcast (no dedicated event); a re-list reflects the processedAt change.
  schedule_message_failed: ScheduledMessage;
  // A recurring cybo schedule (#619) was mutated (created/updated/enabled/deleted/
  // run-once) — possibly by another client or the runner. The relay fans the
  // `cyborg:schedule_mutated` ack out without a requestId so every open board
  // stays live. Structurally matches ws-client's ScheduleMutatedPayload; kept as
  // a record here so core/ stays free of the cyborg schedule types.
  schedule_mutated: {
    requestId?: string;
    ok: boolean;
    op: string;
    scheduleId: string | null;
    schedule?: Record<string, unknown> | null;
    error?: string;
  };
  // The relay announced a planned restart (deploy). The socket will drop
  // shortly — the UI shows "Updating…" and reconnects quietly.
  server_shutdown: { reason?: string; etaMs?: number };
  error: { requestId?: string; code: string; message: string };
  // `attempt`/`delayMs` are present only on a "reconnecting" emit from
  // scheduleReconnect — they drive the banner's "attempt N · retrying in Ns" copy.
  connection: {
    status: "connected" | "disconnected" | "reconnecting";
    attempt?: number;
    delayMs?: number;
  };
  // HARD-PAUSE gate fired on a fire-and-forget path (the guest agent-prompt
  // send carries no requestId, so it can't reject a pending RPC). The relay
  // emits a top-level `guest_error` with error:'license_required'; the app
  // opens the activate modal in response.
  license_required: { message: string; license?: LicensePayload };
  // A hole was detected in the per-workspace broadcast sequence on an OPEN socket
  // (#499): an incoming broadcast's seq jumped past expected, so events were lost
  // between relay instances or on a flaky link WITHOUT the socket dropping. The
  // app responds with a bounded catch-up (drainSync + DM since-drain) from
  // `fromSeq`, recovering the gap without waiting for a reconnect/foreground.
  seq_gap: { workspaceId: string; fromSeq: number };
}

// Connecting/authenticating can fail two ways that demand OPPOSITE responses:
//  - AuthError: the token is bad/expired → clear the session and send the user
//    to login.
//  - NetworkError: the relay is unreachable (down, deploying, offline) → KEEP
//    the session, stay in the app, show "reconnecting", and retry. Treating a
//    transient relay outage as an auth failure is what logged users out on
//    every deploy.
export class AuthError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}
export class NetworkError extends Error {
  constructor(message = "relay unreachable") {
    super(message);
    this.name = "NetworkError";
  }
}

// Server-authoritative license payload (mirror of PgSync.getLicenseStatus).
// Carried on the cyborg:error / guest_error `license_required` rejection so the
// UI can re-seed the trial bar and open the activate modal from the same event.
export interface LicensePayload {
  state: "trialing" | "active" | "paused";
  plan: string;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  status: string | null;
}

// Server-computed billing intent (mirror of PgSync.getBillingIntent →
// resolveBillingIntent). Returned alongside the license from fetchLicense; tells
// the client WHICH billing action to offer on the caller's surface + the copy.
// Keep BillingActionPayload in lockstep with the server BillingAction union.
export type BillingActionPayload =
  | "stripe_checkout"
  | "stripe_portal"
  | "iap_purchase"
  | "iap_manage"
  | "manage_on_web"
  | "manage_in_mobile"
  | "contact_admin"
  | "owner_only";

// The caller's surface, sent to the relay so it can resolve the right intent
// (web/desktop = Stripe rail, ios/android = IAP rail). Mirror of the server
// BillingPlatform union.
export type BillingPlatformPayload = "web" | "desktop" | "ios" | "android";

export interface BillingIntentPayload {
  action: BillingActionPayload;
  title: string;
  message: string;
  ctaLabel?: string;
}

// Thrown when an agent op (create/run/spawn) is rejected because the workspace's
// trial ended with no active subscription (HARD-PAUSE gate). The UI catches this
// to open the activate modal instead of surfacing a raw error string.
export class LicenseRequiredError extends Error {
  readonly code = "license_required";
  readonly license?: LicensePayload;
  constructor(message: string, license?: LicensePayload) {
    super(message);
    this.name = "LicenseRequiredError";
    this.license = license;
  }
}

// Thrown when a cybo can't start because its backend (e.g. anthropic) is
// unavailable on the daemon. Carries the daemon's CLASSIFIED reason so the UI
// shows the exact remedy (add usage / reconnect with an API key) instead of a
// generic "needs X". `reasonKind` is kept a loose string here to avoid a
// plugins->core import; the UI casts it to ProviderReasonKind for the mapper.
export class ProviderUnavailableError extends Error {
  readonly code = "unavailable";
  readonly backend?: string;
  readonly reasonKind?: string;
  readonly unavailableReason?: string;
  constructor(
    message: string,
    opts?: { backend?: string; reasonKind?: string; unavailableReason?: string },
  ) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.backend = opts?.backend;
    this.reasonKind = opts?.reasonKind;
    this.unavailableReason = opts?.unavailableReason;
  }
}

// Hard ceiling on attachment size, mirrored on the relay (MAX_ATTACHMENT_BYTES
// in relay-standalone.ts). Guarded client-side before upload so an oversized
// file fails fast with a clear message instead of a slow upload + server reject.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

// Public (unauthenticated) invitation preview shown on the /invite/:token
// landing page. The relay answers GET /api/invite/:token with this shape so the
// page can render the workspace name + status before any login/connect.
export interface PublicInvitePreview {
  workspace: { id: string; name: string } | null;
  invitedEmail: string | null;
  status: "pending" | "accepted" | "expired" | "invalid";
  expiresAt: number | null;
}

// Derive the relay's HTTP(S) origin from a saved-session WS url:
//   ws(s)://host[/api/ws] → http(s)://host
// Used by the unauthenticated invite landing page, which has the saved session's
// ws url but no live (authenticated) client yet.
export function relayHttpBaseFromWsUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/api\/ws\/?$/, "")
    .replace(/\/ws\/?$/, "");
}

// Fetch the public invitation preview for the /invite/:token landing page. No
// auth — the relay route is intentionally unauthenticated so an invitee who
// isn't signed in yet can still see what they were invited to.
export async function fetchInvitePreview(
  wsUrl: string,
  token: string,
): Promise<PublicInvitePreview> {
  const base = relayHttpBaseFromWsUrl(wsUrl);
  const resp = await fetch(`${base}/api/invite/${encodeURIComponent(token)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<PublicInvitePreview>;
}

type EventHandler<T> = (data: T) => void;

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Workspace-level slash-command config (the AI settings tab). The CONTRACT W2's
// server endpoints must honour:
//   slashCommandsEnabled — global on/off for the whole workspace. When false,
//                          the composer must not process slash commands in any
//                          channel (persist as `workspaces.slash_commands_enabled`).
//   defaultDaemonId   — the workspace default daemon for slash commands
//   fallbackDaemonIds — ordered fallbacks, tried in order when the default is
//                       offline/inaccessible
//   model             — workspace default model for channel AI commands
//                       (null = auto-resolve, the zero-config default)
// Mutations are owner/admin-only and the server must enforce that.
export interface WorkspaceSlashConfig {
  slashCommandsEnabled: boolean;
  defaultDaemonId: string | null;
  fallbackDaemonIds: string[];
  model: { provider: string; model: string } | null;
}

// The server's flat wire shape (3 workspace columns). The client methods map
// to/from WorkspaceSlashConfig so callers never see this.
interface ServerWorkspaceSlashConfig {
  defaultSlashDaemonId: string | null;
  fallbackDaemons: string[];
  model: { provider: string; model: string } | null;
}

/**
 * Reconnect backoff delay with FULL JITTER (AWS "Exponential Backoff And Jitter").
 *
 * The base envelope is the capped exponential `min(1000 * 2**attempt, 30_000)`;
 * full jitter then picks a uniformly-random point in `[0, envelope]`. Without
 * jitter every client that dropped on the same relay deploy (`server_shutdown`)
 * retries in lockstep — 1s, 2s, 4s, 8s… — slamming the just-restarted
 * single-process cloud relay in a synchronized thundering herd (#504). Spreading
 * each client across its own window de-synchronizes the herd while preserving
 * the same exponential growth of the upper bound.
 *
 * Pure (the caller injects `rand`) so the envelope and bounds are unit-testable.
 *
 * @param attempt 0-based reconnect attempt count.
 * @param rand    RNG returning [0, 1); defaults to Math.random.
 */
export function reconnectBackoffMs(attempt: number, rand: () => number = Math.random): number {
  // Cap the exponent at 5 (1000 * 2**5 = 32_000 already exceeds the 30_000 cap):
  // mathematically identical for every attempt, but avoids 2**attempt blowing up
  // to Infinity on a long-lived client (maxReconnectAttempts is unbounded).
  const envelope = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
  return Math.round(rand() * envelope);
}

function fromServerSlashConfig(c: ServerWorkspaceSlashConfig): WorkspaceSlashConfig {
  return {
    slashCommandsEnabled: true,
    defaultDaemonId: c.defaultSlashDaemonId,
    fallbackDaemonIds: c.fallbackDaemons ?? [],
    model: c.model,
  };
}

export class SlackClient<EventMap extends SlackEventMap = SlackEventMap> {
  private ws: WebSocket | null = null;
  private url = "";
  private token = "";
  private listeners = new Map<string, Set<EventHandler<unknown>>>();
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  // No give-up cap: a mobile client can be backgrounded for a long time, and we
  // want it to keep retrying (the backoff is capped at 30s in scheduleReconnect)
  // so it reconnects whenever the network/app returns, instead of going
  // permanently "disconnected" after a handful of tries.
  private maxReconnectAttempts = Number.POSITIVE_INFINITY;
  private intentionalClose = false;
  protected requestTimeoutMs = 15_000;
  // A WebSocket can sit in CONNECTING indefinitely when the TCP/TLS/HTTP-upgrade
  // handshake stalls (relay cold start, load-balancer drain, flaky network) —
  // neither `open` nor `error` ever fires. doConnect() bounds the wait with this
  // timeout so it can never hang forever; without it a stalled first connect left
  // connectToServer()/handleReconnect awaiting indefinitely and the UI stuck on a
  // spinner with NO error until a manual reload (the signup verify-then-hang bug).
  protected connectTimeoutMs = 15_000;
  // Transport-level liveness heartbeat (#503). A half-open / zombie socket
  // (proxy idle-timeout, NAT/VPN drop, sleep-wake, relay redeploy whose FIN never
  // arrives) can read OPEN forever without firing `close`, so neither the close
  // handler nor scheduleReconnect() ever runs and the client is "online to
  // itself, offline to everyone else". The heartbeat pings every interval and,
  // on a missed pong, closes the socket so the close handler reconnects. It runs
  // for the LIFE OF THE CONNECTION — not foreground-gated — so a backgrounded-
  // but-open desktop/web tab recovers too (on mobile the OS suspends the timer
  // while backgrounded, so a frozen socket is never pinged; the foreground hook
  // covers resume).
  private static readonly HEARTBEAT_INTERVAL_MS = 30_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 10_000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
  // Highest per-workspace broadcast seq observed on THIS connection (#499). Used
  // to detect a forward gap (lost broadcast on an open socket). Cleared on close
  // so a reconnect re-seeds from the first live event after drainSync has already
  // caught history up — avoiding a spurious gap at the reconnect boundary.
  //
  // The relay's seq is a per-workspace GLOBAL counter shared by channel messages
  // (fanned out workspace-wide → dense for every client) AND DMs (delivered only
  // to participants → a DM between OTHER users consumes a seq this client never
  // receives). So a forward "gap" is NOT always a real loss; the app coalesces /
  // rate-limits the resulting catch-up (it's idempotent + dedups, so a false
  // positive only costs one bounded sync RPC).
  private broadcastSeqs = new Map<string, number>();
  // Auth gate. A freshly-opened socket is unauthenticated until cyborg:auth
  // succeeds on it. The relay SILENTLY DROPS any non-auth RPC on an
  // unauthenticated socket (no response), so an RPC that races the
  // post-reconnect auth would hang for requestTimeoutMs and leave the view
  // permanently empty until a manual reload. request() therefore gates every
  // non-auth RPC on this flag, not just on the socket being OPEN.
  // Public so fire-and-forget senders (sendMessage/sendDm in app.svelte.ts) can
  // check it before a raw send — an open-but-unauthenticated socket would
  // otherwise accept the send and have the relay silently drop it.
  public authenticated = false;
  private authWaiters = new Set<{ resolve: () => void; reject: (err: Error) => void }>();

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(url: string, token: string): Promise<void> {
    if (this.ws) {
      this.intentionalClose = true;
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.url = url;
    this.token = token;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    return this.doConnect();
  }

  async authenticate(): Promise<{
    user: { id: string; email: string; name: string | null; imageUrl?: string | null };
    workspaces: { id: string; name: string; avatarUrl: string | null; role: string }[];
  }> {
    const resp = await this.request<{
      user: { id: string; email: string; name: string | null; imageUrl?: string | null };
      workspaces: { id: string; name: string; avatarUrl: string | null; role: string }[];
    }>("cyborg:auth", { token: this.token });
    // Socket is now authenticated — release any RPCs parked in waitForAuth.
    this.authenticated = true;
    for (const w of this.authWaiters) w.resolve();
    this.authWaiters.clear();
    return resp;
  }

  // Presence auto-heal (Part B): a lightweight liveness ping. Sends `cyborg:ping`
  // and resolves `true` if ANY round-trip response with the matching requestId
  // arrives within `timeoutMs` — INCLUDING a `cyborg:error` (an error reply still
  // proves the socket is alive, which keeps this backward-compatible with relays
  // that don't recognize `cyborg:ping`). Resolves `false` only on timeout or when
  // not connected. Unlike request(), it does NOT wait for auth and does NOT
  // reject on an error response — both error and success count as "alive".
  ping(timeoutMs: number): Promise<boolean> {
    if (!this.connected) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const requestId = `ping_${++this.requestCounter}_${Date.now()}`;
      let settled = false;
      const done = (alive: boolean) => {
        if (settled) return;
        settled = true;
        this.pendingRequests.delete(requestId);
        resolve(alive);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      // Any RELAY response keyed by this requestId — resolve/reject alike —
      // proves the socket round-trips. handleMessage() calls resolve() for a pong
      // and reject() for a cyborg:error; both count as "alive". The one exception
      // is disconnect(), which rejects pending requests with "Client disconnected"
      // during an intentional teardown — that torn-down socket is NOT alive.
      this.pendingRequests.set(requestId, {
        resolve: () => done(true),
        // A relay error round-trip still proves the socket is alive → true. But
        // disconnect() rejects all pending requests with "Client disconnected"
        // during an intentional teardown — that is NOT a live socket, so report
        // false in that one case (the literal must match disconnect()).
        reject: (err) => done(err?.message !== "Client disconnected"),
        timer,
      });
      try {
        this.send({ type: "cyborg:ping", requestId });
      } catch {
        // Socket went down between the connected check and the send — not alive.
        clearTimeout(timer);
        done(false);
      }
    });
  }

  async setProfileImage(imageUrl: string | null): Promise<void> {
    await this.request("cyborg:set_profile_image", { imageUrl });
  }

  async setProfileName(name: string): Promise<void> {
    await this.request("cyborg:set_profile_name", { name });
  }

  // Native mobile push: register/unregister this device's FCM token with the
  // relay so it can deliver push to the phone when the user is offline.
  async registerFcmToken(token: string, platform: string, deviceName?: string): Promise<void> {
    await this.request("cyborg:fcm_register", { token, platform, deviceName });
  }

  async unregisterFcmToken(token: string): Promise<void> {
    await this.request("cyborg:fcm_unregister", { token });
  }

  // Tell the relay whether this client is foregrounded or backgrounded. A mobile
  // OS keeps the WebSocket nominally OPEN while the app is suspended, so the relay
  // would otherwise count the user as "active" and SKIP the push (it only pushes
  // to non-active users). Flagging "background" makes the relay deliver the push
  // the frozen socket can't. Fire-and-forget.
  setAppState(state: "active" | "background"): void {
    // Guard: send() throws "Not connected" on a closed/connecting socket. Skip
    // silently — connectToServer/handleReconnect re-assert app state right after
    // auth, so a drop during a toggle can't leave the relay with a stale value.
    // `clientType` lets the relay suppress the MOBILE push when the user is
    // actively on a desktop/web session (v1 parity: "active desktop ⇒ quiet phone").
    if (this.connected) {
      this.send({ type: "cyborg:app_state", state, clientType: this.clientSurface() });
    }
  }

  // Which surface this client is: the Electron desktop shell exposes
  // `window.cyborg7Desktop`; the Tauri mobile shell exposes `window.__TAURI__`;
  // anything else is a plain browser tab.
  private clientSurface(): "mobile" | "desktop" | "web" {
    if (typeof window === "undefined") return "web";
    const w = window as {
      __TAURI__?: unknown;
      __TAURI_INTERNALS__?: unknown;
      cyborg7Desktop?: unknown;
    };
    if (w.__TAURI_INTERNALS__ ?? w.__TAURI__) return "mobile";
    if (w.cyborg7Desktop) return "desktop";
    return "web";
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Client disconnected"));
    }
    this.pendingRequests.clear();
    this.emit("connection", { status: "disconnected" } as EventMap["connection"]);
  }

  // Treat the current socket as dead and reconnect immediately, bypassing the
  // backoff. Used by the app layer when a heartbeat probe times out or the app
  // returns to the foreground after a freeze — a mobile OS can leave the socket
  // in a zombie OPEN state where neither close nor the auto-reconnect ever fires.
  forceReconnect(): void {
    if (this.intentionalClose) return;
    this.reconnectAttempts = 0; // restart backoff so the retry is near-instant
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Not an intentional close, so the existing close handler runs
      // scheduleReconnect() for us (now with attempts reset to 0).
      try {
        this.ws.close();
      } catch {
        // already closing/closed
      }
    } else {
      this.scheduleReconnect();
    }
  }

  // ─── Transport liveness heartbeat (#503) ─────────────────────────
  // Started on `open`, stopped on `close`/disconnect — one timer per connection.
  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (typeof setInterval === "undefined") return; // SSR safety
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, SlackClient.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // One heartbeat: ping and, if no round-trip within the window, tear the socket
  // down so the `close` handler's scheduleReconnect() takes over. ping() resolves
  // true on ANY matching-requestId reply (incl. a relay error → backward-compat),
  // so only a genuine timeout / dead socket trips the teardown.
  private async heartbeatTick(): Promise<void> {
    // ping() has its own timeout (< the interval), so ticks don't normally
    // overlap; guard anyway so a stalled tick can't pile up.
    if (this.heartbeatInFlight) return;
    if (!this.connected) return;
    // Capture the socket this tick is probing. If the connection drops mid-ping,
    // the ping() promise stays pending until its timeout; by the time it resolves
    // false, scheduleReconnect() may have already swapped in a NEW healthy socket.
    // Without this guard the stale tick would close that new socket. Only tear
    // down the socket we actually pinged, and only if it's still the current one.
    const probedWs = this.ws;
    this.heartbeatInFlight = true;
    let alive = false;
    try {
      alive = await this.ping(SlackClient.HEARTBEAT_TIMEOUT_MS);
    } finally {
      this.heartbeatInFlight = false;
    }
    if (alive) return;
    // Half-open socket. Don't fight an intentional teardown (logout/shutdown), and
    // don't close a socket that was already replaced by a reconnect mid-ping.
    if (this.ws === probedWs && probedWs && !this.intentionalClose) {
      try {
        probedWs.close();
      } catch {
        // Already closing/closed — the close handler (or next connect) covers it.
      }
    }
  }

  on<K extends keyof EventMap & string>(event: K, handler: EventHandler<EventMap[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as EventHandler<unknown>);
    return () => set!.delete(handler as EventHandler<unknown>);
  }

  // ─── Messaging ──────────────────────────────────────────────────

  sendMessage(
    workspaceId: string,
    channelId: string,
    text: string,
    mentions?: string[],
    attachments?: Attachment[],
    parentId?: string,
    // Client-generated id (#501): the relay echoes it on the broadcast so the
    // sender reconciles the echo to its exact optimistic bubble. Omitted →
    // legacy fromId+text reconciliation (still works with older relays).
    clientMsgId?: string,
    // #602 — text came from a composer prompt TEMPLATE: ask the server to expand
    // {channel}/{user}/{date} on send. Only set for template-sourced sends so a
    // normal message with literal braces is left untouched. Omitted otherwise.
    expandTemplate?: boolean,
  ): void {
    this.send({
      type: "cyborg:channel_message",
      workspaceId,
      channelId,
      text,
      mentions,
      attachments,
      parentId,
      clientMsgId,
      ...(expandTemplate ? { expandTemplate: true } : {}),
    });
  }

  // Run a channel slash command (e.g. /summarize). The ack only confirms
  // dispatch — the actual result arrives asynchronously as a normal channel
  // message broadcast (cyborg:channel_message_broadcast).
  async slashCommand(
    workspaceId: string,
    channelId: string,
    trigger: string,
    args?: string,
    // Target daemon: slash commands are DAEMON_SPAWN forwards, and the relay
    // refuses to pick one itself when several daemons are connected.
    daemonId?: string,
  ): Promise<{
    ok: boolean;
    trigger: string;
    dispatched: string[];
    error?: string;
    // Ephemeral notices about clamped/ignored args (daemon-side parse). Shown
    // only to the sender as a local system note — never persisted. Absent on
    // clean input and from older daemons.
    warnings?: string[];
    // Set by the relay when no daemon could be resolved for the command — the UI
    // renders it as a system message in the channel (not small grey error text).
    systemAlert?: string;
    // Discriminates the no-daemon alerts so the UI can show a "Configure AI" CTA
    // for the unconfigured case (vs offline / generic slash errors).
    alertType?: "no_daemon_configured" | "slash_daemons_offline";
    channelId?: string | null;
  }> {
    return this.request("cyborg:slash_command", {
      workspaceId,
      channelId,
      trigger,
      ...(args ? { args } : {}),
      ...(daemonId ? { daemonId } : {}),
    });
  }

  // ─── Prompt templates (#602 — reusable composer snippets) ────────
  // Workspace-scoped CRUD for composer templates. Routed relay-side (PG-direct)
  // / local-dispatcher; create/update/delete return ok + the row (or a friendly
  // error on a name clash / validation failure).

  async listPromptTemplates(workspaceId: string): Promise<{ templates: PromptTemplate[] }> {
    return this.request<{ templates: PromptTemplate[] }>("cyborg:list_prompt_templates", {
      workspaceId,
    });
  }

  async createPromptTemplate(
    workspaceId: string,
    name: string,
    body: string,
  ): Promise<{ ok: boolean; template?: PromptTemplate; error?: string }> {
    return this.request("cyborg:create_prompt_template", { workspaceId, name, body });
  }

  async updatePromptTemplate(
    workspaceId: string,
    id: string,
    fields: { name?: string; body?: string },
  ): Promise<{ ok: boolean; template?: PromptTemplate; error?: string }> {
    return this.request("cyborg:update_prompt_template", { workspaceId, id, ...fields });
  }

  async deletePromptTemplate(
    workspaceId: string,
    id: string,
  ): Promise<{ ok: boolean; id: string; error?: string }> {
    return this.request("cyborg:delete_prompt_template", { workspaceId, id });
  }

  async fetchThread(
    workspaceId: string,
    parentId: string,
  ): Promise<{ parentId: string; messages: Message[]; lastViewed?: number | null }> {
    // lastViewed = the viewer's frozen per-thread read cursor (epoch ms | null),
    // used to seed the per-thread "New replies" divider (#7).
    return this.request<{ parentId: string; messages: Message[]; lastViewed?: number | null }>(
      "cyborg:fetch_thread",
      { workspaceId, parentId },
    );
  }

  async fetchThreads(
    workspaceId: string,
    opts?: { unreadOnly?: boolean; limit?: number },
  ): Promise<{ threads: ThreadSummary[] }> {
    return this.request<{ threads: ThreadSummary[] }>("cyborg:fetch_threads", {
      workspaceId,
      unreadOnly: opts?.unreadOnly,
      limit: opts?.limit,
    });
  }

  async threadCounts(
    workspaceId: string,
  ): Promise<{ totalUnreadThreads: number; totalUnreadMentions: number }> {
    return this.request<{ totalUnreadThreads: number; totalUnreadMentions: number }>(
      "cyborg:thread_counts",
      { workspaceId },
    );
  }

  // Fire-and-forget — the WS broadcast updates state on all the user's devices.
  markThreadRead(workspaceId: string, rootId: string): void {
    this.send({ type: "cyborg:mark_thread_read", workspaceId, rootId });
  }

  // Mark a thread unread (#7): rewind the read cursor to just before `beforeAt`
  // (the createdAt ms of the reply the user marked unread). Fire-and-forget; the
  // thread_read_changed broadcast updates the aggregate badge on all devices.
  markThreadUnread(workspaceId: string, rootId: string, beforeAt: number): void {
    this.send({ type: "cyborg:mark_thread_unread", workspaceId, rootId, beforeAt });
  }

  followThread(workspaceId: string, rootId: string, following: boolean): void {
    this.send({ type: "cyborg:follow_thread", workspaceId, rootId, following });
  }

  sendDm(
    workspaceId: string,
    toId: string,
    text: string,
    attachments?: Attachment[],
    parentId?: string,
    // See sendMessage: echoed by the relay for exact optimistic reconciliation (#501).
    clientMsgId?: string,
  ): void {
    this.send({ type: "cyborg:dm", workspaceId, toId, text, attachments, parentId, clientMsgId });
  }

  async fetchDmMessages(
    workspaceId: string,
    peerId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    return this.request<{ messages: Message[]; hasMore: boolean }>("cyborg:fetch_dm_messages", {
      workspaceId,
      peerId,
      ...opts,
    });
  }

  // Seq-cursored DM catch-up (#500): the DM-scoped twin of sync(). Returns DM
  // messages with seq > sinceSeq ASCENDING, paginated, so a reconnect can loop
  // until caught up instead of blindly refetching the latest 50 (which silently
  // drops everything older when >50 arrived during a long disconnect). Throws on
  // older relays that don't implement it → caller falls back to fetchDmMessages.
  async fetchDmSince(
    workspaceId: string,
    peerId: string,
    sinceSeq: number,
    limit?: number,
  ): Promise<{ messages: Message[]; hasMore: boolean; nextSeq: number }> {
    return this.request<{ messages: Message[]; hasMore: boolean; nextSeq: number }>(
      "cyborg:fetch_dm_since",
      { workspaceId, peerId, sinceSeq, ...(limit !== undefined ? { limit } : {}) },
    );
  }

  // channelId → channel typing; toId → DM typing (relay scopes to sender+peer);
  // parentId (#11 thread-typing) → routing hint so receivers show the indicator
  // in the open thread panel. They ride along together on one message.
  sendTyping(workspaceId: string, channelId?: string, toId?: string, parentId?: string): void {
    this.send({
      type: "cyborg:typing",
      workspaceId,
      channelId: channelId ?? "",
      toId,
      parentId,
    });
  }

  sendReaction(workspaceId: string, messageId: string, emoji: string): void {
    this.send({ type: "cyborg:reaction", workspaceId, messageId, emoji });
  }

  async editMessage(workspaceId: string, messageId: string, text: string): Promise<void> {
    await this.request("cyborg:edit_message", { workspaceId, messageId, text });
  }

  async deleteMessage(workspaceId: string, messageId: string): Promise<void> {
    await this.request("cyborg:delete_message", { workspaceId, messageId });
  }

  async pinMessage(
    workspaceId: string,
    channelId: string,
    messageId: string,
    pinned: boolean,
  ): Promise<void> {
    await this.request("cyborg:pin_message", { workspaceId, channelId, messageId, pinned });
  }

  markRead(workspaceId: string, channelId: string, lastReadAt?: number): void {
    this.send({ type: "cyborg:mark_read", workspaceId, channelId, lastReadAt });
  }

  // P2 Item 12: the DM analogue of markRead. Fire-and-forget (mirrors markRead);
  // the relay's read_broadcast confirms cross-device.
  markDmRead(workspaceId: string, peerId: string, lastReadAt?: number): void {
    this.send({ type: "cyborg:mark_dm_read", workspaceId, peerId, lastReadAt });
  }

  // Task analogue: opening a task's detail card clears its Activity rows. Fire-
  // and-forget; the relay marks them read and broadcasts activity_read_changed
  // (carrying taskId) back to all the user's devices for cross-device reconcile.
  markTaskRead(workspaceId: string, taskId: string): void {
    this.send({ type: "cyborg:mark_task_read", workspaceId, taskId });
  }

  async searchMessages(workspaceId: string, query: string, limit = 50): Promise<Message[]> {
    const resp = await this.request<{ messages: Message[] }>("cyborg:search", {
      workspaceId,
      query,
      limit,
    });
    return resp.messages;
  }

  async fetchUnread(workspaceId: string): Promise<{
    // Per-channel unread MESSAGE count (any unread → BOLD the channel name).
    counts: Record<string, number>;
    // BUG #2: per-channel MENTION count (messages whose `mentions` include me,
    // after my read cursor, not my own) → the RED numeric badge. Additive +
    // backward-compatible: older relays omit it, so the client defaults to {}.
    mentionCounts?: Record<string, number>;
    reads: Record<string, number>;
    dmCounts: Record<string, number>;
    dmReads: Record<string, number>;
  }> {
    return this.request("cyborg:fetch_unread", { workspaceId });
  }

  async fetchActivity(
    workspaceId: string,
    opts?: { before?: number; unreadOnly?: boolean; limit?: number },
  ): Promise<{ items: Record<string, unknown>[]; unread: number }> {
    return this.request("cyborg:fetch_activity", { workspaceId, ...opts });
  }

  async markActivityRead(workspaceId: string, eventId?: string): Promise<{ unread: number }> {
    return this.request("cyborg:mark_activity_read", { workspaceId, eventId });
  }

  async setNotificationPref(
    workspaceId: string,
    scopeId: string,
    preference: "all" | "mentions_only" | "muted",
  ): Promise<void> {
    await this.request("cyborg:set_notification_pref", { workspaceId, scopeId, preference });
  }

  async fetchNotificationPrefs(workspaceId: string): Promise<{ prefs: Record<string, string> }> {
    return this.request("cyborg:fetch_notification_prefs", { workspaceId });
  }

  // ─── Composer drafts (server-side draft sync, #610) ──────────────
  // Upsert the caller's draft for a (workspace, scope). Fire-and-forget: drafts
  // are debounced on the client and lossy by nature, so we don't await a response
  // (mirrors the optimistic setNotificationPref persist). `updatedAt` is epoch ms,
  // the reconcile tiebreaker the other device uses on load.
  draftSet(workspaceId: string, scope: string, text: string, updatedAt: number): void {
    this.send({ type: "cyborg:draft_set", workspaceId, scope, text, updatedAt });
  }

  // Clear the caller's draft for a (workspace, scope) — on send or explicit clear.
  draftClear(workspaceId: string, scope: string): void {
    this.send({ type: "cyborg:draft_clear", workspaceId, scope });
  }

  // All of the caller's drafts in a workspace, to seed a fresh device on load.
  async fetchDrafts(
    workspaceId: string,
  ): Promise<{ drafts: Array<{ scope: string; text: string; updatedAt: number }> }> {
    return this.request("cyborg:fetch_drafts", { workspaceId });
  }

  // ─── Workspaces ─────────────────────────────────────────────────

  async fetchWorkspaces(): Promise<Workspace[]> {
    const resp = await this.request<{ workspaces: Workspace[] }>("cyborg:fetch_workspaces");
    return resp.workspaces;
  }

  async createWorkspace(name: string, settings?: Record<string, unknown>): Promise<Workspace> {
    const resp = await this.request<{ workspace: Workspace }>("cyborg:create_workspace", {
      name,
      settings,
    });
    return resp.workspace;
  }

  async updateWorkspace(
    workspaceId: string,
    updates: { name?: string; avatarUrl?: string | null; settings?: WorkspaceSettings },
  ): Promise<void> {
    await this.request("cyborg:update_workspace", { workspaceId, ...updates });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.request("cyborg:delete_workspace", { workspaceId });
  }

  // App-Store Guideline 5.1.1(v): permanently delete the authenticated user's
  // own account. No args — the relay always acts on the authenticated socket's
  // userId, so this can only ever delete the caller's own account.
  async deleteAccount(): Promise<void> {
    await this.request("cyborg:delete_account", {});
  }

  // ─── Channels ───────────────────────────────────────────────────

  async fetchChannels(workspaceId: string): Promise<Channel[]> {
    const resp = await this.request<{ channels: Channel[] }>("cyborg:fetch_channels", {
      workspaceId,
    });
    return resp.channels;
  }

  async createChannel(
    workspaceId: string,
    name: string,
    opts?: { description?: string; isPrivate?: boolean; instructions?: string },
  ): Promise<Channel> {
    const resp = await this.request<{ channel: Channel }>("cyborg:create_channel", {
      workspaceId,
      name,
      ...opts,
    });
    return resp.channel;
  }

  // #608: start a group DM with `participants` (the OTHER members' user-ids; the
  // creator is implicit). 2–8 others. The server validates membership + the cap,
  // derives the auto-name (members' display names, sorted), and returns the new
  // hidden group_dm channel — which then rides the normal channel pipeline.
  async createGroupDm(workspaceId: string, participants: string[]): Promise<Channel> {
    const resp = await this.request<{ channel: Channel }>("cyborg:create_group_dm", {
      workspaceId,
      participants,
    });
    return resp.channel;
  }

  // All workspace channels (public + your private) with a per-channel isMember
  // flag, for the Browse-channels modal. Backed by cyborg:list_channels.
  async listChannels(
    workspaceId: string,
  ): Promise<Array<Channel & { isMember: boolean; memberCount: number }>> {
    const resp = await this.request<{
      channels: Array<Channel & { isMember: boolean; memberCount: number }>;
    }>("cyborg:list_channels", { workspaceId });
    return resp.channels;
  }

  // ─── Messages ───────────────────────────────────────────────────

  async fetchMessages(
    workspaceId: string,
    channelId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<{ messages: Message[]; hasMore: boolean }> {
    return this.request<{ messages: Message[]; hasMore: boolean }>("cyborg:fetch_messages", {
      workspaceId,
      channelId,
      ...opts,
    });
  }

  async fetchWorkspaceActivity(
    workspaceId: string,
    limit?: number,
  ): Promise<{ messages: Message[] }> {
    return this.request<{ messages: Message[] }>("cyborg:fetch_workspace_activity", {
      workspaceId,
      limit,
    });
  }

  async fetchBackendStatus(): Promise<{
    mode: "local" | "remote";
    postgres: { url: string | null; status: string };
    redis: { url: string | null; status: string };
    relay: { url: string; status: string };
    s3?: { url: string | null; status: string };
  }> {
    return this.request("cyborg:fetch_backend_status", {});
  }

  async fetchDaemonInfo(): Promise<{ daemonId: string | null; ownerId: string | null }> {
    return this.request("cyborg:fetch_daemon_info", {});
  }

  async listDaemons(workspaceId: string): Promise<{
    daemons: Array<{
      id: string;
      label: string;
      ownerId: string;
      status: string;
      lastSeenAt: number | null;
      meta?: {
        cpu?: number;
        memMb?: number;
        agents?: number;
        queueDepth?: number;
        host?: string;
        platform?: string;
        arch?: string;
        cyboInstalled?: boolean;
        cyboRuntime?: {
          configured: boolean;
          modelCount: number;
          backends: { backend: string; modelCount: number }[];
        };
      } | null;
    }>;
    // The caller's configured default daemon for slash commands (null = unset).
    defaultSlashDaemonId?: string | null;
    // DEPRECATED per-user preferred model (back-compat; may hold a stale value).
    // Prefer `workspaceSlashConfig.model` — the admin-controlled source of truth.
    slashCommandModel?: { provider: string; model: string } | null;
    // Workspace-level slash AI config (admin-controlled, #opt-A). `model` is the
    // authoritative run-target model, parsed server-side from "provider/model".
    workspaceSlashConfig?: {
      defaultSlashDaemonId: string | null;
      fallbackDaemons: string[];
      model: { provider: string; model: string } | null;
    } | null;
  }> {
    return this.request("cyborg:list_daemons", { workspaceId });
  }

  // Persist the user's default slash-command daemon (a daemon they own; null clears it).
  async setDefaultSlashDaemon(
    workspaceId: string,
    daemonId: string | null,
  ): Promise<{ daemonId: string | null }> {
    return this.request("cyborg:set_default_slash_daemon", { workspaceId, daemonId });
  }

  // Persist the user's preferred model for channel AI commands (/summarize etc.).
  // Pass null to clear it (→ auto-resolve, the zero-config default).
  async setSlashCommandModel(
    model: { provider: string; model: string } | null,
  ): Promise<{ model: { provider: string; model: string } | null }> {
    return this.request("cyborg:set_slash_command_model", { model });
  }

  // Per-channel override for channel AI commands (wins over the user default).
  // Pass null to clear it (→ inherit the user default / auto-resolve).
  async setChannelSlashCommandModel(
    workspaceId: string,
    channelId: string,
    model: { provider: string; model: string } | null,
  ): Promise<{ channelId: string; model: { provider: string; model: string } | null }> {
    return this.request("cyborg:set_channel_slash_command_model", {
      workspaceId,
      channelId,
      model,
    });
  }

  // Per-channel auto-tasks (channel watcher) opt-in switch. When enabled, a cybo
  // may act autonomously on un-mentioned human chatter in this channel; default
  // OFF. Gated server-side to the channel creator / workspace admin / channel admin.
  async setChannelAutoTasks(
    workspaceId: string,
    channelId: string,
    enabled: boolean,
  ): Promise<{ channelId: string; enabled: boolean }> {
    return this.request("cyborg:set_channel_auto_tasks", {
      workspaceId,
      channelId,
      enabled,
    });
  }

  // ─── Workspace slash-command config (admin-only) — see WorkspaceSlashConfig ──
  // The server persists a FLAT shape (defaultSlashDaemonId / fallbackDaemons /
  // model as a "provider/model" string) across 3 workspace columns; map to/from
  // the richer client shape here so the UI is decoupled from the wire format.
  // (slashCommandsEnabled has no server column yet → defaults true on read; the
  // round-trip persists the daemon + fallbacks + model.)
  async getWorkspaceSlashConfig(workspaceId: string): Promise<WorkspaceSlashConfig> {
    const resp = await this.request<{ config: ServerWorkspaceSlashConfig }>(
      "cyborg:get_workspace_slash_config",
      { workspaceId },
    );
    return fromServerSlashConfig(resp.config);
  }

  async setWorkspaceSlashConfig(
    workspaceId: string,
    config: WorkspaceSlashConfig,
  ): Promise<WorkspaceSlashConfig> {
    const resp = await this.request<{
      ok?: boolean;
      error?: string;
      config?: ServerWorkspaceSlashConfig;
    }>("cyborg:set_workspace_slash_config", {
      workspaceId,
      defaultSlashDaemonId: config.defaultDaemonId,
      fallbackDaemons: config.fallbackDaemonIds,
      model: config.model ? `${config.model.provider}/${config.model.model}` : null,
    });
    if (resp.ok === false) throw new Error(resp.error ?? "Failed to save the AI config");
    // Preserve the (client-only) enabled flag; daemon/fallbacks/model come back
    // from the server's authoritative round-trip.
    return resp.config
      ? { ...fromServerSlashConfig(resp.config), slashCommandsEnabled: config.slashCommandsEnabled }
      : config;
  }

  // ─── Workspace agent autonomy (owner/admin) ──────────────────────
  // When off, the workspace's channel-watcher autonomy is disabled: agents only
  // respond when @-mentioned. Default on; the relay fans a
  // `cyborg:workspace_autonomy_updated` broadcast so other clients reflect it.
  async getWorkspaceAutonomy(workspaceId: string): Promise<{ enabled: boolean }> {
    return this.request<{ enabled: boolean }>("cyborg:get_workspace_autonomy", { workspaceId });
  }

  async setWorkspaceAutonomy(
    workspaceId: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; enabled?: boolean; error?: string }> {
    return this.request<{ ok: boolean; enabled?: boolean; error?: string }>(
      "cyborg:set_workspace_autonomy",
      {
        workspaceId,
        enabled,
      },
    );
  }

  async fetchDaemonAccess(workspaceId: string): Promise<{
    access: Array<{
      daemonId: string;
      userId: string;
      grantedBy: string;
      grantedAt: number;
      scopes?: string[];
    }>;
  }> {
    return this.request("cyborg:fetch_daemon_access", { workspaceId });
  }

  // Idempotently SET a user's daemon scopes (#705). Empty `scopes` revokes. This
  // is the authoritative access RPC the per-daemon matrix uses. grant/revoke below
  // remain for the binary call-sites (Settings toggle, sidebar "remove access").
  async setDaemonAccess(
    workspaceId: string,
    daemonId: string,
    userId: string,
    scopes: string[],
  ): Promise<{ ok: boolean; daemonId: string; userId: string; scopes: string[] }> {
    return this.request("cyborg:set_daemon_access", { workspaceId, daemonId, userId, scopes });
  }

  async grantDaemonAccess(
    workspaceId: string,
    daemonId: string,
    userId: string,
  ): Promise<{ granted: boolean }> {
    return this.request("cyborg:grant_daemon_access", { workspaceId, daemonId, userId });
  }

  async revokeDaemonAccess(
    workspaceId: string,
    daemonId: string,
    userId: string,
  ): Promise<{ revoked: boolean }> {
    return this.request("cyborg:revoke_daemon_access", { workspaceId, daemonId, userId });
  }

  // ─── Daemon access REQUESTS (#705 REQUEST → NOTIFY → APPROVE) ───
  //
  // A non-owner asks a daemon OWNER for access at the requested scopes; the owner
  // approves (running the grant) or denies. The owner is notified live via the
  // daemon_access_request_changed event + an activity_new badge.

  // Requester → owner: ask for access at `scopes`. Returns the created (or existing
  // pending) request row.
  async requestDaemonAccess(
    workspaceId: string,
    daemonId: string,
    scopes: Array<"chat" | "spawn" | "terminal" | "admin">,
  ): Promise<{ request: DaemonAccessRequestView }> {
    return this.request("cyborg:request_daemon_access", { workspaceId, daemonId, scopes });
  }

  // Owner → resolve a pending request. `decision` is "approve" | "deny"; on
  // approve, optional `scopes` overrides the requested set before the grant runs.
  // The request id travels as `requestIdToResolve` to avoid colliding with the RPC
  // correlation id (`requestId`).
  async resolveDaemonAccessRequest(
    workspaceId: string,
    requestId: string,
    decision: "approve" | "deny",
    scopes?: Array<"chat" | "spawn" | "terminal" | "admin">,
  ): Promise<{ request: DaemonAccessRequestView }> {
    return this.request("cyborg:resolve_daemon_access_request", {
      workspaceId,
      requestIdToResolve: requestId,
      decision,
      ...(scopes !== undefined ? { scopes } : {}),
    });
  }

  // Owner inbox + requester outbox: pending requests for daemons the caller owns,
  // plus the caller's own outgoing requests.
  async fetchDaemonAccessRequests(
    workspaceId: string,
  ): Promise<{ requests: DaemonAccessRequestView[] }> {
    return this.request("cyborg:fetch_daemon_access_requests", { workspaceId });
  }

  // Owner-only rename (#441) — the server sets the sticky label_user_set flag
  // so daemon reconnects can never overwrite the chosen name.
  async renameDaemon(
    workspaceId: string,
    daemonId: string,
    label: string,
  ): Promise<{ ok: boolean; daemonId: string; label: string }> {
    return this.request("cyborg:rename_daemon", { workspaceId, daemonId, label });
  }

  // Owner-only: which workspaces this daemon could serve, and whether each is
  // enabled (workspace_daemons.enabled).
  async listDaemonWorkspaces(daemonId: string): Promise<{
    workspaces: Array<{ workspaceId: string; name: string; enabled: boolean }>;
  }> {
    return this.request("cyborg:list_daemon_workspaces", { daemonId });
  }

  // Owner-only: enable/disable this daemon for a workspace. Applied live by the relay.
  async setDaemonWorkspace(
    daemonId: string,
    workspaceId: string,
    enabled: boolean,
  ): Promise<{ ok: true }> {
    return this.request("cyborg:set_daemon_workspace", { daemonId, workspaceId, enabled });
  }

  async sync(
    workspaceId: string,
    lastSeq: number,
  ): Promise<{
    mode: "delta" | "snapshot";
    messages: Message[];
    hasMore?: boolean;
    nextSeq?: number;
  }> {
    return this.request("cyborg:sync", { workspaceId, lastSeq });
  }

  // ─── Asset uploads ──────────────────────────────────────────────

  private get httpBase(): string {
    return this.url
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:")
      .replace(/\/api\/ws\/?$/, "")
      .replace(/\/ws\/?$/, "");
  }

  // Subclass access (CyborgClient): the relay's HTTP origin + bearer token, for
  // the Stripe checkout/portal/license REST endpoints that have no WS analogue.
  protected get relayHttpBase(): string {
    return this.httpBase;
  }
  protected get authToken(): string {
    return this.token;
  }

  async uploadAsset(
    file: File,
    folder = "avatars",
    // Upload progress + cancel (#517). `onProgress` reports 0–100 from the S3
    // PUT (web/desktop/Android via XHR); `signal` cancels the in-flight PUT.
    // Both optional — older callers (avatars, posters) pass neither and keep the
    // prior fire-and-forget behavior.
    opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal },
  ): Promise<{ publicUrl: string; key: string }> {
    const presignResp = await fetch(`${this.httpBase}/api/assets/presign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        folder,
        // Declared size — the relay rejects oversized uploads at this checkpoint.
        size: file.size,
      }),
      // Never hang the attachment chip on a stalled network — surface a clear
      // error so the caller can fall back to an inline data: URL (small files).
      signal: AbortSignal.timeout(20_000),
    });
    if (!presignResp.ok) {
      const err = await presignResp.json().catch(() => ({ error: "presign failed" }));
      throw new Error(err.error ?? `HTTP ${presignResp.status}`);
    }
    const { presignedUrl, publicUrl, key, requiredHeaders } = (await presignResp.json()) as {
      presignedUrl: string;
      publicUrl: string;
      key: string;
      // Security handoff: the presigned S3 PUT now BINDS specific headers (the
      // server signs them). The client MUST replay these EXACT headers on the
      // PUT or S3 returns 403. Older servers omit this field — fall back to a
      // hand-set Content-Type so nothing breaks.
      requiredHeaders?: Record<string, string>;
    };

    await this.putToPresignedUrl(presignedUrl, file, requiredHeaders, opts);

    return { publicUrl, key };
  }

  /**
   * PUT the file bytes to the S3 presigned URL.
   *
   * On the Tauri iOS shell the WKWebView origin is `tauri.localhost`, which the
   * S3 bucket's CORS policy does NOT allow (it only allows `app.cyborg7.com`).
   * A plain `fetch` PUT from the WebView therefore gets CORS-blocked and fails
   * on device. v1 solved this by routing the PUT through Tauri's HTTP plugin
   * (`@tauri-apps/plugin-http`), whose `fetch` runs in Rust/reqwest and sends NO
   * browser `Origin` header — so S3 accepts it. We mirror that here.
   *
   * Web/desktop/Android keep the plain `fetch` path (same-origin or normal CORS
   * applies). The presign POST above stays on `window.fetch` (it's same-origin
   * to the relay).
   *
   * `requiredHeaders` are the headers the presign endpoint BOUND into the
   * signature (Content-Type, and Content-Disposition for forced-download
   * types). They MUST be replayed verbatim on the PUT or S3 rejects the request
   * with 403 (SignatureDoesNotMatch). When the server omits them (older relay),
   * we fall back to a hand-set Content-Type — the legacy behavior.
   */
  private async putToPresignedUrl(
    presignedUrl: string,
    file: File,
    requiredHeaders?: Record<string, string>,
    // #517: optional upload-progress + cancel. Honored on the web/desktop/Android
    // XHR path. The Tauri-iOS plugin-http path supports cancel via `signal` but
    // NOT progress (the Rust fetch has no upload-progress callback, and a browser
    // XHR can't be used there — S3 CORS blocks the `tauri.localhost` origin), so
    // iOS keeps the indeterminate spinner.
    opts?: { onProgress?: (pct: number) => void; signal?: AbortSignal },
  ): Promise<void> {
    // The headers the signed PUT requires. Prefer the server-bound set; fall
    // back to today's behavior (Content-Type only) for older relays.
    const putHeaders: Record<string, string> =
      requiredHeaders && Object.keys(requiredHeaders).length > 0
        ? { ...requiredHeaders }
        : { "Content-Type": file.type };
    const isTauriIOS =
      typeof window !== "undefined" &&
      Boolean(
        (window as { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown }).__TAURI_INTERNALS__ ??
        (window as { __TAURI__?: unknown }).__TAURI__,
      ) &&
      typeof navigator !== "undefined" &&
      /iPad|iPhone|iPod/.test(navigator.userAgent);

    if (isTauriIOS) {
      try {
        const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
        const uploadResp = await tauriFetch(presignedUrl, {
          method: "PUT",
          headers: putHeaders,
          // Tauri's HTTP plugin streams an ArrayBuffer/Uint8Array body; a File/Blob
          // isn't transferable across the IPC boundary, so read the bytes first.
          body: new Uint8Array(await file.arrayBuffer()),
          // Bound the PUT so a stalled S3 connection can't spin the chip forever,
          // AND honor an external cancel (#517) — whichever fires first aborts.
          signal: opts?.signal
            ? AbortSignal.any([opts.signal, AbortSignal.timeout(45_000)])
            : AbortSignal.timeout(45_000),
        });
        if (!uploadResp.ok) {
          // Surface S3's XML <Code> (e.g. AccessDenied / SignatureDoesNotMatch)
          // instead of an opaque "Load failed".
          const detail = await uploadResp.text().catch(() => "");
          const code = detail.match(/<Code>([^<]+)<\/Code>/)?.[1];
          throw new Error(`Upload failed: HTTP ${uploadResp.status}${code ? ` (${code})` : ""}`);
        }
        return;
      } catch (err) {
        // If the plugin itself is unavailable (shouldn't happen on iOS), fall
        // through to plain fetch rather than hard-failing.
        if (err instanceof Error && err.message.startsWith("Upload failed:")) throw err;
        console.warn("[upload] Tauri HTTP PUT unavailable, falling back to fetch", err);
      }
    }

    // Web/desktop/Android: PUT via XMLHttpRequest (not fetch) — XHR is the only
    // broadly-supported way to observe UPLOAD progress in a browser/WebView
    // (`fetch` can't report request-body progress). #517.
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", presignedUrl);
      for (const [k, v] of Object.entries(putHeaders)) xhr.setRequestHeader(k, v);
      xhr.timeout = 45_000; // same stall ceiling as the old fetch PUT
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && opts?.onProgress) {
          opts.onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          // Surface S3's XML <Code> (AccessDenied / SignatureDoesNotMatch) like
          // the Tauri path, instead of an opaque status.
          const code = xhr.responseText?.match(/<Code>([^<]+)<\/Code>/)?.[1];
          reject(new Error(`Upload failed: HTTP ${xhr.status}${code ? ` (${code})` : ""}`));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("Upload failed: network error")));
      xhr.addEventListener("timeout", () => reject(new Error("Upload failed: timed out")));
      // Cancel (#517): abort the in-flight PUT when the caller's signal fires
      // (e.g. the user removes the chip mid-upload).
      xhr.addEventListener("abort", () =>
        reject(new DOMException("Upload cancelled", "AbortError")),
      );
      if (opts?.signal) {
        if (opts.signal.aborted) {
          // Already aborted before send: xhr.abort() fires no "abort" event
          // pre-send, so reject directly or the promise would hang forever.
          reject(new DOMException("Upload cancelled", "AbortError"));
          return;
        }
        opts.signal.addEventListener("abort", () => xhr.abort(), { once: true });
      }
      xhr.send(file);
    });
  }

  async getAssetsConfig(): Promise<{
    enabled: boolean;
    bucket: string | null;
    region: string;
    baseUrl: string | null;
  }> {
    const resp = await fetch(`${this.httpBase}/api/assets/config`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ─── Members ────────────────────────────────────────────────────

  async inviteMember(
    workspaceId: string,
    email: string,
    role?: "admin" | "member" | "viewer",
  ): Promise<{ membership: Membership; invitationId: string; inviteUrl: string }> {
    const resp = await this.request<{
      membership: Membership;
      invitationId: string;
      inviteUrl: string;
    }>("cyborg:invite_member", {
      workspaceId,
      email,
      role,
    });
    return {
      membership: resp.membership,
      invitationId: resp.invitationId,
      inviteUrl: resp.inviteUrl,
    };
  }

  // Re-issue an existing pending invitation: resets the 7-day expiry and
  // re-sends the invite email. Returns the new sentAt timestamp so the UI can
  // refresh the row's countdown.
  async resendInvitation(
    workspaceId: string,
    invitationId: string,
  ): Promise<{ invitationId: string; sentAt: number }> {
    return this.request<{ invitationId: string; sentAt: number }>("cyborg:resend_invitation", {
      workspaceId,
      invitationId,
    });
  }

  // Redeem an invitation token for the authenticated user. Returns the new
  // membership + the workspace the user just joined so the caller can navigate
  // into it. The token comes from the /invite/:token landing page.
  async acceptInvitation(
    invitationToken: string,
  ): Promise<{ membership: Membership; workspaceId: string }> {
    return this.request<{ membership: Membership; workspaceId: string }>(
      "cyborg:accept_invitation",
      { invitationToken },
    );
  }

  // Admin/owner: list the workspace's still-pending invitations (not yet
  // accepted, not expired-and-purged) for the Members settings section.
  async listPendingInvitations(workspaceId: string): Promise<{
    invitations: Array<{
      id: string;
      email: string;
      role: string;
      createdAt: number;
      expiresAt: number;
      createdByName?: string;
    }>;
  }> {
    return this.request<{
      invitations: Array<{
        id: string;
        email: string;
        role: string;
        createdAt: number;
        expiresAt: number;
        createdByName?: string;
      }>;
    }>("cyborg:list_pending_invitations", { workspaceId });
  }

  // Admin/owner: revoke a pending invitation so its token can no longer be
  // redeemed. Returns the cancelled invitation id.
  async cancelInvitation(
    workspaceId: string,
    invitationId: string,
  ): Promise<{ invitationId: string }> {
    return this.request<{ invitationId: string }>("cyborg:cancel_invitation", {
      workspaceId,
      invitationId,
    });
  }

  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    const resp = await this.request<{ removed: boolean }>("cyborg:remove_member", {
      workspaceId,
      userId,
    });
    return resp.removed;
  }

  async updateRole(
    workspaceId: string,
    userId: string,
    role: "admin" | "member" | "viewer",
  ): Promise<boolean> {
    const resp = await this.request<{ updated: boolean }>("cyborg:update_role", {
      workspaceId,
      userId,
      role,
    });
    return resp.updated;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const resp = await this.request<{ members: WorkspaceMember[] }>("cyborg:list_members", {
      workspaceId,
    });
    return resp.members;
  }

  // ─── MCP tokens (settings) ───────────────────────────────────────

  async mcpList(workspaceId: string): Promise<McpListResponse> {
    return this.request<McpListResponse>("cyborg:mcp_list", { workspaceId });
  }

  async mcpSetEnabled(workspaceId: string, enabled: boolean): Promise<boolean> {
    const resp = await this.request<{ enabled: boolean }>("cyborg:mcp_set_enabled", {
      workspaceId,
      enabled,
    });
    return resp.enabled;
  }

  async mcpCreateToken(
    workspaceId: string,
    opts: {
      name: string;
      identityType: "cybo" | "user";
      identityId: string;
      scopes: string[];
      expiresInDays?: number;
    },
  ): Promise<{ id: string; token: string }> {
    return this.request<{ id: string; token: string }>("cyborg:mcp_create_token", {
      workspaceId,
      ...opts,
    });
  }

  async mcpToggleToken(workspaceId: string, tokenId: string, enabled: boolean): Promise<boolean> {
    const resp = await this.request<{ updated: boolean }>("cyborg:mcp_toggle_token", {
      workspaceId,
      tokenId,
      enabled,
    });
    return resp.updated;
  }

  async mcpRevokeToken(workspaceId: string, tokenId: string): Promise<boolean> {
    const resp = await this.request<{ revoked: boolean }>("cyborg:mcp_revoke_token", {
      workspaceId,
      tokenId,
    });
    return resp.revoked;
  }

  // ─── Webhooks (inbound, GitHub-style config) ─────────────────────

  async webhookList(workspaceId: string, channelId: string): Promise<Webhook[]> {
    const resp = await this.request<{ webhooks: Webhook[] }>("cyborg:webhook_list", {
      workspaceId,
      channelId,
    });
    return resp.webhooks;
  }

  // Create a webhook config. `generateSecret` mints an HMAC secret returned ONCE
  // in the response (never re-fetchable).
  async webhookCreate(
    workspaceId: string,
    channelId: string,
    opts: {
      name: string;
      eventMode: "release" | "all" | "select";
      events?: string[];
      contentType?: string;
      active?: boolean;
      generateSecret?: boolean;
    },
  ): Promise<{ id: string; secret: string | null }> {
    return this.request<{ id: string; secret: string | null }>("cyborg:webhook_create", {
      workspaceId,
      channelId,
      ...opts,
    });
  }

  async webhookUpdate(
    workspaceId: string,
    webhookId: string,
    patch: {
      name?: string;
      eventMode?: "release" | "all" | "select";
      events?: string[];
      contentType?: string;
      active?: boolean;
    },
  ): Promise<boolean> {
    const resp = await this.request<{ updated: boolean }>("cyborg:webhook_update", {
      workspaceId,
      webhookId,
      ...patch,
    });
    return resp.updated;
  }

  // Rotate (or clear, with `clear: true`) the signing secret. A fresh secret is
  // returned ONCE; `clear` returns null and disables signature verification.
  async webhookRotateSecret(
    workspaceId: string,
    webhookId: string,
    clear = false,
  ): Promise<{ updated: boolean; secret: string | null }> {
    return this.request<{ updated: boolean; secret: string | null }>(
      "cyborg:webhook_rotate_secret",
      { workspaceId, webhookId, clear },
    );
  }

  async webhookDelete(workspaceId: string, webhookId: string): Promise<boolean> {
    const resp = await this.request<{ deleted: boolean }>("cyborg:webhook_delete", {
      workspaceId,
      webhookId,
    });
    return resp.deleted;
  }

  async webhookListDeliveries(workspaceId: string, webhookId: string): Promise<WebhookDelivery[]> {
    const resp = await this.request<{ deliveries: WebhookDelivery[] }>(
      "cyborg:webhook_list_deliveries",
      { workspaceId, webhookId },
    );
    return resp.deliveries;
  }

  async webhookRedeliver(
    workspaceId: string,
    deliveryId: string,
  ): Promise<{ ok: boolean; messageId: string }> {
    return this.request<{ ok: boolean; messageId: string }>("cyborg:webhook_redeliver", {
      workspaceId,
      deliveryId,
    });
  }

  // ─── Tasks ──────────────────────────────────────────────────────

  async createTask(
    workspaceId: string,
    title: string,
    opts?: {
      description?: string;
      assigneeId?: string;
      dueAt?: number;
      // ─── Tasks Redesign (Plane-shaped) — all optional, back-compat ────
      // The relay accepts these camelCase keys and persists the Plane model.
      // `labels` are label NAMES (auto-created in the project's catalog), NOT
      // ids; `moduleIds` are module ids.
      projectId?: string;
      parentId?: string | null;
      stateId?: string;
      priority?: TaskPriority | string;
      // Planned start (epoch ms); null clears it.
      startDate?: number | null;
      labels?: string[];
      cycleId?: string | null;
      moduleIds?: string[];
    },
  ): Promise<Task> {
    const resp = await this.request<{ task: RawTask }>("cyborg:create_task", {
      workspaceId,
      title,
      ...opts,
    });
    return mapRawTask(resp.task);
  }

  async updateTask(
    workspaceId: string,
    taskId: string,
    updates: {
      status?: string;
      title?: string;
      description?: string;
      assigneeId?: string | null;
      // null clears the due date; a number is epoch-ms (local end-of-day).
      dueAt?: number | null;
      result?: string;
      // ─── Tasks Redesign (Plane-shaped) — all optional, back-compat ────
      // Pass null to clear a scalar (projectId/parentId/stateId/startDate/
      // cycleId); an empty `labels`/`moduleIds` array clears that set. `labels`
      // are label NAMES (auto-created), NOT ids.
      priority?: TaskPriority | string | null;
      projectId?: string | null;
      parentId?: string | null;
      stateId?: string | null;
      startDate?: number | null;
      labels?: string[];
      cycleId?: string | null;
      moduleIds?: string[];
    },
  ): Promise<Task> {
    const resp = await this.request<{ task: RawTask }>("cyborg:update_task", {
      workspaceId,
      taskId,
      ...updates,
    });
    return mapRawTask(resp.task);
  }

  async deleteTask(workspaceId: string, taskId: string): Promise<void> {
    await this.request("cyborg:delete_task", { workspaceId, taskId });
  }

  async fetchTasks(
    workspaceId: string,
    opts?: { status?: string; assigneeId?: string },
  ): Promise<Task[]> {
    const resp = await this.request<{ tasks: RawTask[] }>("cyborg:fetch_tasks", {
      workspaceId,
      ...opts,
    });
    return resp.tasks.map(mapRawTask);
  }

  // ─── Tasks Redesign read-only catalog (board/detail) ─────────────
  // PENDING-SERVER: the relay handlers for these five RPCs land in a later phase.
  // They model the fetchTasks pattern (request type → await this.request → map the
  // response array). `fetchProjects` (the tasks-projects list) already exists on the
  // Cyborg subclass (ws-client.ts), so it is intentionally NOT duplicated here.

  // A project's workflow states (board columns), ordered by `sequence` server-side.
  async fetchProjectStates(projectId: string): Promise<TaskState[]> {
    const resp = await this.request<{ states: TaskState[] }>("cyborg:fetch_project_states", {
      projectId,
    });
    return resp.states;
  }

  // A project's label catalog (tags), ordered by `sortOrder` server-side.
  async fetchProjectLabels(projectId: string): Promise<TaskLabel[]> {
    const resp = await this.request<{ labels: TaskLabel[] }>("cyborg:fetch_project_labels", {
      projectId,
    });
    return resp.labels;
  }

  // A project's cycles (sprints).
  async fetchCycles(projectId: string): Promise<Cycle[]> {
    const resp = await this.request<{ cycles: Cycle[] }>("cyborg:fetch_cycles", { projectId });
    return resp.cycles;
  }

  // A project's modules (feature groupings).
  async fetchModules(projectId: string): Promise<Module[]> {
    const resp = await this.request<{ modules: Module[] }>("cyborg:fetch_modules", { projectId });
    return resp.modules;
  }

  // ─── Project pages catalog CRUD ──────────────────────────────────
  // A project's pages (wiki/docs). Returns ALL pages (the UI filters archived
  // itself), non-archived first then newest-updated first (server-ordered).
  async fetchPages(projectId: string): Promise<Page[]> {
    const resp = await this.request<{ pages: Page[] }>("cyborg:fetch_pages", { projectId });
    return resp.pages;
  }

  // A single page by id, or null when missing / not visible.
  async fetchPage(pageId: string): Promise<Page | null> {
    const resp = await this.request<{ page: Page | null }>("cyborg:fetch_page", { pageId });
    return resp.page;
  }

  // Create a blank page in a project. ownedBy + visibility are set server-side
  // (creator / "private"). `opts.title` seeds the title; `opts.parentId` nests
  // the new page directly under that parent (same project) — null/absent = a
  // root page. The server persists parent_id atomically (no follow-up reparent).
  async createPage(
    projectId: string,
    opts: { title?: string; parentId?: string | null } = {},
  ): Promise<Page> {
    const resp = await this.request<{ page: Page }>("cyborg:create_page", {
      projectId,
      title: opts.title,
      parentId: opts.parentId,
    });
    return resp.page;
  }

  // Update a page's editable fields. Only present keys are written. `parentId`
  // re-parents the page in the hierarchy (null = move to root); `sortOrder`
  // repositions it among its siblings.
  async updatePage(
    pageId: string,
    patch: {
      title?: string;
      content?: string;
      visibility?: "private" | "public";
      icon?: string | null;
      parentId?: string | null;
      sortOrder?: number;
    },
  ): Promise<Page> {
    const resp = await this.request<{ page: Page }>("cyborg:update_page", { pageId, ...patch });
    return resp.page;
  }

  // Toggle a page's soft-archive. Reversible — pass archived=false to restore.
  async setPageArchived(pageId: string, archived: boolean): Promise<Page> {
    const resp = await this.request<{ page: Page }>("cyborg:set_page_archived", {
      pageId,
      archived,
    });
    return resp.page;
  }

  // Hard-delete a page.
  async deletePage(pageId: string): Promise<void> {
    await this.request("cyborg:delete_page", { pageId });
  }

  // A single task's activity feed (history), ordered by `epoch` server-side.
  async fetchTaskActivity(taskId: string): Promise<TaskActivity[]> {
    const resp = await this.request<{ activity: TaskActivity[] }>("cyborg:fetch_task_activity", {
      taskId,
    });
    return resp.activity;
  }

  // ─── Extension point for subclasses ─────────────────────────────

  protected handleExtensionMessage(
    _type: string,
    _payload: Record<string, unknown> | undefined,
  ): boolean {
    return false;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private sendRaw(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    this.ws.send(JSON.stringify(data));
  }

  protected send(data: Record<string, unknown>): void {
    this.sendRaw({ type: "session", message: data });
  }

  // Resolve once the socket is OPEN, or reject after `timeoutMs`. Used to gate
  // RPCs so a fetch issued during a reconnect blip (or a navigation that races
  // the socket) waits for the connection instead of throwing "Not connected"
  // synchronously and leaving the view permanently empty until a manual reload.
  private waitForOpen(timeoutMs: number): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    // Event-driven (no polling): the open handler emits "connection" once the
    // socket is ready. The early return above closes the race where it's already
    // OPEN — there's no await between that check and attaching the listener, so
    // the event can't slip through in between.
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      const timer = setTimeout(() => {
        unsubscribe?.();
        reject(new Error("Not connected"));
      }, timeoutMs);
      unsubscribe = this.on("connection", (data) => {
        if (data.status === "connected") {
          clearTimeout(timer);
          unsubscribe?.();
          resolve();
        }
      });
    });
  }

  // Resolve once the socket is AUTHENTICATED (cyborg:auth has succeeded on the
  // current connection), or reject after `timeoutMs`. Gates non-auth RPCs so a
  // fetch issued in the window between socket-open and auth-complete (the
  // post-reconnect race) waits for auth instead of being silently dropped by
  // the relay and hanging until it times out — which left the view empty until
  // a manual reload.
  private waitForAuth(timeoutMs: number): Promise<void> {
    if (this.authenticated) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let waiter: { resolve: () => void; reject: (err: Error) => void } | undefined;
      const timer = setTimeout(() => {
        if (waiter) this.authWaiters.delete(waiter);
        reject(new Error("Not authenticated"));
      }, timeoutMs);
      waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.authWaiters.add(waiter);
    });
  }

  // `timeoutMs` overrides the default per-request RESPONSE timeout for RPCs whose
  // server-side work legitimately exceeds it. The prime case is
  // cyborg:restore_session / cyborg:import_session: the daemon SPAWNS the provider
  // (Claude SDK process boot) and replays the full transcript
  // (hydrateTimelineFromProvider) BEFORE emitting restore_session_response, which
  // for a real, day-old Claude session routinely takes longer than the 15s
  // default — so a slow-but-successful resume tripped the default timeout and
  // surfaced "Request cyborg:restore_session timed out" while the daemon was still
  // (successfully) resuming. The socket-readiness gates keep the default (a stalled
  // connection should fail fast); only the response wait is extended.
  protected async request<T>(
    type: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const responseTimeoutMs = timeoutMs ?? this.requestTimeoutMs;
    await this.waitForOpen(this.requestTimeoutMs);
    // Every RPC except the auth handshake itself must wait until the socket is
    // authenticated — otherwise the relay drops it on the floor (see authWaiters).
    if (type !== "cyborg:auth") await this.waitForAuth(this.requestTimeoutMs);
    return new Promise((resolve, reject) => {
      const requestId = `req_${++this.requestCounter}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${type} timed out`));
      }, responseTimeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });

      this.send({ type, requestId, ...params });
    });
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      // Settle the connect promise exactly once. A stalled handshake fires
      // neither `open` nor `error`, so without this watchdog doConnect() never
      // resolves OR rejects and every awaiter hangs forever. On timeout we close
      // the half-open socket (its `close` handler runs scheduleReconnect, exactly
      // like a failed connect) and reject so connectToServer surfaces a
      // retryable NetworkError instead of a permanent spinner.
      let settled = false;
      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // already closing/closed — the close handler covers reconnect.
        }
        reject(new Error("WebSocket connection timed out"));
      }, this.connectTimeoutMs);

      ws.addEventListener("open", () => {
        // Stale-socket guard: events are async, so a discarded socket (one a newer
        // connect() already replaced) can fire `open` late. Acting here would
        // clobber the live socket's hello/auth/heartbeat. Only the current socket
        // proceeds; a normal connect leaves this.ws === ws.
        if (this.ws && this.ws !== ws) return;
        if (settled) return; // a timeout already rejected — ignore a late open
        settled = true;
        clearTimeout(connectTimer);
        this.reconnectAttempts = 0;
        // Fresh socket: nothing is authenticated yet. Block gated RPCs until
        // cyborg:auth succeeds again on THIS connection.
        this.authenticated = false;
        this.sendRaw({
          type: "hello",
          clientId: `cyborg-ui-${Date.now()}`,
          clientType: "browser",
          protocolVersion: 1,
        });
        this.emit("connection", { status: "connected" } as EventMap["connection"]);
        // Start the transport-level liveness heartbeat for THIS connection (#503).
        // Tied to the socket lifecycle (not foreground-gated), so a
        // backgrounded-but-open tab still detects a half-open socket.
        this.startHeartbeat();
        resolve();
        // Re-authenticate the socket immediately so parked RPCs unblock even if
        // the app layer is slow to call authenticate() after a reconnect. The
        // relay's re-auth is idempotent, so a redundant call from the app is
        // harmless. (cyborg:auth bypasses the auth gate in request().)
        // intentional: opportunistic socket re-auth; a real auth failure surfaces via the app's own authenticate() + connection events.
        if (this.token) this.authenticate().catch(() => {});
      });

      ws.addEventListener("error", () => {
        if (this.ws && this.ws !== ws) return; // stale socket — not the live connection
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        reject(new Error("WebSocket connection failed"));
      });

      ws.addEventListener("close", () => {
        // Stale-socket guard: a discarded socket's `close` can arrive AFTER a
        // newer connect() set this.ws to a different live socket. Without this it
        // would null out the live socket and schedule a spurious reconnect. A
        // genuine teardown leaves this.ws === ws (normal close) or null
        // (disconnect already nulled it) — both fall through.
        if (this.ws && this.ws !== ws) return;
        this.ws = null;
        this.authenticated = false;
        // The heartbeat is per-connection: stop it here so a torn-down socket
        // leaves no orphan timer; the next open() starts a fresh one.
        this.stopHeartbeat();
        // Reset the per-workspace seq baselines (#499): the next connection
        // re-seeds from its first live event, by which point handleReconnect's
        // drainSync has already caught history up — so the reconnect boundary
        // never reads as a spurious gap.
        this.broadcastSeqs.clear();
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        } else {
          // Intentional close (logout/shutdown): fail parked RPCs now instead of
          // letting them hang for the full auth timeout.
          for (const w of this.authWaiters) w.reject(new Error("Client disconnected"));
          this.authWaiters.clear();
        }
      });

      ws.addEventListener("message", (event) => {
        if (this.ws && this.ws !== ws) return; // ignore frames from a discarded socket
        this.handleMessage(event.data as string);
      });
    });
  }

  private handleMessage(raw: string): void {
    let outer: { type?: string; message?: Record<string, unknown> };
    try {
      outer = JSON.parse(raw);
    } catch {
      return;
    }

    const msg =
      outer.type === "session" && outer.message
        ? outer.message
        : (outer as Record<string, unknown>);
    const type = msg.type as string | undefined;
    if (!type) return;

    const payload = (msg as { payload?: Record<string, unknown> }).payload;

    // guest_error is a top-level (non-session-wrapped) message with no
    // requestId — it can't reject a pending RPC, so route the HARD-PAUSE gate
    // to an event the app handles (open the activate modal).
    if (type === "guest_error") {
      const ge = msg as { error?: string; message?: string; license?: LicensePayload };
      if (ge.error === "license_required") {
        this.emit("license_required", {
          message: ge.message ?? "Trial ended — activate your license.",
          license: ge.license,
        } as EventMap["license_required"]);
      }
      return;
    }

    if (this.handleExtensionMessage(type, payload)) return;

    // Resolve pending RPC requests regardless of message type prefix
    if (payload && "requestId" in payload) {
      const pending = this.pendingRequests.get(payload.requestId as string);
      if (pending) {
        this.pendingRequests.delete(payload.requestId as string);
        clearTimeout(pending.timer);

        if (type === "cyborg:error" || type === "rpc_error") {
          const errPayload = payload as {
            message: string;
            error?: string;
            code?: string;
            license?: LicensePayload;
            backend?: string;
            reasonKind?: string;
            unavailableReason?: string;
          };
          // HARD-PAUSE gate: the relay rejects agent ops with a structured
          // license_required error. Surface it as a typed error so the caller
          // can open the activate modal instead of toasting a raw string.
          if (errPayload.error === "license_required") {
            pending.reject(new LicenseRequiredError(errPayload.message, errPayload.license));
          } else if (
            errPayload.code === "unavailable" &&
            (errPayload.backend || errPayload.reasonKind)
          ) {
            // A cybo backend gap (spawn refusal) — carry the daemon's classified
            // reason so the caller shows the exact remedy, not a raw string.
            pending.reject(
              new ProviderUnavailableError(errPayload.message, {
                backend: errPayload.backend,
                reasonKind: errPayload.reasonKind,
                unavailableReason: errPayload.unavailableReason,
              }),
            );
          } else {
            pending.reject(new Error(errPayload.message));
          }
        } else {
          pending.resolve(payload);
        }
        return;
      }
    }

    if (!type.startsWith("cyborg:")) return;

    this.dispatchBroadcast(type, payload);
  }

  // Typed against the concrete base SlackEventMap: statics cannot reference the
  // class's EventMap type parameter, and every broadcast here is a base event
  // that any EventMap (which extends SlackEventMap) is guaranteed to carry.
  private static readonly BROADCAST_MAP: Record<string, keyof SlackEventMap & string> = {
    "cyborg:channel_message_broadcast": "channel_message",
    "cyborg:cybo_mention_notice": "cybo_mention_notice",
    "cyborg:catchup_result": "catchup_result",
    "cyborg:dm_broadcast": "dm",
    "cyborg:typing_broadcast": "typing",
    "cyborg:delete_message_broadcast": "delete_message",
    "cyborg:edit_message_broadcast": "edit_message",
    "cyborg:pin_message_broadcast": "pin_message",
    "cyborg:read_broadcast": "read",
    "cyborg:activity_new": "activity_new",
    "cyborg:daemon_access_request_changed": "daemon_access_request_changed",
    "cyborg:notification_pref_changed": "notification_pref_changed",
    "cyborg:draft_changed": "draft_changed",
    "cyborg:members_updated": "members_updated",
    "cyborg:workspace_autonomy_updated": "workspace_autonomy_updated",
    "cyborg:tasks_changed": "tasks_changed",
    "cyborg:pages_changed": "pages_changed",
    "cyborg:daemon_status_broadcast": "daemon_status",
    "cyborg:channel_created_broadcast": "channel_created",
    "cyborg:group_dm_created_broadcast": "group_dm_created",
    "cyborg:channel_updated_broadcast": "channel_updated",
    "cyborg:channel_deleted_broadcast": "channel_deleted",
    "cyborg:channel_member_added_broadcast": "channel_member_added",
    "cyborg:channel_member_removed_broadcast": "channel_member_removed",
    "cyborg:channel_cybo_added_broadcast": "channel_cybo_added",
    "cyborg:channel_cybo_removed_broadcast": "channel_cybo_removed",
    "cyborg:cybo_updated_broadcast": "cybo_updated",
    "cyborg:cybo_created_broadcast": "cybo_created",
    "cyborg:cybo_deleted_broadcast": "cybo_deleted",
    "cyborg:thread_updated": "thread_updated",
    "cyborg:thread_read_changed": "thread_read_changed",
    "cyborg:thread_follow_changed": "thread_follow_changed",
    // #607: the payload IS the updated ScheduledMessage row, so the default
    // dispatch path (emit payload as-is) carries it straight to subscribers.
    "cyborg:schedule_message_failed": "schedule_message_failed",
    // #619: a schedule mutation fanned out to all clients (no requestId on the
    // broadcast copy; the requesting client's ack is resolved by requestId first).
    "cyborg:schedule_mutated": "schedule_mutated",
    "cyborg:server_shutdown": "server_shutdown",
    "cyborg:error": "error",
  };

  // Track the highest broadcast seq per workspace and emit `seq_gap` on a forward
  // jump (#499). A real loss (Redis pub/sub hiccup, flaky link on an open socket)
  // and a benign hole (a DM between OTHER users consuming a seq we never receive)
  // are indistinguishable here, so this only SIGNALS; the app's handler coalesces
  // the recovery. seq < expected is a duplicate/stale event (already have it).
  private observeBroadcastSeq(payload: Record<string, unknown>): void {
    const seq = payload.seq;
    const workspaceId = payload.workspaceId;
    if (typeof seq !== "number" || typeof workspaceId !== "string") return;
    const prev = this.broadcastSeqs.get(workspaceId);
    if (prev === undefined) {
      // First seq-carrying event for this workspace on this connection: seed the
      // baseline (history was already established by the initial fetch / sync).
      this.broadcastSeqs.set(workspaceId, seq);
      return;
    }
    if (seq <= prev) return; // duplicate / out-of-order — already accounted for
    if (seq > prev + 1) {
      // Hole: we expected prev+1. Hand the app the cursor to catch up FROM.
      this.emit(
        "seq_gap" as keyof EventMap & string,
        {
          workspaceId,
          fromSeq: prev,
        } as EventMap[keyof EventMap & string],
      );
    }
    this.broadcastSeqs.set(workspaceId, seq);
  }

  private dispatchBroadcast(type: string, payload: Record<string, unknown> | undefined): void {
    // Every broadcast carries its data in `payload`. A broadcast that arrives
    // without it is malformed (e.g. a server type not yet migrated to the
    // payload envelope) — drop it instead of dereferencing undefined, which
    // used to throw an uncaught TypeError in the message handler.
    if (!payload) return;
    // Seq-gap detection (#499) runs FIRST so it sees EVERY seq-carrying broadcast
    // uniformly (channel messages + DMs share one per-workspace counter), before
    // any type-specific early-return below. Backward-compatible: a payload with no
    // numeric seq (older relay, or a non-sequenced event) is simply not tracked.
    this.observeBroadcastSeq(payload);
    if (type === "cyborg:reaction_broadcast") {
      const rp = payload as { userId: string; userName?: string; [k: string]: unknown };
      this.emit("reaction", {
        ...rp,
        fromId: rp.userId,
        fromName: rp.userName,
      } as unknown as EventMap["reaction"]);
      return;
    }

    if (type === "cyborg:tasks_changed") {
      // The broadcast `task` carries the same relay `mapTask` readback as the
      // RPC responses — Plane fields in snake_case. Normalize it to the camelCase
      // `Task` model so live-update subscribers match the fetch path. A "deleted"
      // op (or a recurrence-spawned partial) sends only `{ id }`; mapRawTask is
      // tolerant of the missing fields (they default to null/[]).
      const tp = payload as { workspaceId: string; op: string; task: RawTask };
      this.emit(
        "tasks_changed" as keyof EventMap & string,
        {
          ...tp,
          task: mapRawTask(tp.task),
        } as EventMap[keyof EventMap & string],
      );
      return;
    }

    const event = SlackClient.BROADCAST_MAP[type];
    if (event && payload) {
      // EventMap extends SlackEventMap, so every base broadcast key is a key of
      // EventMap — TS can't prove that for a generic parameter, hence the cast.
      this.emit(event as keyof EventMap & string, payload as EventMap[keyof EventMap & string]);
    }
  }

  protected emit<K extends keyof EventMap & string>(event: K, data: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch {
        // listener errors don't crash the client
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit("connection", { status: "disconnected" } as EventMap["connection"]);
      return;
    }

    // Full jitter over the capped-exponential envelope — de-synchronizes the
    // mass reconnect after a relay deploy (#504). The banner reads `delayMs`
    // below, so it shows the actual (jittered) wait, not the envelope.
    const delay = reconnectBackoffMs(this.reconnectAttempts);
    // 1-based, human-facing attempt counter for the reconnect banner.
    const attempt = this.reconnectAttempts + 1;
    this.emit("connection", {
      status: "reconnecting",
      attempt,
      delayMs: delay,
    } as EventMap["connection"]);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      // intentional: a failed reconnect re-schedules via the backoff loop + emits "reconnecting"/"disconnected" events the UI shows.
      this.doConnect().catch(() => {});
    }, delay);
  }
}

import { SlackClient } from "./core/client.js";
import type {
  SlackEventMap,
  LicensePayload,
  BillingIntentPayload,
  BillingPlatformPayload,
} from "./core/client.js";
import { passkeyRegister, passkeyList, passkeyDelete } from "./passkey.js";
import type { PasskeyInfo } from "./passkey.js";
import type {
  Agent,
  AgentStreamPayload,
  AgentPermissionResponse,
  AgentSlashCommand,
  ProviderInfo,
  Cybo,
} from "./plugins/agents/types.js";
import type {
  Channel,
  ChannelMember,
  Attachment,
  Unfurl,
  MessageCard,
  ScheduledMessage,
  Message,
  Cycle,
  Module,
  TaskLink,
  TaskAttachment,
} from "./core/types.js";
import type { TerminalSocket } from "./components/terminal/terminal-transport.js";

// ─── Recurring cybo schedules (#611/#613/#619) ─────────────────────────────
// A schedule belongs to a CYBO and runs it with `prompt` on a `cron` expression.
// These mirror the server's CyborgScheduleViewSchema / CyborgScheduleRunViewSchema
// (packages/server/.../cyborg-messages.ts). The clock lives on the daemon; the UI
// only does CRUD + reads run history. Phase-2 fields (maxRuns/runCount/catchUp/
// stale) are optional so older payloads still typecheck.
export interface ScheduleView {
  id: string;
  workspaceId: string;
  cyboId: string;
  cyboName: string | null;
  channelId: string | null;
  // Per-task scheduling: the task this schedule fires (run as its assignee cybo,
  // unattended). null/absent = a raw-prompt cybo schedule. Lets a per-task editor
  // find the schedule bound to a given task by filtering the workspace list.
  taskId?: string | null;
  cron: string;
  timezone: string | null;
  prompt: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  maxRuns?: number | null;
  runCount?: number;
  catchUp?: boolean;
  stale?: boolean;
  createdBy: string;
  createdAt: number;
}

export interface ScheduleRunView {
  id: string;
  scheduleId: string;
  scheduledFor: number | null;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  skipReason: "license_paused" | "overlap" | "unauthorized" | null;
  agentId: string | null;
  error: string | null;
}

export type ScheduleMutationOp = "create" | "update" | "set_enabled" | "delete" | "run_once";

// The `cyborg:schedule_mutated` payload — both the RPC ack AND (when the relay
// fans it out) a cross-client broadcast. `schedule` is the resulting row for
// create/update/set_enabled, null for delete/run_once. `ok:false` carries `error`.
export interface ScheduleMutatedPayload {
  requestId?: string;
  ok: boolean;
  op: ScheduleMutationOp;
  scheduleId: string | null;
  schedule?: ScheduleView | null;
  error?: string;
}

// ─── Built-in integrations (recipes) ─────────────────────────────────────────
// A "recipe" enables a built-in automation: the daemon provisions a cybo (preset
// soul + permissions) + N schedules + channel membership, recorded in
// installed_recipes. Disable tears the cybo down (cascade) and marks the row
// disabled. The display catalog (id/keys) lives in lib/integrations/recipes-catalog.ts;
// the server registry is the provisioning source of truth — they share recipeId +
// config keys. Mirrors the server's RecipeView (Stream A contract).
export interface RecipeView {
  id: string;
  workspaceId: string;
  recipeId: string;
  enabled: boolean;
  config: Record<string, unknown>;
  // The provisioned cybo's id (null until provisioned / after teardown).
  cyboId: string | null;
  scheduleIds: string[];
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// Secret-bearing credential payload for `cyborg:set_cybo_credential` — mirrors the
// server `ProviderCredentialPayload` union (api | oauth | wellknown; `cli` stores
// nothing). NEVER echoed back: set/remove return `{ ok: true }`, list returns
// metadata only. internal docs §6.
export type ProviderCredentialPayload =
  | { type: "api"; key: string; metadata?: Record<string, string> }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      accountId?: string;
      enterpriseUrl?: string;
    }
  | { type: "wellknown"; key: string; token: string };

// Metadata-only row from `cyborg:list_provider_auth` — proves a credential of a
// given `type` exists for `providerId` on a daemon, WITHOUT revealing the secret.
export interface ProviderAuthMeta {
  providerId: string;
  type: "api" | "oauth" | "wellknown";
  expires?: number;
}

// One shared-file row (M-files): a single attachment flattened out of a
// message, newest-first. Multi-attachment messages contribute multiple rows
// that share `messageId`.
export interface SharedFile {
  messageId: string;
  createdAt: number;
  senderName: string;
  attachment: Attachment;
}

export interface SharedFilesPage {
  files: SharedFile[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface RecentSession {
  providerId: string;
  providerLabel: string;
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: string;
}

// Read-only session viewer (#994): the captured injected context of an ephemeral
// cybo session. `mcpServers` are the tools MADE AVAILABLE at spawn (server
// configs, not the runtime-resolved tool list). Secrets are redacted by the daemon.
export interface SessionContextMcpServer {
  name: string;
  type: string;
  url?: string;
  toolkit?: string;
}

export interface SessionContextBundle {
  systemPrompt: string | null;
  mcpServers: SessionContextMcpServer[];
  routedPrompt: string | null;
  rawPrompt: string | null;
  cyboId: string | null;
  channelId: string | null;
  createdAt: number;
}

// One workspace terminal-directory entry — the daemon's view of a tracked session
// (terminal CLI-UI unification). Mirrors the server's CyborgTerminalDirEntry. Lets
// the sidebar render terminals the client did NOT itself open (CLI / other client).
export interface TerminalDirectoryEntry {
  terminalId: string;
  workspaceId: string;
  daemonId: string | null;
  cwd: string | null;
  title?: string;
  startedAt?: number;
  live: boolean;
}

export interface ArchivedSession {
  id: string;
  provider: string;
  providerHandleId: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  cyboId: string | null;
  cyboName: string | null;
  cyboAvatar: string | null;
  archivedAt: number;
  // Owning daemon, stamped by the relay's archived-session fan-out aggregator
  // (#593). Sent back on restore so the relay scopes + routes the restore to the
  // daemon that actually holds it. Absent in solo/single-daemon flows.
  daemonId?: string | null;
}

// Optional config overrides applied when RESUMING an archived session (#593).
// All optional — omitting them (or the whole object) resumes on the archived
// config. Mirrors the `{ model?, modeId?, thinkingOptionId? }` shape the daemon
// forwards into Paseo's resumeAgentFromPersistence overrides.
export interface ResumeOverrides {
  model?: string;
  modeId?: string;
  thinkingOptionId?: string | null;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

export interface ChannelProject {
  channelId: string;
  projectId: string;
}

export interface PresenceUpdatePayload {
  onlineUserIds: string[];
  // P2 Item 6: subset of online users who manually set themselves away.
  awayUserIds?: string[];
}

export interface UserStatusEntry {
  userId: string;
  emoji: string | null;
  text: string | null;
  expiresAt: number | null;
}

// A co-member's status changed live (P2 Item 6).
export interface UserStatusChangedPayload {
  workspaceId: string;
  userId: string;
  emoji: string | null;
  text: string | null;
  expiresAt: number | null;
}

// A conversation read also cleared its Activity feed items (P2 Item 9). Scoped
// to the user's own devices.
export interface ActivityReadChangedPayload {
  workspaceId: string;
  channelId?: string | null;
  dmPeerId?: string | null;
  // Set when a task's detail card was opened (mark_task_read) — clears that
  // task's activity rows on the user's other devices.
  taskId?: string | null;
  unread: number;
}

// URL unfurls finished fetching for a message (Tier 2). The relay broadcasts
// this after its async OG/oEmbed fetch, separately from the message itself.
// Channel messages carry `channelId`; DMs carry `toId` + `fromId` instead. The
// client patches the message in place wherever it's currently rendered.
export interface MessageUnfurledPayload {
  messageId: string;
  workspaceId: string;
  unfurls: Unfurl[];
  // Channel surface.
  channelId?: string | null;
  // DM surface (one of these branches is present, not both).
  toId?: string | null;
  fromId?: string | null;
}

// A card was re-rendered after a signed action resolved it (#600). The client
// patches the message's card in place wherever it's rendered.
export interface MessageCardUpdatedPayload {
  workspaceId: string;
  channelId: string | null;
  messageId: string;
  card: MessageCard | null;
}

// A personal save toggled on one of MY devices (#609). Per-user broadcast (only
// ever sent back to the saver's own sockets), so the Saved view stays in sync
// across devices without ever leaking my bookmarks to the workspace.
export interface SaveMessagePayload {
  workspaceId: string;
  messageId: string;
  saved: boolean;
}

// Task-processing observability (Logs tab): a structured, human-readable event
// from the watcher + task lifecycle, fanned out to the workspace as
// `cyborg:task_event`. The payload IS the pre-formatted Logs line (the server's
// task-event-log formatter built `level`/`source`/`message`), so the app pushes
// it straight into logState. `category` is always "task".
export interface TaskEventPayload {
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  category: "task";
  workspaceId: string;
  channelId?: string | null;
  taskId?: string | null;
  cyboId?: string | null;
}

// Audit-trace observability (#995, Logs tab): a structured audit event from the
// cybo context/tool/spawn/daemon traces, fanned out to the workspace as
// `cyborg:audit_event`. The payload IS the pre-formatted, REDACTED Logs line
// (the server's audit-event-log formatter built level/source/message + stripped
// secrets), so the app pushes it straight into logState — but unlike task events
// it keeps the structured ids (agentId/cyboId/daemonId/kind/payload) the Logs
// filters slice by.
export type AuditCategory =
  | "context_injection"
  | "tool_injection"
  | "spawn_lifecycle"
  | "invocation_decision"
  | "daemon_operation"
  | "failure";

export interface AuditEventPayload {
  level: "debug" | "info" | "warn" | "error";
  source: string;
  message: string;
  category: AuditCategory;
  kind: string;
  workspaceId: string;
  daemonId?: string | null;
  agentId?: string | null;
  cyboId?: string | null;
  userId?: string | null;
  channelId?: string | null;
  payload: Record<string, unknown>;
}

interface CyborgEventMap extends SlackEventMap {
  agent_stream: AgentStreamPayload;
  presence: PresenceUpdatePayload;
  user_status_changed: UserStatusChangedPayload;
  activity_read_changed: ActivityReadChangedPayload;
  message_unfurled: MessageUnfurledPayload;
  message_card_updated: MessageCardUpdatedPayload;
  save_message: SaveMessagePayload;
  task_event: TaskEventPayload;
  audit_event: AuditEventPayload;
  // A built-in recipe was enabled/disabled (possibly by another client). The relay
  // fans `cyborg:recipes_changed` out so every open integrations view re-lists.
  recipes_changed: { workspaceId: string };
}

export type {
  LicensePayload,
  BillingIntentPayload,
  BillingActionPayload,
  BillingPlatformPayload,
} from "./core/client.js";
export { LicenseRequiredError } from "./core/client.js";

// ─── License pool + allocation (per-workspace billing, spec §4.3) ──────────
// A POOL is the caller's seat entitlement on a rail (iOS tier product or a
// Stripe sub). ALLOCATIONS spend seats on specific workspaces. A workspace is
// Pro iff it has an honored allocation from a good-standing pool. These shapes
// MUST match the relay's `cyborg:fetch_license_pool` / `allocate_license` /
// `deallocate_license` handlers (Unit E, being built in parallel) byte-for-byte.

/** The caller's seat entitlement on one rail, as the relay reports it. */
export interface LicensePoolPayload {
  /** Seats this pool grants (derived server-side from the tier product). */
  seatCount: number;
  /** Mirrors subscriptions.status: 'active' | 'trialing' | 'canceled' | … */
  status: string;
  /** Renewal/expiry of the pool (epoch ms) or null. */
  currentPeriodEnd: number | null;
  /** Which rail funds this pool — drives "manage in App Store" vs Stripe copy. */
  rail: "ios" | "stripe";
  /** Pool will not renew (Apple cancel-but-still-in-period / Stripe cancel). */
  cancelAtPeriodEnd?: boolean;
}

/** One workspace that currently spends a seat from the caller's pool. */
export interface LicenseAllocationEntry {
  workspaceId: string;
}

/** A workspace the caller owns (the relay's authoritative owned-list). */
export interface OwnedWorkspaceEntry {
  id: string;
  name: string;
  /** Mirror of getLicenseStatus.state — drives per-row status in the panel. */
  state: "trialing" | "active" | "paused";
  /** Epoch ms trial expiry, or null (non-trial workspaces). */
  trialEndsAt: number | null;
}

/** Response of `cyborg:fetch_license_pool` — the whole allocation surface. */
export interface LicensePoolResponse {
  pool: LicensePoolPayload | null;
  allocations: LicenseAllocationEntry[];
  ownedWorkspaces: OwnedWorkspaceEntry[];
}

/**
 * Response of `cyborg:allocate_license` / `cyborg:deallocate_license`. The relay
 * returns the affected workspace's fresh license (so the gate mirror updates)
 * plus the recomputed pool + allocation set. On a rejected mutation it returns
 * an `error` code (`no_free_seat` | `not_owner` | `no_pool` |
 * `already_active_other_rail`) and leaves pool/allocations unchanged.
 */
export interface LicenseAllocationResponse {
  workspaceId: string;
  license: LicensePayload;
  pool: LicensePoolPayload | null;
  allocations: LicenseAllocationEntry[];
  error?: string;
}

// Workspace-wide Home aggregates (server: PgSync.getWorkspaceHomeStats). All
// metrics are scoped to the whole workspace and the trailing 7 days (heatmap:
// ~126 days). Empty/zero until session history accumulates.
export interface WorkspaceHomeStats {
  sessionsThisWeek: number;
  tokensThisWeek: number;
  agentHoursThisWeek: number;
  tasksShippedThisWeek: number;
  dailyActivity: { day: string; count: number }[];
  topAgents: { provider: string | null; cyboId: string | null; sessions: number; tokens: number }[];
}

// A repo↔Tasks-project binding (server: PgSync.StoredGithubRepoSync). The settings
// panel renders the "connected to <owner/name>" state from these.
export interface GithubRepoSync {
  id: string;
  workspaceId: string;
  installationId: string;
  tasksProjectId: string;
  repoId: string;
  owner: string;
  name: string;
  repoUrl: string;
  // 0039: 'inbound' = GH→Tasks one-way; 'bidirectional' = GH↔Tasks write-back.
  syncDirection: string;
  // Optional per-binding open/closed task-state overrides (null → project default).
  issueOpenStateId: string | null;
  issueClosedStateId: string | null;
  createdBy: string;
  createdAt: number;
}

// A repository the GitHub App installation can access (the bind picker source).
// Populated from the GitHub API via an installation token; empty when the App's
// live creds are absent and the UI falls back to manual entry.
export interface GithubInstallationRepo {
  repoId: string;
  owner: string;
  name: string;
  repoUrl: string;
}

// A GitHub App installation a workspace authorized (the account/org picker source +
// the detail page's connected-org row). Server: PgSync.StoredGithubInstallation.
export interface GithubInstallation {
  id: string;
  workspaceId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  createdBy: string;
  createdAt: number;
}

// A project-level PR-state → task-state mapping (Image #3). Server:
// PgSync.StoredGithubPrStateMapping. `taskStateId` null = "Set State" unset.
export interface GithubPrStateMapping {
  id: string;
  workspaceId: string;
  tasksProjectId: string;
  prState: string;
  taskStateId: string | null;
  skipBackward: boolean;
  createdBy: string;
  createdAt: number;
}

// A personal GitHub account a workspace member connected via OAuth (the detail
// page's "Personal account connected" row). The relay surfaces only safe fields
// — NEVER the OAuth access token. Server: PgSync.StoredGithubUserConnection (trimmed).
export interface GithubUserConnection {
  id: string;
  githubLogin: string;
  scopes: string | null;
  createdAt: number;
}

// A Slack installation a workspace authorized (the integration detail page's connected
// workspace row[s]). The relay surfaces only safe fields — NEVER the bot access token.
// Server: PgSync.StoredIntegrationInstallation (provider 'slack', trimmed). `externalId`
// is the Slack team id; `config` carries display metadata (e.g. { teamName }).
export interface SlackInstallation {
  id: string;
  workspaceId: string;
  provider: string;
  externalId: string;
  config: Record<string, unknown>;
  botUserId: string | null;
  scopes: string | null;
  installedBy: string;
  createdAt: number;
}

// A Slack↔Cyborg channel link — one (Slack channel ↔ Cyborg channel) binding the
// settings UI lists/creates/removes. Server: PgSync.StoredSlackChannelLink.
export interface SlackChannelLink {
  id: string;
  workspaceId: string;
  installationId: string;
  cyborgChannelId: string;
  slackChannelId: string;
  slackTeamId: string;
  syncDirection: string;
  createdBy: string;
  createdAt: number;
}

// Straight-through wire→event map for handleExtensionMessage (#995): a
// `cyborg:<wire>` frame whose handling is just `emit(<event>, payload)` lives here,
// so the dispatch stays table-driven instead of one branch per type.
const SIMPLE_PASSTHROUGH: Record<string, keyof CyborgEventMap> = {
  "cyborg:agent_stream": "agent_stream",
  "cyborg:task_event": "task_event",
  "cyborg:audit_event": "audit_event",
  "cyborg:presence_update": "presence",
  "cyborg:user_status_changed": "user_status_changed",
  "cyborg:activity_read_changed": "activity_read_changed",
  "cyborg:message_unfurled": "message_unfurled",
  // Personal save toggled on another of my devices (#609) — keep the Saved view
  // in sync. Per-user only; never carries another user's bookmarks.
  "cyborg:save_message_broadcast": "save_message",
  // A built-in recipe install changed — re-list the integrations "Built-in" section.
  "cyborg:recipes_changed": "recipes_changed",
};

// Resuming an archived session (restore_session / import_session) is far slower
// than a normal RPC: on the daemon, handleRestoreSession SPAWNS the provider
// (Claude SDK process boot) and replays the WHOLE transcript
// (hydrateTimelineFromProvider) BEFORE it emits restore_session_response. For a
// real, day-old Claude session that easily exceeds the 15s default request
// timeout — so a slow-but-successful resume rejected with "Request
// cyborg:restore_session timed out" while the daemon was still resuming
// (orphaning the now-live agent the user never navigated to). Give these two RPCs
// a generous window so the success response can land. 90s comfortably covers a
// cold provider boot + long-transcript hydrate without hanging the UI forever on
// a genuinely dead resume.
const RESUME_SESSION_TIMEOUT_MS = 90_000;

export class CyborgClient extends SlackClient<CyborgEventMap> {
  // Per-type listeners for the terminal stream (#673). The terminal protocol is
  // high-frequency and keyed by terminalId, not a request/response, so it can't
  // ride the typed SlackEventMap; TerminalView subscribes through terminalSocket()
  // and handleExtensionMessage fans the inbound frames out here.
  private readonly terminalListeners = new Map<
    string,
    Set<(payload: Record<string, unknown>) => void>
  >();

  // A minimal TerminalSocket (terminal-transport.ts shape) over this client, so
  // relayTerminalTransport can drive a cloud terminal without the transport
  // module importing the concrete client.
  terminalSocket(): TerminalSocket {
    return {
      send: (message) => this.send(message),
      on: (type, handler) => {
        let set = this.terminalListeners.get(type);
        if (!set) {
          set = new Set();
          this.terminalListeners.set(type, set);
        }
        set.add(handler);
        return () => {
          set?.delete(handler);
          // Drop the empty key so the map doesn't accrue dead Sets over many
          // terminal sessions.
          if (set && set.size === 0) this.terminalListeners.delete(type);
        };
      },
      // Fire when the socket RE-establishes after a drop (#48 BUG-2). The base
      // client emits `connection: connected` on every open INCLUDING the first,
      // so we gate on having seen a prior down (`disconnected`/`reconnecting`).
      // The daemon-scoped terminal stream is ephemeral (not part of seq-based
      // history sync), so on reconnect the daemon never re-binds the pty to the
      // new socket — the view must re-issue attach(). We defer the handler until
      // the socket re-authenticates, otherwise the relay drops the attach send
      // and it times out into a frozen (or worse, freshly re-spawned) terminal.
      onReconnect: (handler) => {
        let down = false;
        return this.on("connection", (data) => {
          if (data.status === "disconnected" || data.status === "reconnecting") {
            down = true;
            return;
          }
          if (data.status === "connected" && down) {
            down = false;
            void this.whenAuthenticated(15_000)
              .then(() => handler())
              .catch(() => {
                // Re-auth never landed within the window — a later reconnect (or
                // a manual nav away+back) retries. Never throw into the emitter.
              });
          }
        });
      },
      // Fire on a DAEMON↔relay flap (offline→online) for `daemonId` while THIS
      // view's guest socket stays OPEN (internal docs FIX-1, the headline fix). On a
      // daemon-side flap `onReconnect` above NEVER fires (the guest socket never
      // dropped), yet the daemon stopped streaming during the gap and never
      // re-pushes a snapshot — so the terminal freezes / dead-ends. The relay
      // already broadcasts cyborg:daemon_status_broadcast → the typed `daemon_status`
      // event; we fire `handler` on the offline→online edge (a first `online` after
      // any `offline`) for THIS daemonId so the view re-subscribes (reattachLive).
      // Gated on whenAuthenticated for symmetry with onReconnect: the guest socket
      // usually stayed up, but if BOTH flapped this keeps the re-subscribe send from
      // racing re-auth and being dropped by the relay.
      onDaemonReconnect: (daemonId, handler) => {
        let sawOffline = false;
        return this.on("daemon_status", (data) => {
          if (data.daemonId !== daemonId) return;
          if (data.status === "offline") {
            sawOffline = true;
            return;
          }
          if (data.status === "online" && sawOffline) {
            sawOffline = false;
            void this.whenAuthenticated(15_000)
              .then(() => handler())
              .catch(() => {
                // Re-auth never landed within the window — the next status flip or
                // a manual nav retries. Never throw into the emitter.
              });
          }
        });
      },
    };
  }

  // Resolve once the socket is authenticated on the CURRENT connection, or
  // reject after `timeoutMs`. The base client's waitForAuth is private, so this
  // mirrors it via the public `authenticated` flag for the terminal reconnect
  // gate (terminalSocket().onReconnect). Polls rather than event-subscribes
  // because there is no public auth-success event; the cadence is coarse since
  // it only runs on the reconnect path, not in steady state.
  private whenAuthenticated(timeoutMs: number): Promise<void> {
    if (this.authenticated) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const tick = () => {
        if (this.authenticated) return resolve();
        if (Date.now() - startedAt >= timeoutMs) {
          return reject(new Error("terminal reconnect: re-auth timed out"));
        }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    });
  }

  // ─── Agent methods ──────────────────────────────────────────────

  async createAgent(
    workspaceId: string,
    provider: string,
    cwd: string,
    opts?: {
      model?: string;
      systemPrompt?: string;
      channelId?: string;
      title?: string;
      daemonId?: string;
    },
  ): Promise<Agent> {
    const resp = await this.request<{ agent: Agent }>("cyborg:create_agent", {
      workspaceId,
      provider,
      cwd,
      ...opts,
    });
    return resp.agent;
  }

  async listAgents(workspaceId: string): Promise<Agent[]> {
    const resp = await this.request<{ agents: Agent[] }>("cyborg:list_agents", { workspaceId });
    return resp.agents;
  }

  // Daemon-owner audit listing (#993): ALL sessions on ONE daemon (incl. ephemeral
  // + other users'), gated on the `admin` daemon scope (owner implicit). Distinct
  // from listAgents — the result must stay in the daemon-detail's LOCAL state, never
  // the global agents store that feeds the chat sidebar. Rows carry ephemeral /
  // internal badges absent on the scoped list.
  async listDaemonSessions(workspaceId: string, daemonId: string): Promise<Agent[]> {
    const resp = await this.request<{ sessions: Agent[] }>("cyborg:list_daemon_sessions", {
      workspaceId,
      daemonId,
    });
    return resp.sessions;
  }

  // Start a daemon-scoped terminal session (terminal epic part 3, #656).
  //
  // Matches the merged #657 contract exactly:
  //   send    cyborg:start_terminal { workspaceId, daemonId?, cwd?, cols, rows }
  //   receive cyborg:start_terminal_response { ok, terminalId?, error? }
  // The session is daemon-scoped (NOT persisted to PG); its I/O streams over
  // cyborg:terminal_output / _input / _resize / _kill (wired by TerminalView,
  // #655), keyed by terminalId. cols/rows here are a seed — TerminalView sends a
  // real resize once its xterm fit() runs.
  async startTerminal(
    workspaceId: string,
    opts: { daemonId?: string; cwd?: string; cols: number; rows: number },
  ): Promise<{ terminalId: string }> {
    // start_terminal_response is fanned out to terminalListeners (see
    // handleExtensionMessage), NOT to the request() resolver — so using
    // this.request() here hangs forever ("Request cyborg:start_terminal timed
    // out"): the interceptor consumes the response before the pending request can
    // see it. Correlate it through the terminal socket instead, exactly like
    // relayTerminalTransport.start() does (#656/#673 path collision).
    const requestId = `term_${crypto.randomUUID()}`;
    const sock = this.terminalSocket();
    return new Promise<{ terminalId: string }>((resolve, reject) => {
      let off: (() => void) | undefined;
      const timer = setTimeout(() => {
        off?.();
        reject(new Error("Failed to start terminal session (timed out)"));
      }, 15_000);
      off = sock.on("cyborg:start_terminal_response", (payload) => {
        if (payload.requestId !== requestId) return;
        clearTimeout(timer);
        off?.();
        // Untrusted WS JSON — validate the fields we consume, not just the cast.
        if (payload.ok === true && typeof payload.terminalId === "string") {
          resolve({ terminalId: payload.terminalId });
        } else {
          reject(
            new Error(
              typeof payload.error === "string"
                ? payload.error
                : "Failed to start terminal session",
            ),
          );
        }
      });
      sock.send({ type: "cyborg:start_terminal", requestId, workspaceId, ...opts });
    });
  }

  // Pull the daemon's tracked terminal DIRECTORY for a workspace (terminal CLI-UI
  // unification). Unlike startTerminal (whose *_response is intercepted by the
  // terminalListeners fan-out), list_terminals_response is NOT in that whitelist,
  // so the normal request() correlation resolves it. Returns the owner's live
  // sessions — including any started out-of-band (CLI, another client) — so the
  // sidebar can render terminals it didn't itself open.
  async listTerminals(
    workspaceId: string,
    opts?: { daemonId?: string },
  ): Promise<TerminalDirectoryEntry[]> {
    const resp = await this.request<{ terminals: TerminalDirectoryEntry[] }>(
      "cyborg:list_terminals",
      { workspaceId, ...(opts?.daemonId ? { daemonId: opts.daemonId } : {}) },
    );
    return resp.terminals ?? [];
  }

  // Subscribe to the daemon's PUSH directory feed (cyborg:terminals_changed): the
  // daemon broadcasts the full workspace snapshot to the owner on every terminal
  // start/exit, so a session opened or killed out-of-band updates the sidebar live.
  // Returns an unsubscribe fn. Rides the terminalSocket() fan-out (the frame is
  // whitelisted in handleExtensionMessage). The caller filters by workspaceId.
  onTerminalsChanged(
    handler: (payload: { workspaceId: string; terminals: TerminalDirectoryEntry[] }) => void,
  ): () => void {
    return this.terminalSocket().on("cyborg:terminals_changed", (payload) =>
      handler(payload as unknown as { workspaceId: string; terminals: TerminalDirectoryEntry[] }),
    );
  }

  // Subscribe to the per-user terminal-alias change feed (cyborg:terminal_alias_changed):
  // the server fans a rename/clear out to the user's OTHER clients (owner-scoped),
  // so a rename done on one device updates the rest live. An empty `alias` means
  // the alias was cleared. Returns an unsubscribe fn; rides the terminalSocket()
  // fan-out (the frame is whitelisted in handleExtensionMessage).
  onTerminalAliasChanged(
    handler: (payload: { terminalId: string; alias: string }) => void,
  ): () => void {
    return this.terminalSocket().on("cyborg:terminal_alias_changed", (payload) =>
      handler(payload as unknown as { terminalId: string; alias: string }),
    );
  }

  async listProviders(opts?: { daemonId?: string }): Promise<ProviderInfo[]> {
    const resp = await this.request<{ providers: ProviderInfo[] }>("cyborg:list_providers", opts);
    return resp.providers;
  }

  async listRecentCwds(opts?: { daemonId?: string }): Promise<{ home: string; recent: string[] }> {
    return this.request<{ home: string; recent: string[] }>("cyborg:list_recent_cwds", opts);
  }

  async sendAgentPrompt(
    workspaceId: string,
    agentId: string,
    prompt: string,
    attachments?: Attachment[],
  ): Promise<void> {
    await this.request("cyborg:send_agent_prompt", {
      workspaceId,
      agentId,
      prompt,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  }

  // Invoke a signed card button (#600): echo the opaque token back; the server
  // verifies signature + actor + expiry before executing. The settled card
  // arrives separately via the message_card_updated broadcast.
  async sendMessageAction(
    workspaceId: string,
    messageId: string,
    actionId: string,
    token: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return this.request<{ ok: boolean; error?: string }>("cyborg:message_action", {
      workspaceId,
      messageId,
      actionId,
      token,
    });
  }

  // ─── Scheduled messages (#607 — user send-later) ────────────────
  // Queue a chat message to send at a future time. EXACTLY ONE of channelId /
  // toId targets a channel or a DM peer; `sendAt` is epoch ms and must be in the
  // future (the server re-validates). Returns the created row on success.
  async scheduleMessageCreate(params: {
    workspaceId: string;
    channelId?: string;
    toId?: string;
    text: string;
    sendAt: number;
    mentions?: string[];
  }): Promise<{ ok: boolean; op: "create"; message?: ScheduledMessage; error?: string }> {
    return this.request<{
      ok: boolean;
      op: "create";
      message?: ScheduledMessage;
      error?: string;
    }>("cyborg:schedule_message_create", { ...params });
  }

  // List the caller's scheduled messages for a workspace (pending, sent, failed).
  async scheduleMessageList(workspaceId: string): Promise<{ messages: ScheduledMessage[] }> {
    return this.request<{ messages: ScheduledMessage[] }>("cyborg:schedule_message_list", {
      workspaceId,
    });
  }

  // Cancel a still-pending scheduled message. No-op server-side for an already
  // sent/failed row (the response carries the error then).
  async scheduleMessageCancel(
    workspaceId: string,
    id: string,
  ): Promise<{ ok: boolean; op: "cancel"; id: string; error?: string }> {
    return this.request<{ ok: boolean; op: "cancel"; id: string; error?: string }>(
      "cyborg:schedule_message_cancel",
      { workspaceId, id },
    );
  }

  // ─── Recurring cybo schedules (#611/#613/#619) ──────────────────────
  // CRUD + run-history wrappers over the per-daemon ScheduleRunner. All seven
  // RPCs are dual-routed server-side (local dispatcher + cloud relay); the
  // mutating four resolve with the `cyborg:schedule_mutated` ack, list resolves
  // with `cyborg:schedule_list_response`, and run-history with
  // `cyborg:schedule_runs_response`.

  // Create a recurring run for a cybo. `cyboIdOrSlug` picks the cybo (same
  // convention as spawnCybo); `cron` is the cadence; `prompt` is what it runs.
  // `maxRuns: 1` makes a one-shot. Returns the mutation ack (schedule on ok).
  async createSchedule(params: {
    workspaceId: string;
    cyboIdOrSlug: string;
    cron: string;
    prompt: string;
    channelId?: string | null;
    // Bind this schedule to a task (fired as its assignee cybo, unattended).
    // Omitted/null = a raw-prompt cybo schedule (unchanged).
    taskId?: string | null;
    timezone?: string | null;
    maxRuns?: number | null;
    catchUp?: boolean;
    daemonId?: string;
  }): Promise<ScheduleMutatedPayload> {
    return this.request<ScheduleMutatedPayload>("cyborg:create_schedule", { ...params });
  }

  // List the workspace's schedules. `cyboId` optionally narrows to one cybo's
  // schedules (the agent-editor section); omit it for the Tasks-tab board.
  async listSchedules(
    workspaceId: string,
    cyboId?: string,
  ): Promise<{ schedules: ScheduleView[] }> {
    return this.request<{ schedules: ScheduleView[] }>("cyborg:list_schedules", {
      workspaceId,
      ...(cyboId ? { cyboId } : {}),
    });
  }

  // Edit an existing schedule. Only the provided fields change (a cron change
  // recomputes the next run server-side).
  async updateSchedule(params: {
    workspaceId: string;
    scheduleId: string;
    cron?: string;
    prompt?: string;
    channelId?: string | null;
    // Rebind (or unbind, via null) the schedule's task.
    taskId?: string | null;
    timezone?: string | null;
    daemonId?: string;
  }): Promise<ScheduleMutatedPayload> {
    return this.request<ScheduleMutatedPayload>("cyborg:update_schedule", { ...params });
  }

  // Pause (enabled=false) or resume (enabled=true) a schedule in one RPC.
  async setScheduleEnabled(
    workspaceId: string,
    scheduleId: string,
    enabled: boolean,
    daemonId?: string,
  ): Promise<ScheduleMutatedPayload> {
    return this.request<ScheduleMutatedPayload>("cyborg:set_schedule_enabled", {
      workspaceId,
      scheduleId,
      enabled,
      ...(daemonId ? { daemonId } : {}),
    });
  }

  // Permanently delete a schedule.
  async deleteSchedule(
    workspaceId: string,
    scheduleId: string,
    daemonId?: string,
  ): Promise<ScheduleMutatedPayload> {
    return this.request<ScheduleMutatedPayload>("cyborg:delete_schedule", {
      workspaceId,
      scheduleId,
      ...(daemonId ? { daemonId } : {}),
    });
  }

  // Fire a schedule immediately ("Run now"), independent of its cron clock.
  async runScheduleOnce(
    workspaceId: string,
    scheduleId: string,
    daemonId?: string,
  ): Promise<ScheduleMutatedPayload> {
    return this.request<ScheduleMutatedPayload>("cyborg:run_schedule_once", {
      workspaceId,
      scheduleId,
      ...(daemonId ? { daemonId } : {}),
    });
  }

  // Load a schedule's run history (newest first), capped by `limit` (server max 100).
  async listScheduleRuns(
    workspaceId: string,
    scheduleId: string,
    limit?: number,
    daemonId?: string,
  ): Promise<{ scheduleId: string; runs: ScheduleRunView[] }> {
    return this.request<{ scheduleId: string; runs: ScheduleRunView[] }>(
      "cyborg:list_schedule_runs",
      {
        workspaceId,
        scheduleId,
        ...(limit ? { limit } : {}),
        ...(daemonId ? { daemonId } : {}),
      },
    );
  }

  // ─── Built-in integrations (recipes) ────────────────────────────────
  // Enable/disable/list the workspace's built-in automation recipes. enable +
  // disable are forwarded to the daemon (they create/destroy cybos + schedules);
  // list is answered PG-direct on the relay from the mirror, so cloud users see
  // installs even when the daemon is asleep. Mutations also broadcast
  // `cyborg:recipes_changed` so every open client re-lists.

  // Enable (or re-configure) a recipe. `config` carries the recipe's config keys
  // (channel ids, crons, timezone — see lib/integrations/recipes-catalog.ts).
  // Resolves with the resulting install row. Fails with "no daemon connected" if
  // no daemon is hosting the workspace (the recipe's cybo needs a daemon host).
  async enableRecipe(
    workspaceId: string,
    recipeId: string,
    config: Record<string, unknown>,
  ): Promise<{ recipe: RecipeView }> {
    return this.request<{ recipe: RecipeView }>("cyborg:enable_recipe", {
      workspaceId,
      recipeId,
      config,
    });
  }

  // Disable a recipe: tears down its cybo (cascade removes schedules + channel
  // memberships) and marks the install row disabled.
  async disableRecipe(
    workspaceId: string,
    recipeId: string,
  ): Promise<{ recipeId: string; disabled: true }> {
    return this.request<{ recipeId: string; disabled: true }>("cyborg:disable_recipe", {
      workspaceId,
      recipeId,
    });
  }

  // List the workspace's installed recipes (enabled + disabled rows).
  async listRecipes(workspaceId: string): Promise<{ recipes: RecipeView[] }> {
    return this.request<{ recipes: RecipeView[] }>("cyborg:list_recipes", { workspaceId });
  }

  respondToPermission(
    workspaceId: string,
    agentId: string,
    permissionRequestId: string,
    response: AgentPermissionResponse,
  ): void {
    this.send({
      type: "cyborg:agent_permission_response",
      workspaceId,
      agentId,
      permissionRequestId,
      response,
    });
  }

  cancelAgent(workspaceId: string, agentId: string): void {
    this.send({ type: "cyborg:cancel_agent", workspaceId, agentId });
  }

  // #591: clear an agent's derived "needs attention" flag (sent when the agent
  // is viewed). Fire-and-forget — the owning daemon clears the authoritative
  // flag and re-broadcasts the agent state.
  clearAgentAttention(workspaceId: string, agentId: string): void {
    this.send({ type: "cyborg:clear_attention", workspaceId, agentId });
  }

  // daemonId targets the agent's OWNING daemon directly (#843 Gap B). Without it
  // the relay must resolve the owner from the daemon_agents PG binding, which is
  // written async on agent_status — so a control RPC fired right after create can
  // race ahead of the binding and hit an arbitrary daemon ("Agent not found").
  // When omitted the relay still falls back to the binding (backward-compatible).
  async setAgentModel(
    workspaceId: string,
    agentId: string,
    modelId: string | null,
    daemonId?: string,
  ): Promise<void> {
    await this.request("cyborg:set_agent_model", {
      workspaceId,
      agentId,
      modelId,
      ...(daemonId ? { daemonId } : {}),
    });
  }

  // Reload/restart a wedged session in place (#592): keeps the same agentId and
  // identity, recreating the live session. `rehydrateFromDisk` re-streams the
  // provider history (for a desynced session) instead of preserving the
  // in-memory timeline. Recovers a hung agent without archive/delete.
  async reloadSession(
    workspaceId: string,
    agentId: string,
    opts?: { rehydrateFromDisk?: boolean },
  ): Promise<void> {
    await this.request("cyborg:reload_session", {
      workspaceId,
      agentId,
      rehydrateFromDisk: opts?.rehydrateFromDisk ?? false,
    });
  }

  async setAgentMode(
    workspaceId: string,
    agentId: string,
    modeId: string,
    daemonId?: string,
  ): Promise<void> {
    await this.request("cyborg:set_agent_mode", {
      workspaceId,
      agentId,
      modeId,
      ...(daemonId ? { daemonId } : {}),
    });
  }

  async setAgentThinking(
    workspaceId: string,
    agentId: string,
    thinkingOptionId: string | null,
    daemonId?: string,
  ): Promise<void> {
    await this.request("cyborg:set_agent_thinking", {
      workspaceId,
      agentId,
      thinkingOptionId,
      ...(daemonId ? { daemonId } : {}),
    });
  }

  // 'Rewind to here' (#649): roll the agent/cybo session back to before this turn.
  // `messageId` is the Paseo timeline user-message id carried on the stream entry.
  // mode defaults server-side to "conversation" (the only mode cybos/pi support).
  async rewindAgent(workspaceId: string, agentId: string, messageId: string): Promise<void> {
    await this.request("cyborg:rewind_agent", { workspaceId, agentId, messageId });
  }

  async listAgentCommands(workspaceId: string, agentId: string): Promise<AgentSlashCommand[]> {
    const resp = await this.request<{ commands: AgentSlashCommand[] }>("cyborg:list_commands", {
      workspaceId,
      agentId,
    });
    return resp.commands;
  }

  // #581: @-file/dir autocomplete. `query` is the text after the `@`; the daemon
  // searches the agent's workspace cwd and returns matching file/dir entries.
  async getAgentDirectorySuggestions(
    workspaceId: string,
    agentId: string,
    query: string,
  ): Promise<{ path: string; kind: "file" | "directory" }[]> {
    const resp = await this.request<{
      entries: { path: string; kind: "file" | "directory" }[];
      error: string | null;
    }>("cyborg:directory_suggestions", { workspaceId, agentId, query });
    return resp.entries;
  }

  async fetchAgentTimeline(
    workspaceId: string,
    agentId: string,
    opts?: { cursor?: string; limit?: number; direction?: "older" | "newer" },
  ): Promise<{
    items: Record<string, unknown>[];
    nextCursor: string | null;
    hasMore: boolean;
    olderCursor: string | null;
    hasOlder: boolean;
  }> {
    const resp = await this.request<{
      items: Record<string, unknown>[];
      nextCursor: string | null;
      hasMore: boolean;
      olderCursor?: string | null;
      hasOlder?: boolean;
    }>("cyborg:fetch_agent_timeline", {
      workspaceId,
      agentId,
      cursor: opts?.cursor,
      limit: opts?.limit ?? 100,
      ...(opts?.direction ? { direction: opts.direction } : {}),
    });
    return {
      items: resp.items,
      nextCursor: resp.nextCursor,
      hasMore: resp.hasMore,
      olderCursor: resp.olderCursor ?? null,
      hasOlder: resp.hasOlder ?? false,
    };
  }

  // Read-only session viewer (#994): fetch the captured INJECTED CONTEXT bundle
  // for an ephemeral session (system prompt + tools made available + routed/raw
  // prompt). Returns null for an ordinary (non-ephemeral) agent. Pure read —
  // never attaches/revives the session.
  async fetchSessionContext(
    workspaceId: string,
    agentId: string,
  ): Promise<SessionContextBundle | null> {
    const resp = await this.request<{ context: SessionContextBundle | null }>(
      "cyborg:fetch_session_context",
      { workspaceId, agentId },
    );
    return resp.context;
  }

  // ─── Cybo methods ───────────────────────────────────────────────

  async createCybo(
    workspaceId: string,
    opts: {
      slug: string;
      name: string;
      soul: string;
      provider: string;
      model?: string;
      description?: string;
      avatar?: string;
      role?: string;
      llmAuthMode?: string;
      behaviorMode?: string;
      homeDaemonId?: string | null;
      autonomyLevel?: string | null;
      monthlySpendCap?: number | null;
      platformPermissions?: string[];
      mcpServers?: Record<string, unknown> | null;
    },
  ): Promise<{ id: string; slug: string; name: string; provider: string; model?: string | null }> {
    const resp = await this.request<{
      cybo: { id: string; slug: string; name: string; provider: string; model?: string | null };
    }>("cyborg:create_cybo", { workspaceId, ...opts });
    return resp.cybo;
  }

  async fetchCybos(workspaceId: string): Promise<Cybo[]> {
    const resp = await this.request<{ cybos: Cybo[] }>("cyborg:fetch_cybos", { workspaceId });
    return resp.cybos;
  }

  // Per-user, display-only session alias. Empty alias clears it. Per-user on the
  // server (keyed by the authed guest), so no userId is sent.
  async setSessionAlias(agentId: string, alias: string): Promise<void> {
    await this.request("cyborg:set_session_alias", { agentId, alias });
  }

  async getSessionAliases(): Promise<Record<string, string>> {
    const resp = await this.request<{ aliases: Record<string, string> }>(
      "cyborg:get_session_aliases",
      {},
    );
    return resp.aliases ?? {};
  }

  // Per-user, display-only terminal alias (cross-device synced). Empty alias
  // clears it. Per-user on the server (keyed by the authed guest), so no userId
  // is sent. workspaceId is an optional routing hint so the server can fan the
  // change out to the user's other clients live.
  async setTerminalAlias(terminalId: string, alias: string, workspaceId?: string): Promise<void> {
    await this.request("cyborg:set_terminal_alias", {
      terminalId,
      alias,
      ...(workspaceId ? { workspaceId } : {}),
    });
  }

  async getTerminalAliases(): Promise<Record<string, string>> {
    const resp = await this.request<{ aliases: Record<string, string> }>(
      "cyborg:get_terminal_aliases",
      {},
    );
    return resp.aliases ?? {};
  }

  // Probe the `pi` CLI on the daemon host (Cybos run on PI). Daemon-forwarded.
  async cyboCliStatus(
    workspaceId: string,
    daemonId?: string,
  ): Promise<{ installed: boolean; version?: string | null; path?: string | null }> {
    return this.request("cyborg:cybo_cli_status", { workspaceId, daemonId });
  }

  async cyboCliUpdate(
    workspaceId: string,
    daemonId?: string,
  ): Promise<{
    ok: boolean;
    installed: boolean;
    version?: string | null;
    error?: string;
    // Remedial command for the host's owning package manager (pnpm/bun/npm).
    command?: string;
  }> {
    return this.request("cyborg:cybo_cli_update", { workspaceId, daemonId });
  }

  // Force a provider-snapshot re-probe on the target daemon and return the settled
  // statuses ("Re-check providers" self-repair in Settings → Daemon). Heals a stale
  // "pi unavailable" verdict without restarting the daemon.
  async refreshProviders(
    workspaceId: string,
    daemonId?: string,
  ): Promise<{ providers: { provider: string; status: string }[] }> {
    return this.request("cyborg:refresh_providers", { workspaceId, daemonId });
  }

  // Latest published @cyborg7/cybo version, queried via the daemon's own npm
  // (read-only `npm view`), so an update check reflects what the daemon would install.
  async cyboCliLatest(
    workspaceId: string,
    daemonId?: string,
  ): Promise<{ ok: boolean; latest?: string | null; error?: string | null }> {
    return this.request("cyborg:cybo_cli_latest", { workspaceId, daemonId });
  }

  // Remote daemon self-update (#663): runs `cyborg daemon update` on the host,
  // which RESTARTS the daemon — so the response is "accepted/restarting" (the WS
  // drops mid-update) rather than a synchronous new version; the new version
  // arrives via the next heartbeat. `command` is the manual fallback when the
  // self-update couldn't even launch.
  async updateDaemon(
    workspaceId: string,
    daemonId?: string,
  ): Promise<{ ok: boolean; restarting?: boolean; error?: string; command?: string }> {
    return this.request("cyborg:update_daemon", { workspaceId, daemonId });
  }

  // Latest published daemon CLI version (@getpaseo/cli), via the daemon's own
  // npm — the "update available" verdict for the daemon (mirrors cyboCliLatest).
  async daemonUpdateLatest(
    workspaceId: string,
    daemonId?: string,
  ): Promise<{ ok: boolean; latest?: string | null; error?: string | null }> {
    return this.request("cyborg:daemon_update_latest", { workspaceId, daemonId });
  }

  async updateCybo(
    workspaceId: string,
    cyboId: string,
    fields: {
      name?: string;
      description?: string | null;
      avatar?: string | null;
      role?: string | null;
      soul?: string;
      provider?: string;
      model?: string | null;
      llmAuthMode?: string;
      behaviorMode?: string;
      homeDaemonId?: string | null;
      autonomyLevel?: string | null;
      monthlySpendCap?: number | null;
      platformPermissions?: string[];
      mcpServers?: Record<string, unknown> | null;
    },
  ): Promise<{ id: string; slug: string; name: string; provider: string; model?: string | null }> {
    const resp = await this.request<{
      cybo: { id: string; slug: string; name: string; provider: string; model?: string | null };
    }>("cyborg:update_cybo", { workspaceId, cyboId, ...fields });
    return resp.cybo;
  }

  async deleteCybo(workspaceId: string, cyboId: string): Promise<void> {
    await this.request("cyborg:delete_cybo", { workspaceId, cyboId });
  }

  // Single cybo WITH the full soul (the list omits it). isLocal=true means a
  // disk cybo not yet in the workspace DB.
  async fetchCybo(
    workspaceId: string,
    cyboId: string,
  ): Promise<(Cybo & { soul: string; isLocal?: boolean }) | null> {
    const resp = await this.request<{
      cybo: (Cybo & { soul: string; isLocal?: boolean }) | null;
    }>("cyborg:fetch_cybo", { workspaceId, cyboId });
    return resp.cybo;
  }

  // Snapshot a local (disk) cybo into the workspace DB (soul.md → DB column).
  async importCybo(
    workspaceId: string,
    slug: string,
  ): Promise<{ id: string; slug: string; name: string; provider: string; model?: string | null }> {
    const resp = await this.request<{
      cybo: { id: string; slug: string; name: string; provider: string; model?: string | null };
    }>("cyborg:import_cybo", { workspaceId, slug });
    return resp.cybo;
  }

  async spawnCybo(
    workspaceId: string,
    cyboIdOrSlug: string,
    cwd: string | undefined,
    opts?: { channelId?: string; daemonId?: string },
  ): Promise<{
    agentId: string;
    cyboId: string;
    cyboSlug: string;
    provider: string;
    model?: string | null;
  }> {
    return this.request("cyborg:spawn_cybo", { workspaceId, cyboIdOrSlug, cwd, ...opts });
  }

  // ─── Provider credentials (internal docs + 43) ──────────────────────
  //
  // Per-daemon, write-only API-key (and oauth/wellknown) store. These RPCs are
  // DAEMON_FORWARDed: the relay never reads the secret — it only routes the
  // envelope to the target daemon that holds the credential. The key is NEVER
  // echoed back: `set`/`remove` return `{ ok: true }`, `listProviderAuth` returns
  // METADATA ONLY (providerId, type, expires). All three require an explicit
  // `daemonId` — the credential lives on that machine.

  async setCyboCredential(
    workspaceId: string,
    daemonId: string,
    providerId: string,
    credential: ProviderCredentialPayload,
  ): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("cyborg:set_cybo_credential", {
      workspaceId,
      daemonId,
      providerId,
      credential,
    });
  }

  async removeCyboCredential(
    workspaceId: string,
    daemonId: string,
    providerId: string,
  ): Promise<{ ok: true }> {
    return this.request<{ ok: true }>("cyborg:remove_cybo_credential", {
      workspaceId,
      daemonId,
      providerId,
    });
  }

  async listProviderAuth(workspaceId: string, daemonId: string): Promise<ProviderAuthMeta[]> {
    const resp = await this.request<{ credentials: ProviderAuthMeta[] }>(
      "cyborg:list_provider_auth",
      { workspaceId, daemonId },
    );
    return resp.credentials ?? [];
  }

  // ─── Import/Resume/Delete methods ───────────────────────────────

  // List the local provider sessions (Claude `~/.claude/projects`, Codex, …) that
  // are importable into this workspace — on-disk native sessions the daemon has
  // NOT already imported. Backs the session-import picker; importSession() below
  // snapshots a chosen one. `cwd`/`limit` scope + cap the scan (the daemon
  // defaults limit to 20). The daemon answers `fetch_recent_provider_sessions_response`.
  async fetchRecentProviderSessions(opts?: {
    cwd?: string;
    limit?: number;
  }): Promise<RecentSession[]> {
    const resp = await this.request<{
      entries: RecentSession[];
      filteredAlreadyImportedCount?: number;
    }>("fetch_recent_provider_sessions_request", {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
    });
    return resp.entries ?? [];
  }

  async importSession(opts: {
    providerId?: string;
    providerHandleId?: string;
    sessionId?: string;
    cwd?: string;
  }): Promise<{ agentId: string; timelineSize: number }> {
    const resp = await this.request<{
      status: string;
      agentId: string;
      timelineSize: number;
      agent: Agent;
    }>("import_agent_request", { ...opts });
    return { agentId: resp.agentId, timelineSize: resp.timelineSize };
  }

  // Import a LOCAL provider transcript (Claude `~/.claude/projects`, …) into a
  // workspace via the NEW Cyborg path (cyborg:import_session). Distinct from the
  // legacy Paseo importSession() above (import_agent_request): this one resumes a
  // live agent AND writes a durable archived_sessions row that's re-resumable via
  // restoreSession() from any device. It's relay-forwarded to the daemon holding
  // the transcript with the same spawn-scope + daemonId-resolution as a restore,
  // so it works in cloud mode too. `daemonId` pins that daemon when known; omit it
  // and the relay resolves the sole online workspace daemon (like restoreSession).
  async importSessionCyborg(opts: {
    workspaceId: string;
    provider: string;
    providerHandleId: string;
    cwd?: string;
    channelId?: string;
    daemonId?: string;
  }): Promise<{ agentId: string; sessionId: string }> {
    const resp = await this.request<{ agentId: string; sessionId: string }>(
      "cyborg:import_session",
      {
        workspaceId: opts.workspaceId,
        provider: opts.provider,
        providerHandleId: opts.providerHandleId,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.channelId ? { channelId: opts.channelId } : {}),
        ...(opts.daemonId ? { daemonId: opts.daemonId } : {}),
      },
      RESUME_SESSION_TIMEOUT_MS,
    );
    return { agentId: resp.agentId, sessionId: resp.sessionId };
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.request("delete_agent_request", { agentId });
  }

  // ─── Archive/Session methods ────────────────────────────────────

  async archiveAgent(workspaceId: string, agentId: string): Promise<string> {
    const resp = await this.request<{ sessionId: string }>("cyborg:archive_agent", {
      workspaceId,
      agentId,
    });
    return resp.sessionId;
  }

  // Paginated archived list. `opts.limit`/`opts.cursor` page the list newest-first
  // (the cursor is the opaque token from a prior page's `nextCursor`); omitting
  // both returns the full list (legacy behavior). `nextCursor` is null on the last
  // page. Both fields are additive — old daemons that ignore them just return all.
  async listArchivedSessions(
    workspaceId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ sessions: ArchivedSession[]; nextCursor: string | null }> {
    const resp = await this.request<{ sessions: ArchivedSession[]; nextCursor?: string | null }>(
      "cyborg:list_archived_sessions",
      {
        workspaceId,
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.cursor ? { cursor: opts.cursor } : {}),
      },
    );
    return { sessions: resp.sessions, nextCursor: resp.nextCursor ?? null };
  }

  // Restore an archived session. `opts.daemonId` routes/scopes the restore to the
  // daemon that owns the archived session (from listArchivedSessions); `opts.overrides`
  // (#593) boots the resumed agent on a chosen model/mode/thinking instead of the
  // archived config. Both optional — omitting them resumes exactly as before.
  async restoreSession(
    workspaceId: string,
    sessionId: string,
    opts?: { daemonId?: string; overrides?: ResumeOverrides },
  ): Promise<string> {
    const resp = await this.request<{ agentId: string }>(
      "cyborg:restore_session",
      {
        workspaceId,
        sessionId,
        ...(opts?.daemonId ? { daemonId: opts.daemonId } : {}),
        ...(opts?.overrides ? { overrides: opts.overrides } : {}),
      },
      RESUME_SESSION_TIMEOUT_MS,
    );
    return resp.agentId;
  }

  // ─── Project methods ────────────────────────────────────────────

  async createProject(workspaceId: string, name: string, color: string): Promise<Project> {
    const resp = await this.request<{ project: Project }>("cyborg:create_project", {
      workspaceId,
      name,
      color,
    });
    return resp.project;
  }

  async fetchProjects(workspaceId: string): Promise<{
    projects: Project[];
    channelProjects: ChannelProject[];
  }> {
    return this.request<{ projects: Project[]; channelProjects: ChannelProject[] }>(
      "cyborg:fetch_projects",
      { workspaceId },
    );
  }

  async updateProject(
    workspaceId: string,
    projectId: string,
    name: string,
    color: string,
  ): Promise<void> {
    // workspaceId is REQUIRED by the relay handler (handleUpdateProject reads
    // inner.workspaceId); omitting it made every edit fail with "workspaceId
    // required" — same trap as setChannelProject / deleteProject.
    await this.request("cyborg:update_project", { workspaceId, projectId, name, color });
  }

  async deleteProject(workspaceId: string, projectId: string): Promise<void> {
    // workspaceId is REQUIRED by the relay handler (handleDeleteProject reads
    // inner.workspaceId); omitting it made every delete silently fail server-side
    // (the project reappeared on the next fetch_projects).
    await this.request("cyborg:delete_project", { workspaceId, projectId });
  }

  async setChannelProject(
    workspaceId: string,
    channelId: string,
    projectId: string | null,
  ): Promise<void> {
    // workspaceId is REQUIRED by the relay handler (it reads inner.workspaceId);
    // omitting it made every assignment fail with "workspaceId required".
    await this.request("cyborg:set_channel_project", { workspaceId, channelId, projectId });
  }

  // ─── Cycles catalog CRUD ────────────────────────────────────────
  // `projectId` is the CHAT project id (the same id fetchCycles takes); the relay
  // resolves it to the tasks_projects row and gates visibility. create/update return
  // the affected row so the caller can splice it into the local cycles list without
  // a refetch.

  async createCycle(
    projectId: string,
    input: {
      name: string;
      description?: string | null;
      startDate?: number | null;
      endDate?: number | null;
    },
  ): Promise<Cycle> {
    const resp = await this.request<{ cycle: Cycle }>("cyborg:create_cycle", {
      projectId,
      ...input,
    });
    return resp.cycle;
  }

  async updateCycle(
    cycleId: string,
    updates: {
      name?: string;
      description?: string | null;
      startDate?: number | null;
      endDate?: number | null;
    },
  ): Promise<Cycle> {
    const resp = await this.request<{ cycle: Cycle }>("cyborg:update_cycle", {
      cycleId,
      ...updates,
    });
    return resp.cycle;
  }

  async deleteCycle(cycleId: string): Promise<void> {
    await this.request("cyborg:delete_cycle", { cycleId });
  }

  // ─── Modules catalog CRUD ───────────────────────────────────────

  async createModule(
    projectId: string,
    input: { name: string; description?: string | null; status?: string },
  ): Promise<Module> {
    const resp = await this.request<{ module: Module }>("cyborg:create_module", {
      projectId,
      ...input,
    });
    return resp.module;
  }

  async updateModule(
    moduleId: string,
    updates: { name?: string; description?: string | null; status?: string },
  ): Promise<Module> {
    const resp = await this.request<{ module: Module }>("cyborg:update_module", {
      moduleId,
      ...updates,
    });
    return resp.module;
  }

  async deleteModule(moduleId: string): Promise<void> {
    await this.request("cyborg:delete_module", { moduleId });
  }

  // ─── Task links (external URLs) ─────────────────────────────────
  // The relay/dispatcher resolves the task→project and gates visibility. add/fetch
  // take the taskId; remove takes the linkId. add/fetch return the row(s) so the
  // caller can splice into the local list without a refetch.

  async addTaskLink(
    taskId: string,
    input: { url: string; title?: string | null },
  ): Promise<TaskLink> {
    const resp = await this.request<{ link: TaskLink }>("cyborg:add_task_link", {
      taskId,
      ...input,
    });
    return resp.link;
  }

  async removeTaskLink(linkId: string): Promise<void> {
    await this.request("cyborg:remove_task_link", { linkId });
  }

  async fetchTaskLinks(taskId: string): Promise<TaskLink[]> {
    const resp = await this.request<{ links: TaskLink[] }>("cyborg:fetch_task_links", { taskId });
    return resp.links;
  }

  // ─── Task attachments (S3 asset rows) ───────────────────────────
  // The bytes upload via the existing presign route (POST /api/assets/presign →
  // S3 PUT); after the upload completes, call addTaskAttachment with the resulting
  // key + delivery url to persist the row. remove takes the attachmentId.

  async addTaskAttachment(
    taskId: string,
    input: {
      key: string;
      url: string;
      name: string;
      size: number;
      contentType?: string | null;
    },
  ): Promise<TaskAttachment> {
    const resp = await this.request<{ attachment: TaskAttachment }>("cyborg:add_task_attachment", {
      taskId,
      ...input,
    });
    return resp.attachment;
  }

  async removeTaskAttachment(attachmentId: string): Promise<void> {
    await this.request("cyborg:remove_task_attachment", { attachmentId });
  }

  async fetchTaskAttachments(taskId: string): Promise<TaskAttachment[]> {
    const resp = await this.request<{ attachments: TaskAttachment[] }>(
      "cyborg:fetch_task_attachments",
      { taskId },
    );
    return resp.attachments;
  }

  // ─── Channel management methods ─────────────────────────────────

  async updateChannel(
    workspaceId: string,
    channelId: string,
    updates: {
      name?: string;
      description?: string | null;
      isPrivate?: boolean;
      instructions?: string | null;
    },
  ): Promise<Channel> {
    const resp = await this.request<{ channel: Channel }>("cyborg:update_channel", {
      workspaceId,
      channelId,
      ...updates,
    });
    return resp.channel;
  }

  async deleteChannel(workspaceId: string, channelId: string): Promise<void> {
    await this.request("cyborg:delete_channel", { workspaceId, channelId });
  }

  // Archive (soft-delete) vs the harder deleteChannel: preserves history, just
  // hides the channel from the active list. Admin-gated server-side. Returns the
  // updated channel so the caller can reconcile local state.
  async archiveChannel(
    workspaceId: string,
    channelId: string,
    archived: boolean,
  ): Promise<Channel | null> {
    const resp = await this.request<{ channel: Channel | null }>("cyborg:archive_channel", {
      workspaceId,
      channelId,
      archived,
    });
    return resp.channel;
  }

  // The caller's own role in a channel ("admin" | "member" | null) from the real
  // channel_roles table — replaces the old createdBy === myId admin heuristic.
  async getChannelRole(workspaceId: string, channelId: string): Promise<string | null> {
    const resp = await this.request<{ role: string | null }>("cyborg:get_channel_role", {
      workspaceId,
      channelId,
    });
    return resp.role;
  }

  // Lightweight count of messages-with-attachments in a channel, for the Files
  // tab badge. Separate from fetchChannelFiles so the badge doesn't pull a full
  // page of signed URLs just to show a number.
  async getChannelFileCount(workspaceId: string, channelId: string): Promise<number> {
    const resp = await this.request<{ count: number }>("cyborg:get_channel_file_count", {
      workspaceId,
      channelId,
    });
    return resp.count ?? 0;
  }

  // Subscribe this socket to a workspace's live broadcasts (needed when the
  // workspace was joined mid-session, e.g. via an invite, after the initial auth).
  async subscribeWorkspace(workspaceId: string): Promise<void> {
    await this.request("cyborg:subscribe_workspace", { workspaceId });
  }

  async fetchChannelMembers(workspaceId: string, channelId: string): Promise<ChannelMember[]> {
    const resp = await this.request<{ members: ChannelMember[] }>("cyborg:fetch_channel_members", {
      workspaceId,
      channelId,
    });
    return resp.members;
  }

  async addChannelMember(workspaceId: string, channelId: string, userId: string): Promise<void> {
    await this.request("cyborg:add_channel_member", { workspaceId, channelId, userId });
  }

  // Browse: all public channels + the user's private ones, each flagged isMember
  // and carrying its member_count (additive; older relays omit it → 0).
  async listChannels(
    workspaceId: string,
  ): Promise<Array<Channel & { isMember: boolean; memberCount: number }>> {
    const resp = await this.request<{
      channels: Array<Channel & { isMember: boolean; memberCount: number }>;
    }>("cyborg:list_channels", { workspaceId });
    return resp.channels;
  }

  async removeChannelMember(workspaceId: string, channelId: string, userId: string): Promise<void> {
    await this.request("cyborg:remove_channel_member", { workspaceId, channelId, userId });
  }

  // ── Cybo channel membership (W3 server endpoint) ──
  // Minimal contract: the channel tracks which workspace cybos are members by id;
  // the UI resolves names/avatars from cyboState. Mirrors the human-member trio.
  async fetchChannelCybos(workspaceId: string, channelId: string): Promise<string[]> {
    const resp = await this.request<{ cyboIds: string[] }>("cyborg:fetch_channel_cybos", {
      workspaceId,
      channelId,
    });
    return resp.cyboIds ?? [];
  }

  async addChannelCybo(workspaceId: string, channelId: string, cyboId: string): Promise<void> {
    await this.request("cyborg:add_channel_cybo", { workspaceId, channelId, cyboId });
  }

  async removeChannelCybo(workspaceId: string, channelId: string, cyboId: string): Promise<void> {
    await this.request("cyborg:remove_channel_cybo", { workspaceId, channelId, cyboId });
  }

  // ─── Shared Files (M-files) ─────────────────────────────────────
  // Cursor pagination, newest-first. `before` is the `nextCursor` returned by
  // the previous page (a messageId). The relay over-fetches so a message's
  // attachments never split across pages.

  async fetchChannelFiles(
    workspaceId: string,
    channelId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<SharedFilesPage> {
    return this.request<SharedFilesPage>("cyborg:fetch_channel_files", {
      workspaceId,
      channelId,
      before: opts?.before,
      limit: opts?.limit,
    });
  }

  async fetchDmFiles(
    workspaceId: string,
    peerId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<SharedFilesPage> {
    return this.request<SharedFilesPage>("cyborg:fetch_dm_files", {
      workspaceId,
      peerId,
      before: opts?.before,
      limit: opts?.limit,
    });
  }

  // ─── Web Push ───────────────────────────────────────────────────

  async getVapidKey(): Promise<string | null> {
    const resp = await this.request<{ publicKey: string | null }>("cyborg:get_vapid_key");
    return resp.publicKey;
  }

  async pushSubscribe(sub: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string;
  }): Promise<void> {
    await this.request("cyborg:push_subscribe", { ...sub });
  }

  async pushUnsubscribe(endpoint: string): Promise<void> {
    await this.request("cyborg:push_unsubscribe", { endpoint });
  }

  // ─── Billing / license (Stripe) ─────────────────────────────────

  // Authoritative license state for the workspace's trial bar + activate gate,
  // PLUS the context-aware billing intent for `platform` (what action to offer +
  // copy). Replaces the old localStorage trial clock. Uses the WS RPC (already
  // authenticated on this socket); the HTTP GET /api/stripe/license is its
  // companion for non-WS callers. `platform` tells the relay which surface the
  // caller is on (it can't infer it) — defaults to "web" server-side if omitted.
  async fetchLicense(
    workspaceId: string,
    platform: BillingPlatformPayload = "web",
  ): Promise<{ license: LicensePayload; intent: BillingIntentPayload | null }> {
    const resp = await this.request<{
      workspaceId: string;
      license: LicensePayload;
      intent?: BillingIntentPayload;
    }>("cyborg:fetch_license", { workspaceId, platform });
    return { license: resp.license, intent: resp.intent ?? null };
  }

  // Owner-only: create a Stripe Checkout Session and return its hosted URL. The
  // caller redirects the browser there (window.location.href = url). Card entry
  // happens entirely on checkout.stripe.com — no card data touches our UI.
  // Throws on 403 (non-owner) / 503 (billing not configured) with the server's
  // error string so the modal can show an appropriate message.
  async startCheckout(workspaceId: string): Promise<string> {
    return this.postBilling("/api/stripe/checkout", workspaceId);
  }

  // Owner-only: open the Stripe billing portal (manage / cancel / update card /
  // invoices) and return its hosted URL for the browser to redirect to.
  async openBillingPortal(workspaceId: string): Promise<string> {
    return this.postBilling("/api/stripe/portal", workspaceId);
  }

  // iOS only: ask the relay to reconcile the caller's RevenueCat entitlement
  // into the subscriptions table (across every workspace they own) and return
  // this workspace's fresh license. Used right after a StoreKit purchase/restore
  // (instant access, no waiting for the async webhook) and to self-heal a paused
  // license caused by a missed webhook. Returns null on any error/non-200 so
  // callers can fall back to the optimistic state.
  async reconcileIap(workspaceId: string): Promise<LicensePayload | null> {
    try {
      const resp = await fetch(`${this.relayHttpBase}/api/iap/reconcile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({ workspaceId }),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { license?: LicensePayload };
      return data.license ?? null;
    } catch {
      return null;
    }
  }

  // ─── License pool + allocation (per-workspace seat model, spec §4.3) ────────
  // These ride the same authenticated WS RPC as fetchLicense. The handlers live
  // in relay-standalone.ts (Unit E, in parallel); the request()/response shapes
  // here are the contract. Caller identity = the authed socket's userId, so the
  // pool fetch needs no workspaceId; allocate/deallocate are owner-scoped on the
  // relay (it 403s a non-owner via the same getWorkspaceOwnerId check Stripe uses).

  /**
   * The caller's seat entitlement + which workspaces currently spend a seat +
   * the relay's authoritative list of workspaces the caller owns. `pool` is null
   * when the caller has no pool (free/trial only) — the panel then shows the
   * tier picker / checkout CTA instead of toggles.
   */
  async fetchLicensePool(): Promise<LicensePoolResponse> {
    return this.request<LicensePoolResponse>("cyborg:fetch_license_pool", {});
  }

  /**
   * Spend one free seat on `workspaceId` (no purchase — consumes an owned seat).
   * Owner-only on the relay. Resolves with the workspace's fresh license + the
   * recomputed pool/allocations. A rejected mutation resolves with `error` set
   * (no_free_seat | not_owner | no_pool | already_active_other_rail) and an
   * unchanged pool/allocations — callers branch on `error`.
   */
  async allocateLicense(workspaceId: string): Promise<LicenseAllocationResponse> {
    return this.request<LicenseAllocationResponse>("cyborg:allocate_license", { workspaceId });
  }

  /** Free the seat on `workspaceId` (owner-only). Same response shape as allocate. */
  async deallocateLicense(workspaceId: string): Promise<LicenseAllocationResponse> {
    return this.request<LicenseAllocationResponse>("cyborg:deallocate_license", { workspaceId });
  }

  private async postBilling(path: string, workspaceId: string): Promise<string> {
    const resp = await fetch(`${this.relayHttpBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify({ workspaceId }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))) as {
        error?: string;
      };
      throw new Error(err.error ?? `HTTP ${resp.status}`);
    }
    const { url } = (await resp.json()) as { url?: string };
    if (!url) throw new Error("no checkout url returned");
    return url;
  }

  // ─── Passkeys / WebAuthn ────────────────────────────────────────
  // Authenticated passkey management against the connected relay. The login-side
  // (passwordless) ceremony is pre-auth and lives directly in the login page.

  /** Register a new passkey (Touch ID / Face ID / security key) for this user. */
  registerPasskey(nickname?: string): Promise<void> {
    return passkeyRegister(this.relayHttpBase, this.authToken, nickname);
  }

  /** List the current user's registered passkeys. */
  listPasskeys(): Promise<PasskeyInfo[]> {
    return passkeyList(this.relayHttpBase, this.authToken);
  }

  /** Remove one of the current user's passkeys by id. */
  deletePasskey(id: string): Promise<void> {
    return passkeyDelete(this.relayHttpBase, this.authToken, id);
  }

  // ─── GitHub App → Tasks issue sync (bind a repo to a Tasks-project) ──────
  // HTTP (not WS) — these hit the authed /api/github/* callbacks in routes/github.ts
  // (no WS analogue, same pattern as the Stripe/passkey REST helpers above).

  /** The repo bindings for a Tasks-project (drives the "connected to <owner/name>"
   *  state in the settings panel). `tasksProjectId` is the tasks_projects.id. */
  async fetchGithubRepoSyncs(tasksProjectId: string): Promise<GithubRepoSync[]> {
    const resp = await this.githubFetch(
      `/api/github/repo-syncs?tasksProjectId=${encodeURIComponent(tasksProjectId)}`,
    );
    const { syncs } = (await resp.json()) as { syncs: GithubRepoSync[] };
    return syncs;
  }

  /** The repo bindings across an ENTIRE workspace (the detail page's "Project Issue
   *  Sync" list — every project's bindings). */
  async fetchGithubRepoSyncsForWorkspace(workspaceId: string): Promise<GithubRepoSync[]> {
    const resp = await this.githubFetch(
      `/api/github/repo-syncs?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    const { syncs } = (await resp.json()) as { syncs: GithubRepoSync[] };
    return syncs;
  }

  /** Bind a repository to a Tasks-project (the bindRepoSync RPC). Returns the new
   *  binding id. The repo identity (installationId/repoId/owner/name) comes from
   *  the picker; repoUrl is optional (defaulted server-side from owner/name).
   *  syncDirection ('inbound'|'bidirectional') + the issue state overrides are
   *  optional (Image #4); omitted → server defaults ('inbound', no override). */
  async bindGithubRepoSync(opts: {
    tasksProjectId: string;
    installationId: string;
    repoId: string;
    owner: string;
    name: string;
    repoUrl?: string;
    syncDirection?: "inbound" | "bidirectional";
    issueOpenStateId?: string | null;
    issueClosedStateId?: string | null;
  }): Promise<string> {
    const resp = await this.githubFetch("/api/github/repo-sync", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    const { id } = (await resp.json()) as { id: string };
    return id;
  }

  /** Edit a binding's sync direction / issue state map (Image #5 edit). Only the
   *  supplied fields are changed. */
  async patchGithubRepoSync(
    id: string,
    patch: {
      syncDirection?: "inbound" | "bidirectional";
      issueOpenStateId?: string | null;
      issueClosedStateId?: string | null;
    },
  ): Promise<void> {
    await this.githubFetch(`/api/github/repo-sync/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  /** Remove a repo binding by id. */
  async unbindGithubRepoSync(id: string): Promise<void> {
    await this.githubFetch(`/api/github/repo-sync/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Every GitHub App installation this workspace authorized (the account/org picker
   *  + the detail page's connected-org row[s]). */
  async fetchGithubInstallations(workspaceId: string): Promise<GithubInstallation[]> {
    const resp = await this.githubFetch(
      `/api/github/installations?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    const { installations } = (await resp.json()) as { installations: GithubInstallation[] };
    return installations;
  }

  /** Claim a freshly-installed GitHub App for this workspace, recording the
   *  github_installations row the connected state reads from. Called by the integrations
   *  card after the post-install redirect (?github=installed&installation_id=…). The
   *  relay membership-checks the workspace, refuses to reassign an installation another
   *  workspace already owns, and verifies a new claim against GitHub before recording it. */
  async confirmGithubInstallation(workspaceId: string, installationId: string): Promise<void> {
    await this.githubFetch("/api/github/installations/confirm", {
      method: "POST",
      body: JSON.stringify({ workspaceId, installationId }),
    });
  }

  /** Disconnect an installation from a workspace (drops its bindings too). */
  async disconnectGithubInstallation(workspaceId: string, installationId: string): Promise<void> {
    await this.githubFetch(
      `/api/github/installation/${encodeURIComponent(installationId)}` +
        `?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "DELETE" },
    );
  }

  /** The PR-state → task-state mappings for a project (Image #3). */
  async fetchGithubPrMappings(tasksProjectId: string): Promise<GithubPrStateMapping[]> {
    const resp = await this.githubFetch(
      `/api/github/pr-mappings?tasksProjectId=${encodeURIComponent(tasksProjectId)}`,
    );
    const { mappings } = (await resp.json()) as { mappings: GithubPrStateMapping[] };
    return mappings;
  }

  /** Upsert one PR-state mapping (one row per (project, prState)). Returns its id. */
  async upsertGithubPrMapping(opts: {
    tasksProjectId: string;
    prState: string;
    taskStateId?: string | null;
    skipBackward?: boolean;
  }): Promise<string> {
    const resp = await this.githubFetch("/api/github/pr-mappings", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    const { id } = (await resp.json()) as { id: string };
    return id;
  }

  /** Remove a PR-state mapping by id. */
  async deleteGithubPrMapping(id: string): Promise<void> {
    await this.githubFetch(`/api/github/pr-mapping/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /** The personal GitHub accounts connected for this workspace — drives the detail
   *  page's authoritative "Personal account connected" state (persists across
   *  reloads, not just the transient OAuth redirect note). The relay returns only
   *  safe fields, never the OAuth access token. */
  async fetchGithubUserConnections(
    workspaceId: string,
  ): Promise<{ connections: GithubUserConnection[] }> {
    const resp = await this.githubFetch(
      `/api/github/user-connections?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    return (await resp.json()) as { connections: GithubUserConnection[] };
  }

  /** Start the personal-account OAuth flow (Image #3 "Connect Personal Account").
   *  Returns the GitHub authorize URL to navigate the browser to, or
   *  `{ configured:false }` when GITHUB_OAUTH_* is unset (→ the UI shows a
   *  not-configured state). The caller does `window.location.href = url`. */
  async startGithubOAuth(
    workspaceId: string,
    returnTo?: string,
  ): Promise<{ configured: boolean; url?: string }> {
    const qs = new URLSearchParams({ workspaceId });
    if (returnTo) qs.set("return", returnTo);
    const resp = await this.githubFetch(`/api/github/oauth/start?${qs.toString()}`);
    return (await resp.json()) as { configured: boolean; url?: string };
  }

  /** The repos an installation can access (the picker source). `configured:false`
   *  means the GitHub App's live creds are absent (Phase 3 pending) → the UI falls
   *  back to a manual repo-entry form. `tasksProjectId` scopes the request to the
   *  caller's workspace so the server can authorize it (BOLA guard). */
  async fetchGithubInstallationRepos(
    installationId: string,
    tasksProjectId: string,
  ): Promise<{ configured: boolean; repos: GithubInstallationRepo[] }> {
    const resp = await this.githubFetch(
      `/api/github/installation-repos?installationId=${encodeURIComponent(installationId)}` +
        `&tasksProjectId=${encodeURIComponent(tasksProjectId)}`,
    );
    return (await resp.json()) as { configured: boolean; repos: GithubInstallationRepo[] };
  }

  /** The GitHub App's public config: its slug and the ready-to-use install URL
   *  (github.com/apps/<slug>/installations/new?state=<workspaceId>). Pass the current
   *  `workspaceId` so the server embeds it as the `state` GitHub echoes back to the
   *  callback (→ the user lands on that workspace's integration detail page).
   *  `configured:false` / `slug:null` / `installUrl:null` means the App isn't
   *  registered yet, so the UI disables the Connect button with a clear hint. */
  async fetchGithubAppConfig(
    workspaceId?: string,
  ): Promise<{ configured: boolean; slug: string | null; installUrl: string | null }> {
    const path = workspaceId
      ? `/api/github/config?workspaceId=${encodeURIComponent(workspaceId)}`
      : "/api/github/config";
    const resp = await this.githubFetch(path);
    return (await resp.json()) as {
      configured: boolean;
      slug: string | null;
      installUrl: string | null;
    };
  }

  // Shared fetch for the /api/github/* callbacks: bearer auth + JSON content type +
  // a thrown {error} on a non-2xx (same convention as postBilling above).
  private async githubFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const resp = await fetch(`${this.relayHttpBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
        ...init.headers,
      },
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))) as {
        error?: string;
      };
      throw new Error(err.error ?? `HTTP ${resp.status}`);
    }
    return resp;
  }

  // ─── Slack customer-comms bridge (OAuth install + channel links) ──────
  // HTTP (not WS) — these hit the authed /api/slack/* callbacks in routes/slack-oauth.ts
  // (requireAuth + isMember). Mirror the github* helpers exactly.

  /** The Slack app's public config: the credential gate + the ready-to-use install URL
   *  (the Slack v2 OAuth authorize URL, carrying a signed `state` for `workspaceId`).
   *  `configured:false` / `installUrl:null` means the relay's Slack secrets aren't set
   *  yet, so the UI shows a clear "not configured" state. Pass the current `workspaceId`
   *  so the server embeds it (signed) and the post-install redirect lands here. */
  async fetchSlackConfig(
    workspaceId?: string,
  ): Promise<{ configured: boolean; installUrl: string | null }> {
    const path = workspaceId
      ? `/api/slack/config?workspaceId=${encodeURIComponent(workspaceId)}`
      : "/api/slack/config";
    const resp = await this.slackFetch(path);
    return (await resp.json()) as { configured: boolean; installUrl: string | null };
  }

  /** Every Slack installation this workspace authorized (the detail page's connected
   *  workspace row[s]). The relay returns only safe fields, never the bot access token. */
  async fetchSlackInstallations(workspaceId: string): Promise<SlackInstallation[]> {
    const resp = await this.slackFetch(
      `/api/slack/installations?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    const { installations } = (await resp.json()) as { installations: SlackInstallation[] };
    return installations;
  }

  /** Disconnect a Slack installation from this workspace (drops its channel links too,
   *  via the 0045 cascade). Workspace-scoped + BOLA-guarded server-side. */
  async disconnectSlack(workspaceId: string, installationId: string): Promise<void> {
    await this.slackFetch(
      `/api/slack/installation/${encodeURIComponent(installationId)}` +
        `?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "DELETE" },
    );
  }

  /** This workspace's Slack↔Cyborg channel links (the detail page's links list). */
  async fetchSlackChannelLinks(workspaceId: string): Promise<SlackChannelLink[]> {
    const resp = await this.slackFetch(
      `/api/slack/channel-links?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    const { links } = (await resp.json()) as { links: SlackChannelLink[] };
    return links;
  }

  /** Link a Slack channel to a Cyborg channel. Returns the new link id. The server
   *  BOLA-guards that both the installation and the cyborg channel belong to the
   *  workspace. */
  async linkSlackChannel(opts: {
    workspaceId: string;
    installationId: string;
    cyborgChannelId: string;
    slackChannelId: string;
    slackTeamId: string;
  }): Promise<string> {
    const resp = await this.slackFetch("/api/slack/channel-links", {
      method: "POST",
      body: JSON.stringify(opts),
    });
    const { id } = (await resp.json()) as { id: string };
    return id;
  }

  /** Unlink a Slack↔Cyborg channel link (workspace-scoped + BOLA-guarded server-side). */
  async unlinkSlackChannel(workspaceId: string, id: string): Promise<void> {
    await this.slackFetch(
      `/api/slack/channel-link/${encodeURIComponent(id)}` +
        `?workspaceId=${encodeURIComponent(workspaceId)}`,
      { method: "DELETE" },
    );
  }

  // Shared fetch for the /api/slack/* callbacks: bearer auth + JSON content type + a
  // thrown {error} on a non-2xx (identical convention to githubFetch above).
  private async slackFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const resp = await fetch(`${this.relayHttpBase}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.authToken}`,
        ...init.headers,
      },
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }))) as {
        error?: string;
      };
      throw new Error(err.error ?? `HTTP ${resp.status}`);
    }
    return resp;
  }

  // ─── Home stats (workspace-wide tiles + heatmap + top agents) ──────
  /** Workspace-wide session-history aggregates for the Home Mission Control.
   *  `range` windows the scalar tiles + top agents (heatmap is always a year). */
  getWorkspaceHomeStats(
    workspaceId: string,
    range: "today" | "week" | "month" | "year" = "month",
  ): Promise<WorkspaceHomeStats> {
    return this.request<WorkspaceHomeStats>("cyborg:workspace_stats", { workspaceId, range });
  }

  // ─── User status (P2 Item 6) ────────────────────────────────────

  // Persist + sync the caller's custom status for a workspace. Null emoji+text
  // clears it. Fire-and-forget (mirrors markRead): the broadcast confirms.
  setUserStatus(
    workspaceId: string,
    emoji: string | null,
    text: string | null,
    expiresAt: number | null,
  ): void {
    this.send({ type: "cyborg:set_user_status", workspaceId, emoji, text, expiresAt });
  }

  // P2 Item 6: toggle the caller's manual "away" presence. Fire-and-forget; the
  // relay re-broadcasts presence (incl. awayUserIds) so co-members update live.
  // The relay persists this to user_presence so the manual away choice survives a
  // reconnect. `ephemeral` is retained on the wire for backward-compatibility with
  // older relays (it now always sends false → durable manual away only).
  setPresence(away: boolean, ephemeral = false): void {
    this.send({ type: "cyborg:set_presence", away, ephemeral });
  }

  async fetchUserStatuses(workspaceId: string): Promise<UserStatusEntry[]> {
    const resp = await this.request<{ statuses: UserStatusEntry[] }>("cyborg:fetch_user_statuses", {
      workspaceId,
    });
    return resp.statuses;
  }

  // ─── Saved messages (#609 — personal bookmarks) ─────────────────
  // Toggle a personal bookmark on/off (the analog of pinMessage, but private).
  // The save_message_broadcast echoes back to my other devices.
  async saveMessage(workspaceId: string, messageId: string, saved: boolean): Promise<void> {
    await this.request("cyborg:save_message", { workspaceId, messageId, saved });
  }

  // My saved messages in this workspace, newest-saved first (full message rows).
  async listSaved(workspaceId: string): Promise<Message[]> {
    const resp = await this.request<{ messages: Message[] }>("cyborg:list_saved", { workspaceId });
    return resp.messages;
  }

  // ─── Extension: handle agent_stream messages ────────────────────

  protected override handleExtensionMessage(
    type: string,
    payload: Record<string, unknown> | undefined,
  ): boolean {
    if (type === "agent_stream") {
      // Handled via cyborg:agent_stream from message-router broadcast;
      // processing both would double-deliver every event.
      return true;
    }

    // Straight-through broadcasts: each `cyborg:<wire>` frame re-emits as its typed
    // CyborgEventMap event with no transform. Table-driven (not a branch per type)
    // so adding a passthrough — e.g. #995's `cyborg:audit_event` — is one map row,
    // and the method's cyclomatic complexity stays flat.
    const passthrough = SIMPLE_PASSTHROUGH[type];
    if (passthrough) {
      this.emit(passthrough, payload as never);
      return true;
    }

    // Terminal stream + start/attach acks (#654/#673) → fan out to terminalSocket()
    // subscribers. The *_response acks aren't request()-correlated here because the
    // transport sends start/attach via the raw socket, not request(). attach_terminal_response
    // MUST be here: without it the transport's attach() never resolves, times out (15s), and
    // falls back to a fresh start() — dropping the live pty on every tab-switch re-attach.
    // cyborg:terminal_snapshot (internal docs Phase 0/1) is the screen self-heal frame
    // Paseo emits on every (re)subscribe — it MUST be whitelisted here too, or the
    // repaint never reaches TerminalView (the exact class of omission that caused #789;
    // a regression test asserts its presence — terminal-resubscribe.integration.test.ts).
    if (
      type === "cyborg:terminal_output" ||
      type === "cyborg:terminal_exit" ||
      type === "cyborg:terminal_snapshot" ||
      type === "cyborg:start_terminal_response" ||
      type === "cyborg:attach_terminal_response" ||
      // The workspace terminal DIRECTORY push (terminal CLI-UI unification): the
      // daemon broadcasts the full snapshot on every start/exit so out-of-band
      // (CLI / other-client) terminals surface in the sidebar live. Fanned out to
      // onTerminalsChanged subscribers via terminalSocket().
      type === "cyborg:terminals_changed" ||
      // The per-user terminal-alias change push: a rename/clear on one of the
      // user's devices, fanned out to the rest via onTerminalAliasChanged.
      type === "cyborg:terminal_alias_changed"
    ) {
      // Snapshot before iterating: a handler may unsubscribe itself (mutating
      // the set), and one throwing handler must not starve the rest of the frame.
      const set = this.terminalListeners.get(type);
      if (set) {
        for (const handler of Array.from(set)) {
          try {
            handler(payload ?? {});
          } catch (err) {
            console.error("[terminal] listener threw:", err);
          }
        }
      }
      return true;
    }

    return false;
  }
}

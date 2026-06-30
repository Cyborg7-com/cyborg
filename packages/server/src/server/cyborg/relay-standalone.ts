/* oxlint-disable complexity, no-nested-ternary, no-unused-vars, consistent-type-definitions, no-explicit-any */
import { Hono, type Context, type Next } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getRequestListener } from "@hono/node-server";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  checkAgentAccess,
  createUserToken,
  decodeJwt,
  hashPassword,
  validateDaemonToken,
  validateUserToken,
  verifyPassword,
} from "./relay-auth.js";
import {
  isDaemonScope,
  isScopeAllowed,
  normalizeScopes,
  scopeForType,
  roleForScopes,
  type DaemonScope,
} from "./daemon-scopes.js";
import type { GuestHandlerCtx } from "./handlers/guest-context.js";
import { buildPingResponse } from "./ping-liveness.js";
import { buildExpiredStatusClears } from "./status-sweep.js";
import { handleDeleteAccount } from "./delete-account-handler.js";
import { isDaemonOnline } from "./daemon-liveness.js";
import {
  handleCreateProject,
  handleDeleteProject,
  handleSetChannelProject,
  handleUpdateProject,
} from "./handlers/projects.js";
import { WorkspaceRelay } from "./workspace-relay.js";
import {
  invokeChannelWatchersViaRelay,
  invokeMentionedCybosViaRelay,
} from "./cybo-mention-invoke.js";
import { computeBroadcastScope } from "./relay-broadcast-scope.js";
import { type TaskLogEvent, taskEventBroadcast } from "./task-event-log.js";
import { type AuditEvent, auditEventBroadcast } from "./audit-event-log.js";
import { createAuditSink } from "./audit-sink.js";
import { getActionHandler, verifyAction } from "./signed-actions.js";
import {
  mergePgCybosIntoRoster,
  pgStoredCyboToFetchResponse,
  resolveWorkspaceCybo,
} from "./cybo-roster-merge.js";
import { applyHomeDaemonRouting } from "./cybo-home-daemon-routing.js";
import {
  finalizeTerminalDirectory,
  mergeTerminalDirectoryResponse,
} from "./terminal-directory-merge.js";
import { resolveAgentLifecycleFromBindings } from "./cross-daemon-lifecycle.js";
import {
  collectInitiatedByEmails,
  resolveInitiatedByGlobalIds,
} from "./cross-daemon-initiated-by.js";
import {
  offlineAgentRows,
  auditAgentRows,
  shouldGcOwnerBindings,
} from "./relay-offline-agent-rows.js";
import {
  computeCyboReadiness,
  readinessDaemonsFrom,
  type CyboReadiness,
} from "./cybo-readiness.js";
import { findInaccessibleSlashDaemon, slashDaemonAccessError } from "./slash-daemon-access.js";
import { mountWebUi } from "./web-ui.js";
import { ANDROID_APP_LINK_PACKAGE, assetLinksFromEnv } from "./android-asset-links.js";
import { isValidEmail, normalizeEmail } from "./email.js";
import { deriveGroupDmName, validateGroupDmParticipants } from "./group-dm.js";
import { AttachmentSchema, serializeDaemonAccessRequest } from "./cyborg-messages.js";
import { finalizeMergedArchivedPage } from "./archived-session-ordering.js";
import { taskActivityEvents } from "./task-activity.js";
import { computeNextRecurrence, MAX_RECURRENCE_COUNT } from "./task-dispatch.js";
import { unfurlUrls } from "./unfurl.js";
import {
  generateWebhookSecret,
  newOutgoingWebhookId,
  normalizeEventFlags,
  validateWebhookUrl,
} from "./outgoing-webhook-delivery.js";
import { enqueueWebhookEvent } from "./webhook-enqueue.js";
import { WebhookDeliveryRunner } from "./webhook-delivery-runner.js";
import { handleMcpRequest } from "./mcp/http.js";
import { generateMcpToken, newMcpTokenId } from "./mcp/token.js";
import { RateLimiter } from "./rate-limiter.js";
import { PgSync } from "./db/pg-sync.js";
import { canCreateAgent, canManageCybo } from "./permissions.js";
import { RelayRedis } from "./relay-redis.js";
import { sendInvitationEmail } from "./email-otp.js";
import {
  initWebPush,
  isWebPushConfigured,
  vapidPublicKey,
  sendWebPush,
  type PushPayload,
} from "./push.js";
import { isDesktopActiveForPush } from "./push-active.js";
import { initFcm, isFcmConfigured, sendFcm, sendFcmBadge } from "./push-fcm.js";
import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl as signCloudFront } from "@aws-sdk/cloudfront-signer";
import { isStripeConfigured } from "./billing/stripe.js";
import { deriveWorkspaceLicense } from "./billing/license-pool.js";
import { isActiveRow, isStripeRow } from "./billing/revenuecat.js";
import { normalizeBillingPlatform } from "./billing/intent.js";
import { createStripeRoutes } from "./routes/stripe.js";
import { createIapRoutes } from "./routes/iap.js";
import { createWebhookRoutes } from "./routes/webhooks.js";
import { createGithubRoutes } from "./routes/github.js";
import { emitTaskOutbound, isClosedTaskStatus } from "./github-outbound.js";
import { synthesizeReleaseCard } from "./webhook-card.js";
import { createAuthRoutes } from "./routes/auth.js";
import { createPasskeyRoutes } from "./routes/passkey.js";
import { createAssetRoutes, uploadBufferToS3 } from "./routes/assets.js";
import type { AgentImageAttachment, UploadedAgentImage } from "./codex-image-attachment.js";
import { createWorkspaceRestRoutes } from "./routes/workspace-rest.js";
import { createSuperadminRoutes } from "./routes/superadmin.js";
import { createPublicRoutes } from "./routes/public.js";
import { createClientLogRoutes } from "./routes/client-log.js";
import pino from "pino";
import {
  attachPinoBridge,
  configureObservability,
  flush,
  getScopedLogger,
} from "@cyborg7/observability/node";
import { resolveDaemonVersion } from "../daemon-version.js";
import { decideScheduledSend } from "./scheduled-message-send.js";
import { scheduledMessageView } from "./scheduled-message-runner.js";
import type { StoredSchedule, StoredScheduledMessage, StoredPromptTemplate } from "./storage.js";
import { isPageRestrictedFromUser, pageBroadcastPayload } from "./page-access.js";
import {
  promptTemplateView,
  validatePromptTemplate,
  expandPromptTemplate,
  formatTemplateDate,
} from "./prompt-template-expand.js";

// Same redaction set as packages/server/src/server/logger.ts (REDACT_PATHS) so the
// relay's pino logger never writes auth headers / sec-websocket-protocol to its
// console sink OR the Logfire bridge.
const RELAY_REDACT_PATHS = [
  "authorization",
  "Authorization",
  "headers.authorization",
  "headers.Authorization",
  "req.headers.authorization",
  "req.headers.Authorization",
  '["sec-websocket-protocol"]',
  "Sec-WebSocket-Protocol",
  'headers["sec-websocket-protocol"]',
  "headers.Sec-WebSocket-Protocol",
  'req.headers["sec-websocket-protocol"]',
  "req.headers.Sec-WebSocket-Protocol",
];

// Relay structured logger. Assigned at the top of main() AFTER
// configureObservability so attachPinoBridge can mirror its error/fatal records to
// Logfire (a no-op when LOGFIRE_TOKEN is unset). Module-scoped so the helpers
// declared inside main() — plus the bottom main().catch — log structurally.
let relayLog: pino.Logger;

// Full invitations: the base origin for the shareable invite landing URL
// (`${INVITE_BASE_URL}/invite/${token}`) and the 7-day token lifetime.
const INVITE_BASE_URL = process.env.CYBORG_APP_URL ?? "https://app.cyborg7.com";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A foregrounded desktop/web client idle (no user-driven app message) longer than
// this stops suppressing the user's phone (FCM) push — they've walked away from the
// open screen. Push-suppression only; never affects presence/away status.
const DESKTOP_ACTIVE_IDLE_MS = 30 * 60 * 1000;

// Defensive narrowing for untrusted WS JSON: a plain (non-array, non-null) object.
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Provider-readiness resolver (#636): snapshot this workspace's daemons ONCE
// (the in-memory connected set ∩ the PG workspace rows + their runtime meta) and
// return a per-cybo readiness fn. The intersection matters — PG's `status`
// column lags a hard disconnect, so live liveness comes from the relay. Used by
// create/update responses + broadcasts and the fetch_cybos roster so the UI can
// flag "needs daemon" cybos WITHOUT blocking their creation.
async function workspaceReadinessResolver(
  relay: WorkspaceRelay,
  pg: PgSync,
  workspaceId: string,
): Promise<(provider: string, model: string | null) => CyboReadiness> {
  const connected = new Set(relay.getConnectedDaemons());
  const wsDaemons = await pg.getDaemonsForWorkspace(workspaceId);
  const daemons = readinessDaemonsFrom(wsDaemons, connected, (id) => relay.getDaemonProviders(id));
  return (provider, model) => computeCyboReadiness(provider, model, daemons);
}

const DAEMON_FORWARD_TYPES = new Set([
  "cyborg:create_agent",
  "cyborg:list_agents",
  "cyborg:list_providers",
  "cyborg:list_recent_cwds",
  "cyborg:set_agent_model",
  "cyborg:set_agent_mode",
  "cyborg:set_agent_thinking",
  // 'Rewind to here' (#649): only the daemon that owns the agent can rewind its
  // live provider session, so forward it (like the other agent-control ops).
  "cyborg:rewind_agent",
  // Reload/restart a session (#592): the owning daemon holds the live session,
  // so forward it like the other agent-control ops.
  "cyborg:reload_session",
  "cyborg:list_commands",
  "cyborg:directory_suggestions",
  "cyborg:fetch_agent_state",
  "cyborg:fetch_agent_timeline",
  // Read-only session viewer (#994): the captured ephemeral context lives on the
  // OWNING daemon's SQLite — forward it there like fetch_agent_timeline. Pure
  // read; authorized by the audit predicate at the daemon dispatcher.
  "cyborg:fetch_session_context",
  "cyborg:archive_agent",
  "cyborg:restore_session",
  // Resume a LOCAL provider transcript into the workspace (#resume picker, local
  // tab). Only the daemon holding the on-disk transcript can import it, so forward
  // it to the owning daemon — and gate it with `spawn` scope + daemonId resolution
  // in the special-case branch below (it carries no agentId, like restore_session).
  "cyborg:import_session",
  // Local-import SCAN that BACKS the import above (#resume picker, "Local import"
  // tab). Paseo-native (NO `cyborg:` prefix): a read-only scan of the daemon's
  // on-disk provider transcripts (~/.claude/projects, …). The relay has no such
  // files, so it MUST forward to the workspace daemon (single-daemon, like the
  // import) and route the response back — see the no-agentId scan branch below.
  // #971 wired import_session but missed this scan, so cloud `/resume` answered
  // `unsupported: fetch_recent_provider_sessions_request`.
  "fetch_recent_provider_sessions_request",
  // Must forward to the daemon (NOT read cloud PG): the desktop daemon archives to
  // its local SQLite and has no PG connection, so the PG mirror never runs and the
  // PG-backed list was permanently stale (stuck at the few rows mirrored long ago).
  // archive_agent/restore_session already go to the daemon — list must too.
  "cyborg:list_archived_sessions",
  "cyborg:get_pairing_info",
  "cyborg:fetch_cybos",
  // Single-cybo fetch returns the full soul (DB row or, for a local cybo, read
  // off the daemon's disk) — only the daemon can resolve both, so forward it.
  "cyborg:fetch_cybo",
  // Probes the `pi` CLI on the daemon host — only the daemon can shell out.
  "cyborg:cybo_cli_status",
  "cyborg:cybo_cli_update",
  // On-demand provider snapshot re-check on the target daemon (self-repair).
  "cyborg:refresh_providers",
  // Read-only npm-latest check on the daemon host (the daemon owns npm).
  "cyborg:cybo_cli_latest",
  // Remote daemon self-update (#663): runs `cyborg daemon update` on the host
  // and restarts it. Gated by daemon access (DAEMON_HOST_CONTROL_TYPES below).
  // The latest-version probe is read-only (npm view), like cybo_cli_latest.
  "cyborg:update_daemon",
  "cyborg:daemon_update_latest",
  "cyborg:spawn_cybo",
  // Schedule WRITES execute on the owning daemon (the clock + SQLite truth live
  // there; the relay runs no runner) — forward like spawn_cybo. list_schedules
  // is NOT here: the relay answers it directly from the PG mirror (below) so
  // cloud/DMG users see schedules even when the owning daemon is asleep.
  "cyborg:create_schedule",
  "cyborg:update_schedule",
  "cyborg:set_schedule_enabled",
  "cyborg:delete_schedule",
  "cyborg:run_schedule_once",
  // Slash commands summon an ephemeral cybo, which needs a daemon's AgentManager
  // (the cloud relay runs no local agents) — forward to the owning daemon.
  "cyborg:slash_command",
  // create/update/delete_cybo are NOT forwarded: cybos are workspace-level PG
  // entities, so the relay authorizes (authoritative PG role + settings) and
  // mutates PG directly — exactly like create_channel. Enforcing on the daemon
  // (its local SQLite never syncs cloud settings) was the root of members being
  // wrongly denied "Cannot create cybo" despite allowMemberAgentCreation. See the
  // cyborg:create_cybo / update_cybo / delete_cybo handlers in the guest switch.
  // Snapshots a local (disk) cybo into the DB — only the daemon can read soul.md.
  "cyborg:import_cybo",
  // Terminal sessions run on the owning daemon's host (#654); start + the control
  // ops all forward there. terminal_output/terminal_exit flow back daemon→relay→
  // client through the default broadcast path (scoped by toUserId below).
  "cyborg:start_terminal",
  "cyborg:terminal_input",
  "cyborg:terminal_resize",
  "cyborg:kill_terminal",
  // Subscribe / unsubscribe — the snapshot-on-(re)subscribe self-heal model
  // (internal docs). Each subscribe registers a viewer that owns its own Paseo
  // subscription; the daemon forwards the fresh snapshot back via the toUserId
  // fan-out. Forwarded to the owning daemon like the other terminal control ops.
  "cyborg:subscribe_terminal",
  "cyborg:unsubscribe_terminal",
  // Forget a persisted dead terminal (#750) — control of an existing session's
  // on-disk history, forwarded to the owning daemon like the other terminal ops.
  "cyborg:forget_terminal",
  // List the caller's tracked sessions for a workspace (the directory feed's pull
  // half) — read-only, runs on the owning daemon's controller; forwarded there.
  // terminals_changed pushes flow back via the default toUserId broadcast path.
  "cyborg:list_terminals",
  // Provider credentials live in the OWNING daemon's encrypted file (internal docs
  // §3, §6.1) — the relay forwards by daemonId and never reads/writes the secret.
  // All three are admin-gated (DAEMON_HOST_CONTROL_TYPES below); list returns
  // metadata only.
  "cyborg:set_cybo_credential",
  "cyborg:remove_cybo_credential",
  "cyborg:list_provider_auth",
  // Daemon-owner audit (#993): list ALL sessions on one daemon (incl. ephemeral +
  // other users'). admin-gated (DAEMON_HOST_CONTROL_TYPES below); the relay routes
  // it to the single target daemon and answers from the PG mirror when it's offline.
  "cyborg:list_daemon_sessions",
]);

// Forwarded ops that EXECUTE on a daemon (spawn code). The relay is the only
// gatekeeper — the daemon can't see cloud daemon_access — so we must verify the
// caller can actually use the target daemon before forwarding. Read-only forwards
// (list_*/fetch_*) stay open so members can SEE daemons they can't use.
const DAEMON_SPAWN_TYPES = new Set([
  "cyborg:create_agent",
  "cyborg:spawn_cybo",
  "cyborg:slash_command",
  // Managing a schedule = configuring recurring code execution on a daemon, so
  // it needs the same gate as a spawn: non-viewer + daemon access (+ license).
  // This also gives schedule writes the single-daemon auto-resolution and the
  // "specify daemonId when several are online" rule for free.
  "cyborg:create_schedule",
  "cyborg:update_schedule",
  "cyborg:set_schedule_enabled",
  "cyborg:delete_schedule",
  "cyborg:run_schedule_once",
  // Opening a terminal = running a shell on a daemon — same privileged gate as a
  // spawn (#654): non-viewer + daemon access (+ license + single-daemon resolve).
  "cyborg:start_terminal",
]);

// Forwarded ops that mutate an existing agent — gated by that agent's daemon via
// checkAgentAccess (mirrors the prompt/cancel/permission paths).
const DAEMON_AGENT_CONTROL_TYPES = new Set([
  "cyborg:set_agent_model",
  "cyborg:set_agent_mode",
  "cyborg:set_agent_thinking",
  // Rewind mutates an existing agent's session — gate it on agent access (#649).
  "cyborg:rewind_agent",
  // Reload/restart mutates an existing agent's live session — gate on agent
  // access, same as rewind (#592).
  "cyborg:reload_session",
  "cyborg:archive_agent",
  "cyborg:restore_session",
  // import_session is session-resume like restore_session (resumes a NEW agent
  // with no agentId). Listed here for parity, but — exactly like restore_session
  // — it's actually handled by the special-case daemonId-resolution branch below
  // (the agentId-keyed gate can't resolve a daemon for it), not this set's branch.
  "cyborg:import_session",
]);

// Terminal control ops on an EXISTING daemon-scoped session (#654). Not agent-
// scoped (terminals aren't in PG), so the MUTATING ops carry an explicit daemonId
// and are gated by daemon access only — lightweight (no viewer/license overhead)
// since they're high-frequency, and the daemon owner-locks the terminal as a 2nd
// gate. The one exception is the read-only directory PULL (`cyborg:list_terminals`)
// from the sidebar: it deliberately OMITS daemonId and is FANNED OUT across every
// workspace daemon the caller can list on (a terminal created via the CLI lives on
// whichever daemon spawned it), then merged — see the list_terminals branch below.
const DAEMON_TERMINAL_CONTROL_TYPES = new Set([
  "cyborg:terminal_input",
  "cyborg:terminal_resize",
  "cyborg:kill_terminal",
  // Subscribe / unsubscribe to an existing session (internal docs): the
  // snapshot-on-(re)subscribe self-heal. Control of an existing PTY (not a spawn)
  // — gated by daemon access only; owner-locked on the daemon as a 2nd gate.
  "cyborg:subscribe_terminal",
  "cyborg:unsubscribe_terminal",
  // Forget a persisted dead session (#750): deletes its on-disk history on the
  // owning daemon. Gated by daemon access only (the daemon owner-locks as a 2nd
  // gate); not a spawn — no pty is created.
  "cyborg:forget_terminal",
  // List the owner's tracked sessions for a workspace — read-only directory pull.
  // The sidebar omits daemonId, so it's FANNED OUT to every workspace daemon the
  // caller can list on and merged (a daemonId-targeted pull stays a direct forward).
  // Gated by per-daemon `terminal` access; the controller owner-scopes the result.
  "cyborg:list_terminals",
]);

// Host-level daemon control (#663): running the daemon's self-update mutates +
// restarts the host machine, so it's RCE-grade — gated by daemon access (owner
// or #35 grant), the same gate as a spawn but without viewer/license overhead
// (it's an explicit, daemon-targeted admin action). Carries an explicit daemonId.
const DAEMON_HOST_CONTROL_TYPES = new Set([
  "cyborg:update_daemon",
  // Provider-credential RPCs (internal docs): admin-grade, daemon-targeted,
  // explicit daemonId required. The relay never reads the secret — it only routes
  // the envelope to the daemon that owns the encrypted store.
  "cyborg:set_cybo_credential",
  "cyborg:remove_cybo_credential",
  "cyborg:list_provider_auth",
  // Daemon-owner audit (#993): admin-grade, daemon-targeted (explicit daemonId).
  // The admin-scope gate here rejects a non-admin guest BEFORE any daemon forward.
  "cyborg:list_daemon_sessions",
]);

const PORT = parseInt(process.env.RELAY_PORT ?? "9100", 10);
const HOST = process.env.RELAY_HOST ?? "0.0.0.0";
// Closed set of workspace roles — invite/update_role must reject anything else
// (arbitrary strings silently break role comparisons + enable bogus grants).
const VALID_WORKSPACE_ROLES = new Set(["owner", "admin", "member", "viewer"]);

// Parse a stored slash-command model preference (JSON {"provider","model"}).
// Returns null for unset/corrupt values (→ inherit / auto-resolve).
function parseSlashModel(
  raw: string | null | undefined,
): { provider: string; model: string } | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { provider?: unknown; model?: unknown };
    if (typeof p.provider === "string" && typeof p.model === "string") {
      return { provider: p.provider, model: p.model };
    }
  } catch {
    // fall through
  }
  return null;
}

// JWT verify/mint, password hashing, and agent-access live in ./relay-auth.ts.

// ─── Main ─────────────────────────────────────────────────────────

interface GuestConnection {
  ws: WebSocket;
  userId: string;
  email: string;
  token: string;
  workspaceIds: Set<string>;
  // Agents this guest has prompted that may still be mid-turn. Keyed
  // "workspaceId agentId". On disconnect we cancel these so a turn left
  // waiting on a permission response (that only this guest could answer) does
  // not hang the agent forever.
  activeAgents: Set<string>;
  // Live terminal subscriptions this guest holds, keyed by terminalId. On a CLEAN
  // unsubscribe the entry is removed; on a DIRTY close (app crash) the close
  // handler forwards an unsubscribe_terminal to the owning daemon for each, so the
  // daemon-side viewer doesn't leak and double output on the next reopen (#807).
  // The daemon's per-user collapse (terminal-controller.ts addViewer) is the
  // primary guard; this just drops the leak immediately instead of at reopen.
  terminalSubs: Map<string, { workspaceId: string; daemonId: string; attachId?: string }>;
  // True while the client app is backgrounded — set via `cyborg:app_state`
  // (visibilitychange). Combined with `clientType` it drives desktop-active push
  // suppression: an open + foregrounded desktop/web connection silences the phone.
  backgrounded?: boolean;
  // Which surface this connection is — set via `cyborg:app_state`. Lets dispatchPush
  // skip the MOBILE (FCM) push for users actively on a bigger screen (v1 parity).
  // Undefined on older clients → treated as not-a-desktop, so no over-suppression.
  clientType?: "desktop" | "web" | "mobile";
  // Epoch ms of the last user-driven app message on this socket (NOT the WS-level
  // ping/pong keepalive, and NOT the `cyborg:ping` liveness round-trip). Used ONLY
  // by dispatchPush's desktop-active suppression: a desktop/web client that has
  // been foregrounded but idle longer than DESKTOP_ACTIVE_IDLE_MS stops silencing
  // the phone. This is DELIBERATELY independent of presence/away — it never feeds
  // awayUsers/userPresence or any status broadcast.
  lastActivityAt?: number;
}

async function main() {
  // ─── Deploy import smoke-check (tools/deploy-relay.sh) ────────
  // When RELAY_IMPORT_CHECK=1, the ENTIRE eager import graph of this entrypoint has
  // already resolved by the time main() runs (ESM evaluates all static imports on
  // module load) — so a missing dependency anywhere in that graph (e.g. an
  // uninstalled npm dep like `marked`, reached via mcp/http → mcp/server) throws on
  // IMPORT, before we ever get here. Exit cleanly BEFORE any side-effect
  // (observability bootstrap, DB pool, server.listen) so the deploy can verify the
  // entry imports WITHOUT starting a second server / binding the port. A genuinely
  // missing import fails this run → the deploy aborts BEFORE restarting the live
  // relay, instead of crash-looping it (the 2026-06-29 `marked` outage class).
  if (process.env.RELAY_IMPORT_CHECK === "1") {
    // eslint-disable-next-line no-console
    console.log("RELAY_IMPORT_CHECK: full eager import graph resolved OK");
    process.exit(0);
  }

  // ─── Observability ───────────────────────────────────────────
  // Bootstrap Logfire-on-OTel FIRST so every subsequent log/error is attributed.
  // Token-gated: with LOGFIRE_TOKEN unset this is a real no-op and the pino bridge
  // below stays a passthrough. `version` is the @getpaseo/server package version
  // (the relay's own version), resolved by walking up from this module.
  const version = resolveDaemonVersion(import.meta.url);
  configureObservability({
    platform: "relay",
    version,
    environment: process.env.CYBORG_ENV ?? "prod",
  });
  // Relay pino logger: JSON to stdout, REDACT_PATHS-equivalent redaction. The
  // bridge mirrors error/fatal records to Logfire (no-op when disabled).
  relayLog = attachPinoBridge(
    pino({
      level: process.env.RELAY_LOG_LEVEL ?? "info",
      redact: { paths: RELAY_REDACT_PATHS, remove: true },
    }),
  );

  let pg: PgSync | null = null;

  if (process.env.DATABASE_URL) {
    try {
      pg = new PgSync();
      relayLog.info("PostgreSQL connected");
    } catch (err) {
      relayLog.error({ err }, "PostgreSQL failed");
    }
  } else {
    relayLog.info("No DATABASE_URL — REST API disabled");
  }

  // ─── Redis ───────────────────────────────────────────────────

  let redis: RelayRedis | null = null;

  if (process.env.REDIS_URL) {
    try {
      redis = new RelayRedis(process.env.REDIS_URL, undefined, relayLog);
      await redis.connect();
      relayLog.info("Redis connected");
    } catch (err) {
      relayLog.error({ err }, "Redis failed");
      redis = null;
    }
  }

  // Unique id for this relay instance, used to ignore our own pub/sub echoes.
  const instanceId = randomUUID();

  // Cross-instance broadcast fanout. Off by default: a single relay needs no
  // Redis round-trip per broadcast (agent streams are high-frequency). Enable
  // on every instance when running more than one relay behind a load balancer.
  const broadcastFanout =
    process.env.RELAY_BROADCAST_FANOUT === "1" || process.env.RELAY_BROADCAST_FANOUT === "true";

  // ─── Web Push (VAPID) + native mobile push (FCM) ─────────────

  initWebPush();
  initFcm(relayLog);

  // ─── Guest WS state ──────────────────────────────────────────

  const guests = new Map<WebSocket, GuestConnection>();
  const guestSubs = new Map<string, Set<WebSocket>>();
  // P2 #6a: users who manually set themselves "away". Keyed by userId. DURABLE —
  // hydrated from user_presence on startup and persisted on toggle, so manual
  // away survives a full disconnect (it's the person's choice, not their socket
  // state). broadcastPresence intersects this with the online set, so an offline
  // away-user correctly shows offline.
  const awayUsers = new Set<string>();

  // Deliver a broadcast to guests connected to THIS instance only.
  function broadcastToGuestsLocal(
    workspaceId: string,
    message: Record<string, unknown>,
    seq?: number,
  ) {
    // Stop tracking an agent for guest-disconnect cancellation once its turn
    // ends, so GuestConnection.activeAgents stays bounded over a long session
    // and we don't re-cancel long-finished turns on disconnect. (Terminal event
    // names match message-router's own turn-end detection.)
    if (message.type === "cyborg:agent_stream") {
      const p = message.payload as { agentId?: string; event?: { type?: string } } | undefined;
      const evType = p?.event?.type;
      if (p?.agentId && (evType === "turn_completed" || evType === "turn_failed")) {
        const key = `${workspaceId}\t${p.agentId}`;
        for (const g of guests.values()) g.activeAgents.delete(key);
      }
    }
    const subs = guestSubs.get(workspaceId);
    if (!subs || subs.size === 0) return;
    // Per-message author/recipient scoping. Default is workspace-wide; private
    // types (DMs, per-user thread events, personal ephemeral results, owner-scoped
    // terminal streams, AUTHOR-only cybo mention/capability notices) narrow the
    // audience. Centralized in computeBroadcastScope so a new private type is one
    // tested unit, not a forgotten `if` here that silently leaks (internal docs #1).
    const { allowedUsers, allowedEmail } = computeBroadcastScope(message);
    const enriched =
      message.payload && typeof message.payload === "object" && seq !== undefined
        ? { ...message, payload: { ...(message.payload as Record<string, unknown>), seq } }
        : message;
    const data = JSON.stringify({ type: "session", message: enriched });
    for (const ws of subs) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (allowedUsers) {
        const g = guests.get(ws);
        if (!g || !allowedUsers.has(g.userId)) continue;
      }
      if (allowedEmail) {
        const g = guests.get(ws);
        if (!g || g.email !== allowedEmail) continue;
      }
      ws.send(data);
    }
  }

  // Tasks Phase 2 — per-channel watcher debounce on the relay (agent_watch
  // bucket, ≤1 watch turn / 20s / channel). The watcher fires on un-mentioned
  // human chatter and each fire spawns an (LLM) ephemeral cybo, so this caps cost
  // BEFORE the chain/task lookups + forward. Keyed by channel id. Relay-local
  // (a single relay instance owns the post path for a given WS connection).
  const watcherRateLimiter = new RateLimiter();

  // Deliver to local guests AND fan out to other relay instances via Redis so
  // guests connected elsewhere receive the same broadcast.
  function broadcastToGuests(
    workspaceId: string,
    message: Record<string, unknown>,
    _fromDaemonId?: string,
    seq?: number,
  ) {
    broadcastToGuestsLocal(workspaceId, message, seq);
    if (redis && broadcastFanout) {
      redis
        .publishBroadcast({ originId: instanceId, workspaceId, message, seq })
        .catch((err) =>
          relayLog.error(
            { err, workspaceId, seq },
            "Redis broadcast fanout publish failed — other relay instances missed this message",
          ),
        );
    }
  }

  // ─── Task-pipeline observability (Logs tab) ──────────────────────
  // Fan a structured task event out to a workspace's guests. Best-effort; a
  // fan-out failure must never poison the task/watcher path it rides on.
  function emitTaskEventForWorkspace(workspaceId: string, event: TaskLogEvent): void {
    try {
      broadcastToGuests(workspaceId, taskEventBroadcast(event));
    } catch (err) {
      relayLog.error({ err, workspaceId }, "task_event broadcast failed");
    }
  }

  // ─── Audit-trace observability (#995, Logs tab) ──────────────────
  // Relay-originated audit events (the sibling of emitTaskEventForWorkspace). Fan
  // a structured AuditEvent out to a workspace's guests as `cyborg:audit_event`.
  // Best-effort; a fan-out failure must never poison the operation it rides on.
  // (Daemon-originated audit events reach guests via the default onBroadcast
  // forward — this is only for events the relay itself produces.)
  function emitAuditEventForWorkspace(workspaceId: string, event: AuditEvent): void {
    try {
      broadcastToGuests(workspaceId, auditEventBroadcast(event));
    } catch (err) {
      relayLog.error({ err, workspaceId }, "audit_event broadcast failed");
    }
  }
  const relayAuditSink = createAuditSink((event) =>
    emitAuditEventForWorkspace(event.workspaceId, event),
  );

  // Resolve a task assignee id to a display name for the Logs tab: a cybo by its
  // name, else a workspace human by name/email, else null (unassigned/unknown).
  async function resolveAssigneeNameForLog(
    workspaceId: string,
    assigneeId: string | null,
  ): Promise<string | null> {
    if (!assigneeId) return null;
    try {
      const cybo = (await pg.getCybos(workspaceId)).find((c) => c.id === assigneeId);
      if (cybo) return cybo.name;
      const user = await pg.getUserById(assigneeId);
      if (user) return user.name ?? user.email ?? assigneeId;
    } catch {
      // best-effort display resolution
    }
    return assigneeId;
  }

  // Whether the assignee is a cybo (→ carry its id as cyboId on the log event).
  async function resolveCyboIdForLog(
    workspaceId: string,
    assigneeId: string | null,
  ): Promise<string | null> {
    if (!assigneeId) return null;
    try {
      const isCybo = (await pg.getCybos(workspaceId)).some((c) => c.id === assigneeId);
      return isCybo ? assigneeId : null;
    } catch {
      return null;
    }
  }

  // Receive broadcasts fanned out by OTHER relay instances and deliver them to
  // our local guests. Skip our own echoes (already delivered locally).
  if (redis && broadcastFanout) {
    redis
      .subscribeBroadcast(({ originId, workspaceId, message, seq }) => {
        if (originId === instanceId) return;
        broadcastToGuestsLocal(workspaceId, message, seq);
      })
      .then(() => relayLog.info("Redis broadcast fanout subscribed"))
      .catch((err) => relayLog.error({ err }, "Redis subscribe failed"));
  }

  // ─── Web Push dispatch ───────────────────────────────────────

  // Users with an open guest socket are "online" — they get the in-app update,
  // so we don't also push to them. (Single-instance accurate; with multi-relay
  // a user connected elsewhere may still be pushed — acceptable.)
  function connectedUserIdsInWorkspace(workspaceId: string): Set<string> {
    const ids = new Set<string>();
    const subs = guestSubs.get(workspaceId);
    if (!subs) return ids;
    for (const ws of subs) {
      const g = guests.get(ws);
      if (g && ws.readyState === WebSocket.OPEN) ids.add(g.userId);
    }
    return ids;
  }

  // Presence: a user is "online" while they hold an open guest socket. Whenever
  // the connected set changes (a guest authenticates or disconnects), push every
  // guest the set of THEIR co-members who are currently online, so DM/member
  // dots go green live. Scoped to co-members — a guest never learns about users
  // they don't share a workspace with. Snapshot semantics: the client replaces
  // its online set with what we send, so a single message per guest covers all
  // their workspaces without cross-workspace clobber.
  //
  // Previously NO presence was ever broadcast in cloud mode, so every human
  // showed offline (only "self" lit up) — that's what made connected users
  // appear offline to each other.
  //
  // `changedWorkspaceIds` scopes the broadcast to only the guests who share one
  // of those workspaces (the ones whose online set could have changed), instead
  // of pinging every connected guest in the whole system on each connect/
  // disconnect — that was an O(N²) storm across unrelated tenants. Omit it only
  // for a full refresh.
  function broadcastPresence(changedWorkspaceIds?: Iterable<string>): void {
    const perWorkspaceOnline = new Map<string, Set<string>>();
    const onlineInWorkspace = (wsId: string): Set<string> => {
      let cached = perWorkspaceOnline.get(wsId);
      if (!cached) {
        cached = connectedUserIdsInWorkspace(wsId);
        perWorkspaceOnline.set(wsId, cached);
      }
      return cached;
    };
    // Resolve the set of sockets to notify: only guests subscribed to a changed
    // workspace, or every guest when no scope is given.
    const targets = new Set<WebSocket>();
    if (changedWorkspaceIds) {
      for (const wsId of changedWorkspaceIds) {
        const subs = guestSubs.get(wsId);
        if (subs) for (const ws of subs) targets.add(ws);
      }
    } else {
      for (const ws of guests.keys()) targets.add(ws);
    }
    for (const ws of targets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const g = guests.get(ws);
      if (!g) continue;
      const online = new Set<string>();
      const away = new Set<string>();
      for (const wsId of g.workspaceIds) {
        for (const uid of onlineInWorkspace(wsId)) {
          online.add(uid);
          // Away if the user manually toggled away (durable). Intersected with the
          // online set above, so an offline user never shows away.
          if (awayUsers.has(uid)) away.add(uid);
        }
      }
      sendPaseoResponse(ws, "cyborg:presence_update", {
        onlineUserIds: [...online],
        awayUserIds: [...away],
      });
    }
  }

  // P2 Item 6: a user's custom status changed in `workspaceId`. Push the new
  // status to every guest who shares that workspace (its co-members), mirroring
  // the presence_update fan-out so the emoji shows live where presence shows.
  // Scoped to co-members — a guest never learns about users they don't share a
  // workspace with.
  function broadcastUserStatusChanged(
    workspaceId: string,
    status: {
      userId: string;
      emoji: string | null;
      text: string | null;
      expiresAt: number | null;
    },
  ): void {
    const subs = guestSubs.get(workspaceId);
    if (!subs) return;
    for (const gws of subs) {
      if (gws.readyState !== WebSocket.OPEN) continue;
      sendPaseoResponse(gws, "cyborg:user_status_changed", { workspaceId, ...status });
    }
  }

  // Fire-and-forget: push to each OFFLINE recipient over both transports — web
  // push (VAPID) and native mobile (FCM) — pruning any subscription/token the
  // push service reports as gone. A user with both a browser sub and a phone
  // token gets both; either transport being unconfigured just skips that arm.
  async function dispatchPush(
    workspaceId: string,
    recipientIds: string[],
    payload: PushPayload,
  ): Promise<void> {
    if (!pg || recipientIds.length === 0) return;
    if (!isWebPushConfigured() && !isFcmConfigured()) return;
    const pgRef = pg;
    // v1 parity (cyborg7-core/src/lib/push/policy.ts): push to EVERY pref-eligible
    // recipient regardless of whether their app is open. v1 NEVER gated mobile push
    // on the mobile app's own foreground/background — only on an active *desktop*,
    // which this relay can't yet detect (GuestConnection carries no desktop/mobile
    // tag). The "don't buzz me for the chat I'm already looking at" suppression is a
    // CLIENT concern: the iOS plugin's willPresent (activeKey == pushKey) and the web
    // Service Worker handle it — NOT the server. (The server can't know which chat a
    // client is viewing; v1's policy comment says exactly this.)
    //
    // Why not gate on an open socket: a foregrounded phone got NO push at all ("no
    // push inside"), and a backgrounded phone fared no better — iOS freezes the JS
    // loop on background, so the `cyborg:app_state: background` signal often never
    // flushes before the socket is suspended, leaving the relay to treat a frozen
    // phone as "active" and suppress its push ("no push outside"). Pushing to all
    // recipients and letting the client dedup is the only reliable model.
    const dedupedTargets = [...new Set(recipientIds)];
    if (dedupedTargets.length === 0) return;
    // DND/away gating (#604): drop recipients who are in an unexpired Do-Not-
    // Disturb window (dndUntil > now) or manually away — BEFORE both push arms,
    // so neither web-push nor FCM buzzes them. This is the server-side half of
    // DND: the client already hides its own banners (dc63bd140), but a phone in
    // someone's pocket still vibrated because the relay never read the presence
    // it already stores + broadcasts. Fail-open: a presence-lookup error pushes
    // to everyone (a missed suppression beats a dropped notification).
    const suppressed = await pgRef
      .getPushSuppressedUserIds(dedupedTargets, new Date())
      .catch(() => new Set<string>());
    const targets = dedupedTargets.filter((id) => !suppressed.has(id));
    if (targets.length === 0) return;
    // Prefix the title with the workspace name so a multi-workspace user can tell
    // WHICH workspace a push came from (v1 parity: "Workspace · #channel" /
    // "Workspace · Person (DM)"). The call sites already encode person + channel in
    // the title (e.g. "Alice mentioned you in #general", "#general", "Alice (DM)");
    // this adds the workspace as the leading segment. Resolved once per dispatch;
    // On lookup failure we fall back to the bare title (handled below) rather than
    // drop the push.
    // intentional: best-effort title enrichment.
    const wsName = (await pgRef.getWorkspaceById(workspaceId).catch(() => null))?.name;
    const titledPayload: PushPayload = wsName
      ? { ...payload, title: `${wsName} · ${payload.title}` }
      : payload;
    if (isWebPushConfigured()) {
      const subs = await pgRef.getPushSubscriptionsForUsers(targets);
      await Promise.all(
        subs.map(async (s) => {
          const res = await sendWebPush(s, titledPayload);
          // Self-heals on the next "gone" response if this delete fails.
          // intentional: best-effort prune of a dead push subscription.
          if (res === "gone") await pgRef.deletePushSubscriptionById(s.id).catch(() => {});
        }),
      );
    }
    if (isFcmConfigured()) {
      // Desktop-active suppression (v1 parity): skip the PHONE push for users who
      // are actively on a desktop/web session (open WS + foregrounded) — they're at
      // the bigger screen and see it there. MOBILE (FCM) only; the web-push arm
      // above (closed-tab Service Worker path) is intentionally untouched. When the
      // desktop minimizes (app_state→background) or disconnects, the phone resumes
      // on the next message.
      //
      // Idle escape hatch: a desktop/web client left foregrounded but with NO user
      // interaction for DESKTOP_ACTIVE_IDLE_MS (30 min) is treated as "walked away"
      // — it no longer silences the phone, so a left-open laptop still delivers to
      // the pocket. lastActivityAt is push-only and never touches presence/away, so
      // the user keeps showing online here (their away dot is unaffected).
      const now = Date.now();
      const onActiveDesktop = new Set<string>();
      for (const g of guests.values()) {
        if (
          isDesktopActiveForPush(
            {
              clientType: g.clientType,
              backgrounded: g.backgrounded,
              wsOpen: g.ws.readyState === WebSocket.OPEN,
              lastActivityAt: g.lastActivityAt,
            },
            now,
            DESKTOP_ACTIVE_IDLE_MS,
          )
        ) {
          onActiveDesktop.add(g.userId);
        }
      }
      const fcmTargets = targets.filter((id) => !onActiveDesktop.has(id));
      const tokens = await pgRef.getFcmTokensForUsers(fcmTargets);
      // iOS app-icon badge: compute the per-recipient unread count ONCE per
      // dispatch (batched — never per-token, avoiding the v1 N+1), then attach
      // each token's owner count to its payload. The token row carries userId,
      // so token→count is a direct map lookup. Web push above is left untouched.
      const badgeCounts = await pgRef
        .badgeCountsForRecipients(fcmTargets)
        .catch(() => new Map<string, number>());
      await Promise.all(
        tokens.map(async (t) => {
          const badgeCount = badgeCounts.get(t.userId);
          const tokenPayload =
            badgeCount !== undefined ? { ...titledPayload, badgeCount } : titledPayload;
          const res = await sendFcm(t.token, tokenPayload, t.platform);
          // Self-heals on the next "gone" response if this delete fails.
          // intentional: best-effort prune of a dead FCM token.
          if (res === "gone") await pgRef.deleteFcmToken(t.token).catch(() => {});
        }),
      );
    }
  }

  // #605 clear-on-read badge sync: when a user's read state advances and their
  // unread-activity rows are marked read, push a SILENT FCM badge update to the
  // user's mobile tokens so the app-icon badge drops without opening the app.
  // The relay holds the FCM tokens (cloud mode), so this is where the clear must
  // fire. Reuses the existing FCM transport (sendFcmBadge) + dead-token prune —
  // NOT a new push path; carries no visible notification. Uses the RAW unread
  // count (no +1 in-flight bump) so the badge can clear all the way to 0.
  // Best-effort and off the response path: the caller `void`s it.
  async function pushBadgeUpdate(userId: string): Promise<void> {
    if (!pg || !isFcmConfigured()) return;
    const pgRef = pg;
    // A count-query failure must not break read-state handling; null skips the
    // badge push and the badge self-corrects on the next push.
    // intentional: best-effort unread-count read for the badge clear.
    const count = await pgRef.unreadBadgeCount(userId).catch(() => null);
    if (count === null) return;
    const tokens = await pgRef.getFcmTokensForUsers([userId]);
    await Promise.all(
      tokens.map(async (t) => {
        const res = await sendFcmBadge(t.token, count, t.platform);
        // Self-heals on the next "gone" response if this delete fails.
        // intentional: best-effort prune of a dead FCM token (mirrors dispatchPush).
        if (res === "gone") await pgRef.deleteFcmToken(t.token).catch(() => {});
      }),
    );
  }

  // ─── Paseo protocol helpers ───────────────────────────────────

  function sendPaseoResponse(ws: WebSocket, type: string, payload: Record<string, unknown>): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "session", message: { type, payload } }));
  }

  // Deliver to a user's OTHER guest connections (cross-device sync for read /
  // notification-pref changes). Scoped to the user — NOT workspace-wide — so it
  // can never clear someone else's unread.
  function notifyUserGuests(
    userId: string,
    type: string,
    payload: Record<string, unknown>,
    exceptWs: WebSocket,
  ): void {
    for (const [gws, g] of guests) {
      if (g.userId === userId && gws !== exceptWs && gws.readyState === WebSocket.OPEN) {
        gws.send(JSON.stringify({ type: "session", message: { type, payload } }));
      }
    }
  }

  // P2 Item 9: persist an activity-feed row for a recipient. The cloud relay
  // previously never wrote activity_events (only the daemon's message-router
  // did), so markActivityReadByChannel / seedReadFromServer had no rows to act
  // on and cross-device activity read-state never synced. Mirrors the daemon's
  // emitActivity: insert the row (id + createdAt generated here for PG). Best-
  // effort — a failed insert must not break message delivery.
  async function emitActivityEvent(
    recipientUserId: string,
    e: {
      workspaceId: string;
      eventType: string;
      sourceId: string;
      // Defaults to "message" (mentions/thread replies). Task activity passes
      // "task" so a task-feed row is distinguishable from a chat one. Bare-text
      // column, so a new value needs no migration.
      sourceType?: string;
      channelId?: string | null;
      dmPeerId?: string | null;
      previewText?: string | null;
      actorId?: string | null;
      actorName?: string | null;
    },
  ): Promise<void> {
    try {
      await pg.insertActivityEvent({
        ...e,
        id: randomUUID(),
        userId: recipientUserId,
        sourceType: e.sourceType ?? "message",
        createdAt: Date.now(),
      });
    } catch (err) {
      relayLog.error({ err }, "activity insert failed");
    }
  }

  // ─── list_agents fan-out aggregation ─────────────────────────
  // A workspace can have multiple daemons (e.g. an invited member runs their own).
  // Each daemon only knows ITS agents, so list_agents is fanned out to every daemon
  // and the per-daemon responses are merged here (deduped by agentId) before the
  // single merged response is sent to the requesting guest. Keyed by requestId
  // (req_<counter>_<ms>, effectively unique per in-flight request).
  interface AgentListAggregation {
    guestWs: WebSocket;
    workspaceId: string;
    // The requesting guest's email — used to filter OFFLINE (PG-mirrored) sessions
    // so a member only sees their own private sessions when the owning daemon is
    // asleep (the live rows are already filtered by the daemon).
    guestEmail: string | null;
    // The requesting guest's GLOBAL account id. Used together with guestEmail to
    // scope the stale-binding GC (Part 1, #810) to the requester's OWN sessions,
    // matching the same ownership rule the offline visibility filter uses (cloud
    // sessions carry the global id as initiated_by; own-daemon sessions match by
    // real email).
    guestUserId: string;
    // True when the originating list_agents request carried a NARROWING filter
    // (e.g. cyboId) — the daemon then answers with a SUBSET of the user's live
    // agents, so the stale-binding GC must be SKIPPED (a binding absent from a
    // filtered list may still be a live agent of the user). Only an UNFILTERED
    // list is the complete live set the GC requires.
    filtered: boolean;
    agents: Map<string, Record<string, unknown>>;
    pendingDaemons: Set<string>;
    timer: ReturnType<typeof setTimeout>;
  }
  const agentListAggregations = new Map<string, AgentListAggregation>();

  // Durable session list: a workspace's agent sessions are mirrored to PG
  // (agent_bindings) so they stay listed when the owning daemon is offline. Read
  // the mirror and turn the bindings whose daemon is NOT in the live fan-out into
  // offline list rows, applying the same private-session visibility filter the
  // daemon would. Returns null when there is no PG or the read fails, so callers
  // fall back to the live-only behaviour (never crashing the list).
  async function offlineAgentRowsFromPg(
    workspaceId: string,
    guestEmail: string | null,
    liveAgentIds: ReadonlySet<string>,
    viewerGlobalId: string | null,
  ): Promise<Record<string, unknown>[] | null> {
    if (!pg) return null;
    try {
      const bindings = await pg.getAgentBindingsByWorkspace(workspaceId);
      return offlineAgentRows(bindings, guestEmail, liveAgentIds, viewerGlobalId);
    } catch (err) {
      relayLog.error(
        { err, workspaceId },
        "getAgentBindingsByWorkspace failed — offline agent sessions hidden this list",
      );
      return null;
    }
  }

  // Answer list_agents purely from the PG mirror when NO daemon is online, so the
  // workspace's sessions stay visible (offline, not-live) instead of erroring.
  // Returns false when there's nothing to fall back on (no PG / read failed) so the
  // caller keeps the original "start your daemon" error. Extracted so the request
  // handler's no-daemon branch stays under the max-depth budget.
  async function sendOfflineAgentList(
    targetWs: WebSocket,
    requestId: string,
    workspaceId: string,
    guestEmail: string | null,
    viewerGlobalId: string | null,
  ): Promise<boolean> {
    const offline = await offlineAgentRowsFromPg(
      workspaceId,
      guestEmail,
      new Set(),
      viewerGlobalId,
    );
    if (!offline) return false;
    const cmap = await cyboMapForWorkspace(workspaceId);
    for (const row of offline) enrichCyboFields(row, cmap);
    await resolveCrossDaemonLifecycle(workspaceId, offline);
    await resolveInitiatedByToGlobalId(offline);
    sendPaseoResponse(targetWs, "cyborg:list_agents_response", { requestId, agents: offline });
    return true;
  }

  // ─── Daemon-owner session audit (#993) ───────────────────────
  // The audit lists ALL sessions on ONE daemon (incl. ephemeral + other users') for
  // the daemon owner / admin grantee. The admin-scope gate runs at the relay
  // boundary BEFORE the forward; the daemon answers with a single response (no
  // fan-out / merge), which we intercept to resolve initiatedBy → global id (group
  // under "You") and enrich cybo labels before relaying it to the requesting guest.
  // Keyed by requestId so the daemon→relay response finds the originating guest.
  interface DaemonSessionAuditRequest {
    guestWs: WebSocket;
    workspaceId: string;
    daemonId: string;
    timer: ReturnType<typeof setTimeout>;
  }
  const daemonSessionAuditRequests = new Map<string, DaemonSessionAuditRequest>();

  // Remember which guest a forwarded audit request belongs to (keyed by requestId)
  // so the daemon→relay response routes back to it. Extracted so the routing branch
  // stays flat (max-depth). The timer drops a stale entry if the daemon never answers.
  function trackDaemonSessionAudit(
    requestId: string,
    guestWs: WebSocket,
    workspaceId: string,
    daemonId: string,
  ): void {
    const existing = daemonSessionAuditRequests.get(requestId);
    if (existing) clearTimeout(existing.timer);
    daemonSessionAuditRequests.set(requestId, {
      guestWs,
      workspaceId,
      daemonId,
      timer: setTimeout(() => daemonSessionAuditRequests.delete(requestId), 10000),
    });
  }

  // Mutate the audit rows IN PLACE with cybo labels + global-id initiator grouping,
  // the same enrichment the live list_agents merge applies, then send to the guest.
  async function finalizeDaemonSessionAudit(
    guestWs: WebSocket,
    requestId: string,
    workspaceId: string,
    daemonId: string,
    sessions: Record<string, unknown>[],
  ): Promise<void> {
    const cmap = await cyboMapForWorkspace(workspaceId);
    for (const row of sessions) enrichCyboFields(row, cmap);
    await resolveCrossDaemonLifecycle(workspaceId, sessions);
    await resolveInitiatedByToGlobalId(sessions);
    sendPaseoResponse(guestWs, "cyborg:list_daemon_sessions_response", {
      requestId,
      daemonId,
      sessions,
    });
  }

  // Offline fallback: the gate has ALREADY passed, so list EVERY mirrored binding on
  // the target daemon — no per-user `offlineBindingVisible` scoping, no ephemeral
  // drop. Returns false when there's no PG / the read failed (caller keeps the
  // "start your daemon" error). Mirrors sendOfflineAgentList for the audit shape.
  async function sendOfflineDaemonSessions(
    guestWs: WebSocket,
    requestId: string,
    workspaceId: string,
    daemonId: string,
  ): Promise<boolean> {
    if (!pg) return false;
    let bindings: Awaited<ReturnType<typeof pg.getAgentBindingsByWorkspace>>;
    try {
      bindings = await pg.getAgentBindingsByWorkspace(workspaceId);
    } catch (err) {
      relayLog.error(
        { err, workspaceId, daemonId },
        "getAgentBindingsByWorkspace failed — offline daemon audit unavailable",
      );
      return false;
    }
    const sessions = auditAgentRows(bindings, daemonId);
    await finalizeDaemonSessionAudit(guestWs, requestId, workspaceId, daemonId, sessions);
    return true;
  }

  // A cybo created via the cloud lives ONLY in PG, so the daemon can't denormalize
  // its name/avatar into list_agents/archived responses (it scans local SQLite +
  // disk). Without this the session reads as its PROVIDER ("opencode-go") with the
  // generic provider icon instead of "Apex" with its photo. Fill the gap here from
  // PG (workspace-shared cybos) at finalize, so it's authoritative regardless of
  // the daemon's version or the client's cybo-list timing.
  async function cyboMapForWorkspace(
    workspaceId: string,
  ): Promise<Map<string, { name: string; avatar: string | null }>> {
    const map = new Map<string, { name: string; avatar: string | null }>();
    if (!pg) return map;
    try {
      for (const c of await pg.getCybos(workspaceId)) {
        map.set(c.id, { name: c.name, avatar: c.avatar ?? null });
      }
    } catch {
      // PG read failed — fall back to whatever the daemon denormalized.
    }
    return map;
  }

  // Fill cyboName/cyboAvatar on a row IN PLACE from the PG cybo map when the
  // daemon couldn't denormalize them (cloud-only cybo). Mutates to avoid a
  // spread-in-map (oxlint no-map-spread); the row objects are relay-owned.
  function enrichCyboFields(
    row: Record<string, unknown>,
    cmap: Map<string, { name: string; avatar: string | null }>,
  ): void {
    const cyboId = row.cyboId as string | undefined;
    if (!cyboId || (row.cyboName && row.cyboAvatar)) return;
    const c = cmap.get(cyboId);
    if (!c) return;
    row.cyboName = row.cyboName ?? c.name;
    row.cyboAvatar = row.cyboAvatar ?? c.avatar;
  }

  // Resolve cross-daemon lifecycle on the merged agent list IN PLACE. A daemon
  // answers list_agents for the WHOLE workspace from its synced bindings, but it
  // only has a live handle on ITS OWN agents — a peer daemon's agent is reported
  // with lifecycle "unknown" and daemonLocal:false (dispatcher.ts liveAgentFields).
  // The relay owns daemon_agents (status kept live by the agent_status report),
  // so it is authoritative for those rows: override the "unknown" lifecycle with
  // the persisted status and stamp the owning daemonId so the cross-daemon
  // sidebar can badge the row by its daemon (PR #799 reads agent.daemonId).
  async function resolveCrossDaemonLifecycle(
    workspaceId: string,
    agents: Record<string, unknown>[],
  ): Promise<void> {
    if (!pg || agents.length === 0) return;
    let rows: { daemonId: string; agentId: string; status: string }[];
    try {
      rows = await pg.getDaemonAgentsByWorkspace(workspaceId);
    } catch (err) {
      // PG read failed — leave the daemon-reported rows untouched (a remote
      // agent stays "unknown", same as before, rather than the list erroring).
      relayLog.error(
        { err, workspaceId },
        "getDaemonAgentsByWorkspace failed — cross-daemon agents may show lifecycle 'unknown'",
      );
      return;
    }
    resolveAgentLifecycleFromBindings(agents, rows);
  }

  // Resolve each row's initiatedBy (a daemon-LOCAL SQLite user id, unique to the
  // owning daemon's id space) to the GLOBAL PG account id by identity (email), so
  // a session a user launched on ANOTHER user's daemon groups under that user's
  // "You". Without this, R's session on S's daemon carries S's local id for R
  // (e.g. 7d8395e3) which never equals R's cloud account id (4871b232), so the UI
  // groups it under a phantom local id instead of "You" (session-scope.ts
  // groupByOwner). The daemon carries initiatedByEmail (the stable cross-namespace
  // identity); we batch-resolve those emails to global ids via PG, then overlay
  // via the pure transform (mutates in place, same idiom as enrichCyboFields).
  async function resolveInitiatedByToGlobalId(agents: Record<string, unknown>[]): Promise<void> {
    if (!pg || agents.length === 0) return;
    const emails = collectInitiatedByEmails(agents);
    if (emails.length === 0) return;
    let emailToGlobalId: Map<string, string>;
    try {
      emailToGlobalId = await pg.getUserIdsByEmails(emails);
    } catch (err) {
      // PG read failed — leave initiatedBy as the daemon-local id (same as before
      // this bridge) rather than erroring the whole list.
      relayLog.error(
        { err },
        "getUserIdsByEmails failed resolving initiatedBy — rows keep daemon-local ids",
      );
      return;
    }
    resolveInitiatedByGlobalIds(agents, emailToGlobalId);
  }

  async function finalizeAgentList(requestId: string): Promise<void> {
    const agg = agentListAggregations.get(requestId);
    if (!agg) return;
    agentListAggregations.delete(requestId);
    clearTimeout(agg.timer);
    // Union in PG-mirrored sessions whose owning daemon is OFFLINE (its agentId is
    // absent from the live fan-out), so the workspace's sessions survive a daemon
    // restart. Live rows win the dedupe; a PG miss leaves just the live rows.
    const offline = await offlineAgentRowsFromPg(
      agg.workspaceId,
      agg.guestEmail,
      new Set(agg.agents.keys()),
      agg.guestUserId,
    );
    if (offline) {
      for (const row of offline) {
        const id = row.agentId as string | undefined;
        if (id && !agg.agents.has(id)) agg.agents.set(id, row);
      }
    }
    const cmap = await cyboMapForWorkspace(agg.workspaceId);
    const agents = Array.from(agg.agents.values());
    for (const a of agents) enrichCyboFields(a, cmap);
    await resolveCrossDaemonLifecycle(agg.workspaceId, agents);
    await resolveInitiatedByToGlobalId(agents);
    sendPaseoResponse(agg.guestWs, "cyborg:list_agents_response", { requestId, agents });
  }

  // ─── list_archived_sessions fan-out aggregation ──────────────
  // Archives live in each daemon's LOCAL SQLite, so — exactly like list_agents —
  // a single-daemon forward answers with one daemon's archive. With several
  // daemons subscribed, the no-target forward picked an arbitrary one and the
  // guest saw "No archived sessions" whenever the wrong daemon answered first.
  interface ArchivedListAggregation {
    guestWs: WebSocket;
    workspaceId: string;
    sessions: Map<string, Record<string, unknown>>;
    pendingDaemons: Set<string>;
    timer: ReturnType<typeof setTimeout>;
    // Page size requested by the guest (undefined ⇒ legacy full list). Each daemon
    // returns its own newest `limit` rows; the relay re-caps the MERGED stream to
    // `limit` and recomputes a GLOBAL keyset cursor so "show more" pages older
    // history coherently across daemons (the cursor is a global (archivedAt, id)
    // keyset, so every daemon applies the same predicate on the next page).
    limit?: number;
    // True once ANY daemon reported a non-null nextCursor (it has more rows beyond
    // its page). REQUIRED for the single-daemon case: each daemon already caps its
    // OWN response to `limit`, so the merged stream is ≤ limit and the
    // `merged > limit` test alone never fires — the cursor would always be null and
    // "Show more" would be dead. OR-ing this in restores it (a daemon reports "more"
    // only when it returned a full page, so this implies merged ≥ limit).
    daemonHasMore: boolean;
  }
  const archivedListAggregations = new Map<string, ArchivedListAggregation>();

  async function finalizeArchivedList(requestId: string): Promise<void> {
    const agg = archivedListAggregations.get(requestId);
    if (!agg) return;
    archivedListAggregations.delete(requestId);
    clearTimeout(agg.timer);
    const cmap = await cyboMapForWorkspace(agg.workspaceId);
    const rows = Array.from(agg.sessions.values()) as Array<
      Record<string, unknown> & { archivedAt: number; id: string }
    >;
    // Coerce the keyset fields IN PLACE (archivedAt missing ⇒ 0, id stringified) so
    // the sort + the pure paginator share one total order — no object spread
    // (oxc/no-map-spread); the records are throwaway (the aggregation is deleted).
    for (const s of rows) {
      enrichCyboFields(s, cmap);
      s.archivedAt = typeof s.archivedAt === "number" ? s.archivedAt : 0;
      s.id = String(s.id);
    }
    // Newest first — the daemon archives don't guarantee order across daemons once
    // merged, and the user expects most-recently-archived at the top. Tie-break by
    // id DESC so the keyset cursor is total.
    rows.sort((a, b) => {
      if (b.archivedAt !== a.archivedAt) return b.archivedAt - a.archivedAt;
      if (b.id < a.id) return -1;
      if (b.id > a.id) return 1;
      return 0;
    });
    // Cap to the page size + derive the GLOBAL keyset cursor. `daemonHasMore` is the
    // OR of every per-daemon nextCursor — REQUIRED for the single-daemon case, where
    // each daemon self-caps so the merge never overflows `limit` on its own.
    const { sessions, nextCursor } = finalizeMergedArchivedPage(rows, {
      limit: agg.limit,
      daemonHasMore: agg.daemonHasMore,
    });
    sendPaseoResponse(agg.guestWs, "cyborg:list_archived_sessions_response", {
      requestId,
      sessions,
      nextCursor,
    });
  }

  // ─── list_terminals fan-out aggregation ─────────────────────
  // The terminal directory lives in each daemon's OWN controller (not in PG): a
  // terminal created via the CLI `cyborg:start_terminal` (PR #838) is known only
  // to the daemon that spawned it. The sidebar pulls the directory with NO
  // daemonId, so — exactly like list_agents / list_archived_sessions — a single-
  // daemon forward answers with one daemon's terminals (or, before this, the relay
  // rejected the pull as "daemonId required" and the Terminals section never
  // showed). Fan out, merge per-daemon responses (deduped by terminalId), and send
  // ONE merged response to the requesting guest. Keyed by requestId.
  interface TerminalListAggregation {
    guestWs: WebSocket;
    workspaceId: string;
    terminals: Map<string, Record<string, unknown>>;
    pendingDaemons: Set<string>;
    timer: ReturnType<typeof setTimeout>;
  }
  const terminalListAggregations = new Map<string, TerminalListAggregation>();

  function finalizeTerminalList(requestId: string): void {
    const agg = terminalListAggregations.get(requestId);
    if (!agg) return;
    terminalListAggregations.delete(requestId);
    clearTimeout(agg.timer);
    sendPaseoResponse(agg.guestWs, "cyborg:list_terminals_response", {
      requestId,
      workspaceId: agg.workspaceId,
      terminals: finalizeTerminalDirectory(agg.terminals),
    });
  }

  // ─── Cybo mutation PG mirror ─────────────────────────────────
  // create/update/delete_cybo are DAEMON_FORWARD ops: the daemon persists them
  // in ITS local SQLite only (solo-mode daemons have no PG), so the workspace-
  // level `cybos` table never heard about them. A cybo "saved in this workspace"
  // was invisible to spawn enrichment and to every other daemon — the root of
  // "Cybo not found" on cybos the user just created. Stash each forwarded
  // mutation by requestId; when the daemon's success response flows back through
  // onBroadcast, mirror it into PG under the SAME id the daemon generated.
  interface PendingCyboMutation {
    type: string;
    workspaceId: string;
    userId: string;
    inner: Record<string, unknown>;
    timer: ReturnType<typeof setTimeout>;
  }
  const pendingCyboMutations = new Map<string, PendingCyboMutation>();

  function stashCyboMutation(
    type: string,
    workspaceId: string,
    userId: string,
    inner: Record<string, unknown>,
  ): void {
    const requestId = inner.requestId as string | undefined;
    if (!requestId) return;
    const existing = pendingCyboMutations.get(requestId);
    if (existing) clearTimeout(existing.timer);
    pendingCyboMutations.set(requestId, {
      type,
      workspaceId,
      userId,
      inner: { ...inner },
      // A daemon that never answers must not leak the stash forever.
      timer: setTimeout(() => pendingCyboMutations.delete(requestId), 60_000),
    });
  }

  // ─── Single-cybo fetch PG fallback ─────────────────────
  // `cyborg:fetch_cybo` (the editor's lazy soul-load) is a DAEMON_FORWARD with
  // NO PG fallback: the answering daemon resolves by id/slug against ITS local
  // SQLite + disk cybos, so a cloud (PG-only) workspace cybo NOT present on that
  // daemon comes back `cybo: null` → "The daemon answered but didn't return this
  // cybo", and the editor locks saving. Stash the requested {workspaceId, cyboId}
  // by requestId; when the daemon's `fetch_cybo_response` flows back null, enrich
  // it from PG (tolerant id resolution, same as the mutation handlers) so the
  // soul still loads. Mirrors the fetch_cybos roster PG-merge.
  interface PendingCyboFetch {
    workspaceId: string;
    cyboId: string;
    timer: ReturnType<typeof setTimeout>;
  }
  const pendingCyboFetches = new Map<string, PendingCyboFetch>();

  function stashCyboFetch(workspaceId: string, inner: Record<string, unknown>): void {
    const requestId = inner.requestId as string | undefined;
    const cyboId = inner.cyboId as string | undefined;
    if (!requestId || !cyboId) return;
    const existing = pendingCyboFetches.get(requestId);
    if (existing) clearTimeout(existing.timer);
    pendingCyboFetches.set(requestId, {
      workspaceId,
      cyboId,
      // A daemon that never answers must not leak the stash forever.
      timer: setTimeout(() => pendingCyboFetches.delete(requestId), 60_000),
    });
  }

  async function mirrorCyboMutationToPg(
    pending: PendingCyboMutation,
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!pg) return;
    const inner = pending.inner;
    if (pending.type === "cyborg:create_cybo") {
      const cybo = payload?.cybo as Record<string, unknown> | undefined;
      const id = cybo?.id as string | undefined;
      if (!id) return;
      // Idempotent: a replayed/duplicate response must not throw on the PK.
      const existing = await pg.getCybos(pending.workspaceId);
      if (existing.some((c) => c.id === id)) return;
      await pg.createCybo({
        id,
        workspaceId: pending.workspaceId,
        slug: (inner.slug as string) ?? "",
        name: (inner.name as string) ?? "",
        soul: (inner.soul as string) ?? "",
        provider: (inner.provider as string) ?? "",
        createdBy: pending.userId,
        description: (inner.description as string | undefined) ?? null,
        avatar: (inner.avatar as string | undefined) ?? null,
        role: (inner.role as string | undefined) ?? null,
        model: (inner.model as string | undefined) ?? null,
        mcpServers: (inner.mcpServers as Record<string, unknown> | null | undefined) ?? null,
        toolGrants: (inner.toolGrants as Record<string, unknown> | null | undefined) ?? null,
        llmAuthMode: inner.llmAuthMode as string | undefined,
        behaviorMode: inner.behaviorMode as string | undefined,
        homeDaemonId: (inner.homeDaemonId as string | null | undefined) ?? null,
        autonomyLevel: inner.autonomyLevel as string | undefined,
        monthlySpendCap: (inner.monthlySpendCap as number | null | undefined) ?? null,
        platformPermissions: inner.platformPermissions as string[] | undefined,
      });
      relayLog.info(
        { cyboId: id, slug: inner.slug as string, workspaceId: pending.workspaceId },
        "cybo-pg-mirror created",
      );
    } else if (pending.type === "cyborg:update_cybo") {
      const id = inner.cyboId as string | undefined;
      if (!id) return;
      const { type: _t, requestId: _r, workspaceId: _w, cyboId: _c, ...updates } = inner;
      await pg.updateCybo(id, updates as Parameters<typeof pg.updateCybo>[1]);
      relayLog.info({ cyboId: id, workspaceId: pending.workspaceId }, "cybo-pg-mirror updated");
    } else if (pending.type === "cyborg:delete_cybo") {
      const id = inner.cyboId as string | undefined;
      if (!id) return;
      await pg.deleteCybo(id);
      relayLog.info({ cyboId: id, workspaceId: pending.workspaceId }, "cybo-pg-mirror deleted");
    }
  }

  function mapChannel(c: {
    id: string;
    workspace_id: string;
    name: string;
    description: string | null;
    is_private: number;
    instructions: string | null;
    slash_command_model?: string | null;
    created_by: string;
    created_at: number;
    is_archived?: number;
    type?: string;
    is_hidden?: number;
    auto_tasks_enabled?: number | null;
  }) {
    return {
      id: c.id,
      workspaceId: c.workspace_id,
      name: c.name,
      description: c.description,
      isPrivate: !!c.is_private,
      instructions: c.instructions,
      // Per-channel AI-command model override, parsed for the client (null = inherit).
      slashCommandModel: parseSlashModel(c.slash_command_model),
      createdBy: c.created_by,
      createdAt: c.created_at,
      // P2 #3: archived (soft-deleted) flag. Older payloads omit is_archived →
      // false, so clients on stale relays just never see a channel as archived.
      isArchived: !!c.is_archived,
      // #608: channel kind + browser visibility. The client groups type ===
      // 'group_dm' under the DM section; older payloads omit them → a regular,
      // visible channel.
      type: c.type ?? "regular",
      isHidden: !!c.is_hidden,
      // Tasks Phase 2 — per-channel auto-tasks (channel watcher) opt-in switch.
      // OPT-IN: NULL/0 => OFF, only explicit 1 => ON (matches schema.ts contract).
      autoTasksEnabled: c.auto_tasks_enabled === 1,
    };
  }

  // ─── Media delivery: CloudFront signing (M8) + on-demand thumbnails (M7) ──
  // Originals are served via signed CloudFront URLs when configured (CDN edge
  // + signed-URL cache locality); sized WebP thumbnails come from the relay's
  // /api/assets/thumb endpoint. Both fall back gracefully: no CloudFront env →
  // keep the S3 publicUrl; no RELAY_PUBLIC_URL → no thumbnails (renderer uses
  // the original). Ported from cyborg7-core lib/media/cloudfront.ts.
  const cfDomain = process.env.CLOUDFRONT_DOMAIN;
  const cfKeyPairId = process.env.CLOUDFRONT_KEY_PAIR_ID;
  const cfPrivateKey = process.env.CLOUDFRONT_SIGNING_KEY?.replace(/\\n/g, "\n");
  const cloudFrontEnabled = !!(cfDomain && cfKeyPairId && cfPrivateKey);
  const relayPublicUrl = (process.env.RELAY_PUBLIC_URL ?? "").replace(/\/$/, "");

  function nextHourBoundaryIso(): string {
    const ttlMs = 4 * 60 * 60 * 1000;
    const hourMs = 60 * 60 * 1000;
    return new Date(Math.ceil((Date.now() + ttlMs) / hourMs) * hourMs).toISOString();
  }

  function signCloudFrontUrl(key: string): string | null {
    if (!cloudFrontEnabled || !cfDomain || !cfKeyPairId || !cfPrivateKey) return null;
    const encodedPath = key
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    try {
      return signCloudFront({
        url: `https://${cfDomain}/${encodedPath}`,
        keyPairId: cfKeyPairId,
        privateKey: cfPrivateKey,
        dateLessThan: nextHourBoundaryIso(),
      });
    } catch (err) {
      relayLog.error({ err }, "media cloudfront sign failed");
      return null;
    }
  }

  function thumbUrl(key: string, w: number): string | undefined {
    if (!relayPublicUrl) return undefined;
    return `${relayPublicUrl}/api/assets/thumb?key=${encodeURIComponent(key)}&w=${w}`;
  }

  // Rewrite a message's attachments for delivery. Image originals → signed
  // CloudFront; images also get sized thumbnail variant URLs. Non-S3 (inline /
  // data-URL dev) attachments are left untouched.
  //
  // Be liberal about the input shape: persisted attachments have historically
  // been double-JSON-encoded (the column can hold a stringified array, or an
  // array whose elements are stringified). Normalize to a flat array of
  // objects before signing so a real image always gets signed + thumbnailed.
  function normalizeAttachments(raw: unknown): unknown {
    let a = raw;
    if (typeof a === "string") {
      try {
        a = JSON.parse(a);
      } catch {
        return raw;
      }
    }
    if (!Array.isArray(a)) return a;
    return a.flatMap((el) => {
      if (typeof el !== "string") return [el];
      try {
        const parsed = JSON.parse(el);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [el];
      }
    });
  }

  function signAttachments(attachmentsRaw: unknown): unknown {
    const attachments = normalizeAttachments(attachmentsRaw);
    if (!Array.isArray(attachments)) return attachments;
    const result: unknown[] = [];
    for (const a of attachments) {
      if (!a || typeof a !== "object") {
        result.push(a);
        continue;
      }
      const att = a as { key?: string; type?: string; url?: string; [k: string]: unknown };
      if (!att.key || att.key.startsWith("inline-")) {
        result.push(att);
        continue;
      }
      const out: typeof att = Object.assign({}, att);
      const signed = signCloudFrontUrl(att.key);
      if (signed) out.url = signed;
      if (typeof att.type === "string" && att.type.startsWith("image/")) {
        const t = {
          w360: thumbUrl(att.key, 360),
          w720: thumbUrl(att.key, 720),
          w1080: thumbUrl(att.key, 1080),
        };
        if (t.w360 || t.w720 || t.w1080) out.thumbnails = t;
      }
      result.push(out);
    }
    return result;
  }

  // Shared-files delivery: flatten each {messageId, createdAt, senderName,
  // attachments[]} row into one entry per attachment, signing URLs +
  // thumbnails exactly like message delivery. `requested` is the page size the
  // client asked for; we over-fetched by 5 rows so a multi-attachment message
  // at the boundary isn't split — emit every file of every row up to and
  // including the row that crosses `requested`, then set the cursor to that
  // last row's messageId. hasMore reflects whether the DB had more rows beyond
  // what we emitted.
  function flattenFileRows(
    rows: Array<{
      messageId: string;
      createdAt: number;
      senderName: string;
      attachments: unknown;
    }>,
    requested: number,
  ): { files: unknown[]; hasMore: boolean; nextCursor: string | null } {
    const files: unknown[] = [];
    let emittedRows = 0;
    let consumedRows = 0;
    let lastEmittedId: string | null = null;
    for (const row of rows) {
      // Stop once we've emitted at least `requested` rows — but never split a
      // single message's attachments across pages (we always finish the row we
      // started, which is naturally satisfied by emitting whole rows).
      if (emittedRows >= requested) break;
      consumedRows += 1;
      const signed = signAttachments(row.attachments);
      const list = Array.isArray(signed) ? signed : [];
      if (list.length === 0) continue;
      for (const att of list) {
        if (!att || typeof att !== "object") continue;
        files.push({
          messageId: row.messageId,
          createdAt: row.createdAt,
          senderName: row.senderName,
          attachment: att,
        });
      }
      emittedRows += 1;
      lastEmittedId = row.messageId;
    }
    // More data exists if we broke early leaving unconsumed rows, OR the DB
    // returned a full over-fetched page (so there may be more beyond it).
    // (Comparing rows.length to emittedRows was wrong: rows skipped for having
    // no valid attachments left emittedRows < rows.length at the true end of
    // data, falsely reporting hasMore.)
    const hasMore = consumedRows < rows.length || rows.length >= requested + 5;
    return { files, hasMore, nextCursor: hasMore ? lastEmittedId : null };
  }

  function mapMessage(m: {
    id: string;
    channel_id: string | null;
    from_id: string;
    from_type: string;
    from_name: string | null;
    to_id: string | null;
    text: string;
    mentions: string | null;
    parent_id: string | null;
    attachments?: string | null;
    reactions?: { userId: string; userName?: string; emoji: string; createdAt: number }[] | null;
    unfurls?: unknown;
    card?: unknown;
    pinned_at?: number | null;
    pinned_by?: string | null;
    source?: string | null;
    seq: number;
    created_at: number;
    updated_at?: number | null;
  }) {
    return {
      id: m.id,
      channelId: m.channel_id,
      fromId: m.from_id,
      fromType: m.from_type,
      fromName: m.from_name,
      toId: m.to_id,
      text: m.text,
      mentions: m.mentions
        ? typeof m.mentions === "string"
          ? JSON.parse(m.mentions)
          : m.mentions
        : null,
      parentId: m.parent_id,
      attachments: m.attachments
        ? signAttachments(
            typeof m.attachments === "string" ? JSON.parse(m.attachments) : m.attachments,
          )
        : null,
      reactions: m.reactions ?? null,
      unfurls: m.unfurls
        ? typeof m.unfurls === "string"
          ? JSON.parse(m.unfurls)
          : m.unfurls
        : null,
      card: m.card ? (typeof m.card === "string" ? JSON.parse(m.card) : m.card) : null,
      pinnedAt: m.pinned_at ?? null,
      pinnedBy: m.pinned_by ?? null,
      source: m.source ?? null,
      seq: m.seq,
      createdAt: m.created_at,
      updatedAt: m.updated_at ?? null,
    };
  }

  function mapTask(
    t: {
      id: string;
      workspace_id: string;
      title: string;
      description: string | null;
      status: string;
      assignee_id: string | null;
      created_by: string;
      due_at: number | null;
      result: string | null;
      channel_id?: string | null;
      priority?: string | null;
      sort_order?: number | null;
      start_date?: number | null;
      archived_at?: number | null;
      is_draft?: number;
      // Tasks Redesign — Plane-style denormalized projection (StoredTask carries
      // these; pg-sync's mapTaskRowsWithSatellites hydrates label_ids/module_ids).
      project_id?: string | null;
      parent_id?: string | null;
      state_id?: string | null;
      sequence_id?: number | null;
      cycle_id?: string | null;
      label_ids?: string[];
      module_ids?: string[];
      created_at: number;
      updated_at: number;
    },
    // Per-task scheduling — the minimal READ-ONLY summary of the schedule bound to
    // this task (its cron/timezone/enabled/nextRunAt), denormalized onto the wire
    // Task so the board/detail can render a cadence chip without a second round-trip.
    // null (or omitted) when no schedule is bound. A task with multiple bound
    // schedules surfaces the soonest-firing one (see scheduleSummaryForTask).
    schedule?: {
      cronExpr: string;
      timezone: string | null;
      enabled: boolean;
      nextRunAt: number | null;
    } | null,
  ) {
    return {
      id: t.id,
      workspaceId: t.workspace_id,
      title: t.title,
      description: t.description,
      status: t.status,
      assigneeId: t.assignee_id,
      createdBy: t.created_by,
      dueAt: t.due_at,
      result: t.result ?? null,
      channelId: t.channel_id ?? null,
      priority: t.priority ?? null,
      // Per-task scheduling — read-only cadence summary (null when no schedule
      // is bound to this task).
      schedule: schedule ?? null,
      // Phase 0 — lane ordering, planned start, soft-archive, draft.
      sortOrder: t.sort_order ?? null,
      startDate: t.start_date ?? null,
      archivedAt: t.archived_at ?? null,
      isDraft: (t.is_draft ?? 0) === 1,
      // Tasks Redesign readback — snake_case to match the broadcast/response
      // contract (CyborgTasksChanged / create_task_response). Optional so an old
      // row (no Plane columns) maps to null/[].
      project_id: t.project_id ?? null,
      parent_id: t.parent_id ?? null,
      state_id: t.state_id ?? null,
      sequence_id: t.sequence_id ?? null,
      cycle_id: t.cycle_id ?? null,
      label_ids: t.label_ids ?? [],
      module_ids: t.module_ids ?? [],
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  }

  // Per-task scheduling — collapse a task's bound schedule(s) into the single
  // minimal READ-ONLY summary `mapTask` denormalizes onto the wire Task. When a
  // task has more than one bound schedule, surface the soonest-firing ENABLED one
  // (an enabled schedule with the smallest nextRunAt); fall back to the first row
  // when none is enabled. null when no schedule is bound.
  function scheduleSummaryForTask(schedules: StoredSchedule[] | undefined): {
    cronExpr: string;
    timezone: string | null;
    enabled: boolean;
    nextRunAt: number | null;
  } | null {
    if (!schedules || schedules.length === 0) return null;
    let chosen: StoredSchedule | null = null;
    for (const s of schedules) {
      if (chosen === null) {
        chosen = s;
        continue;
      }
      const sEnabled = s.enabled === 1;
      const chosenEnabled = chosen.enabled === 1;
      // Prefer an enabled schedule; among same-enabled, prefer the smaller (sooner)
      // nextRunAt (a null nextRunAt sorts last — a paused/finished schedule).
      if (sEnabled && !chosenEnabled) {
        chosen = s;
      } else if (sEnabled === chosenEnabled) {
        const sNext = s.next_run_at ?? Number.POSITIVE_INFINITY;
        const chosenNext = chosen.next_run_at ?? Number.POSITIVE_INFINITY;
        if (sNext < chosenNext) chosen = s;
      }
    }
    if (chosen === null) return null;
    return {
      cronExpr: chosen.cron_expr,
      timezone: chosen.timezone,
      enabled: chosen.enabled === 1,
      nextRunAt: chosen.next_run_at,
    };
  }

  // ─── License pool view (per-workspace seat model, spec §4.3) ─────
  // The shared read-side of cyborg:fetch_license_pool / allocate / deallocate:
  // the caller's seat ENTITLEMENT (the ios pool — the only rail that uses pools;
  // Stripe stays per-workspace, see spec §2.4), the workspaces that currently
  // SPEND a seat, and the workspaces the caller OWNS (enriched with each one's
  // license state + trialEndsAt so the panel can show "Trial/Paused" per row
  // without a per-workspace fetch_license round-trip). The `pool` shape mirrors
  // the ws-client `LicensePoolPayload`; `null` when the caller has no pool.
  async function buildPoolView(client: PgSync, userId: string) {
    const poolRow = await client.getPoolByOwnerRail(userId, "ios");
    const allocations = (await client.getAllocationsForUserWorkspaces(userId)).map((a) => ({
      workspaceId: a.workspaceId,
    }));
    // Workspaces the caller OWNS — the only ones a seat can be allocated to.
    const owned = (await client.getWorkspacesForUser(userId)).filter(
      (w) => w.owner_id === userId || w.role === "owner",
    );
    const ownedWorkspaces = await Promise.all(
      owned.map(async (w) => {
        const lic = await client.getLicenseStatus(w.id);
        return {
          id: w.id,
          name: w.name,
          state: lic.state,
          trialEndsAt: lic.trialEndsAt,
        };
      }),
    );
    const pool = poolRow
      ? {
          seatCount: poolRow.seatCount,
          status: poolRow.status,
          currentPeriodEnd: poolRow.currentPeriodEnd?.getTime() ?? null,
          rail: poolRow.rail as "ios" | "stripe",
          cancelAtPeriodEnd: poolRow.cancelAtPeriodEnd,
        }
      : null;
    return { pool, allocations, ownedWorkspaces };
  }

  function mapCybo(c: {
    id: string;
    workspace_id: string;
    slug: string;
    name: string;
    description: string | null;
    avatar: string | null;
    role: string | null;
    soul: string;
    provider: string;
    model: string | null;
    mcp_servers: string | null;
    is_default: number;
    created_by: string;
    created_at: number;
    updated_at: number;
  }) {
    return {
      id: c.id,
      workspaceId: c.workspace_id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      avatar: c.avatar,
      role: c.role,
      soul: c.soul,
      provider: c.provider,
      model: c.model,
      mcpServers: c.mcp_servers
        ? typeof c.mcp_servers === "string"
          ? JSON.parse(c.mcp_servers)
          : c.mcp_servers
        : null,
      isDefault: !!c.is_default,
      createdBy: c.created_by,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    };
  }

  async function handlePaseoRpc(
    ws: WebSocket,
    guest: GuestConnection,
    inner: Record<string, unknown>,
  ): Promise<void> {
    const type = inner.type as string;
    const requestId = inner.requestId as string | undefined;

    function respond(rt: string, data: Record<string, unknown>) {
      sendPaseoResponse(ws, rt, { ...data, requestId });
    }
    function respondError(message: string) {
      sendPaseoResponse(ws, "cyborg:error", { message, requestId });
    }

    // Presence auto-heal (Part A): a lightweight liveness ping. Answered BEFORE
    // the `if (!pg)` guard and BEFORE the workspace-membership gate below — it's
    // a pure round-trip on this authenticated socket that proves liveness, so it
    // must NOT depend on Postgres or on any workspace subscription. Purely
    // additive: old clients never send it; a new client sending it to an old
    // relay (which doesn't know it) gets a `cyborg:error` round-trip, which the
    // client treats as "alive" too.
    if (type === "cyborg:ping") {
      const pong = buildPingResponse(requestId);
      sendPaseoResponse(ws, pong.type, pong.payload);
      return;
    }

    // Mark this connection user-active for desktop-active push suppression. Stamped
    // AFTER the cyborg:ping early-return (the periodic liveness ping is automated,
    // not interaction) and after WS-level ping/pong (which never reaches here), so
    // only real client/user app messages (auth, app_state, send, typing, reads,
    // navigation, …) count. Used ONLY by dispatchPush — never by presence/away.
    guest.lastActivityAt = Date.now();

    if (!pg) {
      respondError("database unavailable");
      return;
    }

    // Idempotent re-auth: a client may send cyborg:auth again on an already-
    // authenticated socket (e.g. login racing the reconnect handler, which both
    // call authenticate()). Re-validate and return the auth_response instead of
    // falling through to the switch default ("unsupported: cyborg:auth"), which
    // was breaking login.
    if (type === "cyborg:auth") {
      const token = (inner.token as string) ?? guest.token;
      const decoded = validateUserToken(token);
      const user = decoded ? await pg.getUserByEmail(decoded.email) : null;
      if (!user) {
        respondError("unauthorized");
        return;
      }
      // Re-auth must re-check moderation status (same gate as the initial WS auth
      // and the REST path): a user suspended/soft-deleted mid-session that races
      // a reconnect's re-auth must be rejected, not silently re-admitted.
      const status = await pg.getAccountStatus(user.id);
      if (status?.suspendedAt || status?.deletedAt) {
        respondError("unauthorized");
        return;
      }
      const wss = await pg.getWorkspacesForUser(user.id);
      respond("cyborg:auth_response", {
        user: { id: user.id, email: user.email, name: user.name, imageUrl: user.imageUrl ?? null },
        workspaces: wss.map((w) => ({
          id: w.id,
          name: w.name,
          avatarUrl: w.avatar_url ?? null,
          role: w.role,
        })),
      });
      return;
    }

    // Subscribe this socket to a workspace's live broadcasts. Validated against
    // the DB (not guest.workspaceIds) so a workspace joined mid-session — e.g.
    // after accepting an invite — starts receiving events without a reload.
    if (type === "cyborg:subscribe_workspace") {
      const subWs = inner.workspaceId as string | undefined;
      if (!subWs) {
        respondError("workspaceId required");
        return;
      }
      // Superadmin moderation: a DISABLED workspace can't be (re)subscribed to,
      // even by a real member — block before the membership check so a disabled
      // org can't be reopened from an already-open session.
      if (await pg.isWorkspaceDisabled(subWs)) {
        respondError("This workspace has been disabled by an administrator.");
        return;
      }
      if (await pg.isMember(subWs, guest.userId)) {
        guest.workspaceIds.add(subWs);
        if (!guestSubs.has(subWs)) guestSubs.set(subWs, new Set());
        guestSubs.get(subWs)!.add(ws);
        respond("cyborg:subscribe_workspace_response", { ok: true });
        // A user joining/selecting a workspace mid-session changes who its
        // online members are — refresh presence for that workspace so the
        // joiner and existing members see each other without waiting for an
        // unrelated connect/disconnect.
        broadcastPresence([subWs]);
      } else {
        respondError("not a member of this workspace");
      }
      return;
    }

    const workspaceId = inner.workspaceId as string | undefined;
    if (workspaceId && !guest.workspaceIds.has(workspaceId)) {
      respondError("not a member of this workspace");
      return;
    }

    // Context for extracted domain handlers (see ./handlers/*). Same pg/respond
    // closures the inline cases use — behaviour is identical.
    const guestCtx: GuestHandlerCtx = {
      pg,
      userId: guest.userId,
      workspaceId,
      respond,
      respondError,
    };

    if (DAEMON_FORWARD_TYPES.has(type)) {
      const targetWorkspace = workspaceId ?? Array.from(guest.workspaceIds)[0];
      if (!targetWorkspace) {
        respondError("no workspace available");
        return;
      }
      // Slash commands run on a WORKSPACE-designated daemon (admin-controlled,
      // #opt-A): the workspace default, else its ordered fallbacks, whichever is
      // online. The admin's designation IS the authorization, so members don't
      // need per-user access to it (the spawn gate below skips that for this case).
      // Falls back to "exactly one online workspace daemon" when nothing is
      // configured, and a clear systemAlert when nothing is runnable.
      let slashDaemonFromWorkspaceConfig = false;
      if (type === "cyborg:slash_command" && !inner.daemonId) {
        const onlineIds = new Set(relay.getConnectedDaemons());
        const wsDaemonIds = new Set(
          (await pg.getDaemonsForWorkspace(targetWorkspace)).map((d) => d.id),
        );
        let cfg = { defaultSlashDaemonId: null as string | null, fallbackDaemons: [] as string[] };
        try {
          const c = await pg.getWorkspaceSlashConfig(targetWorkspace);
          cfg = {
            defaultSlashDaemonId: c.defaultSlashDaemonId,
            fallbackDaemons: c.fallbackDaemons,
          };
        } catch (err) {
          relayLog.error({ err }, "slash_command getWorkspaceSlashConfig failed (degrading)");
        }
        // Default first, then fallbacks in order; only accept workspace daemons.
        const ordered = [cfg.defaultSlashDaemonId, ...cfg.fallbackDaemons].filter(
          (d): d is string => !!d && wsDaemonIds.has(d),
        );
        let chosen = ordered.find((d) => onlineIds.has(d));
        const configured = ordered.length > 0;
        if (!chosen && !configured) {
          // Unconfigured workspace: if exactly one workspace daemon is online, use it.
          const onlineWs = [...wsDaemonIds].filter((d) => onlineIds.has(d));
          if (onlineWs.length === 1) chosen = onlineWs[0];
        }
        if (!chosen) {
          respond("cyborg:slash_command_response", {
            ok: false,
            trigger: (inner.trigger as string | undefined) ?? null,
            dispatched: [],
            channelId: (inner.channelId as string | undefined) ?? null,
            // Structured discriminator so the UI can attach a contextual CTA
            // ("Configure AI" → Settings → AI) for the unconfigured case, and
            // tell it apart from a generic slash failure or the offline case.
            alertType: configured ? "slash_daemons_offline" : "no_daemon_configured",
            systemAlert: configured
              ? "The workspace's AI daemon is offline (and all configured fallbacks). Bring a configured daemon online, or ask a workspace admin to update the slash settings."
              : "No AI daemon is configured for this workspace's slash commands. A workspace admin can set one in the workspace settings.",
          });
          return;
        }
        inner.daemonId = chosen;
        slashDaemonFromWorkspaceConfig = true;
        relayLog.info(
          {
            workspaceId: targetWorkspace,
            daemonId: chosen,
            source: configured ? "configured" : "sole-online",
          },
          "slash_command workspace daemon resolved",
        );
      }
      // Slash commands target a daemon that may be SOLO (no PG) and thus blind to
      // cloud-only channels (which live only in PG). Resolve the channel + recent
      // transcript HERE (the relay has PG) and embed them in the forward so the
      // daemon never has to look them up — this is the root fix for the long-
      // standing "channel not found" / "no recent messages" on cloud group slash
      // commands. A missing channel fails fast with a descriptive error.
      if (type === "cyborg:slash_command") {
        const slashChannelId = inner.channelId as string | undefined;
        if (!slashChannelId) {
          respondError("Slash command is missing a channel — reopen the channel and try again.");
          return;
        }
        const slashChannel = await pg.getChannel(slashChannelId);
        if (!slashChannel || slashChannel.workspace_id !== targetWorkspace) {
          const wsName = (await pg.getWorkspaceById(targetWorkspace))?.name ?? targetWorkspace;
          relayLog.error(
            {
              channelId: slashChannelId,
              workspaceId: targetWorkspace,
              caller: guest.userId,
              trigger: inner.trigger as string,
            },
            "slash_command channel not found in workspace",
          );
          respondError(
            `Channel not found: "${slashChannelId}" is not in workspace "${wsName}". It may have been deleted or moved — reopen the channel and try again.`,
          );
          return;
        }
        // Private-channel membership gate (#242). The slash path reads the channel
        // transcript and forwards up to 200 messages to the caller's OWN daemon, so
        // a workspace member who is NOT in a private channel must not be able to
        // summarize/act in it. Mirrors the fetch_messages / fetch_channel_members
        // checks; non-private channels are readable by any workspace member.
        if (
          slashChannel.is_private &&
          !(await pg.getChannelMemberRole(slashChannelId, guest.userId))
        ) {
          relayLog.error(
            { caller: guest.userId, channelId: slashChannelId, trigger: inner.trigger as string },
            "slash_command caller not a member of private channel",
          );
          respondError("You're not a member of this private channel.");
          return;
        }
        inner.resolvedChannel = {
          id: slashChannel.id,
          workspace_id: slashChannel.workspace_id,
          name: slashChannel.name,
          // Forward the per-channel override so the PG-blind daemon honors it
          // (channel > workspace > auto). slashChannel comes from pg.getChannel,
          // so it already carries slash_command_model.
          slash_command_model: slashChannel.slash_command_model ?? null,
          // Forward the channel's agent guidelines (channels.instructions) so
          // slash-command prompts honor the owner's format/limit rules. Capped
          // so an oversized blob can't inflate the forwarded frame — the prompt
          // builder caps again defensively (CHANNEL_GUIDELINES_MAX_CHARS).
          instructions: slashChannel.instructions ? slashChannel.instructions.slice(0, 4000) : null,
        };
        // Forward the workspace's configured slash model so the (PG-blind solo)
        // daemon honors it instead of auto-resolving to a default (Haiku). The
        // daemon can't read workspaces.slash_command_model in cloud mode.
        try {
          const wsSlashCfg = await pg.getWorkspaceSlashConfig(targetWorkspace);
          if (wsSlashCfg.model) inner.workspaceSlashModel = wsSlashCfg.model;
        } catch (err) {
          relayLog.error({ err }, "slash_command workspace model fetch failed (degrading)");
        }
        if (inner.trigger === "catchup") {
          // /catchup digests the caller's UNREAD slice, not a recent-N window.
          // The relay has PG, so resolve the caller's last_read_at + the
          // since-slice here and embed both; the (PG-blind) daemon can read
          // neither. Cap at 500 (matches catchupCommand.maxContextMessages).
          const sinceMs = await pg.getChannelLastRead(guest.userId, slashChannelId);
          inner.catchupSince = sinceMs;
          inner.resolvedMessages = await pg.getChannelMessagesSince(
            slashChannelId,
            sinceMs ?? 0,
            500,
          );
          relayLog.info(
            {
              channelName: slashChannel.name,
              channelId: slashChannelId,
              daemonId: inner.daemonId as string,
              unread: (inner.resolvedMessages as unknown[]).length,
              since: sinceMs ?? null,
            },
            "slash_command forwarding /catchup",
          );
        } else {
          // Embed a generous recent slice (oldest-first); the daemon slices to the
          // command's own count. Capped so the forwarded frame stays small.
          inner.resolvedMessages = await pg.getMessages({ channelId: slashChannelId, limit: 200 });
          relayLog.info(
            {
              trigger: inner.trigger as string,
              channelName: slashChannel.name,
              channelId: slashChannelId,
              daemonId: inner.daemonId as string,
              messages: (inner.resolvedMessages as unknown[]).length,
            },
            "slash_command forwarding",
          );
        }
      }
      // spawn_cybo: the cybo lives in cloud PG (workspace-level) but the TARGET
      // daemon resolves it from its LOCAL SQLite, which may not have it (created on
      // another machine / via the cloud) → "Cybo not found: <slug>". Resolve it from
      // PG here and embed it so any daemon can spawn any workspace cybo. getCybos →
      // mapCybo already returns the StoredCybo shape the daemon expects (mcp_servers
      // as a JSON string, etc.), so no extra normalization is needed.
      // create_schedule, like spawn_cybo, names a cybo by id/slug that the target
      // daemon may not have in its local SQLite (created on another machine / the
      // cloud). Resolve it from PG and embed it so any daemon can create the
      // schedule. update/delete/etc. address an existing schedule by id, which
      // already lives in the owning daemon's SQLite — no enrichment needed.
      if (type === "cyborg:spawn_cybo" || type === "cyborg:create_schedule") {
        const idOrSlug = inner.cyboIdOrSlug as string | undefined;
        if (!idOrSlug) {
          respondError("Missing cybo — reopen and try again.");
          return;
        }
        const cybos = await pg.getCybos(targetWorkspace);
        const cybo = cybos.find((c) => c.id === idOrSlug || c.slug === idOrSlug);
        if (cybo) {
          inner.resolvedCybo = cybo;
        } else {
          // Not a PG workspace cybo — but the roster also lists the daemon's LOCAL
          // (disk) cybos (`cybo link`, via fetch_cybos' DB+local merge), which the
          // daemon CAN spawn (cybo-manager bypasses the workspace check for local
          // cybos). So don't hard-fail here: forward UNENRICHED and let the target
          // daemon resolve it locally — it returns its own "Cybo not found" if it
          // genuinely lacks it. Diagnostic (server-side only, not shown to the user):
          // workspace + PG cybo count pinpoints PG-miss vs local-cybo spawns.
          relayLog.error(
            {
              cyboIdOrSlug: idOrSlug,
              workspaceId: targetWorkspace,
              pgCyboCount: cybos.length,
              caller: guest.userId,
            },
            "spawn_cybo not in workspace PG cybos; forwarding for local-cybo resolution",
          );
        }
      }
      // Cybo mutations must land in the workspace-level PG table, not just the
      // target daemon's local SQLite. Stash the request; the PG mirror happens
      // when the daemon's success response flows back (see onBroadcast).
      if (
        type === "cyborg:create_cybo" ||
        type === "cyborg:update_cybo" ||
        type === "cyborg:delete_cybo"
      ) {
        stashCyboMutation(type, targetWorkspace, guest.userId, inner);
      }
      // Stash single-cybo fetches so the response handler can fall back to PG
      // when the answering daemon doesn't have this (cloud-only) cybo locally.
      if (type === "cyborg:fetch_cybo") {
        stashCyboFetch(targetWorkspace, inner);
      }
      // `let` (not `const`): the spawn_cybo home-daemon routing below may PIN this
      // to the cybo's home daemon (when online + accessible) so the existing
      // scope/forward logic treats it as an explicit target.
      let targetDaemonId = inner.daemonId as string | undefined;
      // Forward the caller's REAL workspace role so the daemon doesn't have to
      // fabricate one (it can't see cloud memberships in its local SQLite).
      const callerRole = await pg.getMemberRole(targetWorkspace, guest.userId);
      if (!callerRole) {
        relayLog.error(
          { type, caller: guest.userId, workspaceId: targetWorkspace },
          "daemon_forward caller not a member of workspace",
        );
        respondError(
          "You're not a member of this workspace anymore — refresh the page and try again.",
        );
        return;
      }

      // Enforce daemon access for execution forwards — membership alone is NOT
      // enough to run code on a daemon. Each forwarded action requires a specific
      // SCOPE (#705): scopeForType maps the type → chat | spawn | terminal | admin,
      // and a caller is allowed iff they hold that scope OR `admin` (owner = all
      // scopes). The relay's DAEMON_*_TYPES sets still route the action to the
      // right gate branch (viewer/license overhead etc.); the scope is what's
      // checked. Note start_terminal lives in DAEMON_SPAWN_TYPES (so it keeps the
      // viewer/license gate) but scopeForType returns `terminal` for it — the
      // intentional reclassification: a spawn-only user can NOT open a host shell.
      const requiredScope = scopeForType(type);
      // Scope check against a specific daemon, factored so the SPAWN branch's
      // three resolution paths share one decision. Owner ⇒ all scopes (size>0 +
      // isScopeAllowed both pass). Empty set (no row, not owner) ⇒ denied.
      const scopeAllowedOn = async (daemonId: string): Promise<boolean> => {
        const scopes = await pg.getUserDaemonScopes(targetWorkspace, daemonId, guest.userId);
        if (scopes.size === 0) return false;
        return isScopeAllowed(scopes, requiredScope);
      };
      // Problem (4) — HOME-DAEMON authoritative spawn routing. A cybo's
      // home_daemon_id (the machine it "lives on", chosen at creation) was
      // persisted but inert: spawn_cybo always landed on the sponsor/selected
      // daemon. Honor it here: when the caller didn't pin an explicit daemon and
      // the cybo's home daemon is ONLINE + the caller can run on it, pin the
      // spawn there. Falls back GRACEFULLY (and tells the author why) when the
      // home daemon is offline/inaccessible — never a hard fail, never blocking
      // the existing multi-daemon resolution below. Only spawn_cybo carries a
      // resolvedCybo; create_schedule names a cybo too but a schedule's runner
      // must stay on its owning daemon, so it is deliberately excluded.
      if (type === "cyborg:spawn_cybo" && !targetDaemonId) {
        const resolvedCybo = inner.resolvedCybo as
          | { home_daemon_id?: string | null; slug?: string | null }
          | undefined;
        const pinned = await applyHomeDaemonRouting({
          homeDaemonId: resolvedCybo?.home_daemon_id ?? null,
          cyboSlug: resolvedCybo?.slug ?? null,
          getOnlineWorkspaceDaemonIds: async () => {
            const connectedNow = new Set(relay.getConnectedDaemons());
            return new Set(
              (await pg.getDaemonsForWorkspace(targetWorkspace))
                .filter((d) => connectedNow.has(d.id))
                .map((d) => d.id),
            );
          },
          isAccessible: (daemonId) => scopeAllowedOn(daemonId),
          onPinned: (daemonId) =>
            relayLog.info(
              { workspaceId: targetWorkspace, daemonId, cyboSlug: resolvedCybo?.slug },
              "spawn_cybo pinned to home daemon",
            ),
          onFallback: (reason, message) => {
            relayLog.warn(
              { workspaceId: targetWorkspace, reason, cyboSlug: resolvedCybo?.slug },
              "spawn_cybo home daemon unavailable — falling back to sponsor/effective daemon",
            );
            if (message) {
              broadcastToGuests(targetWorkspace, {
                type: "cyborg:cybo_mention_notice",
                payload: { toUserId: guest.userId, workspaceId: targetWorkspace, text: message },
              });
            }
          },
          onError: (err) =>
            relayLog.error(
              { err, workspaceId: targetWorkspace, cyboSlug: resolvedCybo?.slug },
              "spawn_cybo home-daemon routing probe failed — using sponsor/effective daemon",
            ),
        });
        if (pinned) {
          // Pin so the explicit-target scope branch + the forward both use it.
          targetDaemonId = pinned;
          inner.daemonId = pinned;
        }
      }
      // Local-import SCAN (#resume picker, "Local import" tab) — a read-only scan of
      // the daemon's on-disk provider transcripts (~/.claude/projects, …). It carries
      // NO agentId, so resolve the workspace daemon the SAME way the import that
      // follows it does (importProviderSession also sends no daemonId → the sole
      // online workspace daemon), so the picker and the import agree on which
      // machine's transcripts they work with. When NO daemon (or several, none
      // pinned) is online, answer a GRACEFUL EMPTY result — NOT `unsupported`, NOT a
      // raw error: the picker then renders "Local import needs a running local daemon
      // on this machine" instead of a failure (the empty shape is identical to a
      // daemon answering with zero importable sessions). With exactly one online
      // daemon, pin it and fall through to the forward; its
      // fetch_recent_provider_sessions_response routes back to the requesting guest
      // through the generic onBroadcast → broadcastToGuests path (single-daemon, like
      // import_session_response — no fan-out aggregation needed).
      if (type === "fetch_recent_provider_sessions_request") {
        let scanDaemonId = targetDaemonId;
        if (!scanDaemonId) {
          const connected = new Set(relay.getConnectedDaemons());
          const connectedWsDaemons = (await pg.getDaemonsForWorkspace(targetWorkspace)).filter(
            (d) => connected.has(d.id),
          );
          if (connectedWsDaemons.length !== 1) {
            respond("fetch_recent_provider_sessions_response", { entries: [] });
            return;
          }
          scanDaemonId = connectedWsDaemons[0].id;
        }
        inner.daemonId = scanDaemonId;
      }
      if (type === "cyborg:restore_session" || type === "cyborg:import_session") {
        // Session-resume (#705 ⇒ `spawn` scope) — restore_session AND
        // import_session both resume a session WITHOUT an `agentId`:
        // restore_session carries a `sessionId`, import_session carries
        // provider + providerHandleId + cwd. So the agentId-keyed
        // DAEMON_AGENT_CONTROL_TYPES gate below can't resolve a daemon for either
        // (it would reject every resume with "agentId required"). Each lives in a
        // daemon's LOCAL SQLite / on-disk transcript, so the request carries the
        // OWNING daemonId (stamped on the archived-session list; absent for a
        // freshly-scanned local transcript — there is exactly one online daemon
        // that holds it). Gate + route on THAT daemon with the SAME `spawn` scope
        // as a spawn — no weaker. When the caller didn't specify one, resolve the
        // sole online workspace daemon (and require an explicit daemonId when
        // several are up, mirroring the spawn branch's no-target rule).
        if (callerRole === "viewer") {
          respondError(
            type === "cyborg:import_session"
              ? "viewers cannot import sessions"
              : "viewers cannot restore sessions",
          );
          return;
        }
        let resumeDaemonId = targetDaemonId;
        if (!resumeDaemonId) {
          const connected = new Set(relay.getConnectedDaemons());
          const connectedWsDaemons = (await pg.getDaemonsForWorkspace(targetWorkspace)).filter(
            (d) => connected.has(d.id),
          );
          if (connectedWsDaemons.length === 0) {
            respondError("no daemon connected");
            return;
          }
          if (connectedWsDaemons.length > 1) {
            respondError("multiple daemons connected — specify daemonId");
            return;
          }
          resumeDaemonId = connectedWsDaemons[0].id;
        }
        if (!(await scopeAllowedOn(resumeDaemonId))) {
          respondError(`no ${requiredScope} access to this daemon`);
          return;
        }
        // Pin the resolved daemon so the forward below lands on the daemon that
        // actually holds the archived session / local transcript (not an arbitrary
        // subscriber).
        inner.daemonId = resumeDaemonId;
      } else if (DAEMON_SPAWN_TYPES.has(type)) {
        if (callerRole === "viewer") {
          respondError("viewers cannot run agents");
          return;
        }
        // HARD-PAUSE license gate (DECISION #2): once the 7-day trial ends with
        // no active subscription, BLOCK paid agent features (create + spawn).
        // Reads + human messaging stay open — only agent-run spawns are gated.
        // Only enforce when billing is configured — otherwise getLicenseStatus
        // would query the subscriptions table (may not exist) and pause every
        // workspace older than the trial window, locking everyone out.
        if (isStripeConfigured()) {
          const spawnLicense = await pg.getLicenseStatus(targetWorkspace);
          if (spawnLicense.state === "paused") {
            sendPaseoResponse(ws, "cyborg:error", {
              error: "license_required",
              message: "Trial ended — activate your license to bring agents back online.",
              license: spawnLicense,
              requestId,
            });
            return;
          }
        }
        if (slashDaemonFromWorkspaceConfig) {
          // The workspace admin designated this daemon for everyone's slash
          // commands; workspace membership (callerRole, checked above) is the
          // authorization — don't require per-user daemon access here. (Slash is
          // always `spawn`, never start_terminal, so no terminal-scope concern.)
        } else if (targetDaemonId) {
          if (!(await scopeAllowedOn(targetDaemonId))) {
            respondError(`no ${requiredScope} access to this daemon`);
            return;
          }
        } else {
          // No explicit target: the spawn forwards to a connected daemon the
          // caller doesn't get to choose, so any-access is NOT enough — it would
          // let a user with access to daemon A run code on daemon B. Require the
          // scope on the single connected daemon; if several, force a daemonId.
          const connected = new Set(relay.getConnectedDaemons());
          const connectedWsDaemons = (await pg.getDaemonsForWorkspace(targetWorkspace)).filter(
            (d) => connected.has(d.id),
          );
          if (connectedWsDaemons.length === 0) {
            respondError("no daemon connected");
            return;
          }
          if (connectedWsDaemons.length > 1) {
            respondError("multiple daemons connected — specify daemonId");
            return;
          }
          if (!(await scopeAllowedOn(connectedWsDaemons[0].id))) {
            respondError(`no ${requiredScope} access to this daemon`);
            return;
          }
        }
      } else if (DAEMON_AGENT_CONTROL_TYPES.has(type)) {
        // agentId is REQUIRED — a missing one previously skipped the access check
        // entirely (bypass). Agent-control (set model/mode/thinking, rewind,
        // archive, restore) requires the `spawn` scope — chat-only can talk to an
        // agent but not reconfigure it.
        const controlAgentId = inner.agentId as string | undefined;
        if (!controlAgentId) {
          respondError("agentId required");
          return;
        }
        const control = await checkAgentAccess(
          pg,
          targetWorkspace,
          guest.userId,
          controlAgentId,
          "spawn",
        );
        if (!control.allowed) {
          respondError(control.reason ?? "no access to this daemon");
          return;
        }
      } else if (DAEMON_TERMINAL_CONTROL_TYPES.has(type)) {
        // Terminal control targets a daemon-scoped session, so it carries an
        // explicit daemonId and requires the `terminal` scope (#705) on THAT
        // daemon. The daemon then owner-locks the terminal id (2nd gate).
        // Lightweight: one indexed scope check, no viewer/license overhead.
        //
        // EXCEPTION: the read-only directory PULL (`cyborg:list_terminals`) from
        // the sidebar deliberately OMITS daemonId. A workspace can have several
        // daemons and each only tracks ITS own sessions, so a terminal created via
        // the CLI (PR #838) lives on whichever daemon spawned it — there is no one
        // daemon to target. When daemonId is absent we fan it out below (like
        // list_agents / list_archived_sessions) and enforce the per-daemon
        // `terminal` scope there. The mutating control ops still demand an explicit
        // daemonId here (and are gated by the scope check below).
        const isDirectoryFanout = type === "cyborg:list_terminals" && !targetDaemonId;
        if (!targetDaemonId && !isDirectoryFanout) {
          respondError("daemonId required");
          return;
        }
        if (targetDaemonId && !(await scopeAllowedOn(targetDaemonId))) {
          respondError("no terminal access to this daemon");
          return;
        }
      } else if (DAEMON_HOST_CONTROL_TYPES.has(type)) {
        // Self-update restarts the daemon host — RCE-grade, so it requires the
        // `admin` scope (owner, or an explicit admin grant) on THAT daemon. The UI
        // always targets a specific daemon, so an explicit daemonId is required
        // (no arbitrary-daemon fallback for an op that reboots a machine).
        if (!targetDaemonId) {
          respondError("daemonId required");
          return;
        }
        if (!(await scopeAllowedOn(targetDaemonId))) {
          respondError("no admin access to this daemon");
          return;
        }
      }

      const relayRpc = {
        type: "cyborg:relay_rpc",
        token: guest.token,
        workspaceId: targetWorkspace,
        guestId: guest.userId,
        role: callerRole,
        inner,
      };

      // list_agents must aggregate across ALL daemons in the workspace (each only
      // knows its own agents) — fan out and merge per-daemon responses. Everything
      // else targets a single daemon (or the explicitly requested one).
      if (type === "cyborg:list_agents" && !targetDaemonId) {
        const listReqId = inner.requestId as string | undefined;
        const reached = relay.sendToAllDaemonsInWorkspace(targetWorkspace, relayRpc);
        if (reached.length === 0) {
          // No daemon online — answer from the durable PG mirror so the workspace's
          // sessions stay visible (offline, not-live) instead of erroring. On a PG
          // miss (solo relay / read failure) keep the original "start your daemon"
          // error so behaviour is unchanged where there's nothing to fall back on.
          if (
            listReqId &&
            (await sendOfflineAgentList(ws, listReqId, targetWorkspace, guest.email, guest.userId))
          ) {
            return;
          }
          respondError("no daemon connected — start your local daemon to use this feature");
          return;
        }
        if (listReqId) {
          const existing = agentListAggregations.get(listReqId);
          if (existing) clearTimeout(existing.timer);
          agentListAggregations.set(listReqId, {
            guestWs: ws,
            workspaceId: targetWorkspace,
            guestEmail: guest.email,
            guestUserId: guest.userId,
            // A cyboId-scoped request narrows the daemon's answer to that cybo's
            // agents only → not the complete live set → GC must skip it.
            filtered: inner.cyboId != null,
            agents: new Map(),
            pendingDaemons: new Set(reached),
            // Fallback flush so a slow/dead daemon can't hang the request forever.
            timer: setTimeout(() => void finalizeAgentList(listReqId), 4000),
          });
        }
        return;
      }

      // Archived sessions live in each daemon's local SQLite — fan out and merge,
      // same as list_agents above (a single arbitrary daemon answers with ITS
      // archive only, hiding everyone else's sessions).
      if (type === "cyborg:list_archived_sessions" && !targetDaemonId) {
        const archReqId = inner.requestId as string | undefined;
        const reached = relay.sendToAllDaemonsInWorkspace(targetWorkspace, relayRpc);
        if (reached.length === 0) {
          respondError("no daemon connected — start your local daemon to use this feature");
          return;
        }
        if (archReqId) {
          const existing = archivedListAggregations.get(archReqId);
          if (existing) clearTimeout(existing.timer);
          archivedListAggregations.set(archReqId, {
            guestWs: ws,
            workspaceId: targetWorkspace,
            sessions: new Map(),
            pendingDaemons: new Set(reached),
            timer: setTimeout(() => void finalizeArchivedList(archReqId), 4000),
            limit:
              typeof inner.limit === "number" && Number.isFinite(inner.limit)
                ? inner.limit
                : undefined,
            daemonHasMore: false,
          });
        }
        return;
      }

      // The terminal directory lives in each daemon's OWN controller — a CLI-
      // created terminal (PR #838) is only known to the daemon that spawned it.
      // The sidebar pulls the directory with NO daemonId, so a single-daemon
      // forward would hit an arbitrary subscriber and miss every other daemon's
      // sessions (the original bug: the relay rejected it outright as "daemonId
      // required", so the Terminals section never appeared). Fan out, merge by
      // terminalId, and reply once — exactly like list_agents / list_archived
      // above. Per-daemon `terminal` scope is enforced here (the only daemons we
      // fan to are those the caller can list terminals on); the daemon owner-scopes
      // the rows it returns. Zero reachable daemons ⇒ an EMPTY directory (not an
      // error): the sidebar simply renders no Terminals section.
      if (type === "cyborg:list_terminals" && !targetDaemonId) {
        const termReqId = inner.requestId as string | undefined;
        const connected = new Set(relay.getConnectedDaemons());
        const wsDaemons = (await pg.getDaemonsForWorkspace(targetWorkspace)).filter((d) =>
          connected.has(d.id),
        );
        // Only fan out to daemons the caller actually holds `terminal` scope on
        // (owner ⇒ all daemons). A daemon the caller can't list terminals on is
        // silently skipped, never reached — same gate as the single-daemon path.
        const allowedDaemonIds: string[] = [];
        for (const d of wsDaemons) {
          if (await scopeAllowedOn(d.id)) allowedDaemonIds.push(d.id);
        }
        const reached = allowedDaemonIds.filter((id) =>
          relay.sendToDaemonInWorkspace(targetWorkspace, relayRpc, id),
        );
        if (reached.length === 0) {
          // No reachable daemon (none connected, or none the caller can list on):
          // reply with an empty directory so the sidebar clears, not an error.
          if (termReqId) {
            sendPaseoResponse(ws, "cyborg:list_terminals_response", {
              requestId: termReqId,
              workspaceId: targetWorkspace,
              terminals: [],
            });
          }
          return;
        }
        if (termReqId) {
          const existing = terminalListAggregations.get(termReqId);
          if (existing) clearTimeout(existing.timer);
          terminalListAggregations.set(termReqId, {
            guestWs: ws,
            workspaceId: targetWorkspace,
            terminals: new Map(),
            pendingDaemons: new Set(reached),
            // Fallback flush so a slow/dead daemon can't hang the request forever.
            timer: setTimeout(() => void finalizeTerminalList(termReqId), 4000),
          });
        }
        return;
      }

      // Daemon-owner session audit (#993): single-daemon (NOT a fan-out) — the
      // admin-scope gate ran above (DAEMON_HOST_CONTROL_TYPES requires the explicit
      // daemonId + admin). Forward to the target daemon; when it's offline, answer
      // from the PG mirror (gate already passed → all bindings, no per-user scoping).
      if (type === "cyborg:list_daemon_sessions" && targetDaemonId) {
        const auditReqId = inner.requestId as string | undefined;
        const forwarded = relay.sendToDaemonInWorkspace(targetWorkspace, relayRpc, targetDaemonId);
        if (forwarded) {
          if (auditReqId) trackDaemonSessionAudit(auditReqId, ws, targetWorkspace, targetDaemonId);
          return;
        }
        if (
          auditReqId &&
          (await sendOfflineDaemonSessions(ws, auditReqId, targetWorkspace, targetDaemonId))
        ) {
          return;
        }
        respondError("no daemon connected — start your local daemon to use this feature");
        return;
      }

      // Agent-scoped forwards MUST land on the daemon that owns the agent. With
      // several daemons subscribed to the same workspace, the no-target fallback
      // delivers to an arbitrary subscriber, which answers "Agent not found in
      // workspace" — blank history after a reload (fetch_agent_timeline), model
      // switches that never apply (set_agent_model), etc. Resolve the owning
      // daemon from the PG agent↔daemon binding when the caller didn't target one.
      // Honor a daemonId resolved AFTER capture (the restore_session gate above
      // pins inner.daemonId to the archived session's owning daemon), so the
      // forward lands there instead of an arbitrary subscriber.
      let forwardDaemonId = targetDaemonId ?? (inner.daemonId as string | undefined);
      const forwardAgentId = inner.agentId as string | undefined;
      if (!forwardDaemonId && forwardAgentId) {
        forwardDaemonId = (await pg.getAgentDaemonId(forwardAgentId, targetWorkspace)) ?? undefined;
      }

      const forwarded = relay.sendToDaemonInWorkspace(targetWorkspace, relayRpc, forwardDaemonId);
      // Track this guest's live terminal subscriptions so a DIRTY socket close
      // (app crash) can forward an unsubscribe and not leak the daemon-side viewer
      // (#807). A clean unsubscribe removes the entry here. Only track once the
      // forward actually reached a daemon (a failed forward subscribed nothing).
      if (forwarded && forwardDaemonId) {
        const terminalId = inner.terminalId as string | undefined;
        if (type === "cyborg:subscribe_terminal" && terminalId) {
          guest.terminalSubs.set(terminalId, {
            workspaceId: targetWorkspace,
            daemonId: forwardDaemonId,
            attachId: inner.attachId as string | undefined,
          });
        } else if (type === "cyborg:unsubscribe_terminal" && terminalId) {
          guest.terminalSubs.delete(terminalId);
        }
      }
      if (!forwarded) {
        relayLog.error(
          {
            type,
            daemonId: forwardDaemonId ?? "auto",
            workspaceId: targetWorkspace,
            caller: guest.userId,
          },
          "daemon_forward forward failed",
        );
        // The cybo roster lives in PG (workspace-level) too — a dead/missing
        // daemon must not blank it. Answer with the PG cybos instead of erroring;
        // local (disk) cybos from the unreachable daemon are simply absent.
        if (type === "cyborg:fetch_cybos") {
          const pgCybos = await pg.getCybos(targetWorkspace);
          const readinessFor = await workspaceReadinessResolver(relay, pg, targetWorkspace);
          respond("cyborg:fetch_cybos_response", {
            cybos: pgCybos.map((c) => {
              let perms: string[] = [];
              try {
                perms = c.platform_permissions ? JSON.parse(c.platform_permissions) : [];
              } catch {
                perms = [];
              }
              return {
                id: c.id,
                slug: c.slug,
                name: c.name,
                description: c.description,
                avatar: c.avatar,
                role: c.role,
                provider: c.provider,
                model: c.model,
                llmAuthMode: c.llm_auth_mode,
                behaviorMode: c.behavior_mode,
                homeDaemonId: c.home_daemon_id,
                autonomyLevel: c.autonomy_level,
                monthlySpendCap: c.monthly_spend_cap,
                platformPermissions: perms,
                isDefault: c.is_default === 1,
                createdAt: c.created_at,
                isLocal: false,
                daemonId: null,
                // Server-computed "last active" (epoch ms); null when the cybo
                // has no sessions. Same value the merge path (SITE 2) carries —
                // kept in parity here for the dead-daemon PG-only fallback.
                lastActiveAt: c.last_active_at ?? null,
                // #636: readiness on the PG-only fallback roster too.
                readiness: readinessFor(c.provider, c.model),
              };
            }),
          });
          return;
        }
        // Offline CLEAR of an agent session whose owning daemon is asleep (#810).
        // archive normally forwards to the daemon, which errors here ("isn't
        // connected right now") so a dead session's offline row is un-clearable.
        // Authorize + clear the PG mirror directly so the user can get rid of it.
        if (type === "cyborg:archive_agent") {
          const agentId = inner.agentId as string | undefined;
          if (!agentId) {
            respondError("agentId required");
            return;
          }
          const binding = await pg.getAgentBinding(agentId);
          if (!binding) {
            respondError("agent not found");
            return;
          }
          // SAME rule as the daemon's handleArchiveAgent: a SHARED channel agent
          // (channel-bound; the PG mirror only ever holds NON-ephemeral bindings,
          // so channelId ⇒ shared) is clearable by any member. Otherwise PRIVATE:
          // the INITIATOR (real email OR the GLOBAL account id — a cloud-forwarded
          // session stamps initiated_by = the global id, even on old rows whose
          // mirrored email is the synthetic <id>@remote.local placeholder) OR a
          // workspace OWNER/ADMIN. Conditions computed flat (role looked up only
          // for a private session) to keep one combined guard.
          const isSharedChannelAgent = !!binding.channelId;
          const archiverRole = isSharedChannelAgent
            ? null
            : await pg.getMemberRole(targetWorkspace, guest.userId);
          const isAdmin = archiverRole === "owner" || archiverRole === "admin";
          const isInitiator =
            (!!binding.initiatedByEmail &&
              !!guest.email &&
              binding.initiatedByEmail.toLowerCase() === guest.email.toLowerCase()) ||
            (!!binding.initiatedBy && binding.initiatedBy === guest.userId);
          if (!isSharedChannelAgent && !isAdmin && !isInitiator) {
            respondError(
              "only workspace admins or the session initiator can clear an offline agent",
            );
            return;
          }
          await pg.deleteAgentBinding(agentId);
          // Mirror the teardown into agent_sessions so the Home stats stop accruing
          // (best-effort; PG-only) — same as the daemon's "removed" agent_status.
          await pg
            .archiveAgentSession(agentId)
            .catch((err) =>
              relayLog.error({ err, agentId }, "archiveAgentSession failed clearing offline agent"),
            );
          // Broadcast the removal so other connected clients drop the row, mirroring
          // the daemon's removal agent_status shape.
          broadcastToGuests(targetWorkspace, {
            type: "cyborg:agent_status",
            payload: {
              agentId,
              lifecycle: "removed",
              provider: binding.provider,
              workspaceId: targetWorkspace,
            },
          });
          // The client's archiveAgent expects a sessionId; an offline clear has no
          // archived_sessions row (it's a clear, not a full archive), so null.
          respond("cyborg:archive_agent_response", { sessionId: null });
          return;
        }
        respondError(
          forwardDaemonId
            ? `The daemon for this command (${forwardDaemonId}) isn't connected right now — open it in the Agents tab and make sure it's online, then retry.`
            : "No daemon is connected — start the daemon you own (Agents tab) and try again.",
        );
      }
      return;
    }

    try {
      switch (type) {
        case "cyborg:fetch_workspaces": {
          const workspaces = await pg.getWorkspacesForUser(guest.userId);
          respond("cyborg:fetch_workspaces_response", {
            workspaces: workspaces.map((w) => ({
              id: w.id,
              name: w.name,
              avatarUrl: w.avatar_url ?? null,
              role: w.role,
            })),
          });
          break;
        }

        case "cyborg:create_workspace": {
          const wsName = (inner.name as string)?.trim();
          if (!wsName) {
            respondError("name required");
            break;
          }
          const newWsId = randomUUID();
          await pg.createWorkspace(
            newWsId,
            wsName,
            guest.userId,
            inner.settings as Record<string, unknown> | undefined,
          );
          await pg.addMember(newWsId, guest.userId, "owner", "active");
          // NOTE (per-workspace seat model, spec §6.6): a freshly-created
          // workspace is NO LONGER auto-granted Pro. It starts on the 7-day trial;
          // the owner explicitly allocates a seat from their license pool
          // (`cyborg:allocate_license`) to make it Pro. The old fan-out backfill
          // (reconcileUserIapLicense here) was removed because the seat model must
          // never auto-allocate a workspace.
          const generalChId = `ch_${randomUUID()}`;
          await pg.createChannel(generalChId, newWsId, "general", guest.userId, {
            description: "General discussion",
          });
          // Seed a default project named after the workspace so a brand-new
          // company never lands on an empty "No projects yet" Tasks screen — the
          // owner can rename it later. Mirrors cyborg:create_project (chat project
          // + its partner Tasks project + default states). Best-effort: a failure
          // here must not fail workspace creation.
          try {
            const defaultProjId = randomUUID();
            await pg.createProject(defaultProjId, newWsId, wsName, "#6366f1");
            await pg.provisionTasksProject(newWsId, defaultProjId, wsName);
          } catch (err) {
            console.error("[create_workspace] default project seeding failed (continuing)", {
              workspaceId: newWsId,
              err,
            });
          }
          guest.workspaceIds.add(newWsId);
          const guestSub = guestSubs.get(newWsId) ?? new Set();
          guestSub.add(ws);
          guestSubs.set(newWsId, guestSub);
          // Link the owner's already-connected daemon(s) to the new workspace —
          // a fresh-install daemon connected before this workspace existed, so it
          // would otherwise show "0 daemons" until it reconnects.
          await relay.linkOwnerDaemonsToWorkspace(newWsId, guest.userId);
          respond("cyborg:create_workspace_response", {
            workspace: {
              id: newWsId,
              name: wsName,
              ownerId: guest.userId,
              avatarUrl: null,
              settings: inner.settings ?? {},
              createdAt: Date.now(),
            },
          });
          break;
        }

        case "cyborg:delete_account": {
          // App-Store 5.1.1(v) self-deletion — DESTRUCTIVE + irreversible. No
          // target userId on the wire: we act ONLY on the authenticated socket's
          // guest.userId, so a caller can never delete anyone else's account.
          // pg.deleteAccount runs one transaction: reassigns ownership of co-owned
          // workspaces (heir = first admin, else first other active member,
          // promoted to admin), deletes solely-owned workspaces (children
          // cascade), clears non-cascading authored refs (daemons, invitations,
          // agent_channel_assignments, daemon_access.grantedBy), then deletes the
          // user row (cascading memberships, channel_members/roles, reads,
          // agent_sessions, mcp/fcm tokens, presence, push subscriptions, …).
          await handleDeleteAccount({
            userId: guest.userId,
            deleteAccount: (id) => pg.deleteAccount(id),
            respondOk: () => respond("cyborg:delete_account_response", { ok: true }),
            respondError,
            closeSocket: () => {
              // Tear down EVERY live socket for this (now-deleted) user — not just
              // the calling one — so a session on another device/tab can't keep
              // operating as a gone user (its next PG-backed RPC would fail). The
              // close handler drops each from guestSubs/presence.
              for (const [gws, g] of guests) {
                if (g.userId === guest.userId) {
                  try {
                    gws.close(1000, "account deleted");
                  } catch {
                    // intentional: best-effort teardown; the socket may already be
                    // closing/closed and the close handler still cleans up state.
                  }
                }
              }
            },
            logError: (message, err) => relayLog.error({ err }, message),
          });
          break;
        }

        case "cyborg:fetch_channels": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const channels = await pg.getChannelsForUser(workspaceId, guest.userId);
          // Carry the channel→project assignment on the channel itself so a
          // reconnect's wholesale channels overwrite preserves it. Without this,
          // reconcile dropped projectId and channels fell to "Unfiled" until a
          // reload re-ran the (one-shot) client-side project application.
          const cps = await pg.getChannelProjects(workspaceId);
          const projectByChannel = new Map(cps.map((cp) => [cp.channelId, cp.projectId]));
          respond("cyborg:fetch_channels_response", {
            channels: channels.map((c) =>
              Object.assign(mapChannel(c), { projectId: projectByChannel.get(c.id) ?? null }),
            ),
          });
          break;
        }

        case "cyborg:list_channels": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (!role) {
            respondError("not a workspace member");
            break;
          }
          const browse = await pg.getChannelsWithMembership(workspaceId, guest.userId);
          respond("cyborg:list_channels_response", {
            channels: browse.map((c) =>
              Object.assign(mapChannel(c), {
                isMember: c.is_member,
                memberCount: c.member_count,
              }),
            ),
          });
          break;
        }

        case "cyborg:fetch_messages": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const channelId = inner.channelId as string;
          if (!channelId) {
            respondError("channelId required");
            break;
          }
          // Anchor the read to the asserted workspace (mirrors channel_message):
          // caller must be a member, the channel must belong to this workspace,
          // and a private channel requires channel membership.
          const fmRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!fmRole) {
            respondError("not a member of this workspace");
            break;
          }
          const fmChannel = await pg.getChannel(channelId);
          if (!fmChannel || fmChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          if (fmChannel.is_private && !(await pg.getChannelMemberRole(channelId, guest.userId))) {
            respondError("channel not found");
            break;
          }
          const limit = Math.min((inner.limit as number) ?? 50, 200);
          const messages = await pg.getMessages({
            channelId,
            before: inner.before as string | undefined,
            limit: limit + 1,
          });
          const hasMore = messages.length > limit;
          // getMessages returns ASCENDING (oldest→newest); the extra (limit+1th)
          // row is therefore the OLDEST. slice(1) drops it and keeps the newest
          // `limit` — slice(0, limit) would have dropped the NEWEST message of the
          // page (the latest message vanished on every reload).
          const mapped = (hasMore ? messages.slice(1) : messages).map(mapMessage);
          // Attach the thread footer (derived reply count + last reply) to roots so
          // the "N replies" footer survives reload (it was only set live, then lost).
          const replyCounts = await pg.getReplyCountsForRoots(mapped.map((mm) => mm.id));
          const withThreads = mapped.map((mm) => Object.assign(mm, replyCounts.get(mm.id) ?? {}));
          respond("cyborg:fetch_messages_response", {
            messages: withThreads,
            hasMore,
          });
          break;
        }

        case "cyborg:fetch_dm_messages": {
          const peerId = inner.peerId as string;
          if (!workspaceId || !peerId) {
            respondError("workspaceId and peerId required");
            break;
          }
          const dmLimit = Math.min((inner.limit as number) ?? 50, 200);
          const dmMessages = await pg.getDmMessages({
            workspaceId,
            userId: guest.userId,
            peerId,
            before: inner.before as string | undefined,
            limit: dmLimit + 1,
          });
          const dmHasMore = dmMessages.length > dmLimit;
          // Ascending order — drop the oldest extra row, not the newest message.
          const dmMapped = (dmHasMore ? dmMessages.slice(1) : dmMessages).map(mapMessage);
          // Attach the thread footer (derived reply count + last reply) to DM roots
          // so the "N replies" footer survives reload — mirrors the channel fetch
          // (cyborg:fetch_messages). getReplyCountsForRoots keys on parentId only,
          // so it works identically for DM roots (channelId = null).
          const dmReplyCounts = await pg.getReplyCountsForRoots(dmMapped.map((mm) => mm.id));
          const dmWithThreads = dmMapped.map((mm) =>
            Object.assign(mm, dmReplyCounts.get(mm.id) ?? {}),
          );
          respond("cyborg:fetch_dm_messages_response", {
            messages: dmWithThreads,
            hasMore: dmHasMore,
          });
          break;
        }

        // Seq-cursored DM catch-up (#500). The channel drain (cyborg:sync) pages
        // ALL workspace messages since a seq cursor; this is its DM-scoped twin so
        // a reconnect reconstructs the full DM history (no blind "latest 50"
        // window that drops everything older when >50 arrived while offline).
        // Returns ascending pages + nextSeq so the client loops until caught up.
        // Additive: older relays answer "unsupported: cyborg:fetch_dm_since" and
        // the client falls back to the latest-page refetch.
        case "cyborg:fetch_dm_since": {
          // Defensive typeof checks on untrusted JSON (not `as` casts).
          const sincePeerId = typeof inner.peerId === "string" ? inner.peerId : undefined;
          if (!workspaceId || !sincePeerId) {
            respondError("workspaceId and peerId required");
            break;
          }
          const sinceLimit = Math.min(typeof inner.limit === "number" ? inner.limit : 200, 500);
          const sinceSeq = typeof inner.sinceSeq === "number" ? inner.sinceSeq : 0;
          const sinceRows = await pg.getDmMessagesSince({
            workspaceId,
            userId: guest.userId,
            peerId: sincePeerId,
            sinceSeq,
            limit: sinceLimit + 1,
          });
          const sinceHasMore = sinceRows.length > sinceLimit;
          const sincePage = sinceHasMore ? sinceRows.slice(0, sinceLimit) : sinceRows;
          const sinceMapped = sincePage.map(mapMessage);
          const sinceReplyCounts = await pg.getReplyCountsForRoots(sinceMapped.map((mm) => mm.id));
          const sinceWithThreads = sinceMapped.map((mm) =>
            Object.assign(mm, sinceReplyCounts.get(mm.id) ?? {}),
          );
          const sinceNextSeq =
            sincePage.length > 0 ? sincePage[sincePage.length - 1].seq : sinceSeq;
          respond("cyborg:fetch_dm_since_response", {
            messages: sinceWithThreads,
            hasMore: sinceHasMore,
            nextSeq: sinceNextSeq,
          });
          break;
        }

        case "cyborg:fetch_workspace_activity": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const actLimit = Math.min((inner.limit as number) ?? 200, 500);
          const activity = await pg.getRecentActivity(workspaceId, guest.userId, actLimit);
          respond("cyborg:fetch_workspace_activity_response", {
            messages: activity.map(mapMessage),
          });
          break;
        }

        // ─── Chat-port (PR #17) reads — ported to the cloud gateway. These were
        // only in the daemon dispatcher, so in cloud mode badges/activity/prefs
        // got no response. All query PG directly like the rest of the gateway.

        case "cyborg:fetch_unread": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const [counts, mentionCounts, reads, dmCounts, dmReads] = await Promise.all([
            pg.getUnreadCounts(workspaceId, guest.userId),
            // BUG #2: per-channel MENTION count → the RED numeric badge. Additive +
            // backward-compatible field; older clients ignore it, the bold flag
            // still seeds from `counts`.
            pg.getMentionCounts(workspaceId, guest.userId),
            pg.getReadsForUser(workspaceId, guest.userId),
            // P2 Item 12: DM unread + read cursors (badge + frozen divider source).
            pg.getDmUnreadCounts(workspaceId, guest.userId),
            pg.getDmReadsForUser(workspaceId, guest.userId),
          ]);
          respond("cyborg:fetch_unread_response", {
            counts,
            mentionCounts,
            reads,
            dmCounts,
            dmReads,
          });
          break;
        }

        case "cyborg:set_presence": {
          // P2 #6a: manual away toggle. Track per-user, PERSIST to user_presence
          // (so it survives a full disconnect), and re-broadcast presence so
          // co-members see the away dot live. Online status itself stays
          // connection-derived; this only adds the away flag. (The legacy
          // `ephemeral` auto-away on app-background was removed — backgrounding no
          // longer flips presence; a connected user simply shows online.)
          // Ignore legacy ephemeral auto-away frames: un-updated clients still send
          // set_presence{away:true, ephemeral:true} on background. Auto-away was
          // removed, so we must NOT persist those as durable away (it would
          // permanently stick a backgrounded old client as "away"). Only durable
          // MANUAL away (ephemeral absent/false) is honored + persisted.
          if (typeof inner.away === "boolean" && inner.ephemeral !== true) {
            if (inner.away) awayUsers.add(guest.userId);
            else awayUsers.delete(guest.userId);
            void pg
              .setUserAway(guest.userId, inner.away)
              .catch((err) =>
                relayLog.warn(
                  { err, userId: guest.userId, away: inner.away },
                  "setUserAway persist failed — away state won't survive reconnect",
                ),
              );
            broadcastPresence(guest.workspaceIds);
          }
          break;
        }

        case "cyborg:app_state": {
          // Per-connection foreground/background + client surface (desktop/web/
          // mobile). dispatchPush uses these for DESKTOP-ACTIVE suppression: a user
          // with an open + foregrounded desktop/web connection gets NO mobile push
          // (v1 parity — "active desktop ⇒ quiet phone"). It does NOT gate mobile-vs-
          // mobile: a backgrounded/foregrounded PHONE is always pushed, and the
          // client's willPresent dedups the chat being viewed (iOS can't reliably
          // flush this signal before the socket suspends anyway). No presence/away
          // side effects.
          if (typeof inner.state === "string") {
            guest.backgrounded = inner.state === "background";
          }
          if (
            inner.clientType === "desktop" ||
            inner.clientType === "web" ||
            inner.clientType === "mobile"
          ) {
            guest.clientType = inner.clientType;
          }
          break;
        }

        case "cyborg:mark_read": {
          const channelId = inner.channelId as string | undefined;
          if (!workspaceId || !channelId) {
            respondError("workspaceId and channelId required");
            break;
          }
          const lastReadAt = (inner.lastReadAt as number) ?? Date.now();
          await pg.markRead(workspaceId, guest.userId, channelId, lastReadAt);
          notifyUserGuests(
            guest.userId,
            "cyborg:read_broadcast",
            { workspaceId, channelId, lastReadAt },
            ws,
          );
          // P2 Item 9: reading a channel also clears its Activity feed items
          // (mentions / thread-replies). Mark them read server-side and tell ALL
          // the user's devices so the activity badge reconciles cross-device.
          void (async () => {
            try {
              const changed = await pg.markActivityReadByChannel(
                workspaceId,
                guest.userId,
                channelId,
              );
              if (!changed) return;
              const unread = await pg.getUnreadActivityCount(workspaceId, guest.userId);
              for (const gws of guests.keys()) {
                const g = guests.get(gws);
                if (g?.userId === guest.userId && gws.readyState === WebSocket.OPEN) {
                  sendPaseoResponse(gws, "cyborg:activity_read_changed", {
                    workspaceId,
                    channelId,
                    unread,
                  });
                }
              }
              // #605: the activity badge dropped, so clear it on the push surface too.
              void pushBadgeUpdate(guest.userId);
            } catch (err) {
              relayLog.error({ err }, "activity mark-by-channel failed");
            }
          })();
          respond("cyborg:mark_read_response", { lastReadAt });
          break;
        }

        case "cyborg:mark_dm_read": {
          // P2 Item 12: the DM analogue of mark_read. Advances the user's
          // dm_reads cursor for a peer (badge source + frozen-divider basis),
          // broadcasts to the user's OTHER devices, and clears DM Activity items.
          const peerId = inner.peerId as string | undefined;
          if (!workspaceId || !peerId) {
            respondError("workspaceId and peerId required");
            break;
          }
          const lastReadAt = (inner.lastReadAt as number) ?? Date.now();
          await pg.markDmRead(workspaceId, guest.userId, peerId, lastReadAt);
          notifyUserGuests(
            guest.userId,
            "cyborg:read_broadcast",
            { workspaceId, dmPeerId: peerId, lastReadAt },
            ws,
          );
          // Reading a DM also clears its Activity feed items (mentions from that
          // peer). Mark read server-side and tell ALL the user's devices.
          void (async () => {
            try {
              const changed = await pg.markActivityReadByDmPeer(workspaceId, guest.userId, peerId);
              if (!changed) return;
              const unread = await pg.getUnreadActivityCount(workspaceId, guest.userId);
              for (const gws of guests.keys()) {
                const g = guests.get(gws);
                if (g?.userId === guest.userId && gws.readyState === WebSocket.OPEN) {
                  sendPaseoResponse(gws, "cyborg:activity_read_changed", {
                    workspaceId,
                    dmPeerId: peerId,
                    unread,
                  });
                }
              }
              // #605: the activity badge dropped, so clear it on the push surface too.
              void pushBadgeUpdate(guest.userId);
            } catch (err) {
              relayLog.error({ err }, "activity mark-by-dm-peer failed");
            }
          })();
          respond("cyborg:mark_dm_read_response", { lastReadAt });
          break;
        }

        case "cyborg:mark_task_read": {
          // Task analogue of mark_dm_read: opening a task's detail card clears its
          // Activity rows (task_assigned / task_status_changed). Task rows carry no
          // channel/dm scope, so they're matched by sourceType + sourceId=taskId.
          // Marks read server-side and tells ALL the user's devices so the activity
          // badge reconciles cross-device (open on the phone, clears on the laptop).
          const taskId = inner.taskId as string | undefined;
          if (!workspaceId || !taskId) {
            respondError("workspaceId and taskId required");
            break;
          }
          void (async () => {
            try {
              const changed = await pg.markActivityReadByTask(workspaceId, guest.userId, taskId);
              if (!changed) return;
              const unread = await pg.getUnreadActivityCount(workspaceId, guest.userId);
              for (const gws of guests.keys()) {
                const g = guests.get(gws);
                if (g?.userId === guest.userId && gws.readyState === WebSocket.OPEN) {
                  sendPaseoResponse(gws, "cyborg:activity_read_changed", {
                    workspaceId,
                    taskId,
                    unread,
                  });
                }
              }
              // #605: the activity badge dropped, so clear it on the push surface too.
              void pushBadgeUpdate(guest.userId);
            } catch (err) {
              relayLog.error({ err }, "activity mark-by-task failed");
            }
          })();
          respond("cyborg:mark_task_read_response", { taskId });
          break;
        }

        case "cyborg:fetch_activity": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const [items, unread] = await Promise.all([
            pg.getActivity(workspaceId, guest.userId, {
              limit: typeof inner.limit === "number" ? Math.min(inner.limit, 200) : undefined,
              before: inner.before as number | undefined,
              unreadOnly: inner.unreadOnly as boolean | undefined,
            }),
            pg.getUnreadActivityCount(workspaceId, guest.userId),
          ]);
          respond("cyborg:fetch_activity_response", { items, unread });
          break;
        }

        case "cyborg:mark_activity_read": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const eventId = inner.eventId as string | undefined;
          if (eventId) await pg.markActivityRead(eventId, guest.userId);
          else await pg.markAllActivityRead(workspaceId, guest.userId);
          const unread = await pg.getUnreadActivityCount(workspaceId, guest.userId);
          // #605: clearing the activity feed drops the badge — sync it to the
          // push surface (mobile app-icon) too.
          void pushBadgeUpdate(guest.userId);
          respond("cyborg:mark_activity_read_response", { unread });
          break;
        }

        case "cyborg:set_notification_pref": {
          const scopeId = inner.scopeId as string | undefined;
          const preference = inner.preference as string | undefined;
          if (!workspaceId || !scopeId || !preference) {
            respondError("workspaceId, scopeId and preference required");
            break;
          }
          await pg.setNotificationPref(workspaceId, guest.userId, scopeId, preference);
          notifyUserGuests(
            guest.userId,
            "cyborg:notification_pref_changed",
            { workspaceId, scopeId, preference },
            ws,
          );
          respond("cyborg:set_notification_pref_response", { ok: true });
          break;
        }

        case "cyborg:fetch_notification_prefs": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const prefs = await pg.getNotificationPrefs(workspaceId, guest.userId);
          respond("cyborg:fetch_notification_prefs_response", { prefs });
          break;
        }

        // ─── Composer drafts (server-side draft sync, #610) ──────────────
        // Per-(user, scope) draft so an unfinished message follows the user
        // across devices. Mirrors set_notification_pref: PG write + a user-scoped
        // (not workspace-scoped) broadcast — a draft is private, so only the
        // user's OWN other devices are told, via notifyUserGuests.
        case "cyborg:draft_set": {
          const scope = inner.scope as string | undefined;
          const text = inner.text as string | undefined;
          // Use the client's edit time (epoch ms) as the reconcile tiebreaker,
          // but guard against NaN/±Infinity (not just typeof number) so a bad
          // value can't poison the newest-wins comparison or the UI.
          const updatedAt =
            typeof inner.updatedAt === "number" && Number.isFinite(inner.updatedAt)
              ? (inner.updatedAt as number)
              : Date.now();
          if (!workspaceId || !scope || text === undefined) {
            respondError("workspaceId, scope and text required");
            break;
          }
          // Persist the client's updatedAt (NOT now()) so PG agrees with the
          // SQLite mirror and the daemon path — cross-device reconcile depends on it.
          await pg.setDraft({
            workspaceId,
            userId: guest.userId,
            scope,
            text,
            updatedAt: new Date(updatedAt),
          });
          notifyUserGuests(
            guest.userId,
            "cyborg:draft_changed",
            { workspaceId, scope, text, updatedAt },
            ws,
          );
          respond("cyborg:draft_set_response", { ok: true });
          break;
        }

        case "cyborg:draft_clear": {
          const scope = inner.scope as string | undefined;
          if (!workspaceId || !scope) {
            respondError("workspaceId and scope required");
            break;
          }
          await pg.clearDraft(workspaceId, guest.userId, scope);
          notifyUserGuests(
            guest.userId,
            "cyborg:draft_changed",
            { workspaceId, scope, text: null, updatedAt: Date.now() },
            ws,
          );
          respond("cyborg:draft_clear_response", { ok: true });
          break;
        }

        case "cyborg:fetch_drafts": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const drafts = await pg.getDrafts(workspaceId, guest.userId);
          respond("cyborg:fetch_drafts_response", { drafts });
          break;
        }

        // ─── P2 Item 6: custom user status ("Set yourself as away") ──────────
        case "cyborg:set_user_status": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const emoji = inner.emoji === undefined ? null : (inner.emoji as string | null);
          const text = inner.text === undefined ? null : (inner.text as string | null);
          const expiresAt =
            inner.expiresAt === undefined ? null : (inner.expiresAt as number | null);
          await pg.setUserStatus({
            id: randomUUID(),
            workspaceId,
            userId: guest.userId,
            emoji,
            text,
            expiresAt,
          });
          // Broadcast to co-members of THIS workspace (like presence_update) so
          // the emoji shows live where presence shows.
          broadcastUserStatusChanged(workspaceId, {
            userId: guest.userId,
            emoji,
            text,
            expiresAt,
          });
          respond("cyborg:set_user_status_response", { ok: true });
          break;
        }

        case "cyborg:fetch_user_statuses": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          // Expired statuses are swept by a periodic timer (see relay startup),
          // not per-request — a delete-by-expires_at on every fetch was a full
          // table scan under concurrency. getUserStatuses already filters out
          // expired rows at read time, so a fetch never returns a stale status.
          const members = await pg.getMembers(workspaceId);
          const statuses = await pg.getUserStatuses(
            workspaceId,
            members.map((m) => m.userId),
          );
          respond("cyborg:fetch_user_statuses_response", { statuses });
          break;
        }

        case "cyborg:fetch_thread": {
          const parentId = inner.parentId as string | undefined;
          if (!workspaceId || !parentId) {
            respondError("workspaceId and parentId required");
            break;
          }
          const parent = await pg.getMessageById(parentId);
          // getMessageById returns camelCase `workspaceId` — `parent.workspace_id`
          // was always undefined, so this guard always failed and fetch_thread
          // returned [] for EVERY thread. (Masked until CRT hid replies from the
          // channel; before that, replies were only ever visible inline.)
          if (!parent || parent.workspaceId !== workspaceId) {
            respond("cyborg:fetch_thread_response", { parentId, messages: [] });
            break;
          }
          const replies = await pg.getThreadReplies(parentId);
          // Per-thread "New replies" divider (#7): return the viewer's frozen
          // last_viewed cursor so the client can place the UnreadDivider above
          // the first reply newer than it, before mark_thread_read advances it.
          const lastViewed = await pg.getThreadLastViewed(parentId, guest.userId);
          respond("cyborg:fetch_thread_response", {
            parentId,
            messages: replies.map(mapMessage),
            lastViewed,
          });
          break;
        }

        case "cyborg:fetch_threads": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const list = await pg.getThreads(workspaceId, guest.userId, {
            unreadOnly: Boolean(inner.unreadOnly),
            limit: typeof inner.limit === "number" ? Math.min(inner.limit, 200) : undefined,
          });
          respond("cyborg:fetch_threads_response", {
            threads: list.map((t) => ({
              root: t.root ? mapMessage(t.root) : null,
              replyCount: t.replyCount,
              lastReplyAt: t.lastReplyAt,
              participants: t.participants,
              unreadReplies: t.unreadReplies,
              unreadMentions: t.unreadMentions,
            })),
          });
          break;
        }

        case "cyborg:thread_counts": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const counts = await pg.getThreadCounts(workspaceId, guest.userId);
          respond("cyborg:thread_counts_response", counts);
          break;
        }

        case "cyborg:workspace_stats": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          // Defensive: range is untrusted; fall back to the default (month) for
          // anything not in the allowed set.
          const r = inner.range;
          const range =
            r === "today" || r === "week" || r === "month" || r === "year" ? r : undefined;
          const stats = await pg.getWorkspaceHomeStats(workspaceId, range);
          respond("cyborg:workspace_stats_response", stats);
          break;
        }

        case "cyborg:mark_thread_read": {
          const rootId = inner.rootId as string | undefined;
          if (!workspaceId || !rootId) {
            respondError("workspaceId and rootId required");
            break;
          }
          await pg.markThreadRead(rootId, guest.userId, inner.viewedAt as number | undefined);
          // Cross-device read sync (scoped to this user).
          broadcastToGuests(workspaceId, {
            type: "cyborg:thread_read_changed",
            payload: {
              toUserId: guest.userId,
              rootId,
              unread_replies: 0,
              unread_mentions: 0,
              previous_unread_replies: 0,
              previous_unread_mentions: 0,
            },
          });
          respond("cyborg:mark_thread_read_response", { ok: true });
          break;
        }

        case "cyborg:mark_channel_unread": {
          // Mark-unread-from-post for a channel (N4): the channel analogue of
          // mark_thread_unread. Rewind last_read_at to just BEFORE the chosen
          // post (beforeAt = post.created_at ms) so it + later posts count
          // unread. markRead OVERWRITES last_read_at (not advance-only), so
          // passing an earlier value rewinds correctly.
          // Defensive runtime checks on the untrusted WS payload (no `as` casts):
          // a non-string channelId or non-integer beforeAt is rejected, not coerced.
          const unreadChannelId = typeof inner.channelId === "string" ? inner.channelId : undefined;
          const unreadBeforeAt =
            typeof inner.beforeAt === "number" && Number.isInteger(inner.beforeAt)
              ? inner.beforeAt
              : undefined;
          if (!workspaceId || !unreadChannelId || unreadBeforeAt === undefined) {
            respondError("workspaceId, channelId and beforeAt required");
            break;
          }
          const rewoundReadAt = unreadBeforeAt - 1;
          await pg.markRead(workspaceId, guest.userId, unreadChannelId, rewoundReadAt);
          // Same cross-device sync as mark_read: tell the user's OTHER sockets.
          notifyUserGuests(
            guest.userId,
            "cyborg:read_broadcast",
            { workspaceId, channelId: unreadChannelId, lastReadAt: rewoundReadAt },
            ws,
          );
          respond("cyborg:mark_channel_unread_response", { lastReadAt: rewoundReadAt });
          break;
        }

        case "cyborg:mark_thread_unread": {
          // Mark-unread affordance (#7): rewind the viewer's last_viewed to just
          // before the given reply so it (and later replies) count as unread.
          // beforeAt = the createdAt (ms) of the reply the user marked unread.
          const rootId = inner.rootId as string | undefined;
          const beforeAt = inner.beforeAt as number | undefined;
          if (!workspaceId || !rootId || typeof beforeAt !== "number") {
            respondError("workspaceId, rootId and beforeAt required");
            break;
          }
          await pg.markThreadUnread(rootId, guest.userId, beforeAt);
          // Recompute this viewer's unread post-rewind and push a delta so the
          // aggregate Threads badge updates without a refetch (mirrors the
          // thread_updated prev/new contract; prev = read = 0/0).
          const unread = await pg.getThreadUnreadForUser(rootId, guest.userId);
          broadcastToGuests(workspaceId, {
            type: "cyborg:thread_read_changed",
            payload: {
              toUserId: guest.userId,
              rootId,
              unread_replies: unread.unreadReplies,
              unread_mentions: unread.unreadMentions,
              previous_unread_replies: 0,
              previous_unread_mentions: 0,
            },
          });
          respond("cyborg:mark_thread_unread_response", { ok: true });
          break;
        }

        case "cyborg:follow_thread": {
          const rootId = inner.rootId as string | undefined;
          if (!workspaceId || !rootId) {
            respondError("workspaceId and rootId required");
            break;
          }
          const following = inner.following !== false;
          await pg.followThread(rootId, guest.userId, workspaceId, following);
          broadcastToGuests(workspaceId, {
            type: "cyborg:thread_follow_changed",
            payload: { toUserId: guest.userId, rootId, following },
          });
          respond("cyborg:follow_thread_response", { ok: true });
          break;
        }

        case "cyborg:search": {
          const query = (inner.query as string | undefined) ?? "";
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const results = await pg.searchMessages(
            workspaceId,
            guest.userId,
            query,
            typeof inner.limit === "number" ? Math.min(inner.limit, 200) : undefined,
          );
          respond("cyborg:search_response", { messages: results.map(mapMessage) });
          break;
        }

        case "cyborg:search_tasks": {
          const query = (inner.query as string | undefined) ?? "";
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const results = await pg.searchTasks(
            workspaceId,
            // Per-PROJECT visibility gate (fail-closed): the relay only checks
            // workspace membership, so thread the authed guest's userId so searchTasks
            // can scope the hits to the projects this caller may see (same as
            // fetch_tasks → getTasksPage and searchMessages).
            guest.userId,
            query,
            typeof inner.limit === "number" ? Math.min(inner.limit, 100) : undefined,
          );
          respond("cyborg:search_tasks_response", { results });
          break;
        }

        case "cyborg:fetch_backend_status": {
          const maskUrl = (raw: string | undefined): string | null => {
            if (!raw) return null;
            try {
              const u = new URL(raw);
              if (u.password) u.password = "****";
              return u.toString();
            } catch {
              return raw.replace(/:([^@/]{3})[^@/]*@/, ":$1****@");
            }
          };

          respond("cyborg:fetch_backend_status_response", {
            mode: "remote",
            postgres: {
              url: maskUrl(process.env.DATABASE_URL),
              status: pg ? "connected" : "disconnected",
            },
            redis: {
              url: maskUrl(process.env.REDIS_URL),
              status: redis ? "connected" : "disconnected",
            },
            relay: {
              url: `ws://${HOST}:${PORT}`,
              status: "connected",
            },
            s3: {
              url: s3Bucket ? `https://${s3Bucket}.s3.${s3Region}.amazonaws.com` : null,
              status: s3Client ? "connected" : "disconnected",
            },
          });
          break;
        }

        case "cyborg:fetch_license": {
          // Authoritative license state for the client's trial bar + activate
          // gate. Replaces the localStorage trial clock with a server source:
          // { state: 'trialing'|'active'|'paused', trialEndsAt, ... }.
          //
          // Also carries the context-aware billing `intent` (what action to offer
          // + copy) computed from source × state × platform × role. `platform` is
          // client-supplied — the relay can't know which surface the caller is on
          // (web/desktop/iOS/Android) — and defaults to "web" when absent/invalid.
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const licensePlatform = normalizeBillingPlatform(inner.platform);
          const [license, intent] = await Promise.all([
            pg.getLicenseStatus(workspaceId),
            pg.getBillingIntent(workspaceId, guest.userId, licensePlatform),
          ]);
          respond("cyborg:fetch_license_response", {
            workspaceId,
            license,
            intent,
          });
          break;
        }

        case "cyborg:fetch_license_pool": {
          // The whole allocation surface for the authed caller (spec §4.3): their
          // seat entitlement (ios pool), the workspaces spending a seat, and the
          // workspaces they own (with per-row license state). No workspaceId — the
          // caller is identified by the authed socket's userId.
          const view = await buildPoolView(pg, guest.userId);
          respond("cyborg:fetch_license_pool_response", view);
          break;
        }

        case "cyborg:allocate_license": {
          // Owner-only: spend one FREE seat on a workspace (no purchase — consumes
          // an owned seat). On a rejected mutation we still RESOLVE the *_response
          // (not cyborg:error) with `error` set so the client branches on it; the
          // pool/allocations are returned unchanged. Order of checks (spec §4.3):
          //   not_owner → no_pool → no_free_seat → already_active_other_rail.
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const allocReject = async (code: string): Promise<void> => {
            const view = await buildPoolView(pg, guest.userId);
            respond("cyborg:allocate_license_response", {
              workspaceId,
              license: await pg.getLicenseStatus(workspaceId),
              pool: view.pool,
              allocations: view.allocations,
              error: code,
            });
          };

          // (1) caller must OWN the workspace.
          if ((await pg.getWorkspaceOwnerId(workspaceId)) !== guest.userId) {
            await allocReject("not_owner");
            break;
          }
          // (2) caller must have a pool (the ios seat entitlement).
          const allocPool = await pg.getPoolByOwnerRail(guest.userId, "ios");
          if (!allocPool) {
            await allocReject("no_pool");
            break;
          }
          // (3) no-dual-rail: refuse if the workspace is already Pro on the OTHER
          // (Stripe) rail — the iOS seat would be wasted and we never double-cover.
          // (Checked before claiming a seat so a dual-rail attempt spends nothing.)
          const existingAlloc = await pg.getAllocationForWorkspace(workspaceId);
          if (!existingAlloc) {
            const sub = await pg.getSubscription(workspaceId);
            if (isStripeRow(sub) && isActiveRow(sub)) {
              await allocReject("already_active_other_rail");
              break;
            }
          }
          // (4) ATOMIC seat claim: locks the pool row, re-counts under the lock,
          // and inserts only if a seat is still free — closing the write-skew
          // race two concurrent allocate calls had with count-then-insert. An
          // already-allocated workspace returns ok without spending a seat.
          const claim = await pg.allocateSeatAtomic(allocPool.id, workspaceId);
          if (!claim.ok) {
            await allocReject(claim.reason ?? "no_free_seat");
            break;
          }
          await deriveWorkspaceLicense(pg, workspaceId);

          const allocView = await buildPoolView(pg, guest.userId);
          respond("cyborg:allocate_license_response", {
            workspaceId,
            license: await pg.getLicenseStatus(workspaceId),
            pool: allocView.pool,
            allocations: allocView.allocations,
          });
          break;
        }

        case "cyborg:deallocate_license": {
          // Owner-only: free the seat on a workspace (the workspace then falls back
          // to trial/paused via the derive step). Same response shape as allocate.
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          if ((await pg.getWorkspaceOwnerId(workspaceId)) !== guest.userId) {
            const view = await buildPoolView(pg, guest.userId);
            respond("cyborg:deallocate_license_response", {
              workspaceId,
              license: await pg.getLicenseStatus(workspaceId),
              pool: view.pool,
              allocations: view.allocations,
              error: "not_owner",
            });
            break;
          }
          await pg.deleteAllocation(workspaceId);
          await deriveWorkspaceLicense(pg, workspaceId);

          const deallocView = await buildPoolView(pg, guest.userId);
          respond("cyborg:deallocate_license_response", {
            workspaceId,
            license: await pg.getLicenseStatus(workspaceId),
            pool: deallocView.pool,
            allocations: deallocView.allocations,
          });
          break;
        }

        case "cyborg:fetch_tasks": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          // Tasks Redesign — optional single-project scope. The wire projectId is a
          // CHAT id (the UI/CLI route on it) or a "tp_…" id; resolve it to the
          // tasks_projects.id, gate visibility (fail-closed), then filter the page to
          // that project. Omitted → the full visible-workspace page (unchanged).
          let ftProjectId: string | undefined;
          const ftRawProjectId = inner.projectId as string | undefined;
          if (ftRawProjectId) {
            const resolved = await pg.resolveTasksProjectId(ftRawProjectId);
            if (!resolved) {
              respondError("project not found");
              break;
            }
            if (!(await pg.assertProjectVisible(ftRawProjectId, guest.userId))) {
              respondError("forbidden");
              break;
            }
            ftProjectId = resolved;
          }
          const { tasks, nextCursor } = await pg.getTasksPage(workspaceId, {
            status: inner.status as string | undefined,
            assigneeId: inner.assigneeId as string | undefined,
            limit: inner.limit as number | undefined,
            cursor: inner.cursor as string | undefined,
            // Tasks Redesign — scope to the resolved tasks_projects.id when given.
            projectId: ftProjectId,
            // Tasks Redesign GATE (fail-closed): scope the page to the projects this
            // caller may see. pg.getTasksPage applies taskVisibilityCondition when a
            // userId is present (legacy/no-project tasks stay visible); a member can
            // never receive a task in a project they can't see.
            userId: guest.userId,
          });
          // Per-task scheduling — batch-fetch the schedules bound to this page's
          // tasks (one query, read-only PG mirror) and denormalize a minimal cadence
          // summary onto each wire Task. A task with no bound schedule gets null.
          const taskScheduleMap = await pg.getSchedulesByTaskIds(tasks.map((t) => t.id));
          respond("cyborg:fetch_tasks_response", {
            tasks: tasks.map((t) => mapTask(t, scheduleSummaryForTask(taskScheduleMap.get(t.id)))),
            nextCursor,
          });
          break;
        }

        // List the workspace's Tasks-projects (the CLI / UI project picker source).
        // Scoped to the projects this caller may see (Inbox + channel-tagged projects
        // they're a member of + everything for owner/admin). Carries workspaceId, so
        // the workspace-membership gate above already proved membership; the per-
        // project visibility filter is applied inside getTasksProjectsForUser.
        case "cyborg:fetch_tasks_projects": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const projects = await pg.getTasksProjectsForUser(workspaceId, guest.userId);
          respond("cyborg:fetch_tasks_projects_response", { projects });
          break;
        }

        // ─── Tasks Redesign catalog reads (board/detail) ───────────────────
        // These five carry the CHAT projectId / taskId only (no workspaceId), so
        // the workspace-membership gate above never fires for them — visibility is
        // enforced HERE via pg.assertProjectVisible (fail-closed). For task_activity
        // the task is first resolved to its project, then that project is gated.
        case "cyborg:fetch_project_states": {
          const projectId = inner.projectId as string | undefined;
          if (!projectId) {
            respondError("projectId required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const states = await pg.getProjectStates(projectId);
          respond("cyborg:fetch_project_states_response", { states });
          break;
        }

        case "cyborg:fetch_project_labels": {
          const projectId = inner.projectId as string | undefined;
          if (!projectId) {
            respondError("projectId required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const labels = await pg.getProjectLabels(projectId);
          respond("cyborg:fetch_project_labels_response", { labels });
          break;
        }

        case "cyborg:fetch_cycles": {
          const projectId = inner.projectId as string | undefined;
          if (!projectId) {
            respondError("projectId required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const cycles = await pg.getProjectCycles(projectId);
          respond("cyborg:fetch_cycles_response", { cycles });
          break;
        }

        case "cyborg:fetch_modules": {
          const projectId = inner.projectId as string | undefined;
          if (!projectId) {
            respondError("projectId required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const modules = await pg.getProjectModules(projectId);
          respond("cyborg:fetch_modules_response", { modules });
          break;
        }

        // ─── Cycles catalog CRUD ─────────────────────────────────────────
        // create carries the CHAT projectId; update/delete carry the cycleId, so
        // the cycle is first resolved to its project (a "tp_…" id assertProjectVisible
        // accepts directly), then gated. A writer role isn't separately required:
        // visibility (channel membership / owner-admin) is the catalog gate, matching
        // the fetch reads above.
        case "cyborg:create_cycle": {
          const projectId = inner.projectId as string | undefined;
          const name = inner.name as string | undefined;
          if (!projectId || !name) {
            respondError("projectId and name required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const cycle = await pg.insertCycle({
            projectId,
            name,
            description: (inner.description as string | null | undefined) ?? null,
            startDate: (inner.startDate as number | null | undefined) ?? null,
            endDate: (inner.endDate as number | null | undefined) ?? null,
          });
          respond("cyborg:create_cycle_response", { cycle });
          break;
        }

        case "cyborg:update_cycle": {
          const cycleId = inner.cycleId as string | undefined;
          if (!cycleId) {
            respondError("cycleId required");
            break;
          }
          const cycleProjectId = await pg.getCycleProjectId(cycleId);
          if (!cycleProjectId || !(await pg.assertProjectVisible(cycleProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const cycle = await pg.updateCycle(cycleId, {
            name: inner.name as string | undefined,
            description: inner.description as string | null | undefined,
            startDate: inner.startDate as number | null | undefined,
            endDate: inner.endDate as number | null | undefined,
          });
          if (!cycle) {
            respondError("cycle not found");
            break;
          }
          respond("cyborg:update_cycle_response", { cycle });
          break;
        }

        case "cyborg:delete_cycle": {
          const cycleId = inner.cycleId as string | undefined;
          if (!cycleId) {
            respondError("cycleId required");
            break;
          }
          const cycleProjectId = await pg.getCycleProjectId(cycleId);
          if (!cycleProjectId || !(await pg.assertProjectVisible(cycleProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          await pg.deleteCycle(cycleId);
          respond("cyborg:delete_cycle_response", { deleted: true });
          break;
        }

        // ─── Project pages catalog CRUD ──────────────────────────────────
        // fetch/create carry the CHAT projectId; fetch_page/update/archive/delete
        // carry the pageId, so the page is first resolved to its project (a "tp_…"
        // id assertProjectVisible accepts directly), then gated. Visibility (channel
        // membership / owner-admin) is the catalog gate, matching the cycle CRUD.
        // create/update/archive/delete broadcast cyborg:pages_changed to the
        // workspace so open pages views refresh live (cycles don't broadcast; pages
        // mirror the tasks_changed fan-out instead).
        case "cyborg:fetch_pages": {
          const projectId = typeof inner.projectId === "string" ? inner.projectId : undefined;
          if (!projectId) {
            respondError("projectId required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const pages = await pg.getProjectPages(projectId, guest.userId);
          respond("cyborg:fetch_pages_response", { pages });
          break;
        }

        case "cyborg:fetch_page": {
          const pageId = typeof inner.pageId === "string" ? inner.pageId : undefined;
          if (!pageId) {
            respondError("pageId required");
            break;
          }
          const pageProjectId = await pg.getPageProjectId(pageId);
          // Missing page → null (not an error) so the client treats it as "gone".
          if (!pageProjectId) {
            respond("cyborg:fetch_page_response", { page: null });
            break;
          }
          if (!(await pg.assertProjectVisible(pageProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const page = await pg.getPageById(pageId);
          // A non-null-owner private page is visible ONLY to its owner; hide it from
          // everyone else (null → "gone"), mirroring the list filter. Public + legacy
          // null-owner pages return unchanged.
          if (page && isPageRestrictedFromUser(page, guest.userId)) {
            respond("cyborg:fetch_page_response", { page: null });
            break;
          }
          respond("cyborg:fetch_page_response", { page });
          break;
        }

        case "cyborg:create_page": {
          const projectId = typeof inner.projectId === "string" ? inner.projectId : undefined;
          if (!projectId) {
            respondError("projectId required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const page = await pg.insertPage({
            projectId,
            title: typeof inner.title === "string" ? inner.title : undefined,
            ownedBy: guest.userId,
            // A string nests the page under that parent; absent/malformed = root.
            parentId: typeof inner.parentId === "string" ? inner.parentId : null,
          });
          respond("cyborg:create_page_response", { page });
          broadcastToGuests(page.workspaceId, {
            type: "cyborg:pages_changed",
            payload: {
              workspaceId: page.workspaceId,
              projectId: page.projectId,
              op: "created",
              // Strip a private page to id+visibility so its title/content never
              // fans out to non-owners; public + null-owner pages broadcast in full.
              page: pageBroadcastPayload(page),
            },
          });
          break;
        }

        case "cyborg:update_page": {
          const pageId = typeof inner.pageId === "string" ? inner.pageId : undefined;
          if (!pageId) {
            respondError("pageId required");
            break;
          }
          const pageProjectId = await pg.getPageProjectId(pageId);
          if (!pageProjectId || !(await pg.assertProjectVisible(pageProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          // Owner-gate: a non-null-owner private page is editable only by its owner
          // (the project gate above is membership-only). Loading the current row lets
          // the owner still flip their OWN private page public.
          const currentPage = await pg.getPageById(pageId);
          if (currentPage && isPageRestrictedFromUser(currentPage, guest.userId)) {
            respondError("forbidden");
            break;
          }
          // Only treat a field as present when it's the right type — a missing or
          // malformed title/content/visibility must NOT be coerced into a write.
          const page = await pg.updatePage(pageId, {
            title: typeof inner.title === "string" ? inner.title : undefined,
            content: typeof inner.content === "string" ? inner.content : undefined,
            visibility:
              inner.visibility === "private" || inner.visibility === "public"
                ? inner.visibility
                : undefined,
            // A string sets the emoji icon; explicit null clears it; anything
            // else (absent/malformed) leaves the icon untouched.
            icon:
              typeof inner.icon === "string" ? inner.icon : inner.icon === null ? null : undefined,
            // A string re-parents (nest); explicit null moves to root; anything
            // else leaves the parent untouched. A cycle throws PageCycleError,
            // caught by the outer switch handler → respondError.
            parentId:
              typeof inner.parentId === "string"
                ? inner.parentId
                : inner.parentId === null
                  ? null
                  : undefined,
            sortOrder: typeof inner.sortOrder === "number" ? inner.sortOrder : undefined,
          });
          if (!page) {
            respondError("page not found");
            break;
          }
          respond("cyborg:update_page_response", { page });
          broadcastToGuests(page.workspaceId, {
            type: "cyborg:pages_changed",
            payload: {
              workspaceId: page.workspaceId,
              projectId: page.projectId,
              op: "updated",
              // Strip a private page to id+visibility so its title/content never
              // fans out to non-owners; public + null-owner pages broadcast in full.
              page: pageBroadcastPayload(page),
            },
          });
          break;
        }

        case "cyborg:set_page_archived": {
          const pageId = typeof inner.pageId === "string" ? inner.pageId : undefined;
          const archived = typeof inner.archived === "boolean" ? inner.archived : undefined;
          if (!pageId || typeof archived !== "boolean") {
            respondError("pageId and archived required");
            break;
          }
          const pageProjectId = await pg.getPageProjectId(pageId);
          if (!pageProjectId || !(await pg.assertProjectVisible(pageProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          // Owner-gate: a non-null-owner private page is archivable only by its owner.
          const currentPage = await pg.getPageById(pageId);
          if (currentPage && isPageRestrictedFromUser(currentPage, guest.userId)) {
            respondError("forbidden");
            break;
          }
          const page = await pg.setPageArchived(pageId, archived);
          if (!page) {
            respondError("page not found");
            break;
          }
          respond("cyborg:set_page_archived_response", { page });
          broadcastToGuests(page.workspaceId, {
            type: "cyborg:pages_changed",
            payload: {
              workspaceId: page.workspaceId,
              projectId: page.projectId,
              op: "updated",
              // Strip a private page to id+visibility so its title/content never
              // fans out to non-owners; public + null-owner pages broadcast in full.
              page: pageBroadcastPayload(page),
            },
          });
          break;
        }

        case "cyborg:delete_page": {
          const pageId = typeof inner.pageId === "string" ? inner.pageId : undefined;
          if (!pageId) {
            respondError("pageId required");
            break;
          }
          const pageProjectId = await pg.getPageProjectId(pageId);
          if (!pageProjectId || !(await pg.assertProjectVisible(pageProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          // Capture identity for the broadcast before the row is gone.
          const page = await pg.getPageById(pageId);
          // Owner-gate: a non-null-owner private page is deletable only by its owner.
          if (page && isPageRestrictedFromUser(page, guest.userId)) {
            respondError("forbidden");
            break;
          }
          await pg.deletePage(pageId);
          respond("cyborg:delete_page_response", { deleted: true });
          if (page) {
            broadcastToGuests(page.workspaceId, {
              type: "cyborg:pages_changed",
              payload: {
                workspaceId: page.workspaceId,
                projectId: page.projectId,
                op: "deleted",
                page: { id: page.id },
              },
            });
          }
          break;
        }

        // ─── Modules catalog CRUD ────────────────────────────────────────
        case "cyborg:create_module": {
          const projectId = inner.projectId as string | undefined;
          const name = inner.name as string | undefined;
          if (!projectId || !name) {
            respondError("projectId and name required");
            break;
          }
          if (!(await pg.assertProjectVisible(projectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const moduleRow = await pg.insertModule({
            projectId,
            name,
            description: (inner.description as string | null | undefined) ?? null,
            status: (inner.status as string | null | undefined) ?? null,
          });
          respond("cyborg:create_module_response", { module: moduleRow });
          break;
        }

        case "cyborg:update_module": {
          const moduleId = inner.moduleId as string | undefined;
          if (!moduleId) {
            respondError("moduleId required");
            break;
          }
          const moduleProjectId = await pg.getModuleProjectId(moduleId);
          if (!moduleProjectId || !(await pg.assertProjectVisible(moduleProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const moduleRow = await pg.updateModule(moduleId, {
            name: inner.name as string | undefined,
            description: inner.description as string | null | undefined,
            status: inner.status as string | undefined,
          });
          if (!moduleRow) {
            respondError("module not found");
            break;
          }
          respond("cyborg:update_module_response", { module: moduleRow });
          break;
        }

        case "cyborg:delete_module": {
          const moduleId = inner.moduleId as string | undefined;
          if (!moduleId) {
            respondError("moduleId required");
            break;
          }
          const moduleProjectId = await pg.getModuleProjectId(moduleId);
          if (!moduleProjectId || !(await pg.assertProjectVisible(moduleProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          await pg.deleteModule(moduleId);
          respond("cyborg:delete_module_response", { deleted: true });
          break;
        }

        case "cyborg:fetch_task_activity": {
          const taskId = inner.taskId as string | undefined;
          if (!taskId) {
            respondError("taskId required");
            break;
          }
          // Gate the feed via the task's project: resolve task→project, then run
          // the same visibility predicate. A missing task or invisible project →
          // forbidden (never leak a feed from a project the caller can't see).
          const taskProjectId = await pg.getTaskProjectId(taskId);
          if (!taskProjectId || !(await pg.assertProjectVisible(taskProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const activity = await pg.getTaskActivity(taskId);
          respond("cyborg:fetch_task_activity_response", { activity });
          break;
        }

        // ─── Task links (external URLs) ──────────────────────────────────
        // add/fetch carry the taskId; remove carries the linkId, so the link is
        // first resolved to its task's project, then gated. Visibility (channel
        // membership / owner-admin) is the gate, matching fetch_task_activity.
        case "cyborg:add_task_link": {
          const taskId = inner.taskId as string | undefined;
          const url = inner.url as string | undefined;
          if (!taskId || !url) {
            respondError("taskId and url required");
            break;
          }
          const taskProjectId = await pg.getTaskProjectId(taskId);
          if (!taskProjectId || !(await pg.assertProjectVisible(taskProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const link = await pg.addTaskLink({
            taskId,
            url,
            title: (inner.title as string | null | undefined) ?? null,
            createdBy: guest.userId,
          });
          respond("cyborg:add_task_link_response", { link });
          break;
        }

        case "cyborg:remove_task_link": {
          const linkId = inner.linkId as string | undefined;
          if (!linkId) {
            respondError("linkId required");
            break;
          }
          const linkProjectId = await pg.getTaskLinkProjectId(linkId);
          if (!linkProjectId || !(await pg.assertProjectVisible(linkProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          await pg.removeTaskLink(linkId);
          respond("cyborg:remove_task_link_response", { deleted: true });
          break;
        }

        case "cyborg:fetch_task_links": {
          const taskId = inner.taskId as string | undefined;
          if (!taskId) {
            respondError("taskId required");
            break;
          }
          const taskProjectId = await pg.getTaskProjectId(taskId);
          if (!taskProjectId || !(await pg.assertProjectVisible(taskProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const links = await pg.getTaskLinks(taskId);
          respond("cyborg:fetch_task_links_response", { links });
          break;
        }

        // ─── Task attachments (S3 asset rows) ────────────────────────────
        // The client uploads the bytes via the existing HTTP presign route, then
        // calls add_task_attachment with the resulting key + delivery url so the
        // row persists. Gated by the task's project visibility, like links.
        case "cyborg:add_task_attachment": {
          const taskId = inner.taskId as string | undefined;
          const key = inner.key as string | undefined;
          const url = inner.url as string | undefined;
          const name = inner.name as string | undefined;
          const size = inner.size as number | undefined;
          if (!taskId || !key || !url || !name || typeof size !== "number") {
            respondError("taskId, key, url, name and size required");
            break;
          }
          const taskProjectId = await pg.getTaskProjectId(taskId);
          if (!taskProjectId || !(await pg.assertProjectVisible(taskProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const attachment = await pg.addTaskAttachment({
            taskId,
            key,
            url,
            name,
            size,
            contentType: (inner.contentType as string | null | undefined) ?? null,
            uploadedBy: guest.userId,
          });
          respond("cyborg:add_task_attachment_response", { attachment });
          break;
        }

        case "cyborg:remove_task_attachment": {
          const attachmentId = inner.attachmentId as string | undefined;
          if (!attachmentId) {
            respondError("attachmentId required");
            break;
          }
          const attProjectId = await pg.getTaskAttachmentProjectId(attachmentId);
          if (!attProjectId || !(await pg.assertProjectVisible(attProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          await pg.removeTaskAttachment(attachmentId);
          respond("cyborg:remove_task_attachment_response", { deleted: true });
          break;
        }

        case "cyborg:fetch_task_attachments": {
          const taskId = inner.taskId as string | undefined;
          if (!taskId) {
            respondError("taskId required");
            break;
          }
          const taskProjectId = await pg.getTaskProjectId(taskId);
          if (!taskProjectId || !(await pg.assertProjectVisible(taskProjectId, guest.userId))) {
            respondError("forbidden");
            break;
          }
          const attachments = await pg.getTaskAttachments(taskId);
          respond("cyborg:fetch_task_attachments_response", { attachments });
          break;
        }

        case "cyborg:update_workspace": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner" && callerRole !== "admin") {
            respondError("forbidden");
            break;
          }
          const updates: {
            name?: string;
            avatarUrl?: string | null;
            settings?: Record<string, unknown>;
          } = {};
          if (typeof inner.name === "string" && inner.name.trim()) updates.name = inner.name.trim();
          if (inner.avatarUrl !== undefined) updates.avatarUrl = inner.avatarUrl as string | null;
          if (inner.settings !== undefined && typeof inner.settings === "object") {
            updates.settings = inner.settings as Record<string, unknown>;
          }
          await pg.updateWorkspace(workspaceId, updates);
          respond("cyborg:update_workspace_response", { ok: true });
          break;
        }
        case "cyborg:delete_workspace": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner") {
            respondError("only the workspace owner can delete it");
            break;
          }
          await pg.deleteWorkspace(workspaceId);
          respond("cyborg:delete_workspace_response", { ok: true });
          break;
        }
        case "cyborg:set_profile_image": {
          const imageUrl = inner.imageUrl === null ? null : (inner.imageUrl as string);
          await pg.updateUserImage(guest.userId, imageUrl);
          respond("cyborg:set_profile_image_response", { ok: true, imageUrl });
          // Refresh member lists across the user's workspaces so others see the
          // new avatar without reloading.
          const userWorkspaces = await pg.getWorkspacesForUser(guest.userId);
          // Fetch every workspace's member list in parallel (was a sequential
          // N+1: one awaited getMembers per workspace inside the loop).
          const memberLists = await Promise.all(userWorkspaces.map((w) => pg.getMembers(w.id)));
          userWorkspaces.forEach((w, i) => {
            relay.injectMessage(w.id, {
              type: "cyborg:members_updated",
              payload: { workspaceId: w.id, members: memberLists[i] },
            });
          });
          break;
        }

        case "cyborg:set_profile_name": {
          const name = typeof inner.name === "string" ? inner.name.trim() : "";
          if (!name) {
            respondError("name required");
            break;
          }
          await pg.updateUserName(guest.userId, name);
          respond("cyborg:set_profile_name_response", { ok: true, name });
          // Mirror set_profile_image: refresh member lists so the new display
          // name shows for everyone without a reload.
          const userWorkspaces = await pg.getWorkspacesForUser(guest.userId);
          // Fetch every workspace's member list in parallel (was a sequential
          // N+1: one awaited getMembers per workspace inside the loop).
          const memberLists = await Promise.all(userWorkspaces.map((w) => pg.getMembers(w.id)));
          userWorkspaces.forEach((w, i) => {
            relay.injectMessage(w.id, {
              type: "cyborg:members_updated",
              payload: { workspaceId: w.id, members: memberLists[i] },
            });
          });
          break;
        }

        // Per-user, display-only session alias. PG-direct via guest.userId (never
        // shared). Empty/whitespace alias = delete (back to the default name).
        case "cyborg:set_session_alias": {
          const aliasAgentId = typeof inner.agentId === "string" ? inner.agentId : "";
          if (!aliasAgentId) {
            respondError("agentId required");
            break;
          }
          const aliasText = typeof inner.alias === "string" ? inner.alias.trim() : "";
          if (aliasText) {
            await pg.setSessionAlias(guest.userId, aliasAgentId, aliasText);
          } else {
            await pg.deleteSessionAlias(guest.userId, aliasAgentId);
          }
          respond("cyborg:set_session_alias_response", { ok: true });
          break;
        }

        case "cyborg:get_session_aliases": {
          const aliases = await pg.getSessionAliases(guest.userId);
          respond("cyborg:get_session_aliases_response", { aliases });
          break;
        }

        // Per-user, display-only terminal alias (cross-device synced). PG-direct
        // via guest.userId (never shared — terminals are private to their owner).
        // Empty/whitespace alias = delete (back to the pty title). After the write
        // we fan the change out to the user's OTHER clients (owner-scoped via
        // toUserId, like terminals_changed) so a rename on one device shows live
        // on the rest. workspaceId is a routing hint only, not part of the key.
        case "cyborg:set_terminal_alias": {
          const aliasTerminalId = typeof inner.terminalId === "string" ? inner.terminalId : "";
          if (!aliasTerminalId) {
            respondError("terminalId required");
            break;
          }
          // Require alias to be a string: a missing/malformed field must NOT be
          // coerced to "" (which would silently delete an existing alias). An
          // explicit empty string is still a legitimate "clear".
          if (typeof inner.alias !== "string") {
            respondError("alias must be a string");
            break;
          }
          const aliasText = inner.alias.trim();
          if (aliasText) {
            await pg.setTerminalAlias(guest.userId, aliasTerminalId, aliasText);
          } else {
            await pg.deleteTerminalAlias(guest.userId, aliasTerminalId);
          }
          respond("cyborg:set_terminal_alias_response", { ok: true });
          const aliasWorkspaceId = typeof inner.workspaceId === "string" ? inner.workspaceId : "";
          if (aliasWorkspaceId) {
            broadcastToGuests(aliasWorkspaceId, {
              type: "cyborg:terminal_alias_changed",
              payload: {
                terminalId: aliasTerminalId,
                alias: aliasText,
                toUserId: guest.userId,
              },
            });
          }
          break;
        }

        case "cyborg:get_terminal_aliases": {
          const aliases = await pg.getTerminalAliases(guest.userId);
          respond("cyborg:get_terminal_aliases_response", { aliases });
          break;
        }

        case "cyborg:list_members": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const members = await pg.getMembers(workspaceId);
          respond("cyborg:list_members_response", { members });
          break;
        }

        case "cyborg:sync": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const SYNC_PAGE = 500;
          const lastSeq = (inner.lastSeq as number) ?? 0;
          // Fetch one extra to detect more pages. seq is monotonic per relay
          // instance (reseeded from DB max on restart), so it's a safe cursor.
          const msgs = await pg.getMessagesSince(workspaceId, lastSeq, SYNC_PAGE + 1);
          const hasMore = msgs.length > SYNC_PAGE;
          const page = hasMore ? msgs.slice(0, SYNC_PAGE) : msgs;
          const nextSeq = page.length > 0 ? page[page.length - 1].seq : lastSeq;
          respond("cyborg:sync_response", {
            // snapshot only on a cold start (no cursor); otherwise it's a delta
            // the client appends — basing "snapshot" on row count wrongly wiped
            // history the client legitimately had.
            mode: lastSeq === 0 ? "snapshot" : "delta",
            messages: page.map(mapMessage),
            hasMore,
            nextSeq,
          });
          break;
        }

        case "cyborg:fetch_projects": {
          if (!workspaceId) break;
          // Tasks Redesign GATE (fail-closed): scope the chat-project list to what
          // this caller may see. pg.getProjects applies the visibility filter when a
          // userId is present (a project tagged on a channel the user belongs to, or
          // any project for owner/admin). The channel→project links are then
          // filtered to those same visible project ids so a private-channel binding
          // never leaks to a non-member.
          const [projs, cps] = await Promise.all([
            pg.getProjects(workspaceId, guest.userId),
            pg.getChannelProjects(workspaceId),
          ]);
          const visibleProjIds = new Set(projs.map((p) => p.id));
          respond("cyborg:fetch_projects_response", {
            projects: projs,
            channelProjects: cps.filter((cp) => visibleProjIds.has(cp.projectId)),
          });
          break;
        }

        case "cyborg:create_project":
          await handleCreateProject(guestCtx, inner);
          break;

        case "cyborg:update_project":
          await handleUpdateProject(guestCtx, inner);
          break;

        case "cyborg:delete_project":
          await handleDeleteProject(guestCtx, inner);
          break;

        case "cyborg:set_channel_project":
          await handleSetChannelProject(guestCtx, inner);
          break;

        // Schedule list is answered from the PG mirror so cloud/DMG users see
        // their schedules even when the owning daemon is offline (internal docs
        // §3.2). Read-only — the runner still executes off SQLite, so a stale
        // mirror can't double-fire. Writes are forwarded to the daemon above.
        case "cyborg:list_schedules": {
          if (!workspaceId) break;
          const reqCyboId = inner.cyboId as string | undefined;
          // Annotate each schedule with `stale` (#619 §3.3): overdue + the owning
          // daemon gone (no live daemon serves the workspace). Computed at read
          // time against the heartbeat registry — read-only, never feeds execution.
          const [rows, cybos] = await Promise.all([
            pg.listSchedulesWithStaleness(workspaceId),
            pg.getCybos(workspaceId),
          ]);
          const cyboNameById = new Map(cybos.map((c) => [c.id, c.name]));
          const filtered = reqCyboId ? rows.filter((s) => s.cybo_id === reqCyboId) : rows;
          respond("cyborg:schedule_list_response", {
            schedules: filtered.map((s) => ({
              id: s.id,
              workspaceId: s.workspace_id,
              cyboId: s.cybo_id,
              cyboName: cyboNameById.get(s.cybo_id) ?? null,
              channelId: s.channel_id,
              taskId: s.task_id,
              cron: s.cron_expr,
              timezone: s.timezone,
              prompt: s.prompt,
              enabled: s.enabled === 1,
              lastRunAt: s.last_run_at,
              nextRunAt: s.next_run_at,
              maxRuns: s.max_runs,
              runCount: s.run_count,
              catchUp: s.catch_up === 1,
              stale: s.stale,
              createdBy: s.created_by,
              createdAt: s.created_at,
            })),
          });
          break;
        }

        // Run history for a schedule (the "Last runs" drawer, #619). Answered from
        // the PG mirror so cloud/DMG users see history even when the daemon is
        // asleep — read-only, like list_schedules. Scoped to the workspace.
        case "cyborg:list_schedule_runs": {
          if (!workspaceId) break;
          // typeof guard (not `as`) — untrusted JSON; require a string id.
          const scheduleId = typeof inner.scheduleId === "string" ? inner.scheduleId : null;
          if (!scheduleId) break;
          const limit = typeof inner.limit === "number" ? inner.limit : undefined;
          const schedule = await pg.getSchedule(scheduleId);
          const runs =
            schedule && schedule.workspace_id === workspaceId
              ? await pg.listScheduleRuns(scheduleId, limit)
              : [];
          respond("cyborg:schedule_runs_response", {
            scheduleId,
            runs: runs.map((r) => ({
              id: r.id,
              scheduleId: r.schedule_id,
              scheduledFor: r.scheduled_for,
              startedAt: r.started_at,
              endedAt: r.ended_at,
              status: r.status,
              skipReason: r.skip_reason,
              agentId: r.agent_id,
              error: r.error,
            })),
          });
          break;
        }

        // "Send later" (#607): persist a scheduled message. The relay's PG mirror
        // is the single source of truth + the single firer (claimDueScheduled
        // Messages, FOR UPDATE SKIP LOCKED), so the create/list/cancel writes are
        // answered here directly — never forwarded to a daemon.
        case "cyborg:schedule_message_create": {
          if (!workspaceId) break;
          // Untrusted JSON — typeof guards, not `as`.
          const channelId = typeof inner.channelId === "string" ? inner.channelId : null;
          const toId = typeof inner.toId === "string" ? inner.toId : null;
          const text = typeof inner.text === "string" ? inner.text : "";
          const sendAt = typeof inner.sendAt === "number" ? inner.sendAt : null;
          const mentions =
            Array.isArray(inner.mentions) &&
            (inner.mentions as unknown[]).every((m) => typeof m === "string")
              ? (inner.mentions as string[])
              : null;
          // EXACTLY ONE of channelId / toId — a channel post or a DM, not both/neither.
          if ((channelId === null) === (toId === null)) {
            respond("cyborg:schedule_message_create_response", {
              ok: false,
              op: "create",
              error: "Specify exactly one of a channel or a DM recipient.",
            });
            break;
          }
          if (text.trim().length === 0) {
            respond("cyborg:schedule_message_create_response", {
              ok: false,
              op: "create",
              error: "Write something to send.",
            });
            break;
          }
          if (sendAt === null || !Number.isFinite(sendAt) || sendAt <= Date.now()) {
            respond("cyborg:schedule_message_create_response", {
              ok: false,
              op: "create",
              error: "Pick a time in the future.",
            });
            break;
          }
          // Authority: viewers (and non-members) can't send messages here.
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (!role || role === "viewer") {
            respond("cyborg:schedule_message_create_response", {
              ok: false,
              op: "create",
              error: "You can't send messages in this workspace.",
            });
            break;
          }
          if (channelId !== null) {
            const ch = await pg.getChannel(channelId);
            if (!ch || ch.workspace_id !== workspaceId) {
              respond("cyborg:schedule_message_create_response", {
                ok: false,
                op: "create",
                error: "Channel not found.",
              });
              break;
            }
            if (ch.is_archived === 1) {
              respond("cyborg:schedule_message_create_response", {
                ok: false,
                op: "create",
                error: "Channel is archived.",
              });
              break;
            }
          }
          const row: StoredScheduledMessage = {
            id: `schedmsg_${randomUUID()}`,
            workspace_id: workspaceId,
            channel_id: channelId,
            to_id: toId,
            from_id: guest.userId,
            text,
            mentions: mentions && mentions.length > 0 ? JSON.stringify(mentions) : null,
            send_at: sendAt,
            processed_at: null,
            error_code: null,
            created_at: Date.now(),
          };
          await pg.createScheduledMessage(row);
          respond("cyborg:schedule_message_create_response", {
            ok: true,
            op: "create",
            message: scheduledMessageView(row),
          });
          break;
        }

        // The author's scheduled messages (pending + processed) for this workspace.
        case "cyborg:schedule_message_list": {
          if (!workspaceId) break;
          const rows = await pg.listScheduledMessages(workspaceId, guest.userId);
          respond("cyborg:schedule_message_list_response", {
            messages: rows.map(scheduledMessageView),
          });
          break;
        }

        // Cancel a still-pending scheduled message (the author's own only). An
        // already-sent (processed) row can't be unsent.
        case "cyborg:schedule_message_cancel": {
          if (!workspaceId) break;
          const id = typeof inner.id === "string" ? inner.id : "";
          const existing = await pg.getScheduledMessage(id);
          if (
            !existing ||
            existing.workspace_id !== workspaceId ||
            existing.from_id !== guest.userId
          ) {
            respond("cyborg:schedule_message_cancel_response", {
              ok: false,
              op: "cancel",
              id,
              error: "Scheduled message not found.",
            });
            break;
          }
          if (existing.processed_at !== null) {
            respond("cyborg:schedule_message_cancel_response", {
              ok: false,
              op: "cancel",
              id,
              error: "This message already sent.",
            });
            break;
          }
          await pg.deleteScheduledMessage(id);
          respond("cyborg:schedule_message_cancel_response", { ok: true, op: "cancel", id });
          break;
        }

        // ─── Outgoing webhooks (#598) ───────────────────────────────
        // WORKSPACE-LEVEL config (like channels/cybos): the relay authorizes from
        // the authoritative PG role and mutates PG directly — NOT a daemon-forward.
        // A workspace MEMBER (non-viewer) may create/manage; created_by is recorded.
        // The signing secret is generated here, stored HASHED, and returned to the
        // client ONCE on create/regenerate — never re-shown, never logged.
        case "cyborg:create_outgoing_webhook": {
          if (!workspaceId) break;
          const channelId = typeof inner.channelId === "string" ? inner.channelId : "";
          const url = typeof inner.url === "string" ? inner.url : "";
          const name = typeof inner.name === "string" ? inner.name : undefined;
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (!role || role === "viewer") {
            respond("cyborg:outgoing_webhook_mutated", {
              ok: false,
              op: "create",
              id: null,
              error: "You can't create webhooks in this workspace.",
            });
            break;
          }
          const urlError = validateWebhookUrl(url);
          if (urlError) {
            respond("cyborg:outgoing_webhook_mutated", {
              ok: false,
              op: "create",
              id: null,
              error: urlError,
            });
            break;
          }
          const ch = await pg.getChannel(channelId);
          if (!ch || ch.workspace_id !== workspaceId) {
            respond("cyborg:outgoing_webhook_mutated", {
              ok: false,
              op: "create",
              id: null,
              error: "Channel not found.",
            });
            break;
          }
          const secret = generateWebhookSecret();
          const events =
            inner.events && typeof inner.events === "object"
              ? normalizeEventFlags(inner.events)
              : { "message.created": true };
          const webhook = await pg.createOutgoingWebhook({
            id: newOutgoingWebhookId(),
            workspaceId,
            channelId,
            url,
            secretKeyHash: secret.hash,
            name,
            events,
            createdBy: guest.userId,
          });
          respond("cyborg:outgoing_webhook_mutated", {
            ok: true,
            op: "create",
            id: webhook.id,
            webhook,
            secret: secret.raw,
          });
          break;
        }

        // ─── Prompt templates (#602 — reusable composer snippets) ────
        // Workspace config (like create_channel / create_cybo above): RELAY-
        // authoritative, mutated straight in PG and member-gated from the
        // AUTHORITATIVE PG role (viewers/non-members refused). The name is a
        // per-workspace unique handle; a create/rename clash maps to a friendly
        // error instead of the UNIQUE throw.
        case "cyborg:create_prompt_template": {
          if (!workspaceId) {
            respond("cyborg:create_prompt_template_response", {
              ok: false,
              op: "create",
              error: "workspaceId required",
            });
            break;
          }
          const ptRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!ptRole || ptRole === "viewer") {
            respond("cyborg:create_prompt_template_response", {
              ok: false,
              op: "create",
              error: "You can't manage prompt templates in this workspace.",
            });
            break;
          }
          const name = (typeof inner.name === "string" ? inner.name : "").trim();
          const body = typeof inner.body === "string" ? inner.body : "";
          if (name.length === 0 || name.length > 100) {
            respond("cyborg:create_prompt_template_response", {
              ok: false,
              op: "create",
              error: "Template name must be 1–100 characters.",
            });
            break;
          }
          const validation = validatePromptTemplate(body);
          if (!validation.ok || body.length > 10_000) {
            respond("cyborg:create_prompt_template_response", {
              ok: false,
              op: "create",
              error: validation.error ?? "Invalid template body.",
            });
            break;
          }
          if (await pg.getPromptTemplateByName(workspaceId, name)) {
            respond("cyborg:create_prompt_template_response", {
              ok: false,
              op: "create",
              error: `A template named "${name}" already exists.`,
            });
            break;
          }
          const ptRow: StoredPromptTemplate = {
            id: `ptmpl_${randomUUID()}`,
            workspace_id: workspaceId,
            name,
            body,
            created_by: guest.userId,
            created_at: Date.now(),
          };
          await pg.createPromptTemplate(ptRow);
          respond("cyborg:create_prompt_template_response", {
            ok: true,
            op: "create",
            template: promptTemplateView(ptRow),
          });
          break;
        }

        case "cyborg:update_outgoing_webhook": {
          if (!workspaceId) break;
          const id = typeof inner.id === "string" ? inner.id : "";
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (!role || role === "viewer") {
            respond("cyborg:outgoing_webhook_mutated", {
              ok: false,
              op: "update",
              id,
              error: "You can't manage webhooks in this workspace.",
            });
            break;
          }
          const newUrl = typeof inner.url === "string" ? inner.url : undefined;
          if (newUrl !== undefined) {
            const urlError = validateWebhookUrl(newUrl);
            if (urlError) {
              respond("cyborg:outgoing_webhook_mutated", {
                ok: false,
                op: "update",
                id,
                error: urlError,
              });
              break;
            }
          }
          const regenerate = inner.regenerateSecret === true;
          const secret = regenerate ? generateWebhookSecret() : null;
          const webhook = await pg.updateOutgoingWebhook(id, workspaceId, {
            name: typeof inner.name === "string" ? inner.name : undefined,
            url: newUrl,
            events:
              inner.events && typeof inner.events === "object"
                ? normalizeEventFlags(inner.events)
                : undefined,
            isActive: typeof inner.isActive === "boolean" ? inner.isActive : undefined,
            secretKeyHash: secret?.hash,
          });
          if (!webhook) {
            respond("cyborg:outgoing_webhook_mutated", {
              ok: false,
              op: "update",
              id,
              error: "Webhook not found.",
            });
            break;
          }
          respond("cyborg:outgoing_webhook_mutated", {
            ok: true,
            op: "update",
            id: webhook.id,
            webhook,
            ...(secret ? { secret: secret.raw } : {}),
          });
          break;
        }

        case "cyborg:update_prompt_template": {
          if (!workspaceId) {
            respond("cyborg:update_prompt_template_response", {
              ok: false,
              op: "update",
              error: "workspaceId required",
            });
            break;
          }
          const ptRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!ptRole || ptRole === "viewer") {
            respond("cyborg:update_prompt_template_response", {
              ok: false,
              op: "update",
              error: "You can't manage prompt templates in this workspace.",
            });
            break;
          }
          const ptId = typeof inner.id === "string" ? inner.id : "";
          const existing = await pg.getPromptTemplate(ptId);
          if (!existing || existing.workspace_id !== workspaceId) {
            respond("cyborg:update_prompt_template_response", {
              ok: false,
              op: "update",
              error: "Template not found.",
            });
            break;
          }
          const hasName = typeof inner.name === "string";
          const hasBody = typeof inner.body === "string";
          const name = hasName ? (inner.name as string).trim() : undefined;
          const body = hasBody ? (inner.body as string) : undefined;
          if (hasName && (name === undefined || name.length === 0 || name.length > 100)) {
            respond("cyborg:update_prompt_template_response", {
              ok: false,
              op: "update",
              error: "Template name must be 1–100 characters.",
            });
            break;
          }
          if (body !== undefined) {
            const validation = validatePromptTemplate(body);
            if (!validation.ok || body.length > 10_000) {
              respond("cyborg:update_prompt_template_response", {
                ok: false,
                op: "update",
                error: validation.error ?? "Invalid template body.",
              });
              break;
            }
          }
          if (name === undefined && body === undefined) {
            respond("cyborg:update_prompt_template_response", {
              ok: false,
              op: "update",
              error: "Nothing to update.",
            });
            break;
          }
          if (name !== undefined && name !== existing.name) {
            const clash = await pg.getPromptTemplateByName(workspaceId, name);
            if (clash && clash.id !== ptId) {
              respond("cyborg:update_prompt_template_response", {
                ok: false,
                op: "update",
                error: `A template named "${name}" already exists.`,
              });
              break;
            }
          }
          await pg.updatePromptTemplate(ptId, {
            ...(name !== undefined ? { name } : {}),
            ...(body !== undefined ? { body } : {}),
          });
          const updated = await pg.getPromptTemplate(ptId);
          respond("cyborg:update_prompt_template_response", {
            ok: true,
            op: "update",
            ...(updated ? { template: promptTemplateView(updated) } : {}),
          });
          break;
        }

        case "cyborg:delete_outgoing_webhook": {
          if (!workspaceId) break;
          const id = typeof inner.id === "string" ? inner.id : "";
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (!role || role === "viewer") {
            respond("cyborg:outgoing_webhook_mutated", {
              ok: false,
              op: "delete",
              id,
              error: "You can't manage webhooks in this workspace.",
            });
            break;
          }
          const deleted = await pg.deleteOutgoingWebhook(id, workspaceId);
          respond("cyborg:outgoing_webhook_mutated", {
            ok: deleted,
            op: "delete",
            id,
            ...(deleted ? {} : { error: "Webhook not found." }),
          });
          break;
        }

        case "cyborg:delete_prompt_template": {
          if (!workspaceId) {
            respond("cyborg:delete_prompt_template_response", {
              ok: false,
              op: "delete",
              id: "",
              error: "workspaceId required",
            });
            break;
          }
          const ptRole = await pg.getMemberRole(workspaceId, guest.userId);
          const ptId = typeof inner.id === "string" ? inner.id : "";
          if (!ptRole || ptRole === "viewer") {
            respond("cyborg:delete_prompt_template_response", {
              ok: false,
              op: "delete",
              id: ptId,
              error: "You can't manage prompt templates in this workspace.",
            });
            break;
          }
          const existing = await pg.getPromptTemplate(ptId);
          if (!existing || existing.workspace_id !== workspaceId) {
            respond("cyborg:delete_prompt_template_response", {
              ok: false,
              op: "delete",
              id: ptId,
              error: "Template not found.",
            });
            break;
          }
          await pg.deletePromptTemplate(ptId);
          respond("cyborg:delete_prompt_template_response", { ok: true, op: "delete", id: ptId });
          break;
        }

        case "cyborg:fetch_outgoing_webhooks": {
          if (!workspaceId) break;
          // Any member may list — the view never carries the secret.
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (!role) {
            respond("cyborg:fetch_outgoing_webhooks_response", { webhooks: [] });
            break;
          }
          const channelFilter = typeof inner.channelId === "string" ? inner.channelId : undefined;
          const webhooks = await pg.listOutgoingWebhooks(workspaceId, channelFilter);
          respond("cyborg:fetch_outgoing_webhooks_response", { webhooks });
          break;
        }

        // Any workspace member may read the templates; a non-member gets an empty
        // list rather than foreign config.
        case "cyborg:list_prompt_templates": {
          if (!workspaceId) {
            respond("cyborg:list_prompt_templates_response", { templates: [] });
            break;
          }
          const ptRole = await pg.getMemberRole(workspaceId, guest.userId);
          const templates = ptRole ? await pg.listPromptTemplates(workspaceId) : [];
          respond("cyborg:list_prompt_templates_response", {
            templates: templates.map(promptTemplateView),
          });
          break;
        }

        case "cyborg:channel_message": {
          if (!workspaceId) break;
          const chId = inner.channelId as string;
          // `let` because a #602 template send is expanded SERVER-SIDE below,
          // once the target channel + sender are resolved (cloud path mirror of
          // message-router.handleChannelMessage). Ordinary sends pass through.
          let text = inner.text as string;
          const hasAttachments = Array.isArray(inner.attachments) && inner.attachments.length > 0;
          if (!chId || (!text && !hasAttachments)) break;
          // Authorization: viewers can't post; private channels require membership.
          const posterRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!posterRole || posterRole === "viewer") {
            respondError("you can't post in this workspace");
            break;
          }
          const targetChannel = await pg.getChannel(chId);
          if (!targetChannel || targetChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          if (targetChannel.is_private && !(await pg.getChannelMemberRole(chId, guest.userId))) {
            respondError("not a member of this channel");
            break;
          }
          const user = await pg.getUserById(guest.userId);
          // #602 — composer prompt template: expand {channel}/{user}/{date} with
          // the FINAL context (this channel, the sender, today's date), HTML-
          // escaped inside expandPromptTemplate. Only template sends set the flag,
          // so an ordinary message with literal braces is left byte-identical.
          if (inner.expandTemplate === true) {
            text = expandPromptTemplate(text, {
              channel: targetChannel.name,
              user: user?.name ?? user?.email ?? undefined,
              date: formatTemplateDate(new Date()),
            });
          }
          const msgId = randomUUID();
          // Thread reply: carry the parent so it actually threads (was hardcoded
          // null, which silently dropped every reply's thread link in cloud).
          const replyParentId = (inner.parentId as string) || null;
          relay.injectMessage(
            workspaceId,
            {
              type: "cyborg:channel_message_broadcast" as const,
              payload: {
                id: msgId,
                workspaceId,
                channelId: chId,
                fromId: guest.userId,
                fromType: "human" as const,
                fromName: user?.name ?? null,
                toId: null,
                text,
                mentions: (inner.mentions as string[]) ?? null,
                parentId: replyParentId,
                attachments: Array.isArray(inner.attachments)
                  ? (inner.attachments as unknown[]).slice(0, 10)
                  : null,
                // Echo the client-generated id (#501) so the sender reconciles the
                // broadcast to its exact optimistic bubble — disambiguates two
                // identical consecutive sends / retries. Not persisted; absent
                // from older clients (then the client falls back to fromId+text).
                // typeof guard (not `as`) — untrusted JSON.
                clientMsgId: typeof inner.clientMsgId === "string" ? inner.clientMsgId : null,
                createdAt: Date.now(),
              },
            },
            "guest",
          );
          // Outgoing webhooks (#598): a channel post → message.created event for
          // any active webhook on this channel. Fire-and-forget; never blocks the
          // post path. Thread replies count as channel messages (they have chId).
          void enqueueWebhookEvent({
            pg,
            logger: relayLog,
            eventType: "message.created",
            workspaceId,
            channelId: chId,
            messageId: msgId,
            text,
            fromId: guest.userId,
            fromName: user?.name ?? null,
            createdAt: Date.now(),
          });
          // Cloud cybo-mention invocation (P0 of the mentions audit): resolve
          // "@cybo" mentions against the channel's cybo MEMBERS and forward
          // spawn+prompt to a slash-style-picked daemon (workspace slash default
          // → fallbacks → single online → the cybo creator's online daemon).
          // Fire-and-forget — never blocks or poisons the post path; failures
          // surface as an author-only ephemeral notice (P2).
          if (Array.isArray(inner.mentions) && (inner.mentions as string[]).length > 0) {
            const mentionAuthorName = user?.name ?? user?.email ?? "Someone";
            void invokeMentionedCybosViaRelay(
              {
                pg,
                getOnlineDaemonIds: () => relay.getConnectedDaemons(),
                getDaemonProviders: (daemonId) => relay.getDaemonProviders(daemonId),
                forwardInvoke: (daemonId, invoke) =>
                  relay.sendToDaemonInWorkspace(
                    workspaceId,
                    {
                      type: "cyborg:relay_rpc",
                      token: guest.token,
                      workspaceId,
                      guestId: guest.userId,
                      role: posterRole,
                      inner: { type: "cyborg:invoke_cybo_mention", ...invoke },
                    },
                    daemonId,
                  ),
                notifyAuthor: (noticeText) =>
                  broadcastToGuests(workspaceId, {
                    type: "cyborg:cybo_mention_notice",
                    payload: {
                      toUserId: guest.userId,
                      workspaceId,
                      channelId: chId,
                      text: noticeText,
                    },
                  }),
                log: (m) => relayLog.info(m),
                // Structured, alarmable events (#736): stable `event` tag + context
                // → pino JSON → journald → CloudWatch metric filters. Replaces the
                // user-only notices that made mention/capability failures invisible.
                onEvent: (level, event, fields) => {
                  relayLog[level]({ event, ...fields }, event);
                  // Re-route the mention/capability failure onto the Logs-tab
                  // audit stream (#995). The pino line above stays for CloudWatch.
                  relayAuditSink.emit({
                    kind: `mention.${event}`,
                    category: "invocation_decision",
                    level,
                    workspaceId,
                    channelId: chId,
                    source: "mention",
                    message: event,
                    payload: fields,
                  });
                },
              },
              {
                workspaceId,
                channelId: chId,
                channelName: targetChannel.name,
                channelDescription: targetChannel.description ?? null,
                messageId: msgId,
                text,
                mentions: inner.mentions as string[],
                authorId: guest.userId,
                authorName: mentionAuthorName,
                // Guest posts are always human-authored (agents post via the
                // daemon paths) — and only human posts may summon cybos.
                authorType: "human",
              },
            ).catch((err) =>
              relayLog.error(
                { event: "cybo_mention_failed", stage: "invocation", err },
                "cybo-mention invocation failed",
              ),
            );
          }
          // Tasks Phase 2 — channel watcher (cloud path). Fires on EVERY human
          // post (mentioned or not), gated cheap → expensive: auto_tasks_enabled
          // (opt-in) → per-channel agent_watch rate limit → then the chain/task
          // lookups + failover happen inside invokeChannelWatchersViaRelay. Guest
          // posts are always human-authored, so this is the human path; the
          // watcher's own task ops post via the daemon (agent) paths and never
          // reach here, so they can't re-trigger it. Fire-and-forget — never blocks
          // or poisons the post path. The whole thing is wrapped so a lookup throw
          // can't escape the post handler.
          void (async () => {
            // Logs tab observability (cloud path): fan a structured task-pipeline
            // event out to every workspace guest. Best-effort, never blocks the
            // watcher (mirrors the daemon's broadcastTaskEvent).
            const emitTaskEvent = (event: TaskLogEvent) => {
              try {
                broadcastToGuests(workspaceId, taskEventBroadcast(event));
              } catch {
                // observability is best-effort; a fan-out failure must not poison
                // the watcher path it rides on.
              }
            };
            // Map the watcher's structured pipeline events to task_event log lines.
            const watcherOnEvent = (
              level: "info" | "warn" | "error",
              event: string,
              fields: Record<string, unknown>,
            ) => {
              relayLog[level]({ event, ...fields }, event);
              const cn = (fields.channelName as string) ?? targetChannel.name;
              if (event === "channel_watch_fired") {
                emitTaskEvent({
                  kind: "watcher_fired",
                  workspaceId,
                  channelId: chId,
                  channelName: cn,
                  author: (fields.author as string) ?? "Someone",
                });
              } else if (event === "channel_watch_selected") {
                emitTaskEvent({
                  kind: "watcher_selected",
                  workspaceId,
                  channelId: chId,
                  cyboId: (fields.cyboId as string) ?? null,
                  channelName: cn,
                  cyboName: (fields.cyboName as string) ?? "cybo",
                  chainPosition: (fields.chainPosition as number) ?? 1,
                  chainLength: (fields.chainLength as number) ?? 1,
                });
              } else if (event === "channel_watch_no_cybo_members") {
                emitTaskEvent({
                  kind: "watcher_skipped",
                  workspaceId,
                  channelId: chId,
                  channelName: cn,
                  reason: "no_cybo_members",
                });
              } else if (event === "channel_watch_no_online_cybo") {
                emitTaskEvent({
                  kind: "watcher_skipped",
                  workspaceId,
                  channelId: chId,
                  channelName: cn,
                  reason: "no_online_cybo",
                });
              } else if (
                event === "channel_watch_forward_failed" ||
                event === "channel_watch_failed"
              ) {
                emitTaskEvent({
                  kind: "watcher_spawn_failed",
                  workspaceId,
                  channelId: chId,
                  cyboId: (fields.cyboId as string) ?? null,
                  channelName: cn,
                  cyboName: (fields.cyboSlug as string) ?? "cybo",
                  detail: (fields.stage as string) ?? "forward failed",
                });
              }
            };
            try {
              // Cheapest gate FIRST: the per-workspace autonomy master switch. When
              // a workspace turns autonomy OFF, no UN-mentioned channel watcher fires.
              // Kept SILENT (no task-event) like the auto-tasks-off case below so an
              // off workspace doesn't flood the Logs pane. @-mentions are UNAFFECTED:
              // this gate is only on the watcher path, not the mention path above.
              if (!(await pg.getWorkspaceAutonomyEnabled(workspaceId))) return;
              // auto-tasks-off is the steady state for most channels and would log
              // on every post — intentionally NOT surfaced (would flood the pane).
              if (!(await pg.getChannelAutoTasksEnabled(chId))) return;
              if (!watcherRateLimiter.check(chId, "agent_watch").allowed) {
                emitTaskEvent({
                  kind: "watcher_skipped",
                  workspaceId,
                  channelId: chId,
                  channelName: targetChannel.name,
                  reason: "rate_limited",
                });
                return;
              }
              await invokeChannelWatchersViaRelay(
                {
                  pg,
                  getOnlineDaemonIds: () => relay.getConnectedDaemons(),
                  getDaemonProviders: (daemonId) => relay.getDaemonProviders(daemonId),
                  forwardInvoke: (daemonId, invoke) =>
                    relay.sendToDaemonInWorkspace(
                      workspaceId,
                      {
                        type: "cyborg:relay_rpc",
                        token: guest.token,
                        workspaceId,
                        guestId: guest.userId,
                        role: posterRole,
                        inner: { type: "cyborg:invoke_channel_watch", ...invoke },
                      },
                      daemonId,
                    ),
                  log: (m) => relayLog.info(m),
                  onEvent: watcherOnEvent,
                },
                {
                  workspaceId,
                  channelId: chId,
                  channelName: targetChannel.name,
                  channelDescription: targetChannel.description ?? null,
                  messageId: msgId,
                  text,
                  authorId: guest.userId,
                  authorName: user?.name ?? user?.email ?? "Someone",
                  // Guest posts are always human-authored (agents post via the
                  // daemon paths) — only human posts may trigger the watcher.
                  authorType: "human",
                },
              );
            } catch (err) {
              relayLog.error(
                { event: "channel_watch_failed", stage: "invocation", err },
                "channel-watch invocation failed",
              );
            }
          })();
          // URL unfurls (Tier 2): fire-and-forget. The message row is persisted by
          // injectMessage above; the unfurl fetch is network-bound (seconds) so the
          // row exists well before setMessageUnfurls runs. On success, broadcast a
          // cyborg:message_unfurled event so connected clients hydrate previews.
          if (/https?:\/\//.test(text)) {
            void unfurlUrls(text)
              .then(async (u) => {
                if (u.length === 0) return;
                await pg.setMessageUnfurls(msgId, u);
                broadcastToGuests(workspaceId, {
                  type: "cyborg:message_unfurled" as const,
                  payload: { messageId: msgId, channelId: chId, workspaceId, unfurls: u },
                });
                return;
              })
              .catch((err) =>
                relayLog.debug({ err, messageId: msgId }, "URL unfurl/preview enrichment failed"),
              );
          }
          // Maintain thread aggregates + per-follower unread, emit thread_updated.
          if (replyParentId) {
            void (async () => {
              try {
                const mentionedIds = Array.isArray(inner.mentions)
                  ? (inner.mentions as string[])
                  : [];
                const replyAt = Date.now();
                const { followers } = await pg.maintainThreadOnReply({
                  rootId: replyParentId,
                  workspaceId,
                  channelId: chId,
                  authorId: guest.userId,
                  mentionedUserIds: mentionedIds,
                  replyAt,
                });
                const mentionSet = new Set(mentionedIds);
                // One query for every follower's unread instead of one per
                // follower in the loop below (was an N+1 per reply).
                const unreadByUser = await pg.getThreadUnreadForRoot(replyParentId);
                for (const uid of followers) {
                  const u = unreadByUser.get(uid) ?? { unreadReplies: 0, unreadMentions: 0 };
                  broadcastToGuests(workspaceId, {
                    type: "cyborg:thread_updated",
                    payload: {
                      toUserId: uid,
                      rootId: replyParentId,
                      channelId: chId,
                      unread_replies: u.unreadReplies,
                      unread_mentions: u.unreadMentions,
                      previous_unread_replies:
                        uid === guest.userId ? u.unreadReplies : Math.max(0, u.unreadReplies - 1),
                      previous_unread_mentions: Math.max(
                        0,
                        u.unreadMentions - (mentionSet.has(uid) ? 1 : 0),
                      ),
                      last_reply_at: replyAt,
                    },
                  });
                }
              } catch (e) {
                relayLog.error({ err: e }, "threads maintain failed");
              }
            })();
          }
          // P2 Item 9: write server-side activity rows so reading the channel
          // clears these items cross-device. A human @mention → a "mention"
          // row for that member; a thread reply → a "thread_reply" row for the
          // parent's author. channelId is set so markActivityReadByChannel can
          // clear them when the recipient reads the channel.
          void (async () => {
            try {
              const actorName = user?.name ?? null;
              const preview = text.slice(0, 200);
              const mentioned = (
                Array.isArray(inner.mentions) ? (inner.mentions as string[]) : []
              ).filter((id) => id !== guest.userId);
              const memberIds = new Set((await pg.getChannelMembers(chId)).map((m) => m.userId));
              for (const mid of mentioned) {
                // Only members get a feed row — no cross-workspace mention spam.
                if (!memberIds.has(mid)) continue;
                await emitActivityEvent(mid, {
                  workspaceId,
                  eventType: "mention",
                  sourceId: msgId,
                  channelId: chId,
                  previewText: preview,
                  actorId: guest.userId,
                  actorName,
                });
              }
              if (replyParentId) {
                const parent = await pg.getMessageById(replyParentId);
                // Notify the parent's author (unless they wrote the reply, or
                // already got a mention row above for this same message).
                if (
                  parent &&
                  parent.fromId !== guest.userId &&
                  memberIds.has(parent.fromId) &&
                  !mentioned.includes(parent.fromId)
                ) {
                  await emitActivityEvent(parent.fromId, {
                    workspaceId,
                    eventType: "thread_reply",
                    sourceId: msgId,
                    channelId: chId,
                    previewText: preview,
                    actorId: guest.userId,
                    actorName,
                  });
                }
              }
            } catch (err) {
              relayLog.error({ err }, "activity channel emit failed");
            }
          })();
          // Push to offline recipients. @mentioned users get a distinct,
          // higher-signal "mentioned you" notification; other channel members
          // get the regular channel notification.
          void (async () => {
            try {
              const mentions = (
                Array.isArray(inner.mentions) ? (inner.mentions as string[]) : []
              ).filter((id) => id !== guest.userId);
              const mentionSet = new Set(mentions);
              const members = await pg.getChannelMembers(chId);
              const others = members
                .map((m) => m.userId)
                .filter((id) => id !== guest.userId && !mentionSet.has(id));
              const ch = await pg.getChannel(chId);
              const who = user?.name ?? "Someone";
              const where = ch?.name ? ` in #${ch.name}` : "";
              const url = `/workspace/${workspaceId}/channel/${chId}`;
              // Honor each recipient's per-channel notification preference (same
              // policy as the in-app banner). Channel default is "mentions_only":
              //  - muted        → never push
              //  - mentions_only→ push only if mentioned
              //  - all          → push every message
              // Without this the relay pushed EVERY channel message to EVERY offline
              // member regardless of their pref (over-push).
              const prefs = await pg.getNotificationPrefsForScope(workspaceId, chId);
              const prefOf = (id: string): string => prefs.get(id) ?? "mentions_only";
              const mentionTargets = mentions.filter((id) => prefOf(id) !== "muted");
              const otherTargets = others.filter((id) => prefOf(id) === "all");
              if (mentionTargets.length > 0) {
                await dispatchPush(workspaceId, mentionTargets, {
                  title: `${who} mentioned you${where}`,
                  body: text.slice(0, 140),
                  url,
                  tag: `mention:${chId}`,
                });
              }
              if (otherTargets.length > 0) {
                await dispatchPush(workspaceId, otherTargets, {
                  title: ch?.name ? `#${ch.name}` : "New message",
                  body: `${who}: ${text.slice(0, 140)}`,
                  url,
                  tag: `ch:${chId}`,
                });
              }
            } catch (err) {
              relayLog.error({ err }, "push channel dispatch failed");
            }
          })();
          break;
        }

        case "cyborg:dm": {
          if (!workspaceId) break;
          const toId = inner.toId as string;
          const text = inner.text as string;
          const dmAttachments = Array.isArray(inner.attachments)
            ? (inner.attachments as unknown[]).slice(0, 10)
            : null;
          if (!toId || (!text && !dmAttachments)) break;
          const user = await pg.getUserById(guest.userId);
          // Thread reply in a DM: carry the parent so it actually threads (was
          // hardcoded null, which dropped every DM reply's thread link, so DM
          // thread footers never appeared and replies leaked into the inline list).
          const dmReplyParentId = (inner.parentId as string) || null;
          // Capture the id so the unfurl trigger below can target this row.
          const dmMsgId = randomUUID();
          relay.injectMessage(
            workspaceId,
            {
              type: "cyborg:dm_broadcast" as const,
              payload: {
                id: dmMsgId,
                workspaceId,
                channelId: null,
                fromId: guest.userId,
                fromType: "human" as const,
                fromName: user?.name ?? null,
                toId,
                text,
                mentions: null,
                parentId: dmReplyParentId,
                attachments: dmAttachments,
                // Echo the client-generated id (#501) — see channel handler above.
                clientMsgId: typeof inner.clientMsgId === "string" ? inner.clientMsgId : null,
                createdAt: Date.now(),
              },
            },
            "guest",
          );
          // URL unfurls (Tier 2): fire-and-forget, scoped to the DM pair. The
          // cyborg:message_unfurled event carries fromId/toId so broadcastToGuests
          // only delivers it to the two participants (see broadcastToGuestsLocal).
          if (text && /https?:\/\//.test(text)) {
            void unfurlUrls(text)
              .then(async (u) => {
                if (u.length === 0) return;
                await pg.setMessageUnfurls(dmMsgId, u);
                broadcastToGuests(workspaceId, {
                  type: "cyborg:message_unfurled" as const,
                  payload: {
                    messageId: dmMsgId,
                    toId,
                    fromId: guest.userId,
                    workspaceId,
                    unfurls: u,
                  },
                });
                return;
              })
              .catch((err) =>
                relayLog.debug(
                  { err, messageId: dmMsgId },
                  "DM URL unfurl/preview enrichment failed",
                ),
              );
          }
          // Maintain thread aggregates for DM threads (channelId = null). Mirrors
          // the channel_message path; maintainThreadOnReply keys on rootId and
          // accepts a null channelId, so no channel-only assumption applies.
          if (dmReplyParentId) {
            void (async () => {
              try {
                const replyAt = Date.now();
                await pg.maintainThreadOnReply({
                  rootId: dmReplyParentId,
                  workspaceId,
                  channelId: null,
                  authorId: guest.userId,
                  mentionedUserIds: [],
                  replyAt,
                });
              } catch (e) {
                relayLog.error({ err: e }, "threads dm maintain failed");
              }
            })();
          }
          // Push to the DM recipient if they're offline.
          void (async () => {
            try {
              await dispatchPush(workspaceId, [toId], {
                // "(DM)" so it's distinguishable from a channel once dispatchPush
                // prepends the workspace name → "Workspace · Alice (DM)" (v1 parity).
                title: user?.name ? `${user.name} (DM)` : "Direct message",
                body: text.slice(0, 140),
                url: `/workspace/${workspaceId}/dm/${guest.userId}`,
                tag: `dm:${guest.userId}`,
              });
            } catch (err) {
              relayLog.error({ err }, "push dm dispatch failed");
            }
          })();
          break;
        }

        case "cyborg:typing": {
          if (!workspaceId) break;
          const chId2 = inner.channelId as string;
          const typingToId = inner.toId as string | undefined;
          // DM typing: scope the broadcast to sender + peer only (mirrors the
          // cyborg:dm fan-out in broadcastToGuestsLocal), never workspace-wide.
          // Self-DM is a no-op — never echo typing back to the sender.
          if (typingToId) {
            if (typingToId === guest.userId) break;
            const dmUser = await pg.getUserById(guest.userId);
            relay.injectMessage(
              workspaceId,
              {
                type: "cyborg:typing_broadcast" as const,
                payload: {
                  workspaceId,
                  channelId: "",
                  fromId: guest.userId,
                  fromName: dmUser?.name ?? null,
                  toId: typingToId,
                },
              },
              "guest",
            );
            break;
          }
          if (!chId2) break;
          // Thread-typing scope (#11 thread-typing): when the sender is composing
          // a reply in a thread, echo the root id so receivers can route the
          // indicator to the open thread panel. The broadcast scope is unchanged
          // (workspace-wide, channel-keyed); parentId is purely a routing hint.
          const typingParentId =
            typeof inner.parentId === "string" ? (inner.parentId as string) : undefined;
          const user = await pg.getUserById(guest.userId);
          relay.injectMessage(
            workspaceId,
            {
              type: "cyborg:typing_broadcast" as const,
              payload: {
                workspaceId,
                channelId: chId2,
                fromId: guest.userId,
                fromName: user?.name ?? null,
                ...(typingParentId ? { parentId: typingParentId } : {}),
              },
            },
            "guest",
          );
          break;
        }

        case "cyborg:send_agent_prompt": {
          if (!workspaceId) break;
          const agentId = inner.agentId as string;
          const prompt = inner.prompt as string;
          // #579: image/file attachments ride alongside the prompt. The relay
          // forwards them verbatim — the owning DAEMON builds the vision content
          // blocks (it knows the agent's provider; the relay must not fetch/base64).
          // Validate each item against AttachmentSchema rather than asserting
          // the shape of untrusted relay JSON — a malformed item (missing
          // name/url/type/size) would otherwise crash buildAgentPrompt on the
          // owning daemon. Invalid entries are dropped, not trusted.
          const promptAttachments = Array.isArray(inner.attachments)
            ? inner.attachments
                .slice(0, 10)
                .map((a) => AttachmentSchema.safeParse(a))
                .filter((r) => r.success)
                .map((r) => r.data)
            : undefined;
          const hasAttachments = !!promptAttachments && promptAttachments.length > 0;
          if (!agentId || (!prompt && !hasAttachments)) {
            respondError("agentId and prompt (or attachments) required");
            break;
          }
          const promptAccess = await checkAgentAccess(pg, workspaceId, guest.userId, agentId);
          if (!promptAccess.allowed) {
            respondError(promptAccess.reason!);
            break;
          }
          // HARD-PAUSE license gate (DECISION #2): prompting/running an agent is
          // a paid feature — block it once the trial ends with no active sub.
          // Only enforce when billing is configured (see agent-spawn gate above).
          if (isStripeConfigured()) {
            const promptLicense = await pg.getLicenseStatus(workspaceId);
            if (promptLicense.state === "paused") {
              sendPaseoResponse(ws, "cyborg:error", {
                error: "license_required",
                message: "Trial ended — activate your license to bring agents back online.",
                license: promptLicense,
                requestId,
              });
              break;
            }
          }
          const promptUser = await pg.getUserById(guest.userId);
          relay.injectMessage(
            workspaceId,
            {
              type: "cyborg:dm_broadcast" as const,
              payload: {
                id: randomUUID(),
                workspaceId,
                channelId: null,
                fromId: guest.userId,
                fromType: "human" as const,
                fromName: promptUser?.name ?? null,
                toId: agentId,
                text: prompt,
                mentions: null,
                parentId: null,
                // Show the user's attachments on their own DM message (#579).
                ...(hasAttachments ? { attachments: promptAttachments } : {}),
                createdAt: Date.now(),
              },
            },
            "guest",
          );
          relay.injectMessage(workspaceId, {
            type: "cyborg:agent_prompt_forward",
            agentId,
            workspaceId,
            prompt,
            // Forwarded verbatim; the daemon folds them into the prompt.
            ...(hasAttachments ? { attachments: promptAttachments } : {}),
            fromDaemonId: "guest",
            fromUserId: guest.userId,
            // The daemon's local SQLite assigns DIFFERENT user ids than the cloud
            // PG for the same account, so initiated_by (local id) can't be compared
            // to fromUserId (cloud id) directly. Carry the email so the daemon can
            // bridge the two id namespaces by identity.
            fromEmail: promptUser?.email ?? null,
            // An agent-session / DM prompt to a cybo is an inherently PRIVATE 1:1
            // turn (we injected a dm_broadcast for it just above). Tag the recipient
            // so the owning daemon arms the DM guard (routeDmTurn) — without this the
            // cloud path bypasses handleDm and a channel-bound cybo's reply leaks into
            // its bound channel. The daemon resolves the recipient's LOCAL id by email
            // (id namespaces differ); the email also steers the relay-flush guard.
            ...(promptUser?.email
              ? { dmRecipient: { userId: guest.userId, email: promptUser.email } }
              : {}),
          });
          respond("cyborg:send_agent_prompt_response", {
            agentId,
            status: "forwarded",
          });
          break;
        }

        case "cyborg:cancel_agent": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const agentId = inner.agentId as string;
          if (!agentId) {
            respondError("agentId required");
            break;
          }
          const cancelAccess = await checkAgentAccess(pg, workspaceId, guest.userId, agentId);
          if (!cancelAccess.allowed) {
            respondError(cancelAccess.reason ?? "no access to this agent");
            break;
          }
          relay.injectMessage(workspaceId, {
            type: "cyborg:cancel_agent_forward",
            agentId,
            workspaceId,
            fromDaemonId: "guest",
          });
          // Ack so CLI/programmatic callers don't hang waiting — the daemon
          // confirms asynchronously via agent_status/agent_stream broadcasts.
          respond("cyborg:cancel_agent_ack", { agentId, status: "canceling" });
          break;
        }

        case "cyborg:clear_attention": {
          // #591: dismiss an agent's derived attention flag (viewed). Same
          // access gate + forward shape as cancel_agent; fire-and-forget (the
          // owning daemon clears + re-broadcasts the agent state).
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const agentId = inner.agentId as string;
          if (!agentId) {
            respondError("agentId required");
            break;
          }
          const clearAccess = await checkAgentAccess(pg, workspaceId, guest.userId, agentId);
          if (!clearAccess.allowed) {
            respondError(clearAccess.reason ?? "no access to this agent");
            break;
          }
          relay.injectMessage(workspaceId, {
            type: "cyborg:clear_attention_forward",
            agentId,
            workspaceId,
            fromDaemonId: "guest",
          });
          break;
        }

        case "cyborg:agent_permission_response": {
          if (!workspaceId) break;
          const agentId = inner.agentId as string;
          const prid = inner.permissionRequestId as string;
          const response = inner.response as Record<string, unknown>;
          if (!agentId || !prid || !response) break;
          const permAccess = await checkAgentAccess(pg, workspaceId, guest.userId, agentId);
          if (!permAccess.allowed) break;
          relay.injectMessage(workspaceId, {
            type: "cyborg:permission_response_forward",
            agentId,
            workspaceId,
            permissionRequestId: prid,
            response,
            fromDaemonId: "guest",
          });
          break;
        }

        case "cyborg:create_channel": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const name = inner.name as string;
          if (!name) {
            respondError("name required");
            break;
          }
          // #608: group DMs are NOT created through the generic channel path —
          // they have their own validated handler (member checks + cap + atomic
          // membership). Reject a group_dm type here so the dedicated handler is
          // the only way to mint one.
          if (inner.type === "group_dm") {
            respondError("use cyborg:create_group_dm to create a group DM");
            break;
          }
          const ccRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!ccRole || ccRole === "viewer") {
            respondError("you can't create channels in this workspace");
            break;
          }
          const channelId = randomUUID();
          await pg.createChannel(channelId, workspaceId, name, guest.userId, {
            description: inner.description as string | undefined,
            isPrivate: inner.isPrivate as boolean | undefined,
            instructions: inner.instructions as string | undefined,
          });
          const channels = await pg.getChannels(workspaceId);
          const ch = channels.find((c) => c.id === channelId);
          respond("cyborg:create_channel_response", {
            channel: ch ? mapChannel(ch) : { id: channelId, workspaceId, name },
          });
          if (ch) {
            broadcastToGuests(workspaceId, {
              type: "cyborg:channel_created_broadcast",
              payload: { channel: mapChannel(ch) },
            });
          }
          break;
        }

        // #608: group DMs are workspace-level channels (type='group_dm',
        // is_hidden=true), so — exactly like create_channel — the relay is
        // authoritative: it validates against the AUTHORITATIVE PG roster and
        // mutates PG directly. Membership is set at creation only; the channel
        // then rides the normal channel pipeline (threads/unread/reads) via
        // channel_id, never the 1:1 to_id path.
        case "cyborg:create_group_dm": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const gdRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!gdRole || gdRole === "viewer") {
            respondError("you can't start a group DM in this workspace");
            break;
          }
          // `inner` is untrusted WS JSON — validate the shape at runtime.
          const rawParticipants = Array.isArray(inner.participants) ? inner.participants : null;
          if (!rawParticipants) {
            respondError("participants required");
            break;
          }
          const participants = rawParticipants.filter((p): p is string => typeof p === "string");
          const gdMembers = await pg.getMembers(workspaceId);
          const gdMemberIds = new Set(gdMembers.map((m) => m.userId));
          const validation = validateGroupDmParticipants({
            creatorId: guest.userId,
            participants,
            memberIds: gdMemberIds,
          });
          if (!validation.ok) {
            respondError(validation.error);
            break;
          }
          // Auto-name from the FULL member set (creator + others), so the title
          // reads identically for every member.
          const gdMemberSet = new Set([guest.userId, ...validation.participantIds]);
          const gdName = deriveGroupDmName(
            gdMembers
              .filter((m) => gdMemberSet.has(m.userId))
              .map((m) => ({ userId: m.userId, name: m.name, email: m.email })),
          );
          const gdChannelId = randomUUID();
          await pg.createGroupDm({
            id: gdChannelId,
            workspaceId,
            name: gdName,
            createdBy: guest.userId,
            participantIds: validation.participantIds,
          });
          // We just minted this channel with a known, fixed shape, so build the
          // client Channel object directly instead of re-reading the whole
          // workspace channel list to find it. Mirrors mapChannel's output so the
          // client deserializes it identically to a fetched channel.
          const gdMapped = {
            id: gdChannelId,
            workspaceId,
            name: gdName,
            description: null,
            isPrivate: true,
            instructions: null,
            slashCommandModel: null,
            createdBy: guest.userId,
            createdAt: Date.now(),
            isArchived: false,
            type: "group_dm" as const,
            isHidden: true,
          };
          respond("cyborg:create_group_dm_response", { channel: gdMapped });
          // Broadcast to the workspace; the client adds it only if the current
          // user is in memberIds (a hidden channel must never appear for a
          // non-member). memberIds is the authoritative member list.
          broadcastToGuests(workspaceId, {
            type: "cyborg:group_dm_created_broadcast",
            payload: { channel: gdMapped, memberIds: [...gdMemberSet] },
          });
          break;
        }

        // Cybo CRUD is relay-authoritative (like create_channel above): cybos are
        // workspace-level PG entities, so we authorize from the AUTHORITATIVE PG
        // role + workspace settings and mutate PG directly. fetch_cybos already
        // merges PG cybos and spawn_cybo resolves them from PG, so a relay-created
        // cybo lists + runs on every daemon with no daemon round-trip.
        case "cyborg:create_cybo": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const ccRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!ccRole) {
            respondError(
              "You're not a member of this workspace anymore — refresh the page and try again.",
            );
            break;
          }
          const ccSettings = await pg.getWorkspaceSettings(workspaceId);
          if (!canCreateAgent(ccRole, ccSettings.allowMemberAgentCreation === true)) {
            respondError("You don't have permission to create cybos in this workspace.");
            break;
          }
          // `inner` is untrusted WS JSON — validate field types at runtime; never assert.
          const ccSlug = typeof inner.slug === "string" ? inner.slug : undefined;
          const ccName = typeof inner.name === "string" ? inner.name : undefined;
          if (!ccSlug || !ccName) {
            respondError("slug and name are required");
            break;
          }
          const ccProvider = typeof inner.provider === "string" ? inner.provider : "";
          const ccModel = typeof inner.model === "string" ? inner.model : null;
          const newCyboId = randomUUID();
          await pg.createCybo({
            id: newCyboId,
            workspaceId,
            slug: ccSlug,
            name: ccName,
            soul: typeof inner.soul === "string" ? inner.soul : "",
            provider: ccProvider,
            createdBy: guest.userId,
            description: typeof inner.description === "string" ? inner.description : null,
            avatar: typeof inner.avatar === "string" ? inner.avatar : null,
            role: typeof inner.role === "string" ? inner.role : null,
            model: ccModel,
            mcpServers: isRecord(inner.mcpServers) ? inner.mcpServers : null,
            // Composio grants — stored as-is (pg-sync omits the column when null,
            // so a create stays safe pre-migration). Strict shape is re-validated
            // at spawn (parseCyboToolGrants), so a malformed blob is a no-op, never fatal.
            toolGrants: isRecord(inner.toolGrants) ? inner.toolGrants : null,
            llmAuthMode: typeof inner.llmAuthMode === "string" ? inner.llmAuthMode : undefined,
            behaviorMode: typeof inner.behaviorMode === "string" ? inner.behaviorMode : undefined,
            homeDaemonId:
              typeof inner.homeDaemonId === "string" || inner.homeDaemonId === null
                ? (inner.homeDaemonId as string | null)
                : undefined,
            autonomyLevel:
              typeof inner.autonomyLevel === "string" || inner.autonomyLevel === null
                ? inner.autonomyLevel
                : undefined,
            monthlySpendCap:
              typeof inner.monthlySpendCap === "number" ? inner.monthlySpendCap : null,
            platformPermissions: Array.isArray(inner.platformPermissions)
              ? inner.platformPermissions.filter((p): p is string => typeof p === "string")
              : [],
          });
          // #636: compute readiness AFTER persisting (creation is never blocked).
          // "needs-daemon" means it committed fine but nothing reachable can run
          // it yet — the UI surfaces a banner, the cybo is not rejected.
          const ccReadiness = (await workspaceReadinessResolver(relay, pg, workspaceId))(
            ccProvider,
            ccModel,
          );
          respond("cyborg:create_cybo_response", {
            cybo: {
              id: newCyboId,
              slug: ccSlug,
              name: ccName,
              provider: ccProvider,
              model: ccModel,
              isDefault: false,
              readiness: ccReadiness,
            },
          });
          // #644: broadcast the new cybo so every workspace member's roster (the
          // agents pane + @-mention autocomplete) gains it live instead of going
          // stale until a reload. Completes the create/add/update/remove symmetry
          // (#633 add, #641 update). The creator also refetches locally; the
          // client handler dedupes by id so the broadcast is idempotent.
          broadcastToGuests(workspaceId, {
            type: "cyborg:cybo_created_broadcast",
            cybo: {
              id: newCyboId,
              slug: ccSlug,
              name: ccName,
              description: typeof inner.description === "string" ? inner.description : null,
              avatar: typeof inner.avatar === "string" ? inner.avatar : null,
              role: typeof inner.role === "string" ? inner.role : null,
              provider: ccProvider,
              model: ccModel,
              isDefault: false,
              createdAt: Date.now(),
              readiness: ccReadiness,
            },
          });
          break;
        }

        case "cyborg:update_cybo": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const ucRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!ucRole) {
            respondError(
              "You're not a member of this workspace anymore — refresh the page and try again.",
            );
            break;
          }
          const ucCyboId = typeof inner.cyboId === "string" ? inner.cyboId : undefined;
          if (!ucCyboId) {
            respondError("cyboId required");
            break;
          }
          // Scope to THIS workspace's cybos. Resolution is TOLERANT (exact id →
          // local:<slug> → slug): clients holding a pre-fix roster carry a
          // daemon-local duplicate id for a cybo that DOES exist in PG.
          const ucExisting = resolveWorkspaceCybo(await pg.getCybos(workspaceId), ucCyboId);
          if (!ucExisting) {
            respondError(`Cybo not found in this workspace (id: ${ucCyboId})`);
            break;
          }
          const ucSettings = await pg.getWorkspaceSettings(workspaceId);
          // Object-level auth: a member may edit only the cybos they created;
          // owner/admin may edit any. Prevents one member editing a teammate's cybo.
          if (
            !canManageCybo(
              ucRole,
              ucSettings.allowMemberAgentCreation === true,
              ucExisting.created_by,
              guest.userId,
            )
          ) {
            respondError("You don't have permission to edit this cybo.");
            break;
          }
          const ucUpdates: Parameters<typeof pg.updateCybo>[1] = {};
          if (typeof inner.name === "string") ucUpdates.name = inner.name;
          if (typeof inner.description === "string" || inner.description === null)
            ucUpdates.description = inner.description;
          if (typeof inner.avatar === "string" || inner.avatar === null)
            ucUpdates.avatar = inner.avatar;
          if (typeof inner.role === "string" || inner.role === null) ucUpdates.role = inner.role;
          if (typeof inner.soul === "string") ucUpdates.soul = inner.soul;
          if (typeof inner.provider === "string") ucUpdates.provider = inner.provider;
          if (typeof inner.model === "string" || inner.model === null)
            ucUpdates.model = inner.model;
          if (typeof inner.llmAuthMode === "string") ucUpdates.llmAuthMode = inner.llmAuthMode;
          if (typeof inner.behaviorMode === "string") ucUpdates.behaviorMode = inner.behaviorMode;
          if (typeof inner.homeDaemonId === "string" || inner.homeDaemonId === null)
            ucUpdates.homeDaemonId = inner.homeDaemonId;
          if (typeof inner.autonomyLevel === "string" || inner.autonomyLevel === null)
            ucUpdates.autonomyLevel = inner.autonomyLevel;
          if (typeof inner.monthlySpendCap === "number" || inner.monthlySpendCap === null)
            ucUpdates.monthlySpendCap = inner.monthlySpendCap;
          if (Array.isArray(inner.platformPermissions))
            ucUpdates.platformPermissions = inner.platformPermissions.filter(
              (p): p is string => typeof p === "string",
            );
          if (inner.mcpServers === null) ucUpdates.mcpServers = null;
          else if (isRecord(inner.mcpServers)) ucUpdates.mcpServers = inner.mcpServers;
          if (inner.toolGrants === null) ucUpdates.toolGrants = null;
          else if (isRecord(inner.toolGrants)) ucUpdates.toolGrants = inner.toolGrants;
          await pg.updateCybo(ucExisting.id, ucUpdates);
          // #636: recompute readiness against the POST-edit provider/model —
          // changing a cybo's provider can flip it ready ⇄ needs-daemon.
          const ucProvider = ucUpdates.provider ?? ucExisting.provider;
          const ucModel = "model" in ucUpdates ? ucUpdates.model : ucExisting.model;
          const ucReadiness = (await workspaceReadinessResolver(relay, pg, workspaceId))(
            ucProvider,
            ucModel ?? null,
          );
          respond("cyborg:update_cybo_response", {
            cybo: {
              id: ucExisting.id,
              slug: ucExisting.slug,
              name: ucUpdates.name ?? ucExisting.name,
              provider: ucProvider,
              model: ucModel,
              readiness: ucReadiness,
            },
          });
          // #640: broadcast the edit so every workspace member's roster (the
          // @-mention autocomplete, agents pane, in-channel cybo header) updates
          // live instead of going stale until a reload. Symmetric with the ADD
          // path (channel_cybo_added_broadcast). Nullable fields use a presence
          // check so clearing avatar/role/model propagates correctly.
          broadcastToGuests(workspaceId, {
            type: "cyborg:cybo_updated_broadcast",
            cybo: {
              id: ucExisting.id,
              slug: ucExisting.slug,
              name: ucUpdates.name ?? ucExisting.name,
              description:
                "description" in ucUpdates ? ucUpdates.description : ucExisting.description,
              avatar: "avatar" in ucUpdates ? ucUpdates.avatar : ucExisting.avatar,
              role: "role" in ucUpdates ? ucUpdates.role : ucExisting.role,
              provider: ucProvider,
              model: ucModel,
              readiness: ucReadiness,
            },
          });
          break;
        }

        case "cyborg:delete_cybo": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const dcRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!dcRole) {
            respondError(
              "You're not a member of this workspace anymore — refresh the page and try again.",
            );
            break;
          }
          const dcCyboId = typeof inner.cyboId === "string" ? inner.cyboId : undefined;
          if (!dcCyboId) {
            respondError("cyboId required");
            break;
          }
          // Tolerant resolution, same rationale as update_cybo above.
          const dcExisting = resolveWorkspaceCybo(await pg.getCybos(workspaceId), dcCyboId);
          if (dcExisting) {
            const dcSettings = await pg.getWorkspaceSettings(workspaceId);
            // Object-level auth: a member may delete only the cybos they created.
            if (
              !canManageCybo(
                dcRole,
                dcSettings.allowMemberAgentCreation === true,
                dcExisting.created_by,
                guest.userId,
              )
            ) {
              respondError("You don't have permission to delete this cybo.");
              break;
            }
            await pg.deleteCybo(dcExisting.id);
          }
          // The id to remove EVERYWHERE: the canonical PG id when known, else the raw
          // input — a daemon-only / leaked cybo that ISN'T in this workspace's PG (its
          // PG row lives in another workspace, or there is none). We no longer hard-
          // error "not found in this workspace" for that case: it left the user unable
          // to delete a cybo that clearly shows in their roster (it lives in a daemon's
          // SQLite scoped to this workspace).
          const dcTargetId = dcExisting?.id ?? dcCyboId;
          // Fan the delete out to EVERY online workspace daemon so its LOCAL SQLite
          // copy is pruned too — otherwise delete is PG-only and fetch_cybos re-
          // surfaces the daemon's surviving row ("deleted but reappears"). The daemon
          // no-ops if it doesn't hold the cybo (or it's scoped to another workspace).
          // Best-effort: an offline daemon reconciles on reconnect. (relay/guest are
          // captured from the enclosing main() closure — valid at call time.)
          const dcConnected = new Set(relay.getConnectedDaemons());
          for (const d of await pg.getDaemonsForWorkspace(workspaceId)) {
            if (!dcConnected.has(d.id)) continue;
            relay.sendToDaemonInWorkspace(
              workspaceId,
              {
                type: "cyborg:relay_rpc",
                token: guest.token,
                workspaceId,
                guestId: guest.userId,
                role: dcRole,
                inner: {
                  type: "cyborg:delete_cybo",
                  workspaceId,
                  cyboId: dcTargetId,
                  requestId: randomUUID(),
                },
              },
              d.id,
            );
          }
          respond("cyborg:delete_cybo_response", { deleted: true });
          // #644: broadcast the deletion so every member's roster drops it live.
          // Idempotent: the deleter already filtered locally, others remove on receipt.
          broadcastToGuests(workspaceId, {
            type: "cyborg:cybo_deleted_broadcast",
            cyboId: dcTargetId,
          });
          break;
        }

        case "cyborg:update_channel": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const ucChId = inner.channelId as string;
          if (!ucChId) {
            respondError("channelId required");
            break;
          }
          const wsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const chRow = await pg.getChannel(ucChId);
          if (!chRow || chRow.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          const isCreator = chRow.created_by === guest.userId;
          const isWsAdmin = wsRole === "owner" || wsRole === "admin";
          const chMemberRole = await pg.getChannelMemberRole(ucChId, guest.userId);
          if (!isCreator && !isWsAdmin && chMemberRole !== "admin") {
            respondError("permission denied");
            break;
          }
          const ucUpdates: Record<string, unknown> = {};
          if (inner.name !== undefined) ucUpdates.name = inner.name;
          if (inner.description !== undefined) ucUpdates.description = inner.description;
          if (inner.isPrivate !== undefined) ucUpdates.isPrivate = inner.isPrivate;
          if (inner.instructions !== undefined) ucUpdates.instructions = inner.instructions;
          // Per-channel AI-command model override: { provider, model } or null to
          // clear. Stored as JSON text; ignore a malformed value rather than 500.
          if (inner.slashCommandModel !== undefined) {
            const scm = inner.slashCommandModel as { provider?: unknown; model?: unknown } | null;
            if (scm === null) {
              ucUpdates.slashCommandModel = null;
            } else if (typeof scm.provider === "string" && typeof scm.model === "string") {
              ucUpdates.slashCommandModel = JSON.stringify({
                provider: scm.provider,
                model: scm.model,
              });
            }
          }
          await pg.updateChannel(
            ucChId,
            ucUpdates as {
              name?: string;
              description?: string | null;
              isPrivate?: boolean;
              instructions?: string | null;
              slashCommandModel?: string | null;
            },
          );
          // Converting to private: ensure the actor is a member so the channel
          // stays visible to them and the "0 members ⇒ public" legacy rule never
          // accidentally re-exposes it.
          if (inner.isPrivate === true) {
            await pg.addChannelMember(ucChId, guest.userId, "admin");
          }
          const ucChannels = await pg.getChannelsForUser(workspaceId, guest.userId);
          const ucCh = ucChannels.find((c) => c.id === ucChId);
          const mapped = ucCh ? mapChannel(ucCh) : null;
          respond("cyborg:update_channel_response", { channel: mapped });
          if (mapped) {
            broadcastToGuests(workspaceId, {
              type: "cyborg:channel_updated_broadcast",
              payload: { channel: mapped },
            });
          }
          break;
        }

        case "cyborg:delete_channel": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const dcChId = inner.channelId as string;
          if (!dcChId) {
            respondError("channelId required");
            break;
          }
          const dcWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const dcRow = await pg.getChannel(dcChId);
          if (!dcRow || dcRow.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          const dcIsCreator = dcRow.created_by === guest.userId;
          const dcIsWsAdmin = dcWsRole === "owner" || dcWsRole === "admin";
          if (!dcIsCreator && !dcIsWsAdmin) {
            respondError("permission denied");
            break;
          }
          await pg.softDeleteChannel(dcChId);
          respond("cyborg:delete_channel_response", { deleted: true });
          broadcastToGuests(workspaceId, {
            type: "cyborg:channel_deleted_broadcast",
            payload: { channelId: dcChId, workspaceId },
          });
          break;
        }

        // P2 #3: archive (soft-delete) vs the harder delete_channel. Admin-gated
        // via the real channel role (getChannelRole) with workspace owner/admin
        // as an override. Reuses channel_updated_broadcast so clients reconcile
        // the archived flag (and drop it from the active list) without a new
        // event type.
        case "cyborg:archive_channel": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const arChId = inner.channelId as string;
          if (!arChId) {
            respondError("channelId required");
            break;
          }
          const arArchived = inner.archived === undefined ? true : !!inner.archived;
          const arWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const arRow = await pg.getChannel(arChId);
          if (!arRow || arRow.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          const arIsWsAdmin = arWsRole === "owner" || arWsRole === "admin";
          const arChRole = await pg.getChannelRole(arChId, guest.userId);
          if (!arIsWsAdmin && arChRole !== "admin") {
            respondError("permission denied");
            break;
          }
          await pg.setChannelArchived(arChId, arArchived);
          const arChannels = await pg.getChannels(workspaceId);
          const arCh = arChannels.find((c) => c.id === arChId);
          const arMapped = arCh ? mapChannel(arCh) : null;
          respond("cyborg:archive_channel_response", { channel: arMapped });
          if (arMapped) {
            broadcastToGuests(workspaceId, {
              type: "cyborg:channel_updated_broadcast",
              payload: { channel: arMapped },
            });
          }
          break;
        }

        // P2 #3: the caller's real per-channel role ("admin" | "member" | null),
        // for the client to derive isChannelAdmin instead of createdBy === me.
        case "cyborg:get_channel_role": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const grChId = inner.channelId as string;
          if (!grChId) {
            respondError("channelId required");
            break;
          }
          const grRole = await pg.getChannelRole(grChId, guest.userId);
          respond("cyborg:get_channel_role_response", { role: grRole });
          break;
        }

        // P2 #4: lightweight file count for the Files tab badge.
        case "cyborg:get_channel_file_count": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const gfcChId = inner.channelId as string;
          if (!gfcChId) {
            respondError("channelId required");
            break;
          }
          if (!(await pg.isMember(workspaceId, guest.userId))) {
            respondError("permission denied");
            break;
          }
          const gfcChannel = await pg.getChannel(gfcChId);
          if (!gfcChannel) {
            respondError("channel not found");
            break;
          }
          if (
            gfcChannel.is_private === 1 &&
            !(await pg.getChannelMemberRole(gfcChId, guest.userId))
          ) {
            respondError("permission denied");
            break;
          }
          const gfcCount = await pg.getChannelFileCount(gfcChId);
          respond("cyborg:get_channel_file_count_response", { count: gfcCount });
          break;
        }

        case "cyborg:fetch_channel_members": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const fcmChId = inner.channelId as string;
          if (!fcmChId) {
            respondError("channelId required");
            break;
          }
          // Anchor: caller must be a workspace member and the channel must belong
          // to that workspace (a private channel additionally requires membership)
          // — otherwise foreign member lists (userIds, names) leak.
          const fcmRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!fcmRole) {
            respondError("not a member of this workspace");
            break;
          }
          const fcmChannel = await pg.getChannel(fcmChId);
          if (!fcmChannel || fcmChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          if (fcmChannel.is_private && !(await pg.getChannelMemberRole(fcmChId, guest.userId))) {
            respondError("channel not found");
            break;
          }
          const members = await pg.getChannelMembers(fcmChId);
          respond("cyborg:fetch_channel_members_response", { members });
          break;
        }

        case "cyborg:add_channel_member": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const acmChId = inner.channelId as string;
          const acmUserId = inner.userId as string;
          if (!acmChId || !acmUserId) {
            respondError("channelId and userId required");
            break;
          }
          const acmChannel = await pg.getChannel(acmChId);
          if (!acmChannel) {
            respondError("channel not found");
            break;
          }
          const acmWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const acmChRole = await pg.getChannelMemberRole(acmChId, guest.userId);
          const acmIsWsAdmin = acmWsRole === "owner" || acmWsRole === "admin";
          const acmIsPrivate = acmChannel.is_private === 1;
          let acmAllowed = acmIsWsAdmin || acmChRole === "admin";
          // Public channels: any existing member can add others, and anyone can self-join.
          if (!acmAllowed && !acmIsPrivate) {
            const isSelfJoin = acmUserId === guest.userId;
            const isExistingMember = acmChRole !== null;
            if (isSelfJoin || isExistingMember) acmAllowed = true;
          }
          if (!acmAllowed) {
            respondError("permission denied");
            break;
          }
          if (!(await pg.isMember(workspaceId, acmUserId))) {
            respondError("user is not a workspace member");
            break;
          }
          await pg.addChannelMember(acmChId, acmUserId);
          respond("cyborg:add_channel_member_response", { ok: true });
          broadcastToGuests(workspaceId, {
            type: "cyborg:channel_member_added_broadcast",
            payload: { channelId: acmChId, userId: acmUserId, workspaceId },
          });
          // Slack-style inline system message ("X joined" / "A added X").
          {
            const [actor, otherMember] = await Promise.all([
              pg.getUserById(guest.userId),
              acmUserId === guest.userId ? Promise.resolve(null) : pg.getUserById(acmUserId),
            ]);
            const member = acmUserId === guest.userId ? actor : otherMember;
            const memberName = member?.name ?? "Someone";
            const text =
              acmUserId === guest.userId
                ? `${memberName} joined the channel`
                : `${actor?.name ?? "Someone"} added ${memberName} to the channel`;
            relay.injectMessage(
              workspaceId,
              {
                type: "cyborg:channel_message_broadcast" as const,
                payload: {
                  id: randomUUID(),
                  workspaceId,
                  channelId: acmChId,
                  fromId: "system",
                  fromType: "system" as const,
                  fromName: null,
                  toId: null,
                  text,
                  mentions: null,
                  parentId: null,
                  createdAt: Date.now(),
                },
              },
              "guest",
            );
          }
          break;
        }

        case "cyborg:remove_channel_member": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const rcmChId = inner.channelId as string;
          const rcmUserId = inner.userId as string;
          if (!rcmChId || !rcmUserId) {
            respondError("channelId and userId required");
            break;
          }
          const isSelfLeave = rcmUserId === guest.userId;
          if (!isSelfLeave) {
            const rcmWsRole = await pg.getMemberRole(workspaceId, guest.userId);
            const rcmChRole = await pg.getChannelMemberRole(rcmChId, guest.userId);
            const rcmIsWsAdmin = rcmWsRole === "owner" || rcmWsRole === "admin";
            if (!rcmIsWsAdmin && rcmChRole !== "admin") {
              respondError("permission denied");
              break;
            }
          }
          await pg.removeChannelMember(rcmChId, rcmUserId);
          respond("cyborg:remove_channel_member_response", { ok: true });
          broadcastToGuests(workspaceId, {
            type: "cyborg:channel_member_removed_broadcast",
            payload: { channelId: rcmChId, userId: rcmUserId, workspaceId },
          });
          break;
        }

        // ── Cybo channel membership (Phase 2 / #270) ──
        // Adding a cybo to a channel IS the grant: membership = read+react+respond
        // there (the cyborg7 MCP channel tools gate on channel_members, not on the
        // cybo's platform permissions). The UI mirrors the human-member trio.
        case "cyborg:fetch_channel_cybos": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const fccChId = inner.channelId as string;
          if (!fccChId) {
            respondError("channelId required");
            break;
          }
          // Anchor like fetch_channel_members: caller must be a workspace member and
          // the channel must belong to that workspace (private → channel member too).
          const fccRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!fccRole) {
            respondError("not a member of this workspace");
            break;
          }
          const fccChannel = await pg.getChannel(fccChId);
          if (!fccChannel || fccChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          if (fccChannel.is_private && !(await pg.getChannelMemberRole(fccChId, guest.userId))) {
            respondError("channel not found");
            break;
          }
          const cyboIds = await pg.getChannelCyboMembers(fccChId);
          respond("cyborg:fetch_channel_cybos_response", { cyboIds });
          break;
        }

        case "cyborg:add_channel_cybo": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const accChId = inner.channelId as string;
          const accCyboId = inner.cyboId as string;
          if (!accChId || !accCyboId) {
            respondError("channelId and cyboId required");
            break;
          }
          const accChannel = await pg.getChannel(accChId);
          if (!accChannel || accChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          // Permission mirrors human add: ws admin/owner or channel admin; on a
          // public channel any existing member can add. Adding a cybo grants it
          // agency in the channel, so the same authority bar applies.
          const accWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const accChRole = await pg.getChannelMemberRole(accChId, guest.userId);
          const accIsWsAdmin = accWsRole === "owner" || accWsRole === "admin";
          let accAllowed = accIsWsAdmin || accChRole === "admin";
          if (!accAllowed && accChannel.is_private !== 1 && accChRole !== null) {
            accAllowed = true;
          }
          if (!accAllowed) {
            respondError("permission denied");
            break;
          }
          // The cybo must belong to THIS workspace (no cross-workspace adds).
          const accCybos = await pg.getCybos(workspaceId);
          if (!accCybos.some((c) => c.id === accCyboId)) {
            respondError("cybo not found in this workspace");
            break;
          }
          await pg.addCyboToChannel(accChId, accCyboId);
          respond("cyborg:add_channel_cybo_response", { ok: true });
          broadcastToGuests(workspaceId, {
            type: "cyborg:channel_cybo_added_broadcast",
            payload: { channelId: accChId, cyboId: accCyboId, workspaceId },
          });
          break;
        }

        case "cyborg:remove_channel_cybo": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const rccChId = inner.channelId as string;
          const rccCyboId = inner.cyboId as string;
          if (!rccChId || !rccCyboId) {
            respondError("channelId and cyboId required");
            break;
          }
          const rccChannel = await pg.getChannel(rccChId);
          if (!rccChannel || rccChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          // A cybo can't self-leave (it isn't the caller), so removal always needs
          // ws admin/owner or channel admin authority.
          const rccWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const rccChRole = await pg.getChannelMemberRole(rccChId, guest.userId);
          const rccIsWsAdmin = rccWsRole === "owner" || rccWsRole === "admin";
          if (!rccIsWsAdmin && rccChRole !== "admin") {
            respondError("permission denied");
            break;
          }
          await pg.removeCyboFromChannel(rccChId, rccCyboId);
          respond("cyborg:remove_channel_cybo_response", { ok: true });
          broadcastToGuests(workspaceId, {
            type: "cyborg:channel_cybo_removed_broadcast",
            payload: { channelId: rccChId, cyboId: rccCyboId, workspaceId },
          });
          break;
        }

        case "cyborg:fetch_channel_files": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const fcfChId = inner.channelId as string;
          if (!fcfChId) {
            respondError("channelId required");
            break;
          }
          // Auth: workspace member; for a private channel, also a channel member.
          if (!(await pg.isMember(workspaceId, guest.userId))) {
            respondError("permission denied");
            break;
          }
          const fcfChannel = await pg.getChannel(fcfChId);
          if (!fcfChannel) {
            respondError("channel not found");
            break;
          }
          if (
            fcfChannel.is_private === 1 &&
            !(await pg.getChannelMemberRole(fcfChId, guest.userId))
          ) {
            respondError("permission denied");
            break;
          }
          // Over-fetch by 5 so a multi-attachment message at the page boundary
          // doesn't get its files split across two pages (v1 parity). hasMore is
          // judged on the requested page size, the cursor advances on the last
          // ROW actually emitted.
          const fcfLimit = Math.min((inner.limit as number) ?? 20, 60);
          const fcfRows = await pg.getChannelFiles({
            channelId: fcfChId,
            before: inner.before as string | undefined,
            limit: fcfLimit + 5,
          });
          const fcf = flattenFileRows(fcfRows, fcfLimit);
          respond("cyborg:fetch_channel_files_response", fcf);
          break;
        }

        case "cyborg:fetch_dm_files": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const fdfPeerId = inner.peerId as string;
          if (!fdfPeerId) {
            respondError("peerId required");
            break;
          }
          if (!(await pg.isMember(workspaceId, guest.userId))) {
            respondError("permission denied");
            break;
          }
          const fdfLimit = Math.min((inner.limit as number) ?? 20, 60);
          const fdfRows = await pg.getDmFiles({
            workspaceId,
            userId: guest.userId,
            peerId: fdfPeerId,
            before: inner.before as string | undefined,
            limit: fdfLimit + 5,
          });
          const fdf = flattenFileRows(fdfRows, fdfLimit);
          respond("cyborg:fetch_dm_files_response", fdf);
          break;
        }

        case "cyborg:get_vapid_key": {
          respond("cyborg:get_vapid_key_response", { publicKey: vapidPublicKey() });
          break;
        }

        case "cyborg:push_subscribe": {
          const psEndpoint = inner.endpoint as string;
          const psKeys = inner.keys as { p256dh?: string; auth?: string } | undefined;
          if (!psEndpoint || !psKeys?.p256dh || !psKeys?.auth) {
            respondError("endpoint and keys required");
            break;
          }
          await pg.upsertPushSubscription({
            id: randomUUID(),
            userId: guest.userId,
            endpoint: psEndpoint,
            p256dh: psKeys.p256dh,
            auth: psKeys.auth,
            userAgent: (inner.userAgent as string | undefined) ?? null,
          });
          respond("cyborg:push_subscribe_response", { ok: true });
          break;
        }

        case "cyborg:push_unsubscribe": {
          const puEndpoint = inner.endpoint as string;
          if (!puEndpoint) {
            respondError("endpoint required");
            break;
          }
          await pg.deletePushSubscriptionByEndpoint(guest.userId, puEndpoint);
          respond("cyborg:push_unsubscribe_response", { ok: true });
          break;
        }

        case "cyborg:fcm_register": {
          const fcmToken = inner.token as string;
          const fcmPlatform = (inner.platform as string) || "android";
          if (!fcmToken) {
            respondError("token required");
            break;
          }
          await pg.upsertFcmToken({
            id: randomUUID(),
            userId: guest.userId,
            token: fcmToken,
            platform: fcmPlatform,
            deviceName: (inner.deviceName as string | undefined) ?? null,
          });
          respond("cyborg:fcm_register_response", { ok: true });
          break;
        }

        case "cyborg:fcm_unregister": {
          const fcmToken = inner.token as string;
          if (!fcmToken) {
            respondError("token required");
            break;
          }
          await pg.deleteFcmToken(fcmToken);
          respond("cyborg:fcm_unregister_response", { ok: true });
          break;
        }

        case "cyborg:fetch_daemon_info": {
          respond("cyborg:fetch_daemon_info_response", {
            daemonId: null,
            ownerId: null,
          });
          break;
        }

        case "cyborg:list_daemons": {
          const wId = inner.workspaceId as string;
          if (!wId) {
            respondError("workspaceId required");
            break;
          }
          const daemons = await pg.getDaemonsForWorkspace(wId);
          const connected = new Set(relay.getConnectedDaemons());
          // Reconcile liveness for DISPLAY (#555): a daemon counts as online if
          // its socket is on THIS instance OR it has a recent heartbeat in PG.
          // The connected-set is per-instance + non-durable, so after a relay
          // restart (or in multi-instance) an owned, subscribed, heartbeating
          // daemon would otherwise show offline and get filtered out of the
          // provider rows / sidebar. Heartbeat freshness is the durable signal.
          const now = Date.now();
          for (const d of daemons) {
            d.status = isDaemonOnline({
              connected: connected.has(d.id),
              lastSeenAt: d.lastSeenAt,
              now,
            })
              ? "online"
              : "offline";
          }
          // Optional preference: degrade to null if its (hand-applied) column is
          // missing on the cloud PG, rather than crashing the WHOLE daemon list.
          // This was the "daemons disappeared" incident — a drifted migration made
          // this query throw and took the entire list_daemons response down with it.
          let defaultSlashDaemonId: string | null = null;
          try {
            defaultSlashDaemonId = await pg.getUserDefaultSlashDaemon(guest.userId);
          } catch (err) {
            relayLog.error(
              { err },
              "list_daemons getUserDefaultSlashDaemon failed (degrading to null)",
            );
          }
          // Optional preference: the model the user's channel AI commands prefer
          // (null = auto-resolve). Same defensive degrade-to-null as above.
          let slashCommandModel: { provider: string; model: string } | null = null;
          try {
            slashCommandModel = await pg.getUserSlashCommandModel(guest.userId);
          } catch (err) {
            relayLog.error(
              { err },
              "list_daemons getUserSlashCommandModel failed (degrading to null)",
            );
          }
          // Workspace-level slash config (admin-controlled, #opt-A) — the source of
          // truth for routing; the per-user fields above are deprecated/back-compat.
          let workspaceSlashConfig:
            | {
                defaultSlashDaemonId: string | null;
                fallbackDaemons: string[];
                model: { provider: string; model: string } | null;
              }
            | undefined;
          try {
            workspaceSlashConfig = await pg.getWorkspaceSlashConfig(wId);
          } catch (err) {
            relayLog.error({ err }, "list_daemons getWorkspaceSlashConfig failed (omitting)");
          }
          respond("cyborg:list_daemons_response", {
            daemons,
            defaultSlashDaemonId,
            slashCommandModel,
            workspaceSlashConfig,
          });
          break;
        }

        case "cyborg:set_workspace_slash_config": {
          // Admin/owner-only: set the workspace's slash default daemon + ordered
          // fallbacks + model. Referenced daemons MUST belong to this workspace
          // (can't designate a foreign daemon).
          const wsId = inner.workspaceId as string;
          if (!wsId) {
            respondError("workspaceId required");
            break;
          }
          const role = await pg.getMemberRole(wsId, guest.userId);
          if (role !== "owner" && role !== "admin") {
            respondError("only a workspace owner or admin can change the slash AI config");
            break;
          }
          const wsDaemonIds = new Set((await pg.getDaemonsForWorkspace(wsId)).map((d) => d.id));
          const config: {
            defaultSlashDaemonId?: string | null;
            fallbackDaemons?: string[];
            model?: string | null;
          } = {};
          if (inner.defaultSlashDaemonId !== undefined) {
            const d = inner.defaultSlashDaemonId as string | null;
            if (d !== null && !wsDaemonIds.has(d)) {
              respondError("that daemon does not belong to this workspace");
              break;
            }
            config.defaultSlashDaemonId = d;
          }
          if (inner.fallbackDaemons !== undefined) {
            const list = inner.fallbackDaemons as unknown;
            if (!Array.isArray(list) || list.some((x) => typeof x !== "string")) {
              respondError("fallbackDaemons must be an array of daemon ids");
              break;
            }
            const foreign = (list as string[]).find((d) => !wsDaemonIds.has(d));
            if (foreign) {
              respondError(`daemon ${foreign} does not belong to this workspace`);
              break;
            }
            config.fallbackDaemons = list as string[];
          }
          if (inner.model !== undefined) {
            const m = inner.model as string | null;
            if (m !== null && (typeof m !== "string" || !m.includes("/"))) {
              respondError('model must be "provider/model" or null');
              break;
            }
            config.model = m;
          }
          // Daemon-access matrix (same gate as the spawn path): slash commands
          // RUN on the designated daemon, so introducing one requires owning it
          // or holding a daemon_access grant — admin role alone is not enough.
          const inaccessible = await findInaccessibleSlashDaemon({
            pg,
            workspaceId: wsId,
            userId: guest.userId,
            requested: config,
            current: await pg.getWorkspaceSlashConfig(wsId),
          });
          if (inaccessible) {
            respondError(slashDaemonAccessError(inaccessible));
            break;
          }
          await pg.setWorkspaceSlashConfig(wsId, config);
          const updated = await pg.getWorkspaceSlashConfig(wsId);
          respond("cyborg:set_workspace_slash_config_response", { ok: true, config: updated });
          break;
        }

        case "cyborg:get_workspace_slash_config": {
          // Read-back for the AI settings tab — any workspace member may read.
          const wsId = inner.workspaceId as string;
          if (!wsId) {
            respondError("workspaceId required");
            break;
          }
          const role = await pg.getMemberRole(wsId, guest.userId);
          if (!role) {
            respondError("not a member of this workspace");
            break;
          }
          const config = await pg.getWorkspaceSlashConfig(wsId);
          respond("cyborg:get_workspace_slash_config_response", { config });
          break;
        }

        case "cyborg:set_slash_command_model": {
          // Persist the user's preferred model for channel AI commands. Accepts
          // { provider, model } or null to clear (→ auto-resolve). Per-user, so no
          // workspace/daemon ownership check is needed (mirrors set_default_slash_daemon
          // which gates on ownership only because it names a specific daemon).
          const rawModel = inner.model as
            | { provider?: unknown; model?: unknown }
            | null
            | undefined;
          let selection: { provider: string; model: string } | null = null;
          if (rawModel) {
            if (typeof rawModel.provider !== "string" || typeof rawModel.model !== "string") {
              respondError("model must be { provider, model } or null");
              break;
            }
            selection = { provider: rawModel.provider, model: rawModel.model };
          }
          await pg.setUserSlashCommandModel(guest.userId, selection);
          respond("cyborg:set_slash_command_model_response", { model: selection });
          break;
        }

        case "cyborg:set_channel_slash_command_model": {
          // Per-CHANNEL override (wins over the user default). Same edit gate as
          // cyborg:update_channel (creator / workspace owner-admin / channel admin).
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const scmChId = inner.channelId as string;
          if (!scmChId) {
            respondError("channelId required");
            break;
          }
          const scmWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const scmChannel = await pg.getChannel(scmChId);
          if (!scmChannel || scmChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          const scmIsCreator = scmChannel.created_by === guest.userId;
          const scmIsWsAdmin = scmWsRole === "owner" || scmWsRole === "admin";
          const scmChRole = await pg.getChannelMemberRole(scmChId, guest.userId);
          if (!scmIsCreator && !scmIsWsAdmin && scmChRole !== "admin") {
            respondError("you don't have permission to change this channel's AI model");
            break;
          }
          const rawChModel = inner.model as
            | { provider?: unknown; model?: unknown }
            | null
            | undefined;
          let chSelection: { provider: string; model: string } | null = null;
          if (rawChModel) {
            if (typeof rawChModel.provider !== "string" || typeof rawChModel.model !== "string") {
              respondError("model must be { provider, model } or null");
              break;
            }
            chSelection = { provider: rawChModel.provider, model: rawChModel.model };
          }
          await pg.updateChannel(scmChId, {
            slashCommandModel: chSelection ? JSON.stringify(chSelection) : null,
          });
          respond("cyborg:set_channel_slash_command_model_response", {
            channelId: scmChId,
            model: chSelection,
          });
          break;
        }

        case "cyborg:set_channel_auto_tasks": {
          // Per-channel auto-tasks (channel watcher) opt-IN switch. The watcher
          // auto-spawns a cybo on un-mentioned human chatter ONLY when this is
          // explicitly enabled (default OFF). Same edit gate as
          // cyborg:set_channel_slash_command_model (creator / workspace
          // owner-admin / channel admin) — turning autonomy on is a managed action.
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const atChId = inner.channelId as string;
          if (!atChId) {
            respondError("channelId required");
            break;
          }
          if (typeof inner.enabled !== "boolean") {
            respondError("enabled must be a boolean");
            break;
          }
          const atChannel = await pg.getChannel(atChId);
          if (!atChannel || atChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          const atWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const atIsCreator = atChannel.created_by === guest.userId;
          const atIsWsAdmin = atWsRole === "owner" || atWsRole === "admin";
          const atChRole = await pg.getChannelMemberRole(atChId, guest.userId);
          if (!atIsCreator && !atIsWsAdmin && atChRole !== "admin") {
            respondError("you don't have permission to change this channel's auto-tasks");
            break;
          }
          await pg.setChannelAutoTasksEnabled(atChId, inner.enabled);
          respond("cyborg:set_channel_auto_tasks_response", {
            channelId: atChId,
            enabled: inner.enabled,
          });
          break;
        }

        case "cyborg:set_default_slash_daemon": {
          // Persist the user's default slash-command daemon. Only a daemon the
          // user OWNS is accepted (null clears the default).
          const daemonId = (inner.daemonId as string | null | undefined) ?? null;
          if (daemonId !== null) {
            const owned = (await pg.getDaemonsForWorkspace(inner.workspaceId as string)).some(
              (d) => d.id === daemonId && d.ownerId === guest.userId,
            );
            if (!owned) {
              respondError("you can only default to a daemon you own");
              break;
            }
          }
          await pg.setUserDefaultSlashDaemon(guest.userId, daemonId);
          respond("cyborg:set_default_slash_daemon_response", { daemonId });
          break;
        }

        case "cyborg:fetch_daemon_access": {
          const wId = inner.workspaceId as string;
          if (!wId) {
            respondError("workspaceId required");
            break;
          }
          const access = await pg.getDaemonAccessForWorkspace(wId);
          respond("cyborg:fetch_daemon_access_response", { access });
          break;
        }

        // ─── Daemon access REQUESTS (#705 REQUEST → NOTIFY → APPROVE) ───
        //
        // A non-owner asks the daemon OWNER for access at a requested set of scopes.
        // We create the (one-pending) request, persist an activity row for the owner
        // and live-push it so the inbox + badge update. The owner approves/denies via
        // resolve_daemon_access_request below.
        case "cyborg:request_daemon_access": {
          const wId = inner.workspaceId as string;
          const dId = inner.daemonId as string;
          const rawScopes = inner.scopes;
          if (!wId || !dId) {
            respondError("workspaceId and daemonId required");
            break;
          }
          if (!Array.isArray(rawScopes)) {
            respondError("scopes must be an array");
            break;
          }
          // Reject unknown scope strings (fail loudly, same as set_daemon_access).
          const unknownReq = rawScopes.filter((s) => !isDaemonScope(s));
          if (unknownReq.length > 0) {
            respondError(`unknown scope(s): ${unknownReq.join(", ")}`);
            break;
          }
          // A request must name at least one scope — unlike set_daemon_access
          // (where empty = revoke), an empty REQUEST would normalize to admin and
          // silently over-ask. Reject it.
          if (rawScopes.length === 0) {
            respondError("a request must include at least one access scope");
            break;
          }
          const reqScopes = [...normalizeScopes(rawScopes as string[])];
          const reqDaemons = await pg.getDaemonsForWorkspace(wId);
          const reqTarget = reqDaemons.find((d) => d.id === dId);
          if (!reqTarget) {
            respondError("daemon not found in this workspace");
            break;
          }
          // The owner is implicitly admin — a request from them is meaningless and
          // would create a row that shadows owner semantics. Reject it.
          if (reqTarget.ownerId === guest.userId) {
            respondError("you already own this daemon");
            break;
          }
          const requester = await pg.getUserById(guest.userId);
          const requesterName = requester?.name ?? requester?.email ?? null;
          const created = await pg.createDaemonAccessRequest({
            workspaceId: wId,
            daemonId: dId,
            requesterId: guest.userId,
            requesterName,
            scopes: reqScopes,
          });
          const requestPayload = serializeDaemonAccessRequest(created);

          // Notify the OWNER: persist an activity_events row (eventType is bare
          // text, no migration) + live-push the request-changed event AND an
          // activity_new so the badge increments. exceptWs is THIS socket so the
          // owner's other devices get it (the requester is not the owner anyway).
          const reqPreview = `${requesterName ?? "Someone"} requested ${roleForScopes(
            reqScopes,
          )} access to ${reqTarget.label}`;
          const reqActivityId = randomUUID();
          const reqActivityCreatedAt = Date.now();
          await emitActivityEvent(reqTarget.ownerId, {
            workspaceId: wId,
            eventType: "daemon_access_request",
            sourceType: "daemon",
            sourceId: created.id,
            previewText: reqPreview,
            actorId: guest.userId,
            actorName: requesterName,
          });
          notifyUserGuests(
            reqTarget.ownerId,
            "cyborg:daemon_access_request_changed",
            { request: requestPayload },
            ws,
          );
          notifyUserGuests(
            reqTarget.ownerId,
            "cyborg:activity_new",
            {
              id: reqActivityId,
              workspaceId: wId,
              eventType: "daemon_access_request",
              sourceType: "daemon",
              sourceId: created.id,
              channelId: null,
              previewText: reqPreview,
              actorId: guest.userId,
              actorName: requesterName,
              createdAt: reqActivityCreatedAt,
            },
            ws,
          );
          // Native push (APNs/FCM + web) to the owner's devices (#705): the
          // notifyUserGuests live pushes above only land while a session is OPEN, so a
          // request would otherwise reach an off-app owner only via the Daemons-tab
          // badge next time they look. dispatchPush reuses the message push path —
          // DND/away + active-desktop suppression + per-token badge + dead-token prune
          // — and the tap deep-links to the Daemons page (the approve/deny inbox).
          // Fire-and-forget + best-effort: a push failure must not fail the request.
          void dispatchPush(wId, [reqTarget.ownerId], {
            title: "Daemon access request",
            body: reqPreview,
            url: `/workspace/${wId}/settings/daemon`,
            tag: `daemon-access-request:${created.id}`,
          }).catch(() => {}); // intentional: best-effort push; a failure must not fail the request
          respond("cyborg:request_daemon_access_response", { request: requestPayload });
          break;
        }

        // Owner resolves a pending request: approve runs the existing grant
        // (setDaemonAccess) with the requested-or-overridden scopes; deny grants
        // nothing. OWNER-ONLY gate (the daemon's ownerId must be this guest). The
        // REQUESTER is notified (activity + live push), and on approve also gets the
        // access change pushed so their daemonState updates.
        case "cyborg:resolve_daemon_access_request": {
          const wId = inner.workspaceId as string;
          const reqId = inner.requestIdToResolve as string;
          const decision = inner.decision as string;
          const overrideScopesRaw = inner.scopes;
          if (!wId || !reqId) {
            respondError("workspaceId and requestIdToResolve required");
            break;
          }
          if (decision !== "approve" && decision !== "deny") {
            respondError("decision must be 'approve' or 'deny'");
            break;
          }
          const request = await pg.getDaemonAccessRequestById(reqId);
          if (!request || request.workspaceId !== wId) {
            respondError("request not found");
            break;
          }
          if (request.status !== "pending") {
            respondError("request already resolved");
            break;
          }
          const resolveDaemons = await pg.getDaemonsForWorkspace(wId);
          const resolveTarget = resolveDaemons.find((d) => d.id === request.daemonId);
          // OWNER-ONLY: only the daemon's owner may approve/deny.
          if (!resolveTarget || resolveTarget.ownerId !== guest.userId) {
            respondError("only the daemon owner can resolve access requests");
            break;
          }

          // Optional owner override of the requested scopes (applies on approve).
          // Validated up front (regardless of decision) to keep nesting shallow.
          if (overrideScopesRaw !== undefined && !Array.isArray(overrideScopesRaw)) {
            respondError("scopes must be an array");
            break;
          }
          const unknownOverride = Array.isArray(overrideScopesRaw)
            ? overrideScopesRaw.filter((s) => !isDaemonScope(s))
            : [];
          if (unknownOverride.length > 0) {
            respondError(`unknown scope(s): ${unknownOverride.join(", ")}`);
            break;
          }
          const grantedScopes: DaemonScope[] = Array.isArray(overrideScopesRaw)
            ? [...normalizeScopes(overrideScopesRaw as string[])]
            : [...normalizeScopes(request.scopes)];
          // Resolve FIRST (atomic, pending-only), then grant ONLY if we won the
          // race — resolved === null means another admin already resolved it, so we
          // must not grant again (prevents a double grant on concurrent approvals).
          const resolved = await pg.resolveDaemonAccessRequest(
            reqId,
            decision === "approve" ? "approved" : "denied",
            guest.userId,
          );
          if (decision === "approve" && resolved) {
            // Run the EXISTING grant with the approved scopes.
            await pg.setDaemonAccess(
              wId,
              request.daemonId,
              request.requesterId,
              grantedScopes,
              guest.userId,
            );
          }
          // resolveDaemonAccessRequest returns null only if the row vanished between
          // the load and the update (a concurrent delete). Fall back to the loaded
          // request with the new status so the response/push still carries a row.
          const resolvedRow = resolved ?? {
            ...request,
            status: decision === "approve" ? "approved" : "denied",
            resolvedBy: guest.userId,
            resolvedAt: new Date(),
          };
          const resolvedPayload = serializeDaemonAccessRequest(resolvedRow);

          // Notify the REQUESTER: activity row + live request-changed push.
          // Resolve the owner's display name so the feed shows a human name, not
          // the raw user UUID (the UI falls back to actor_id when actor_name is null).
          const resolver = await pg.getUserById(guest.userId);
          const resolverName = resolver?.name ?? resolver?.email ?? null;
          const resolvePreview =
            decision === "approve"
              ? `Your request for ${roleForScopes(grantedScopes)} access to ${resolveTarget.label} was approved`
              : `Your request for access to ${resolveTarget.label} was denied`;
          await emitActivityEvent(request.requesterId, {
            workspaceId: wId,
            eventType: "daemon_access_request_resolved",
            sourceType: "daemon",
            sourceId: request.id,
            previewText: resolvePreview,
            actorId: guest.userId,
            actorName: resolverName,
          });
          notifyUserGuests(
            request.requesterId,
            "cyborg:daemon_access_request_changed",
            { request: resolvedPayload },
            ws,
          );
          notifyUserGuests(
            request.requesterId,
            "cyborg:activity_new",
            {
              id: randomUUID(),
              workspaceId: wId,
              eventType: "daemon_access_request_resolved",
              sourceType: "daemon",
              sourceId: request.id,
              channelId: null,
              previewText: resolvePreview,
              actorId: guest.userId,
              actorName: resolverName,
              createdAt: Date.now(),
            },
            ws,
          );
          // On approve, also push the access change so the requester's daemonState
          // refreshes live (mirrors set_daemon_access semantics): they now hold
          // grantedScopes on this daemon.
          if (decision === "approve") {
            notifyUserGuests(
              request.requesterId,
              "cyborg:set_daemon_access_response",
              {
                ok: true,
                daemonId: request.daemonId,
                userId: request.requesterId,
                scopes: grantedScopes,
              },
              ws,
            );
          }
          respond("cyborg:resolve_daemon_access_request_response", { request: resolvedPayload });
          break;
        }

        // Owner inbox + requester outbox: the PENDING requests the caller should
        // see — requests for daemons the caller OWNS, plus their own outgoing
        // requests. Resolved requests are excluded (the inbox is actionable-only).
        case "cyborg:fetch_daemon_access_requests": {
          const wId = inner.workspaceId as string;
          if (!wId) {
            respondError("workspaceId required");
            break;
          }
          const pending = await pg.listDaemonAccessRequests(wId, { status: "pending" });
          const wsDaemons = await pg.getDaemonsForWorkspace(wId);
          const ownedDaemonIds = new Set(
            wsDaemons.filter((d) => d.ownerId === guest.userId).map((d) => d.id),
          );
          const visible = pending.filter(
            (r) => ownedDaemonIds.has(r.daemonId) || r.requesterId === guest.userId,
          );
          respond("cyborg:fetch_daemon_access_requests_response", {
            requests: visible.map(serializeDaemonAccessRequest),
          });
          break;
        }

        // Idempotently SET a user's scopes on a daemon (#705). The single
        // authoritative access-mutation RPC: scopes=['chat','spawn',...] grants
        // exactly that set; scopes=[] (or all-invalid) REVOKES (deletes the row).
        // Owner-only (same gate as the legacy grant/revoke) — no weakening. Invalid
        // scope strings are rejected up front so a bad client can't store garbage.
        case "cyborg:set_daemon_access": {
          const wId = inner.workspaceId as string;
          const dId = inner.daemonId as string;
          const uId = inner.userId as string;
          const rawScopes = inner.scopes;
          if (!wId || !dId || !uId) {
            respondError("workspaceId, daemonId, userId required");
            break;
          }
          if (!Array.isArray(rawScopes)) {
            respondError("scopes must be an array");
            break;
          }
          // Reject unknown scope strings (don't silently drop — a client sending an
          // unrecognized scope is a bug or an attack; fail loudly).
          const unknown = rawScopes.filter((s) => !isDaemonScope(s));
          if (unknown.length > 0) {
            respondError(`unknown scope(s): ${unknown.join(", ")}`);
            break;
          }
          const setScopes = rawScopes as DaemonScope[];
          const setDaemons = await pg.getDaemonsForWorkspace(wId);
          const setTarget = setDaemons.find((d) => d.id === dId);
          if (!setTarget || setTarget.ownerId !== guest.userId) {
            respondError("only daemon owner can manage access");
            break;
          }
          // Granting access to yourself is a no-op (owner already has all scopes);
          // disallow targeting the owner so the row never shadows owner semantics.
          if (uId === setTarget.ownerId) {
            respondError("the daemon owner already has full access");
            break;
          }
          await pg.setDaemonAccess(wId, dId, uId, setScopes, guest.userId);
          respond("cyborg:set_daemon_access_response", {
            ok: true,
            daemonId: dId,
            userId: uId,
            scopes: setScopes,
          });
          break;
        }

        case "cyborg:grant_daemon_access": {
          const wId = inner.workspaceId as string;
          const dId = inner.daemonId as string;
          const uId = inner.userId as string;
          if (!wId || !dId || !uId) {
            respondError("workspaceId, daemonId, userId required");
            break;
          }
          const grantDaemons = await pg.getDaemonsForWorkspace(wId);
          const grantTarget = grantDaemons.find((d) => d.id === dId);
          if (!grantTarget || grantTarget.ownerId !== guest.userId) {
            respondError("only daemon owner can manage access");
            break;
          }
          await pg.grantDaemonAccess(wId, dId, uId, guest.userId);
          respond("cyborg:grant_daemon_access_response", { ok: true });
          break;
        }

        case "cyborg:rename_daemon": {
          const wId = inner.workspaceId as string;
          const dId = inner.daemonId as string;
          const rawLabel = inner.label as string;
          const newLabel = typeof rawLabel === "string" ? rawLabel.trim() : "";
          if (!wId || !dId || !newLabel) {
            respondError("workspaceId, daemonId, label required");
            break;
          }
          if (newLabel.length > 64) {
            respondError("label too long (max 64 characters)");
            break;
          }
          const renameDaemons = await pg.getDaemonsForWorkspace(wId);
          const renameTarget = renameDaemons.find((d) => d.id === dId);
          if (!renameTarget || renameTarget.ownerId !== guest.userId) {
            respondError("only the daemon owner can rename it");
            break;
          }
          await pg.renameDaemon(dId, newLabel);
          respond("cyborg:rename_daemon_response", { ok: true, daemonId: dId, label: newLabel });
          break;
        }

        case "cyborg:revoke_daemon_access": {
          const wId = inner.workspaceId as string;
          const dId = inner.daemonId as string;
          const uId = inner.userId as string;
          if (!wId || !dId || !uId) {
            respondError("workspaceId, daemonId, userId required");
            break;
          }
          const revokeDaemons = await pg.getDaemonsForWorkspace(wId);
          const revokeTarget = revokeDaemons.find((d) => d.id === dId);
          if (!revokeTarget || revokeTarget.ownerId !== guest.userId) {
            respondError("only daemon owner can manage access");
            break;
          }
          await pg.revokeDaemonAccess(wId, dId, uId);
          respond("cyborg:revoke_daemon_access_response", { ok: true });
          break;
        }

        case "cyborg:list_daemon_workspaces": {
          const dId = inner.daemonId as string;
          if (!dId) {
            respondError("daemonId required");
            break;
          }
          const owner = await pg.getDaemonOwner(dId);
          if (owner !== guest.userId) {
            respondError("only daemon owner can manage workspaces");
            break;
          }
          const workspaces = await pg.getDaemonWorkspaces(guest.userId, dId);
          respond("cyborg:list_daemon_workspaces_response", { workspaces });
          break;
        }

        case "cyborg:set_daemon_workspace": {
          const dId = inner.daemonId as string;
          const wId = inner.workspaceId as string;
          const enabled = inner.enabled as boolean;
          if (!dId || !wId || typeof enabled !== "boolean") {
            respondError("daemonId, workspaceId, enabled required");
            break;
          }
          // Owner-of-daemon AND member-of-target-workspace — see
          // PgSync.canManageDaemonWorkspace for the cross-tenant rationale.
          const verdict = await pg.canManageDaemonWorkspace(guest.userId, dId, wId);
          if (verdict === "not_owner") {
            respondError("only daemon owner can manage workspaces");
            break;
          }
          if (verdict === "not_member") {
            respondError("not a member of this workspace");
            break;
          }
          await pg.setWorkspaceDaemonEnabled(wId, dId, enabled);
          // Apply live to any connected instance so it takes effect without a
          // reconnect (PG row is the durable source of truth across reconnects).
          relay.setDaemonWorkspaceServing(dId, wId, enabled);
          respond("cyborg:set_daemon_workspace_response", { ok: true });
          break;
        }

        case "cyborg:invite_member": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const email = normalizeEmail((inner.email as string) ?? "");
          const role = (inner.role as string) || "member";
          if (!email) {
            respondError("email required");
            break;
          }
          if (!isValidEmail(email)) {
            respondError("invalid email address");
            break;
          }
          if (!VALID_WORKSPACE_ROLES.has(role)) {
            respondError("invalid role");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner" && callerRole !== "admin") {
            respondError("forbidden");
            break;
          }
          // Only an owner may mint another owner — stops an admin escalating a
          // colluding account to owner (which can delete the workspace / change roles).
          if (role === "owner" && callerRole !== "owner") {
            respondError("only an owner can grant the owner role");
            break;
          }
          let targetUser = await pg.getUserByEmail(email);
          if (!targetUser) {
            const newId = randomUUID();
            await pg.upsertUser(newId, email, email.split("@")[0]);
            targetUser = { id: newId, email, name: email.split("@")[0], passwordHash: null };
          } else {
            // Don't re-invite (and silently downgrade) an already-active member.
            const existing = (await pg.getMembers(workspaceId)).find(
              (m) => m.userId === targetUser!.id,
            );
            if (existing && existing.membershipType === "active") {
              respondError("already a member");
              break;
            }
          }
          await pg.addMember(workspaceId, targetUser.id, role, "invited");
          const members = await pg.getMembers(workspaceId);
          const membership = members.find((m) => m.userId === targetUser!.id);

          // Full invite flow: reuse + refresh the pending invite for this
          // (workspace, email) if one exists (matching the partial unique index),
          // otherwise create a fresh token. Either way the token is good for 7d.
          const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
          const existingInvite = await pg.getPendingInvitation(workspaceId, email);
          let invitationId: string;
          if (existingInvite) {
            invitationId = existingInvite.id;
            await pg.updateInvitationExpiry(invitationId, expiresAt);
          } else {
            invitationId = randomBytes(32).toString("hex");
            await pg.createInvitation({
              id: invitationId,
              workspaceId,
              email,
              role,
              createdBy: guest.userId,
              expiresAt,
            });
          }
          const inviteUrl = `${INVITE_BASE_URL}/invite/${invitationId}`;

          // ALWAYS (re)send the invite email, but never fail the RPC on a send
          // error — the invite row + link are already valid (graceful degrade).
          const inviteWs = await pg.getWorkspaceById(workspaceId);
          try {
            await sendInvitationEmail(email, inviteUrl, inviteWs?.name ?? "a workspace");
          } catch (err) {
            relayLog.error({ err }, "invite email send failed");
          }

          respond("cyborg:invite_member_response", { membership, invitationId, inviteUrl });
          break;
        }

        case "cyborg:resend_invitation": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const invitationId = inner.invitationId as string;
          if (!invitationId) {
            respondError("invitationId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner" && callerRole !== "admin") {
            respondError("forbidden");
            break;
          }
          const invite = await pg.getInvitation(invitationId);
          if (!invite || invite.workspaceId !== workspaceId) {
            respondError("invitation not found");
            break;
          }
          if (invite.acceptedAt) {
            respondError("invitation already accepted");
            break;
          }
          const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
          await pg.updateInvitationExpiry(invitationId, expiresAt);
          const inviteUrl = `${INVITE_BASE_URL}/invite/${invitationId}`;
          const inviteWs = await pg.getWorkspaceById(workspaceId);
          try {
            await sendInvitationEmail(invite.email, inviteUrl, inviteWs?.name ?? "a workspace");
          } catch (err) {
            relayLog.error({ err }, "invite email resend failed");
          }
          respond("cyborg:resend_invitation_response", { invitationId, sentAt: Date.now() });
          break;
        }

        case "cyborg:accept_invitation": {
          const invitationToken = inner.invitationToken as string;
          if (!invitationToken) {
            respondError("invitationToken required");
            break;
          }
          const invite = await pg.getInvitation(invitationToken);
          if (!invite) {
            respondError("invitation not found");
            break;
          }
          if (invite.acceptedAt) {
            respondError("invitation already accepted");
            break;
          }
          if (invite.expiresAt.getTime() < Date.now()) {
            respondError("invitation expired");
            break;
          }
          // The invite is bound to a specific email — only the user who owns
          // that address (the accepting guest) may accept it.
          const invitedUser = await pg.getUserByEmail(invite.email);
          if (invitedUser?.id !== guest.userId) {
            respondError("email mismatch");
            break;
          }
          await pg.markInvitationAccepted(invitationToken, guest.userId);
          // Ensure an ACTIVE membership: flip an existing invited row, or add a
          // fresh active one if none exists (e.g. the invited row was removed).
          const existing = await pg.getMemberRole(invite.workspaceId, guest.userId);
          if (existing) {
            await pg.setMembershipType(invite.workspaceId, guest.userId, "active");
          } else {
            await pg.addMember(invite.workspaceId, guest.userId, invite.role, "active");
          }
          // Auto-join the workspace's default public channel so the new member's
          // channel list isn't empty (mirrors activateInvitedMemberships).
          await pg.joinDefaultChannels(invite.workspaceId, guest.userId);
          const members = await pg.getMembers(invite.workspaceId);
          const membership = members.find((m) => m.userId === guest.userId);
          respond("cyborg:accept_invitation_response", {
            membership,
            workspaceId: invite.workspaceId,
          });
          break;
        }

        case "cyborg:list_pending_invitations": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner" && callerRole !== "admin") {
            respondError("forbidden");
            break;
          }
          const invitations = await pg.getPendingInvitations(workspaceId);
          respond("cyborg:list_pending_invitations_response", {
            invitations: invitations.map((i) => {
              const out: {
                id: string;
                email: string;
                role: string;
                createdAt: number;
                expiresAt: number;
                createdByName?: string;
              } = {
                id: i.id,
                email: i.email,
                role: i.role,
                createdAt: i.createdAt,
                expiresAt: i.expiresAt,
              };
              if (i.createdByName) out.createdByName = i.createdByName;
              return out;
            }),
          });
          break;
        }

        case "cyborg:cancel_invitation": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const invitationId = inner.invitationId as string;
          if (!invitationId) {
            respondError("invitationId required");
            break;
          }
          const invite = await pg.getInvitation(invitationId);
          if (!invite || invite.workspaceId !== workspaceId) {
            respondError("invitation not found");
            break;
          }
          if (invite.acceptedAt) {
            respondError("invitation already accepted");
            break;
          }
          // Owner/admin OR the inviter who created this invitation may cancel it.
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          const isPrivileged = callerRole === "owner" || callerRole === "admin";
          if (!isPrivileged && invite.createdBy !== guest.userId) {
            respondError("forbidden");
            break;
          }
          await pg.deleteInvitation(invitationId);
          // Drop the phantom "invited" membership created at invite time so a
          // canceled invitee isn't left as a ghost member. Never touch an active
          // membership (they may have joined another way).
          const invitedUser = await pg.getUserByEmail(invite.email);
          if (invitedUser) {
            const mem = (await pg.getMembers(workspaceId)).find((m) => m.userId === invitedUser.id);
            if (mem && mem.membershipType === "invited") {
              await pg.removeMember(workspaceId, invitedUser.id);
            }
          }
          respond("cyborg:cancel_invitation_response", { invitationId });
          break;
        }

        case "cyborg:remove_member": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const targetUserId = inner.userId as string;
          if (!targetUserId) {
            respondError("userId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner" && callerRole !== "admin") {
            respondError("forbidden");
            break;
          }
          const targetRole = await pg.getMemberRole(workspaceId, targetUserId);
          if (targetRole === "owner") {
            respondError("cannot remove owner");
            break;
          }
          await pg.removeMember(workspaceId, targetUserId);
          respond("cyborg:remove_member_response", { removed: true });
          break;
        }

        case "cyborg:update_role": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const targetUserId = inner.userId as string;
          const newRole = inner.role as string;
          if (!targetUserId || !newRole) {
            respondError("userId and role required");
            break;
          }
          if (!VALID_WORKSPACE_ROLES.has(newRole)) {
            respondError("invalid role");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner") {
            respondError("only owner can change roles");
            break;
          }
          await pg.updateMemberRole(workspaceId, targetUserId, newRole);
          respond("cyborg:update_role_response", { updated: true });
          break;
        }

        // ─── MCP tokens (settings tab) ─────────────────────────────
        // Tokens are isolated PER USER: any workspace member can create and
        // manage THEIR OWN tokens (list/toggle/revoke are owner_id-scoped in
        // SQL), and a user-identity token can only ever act as the caller —
        // never another user. The workspace master switch stays owner/admin.
        case "cyborg:mcp_list": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!callerRole) {
            respondError("not a member of this workspace");
            break;
          }
          const [enabled, tokens, cybos, self] = await Promise.all([
            pg.getMcpEnabled(workspaceId),
            pg.listMcpTokens(workspaceId, guest.userId),
            pg.getCybos(workspaceId),
            pg.getUserById(guest.userId),
          ]);
          respond("cyborg:mcp_list_response", {
            enabled,
            tokens,
            connectionUrl: relayPublicUrl ? `${relayPublicUrl}/mcp` : null,
            identities: {
              self: self ? { id: self.id, name: self.name ?? self.email } : null,
              // Viewers cannot run agents, so they don't get cybo identities to
              // mint tokens for (mirrors the cyborg:agent gate).
              cybos: callerRole === "viewer" ? [] : cybos.map((c) => ({ id: c.id, name: c.name })),
            },
          });
          break;
        }

        case "cyborg:mcp_set_enabled": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (callerRole !== "owner" && callerRole !== "admin") {
            respondError("forbidden");
            break;
          }
          await pg.setMcpEnabled(workspaceId, inner.enabled === true);
          respond("cyborg:mcp_set_enabled_response", { enabled: inner.enabled === true });
          break;
        }

        case "cyborg:set_workspace_autonomy": {
          // Per-workspace master switch for un-mentioned channel watchers. DEFAULT
          // ON; owner/admin only. @-mentions are UNAFFECTED by this flag — a directly
          // tagged agent always responds.
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (role !== "owner" && role !== "admin") {
            respondError("only a workspace owner or admin can change agent autonomy");
            break;
          }
          await pg.setWorkspaceAutonomyEnabled(workspaceId, inner.enabled === true);
          respond("cyborg:set_workspace_autonomy_response", {
            ok: true,
            enabled: inner.enabled === true,
          });
          // Fan out to this workspace's guests (Redis cross-instance, so guests on
          // other relay instances reflect it too) and forward to its daemons so the
          // local-daemon watcher path sees the new state without a refetch.
          broadcastToGuests(workspaceId, {
            type: "cyborg:workspace_autonomy_updated",
            payload: { workspaceId, enabled: inner.enabled === true },
          });
          relay.sendToAllDaemonsInWorkspace(workspaceId, {
            type: "cyborg:workspace_autonomy_updated",
            payload: { workspaceId, enabled: inner.enabled === true },
          });
          break;
        }

        case "cyborg:get_workspace_autonomy": {
          // Read-back for the settings UI — any workspace member may read.
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const role = await pg.getMemberRole(workspaceId, guest.userId);
          if (!role) {
            respondError("not a member of this workspace");
            break;
          }
          respond("cyborg:get_workspace_autonomy_response", {
            enabled: await pg.getWorkspaceAutonomyEnabled(workspaceId),
          });
          break;
        }

        case "cyborg:mcp_create_token": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!callerRole) {
            respondError("not a member of this workspace");
            break;
          }
          const name = ((inner.name as string) ?? "").trim();
          const identityType = inner.identityType === "user" ? "user" : "cybo";
          const identityId = inner.identityId as string;
          const scopes = Array.isArray(inner.scopes)
            ? (inner.scopes as string[]).filter((s) => s === "read" || s === "write")
            : [];
          if (!name || !identityId || scopes.length === 0) {
            respondError("name, identityId and at least one scope are required");
            break;
          }
          if (identityType === "user") {
            // Anti-impersonation: a member can only mint user tokens that act as
            // THEMSELVES. (Identity still re-checked per request in mcp/http.ts.)
            if (identityId !== guest.userId) {
              respondError("a user token can only act as yourself");
              break;
            }
          } else {
            // Cybo tokens let the holder act through an agent — viewers cannot
            // run agents, so they cannot mint these either.
            if (callerRole === "viewer") {
              respondError("viewers cannot create agent tokens");
              break;
            }
            const cybos = await pg.getCybos(workspaceId);
            if (!cybos.some((c) => c.id === identityId)) {
              respondError("cybo not found in this workspace");
              break;
            }
          }
          const expiresInDays = Number(inner.expiresInDays);
          const expiresAt =
            Number.isFinite(expiresInDays) && expiresInDays > 0
              ? new Date(Date.now() + expiresInDays * 86400 * 1000)
              : null;
          const { raw, hash } = generateMcpToken(workspaceId);
          const tokenRowId = newMcpTokenId();
          await pg.createMcpToken({
            id: tokenRowId,
            tokenHash: hash,
            name,
            workspaceId,
            ownerId: guest.userId,
            identityType,
            identityId,
            scopes,
            expiresAt,
          });
          // Raw token returned ONCE — never stored or re-fetchable.
          respond("cyborg:mcp_create_token_response", { id: tokenRowId, token: raw });
          break;
        }

        case "cyborg:mcp_toggle_token": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!callerRole) {
            respondError("not a member of this workspace");
            break;
          }
          const tokenId = inner.tokenId as string;
          if (!tokenId) {
            respondError("tokenId required");
            break;
          }
          // owner_id scoping in SQL: flipping someone else's token matches 0 rows.
          const ok = await pg.setMcpTokenEnabled(
            tokenId,
            workspaceId,
            guest.userId,
            inner.enabled === true,
          );
          respond("cyborg:mcp_toggle_token_response", { updated: ok });
          break;
        }

        case "cyborg:mcp_revoke_token": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const callerRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!callerRole) {
            respondError("not a member of this workspace");
            break;
          }
          const tokenId = inner.tokenId as string;
          if (!tokenId) {
            respondError("tokenId required");
            break;
          }
          const revoked = await pg.revokeMcpToken(tokenId, workspaceId, guest.userId);
          respond("cyborg:mcp_revoke_token_response", { revoked });
          break;
        }

        // ─── Webhooks (inbound, GitHub-style config) ──────────────────
        // All webhook config RPCs are CHANNEL-ADMIN gated: a workspace owner/admin
        // OR a channel admin of the target channel. The endpoint itself stays
        // public+token-authed; these only manage the config rows.
        case "cyborg:webhook_list":
        case "cyborg:webhook_create":
        case "cyborg:webhook_update":
        case "cyborg:webhook_rotate_secret":
        case "cyborg:webhook_delete":
        case "cyborg:webhook_list_deliveries":
        case "cyborg:webhook_redeliver": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const whChannelId = inner.channelId as string | undefined;
          // Resolve the channel from the webhook/delivery id for the ops that
          // don't pass channelId directly.
          let resolvedChannelId = whChannelId ?? null;
          let resolvedWebhookId = (inner.webhookId as string | undefined) ?? null;
          if (!resolvedChannelId && resolvedWebhookId) {
            const wh = await pg.getWebhook(resolvedWebhookId);
            resolvedChannelId = wh?.channelId ?? null;
          }
          if (!resolvedChannelId && type === "cyborg:webhook_redeliver") {
            const deliveryId = inner.deliveryId as string | undefined;
            if (deliveryId) {
              const d = await pg.getWebhookDelivery(deliveryId);
              resolvedChannelId = d?.channelId ?? null;
              resolvedWebhookId = d?.webhookId ?? resolvedWebhookId;
            }
          }
          if (!resolvedChannelId) {
            respondError("channelId required");
            break;
          }
          const whChannel = await pg.getChannel(resolvedChannelId);
          if (!whChannel || whChannel.workspace_id !== workspaceId) {
            respondError("channel not found");
            break;
          }
          const whWsRole = await pg.getMemberRole(workspaceId, guest.userId);
          const whChRole = await pg.getChannelMemberRole(resolvedChannelId, guest.userId);
          const whIsAdmin = whWsRole === "owner" || whWsRole === "admin" || whChRole === "admin";
          if (!whIsAdmin) {
            respondError("channel admin required");
            break;
          }

          if (type === "cyborg:webhook_list") {
            const webhooks = await pg.listWebhooks(resolvedChannelId);
            respond("cyborg:webhook_list_response", { webhooks });
            break;
          }

          if (type === "cyborg:webhook_create") {
            const name = ((inner.name as string) ?? "Webhook").trim().slice(0, 100) || "Webhook";
            const eventMode =
              inner.eventMode === "all" || inner.eventMode === "select"
                ? inner.eventMode
                : "release";
            const events = Array.isArray(inner.events)
              ? (inner.events as unknown[]).filter((e): e is string => typeof e === "string")
              : [];
            // Generate a secret if requested. Returned ONCE in the response.
            const wantSecret = inner.generateSecret === true;
            const secret = wantSecret ? `whsec_${randomBytes(24).toString("hex")}` : null;
            const id = `wh_${randomUUID()}`;
            await pg.createWebhook({
              id,
              channelId: resolvedChannelId,
              workspaceId,
              name,
              secret,
              contentType:
                typeof inner.contentType === "string" ? inner.contentType : "application/json",
              eventMode,
              events,
              active: inner.active !== false,
              createdBy: guest.userId,
            });
            respond("cyborg:webhook_create_response", { id, secret });
            break;
          }

          if (type === "cyborg:webhook_update") {
            if (!resolvedWebhookId) {
              respondError("webhookId required");
              break;
            }
            const patch: {
              name?: string;
              contentType?: string;
              eventMode?: string;
              events?: string[];
              active?: boolean;
            } = {};
            if (typeof inner.name === "string") patch.name = inner.name.trim().slice(0, 100);
            if (typeof inner.contentType === "string") patch.contentType = inner.contentType;
            if (
              inner.eventMode === "all" ||
              inner.eventMode === "select" ||
              inner.eventMode === "release"
            ) {
              patch.eventMode = inner.eventMode;
            }
            if (Array.isArray(inner.events)) {
              patch.events = (inner.events as unknown[]).filter(
                (e): e is string => typeof e === "string",
              );
            }
            if (typeof inner.active === "boolean") patch.active = inner.active;
            const updated = await pg.updateWebhook(resolvedWebhookId, workspaceId, patch);
            respond("cyborg:webhook_update_response", { updated });
            break;
          }

          if (type === "cyborg:webhook_rotate_secret") {
            if (!resolvedWebhookId) {
              respondError("webhookId required");
              break;
            }
            // `clear: true` removes the secret (disables signature verification);
            // otherwise mint a fresh one, returned ONCE.
            const clear = inner.clear === true;
            const secret = clear ? null : `whsec_${randomBytes(24).toString("hex")}`;
            const ok = await pg.setWebhookSecret(resolvedWebhookId, workspaceId, secret);
            respond("cyborg:webhook_rotate_secret_response", { updated: ok, secret });
            break;
          }

          if (type === "cyborg:webhook_delete") {
            if (!resolvedWebhookId) {
              respondError("webhookId required");
              break;
            }
            const deleted = await pg.deleteWebhook(resolvedWebhookId, workspaceId);
            respond("cyborg:webhook_delete_response", { deleted });
            break;
          }

          if (type === "cyborg:webhook_list_deliveries") {
            if (!resolvedWebhookId) {
              respondError("webhookId required");
              break;
            }
            const deliveries = await pg.listWebhookDeliveries(resolvedWebhookId, 30);
            respond("cyborg:webhook_list_deliveries_response", { deliveries });
            break;
          }

          if (type === "cyborg:webhook_redeliver") {
            const deliveryId = inner.deliveryId as string | undefined;
            if (!deliveryId) {
              respondError("deliveryId required");
              break;
            }
            const original = await pg.getWebhookDelivery(deliveryId);
            if (!original || original.channelId !== resolvedChannelId) {
              respondError("delivery not found");
              break;
            }
            // Replay the original request body through the same build path. We
            // re-post the message and record a NEW delivery linked to the source.
            const ev = original.event;
            let replayPayload: Record<string, unknown> = {};
            try {
              replayPayload = original.requestBody
                ? (JSON.parse(original.requestBody) as Record<string, unknown>)
                : {};
            } catch {
              replayPayload = original.requestBody ? { text: original.requestBody } : {};
            }
            const card = ev === "release" ? synthesizeReleaseCard(replayPayload) : null;
            const text =
              card?.text ??
              (typeof replayPayload.text === "string" ? replayPayload.text.trim() : "");
            if (!text) {
              respondError("nothing to redeliver");
              break;
            }
            const fromName =
              card?.fromName ??
              (typeof replayPayload.username === "string" && replayPayload.username.trim()
                ? replayPayload.username.trim().slice(0, 80)
                : "Webhook");
            const redeliverMsgId = randomUUID();
            relay.injectMessage(
              workspaceId,
              {
                type: "cyborg:channel_message_broadcast",
                payload: {
                  id: redeliverMsgId,
                  workspaceId,
                  channelId: resolvedChannelId,
                  fromId: guest.userId,
                  fromType: "human",
                  fromName,
                  toId: null,
                  text,
                  mentions: null,
                  parentId: null,
                  attachments: null,
                  card: card?.card ?? null,
                  source: "webhook",
                  createdAt: Date.now(),
                },
              },
              guest.userId,
            );
            await pg.insertWebhookDelivery({
              id: randomUUID(),
              webhookId: original.webhookId,
              channelId: resolvedChannelId,
              workspaceId,
              event: ev,
              action: original.action,
              requestHeaders: original.requestHeaders,
              requestBody: original.requestBody,
              responseStatus: 200,
              responseBody: JSON.stringify({ ok: true, messageId: redeliverMsgId }),
              ok: true,
              redeliveredFrom: original.id,
            });
            respond("cyborg:webhook_redeliver_response", { ok: true, messageId: redeliverMsgId });
            break;
          }
          break;
        }

        case "cyborg:reaction": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const messageId = inner.messageId as string;
          const emoji = inner.emoji as string;
          if (!messageId || !emoji) {
            respondError("messageId and emoji required");
            break;
          }
          // Match sibling write ops: members only, viewers can't react.
          const reactRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!reactRole || reactRole === "viewer") {
            respondError("you can't react in this workspace");
            break;
          }
          const reactUser = await pg.getUserById(guest.userId);
          const reactName = reactUser?.name ?? reactUser?.email ?? "Unknown";
          const action = await pg.toggleReaction(
            workspaceId,
            messageId,
            guest.userId,
            reactName,
            emoji,
          );
          broadcastToGuests(workspaceId, {
            type: "cyborg:reaction_broadcast",
            // Payload envelope: the client reads broadcast data from `payload`.
            // Top-level fields are dropped client-side, so an unwrapped reaction
            // arrived with payload=undefined and crashed the message handler.
            payload: {
              workspaceId,
              messageId,
              userId: guest.userId,
              userName: reactName,
              emoji,
              action,
            },
          });
          break;
        }

        case "cyborg:create_task": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const ctRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!ctRole || ctRole === "viewer") {
            respondError("you can't create tasks in this workspace");
            break;
          }
          // Tasks Redesign GATE: a task explicitly targeted at a Tasks-project must
          // land in a project the caller can see (fail-closed). The workspace
          // role!=viewer write check above still applies; this adds project scope.
          const ctProjectId = inner.projectId as string | undefined;
          if (ctProjectId && !(await pg.assertProjectVisible(ctProjectId, guest.userId))) {
            respondError("project not found");
            break;
          }
          const taskId = randomUUID();
          // Tasks Redesign — the create-path require-rule (project | channel | parent)
          // lives in pg.createTask's resolver: it throws "provide projectId or
          // channelId" when none is supplied, or "project not found" when an explicit
          // projectId is unknown. Surface those as a clear client error (respondError)
          // and stop before the activity-feed / broadcast side effects, instead of
          // letting the create proceed with an undefined task.
          try {
            await pg.createTask({
              id: taskId,
              workspaceId,
              title: (inner.title as string) || "Untitled",
              createdBy: guest.userId,
              description: inner.description as string | undefined,
              assigneeId: inner.assigneeId as string | undefined,
              // Tasks Phase 2 (watcher): the UI can scope a task to a channel and
              // set a board priority — forward both so they survive the create
              // instead of being dropped at this guest path.
              channelId: inner.channelId as string | undefined,
              priority: inner.priority as string | undefined,
              // Tasks Redesign — Plane-style fields. pg.createTask resolves the
              // effective project (explicit projectId → channel's project / Inbox →
              // parentId inherit, else error), the workflow state (else the project
              // default), the sub-task parent, planned start, and the single cycle.
              // Forwarded so they survive the cloud create path.
              projectId: ctProjectId,
              parentId: inner.parentId as string | null | undefined,
              stateId: inner.stateId as string | undefined,
              startDate: inner.startDate as number | null | undefined,
              cycleId: inner.cycleId as string | null | undefined,
              // Tasks Redesign — denormalized sets. labels are NAMES (createTask
              // resolves/creates them against the task's final project); moduleIds
              // are ids. Forwarded so they survive the cloud create instead of being
              // dropped on the guest path.
              labelNames: Array.isArray(inner.labels) ? (inner.labels as string[]) : undefined,
              moduleIds: Array.isArray(inner.moduleIds) ? (inner.moduleIds as string[]) : undefined,
              // User-facing create handler — require an explicit project/channel/
              // parent context (no silent Inbox fallback). With none, the resolver
              // throws "provide projectId or channelId", surfaced via respondError
              // below. (The 2nd-workspace MCP server calls pg.createTask WITHOUT this
              // flag → default Inbox fallback, per its own contract.)
              requireProjectContext: true,
            });
          } catch (err) {
            respondError(err instanceof Error ? err.message : "task create failed");
            break;
          }
          const tasks = await pg.getTasks(workspaceId);
          const task = tasks.find((t) => t.id === taskId);
          respond("cyborg:create_task_response", { task: task ? mapTask(task) : { id: taskId } });
          // Tasks Redesign — append a 'created' row to the per-task Activity feed
          // (task_activity, read by the work-item Activity pane via
          // fetch_task_activity). The daemon write path does this in WorkspaceRelay;
          // the cloud relay must too, else a task filed through relay-standalone has
          // an empty Activity tab. Best-effort: a feed-write failure must NOT fail the
          // create the human already committed. epoch is full-precision ms.
          try {
            await pg.recordTaskActivity({
              taskId,
              workspaceId,
              actorId: guest.userId,
              verb: "created",
              epoch: Date.now(),
            });
          } catch (err) {
            relayLog.warn({ err, taskId }, "task_activity created-row failed");
          }
          // Activity feed + live update. A human assignee (not the creator) gets a
          // "task_assigned" row via the SAME activity path as message mentions; a
          // cybo/agent assignee produces none (isHumanRecipient is false — agents
          // aren't workspace members). tasks_changed lets open task views refresh.
          if (task) {
            const mapped = mapTask(task);
            void (async () => {
              try {
                const memberIds = new Set(
                  ((await pg.getMembers(workspaceId)) ?? []).map((m) => m.userId),
                );
                const actorName = (await pg.getUserById(guest.userId))?.name ?? null;
                const events = taskActivityEvents({
                  prev: null,
                  next: {
                    id: mapped.id,
                    title: mapped.title,
                    assigneeId: mapped.assigneeId,
                    status: mapped.status,
                  },
                  actorId: guest.userId,
                  isHumanRecipient: (id) => memberIds.has(id),
                });
                const actorLabel = actorName ?? "Someone";
                for (const ev of events) {
                  const createdAt = Date.now();
                  await emitActivityEvent(ev.recipientId, {
                    workspaceId,
                    eventType: ev.eventType,
                    sourceType: ev.sourceType,
                    sourceId: ev.sourceId,
                    previewText: ev.previewText,
                    actorId: guest.userId,
                    actorName,
                  });
                  // Live in-app badge (mirror the daemon_access_request block): push
                  // an activity_new to ALL of the recipient's open sessions so the
                  // Activity badge increments without a refetch. Keyed by task:<id>
                  // on the client (ActivityState.pushTask) so it dedupes against the
                  // on-load seed. notifyUserGuests is user-scoped, exceptWs = this
                  // socket — the recipient is never the actor (taskActivityEvents
                  // already drops the actor), so excluding this socket is harmless.
                  notifyUserGuests(
                    ev.recipientId,
                    "cyborg:activity_new",
                    {
                      id: randomUUID(),
                      workspaceId,
                      eventType: ev.eventType,
                      sourceType: ev.sourceType,
                      sourceId: ev.sourceId,
                      channelId: null,
                      previewText: ev.previewText,
                      actorId: guest.userId,
                      actorName,
                      createdAt,
                    },
                    ws,
                  );
                  // Native push (web + FCM) to the assignee's devices via the SAME
                  // path message mentions/DMs use — DND/away + active-desktop
                  // suppression + per-token badge + dead-token prune. The tap
                  // deep-links to the task detail. Always notify the assignee (no
                  // per-task opt-out); the actor/cybos are already excluded above.
                  void dispatchPush(workspaceId, [ev.recipientId], {
                    title: `${actorLabel} assigned you a task`,
                    body: ev.previewText,
                    url: `/workspace/${workspaceId}/tasks/item/${ev.sourceId}`,
                    tag: `task:${ev.sourceId}`,
                  }).catch(() => {}); // intentional: best-effort push; a failure must not fail the create
                }
                // Logs tab observability: surface the created task with its actor +
                // assignee. Resolution is best-effort and shares this async block's
                // member lookup; it never blocks the create response.
                emitTaskEventForWorkspace(workspaceId, {
                  kind: "task_created",
                  workspaceId,
                  taskId: mapped.id,
                  channelId: mapped.channelId,
                  cyboId: await resolveCyboIdForLog(workspaceId, mapped.assigneeId),
                  title: mapped.title,
                  assigneeName: await resolveAssigneeNameForLog(workspaceId, mapped.assigneeId),
                  priority: mapped.priority,
                  actor: actorName ?? "Someone",
                });
              } catch (err) {
                relayLog.error({ err }, "task create activity emit failed");
              }
            })();
            broadcastToGuests(workspaceId, {
              type: "cyborg:tasks_changed",
              payload: { workspaceId, op: "created", task: mapped },
            });
          }
          break;
        }

        case "cyborg:update_task": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const taskId = inner.taskId as string;
          if (!taskId) {
            respondError("taskId required");
            break;
          }
          const utRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!utRole || utRole === "viewer") {
            respondError("forbidden");
            break;
          }
          // Anchor: the task must belong to the asserted workspace BEFORE we mutate
          // it (pg.updateTask is by id alone, so without this any task is editable).
          const utTasks = (await pg.getTasks(workspaceId)) ?? [];
          const utPrev = utTasks.find((t) => t.id === taskId);
          if (!utPrev) {
            respondError("task not found");
            break;
          }
          // Tasks Redesign GATE (fail-closed, project-scoped): the caller must be
          // able to see the task's CURRENT project before editing it, and — when the
          // update RE-PARENTS it to a different project — the DESTINATION project too.
          // Tasks with no project_id (legacy/unassigned) carry no project gate.
          const utDestProjectId = inner.projectId as string | null | undefined;
          if (
            utPrev.project_id &&
            !(await pg.assertProjectVisible(utPrev.project_id, guest.userId))
          ) {
            respondError("task not found");
            break;
          }
          if (utDestProjectId && !(await pg.assertProjectVisible(utDestProjectId, guest.userId))) {
            respondError("project not found");
            break;
          }
          // labels[] are NAMES on the guest path (no client-side name→id resolver).
          // Resolve them (get-or-create) to label ids against the task's EFFECTIVE
          // project — the destination project when this update re-parents, else the
          // current one. A task with no project has no label catalog, so labels are
          // skipped there. undefined (field absent) leaves the existing set; an
          // explicit [] clears it (updateTask replace-set semantics).
          let utLabelIds: string[] | undefined;
          if (Array.isArray(inner.labels)) {
            const utLabelProjectId = utDestProjectId ?? utPrev.project_id ?? null;
            utLabelIds = utLabelProjectId
              ? await pg.resolveLabels(utLabelProjectId, inner.labels as string[])
              : [];
          }
          await pg.updateTask(taskId, {
            title: inner.title as string | undefined,
            description: inner.description as string | undefined,
            status: inner.status as string | undefined,
            assigneeId: inner.assigneeId as string | undefined,
            // dueAt (epoch ms | null) + priority must round-trip through the
            // cloud path too; without them a due-date / priority edit only ever
            // updates status in PG. null dueAt clears the due date.
            dueAt: inner.dueAt as number | null | undefined,
            priority: inner.priority as string | null | undefined,
            // Tasks Redesign — Plane-style scalar/set fields. Pass null to clear a
            // scalar (project/parent/state/cycle/startDate); moduleIds replaces the
            // task's module set when provided. labels arrive as NAMES and are
            // resolved (get-or-create) to labelIds above against the task's
            // effective project, then replace the task's label set.
            projectId: utDestProjectId,
            parentId: inner.parentId as string | null | undefined,
            stateId: inner.stateId as string | null | undefined,
            startDate: inner.startDate as number | null | undefined,
            cycleId: inner.cycleId as string | null | undefined,
            labelIds: utLabelIds,
            moduleIds: inner.moduleIds as string[] | undefined,
          });
          // Tasks Redesign — append 'updated' rows to the per-task Activity feed
          // (task_activity, read by the work-item Activity pane via
          // fetch_task_activity), one row per attribute the human actually moved. The
          // daemon write path (WorkspaceRelay) does this; the cloud relay must too,
          // else an edit through relay-standalone leaves the Activity tab empty. We
          // diff the forwarded fields against the pre-edit `utPrev` snapshot; absent
          // (undefined) fields were not part of this update and are skipped. Dates are
          // recorded as their epoch-ms string. Best-effort: a feed-write failure must
          // NOT fail the edit the human already committed. epoch is full-precision ms.
          try {
            const utEpoch = Date.now();
            const utActs: Array<{
              field: string;
              oldValue: string | null;
              newValue: string | null;
            }> = [];
            const utStr = (v: unknown): string | null =>
              v === null || v === undefined ? null : String(v);
            const utTitle = inner.title as string | undefined;
            if (utTitle !== undefined && utTitle !== utPrev.title) {
              utActs.push({ field: "title", oldValue: utPrev.title ?? null, newValue: utTitle });
            }
            // State move: prefer the explicit stateId; otherwise the legacy status.
            const utStateId = inner.stateId as string | null | undefined;
            const utStatus = inner.status as string | undefined;
            if (utStateId !== undefined && utStateId !== utPrev.state_id) {
              utActs.push({
                field: "state",
                oldValue: utPrev.state_id ?? null,
                newValue: utStateId ?? null,
              });
            } else if (utStatus !== undefined && utStatus !== utPrev.status) {
              utActs.push({ field: "status", oldValue: utPrev.status ?? null, newValue: utStatus });
            }
            const utAssignee = inner.assigneeId as string | null | undefined;
            if (utAssignee !== undefined && utAssignee !== utPrev.assignee_id) {
              utActs.push({
                field: "assignee",
                oldValue: utPrev.assignee_id ?? null,
                newValue: utAssignee ?? null,
              });
            }
            const utPriority = inner.priority as string | null | undefined;
            if (utPriority !== undefined && utPriority !== utPrev.priority) {
              utActs.push({
                field: "priority",
                oldValue: utPrev.priority ?? null,
                newValue: utPriority ?? null,
              });
            }
            const utDueAt = inner.dueAt as number | null | undefined;
            if (utDueAt !== undefined && (utDueAt ?? null) !== utPrev.due_at) {
              utActs.push({
                field: "due_at",
                oldValue: utStr(utPrev.due_at),
                newValue: utStr(utDueAt),
              });
            }
            const utStartDate = inner.startDate as number | null | undefined;
            if (utStartDate !== undefined && (utStartDate ?? null) !== utPrev.start_date) {
              utActs.push({
                field: "start_date",
                oldValue: utStr(utPrev.start_date),
                newValue: utStr(utStartDate),
              });
            }
            // projectId is forwarded as the OUTBOUND chat project id, matching
            // StoredTask.project_id, so the diff compares like-for-like.
            if (utDestProjectId !== undefined && (utDestProjectId ?? null) !== utPrev.project_id) {
              utActs.push({
                field: "project",
                oldValue: utPrev.project_id ?? null,
                newValue: utDestProjectId ?? null,
              });
            }
            const utParentId = inner.parentId as string | null | undefined;
            if (utParentId !== undefined && (utParentId ?? null) !== utPrev.parent_id) {
              utActs.push({
                field: "parent",
                oldValue: utPrev.parent_id ?? null,
                newValue: utParentId ?? null,
              });
            }
            const utCycleId = inner.cycleId as string | null | undefined;
            if (utCycleId !== undefined && (utCycleId ?? null) !== utPrev.cycle_id) {
              utActs.push({
                field: "cycle",
                oldValue: utPrev.cycle_id ?? null,
                newValue: utCycleId ?? null,
              });
            }
            for (const a of utActs) {
              await pg.recordTaskActivity({
                taskId,
                workspaceId,
                actorId: guest.userId,
                verb: "updated",
                field: a.field,
                oldValue: a.oldValue,
                newValue: a.newValue,
                epoch: utEpoch,
              });
            }
          } catch (err) {
            relayLog.warn({ err, taskId }, "task_activity updated-rows failed");
          }
          const tasks = await pg.getTasks(workspaceId);
          const task = tasks.find((t) => t.id === taskId);
          // GitHub OUTBOUND write-back (wave-2a): mirror a bidirectionally-synced
          // task's state/title/body change to its linked GitHub issue. Best-effort +
          // echo-guarded inside emitTaskOutbound (and a no-op unless the task has a
          // bidirectional github_issue_syncs link), so it never blocks the response or
          // the edit the human already committed. isClosedTaskStatus mirrors the
          // task's status → "should the issue be closed": BOTH "done" (completed) and
          // "cancelled" close it, so cancelling a task closes its linked issue too.
          if (task) {
            void emitTaskOutbound(pg, {
              taskId,
              prevTitle: utPrev.title ?? null,
              nextTitle: task.title ?? null,
              prevDescription: utPrev.description ?? null,
              nextDescription: task.description ?? null,
              prevCompleted: isClosedTaskStatus(utPrev.status),
              nextCompleted: isClosedTaskStatus(task.status),
            }).catch((err) => relayLog.warn({ err, taskId }, "github outbound write-back failed"));
          }
          // Per-task scheduling — denormalize the task's bound schedule summary onto
          // the wire Task so a non-schedule edit's broadcast/response keeps the
          // cadence chip (a partial Task with schedule:null would blank it client-
          // side). One read-only lookup, reused for both the response and the
          // broadcast below.
          const utScheduleSummary = task
            ? scheduleSummaryForTask((await pg.getSchedulesByTaskIds([task.id])).get(task.id))
            : null;
          respond("cyborg:update_task_response", {
            task: task ? mapTask(task, utScheduleSummary) : { id: taskId },
          });
          // Activity feed + live update — same path as create_task, but the prev
          // snapshot drives whether the assignee changed (task_assigned) or the
          // status moved (task_status_changed). The actor is never notified.
          if (task) {
            const mapped = mapTask(task, utScheduleSummary);
            void (async () => {
              try {
                const memberIds = new Set(
                  ((await pg.getMembers(workspaceId)) ?? []).map((m) => m.userId),
                );
                const actorName = (await pg.getUserById(guest.userId))?.name ?? null;
                const events = taskActivityEvents({
                  prev: { assigneeId: utPrev.assignee_id, status: utPrev.status },
                  next: {
                    id: mapped.id,
                    title: mapped.title,
                    assigneeId: mapped.assigneeId,
                    status: mapped.status,
                  },
                  actorId: guest.userId,
                  isHumanRecipient: (id) => memberIds.has(id),
                });
                const actorLabel = actorName ?? "Someone";
                for (const ev of events) {
                  const createdAt = Date.now();
                  await emitActivityEvent(ev.recipientId, {
                    workspaceId,
                    eventType: ev.eventType,
                    sourceType: ev.sourceType,
                    sourceId: ev.sourceId,
                    previewText: ev.previewText,
                    actorId: guest.userId,
                    actorName,
                  });
                  // Live in-app badge — same activity_new fan-out as create_task.
                  notifyUserGuests(
                    ev.recipientId,
                    "cyborg:activity_new",
                    {
                      id: randomUUID(),
                      workspaceId,
                      eventType: ev.eventType,
                      sourceType: ev.sourceType,
                      sourceId: ev.sourceId,
                      channelId: null,
                      previewText: ev.previewText,
                      actorId: guest.userId,
                      actorName,
                      createdAt,
                    },
                    ws,
                  );
                  // Native push to the assignee. The title differs by event kind: a
                  // reassignment reads "assigned you a task"; a status move reads
                  // "moved your task to <status>" (mapped.status is the new state).
                  const pushTitle =
                    ev.eventType === "task_status_changed"
                      ? `${actorLabel} moved your task to ${mapped.status}`
                      : `${actorLabel} assigned you a task`;
                  void dispatchPush(workspaceId, [ev.recipientId], {
                    title: pushTitle,
                    body: ev.previewText,
                    url: `/workspace/${workspaceId}/tasks/item/${ev.sourceId}`,
                    tag: `task:${ev.sourceId}`,
                  }).catch(() => {}); // intentional: best-effort push; a failure must not fail the edit
                }
                // Logs tab observability: surface a status move on the board.
                // Only when the status actually changed (title/assignee-only edits
                // are board noise, not pipeline events).
                if (utPrev.status !== mapped.status) {
                  emitTaskEventForWorkspace(workspaceId, {
                    kind: "task_status_changed",
                    workspaceId,
                    taskId: mapped.id,
                    channelId: mapped.channelId,
                    title: mapped.title,
                    fromStatus: utPrev.status,
                    toStatus: mapped.status,
                    actor: actorName ?? "Someone",
                  });
                }
              } catch (err) {
                relayLog.error({ err }, "task update activity emit failed");
              }
            })();
            broadcastToGuests(workspaceId, {
              type: "cyborg:tasks_changed",
              payload: { workspaceId, op: "updated", task: mapped },
            });
          }
          // Tasks Phase 3 (internal docs): if this update flipped a RECURRING
          // task to done, spawn its next occurrence. PG-only here (the relay runs no
          // agents — the spawned child is dispatched by the OWNING daemon's tick /
          // reconnect catch-up; ownership is sticky, Decision 5). The "just became
          // done" guard plus the atomic recurrence_spawned_at claim inside
          // pg.spawnRecurrenceChild make this exactly-once.
          if (task && task.status === "done" && utPrev.status !== "done" && utPrev.recurrence) {
            const now = Date.now();
            const fromMs = utPrev.due_at ?? now;
            const nextDueAt = computeNextRecurrence(utPrev.recurrence, fromMs, now);
            if (nextDueAt !== null) {
              void (async () => {
                try {
                  const childId = await pg.spawnRecurrenceChild(
                    taskId,
                    nextDueAt,
                    MAX_RECURRENCE_COUNT,
                  );
                  if (childId) {
                    broadcastToGuests(workspaceId, {
                      type: "cyborg:tasks_changed",
                      payload: { workspaceId, op: "created", task: { id: childId } },
                    });
                    // Logs tab observability: a recurring task spawned its next run.
                    emitTaskEventForWorkspace(workspaceId, {
                      kind: "recurrence_spawned",
                      workspaceId,
                      taskId,
                      channelId: utPrev.channel_id ?? null,
                      title: utPrev.title,
                      childTaskId: childId,
                      nextDueAt,
                    });
                  }
                } catch (err) {
                  relayLog.error({ err, taskId }, "recurrence spawn failed");
                }
              })();
            }
          }
          break;
        }

        case "cyborg:reorder_task": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const rtTaskId = inner.taskId as string;
          if (!rtTaskId) {
            respondError("taskId required");
            break;
          }
          const rtRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!rtRole || rtRole === "viewer") {
            respondError("forbidden");
            break;
          }
          // Anchor to the asserted workspace before mutating (reorderTask is by id).
          const rtTasks = (await pg.getTasks(workspaceId)) ?? [];
          const rtPrev = rtTasks.find((t) => t.id === rtTaskId);
          if (!rtPrev) {
            respondError("task not found");
            break;
          }
          // Tasks Redesign GATE (fail-closed): the task's project must be visible to
          // the caller before reordering it. Legacy/no-project tasks carry no gate.
          if (
            rtPrev.project_id &&
            !(await pg.assertProjectVisible(rtPrev.project_id, guest.userId))
          ) {
            respondError("task not found");
            break;
          }
          const rtTask = await pg.reorderTask(rtTaskId, {
            beforeId: inner.beforeId as string | undefined,
            afterId: inner.afterId as string | undefined,
          });
          if (!rtTask) {
            respondError("task not found");
            break;
          }
          // Per-task scheduling — keep the cadence chip on a reorder broadcast (a
          // lane drag is not a schedule edit, but a schedule:null wire Task would
          // blank the chip client-side). One read-only lookup for this task.
          const rtScheduleSummary = scheduleSummaryForTask(
            (await pg.getSchedulesByTaskIds([rtTask.id])).get(rtTask.id),
          );
          const rtMapped = mapTask(rtTask, rtScheduleSummary);
          respond("cyborg:reorder_task_response", { task: rtMapped });
          broadcastToGuests(workspaceId, {
            type: "cyborg:tasks_changed",
            payload: { workspaceId, op: "updated", task: rtMapped },
          });
          break;
        }

        case "cyborg:bulk_update_tasks": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const buRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!buRole || buRole === "viewer") {
            respondError("forbidden");
            break;
          }
          const buTaskIds = Array.isArray(inner.taskIds) ? (inner.taskIds as string[]) : [];
          const buUpdates = (inner.updates ?? {}) as Record<string, unknown>;
          // Anchor: only touch tasks that belong to this workspace (updateTask is by
          // id alone, so without this filter a forged id could edit another ws's task).
          const buWsTasks = (await pg.getTasks(workspaceId)) ?? [];
          const buWsById = new Map(buWsTasks.map((t) => [t.id, t]));
          // Tasks Redesign GATE (fail-closed, project-scoped): same per-task project
          // visibility the single-task update/delete handlers enforce, applied to
          // each id in the bulk set. Without it a non-owner member who isn't in a
          // private project's channel could pass that project's task ids and bulk-
          // mutate them — the workspace role!=viewer check above does NOT gate by
          // project. A task with no project_id (legacy/unassigned) carries no gate;
          // any id not in this workspace, or whose project the caller can't see, is
          // dropped from the apply set (the rest of the op still proceeds).
          const buApplyIds: string[] = [];
          for (const id of buTaskIds) {
            const task = buWsById.get(id);
            if (!task) continue;
            if (
              task.project_id &&
              !(await pg.assertProjectVisible(task.project_id, guest.userId))
            ) {
              continue;
            }
            buApplyIds.push(id);
          }
          const buUpdateFields = {
            status: buUpdates.status as string | undefined,
            priority: buUpdates.priority as string | null | undefined,
            assigneeId: buUpdates.assigneeId as string | null | undefined,
            dueAt: buUpdates.dueAt as number | null | undefined,
            archivedAt: buUpdates.archivedAt as number | null | undefined,
          };
          // Apply per task (PG updateTask is single-row); collect the updated rows.
          for (const id of buApplyIds) {
            await pg.updateTask(id, buUpdateFields);
          }
          const buAfter = (await pg.getTasks(workspaceId)) ?? [];
          const buApplied = new Set(buApplyIds);
          const buRows = buAfter.filter((t) => buApplied.has(t.id));
          // GitHub OUTBOUND write-back (wave-2a) for the bulk path: a bulk edit can
          // move status (→ close/reopen the linked GitHub issue) for a bidirectionally-
          // synced task. Best-effort + echo-guarded per task inside emitTaskOutbound
          // (a no-op for non-synced tasks); title/description aren't part of a bulk
          // update, so only the status-driven state action ever emits here.
          for (const buRow of buRows) {
            const buPrev = buWsById.get(buRow.id);
            if (!buPrev) continue;
            void emitTaskOutbound(pg, {
              taskId: buRow.id,
              prevTitle: buPrev.title ?? null,
              nextTitle: buRow.title ?? null,
              prevDescription: buPrev.description ?? null,
              nextDescription: buRow.description ?? null,
              prevCompleted: isClosedTaskStatus(buPrev.status),
              nextCompleted: isClosedTaskStatus(buRow.status),
            }).catch((err) =>
              relayLog.warn({ err, taskId: buRow.id }, "github outbound write-back failed"),
            );
          }
          // Per-task scheduling — one BATCHED lookup over the applied set, so each
          // broadcast/response Task carries its bound schedule summary instead of
          // schedule:null (which would blank the chip client-side on a bulk edit).
          const buScheduleMap = await pg.getSchedulesByTaskIds(buRows.map((t) => t.id));
          const buResult = buRows.map((t) =>
            mapTask(t, scheduleSummaryForTask(buScheduleMap.get(t.id))),
          );
          respond("cyborg:bulk_update_tasks_response", { tasks: buResult });
          for (const mapped of buResult) {
            broadcastToGuests(workspaceId, {
              type: "cyborg:tasks_changed",
              payload: { workspaceId, op: "updated", task: mapped },
            });
          }
          break;
        }

        case "cyborg:delete_task": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const dtTaskId = inner.taskId as string;
          if (!dtTaskId) {
            respondError("taskId required");
            break;
          }
          const dtRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!dtRole || dtRole === "viewer") {
            respondError("forbidden");
            break;
          }
          // Anchor to the asserted workspace before deleting (deleteTask is by id).
          const dtTasks = (await pg.getTasks(workspaceId)) ?? [];
          const dtTask = dtTasks.find((t) => t.id === dtTaskId);
          if (!dtTask) {
            respondError("task not found");
            break;
          }
          // Tasks Redesign GATE (fail-closed): the task's project must be visible to
          // the caller before deleting it. Legacy/no-project tasks carry no gate.
          if (
            dtTask.project_id &&
            !(await pg.assertProjectVisible(dtTask.project_id, guest.userId))
          ) {
            respondError("task not found");
            break;
          }
          await pg.deleteTask(dtTaskId);
          respond("cyborg:delete_task_response", { taskId: dtTaskId, deleted: true });
          broadcastToGuests(workspaceId, {
            type: "cyborg:tasks_changed",
            payload: { workspaceId, op: "deleted", task: { id: dtTaskId } },
          });
          break;
        }

        case "cyborg:archive_task": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const atTaskId = inner.taskId as string;
          if (!atTaskId) {
            respondError("taskId required");
            break;
          }
          const atRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!atRole || atRole === "viewer") {
            respondError("forbidden");
            break;
          }
          // Anchor to the asserted workspace before mutating (updateTask is by id).
          const atTasks = (await pg.getTasks(workspaceId)) ?? [];
          const atPrev = atTasks.find((t) => t.id === atTaskId);
          if (!atPrev) {
            respondError("task not found");
            break;
          }
          // Tasks Redesign GATE (fail-closed): the task's project must be visible to
          // the caller before archiving it. Legacy/no-project tasks carry no gate.
          if (
            atPrev.project_id &&
            !(await pg.assertProjectVisible(atPrev.project_id, guest.userId))
          ) {
            respondError("task not found");
            break;
          }
          const archived = inner.archived === true;
          await pg.updateTask(atTaskId, { archivedAt: archived ? Date.now() : null });
          const atAfter = (await pg.getTasks(workspaceId)) ?? [];
          const atTask = atAfter.find((t) => t.id === atTaskId);
          // Per-task scheduling — keep the cadence chip on an archive/unarchive
          // broadcast (a schedule:null wire Task would blank it client-side). One
          // read-only lookup for this task.
          const atScheduleSummary = atTask
            ? scheduleSummaryForTask((await pg.getSchedulesByTaskIds([atTask.id])).get(atTask.id))
            : null;
          const atMapped = atTask ? mapTask(atTask, atScheduleSummary) : { id: atTaskId };
          respond("cyborg:archive_task_response", { task: atMapped });
          broadcastToGuests(workspaceId, {
            type: "cyborg:tasks_changed",
            payload: { workspaceId, op: "updated", task: atMapped },
          });
          break;
        }

        case "cyborg:delete_message": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const messageId = inner.messageId as string;
          if (!messageId) {
            respondError("messageId required");
            break;
          }
          // Only the author or a workspace admin/owner may delete a message.
          const delMsg = await pg.getMessageById(messageId);
          if (!delMsg || delMsg.workspaceId !== workspaceId) {
            respondError("message not found");
            break;
          }
          const delRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (delMsg.fromId !== guest.userId && delRole !== "owner" && delRole !== "admin") {
            respondError("you can only delete your own messages");
            break;
          }
          await pg.deleteMessage(messageId);
          // Payload-wrapped so the client's dispatchBroadcast (which requires
          // `payload`) actually delivers it — was top-level, so live deletes never
          // reached other clients (only a reload hid the soft-deleted row). The
          // displayed thread reply count is derived from non-deleted replies on
          // fetch, so a deleted reply self-corrects without a stored decrement.
          broadcastToGuests(workspaceId, {
            type: "cyborg:delete_message_broadcast",
            payload: { workspaceId, messageId },
          });
          // Outgoing webhooks (#598): a channel message delete → message.deleted.
          // DMs (null channel) have no webhook scope.
          if (delMsg.channelId) {
            void enqueueWebhookEvent({
              pg,
              logger: relayLog,
              eventType: "message.deleted",
              workspaceId,
              channelId: delMsg.channelId,
              messageId,
            });
          }
          respond("cyborg:delete_message_response", { deleted: true });
          break;
        }

        case "cyborg:edit_message": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const editMessageId = inner.messageId as string;
          const editText = inner.text as string;
          if (!editMessageId || editText === undefined) {
            respondError("messageId and text required");
            break;
          }
          // Only the author may edit their own message (admins can delete, but not
          // rewrite someone else's words).
          const editMsg = await pg.getMessageById(editMessageId);
          if (!editMsg || editMsg.workspaceId !== workspaceId) {
            respondError("message not found");
            break;
          }
          if (editMsg.fromId !== guest.userId) {
            respondError("you can only edit your own messages");
            break;
          }
          await pg.updateMessageText(editMessageId, editText);
          broadcastToGuests(workspaceId, {
            type: "cyborg:edit_message_broadcast",
            payload: { workspaceId, messageId: editMessageId, text: editText },
          });
          // Outgoing webhooks (#598): a channel message edit → message.updated.
          // DMs (null channel) have no webhook scope.
          if (editMsg.channelId) {
            void enqueueWebhookEvent({
              pg,
              logger: relayLog,
              eventType: "message.updated",
              workspaceId,
              channelId: editMsg.channelId,
              messageId: editMessageId,
              text: editText,
              fromId: editMsg.fromId,
            });
          }
          respond("cyborg:edit_message_response", { updated: true });
          break;
        }

        case "cyborg:pin_message": {
          const pinMsgId = inner.messageId as string;
          const pinChId = (inner.channelId as string) ?? null;
          const pinned = inner.pinned !== false;
          if (!workspaceId || !pinMsgId) {
            respondError("workspaceId and messageId required");
            break;
          }
          const pm = await pg.getMessageById(pinMsgId);
          if (!pm || pm.workspaceId !== workspaceId) {
            respondError("message not found");
            break;
          }
          const pinRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!pinRole || pinRole === "viewer") {
            respondError("you can't pin in this workspace");
            break;
          }
          await pg.setPinned(pinMsgId, pinned ? guest.userId : null);
          const pinnedAt = pinned ? Date.now() : null;
          const pinnedBy = pinned ? guest.userId : null;
          broadcastToGuests(workspaceId, {
            type: "cyborg:pin_message_broadcast",
            payload: { workspaceId, channelId: pinChId, messageId: pinMsgId, pinnedAt, pinnedBy },
          });
          respond("cyborg:pin_message_response", { pinnedAt, pinnedBy });
          break;
        }

        // Saved messages (#609) — cloud half of the dual-routed handler
        // (dispatcher.ts has the local mirror). A PRIVATE per-user bookmark,
        // distinct from pin_message above (which is shared). Toggle on/off via
        // `saved`; the broadcast is PER-USER (cross-device sync of MY saves) via
        // notifyUserGuests — NEVER fanned out to the workspace, mirroring
        // read_broadcast. So another user can't see (or even learn of) my saves.
        case "cyborg:save_message": {
          const saveMsgId = inner.messageId as string;
          const saved = inner.saved !== false;
          if (!workspaceId || !saveMsgId) {
            respondError("workspaceId and messageId required");
            break;
          }
          const smRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!smRole) {
            respondError("not a member of this workspace");
            break;
          }
          const sm = await pg.getMessageById(saveMsgId);
          if (!sm || sm.workspaceId !== workspaceId) {
            respondError("message not found");
            break;
          }
          if (saved) await pg.saveMessage(guest.userId, saveMsgId);
          else await pg.unsaveMessage(guest.userId, saveMsgId);
          notifyUserGuests(
            guest.userId,
            "cyborg:save_message_broadcast",
            { workspaceId, messageId: saveMsgId, saved },
            ws,
          );
          respond("cyborg:save_message_response", { messageId: saveMsgId, saved });
          break;
        }

        case "cyborg:list_saved": {
          if (!workspaceId) {
            respondError("workspaceId required");
            break;
          }
          const lsRole = await pg.getMemberRole(workspaceId, guest.userId);
          if (!lsRole) {
            respondError("not a member of this workspace");
            break;
          }
          const savedMsgs = await pg.getSavedMessages(guest.userId, workspaceId);
          respond("cyborg:list_saved_response", { messages: savedMsgs.map(mapMessage) });
          break;
        }

        // Signed interactive action (#600) — cloud half of the dual-routed
        // handler (dispatcher.ts has the local mirror). The action resolves AT
        // the relay (like cyborg:agent_permission_response), not forwarded raw.
        case "cyborg:message_action": {
          // Untrusted guest JSON — validate types instead of asserting them.
          const maMsgId = typeof inner.messageId === "string" ? inner.messageId : "";
          const maActionId = typeof inner.actionId === "string" ? inner.actionId : "";
          const maToken = typeof inner.token === "string" ? inner.token : "";
          if (!workspaceId || !maMsgId || !maActionId || !maToken) {
            respondError("workspaceId, messageId, actionId and token required");
            break;
          }
          const now = Math.floor(Date.now() / 1000);
          // expectActor = the cloud guest id (the relay's actor namespace).
          const maPayload = verifyAction(maToken, { now, expectActor: guest.userId });
          if (!maPayload || maPayload.mid !== maMsgId || maPayload.aid !== maActionId) {
            respond("cyborg:message_action_response", { ok: false, error: "invalid_or_expired" });
            break;
          }
          const maHandler = getActionHandler(maPayload.k);
          if (!maHandler) {
            respond("cyborg:message_action_response", { ok: false, error: "unknown_action_kind" });
            break;
          }
          const maOutcome = await maHandler(maPayload, {
            actorId: guest.userId,
            workspaceId,
            messageId: maMsgId,
            deps: { mode: "cloud", pg, relay },
          });
          respond("cyborg:message_action_response", {
            ok: maOutcome.ok,
            ...(maOutcome.error ? { error: maOutcome.error } : {}),
          });
          if (maOutcome.ok && maOutcome.card) {
            const maMsg = await pg.getMessageById(maMsgId);
            broadcastToGuests(workspaceId, {
              type: "cyborg:message_card_updated",
              payload: {
                workspaceId,
                channelId: maMsg?.channelId ?? null,
                messageId: maMsgId,
                card: maOutcome.card,
              },
            });
          }
          break;
        }

        default: {
          relayLog.info({ type }, "Unhandled Paseo RPC");
          respondError(`unsupported: ${type}`);
          break;
        }
      }
    } catch (err) {
      relayLog.error({ err, type }, "Paseo RPC error");
      respondError(err instanceof Error ? err.message : "internal error");
    }
  }

  // ─── Asset uploads (S3) ───────────────────────────────────────
  // Built BEFORE the relay so the agent-image attachment path (#845) can upload
  // generated images server-side via the uploadAgentImage callback below. The
  // same client/bucket are injected into the asset routes further down.
  const s3Bucket = process.env.S3_ASSETS_BUCKET;
  const s3Region = process.env.S3_ASSETS_REGION ?? "us-east-1";
  let s3Client: S3Client | null = null;
  if (s3Bucket && process.env.S3_ASSETS_ACCESS_KEY_ID && process.env.S3_ASSETS_SECRET_ACCESS_KEY) {
    s3Client = new S3Client({
      region: s3Region,
      credentials: {
        accessKeyId: process.env.S3_ASSETS_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_ASSETS_SECRET_ACCESS_KEY,
      },
    });
    relayLog.info({ bucket: s3Bucket }, "S3 assets configured");
  }

  // #845: upload an agent-generated image (shipped inline by the daemon over the
  // agent_stream) to S3, returning the persisted attachment fields. null on any
  // failure / S3-off so the relay just persists the message without the image.
  async function uploadAgentImage(img: AgentImageAttachment): Promise<UploadedAgentImage | null> {
    try {
      // Decode once and persist the ACTUAL byte length, not the daemon-provided
      // img.size (which could be wrong/spoofed).
      const buffer = Buffer.from(img.dataBase64, "base64");
      const result = await uploadBufferToS3({
        s3Client,
        s3Bucket,
        s3Region,
        buffer,
        contentType: img.mimeType,
        filename: img.filename,
        folder: "agent-images",
      });
      if (!result) return null;
      return {
        key: result.key,
        url: result.publicUrl,
        name: img.filename,
        type: img.mimeType,
        size: buffer.length,
      };
    } catch (err) {
      relayLog.warn({ err }, "Failed to upload agent-generated image to S3");
      return null;
    }
  }

  // ─── Relay ────────────────────────────────────────────────────

  const relay = new WorkspaceRelay({
    pg,
    redis,
    logger: relayLog,
    validateToken: validateDaemonToken,
    uploadAgentImage,
    onBroadcast: (workspaceId, message, fromDaemonId, seq) => {
      // Intercept per-daemon list_agents responses for fan-out aggregation: merge
      // into the pending request and suppress the broadcast (the requesting guest
      // gets ONE merged response instead of N partial ones from each daemon).
      const m = message as Record<string, unknown>;
      if (m.type === "cyborg:list_agents_response") {
        const p = m.payload as Record<string, unknown> | undefined;
        const requestId = p?.requestId as string | undefined;
        const agg = requestId ? agentListAggregations.get(requestId) : undefined;
        if (requestId && agg) {
          const agents = (p?.agents as Record<string, unknown>[]) ?? [];
          const liveAgentIds: string[] = [];
          for (const a of agents) {
            const id = a.agentId as string | undefined;
            if (id) liveAgentIds.push(id);
            if (id && !agg.agents.has(id)) agg.agents.set(id, a);
            // Backfill the agent↔daemon binding from each daemon's own list —
            // the authoritative "who owns what" source. Covers agents spawned
            // before status-based registration existed, so agent-scoped
            // forwards (timeline, set_model, …) can target the right daemon.
            if (id && pg && fromDaemonId && fromDaemonId !== "guest") {
              pg.registerDaemonAgent(
                fromDaemonId,
                id,
                workspaceId,
                (a.provider as string) ?? "unknown",
              ).catch((err) =>
                relayLog.error(
                  { err, daemonId: fromDaemonId, agentId: id, workspaceId },
                  "registerDaemonAgent backfill failed — agent-scoped forwards may misroute",
                ),
              );
            }
          }
          // GC the REQUESTER's stale offline bindings on this now-online daemon
          // (#810). This per-daemon response is the COMPLETE set of THIS user's
          // visible live agents on the daemon (handleListAgents filters per-user),
          // so any of the user's OWN bindings on this daemon that are absent from
          // it are dead/orphaned sessions (e.g. left behind by a SQLite-cache reset
          // or a failed delete sync) — prune them so duplicate offline rows stop
          // piling up. SCOPED to the requester (global id OR real email) so a
          // peer's live PRIVATE binding — by design never in this filtered list —
          // is never touched: restart-safe (a merely-disconnected daemon, which
          // sends no response, is never pruned). SKIPPED for a FILTERED request
          // (a cyboId list is a subset, not the complete set) and for an EMPTY
          // response (ambiguous/transient — never delete-all). See shouldGcOwnerBindings.
          if (
            pg &&
            fromDaemonId &&
            fromDaemonId !== "guest" &&
            shouldGcOwnerBindings({ requestFiltered: agg.filtered, liveAgentCount: agents.length })
          ) {
            pg.deleteStaleAgentBindingsForOwner({
              daemonId: fromDaemonId,
              workspaceId,
              liveAgentIds,
              ownerGlobalId: agg.guestUserId,
              ownerEmail: agg.guestEmail,
            })
              .then((deleted) => {
                if (deleted > 0) {
                  relayLog.warn(
                    { daemonId: fromDaemonId, workspaceId, deleted, live: liveAgentIds.length },
                    "GC'd stale agent_bindings for owner on daemon reconnect (#810)",
                  );
                }
                return undefined;
              })
              .catch((err) =>
                relayLog.error(
                  { err, daemonId: fromDaemonId, workspaceId },
                  "deleteStaleAgentBindingsForOwner failed — stale offline sessions may persist",
                ),
              );
          }
          if (fromDaemonId) agg.pendingDaemons.delete(fromDaemonId);
          if (agg.pendingDaemons.size === 0) void finalizeAgentList(requestId);
          return;
        }
      }
      // Same merge-and-suppress for archived sessions (per-daemon SQLite archives).
      if (m.type === "cyborg:list_archived_sessions_response") {
        const p = m.payload as Record<string, unknown> | undefined;
        const requestId = p?.requestId as string | undefined;
        const agg = requestId ? archivedListAggregations.get(requestId) : undefined;
        if (requestId && agg) {
          const sessions = (p?.sessions as Record<string, unknown>[]) ?? [];
          for (const s of sessions) {
            const id = s.id as string | undefined;
            // Stamp the owning daemon (#593): the daemon doesn't know its own
            // relay id, so the relay tags each session with the daemon that
            // answered. The client sends this back on restore so the relay can
            // scope + route the restore to the daemon that actually holds it.
            if (fromDaemonId && fromDaemonId !== "guest") s.daemonId = fromDaemonId;
            if (id && !agg.sessions.has(id)) agg.sessions.set(id, s);
          }
          // A non-null per-daemon cursor means that daemon has rows beyond its page
          // — keep it so finalize emits a global cursor even for a single daemon
          // (whose self-capped response never overflows the merge). OR across all.
          if (typeof p?.nextCursor === "string" && p.nextCursor.length > 0) {
            agg.daemonHasMore = true;
          }
          if (fromDaemonId) agg.pendingDaemons.delete(fromDaemonId);
          if (agg.pendingDaemons.size === 0) void finalizeArchivedList(requestId);
          return;
        }
      }
      // Same merge-and-suppress for the terminal directory (per-daemon controller,
      // not PG). Dedupe by terminalId and stamp the answering daemon so the sidebar
      // can route control ops back to the daemon that owns the session — the daemon
      // doesn't know its own relay id (mirrors the archived-session daemonId stamp).
      if (m.type === "cyborg:list_terminals_response") {
        const p = m.payload as Record<string, unknown> | undefined;
        const requestId = p?.requestId as string | undefined;
        const agg = requestId ? terminalListAggregations.get(requestId) : undefined;
        if (requestId && agg) {
          const terminals = (p?.terminals as Record<string, unknown>[]) ?? [];
          mergeTerminalDirectoryResponse(agg.terminals, terminals, fromDaemonId);
          if (fromDaemonId) agg.pendingDaemons.delete(fromDaemonId);
          if (agg.pendingDaemons.size === 0) finalizeTerminalList(requestId);
          return;
        }
      }
      // Daemon-owner session audit (#993): the daemon answers with ONE response (no
      // fan-out). Intercept it to resolve initiatedBy → global id + enrich cybo
      // labels, then send to the originating guest; SUPPRESS the default broadcast
      // (only the requester may see another user's session metadata).
      if (m.type === "cyborg:list_daemon_sessions_response") {
        const p = m.payload as Record<string, unknown> | undefined;
        const requestId = p?.requestId as string | undefined;
        const pending = requestId ? daemonSessionAuditRequests.get(requestId) : undefined;
        if (requestId && pending) {
          daemonSessionAuditRequests.delete(requestId);
          clearTimeout(pending.timer);
          const sessions = (p?.sessions as Record<string, unknown>[]) ?? [];
          void finalizeDaemonSessionAudit(
            pending.guestWs,
            requestId,
            pending.workspaceId,
            pending.daemonId,
            sessions,
          );
          return;
        }
      }
      // Mirror successful cybo mutations into the workspace-level PG table (the
      // daemon only wrote its local SQLite). Non-suppressing: the guest still
      // receives the response below; the mirror is fire-and-forget.
      if (
        pg &&
        (m.type === "cyborg:create_cybo_response" ||
          m.type === "cyborg:update_cybo_response" ||
          m.type === "cyborg:delete_cybo_response")
      ) {
        const p = m.payload as Record<string, unknown> | undefined;
        const requestId = p?.requestId as string | undefined;
        const pending = requestId ? pendingCyboMutations.get(requestId) : undefined;
        if (requestId && pending) {
          pendingCyboMutations.delete(requestId);
          clearTimeout(pending.timer);
          mirrorCyboMutationToPg(pending, p).catch((err) => {
            relayLog.error({ err, type: pending.type }, "cybo-pg-mirror mirror failed");
          });
        }
      }
      // Single-cybo fetch PG fallback: when the answering daemon couldn't resolve
      // this cybo locally (`cybo: null`), enrich the response from the workspace
      // PG `cybos` table so a cloud-only cybo still loads in the editor — soul and
      // all. Tolerant id resolution (exact id, `local:<slug>`, raw slug) mirrors
      // the mutation handlers, so a client holding a pre-merge roster id resolves.
      if (pg && m.type === "cyborg:fetch_cybo_response") {
        const p = m.payload as Record<string, unknown> | undefined;
        const requestId = p?.requestId as string | undefined;
        const pending = requestId ? pendingCyboFetches.get(requestId) : undefined;
        if (requestId && pending) {
          pendingCyboFetches.delete(requestId);
          clearTimeout(pending.timer);
        }
        // Only fall back when the daemon returned nothing; a daemon that DID
        // resolve the cybo owns the (possibly fresher, disk-backed) soul.
        if (p && p.cybo == null && pending) {
          const pgRef = pg;
          const { workspaceId: pendWs, cyboId } = pending;
          void pgRef
            .getCybos(pendWs)
            .then((pgCybos) => {
              const hit = resolveWorkspaceCybo(pgCybos, cyboId);
              if (hit) {
                // Enrich the response from PG (soul + all), so a cloud-only cybo
                // still loads in the editor even when the answering daemon never
                // had it locally.
                p.cybo = pgStoredCyboToFetchResponse(hit);
              }
              broadcastToGuests(workspaceId, message, fromDaemonId, seq);
              return undefined;
            })
            .catch(() => broadcastToGuests(workspaceId, message, fromDaemonId, seq));
          return;
        }
      }
      // Workspace-level cybo roster: the daemon's fetch_cybos response only
      // contains ITS local SQLite + disk cybos. Merge in the PG (shared) cybos
      // so a cybo created on any machine is visible — and startable — from every
      // daemon. Dedup by id AND slug (the daemon may already have a local copy).
      if (pg && m.type === "cyborg:fetch_cybos_response") {
        const p = m.payload as Record<string, unknown> | undefined;
        const list = p?.cybos as Record<string, unknown>[] | undefined;
        if (p && Array.isArray(list)) {
          const pgRef = pg;
          void Promise.all([
            pgRef.getCybos(workspaceId),
            workspaceReadinessResolver(relay, pgRef, workspaceId),
          ])
            .then(([pgCybos, readinessFor]) => {
              // PG is AUTHORITATIVE: on an id OR slug collision the PG row
              // REPLACES the daemon's local duplicate (a stale SQLite row from a
              // failed PG mirror, or the disk copy) — otherwise the duplicate
              // shadowed the PG id and EDIT answered "Cybo not found" (the
              // post-#413 bug; see cybo-roster-merge.ts).
              mergePgCybosIntoRoster(list, pgCybos);
              // #636: annotate every roster entry with provider readiness so the
              // UI can flag "needs daemon" cybos. Computed live (a daemon may
              // have just connected), never persisted.
              for (const entry of list) {
                if (typeof entry.provider === "string") {
                  entry.readiness = readinessFor(
                    entry.provider,
                    typeof entry.model === "string" ? entry.model : null,
                  );
                }
              }
              broadcastToGuests(workspaceId, message, fromDaemonId, seq);
              return undefined;
            })
            .catch(() => broadcastToGuests(workspaceId, message, fromDaemonId, seq));
          return;
        }
      }
      broadcastToGuests(workspaceId, message, fromDaemonId, seq);
      if (pg && fromDaemonId && fromDaemonId !== "guest") {
        const msg = message as Record<string, unknown>;
        if (msg.type === "cyborg:agent_status") {
          const p = msg.payload as Record<string, unknown> | undefined;
          // The daemon's message-router emits `status` ("idle"|"running"|"error");
          // only older payloads carried `lifecycle`. Gating on lifecycle alone
          // meant live agents NEVER populated daemon_agents, so agent-scoped
          // forwards couldn't resolve their owning daemon.
          const life = (p?.lifecycle ?? p?.status) as string | undefined;
          if (p?.agentId && life) {
            const agentId = p.agentId as string;
            const provider = (p.provider as string) ?? "unknown";
            if (life === "removed") {
              pg.removeDaemonAgent(fromDaemonId, agentId).catch((err) =>
                relayLog.error(
                  { err, daemonId: fromDaemonId, agentId },
                  "removeDaemonAgent failed — stale agent↔daemon binding may misroute forwards",
                ),
              );
              // Mirror the teardown into agent_sessions so the Home stats' agent-
              // hours stop accruing for this session (best-effort; PG-only).
              pg.archiveAgentSession(agentId).catch((err) =>
                relayLog.error({ err, agentId }, "archiveAgentSession failed (Home stats)"),
              );
            } else {
              // Persist the LIVE lifecycle as daemon_agents.status. This is the
              // ONLY place the relay learns a cross-daemon agent's real status:
              // a client listing agents asks its own daemon, which has no live
              // handle on a peer daemon's agent and so reports "unknown". The
              // list_agents finalize reads this status back to resolve the real
              // lifecycle for those cross-daemon rows.
              pg.registerDaemonAgent(fromDaemonId, agentId, workspaceId, provider, life).catch(
                (err) =>
                  relayLog.error(
                    { err, daemonId: fromDaemonId, agentId, workspaceId },
                    "registerDaemonAgent failed — agent-scoped forwards may not resolve owning daemon",
                  ),
              );
              // Record the session for the Home "This week" stats. Solo daemons
              // (every real user) have no RDS access, so their daemon-side
              // recordAgentSessionStart is a no-op — the relay is the only PG
              // writer. Idempotent upsert keeps the original createdAt + tokens.
              // The forwarded userId is a daemon-LOCAL id; resolve the carried
              // email to the global PG account id first (null if unresolvable, so
              // the FK to users(id) never breaks). Defensive typeof checks — the
              // payload is untrusted JSON off the wire.
              const email = typeof p?.userEmail === "string" ? p.userEmail : undefined;
              const resolveUser = email ? pg.getUserByEmail(email) : Promise.resolve(null);
              resolveUser
                .then((globalUser) =>
                  pg.upsertAgentSession({
                    agentId,
                    workspaceId,
                    channelId: typeof p?.channelId === "string" ? p.channelId : null,
                    userId: globalUser?.id ?? null,
                    provider: typeof p?.provider === "string" ? p.provider : null,
                    cyboId: typeof p?.cyboId === "string" ? p.cyboId : null,
                    sessionType: typeof p?.sessionType === "string" ? p.sessionType : "session",
                    cwd: typeof p?.cwd === "string" ? p.cwd : null,
                  }),
                )
                .catch((err) =>
                  relayLog.error({ err, agentId }, "upsertAgentSession failed (Home stats)"),
                );
            }
          }
        }
        // Cumulative token usage for the Home stats rides the agent_stream the
        // relay already forwards. Solo daemons can't write PG, so the relay
        // records usage here off each turn_completed (best-effort, PG-only).
        if (msg.type === "cyborg:agent_stream") {
          const p = msg.payload as Record<string, unknown> | undefined;
          const ev = p?.event as Record<string, unknown> | undefined;
          // Defensive: agentId is untrusted JSON off the wire.
          if (typeof p?.agentId === "string" && ev?.type === "turn_completed") {
            const agentId = p.agentId;
            const wsId = typeof p.workspaceId === "string" ? p.workspaceId : workspaceId;
            const usage = ev.usage;
            // Untrusted JSON: ensure it's a plain object (not an array/primitive)
            // before treating it as a usage payload.
            if (usage && typeof usage === "object" && !Array.isArray(usage) && wsId) {
              // Ensure the row exists first: EPHEMERAL cybo summons never emit
              // agent_status (no upsert), so a bare UPDATE would drop their tokens.
              pg.ensureAgentSession(agentId, wsId)
                .then(() =>
                  pg.recordAgentSessionUsage(
                    agentId,
                    usage as {
                      inputTokens?: number;
                      outputTokens?: number;
                      cachedInputTokens?: number;
                      totalCostUsd?: number;
                    },
                  ),
                )
                .catch((err) =>
                  relayLog.error({ err, agentId }, "recordAgentSessionUsage failed (Home stats)"),
                );
            }
          }
        }
      }
    },
    onHeartbeat: (daemonId, meta) => {
      // Low-severity: the next heartbeat refreshes the online TTL; log at debug so a
      // transient Redis blip is visible without flooding on every beat.
      redis
        ?.setDaemonOnline(daemonId, meta ?? {})
        .catch((err) =>
          relayLog.debug({ err, daemonId }, "setDaemonOnline heartbeat refresh failed"),
        );
      // Persist the daemon's DualStorage mode to daemons.deployment_mode for the
      // superadmin overview. Backward compatible: older daemons omit the field
      // (the schema strips an unknown value), so the column stays NULL = unknown.
      const deploymentMode = meta?.deploymentMode;
      if (pg && (deploymentMode === "solo" || deploymentMode === "connected")) {
        pg.setDaemonDeploymentMode(daemonId, deploymentMode).catch((err) =>
          relayLog.debug({ err, daemonId }, "setDaemonDeploymentMode failed"),
        );
      }
    },
    // #745: daemon-side failures (cybo spawn, provider/quota) arrive over the
    // daemon WS and are logged here through the relay's pino logger — JSON to
    // stdout → the /cyborg7/relay log group, where ops can see what dies on a
    // user's machine (the daemon has no CloudWatch creds of its own).
    onTelemetry: (daemonId, event) => {
      relayLog.error({ daemonId, ...event }, "daemon_telemetry");
    },
    onDaemonConnect: (daemonId, workspaceIds) => {
      redis
        ?.setDaemonOnline(daemonId, { connectedAt: Date.now() })
        .catch((err) =>
          relayLog.warn(
            { err, daemonId },
            "setDaemonOnline at connect failed — daemon may appear offline until next heartbeat",
          ),
        );
      for (const wsId of workspaceIds) {
        broadcastToGuests(wsId, {
          type: "cyborg:daemon_status_broadcast",
          // Payload envelope: the client reads broadcast data from `payload`
          // (top-level fields are dropped), so daemon status must be wrapped or
          // the online/offline badges never update live.
          payload: { daemonId, status: "online" },
        });
      }
    },
    onDaemonDisconnect: (daemonId, workspaceIds) => {
      redis
        ?.removeDaemon(daemonId)
        .catch((err) =>
          relayLog.warn(
            { err, daemonId },
            "removeDaemon on disconnect failed — daemon may linger online until its TTL expires",
          ),
        );
      if (pg)
        pg.removeDaemonAgents(daemonId).catch((err) =>
          relayLog.error(
            { err, daemonId },
            "removeDaemonAgents on disconnect failed — stale bindings may misroute forwards to a dead daemon",
          ),
        );
      for (const wsId of workspaceIds) {
        broadcastToGuests(wsId, {
          type: "cyborg:daemon_status_broadcast",
          payload: { daemonId, status: "offline" },
        });
      }
    },
  });

  // Re-seed per-workspace seq counters from the DB so they stay monotonic across
  // relay restarts (keeps sync deltas working; display order uses createdAt).
  await relay.seedSequencesFromDb();

  // ─── Hono App ─────────────────────────────────────────────────

  type Env = { Variables: { userId: string; userEmail: string } };
  const app = new Hono<Env>();
  const startedAt = Date.now();

  // ─── CORS ──────────────────────────────────────────────────────
  // The UI served by THIS relay (same-origin, e.g. https://app.cyborg7.com)
  // needs no CORS. These origins cover cross-domain callers: the desktop DMG's
  // WS host (relay.cyborg7.com), the production web host (app.cyborg7.com), and
  // the local Vite dev server. Override/extend via CYBORG_CORS_ORIGINS (comma-
  // separated). `*` (the dev default below when unset) allows any origin.
  const DEFAULT_CORS_ORIGINS = [
    "https://app.cyborg7.com",
    "https://relay.cyborg7.com",
    "http://localhost:5173",
  ];
  const corsEnv = process.env.CYBORG_CORS_ORIGINS?.trim();
  // No env → allow all (dev convenience, unchanged from the previous bare
  // cors()). "*" is explicit allow-all. Otherwise use the configured list,
  // unioned with the production defaults so app/relay hosts always work.
  const corsOrigin: "*" | string[] =
    !corsEnv || corsEnv === "*"
      ? "*"
      : [
          ...new Set([
            ...corsEnv
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
            ...DEFAULT_CORS_ORIGINS,
          ]),
        ];

  app.use("*", logger());
  app.use("*", cors({ origin: corsOrigin }));
  app.onError((err, c) => {
    relayLog.error({ err }, "Unhandled request error");
    return c.json({ error: "internal server error" }, 500);
  });

  // ─── Auth middleware ──────────────────────────────────────────

  const requireAuth = async (c: Context<Env>, next: Next) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const auth = c.req.header("authorization");
    if (!auth?.startsWith("Bearer ")) return c.json({ error: "unauthorized" }, 401);
    const decoded = validateUserToken(auth.slice(7));
    if (!decoded) return c.json({ error: "invalid token" }, 401);
    const user = await pg.getUserByEmail(decoded.email);
    if (!user) return c.json({ error: "user not found" }, 401);
    // Block suspended/soft-deleted accounts on the authenticated REST path. This
    // is the single chokepoint every /api/* request flows through, so it is also
    // what makes a revoked/suspended superadmin lose access on their next call.
    // Backward compatible: the columns are nullable, so a normal user (both NULL)
    // is unaffected.
    const status = await pg.getAccountStatus(user.id);
    if (status?.suspendedAt || status?.deletedAt) {
      return c.json({ error: "account suspended" }, 403);
    }
    c.set("userId", user.id);
    c.set("userEmail", user.email);
    await next();
  };

  // ─── Public endpoints: health + invite landing (extracted) ────
  // Unauthenticated — see ./routes/public.ts.
  app.route(
    "/",
    createPublicRoutes({
      pg,
      startedAt,
      getConnectedDaemons: () => relay.getConnectedDaemons(),
      getRedisOnlineDaemons: () => (redis ? redis.getOnlineDaemons() : Promise.resolve([])),
      guestCount: () => guests.size,
      hasRedis: !!redis,
    }),
  );

  // ─── Auth routes (extracted) ──────────────────────────────────
  // OTP signup / login / password reset — see ./routes/auth.ts.
  app.route(
    "/",
    createAuthRoutes({ pg, broadcastToGuests, hashPassword, verifyPassword, createUserToken }),
  );

  // ─── Passkey / WebAuthn routes ────────────────────────────────
  // Passwordless login + passkey management — see ./routes/passkey.ts.
  app.route(
    "/",
    createPasskeyRoutes({ pg, createUserToken, validateUserToken, broadcastToGuests }),
  );

  // ─── Protected workspace REST (extracted) ─────────────────────
  // Read-only authenticated workspace fetches — see ./routes/workspace-rest.ts.
  app.route("/", createWorkspaceRestRoutes({ pg: pg!, requireAuth }));

  // ─── Superadmin admin surface (extracted) ─────────────────────
  // Superadmin-gated platform metrics + grant/revoke/suspend/delete/plan/role/
  // impersonate. Each privileged endpoint re-checks pg.isSuperadmin on every
  // request; suspended/deleted users are already blocked at requireAuth above.
  // See ./routes/superadmin.ts.
  app.route(
    "/",
    createSuperadminRoutes({
      pg: pg!,
      requireAuth,
      // Live-socket teardown for suspend/soft-delete: drop EVERY open socket for
      // the target userId immediately (the cloud UI runs over WS, so a status
      // flip alone wouldn't disconnect an already-connected session). Mirrors the
      // cyborg:delete_account teardown — iterate the live `guests` and close each
      // matching socket; the close handler removes it from guestSubs/presence.
      evictUser: (userId: string) => {
        // Snapshot first: gws.close() can trigger a close handler that
        // synchronously mutates `guests`, which would corrupt a live iterator.
        for (const [gws, g] of Array.from(guests)) {
          if (g.userId === userId) {
            try {
              gws.close(1000, "account deactivated");
            } catch {
              // Best-effort: the socket may already be closing/closed; its close
              // handler still cleans up state.
            }
          }
        }
      },
      // Live-unsubscribe every connected member from a DISABLED workspace WITHOUT
      // closing their socket (they may be in other workspaces). Drop the
      // workspaceId from each subscribed guest's workspaceIds set, then clear its
      // guestSubs entry. Their next workspace-scoped op then hits the existing
      // "not a member of this workspace" path → the client shows its refresh
      // prompt → on refresh getWorkspacesForUser excludes the now-disabled org.
      // Best-effort + try/catch, mirroring evictUser.
      evictWorkspace: (workspaceId: string) => {
        // Snapshot the subscriber set first (we mutate guestSubs below).
        for (const gws of Array.from(guestSubs.get(workspaceId) ?? [])) {
          try {
            guests.get(gws)?.workspaceIds.delete(workspaceId);
          } catch {
            // Best-effort: a racing disconnect may already have removed the guest.
          }
        }
        guestSubs.delete(workspaceId);
      },
    }),
  );

  // ─── Stripe billing + inbound webhooks (extracted) ────────────
  // Self-contained route groups, mounted as Hono sub-apps. See
  // ./routes/stripe.ts and ./routes/webhooks.ts.
  app.route("/", createStripeRoutes({ pg, requireAuth }));
  app.route("/", createIapRoutes({ pg, requireAuth }));
  app.route(
    "/",
    createWebhookRoutes({
      pg,
      relay,
      // Webhook-triggered cybo fire (#620) forwards a relay_rpc attributed to the
      // webhook creator — mint that creator's user JWT (same token shape the guest
      // path reuses). createUserToken keys on email; the daemon maps guestId →
      // authCtx.user.id and trusts the relay-resolved role.
      mintUserToken: (email, name) => createUserToken(email, name ?? undefined),
    }),
  );

  // ─── GitHub App → Tasks one-way issue sync (extracted) ────────
  // PUBLIC POST /api/github/webhook (HMAC-verified, no requireAuth) + the authed
  // bind callbacks the Tasks settings panel calls. GitHub issues → Cyborg7 tasks;
  // GitHub is the source of truth. See ./routes/github.ts.
  app.route("/", createGithubRoutes({ pg, requireAuth }));

  // ─── Frontend telemetry proxy (extracted) ─────────────────────
  // POST /api/cyborg/client-log — frontends beacon client-side errors here so the
  // Logfire write token never ships to the browser; the relay emits the exception
  // server-side. Best-effort auth + its own rate-limit budget. See
  // ./routes/client-log.ts.
  const clientLogRateLimiter = new RateLimiter();
  app.route("/", createClientLogRoutes({ pg, relayLog, rateLimiter: clientLogRateLimiter }));

  // ─── Asset routes (extracted) ─────────────────────────────────
  // S3 presign + config + on-demand thumbnails. The S3 client/bucket built
  // above are injected (a backend-status handler also reports them). See
  // ./routes/assets.ts.
  app.route("/", createAssetRoutes({ requireAuth, s3Client, s3Bucket, s3Region }));

  // ─── Static web UI (one EC2 hosts front + back, like v1) ──────
  // Serve the SvelteKit (adapter-static) build so the SAME relay process that
  // owns /api/* + the WS upgrade also serves https://app.cyborg7.com. The UI's
  // WS is then same-origin (app.cyborg7.com/api/ws) → no CORS.
  //
  // CYBORG_UI_DIST points at the UI's build/ dir. Default: packages/ui/build
  // resolved relative to this source file, so a dev checkout "just works" and a
  // deploy can rsync the build elsewhere and point the env at it.
  //
  // This MUST come AFTER every /api/* route and is registered ONLY on GETs that
  // aren't /api/* — so it can never shadow the API. The WS upgrade (/relay,
  // /api/ws) is handled at the node http layer below, never reaching Hono.
  //
  // If the dir is absent (pure-backend deploy with no UI shipped) we skip
  // mounting entirely and log it — the relay keeps running as an API/WS backend.
  const uiDistEnv = process.env.CYBORG_UI_DIST;
  const uiDist = uiDistEnv
    ? isAbsolute(uiDistEnv)
      ? uiDistEnv
      : join(process.cwd(), uiDistEnv)
    : fileURLToPath(new URL("../../../../ui/build", import.meta.url));
  // Mount the static web UI: hashed assets + an SPA fallback for client-side
  // routes. mountWebUi reads the fallback shell fresh-per-change from disk, so a
  // UI-only deploy (which rsyncs a new build but intentionally skips the relay
  // restart) is served live and never pins a stale shell pointing at chunk
  // hashes a later --delete rsync has removed. See web-ui.ts.
  // Android App Links verification (#469): serve the Digital Asset Links file
  // with application/json BEFORE the UI mount, so it isn't swallowed by the SPA
  // fallback (which would return the HTML shell and fail Android's autoVerify).
  // Fingerprints come from ANDROID_APP_LINKS_SHA256 (Play app-signing cert +
  // upload key, comma/space-separated — deploy secrets, never committed). When
  // unset we 404 instead of serving an empty/bogus statement that would make
  // verification fail silently.
  app.get("/.well-known/assetlinks.json", (c) => {
    const statements = assetLinksFromEnv(
      process.env.ANDROID_APP_LINKS_SHA256,
      ANDROID_APP_LINK_PACKAGE,
    );
    if (!statements) {
      relayLog.warn(
        "applinks ANDROID_APP_LINKS_SHA256 unset — /.well-known/assetlinks.json returns 404",
      );
      return c.notFound();
    }
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(statements);
  });

  mountWebUi(app, uiDist);

  // ─── Start HTTP + attach WebSockets ───────────────────────────

  const honoListener = getRequestListener(app.fetch);
  // Per-token rate limiter for the MCP data plane (action "mcp", keyed by token
  // id). In-memory for this relay instance.
  const mcpRateLimiter = new RateLimiter();
  // The MCP endpoint is handled at the Node http layer (not Hono) so the
  // Streamable HTTP transport gets raw IncomingMessage/ServerResponse. All other
  // paths fall through to Hono. PAT auth happens inside handleMcpRequest, and
  // write tools post through the relay (persist + broadcast like any message).
  const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
    // Don't use `new URL()` on untrusted input — a malformed request URL would
    // throw and crash the process. A plain split is enough to route /mcp.
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/mcp") {
      if (!pg) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "database unavailable" }));
        return;
      }
      void handleMcpRequest(req, res, {
        pg,
        relay,
        rateLimiter: mcpRateLimiter,
        // Live-fan-out task mutations made via the MCP task tools, same shape the
        // relay's own task RPCs broadcast, so a task created/edited by an external
        // agent shows up in connected clients without a manual refetch.
        broadcastTasksChanged: (wsId, payload) =>
          broadcastToGuests(wsId, { type: "cyborg:tasks_changed", payload }),
      }).catch((err) => {
        relayLog.error({ err }, "mcp request failed");
        // The socket may already be destroyed (e.g. oversized-body abort) —
        // writing then throws. Guard + try/catch so the relay can't crash here.
        if (!res.headersSent && !res.destroyed) {
          try {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "internal mcp error" }));
          } catch (writeErr) {
            relayLog.error({ err: writeErr }, "mcp failed to write 500");
          }
        }
      });
      return;
    }
    honoListener(req, res);
  };
  const server = createServer(requestListener);

  const relayWss = new WebSocketServer({ noServer: true });
  relay.attachToWss(relayWss);

  const guestWss = new WebSocketServer({ noServer: true });

  // Liveness tracking for the guest ping/pong keepalive (see guestPingSweep
  // below). WeakMap keyed by socket so entries vanish when the socket is GC'd —
  // no manual cleanup, no `any` cast onto the ws object.
  const guestSocketAlive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req, socket, head) => {
    // Same crash-safety rationale as the request listener above.
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/relay") {
      relayWss.handleUpgrade(req, socket, head, (ws) => {
        relayWss.emit("connection", ws, req);
      });
    } else if (pathname === "/api/ws") {
      guestWss.handleUpgrade(req, socket, head, (ws) => {
        guestWss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, HOST, () => {
    relayLog.info({ host: HOST, port: PORT, version }, "Hono + WS listening");
  });

  // P2 #6a: hydrate durable manual-away from PG so it survives a relay restart.
  // broadcastPresence intersects awayUsers with the live online set, so a
  // hydrated-but-offline user shows offline.
  pg.getAwayUserIds()
    .then((ids) => ids.forEach((id) => awayUsers.add(id)))
    .catch((err) =>
      relayLog.warn(
        { err },
        "away-state hydration failed — manual-away won't survive this restart",
      ),
    );

  // One-time backfill: every existing workspace with zero projects gets a default
  // project named after it (matching what new workspaces get in
  // cyborg:create_workspace), so no existing company lands on an empty Tasks
  // screen. Idempotent + cheap (only projectless workspaces); fire-and-forget.
  pg.backfillDefaultProjects()
    .then((n) => {
      if (n > 0) relayLog.info({ count: n }, "seeded default projects for existing workspaces");
      return undefined;
    })
    .catch((err) =>
      relayLog.warn({ err }, "default-project backfill failed (will retry next restart)"),
    );

  // Sweep expired user statuses on a background timer instead of on every
  // fetch_user_statuses (which was a full-table delete per request). Reads
  // already exclude expired rows, so this is pure housekeeping; 15 min is
  // plenty. `unref()` so the timer never keeps the process alive on shutdown.
  //
  // Crucially, after deleting we broadcast a `user_status_changed` clear
  // ({emoji:null,text:null,expiresAt:null}) per cleared (workspace,user) — the
  // same shape `cyborg:set_user_status` emits when a user clears their own
  // status — so every live-connected client drops the chip instantly. Without
  // this, a status that expires while a client is connected lingers until the
  // client's next full resync (reconnect / foreground).
  async function sweepExpiredStatuses(): Promise<void> {
    const cleared = await pg.clearExpiredStatuses();
    // buildExpiredStatusClears is the pure mapping (unit-tested in
    // status-sweep.test.ts); the broadcast itself stays here because it closes
    // over guestSubs.
    for (const { workspaceId, ...status } of buildExpiredStatusClears(cleared)) {
      broadcastUserStatusChanged(workspaceId, status);
    }
  }
  const statusSweep = setInterval(
    () => {
      // Reads already exclude expired rows, and the next 15-min sweep retries, so a
      // failed sweep changes nothing user-visible.
      // intentional: pure housekeeping sweep.
      void sweepExpiredStatuses().catch(() => {});
    },
    15 * 60 * 1000,
  );
  statusSweep.unref();

  // "Send later" firing (#607). The relay is the SINGLE firer when a daemon is
  // connected (a connected daemon's runner no-ops) — claimDueScheduledMessages
  // atomically stamps processed_at (FOR UPDATE SKIP LOCKED) so each due row is
  // handed to exactly one sweep, even across relay instances or a relay + daemon.
  // Each claimed row is re-validated AT SEND TIME (authority + target) via the
  // pure decideScheduledSend, then sent through the normal relay path
  // (injectMessage = persist + broadcast) or recorded as failed (shown to the
  // author, never silently dropped).

  // Push the failed row (error_code set) to its author so the Scheduled list
  // flips pending → failed live. Scoped to fromId in broadcastToGuestsLocal.
  function broadcastFailed(row: StoredScheduledMessage): void {
    broadcastToGuests(row.workspace_id, {
      type: "cyborg:schedule_message_failed",
      payload: scheduledMessageView(row),
    });
  }

  async function fireDueScheduledMessages(): Promise<void> {
    const now = Date.now();
    // Rows are already claimed (processed_at stamped) when returned.
    const claimed = await pg.claimDueScheduledMessages(now);
    for (const row of claimed) {
      try {
        // Re-validate authority + target AT SEND TIME (the author may have lost
        // access, or the channel been deleted/archived, since scheduling).
        const role = await pg.getMemberRole(row.workspace_id, row.from_id);
        const authorCanSend = !!role && role !== "viewer";
        const channel = row.channel_id ? await pg.getChannel(row.channel_id) : null;
        const recipient = row.to_id ? await pg.getUserById(row.to_id) : null;
        const decision = decideScheduledSend({
          channelId: row.channel_id,
          toId: row.to_id,
          authorCanSend,
          channelExists: row.channel_id !== null && channel !== null,
          channelArchived: channel?.is_archived === 1,
          recipientExists: row.to_id !== null && recipient !== null,
        });
        if (decision.kind === "fail") {
          await pg.setScheduledMessageError(row.id, decision.errorCode);
          // Broadcast the freshly-stamped row so its errorCode reaches the author.
          broadcastFailed({ ...row, error_code: decision.errorCode });
          continue;
        }
        // Survivor — fire through the NORMAL relay path (persist + broadcast), so
        // it's indistinguishable from a live human send.
        const user = await pg.getUserById(row.from_id);
        if (row.channel_id) {
          relay.injectMessage(
            row.workspace_id,
            {
              type: "cyborg:channel_message_broadcast",
              payload: {
                id: randomUUID(),
                workspaceId: row.workspace_id,
                channelId: row.channel_id,
                fromId: row.from_id,
                fromType: "human",
                fromName: user?.name ?? null,
                toId: null,
                text: row.text,
                mentions: row.mentions ? (JSON.parse(row.mentions) as string[]) : null,
                parentId: null,
                attachments: null,
                createdAt: Date.now(),
              },
            },
            "guest",
          );
        } else if (row.to_id) {
          relay.injectMessage(
            row.workspace_id,
            {
              type: "cyborg:dm_broadcast",
              payload: {
                id: randomUUID(),
                workspaceId: row.workspace_id,
                channelId: null,
                fromId: row.from_id,
                fromType: "human",
                fromName: user?.name ?? null,
                toId: row.to_id,
                text: row.text,
                mentions: null,
                parentId: null,
                attachments: null,
                createdAt: Date.now(),
              },
            },
            "guest",
          );
        }
      } catch (err) {
        // The row is already claimed (processed_at set), so it won't loop — but a
        // failed send must still be SHOWN. Record the reason + tell the author.
        relayLog.warn({ err, id: row.id }, "[scheduled-message] relay send failed after claim");
        await pg
          .setScheduledMessageError(row.id, "unknown_error")
          .catch((e) =>
            relayLog.warn({ e, id: row.id }, "[scheduled-message] failed to record send error"),
          );
        const updated = await pg.getScheduledMessage(row.id).catch((e) => {
          relayLog.warn({ e, id: row.id }, "[scheduled-message] failed to re-read after error");
          return undefined;
        });
        if (updated) broadcastFailed(updated);
      }
    }
  }

  const scheduledMessageSweep = setInterval(() => {
    void fireDueScheduledMessages().catch((err) =>
      relayLog.warn({ err }, "[scheduled-message] sweep failed"),
    );
  }, 30_000);
  scheduledMessageSweep.unref();

  // Outgoing-webhook delivery (#598). The relay is the PG gateway, so it's the
  // primary deliverer; the tick claims due webhook_outbox rows (FOR UPDATE SKIP
  // LOCKED — safe alongside a connected daemon's own runner), signs + POSTs them
  // via secureFetch, and dead-letters/deactivates a webhook after repeated
  // failures. On deactivation it DMs the owner a system message (best effort).
  // Show only the destination HOST in the owner DM (never the full URL, which can
  // carry a path token); fall back to a generic label if the URL won't parse.
  const safeHost = (raw: string): string => {
    try {
      return new URL(raw).host;
    } catch {
      return "the configured endpoint";
    }
  };
  const webhookDeliveryRunner = new WebhookDeliveryRunner({
    pg,
    logger: relayLog,
    notifyOwner: ({ workspaceId: wid, userId, webhookName, url }) => {
      relay.injectMessage(
        wid,
        {
          type: "cyborg:dm_broadcast" as const,
          payload: {
            id: randomUUID(),
            workspaceId: wid,
            channelId: null,
            fromId: "system",
            fromType: "system" as const,
            fromName: null,
            toId: userId,
            // Name the webhook + its host, but NEVER the signing secret.
            text: `Your outgoing webhook "${webhookName}" (${safeHost(url)}) was disabled after repeated delivery failures. Re-enable it once the endpoint is healthy.`,
            mentions: null,
            parentId: null,
            attachments: null,
            createdAt: Date.now(),
          },
        },
        "guest",
      );
    },
  });
  const webhookDeliverySweep = setInterval(() => {
    void webhookDeliveryRunner
      .tick()
      .catch((err) => relayLog.warn({ err }, "[webhook-delivery] sweep failed"));
  }, 60_000);
  webhookDeliverySweep.unref();

  // Guest WebSocket keepalive. Presence is derived purely from live guest
  // sockets (connectedUserIdsInWorkspace), so a connection that silently dies
  // must be detected promptly — otherwise the user shows online to themselves
  // (their client never noticed) while co-members already see them offline, or
  // vice-versa. Idle proxies in front of the relay also drop a quiet WS after
  // ~60s, leaving the client in a "zombie" OPEN state it never recovers from.
  //
  // Protocol-level ping frames fix both: the client's WS stack auto-replies with
  // a pong (no client code, so this is backward-compatible with old desktop
  // builds), which keeps the link warm AND tells us the socket is alive. A
  // socket that misses a full interval without ponging is terminated, which
  // fires its `close` handler → presence refresh for co-members.
  const GUEST_PING_INTERVAL_MS = 30_000;
  const guestPingSweep = setInterval(() => {
    for (const ws of guestWss.clients) {
      if (guestSocketAlive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      guestSocketAlive.set(ws, false);
      try {
        ws.ping();
      } catch {
        // A throw here just means the socket is already broken; the next sweep
        // sees alive===false and terminates it.
      }
    }
  }, GUEST_PING_INTERVAL_MS);
  guestPingSweep.unref();

  // ─── Guest WebSocket handler ──────────────────────────────────

  guestWss.on("connection", (ws) => {
    let authenticated = false;
    let receivedHello = false;

    // Keepalive: a fresh socket starts alive; every pong (auto-sent by the
    // client's WS stack in reply to guestPingSweep's ping) re-arms it.
    guestSocketAlive.set(ws, true);
    ws.on("pong", () => {
      guestSocketAlive.set(ws, true);
    });

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        ws.send(JSON.stringify({ type: "guest_error", error: "auth timeout" }));
        ws.close(4001, "auth timeout");
      }
    }, 10_000);

    async function authenticateGuest(token: string): Promise<{
      user: { id: string; email: string; name: string | null; imageUrl: string | null };
      workspaceIds: Set<string>;
      workspaces: Array<{ id: string; name: string; avatarUrl: string | null; role: string }>;
    } | null> {
      const decoded = validateUserToken(token);
      if (!decoded || !pg) return null;
      const user = await pg.getUserByEmail(decoded.email);
      if (!user) return null;
      // Block suspended/soft-deleted accounts on the WS auth path too — the cloud
      // UI runs over WebSocket, so without this a suspend/delete would only take
      // effect on the REST path and leave the live socket fully operational.
      // Returning null signals auth failure (every caller closes the socket).
      const status = await pg.getAccountStatus(user.id);
      if (status?.suspendedAt || status?.deletedAt) return null;
      const workspaces = await pg.getWorkspacesForUser(user.id);
      const workspaceIds = new Set(workspaces.map((w) => w.id));
      return {
        user: { id: user.id, email: user.email, name: user.name, imageUrl: user.imageUrl ?? null },
        workspaceIds,
        workspaces: workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          avatarUrl: w.avatar_url ?? null,
          role: w.role,
        })),
      };
    }

    function registerGuest(userId: string, token: string, workspaceIds: Set<string>): void {
      const email = validateUserToken(token)?.email ?? "";
      guests.set(ws, {
        ws,
        userId,
        email,
        token,
        workspaceIds,
        activeAgents: new Set(),
        terminalSubs: new Map(),
        // Fresh connect counts as activity; idle-decays for desktop-active push
        // suppression (see DESKTOP_ACTIVE_IDLE_MS). Push-only, not presence.
        lastActivityAt: Date.now(),
      });
      for (const wsId of workspaceIds) {
        if (!guestSubs.has(wsId)) guestSubs.set(wsId, new Set());
        guestSubs.get(wsId)!.add(ws);
      }
      authenticated = true;
      clearTimeout(authTimeout);
      // This user just came online — refresh presence for co-members in the
      // workspaces they're in (and send this guest the current snapshot).
      broadcastPresence(workspaceIds);
    }

    ws.on("message", async (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!authenticated) {
        if (msg.type === "hello") {
          receivedHello = true;
          return;
        }

        if (
          msg.type === "session" &&
          (msg.message as Record<string, unknown>)?.type === "cyborg:auth"
        ) {
          const inner = msg.message as Record<string, unknown>;
          const token = inner.token as string;
          const requestId = inner.requestId as string | undefined;
          if (!token) {
            sendPaseoResponse(ws, "cyborg:error", {
              message: "token required",
              requestId,
            });
            ws.close(4003, "unauthorized");
            return;
          }
          const result = await authenticateGuest(token);
          if (!result) {
            sendPaseoResponse(ws, "cyborg:error", {
              message: "unauthorized",
              requestId,
            });
            ws.close(4003, "unauthorized");
            return;
          }
          registerGuest(result.user.id, token, result.workspaceIds);
          sendPaseoResponse(ws, "cyborg:auth_response", {
            requestId,
            user: result.user,
            workspaces: result.workspaces,
          });
          return;
        }

        if (msg.type === "guest_hello" && typeof msg.token === "string") {
          const result = await authenticateGuest(msg.token);
          if (!result) {
            ws.send(
              JSON.stringify({
                type: "guest_error",
                error: "unauthorized",
              }),
            );
            ws.close(4003, "unauthorized");
            return;
          }
          registerGuest(result.user.id, msg.token, result.workspaceIds);
          ws.send(
            JSON.stringify({
              type: "guest_subscribed",
              workspaceIds: Array.from(result.workspaceIds),
              userId: result.user.id,
            }),
          );
          return;
        }

        // An RPC arrived before cyborg:auth completed on this socket (the
        // post-reconnect race). Reject it explicitly so the client's pending
        // request fails fast instead of hanging until its 15s timeout — a
        // silent drop here is what left chats empty until a manual reload.
        if (msg.type === "session") {
          const inner = msg.message as Record<string, unknown> | undefined;
          const requestId = inner?.requestId as string | undefined;
          if (requestId) {
            sendPaseoResponse(ws, "cyborg:error", { message: "not authenticated", requestId });
            return;
          }
        }

        if (!receivedHello) {
          ws.send(
            JSON.stringify({
              type: "guest_error",
              error: "expected guest_hello or hello",
            }),
          );
          ws.close(4002, "expected auth");
        }
        return;
      }

      const guest = guests.get(ws);
      if (!guest || !pg) return;

      if (redis) {
        try {
          const allowed = await redis.checkRate(`guest:${guest.userId}`, 30, 60);
          if (!allowed) {
            ws.send(JSON.stringify({ type: "guest_error", error: "rate limited" }));
            return;
          }
        } catch (err) {
          // Fail open: a Redis outage must not drop guest messages.
          relayLog.error({ err }, "rate-limit check failed, allowing");
        }
      }

      if (msg.type === "session" && msg.message && typeof msg.message === "object") {
        // ws doesn't await this async handler, so a throw anywhere in the RPC
        // path (e.g. a transient PG failure in an awaited query) becomes an
        // unhandled rejection and kills the whole relay process on Node 15+.
        // Contain it here and answer the caller instead of crashing.
        try {
          await handlePaseoRpc(ws, guest, msg.message as Record<string, unknown>);
        } catch (err) {
          relayLog.error({ err }, "rpc handler failed");
          const inner = msg.message as Record<string, unknown>;
          sendPaseoResponse(ws, "cyborg:error", {
            message: "internal error",
            requestId: inner.requestId as string | undefined,
          });
        }
        return;
      }

      if (msg.type === "guest_send_message") {
        const workspaceId = msg.workspaceId as string;
        const channelId = msg.channelId as string;
        const text = msg.text as string;
        if (!workspaceId || !channelId || !text) {
          ws.send(
            JSON.stringify({
              type: "guest_error",
              error: "workspaceId, channelId, and text required",
            }),
          );
          return;
        }
        if (!guest.workspaceIds.has(workspaceId)) {
          ws.send(
            JSON.stringify({
              type: "guest_error",
              error: "not subscribed to workspace",
            }),
          );
          return;
        }

        // Legacy frame must enforce the SAME authorization as cyborg:channel_message
        // (it previously skipped all of these): writer role, channel∈workspace, and
        // private-channel membership.
        const legacyRole = await pg.getMemberRole(workspaceId, guest.userId);
        if (!legacyRole || legacyRole === "viewer") {
          ws.send(
            JSON.stringify({ type: "guest_error", error: "you can't post in this workspace" }),
          );
          return;
        }
        const legacyChannel = await pg.getChannel(channelId);
        if (!legacyChannel || legacyChannel.workspace_id !== workspaceId) {
          ws.send(JSON.stringify({ type: "guest_error", error: "channel not found" }));
          return;
        }
        if (legacyChannel.is_private && !(await pg.getChannelMemberRole(channelId, guest.userId))) {
          ws.send(JSON.stringify({ type: "guest_error", error: "not a member of this channel" }));
          return;
        }

        const user = await pg.getUserById(guest.userId);
        const messageId = randomUUID();
        const now = Date.now();

        const channelMessage = {
          type: "cyborg:channel_message_broadcast" as const,
          payload: {
            id: messageId,
            workspaceId,
            channelId,
            fromId: guest.userId,
            fromType: "human" as const,
            fromName: user?.name ?? null,
            toId: (msg.toId as string) ?? null,
            text,
            mentions: (msg.mentions as string[]) ?? null,
            parentId: (msg.parentId as string) ?? null,
            createdAt: now,
          },
        };

        const seq = relay.injectMessage(workspaceId, channelMessage, "guest");

        ws.send(
          JSON.stringify({
            type: "guest_message_ack",
            messageId,
            seq,
          }),
        );
      } else if (msg.type === "guest_prompt_agent") {
        try {
          const workspaceId = msg.workspaceId as string;
          const agentId = msg.agentId as string;
          const prompt = msg.prompt as string;
          if (!workspaceId || !agentId || !prompt) {
            ws.send(
              JSON.stringify({
                type: "guest_error",
                error: "workspaceId, agentId, and prompt required",
              }),
            );
            return;
          }
          if (!guest.workspaceIds.has(workspaceId)) {
            ws.send(
              JSON.stringify({
                type: "guest_error",
                error: "not subscribed to workspace",
              }),
            );
            return;
          }

          if (pg) {
            const guestAccess = await checkAgentAccess(pg, workspaceId, guest.userId, agentId);
            if (!guestAccess.allowed) {
              ws.send(
                JSON.stringify({
                  type: "guest_error",
                  error: guestAccess.reason,
                }),
              );
              return;
            }
            // HARD-PAUSE license gate (DECISION #2) — mirrors the cyborg:send_agent_prompt path.
            // Only enforce when billing is configured (see agent-spawn gate above).
            const gpLicense = isStripeConfigured() ? await pg.getLicenseStatus(workspaceId) : null;
            if (gpLicense?.state === "paused") {
              ws.send(
                JSON.stringify({
                  type: "guest_error",
                  error: "license_required",
                  message: "Trial ended — activate your license to bring agents back online.",
                  license: gpLicense,
                }),
              );
              return;
            }
            const gpUser = await pg.getUserById(guest.userId);
            relay.injectMessage(
              workspaceId,
              {
                type: "cyborg:dm_broadcast" as const,
                payload: {
                  id: randomUUID(),
                  workspaceId,
                  channelId: null,
                  fromId: guest.userId,
                  fromType: "human" as const,
                  fromName: gpUser?.name ?? null,
                  toId: agentId,
                  text: prompt,
                  mentions: null,
                  parentId: null,
                  createdAt: Date.now(),
                },
              },
              "guest",
            );
          }

          relay.injectMessage(workspaceId, {
            type: "cyborg:agent_prompt_forward",
            agentId,
            workspaceId,
            prompt,
            fromDaemonId: "guest",
          });

          // Remember this agent so we can cancel its turn if the guest
          // disconnects before it finishes (see ws "close" handler).
          guest.activeAgents.add(`${workspaceId}\t${agentId}`);

          ws.send(JSON.stringify({ type: "guest_prompt_ack", agentId }));
        } catch (err) {
          relayLog.error({ err }, "guest_prompt_agent failed");
          ws.send(
            JSON.stringify({
              type: "guest_error",
              error: "internal_error",
              message: "Failed to process prompt. Please try again.",
            }),
          );
        }
      } else if (msg.type === "guest_cancel_agent") {
        const workspaceId = msg.workspaceId as string;
        const agentId = msg.agentId as string;
        if (!workspaceId || !agentId) return;
        if (!guest.workspaceIds.has(workspaceId)) return;
        if (pg) {
          const cancelAccess = await checkAgentAccess(pg, workspaceId, guest.userId, agentId);
          if (!cancelAccess.allowed) return;
        }

        relay.injectMessage(workspaceId, {
          type: "cyborg:cancel_agent_forward",
          agentId,
          workspaceId,
          fromDaemonId: "guest",
        });
        guest.activeAgents.delete(`${workspaceId}\t${agentId}`);
      } else if (msg.type === "guest_permission_response") {
        const workspaceId = msg.workspaceId as string;
        const agentId = msg.agentId as string;
        const permissionRequestId = msg.permissionRequestId as string;
        const response = msg.response as Record<string, unknown>;
        if (!workspaceId || !agentId || !permissionRequestId || !response) return;
        if (!guest.workspaceIds.has(workspaceId)) return;
        if (pg) {
          const permAccess = await checkAgentAccess(pg, workspaceId, guest.userId, agentId);
          if (!permAccess.allowed) return;
        }

        relay.injectMessage(workspaceId, {
          type: "cyborg:permission_response_forward",
          agentId,
          workspaceId,
          permissionRequestId,
          response,
          fromDaemonId: "guest",
        });
      } else if (msg.type === "guest_fetch_history") {
        const channelId = msg.channelId as string;
        if (!channelId) return;

        // Legacy read carries no workspaceId — derive it from the channel and
        // assert the caller is a member (and a private channel's member) before
        // returning history, mirroring cyborg:fetch_messages.
        const ghChannel = await pg.getChannel(channelId);
        if (!ghChannel) {
          ws.send(JSON.stringify({ type: "guest_error", error: "channel not found" }));
          return;
        }
        const ghRole = await pg.getMemberRole(ghChannel.workspace_id, guest.userId);
        if (
          !ghRole ||
          (ghChannel.is_private && !(await pg.getChannelMemberRole(channelId, guest.userId)))
        ) {
          ws.send(JSON.stringify({ type: "guest_error", error: "channel not found" }));
          return;
        }

        try {
          const messages = await pg.getMessages({
            channelId,
            before: msg.before as string | undefined,
            limit: Math.min((msg.limit as number) ?? 50, 200),
          });
          ws.send(
            JSON.stringify({
              type: "guest_history",
              channelId,
              messages,
            }),
          );
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: "guest_error",
              error: "failed to fetch history",
            }),
          );
        }
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      const guest = guests.get(ws);
      if (guest) {
        // Cancel any turns this guest started that may still be running, so an
        // agent paused on a permission request this guest never answered does
        // not hang. Cancel of an already-idle agent is a no-op on the daemon.
        for (const key of guest.activeAgents) {
          const [wsId, agentId] = key.split("\t");
          if (!wsId || !agentId) continue;
          relay.injectMessage(wsId, {
            type: "cyborg:cancel_agent_forward",
            agentId,
            workspaceId: wsId,
            fromDaemonId: "guest",
          });
        }
        guest.activeAgents.clear();
        // Forward an unsubscribe_terminal for every live terminal subscription this
        // guest held so a DIRTY close (app crash) drops the daemon-side viewer right
        // away instead of leaking it until the next reopen — a leaked viewer + a
        // reopen's fresh attachId is what doubled every character (#807). The daemon
        // owner-locks + is idempotent, so a redundant unsubscribe is a safe no-op.
        for (const [terminalId, sub] of guest.terminalSubs) {
          relay.sendToDaemonInWorkspace(
            sub.workspaceId,
            {
              type: "cyborg:relay_rpc",
              token: guest.token,
              workspaceId: sub.workspaceId,
              guestId: guest.userId,
              inner: {
                type: "cyborg:unsubscribe_terminal",
                workspaceId: sub.workspaceId,
                daemonId: sub.daemonId,
                terminalId,
                attachId: sub.attachId,
              },
            },
            sub.daemonId,
          );
        }
        guest.terminalSubs.clear();
        for (const wsId of guest.workspaceIds) {
          const s = guestSubs.get(wsId);
          if (s) {
            s.delete(ws);
            if (s.size === 0) guestSubs.delete(wsId);
          }
        }
        guests.delete(ws);
        // P2 #6a: manual away is DURABLE now (persisted in user_presence) — do
        // NOT clear it on the last socket close. broadcastPresence intersects
        // awayUsers with the live online set, so an away-user who fully
        // disconnects correctly shows offline (not away) to co-members, while
        // their away choice is restored the moment they reconnect.
        // This user may have gone offline (no other open sockets) — refresh
        // presence for co-members in the workspaces they were in so their dot
        // goes grey live. The leaving socket is already out of guestSubs above,
        // so it only notifies the remaining members.
        broadcastPresence(guest.workspaceIds);
      }
    });

    ws.on("error", () => {
      clearTimeout(authTimeout);
    });
  });

  // ─── Shutdown ─────────────────────────────────────────────────

  const shutdown = async () => {
    relayLog.info("Shutting down...");
    // Announce a planned restart BEFORE dropping sockets so clients show a
    // friendly "Updating…" state and reconnect quietly, instead of treating the
    // drop as an error/logout. Then give them a brief window to receive the
    // notice and let in-flight RPCs settle before we actually close.
    for (const [ws] of guests) {
      sendPaseoResponse(ws, "cyborg:server_shutdown", { reason: "deploy", etaMs: 10_000 });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    clearInterval(guestPingSweep);
    for (const [ws] of guests) ws.close(1001, "server shutting down");
    guests.clear();
    guestSubs.clear();
    guestWss.close();
    await relay.close();
    server.close();
    if (redis) await redis.close();
    if (pg) await pg.close();
    // Drain any pending Logfire spans before the process exits.
    await flush();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch(async (err) => {
  // relayLog may be unset if main() threw before its assignment (e.g. config
  // bootstrap) — fall back to console so the fatal is never swallowed.
  if (relayLog) {
    relayLog.fatal({ err }, "Relay fatal");
  } else {
    console.error("[server] Fatal:", err);
  }
  // Best-effort drain so the fatal exception reaches Logfire before exit.
  await flush();
  process.exit(1);
});

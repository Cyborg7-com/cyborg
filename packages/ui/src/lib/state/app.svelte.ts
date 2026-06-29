import { goto } from "$app/navigation";
import { toast } from "svelte-sonner";
import { reportClientError } from "@cyborg7/observability/web";
import { client } from "./client.js";
import type { ProviderCredentialPayload, ProviderAuthMeta } from "../ws-client.js";
import { refreshChannelRosterOnMembershipChange } from "../channel-roster-refresh.js";
import { sessionAlias } from "./session-alias.svelte.js";
import { terminalAlias } from "./terminal-alias.svelte.js";
import { favoritesState } from "./favorites.svelte.js";
import { scheduledMessagesState } from "./scheduled-messages.svelte.js";
import { schedulesState } from "./schedules.svelte.js";
import { promptTemplatesState } from "./prompt-templates.svelte.js";
import { draftsState } from "../drafts.svelte.js";
import {
  AuthError,
  NetworkError,
  LicenseRequiredError,
  fetchInvitePreview,
  type PublicInvitePreview,
} from "../core/client.js";
import { licenseState } from "./license.svelte.js";
import type { Attachment, Channel, Workspace } from "../core/types.js";
import {
  shouldNotifyFor,
  hasMention,
  type NotifyContext,
  type NotificationPref,
} from "../notify-policy.js";
import { playNotificationSound, playNamedSound, unlockNotificationAudio } from "../notify-sound.js";
import { notifyClientPrefsState } from "../notify-client-prefs.svelte.js";
import { registerMobilePush, isTauriIOS, isTauriAndroid } from "../mobile/push.js";
import { isDesktopApp } from "../utils.js";
import type { BillingPlatformPayload } from "../core/client.js";
import { openExternalUrl } from "../desktop-terminal.js";
import * as cache from "../cache/index.js";
import type {
  Agent,
  AgentEvent,
  AgentPermissionResponse,
  AgentSlashCommand,
} from "../plugins/agents/types.js";
import { applyCyboUpdate } from "../plugins/agents/apply-cybo-update.js";
import { appendCybo, removeCybo } from "../plugins/agents/cybo-roster-ops.js";
import { createSeqGapState, recoverSeqGap } from "./seq-gap-recovery.js";
import { createUnreadReconcileState, reconcileUnread } from "./unread-reconcile.js";
import { agentIdsForDaemonCatchUp } from "./agent-catchup-scope.js";
import { shellConfig } from "../core/plugin.svelte.js";

// Re-export core state (only things NOT using coreClient)
export {
  authState,
  connectionState,
  daemonHealthState,
  presenceState,
  workspaceUserStatusesState,
  workspaceState,
  channelState,
  dmState,
  dmTypingState,
  userStatusState,
  notificationState,
  unreadFlagState,
  dmActivityState,
  sortMembersByDmRecency,
  notifPrefsState,
  threadsState,
  savedState,
  messageFocusState,
  getSavedSession,
  clearSavedSession,
} from "../core/state.svelte.js";
export type { SavedSession, UserStatus, DaemonHealthData } from "../core/state.svelte.js";
// Client-only sidebar favorites (channels/DMs/agents). Re-exported here so UI
// components import it alongside the rest of the workspace state.
export { favoritesState } from "./favorites.svelte.js";
// Scheduled messages (#607 — user send-later). Re-exported so the composer
// dialog + Scheduled pane import it alongside the rest of the app state.
export {
  scheduledMessagesState,
  scheduledStatus,
  scheduledErrorLabel,
  type ScheduledStatus,
} from "./scheduled-messages.svelte.js";
// Recurring cybo schedules (#611/#613/#619 — the Tasks-tab "Scheduled" board).
// Re-exported so the Tasks route + create dialog import it alongside app state.
export { schedulesState } from "./schedules.svelte.js";
export type { ThreadSummary } from "../core/client.js";
export { AuthError, NetworkError } from "../core/client.js";
// Client-only notification prefs (DND, custom keywords, per-channel ignore-
// broadcast + sound). Re-exported here so settings/profile UIs import all state
// from one place, matching the rest of the codebase.
export { notifyClientPrefsState } from "../notify-client-prefs.svelte.js";
export { SOUND_CHOICES } from "../notify-client-prefs.svelte.js";
export type { SoundChoice } from "../notify-client-prefs.svelte.js";

import {
  authState,
  connectionState,
  daemonHealthState,
  presenceState,
  workspaceUserStatusesState,
  workspaceState,
  channelState,
  dmState,
  dmTypingState,
  userStatusState,
  notificationState,
  unreadFlagState,
  dmActivityState,
  readCursorState,
  notifPrefsState,
  threadsState,
  savedState,
  messageFocusState,
  clearSavedSession,
} from "../core/state.svelte.js";
import { findOptimisticIndex } from "../core/message-reconcile.js";

// Re-export agent state
export {
  agentStreamState,
  attentionState,
  providerState,
  cyboState,
  daemonState,
  logState,
  activityState,
  sessionState,
  daemonAccessRequestsState,
} from "../plugins/agents/state.svelte.js";

import {
  agentStreamState,
  attentionState,
  providerState,
  cyboState,
  daemonState,
  logState,
  activityState,
  sessionState,
  daemonAccessRequestsState,
  ARCHIVED_SESSIONS_PAGE_SIZE,
} from "../plugins/agents/state.svelte.js";

export type {
  StreamEntry,
  TurnStatus,
  LogEntry,
  LogLevel,
  LogCategory,
  ActivityItem,
  ActivityEventType,
  DaemonAccessRequest,
  RecentSession,
  ArchivedSession,
  ResumeOverrides,
} from "../plugins/agents/state.svelte.js";

import type {
  ServerActivityItem,
  ResumeOverrides,
  DaemonAccessRequest,
  RecentSession,
} from "../plugins/agents/state.svelte.js";
export type { Daemon, DaemonMeta, DaemonAccessEntry } from "../plugins/agents/types.js";
export type { ProviderCredentialPayload, ProviderAuthMeta } from "../ws-client.js";

// ─── Composed client (agents + core) ─────────────────────────────

interface RawReaction {
  userId: string;
  userName?: string;
  emoji: string;
  createdAt: number;
}

function hydrateReactions(
  raw: RawReaction[] | null | undefined,
  myId: string | undefined,
): import("../core/types.js").Reaction[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const grouped = new Map<string, { count: number; reacted: boolean; names: string[] }>();
  for (const r of raw) {
    const entry = grouped.get(r.emoji) ?? { count: 0, reacted: false, names: [] };
    entry.count++;
    if (r.userId === myId) entry.reacted = true;
    if (r.userName) entry.names.push(r.userName);
    grouped.set(r.emoji, entry);
  }
  return [...grouped.entries()].map(([emoji, g]) => ({
    emoji,
    count: g.count,
    reacted: g.reacted,
    reactorNames: g.names,
  }));
}

function hydrateMessages(
  messages: import("../core/types.js").Message[],
): import("../core/types.js").Message[] {
  const myId = authState.user?.id;
  return messages.map((m) => {
    const raw = (m as unknown as { reactions?: RawReaction[] | null }).reactions;
    if (!raw || !Array.isArray(raw) || raw.length === 0) return m;
    if (raw[0] && "count" in raw[0]) return m;
    return { ...m, reactions: hydrateReactions(raw, myId) };
  });
}

// ─── Local message cache (iOS shell only — Caveats #28/#29) ──────────────────
//
// Strictly additive + iOS-gated. Everything below no-ops unless isTauriIOS() is
// true, so web/desktop/Android are byte-for-byte unaffected. On a cache MISS or
// ANY error the existing network-fetch path runs exactly as before. All writes
// are fire-and-forget. The L1 Map lives in a plain `.ts` singleton (Caveat #28);
// cursors are stamped only on fetch SUCCESS (Caveat #29).

function cacheOn(): boolean {
  try {
    return isTauriIOS();
  } catch {
    return false;
  }
}

// L1 memory key (per active conversation) + L2 scope key share the same string.
function channelKey(wsId: string, channelId: string): string {
  return cache.channelScope(wsId, channelId);
}
function dmKey(wsId: string, peerId: string): string {
  return cache.dmScope(wsId, peerId);
}

/**
 * Synchronous cold-render peek for selectChannel/selectDm. Returns the cached
 * Message[] if L1 has them (instant paint, no skeleton); null otherwise — the
 * caller then keeps its current `messages=[]; loading=true` behavior. The async
 * L2 read is kicked off in the background and, if it lands while we're still on
 * the same conversation and the network hasn't answered yet, paints then.
 */
function coldPeekChannel(channelId: string): import("../core/types.js").Message[] | null {
  if (!cacheOn() || !workspaceState.current) return null;
  const wsId = workspaceState.current.id;
  const key = channelKey(wsId, channelId);
  const hit = cache.memGet(key);
  if (hit && hit.messages.length > 0) return hit.messages;
  // L1 miss: try L2 in the background. If it resolves before the network and
  // we're still on this channel still loading, paint the cached window.
  void (async () => {
    const entry = await cache.readCache(key, key);
    if (!entry || entry.messages.length === 0) return;
    if (channelState.activeId === channelId && channelState.loading) {
      channelState.setMessages(entry.messages);
      channelState.loading = false;
    }
  })();
  return null;
}

function coldPeekDm(peerId: string): import("../core/types.js").Message[] | null {
  if (!cacheOn() || !workspaceState.current) return null;
  const wsId = workspaceState.current.id;
  const key = dmKey(wsId, peerId);
  const hit = cache.memGet(key);
  if (hit && hit.messages.length > 0) return hit.messages;
  void (async () => {
    const entry = await cache.readCache(key, key);
    if (!entry || entry.messages.length === 0) return;
    if (dmState.activePeerId === peerId && dmState.loading) {
      dmState.mergeServer(entry.messages);
      dmState.loading = false;
    }
  })();
  return null;
}

// Writeback after a successful fetch — persists the authoritative window +
// stamps the read cursor (Caveat #29). Fire-and-forget.
function cacheWriteChannel(wsId: string, channelId: string): void {
  if (!cacheOn()) return;
  const key = channelKey(wsId, channelId);
  void cache.writeScopeMessages(
    key,
    key,
    channelState.messages,
    readCursorState.getChannel(channelId),
  );
}
function cacheWriteDm(wsId: string, peerId: string): void {
  if (!cacheOn()) return;
  const key = dmKey(wsId, peerId);
  void cache.writeScopeMessages(key, key, dmState.messages, readCursorState.getDm(peerId));
}

// Resolve the scope key for a live message (used by WS-mutation writeback). A
// channel message → channel scope; a DM → dm scope keyed by the peer.
function scopeForMessage(msg: import("../core/types.js").Message): string | null {
  const wsId = msg.workspaceId ?? workspaceState.current?.id;
  if (!wsId) return null;
  if (msg.channelId) return cache.channelScope(wsId, msg.channelId);
  const myId = authState.user?.id;
  if (myId && (msg.fromId === myId || msg.toId === myId)) {
    const peerId = msg.fromId === myId ? msg.toId : msg.fromId;
    if (peerId) return cache.dmScope(wsId, peerId);
  }
  return null;
}

// Upsert a live channel/DM message into the cache so cold revisits are fresh.
// Skips optimistic local rows (the real echo is cached when it arrives) and any
// message we can't scope. Fire-and-forget; no-op off-iOS.
function cacheSyncIncoming(msg: import("../core/types.js").Message): void {
  if (!cacheOn()) return;
  if (msg.id.startsWith("local-")) return;
  const scopeKey = scopeForMessage(msg);
  if (!scopeKey) return;
  void cache.cacheUpsertMessage(scopeKey, msg);
}

// Re-exported from ./client.js (the singleton lives there to break the
// app.svelte.ts and web-push import cycle). Consumers that import `client` from
// this module are unaffected.
export { client };

// Wire core events
let hasConnectedBefore = false;

// Outbox: messages whose send threw because the socket was down (e.g. mid
// deploy) or open-but-unauthenticated. We keep the optimistic bubble on screen
// and replay the send once the socket is back+authed, instead of silently
// rolling it back. The broadcast echo reconciles the optimistic message (by
// clientMsgId, #501), so a single replay doesn't duplicate.
//
// Each entry is keyed by its clientMsgId AND mirrored to IndexedDB (#502) so an
// undelivered send survives a reload: on startup the queue is rebuilt from the
// persisted records (rehydrateOutbox), and each record is deleted once its echo
// reconciles the bubble (dequeueOutbox). The closure can't be persisted, so it's
// always derived from the serializable record via recordToCommand.
const sendOutbox: Array<{ clientMsgId: string; resend: () => void }> = [];

// Build the replay closure for a record (pure mapping → the right client call).
function outboxResend(rec: cache.OutboxRecord): () => void {
  const cmd = cache.recordToCommand(rec);
  return cmd.kind === "dm"
    ? () => client.sendDm(...cmd.args)
    : () => client.sendMessage(...cmd.args);
}

// Queue a send for replay: persist it (survives reload) + push its closure.
// Skips a duplicate clientMsgId already queued (a retry re-uses the same id).
function enqueueOutbox(rec: cache.OutboxRecord): void {
  void cache.putOutbox(rec);
  if (sendOutbox.some((e) => e.clientMsgId === rec.clientMsgId)) return;
  sendOutbox.push({ clientMsgId: rec.clientMsgId, resend: outboxResend(rec) });
}

// The send was delivered (its echo reconciled the optimistic row) — drop the
// persisted record so a future reload doesn't re-send it, and clear any
// still-pending in-memory replay for the same id.
function dequeueOutbox(clientMsgId: string | null | undefined): void {
  if (!clientMsgId) return;
  void cache.deleteOutbox(clientMsgId);
  const idx = sendOutbox.findIndex((e) => e.clientMsgId === clientMsgId);
  if (idx >= 0) sendOutbox.splice(idx, 1);
  forgetOutboxBubble(clientMsgId);
}

function flushSendOutbox(): void {
  if (sendOutbox.length === 0) return;
  const pending = sendOutbox.splice(0, sendOutbox.length);
  for (const entry of pending) {
    try {
      entry.resend();
      // Handed to an authed socket — the relay now owns delivery + persistence,
      // so drop the persisted record (#502). If we reload before the echo, the
      // message is already in server history (no dupe); the broadcast echo also
      // dequeues, so this is idempotent. We only KEEP the record when the resend
      // throws below (still offline), so a genuinely-undelivered send survives.
      void cache.deleteOutbox(entry.clientMsgId);
    } catch {
      // Still down — re-queue (keep the persisted record) so the next connect
      // (or reload) retries; the record stays in IDB until it's handed off.
      sendOutbox.push(entry);
    }
  }
}

// Optimistic bubbles rebuilt from the persisted outbox on cold start (#502),
// indexed by their surface key so the channel/DM that owns them can re-show them
// AFTER its history fetch (which replaces the list via setMessages and would
// otherwise drop a not-yet-delivered row). Each entry is removed once its send
// is delivered+dequeued. Surface key: `channel:<channelId>` / `dm:<peerId>`.
const pendingOutboxBubbles = new Map<string, import("../core/types.js").Message[]>();
function outboxSurfaceKey(kind: "channel" | "dm", targetId: string): string {
  return `${kind}:${targetId}`;
}

// Re-add any persisted-outbox bubbles for the just-loaded surface, so a reload's
// history fetch doesn't hide a still-pending send. addMessage is idempotent (it
// skips an existing id and reconciles a settled one), so this is safe to call on
// every selectChannel/selectDm. No-op when nothing is pending for that surface.
function reapplyOutboxBubbles(kind: "channel" | "dm", targetId: string): void {
  const bubbles = pendingOutboxBubbles.get(outboxSurfaceKey(kind, targetId));
  if (!bubbles || bubbles.length === 0) return;
  for (const msg of bubbles) {
    if (kind === "channel") channelState.addMessage(msg);
    else dmState.addMessage(msg);
  }
}

// Forget a delivered send's rehydrated bubble so it isn't re-applied on a later
// re-open of the surface. Called from dequeueOutbox.
function forgetOutboxBubble(clientMsgId: string): void {
  const localId = cache.localIdFor(clientMsgId);
  for (const [key, bubbles] of pendingOutboxBubbles.entries()) {
    const next = bubbles.filter((m) => m.id !== localId);
    if (next.length === 0) pendingOutboxBubbles.delete(key);
    else if (next.length !== bubbles.length) pendingOutboxBubbles.set(key, next);
  }
}

// Keep a rehydrated bubble's snapshot status in sync with its live row, so when
// the surface is (re-)opened after the watchdog fired, reapplyOutboxBubbles shows
// "failed" (not a perpetual spinner). No-op for a localId we aren't tracking.
function patchPendingBubbleStatus(localId: string, status: "pending" | "sent" | "failed"): void {
  for (const [key, bubbles] of pendingOutboxBubbles.entries()) {
    const idx = bubbles.findIndex((m) => m.id === localId);
    if (idx < 0) continue;
    const next = bubbles.slice();
    next[idx] = { ...next[idx], sendStatus: status };
    pendingOutboxBubbles.set(key, next);
  }
}

// Cold-start rehydration (#502): rebuild the optimistic bubbles + replay queue
// from persisted outbox records for THIS user. Called right after auth, before
// flushSendOutbox runs on the live socket. Re-adds each queued send's bubble (as
// "pending") to its channel/DM so a reload re-shows it — both immediately if that
// surface is already open AND via reapplyOutboxBubbles after its history fetch.
// The same clientMsgId is preserved so the echo reconciles the exact row.
async function rehydrateOutbox(userId: string): Promise<void> {
  const records = await cache.getOutboxForUser(userId);
  if (records.length === 0) return;
  const myName = authState.user?.name ?? authState.user?.email ?? "You";
  for (const rec of records) {
    const msg = cache.recordToOptimisticMessage(rec, myName);
    // Remember it so the owning surface re-shows it after its fetch (setMessages
    // replaces the list, so a one-shot add now can be clobbered by a later load).
    const key = outboxSurfaceKey(rec.kind, rec.targetId);
    pendingOutboxBubbles.set(key, [...(pendingOutboxBubbles.get(key) ?? []), msg]);
    // If that surface is already open, show it immediately too.
    if (rec.kind === "channel" && rec.targetId === channelState.activeId) {
      channelState.addMessage(msg);
    } else if (rec.kind === "dm" && rec.targetId === dmState.activePeerId) {
      dmState.addMessage(msg);
    }
    // Always rebuild the replay queue (dedup by clientMsgId) so the pending send
    // is retried regardless of which surface is currently open.
    if (!sendOutbox.some((e) => e.clientMsgId === rec.clientMsgId)) {
      sendOutbox.push({ clientMsgId: rec.clientMsgId, resend: outboxResend(rec) });
    }
    // Arm the failure watchdog so a rehydrated send that still never delivers
    // surfaces "Failed – Retry" after reload (mirrors a fresh send's dispatch).
    // The post-rehydrate flush re-attempts delivery; if its echo arrives first,
    // the watchdog is swept (sweepReconciledWatchdogs) and never fires.
    armSendWatchdog(msg.id, rec.kind);
  }
}

client.on("connection", ({ status, attempt, delayMs }) => {
  connectionState.status = status;
  // Surface reconnect progress in the banner ("attempt N · retrying in Ns").
  // Present only on a "reconnecting" emit; reset on a successful connection so a
  // future drop starts clean.
  if (status === "reconnecting") {
    if (typeof attempt === "number") connectionState.reconnectAttempt = attempt;
    if (typeof delayMs === "number") connectionState.reconnectDelayMs = delayMs;
  } else if (status === "connected") {
    connectionState.reconnectAttempt = 0;
    connectionState.reconnectDelayMs = 0;
  }
  // Mark the first-ever successful connect so the ConnectionStatus banner only
  // appears for REAL drops afterward — never during the cold-start restore
  // (which the splash already covers).
  if (status === "connected") connectionState.hasConnectedOnce = true;

  if (status === "connected") {
    // The relay is back — clear the deploy banner. The outbox is NOT flushed
    // here: a freshly-opened socket is not yet authenticated (cyborg:auth runs
    // afterward in handleReconnect/connectToServer), and unauthenticated sends
    // are silently dropped by the relay. Flushing happens right after auth
    // succeeds, so replayed messages aren't lost.
    connectionState.deploying = false;
  }
  if (status === "connected" && hasConnectedBefore) {
    handleReconnect();
  }
  if (status === "connected") hasConnectedBefore = true;
});

// A hole in the per-workspace broadcast sequence was detected on an OPEN socket
// (#499) — events lost between relay instances / on a flaky link without the
// socket dropping. Catch up immediately (onSeqGap is coalesced + rate-limited).
client.on("seq_gap", ({ workspaceId }) => {
  void onSeqGap(workspaceId);
});

// The relay announced a planned restart (deploy). Show a friendly "Updating…"
// state so the imminent socket drop reads as maintenance, not an error, and the
// reconnect that follows is expected.
client.on("server_shutdown", () => {
  connectionState.deploying = true;
  connectionState.status = "reconnecting";
});

// Apply one sync page's messages to the active channel.
function applyChannelSyncPage(
  mode: "delta" | "snapshot",
  messages: import("../core/types.js").Message[],
): void {
  const hydrated = hydrateMessages(messages);
  const activeChannel = channelState.activeId;
  // Collapsed threads: replies belong to the thread panel, never the channel
  // timeline — exclude them from the sync delta too (not just the initial fetch),
  // so a reconnect doesn't splice replies back into the channel.
  const channelMessages = activeChannel
    ? hydrated.filter(
        (m: { channelId?: string | null; parentId?: string | null }) =>
          m.channelId === activeChannel && !m.parentId,
      )
    : [];
  if (mode === "snapshot") {
    channelState.setMessages(channelMessages);
  } else {
    for (const msg of channelMessages) channelState.addMessage(msg);
  }
}

// Drain the workspace delta in pages — a long disconnect can exceed one page
// (500); the old single call silently dropped the rest. Bounded against an
// infinite loop if the cursor ever fails to advance.
async function drainSync(wsId: string, fromSeq: number): Promise<void> {
  let cursor = fromSeq;
  for (let page = 0; page < 50; page++) {
    const { mode, messages, hasMore, nextSeq } = await client.sync(wsId, cursor);
    if (workspaceState.current?.id !== wsId) break;
    applyChannelSyncPage(mode, messages);
    if (!hasMore || nextSeq === undefined || nextSeq <= cursor) break;
    cursor = nextSeq;
  }
}

// Catch the open DM up after a disconnect (#500). A populated DM forward-drains
// from its newest known seq via fetchDmSince (paginated until caught up), so a
// disconnect with >50 new DM messages reconstructs the FULL history — the old
// blind "latest 50" refetch silently lost everything older than the 50 newest.
// A cold DM (no seq cursor) or an older relay without fetch_dm_since falls back
// to the latest-page fetch (prior behavior). mergeServer dedups + reconciles
// optimistic rows, so re-running on a populated DM only splices in what we missed.
async function catchUpDm(wsId: string, peerId: string): Promise<void> {
  const stillCurrent = () => workspaceState.current?.id === wsId && dmState.activePeerId === peerId;
  const fromSeq = dmState.lastSeq;
  if (fromSeq > 0) {
    try {
      let cursor = fromSeq;
      for (let page = 0; page < 50; page++) {
        const { messages, hasMore, nextSeq } = await client.fetchDmSince(wsId, peerId, cursor);
        if (!stillCurrent()) return;
        dmState.mergeServer(hydrateMessages(messages));
        if (!hasMore || nextSeq === undefined || nextSeq <= cursor) break;
        cursor = nextSeq;
      }
      return;
    } catch {
      // Older relay without fetch_dm_since — fall through to the latest window.
    }
  }
  try {
    const { messages, hasMore } = await client.fetchDmMessages(wsId, peerId, { limit: 50 });
    if (!stillCurrent()) return;
    dmState.mergeServer(hydrateMessages(messages));
    // Only set the older-history paging flag on the cold path — a populated DM may
    // have already paged older history that this fresh window must not discard.
    if (fromSeq === 0) dmState.hasMore = hasMore;
  } catch {
    // server may not support DM fetch yet
  }
}

// Seq-gap recovery (#499 + #639). A forward jump in the per-workspace broadcast
// seq means events may have been lost on an OPEN socket — recover the active
// channel + DM MESSAGES and the ROSTER panels (#639) now, instead of waiting for
// the next reconnect/foreground. The orchestration (in-flight guard, min-interval
// coalescing, per-step workspace re-check) lives in the testable seq-gap-recovery
// module; here we just wire the live deps.
const SEQ_GAP_MIN_INTERVAL_MS = 10_000;
const seqGapState = createSeqGapState();
async function onSeqGap(wsId: string): Promise<void> {
  await recoverSeqGap(
    wsId,
    {
      isActiveWorkspace: (id) => workspaceState.current?.id === id,
      now: () => Date.now(),
      drainMessages: (id) => drainSync(id, channelState.lastSeq),
      catchUpDm: async (id) => {
        if (dmState.activePeerId) await catchUpDm(id, dmState.activePeerId);
      },
      reconcilePanels: (id) => reconcileWorkspacePanels(id),
    },
    seqGapState,
    SEQ_GAP_MIN_INTERVAL_MS,
  );
}

// Authoritative unread reconcile on foreground (#672). The red unread badge
// lives in PERSISTED localStorage and only self-corrects on a fetch_unread
// reseed; onForeground() previously rode that reseed on handleReconnect(), gated
// behind away ≥ 30s + a needed reconnect — so a brief background → read
// elsewhere → foreground left the stale badge. This re-fetches the authoritative
// snapshot and reseeds on EVERY foreground (the orchestration — in-flight guard,
// min-interval coalescing, no-swallow retry — lives in the testable
// unread-reconcile module; here we just wire the live deps). Scoped to
// unread/read-state only — it does NOT touch the zombie-socket reconnect (still
// away-gated below) nor the status path (#671).
const UNREAD_RECONCILE_MIN_INTERVAL_MS = 10_000;
const unreadReconcileState = createUnreadReconcileState();
// One workspace's authoritative reseed: same body as subscribeAndSeedAllWorkspaces'
// per-workspace seed, but AWAITED and allowed to THROW so the orchestrator can
// retry on the next foreground instead of stranding the persisted-stale cache.
async function reconcileWorkspaceUnread(wsId: string): Promise<void> {
  const u = await client.fetchUnread(wsId);
  seedUnreadSignals(wsId, u);
  // Re-freeze the divider cursors from server truth — but only for the active
  // workspace, since readCursorState is a single global map and a background
  // workspace must not clobber the open conversation's cursor.
  if (workspaceState.current?.id === wsId) {
    readCursorState.seed({ reads: u.reads, dmReads: u.dmReads });
  }
  // NOTE: the dock/title push is intentionally NOT here. When the orchestrator
  // reconciles every workspace concurrently, a per-workspace push would emit one
  // intermediate (and possibly inconsistent) badge total per workspace. The
  // caller pushes globalTotal ONCE after all workspaces have settled.
}
async function reconcileUnreadOnForeground(): Promise<void> {
  await reconcileUnread(
    {
      listWorkspaceIds: () => workspaceState.list.map((ws) => ws.id),
      reconcileWorkspaceUnread,
      now: () => Date.now(),
    },
    unreadReconcileState,
    UNREAD_RECONCILE_MIN_INTERVAL_MS,
  );
  // Push the freshly-reconciled total to the dock/title ONCE, after every
  // workspace has been reseeded — so the badge updates on foreground even before
  // the reactive effect re-runs, without flickering through intermediate
  // per-workspace totals.
  pushUnreadIndicators(notificationState.globalTotal);
}

// Reconcile sidebar state (channels/members/agents/daemons) whose broadcasts
// were missed while disconnected. Active-channel messages are handled by sync.
async function reconcileWorkspacePanels(wsId: string): Promise<void> {
  try {
    // Each pane reconcile is independent; null means "keep the current pane"
    // (guarded by the `if (channels)`… checks below), so one fetch failing leaves
    // that pane stale rather than blanking it — not a lost user action.
    const [channels, members, agents, daemons] = await Promise.all([
      client.fetchChannels(wsId).catch(() => null), // intentional: stale pane, see above
      client.listMembers(wsId).catch(() => null), // intentional: stale pane, see above
      client.listAgents(wsId).catch(() => null), // intentional: stale pane, see above
      client.listDaemons(wsId).catch(() => null), // intentional: stale pane, see above
    ]);
    if (workspaceState.current?.id !== wsId) return;
    if (channels) workspaceState.channels = channels;
    if (members) {
      workspaceState.members = members;
      authState.setMemberImagesFromMembers(members);
    }
    if (agents) {
      workspaceState.agents = agents;
      // #591: a reconnect snapshot is the authoritative "what happened while I
      // was away" — seed the derived attention badges from it.
      attentionState.seedFromAgents(agents);
    }
    if (daemons) daemonStatusState.load(daemons.daemons);
    // Archived sessions + cybos aren't reconciled by the fetches above and their
    // sidebar fetches are one-shot — refetch here so a reconnect (fresh socket)
    // refills them instead of leaving "No archived sessions" / blank cybo avatars
    // until reload.
    void fetchSessions();
    void fetchCybos();
    void seedThreadCounts();
    void seedUserStatuses(wsId);
  } catch (err) {
    // Background reconnect reconcile — a failure leaves a stale pane until the
    // next sync, not a lost user action. Warn (no toast) per low-noise policy.
    console.warn("[reconcileWorkspacePanels] refetch failed", err);
  }
}

// Subscribe to EVERY workspace the user belongs to (not just the active one)
// and seed each one's unread counts. Without this the socket only hears the
// current workspace, so a DM / channel message in another workspace doesn't
// badge until you switch there. Called on connect and on reconnect (a fresh
// socket starts with no subscriptions). Fire-and-forget.
// BUG #2: seed the TWO independent unread signals from server truth.
//   • RED badge (notificationState): per-channel MENTION count + per-DM message
//     count (DMs always count, so their message count IS their badge).
//   • BOLD flag (unreadFlagState): channels that have ANY unread message
//     (counts > 0). DMs are not tracked in the flag store (their badge bolds).
// Backward-compatible: older relays omit `mentionCounts`, so channel badges fall
// back to {} (no red number from a plain unread) — still correct for BUG #2.
function seedUnreadSignals(
  workspaceId: string,
  u: {
    counts: Record<string, number>;
    mentionCounts?: Record<string, number>;
    dmCounts: Record<string, number>;
  },
): void {
  const mentionCounts = u.mentionCounts ?? {};
  notificationState.seedCounts(workspaceId, { ...mentionCounts, ...u.dmCounts });
  const unreadChannelIds = Object.entries(u.counts)
    .filter(([, n]) => n > 0)
    .map(([id]) => id);
  unreadFlagState.seed(workspaceId, unreadChannelIds);
}

function subscribeAndSeedAllWorkspaces(): void {
  for (const ws of workspaceState.list) {
    // intentional: fire-and-forget background subscribe; selectWorkspace surfaces a real subscribe failure for the active one.
    client.subscribeWorkspace(ws.id).catch(() => {});
    // Cross-workspace notification prefs: load + MERGE each workspace's per-scope
    // prefs up front. notifPrefsState was previously seeded ONLY for the active
    // workspace, so a plain (non-mention) message arriving in a DIFFERENT
    // workspace's muted / mentions-only channel had an UNKNOWN pref and the
    // policy fell through to notify — firing an OS banner the user had muted.
    // Loading every workspace's prefs (keyed by globally-unique scope id) lets
    // decideChannel apply the REAL pref to cross-workspace messages. Background +
    // best-effort: selectWorkspace re-fetches and merges the active workspace's
    // prefs authoritatively, so a miss here just delays a background pref.
    void (async () => {
      try {
        const r = await client.fetchNotificationPrefs(ws.id);
        notifPrefsState.merge(r.prefs);
      } catch {
        // intentional: background cross-workspace pref seed; a miss is recovered on workspace switch (selectWorkspace merges that workspace's prefs).
      }
    })();
    client
      .fetchUnread(ws.id)
      .then((u) => {
        seedUnreadSignals(ws.id, u);
        // Re-freeze the divider cursors from server truth — but only for the
        // active workspace, since readCursorState is a single global map and a
        // background workspace must not clobber the open conversation's cursor.
        if (workspaceState.current?.id === ws.id) {
          readCursorState.seed({ reads: u.reads, dmReads: u.dmReads });
        }
        // Belt-and-braces: push the freshly-seeded total to the dock/title
        // imperatively, so the badge appears on connect/reconnect even if the
        // reactive effect hasn't (re)run yet.
        pushUnreadIndicators(notificationState.globalTotal);
        return;
      })
      // intentional: background per-workspace unread seed for badges; a miss just delays a badge until the next sync.
      .catch(() => {});
  }
}

// Re-seed every open agent session's timeline from the server on reconnect, so
// items streamed while the socket was down are recovered. The timeline has no
// per-entry cursor, so we re-fetch the latest page and hydrateFromTimeline
// rebuilds the stream from server truth; the resumed live stream appends after.
// `daemonId` scopes the catch-up to one daemon's open sessions (used by the
// owner-daemon reconnect self-heal, #518) — omit it (client reconnect) to
// re-hydrate every open session.
async function catchUpAgentTimelines(wsId: string, daemonId?: string): Promise<void> {
  const openAgentIds = Array.from(agentStreamState.streams.keys()).filter(
    (id) => agentStreamState.getEntries(id).length > 0,
  );
  const agentIds = agentIdsForDaemonCatchUp(openAgentIds, workspaceState.agents, daemonId);
  await Promise.all(
    agentIds.map(async (agentId) => {
      try {
        const { items } = await client.fetchAgentTimeline(wsId, agentId);
        if (workspaceState.current?.id !== wsId) return;
        // The session may have been closed/archived while the fetch was in flight —
        // don't resurrect a deleted stream (hydrateFromTimeline would recreate it).
        if (!agentStreamState.streams.has(agentId)) return;
        agentStreamState.hydrateFromTimeline(agentId, items);
      } catch {
        // agent gone / server may not support it — leave the stream as-is
      }
    }),
  );
}

// Re-assert foreground/background on a freshly-(re)connected socket. The relay's
// `backgrounded` flag is CONNECTION-scoped, so a new GuestConnection defaults to
// active — without this, a reconnect while backgrounded would make the relay think
// we're active and suppress push. Called right after auth on every connect path.
function syncAppStateToRelay(): void {
  if (typeof document === "undefined") return;
  client.setAppState(document.visibilityState === "hidden" ? "background" : "active");
}

async function handleReconnect(): Promise<void> {
  try {
    const authResp = await client.authenticate();
    // Socket is authenticated again — now it's safe to replay queued sends
    // (the relay drops sends that arrive before cyborg:auth).
    flushSendOutbox();
    void registerMobilePush(client);
    syncAppStateToRelay();
    authState.user = authResp.user;
    subscribeAndSeedAllWorkspaces();

    if (!workspaceState.current) return;
    const wsId = workspaceState.current.id;

    // Catch up the active channel's delta. Drain even when lastSeq===0: a fresh
    // session (or one whose active view never loaded) still needs the snapshot,
    // and applyChannelSyncPage no-ops when there's no active channel — so the old
    // `if (seq > 0)` guard only ever skipped legitimate catch-up.
    await drainSync(wsId, channelState.lastSeq);
    await reconcileWorkspacePanels(wsId);

    // Catch up the Activity feed (mentions / DM-received items) from server truth:
    // its broadcasts were missed while the socket was down.
    void seedActivityFromServer(wsId, workspaceState.channels, [], authState.user?.id);

    // Catch up every open agent session's timeline — agent stream events that
    // arrived while disconnected are otherwise lost (the live stream only resumes
    // from "now" after re-subscribe). Fire-and-forget: agent timelines are
    // independent and can be slow, so don't block the active channel/DM restore
    // behind them (each fetch is workspace-guarded internally).
    void catchUpAgentTimelines(wsId);

    // Catch up the task board. fetchTasks only runs on workspace-open, and task
    // mutations aren't replayed by drainSync, so tasks changed while the socket
    // was down would otherwise stay stale until the workspace is re-opened.
    // Fire-and-forget + workspace-guarded so a slow/failed fetch can't block or
    // clobber a since-switched workspace.
    void (async () => {
      try {
        const tasks = await client.fetchTasks(wsId);
        if (workspaceState.current?.id === wsId) workspaceState.tasks = tasks;
      } catch {
        // best-effort; live task_* broadcasts resume after re-subscribe
      }
    })();

    // Self-heal: if the active channel never loaded (e.g. the initial fetch failed
    // during a not-OPEN window before auth completed), re-fetch it now that we're
    // authenticated.
    if (channelState.activeId && channelState.messages.length === 0) {
      await selectChannel(channelState.activeId);
    }
    // DM resync (Caveat #24): drainSync only reconciles the active CHANNEL, so
    // the open DM must be reconciled here too — both the empty self-heal case
    // AND the already-populated case (a DM message could have arrived while the
    // socket was a backgrounded zombie). Re-fetch the recent window and merge:
    // mergeServer() dedups by message id and reconciles optimistic local- rows,
    // so re-running it on a populated DM only splices in what we missed. Show
    // the spinner only when the DM was empty (the self-heal case); a silent
    // background reconcile must not flash a loader over messages already on
    // screen.
    if (dmState.activePeerId) {
      const peerId = dmState.activePeerId;
      const wasEmpty = dmState.messages.length === 0;
      // Show the spinner only when the DM was empty (the self-heal case); a silent
      // background reconcile must not flash a loader over messages already on
      // screen. catchUpDm seq-drains a populated DM (#500) or fetches the latest
      // window when cold.
      if (wasEmpty) dmState.loading = true;
      try {
        await catchUpDm(wsId, peerId);
      } finally {
        if (wasEmpty && dmState.activePeerId === peerId) dmState.loading = false;
      }
    }
  } catch (e) {
    // Mid-session token-expiry → logout (Caveat #25). The re-auth above
    // (client.authenticate()) is the only step that can fail with the relay's
    // "unauthorized" response; everything after it is a best-effort resync that
    // must NOT trigger a logout. Classify exactly like connectToServer: a bad/
    // expired token (message matches /unauthor/i) clears the session and routes
    // to /login; anything else is a transient relay/network failure that we
    // swallow so the existing backoff loop keeps retrying (prior behavior).
    const msg = e instanceof Error ? e.message : String(e);
    if (/unauthor/i.test(msg)) {
      clearSavedSession();
      void goto("/login");
    }
    // else: transient — will retry on the next reconnect.
  }
}

// Render an OS banner. No focus/suppression logic here — the notify policy
// (shouldNotifyFor) already decided this should fire. Inside Electron we route
// to the main process for a native notification (richer + deep-link click,
// like the original app); in a plain browser we fall back to the in-tab
// Notification API.
function renderOSNotification(title: string, body: string, url?: string): void {
  if (typeof window === "undefined") return;
  // Caveat #30: on the iOS shell, FCM-over-APNs delivers the banner server-side.
  // Firing a local notification here too would double-banner — explicitly no-op.
  if (isTauriIOS()) return;
  const bridge = (
    window as Window & {
      cyborg7Desktop?: { notify?: (o: { title: string; body: string; url?: string }) => void };
    }
  ).cyborg7Desktop;
  if (bridge?.notify) {
    bridge.notify({ title, body, url });
    return;
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, { body, icon: "/favicon.png", tag: url ?? title });
    if (url) {
      n.addEventListener("click", () => {
        window.focus();
        void goto(url);
        n.close();
      });
    }
  } catch {
    // notification construction can throw on some platforms — best-effort
  }
}

// Client-side activity-feed entry for an @mention (superseded by the server
// activity feed in P7b; kept until the ActivityPane is rewired). The OS
// notification decision is handled separately by the notify policy (P9).
function handleIncomingMention(msg: import("../core/types.js").Message, preview: string): void {
  const channel = workspaceState.channels.find((c) => c.id === msg.channelId);
  // Structured activity-feed entry (cyborg7's addMention API). The OS
  // notification decision is handled separately by the P9 policy below
  // (maybeFireChannelBanner), so this stays feed-only — no direct fire.
  activityState.addMention({
    sourceId: msg.id,
    actorName: msg.fromName ?? msg.fromId,
    actorId: msg.fromId,
    actorType: msg.fromType,
    preview,
    channelId: msg.channelId,
    channelName: channel?.name ?? null,
    createdAt: new Date(msg.createdAt).toISOString(),
  });
}

// P2 Item 9 (server-authoritative): seed the Activity feed + rail unread badge
// from the relay's cyborg:fetch_activity response — the authoritative
// activity_events the relay persists (channel mentions + thread replies) plus a
// server-counted unread total. This is the canonical seed; the old ~200-message
// reconstruction under-counted (it could only see mentions in that window). If
// the relay doesn't support the activity feed yet, fall back to backfilling
// recent @mentions from the workspace-activity messages so the feed isn't empty
// (legacy behavior — unread then derives from the seeded items, not the server).
async function seedActivityFromServer(
  workspaceId: string,
  channels: Channel[],
  fallbackMessages: import("../core/types.js").Message[],
  myId: string | undefined,
): Promise<void> {
  try {
    const { items, unread } = await client.fetchActivity(workspaceId, { limit: 100 });
    if (activeWorkspaceSelection !== workspaceId) return;
    activityState.seedFromServer(items as unknown as ServerActivityItem[], unread);
  } catch {
    // Older relay without the activity feed — fall back to the recent-message
    // @mention backfill (idempotent, keyed by message id). Leaves _serverUnread
    // null so the badge falls back to counting unread items.
    if (activeWorkspaceSelection !== workspaceId || !myId || fallbackMessages.length === 0) return;
    const channelName = new Map(channels.map((c) => [c.id, c.name]));
    const backfill = fallbackMessages
      .filter((m) => m.fromId !== myId && m.fromType !== "system" && m.mentions?.includes(myId))
      .map((m) => ({
        sourceId: m.id,
        actorName: m.fromName ?? m.fromId,
        actorId: m.fromId,
        actorType: m.fromType,
        preview: typeof m.text === "string" ? m.text.slice(0, 120) : "",
        channelId: m.channelId,
        channelName: m.channelId ? (channelName.get(m.channelId) ?? null) : null,
        createdAt: new Date(m.createdAt).toISOString(),
      }));
    if (backfill.length > 0) activityState.addMentions(backfill);
  }
}

// Build the policy context from current state (P9).
function notifyContext(): NotifyContext {
  return {
    currentUserId: authState.user?.id,
    currentUserName: authState.user?.name ?? authState.user?.email?.split("@")[0],
    activeChannelId: channelState.activeId,
    viewingDmHumanUserId: dmState.activePeerId,
    viewingDmAgentId: activeAgentIdFromUrl(),
    channelNotifPrefs: notifPrefsState.prefs as Record<string, NotificationPref>,
    // DM + agent-DM prefs live in the SAME per-scope map (keyed by the peer/agent
    // id, which is the DM's scopeId). These were hardcoded empty, so muting a DM
    // had no effect even though the policy honors it — wire them through so a
    // muted DM actually stops notifying.
    humanDmNotifPrefs: notifPrefsState.prefs as Record<string, "all" | "muted">,
    agentDmNotifPrefs: notifPrefsState.prefs as Record<string, "all" | "muted">,
    // Client-only gates (this device): DND, custom highlight keywords, and the
    // per-channel ignore-broadcast flags. All default off so prior behavior is
    // unchanged when the user hasn't touched them.
    dndActive: notifyClientPrefsState.dnd,
    highlightKeywords: notifyClientPrefsState.keywords,
    channelIgnoreBroadcast: notifyClientPrefsState.ignoreBroadcast,
  };
}

client.on("pin_message", (p) => {
  if (p.channelId === channelState.activeId) {
    channelState.setPinned(p.messageId, p.pinnedAt, p.pinnedBy);
  }
  // Mirror the pin state into the cache (patch-by-id, surface-agnostic). No-op
  // off-iOS.
  if (cacheOn()) void cache.cachePinMessage(p.messageId, p.pinnedAt, p.pinnedBy);
});

// A personal save toggled on another of my devices (#609): reconcile the Saved
// view + the per-message bookmark glyph. Per-user broadcast, so this only ever
// carries my own saves. We don't have the full message row here on a remote save,
// so a remote ADD just flips the id (the Saved view refetches on next open); a
// remote REMOVE drops the row immediately.
client.on("save_message", (p) => {
  savedState.apply(p.messageId, p.saved);
});

// Cross-device read sync: another device of mine marked a channel or DM read.
// Clear the badge and MONOTONICALLY advance the read-cursor (Item 12). The
// frozen `unreadCursor` on the OPEN conversation is deliberately NOT touched —
// the divider stays frozen for the visit.
client.on("read", (p) => {
  if (!p.workspaceId) return;
  if (p.dmPeerId) {
    notificationState.clear(p.workspaceId, p.dmPeerId);
    readCursorState.advanceDm(p.dmPeerId, p.lastReadAt);
  } else if (p.channelId) {
    notificationState.clear(p.workspaceId, p.channelId);
    // BUG #2: clear BOTH signals — the red mention count AND the bold unread flag.
    unreadFlagState.clearUnread(p.workspaceId, p.channelId);
    readCursorState.advanceChannel(p.channelId, p.lastReadAt);
  }
});

client.on("notification_pref_changed", (p) => {
  notifPrefsState.set(p.scopeId, p.preference);
});

// Server-side draft sync (#610): wire the WS transport into the drafts store so
// edits debounce-write to the server and clears delete server-side. Best-effort:
// send() throws "Not connected" on a closed socket, so swallow it — a missed
// draft write is recovered on the next edit / workspace-load reconcile (drafts
// are lossy by nature; localStorage remains the instant cache regardless).
draftsState.bindSync({
  draftSet(workspaceId, scope, text, updatedAt) {
    try {
      client.draftSet(workspaceId, scope, text, updatedAt);
    } catch {
      // intentional: best-effort draft sync; recovered on next edit / load reconcile.
    }
  },
  draftClear(workspaceId, scope) {
    try {
      client.draftClear(workspaceId, scope);
    } catch {
      // intentional: best-effort draft clear; the server row is harmless if it lingers and is overwritten on next set.
    }
  },
});

// A draft created/updated/cleared on the user's OTHER device → live-apply it here
// so an unfinished message follows them across devices in real time. Scoped to
// the active workspace (the store is keyed per active workspace's scope ids).
client.on("draft_changed", (p) => {
  if (workspaceState.current?.id !== p.workspaceId) return;
  draftsState.applyRemoteChange(p.scope, p.text, p.updatedAt);
});

// ─── Threads (CRT): aggregate badge + list maintained by WS deltas ──────────
client.on("thread_updated", (e) => {
  threadsState.applyDelta({
    rootId: e.rootId,
    newReplies: e.unread_replies,
    newMentions: e.unread_mentions,
    prevReplies: e.previous_unread_replies,
    prevMentions: e.previous_unread_mentions,
  });
});
client.on("thread_read_changed", (e) => {
  threadsState.applyDelta({
    rootId: e.rootId,
    newReplies: e.unread_replies,
    newMentions: e.unread_mentions,
    prevReplies: e.previous_unread_replies,
    prevMentions: e.previous_unread_mentions,
  });
});
client.on("thread_follow_changed", (e) => {
  if (!e.following) {
    threadsState.list = threadsState.list.filter((t) => t.root?.id !== e.rootId);
  }
});

// #607: a scheduled send FAILED at fire time — flip its row to failed live so the
// open Scheduled pane updates without a reload. (A successful send arrives as a
// normal channel/dm broadcast; a re-list picks up its processedAt.)
client.on("schedule_message_failed", (row) => {
  scheduledMessagesState.applyFailed(row);
});

// #619: a recurring schedule was mutated (by another client, or the runner
// deactivating a one-shot). Patch the Tasks-tab board live. The requesting
// client's own ack is resolved by requestId and patched there too; this broadcast
// keeps OTHER clients in sync. Cast the loose broadcast record to the typed
// payload — the structural fields (ok/op/scheduleId/schedule) line up.
client.on("schedule_mutated", (p) => {
  schedulesState.applyMutation(p as Parameters<typeof schedulesState.applyMutation>[0]);
});

export async function fetchThreads(unreadOnly = false): Promise<void> {
  if (!workspaceState.current) return;
  const wsId = workspaceState.current.id;
  threadsState.loading = true;
  try {
    const { threads } = await client.fetchThreads(wsId, { unreadOnly });
    if (workspaceState.current?.id === wsId) threadsState.setList(threads);
  } catch {
    // server may not support threads yet
  } finally {
    threadsState.loading = false;
  }
}

async function seedThreadCounts(): Promise<void> {
  if (!workspaceState.current) return;
  const wsId = workspaceState.current.id;
  try {
    const c = await client.threadCounts(wsId);
    if (workspaceState.current?.id === wsId) threadsState.seedCounts(c);
  } catch {
    // intentional: background thread-count seed; a miss just leaves counts to
    // arrive via live events. No user action, no surface.
  }
}

// P2 Item 6: fetch all co-members' custom statuses for a workspace and seed the
// shared map. Called on workspace open + reconnect. Fire-and-forget.
async function seedUserStatuses(wsId: string): Promise<void> {
  try {
    const statuses = await client.fetchUserStatuses(wsId);
    if (workspaceState.current?.id === wsId) workspaceUserStatusesState.seed(statuses);
  } catch {
    // server may not support user statuses yet
  }
}

export function markThreadRead(rootId: string): void {
  if (!workspaceState.current) return;
  client.markThreadRead(workspaceState.current.id, rootId);
  // Optimistic: zero this thread's unread locally (the broadcast confirms it).
  const t = threadsState.list.find((x) => x.root?.id === rootId);
  if (t && (t.unreadReplies > 0 || t.unreadMentions > 0)) {
    threadsState.applyDelta({
      rootId,
      newReplies: 0,
      newMentions: 0,
      prevReplies: t.unreadReplies,
      prevMentions: t.unreadMentions,
    });
  }
}

// Mark a thread unread from the given reply (#7): rewind the server read cursor
// to just before `beforeAt` (the reply's createdAt ms) so it and later replies
// count as unread again, and rewind the frozen per-thread divider cursor so the
// "New replies" line reappears above that reply on the next open.
export function markThreadUnread(rootId: string, beforeAt: number): void {
  if (!workspaceState.current) return;
  client.markThreadUnread(workspaceState.current.id, rootId, beforeAt);
  // Move the frozen divider cursor back to just-before the reply (mirrors the
  // server's last_viewed = beforeAt - 1ms) so the divider lands above it.
  threadsState.setPerThreadLastViewed(rootId, beforeAt - 1);
}

export function followThread(rootId: string, following: boolean): void {
  if (!workspaceState.current) return;
  client.followThread(workspaceState.current.id, rootId, following);
}

export function setChannelNotificationPref(
  channelId: string,
  preference: "all" | "mentions_only" | "muted",
): void {
  if (!workspaceState.current) return;
  notifPrefsState.set(channelId, preference); // optimistic
  // intentional: optimistic notification-pref persist; a failed write resolves itself on the next prefs fetch (no data loss).
  void client.setNotificationPref(workspaceState.current.id, channelId, preference).catch(() => {});
}

// Reflect a per-channel slash model override in the local store right after the
// set-RPC resolves. Without this the channel in workspaceState keeps its stale
// (cached) slashCommandModel, so reopening the channel's AI tab reseeds from null
// and the override looks like it "didn't save" — even though PG persisted it.
export function applyChannelSlashModel(
  channelId: string,
  model: { provider: string; model: string } | null,
): void {
  workspaceState.channels = workspaceState.channels.map((c) =>
    c.id === channelId ? { ...c, slashCommandModel: model } : c,
  );
}

// Reflect the per-channel auto-tasks (watcher) opt-in switch in the local store
// right after the set-RPC resolves, so reopening the channel's AI tab reseeds
// from the saved value instead of the stale cached one.
export function applyChannelAutoTasks(channelId: string, enabled: boolean): void {
  workspaceState.channels = workspaceState.channels.map((c) =>
    c.id === channelId ? { ...c, autoTasksEnabled: enabled } : c,
  );
}

// P2 Item 6: set MY custom status. Updates local state optimistically and syncs
// to the relay so co-members see the emoji (broadcast) and it persists cross-
// device. expiresAt is an ISO string locally; the relay wants epoch ms.
export function setMyStatus(
  emoji: string | null,
  text: string | null,
  expiresAt: string | null,
): void {
  userStatusState.setStatus(emoji, text, expiresAt);
  const ws = workspaceState.current;
  if (!ws) return;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : null;
  client.setUserStatus(ws.id, emoji, text, expiresMs);
}

// The caller's OWN manual-away flag. The relay re-broadcasts presence (incl.
// awayUserIds) to co-members but NOT back to the sender, so there's no server
// reader for self-away on the client — we track it here so every surface (the
// Settings "Away" toggle, etc.) shows a consistent state across navigations
// within the session, instead of resetting to "Off" on each mount.
export const selfPresenceState = $state({ away: false });

// P2 Item 6: toggle the caller's manual "away" presence so co-members see it.
export function setMyPresence(away: boolean): void {
  selfPresenceState.away = away;
  client.setPresence(away);
}

// Last-viewed channel persistence (v1 "activitySession", Sidebar.tsx:859).
// Per-workspace key so each workspace restores its own last channel on reload.
function lastChannelKey(workspaceId: string): string {
  return `cyborg7:lastChannel:${workspaceId}`;
}

export function rememberLastChannel(workspaceId: string, channelId: string): void {
  try {
    localStorage.setItem(lastChannelKey(workspaceId), channelId);
  } catch {
    // intentional: best-effort last-channel persistence; storage-disabled just
    // means we don't restore on reload.
  }
}

export function getLastChannel(workspaceId: string): string | null {
  try {
    return localStorage.getItem(lastChannelKey(workspaceId));
  } catch {
    return null;
  }
}

// Fire the OS banner for an incoming channel message if the policy allows.
function maybeFireChannelBanner(
  msg: import("../core/types.js").Message,
  o: { mentioned: boolean; preview: string; msgWsId?: string },
): void {
  const decision = shouldNotifyFor(
    {
      kind: "channel_message",
      channelId: msg.channelId!,
      // A webhook/automation card carries the creator's user id, but it isn't the
      // user's own send — drop it from the policy's self-check so it still notifies.
      senderId: msg.source === "webhook" ? undefined : msg.fromId,
      text: typeof msg.text === "string" ? msg.text : "",
    },
    notifyContext(),
  );
  if (!decision.notify) return;
  const channel = workspaceState.channels.find((c) => c.id === msg.channelId);
  const who = msg.fromName ?? "Someone";
  const title = o.mentioned
    ? `${who} mentioned you${channel?.name ? ` in #${channel.name}` : ""}`
    : `#${channel?.name ?? "channel"}`;
  const url = o.msgWsId ? `/workspace/${o.msgWsId}/channel/${msg.channelId}` : undefined;
  // Per-channel sound (client-side). "default" falls back to the bundled sound,
  // so untouched channels behave exactly as before.
  playNamedSound(notifyClientPrefsState.soundFor(msg.channelId!));
  renderOSNotification(title, o.mentioned ? o.preview : `${who}: ${o.preview}`, url);
}

// Fire the OS banner + sound for an incoming human DM if the policy allows.
// DMs notify by default (Slack/Mattermost parity) — suppressed only when muted
// or when focused on that exact conversation (both handled by the policy).
function maybeFireDmBanner(
  msg: import("../core/types.js").Message,
  peerId: string,
  preview: string,
  wsId: string | undefined,
): void {
  const decision = shouldNotifyFor(
    {
      kind: "dm_human",
      fromUserId: msg.fromId,
      text: typeof msg.text === "string" ? msg.text : "",
    },
    notifyContext(),
  );
  if (!decision.notify) return;
  const url = wsId ? `/workspace/${wsId}/dm/${peerId}` : undefined;
  playNotificationSound();
  renderOSNotification(msg.fromName ?? "Direct message", preview, url);
}

// Badge increment + activity + OS-notification for an incoming channel message
// True only when the app window actually has OS focus. `visibilityState` alone
// is not enough: a window can be "visible" yet unfocused (another app on top),
// in which case incoming messages to the open conversation SHOULD still badge —
// the user isn't looking. Mirrors Mattermost's window-focus check.
function windowFocused(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState !== "visible") return false;
  // iOS WKWebView: document.hasFocus() is unreliable — it frequently returns
  // false even when the app is foreground and the chat is on-screen. That made
  // a message arriving in the chat you're VIEWING still get marked unread, so
  // opening it then leaving left it bold ("unread won't clear"). On the iOS
  // shell there is no separate window-focus concept: visible == focused. Mirrors
  // v1's mobile foreground detection (document.visibilityState). Web/desktop keep
  // the hasFocus() check — there you can see a tab without it being focused.
  return isTauriIOS() ? true : document.hasFocus();
}

// (own messages excluded). Extracted from the handler to keep it simple.
// oxlint-disable-next-line eslint/complexity -- mention/badge/banner gating is one decision tree
function notifyForIncoming(msg: import("../core/types.js").Message): void {
  const myId = authState.user?.id;
  // Webhook/CI cards are injected under the creator's user id, but they're an
  // automation — NOT the user's own typing — so they must not be echo-suppressed
  // like a self-send (otherwise whoever created the webhook never gets a
  // sound/unread for its cards, even with "all messages" notifications on).
  const isAutomation = msg.source === "webhook";
  // System messages ("X joined the channel") render inline but never badge/notify.
  if (
    !myId ||
    (msg.fromId === myId && !isAutomation) ||
    !msg.channelId ||
    msg.fromType === "system"
  )
    return;
  const preview = typeof msg.text === "string" ? msg.text.slice(0, 120) : "New message";
  const currentWsId = workspaceState.current?.id;
  const msgWsId = msg.workspaceId ?? currentWsId;
  // Track channel recency in the same activity store DMs use (keyed by id), so
  // the unified mobile inbox can sort channels + DMs together by last activity.
  if (msgWsId && msg.channelId) dmActivityState.bump(msgWsId, msg.channelId, msg.createdAt);
  // Active = viewing this channel, OR (for a channel-bound agent's reply)
  // viewing that agent's page — in both cases with the window actually focused.
  const viewingThisAgent = msg.fromType === "agent" && activeAgentIdFromUrl() === msg.fromId;
  const isActive =
    windowFocused() &&
    ((msg.channelId === channelState.activeId && msgWsId === currentWsId) || viewingThisAgent);

  // BUG #2: keep the BOLD signal (unread flag) and the RED NUMBER (mention count)
  // independent, matching Mattermost + v1 (Sidebar.tsx unreadChannels vs
  // mentionCounts). A plain message bolds the channel but must NOT bump the red
  // badge — only a real mention does. Compute `mentioned` FIRST so it gates both
  // the badge and the OS banner. The mention test covers @everyone/@here/@channel
  // and a `@name` word-boundary match (hasMention), plus the explicit mentions[].
  const myName = authState.user?.name ?? authState.user?.email?.split("@")[0];
  const text = typeof msg.text === "string" ? msg.text : "";
  const mentioned = (msg.mentions?.includes(myId) ?? false) || hasMention(text, myName);
  const pref = notifPrefsState.get(msg.channelId) as NotificationPref;

  if (msgWsId && !isActive && pref !== "muted") {
    const isCurrentWs = msgWsId === currentWsId;
    if (!isCurrentWs || workspaceState.channels.some((c) => c.id === msg.channelId)) {
      // Any non-muted unread → BOLD the channel name.
      unreadFlagState.markUnread(msgWsId, msg.channelId);
      // Only a mention → bump the RED NUMBER.
      if (mentioned) notificationState.increment(msgWsId, msg.channelId);
    }
  }

  if (mentioned) handleIncomingMention(msg, preview);
  maybeFireChannelBanner(msg, { mentioned, preview, msgWsId });
}

// Author-only ephemeral notice about a cybo @-mention that couldn't invoke
// (not a channel member / no runnable daemon / spawn failed). Rendered as a
// LOCAL system note pinned at the bottom of the channel (the #366/#210
// pattern: seq:0, ~30s TTL, never persisted). Other members never see it.
client.on("cybo_mention_notice", (p) => {
  if (p.toUserId !== authState.user?.id) return;
  if (p.channelId !== channelState.activeId) return;
  const noteId = `cybo-mention-note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  channelState.addMessage({
    id: noteId,
    channelId: p.channelId,
    fromId: "system",
    fromType: "system",
    text: p.text,
    seq: 0,
    createdAt: Date.now(),
  });
  setTimeout(() => channelState.removeMessage(noteId), 30_000);
});

// /catchup digest arrives ephemerally (scoped to this user by the relay). Fill
// the sheet — open it if the digest came from the composer path (where the sheet
// wasn't pre-opened). Never touches the channel: a personal digest, rendered here.
client.on("catchup_result", (p) => {
  if (p.toUserId !== authState.user?.id) return;
  catchupState.resolve(p);
});

client.on("channel_message", (msg) => {
  if (msg.parentId) {
    // Thread reply: never in the main list. Bump the parent indicator + feed
    // the thread panel if it's open.
    if (msg.channelId === channelState.activeId) {
      channelState.bumpReplyCount(msg.parentId, msg.createdAt);
    }
    threadState.receiveReply(msg);
    // #515: the sender's message landed → drop their "is typing…" in the thread
    // immediately instead of waiting out the 5s expiry (no-op if not the open
    // thread / not typing).
    threadState.clearTypingFor(msg.fromId);
  } else if (msg.channelId === channelState.activeId) {
    channelState.addMessage(msg);
    // #515: clear the sender's channel typing indicator now their message is on
    // screen (no ≤5s overlap). Own messages never have a typing entry → no-op.
    channelState.clearTypingFor(msg.fromId);
    // My own message just echoed back and collapsed its optimistic row — cancel
    // its failure watchdog so a slow-but-successful send never shows as failed,
    // and drop its persisted outbox record (#502) so a reload never re-sends it.
    if (msg.fromId === authState.user?.id) {
      sweepReconciledWatchdogs("channel");
      dequeueOutbox(msg.clientMsgId);
    }
    // #516: an incoming message in the focused active channel advances the read
    // cursor live (own echoes already imply read). Throttled + focus-gated.
    else if (msg.fromType !== "system") scheduleLiveReadAdvance();
  }
  // Keep the local cache in sync (iOS shell only). Upsert the live message into
  // its channel scope so a cold revisit is fresh; fire-and-forget, no-op off-iOS.
  cacheSyncIncoming(msg);
  // Badge + activity-feed + policy-based OS banner (P9). System messages
  // ("X joined the channel") show inline but never badge/notify — that guard
  // lives inside notifyForIncoming.
  notifyForIncoming(msg);
});

// A DM from the peer (not my own echo): badge it unless I'm focused on that exact
// conversation, and surface it in the activity feed. Extracted to keep the `dm`
// handler under the complexity budget.
function handleIncomingDmFromPeer(msg: import("../core/types.js").Message, peerId: string): void {
  const wsId = msg.workspaceId ?? workspaceState.current?.id;
  const isActiveDm =
    windowFocused() && peerId === dmState.activePeerId && wsId === workspaceState.current?.id;
  if (wsId && !isActiveDm) {
    notificationState.increment(wsId, peerId);
  }
  // #17: surface this peer at the top of the DM list (most-recent-first).
  if (wsId) dmActivityState.bump(wsId, peerId, msg.createdAt);
  const preview = typeof msg.text === "string" ? msg.text.slice(0, 120) : "Direct message";
  // Only surface in the Activity feed when the DM belongs to the workspace
  // currently open. The feed is per-workspace (ActivityItem carries no
  // workspaceId and seedFromServer replaces it per workspace), so an unscoped
  // push leaks another workspace's DM into the current feed (the "Activity shows
  // a message from another workspace" bug). The cross-workspace unread badge
  // above stays unconditional so other workspaces still light up in the rail.
  if (wsId === workspaceState.current?.id) {
    activityState.push(
      "dm_received",
      msg.fromName ?? msg.fromId,
      msg.fromId,
      msg.fromType,
      preview,
    );
  }
  // Fire an OS banner + sound for the DM (channels only did this for @mentions).
  maybeFireDmBanner(msg, peerId, preview, wsId);
}

// The agent currently open in the UI (route .../agent/:agentId). Read from the
// URL at event time — no reactive state needed for an event-handler decision.
function activeAgentIdFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/\/agent\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Fire the OS banner + sound for an agent's DM reply (dm_agent policy: notify by
// default unless muted or focused on that agent's conversation).
function maybeFireAgentDmBanner(
  msg: import("../core/types.js").Message,
  agentId: string,
  preview: string,
  wsId: string | undefined,
): void {
  const decision = shouldNotifyFor(
    {
      kind: "dm_agent",
      remoteAgentId: agentId,
      text: typeof msg.text === "string" ? msg.text : "",
    },
    notifyContext(),
  );
  if (!decision.notify) return;
  const url = wsId ? `/workspace/${wsId}/agent/${agentId}` : undefined;
  playNotificationSound();
  renderOSNotification(msg.fromName ?? "Agent", preview, url);
}

// An agent reply arrives as a dm_broadcast with fromType "agent". Badge it keyed
// by agentId (agents live on /agent/:id, not the DM route) unless focused on that
// agent's page, and fire a notification — Paseo-style red-badge parity.
function handleIncomingAgentDm(msg: import("../core/types.js").Message, agentId: string): void {
  const wsId = msg.workspaceId ?? workspaceState.current?.id;
  const isActive =
    windowFocused() && agentId === activeAgentIdFromUrl() && wsId === workspaceState.current?.id;
  if (wsId && !isActive) {
    notificationState.increment(wsId, agentId);
  }
  // #17: agent DMs are keyed by agentId — bump so an agent reply surfaces it.
  if (wsId) dmActivityState.bump(wsId, agentId, msg.createdAt);
  const preview = typeof msg.text === "string" ? msg.text.slice(0, 120) : "Message";
  maybeFireAgentDmBanner(msg, agentId, preview, wsId);
}

client.on("dm", (msg) => {
  const myId = authState.user?.id;
  if (!myId) return;
  // The relay broadcasts DMs workspace-wide, so ignore any DM I'm not part of —
  // otherwise everyone gets a phantom badge (and a content leak) for other
  // people's conversations.
  if (msg.fromId !== myId && msg.toId !== myId) return;

  const peerId = msg.fromId === myId ? (msg.toId ?? null) : msg.fromId;
  // #515: an incoming DM from the peer means they stopped typing — clear their
  // SIDEBAR typing badge (keyed by the typing sender's id) now, instead of letting
  // it linger up to 5s. Own echoes are a no-op; covers both main-list and thread.
  if (msg.fromId !== myId) dmTypingState.clearFor(msg.fromId);
  if (msg.parentId) {
    // DM thread reply: never in the main DM list. Bump the root's footer (if the
    // root is in view) and feed the open thread panel — mirrors channel_message.
    if (peerId && peerId === dmState.activePeerId) {
      dmState.bumpReplyCount(msg.parentId, msg.createdAt);
    }
    threadState.receiveReply(msg);
    // #515: drop the sender's typing indicator in the open DM thread now their
    // reply is on screen (no-op if not the open thread / not typing).
    threadState.clearTypingFor(msg.fromId);
  } else if (peerId && peerId === dmState.activePeerId) {
    dmState.addMessage(msg);
    // #515: clear the sender's DM typing indicator now their message rendered.
    dmState.clearTypingFor(msg.fromId);
    // My own DM just echoed back and collapsed its optimistic row — cancel its
    // failure watchdog so a slow-but-successful send never shows as failed, and
    // drop its persisted outbox record (#502) so a reload never re-sends it.
    if (msg.fromId === myId) {
      sweepReconciledWatchdogs("dm");
      dequeueOutbox(msg.clientMsgId);
    }
    // #516: an incoming human DM in the focused active conversation advances the
    // read cursor live. Agent replies surface via /agent/:id (not the DM cursor),
    // so scope this to human DMs.
    else if (msg.fromType !== "agent") scheduleLiveReadAdvance();
  }
  // Keep the local cache in sync for HUMAN DMs (iOS shell only). Agent replies
  // arrive here with fromType "agent" but are surfaced via agentStreamState, not
  // selectDm — they have no DM cache scope, so don't pollute it. Fire-and-forget.
  if (msg.fromType !== "agent") cacheSyncIncoming(msg);
  if (msg.fromId !== myId && peerId) {
    if (msg.fromType === "agent") {
      handleIncomingAgentDm(msg, peerId);
    } else {
      handleIncomingDmFromPeer(msg, peerId);
    }
  }
});

client.on("typing", (event) => {
  const myId = authState.user?.id;
  // Never show your own typing back to yourself.
  if (event.fromId === myId) return;
  // Thread typing (#11 thread-typing): a parentId routes to the OPEN thread's
  // own indicator (bottom of ThreadPanel), not the channel/DM composer.
  if (event.parentId) {
    if (event.parentId === threadState.parentId) threadState.addTyping(event);
    return;
  }
  // DM typing: only react if it's addressed to me. Always feed the
  // workspace-scoped map so the SIDEBAR row animates even when this DM is not
  // the active view; if the DM IS open, also drive the in-conversation line.
  if (event.toId) {
    if (event.toId === myId) {
      dmTypingState.mark(event.fromId);
      if (event.fromId === dmState.activePeerId) {
        dmState.addTyping(event);
      }
    }
    return;
  }
  if (event.channelId === channelState.activeId) {
    channelState.addTyping(event);
  }
});

// When the window regains focus, the conversation the user is looking at counts
// as read — clear its badge (and sync read-state server-side for channels). This
// pairs with the focus-aware badge guards above: a message arriving while the
// window was unfocused badges even the open conversation, then clears here.
function clearActiveConversationBadge(): void {
  const ws = workspaceState.current;
  if (!ws) return;
  if (dmState.activePeerId) {
    notificationState.clear(ws.id, dmState.activePeerId);
    // Item 12: re-mark-read on focus (Mattermost markAsReadOnFocus) so a read on
    // another device while this tab was blurred reconciles. Advance the LOCAL
    // cursor monotonically; the frozen divider snapshot is untouched.
    client.markDmRead(ws.id, dmState.activePeerId);
    readCursorState.advanceDm(dmState.activePeerId, Date.now());
  }
  if (channelState.activeId) {
    notificationState.clear(ws.id, channelState.activeId);
    // BUG #2: clear BOTH the red mention count AND the bold unread flag.
    unreadFlagState.clearUnread(ws.id, channelState.activeId);
    client.markRead(ws.id, channelState.activeId);
    readCursorState.advanceChannel(channelState.activeId, Date.now());
  }
  const agentId = activeAgentIdFromUrl();
  if (agentId) notificationState.clear(ws.id, agentId);
}

// Clicking a sidebar item in an UNFOCUSED window fires the window `focus` event
// (on mousedown) BEFORE the click navigates (on mouseup → goto → selectChannel,
// which synchronously nulls dmState.activePeerId). Running clearActiveConversation
// Badge() synchronously on focus therefore marked the DM the user was LEAVING as
// read — users reported a DM's red badge vanishing just by clicking into the app
// or opening another channel without ever reading the DM. Defer the clear past the
// in-flight navigation and re-read the active conversation at fire time, so only
// the conversation the user actually lands on (and stays on) is marked read. A
// pure refocus (alt-tab back, no navigation) still clears the open conversation —
// just a frame later, which is imperceptible.
//
// The deferral is backed by cancellation, not just timing: selectChannel /
// selectDm / disconnectFromServer call cancelActiveConversationBadgeClear() up
// front, so a navigation away DEFUSES any pending clear regardless of how long
// the route takes to settle — the 250ms only ever fires for a pure refocus where
// the active conversation never changed.
let badgeClearTimer: ReturnType<typeof setTimeout> | null = null;
function cancelActiveConversationBadgeClear(): void {
  if (badgeClearTimer) {
    clearTimeout(badgeClearTimer);
    badgeClearTimer = null;
  }
}
function scheduleActiveConversationBadgeClear(): void {
  if (typeof window === "undefined") {
    clearActiveConversationBadge();
    return;
  }
  cancelActiveConversationBadgeClear();
  badgeClearTimer = setTimeout(() => {
    badgeClearTimer = null;
    clearActiveConversationBadge();
  }, 250);
}

// ─── Live read-cursor advance for the active+focused conversation (#516) ──────
// The read cursor previously only advanced on conversation OPEN and on
// focus/foreground — so sitting in a channel/DM reading a live stream left the
// server `lastReadAt` frozen until the next focus event. That caused (a) another
// device to keep showing the conversation unread while it's being read here (the
// read_broadcast cross-device sync never fired for live-arriving messages), and
// (b) a reconnect `fetchUnread` re-seed to resurrect a bold/unread state for a
// conversation the user was actively reading.
//
// This advances the cursor LIVE: when a message lands in the focused active
// conversation, (re-)mark it read — THROTTLED to once per window so a fast stream
// doesn't spam markRead. We reuse clearActiveConversationBadge(), which already
// does the full job for whatever conversation is active (markRead/markDmRead →
// relay read_broadcast → other devices, advance readCursorState, clear the local
// unread flag/count) and re-reads the active conversation at fire time, so a mid-
// debounce switch just marks the conversation the user actually landed on.
//
// BOUNDARY vs #514: this is the LOCAL live-advance only — best-effort, focus-gated
// client behavior that keeps `lastReadAt` moving and emits the existing
// read_broadcast. It does NOT change the server's read-state model; #514 is the
// separate server-authoritative reconcile of `last_viewed` on reconnect/focus +
// cross-device. They're complementary: #516 keeps the cursor live so #514's
// reseed (and other devices) don't see a stale conversation.
const LIVE_READ_ADVANCE_MS = 1_500;
let liveReadTimer: ReturnType<typeof setTimeout> | null = null;
// The conversation a pending advance was scheduled FOR. Captured so a timer that
// outlives a mid-window conversation switch doesn't mark the NEW conversation
// read (and so a switch reschedules cleanly for the conversation now in view).
let liveReadChannelId: string | null = null;
let liveReadPeerId: string | null = null;
function scheduleLiveReadAdvance(): void {
  if (typeof window === "undefined") return;
  // Gate on focus up front (don't mark read while backgrounded).
  if (!windowFocused()) return;
  const channelId = channelState.activeId;
  const peerId = dmState.activePeerId;
  // A pending advance from a DIFFERENT conversation is stale — drop it so this
  // message reschedules for the conversation actually in view.
  if (liveReadTimer && (channelId !== liveReadChannelId || peerId !== liveReadPeerId)) {
    clearTimeout(liveReadTimer);
    liveReadTimer = null;
  }
  // Coalesce: a burst of messages in the same conversation schedules ONE trailing
  // advance, not one per message.
  if (liveReadTimer) return;
  liveReadChannelId = channelId;
  liveReadPeerId = peerId;
  liveReadTimer = setTimeout(() => {
    liveReadTimer = null;
    // Fire only if still focused AND on the SAME conversation we scheduled for —
    // a switch during the window must not mark the new conversation read here
    // (it was already marked read on open).
    if (
      windowFocused() &&
      channelState.activeId === liveReadChannelId &&
      dmState.activePeerId === liveReadPeerId
    ) {
      clearActiveConversationBadge();
    }
  }, LIVE_READ_ADVANCE_MS);
}

// ─── Mobile/background reconnect + liveness (foreground hook) ─────────────────
// A mobile OS freezes the WebSocket while the app is backgrounded; on resume the
// socket can still read OPEN (a "zombie") so neither onclose nor the auto-
// reconnect fires and the UI silently stops receiving messages. Two defenses:
//   1. Foreground hook (here) — on visibility/online, probe liveness and force a
//      reconnect (or, if alive but away a while, resync the missed delta).
//   2. Periodic heartbeat (transport-level, inside SlackClient, #503) — pings
//      every 30s for the LIFE OF THE CONNECTION and tears down a half-open
//      socket so the backoff loop reconnects. It is NOT foreground-gated, so a
//      backgrounded-but-open desktop/web tab recovers too (previously the app
//      heartbeat below was paused on background and missed exactly that case).
//      On mobile the OS suspends the timer while backgrounded, so a frozen
//      socket is never pinged; this foreground hook covers resume.
//
// GATING: a half-open / zombie socket (proxy idle-timeout, VPN/NAT drop, sleep-
// wake, relay redeploy whose FIN never arrives) can read OPEN on EVERY platform,
// not just iOS — so neither `close` nor the auto-reconnect fires and the client
// sits "online to itself, offline to everyone else". The liveness PROBE + forced
// TEARDOWN therefore run on iOS + desktop + web (any platform with a `window`).
// The probe is a no-DB `cyborg:ping` round-trip (see probeConnection). The old
// iOS-only `iosLiveness()` gate was replaced by `livenessEnabled()` below;
// callers that still need the iOS-only branch (e.g. the local message cache,
// push) call `isTauriIOS()` directly.

// Whether the foreground reconnect probe should run on this surface. True for
// iOS + desktop + web — i.e. anywhere there's a `window`. The zombie-socket
// failure is not iOS-specific (see above), so the cheap no-DB ping guards every
// platform. SSR (no `window`) stays off.
function livenessEnabled(): boolean {
  return typeof window !== "undefined";
}
const FOREGROUND_RESYNC_AWAY_MS = 30_000;
// Timeout for the on-foreground liveness probe below. The PERIODIC heartbeat now
// lives transport-level inside SlackClient (#503), so the app layer keeps only
// the foreground resync probe — no app-side interval, no double-pinging.
const FOREGROUND_PROBE_TIMEOUT_MS = 10_000;
let lastActiveTimestamp = Date.now();

// Liveness probe: resolves true only if the socket round-trips within timeoutMs.
// Uses the lightweight `cyborg:ping` → `cyborg:pong` RPC (client.ping), which
// touches NO Postgres and needs NO workspace subscription. An error round-trip
// (e.g. an older relay that doesn't know cyborg:ping) still counts as alive
// (client.ping resolves true on any matching-requestId response), which keeps a
// half-open socket from being torn down just because the relay is old.
async function probeConnection(timeoutMs: number): Promise<boolean> {
  if (!client.connected) return false;
  return client.ping(timeoutMs);
}

async function onForeground(): Promise<void> {
  const awayMs = Date.now() - lastActiveTimestamp;
  lastActiveTimestamp = Date.now();
  // Sync the open conversation's read-state. This is the ONLY thing the old
  // visibilitychange/focus handler did, and it must keep running on every
  // platform (web/desktop/Android/iOS) — it's not a reconnect behavior change.
  // Deferred so a click that BOTH refocuses the window and navigates away can't
  // mark the conversation being left as read (see scheduleActiveConversationBadgeClear).
  scheduleActiveConversationBadgeClear();

  // Everything below is the zombie-socket recovery (liveness probe + forced
  // reconnect). It now runs on iOS + desktop + web — a half-open socket can read
  // OPEN on any platform without firing `close`, so the probe guards them all.
  // Only SSR (no `window`) is skipped.
  if (!livenessEnabled()) return;

  if (!client.connected) {
    client.forceReconnect();
    return;
  }
  const alive = await probeConnection(FOREGROUND_PROBE_TIMEOUT_MS);
  if (!alive) {
    client.forceReconnect();
    return;
  }
  // #671: user statuses expire server-side via a periodic sweep whose
  // `user_status_changed` clear a frozen WebView misses entirely (the OS suspends
  // the socket while backgrounded). Unlike the channel/DM delta below, a status
  // clear is silently-drifting state that the < 30s gate would leave stale on a
  // quick lock/unlock or app-switch. So re-fetch statuses on EVERY foreground (a
  // single cheap RPC; seed() already drops absentees), independent of awayMs.
  // Scoped to statuses only — the read-state/channel/DM resync stays gated below.
  const fgWsId = workspaceState.current?.id;
  if (fgWsId) void seedUserStatuses(fgWsId);
  // Socket is genuinely alive but we were away long enough that a broadcast
  // could have been missed mid-freeze — resync explicitly (handleReconnect
  // drains the workspace channel delta from channelState.lastSeq AND reconciles
  // the open DM by re-fetching + dedup-merging its recent window).
  // handleReconnect ALSO reseeds unread (subscribeAndSeedAllWorkspaces), so it
  // covers the badge reconcile on the ≥30s path.
  if (awayMs >= FOREGROUND_RESYNC_AWAY_MS) {
    await handleReconnect();
    return;
  }

  // #672: THE GAP — socket alive, away < 30s. Nothing above reseeded unread, so
  // a read elsewhere during a BRIEF background (or a read of a DIFFERENT
  // conversation than the one badged) leaves the stale PERSISTED badge. Reconcile
  // the authoritative unread snapshot now (seedCounts replaces the whole map, so
  // now-read entries drop; a genuine server unread SURVIVES). Coalesced +
  // no-swallow inside reconcileUnread. Scoped to unread/read-state only.
  await reconcileUnreadOnForeground();

  // THE AGENT-STREAM GAP (sibling of #672): on a BRIEF background (away < 30s)
  // the OS freezes the WebSocket, so `agent_stream` events the daemon emitted
  // mid-freeze are DROPPED — they're not replayed on an already-open socket, and
  // the ≥30s `handleReconnect` catch-up (which calls catchUpAgentTimelines) never
  // ran. For an INTERACTIVE Claude session that's mid-turn, the lost events
  // include the agent's reply and its `turn_completed`, so the stream freezes on
  // the old turn and the chat reads as "closed"/dead after a quick tab-switch or
  // a few seconds of inactivity. Re-hydrate the open agent timelines from server
  // truth now — the same recovery the reconnect path uses, extended to the
  // brief-foreground path the user actually hits. Fire-and-forget +
  // workspace-guarded internally; only re-hydrates streams that are already open
  // (so it never resurrects a closed/archived session). Mirrors the terminal
  // re-attach-on-tab-switch fix (#738).
  if (fgWsId) void catchUpAgentTimelines(fgWsId);
}

if (typeof window !== "undefined") {
  // `focus` runs the same foreground path as visibility/online. onForeground()
  // calls clearActiveConversationBadge() first (the old `focus` handler's only
  // job) and then — iOS-only — does the liveness probe + reconnect kick. Off-iOS
  // it is therefore behaviorally identical to the previous focus handler.
  window.addEventListener("focus", () => void onForeground());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Tell the relay we're active again so it resumes suppressing push to this
      // (now-foreground) device and delivers messages over the live socket.
      try {
        client.setAppState("active");
      } catch {
        // intentional: fire-and-forget foreground signal to the relay; reconnect re-asserts.
      }
      void onForeground();
    } else {
      // Going to the background — record when (so the next foreground can tell
      // how long we were away). CRUCIAL: tell the relay we're backgrounded. The
      // OS keeps this socket nominally OPEN, so without this the relay counts us
      // "active" and NEVER sends the push — the root cause of "no notifications
      // when the app is backgrounded/closed". Now the relay treats us as a push
      // target. (The transport heartbeat is connection-tied, not foreground-
      // gated, and the OS suspends its timer on mobile background anyway, so
      // there's nothing to pause here.)
      lastActiveTimestamp = Date.now();
      try {
        client.setAppState("background");
      } catch {
        // intentional: fire-and-forget background signal to the relay; reconnect re-asserts.
      }
    }
  });
  window.addEventListener("online", () => void onForeground());

  // Unlock the notification sound on the first user gesture (browsers/Chromium
  // block audio.play() until then).
  const unlock = () => unlockNotificationAudio();
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });

  // Deep-link from a clicked native (Electron main-process) notification.
  const bridge = (
    window as Window & {
      cyborg7Desktop?: { events?: { on?: (e: string, h: (p: unknown) => void) => () => void } };
    }
  ).cyborg7Desktop;
  bridge?.events?.on?.("navigate", (url) => {
    if (typeof url === "string") void goto(url);
  });
}

// Wire agent events
client.on("agent_stream", (payload) => {
  agentStreamState.handleEvent(payload.agentId, payload.event);
  logState.pushAgentEvent(payload.agentId, payload.event);

  const turnEvents = ["turn_started", "turn_completed", "turn_failed", "turn_canceled"];
  if (turnEvents.includes(payload.event.type)) {
    const agent = workspaceState.agents.find((a) => a.agentId === payload.agentId);
    if (agent) {
      const status = agentStreamState.getTurnStatus(payload.agentId);
      agent.lifecycle = status === "canceled" ? "idle" : status;
      workspaceState.agents = [...workspaceState.agents];
    }
    // #591: derive the list-level "needs attention" badge from the live turn
    // edge (completed → "finished", failed → "error"), mirroring the daemon's
    // edge rule for agents already streaming here — so a background agent that
    // finishes/errors badges without waiting for the next listAgents snapshot.
    // Skips the agent currently in view (it's being read → no "review me").
    if (payload.agentId !== activeAgentIdFromUrl()) {
      attentionState.noteTurnEvent(
        payload.agentId,
        payload.event.type as "turn_started" | "turn_completed" | "turn_failed" | "turn_canceled",
      );
    }
  }

  const agentName =
    workspaceState.agents.find((a) => a.agentId === payload.agentId)?.provider ??
    payload.agentId.slice(0, 8);
  if (payload.event.type === "permission_requested") {
    activityState.push(
      "permission_request",
      agentName,
      payload.agentId,
      "agent",
      `Requesting permission: ${payload.event.request.name ?? "unknown tool"}`,
    );
  } else if (payload.event.type === "turn_failed") {
    activityState.push(
      "agent_error",
      agentName,
      payload.agentId,
      "agent",
      payload.event.error ?? "Agent turn failed",
    );
  }
});

// Task-processing observability (Logs tab): the server fans structured watcher +
// task-lifecycle events out as `cyborg:task_event`; the payload is the already-
// formatted Logs line (level/source/message + category "task"), so push it
// straight into logState. These surface the under-the-hood pipeline a user can't
// otherwise see: watcher fired/skipped/selected, task created/moved/dispatched,
// recurrence spawned.
client.on("task_event", (payload) => {
  logState.push(payload.level, payload.category, payload.source, payload.message);
});

// Audit-trace observability (#995, Logs tab): the server fans the redacted cybo
// context/tool/spawn/daemon traces out as `cyborg:audit_event`. Unlike task events
// these carry structured ids (agentId/cyboId/daemonId/kind/payload) the Logs filters
// slice by, so push the FULL line via pushAudit (not the lossy push).
client.on("audit_event", (payload) => {
  logState.pushAudit({
    level: payload.level,
    category: payload.category,
    source: payload.source,
    message: payload.message,
    kind: payload.kind,
    daemonId: payload.daemonId ?? null,
    agentId: payload.agentId ?? null,
    cyboId: payload.cyboId ?? null,
    payload: payload.payload ?? null,
  });
});

client.on("error", (err) => {
  connectionState.error = err.message;
});

// HARD-PAUSE gate on a fire-and-forget path (guest agent-prompt send): the
// relay can't reject a pending RPC, so it emits a top-level guest_error with
// error:'license_required'. Re-seed the license + open the activate modal.
client.on("license_required", (p) => {
  if (p.license) licenseState.set(p.license);
  licenseState.openModal();
  toast.error(p.message);
});

client.on("presence", (payload) => {
  presenceState.update(payload.onlineUserIds);
  // P2 Item 6: away is a subset of online, broadcast alongside it.
  presenceState.updateAway(payload.awayUserIds ?? []);
});

// P2 Item 6: a co-member's custom status changed live. If it's MY own status
// (echoed on another device), also reconcile my self-status state.
client.on("user_status_changed", (p) => {
  workspaceUserStatusesState.set(p.userId, {
    emoji: p.emoji,
    text: p.text,
    expiresAt: p.expiresAt,
  });
  if (p.userId === authState.user?.id) {
    userStatusState.applyRemote(
      p.emoji,
      p.text,
      p.expiresAt != null ? new Date(p.expiresAt).toISOString() : null,
    );
  }
});

// P2 Item 9: a conversation read on one of my devices also cleared its Activity
// feed items. Reconcile the local ActivityState so the badge matches everywhere.
client.on("activity_read_changed", (p) => {
  if (p.channelId) activityState.markReadByChannel(p.channelId);
  if (p.dmPeerId) activityState.markReadByDmPeer(p.dmPeerId);
  if (p.taskId) activityState.markReadByTask(p.taskId);
});

function tombstoneMessage(
  m: import("../core/types.js").Message,
): import("../core/types.js").Message {
  return Object.assign({}, m, { deleted: true, text: "", reactions: undefined });
}

client.on("delete_message", ({ messageId }) => {
  // Tombstone the deleted message in place (render "(message deleted)") instead
  // of removing it, and drop the replies of a deleted root (the server cascades
  // the soft-delete to them). Mattermost-style.
  const apply = (messages: import("../core/types.js").Message[]) => {
    const out: import("../core/types.js").Message[] = [];
    for (const m of messages) {
      if (m.parentId === messageId) continue;
      out.push(m.id === messageId ? tombstoneMessage(m) : m);
    }
    return out;
  };
  channelState.messages = apply(channelState.messages);
  dmState.messages = apply(dmState.messages);
  if (threadState.parentId === messageId) {
    threadState.replies = [];
  } else {
    threadState.replies = apply(threadState.replies);
  }
  // Mirror the tombstone (+ reply cascade) into the cache. No-op off-iOS.
  if (cacheOn()) void cache.cacheDeleteMessage(messageId);
});

client.on("edit_message", ({ messageId, text }) => {
  const updateMessages = (messages: import("../core/types.js").Message[]) =>
    messages.map((m) => (m.id === messageId ? { ...m, text, updatedAt: Date.now() } : m));
  channelState.messages = updateMessages(channelState.messages);
  dmState.messages = updateMessages(dmState.messages);
  // Mirror the edit into the cache. No-op off-iOS.
  if (cacheOn()) void cache.cacheEditMessage(messageId, text);
});

// URL unfurls finished fetching server-side (Tier 2): patch the message in place
// wherever it's rendered. The relay scopes the broadcast (channelId for channels,
// toId/fromId for DMs), but a message can be on screen in the channel timeline,
// the open DM, or the thread panel — so we patch all three by messageId. Older
// messages without an `unfurls` field are unaffected (this only assigns when the
// id matches, mirroring the edit/reaction in-place patch pattern).
client.on("message_unfurled", ({ messageId, unfurls }) => {
  const patch = (messages: import("../core/types.js").Message[]) =>
    messages.map((m) => (m.id === messageId ? { ...m, unfurls } : m));
  channelState.messages = patch(channelState.messages);
  dmState.messages = patch(dmState.messages);
  threadState.replies = patch(threadState.replies);
  // Mirror the unfurls into the cache. No-op off-iOS.
  if (cacheOn()) void cache.cacheUnfurlMessage(messageId, (unfurls as unknown[]) ?? []);
});

client.on("reaction", (event) => {
  const myId = authState.user?.id;
  if (event.fromId === myId) return;

  const updateMessages = (messages: import("../core/types.js").Message[]) =>
    messages.map((m) => {
      if (m.id !== event.messageId) return m;
      const reactions = [...(m.reactions ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === event.emoji);

      if (event.action === "removed") {
        if (idx >= 0) {
          const r = reactions[idx];
          if (r.count <= 1) {
            reactions.splice(idx, 1);
          } else {
            reactions[idx] = {
              ...r,
              count: r.count - 1,
              reactorNames: r.reactorNames?.filter((n) => n !== event.fromName),
            };
          }
        }
      } else {
        if (idx >= 0) {
          reactions[idx] = {
            ...reactions[idx],
            count: reactions[idx].count + 1,
            reactorNames: [...(reactions[idx].reactorNames ?? []), event.fromName ?? "Unknown"],
          };
        } else {
          reactions.push({
            emoji: event.emoji,
            count: 1,
            reacted: false,
            reactorNames: [event.fromName ?? "Unknown"],
          });
        }
      }
      return { ...m, reactions };
    });

  channelState.messages = updateMessages(channelState.messages);
  dmState.messages = updateMessages(dmState.messages);
  // Mirror the reaction change into the cache (same reducer logic). No-op off-iOS.
  if (cacheOn()) void cache.cacheApplyReaction(event);
});

client.on("members_updated", ({ workspaceId, members }) => {
  if (workspaceState.current?.id === workspaceId) {
    workspaceState.members = members;
    authState.setMemberImagesFromMembers(members);
  }
});

// An owner/admin toggled agent autonomy (here or on another device) → patch the
// workspace's settings.agentAutonomyEnabled live so the AI-settings toggle and
// any reader stay in sync. Mirror both the active workspace and its list copy,
// matching how updateWorkspace patches settings.
client.on("workspace_autonomy_updated", ({ workspaceId, enabled }) => {
  if (workspaceState.current?.id === workspaceId) {
    workspaceState.current.settings = {
      ...workspaceState.current.settings,
      agentAutonomyEnabled: enabled,
    };
  }
  const inList = workspaceState.list.find((w) => w.id === workspaceId);
  if (inList) {
    inList.settings = { ...inList.settings, agentAutonomyEnabled: enabled };
  }
});

// A task was created/updated/deleted anywhere (this client, another member, a
// cybo) → patch the board live so it reflects without a manual refetch. Guarded
// on the active workspace so a stale broadcast can't leak into a since-switched
// one. created/updated share one path (patch by id, else prepend) — a "created"
// row is new (prepend), an "updated" row already exists (merge onto it). A
// "deleted" op drops the row by id (an open detail peek for it falls back to
// "not found").
//
// The incoming `task` is already the camelCase `Task` model (client.ts ran the
// broadcast through `mapRawTask`), so every Tasks-Redesign field
// (projectId/parentId/stateId/sequenceId/cycleId/priority/startDate/dueAt/
// labelIds/moduleIds) rides along and is carried onto the board row instead of
// being dropped on reconcile. We MERGE (spread the existing row first) rather
// than replace so a partial broadcast — a recurrence-spawned `{ id }` or a
// future field-scoped `updated` op where `mapRawTask` defaulted the absent
// Plane columns to null/[] — can't wipe fields the board already knows.
client.on("tasks_changed", ({ workspaceId, op, task }) => {
  if (workspaceState.current?.id !== workspaceId) return;
  // Guard the rune-backed list: it can be transiently undefined mid workspace
  // switch (the broadcast can land between clearing and re-seeding tasks).
  const tasks = workspaceState.tasks ?? [];
  if (op === "deleted") {
    workspaceState.tasks = tasks.filter((t) => t.id !== task.id);
    return;
  }
  const existing = tasks.find((t) => t.id === task.id);
  if (!existing) {
    workspaceState.tasks = [task, ...tasks];
  } else {
    // MUTATE the existing $state task in place rather than replacing the object/
    // array reference: Svelte 5 deep-reactivity tracks per-property writes, so
    // surgical assignments re-render only what changed and keep object identity
    // stable for keyed list items. Copy each incoming field onto the live row.
    for (const key of Object.keys(task) as (keyof typeof task)[]) {
      // Per-task scheduling — never let a partial broadcast that OMITTED `schedule`
      // (`undefined`) blank an existing cadence chip. The server denormalizes the
      // schedule onto every edit broadcast, but this guard is defense in depth:
      // preserve the prior schedule unless the broadcast actually carried the field.
      // An explicit `null` (the schedule was detached via its own *_schedule RPC)
      // DOES fall through and clears the chip.
      if (key === "schedule" && task.schedule === undefined) continue;
      (existing as unknown as Record<string, unknown>)[key] = task[key];
    }
  }
});

// A page was created/updated/archived/deleted server-side. The pages list view
// owns its own state + refetch, so this global handler is an intentional no-op
// stub (registered for consistency with tasks_changed); the list view subscribes
// to `pages_changed` itself and refetches off this same broadcast. Kept here so
// the event mapping is wired end-to-end and a future global pages cache has an
// obvious hook point.
client.on("pages_changed", () => {
  // intentional: pages live-update is handled by the pages list view's own
  // `client.on("pages_changed", …)` subscription + refetch, not global state.
});

client.on("daemon_status", ({ daemonId, status }) => {
  const prev = daemonStatusState.get(daemonId);
  daemonStatusState.set(daemonId, status);
  // Mirror into the global daemon state so sidebar/detail dots stay realtime.
  daemonState.setStatus(daemonId, status);
  // list_agents/fetch_cybos are forwarded to the daemon, so they return empty
  // while the daemon is down — e.g. after an account switch re-claims and
  // restarts the embedded daemon, or right after a hard reload while the daemon
  // re-attaches. selectWorkspace already ran against the offline daemon and
  // nothing else refreshes the lists, so the agents panel / cybo templates stay
  // empty until a manual reload. Refetch on the offline→online transition.
  if (status === "online" && prev !== "online" && workspaceState.current) {
    const wsId = workspaceState.current.id;
    void (async () => {
      try {
        const agents = await client.listAgents(wsId);
        if (workspaceState.current?.id === wsId) {
          workspaceState.agents = agents;
          attentionState.seedFromAgents(agents); // #591: seed derived attention
        }
      } catch {
        // intentional: silent background self-heal on daemon offline→online; a
        // miss just waits for the next status flip or manual reload.
      }
      // Re-hydrate the open sessions THIS daemon owns (#518): the agent_stream
      // only resumes "from now" after the daemon re-attaches, so output streamed
      // (and turns that progressed) while it was away are lost to a client that
      // stayed connected. The list refetch above is registry-only — without this
      // the open session shows a gap until a manual reopen. Fire-and-forget +
      // workspace-guarded internally; scoped to this daemon to skip redundant
      // fetches of sessions whose daemon never dropped. Runs after the list
      // refetch so workspaceState.agents has the fresh daemon ownership.
      if (workspaceState.current?.id === wsId) {
        void catchUpAgentTimelines(wsId, daemonId);
      }
    })();
    // Guard on loading so we don't stack a concurrent request on top of an
    // in-flight selectWorkspace/retryCybosOnEmpty fetch. Deliberately does NOT
    // set cyboState.loading: this is a silent background self-heal, and
    // flipping the flag would flash a loading state over the rendered pane.
    if (cyboState.list.length === 0 && !cyboState.loading) {
      void (async () => {
        try {
          const cybos = await client.fetchCybos(wsId);
          if (workspaceState.current?.id === wsId && cybos.length > 0) cyboState.list = cybos;
        } catch {
          // intentional: silent background self-heal on daemon offline→online;
          // a miss just waits for the next status flip or manual reload.
        }
      })();
    }
  }
});

// #705 (REQUEST → NOTIFY → APPROVE): a daemon-access request was created (→ the
// daemon OWNER) or resolved (→ the REQUESTER). Pushed per-user, so the payload is
// always relevant to the current user. Upsert the row (the inbox/affordances read
// from here), then — when I'm the owner of a freshly PENDING request — bump the
// Activity feed so the "Permissions" tab surfaces an approvable row immediately
// (the activity_new push below handles the persisted badge; this is the live one).
client.on("daemon_access_request_changed", ({ request }) => {
  if (workspaceState.current?.id !== request.workspaceId) return;
  const existing = daemonAccessRequestsState.byId(request.id);
  daemonAccessRequestsState.upsert(request as DaemonAccessRequest);
  // Only bump activity for a NEWLY pending request I own (not on resolve, and not
  // for my own outgoing request). The owner is the daemon's ownerId.
  const myId = authState.user?.id;
  const daemon = daemonState.byId(request.daemonId);
  const iOwn = !!myId && daemon?.ownerId === myId;
  const isNewPending = request.status === "pending" && !existing;
  if (iOwn && isNewPending && request.requesterId !== myId) {
    const daemonLabel = daemon?.label ?? "your daemon";
    activityState.pushDaemonAccessRequest(
      request.id,
      request.requesterName ?? "Someone",
      request.requesterId,
      `requested access to ${daemonLabel}`,
    );
  }
  // When MY pending request is approved, the grant landed server-side — refetch
  // daemon access so daemonState reflects it live (canAccess flips without a full
  // workspace reload).
  if (request.status === "approved" && !!myId && request.requesterId === myId) {
    client
      .fetchDaemonAccess(request.workspaceId)
      .then(({ access }) => {
        daemonState.setAccess(access);
        return;
      })
      // intentional: best-effort live access refresh; the next workspace load reconciles otherwise.
      .catch(() => {});
  }
});

// #705: the server also persists a generic activity_new badge for a daemon-access
// request. Mention/DM activity already flows through the message paths, so this
// handler only routes the daemon_access_request type into the feed — keyed by the
// request id (sourceId), so it dedupes against the live daemon_access_request_changed
// push (idempotent: pushDaemonAccessRequest ignores a duplicate id).
client.on("activity_new", (e) => {
  if (workspaceState.current?.id !== e.workspaceId) return;
  if (!e.sourceId) return;
  // Task notification (assignment / status change): route into the feed keyed by
  // task:<taskId> (idempotent: pushTask ignores a duplicate id), mirroring the
  // daemon-access-request live push. sourceType="task" disambiguates from a
  // message-sourced event sharing the task_* prefix.
  if (
    e.sourceType === "task" &&
    (e.eventType === "task_assigned" || e.eventType === "task_status_changed")
  ) {
    activityState.pushTask(
      e.sourceId,
      e.eventType,
      e.actorName ?? "Someone",
      e.actorId,
      e.previewText ?? "",
    );
    return;
  }
  if (e.eventType !== "daemon_access_request") return;
  activityState.pushDaemonAccessRequest(
    e.sourceId,
    e.actorName ?? "Someone",
    e.actorId,
    e.previewText ?? "requested access to your daemon",
  );
});

client.on("channel_created", ({ channel }) => {
  if (workspaceState.current?.id !== channel.workspaceId) return;
  if (workspaceState.channels.some((c) => c.id === channel.id)) return;
  // Only surface a channel we created (we're its first member). A public channel
  // someone ELSE creates is NOT auto-added to our sidebar — that diverged from the
  // server's member-only channel list (it showed up live but vanished on reload)
  // and let a non-member open a composer in a channel they never joined. Others'
  // public channels are found via "Browse channels" → read-only Preview → Join.
  if (channel.createdBy === authState.user?.id) {
    workspaceState.channels = [...workspaceState.channels, channel];
  }
});

// #608: a group DM was created. Unlike channel_created (which only self-adds
// the creator), a group DM is added to the sidebar for EVERY member — the
// broadcast carries the authoritative memberIds. A hidden channel must never
// appear for a non-member, so gate strictly on membership.
client.on("group_dm_created", ({ channel, memberIds }) => {
  if (workspaceState.current?.id !== channel.workspaceId) return;
  if (!authState.user?.id || !memberIds.includes(authState.user.id)) return;
  if (workspaceState.channels.some((c) => c.id === channel.id)) return;
  workspaceState.channels = [...workspaceState.channels, channel];
});

client.on("channel_updated", ({ channel }) => {
  // Archived channels are excluded from the active list — drop a newly-archived
  // channel here so every client (not just the actor) sees it disappear. The
  // archive broadcast reuses channel_updated rather than a bespoke event.
  if (channel.isArchived) {
    workspaceState.channels = workspaceState.channels.filter((c) => c.id !== channel.id);
    if (channelState.activeId === channel.id) {
      channelState.activeId = null;
    }
    return;
  }
  const exists = workspaceState.channels.some((c) => c.id === channel.id);
  if (exists) {
    workspaceState.channels = workspaceState.channels.map((c) =>
      c.id === channel.id ? { ...c, ...channel } : c,
    );
    return;
  }
  // Channel re-surfaced (e.g. unarchived) and not in our list. Only show it if
  // it's public or we created it — never silently re-add a private channel to a
  // non-member's sidebar (mirrors the channel_created visibility guard).
  if (!channel.isPrivate || channel.createdBy === authState.user?.id) {
    workspaceState.channels = [...workspaceState.channels, channel];
  }
});

// #630: per-channel mention-roster refresh signal. Bumped whenever a member or
// cybo is added/removed to a channel. An OPEN composer's roster effect
// (MessageInput) depends on versionOf(channelId), so a bump makes it re-fetch
// fetch_channel_members / fetch_channel_cybos → @-autocomplete updates LIVE
// without a reload. Per-channel so only the affected composer re-fetches.
class ChannelRosterRefreshState {
  versions = $state<Record<string, number>>({});
  versionOf(channelId: string | null | undefined): number {
    return channelId ? (this.versions[channelId] ?? 0) : 0;
  }
  bump(channelId: string): void {
    // Mutate the key directly (not reassign the object): Svelte 5's deep $state
    // proxy then re-runs ONLY effects observing THIS channel's version, instead
    // of every composer watching any channel (gemini review).
    this.versions[channelId] = (this.versions[channelId] ?? 0) + 1;
  }
}
export const channelRosterState = new ChannelRosterRefreshState();

client.on("channel_member_added", async ({ channelId, userId, workspaceId }) => {
  if (workspaceState.current?.id !== workspaceId) return;
  // Self-add: make sure the channel shows in my sidebar.
  if (userId === authState.user?.id && !workspaceState.channels.some((c) => c.id === channelId)) {
    try {
      const channels = await client.fetchChannels(workspaceId);
      const added = channels.find((c) => c.id === channelId);
      if (added && !workspaceState.channels.some((c) => c.id === added.id)) {
        workspaceState.channels = [...workspaceState.channels, added];
      }
    } catch {
      // ignore — channel will appear on next workspace refresh
    }
  }
  // #630: ANY member added to a channel I'm in → refresh its mention roster so an
  // open composer's @-autocomplete picks up the new member live (previously this
  // handler returned early for non-self adds, so the roster went stale until a
  // reload).
  refreshChannelRosterOnMembershipChange(
    {
      eventWorkspaceId: workspaceId,
      channelId,
      currentWorkspaceId: workspaceState.current?.id,
      myChannelIds: workspaceState.channels.map((c) => c.id),
    },
    (id) => channelRosterState.bump(id),
  );
});

// #630: a cybo added/removed to a channel I'm in → refresh its mention roster so
// @-autocomplete includes/drops the cybo live. These broadcasts are SEPARATE
// from channel_member_added (cybos aren't user members) and were previously
// unhandled on the client — the exact repro (adding a cybo needed a reload).
function refreshRosterForChannelCybo({
  channelId,
  workspaceId,
}: {
  channelId: string;
  workspaceId: string;
}): void {
  refreshChannelRosterOnMembershipChange(
    {
      eventWorkspaceId: workspaceId,
      channelId,
      currentWorkspaceId: workspaceState.current?.id,
      myChannelIds: workspaceState.channels.map((c) => c.id),
    },
    (id) => channelRosterState.bump(id),
  );
}
client.on("channel_cybo_added", refreshRosterForChannelCybo);
client.on("channel_cybo_removed", refreshRosterForChannelCybo);

// #640: a cybo was edited (name/model/avatar/role/…) anywhere in the workspace →
// patch it in the shared roster so the @-mention autocomplete, the agents pane,
// and the in-channel cybo header reflect it LIVE instead of going stale until a
// reload. Sibling of channel_cybo_added (#633): UPDATE must broadcast too.
client.on("cybo_updated", ({ cybo }) => {
  const match = cyboState.list.find((c) => c.id === cybo.id);
  if (!match) return; // not a cybo we track — nothing to do
  // Mutate the $state roster element IN PLACE so Svelte 5's deep-proxy
  // reactivity is surgical (only the changed keys re-trigger; the array ref and
  // sibling cybos stay untouched) — same pattern as #633's live refresh.
  applyCyboUpdate(match, cybo);
  // Bump the open channel's mention roster so an active composer's autocomplete
  // re-renders the cybo's new name immediately.
  if (channelState.activeId) channelRosterState.bump(channelState.activeId);
});

// #644: a cybo was created/deleted anywhere in the workspace → keep the shared
// roster (agents pane + @-mention autocomplete) in sync live instead of stale
// until reload. Completes the create/add/update/remove broadcast symmetry
// (#633 add, #641 update). Both ops mutate cyboState.list in place (push/splice)
// and are idempotent, so the actor (who already refetched/filtered locally) and
// every other member converge without duplicates.
client.on("cybo_created", ({ cybo }) => {
  appendCybo(cyboState.list, cybo);
});
client.on("cybo_deleted", ({ cyboId }) => {
  removeCybo(cyboState.list, cyboId);
  // A deleted cybo may have been a channel member → bump the open channel's
  // mention roster so it drops out of an active composer's autocomplete live.
  if (channelState.activeId) channelRosterState.bump(channelState.activeId);
});

client.on("channel_deleted", ({ channelId, workspaceId }) => {
  workspaceState.channels = workspaceState.channels.filter((c) => c.id !== channelId);
  notificationState.clear(workspaceId, channelId);
  unreadFlagState.clearUnread(workspaceId, channelId);
  if (channelState.activeId === channelId) {
    channelState.activeId = null;
  }
  // Drop the cached scope so a deleted channel's history doesn't resurface on a
  // cold open. No-op off-iOS.
  if (cacheOn()) {
    const key = cache.channelScope(workspaceId, channelId);
    void cache.cacheDropScope(key, key);
  }
});

client.on("channel_member_removed", ({ channelId, userId, workspaceId }) => {
  if (userId === authState.user?.id) {
    const ch = workspaceState.channels.find((c) => c.id === channelId);
    if (ch?.isPrivate) {
      workspaceState.channels = workspaceState.channels.filter((c) => c.id !== channelId);
      notificationState.clear(workspaceId, channelId);
      unreadFlagState.clearUnread(workspaceId, channelId);
      if (channelState.activeId === channelId) {
        channelState.activeId = null;
      }
      // Removed from a private channel — drop its cached history. No-op off-iOS.
      if (cacheOn()) {
        const key = cache.channelScope(workspaceId, channelId);
        void cache.cacheDropScope(key, key);
      }
    }
  }
  // #630/#635 symmetry: a member removed from a channel I'm still in (incl.
  // actor≠self — someone ELSE removed) → refresh the mention roster so they drop
  // out of @-autocomplete live. The self-from-private case above already dropped
  // the channel from my list, so this gate no-ops there (channel ∉ myChannelIds).
  refreshChannelRosterOnMembershipChange(
    {
      eventWorkspaceId: workspaceId,
      channelId,
      currentWorkspaceId: workspaceState.current?.id,
      myChannelIds: workspaceState.channels.map((c) => c.id),
    },
    (id) => channelRosterState.bump(id),
  );
});

// ─── Daemon status state ────────────────────────────────────────

class DaemonStatusState {
  private statuses = $state<Record<string, "online" | "offline">>({});

  set(daemonId: string, status: "online" | "offline"): void {
    this.statuses = { ...this.statuses, [daemonId]: status };
  }

  get(daemonId: string): "online" | "offline" {
    return this.statuses[daemonId] ?? "offline";
  }

  get onlineCount(): number {
    return Object.values(this.statuses).filter((s) => s === "online").length;
  }

  get all(): Record<string, "online" | "offline"> {
    return this.statuses;
  }

  load(daemons: Array<{ id: string; status: string }>): void {
    const next: Record<string, "online" | "offline"> = {};
    for (const d of daemons) {
      next[d.id] = d.status === "online" ? "online" : "offline";
    }
    this.statuses = next;
  }

  clear(): void {
    this.statuses = {};
  }
}

export const daemonStatusState = new DaemonStatusState();

// Tracks the workspace selection currently in flight. selectWorkspace awaits
// several fetches; if the user switches workspace mid-await, a slower previous
// selection must not clobber the newer one. Every post-await assignment checks
// this token.
let activeWorkspaceSelection: string | null = null;

// ─── Actions (override core to use CyborgClient) ─────────────────

export async function connectToServer(url: string, token: string): Promise<void> {
  authState.token = token;
  let authResp: Awaited<ReturnType<typeof client.authenticate>>;
  try {
    await client.connect(url, token);
    authResp = await client.authenticate();
    // Authenticated — replay anything queued while the socket was down.
    flushSendOutbox();
    void registerMobilePush(client);
    syncAppStateToRelay();
  } catch (e) {
    // Classify the failure so callers can react correctly: a bad/expired token
    // (AuthError) means log out; an unreachable relay (NetworkError) means keep
    // the session and reconnect. The relay's bad-token response is the literal
    // string "unauthorized"; everything else (socket closed, timeout, refused)
    // is a transient network failure.
    const msg = e instanceof Error ? e.message : String(e);
    if (/unauthor/i.test(msg)) throw new AuthError(msg);
    throw new NetworkError(msg);
  }
  authState.user = authResp.user;
  authState.bindUser(authResp.user.id);
  userStatusState.bindUser(authResp.user.id);
  // Per-user session aliases are global (not per-workspace) — hydrate the local
  // mirror from the DB once on connect. Fire-and-forget; failure keeps any local
  // aliases visible (display-only).
  void sessionAlias.load(client);
  // Per-user terminal aliases are global too — hydrate from the DB and subscribe
  // to the live cross-device change feed. Fire-and-forget; failure keeps any
  // local (localStorage-fallback) aliases visible (display-only).
  void terminalAlias.load(client);
  notificationState.bindUser(authResp.user.id);
  unreadFlagState.bindUser(authResp.user.id);
  dmActivityState.bindUser(authResp.user.id);
  favoritesState.bindUser(authResp.user.id);
  activityState.bindUser(authResp.user.id);
  // Client-only notification prefs (DND, custom keywords, per-channel ignore-
  // broadcast + sound). Per-user localStorage so a shared device stays separate.
  notifyClientPrefsState.bindUser(authResp.user.id);
  // Open the local message cache for this user (iOS shell only). Wipes the cache
  // if a different user previously owned this device + runs the LRU sweep.
  // Fire-and-forget — must not block login. No-op off-iOS.
  if (cacheOn()) void cache.cacheInit(authResp.user.id);
  // Rehydrate the persistent send outbox (#502) — NOT iOS-gated: an offline send
  // must survive a reload everywhere. Rebuild the optimistic bubbles + replay
  // queue from IndexedDB, then flush them on this freshly-authed socket. The
  // early flushSendOutbox above only covered in-memory entries; this covers ones
  // persisted across a reload. Fire-and-forget — must not block login.
  void rehydrateOutbox(authResp.user.id).then(() => flushSendOutbox());
  // Desktop only: bind the embedded daemon to this user + the relay it should
  // connect to (derived from the server we just authed against), so it registers
  // with the cloud relay and shows online. Fire-and-forget — it restarts the
  // local daemon and must not block login. No-op in the browser.
  try {
    const desktop = (
      window as unknown as {
        cyborg7Desktop?: {
          invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
        };
      }
    ).cyborg7Desktop;
    if (desktop) {
      // The daemon relay endpoint is /relay at the ORIGIN. `url` here is the
      // guest WS URL (e.g. ws://host:9100/api/ws), so derive from host only —
      // appending /relay to the path would yield the wrong /api/ws/relay.
      const u = new URL(url);
      const wsProto = u.protocol === "https:" || u.protocol === "wss:" ? "wss" : "ws";
      const relayUrl = `${wsProto}://${u.host}/relay`;
      void desktop
        .invoke("claim_desktop_daemon", { ownerId: authResp.user.id, relayUrl })
        // intentional: desktop-only daemon claim is fire-and-forget; the daemon's own status heartbeat is the source of truth.
        .catch(() => {});
    }
  } catch {
    // intentional: desktop-only daemon claim is fire-and-forget and must not
    // block login; a clean no-op in the browser (no bridge present).
  }
  workspaceState.list = authResp.workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    ownerId: "",
    avatarUrl: ws.avatarUrl ?? null,
    role: ws.role as Workspace["role"],
    createdAt: 0,
    settings: {},
  }));
  // Hear live broadcasts from ALL the user's workspaces + seed their unread, so
  // cross-workspace DMs/messages badge live and the switcher badges are filled.
  subscribeAndSeedAllWorkspaces();
  try {
    localStorage.setItem("cyborg7-session", JSON.stringify({ mode: "direct", url, token }));
  } catch {
    // intentional: best-effort session persistence; storage-disabled just means
    // the user re-auths next launch.
  }
  // Best-effort: re-register the web push subscription if the user already
  // granted permission. Dynamic import avoids a circular module dependency.
  // intentional: opportunistic push re-register; failure just means no push until the next launch (settings page re-enables it).
  void import("$lib/push/web-push.js").then((m) => m.ensureWebPushSubscription()).catch(() => {});
}

// Upload a profile avatar to S3 and persist its URL in PG (users.image_url) so
// every workspace member sees it. Replaces the old localStorage data-URL flow.
export async function updateProfileImage(file: File): Promise<void> {
  const { publicUrl } = await client.uploadAsset(file, "avatars");
  await client.setProfileImage(publicUrl);
  authState.setProfileImage(publicUrl);
}

export async function updateProfileName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  await client.setProfileName(trimmed);
  authState.setProfileName(trimmed);
}

// Cold-start race: on app launch the local embedded daemon may still be
// connecting/subscribing to the relay when selectWorkspace's first listAgents
// runs, so the daemon-fan-out returns no agents even though the workspace has
// some — they only appear after a manual reload. If the initial fetch came back
// empty, retry a few times on a short backoff; stop as soon as it's non-empty or
// the user navigates away. Complements the daemon_status offline→online self-heal
// (which misses the "online but not yet workspace-subscribed" window).
async function retryAgentsOnEmpty(workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (activeWorkspaceSelection !== workspaceId || workspaceState.agents.length > 0) return;
    try {
      const agents = await client.listAgents(workspaceId);
      if (activeWorkspaceSelection === workspaceId && agents.length > 0) {
        workspaceState.agents = agents;
        attentionState.seedFromAgents(agents); // #591: seed derived attention
        return;
      }
    } catch {
      // intentional: one attempt in a cold-start backoff retry loop; the loop
      // tries again and the daemon_status self-heal is the backstop.
    }
  }
}

export async function selectWorkspace(workspace: Workspace): Promise<void> {
  activeWorkspaceSelection = workspace.id;
  // Loading indicator for the rail switch (cleared when the target's core data is
  // in, or on failure below). The shell renders a clear "switching" view instead
  // of a blank half-loaded one while this is true.
  workspaceState.switching = true;
  workspaceState.switchError = null;
  channelState.clear();
  channelState.activeId = null;
  agentStreamState.clearAll();
  attentionState.clearAll(); // #591: drop the previous workspace's attention badges
  logState.bindWorkspace(workspace.id);
  // Clear the cybo roster immediately so the PREVIOUS workspace's cybos never linger
  // into the new one (the fetch below is awaited and can be slow). A stale roster let
  // a user "Start chat" on a cybo that isn't in the new workspace — the relay then
  // rejects the spawn ("isn't in this workspace"). `loading` shows a placeholder
  // instead of an empty/stale list; the awaited fetch repopulates it (1859 below).
  cyboState.list = [];
  cyboState.loading = true;

  // Ensure this socket receives the workspace's live broadcasts — covers
  // workspaces joined mid-session (e.g. via an invite) that weren't part of the
  // socket's original auth-time subscription. Fire-and-forget. (cyborg7)
  // intentional: best-effort live-broadcast subscribe; the awaited core fetches below carry the actual switch success/failure.
  client.subscribeWorkspace(workspace.id).catch(() => {});

  // channels + tasks are the only fetches without a fallback — a rejection there
  // means the switch genuinely failed, so flag it and surface an error rather
  // than leaving the user on an infinite spinner.
  let loadFailed = false;
  // unread + notifPrefs are P6/P8 additions on top of cyborg7's five fetches;
  // serverDrafts (#610) is the cross-device draft seed.
  const [
    channels,
    tasks,
    agents,
    activity,
    cybos,
    unread,
    notifPrefs,
    allWorkspaces,
    serverDrafts,
  ] = await Promise.all([
    client.fetchChannels(workspace.id).catch(() => {
      loadFailed = true;
      return [];
    }),
    client.fetchTasks(workspace.id).catch(() => {
      loadFailed = true;
      return [];
    }),
    // intentional: agents fallback by design — an empty list triggers the cold-start retryAgentsOnEmpty backoff below.
    client.listAgents(workspace.id).catch(() => []),
    client.fetchWorkspaceActivity(workspace.id, 200).catch(() => ({ messages: [] })),
    client.fetchCybos(workspace.id).catch((): typeof cyboState.list => []),
    client
      .fetchUnread(workspace.id)
      .catch(() => ({ counts: {}, reads: {}, dmCounts: {}, dmReads: {} })),
    client.fetchNotificationPrefs(workspace.id).catch(() => ({ prefs: {} })),
    // The auth-time workspace list hydrates settings as {} (the auth payload
    // doesn't carry them), so flags like settings.trialDismissed were lost on
    // reload. fetch_workspaces returns the real settings jsonb — merge it in.
    client.fetchWorkspaces().catch((): Workspace[] => []),
    // Cross-device composer drafts (#610). Best-effort: a miss just falls back
    // to this device's localStorage cache (no server seed this load).
    client.fetchDrafts(workspace.id).catch(() => ({ drafts: [] })),
  ]);

  // Bail if the user switched workspace while these fetches were in flight —
  // otherwise this stale result clobbers the newer selection. (Don't clear
  // `switching` here: the newer in-flight selectWorkspace owns that flag.)
  if (activeWorkspaceSelection !== workspace.id) return;

  if (loadFailed) {
    workspaceState.switchError =
      "Couldn't load that workspace. Check your connection and try again.";
    workspaceState.switching = false;
    // The switch failed → nothing will repopulate the (cleared) roster; drop the
    // loading placeholder. (A stale return at the guard above leaves it to the newer
    // in-flight selectWorkspace, which owns the flag.)
    cyboState.loading = false;
    return;
  }

  if (activity.messages.length > 0) {
    logState.hydrateFromMessages(activity.messages);
  }

  workspaceState.channels = channels;
  workspaceState.tasks = tasks;
  workspaceState.agents = agents;
  // #591: seed derived finished/error attention badges from the initial roster
  // snapshot (so an agent that finished before this load already shows a badge).
  attentionState.seedFromAgents(agents);
  const fresh = allWorkspaces.find((w) => w.id === workspace.id);
  if (fresh?.settings) {
    workspace.settings = fresh.settings;
    const inList = workspaceState.list.find((w) => w.id === workspace.id);
    if (inList) inList.settings = fresh.settings;
  }
  workspaceState.current = workspace;
  // Server-side draft sync (#610): seed this device's composer drafts from the
  // server and reconcile against the localStorage cache (newest updatedAt wins).
  // MUST run AFTER workspaceState.current is set — the drafts store keys its
  // localStorage by the active workspace id, so an earlier call would read/write
  // under the wrong (or "_") workspace. Local-only / locally-newer drafts are
  // re-pushed to the server inside seedFromServer so it converges.
  draftsState.seedFromServer(serverDrafts.drafts);
  // Core data is in — unblock the shell (the tail below loads members/messages
  // with their own loading states).
  workspaceState.switching = false;
  cyboState.list = cybos;
  cyboState.loading = false;
  // Server-authoritative license (trial bar + HARD-PAUSE gate). Best-effort —
  // an older relay without the billing routes just leaves the bar hidden.
  void refreshLicense(workspace.id);
  // Cold-start race: cybos are DAEMON_FORWARD, so the initial fetch can return []
  // before the embedded daemon connects, leaving cybo avatars/names blank until
  // reload. Retry until the daemon answers.
  if (cybos.length === 0) void retryCybosOnEmpty(workspace.id);
  // Server-truth unread signals (survive reload + cross-device). BUG #2: the RED
  // badge seeds from channel MENTION counts + DM message counts; the BOLD flag
  // seeds from channels with any unread message. Item 12: DM badges (keyed by
  // peerId) merge into the SAME per-workspace map as channel mention counts; the
  // frozen-divider cursors seed into readCursorState separately.
  seedUnreadSignals(workspace.id, unread);
  readCursorState.seed({ reads: unread.reads, dmReads: unread.dmReads });
  // MERGE (not seed/replace): switching to this workspace must NOT discard the
  // other workspaces' prefs that subscribeAndSeedAllWorkspaces loaded — otherwise
  // a cross-workspace muted/mentions-only channel would banner a plain message
  // again the moment you switch away from it. Scope ids are globally-unique, so
  // overlaying this workspace's fresh prefs keeps every workspace's prefs correct.
  notifPrefsState.merge(notifPrefs.prefs);
  // Seed the threads aggregate badge; the list loads lazily when the Threads
  // view is opened. (clear first so stale counts from the previous workspace
  // don't linger.)
  threadsState.clear();
  void seedThreadCounts();
  // Saved messages are per-workspace; drop the previous workspace's list, then
  // seed it so the per-message bookmark glyph is correct everywhere (not just
  // after opening the Saved view). One cheap query, like seedThreadCounts (#609).
  savedState.clear();
  void loadSavedMessages();

  // P2 Item 6: hydrate co-members' custom statuses so their emoji shows where
  // presence shows. Clear first so a previous workspace's statuses don't linger;
  // live changes arrive via the user_status_changed broadcast.
  workspaceUserStatusesState.clear();
  void seedUserStatuses(workspace.id);

  // P2 Item 9 (server-authoritative badge): seed the Activity feed AND the rail
  // unread baseline from the relay's cyborg:fetch_activity — the real
  // activity_events (channel mentions + thread replies the relay persists), with
  // a server-counted `unread` total. This replaces the old ~200-message
  // reconstruction, which under-counted on a fresh session (mentions older than
  // the window, or delivered before the seed ran, were missed). The live path
  // (incoming mention → addMention, activity_read_changed → markRead) stays as-is
  // and dedupes against the seeded items by source id, so it never double-counts.
  // Falls back to the legacy message backfill only if the server feed is
  // unavailable (older relay), so the feed still shows recent mentions there.
  const myId = authState.user?.id;
  void seedActivityFromServer(workspace.id, channels, activity.messages, myId);

  // Members load AFTER core data (switching already cleared), so the sidebar is
  // visible with an empty DM roster during this gap — show skeletons (item 4).
  workspaceState.membersLoading = true;
  client
    .listMembers(workspace.id)
    .then((members) => {
      if (activeWorkspaceSelection !== workspace.id) return;
      workspaceState.members = members;
      authState.setMemberImagesFromMembers(members);
      return undefined;
    })
    .catch(() => {
      if (activeWorkspaceSelection === workspace.id) workspaceState.members = [];
    })
    .finally(() => {
      if (activeWorkspaceSelection === workspace.id) workspaceState.membersLoading = false;
    });

  // Load the full daemon list + per-user access grants into the global daemon
  // state (the sidebar + detail view read from here). Access fetch is best-effort
  // so a daemon list still renders if it fails.
  Promise.all([
    client.listDaemons(workspace.id),
    client.fetchDaemonAccess(workspace.id).catch(() => ({ access: [] })),
  ])
    .then(
      ([
        { daemons, defaultSlashDaemonId, slashCommandModel, workspaceSlashConfig },
        { access },
      ]) => {
        if (activeWorkspaceSelection !== workspace.id) return;
        daemonStatusState.load(daemons);
        daemonState.load(daemons, access);
        daemonState.setDefaultSlashDaemon(defaultSlashDaemonId ?? null);
        // The workspace slash config is the admin-controlled SOURCE OF TRUTH (#opt-A);
        // the per-user `slashCommandModel` is deprecated/back-compat and can hold a
        // stale value (e.g. a legacy provider id), which made the run-target hint show
        // the wrong provider — "OpenCode" for a pi/opencode-go/glm-5.1 selection.
        // Prefer the workspace model (server-parsed provider/model); fall back to the
        // per-user field only when the workspace hasn't pinned one.
        daemonState.setSlashCommandModel(workspaceSlashConfig?.model ?? slashCommandModel ?? null);
        return undefined;
      },
    )
    // intentional: background daemon-list/access hydration; a miss leaves the daemon pane empty until reconnect-reconcile.
    .catch(() => {});

  // #705: seed the daemon-access-request inbox (owner) + outbox (requester) so the
  // Activity "Permissions" tab + the request affordances render the pending set on
  // load. Best-effort: a miss (older relay) just leaves the inbox empty until the
  // live daemon_access_request_changed push arrives.
  client
    .fetchDaemonAccessRequests(workspace.id)
    .then(({ requests }) => {
      if (activeWorkspaceSelection !== workspace.id) return;
      daemonAccessRequestsState.load(requests as DaemonAccessRequest[]);
      return undefined;
    })
    // intentional: background daemon-access-request hydration; a miss is recovered by the live push.
    .catch(() => {});

  // If the agents panel came back empty, the local daemon was likely still
  // connecting — retry briefly so it self-populates without a manual reload.
  if (workspaceState.agents.length === 0) {
    void retryAgentsOnEmpty(workspace.id);
  }

  if (channels.length > 0) {
    channelState.activeId = channels[0].id;
    // Cache-first cold render (iOS shell only — additive/safe). HIT → instant
    // paint, no skeleton; MISS → exact prior behavior (clear + spinner).
    const cachedInitial = coldPeekChannel(channels[0].id);
    if (cachedInitial) {
      channelState.setMessages(cachedInitial);
      channelState.loading = false;
    } else {
      channelState.loading = true;
      channelState.messages = [];
    }
    const { messages, hasMore } = await client.fetchMessages(workspace.id, channels[0].id, {
      limit: 50,
    });
    if (activeWorkspaceSelection !== workspace.id) return;
    channelState.setMessages(hydrateMessages(messages));
    channelState.hasMore = hasMore;
    channelState.loading = false;
    // Writeback on SUCCESS (Caveat #29). Fire-and-forget; no-op off-iOS.
    cacheWriteChannel(workspace.id, channels[0].id);
  }
}

// ─── Pull-to-refresh entry points (mobile) ────────────────────────
// Thin wrappers over the existing private resync helpers so UI components can
// trigger a refresh without reaching into module internals.

// Conversation refresh: if the socket dropped, kick a reconnect (its own loop
// drains the delta on auth); otherwise resync the open workspace/channel now.
export async function refreshActiveConversation(): Promise<void> {
  if (!client.connected) {
    client.forceReconnect();
    return;
  }
  await handleReconnect();
}

// Activity refresh: re-pull the server activity feed for the current workspace.
// channels/fallback args only feed the legacy backfill path, so [] is safe.
export async function refreshActivity(): Promise<void> {
  const wsId = workspaceState.current?.id;
  if (!wsId) return;
  if (!client.connected) {
    client.forceReconnect();
    return;
  }
  await seedActivityFromServer(wsId, [], [], authState.user?.id);
}

// ─── Billing / license (Stripe) ───────────────────────────────────

// Pull the workspace's authoritative license into licenseState. Best-effort:
// an older relay (or self-hosted with no billing) just leaves the bar hidden.
// iOS self-heal guard: reconcile a paused license against RevenueCat at most
// once per workspace per session, so a missed webhook recovers without
// hammering the reconcile endpoint on every refresh.
const iapReconciledWorkspaces = new Set<string>();

// The caller's billing surface, sent with fetchLicense so the relay resolves the
// right intent (web/desktop → Stripe rail, ios/android → IAP rail). iOS/Android
// run inside Tauri; desktop is the Electron shell; everything else is the web.
export function currentBillingPlatform(): BillingPlatformPayload {
  if (isTauriIOS()) return "ios";
  if (isTauriAndroid()) return "android";
  if (isDesktopApp()) return "desktop";
  return "web";
}

export async function refreshLicense(workspaceId?: string): Promise<void> {
  const wsId = workspaceId ?? workspaceState.current?.id;
  if (!wsId) return;
  try {
    const platform = currentBillingPlatform();
    const fetched = await client.fetchLicense(wsId, platform);
    let license = fetched.license;
    let intent = fetched.intent;
    // On iOS, a `paused` license may just be a RevenueCat webhook we never
    // received (downtime / auth not yet deployed). Reconcile once against
    // RevenueCat and adopt the corrected result before showing the locked state.
    // (reconcileIap returns only the license; the intent is re-derived on the
    // next fetch — until then we drop the stale intent so the UI doesn't show a
    // purchase card for a now-active license.)
    if (license.state === "paused" && isTauriIOS() && !iapReconciledWorkspaces.has(wsId)) {
      iapReconciledWorkspaces.add(wsId);
      const reconciled = await client.reconcileIap(wsId);
      if (reconciled) {
        license = reconciled;
        intent = null;
      }
    }
    // Don't clobber a newer selection's license with a stale fetch.
    if (workspaceState.current?.id === wsId || workspaceId === wsId) {
      licenseState.set(license);
      licenseState.setIntent(intent);
    }
  } catch {
    // Older relay without the billing route — leave the trial bar hidden.
  }
}

// iOS only: reconcile the caller's RevenueCat entitlement on the relay and adopt
// the resulting license. Called right after a StoreKit purchase/restore so
// access reflects immediately (the webhook is async). A null result leaves the
// optimistic state in place until the webhook lands.
export async function reconcileIapLicense(): Promise<void> {
  const wsId = workspaceState.current?.id;
  if (!wsId) return;
  const license = await client.reconcileIap(wsId);
  if (license && workspaceState.current?.id === wsId) {
    licenseState.set(license);
    iapReconciledWorkspaces.add(wsId);
  }
}

// Owner-only: start a Stripe Checkout Session. Card entry happens on
// checkout.stripe.com — never in our UI.
//
// Web: redirect the tab to the hosted page (`window.location.href`). The
// Stripe success_url returns to the app, so the page leaving IS the flow.
//
// Desktop (Electron): the main process denies in-place navigation off the app
// origin (main.ts `will-navigate`), so `location.href` would silently stick.
// Open the hosted page in the OS browser via the `openExternal` bridge instead,
// and return true so the caller can switch to a "waiting for activation" state
// and poll the license (the external tab can't redirect back into the app).
//
// Returns true when it opened externally (desktop), false when it navigated the
// current tab (web).
export async function startCheckout(): Promise<boolean> {
  const wsId = workspaceState.current?.id;
  if (!wsId) throw new Error("No workspace selected");
  const url = await client.startCheckout(wsId);
  if (isDesktopApp()) {
    openExternalUrl(url);
    return true;
  }
  if (typeof window !== "undefined") window.location.href = url;
  return false;
}

// Owner-only (active subscription): open the Stripe billing portal.
//
// Web: redirect the current tab (the portal's return URL brings the user back).
// Desktop: in-place navigation off the app origin is denied (see startCheckout),
// so open the portal in the OS browser instead. Returns true when it opened
// externally (desktop) so a caller with a loading state can reset it.
export async function openBillingPortal(): Promise<boolean> {
  const wsId = workspaceState.current?.id;
  if (!wsId) throw new Error("No workspace selected");
  const url = await client.openBillingPortal(wsId);
  if (isDesktopApp()) {
    openExternalUrl(url);
    return true;
  }
  if (typeof window !== "undefined") window.location.href = url;
  return false;
}

// HARD-PAUSE gate handler for RPC-based agent ops (create / spawn / prompt).
// The relay rejects these with a LicenseRequiredError once the trial ends with
// no active sub. Re-seed the license + open the activate modal; returns true if
// it handled a license error so the caller can decide whether to re-throw.
function handleLicenseError(err: unknown): boolean {
  if (err instanceof LicenseRequiredError) {
    if (err.license) licenseState.set(err.license);
    licenseState.openModal();
    return true;
  }
  return false;
}

// Handle the post-Checkout return query param (?billing=success|canceled).
// success → re-fetch the license (the webhook may already have flipped it to
// active) + toast; canceled → just close the modal. The caller cleans the param.
export async function handleBillingReturn(status: string | null): Promise<void> {
  if (status === "success") {
    await refreshLicense();
    licenseState.modalOpen = false;
    toast.success("License activated — your agents are back online.");
  } else if (status === "canceled") {
    licenseState.modalOpen = false;
  }
}

// ─── License pool + seat allocation (per-workspace billing, spec §4.3) ────────
// The LicenseAllocationPanel reads/mutates the caller's seat pool through these.
// They round-trip the `cyborg:fetch_license_pool` / `allocate_license` /
// `deallocate_license` WS RPCs (Unit E handlers in relay-standalone.ts).
//
// On a transport/timeout failure (thrown): log + leave state unchanged (the panel
// retains whatever it last showed; a stale view is better than a misleading one).
// On a business rejection (resp.error set — no_free_seat / not_owner / no_pool /
// already_active_other_rail): do NOT mutate optimistic state; return the code so
// the panel can surface the reason inline.

// Fetch the caller's seat pool + allocations + owned workspaces into licenseState.
export async function fetchLicensePool(): Promise<void> {
  licenseState.poolLoading = true;
  try {
    const resp = await client.fetchLicensePool();
    licenseState.setPool(resp.pool, resp.allocations, resp.ownedWorkspaces);
  } catch (err) {
    console.error(
      "[billing] cyborg:fetch_license_pool failed — leaving state unchanged:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    licenseState.poolLoading = false;
  }
}

// Owner-only: spend one FREE seat on `workspaceId` (no purchase). Adopts the
// relay's recomputed pool + allocations, then refreshes the gate mirror for the
// active workspace. Returns the server error code (e.g. "no_free_seat") on a
// rejected mutation, or null on success — the panel branches on it.
// On a transport/timeout failure (thrown): logs + re-throws so the panel can
// surface a generic "try again" message (state left unchanged).
export async function allocateLicense(workspaceId: string): Promise<string | null> {
  licenseState.poolLoading = true;
  try {
    const resp = await client.allocateLicense(workspaceId);
    if (resp.error) return resp.error;
    licenseState.setPoolAndAllocations(resp.pool, resp.allocations);
    // Adopt the affected workspace's fresh license so the trial/paused gate
    // mirror flips immediately (spec §4.3: "also call refreshLicense").
    if (workspaceState.current?.id === workspaceId) licenseState.set(resp.license);
    else void refreshLicense(workspaceId);
    return null;
  } catch (err) {
    console.error(
      "[billing] cyborg:allocate_license failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "error";
  } finally {
    licenseState.poolLoading = false;
  }
}

// Owner-only: free the seat on `workspaceId`. Same response handling as allocate.
export async function deallocateLicense(workspaceId: string): Promise<string | null> {
  licenseState.poolLoading = true;
  try {
    const resp = await client.deallocateLicense(workspaceId);
    if (resp.error) return resp.error;
    licenseState.setPoolAndAllocations(resp.pool, resp.allocations);
    if (workspaceState.current?.id === workspaceId) licenseState.set(resp.license);
    else void refreshLicense(workspaceId);
    return null;
  } catch (err) {
    console.error(
      "[billing] cyborg:deallocate_license failed:",
      err instanceof Error ? err.message : String(err),
    );
    return "error";
  } finally {
    licenseState.poolLoading = false;
  }
}

// Cross-component UI state for the Agents pane. The DaemonSidebar (rendered by
// the workspace layout, outside the pane) switches the pane to the Daemon
// sub-tab in-page via this shared state — no navigation involved.
export const agentsPaneState = $state<{ subTab: "cybos" | "agents" | "daemon" }>({
  // "cybos" = the workspace cybo roster (your cybos); shown first + default.
  subTab: "cybos",
});

// Set the globally-selected daemon and show its detail in the Agents pane's
// Daemon sub-tab. New sessions seed their daemon from `daemonState.selectedId`,
// so this re-scopes launches to the chosen daemon. Stays in-page when already
// on /agents; otherwise brings the user there.
export function selectDaemon(daemonId: string): void {
  const wsId = workspaceState.current?.id;
  if (!wsId) return;
  daemonState.selectedId = daemonId;
  agentsPaneState.subTab = "daemon";
  const agentsPath = `/workspace/${wsId}/agents`;
  if (typeof window !== "undefined" && window.location.pathname !== agentsPath) {
    void goto(agentsPath);
  }
}

export function disconnectFromServer(): void {
  cancelActiveConversationBadgeClear();
  hasConnectedBefore = false;
  clearSavedSession();
  client.disconnect();
  // Wipe the local message cache on logout so the next account can't read this
  // one's messages (also clears L1). No-op off-iOS. Fire-and-forget.
  if (cacheOn()) void cache.cacheClear();
  // Drop the persistent send outbox + its in-memory mirror (#502) so an
  // undelivered send doesn't replay under (or leak to) the next session. NOT
  // iOS-gated. Fire-and-forget.
  void cache.clearOutbox();
  sendOutbox.length = 0;
  pendingOutboxBubbles.clear();
  authState.clearLocal();
  userStatusState.clearLocal();
  notificationState.clearLocal();
  // Explicitly clear the dock badge / web title now (don't rely on the reactive
  // effect firing before the socket + state tear down on logout).
  pushUnreadIndicators(0);
  unreadFlagState.clearLocal();
  dmActivityState.clearLocal();
  favoritesState.clearLocal();
  // #607: drop the cached scheduled-message list so the next account doesn't
  // inherit the previous user's pending rows.
  scheduledMessagesState.clear();
  // #619: drop the cached recurring-schedule board for the same reason.
  schedulesState.clear();
  // #602: drop the cached prompt-template list so the next account/workspace
  // doesn't inherit the previous workspace's templates in the composer menu.
  promptTemplatesState.clear();
  readCursorState.reset();
  activityState.clearLocal();
  notifyClientPrefsState.clearLocal();
  // Cross-workspace notification prefs are now merged (not replaced per switch),
  // so clear them explicitly on logout or the previous account's prefs leak.
  notifPrefsState.clear();
  // Drop in-memory composer drafts (#610) so the previous account's unfinished
  // messages don't leak into the next login; server truth re-seeds on load.
  draftsState.clearAllLocal();
  // Clear per-account live state too, or the previous account's presence dots,
  // open DM thread, and daemon online/offline indicators leak into the next login.
  presenceState.clear();
  dmState.clear();
  dmState.activePeerId = null;
  daemonStatusState.load([]);
  daemonState.clear();
  daemonAccessRequestsState.clear();
  daemonHealthState.stop();
  workspaceState.current = null;
  workspaceState.list = [];
  workspaceState.channels = [];
  workspaceState.tasks = [];
  workspaceState.agents = [];
  attentionState.clearAll(); // #591
  channelState.clear();
  logState.clear();
  sessionState.list = [];
  sessionState.fetched = false;
  connectionState.status = "disconnected";
  // Wipe the warm projects cache so the next account's workspaces start cold
  // (no stale project headers from the previous session).
  projectsCache.clear();
}

// ─── Core actions (override to use CyborgClient) ─────────────────

export async function selectChannel(channelId: string): Promise<void> {
  if (!workspaceState.current) return;
  // Selecting a real (joined) channel always exits any preview: the channel now
  // resolves from `channels`, so the read-only preview slot must be cleared or
  // `isPreviewing` would linger and keep the composer hidden.
  workspaceState.previewChannel = null;
  // Navigating away defuses any pending focus-driven badge clear so the DM being
  // left is never marked read, regardless of how long the route takes to settle.
  cancelActiveConversationBadgeClear();
  // Leaving any open DM: clear the active peer so this channel is the sole
  // active conversation. Otherwise composer draftKey (which prefers dm:<peer>
  // over channel:<id>) and DM read-receipts keep pointing at the stale DM.
  dmState.activePeerId = null;
  channelState.activeId = channelId;
  // Cache-first cold render (iOS shell only — additive/safe). On a HIT, paint the
  // cached window synchronously and skip the skeleton; the network revalidate
  // below still runs and replaces it. On a MISS this returns null and we fall
  // back to the EXACT prior behavior (clear + spinner).
  const cachedChannel = coldPeekChannel(channelId);
  if (cachedChannel) {
    channelState.setMessages(cachedChannel);
    channelState.loading = false;
  } else {
    channelState.loading = true;
    channelState.messages = [];
  }
  rememberLastChannel(workspaceState.current.id, channelId);
  // Item 12: freeze the divider from the server read-cursor BEFORE this visit's
  // mark-read advances it, so the "New messages" line renders at the true
  // first-unread boundary and stays frozen for the whole visit.
  const frozen = readCursorState.getChannel(channelId);
  channelState.setUnreadCursor(frozen);
  notificationState.clear(workspaceState.current.id, channelId);
  // BUG #2: opening the channel reads it — drop the bold unread flag too.
  unreadFlagState.clearUnread(workspaceState.current.id, channelId);
  // Persist read-state server-side (cross-device unread sync, P6). The relay
  // also marks this channel's Activity items read and broadcasts
  // activity_read_changed back (incl. this device); mark optimistically here so
  // the activity badge clears instantly. (P2 Item 9)
  client.markRead(workspaceState.current.id, channelId);
  activityState.markReadByChannel(channelId);
  // Advance the LOCAL cursor to now so a later re-open snapshots the new value,
  // not the frozen copy this visit's divider holds (monotonic; Mattermost model).
  readCursorState.advanceChannel(channelId, Date.now());
  try {
    const { messages, hasMore } = await client.fetchMessages(workspaceState.current.id, channelId, {
      limit: 50,
    });
    // Guard against stale responses if the user switched channels mid-fetch.
    if (channelState.activeId === channelId) {
      channelState.setMessages(hydrateMessages(messages));
      channelState.hasMore = hasMore;
      // #502: re-show any still-pending persisted-outbox bubble for this channel
      // AFTER the fetch (setMessages replaced the list). No-op when none pending.
      reapplyOutboxBubbles("channel", channelId);
      // Writeback the authoritative window + stamp cursors (Caveat #29: only on
      // SUCCESS). Fire-and-forget; no-op off-iOS.
      cacheWriteChannel(workspaceState.current.id, channelId);
    }
  } catch (err) {
    // Leave activeId set so the channel can be retried (e.g. on reconnect).
    console.error("Failed to load channel messages:", err);
  } finally {
    if (channelState.activeId === channelId) channelState.loading = false;
  }
}

// Read-only preview of a PUBLIC channel the user has NOT joined. Mirrors the
// message-load half of selectChannel but deliberately skips EVERY joined-channel
// side effect: no mark-read, no badge/unread-flag clear, no read-cursor advance,
// no last-channel cache, no SQLite writeback. Seeding `previewChannel` is what
// makes `viewedChannel`/`isPreviewing` resolve so the header, empty-state and the
// "Join to participate" banner render for a non-member. The relay already lets any
// workspace member read a public channel's history (private channels are gated at
// fetch_messages), so no server change is needed.
export async function selectChannelPreview(channel: Channel): Promise<void> {
  if (!workspaceState.current) return;
  const channelId = channel.id;
  cancelActiveConversationBadgeClear();
  dmState.activePeerId = null;
  channelState.activeId = channelId;
  workspaceState.previewChannel = channel;
  // No unread divider in preview — a channel you haven't joined has no read
  // cursor to freeze from, and we must not advance one.
  channelState.setUnreadCursor(null);
  channelState.loading = true;
  channelState.messages = [];
  try {
    const { messages, hasMore } = await client.fetchMessages(workspaceState.current.id, channelId, {
      limit: 50,
    });
    // Guard against a stale response if the user navigated away mid-fetch.
    if (channelState.activeId === channelId) {
      channelState.setMessages(hydrateMessages(messages));
      channelState.hasMore = hasMore;
    }
  } catch (err) {
    console.error("Failed to load channel preview messages:", err);
  } finally {
    if (channelState.activeId === channelId) channelState.loading = false;
  }
}

export async function loadMoreMessages(): Promise<void> {
  if (
    !workspaceState.current ||
    !channelState.activeId ||
    !channelState.hasMore ||
    channelState.loading
  )
    return;
  channelState.loading = true;
  const oldest = channelState.messages[0];
  // Capture the target before the await: channelState is a singleton, so if the
  // user switches channel/workspace while the fetch is in flight, prepending the
  // result would inject the old channel's history into the new channel, and a
  // blind `loading = false` would clear the new channel's own loading state.
  const workspaceId = workspaceState.current.id;
  const channelId = channelState.activeId;
  try {
    const { messages, hasMore } = await client.fetchMessages(workspaceId, channelId, {
      before: oldest?.id,
      limit: 50,
    });
    if (workspaceState.current?.id === workspaceId && channelState.activeId === channelId) {
      channelState.prependMessages(hydrateMessages(messages), hasMore);
    }
  } catch (err) {
    // A failed page fetch must NOT wedge load-older. Without resetting `loading`
    // in finally, the scroll-up trigger (gated on !loading) dies for the rest of
    // the session, so older history can never load again and the chat looks
    // permanently "cut off". Surface the error; scrolling up retries. (Mirrors
    // loadMoreDmMessages, which already had this guard.)
    reportClientError({
      source: "loadMoreMessages",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      platform: "web",
    });
  } finally {
    // Only clear loading if we're still on the channel we fetched for — otherwise
    // we'd stomp the freshly-selected channel's own loading state.
    if (channelState.activeId === channelId) {
      channelState.loading = false;
    }
  }
}

// Send-status watchdog: if the server echo hasn't reconciled an optimistic
// local- row within this window, flip it to "failed" so a Retry affordance
// shows (reconciliation removes the local row, so the timer becomes a no-op).
// Surface-tagged so a channel send and a DM send each flip/sweep the right
// message list (channels and DMs share the same optimistic lifecycle).
const SEND_WATCHDOG_MS = 12_000;
type SendSurface = "channel" | "dm";
const sendWatchdogs = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; surface: SendSurface }
>();

function surfaceFor(surface: SendSurface): {
  setSendStatus: (id: string, s: "pending" | "sent" | "failed") => void;
  messages: { id: string }[];
} {
  return surface === "dm" ? dmState : channelState;
}

function armSendWatchdog(localId: string, surface: SendSurface): void {
  const existing = sendWatchdogs.get(localId);
  if (existing) clearTimeout(existing.timer);
  sendWatchdogs.set(localId, {
    surface,
    timer: setTimeout(() => {
      sendWatchdogs.delete(localId);
      // Only the still-unreconciled local row remains by id; reconciled rows have
      // a server id so setSendStatus no-ops on them.
      surfaceFor(surface).setSendStatus(localId, "failed");
      // #502: also flip the persisted-outbox snapshot so re-opening the surface
      // shows "failed" rather than a perpetual spinner (no-op for a non-rehydrated
      // send — its localId isn't tracked in pendingOutboxBubbles).
      patchPendingBubbleStatus(localId, "failed");
    }, SEND_WATCHDOG_MS),
  });
}

function clearSendWatchdog(localId: string): void {
  const t = sendWatchdogs.get(localId);
  if (t) clearTimeout(t.timer);
  sendWatchdogs.delete(localId);
}

// Reconciliation collapses an optimistic local- row into the server echo (by
// fromId+text), so its id vanishes from the list. Sweep any watchdog whose row
// is gone — that send succeeded, so it must never flip to "failed". Cheap: runs
// only when one of MY own messages echoes back, scoped to the echoing surface.
function sweepReconciledWatchdogs(surface: SendSurface): void {
  if (sendWatchdogs.size === 0) return;
  const live = new Set(surfaceFor(surface).messages.map((m) => m.id));
  for (const [localId, entry] of sendWatchdogs.entries()) {
    if (entry.surface === surface && !live.has(localId)) clearSendWatchdog(localId);
  }
}

// A unique client-generated id for optimistic reconciliation (#501). The relay
// echoes it on the broadcast so the sender settles the EXACT optimistic bubble —
// two identical consecutive sends / a retried send each match their own row.
function newClientMsgId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // crypto unavailable (older SSR) — fall through to the timestamp+random id.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function dispatchSend(
  localId: string,
  wsId: string,
  chId: string,
  text: string,
  mentions: string[] | undefined,
  attachments: Attachment[] | undefined,
  clientMsgId: string,
  // #602 — template-sourced send: ask the server to expand {channel}/{user}/{date}
  // on the live send. Not persisted on the offline outbox (a queued replay posts
  // the raw body), so it only affects the live path.
  expandTemplate?: boolean,
): void {
  channelState.setSendStatus(localId, "pending");
  // Keep a rehydrated bubble's snapshot in lockstep (e.g. Retry after reload).
  // No-op for a fresh send (its localId isn't tracked in pendingOutboxBubbles).
  patchPendingBubbleStatus(localId, "pending");
  armSendWatchdog(localId, "channel");
  try {
    // An open-but-unauthenticated socket (post-reconnect auth race) would accept
    // the raw send and have the relay silently drop it — treat it as a failure
    // so it's queued for replay after auth, not lost.
    if (!client.authenticated) throw new Error("not authenticated");
    client.sendMessage(
      wsId,
      chId,
      text,
      mentions,
      attachments,
      undefined,
      clientMsgId,
      expandTemplate,
    );
  } catch {
    // Socket down (e.g. relay deploying). Keep the optimistic bubble and queue a
    // replay for when we reconnect, instead of dropping the message. Persist it
    // (#502) so it survives a reload; the replay carries the SAME clientMsgId so
    // the broadcast echo reconciles the original optimistic copy (no dupe).
    enqueueOutbox({
      clientMsgId,
      userId: authState.user?.id ?? "unknown",
      kind: "channel",
      workspaceId: wsId,
      targetId: chId,
      text,
      mentions: mentions ?? null,
      attachments: attachments ?? null,
      parentId: null,
      createdAt: Date.now(),
    });
  }
}

export function sendMessage(
  text: string,
  mentions?: string[],
  attachments?: Attachment[],
  // #602 — the text came from a composer prompt template; the server expands
  // {channel}/{user}/{date} on send. The optimistic bubble shows the raw body
  // until the server's expanded broadcast echo reconciles it (same as a slash
  // command's optimistic → server-result flow).
  expandTemplate?: boolean,
): void {
  if (!workspaceState.current || !channelState.activeId) return;
  // Capture the target so a queued replay (after a deploy/reconnect) lands in
  // the right channel even if the user has since navigated away.
  const wsId = workspaceState.current.id;
  const chId = channelState.activeId;
  const myId = authState.user?.id ?? "unknown";
  const myName = authState.user?.name ?? authState.user?.email ?? "You";

  const clientMsgId = newClientMsgId();
  const localId = `local-${clientMsgId}`;
  channelState.addMessage({
    id: localId,
    channelId: chId,
    fromId: myId,
    fromType: "human",
    fromName: myName,
    text,
    mentions: mentions ?? [],
    attachments: attachments ?? null,
    sendStatus: "pending",
    clientMsgId,
    seq: 0,
    createdAt: Date.now(),
  });

  dispatchSend(localId, wsId, chId, text, mentions, attachments, clientMsgId, expandTemplate);
}

// #607: schedule a chat message to send later. Targets EXACTLY ONE of a channel
// or a DM peer (the composer passes whichever it's in). On success the created
// row is folded into the Scheduled-pane list (live if it's open) and returned so
// the composer can clear like a normal send; on failure the error is surfaced by
// the caller (the dialog). `sendAt` is epoch ms and must be in the future — the
// dialog gates this in the UI and the server re-validates.
export async function scheduleMessage(
  target: { channelId: string } | { toId: string },
  text: string,
  sendAt: number,
  mentions?: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!workspaceState.current) return { ok: false, error: "No workspace" };
  const wsId = workspaceState.current.id;
  try {
    const res = await client.scheduleMessageCreate({
      workspaceId: wsId,
      ...target,
      text,
      sendAt,
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
    });
    if (res.ok && res.message) scheduledMessagesState.upsert(res.message);
    return { ok: res.ok, error: res.error };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't schedule message" };
  }
}

// Re-attempt a failed optimistic send. Reuses the SAME local row AND its original
// clientMsgId (#501), so the eventual echo collapses exactly this bubble — resets
// it to "pending" and re-arms the watchdog.
export function retrySendMessage(localId: string): void {
  if (!workspaceState.current) return;
  const msg = channelState.messages.find((m) => m.id === localId);
  if (!msg || !localId.startsWith("local-")) return;
  const wsId = workspaceState.current.id;
  const chId = msg.channelId ?? channelState.activeId;
  if (!chId) return;
  // Pre-#501 rows (or any without one) get a fresh id — still reconciles by
  // fromId+text via the fallback.
  const clientMsgId = msg.clientMsgId ?? localId.replace(/^local-/, "");
  dispatchSend(
    localId,
    wsId,
    chId,
    msg.text,
    msg.mentions ?? undefined,
    msg.attachments ?? undefined,
    clientMsgId,
  );
}

export function pinMessage(messageId: string, pinned: boolean): void {
  if (!workspaceState.current || !channelState.activeId) return;
  // Optimistic: stamp/clear locally, reconcile from the broadcast.
  channelState.setPinned(
    messageId,
    pinned ? Date.now() : null,
    pinned ? (authState.user?.id ?? null) : null,
  );
  client
    .pinMessage(workspaceState.current.id, channelState.activeId, messageId, pinned)
    .catch(() => {
      channelState.setPinned(messageId, pinned ? null : Date.now(), null);
    });
}

// ─── Saved messages (#609 — personal bookmarks) ───────────────────
// Toggle a personal bookmark. Optimistic (the message row is in hand, so a save
// shows up in an already-loaded Saved view at once); the save_message broadcast
// reconciles across my devices and a failure reverts. The private analog of
// pinMessage, but works from ANY surface (channel, DM, thread, Saved view).
export function saveMessage(message: import("../core/types.js").Message, saved: boolean): void {
  if (!workspaceState.current) return;
  savedState.apply(message.id, saved, message);
  client.saveMessage(workspaceState.current.id, message.id, saved).catch(() => {
    // Revert the optimistic toggle on failure.
    savedState.apply(message.id, !saved, message);
  });
}

// Load my saved messages for the current workspace (newest-saved first). Mirrors
// fetchThreads: one-shot on Saved-view open, guarded against a workspace switch
// racing the response.
export async function loadSavedMessages(): Promise<void> {
  if (!workspaceState.current) return;
  const wsId = workspaceState.current.id;
  savedState.loading = true;
  try {
    const messages = await client.listSaved(wsId);
    if (workspaceState.current?.id === wsId) savedState.setList(messages);
  } catch {
    // Older relays may not support saved messages yet — leave the list empty.
  } finally {
    savedState.loading = false;
  }
}

// ─── /catchup digest (personal, ephemeral) ───────────────────────
// Drives the CatchupSheet overlay. The digest is NEVER persisted — it lives only
// here for the lifetime of the sheet. status: loading → ready (digest) | empty
// (all caught up) | error.
class CatchupState {
  open = $state(false);
  status = $state<"loading" | "ready" | "empty" | "error">("loading");
  channelId = $state<string | null>(null);
  channelName = $state("");
  digest = $state("");
  errorText = $state("");
  unreadCount = $state(0);

  // Open the sheet in its loading state for a freshly-dispatched /catchup.
  start(channelId: string, channelName: string): void {
    this.open = true;
    this.status = "loading";
    this.channelId = channelId;
    this.channelName = channelName;
    this.digest = "";
    this.errorText = "";
    this.unreadCount = 0;
  }

  // Apply an incoming catchup_result. Opens the sheet if it wasn't already (the
  // composer path doesn't pre-open). Ignores results for a different channel than
  // the one currently shown in the sheet (a stale digest from a prior run).
  resolve(p: {
    channelId: string;
    channelName: string;
    ok: boolean;
    text: string;
    unreadCount: number;
  }): void {
    if (this.open && this.channelId && this.channelId !== p.channelId) return;
    this.open = true;
    this.channelId = p.channelId;
    this.channelName = p.channelName;
    this.unreadCount = p.unreadCount;
    if (!p.ok && p.unreadCount === 0) {
      this.status = "empty";
      this.errorText = p.text;
      this.digest = "";
    } else if (!p.ok) {
      this.status = "error";
      this.errorText = p.text;
      this.digest = "";
    } else {
      this.status = "ready";
      this.digest = p.text;
      this.errorText = "";
    }
  }

  close(): void {
    this.open = false;
  }
}

export const catchupState = new CatchupState();

// /resume session picker (Phase 3/4). A CLIENT-only ephemeral sheet — like the
// /catchup digest — opened by intercepting /resume in the composer. It fans out
// to the existing restore_session (cloud archived restore, for everyone) and
// import_session (local transcript import, when a daemon serving the transcripts
// is reachable) RPCs; there is no server round-trip for /resume itself.
class ResumePickerState {
  open = $state(false);
  // The channel /resume was run from. Anchors an imported agent's binding to that
  // channel (parity with create_agent), so a session resumed from a channel lands
  // back there. Null when opened outside a channel context.
  channelId = $state<string | null>(null);

  start(channelId: string | null): void {
    this.open = true;
    this.channelId = channelId;
  }

  close(): void {
    this.open = false;
  }
}

export const resumePickerState = new ResumePickerState();

// Dispatch /catchup for a channel and open the digest sheet (loading). Shared by
// the composer's /catchup submit and the "Summarize new messages" unread-divider
// button. Resolves the target daemon the same way the composer does; surfaces a
// no-daemon / dispatch error in the sheet itself (never as channel noise).
export async function runCatchup(channelId: string, channelName: string): Promise<void> {
  const wsId = workspaceState.current?.id;
  if (!wsId || !channelId) return;
  // In-flight guard: a rapid double-click on the divider button or repeated
  // composer submits must not fire two digests. A loading sheet for THIS channel
  // is already running; ignore. (Re-running from the error state is still fine —
  // status is "error" there, not "loading".)
  if (catchupState.status === "loading" && catchupState.channelId === channelId) return;
  catchupState.start(channelId, channelName);
  const def = daemonState.defaultSlashDaemonId;
  const daemonId = def && daemonState.isOnline(def) ? def : undefined;
  try {
    const resp = await client.slashCommand(wsId, channelId, "catchup", undefined, daemonId);
    if (resp.systemAlert) {
      catchupState.resolve({
        channelId,
        channelName,
        ok: false,
        text: resp.systemAlert,
        unreadCount: 1,
      });
      return;
    }
    if (!resp.ok) {
      catchupState.resolve({
        channelId,
        channelName,
        ok: false,
        text: resp.error ?? "/catchup failed",
        unreadCount: 1,
      });
    }
    // ok: the digest arrives asynchronously via the catchup_result event.
  } catch (err) {
    catchupState.resolve({
      channelId,
      channelName,
      ok: false,
      text: err instanceof Error ? err.message : "/catchup failed",
      unreadCount: 1,
    });
  }
}

// ─── Threads ─────────────────────────────────────────────────────
class ThreadState {
  parentId: string | null = $state(null);
  parent: import("../core/types.js").Message | null = $state(null);
  replies: import("../core/types.js").Message[] = $state([]);
  loading = $state(false);

  // Thread-typing (#11 thread-typing): people composing a reply in THIS thread.
  // Same 5s auto-expire + dedup-by-fromId machinery ChannelState uses; rendered as
  // a TypingIndicator at the bottom of ThreadPanel. Routed here by client.on("typing")
  // only when the event's parentId matches the open thread.
  typing: import("../core/types.js").TypingEvent[] = $state([]);
  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  receiveReply(msg: import("../core/types.js").Message): void {
    if (!this.parentId || this.parentId !== msg.parentId) return;
    if (this.replies.find((m) => m.id === msg.id)) return;
    // clientMsgId-first reconciliation (#501), fallback to fromId+text.
    const localIdx = findOptimisticIndex(this.replies, msg);
    if (localIdx >= 0) {
      this.replies[localIdx] = msg;
      this.replies = this.replies.slice();
    } else {
      this.replies = [...this.replies, msg];
    }
  }

  addTyping(event: import("../core/types.js").TypingEvent): void {
    const existing = this.typingTimers.get(event.fromId);
    if (existing) clearTimeout(existing);

    if (!this.typing.find((t) => t.fromId === event.fromId)) {
      this.typing = [...this.typing, event];
    }

    this.typingTimers.set(
      event.fromId,
      setTimeout(() => {
        this.typing = this.typing.filter((t) => t.fromId !== event.fromId);
        this.typingTimers.delete(event.fromId);
      }, 5000),
    );
  }

  // Clear ONE sender's thread typing entry + timer when their reply arrives
  // (#515) — mirrors ChannelState/DmState.clearTypingFor.
  clearTypingFor(fromId: string): void {
    const timer = this.typingTimers.get(fromId);
    // No timer → not shown as typing → skip the reactive array reassign (runs on
    // every incoming thread reply; usually a no-op).
    if (!timer) return;
    clearTimeout(timer);
    this.typingTimers.delete(fromId);
    this.typing = this.typing.filter((t) => t.fromId !== fromId);
  }

  close(): void {
    this.parentId = null;
    this.parent = null;
    this.replies = [];
    this.loading = false;
    this.typing = [];
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
  }
}
export const threadState = new ThreadState();

export async function openThread(parent: import("../core/types.js").Message): Promise<void> {
  threadState.parentId = parent.id;
  threadState.parent = parent;
  threadState.replies = [];
  threadState.typing = [];
  threadState.loading = true;
  if (!workspaceState.current) return;
  try {
    const res = await client.fetchThread(workspaceState.current.id, parent.id);
    if (threadState.parentId !== parent.id) return;
    threadState.replies = res.messages;
    // Per-thread "New replies" divider (#7): freeze the divider cursor from the
    // server's last_viewed BEFORE we advance it. Captured once at open and kept
    // frozen (perThreadLastViewed snapshot), so marking the thread read here does
    // NOT make the divider vanish — it stays above the first reply newer than the
    // open-time cursor for the whole visit (same pattern as the channel divider).
    if (typeof res.lastViewed === "number") {
      threadsState.setPerThreadLastViewed(parent.id, res.lastViewed);
    }
    // Advance the server cursor + clear this thread's unread badge on open
    // (consistent with the existing mark_thread_read infra; divider stays frozen).
    markThreadRead(parent.id);
  } finally {
    threadState.loading = false;
  }
}

export function closeThread(): void {
  threadState.close();
}

// The other party of a DM root, from the current user's perspective: if I sent
// the root, the peer is its toId; otherwise the peer is its sender.
function dmCounterparty(
  root: import("../core/types.js").Message | null,
  myId: string,
): string | null {
  if (!root) return null;
  return root.fromId === myId ? (root.toId ?? null) : root.fromId;
}

export function sendThreadReply(
  text: string,
  mentions?: string[],
  attachments?: Attachment[],
): void {
  const parentId = threadState.parentId;
  if (!workspaceState.current || !parentId) return;
  // A thread can be rooted in a channel OR a DM (human or agent). The parent's
  // channelId is the source of truth: null → DM thread, routed via cyborg:dm to
  // the conversation peer so the reply reaches both participants and threads.
  // (Previously this required channelState.activeId and always sent through the
  // channel path, so DM thread replies silently never sent.)
  const parentChannelId = threadState.parent?.channelId ?? null;
  // For a DM thread the peer is the conversation's other party: the active DM
  // peer, falling back to the root's counterparty if no DM is open.
  const myId = authState.user?.id ?? "unknown";
  const dmPeerId = dmState.activePeerId ?? dmCounterparty(threadState.parent, myId);
  if (!parentChannelId && !dmPeerId) return;
  if (parentChannelId && !channelState.activeId) return;
  const myName = authState.user?.name ?? authState.user?.email ?? "You";
  const clientMsgId = newClientMsgId();
  const localId = `local-${clientMsgId}`;
  threadState.replies = [
    ...threadState.replies,
    {
      id: localId,
      channelId: parentChannelId,
      fromId: myId,
      fromType: "human",
      fromName: myName,
      toId: parentChannelId ? null : dmPeerId,
      text,
      mentions: mentions ?? [],
      parentId,
      attachments: attachments ?? null,
      clientMsgId,
      seq: 0,
      createdAt: Date.now(),
    },
  ];
  // NOTE: do NOT optimistically bump the reply count here — the broadcast echo of
  // this very reply already bumps it (channel_message / dm handler), so bumping
  // here too double-counted the author's own replies (3 showed as 6).
  try {
    sendThreadReplyOverWire({
      wsId: workspaceState.current.id,
      parentChannelId,
      dmPeerId,
      text,
      mentions,
      attachments,
      parentId,
      clientMsgId,
    });
  } catch {
    threadState.replies = threadState.replies.filter((m) => m.id !== localId);
  }
}

// Route a thread reply to the channel or DM transport. Split out of
// sendThreadReply to keep that function under the complexity budget.
function sendThreadReplyOverWire(opts: {
  wsId: string;
  parentChannelId: string | null;
  dmPeerId: string | null;
  text: string;
  mentions?: string[];
  attachments?: Attachment[];
  parentId: string;
  clientMsgId: string;
}): void {
  if (opts.parentChannelId) {
    client.sendMessage(
      opts.wsId,
      opts.parentChannelId,
      opts.text,
      opts.mentions,
      opts.attachments,
      opts.parentId,
      opts.clientMsgId,
    );
  } else if (opts.dmPeerId) {
    client.sendDm(
      opts.wsId,
      opts.dmPeerId,
      opts.text,
      opts.attachments,
      opts.parentId,
      opts.clientMsgId,
    );
  }
}

export async function selectDm(peerId: string): Promise<void> {
  // No workspace selected yet (e.g. fresh login before the layout finishes
  // restoring) — bail WITHOUT stranding activePeerId. The DM route effect also
  // depends on workspaceState.current, so it re-runs and fetches once the
  // workspace is set. (Previously this set activePeerId then returned, and the
  // guard below blocked any retry → the DM stayed permanently empty after a
  // fresh login.)
  if (!workspaceState.current) return;
  // Already selected this peer — don't refetch. (Must NOT also key this on
  // messages.length/loading: this runs inside the route $effect, which then
  // tracks those reads, so an empty or just-loaded DM would re-trigger the
  // effect and fetch again in a loop. The strand that needed a "refetch when
  // empty" escape hatch is already handled — we bail above before setting
  // activePeerId, and the effect re-runs when workspaceState.current is set.)
  if (dmState.activePeerId === peerId) return;
  // Switching to a DIFFERENT DM defuses any pending focus-driven clear so the DM
  // being left isn't marked read (re-selecting the SAME peer above returns early,
  // so a pure refocus on the open DM still clears it). See scheduleActiveConversationBadgeClear.
  cancelActiveConversationBadgeClear();
  dmState.activePeerId = peerId;
  // #17: opening a conversation counts as activity — bump it to the top of the
  // DM list (mirrors v1 bumpDmActivity on click). selectDm bailed above when no
  // workspace is set, so workspaceState.current is non-null here.
  dmActivityState.bump(workspaceState.current.id, peerId);
  // Cache-first cold render (iOS shell only — additive/safe). HIT → paint cached
  // window synchronously, no skeleton; MISS → null, exact prior behavior (clear).
  // On a peer SWITCH always clear first so the previous peer's messages never
  // bleed into the new peer's view — mergeServer is additive (deduplicates by id
  // only), so without the clear, peer A's messages survive alongside peer B's on
  // a cache-HIT switch. Mirrors selectChannel which uses setMessages (full replace)
  // on its HIT path. Same-peer re-entry returns early above, so this is always a
  // different peer when we reach here.
  dmState.messages = [];
  const cachedDm = coldPeekDm(peerId);
  if (cachedDm) {
    dmState.mergeServer(cachedDm);
  }
  dmState.hasMore = false;
  // Drop the previous DM's in-conversation typing line on switch.
  dmState.clearTyping();
  channelState.activeId = null;
  // Item 12: freeze the DM divider from the server read-cursor BEFORE this
  // visit's mark-read advances it (mirrors selectChannel). selectDm already
  // bailed above when no workspace is set, so workspaceState.current is non-null.
  const frozen = readCursorState.getDm(peerId);
  dmState.setUnreadCursor(frozen);
  notificationState.clear(workspaceState.current.id, peerId);
  // Persist DM read-state server-side (cross-device unread sync + frozen-divider
  // basis, Item 12). The relay also clears this DM's Activity items and
  // broadcasts back; mark optimistically here so the activity badge clears now.
  client.markDmRead(workspaceState.current.id, peerId);
  activityState.markReadByDmPeer(peerId);
  // Advance the LOCAL cursor to now so a later re-open snapshots the new value,
  // not the frozen copy this visit's divider holds (monotonic).
  readCursorState.advanceDm(peerId, Date.now());
  // On a cache HIT we already painted — keep the spinner off so there's no flash.
  // On a MISS, show the spinner exactly as before.
  dmState.loading = !cachedDm;
  const wsIdForFetch = workspaceState.current.id;
  // Cold-start resilience (#20 — intermittent "empty DM"). client.request()
  // waits for the socket to be OPEN *and* authenticated before sending, so a
  // throw here means a real failure: on a cold start the auth handshake +
  // first relay round-trip can blow the request timeout. The fetch was caught
  // and the DM left permanently blank — and the FIRST connect does NOT run
  // handleReconnect's DM self-heal (it's gated on a prior connection), so
  // nothing recovered it. Retry a few times with backoff, keeping the spinner
  // up (never flash the "beginning of your history" empty state on a transient
  // failure), and bail if the user moved to another peer/workspace meanwhile.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { messages, hasMore } = await client.fetchDmMessages(wsIdForFetch, peerId, {
        limit: 50,
      });
      if (dmState.activePeerId === peerId) {
        dmState.mergeServer(hydrateMessages(messages));
        dmState.hasMore = hasMore;
        // #502: re-show any still-pending persisted-outbox bubble for this DM
        // after the fetch merge. No-op when none pending.
        reapplyOutboxBubbles("dm", peerId);
        // Writeback the authoritative window + stamp cursors (only on SUCCESS).
        cacheWriteDm(wsIdForFetch, peerId);
      }
      break;
    } catch (err) {
      // Stale retry guard: a fast switch A→B must not let A's retry clobber B.
      if (dmState.activePeerId !== peerId || workspaceState.current?.id !== wsIdForFetch) break;
      if (attempt === 2) {
        console.error("Failed to load DM messages after retries:", err);
        break;
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  // Only clear loading if we're still on this peer — a fast switch A→B must
  // not let A's resolution flip B's spinner off and flash the empty state.
  if (dmState.activePeerId === peerId) dmState.loading = false;
}

export async function loadMoreDmMessages(): Promise<void> {
  if (!workspaceState.current || !dmState.activePeerId || !dmState.hasMore || dmState.loading)
    return;
  dmState.loading = true;
  const oldest = dmState.messages[0];
  try {
    const { messages, hasMore } = await client.fetchDmMessages(
      workspaceState.current.id,
      dmState.activePeerId,
      { before: oldest?.id, limit: 50 },
    );
    dmState.mergeServer(hydrateMessages(messages));
    dmState.hasMore = hasMore;
  } catch {
    // server may not support DM pagination yet
  } finally {
    dmState.loading = false;
  }
}

function dispatchDmSend(
  localId: string,
  wsId: string,
  peerId: string,
  text: string,
  attachments: Attachment[] | undefined,
  clientMsgId: string,
): void {
  dmState.setSendStatus(localId, "pending");
  // Keep a rehydrated bubble's snapshot in lockstep (Retry after reload). No-op
  // for a fresh send (its localId isn't tracked in pendingOutboxBubbles).
  patchPendingBubbleStatus(localId, "pending");
  armSendWatchdog(localId, "dm");
  try {
    // See sendMessage: an unauthenticated-but-open socket would drop this
    // silently, so force it into the outbox for replay after auth.
    if (!client.authenticated) throw new Error("not authenticated");
    client.sendDm(wsId, peerId, text, attachments, undefined, clientMsgId);
  } catch {
    // Socket down (e.g. relay deploying). Keep the optimistic bubble and queue a
    // replay for reconnect rather than dropping it. Persist it (#502) so it
    // survives a reload — same clientMsgId so the echo reconciles the original
    // bubble (no dupe).
    enqueueOutbox({
      clientMsgId,
      userId: authState.user?.id ?? "unknown",
      kind: "dm",
      workspaceId: wsId,
      targetId: peerId,
      text,
      mentions: null,
      attachments: attachments ?? null,
      parentId: null,
      createdAt: Date.now(),
    });
  }
}

export function sendDmMessage(text: string, attachments?: Attachment[]): void {
  if (!workspaceState.current || !dmState.activePeerId) return;
  const wsId = workspaceState.current.id;
  const peerId = dmState.activePeerId;
  const myId = authState.user?.id ?? "unknown";
  const myName = authState.user?.name ?? authState.user?.email ?? "You";
  // #17: an outgoing message bumps this peer to the top of the DM list, even when
  // no inbound message has arrived yet (Slack/WhatsApp parity).
  dmActivityState.bump(wsId, peerId);
  // Add the optimistic message FIRST, then send — so a failed send can roll it
  // back. (Previously the send ran first, so on failure the user saw nothing.)
  const clientMsgId = newClientMsgId();
  const localId = `local-${clientMsgId}`;
  dmState.addMessage({
    id: localId,
    channelId: null,
    fromId: myId,
    fromType: "human",
    fromName: myName,
    toId: peerId,
    text,
    attachments: attachments ?? null,
    sendStatus: "pending",
    clientMsgId,
    seq: 0,
    createdAt: Date.now(),
  });
  dispatchDmSend(localId, wsId, peerId, text, attachments, clientMsgId);
}

// Re-attempt a failed optimistic DM send. Reuses the SAME local row AND its
// original clientMsgId (#501), resetting it to "pending" + re-arming the
// watchdog. Mirrors retrySendMessage for the channel surface.
export function retrySendDmMessage(localId: string): void {
  if (!workspaceState.current || !dmState.activePeerId) return;
  const msg = dmState.messages.find((m) => m.id === localId);
  if (!msg || !localId.startsWith("local-")) return;
  const wsId = workspaceState.current.id;
  const peerId = msg.toId ?? dmState.activePeerId;
  if (!peerId) return;
  const clientMsgId = msg.clientMsgId ?? localId.replace(/^local-/, "");
  dispatchDmSend(localId, wsId, peerId, msg.text, msg.attachments ?? undefined, clientMsgId);
}

// parentId (#11 thread-typing): tag the event with the thread root so receivers
// route the indicator to the open thread panel. Rides along on channel OR DM typing.
export function sendTypingIndicator(parentId?: string): void {
  const ws = workspaceState.current;
  if (!ws) return;
  if (channelState.activeId) {
    client.sendTyping(ws.id, channelState.activeId, undefined, parentId);
    return;
  }
  // DM: route typing to the peer. Skip self-DM (never send typing to yourself).
  const peerId = dmState.activePeerId;
  if (peerId && peerId !== authState.user?.id) {
    client.sendTyping(ws.id, undefined, peerId, parentId);
  }
}

export function toggleReaction(messageId: string, emoji: string): void {
  if (!workspaceState.current) return;
  const myId = authState.user?.id;
  if (!myId) return;
  const myName = authState.user?.name ?? authState.user?.email ?? "You";

  const updateMessages = (messages: import("../core/types.js").Message[]) => {
    return messages.map((m) => {
      if (m.id !== messageId) return m;
      const reactions = [...(m.reactions ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === emoji);
      if (idx >= 0) {
        const r = reactions[idx];
        if (r.reacted) {
          if (r.count <= 1) {
            reactions.splice(idx, 1);
          } else {
            reactions[idx] = {
              ...r,
              count: r.count - 1,
              reacted: false,
              reactorNames: r.reactorNames?.filter((n) => n !== myName),
            };
          }
        } else {
          reactions[idx] = {
            ...r,
            count: r.count + 1,
            reacted: true,
            reactorNames: [...(r.reactorNames ?? []), myName],
          };
        }
      } else {
        reactions.push({ emoji, count: 1, reacted: true, reactorNames: [myName] });
      }
      return { ...m, reactions };
    });
  };

  channelState.messages = updateMessages(channelState.messages);
  dmState.messages = updateMessages(dmState.messages);

  client.sendReaction(workspaceState.current.id, messageId, emoji);
}

export async function editMessage(messageId: string, newText: string): Promise<void> {
  if (!workspaceState.current) return;

  const updateMessages = (messages: import("../core/types.js").Message[]) =>
    messages.map((m) => (m.id === messageId ? { ...m, text: newText, updatedAt: Date.now() } : m));

  channelState.messages = updateMessages(channelState.messages);
  dmState.messages = updateMessages(dmState.messages);

  try {
    await client.editMessage(workspaceState.current.id, messageId, newText);
  } catch (err) {
    // Optimistic edit applied above; the server rejected it, so the local copy
    // now diverges from the truth. Surface it instead of silently lying.
    reportClientError({
      source: "app.editMessage",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      platform: "web",
    });
    toast.error("Couldn't edit message");
  }
}

export async function deleteMessage(messageId: string): Promise<void> {
  if (!workspaceState.current) return;

  channelState.messages = channelState.messages.filter((m) => m.id !== messageId);
  dmState.messages = dmState.messages.filter((m) => m.id !== messageId);

  try {
    await client.deleteMessage(workspaceState.current.id, messageId);
  } catch (err) {
    // Optimistically removed above; the server rejected the delete, so the
    // message is gone locally but still live on the server. Surface it.
    reportClientError({
      source: "app.deleteMessage",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      platform: "web",
    });
    toast.error("Couldn't delete message");
  }
}

export async function updateWorkspace(updates: {
  name?: string;
  avatarUrl?: string | null;
  settings?: import("../core/types.js").WorkspaceSettings;
}): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.updateWorkspace(workspaceState.current.id, updates);
  if (updates.name) workspaceState.current.name = updates.name;
  if (updates.avatarUrl !== undefined) workspaceState.current.avatarUrl = updates.avatarUrl;
  if (updates.settings !== undefined) workspaceState.current.settings = updates.settings;
  const inList = workspaceState.list.find((w) => w.id === workspaceState.current!.id);
  if (inList) {
    if (updates.name) inList.name = updates.name;
    if (updates.avatarUrl !== undefined) inList.avatarUrl = updates.avatarUrl;
    if (updates.settings !== undefined) inList.settings = updates.settings;
  }
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  await client.deleteWorkspace(workspaceId);
  workspaceState.list = workspaceState.list.filter((w) => w.id !== workspaceId);
  if (workspaceState.current?.id === workspaceId) {
    const next = workspaceState.list[0];
    if (next) {
      await selectWorkspace(next);
    } else {
      workspaceState.current = null;
    }
  }
}

// App-Store Guideline 5.1.1(v): permanently delete the signed-in user's
// account. On success we tear down the saved session + all local state (via
// disconnectFromServer, which clears the saved session) and route to /login so
// the now-deleted session can't continue. Throws on failure so the UI can show
// an error and leave the user signed in.
export async function deleteAccount(): Promise<void> {
  await client.deleteAccount();
  disconnectFromServer();
  void goto("/login");
}

// A still-pending invitation row for the Members settings "Pending Invitations"
// section. Mirrors the relay's cyborg:list_pending_invitations payload.
export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  createdAt: number;
  expiresAt: number;
  createdByName?: string;
}

export async function inviteMember(
  email: string,
  role: "admin" | "member" | "viewer" = "member",
): Promise<{ invitationId: string; inviteUrl: string }> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  const { invitationId, inviteUrl } = await client.inviteMember(
    workspaceState.current.id,
    email,
    role,
  );
  const members = await client.listMembers(workspaceState.current.id);
  workspaceState.members = members;
  authState.setMemberImagesFromMembers(members);
  return { invitationId, inviteUrl };
}

export async function removeMember(userId: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.removeMember(workspaceState.current.id, userId);
  workspaceState.members = workspaceState.members.filter((m) => m.userId !== userId);
}

export async function updateMemberRole(
  userId: string,
  role: "admin" | "member" | "viewer",
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.updateRole(workspaceState.current.id, userId, role);
  workspaceState.members = workspaceState.members.map((m) =>
    m.userId === userId ? { ...m, role } : m,
  );
}

// ─── Invitations ──────────────────────────────────────────────────

// Admin/owner: load the workspace's still-pending invitations for the Members
// settings "Pending Invitations" section. Called on mount + after any
// invite/resend/cancel so the list (and each row's expiry countdown) stays
// fresh.
export async function listPendingInvitations(workspaceId?: string): Promise<PendingInvitation[]> {
  const wsId = workspaceId ?? workspaceState.current?.id;
  if (!wsId) throw new Error("No workspace selected");
  const { invitations } = await client.listPendingInvitations(wsId);
  return invitations;
}

// Re-issue a pending invitation: resets its 7-day expiry and re-sends the email.
export async function resendInvitation(
  invitationId: string,
  workspaceId?: string,
): Promise<{ invitationId: string; sentAt: number }> {
  const wsId = workspaceId ?? workspaceState.current?.id;
  if (!wsId) throw new Error("No workspace selected");
  return client.resendInvitation(wsId, invitationId);
}

// Revoke a pending invitation so its token can no longer be redeemed.
export async function cancelInvitation(
  invitationId: string,
  workspaceId?: string,
): Promise<{ invitationId: string }> {
  const wsId = workspaceId ?? workspaceState.current?.id;
  if (!wsId) throw new Error("No workspace selected");
  return client.cancelInvitation(wsId, invitationId);
}

// Public (unauthenticated) invitation preview for the /invite/:token landing
// page. Re-exported here so routes import everything invitation-related from
// the app state module (the single client surface).
export async function getInvitePreview(wsUrl: string, token: string): Promise<PublicInvitePreview> {
  return fetchInvitePreview(wsUrl, token);
}
export type { PublicInvitePreview } from "../core/client.js";

// Redeem an invitation token for the signed-in user. On success the user is now
// a member of `workspaceId`; refresh the local workspace list (the accept didn't
// re-run cyborg:auth) so the post-accept navigation into /workspace/:id finds it.
// Returns the joined workspaceId so the caller can navigate there.
export async function acceptInvitation(invitationToken: string): Promise<string> {
  const { workspaceId } = await client.acceptInvitation(invitationToken);
  // Subscribe this socket to the freshly-joined workspace's live broadcasts —
  // it wasn't part of the socket's auth-time subscription set.
  // intentional: best-effort live-broadcast subscribe on join; the awaited workspace-list refresh below gates navigation.
  client.subscribeWorkspace(workspaceId).catch(() => {});
  // Refresh the workspace list from server truth so the new membership appears
  // in workspaceState.list (selectWorkspace + the /workspace/:id layout look it
  // up there). Best-effort — the layout falls back to /workspace if absent.
  try {
    const workspaces = await client.fetchWorkspaces();
    workspaceState.list = workspaces;
  } catch {
    // Older relay or transient failure — append a minimal entry so navigation
    // into the workspace still resolves.
    if (!workspaceState.list.some((w) => w.id === workspaceId)) {
      workspaceState.list = [
        ...workspaceState.list,
        {
          id: workspaceId,
          name: "Workspace",
          ownerId: "",
          avatarUrl: null,
          role: "member",
          createdAt: Date.now(),
          settings: {},
        },
      ];
    }
  }
  return workspaceId;
}

// ─── Agent actions ────────────────────────────────────────────────

export async function fetchProviders(daemonId?: string): Promise<void> {
  if (daemonId) {
    if (providerState.loadingDaemons[daemonId]) return; // already in flight for this daemon
    providerState.loadingDaemons = { ...providerState.loadingDaemons, [daemonId]: true };
    // Stale-while-revalidate: serve the cached catalog for this daemon
    // immediately (instant provider rows on revisit) while the fetch below
    // refreshes it in the background.
    const cached = providerState.byDaemon[daemonId];
    if (cached) providerState.list = cached;
  }
  providerState.loading = true;
  try {
    const list = await client.listProviders(daemonId ? { daemonId } : undefined);
    providerState.list = list;
    // Keep the per-daemon catalog so daemon-aware surfaces (agent session model
    // menu) don't read a catalog that an arbitrary daemon answered.
    if (daemonId) providerState.byDaemon = { ...providerState.byDaemon, [daemonId]: list };
  } catch {
    providerState.list = [];
  } finally {
    providerState.loading = false;
    if (daemonId) {
      providerState.loadingDaemons = { ...providerState.loadingDaemons, [daemonId]: false };
    }
  }
}

export async function fetchRecentCwds(
  daemonId?: string,
): Promise<{ home: string; recent: string[] }> {
  return client.listRecentCwds(daemonId ? { daemonId } : undefined);
}

export async function createAgent(
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
  if (!workspaceState.current) throw new Error("No workspace selected");
  let agent: Agent;
  try {
    agent = await client.createAgent(workspaceState.current.id, provider, cwd, opts);
  } catch (err) {
    handleLicenseError(err);
    throw err;
  }
  workspaceState.agents = [...workspaceState.agents, agent];
  return agent;
}

export async function fetchCybos(): Promise<void> {
  if (!workspaceState.current) return;
  const wsId = workspaceState.current.id;
  cyboState.loading = true;
  try {
    cyboState.list = await client.fetchCybos(wsId);
  } catch {
    cyboState.list = [];
  } finally {
    cyboState.loading = false;
  }
  // fetch_cybos is DAEMON_FORWARD; on cold start the embedded daemon isn't
  // connected yet → []. Without this, cybo avatars (and names) stay missing
  // until a manual reload. Retry on a short backoff (mirrors retryAgentsOnEmpty).
  if (cyboState.list.length === 0) void retryCybosOnEmpty(wsId);
}

async function retryCybosOnEmpty(workspaceId: string): Promise<void> {
  // fetch_cybos is DAEMON_FORWARD: after a hard reload the embedded daemon can
  // take well over the old 4×1.5s window to re-attach to the relay, so the
  // retry gave up and 'Your templates' stayed empty until a manual reload.
  // Back off exponentially (1s → 5s cap, ~30s total); the daemon_status
  // offline→online self-heal covers anything slower than that.
  for (let attempt = 0; attempt < 8; attempt++) {
    const delay = Math.min(1000 * 1.5 ** attempt, 5000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (workspaceState.current?.id !== workspaceId || cyboState.list.length > 0) return;
    try {
      const cybos = await client.fetchCybos(workspaceId);
      if (workspaceState.current?.id === workspaceId && cybos.length > 0) {
        cyboState.list = cybos;
        return;
      }
    } catch {
      // intentional: one attempt in a cold-start backoff retry loop; the loop
      // tries again and the daemon_status self-heal is the backstop.
    }
  }
}

export async function createCybo(opts: {
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
  monthlySpendCap?: number | null;
  platformPermissions?: string[];
  mcpServers?: Record<string, unknown> | null;
}): Promise<string> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  const created = await client.createCybo(workspaceState.current.id, opts);
  cyboState.list = await client.fetchCybos(workspaceState.current.id);
  return created.id;
}

export async function updateCybo(
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
    monthlySpendCap?: number | null;
    platformPermissions?: string[];
    mcpServers?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.updateCybo(workspaceState.current.id, cyboId, fields);
  cyboState.list = await client.fetchCybos(workspaceState.current.id);
}

export async function deleteCybo(cyboId: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.deleteCybo(workspaceState.current.id, cyboId);
  cyboState.list = cyboState.list.filter((c) => c.id !== cyboId);
}

// ─── Provider credentials (api-key cybos — internal docs + 43) ────────
//
// Thin wrappers over the daemon-forwarded credential RPCs. The key is write-only:
// `listProviderAuth` returns set/not-set METADATA only (no secret ever reaches the
// client). `daemonId` is the daemon that holds the credential (each daemon has its
// own per-machine store).

export async function setCyboCredential(
  daemonId: string,
  providerId: string,
  credential: ProviderCredentialPayload,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.setCyboCredential(workspaceState.current.id, daemonId, providerId, credential);
}

export async function removeCyboCredential(daemonId: string, providerId: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.removeCyboCredential(workspaceState.current.id, daemonId, providerId);
}

export async function listProviderAuth(daemonId: string): Promise<ProviderAuthMeta[]> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  return client.listProviderAuth(workspaceState.current.id, daemonId);
}

// Single cybo WITH soul — used by the editor/detail view to lazy-load the
// personality (the list omits it).
export async function fetchCybo(
  cyboId: string,
): Promise<Awaited<ReturnType<typeof client.fetchCybo>>> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  return client.fetchCybo(workspaceState.current.id, cyboId);
}

// Import a local (disk) cybo into the workspace DB, then refresh the list.
export async function importCybo(slug: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.importCybo(workspaceState.current.id, slug);
  cyboState.list = await client.fetchCybos(workspaceState.current.id);
}

export async function spawnCybo(
  cyboIdOrSlug: string,
  cwd: string | undefined,
  opts?: { channelId?: string; daemonId?: string },
): Promise<string> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  let result: { agentId: string };
  try {
    result = await client.spawnCybo(workspaceState.current.id, cyboIdOrSlug, cwd, opts);
  } catch (err) {
    handleLicenseError(err);
    throw err;
  }
  const agents = await client.listAgents(workspaceState.current.id);
  workspaceState.agents = agents;
  return result.agentId;
}

// List importable local provider sessions (on-disk Claude/Codex/… sessions the
// daemon has not yet imported) for the session-import picker. Thin pass-through
// to the client; the picker drives the actual import via importSession() below.
export async function fetchRecentProviderSessions(opts?: {
  cwd?: string;
  limit?: number;
}): Promise<RecentSession[]> {
  return client.fetchRecentProviderSessions(opts);
}

export async function importSession(opts: {
  providerId?: string;
  providerHandleId?: string;
  sessionId?: string;
  cwd?: string;
}): Promise<string> {
  const { agentId } = await client.importSession(opts);
  const agents = await client.listAgents(workspaceState.current!.id);
  workspaceState.agents = agents;
  return agentId;
}

export async function sendAgentPrompt(
  agentId: string,
  prompt: string,
  attachments?: Attachment[],
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  agentStreamState.addUserMessage(agentId, prompt);
  try {
    await client.sendAgentPrompt(workspaceState.current.id, agentId, prompt, attachments);
  } catch (err) {
    handleLicenseError(err);
    const msg = err instanceof Error ? err.message : "Failed to send";
    agentStreamState.handleEvent(agentId, {
      type: "turn_failed",
      provider: "unknown",
      error: msg,
    } as AgentEvent);
    throw err;
  }
}

// Wire the prompt-queue flush: when a turn completes, AgentStreamState dequeues
// the next queued prompt and sends it through the normal path (which holds the
// WS client). Registered once at module load.
agentStreamState.setPromptSender((agentId, prompt, attachments) => {
  // sendAgentPrompt surfaces failures via a turn_failed event, but it also
  // re-throws — catch here so the queue flush never produces an unhandled
  // rejection (which can break strict/Electron runtimes).
  sendAgentPrompt(agentId, prompt, attachments).catch((err) => {
    console.error("Failed to send queued agent prompt:", err);
  });
});

export function respondToPermission(
  agentId: string,
  permissionRequestId: string,
  response: AgentPermissionResponse,
): void {
  if (!workspaceState.current) return;
  client.respondToPermission(workspaceState.current.id, agentId, permissionRequestId, response);
}

export function cancelAgent(agentId: string): void {
  if (!workspaceState.current) return;
  client.cancelAgent(workspaceState.current.id, agentId);
}

export async function deleteAgent(agentId: string): Promise<void> {
  await client.deleteAgent(agentId);
  agentStreamState.clear(agentId);
  workspaceState.agents = workspaceState.agents.filter((a) => a.agentId !== agentId);
}

export async function archiveAgent(agentId: string): Promise<string> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  const sessionId = await client.archiveAgent(workspaceState.current.id, agentId);
  agentStreamState.clear(agentId);
  workspaceState.agents = workspaceState.agents.filter((a) => a.agentId !== agentId);
  await fetchSessions();
  return sessionId;
}

// Reload/restart a wedged session in place (#592): recover a hung/desynced agent
// keeping its agentId and identity. rehydrateFromDisk re-streams the provider
// history; the fresh stream arrives via the existing agent_stream subscription,
// so no local timeline surgery is needed here.
export async function reloadSession(
  agentId: string,
  opts?: { rehydrateFromDisk?: boolean },
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.reloadSession(workspaceState.current.id, agentId, opts);
  // A rehydrate wipes the daemon's in-memory timeline, mints a new epoch and
  // re-streams provider history. Drop the stale local stream so it rebuilds
  // from the fresh server timeline instead of the re-stream piling ON TOP of
  // the old items (thread_started doesn't reset the timeline) — same model as
  // the workspace-switch clear. Non-rehydrate reloads preserve the timeline, so
  // only clear when rehydrating.
  if (opts?.rehydrateFromDisk) agentStreamState.clear(agentId);
}

export async function restoreSession(
  sessionId: string,
  overrides?: ResumeOverrides,
): Promise<string> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  // Carry the archived session's owning daemon (stamped by the relay) so the
  // restore scopes + routes to the daemon that holds it (#593). Absent in
  // single-daemon flows, where the relay resolves the sole online daemon.
  const daemonId = sessionState.list.find((s) => s.id === sessionId)?.daemonId ?? undefined;
  // Only forward override fields the caller actually set, so an empty/absent
  // object resumes exactly as before.
  const hasOverrides =
    !!overrides &&
    (overrides.model !== undefined ||
      overrides.modeId !== undefined ||
      overrides.thinkingOptionId !== undefined);
  const agentId = await client.restoreSession(workspaceState.current.id, sessionId, {
    daemonId,
    overrides: hasOverrides ? overrides : undefined,
  });
  const agents = await client.listAgents(workspaceState.current.id);
  workspaceState.agents = agents;
  await fetchSessions();
  return agentId;
}

// Import a LOCAL provider transcript into the active workspace via the new Cyborg
// path (cyborg:import_session) and refresh the roster + archived-session lists,
// mirroring restoreSession's post-resume bookkeeping. No daemonId is passed: a
// scanned RecentSession carries none, so the relay resolves the sole online
// workspace daemon (exactly like a no-daemonId restore). Returns the live agent
// id so the caller can navigate to it.
export async function importProviderSession(opts: {
  provider: string;
  providerHandleId: string;
  cwd?: string;
  channelId?: string;
}): Promise<string> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  const wsId = workspaceState.current.id;
  const { agentId } = await client.importSessionCyborg({
    workspaceId: wsId,
    provider: opts.provider,
    providerHandleId: opts.providerHandleId,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.channelId ? { channelId: opts.channelId } : {}),
  });
  const agents = await client.listAgents(wsId);
  workspaceState.agents = agents;
  await fetchSessions();
  return agentId;
}

// daemonId routes the control RPC straight to the agent's owning daemon (#843
// Gap B), avoiding the daemon_agents binding race on a freshly-created session.
export async function setAgentModel(
  agentId: string,
  modelId: string | null,
  daemonId?: string,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.setAgentModel(workspaceState.current.id, agentId, modelId, daemonId);
  // Optimistically reflect the switch — the server's model_changed event doesn't
  // reliably reach cloud guests, so the selector would otherwise stay stale.
  agentStreamState.setModel(agentId, modelId);
}

export async function setAgentMode(
  agentId: string,
  modeId: string,
  daemonId?: string,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.setAgentMode(workspaceState.current.id, agentId, modeId, daemonId);
  // Optimistically reflect the switch (same as setAgentModel) so the mode pill —
  // and its bypass danger styling — update immediately on every provider, even
  // when the server's mode_changed event doesn't reach cloud guests.
  agentStreamState.setModeId(agentId, modeId);
}

export async function setAgentThinking(
  agentId: string,
  thinkingOptionId: string | null,
  daemonId?: string,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.setAgentThinking(workspaceState.current.id, agentId, thinkingOptionId, daemonId);
  // Optimistically reflect the switch — the thinking_option_changed event shares
  // model_changed's cloud-guest unreliability, so the selector would otherwise
  // keep showing the previous value after a change.
  agentStreamState.setThinkingOption(agentId, thinkingOptionId);
}

// 'Rewind to here' (#649): expose Paseo's session rewind for cybos. The server
// truncates the provider session to before `messageId` (a Paseo timeline
// user-message id) and re-broadcasts the truncated timeline. We then re-fetch +
// re-hydrate so the stream view reflects the truncation immediately — the
// broadcast alone only appends, it can't shrink the local entry list.
export async function rewindAgent(agentId: string, messageId: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  const wsId = workspaceState.current.id;
  await client.rewindAgent(wsId, agentId, messageId);
  // Guard against a stale workspace (mirrors the pattern used across this file):
  // the user may have switched workspaces while the rewind RPC was in flight.
  // Bail BEFORE issuing the re-fetch so we don't fire a cross-workspace timeline
  // request — and re-check after the await in case the switch lands mid-fetch
  // (don't hydrate the wrong session's stream).
  if (workspaceState.current?.id !== wsId) return;
  try {
    const { items } = await client.fetchAgentTimeline(wsId, agentId);
    if (workspaceState.current?.id !== wsId) return;
    agentStreamState.hydrateFromTimeline(agentId, items);
  } catch {
    // The rewind itself succeeded; a failed re-fetch just leaves the stale view —
    // a reconnect/remount re-hydrates from server truth.
  }
}

export async function fetchAgentCommands(agentId: string): Promise<AgentSlashCommand[]> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  return client.listAgentCommands(workspaceState.current.id, agentId);
}

// #581: @-file/dir autocomplete in the agent composer. Returns file/directory
// entries from the agent's workspace cwd matching the text typed after `@`.
export async function fetchAgentFileSuggestions(
  agentId: string,
  query: string,
): Promise<{ path: string; kind: "file" | "directory" }[]> {
  if (!workspaceState.current) return [];
  return client.getAgentDirectorySuggestions(workspaceState.current.id, agentId, query);
}

export async function fetchSessions(): Promise<void> {
  if (!workspaceState.current) return;
  const wsId = workspaceState.current.id;
  sessionState.loading = true;
  // Reset paging state for the new fetch so a stale "load more" in flight can't
  // leave the affordance stuck.
  sessionState.loadingMore = false;
  try {
    // Page 1 only — older history loads on demand via loadMoreSessions("Show more")
    // so the panes never render the full unbounded archive at once.
    const page = await client.listArchivedSessions(wsId, { limit: ARCHIVED_SESSIONS_PAGE_SIZE });
    // Workspace-switch race: a switch mid-fetch must not overwrite the new
    // workspace's list with this (now stale) response.
    if (workspaceState.current?.id !== wsId) return;
    sessionState.list = page.sessions;
    sessionState.nextCursor = page.nextCursor;
    sessionState.fetched = true;
  } catch {
    if (workspaceState.current?.id !== wsId) return;
    sessionState.list = [];
    sessionState.nextCursor = null;
    sessionState.fetched = true;
  } finally {
    sessionState.loading = false;
  }
  // Cold-start race: archived sessions are answered by the embedded daemon
  // (DAEMON_FORWARD); on launch it may not be connected to the relay yet, so the
  // first fetch returns []. The sidebar fetch is one-shot, so without a retry the
  // empty list sticks until a manual reload. Retry on a short backoff until the
  // daemon answers (mirrors retryAgentsOnEmpty).
  if (sessionState.list.length === 0) void retrySessionsOnEmpty(wsId);
}

// Append the next (older) page of archived sessions. No-op when already loading
// or when there is no further page (nextCursor === null). Errors are swallowed to
// a stable list (the button simply stays — a transient relay hiccup retries on the
// next click) since this is an additive load, not the primary fetch.
export async function loadMoreSessions(): Promise<void> {
  if (!workspaceState.current) return;
  const wsId = workspaceState.current.id;
  const cursor = sessionState.nextCursor;
  if (!cursor || sessionState.loadingMore) return;
  sessionState.loadingMore = true;
  try {
    const page = await client.listArchivedSessions(wsId, {
      limit: ARCHIVED_SESSIONS_PAGE_SIZE,
      cursor,
    });
    if (workspaceState.current?.id !== wsId) return;
    // Guard against duplicates if a concurrent refetch already merged some ids.
    const seen = new Set(sessionState.list.map((s) => s.id));
    sessionState.list = [...sessionState.list, ...page.sessions.filter((s) => !seen.has(s.id))];
    sessionState.nextCursor = page.nextCursor;
  } catch {
    // Keep the current list + cursor so the user can retry the "Show more" click.
  } finally {
    // Only clear loadingMore if we're still on the workspace we started on — a
    // workspace switch mid-load owns its own loadingMore lifecycle now.
    if (workspaceState.current?.id === wsId) sessionState.loadingMore = false;
  }
}

async function retrySessionsOnEmpty(workspaceId: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (workspaceState.current?.id !== workspaceId || sessionState.list.length > 0) return;
    try {
      const page = await client.listArchivedSessions(workspaceId, {
        limit: ARCHIVED_SESSIONS_PAGE_SIZE,
      });
      if (workspaceState.current?.id === workspaceId && page.sessions.length > 0) {
        sessionState.list = page.sessions;
        sessionState.nextCursor = page.nextCursor;
        return;
      }
    } catch {
      // intentional: one attempt in a cold-start backoff retry loop; the loop
      // tries again and the daemon_status self-heal is the backstop.
    }
  }
}

// ─── Project actions ─────────────────────────────────────────────

export async function createWorkspace(name: string): Promise<Workspace> {
  const ws = await client.createWorkspace(name);
  workspaceState.list = [
    ...workspaceState.list,
    {
      id: ws.id,
      name: ws.name,
      ownerId: ws.ownerId ?? "",
      avatarUrl: null,
      role: "owner",
      createdAt: ws.createdAt ?? Date.now(),
      settings: {},
    },
  ];
  return ws;
}

// ─── Projects warm cache (fix: prevent flash-of-blank on swipe-back) ────────
//
// Projects/channelProjectMap used to live in ChannelSidebar component-local
// $state and was re-fetched from the network on EVERY mount.  On mobile the
// "Projects" tab (/chats) and "Team" tab (/dms) are separate routes, so
// swipe-back unmounts the sidebar.  On remount projects=[] until the async
// fetch resolves (~200-400 ms) — causing blank/incomplete project headers
// because channels are WARM (in global workspaceState) but projects were cold.
//
// Fix: a module-level Map keyed by wsId.  On first fetch the result is written
// here; subsequent sidebar mounts read it synchronously so projects paint on
// the FIRST frame.  A background refresh fires on every mount and swaps in
// fresh data when it lands — no visible gap.  Mutations (create/edit/delete)
// write back immediately so a later remount reflects them.  On workspace switch
// the stale workspace's entry is cleared; on logout all entries are wiped.

export interface ProjectsCacheEntry {
  // createdAt is optional to match the component-local Project interface in ChannelSidebar.
  projects: { id: string; name: string; color: string; createdAt?: number }[];
  channelProjectMap: Map<string, string>;
}

class ProjectsWarmCache {
  private _cache = $state<Map<string, ProjectsCacheEntry>>(new Map());

  get(wsId: string): ProjectsCacheEntry | undefined {
    return this._cache.get(wsId);
  }

  set(wsId: string, entry: ProjectsCacheEntry): void {
    const next = new Map(this._cache);
    next.set(wsId, entry);
    this._cache = next;
  }

  delete(wsId: string): void {
    if (!this._cache.has(wsId)) return;
    const next = new Map(this._cache);
    next.delete(wsId);
    this._cache = next;
  }

  clear(): void {
    this._cache = new Map();
  }
}

export const projectsCache = new ProjectsWarmCache();

export async function fetchProjects(): Promise<{
  projects: { id: string; name: string; color: string; createdAt: number }[];
  channelProjects: { channelId: string; projectId: string }[];
}> {
  if (!workspaceState.current) return { projects: [], channelProjects: [] };
  const wsId = workspaceState.current.id;
  const result = await client.fetchProjects(wsId);
  // Populate the warm cache so subsequent sidebar mounts paint instantly.
  projectsCache.set(wsId, {
    projects: result.projects,
    channelProjectMap: new Map(result.channelProjects.map((cp) => [cp.channelId, cp.projectId])),
  });
  return result;
}

export async function createProject(name: string, color: string): Promise<string> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  const project = await client.createProject(workspaceState.current.id, name, color);
  return project.id;
}

export async function updateProject(projectId: string, name: string, color: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.updateProject(workspaceState.current.id, projectId, name, color);
}

export async function deleteProject(projectId: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.deleteProject(workspaceState.current.id, projectId);
}

export async function setChannelProject(
  channelId: string,
  projectId: string | null,
): Promise<void> {
  const wsId = workspaceState.current?.id;
  if (!wsId) throw new Error("no active workspace");
  await client.setChannelProject(wsId, channelId, projectId);
}

// ─── Channel management ─────────────────────────────────────────

export async function createChannel(
  name: string,
  opts?: {
    description?: string;
    isPrivate?: boolean;
    instructions?: string;
    projectId?: string | null;
  },
): Promise<import("../core/types.js").Channel | null> {
  if (!workspaceState.current) return null;
  const ch = await client.createChannel(workspaceState.current.id, name, {
    description: opts?.description,
    isPrivate: opts?.isPrivate,
    instructions: opts?.instructions,
  });
  const channel = { ...ch, projectId: null as string | null };
  if (!workspaceState.channels.some((c) => c.id === channel.id)) {
    workspaceState.channels = [...workspaceState.channels, channel];
  }
  if (opts?.projectId) {
    // Persist the channel→project link. This used to be fire-and-forget with the
    // failure swallowed by an empty arrow catch, so a transient failure dropped
    // the project and the channel reverted to "no project" on reload. Retry with
    // backoff and SURFACE a real failure instead of hiding it.
    const projectId = opts.projectId;
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt += 1) {
      try {
        await client.setChannelProject(channel.workspaceId, channel.id, projectId);
        saved = true;
      } catch (err) {
        if (attempt === 2) {
          console.warn("createChannel: failed to assign project after retries", err);
        } else {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        }
      }
    }
    // Only reflect the project AFTER the server accepted it — never show a state
    // the server rejected (avoids the under-project → Unfiled flicker on a failed
    // save). Per Gemini review: update post-await, not optimistically.
    if (saved) {
      channel.projectId = projectId;
      // Update the channel IN the array by id: if a concurrent channel_created
      // broadcast already inserted a DIFFERENT object, mutating our local ref
      // wouldn't reach the sidebar. (Gemini review.)
      workspaceState.channels = workspaceState.channels.map((c) =>
        c.id === channel.id ? { ...c, projectId } : c,
      );
    }
  }
  return channel;
}

// #608: start a group DM with the given OTHER members (the creator is implicit).
// The server validates membership + the 2–8 cap and derives the auto-name; the
// returned hidden group_dm channel is added to our sidebar immediately (the
// broadcast adds it for the other members). Returns the new channel, or null if
// there is no active workspace.
export async function createGroupDm(
  participants: string[],
): Promise<import("../core/types.js").Channel | null> {
  if (!workspaceState.current) return null;
  const ch = await client.createGroupDm(workspaceState.current.id, participants);
  if (!workspaceState.channels.some((c) => c.id === ch.id)) {
    workspaceState.channels = [...workspaceState.channels, ch];
  }
  return ch;
}

export async function updateChannel(
  channelId: string,
  updates: {
    name?: string;
    description?: string | null;
    isPrivate?: boolean;
    instructions?: string | null;
  },
): Promise<void> {
  if (!workspaceState.current) return;
  const ch = await client.updateChannel(workspaceState.current.id, channelId, updates);
  workspaceState.channels = workspaceState.channels.map((c) => (c.id === ch.id ? ch : c));
}

export async function deleteChannel(channelId: string): Promise<void> {
  if (!workspaceState.current) return;
  await client.deleteChannel(workspaceState.current.id, channelId);
  workspaceState.channels = workspaceState.channels.filter((c) => c.id !== channelId);
  if (channelState.activeId === channelId) {
    channelState.activeId = null;
  }
}

// Archive (soft-delete) vs deleteChannel: preserves the channel + history but
// hides it from the active list. Mirrors deleteChannel's local reconciliation
// when archiving (drop from sidebar / clear active selection); unarchive re-adds
// it from the returned channel.
export async function archiveChannel(channelId: string, archived: boolean): Promise<void> {
  if (!workspaceState.current) return;
  const ch = await client.archiveChannel(workspaceState.current.id, channelId, archived);
  if (archived) {
    workspaceState.channels = workspaceState.channels.filter((c) => c.id !== channelId);
    notificationState.clear(workspaceState.current.id, channelId);
    unreadFlagState.clearUnread(workspaceState.current.id, channelId);
    if (channelState.activeId === channelId) {
      channelState.activeId = null;
    }
  } else if (ch) {
    // Unarchived: re-insert (or update) the channel in the active list.
    const exists = workspaceState.channels.some((c) => c.id === ch.id);
    workspaceState.channels = exists
      ? workspaceState.channels.map((c) => (c.id === ch.id ? ch : c))
      : [...workspaceState.channels, ch];
  }
}

// Caller's role in a channel from the real channel_roles table ("admin" |
// "member" | null). Replaces the createdBy === myId admin heuristic.
export async function getChannelRole(channelId: string): Promise<string | null> {
  if (!workspaceState.current) return null;
  return client.getChannelRole(workspaceState.current.id, channelId);
}

// Lightweight file count for the Files tab badge. Fail-soft: returns 0 if the
// workspace context is missing (the badge just shows nothing).
export async function getChannelFileCount(channelId: string): Promise<number> {
  if (!workspaceState.current) return 0;
  return client.getChannelFileCount(workspaceState.current.id, channelId);
}

export async function fetchChannelMembers(
  channelId: string,
): Promise<import("../core/types.js").ChannelMember[]> {
  if (!workspaceState.current) return [];
  return client.fetchChannelMembers(workspaceState.current.id, channelId);
}

export async function addChannelMember(channelId: string, userId: string): Promise<void> {
  if (!workspaceState.current) return;
  await client.addChannelMember(workspaceState.current.id, channelId, userId);
}

export async function removeChannelMember(channelId: string, userId: string): Promise<void> {
  if (!workspaceState.current) return;
  await client.removeChannelMember(workspaceState.current.id, channelId, userId);
}

// ── Cybo channel membership (W3) ──
export async function fetchChannelCybos(channelId: string): Promise<string[]> {
  if (!workspaceState.current) return [];
  return client.fetchChannelCybos(workspaceState.current.id, channelId);
}

export async function addChannelCybo(channelId: string, cyboId: string): Promise<void> {
  if (!workspaceState.current) return;
  await client.addChannelCybo(workspaceState.current.id, channelId, cyboId);
}

export async function removeChannelCybo(channelId: string, cyboId: string): Promise<void> {
  if (!workspaceState.current) return;
  await client.removeChannelCybo(workspaceState.current.id, channelId, cyboId);
}

export async function leaveChannel(channelId: string): Promise<void> {
  if (!workspaceState.current || !authState.user) return;
  // Capture the channel before we drop it from the list — we need it to decide
  // the post-leave view (preview vs. nothing).
  const left = workspaceState.channels.find((c) => c.id === channelId);
  await client.removeChannelMember(workspaceState.current.id, channelId, authState.user.id);
  // Slack model: the sidebar shows only channels you're a member of, so leaving
  // any channel (public or private) removes it from your sidebar.
  workspaceState.channels = workspaceState.channels.filter((c) => c.id !== channelId);
  notificationState.clear(workspaceState.current.id, channelId);
  unreadFlagState.clearUnread(workspaceState.current.id, channelId);
  if (channelState.activeId === channelId) {
    // We were viewing the channel we just left. If it's public, drop straight into
    // the read-only preview (with a Join CTA to rejoin) rather than a dead-end
    // "Select a channel". Private channels can't be previewed, so clear selection.
    if (left && !left.isPrivate) {
      selectChannelPreview(left);
    } else {
      channelState.activeId = null;
    }
  }
}

// ─── Shared Files (M-files) ─────────────────────────────────────
// Cursor pagination (newest-first). Fail-soft: the panel shows an inline error
// rather than throwing into the UI tree.

export async function fetchChannelFiles(
  channelId: string,
  opts?: { before?: string; limit?: number },
): Promise<import("../ws-client.js").SharedFilesPage> {
  if (!workspaceState.current) return { files: [], hasMore: false, nextCursor: null };
  return client.fetchChannelFiles(workspaceState.current.id, channelId, opts);
}

export async function fetchDmFiles(
  peerId: string,
  opts?: { before?: string; limit?: number },
): Promise<import("../ws-client.js").SharedFilesPage> {
  if (!workspaceState.current) return { files: [], hasMore: false, nextCursor: null };
  return client.fetchDmFiles(workspaceState.current.id, peerId, opts);
}

// All workspace channels for browse/search (public + your private), with isMember.
export async function listChannels(): Promise<
  Array<Channel & { isMember: boolean; memberCount: number }>
> {
  if (!workspaceState.current) return [];
  return client.listChannels(workspaceState.current.id);
}

// Full-text message search in the current workspace (Postgres FTS server-side).
// Fail-soft: returns [] on error so the search box never throws at the user.
export async function searchMessages(query: string): Promise<import("../core/types.js").Message[]> {
  const wsId = workspaceState.current?.id;
  if (!wsId || !query.trim()) return [];
  try {
    return await client.searchMessages(wsId, query);
  } catch {
    return [];
  }
}

// Self-join a channel: add to channel_members, surface it in the sidebar.
export async function joinChannel(channel: Channel | { id: string }): Promise<void> {
  if (!workspaceState.current || !authState.user) return;
  const channelId = channel.id;
  await client.addChannelMember(workspaceState.current.id, channelId, authState.user.id);
  if (!workspaceState.channels.some((c) => c.id === channelId) && "name" in channel) {
    workspaceState.channels = [...workspaceState.channels, channel as Channel];
  }
  // Preview → joined transition: once the channel is in `channels`, `activeChannel`
  // resolves and `isPreviewing` flips false, so the preview banner swaps to the
  // composer with no reload. Clear the preview slot for the channel we just joined.
  if (workspaceState.previewChannel?.id === channelId) {
    workspaceState.previewChannel = null;
  }
}

// ─── Badge sync (notification state → rail + dock + web title) ──────────────

// Push the global unread total to (a) the Electron dock/taskbar badge and (b)
// the web tab title. Imperative so it can be called both reactively (the effect
// below) AND directly on connect/seed/logout — the effect alone proved flaky
// (it was starved by the rail effect's $state writes, so a freshly-seeded count
// never reached the dock and the badge showed nothing). This function reads
// nothing reactive itself; callers pass the total.
const WEB_TITLE_BASE = "Cyborg";
const ACTIVITY_DOT = "•";
export function pushUnreadIndicators(total: number): void {
  const n = Math.max(0, Math.floor(total) || 0);
  if (typeof window === "undefined") return;
  // Slack-parity badge label: a count for @mentions/DMs (the "red number"), else
  // a dot for any unread channel ACTIVITY (the bold-flag channels — same source
  // as the sidebar + the settings "Channels with unread" row), else cleared.
  // hasAnyUnread() is reactive, so the effect below re-runs as flags change.
  const hasUnreadActivity = unreadFlagState.hasAnyUnread();
  let label = "";
  if (n > 0) {
    label = String(n);
  } else if (hasUnreadActivity) {
    label = ACTIVITY_DOT;
  }
  // (a) Electron dock / taskbar badge. The desktop bridge is `cyborg7Desktop`;
  // absent in a plain browser, so this is a clean no-op there. Prefer the
  // string-aware setBadgeText (dot + count); fall back to the numeric
  // setBadgeCount on an older shell that predates it.
  const w = window as Window & {
    cyborg7Desktop?: {
      setBadgeText?: (text: string) => void;
      setBadgeCount?: (n: number) => void;
    };
  };
  try {
    if (w.cyborg7Desktop?.setBadgeText) {
      w.cyborg7Desktop.setBadgeText(label);
    } else {
      w.cyborg7Desktop?.setBadgeCount?.(n);
    }
  } catch {
    // intentional: desktop dock-badge update is best-effort; a no-op in the browser.
  }
  // (b) Web/PWA fallback: reflect the badge into the tab title — "(3) Cyborg"
  // for a count, "(•) Cyborg" for activity-only. Only when NOT running inside
  // the desktop shell (which has the real dock badge). Mirrors v1's ClientShell
  // title indicator.
  if (!w.cyborg7Desktop && typeof document !== "undefined") {
    try {
      document.title = label ? `(${label}) ${WEB_TITLE_BASE}` : WEB_TITLE_BASE;
    } catch {
      // intentional: tab-title unread indicator is cosmetic best-effort.
    }
  }
}

$effect.root(() => {
  // Rail badge (chat). Kept in its own effect; it WRITES $state
  // (shellConfig.config.railItems), which is why the dock push must NOT live
  // here — those writes could abort the flush before the dock line ran, leaving
  // the badge stale/empty (the historical bug).
  $effect(() => {
    const wsId = workspaceState.current?.id;
    const chatTotal = wsId ? notificationState.getWorkspaceTotal(wsId) : 0;
    // Activity is no longer a rail item — its unread badge now renders on the
    // top-bar Activity bell (reads activityState.unreadCount directly), so this
    // effect only drives the Chat rail badge.
    shellConfig.updateRailBadge("chat", chatTotal);
  });

  // Dock badge + web title in a DEDICATED effect that performs NO $state writes,
  // so it can't be starved by the rail effect above.
  // globalTotal = Σ per-channel MENTION counts + Σ per-DM message counts across
  // ALL workspaces (the "red number"). NOT + activity — the activity feed is a
  // derived inbox of those same events (a DM bumps both the DM count and a
  // dm_received activity entry), so adding it would double-count.
  // pushUnreadIndicators ALSO reads unreadFlagState.hasAnyUnread() for the
  // Slack-parity "dot" (any unread channel, no mention) — that reactive read
  // happens inside the synchronous call below, so this effect re-runs when
  // EITHER the count or the bold-flag set changes.
  $effect(() => {
    pushUnreadIndicators(notificationState.globalTotal);
  });
});

import { SlackClient } from "./client.js";
import type { ThreadSummary } from "./client.js";
import { findOptimisticIndex } from "./message-reconcile.js";
import {
  applyStatusChange,
  reconcileStatusSnapshot,
  type MemberStatus,
} from "./status-reconcile.js";
import type {
  CyborgUser,
  Workspace,
  Channel,
  Message,
  Task,
  TypingEvent,
  WorkspaceMember,
} from "./types.js";

function compareMessages(a: Message, b: Message): number {
  const aSeq = a.seq ?? 0;
  const bSeq = b.seq ?? 0;
  if (aSeq === 0 && bSeq === 0) return a.createdAt - b.createdAt;
  if (aSeq === 0) return 1;
  if (bSeq === 0) return -1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return aSeq - bSeq;
}

// ─── State Classes ────────────────────────────────────────────────

export class WorkspaceState {
  current: Workspace | null = $state(null);
  list: Workspace[] = $state([]);
  channels: Channel[] = $state([]);
  tasks: Task[] = $state([]);
  // oxlint-disable-next-line typescript-eslint/no-explicit-any -- typed by consumer plugin
  agents: any[] = $state([]);
  members: WorkspaceMember[] = $state([]);
  // Switching to another workspace (rail click): true while selectWorkspace loads
  // the target's data, so the shell can show a clear indicator instead of a blank
  // half-loaded view. switchError holds a message when the load fails (so the UI
  // shows an error + retry instead of an infinite spinner).
  switching = $state(false);
  switchError: string | null = $state(null);
  // Members load asynchronously AFTER channels in selectWorkspace, so there's a
  // real window where channels exist but the DM roster is still in flight. The
  // sidebar shows skeleton rows for the DM list while this is true (item 4).
  membersLoading = $state(false);

  // ─── Channel preview (read a public channel without joining) ───────
  // `activeChannel` resolves ONLY from the joined `channels` array, so it's null
  // for a non-member. `previewChannel` holds the channel object a user is peeking
  // at read-only. `viewedChannel` is the unified accessor every preview-safe READ
  // should use (header title, empty-state, name lookups); every WRITE-gated bit of
  // UI keeps reading `activeChannel` so it auto-disables in preview. Cleared on
  // join (the channel lands in `channels`, `activeChannel` resolves) and whenever
  // a real joined channel is selected.
  previewChannel: Channel | null = $state(null);

  get activeChannel(): Channel | null {
    return this.channels.find((c) => c.id === channelState.activeId) ?? null;
  }

  // The channel currently on screen — the joined one if a member, otherwise the
  // previewed one. Preview-safe reads use this; writes stay on `activeChannel`.
  get viewedChannel(): Channel | null {
    return this.activeChannel ?? this.previewChannel;
  }

  // True only while previewing: not a member of the open channel, but a preview
  // channel is seeded and it matches the active channel id (so a stale preview
  // slot from a prior peek can't make a freshly-joined channel look previewed).
  get isPreviewing(): boolean {
    return (
      this.activeChannel === null &&
      this.previewChannel !== null &&
      this.previewChannel.id === channelState.activeId
    );
  }
}

export class ChannelState {
  activeId: string | null = $state(null);
  messages: Message[] = $state([]);
  hasMore = $state(false);
  loading = $state(false);
  typing: TypingEvent[] = $state([]);

  // ─── Item 12: unread divider (Slack-mirror) ───
  // Frozen `lastReadAt` (epoch ms) captured at channel-open from readCursorState
  // BEFORE the badge clears. The "New messages" divider renders above the first
  // loaded message with `createdAt > unreadCursor && fromId !== me` and does NOT
  // move as new messages arrive or the badge clears. null = no cursor (no divider).
  unreadCursor = $state<number | null>(null);

  setUnreadCursor(ms: number | null): void {
    this.unreadCursor = ms;
  }

  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Monotonic workspace-wide sync high-water (#844). lastSeq feeds drainSync's
  // reconnect/seq-gap cursor. Deriving it from the trimmed in-memory window let a
  // 50-row fetch drop the true max, so reconnect re-asked from a low seq and
  // permanently skipped messages. This only ever rises — trimming the window
  // (setMessages) can't lower it.
  private maxAppliedSeq = 0;
  private trackSeq(msgs: Message | Message[]): void {
    const list = Array.isArray(msgs) ? msgs : [msgs];
    for (const m of list) {
      if (!m.id.startsWith("local-") && m.seq > this.maxAppliedSeq) this.maxAppliedSeq = m.seq;
    }
  }

  addMessage(msg: Message): void {
    this.trackSeq(msg);
    if (this.messages.find((m) => m.id === msg.id)) return;
    const localIdx = findOptimisticIndex(this.messages, msg);
    if (localIdx >= 0) {
      // Reconciled: the server echo replaces the optimistic local row. Carry a
      // transient "sent" marker so the row flashes a check, then clear it so the
      // settled steady state shows no indicator at all.
      const settledId = msg.id;
      this.messages[localIdx] = { ...msg, sendStatus: "sent" };
      this.messages = this.messages.slice();
      setTimeout(() => this.clearSentMarker(settledId), 1800);
    } else {
      this.messages = [...this.messages, msg].sort(compareMessages);
    }
  }

  // Drop the transient "sent" check once the reconciled row has settled.
  private clearSentMarker(id: string): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0 || this.messages[idx].sendStatus !== "sent") return;
    const { sendStatus: _drop, ...rest } = this.messages[idx];
    this.messages[idx] = rest;
    this.messages = this.messages.slice();
  }

  // Update the optimistic send-status of a still-local message (pending → failed,
  // or back to pending on retry). No-op once the row has reconciled to a server id.
  setSendStatus(id: string, status: "pending" | "sent" | "failed"): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    this.messages[idx] = { ...this.messages[idx], sendStatus: status };
    this.messages = this.messages.slice();
  }

  // Roll back an optimistic message (e.g. when the send failed) so it doesn't
  // linger forever as a ghost the server will never echo.
  removeMessage(id: string): void {
    this.messages = this.messages.filter((m) => m.id !== id);
  }

  setPinned(messageId: string, pinnedAt: number | null, pinnedBy: string | null): void {
    const idx = this.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    this.messages[idx] = { ...this.messages[idx], pinnedAt, pinnedBy };
    this.messages = this.messages.slice();
  }

  // Bump a parent message's thread indicator when a reply arrives.
  bumpReplyCount(parentId: string, lastReplyAt: number): void {
    const idx = this.messages.findIndex((m) => m.id === parentId);
    if (idx < 0) return;
    const m = this.messages[idx];
    this.messages[idx] = {
      ...m,
      replyCount: (m.replyCount ?? 0) + 1,
      lastReplyAt,
    };
    this.messages = this.messages.slice();
  }

  // Replace the whole list, always chronologically sorted. Fetches must go
  // through this (not a raw assignment) so a server result ordered by a stale
  // seq can't render out of order on reload.
  setMessages(msgs: Message[]): void {
    this.trackSeq(msgs);
    this.messages = [...msgs].sort(compareMessages);
  }

  get lastSeq(): number {
    // The monotonic high-water (never regresses on a trimmed window); also scan
    // the loaded messages so a freshly-restored state is still covered.
    let max = this.maxAppliedSeq;
    for (const m of this.messages) {
      if (!m.id.startsWith("local-") && m.seq > max) max = m.seq;
    }
    return max;
  }

  prependMessages(msgs: Message[], hasMore: boolean): void {
    this.trackSeq(msgs);
    const existingIds = new Set(this.messages.map((m) => m.id));
    const newMsgs = msgs.filter((m) => !existingIds.has(m.id));
    this.messages = [...newMsgs, ...this.messages].sort(compareMessages);
    this.hasMore = hasMore;
  }

  clear(): void {
    this.messages = [];
    // Reset the sync high-water too: clear() runs on workspace/channel teardown,
    // and a seq from the previous scope must not leak into the next one's drain.
    this.maxAppliedSeq = 0;
    this.hasMore = false;
    this.loading = false;
    this.typing = [];
    this.unreadCursor = null;
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
  }

  addTyping(event: TypingEvent): void {
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

  // Clear ONE sender's typing entry + its 5s expiry timer — called when that
  // sender's message arrives so the indicator drops instantly instead of
  // lingering up to 5s (#515). No-op when they aren't currently shown as typing.
  clearTypingFor(fromId: string): void {
    const timer = this.typingTimers.get(fromId);
    // Invariant: a fromId is in `typing` iff it has a timer (addTyping sets both,
    // expiry/clear remove both). So no timer → nothing shown → skip the reactive
    // array reassign (this runs on EVERY incoming message; usually a no-op).
    if (!timer) return;
    clearTimeout(timer);
    this.typingTimers.delete(fromId);
    this.typing = this.typing.filter((t) => t.fromId !== fromId);
  }
}

export class ConnectionState {
  status: "disconnected" | "connected" | "reconnecting" = $state("disconnected");
  error: string | null = $state(null);
  // True once we've connected at least once this session. Lets the
  // ConnectionStatus banner stay hidden during the initial cold-start restore
  // (covered by the splash) and only show for genuine drops afterward.
  hasConnectedOnce: boolean = $state(false);
  // Set when the relay announced a planned restart (cyborg:server_shutdown).
  // Lets the UI show a friendly "Updating…" banner instead of a scary
  // "Disconnected", and reconnect quietly. Cleared on the next successful
  // connection.
  deploying: boolean = $state(false);
  // Reconnect telemetry for the ConnectionStatus banner: the 1-based attempt
  // number and the backoff delay (ms) until the next try. Set on each
  // "reconnecting" emit; reset to 0 on a successful connection.
  reconnectAttempt: number = $state(0);
  reconnectDelayMs: number = $state(0);
}

// ─── Daemon health (polls HTTP /api/health) ──────────────────────

export interface DaemonHealthData {
  relayConnected: boolean;
  pgConnected: boolean;
  uptime: number;
  connectedClients: number;
}

export class DaemonHealthState {
  relayConnected: boolean = $state(false);
  pgConnected: boolean = $state(false);
  uptime: number = $state(0);
  connectedClients: number = $state(0);
  lastChecked: number = $state(0);
  polling: boolean = $state(false);

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private baseUrl: string | null = null;

  get overall(): "connected" | "partial" | "disconnected" {
    if (this.relayConnected && this.pgConnected) return "connected";
    if (this.relayConnected || this.pgConnected) return "partial";
    return "disconnected";
  }

  start(wsUrl: string, intervalMs = 15_000): void {
    this.stop();
    this.baseUrl = wsUrl
      .replace(/^ws:/, "http:")
      .replace(/^wss:/, "https:")
      .replace(/\/ws\/?$/, "");
    this.polling = true;
    this.poll();
    this.intervalId = setInterval(() => this.poll(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.polling = false;
    this.relayConnected = false;
    this.pgConnected = false;
    this.uptime = 0;
    this.connectedClients = 0;
  }

  private async poll(): Promise<void> {
    if (!this.baseUrl) return;
    try {
      const resp = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return;
      const data = await resp.json();
      this.relayConnected = data.relayConnected ?? false;
      this.pgConnected = data.pgConnected ?? false;
      this.uptime = data.uptime ?? 0;
      this.connectedClients = data.connectedClients ?? 0;
      this.lastChecked = Date.now();
    } catch {
      // fetch failed — daemon unreachable, keep last known state
    }
  }
}

// ─── Presence state (online members via daemon) ──────────────────

export class PresenceState {
  private _onlineIds: Set<string> = $state(new Set());
  // P2 Item 6: users who manually set themselves away (a subset of online).
  private _awayIds: Set<string> = $state(new Set());

  get onlineIds(): ReadonlySet<string> {
    return this._onlineIds;
  }

  get onlineCount(): number {
    return this._onlineIds.size;
  }

  isOnline(userId: string): boolean {
    return this._onlineIds.has(userId);
  }

  isAway(userId: string): boolean {
    return this._awayIds.has(userId);
  }

  update(userIds: string[]): void {
    this._onlineIds = new Set(userIds);
  }

  updateAway(userIds: string[]): void {
    this._awayIds = new Set(userIds);
  }

  addUser(userId: string): void {
    if (this._onlineIds.has(userId)) return;
    const next = new Set(this._onlineIds);
    next.add(userId);
    this._onlineIds = next;
  }

  removeUser(userId: string): void {
    if (!this._onlineIds.has(userId)) return;
    const next = new Set(this._onlineIds);
    next.delete(userId);
    this._onlineIds = next;
  }

  clear(): void {
    this._onlineIds = new Set();
    this._awayIds = new Set();
  }
}

// Other workspace members' custom statuses (P2 Item 6), keyed by userId. Synced
// from the relay (fetch on open/reconnect + live user_status_changed broadcasts)
// so the emoji shows where presence shows. Self-status lives in UserStatusState.
// #671: the snapshot/live-change reconcile logic lives in status-reconcile.ts
// as pure functions (unit-tested there); this class just holds the rune-backed
// map and assigns what they return.
export type { MemberStatus };

export class WorkspaceUserStatusesState {
  private _byUser: Record<string, MemberStatus> = $state({});

  get(userId: string): MemberStatus | null {
    return this._byUser[userId] ?? null;
  }

  emojiFor(userId: string): string | null {
    return this._byUser[userId]?.emoji ?? null;
  }

  // Replace the whole map from a fetch (snapshot semantics, like presence).
  seed(statuses: Array<{ userId: string } & MemberStatus>): void {
    this._byUser = reconcileStatusSnapshot(statuses);
  }

  // Apply one live change. A cleared status (no emoji + no text) drops the entry.
  set(userId: string, status: MemberStatus): void {
    this._byUser = applyStatusChange(this._byUser, userId, status);
  }

  clear(): void {
    this._byUser = {};
  }
}

export class AuthState {
  user: CyborgUser | null = $state(null);
  token: string | null = $state(null);
  profileImage: string | null = $state(null);
  private _memberImages: Record<string, string> = $state({});
  private _memberNames: Record<string, string> = $state({});

  // Avatars are PG-backed now (users.image_url). Reset the in-memory caches;
  // they get repopulated from the auth response (self) and the members fetch.
  bindUser(_userId: string): void {
    this.profileImage = null;
    this._memberImages = {};
    this._memberNames = {};
  }

  clearLocal(): void {
    this.user = null;
    this.token = null;
    this.profileImage = null;
    this._memberImages = {};
    this._memberNames = {};
  }

  get authenticated(): boolean {
    return this.user !== null && this.token !== null;
  }

  // Profile images now live in PG (users.image_url), served via auth + members.
  // setProfileImage updates the in-session copy; persistence + S3 upload happen
  // in the caller (ProfileMenu -> uploadAsset + client.setProfileImage).
  setProfileImage(url: string | null): void {
    this.profileImage = url;
    if (this.user) this.user = { ...this.user, imageUrl: url };
  }

  // Updates the in-session display name. NOTE: there is currently no relay RPC
  // to persist the user's name (only cyborg:set_profile_image exists), so this
  // is an in-memory update for the active session only.
  setProfileName(name: string): void {
    if (this.user) this.user = { ...this.user, name };
  }

  getMemberImage(userId: string): string | null {
    if (userId === this.user?.id) return this.user?.imageUrl ?? this.profileImage;
    return this._memberImages[userId] ?? null;
  }

  // Resolve a member's display name by user id. Used so activity rows whose
  // server-side actor_name is missing show a human name instead of a raw UUID.
  getMemberName(userId: string): string | null {
    if (userId === this.user?.id) return this.user?.name ?? null;
    return this._memberNames[userId] ?? null;
  }

  // Populate member avatars + names from the PG-backed members list, so every
  // member sees every other member's avatar (no longer localStorage) and name.
  setMemberImagesFromMembers(
    members: Array<{ userId: string; imageUrl?: string | null; name?: string | null }>,
  ): void {
    const nextImages: Record<string, string> = {};
    const nextNames: Record<string, string> = {};
    for (const m of members) {
      if (m.imageUrl) nextImages[m.userId] = m.imageUrl;
      if (m.name) nextNames[m.userId] = m.name;
    }
    // Mutate the $state maps in place (diff, not wholesale reassign) so Svelte's
    // deep-reactivity proxy only notifies the keys that actually changed — a
    // members refresh that touches one member won't re-run every avatar/name
    // effect observing the others.
    reconcileStateMap(this._memberImages, nextImages);
    reconcileStateMap(this._memberNames, nextNames);
  }
}

// Reconcile a $state record toward `next` by mutating it in place: drop keys no
// longer present, set only the keys whose value changed. Leaves unchanged keys
// untouched so their reactive subscribers don't re-run.
function reconcileStateMap(target: Record<string, string>, next: Record<string, string>): void {
  for (const key of Object.keys(target)) {
    if (!(key in next)) delete target[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (target[key] !== value) target[key] = value;
  }
}

export interface UserStatus {
  emoji: string | null;
  text: string | null;
  expiresAt: string | null;
}

const STATUS_BASE = "cyborg7_user_status";

export class UserStatusState {
  emoji: string | null = $state(null);
  text: string | null = $state(null);
  expiresAt: string | null = $state(null);

  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private _boundUserId: string | null = null;

  private get statusKey(): string {
    return this._boundUserId ? `${STATUS_BASE}_${this._boundUserId}` : STATUS_BASE;
  }

  bindUser(userId: string): void {
    this._boundUserId = userId;
    this.emoji = null;
    this.text = null;
    this.expiresAt = null;
    this.load();
    this.scheduleAutoClear();
  }

  clearLocal(): void {
    this._boundUserId = null;
    this.emoji = null;
    this.text = null;
    this.expiresAt = null;
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  get active(): boolean {
    return this.emoji !== null || this.text !== null;
  }

  get tooltip(): string {
    if (!this.active) return "";
    const parts: string[] = [];
    if (this.emoji) parts.push(this.emoji);
    if (this.text) parts.push(this.text);
    if (this.expiresAt) {
      const remaining = new Date(this.expiresAt).getTime() - Date.now();
      if (remaining > 0) {
        const mins = remaining / 60_000;
        if (mins < 60) {
          parts.push(`· ${Math.ceil(mins)} min`);
        } else {
          const d = new Date(this.expiresAt);
          parts.push(`· until ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
        }
      }
    }
    return parts.join(" ");
  }

  setStatus(emoji: string | null, text: string | null, expiresAt: string | null): void {
    this.emoji = emoji;
    this.text = text;
    this.expiresAt = expiresAt;
    this.persist();
    this.scheduleAutoClear();
  }

  // Apply a server-pushed change to MY OWN status (echoed from another device,
  // P2 Item 6). Same effect as setStatus but named for the remote-origin path —
  // keeps local + persisted state in sync so a reload matches the server.
  applyRemote(emoji: string | null, text: string | null, expiresAt: string | null): void {
    this.emoji = emoji;
    this.text = text;
    this.expiresAt = expiresAt;
    this.persist();
    this.scheduleAutoClear();
  }

  clearStatus(): void {
    this.emoji = null;
    this.text = null;
    this.expiresAt = null;
    this.persist();
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
  }

  private persist(): void {
    try {
      if (!this.active) {
        localStorage.removeItem(this.statusKey);
      } else {
        localStorage.setItem(
          this.statusKey,
          JSON.stringify({ emoji: this.emoji, text: this.text, expiresAt: this.expiresAt }),
        );
      }
    } catch {
      // intentional: best-effort persistence of user status; not user-facing.
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.statusKey);
      if (!raw) return;
      const parsed: UserStatus = JSON.parse(raw);
      if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() <= Date.now()) {
        localStorage.removeItem(this.statusKey);
        return;
      }
      this.emoji = parsed.emoji;
      this.text = parsed.text;
      this.expiresAt = parsed.expiresAt;
    } catch {
      // intentional: best-effort hydrate of user status; falls back to unset.
    }
  }

  private scheduleAutoClear(): void {
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }
    if (!this.expiresAt) return;
    const remaining = new Date(this.expiresAt).getTime() - Date.now();
    if (remaining <= 0) {
      this.clearStatus();
      return;
    }
    this.clearTimer = setTimeout(() => {
      this.clearStatus();
    }, remaining);
  }
}

export class DmState {
  activePeerId: string | null = $state(null);
  messages: Message[] = $state([]);
  hasMore = $state(false);
  loading = $state(false);
  // In-conversation typing line for the OPEN DM. Mirrors ChannelState.typing:
  // 5s auto-expire, deduped by fromId (DMs are 1:1 so this is at most one peer).
  typing: TypingEvent[] = $state([]);

  // ─── Item 12: unread divider (Slack-mirror), mirrors ChannelState. ───
  // Frozen `lastReadAt` (epoch ms) captured at DM-open from readCursorState,
  // BEFORE the badge clears. null = no cursor (no divider).
  unreadCursor = $state<number | null>(null);

  setUnreadCursor(ms: number | null): void {
    this.unreadCursor = ms;
  }

  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  addTyping(event: TypingEvent): void {
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

  // Clear ONE sender's typing entry + its 5s expiry timer when their DM arrives
  // (#515) — mirrors ChannelState.clearTypingFor. No-op when not shown typing.
  clearTypingFor(fromId: string): void {
    const timer = this.typingTimers.get(fromId);
    // Invariant: a fromId is in `typing` iff it has a timer (addTyping sets both,
    // expiry/clear remove both). So no timer → nothing shown → skip the reactive
    // array reassign (this runs on EVERY incoming message; usually a no-op).
    if (!timer) return;
    clearTimeout(timer);
    this.typingTimers.delete(fromId);
    this.typing = this.typing.filter((t) => t.fromId !== fromId);
  }

  // Drop the in-conversation typing line + its timers when switching DMs.
  clearTyping(): void {
    this.typing = [];
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
  }

  addMessage(msg: Message): void {
    if (this.messages.find((m) => m.id === msg.id)) return;
    const localIdx = findOptimisticIndex(this.messages, msg);
    if (localIdx >= 0) {
      // Reconciled: the server echo replaces the optimistic local row. Mirror the
      // channel path — carry a transient "sent" check that auto-clears so the
      // settled steady state shows no indicator.
      const settledId = msg.id;
      this.messages[localIdx] = { ...msg, sendStatus: "sent" };
      this.messages = this.messages.slice();
      setTimeout(() => this.clearSentMarker(settledId), 1800);
    } else {
      this.messages = [...this.messages, msg].sort(compareMessages);
    }
  }

  // Drop the transient "sent" check once the reconciled row has settled.
  private clearSentMarker(id: string): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0 || this.messages[idx].sendStatus !== "sent") return;
    const { sendStatus: _drop, ...rest } = this.messages[idx];
    this.messages[idx] = rest;
    this.messages = this.messages.slice();
  }

  // Update the optimistic send-status of a still-local message (pending → failed,
  // or back to pending on retry). No-op once the row has reconciled to a server id.
  setSendStatus(id: string, status: "pending" | "sent" | "failed"): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    this.messages[idx] = { ...this.messages[idx], sendStatus: status };
    this.messages = this.messages.slice();
  }

  removeMessage(id: string): void {
    this.messages = this.messages.filter((m) => m.id !== id);
  }

  // Bump a DM root's thread indicator when a reply arrives — mirrors
  // ChannelState.bumpReplyCount so DM thread footers update live.
  bumpReplyCount(parentId: string, lastReplyAt: number): void {
    const idx = this.messages.findIndex((m) => m.id === parentId);
    if (idx < 0) return;
    const m = this.messages[idx];
    this.messages[idx] = {
      ...m,
      replyCount: (m.replyCount ?? 0) + 1,
      lastReplyAt,
    };
    this.messages = this.messages.slice();
  }

  mergeServer(serverMessages: Message[]): void {
    const merged = new Map<string, Message>();
    for (const m of this.messages) merged.set(m.id, m);
    for (const m of serverMessages) {
      // Collapse the optimistic local- row this server message settles (#501):
      // clientMsgId-first, falling back to (fromId,text). Mirrors addMessage's
      // findOptimisticIndex but over the merge map's values.
      const mergedValues = [...merged.values()];
      const localIdx = findOptimisticIndex(mergedValues, m);
      if (localIdx >= 0) merged.delete(mergedValues[localIdx].id);
      merged.set(m.id, m);
    }
    this.messages = [...merged.values()].sort(compareMessages);
  }

  // Highest server seq among loaded DM messages — the cursor for the seq-drained
  // reconnect catch-up (#500). Mirrors ChannelState.lastSeq; ignores optimistic
  // local- rows (seq 0). 0 when the conversation hasn't loaded any server message.
  get lastSeq(): number {
    let max = 0;
    for (const m of this.messages) {
      if (!m.id.startsWith("local-") && m.seq > max) max = m.seq;
    }
    return max;
  }

  clear(): void {
    this.messages = [];
    this.hasMore = false;
    this.loading = false;
    this.typing = [];
    this.unreadCursor = null;
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
  }
}

// Workspace-scoped DM typing, keyed by the typing peer's fromId. Lets the
// SIDEBAR show a typing badge on a DM row even when that DM is NOT the active
// view. Each entry self-expires after 5s (same as the in-conversation line).
export class DmTypingState {
  private _typingPeers: Record<string, true> = $state({});
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  isTyping(peerId: string): boolean {
    return this._typingPeers[peerId] === true;
  }

  mark(peerId: string): void {
    const existing = this.timers.get(peerId);
    if (existing) clearTimeout(existing);
    if (!this._typingPeers[peerId]) {
      this._typingPeers = { ...this._typingPeers, [peerId]: true };
    }
    this.timers.set(
      peerId,
      setTimeout(() => {
        const next = { ...this._typingPeers };
        delete next[peerId];
        this._typingPeers = next;
        this.timers.delete(peerId);
      }, 5000),
    );
  }

  // Clear ONE peer's sidebar typing badge + its 5s timer when their DM arrives
  // (#515) — so the sidebar dot drops with the message instead of lingering up to
  // 5s. No-op when that peer isn't shown typing.
  clearFor(peerId: string): void {
    const timer = this.timers.get(peerId);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(peerId);
    const next = { ...this._typingPeers };
    delete next[peerId];
    this._typingPeers = next;
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this._typingPeers = {};
  }
}

export const dmTypingState = new DmTypingState();

// ─── Notification state (single source of truth for unread badges) ─

const NOTIFICATION_COUNTS_BASE = "cyborg7_notification_counts";

export class NotificationState {
  private _counts: Record<string, Record<string, number>> = $state({});
  private _boundUserId: string | null = null;

  private get countsKey(): string {
    return this._boundUserId
      ? `${NOTIFICATION_COUNTS_BASE}_${this._boundUserId}`
      : NOTIFICATION_COUNTS_BASE;
  }

  bindUser(userId: string): void {
    this._boundUserId = userId;
    this._counts = {};
    try {
      const raw = localStorage.getItem(this.countsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") this._counts = parsed;
      }
    } catch {
      // intentional: best-effort hydrate of notification counts; falls back to empty.
    }
  }

  clearLocal(): void {
    this._boundUserId = null;
    this._counts = {};
  }

  increment(workspaceId: string, targetId: string): void {
    if (!this._counts[workspaceId]) this._counts[workspaceId] = {};
    this._counts[workspaceId][targetId] = (this._counts[workspaceId][targetId] ?? 0) + 1;
    this._counts = { ...this._counts };
    this.persist();
  }

  clear(workspaceId: string, targetId: string): void {
    if (!this._counts[workspaceId]?.[targetId]) return;
    const ws = { ...this._counts[workspaceId] };
    delete ws[targetId];
    this._counts = { ...this._counts, [workspaceId]: ws };
    this.persist();
  }

  clearWorkspace(workspaceId: string): void {
    if (!this._counts[workspaceId]) return;
    const next = { ...this._counts };
    delete next[workspaceId];
    this._counts = next;
    this.persist();
  }

  // Replace a workspace's unread counts with server truth (P6: on workspace
  // load, so badges survive reload and sync across devices). Zero counts dropped.
  seedCounts(workspaceId: string, counts: Record<string, number>): void {
    const filtered: Record<string, number> = {};
    for (const [id, n] of Object.entries(counts)) {
      if (n > 0) filtered[id] = n;
    }
    this._counts = { ...this._counts, [workspaceId]: filtered };
    this.persist();
  }

  getCount(workspaceId: string, targetId: string): number {
    return this._counts[workspaceId]?.[targetId] ?? 0;
  }

  getWorkspaceTotal(workspaceId: string): number {
    const ws = this._counts[workspaceId];
    if (!ws) return 0;
    let total = 0;
    for (const count of Object.values(ws)) total += count;
    return total;
  }

  get globalTotal(): number {
    let total = 0;
    for (const ws of Object.values(this._counts)) {
      for (const count of Object.values(ws)) total += count;
    }
    return total;
  }

  private persist(): void {
    try {
      localStorage.setItem(this.countsKey, JSON.stringify(this._counts));
    } catch {
      // intentional: best-effort persistence of notification counts; not user-facing.
    }
  }
}

// ─── Unread-flag state (BUG #2: bold-vs-badge split) ───────────────
// Mattermost/v1 gold standard: a channel has TWO independent unread signals.
//   (a) an unread FLAG → BOLD channel name (any non-muted unread message), and
//   (b) a mention COUNT → the RED NUMBER (held by NotificationState above), which
//       only increments on a real mention.
// This store owns signal (a): a per-workspace Set of channel ids that have an
// unread (non-muted) message. Persisted so bold survives reload.
// DMs are NOT tracked here — they always count (their NotificationState number
// already drives both bold and badge), matching Slack/Mattermost DM behaviour.
const UNREAD_FLAGS_BASE = "cyborg7_unread_flags";

export class UnreadFlagState {
  // workspaceId → Set<channelId>. Stored as a $state object holding Sets;
  // mutations reassign the object so Svelte's runes see the change.
  private _flags: Record<string, Set<string>> = $state({});
  private _boundUserId: string | null = null;

  private get flagsKey(): string {
    return this._boundUserId ? `${UNREAD_FLAGS_BASE}_${this._boundUserId}` : UNREAD_FLAGS_BASE;
  }

  bindUser(userId: string): void {
    this._boundUserId = userId;
    this._flags = {};
    try {
      const raw = localStorage.getItem(this.flagsKey);
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return;
      const next: Record<string, Set<string>> = {};
      for (const [ws, ids] of Object.entries(parsed)) {
        if (Array.isArray(ids)) next[ws] = new Set(ids as string[]);
      }
      this._flags = next;
    } catch {
      // intentional: best-effort hydrate of unread flags; falls back to empty.
    }
  }

  clearLocal(): void {
    this._boundUserId = null;
    this._flags = {};
  }

  markUnread(workspaceId: string, targetId: string): void {
    const ws = this._flags[workspaceId] ?? new Set<string>();
    if (ws.has(targetId)) return;
    const next = new Set(ws);
    next.add(targetId);
    this._flags = { ...this._flags, [workspaceId]: next };
    this.persist();
  }

  clearUnread(workspaceId: string, targetId: string): void {
    const ws = this._flags[workspaceId];
    if (!ws?.has(targetId)) return;
    const next = new Set(ws);
    next.delete(targetId);
    this._flags = { ...this._flags, [workspaceId]: next };
    this.persist();
  }

  clearWorkspace(workspaceId: string): void {
    if (!this._flags[workspaceId]) return;
    const next = { ...this._flags };
    delete next[workspaceId];
    this._flags = next;
    this.persist();
  }

  isUnread(workspaceId: string, targetId: string): boolean {
    return this._flags[workspaceId]?.has(targetId) ?? false;
  }

  // True when ANY loaded workspace has at least one channel/DM with an unread
  // flag. Reactive (reads `_flags`), so the dock-badge effect re-runs as flags
  // change. Same source as `isUnread` — the dock "dot" must never drift from the
  // sidebar's bold channels / the settings "Channels with unread" row.
  hasAnyUnread(): boolean {
    for (const ids of Object.values(this._flags)) {
      if (ids.size > 0) return true;
    }
    return false;
  }

  // Replace a workspace's unread flags with server truth (workspace open /
  // reconnect), so bold survives reload + syncs across devices.
  seed(workspaceId: string, ids: Iterable<string>): void {
    this._flags = { ...this._flags, [workspaceId]: new Set(ids) };
    this.persist();
  }

  private persist(): void {
    try {
      const serializable: Record<string, string[]> = {};
      for (const [ws, ids] of Object.entries(this._flags)) serializable[ws] = [...ids];
      localStorage.setItem(this.flagsKey, JSON.stringify(serializable));
    } catch {
      // intentional: best-effort persistence of unread flags; not user-facing.
    }
  }
}

// ─── DM-activity state (#17: DM list ordered by most-recent message) ─
// Slack/Mattermost parity: the DM list surfaces the most recently active
// conversation at the TOP (Mattermost sorts the sidebar by `last_post_at` desc).
// The v2 relay does not yet return a per-peer `last_message_at` on workspace
// load (it would need a join through dm_conversations → channel_messages), so —
// mirroring the original v1 web app (Sidebar.tsx `dmHumanActivity`) — we track
// the last-activity timestamp per peer CLIENT-SIDE and bump it whenever a DM is
// sent, received, or opened. Workspace-scoped, keyed by peer id (a human userId
// OR an agentId), persisted to localStorage so a reload keeps the order. Peers
// with no recorded activity sort to the bottom in their existing (stable) order.
const DM_ACTIVITY_BASE = "cyborg7_dm_activity";

export class DmActivityState {
  // workspaceId → (peerId → epoch ms of last DM activity).
  private _activity: Record<string, Record<string, number>> = $state({});
  private _boundUserId: string | null = null;

  private get activityKey(): string {
    return this._boundUserId ? `${DM_ACTIVITY_BASE}_${this._boundUserId}` : DM_ACTIVITY_BASE;
  }

  bindUser(userId: string): void {
    this._boundUserId = userId;
    this._activity = {};
    try {
      const raw = localStorage.getItem(this.activityKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") this._activity = parsed;
      }
    } catch {
      // intentional: best-effort hydrate of DM activity order; falls back to empty.
    }
  }

  clearLocal(): void {
    this._boundUserId = null;
    this._activity = {};
  }

  // Record DM activity for a peer at `ms` (defaults to now). Monotonic: never
  // moves a peer's timestamp backward, so a late re-broadcast can't demote a
  // conversation the user has since interacted with.
  bump(workspaceId: string, peerId: string, ms: number = Date.now()): void {
    if (!workspaceId || !peerId) return;
    const ws = this._activity[workspaceId] ?? {};
    if ((ws[peerId] ?? 0) >= ms) return;
    this._activity = { ...this._activity, [workspaceId]: { ...ws, [peerId]: ms } };
    this.persist();
  }

  getActivity(workspaceId: string, peerId: string): number {
    return this._activity[workspaceId]?.[peerId] ?? 0;
  }

  private persist(): void {
    try {
      localStorage.setItem(this.activityKey, JSON.stringify(this._activity));
    } catch {
      // intentional: best-effort persistence of DM activity order; not user-facing.
    }
  }
}

// ─── Item 12: read-cursor state (frozen-divider source) ───────────
// Holds the server `lastReadAt` (epoch ms) per channel and per DM peer, seeded
// on workspace open from `fetch_unread`. This is the source the "New messages"
// divider FREEZES from at conversation-open — strictly separate from the badge
// (notificationState). Advances are MONOTONIC (Mattermost MM-44900 guard): a
// slow broadcast/reseed can never move a cursor backward and resurrect a divider.
export class ReadCursorState {
  private _channel: Record<string, number> = $state({});
  private _dm: Record<string, number> = $state({});

  // Replace both maps from server truth (workspace open / reconnect re-freeze).
  seed(args: { reads: Record<string, number>; dmReads: Record<string, number> }): void {
    this._channel = { ...args.reads };
    this._dm = { ...args.dmReads };
  }

  getChannel(channelId: string): number | null {
    return this._channel[channelId] ?? null;
  }

  getDm(peerId: string): number | null {
    return this._dm[peerId] ?? null;
  }

  advanceChannel(channelId: string, ms: number): void {
    const existing = this._channel[channelId] ?? 0;
    if (ms <= existing) return;
    this._channel = { ...this._channel, [channelId]: ms };
  }

  advanceDm(peerId: string, ms: number): void {
    const existing = this._dm[peerId] ?? 0;
    if (ms <= existing) return;
    this._dm = { ...this._dm, [peerId]: ms };
  }

  reset(): void {
    this._channel = {};
    this._dm = {};
  }
}

// Per-channel notification preferences (server-backed; P8). 'all' |
// 'mentions_only' | 'muted'. Channels default to 'all' — notify on every
// message (WhatsApp/Telegram-style); users dial down to mentions-only or mute.
export class NotificationPrefsState {
  prefs: Record<string, string> = $state({});

  seed(map: Record<string, string>): void {
    this.prefs = { ...map };
  }

  // Additive seed — keep prefs already loaded for OTHER workspaces and overlay
  // this map on top. Scope ids (channel/peer/agent ids) are globally-unique
  // UUIDs, so a flat cross-workspace map never collides. Used to load every
  // workspace's prefs up front (subscribeAndSeedAllWorkspaces) and on each
  // workspace switch, so the notification policy can resolve the REAL pref for a
  // message arriving in a NON-active workspace (a muted/mentions-only channel in
  // another workspace must not banner a plain message). A plain `seed` on switch
  // would wipe the other workspaces' prefs and re-introduce that bug.
  merge(map: Record<string, string>): void {
    for (const [k, v] of Object.entries(map)) this.prefs[k] = v;
  }

  set(scopeId: string, preference: string): void {
    this.prefs[scopeId] = preference;
  }

  get(scopeId: string): string {
    return this.prefs[scopeId] ?? "all";
  }

  // Drop every loaded pref (logout / account switch) so a previous account's
  // cross-workspace prefs never leak into the next session.
  clear(): void {
    this.prefs = {};
  }
}

export const notifPrefsState = new NotificationPrefsState();

// ─── Singleton instances ──────────────────────────────────────────

export const coreClient = new SlackClient();
export const authState = new AuthState();
export const connectionState = new ConnectionState();
export const daemonHealthState = new DaemonHealthState();
export const presenceState = new PresenceState();
export const workspaceUserStatusesState = new WorkspaceUserStatusesState();
export const workspaceState = new WorkspaceState();
export const channelState = new ChannelState();
export const dmState = new DmState();
export const userStatusState = new UserStatusState();
export const notificationState = new NotificationState();
export const unreadFlagState = new UnreadFlagState();
export const dmActivityState = new DmActivityState();
export const readCursorState = new ReadCursorState();

// ─── Shared DM-list ordering (#17) ────────────────────────────────
// The ONE place that orders DM peers, used by BOTH the sidebar "Direct
// Messages" section and the mobile DMs tab so they can never diverge. Sorts by
// last-message activity DESC (most recent first, Slack/Mattermost-style); peers
// with no recorded activity fall to the bottom. Array.prototype.sort is stable
// in modern JS, so ties keep their incoming order — callers pre-sort by name to
// make the no-activity tail deterministic.
export function sortMembersByDmRecency<T extends { userId: string }>(
  members: readonly T[],
  workspaceId: string | null | undefined,
): T[] {
  if (!workspaceId) return [...members];
  return [...members].sort(
    (a, b) =>
      dmActivityState.getActivity(workspaceId, b.userId) -
      dmActivityState.getActivity(workspaceId, a.userId),
  );
}

// Scroll-to + flash-highlight a specific message (e.g. opening a thread from the
// global Threads view jumps the channel to its root). `nonce` bumps so the same
// id re-triggers the scroll. MessageList watches this; ChatMessage flashes.
export class MessageFocusState {
  id: string | null = $state(null);
  nonce = $state(0);
  focus(id: string): void {
    this.id = id;
    this.nonce += 1;
  }
  clear(): void {
    this.id = null;
  }
}
export const messageFocusState = new MessageFocusState();

// ─── Threads (CRT) — global followed-threads list + aggregate unread badge ──
// Mirrors NotificationState's delta approach: the list comes from fetch_threads,
// the aggregate counts are seeded once (thread_counts) then maintained by
// applying prev/new deltas from WS events — no refetch per event.
export interface ThreadUnread {
  unreadReplies: number;
  unreadMentions: number;
}
export class ThreadsState {
  list: ThreadSummary[] = $state([]);
  counts: { totalUnreadThreads: number; totalUnreadMentions: number } = $state({
    totalUnreadThreads: 0,
    totalUnreadMentions: 0,
  });
  loading = $state(false);
  fetched = $state(false);

  // Per-thread "New replies" divider cursor (#7), keyed by root id → the viewer's
  // last_viewed (epoch ms) captured at thread-open from the fetch_thread response.
  // FROZEN: the divider reads this snapshot, NOT the live cursor, so mark_thread_read
  // advancing the server cursor on open doesn't make the divider vanish. ThreadPanel
  // renders UnreadDivider above the first reply with createdAt > this value.
  perThreadLastViewed: Record<string, number> = $state({});

  setPerThreadLastViewed(rootId: string, lastViewed: number): void {
    this.perThreadLastViewed = { ...this.perThreadLastViewed, [rootId]: lastViewed };
  }

  getPerThreadLastViewed(rootId: string): number | null {
    return this.perThreadLastViewed[rootId] ?? null;
  }

  setList(threads: ThreadSummary[]): void {
    this.list = threads;
    this.fetched = true;
  }

  seedCounts(c: { totalUnreadThreads: number; totalUnreadMentions: number }): void {
    this.counts = { ...c };
  }

  clear(): void {
    this.list = [];
    this.counts = { totalUnreadThreads: 0, totalUnreadMentions: 0 };
    this.fetched = false;
    this.perThreadLastViewed = {};
  }

  // Apply a per-thread unread delta (from thread_updated / thread_read_changed):
  // bump the aggregate badge by (new - prev), flip the unread-thread count on a
  // 0↔non-0 transition, and update the matching list item's unread in place.
  applyDelta(d: {
    rootId: string;
    newReplies: number;
    newMentions: number;
    prevReplies: number;
    prevMentions: number;
  }): void {
    const wasUnread = d.prevReplies + d.prevMentions > 0;
    const isUnread = d.newReplies + d.newMentions > 0;
    this.counts = {
      totalUnreadMentions: Math.max(
        0,
        this.counts.totalUnreadMentions + (d.newMentions - d.prevMentions),
      ),
      totalUnreadThreads: Math.max(
        0,
        this.counts.totalUnreadThreads +
          (!wasUnread && isUnread ? 1 : 0) -
          (wasUnread && !isUnread ? 1 : 0),
      ),
    };
    const idx = this.list.findIndex((t) => t.root?.id === d.rootId);
    if (idx >= 0) {
      const updated = Object.assign({}, this.list[idx], {
        unreadReplies: d.newReplies,
        unreadMentions: d.newMentions,
      });
      this.list = [...this.list.slice(0, idx), updated, ...this.list.slice(idx + 1)];
    }
  }
}
export const threadsState = new ThreadsState();

// ─── Saved messages (#609 — personal bookmarks) ───────────────────
// A PRIVATE per-user list of saved messages across channels, shown in the Saved
// view. The list comes from list_saved (newest-saved first); saveMessage toggles
// a row optimistically and the save_message broadcast reconciles across devices.
// Mirrors ThreadsState's list/loading/fetched shape. `savedIds` lets a message row
// anywhere render its filled/empty bookmark without re-fetching the whole list.
export class SavedState {
  list: import("../core/types.js").Message[] = $state([]);
  // The set of message ids the user has saved — drives the per-message toggle
  // glyph. Kept in lockstep with `list` (the Saved view's source of truth) plus
  // any optimistic toggle for a message not currently in the loaded list.
  savedIds: Set<string> = $state(new Set());
  loading = $state(false);
  fetched = $state(false);

  setList(messages: import("../core/types.js").Message[]): void {
    this.list = messages;
    this.savedIds = new Set(messages.map((m) => m.id));
    this.fetched = true;
  }

  isSaved(messageId: string): boolean {
    return this.savedIds.has(messageId);
  }

  // Add/remove a single bookmark. Used for both the optimistic local toggle and
  // the authoritative save_message broadcast. `message` is supplied when known
  // (the toggle has the row in hand) so a save made from a channel can appear in
  // an already-loaded Saved list without a refetch; a broadcast for an unknown
  // message just updates the id set (the list refreshes on next open).
  apply(messageId: string, saved: boolean, message?: import("../core/types.js").Message): void {
    const ids = new Set(this.savedIds);
    if (saved) {
      ids.add(messageId);
      if (message && !this.list.some((m) => m.id === messageId)) {
        // Newest-saved first, mirroring getSavedMessages' ordering.
        this.list = [message, ...this.list];
      }
    } else {
      ids.delete(messageId);
      this.list = this.list.filter((m) => m.id !== messageId);
    }
    this.savedIds = ids;
  }

  clear(): void {
    this.list = [];
    this.savedIds = new Set();
    this.loading = false;
    this.fetched = false;
  }
}
export const savedState = new SavedState();

// ─── Wire client events to state ──────────────────────────────────

coreClient.on("connection", ({ status }) => {
  connectionState.status = status;
});

coreClient.on("channel_message", (msg) => {
  if (msg.channelId === channelState.activeId) {
    channelState.addMessage(msg);
  }
});

coreClient.on("dm", (msg) => {
  if (msg.channelId && msg.channelId === channelState.activeId) {
    channelState.addMessage(msg);
  }
  const myId = authState.user?.id;
  if (myId) {
    const peerId = msg.fromId === myId ? (msg.toId ?? null) : msg.fromId;
    if (peerId && peerId === dmState.activePeerId) {
      dmState.addMessage(msg);
    }
  }
});

coreClient.on("typing", (event) => {
  if (event.channelId === channelState.activeId && event.fromId !== authState.user?.id) {
    channelState.addTyping(event);
  }
});

coreClient.on("error", (err) => {
  connectionState.error = err.message;
});

// ─── Core Actions ─────────────────────────────────────────────────

const SESSION_KEY = "cyborg7-session";

export async function connectToServer(url: string, token: string): Promise<void> {
  authState.token = token;
  await coreClient.connect(url, token);
  const authResp = await coreClient.authenticate();
  authState.user = authResp.user;
  workspaceState.list = authResp.workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    ownerId: "",
    avatarUrl: ws.avatarUrl ?? null,
    role: ws.role as Workspace["role"],
    createdAt: 0,
    settings: {},
  }));
  daemonHealthState.start(url);
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ url, token }));
  } catch {
    // intentional: best-effort session persistence; storage-disabled just means
    // the user re-auths next launch.
  }
}

export interface SavedSession {
  url: string;
  token: string;
}

// Canonical Cyborg Cloud relay (TLS via the ALB). Earlier builds — and some
// early direct/self-hosted logins — saved a RAW relay EC2 IP. The relay has
// since moved/retired those boxes, so a persisted session could silently point
// the app at a dead/old relay (requests time out, no presence, no avatars) even
// after an app update, because the saved session is user data, not app code.
// Migrate those known legacy cloud endpoints to the stable DNS so stale sessions
// self-heal on boot. Genuine self-hosted users (any other host) are untouched.
const CLOUD_WS_URL = "wss://relay.cyborg7.com/api/ws";
// Hosts of retired cloud-relay boxes whose RAW IPs may still live in old saved
// sessions. Sourced from build config (VITE_LEGACY_CLOUD_HOSTS, comma-separated)
// — NOT hardcoded — so infra IPs never ship in the committed client source.
// Empty when the var is unset (no migration, but the source carries no IPs).
const LEGACY_CLOUD_HOSTS = new Set(
  ((import.meta.env.VITE_LEGACY_CLOUD_HOSTS as string | undefined) ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0),
);

function migrateSessionUrl(url: string): string {
  try {
    if (LEGACY_CLOUD_HOSTS.has(new URL(url).hostname)) return CLOUD_WS_URL;
  } catch {
    // intentional: a malformed saved URL just isn't migrated; returned as-is.
  }
  return url;
}

// ── Dev/localhost: don't auto-restore a CLOUD saved session ──────────────────
// When the UI is served from a developer's machine in DEV (vite dev on
// localhost:5173), a saved session whose relay URL points at the CLOUD relay
// (relay.cyborg7.com — or ANY non-localhost host) would auto-restore + auto-
// connect on boot BEFORE the login page renders, dropping the dev onto cloud
// workspaces even though the login form defaults to the LOCAL relay. On
// dev+localhost ONLY, treat such a session as absent (getSavedSession → null) so
// boot falls through to /login (which defaults to the local relay). A session
// pointing at the local relay (localhost / 127.0.0.1) still restores normally.
// Production (any non-localhost host) and the desktop build are completely
// unaffected: `isDevLocalhost` is false there, so this guard never runs and the
// cloud session restores exactly as before.
const isDevLocalhost =
  import.meta.env.DEV &&
  typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");

function isLocalRelayUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    // A malformed saved URL can't be confirmed local — treat it as non-local so
    // the dev+localhost guard ignores it (boot falls through to /login).
    return false;
  }
}

export function getSavedSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.url && parsed?.token) {
      const url = migrateSessionUrl(parsed.url);
      // Dev/localhost only: ignore a stale CLOUD/non-localhost saved session so
      // boot lands on /login (which defaults to the local relay) instead of auto-
      // connecting to the cloud relay. The session is NOT cleared from storage —
      // it's simply not restored on dev+localhost. No-op in prod/desktop.
      if (isDevLocalhost && !isLocalRelayUrl(url)) return null;
      // Persist the corrected URL so the heal is permanent (the existing token
      // stays valid — the cloud relays share the same JWT secret).
      if (url !== parsed.url) {
        try {
          localStorage.setItem(SESSION_KEY, JSON.stringify({ ...parsed, url }));
        } catch {
          // intentional: best-effort write-back of the healed URL; the in-memory
          // value is still corrected for this run.
        }
      }
      return { url, token: parsed.token };
    }
  } catch {
    // intentional: unreadable/corrupt saved session is treated as no session.
  }
  return null;
}

export function clearSavedSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // intentional: best-effort session clear; nothing to surface if storage is gone.
  }
}

export async function selectWorkspace(workspace: Workspace): Promise<void> {
  workspaceState.current = workspace;
  channelState.clear();
  channelState.activeId = null;

  const [channels, tasks] = await Promise.all([
    coreClient.fetchChannels(workspace.id),
    coreClient.fetchTasks(workspace.id),
  ]);

  workspaceState.channels = channels;
  workspaceState.tasks = tasks;

  workspaceState.membersLoading = true;
  coreClient
    .listMembers(workspace.id)
    .then(({ members }) => {
      workspaceState.members = members;
      return undefined;
    })
    .catch(() => {
      workspaceState.members = [];
    })
    .finally(() => {
      workspaceState.membersLoading = false;
    });

  if (channels.length > 0) {
    await selectChannel(channels[0].id);
  }
}

export async function selectChannel(channelId: string): Promise<void> {
  if (!workspaceState.current) return;
  channelState.activeId = channelId;
  channelState.loading = true;
  channelState.messages = [];

  const { messages, hasMore } = await coreClient.fetchMessages(
    workspaceState.current.id,
    channelId,
    { limit: 50 },
  );
  channelState.messages = messages;
  channelState.hasMore = hasMore;
  channelState.loading = false;
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
  const { messages, hasMore } = await coreClient.fetchMessages(
    workspaceState.current.id,
    channelState.activeId,
    { before: oldest?.id, limit: 50 },
  );
  channelState.prependMessages(messages, hasMore);
  channelState.loading = false;
}

export function sendMessage(text: string, mentions?: string[]): void {
  if (!workspaceState.current || !channelState.activeId) return;
  coreClient.sendMessage(workspaceState.current.id, channelState.activeId, text, mentions);
}

export function sendTypingIndicator(): void {
  if (!workspaceState.current || !channelState.activeId) return;
  coreClient.sendTyping(workspaceState.current.id, channelState.activeId);
}

export function selectDm(peerId: string): void {
  dmState.clear();
  dmState.activePeerId = peerId;
  channelState.activeId = null;
}

export function sendDmMessage(text: string): void {
  if (!workspaceState.current || !dmState.activePeerId) return;
  const peerId = dmState.activePeerId;
  const myId = authState.user?.id ?? "unknown";
  const myName = authState.user?.name ?? authState.user?.email ?? "You";
  coreClient.sendDm(workspaceState.current.id, peerId, text);
  dmState.addMessage({
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channelId: null,
    fromId: myId,
    fromType: "human",
    fromName: myName,
    toId: peerId,
    text,
    seq: 0,
    createdAt: Date.now(),
  });
}

export async function inviteMember(
  email: string,
  role: "admin" | "member" | "viewer" = "member",
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await coreClient.inviteMember(workspaceState.current.id, email, role);
  const { members } = await coreClient.listMembers(workspaceState.current.id);
  workspaceState.members = members;
}

export async function removeMember(userId: string): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await coreClient.removeMember(workspaceState.current.id, userId);
  workspaceState.members = workspaceState.members.filter((m) => m.userId !== userId);
}

export async function updateMemberRole(
  userId: string,
  role: "admin" | "member" | "viewer",
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await coreClient.updateRole(workspaceState.current.id, userId, role);
  workspaceState.members = workspaceState.members.map((m) =>
    m.userId === userId ? { ...m, role } : m,
  );
}

export function disconnectFromServer(): void {
  clearSavedSession();
  coreClient.disconnect();
  authState.user = null;
  authState.token = null;
  workspaceState.current = null;
  workspaceState.list = [];
  workspaceState.channels = [];
  workspaceState.tasks = [];
  workspaceState.agents = [];
  channelState.clear();
  daemonHealthState.stop();
  presenceState.clear();
  workspaceUserStatusesState.clear();
  connectionState.status = "disconnected";
}

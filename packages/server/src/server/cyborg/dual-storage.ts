import { CyborgStorage, createCyborgStorage } from "./storage.js";
import { PgSync } from "./db/pg-sync.js";
import type {
  StoredMessage,
  StoredChannel,
  StoredWorkspace,
  StoredMembership,
  StoredUser,
  StoredTask,
  StoredSchedule,
  StoredScheduleRun,
  ScheduleSkipReason,
  StoredScheduledMessage,
  ScheduledMessageErrorCode,
  StoredPromptTemplate,
  StoredInstalledRecipe,
  StoredAgentBinding,
  StoredEphemeralSessionContext,
  StoredArchivedSession,
  StoredProject,
  StoredChannelProject,
  StoredActivityEvent,
  StoredTasksProject,
} from "./storage.js";
import type { StoredCybo } from "./cybo-types.js";
import type { Logger } from "pino";

export type DaemonMode = "solo" | "connected";

export class DualStorage {
  readonly mode: DaemonMode;
  readonly sqlite: CyborgStorage;
  private _pg: PgSync | null;
  // Async PG-sync failures route here (#736) so they reach daemon.log instead of
  // the supervisor's /dev/null. Null when the caller omits it (tests).
  private readonly logger: Logger | null;

  constructor(sqlite: CyborgStorage, pg: PgSync | null, logger?: Logger) {
    this.sqlite = sqlite;
    this._pg = pg;
    this.mode = pg ? "connected" : "solo";
    this.logger = logger ?? null;
  }

  get pg(): PgSync | null {
    return this._pg;
  }

  // ─── Users ───────────────────────────────────────────────────────

  upsertUser(email: string, name?: string | null): StoredUser {
    // SQLite resolves to a DETERMINISTIC, email-derived id (canonicalUserId) so
    // every store agrees and the auth path can never bind to a per-file random id
    // again. In connected mode PG is the AUTHORITATIVE id source: if PG already
    // holds a row for this email under a different (older, real account) id, we
    // adopt THAT id into SQLite so the two never diverge. The reconcile is async
    // (PG returns the real id) but the caller gets the immediate SQLite row.
    const user = this.sqlite.upsertUser(email, name);
    if (this._pg) {
      this._pg
        .upsertUser(user.id, email, name)
        .then((pgId) => {
          if (pgId && pgId !== user.id) {
            this.sqlite.adoptCanonicalUserId(email, pgId, name);
          }
          return undefined;
        })
        .catch(this.logSyncError("upsertUser"));
    }
    return user;
  }

  // Re-key the local SQLite user for `email` onto PG's authoritative id and pull
  // that user's real workspaces (name + owner) down. Run on daemon connect for
  // the owner so a SQLite cache built under a stale random id (the
  // workspace-visibility bug) reconciles to the cloud truth. No-op in solo mode.
  async reconcileUserFromPg(email: string, name?: string | null): Promise<StoredUser | undefined> {
    if (!this._pg) return this.sqlite.getUserByEmail(email);
    const local = this.sqlite.upsertUser(email, name);
    const pgId = await this._pg.upsertUser(local.id, email, name);
    const user = this.sqlite.adoptCanonicalUserId(email, pgId, name);
    // Hydrate the owner's authoritative workspaces (name + true owner) so any
    // stale "Remote"/caller-owned stub in SQLite is corrected and missing rows
    // appear.
    const workspaces = await this._pg.getWorkspacesForUser(pgId);
    for (const ws of workspaces) {
      this.sqlite.ensureUser(ws.owner_id);
      if (!this.sqlite.getWorkspace(ws.id)) {
        this.sqlite.createWorkspaceWithId(ws.id, ws.name, ws.owner_id);
      } else {
        this.sqlite.updateWorkspace(ws.id, { name: ws.name });
      }
      if (!this.sqlite.getMembership(ws.id, pgId)) {
        this.sqlite.addMember(ws.id, pgId, ws.role, "active");
      }
    }
    return user;
  }

  // Adopt an EXPLICIT canonical id (the real cloud account id, e.g. from a token
  // payload) for an email already present locally under a different id. Re-keys
  // the SQLite row (migrating its child data) and mirrors the upsert to PG.
  adoptCanonicalUserId(email: string, canonicalId: string, name?: string | null): StoredUser {
    const user = this.sqlite.adoptCanonicalUserId(email, canonicalId, name);
    if (this._pg) {
      this._pg
        .upsertUser(canonicalId, email, name)
        .catch(this.logSyncError("adoptCanonicalUserId"));
    }
    return user;
  }

  getUserByEmail(email: string): StoredUser | undefined {
    return this.sqlite.getUserByEmail(email);
  }

  getUserById(id: string): StoredUser | undefined {
    return this.sqlite.getUserById(id);
  }

  // ─── Workspaces ──────────────────────────────────────────────────

  createWorkspace(
    name: string,
    ownerId: string,
    settings?: Record<string, unknown>,
  ): StoredWorkspace {
    const ws = this.sqlite.createWorkspace(name, ownerId, settings);
    if (this._pg) {
      // ATOMIC PG create: workspace + owner membership + general channel land in
      // ONE transaction, or none do. The old code chained three separate
      // fire-and-forget awaits — a failure after the workspace insert (e.g.
      // addMember) left a membership-less ORPHAN workspace its own owner could
      // never see (19 such rows found in prod). The general channel id is taken
      // from the SQLite row so both stores agree on it.
      const general = this.sqlite.getChannels(ws.id).find((c) => c.name === "general");
      this._pg
        .createWorkspaceAtomic({
          id: ws.id,
          name,
          ownerId,
          settings,
          generalChannelId: general?.id ?? null,
        })
        .catch(this.logSyncError("createWorkspace"));
    }
    return ws;
  }

  getWorkspacesForUser(userId: string): Array<StoredWorkspace & { role: string }> {
    return this.sqlite.getWorkspacesForUser(userId);
  }

  getWorkspace(workspaceId: string): StoredWorkspace | undefined {
    return this.sqlite.getWorkspace(workspaceId);
  }

  getAllWorkspaceIds(): string[] {
    return this.sqlite.getAllWorkspaceIds();
  }

  updateWorkspace(
    workspaceId: string,
    updates: { name?: string; avatarUrl?: string | null; settings?: Record<string, unknown> },
  ): void {
    this.sqlite.updateWorkspace(workspaceId, updates);
    if (this._pg) {
      this._pg.updateWorkspace(workspaceId, updates).catch(this.logSyncError("updateWorkspace"));
    }
  }

  deleteWorkspace(workspaceId: string): void {
    this.sqlite.deleteWorkspace(workspaceId);
    if (this._pg) {
      this._pg.deleteWorkspace(workspaceId).catch(this.logSyncError("deleteWorkspace"));
    }
  }

  // ─── Memberships ─────────────────────────────────────────────────

  addMember(workspaceId: string, userId: string, role = "member", membershipType = "active"): void {
    this.sqlite.addMember(workspaceId, userId, role, membershipType);
    if (this._pg) {
      this._pg
        .addMember(workspaceId, userId, role, membershipType)
        .catch(this.logSyncError("addMember"));
    }
  }

  getMembership(workspaceId: string, userId: string): StoredMembership | undefined {
    return this.sqlite.getMembership(workspaceId, userId);
  }

  ensureMembership(workspaceId: string, userId: string, role = "owner"): void {
    const existing = this.sqlite.getMembership(workspaceId, userId);
    if (existing) {
      // The relay forwards the caller's AUTHORITATIVE role (it resolves it from
      // cloud PG via getMemberRole and attaches it to every relay_rpc). A stale
      // local cache row must not shadow it: this used to `return` on ANY existing
      // row, so a user whose cloud role is owner/admin but whose local row was a
      // stale "member" (synced before a role change, or never refreshed) was judged
      // by the WRONG role and falsely denied create_cybo/create_agent — the
      // permission check reads getMembership(), not the auth context. Refresh the
      // cached role to match the authoritative one the relay just resolved.
      if (existing.role !== role) {
        this.sqlite.updateMembership(workspaceId, userId, role);
      }
      return;
    }
    // A relay-forwarded RPC carries a CLOUD user id that may not exist in this
    // daemon's local SQLite (solo mode). Without the parent user row the
    // memberships FK (user_id → users.id) fails — an uncaught SqliteError that
    // crashed the daemon worker on every forwarded message (reconnect storm).
    // Materialize the user (and workspace) before the membership insert.
    this.sqlite.ensureUser(userId);
    const hadWorkspace = !!this.sqlite.getWorkspace(workspaceId);
    if (!hadWorkspace) {
      // Materialize a PLACEHOLDER so the membership FK resolves now. The real
      // name + owner come from PG via the async hydrate below — never leave it as
      // the old hardcoded "Remote"/caller-as-owner stub (that diverged the local
      // cache from the authoritative cloud workspace).
      this.sqlite.createWorkspaceWithId(workspaceId, "Remote", userId);
    }
    this.sqlite.addMember(workspaceId, userId, role, "active");
    // Hydrate the authoritative workspace name + owner from PG (fire-and-forget).
    // ensureMembership is on the synchronous relay-forward hot path and must not
    // become async (it would ripple into bootstrap's forward handler), so the
    // correction lands a tick later — the placeholder is transient.
    if (!hadWorkspace && this._pg) {
      this._pg
        .getWorkspaceNameAndOwner(workspaceId)
        .then((real) => {
          if (real) {
            this.sqlite.ensureUser(real.ownerId);
            this.sqlite.updateWorkspace(workspaceId, { name: real.name });
            this.sqlite.reassignWorkspaceOwner(workspaceId, real.ownerId);
          }
          return undefined;
        })
        .catch(this.logSyncError("ensureMembership:hydrate"));
    }
  }

  getMembers(
    workspaceId: string,
  ): Array<StoredMembership & { email: string; name: string | null }> {
    return this.sqlite.getMembers(workspaceId);
  }

  deleteMembership(workspaceId: string, userId: string): void {
    this.sqlite.deleteMembership(workspaceId, userId);
  }

  updateMembership(workspaceId: string, userId: string, role: string): void {
    this.sqlite.updateMembership(workspaceId, userId, role);
  }

  // ─── Channels ────────────────────────────────────────────────────

  createChannel(
    workspaceId: string,
    name: string,
    createdBy: string,
    opts?: {
      description?: string;
      isPrivate?: boolean;
      instructions?: string;
      // #608: channel kind + browser visibility. Defaults (regular/false) keep
      // existing callers byte-identical.
      type?: string;
      isHidden?: boolean;
    },
  ): StoredChannel {
    const ch = this.sqlite.createChannel(workspaceId, name, createdBy, opts);
    if (this._pg) {
      this._pg
        .createChannel(ch.id, workspaceId, name, createdBy, opts)
        .catch(this.logSyncError("createChannel"));
    }
    return ch;
  }

  // #608: create a group-DM channel. The channel row lives in SQLite (so the
  // local sidebar can group it under DMs); per-channel MEMBERSHIP lives only in
  // PG (SQLite has no channel_members table — channels are workspace-visible
  // locally), so the creator + participant member rows are written atomically to
  // PG via createGroupDm. Returns the SQLite channel row for the caller's
  // response. participantIds are the OTHER members (creator added separately).
  createGroupDm(args: {
    workspaceId: string;
    name: string;
    createdBy: string;
    participantIds: string[];
  }): StoredChannel {
    const ch = this.sqlite.createChannel(args.workspaceId, args.name, args.createdBy, {
      isPrivate: true,
      isHidden: true,
      type: "group_dm",
    });
    if (this._pg) {
      this._pg
        .createGroupDm({
          id: ch.id,
          workspaceId: args.workspaceId,
          name: args.name,
          createdBy: args.createdBy,
          participantIds: args.participantIds,
        })
        .catch(this.logSyncError("createGroupDm"));
    }
    return ch;
  }

  getChannels(workspaceId: string): StoredChannel[] {
    return this.sqlite.getChannels(workspaceId);
  }

  getChannel(channelId: string): StoredChannel | undefined {
    return this.sqlite.getChannel(channelId);
  }

  // ─── Messages ────────────────────────────────────────────────────

  insertMessage(msg: {
    workspaceId: string;
    channelId?: string | null;
    fromId: string;
    fromType: "human" | "agent";
    fromName?: string | null;
    toId?: string | null;
    text: string;
    mentions?: string[] | null;
    parentId?: string | null;
    attachments?: unknown[] | null;
  }): StoredMessage {
    const stored = this.sqlite.insertMessage(msg);
    if (this._pg) {
      this._pg
        .insertMessage({
          id: stored.id,
          workspaceId: stored.workspace_id,
          channelId: stored.channel_id,
          fromId: stored.from_id,
          fromType: stored.from_type,
          fromName: stored.from_name,
          toId: stored.to_id,
          text: stored.text,
          mentions: stored.mentions ? JSON.parse(stored.mentions) : null,
          parentId: stored.parent_id,
          attachments: stored.attachments ? JSON.parse(stored.attachments) : null,
          seq: stored.seq,
          createdAt: stored.created_at,
        })
        .catch(this.logSyncError("insertMessage"));
    }
    return stored;
  }

  getMessages(opts: { channelId: string; before?: string; limit?: number }): StoredMessage[] {
    return this.sqlite.getMessages(opts);
  }

  getThreadReplies(parentId: string): StoredMessage[] {
    return this.sqlite.getThreadReplies(parentId);
  }

  searchMessages(
    workspaceId: string,
    query: string,
    limit?: number,
    channelId?: string,
  ): StoredMessage[] {
    return this.sqlite.searchMessages(workspaceId, query, limit, channelId);
  }

  getThreadMeta(channelId: string): Map<string, { count: number; lastReplyAt: number }> {
    return this.sqlite.getThreadMeta(channelId);
  }

  setPinned(
    messageId: string,
    pinnedBy: string | null,
  ): { pinnedAt: number | null; pinnedBy: string | null } {
    const result = this.sqlite.setPinned(messageId, pinnedBy);
    if (this._pg) {
      this._pg.setPinned(messageId, pinnedBy).catch(this.logSyncError("setPinned"));
    }
    return result;
  }

  getPinnedMessages(channelId: string): StoredMessage[] {
    return this.sqlite.getPinnedMessages(channelId);
  }

  getMessageById(id: string): StoredMessage | undefined {
    return this.sqlite.getMessageById(id);
  }

  updateMessageText(id: string, text: string): number {
    const updatedAt = this.sqlite.updateMessageText(id, text);
    if (this._pg) {
      this._pg.updateMessageText(id, text).catch(this.logSyncError("updateMessageText"));
    }
    return updatedAt;
  }

  deleteMessage(id: string): void {
    this.sqlite.deleteMessage(id);
    if (this._pg) {
      this._pg.deleteMessage(id).catch(this.logSyncError("deleteMessage"));
    }
  }

  markRead(workspaceId: string, userId: string, channelId: string, lastReadAt: number): void {
    this.sqlite.markRead(workspaceId, userId, channelId, lastReadAt);
    if (this._pg) {
      this._pg
        .markRead(workspaceId, userId, channelId, lastReadAt)
        .catch(this.logSyncError("markRead"));
    }
  }

  getLastRead(userId: string, channelId: string): number | null {
    return this.sqlite.getLastRead(userId, channelId);
  }

  getUnreadCounts(workspaceId: string, userId: string): Map<string, number> {
    return this.sqlite.getUnreadCounts(workspaceId, userId);
  }

  getReadsForUser(workspaceId: string, userId: string): Map<string, number> {
    return this.sqlite.getReadsForUser(workspaceId, userId);
  }

  // ─── Notification preferences ────────────────────────────────────

  setNotificationPref(
    workspaceId: string,
    userId: string,
    scopeId: string,
    preference: string,
  ): void {
    this.sqlite.setNotificationPref(workspaceId, userId, scopeId, preference);
    if (this._pg) {
      this._pg
        .setNotificationPref(workspaceId, userId, scopeId, preference)
        .catch(this.logSyncError("setNotificationPref"));
    }
  }

  getNotificationPrefs(workspaceId: string, userId: string): Map<string, string> {
    return this.sqlite.getNotificationPrefs(workspaceId, userId);
  }

  getNotificationPref(userId: string, scopeId: string): string | null {
    return this.sqlite.getNotificationPref(userId, scopeId);
  }

  // ─── Composer drafts (server-side draft sync, #610) ──────────────
  // Write SQLite first (instant local cache), then fire-and-forget to PG (the
  // cross-device sync layer) — same dual-write pattern as setNotificationPref.
  setDraft(
    workspaceId: string,
    userId: string,
    scope: string,
    text: string,
    updatedAt: number,
  ): void {
    this.sqlite.setDraft(workspaceId, userId, scope, text, updatedAt);
    if (this._pg) {
      // Thread the client's edit time through so PG matches the SQLite mirror —
      // the reconcile is newest-updatedAt-wins, so PG must not stamp its own now().
      this._pg
        .setDraft({ workspaceId, userId, scope, text, updatedAt: new Date(updatedAt) })
        .catch(this.logSyncError("setDraft"));
    }
  }

  clearDraft(workspaceId: string, userId: string, scope: string): void {
    this.sqlite.clearDraft(workspaceId, userId, scope);
    if (this._pg) {
      this._pg.clearDraft(workspaceId, userId, scope).catch(this.logSyncError("clearDraft"));
    }
  }

  getDrafts(
    workspaceId: string,
    userId: string,
  ): Array<{ scope: string; text: string; updatedAt: number }> {
    return this.sqlite.getDrafts(workspaceId, userId);
  }

  // ─── Activity feed ───────────────────────────────────────────────

  insertActivityEvent(e: {
    // Optional deterministic id (agent-mention dedup): forwarded to SQLite, which
    // adopts it as the row id, and then reused verbatim for the PG mirror below so
    // BOTH stores key on the same id the relay's cloud-mirror write also uses.
    id?: string;
    workspaceId: string;
    userId: string;
    eventType: string;
    sourceType: string;
    sourceId: string;
    channelId?: string | null;
    previewText?: string | null;
    actorId?: string | null;
    actorName?: string | null;
  }): StoredActivityEvent {
    const stored = this.sqlite.insertActivityEvent(e);
    if (this._pg) {
      this._pg
        .insertActivityEvent({ ...e, id: stored.id, createdAt: stored.created_at })
        .catch(this.logSyncError("insertActivityEvent"));
    }
    return stored;
  }

  getActivity(
    workspaceId: string,
    userId: string,
    opts?: { limit?: number; before?: number; unreadOnly?: boolean },
  ): StoredActivityEvent[] {
    return this.sqlite.getActivity(workspaceId, userId, opts);
  }

  markActivityRead(eventId: string, userId: string): void {
    this.sqlite.markActivityRead(eventId, userId);
    if (this._pg)
      this._pg.markActivityRead(eventId, userId).catch(this.logSyncError("markActivityRead"));
  }

  markAllActivityRead(workspaceId: string, userId: string): void {
    this.sqlite.markAllActivityRead(workspaceId, userId);
    if (this._pg)
      this._pg
        .markAllActivityRead(workspaceId, userId)
        .catch(this.logSyncError("markAllActivityRead"));
  }

  getUnreadActivityCount(workspaceId: string, userId: string): number {
    return this.sqlite.getUnreadActivityCount(workspaceId, userId);
  }

  getMessagesSince(workspaceId: string, sinceSeq: number, limit = 500): StoredMessage[] {
    return this.sqlite.getMessagesSince(workspaceId, sinceSeq, limit);
  }

  // The caller's unread slice for /catchup (reads go to SQLite, the local cache).
  getChannelMessagesSince(channelId: string, sinceMs: number, limit = 500): StoredMessage[] {
    return this.sqlite.getChannelMessagesSince(channelId, sinceMs, limit);
  }

  getDmMessages(workspaceId: string, userA: string, userB: string, limit = 50): StoredMessage[] {
    return this.sqlite.getDmMessages(workspaceId, userA, userB, limit);
  }

  // ─── Tasks ───────────────────────────────────────────────────────

  createTask(opts: {
    workspaceId: string;
    title: string;
    createdBy: string;
    description?: string;
    assigneeId?: string;
    dueAt?: number;
    // Tasks Phase 2 (watcher) — channel binding + board priority. Mirrored to PG
    // via the explicit field list below.
    channelId?: string | null;
    priority?: string | null;
    // Tasks Phase 0 — planned start (Gantt left edge) + draft flag.
    startDate?: number | null;
    isDraft?: boolean;
    // Tasks Redesign P0 (Plane-style) — Tasks-project membership, sub-task parent,
    // workflow state, single cycle (scalars), plus the denormalized label/module
    // sets. `labels` are free-text NAMES (resolved/created against the task's final
    // project on EACH store); `moduleIds` are ids. All optional + back-compat. Both
    // stores resolve the effective project/state from the same explicit inputs, so a
    // connected daemon writes a consistent row to SQLite and PG (no divergence).
    projectId?: string | null;
    parentId?: string | null;
    stateId?: string | null;
    cycleId?: string | null;
    labels?: string[];
    moduleIds?: string[];
    // Require-project opt-in (default false). Threaded to BOTH stores so a
    // contextless create resolves identically: false → workspace Inbox fallback;
    // true → throw "provide projectId or channelId" (the user/cybo-facing handlers).
    requireProjectContext?: boolean;
  }): StoredTask {
    // SQLite resolves the effective project + persists the label/module joins
    // (it owns name→id label resolution and the join writers). The full opts spread
    // carries requireProjectContext to the SQLite resolver.
    const task = this.sqlite.createTask(opts);
    if (this._pg) {
      // Mirror the RESOLVED row, not just opts: sort_order is computed in SQLite
      // (lane tail), so PG must carry that exact value — otherwise the cloud relay
      // reads a NULL sort_order and the board order diverges from the daemon. The
      // Redesign scalars are forwarded as-is (PG resolves project/state/sequence on
      // its own side); labels go as NAMES (PG resolves them against its project) and
      // moduleIds as ids — both land in PG's join tables, NOT as task columns.
      this._pg
        .createTask({
          id: task.id,
          workspaceId: opts.workspaceId,
          title: opts.title,
          createdBy: opts.createdBy,
          description: opts.description,
          assigneeId: opts.assigneeId,
          dueAt: opts.dueAt,
          channelId: opts.channelId,
          priority: opts.priority,
          sortOrder: task.sort_order ?? null,
          startDate: task.start_date ?? null,
          isDraft: (task.is_draft ?? 0) === 1,
          projectId: opts.projectId,
          parentId: opts.parentId,
          stateId: opts.stateId,
          cycleId: opts.cycleId,
          labelNames: opts.labels,
          moduleIds: opts.moduleIds,
          // Same require-project decision on the PG side so the mirror row resolves
          // its project identically (no SQLite-Inbox / PG-throw divergence).
          requireProjectContext: opts.requireProjectContext,
        })
        .catch(this.logSyncError("createTask"));
    }
    return task;
  }

  updateTask(
    taskId: string,
    updates: Record<string, unknown> & {
      // Redesign P0 — the denormalized sets. `labels` are NAMES (resolved/created
      // against the task's effective project); `labelIds` are pre-resolved ids;
      // `moduleIds` are ids. labelIds win over labels when both are present (the
      // dispatcher resolves names → ids once and passes labelIds to keep SQLite + PG
      // pointing at the same label rows). Scalars (project/parent/state/cycle/
      // startDate) pass straight through as task columns.
      labels?: string[];
      labelIds?: string[];
      moduleIds?: string[];
    },
  ): StoredTask | undefined {
    // Resolve label NAMES → ids ONCE on the SQLite catalog so both stores replace-set
    // the SAME label rows. The task's effective project is its destination project
    // (re-parent) or its current one; an unprojected task has no label catalog, so
    // labels resolve to []. An explicit labelIds (already resolved) wins; a `labels`
    // array (incl. []) is resolved here.
    let labelIds = updates.labelIds;
    if (labelIds === undefined && updates.labels !== undefined) {
      const prev = this.sqlite.getTaskById(taskId);
      // The destination projectId arrives as a WIRE id (the UI sends the chat
      // project id), so translate it to the local tasks_projects.id before anchoring
      // labels — resolving against a chat id would miss the catalog and silently drop
      // the labels. The task's CURRENT project_id is now also an OUTBOUND chat id
      // (getTaskById translates tasks_projects.id → chat_project_id), so it gets the
      // SAME translation back to the local tasks_projects.id; resolveLabels (and the
      // tasks_projects lookup behind it) keys off the tasks_projects id, not the chat id.
      const destProjectId =
        typeof updates.projectId === "string"
          ? this.sqlite.resolveTasksProjectId(updates.projectId)
          : (updates.projectId as null | undefined);
      const prevProjectId = prev?.project_id
        ? this.sqlite.resolveTasksProjectId(prev.project_id)
        : null;
      const projectId = destProjectId ?? prevProjectId ?? null;
      labelIds = projectId ? this.sqlite.resolveLabels(projectId, updates.labels) : [];
    }
    // Strip the NAME form before handing to either store — both consume ids.
    const { labels: _labels, ...rest } = updates;
    const normalized = { ...rest, ...(labelIds !== undefined ? { labelIds } : {}) };

    const task = this.sqlite.updateTask(taskId, normalized);
    // Mirror the update to PG (fire-and-forget), exactly like createTask above.
    // Without this, a cybo's update_task, a UI status change, or a drag-to-move
    // only ever lands in local SQLite — the cloud relay and any second daemon keep
    // reading the stale row from PG (e.g. a task shown "done" locally stays
    // "pending" everywhere else). Guarded on a successful local update. PG's
    // updateTask takes labelIds + moduleIds and replace-sets its join tables.
    if (task && this._pg) {
      this._pg
        .updateTask(taskId, normalized as Parameters<PgSync["updateTask"]>[1])
        .catch(this.logSyncError("updateTask"));
    }
    return task;
  }

  getTasks(
    workspaceId: string,
    filter?: {
      status?: string;
      assigneeId?: string;
      limit?: number;
      cursor?: string;
      projectId?: string;
    },
  ): StoredTask[] {
    return this.sqlite.getTasks(workspaceId, filter);
  }

  // Phase 0 — paginated read (opaque cursor). Reads from the authoritative local
  // SQLite, exactly like getTasks; the cursor is consistent because the order is
  // deterministic (sort_order NULLS LAST, created_at, id). `projectId` (already a
  // resolved tasks_projects.id) scopes the page to a single Tasks-project.
  getTasksPage(
    workspaceId: string,
    filter?: {
      status?: string;
      assigneeId?: string;
      limit?: number;
      cursor?: string;
      projectId?: string;
    },
  ): { tasks: StoredTask[]; nextCursor: string | null } {
    return this.sqlite.getTasksPage(workspaceId, filter);
  }

  // Phase 0 — drag-reorder. SQLite is authoritative for the resolved sort_order;
  // mirror the SAME value to PG (fire-and-forget) so the cloud relay's board order
  // matches, following updateTask's mirroring + logSyncError pattern.
  reorderTask(
    taskId: string,
    opts: { beforeId?: string; afterId?: string },
  ): StoredTask | undefined {
    const task = this.sqlite.reorderTask(taskId, opts);
    if (task && this._pg) {
      this._pg
        .updateTask(taskId, { sortOrder: task.sort_order ?? null })
        .catch(this.logSyncError("reorderTask"));
    }
    return task;
  }

  // Phase 0 — bulk edit. Apply locally (one transaction), then mirror each updated
  // row to PG individually (fire-and-forget per row, same as updateTask) so a PG
  // hiccup on one row never blocks the others or the response.
  bulkUpdateTasks(taskIds: readonly string[], updates: Record<string, unknown>): StoredTask[] {
    const tasks = this.sqlite.bulkUpdateTasks(taskIds, updates);
    if (this._pg) {
      for (const t of tasks) {
        this._pg
          .updateTask(t.id, updates as Parameters<PgSync["updateTask"]>[1])
          .catch(this.logSyncError("bulkUpdateTasks"));
      }
    }
    return tasks;
  }

  // Phase 0 — hard delete. SQLite first (authoritative), then mirror to PG.
  deleteTask(taskId: string): boolean {
    const deleted = this.sqlite.deleteTask(taskId);
    if (deleted && this._pg) {
      this._pg.deleteTask(taskId).catch(this.logSyncError("deleteTask"));
    }
    return deleted;
  }

  // Phase 0 — soft archive / un-archive. SQLite first, then mirror the archived_at
  // value to PG via updateTask (epoch ms | null) following the updateTask pattern.
  archiveTask(taskId: string, archived: boolean): StoredTask | undefined {
    const task = this.sqlite.archiveTask(taskId, archived);
    if (task && this._pg) {
      this._pg
        .updateTask(taskId, { archivedAt: task.archived_at ?? null })
        .catch(this.logSyncError("archiveTask"));
    }
    return task;
  }

  // ─── Tasks Phase 3 (execute-dispatch + scheduling) ──────────────────
  //
  // The per-daemon TaskRunner reads/claims tasks from the AUTHORITATIVE local
  // SQLite (synchronous, in-process atomic) — the same pattern the ScheduleRunner
  // uses for schedules. SQLite holds only this daemon's workspaces, which is
  // exactly the scope a daemon dispatches. The claim is ALSO mirrored to PG so the
  // cloud relay / a second replica sees the dispatch window and can't double-fire
  // across processes (internal docs §6.7). The SQLite claim is the local
  // serializer; the PG mirror is the cross-process one. getDueTasks /
  // getOwnedOpenTasks read SQLite (local, fast); spawnRecurrenceChild claims +
  // inserts atomically in SQLite and mirrors the spawn to PG.

  // Atomic dispatch claim. True iff THIS caller won the claim (unclaimed or stale).
  // SQLite is the local serializer; the PG mirror (fire-and-forget) propagates the
  // claim window to other replicas. A failed PG mirror is logged, never fatal — the
  // local claim still held, so this daemon won't double-fire; a cross-replica race
  // is bounded by the 30s window either way.
  claimTaskDispatch(taskId: string, staleMs = 30_000): boolean {
    const won = this.sqlite.claimTaskDispatch(taskId, staleMs);
    if (won && this._pg) {
      this._pg.claimTaskDispatch(taskId, staleMs).catch(this.logSyncError("claimTaskDispatch"));
    }
    return won;
  }

  // Open, agent-assignable tasks whose due_at has arrived and whose dispatch slot
  // is claimable. Read from local SQLite (this daemon's workspaces). The per-task
  // claim above is still applied before each dispatch.
  getDueTasks(now: number = Date.now(), staleMs = 30_000): StoredTask[] {
    return this.sqlite.getDueTasks(now, staleMs);
  }

  // Single-task read by id (label_ids/module_ids enriched). Reads the authoritative
  // local SQLite. Used by the schedule runner to load a schedule's bound task before
  // dispatching it (per-task scheduling).
  getTaskById(taskId: string): StoredTask | undefined {
    return this.sqlite.getTaskById(taskId);
  }

  // Owned open tasks for a daemon's cybos (catch-up on reconnect). Ownership is
  // sticky — only the OWNING daemon's cybo ids are passed in.
  getOwnedOpenTasks(
    workspaceId: string,
    assigneeIds: readonly string[],
    staleMs = 3_600_000,
  ): StoredTask[] {
    return this.sqlite.getOwnedOpenTasks(workspaceId, assigneeIds, staleMs);
  }

  // Atomic recurrence spawn-next. Claims the parent's spawn slot + inserts the
  // child in one SQLite transaction (exactly-once locally), then mirrors the child
  // insert + parent claim to PG. Returns the child, or undefined if already
  // spawned / cap reached / parent missing.
  spawnRecurrenceChild(
    parentId: string,
    childDueAt: number | null,
    maxRecurrenceCount: number,
  ): StoredTask | undefined {
    const child = this.sqlite.spawnRecurrenceChild(parentId, childDueAt, maxRecurrenceCount);
    if (child && this._pg) {
      this._pg
        .spawnRecurrenceChild(parentId, childDueAt, maxRecurrenceCount)
        .catch(this.logSyncError("spawnRecurrenceChild"));
    }
    return child;
  }

  // ─── Schedules (recurring cybo runs) ────────────────────────────
  //
  // #207 — the PG `schedules` table is a WRITE-ONLY mirror, for visibility only.
  // SQLite is the AUTHORITATIVE store for the cron path: the per-daemon
  // ScheduleRunner reads `getDueSchedules`/`listSchedules`/`getSchedule` from
  // SQLite (below), never from PG, and `db/pg-sync.ts` deliberately exposes no
  // schedule READ methods. Writes mirror to PG fire-and-forget; a failed mirror
  // write is LOGGED via `logSyncError` but NOT auto-reconciled (no outbox), so PG
  // can drift until the next successful write to that row. Harmless while nothing
  // reads PG schedules — but BEFORE adding a cloud reader, add reconciliation
  // (or read-repair), or a failed markScheduleRun/deleteSchedule could double-fire
  // / resurrect a schedule.

  createSchedule(opts: {
    workspaceId: string;
    cyboId: string;
    cronExpr: string;
    prompt: string;
    createdBy: string;
    channelId?: string | null;
    // Per-task scheduling: bind this schedule to a task. Carried through to PG so
    // the cloud mirror matches (createSchedule mirrors the full row).
    taskId?: string | null;
    timezone?: string | null;
    nextRunAt?: number | null;
    enabled?: boolean;
    // Phase 2 (#619): one-shot cap + catch-up policy. Carried through to PG so
    // the cloud mirror matches (createSchedule mirrors the full row).
    maxRuns?: number | null;
    catchUp?: boolean;
  }): StoredSchedule {
    const schedule = this.sqlite.createSchedule(opts);
    if (this._pg) {
      this._pg.createSchedule(schedule).catch(this.logSyncError("createSchedule"));
    }
    return schedule;
  }

  getSchedule(id: string): StoredSchedule | undefined {
    return this.sqlite.getSchedule(id);
  }

  listSchedules(workspaceId: string): StoredSchedule[] {
    return this.sqlite.listSchedules(workspaceId);
  }

  getDueSchedules(now: number): StoredSchedule[] {
    return this.sqlite.getDueSchedules(now);
  }

  markScheduleRun(
    id: string,
    lastRunAt: number,
    nextRunAt: number | null,
    incrementRunCount = false,
  ): void {
    this.sqlite.markScheduleRun(id, lastRunAt, nextRunAt, incrementRunCount);
    if (this._pg) {
      this._pg
        .markScheduleRun(id, lastRunAt, nextRunAt, incrementRunCount)
        .catch(this.logSyncError("markScheduleRun"));
    }
  }

  setScheduleEnabled(id: string, enabled: boolean, nextRunAt?: number | null): void {
    this.sqlite.setScheduleEnabled(id, enabled, nextRunAt);
    if (this._pg) {
      this._pg
        .setScheduleEnabled(id, enabled, nextRunAt ?? null)
        .catch(this.logSyncError("setScheduleEnabled"));
    }
  }

  updateSchedule(
    id: string,
    fields: {
      cronExpr?: string;
      prompt?: string;
      channelId?: string | null;
      taskId?: string | null;
      timezone?: string | null;
      nextRunAt?: number | null;
    },
  ): StoredSchedule | undefined {
    const updated = this.sqlite.updateSchedule(id, fields);
    if (this._pg) {
      this._pg.updateSchedule(id, fields).catch(this.logSyncError("updateSchedule"));
    }
    return updated;
  }

  deleteSchedule(id: string): void {
    this.sqlite.deleteSchedule(id);
    if (this._pg) {
      this._pg.deleteSchedule(id).catch(this.logSyncError("deleteSchedule"));
    }
  }

  // Cloud-only READ from the PG mirror (internal docs): the relay answers
  // list_schedules for cloud/DMG users from PG so schedules are visible even
  // when the owning daemon is offline. Returns [] in solo mode (no PG). This is
  // the deliberate exception to the "PG schedule table is write-only" rule —
  // safe because it never feeds execution (the runner only reads SQLite).
  async listSchedulesFromPg(workspaceId: string): Promise<StoredSchedule[]> {
    if (!this._pg) return [];
    return this._pg.listSchedules(workspaceId);
  }

  async getScheduleFromPg(id: string): Promise<StoredSchedule | undefined> {
    if (!this._pg) return undefined;
    return this._pg.getSchedule(id);
  }

  // ─── Built-in integrations (recipes) ─────────────────────────────
  // SQLite is authoritative on a solo/local daemon; writes mirror to PG
  // fire-and-forget (logged on failure). Reads come from SQLite, EXCEPT the cloud
  // relay which calls listRecipesFromPg so installs are visible while the owning
  // daemon is asleep (the same exception listSchedulesFromPg makes for schedules).

  enableRecipe(opts: {
    id: string;
    workspaceId: string;
    recipeId: string;
    config?: Record<string, unknown>;
    createdBy: string;
  }): StoredInstalledRecipe {
    const recipe = this.sqlite.enableRecipe(opts);
    if (this._pg) {
      this._pg.enableRecipe(opts).catch(this.logSyncError("enableRecipe"));
    }
    return recipe;
  }

  setRecipeProvisioned(id: string, cyboId: string, scheduleIds: string[]): void {
    this.sqlite.setRecipeProvisioned(id, cyboId, scheduleIds);
    if (this._pg) {
      this._pg
        .setRecipeProvisioned(id, cyboId, scheduleIds)
        .catch(this.logSyncError("setRecipeProvisioned"));
    }
  }

  disableRecipe(workspaceId: string, recipeId: string): void {
    this.sqlite.disableRecipe(workspaceId, recipeId);
    if (this._pg) {
      this._pg.disableRecipe(workspaceId, recipeId).catch(this.logSyncError("disableRecipe"));
    }
  }

  listRecipesForWorkspace(workspaceId: string): StoredInstalledRecipe[] {
    return this.sqlite.listRecipesForWorkspace(workspaceId);
  }

  getInstalledRecipe(workspaceId: string, recipeId: string): StoredInstalledRecipe | null {
    return this.sqlite.getInstalledRecipe(workspaceId, recipeId);
  }

  // Cloud-only READ from the PG mirror: the relay answers list_recipes for
  // cloud/DMG users from PG so installs are visible even when the owning daemon is
  // offline. Returns [] in solo mode (no PG).
  async listRecipesFromPg(workspaceId: string): Promise<StoredInstalledRecipe[]> {
    if (!this._pg) return [];
    return this._pg.listRecipesForWorkspace(workspaceId);
  }

  // ─── Schedule runs (run history — #619) ──────────────────────────
  // SQLite is authoritative (solo daemons keep their full history); PG mirrors
  // fire-and-forget for cloud visibility. The runner opens a row at fire and
  // closes it at finish, or records a single 'skipped' row when it never fires.

  // Returns the SQLite run id; the caller passes it back to finishScheduleRun.
  startScheduleRun(opts: {
    scheduleId: string;
    workspaceId: string;
    scheduledFor: number | null;
  }): string {
    const startedAt = Date.now();
    const id = this.sqlite.startScheduleRun({ ...opts, startedAt });
    if (this._pg) {
      this._pg
        .startScheduleRun({
          id,
          schedule_id: opts.scheduleId,
          workspace_id: opts.workspaceId,
          scheduled_for: opts.scheduledFor,
          started_at: startedAt,
        })
        .catch(this.logSyncError("startScheduleRun"));
    }
    return id;
  }

  finishScheduleRun(opts: {
    id: string;
    status: "succeeded" | "failed";
    agentId?: string | null;
    error?: string | null;
  }): void {
    const endedAt = Date.now();
    this.sqlite.finishScheduleRun({ ...opts, endedAt });
    if (this._pg) {
      this._pg
        .finishScheduleRun({
          id: opts.id,
          status: opts.status,
          agentId: opts.agentId ?? null,
          error: opts.error ?? null,
          endedAt,
        })
        .catch(this.logSyncError("finishScheduleRun"));
    }
  }

  recordSkippedScheduleRun(opts: {
    scheduleId: string;
    workspaceId: string;
    scheduledFor: number | null;
    skipReason: ScheduleSkipReason;
  }): void {
    const at = Date.now();
    const id = this.sqlite.recordSkippedScheduleRun({ ...opts, at });
    if (this._pg) {
      this._pg
        .recordSkippedScheduleRun({
          id,
          schedule_id: opts.scheduleId,
          workspace_id: opts.workspaceId,
          scheduled_for: opts.scheduledFor,
          skipReason: opts.skipReason,
          at,
        })
        .catch(this.logSyncError("recordSkippedScheduleRun"));
    }
  }

  // Run history for the "Last runs" drawer. SQLite for solo/local; the relay
  // reads from PG (listScheduleRunsFromPg) when the daemon may be asleep.
  listScheduleRuns(scheduleId: string, limit?: number): StoredScheduleRun[] {
    return this.sqlite.listScheduleRuns(scheduleId, limit);
  }

  async listScheduleRunsFromPg(scheduleId: string, limit?: number): Promise<StoredScheduleRun[]> {
    if (!this._pg) return [];
    return this._pg.listScheduleRuns(scheduleId, limit);
  }

  // ─── Scheduled messages (user "send later", #607) ────────────────
  //
  // SQLite is authoritative for the SOLO-daemon fire path: ScheduledMessageRunner
  // reads getDueScheduledMessages from SQLite and fires only when this daemon has
  // no PG (`pg === null`). When a daemon IS connected, the cloud relay's tick is
  // the single firer (PG, atomic FOR UPDATE SKIP LOCKED) — so the daemon never
  // double-fires PG-backed rows. Writes mirror to PG so the cloud `list` (and the
  // relay's tick) see the row. Same pattern + caveat as `schedules` above.

  createScheduledMessage(opts: {
    workspaceId: string;
    fromId: string;
    text: string;
    sendAt: number;
    channelId?: string | null;
    toId?: string | null;
    mentions?: string[] | null;
  }): StoredScheduledMessage {
    const row = this.sqlite.createScheduledMessage(opts);
    if (this._pg) {
      this._pg.createScheduledMessage(row).catch(this.logSyncError("createScheduledMessage"));
    }
    return row;
  }

  getScheduledMessage(id: string): StoredScheduledMessage | undefined {
    return this.sqlite.getScheduledMessage(id);
  }

  listScheduledMessages(workspaceId: string, fromId: string): StoredScheduledMessage[] {
    return this.sqlite.listScheduledMessages(workspaceId, fromId);
  }

  // Author's scheduled messages from PG (the cloud read path — used by the relay so
  // a DMG user sees their list even with no daemon of their own).
  async listScheduledMessagesFromPg(
    workspaceId: string,
    fromId: string,
  ): Promise<StoredScheduledMessage[]> {
    if (!this._pg) return [];
    return this._pg.listScheduledMessages(workspaceId, fromId);
  }

  getDueScheduledMessages(now: number): StoredScheduledMessage[] {
    return this.sqlite.getDueScheduledMessages(now);
  }

  updateScheduledMessage(
    id: string,
    fields: { text?: string; sendAt?: number; mentions?: string[] | null },
  ): StoredScheduledMessage | undefined {
    const row = this.sqlite.updateScheduledMessage(id, fields);
    if (this._pg) {
      this._pg
        .updateScheduledMessage(id, fields)
        .catch(this.logSyncError("updateScheduledMessage"));
    }
    return row;
  }

  markScheduledMessageProcessed(
    id: string,
    at: number,
    errorCode: ScheduledMessageErrorCode | null = null,
  ): boolean {
    const claimed = this.sqlite.markScheduledMessageProcessed(id, at, errorCode);
    if (this._pg) {
      this._pg
        .markScheduledMessageProcessed(id, at, errorCode)
        .catch(this.logSyncError("markScheduledMessageProcessed"));
    }
    return claimed;
  }

  // Record a failure reason on an already-claimed row (post-claim send threw).
  // Mirrors to PG so the cloud list shows the error too.
  setScheduledMessageError(id: string, errorCode: ScheduledMessageErrorCode): void {
    this.sqlite.setScheduledMessageError(id, errorCode);
    if (this._pg) {
      this._pg
        .setScheduledMessageError(id, errorCode)
        .catch(this.logSyncError("setScheduledMessageError"));
    }
  }

  deleteScheduledMessage(id: string): boolean {
    const deleted = this.sqlite.deleteScheduledMessage(id);
    if (this._pg) {
      this._pg.deleteScheduledMessage(id).catch(this.logSyncError("deleteScheduledMessage"));
    }
    return deleted;
  }

  // ─── Prompt templates (#602) ─────────────────────────────────────
  // Workspace config (like channels): writes go to SQLite then mirror to PG so
  // the cloud relay/list and other daemons see the row; reads come from SQLite.

  createPromptTemplate(opts: {
    workspaceId: string;
    name: string;
    body: string;
    createdBy: string | null;
  }): StoredPromptTemplate {
    const row = this.sqlite.createPromptTemplate(opts);
    if (this._pg) {
      this._pg.createPromptTemplate(row).catch(this.logSyncError("createPromptTemplate"));
    }
    return row;
  }

  getPromptTemplate(id: string): StoredPromptTemplate | undefined {
    return this.sqlite.getPromptTemplate(id);
  }

  getPromptTemplateByName(workspaceId: string, name: string): StoredPromptTemplate | undefined {
    return this.sqlite.getPromptTemplateByName(workspaceId, name);
  }

  listPromptTemplates(workspaceId: string): StoredPromptTemplate[] {
    return this.sqlite.listPromptTemplates(workspaceId);
  }

  updatePromptTemplate(
    id: string,
    fields: { name?: string; body?: string },
  ): StoredPromptTemplate | undefined {
    const row = this.sqlite.updatePromptTemplate(id, fields);
    if (this._pg) {
      this._pg.updatePromptTemplate(id, fields).catch(this.logSyncError("updatePromptTemplate"));
    }
    return row;
  }

  deletePromptTemplate(id: string): boolean {
    const deleted = this.sqlite.deletePromptTemplate(id);
    if (this._pg) {
      this._pg.deletePromptTemplate(id).catch(this.logSyncError("deletePromptTemplate"));
    }
    return deleted;
  }

  // ─── Agent Bindings (local only — agents run on this daemon) ────

  createAgentBinding(opts: {
    agentId: string;
    workspaceId: string;
    channelId?: string | null;
    provider: string;
    model?: string | null;
    systemPrompt?: string | null;
    daemonId?: string | null;
    cyboId?: string | null;
    initiatedBy?: string | null;
    // The initiator's REAL (canonical cloud) email, threaded from the caller's
    // auth on the cloud-forwarded path. PREFERRED over the local-id lookup below:
    // a cloud guest's local SQLite user row carries only the synthetic
    // "<id>@remote.local" placeholder (ensureUser), so without this the mirror
    // stored a fake email the offline visibility filter could never match (#810).
    initiatedByEmail?: string | null;
    cwd?: string | null;
    ephemeral?: boolean;
    // AUTONOMOUS (cron / scheduled / webhook) spawn — owner-scoped in the session
    // list (see agentBindingVisibleCore). Mirrored to PG so the offline list scopes
    // it identically to the live list.
    autonomous?: boolean;
  }): StoredAgentBinding {
    const binding = this.sqlite.createAgentBinding(opts);
    // Mirror NON-ephemeral bindings to PG so the cloud relay's list_agents can show
    // a workspace's sessions even when the owning daemon is offline (and they
    // reappear, resumable, when it reconnects). Ephemeral summons NEVER hit PG —
    // they don't survive a restart and would leak as ghost rows. Same fire-and-
    // forget + logSyncError pattern as archiveSession. initiated_by is a daemon-
    // local id, so we resolve its EMAIL here (the relay can't map the local id).
    if (this._pg && !opts.ephemeral) {
      // Prefer the caller-supplied real email; otherwise resolve from the local
      // user row. NEVER persist the daemon's synthetic "<id>@remote.local"
      // placeholder — it would never match a real cloud email in the offline
      // visibility filter, so store null and let the filter fall back to the
      // GLOBAL-id match (initiated_by == the viewer's global id) for these rows.
      const resolvedEmail =
        opts.initiatedByEmail ??
        (binding.initiated_by
          ? (this.sqlite.getUserById(binding.initiated_by)?.email ?? null)
          : null);
      const initiatedByEmail =
        resolvedEmail && resolvedEmail.toLowerCase().endsWith("@remote.local")
          ? null
          : resolvedEmail;
      this._pg
        .upsertAgentBinding({
          agentId: binding.agent_id,
          workspaceId: binding.workspace_id,
          channelId: binding.channel_id,
          provider: binding.provider,
          model: binding.model,
          systemPrompt: binding.system_prompt,
          daemonId: binding.daemon_id,
          cyboId: binding.cybo_id,
          initiatedBy: binding.initiated_by,
          initiatedByEmail,
          cwd: binding.cwd,
          providerSessionId: binding.provider_session_id,
          autonomous: binding.autonomous === 1,
        })
        .catch(this.logSyncError("upsertAgentBinding"));
    }
    return binding;
  }

  getAgentBinding(agentId: string): StoredAgentBinding | undefined {
    return this.sqlite.getAgentBinding(agentId);
  }

  getAgentsByWorkspace(workspaceId: string): StoredAgentBinding[] {
    return this.sqlite.getAgentsByWorkspace(workspaceId);
  }

  updateAgentBindingModel(agentId: string, model: string | null): void {
    this.sqlite.updateAgentBindingModel(agentId, model);
    if (this._pg) {
      // Ephemeral bindings are never mirrored, so a PG update would be a guaranteed
      // no-op roundtrip — skip it.
      const binding = this.sqlite.getAgentBinding(agentId);
      if (binding && !binding.ephemeral) {
        this._pg
          .updateAgentBindingModel(agentId, model)
          .catch(this.logSyncError("updateAgentBindingModel"));
      }
    }
  }

  // Best-effort provider resume id capture (turn end). Mirrors to PG so the offline
  // list row carries it too. A binding may not exist (ephemeral / non-bound agent)
  // — both stores no-op on a missing row.
  updateAgentBindingSession(agentId: string, providerSessionId: string | null): void {
    this.sqlite.updateAgentBindingSession(agentId, providerSessionId);
    if (this._pg) {
      // Same as above — ephemeral rows are not in PG, so skip the no-op roundtrip.
      const binding = this.sqlite.getAgentBinding(agentId);
      if (binding && !binding.ephemeral) {
        this._pg
          .updateAgentBindingSession(agentId, providerSessionId)
          .catch(this.logSyncError("updateAgentBindingSession"));
      }
    }
  }

  getCyboBindingsByWorkspace(workspaceId: string): StoredAgentBinding[] {
    return this.sqlite.getCyboBindingsByWorkspace(workspaceId);
  }

  // Item 3 (session singleton): the live non-ephemeral binding for a (cybo, scope) —
  // reads SQLite (the authoritative live-binding store on this daemon).
  getLiveCyboBinding(
    workspaceId: string,
    cyboId: string,
    channelId: string | null,
  ): StoredAgentBinding | undefined {
    return this.sqlite.getLiveCyboBinding(workspaceId, cyboId, channelId);
  }

  deleteAgentBinding(agentId: string): void {
    // Read BEFORE the SQLite delete so we still know whether this was an ephemeral
    // row (which was never mirrored, so its PG delete would be a no-op roundtrip).
    const binding = this.sqlite.getAgentBinding(agentId);
    this.sqlite.deleteAgentBinding(agentId);
    // Keep PG consistent — handleArchiveAgent (and teardown) delete the binding
    // through here, so the offline mirror row must go too or a stale session would
    // linger in the cloud list after the daemon archived it.
    if (this._pg && binding && !binding.ephemeral) {
      this._pg.deleteAgentBinding(agentId).catch(this.logSyncError("deleteAgentBinding"));
    }
  }

  // ─── Ephemeral session context capture (#994) ───────────────────────────
  // SQLite-authoritative (NOT mirrored to PG): the read RPCs are forwarded to
  // the OWNING daemon (which holds this SQLite), exactly like the durable
  // timeline store. Keeping the captured prompts/tools off the shared cloud DB
  // also keeps their PII surface local — consistent with ephemeral bindings,
  // which are likewise never mirrored to PG.
  saveEphemeralSessionContext(row: {
    agentId: string;
    workspaceId: string;
    channelId?: string | null;
    cyboId?: string | null;
    systemPrompt?: string | null;
    mcpServersJson?: string | null;
  }): void {
    this.sqlite.saveEphemeralSessionContext(row);
  }

  updateEphemeralSessionContextPrompts(
    agentId: string,
    routedPrompt: string | null,
    rawPrompt: string | null,
  ): void {
    this.sqlite.updateEphemeralSessionContextPrompts(agentId, routedPrompt, rawPrompt);
  }

  getEphemeralSessionContext(agentId: string): StoredEphemeralSessionContext | undefined {
    return this.sqlite.getEphemeralSessionContext(agentId);
  }

  pruneEphemeralSessionContext(opts: { olderThanMs: number; now?: number }): number {
    return this.sqlite.pruneEphemeralSessionContext(opts);
  }

  deleteEphemeralSessionContext(agentId: string): void {
    this.sqlite.deleteEphemeralSessionContext(agentId);
  }

  // ─── Agent-session history (PG-only; powers the Home "This week" stats) ──
  // The agent_sessions row mirrors the binding lifecycle: created on start,
  // token-updated per turn (cumulative overwrite), archived on stop. PG-only
  // (the weekly workspace aggregate is a connected feature) and best-effort
  // fire-and-forget so it never blocks or breaks the daemon hot path.
  recordAgentSessionStart(params: {
    agentId: string;
    workspaceId: string;
    channelId: string | null;
    userId: string | null;
    provider: string | null;
    cyboId: string | null;
    sessionType: string;
    cwd: string | null;
  }): void {
    this._pg?.upsertAgentSession(params).catch(this.logSyncError("upsertAgentSession"));
  }

  recordAgentSessionUsage(
    agentId: string,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      totalCostUsd?: number;
    },
  ): void {
    this._pg
      ?.recordAgentSessionUsage(agentId, usage)
      .catch(this.logSyncError("recordAgentSessionUsage"));
  }

  archiveAgentSessionRow(agentId: string): void {
    this._pg?.archiveAgentSession(agentId).catch(this.logSyncError("archiveAgentSession"));
  }

  // ─── Cybos (PG primary, SQLite cache) ─────────────────────────

  createCybo(opts: {
    workspaceId: string;
    slug: string;
    name: string;
    soul: string;
    provider: string;
    createdBy: string;
    description?: string | null;
    avatar?: string | null;
    role?: string | null;
    model?: string | null;
    mcpServers?: Record<string, unknown> | null;
    toolGrants?: Record<string, unknown> | null;
    llmAuthMode?: string;
    behaviorMode?: string;
    homeDaemonId?: string | null;
    autonomyLevel?: string | null;
    monthlySpendCap?: number | null;
    platformPermissions?: string[];
    isDefault?: boolean;
  }): StoredCybo {
    const cybo = this.sqlite.createCybo(opts);
    if (this._pg) {
      this._pg.createCybo({ id: cybo.id, ...opts }).catch(this.logSyncError("createCybo"));
    }
    return cybo;
  }

  getCybo(id: string): StoredCybo | undefined {
    return this.sqlite.getCybo(id);
  }

  // Persist a relay-resolved cloud cybo into the local SQLite mirror so getCybo
  // (name/avatar) works for a cybo this daemon never created. Local-only by
  // design — the cybo already lives in shared PG; this just denormalizes it.
  persistCybo(cybo: StoredCybo): void {
    this.sqlite.persistCybo(cybo);
  }

  getCyboBySlug(workspaceId: string, slug: string): StoredCybo | undefined {
    return this.sqlite.getCyboBySlug(workspaceId, slug);
  }

  getCybos(workspaceId: string): StoredCybo[] {
    return this.sqlite.getCybos(workspaceId);
  }

  updateCybo(
    id: string,
    updates: {
      name?: string;
      description?: string | null;
      avatar?: string | null;
      role?: string | null;
      soul?: string;
      provider?: string;
      model?: string | null;
      mcpServers?: Record<string, unknown> | null;
      toolGrants?: Record<string, unknown> | null;
      llmAuthMode?: string;
      behaviorMode?: string;
      homeDaemonId?: string | null;
      autonomyLevel?: string | null;
      monthlySpendCap?: number | null;
      platformPermissions?: string[];
    },
  ): StoredCybo | undefined {
    const cybo = this.sqlite.updateCybo(id, updates);
    if (cybo && this._pg) {
      this._pg.updateCybo(id, updates).catch(this.logSyncError("updateCybo"));
    }
    return cybo;
  }

  deleteCybo(id: string): void {
    this.sqlite.deleteCybo(id);
    if (this._pg) {
      this._pg.deleteCybo(id).catch(this.logSyncError("deleteCybo"));
    }
  }

  // ─── Sequence ────────────────────────────────────────────────────

  nextSeq(workspaceId: string): number {
    return this.sqlite.nextSeq(workspaceId);
  }

  // ─── Audit ───────────────────────────────────────────────────────

  audit(opts: {
    workspaceId: string;
    actorId: string;
    actorType: "human" | "agent" | "system";
    action: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
  }): void {
    this.sqlite.audit(opts);
    if (this._pg) {
      this._pg
        .audit({
          id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ...opts,
        })
        .catch(this.logSyncError("audit"));
    }
  }

  // ─── Archived Sessions (local only) ──────────────────────────────

  archiveSession(opts: {
    workspaceId: string;
    provider: string;
    providerHandleId: string;
    title?: string | null;
    cwd?: string | null;
    model?: string | null;
    cyboId?: string | null;
  }): StoredArchivedSession {
    const row = this.sqlite.archiveSession(opts);
    // Mirror to PG so the cloud relay's list_archived_sessions (which reads PG)
    // actually shows it — previously archives only hit SQLite and the cloud list
    // was always empty.
    if (this._pg) {
      this._pg
        .archiveSession({
          id: row.id,
          workspaceId: row.workspace_id,
          provider: row.provider,
          providerHandleId: row.provider_handle_id,
          title: row.title,
          cwd: row.cwd,
          model: row.model,
          cyboId: row.cybo_id,
          archivedAt: row.archived_at,
        })
        .catch(this.logSyncError("archiveSession"));
    }
    return row;
  }

  getArchivedSessions(workspaceId: string): StoredArchivedSession[] {
    return this.sqlite.getArchivedSessions(workspaceId);
  }

  // Paginated archived list (keyset on archived_at DESC, id DESC). All reads hit
  // SQLite (the local cache is authoritative for the daemon's own archive).
  getArchivedSessionsPage(
    workspaceId: string,
    filter?: { limit?: number; cursor?: string },
  ): { sessions: StoredArchivedSession[]; nextCursor: string | null } {
    return this.sqlite.getArchivedSessionsPage(workspaceId, filter);
  }

  getArchivedSession(id: string): StoredArchivedSession | undefined {
    return this.sqlite.getArchivedSession(id);
  }

  getArchivedSessionByResumedAgent(agentId: string): StoredArchivedSession | undefined {
    return this.sqlite.getArchivedSessionByResumedAgent(agentId);
  }

  markArchivedSessionResumed(id: string, agentId: string): void {
    this.sqlite.markArchivedSessionResumed(id, agentId);
    if (this._pg) {
      this._pg
        .markArchivedSessionResumed(id, agentId)
        .catch(this.logSyncError("markArchivedSessionResumed"));
    }
  }

  reviveArchivedSession(opts: {
    id: string;
    providerHandleId: string;
    title?: string | null;
    cwd?: string | null;
    model?: string | null;
    cyboId?: string | null;
  }): StoredArchivedSession | undefined {
    const row = this.sqlite.reviveArchivedSession(opts);
    if (row && this._pg) {
      this._pg
        .reviveArchivedSession({
          id: row.id,
          providerHandleId: row.provider_handle_id,
          title: row.title,
          cwd: row.cwd,
          model: row.model,
          cyboId: row.cybo_id,
          archivedAt: row.archived_at,
        })
        .catch(this.logSyncError("reviveArchivedSession"));
    }
    return row;
  }

  deleteArchivedSession(id: string): void {
    this.sqlite.deleteArchivedSession(id);
    // Keep PG consistent — previously the delete only hit SQLite, leaving a stale
    // archived row in the shared DB.
    if (this._pg) {
      this._pg.deleteArchivedSession(id).catch(this.logSyncError("deleteArchivedSession"));
    }
  }

  // ─── Projects (local only) ─────────────────────────────────────

  createProject(workspaceId: string, name: string, color: string): StoredProject {
    return this.sqlite.createProject(workspaceId, name, color);
  }

  getProjects(workspaceId: string): StoredProject[] {
    return this.sqlite.getProjects(workspaceId);
  }

  updateProject(id: string, name: string, color: string): void {
    this.sqlite.updateProject(id, name, color);
  }

  deleteProject(id: string): void {
    this.sqlite.deleteProject(id);
  }

  setChannelProject(channelId: string, projectId: string): void {
    this.sqlite.setChannelProject(channelId, projectId);
  }

  // Tasks Phase 2 — per-channel auto-tasks (channel watcher) opt-in switch. Read
  // is the synchronous SQLite mirror; the relay's watcher path reads PG directly
  // (via .pg). OPT-IN: NULL/0 => OFF, only explicit true => ON.
  getChannelAutoTasksEnabled(channelId: string): boolean {
    return this.sqlite.getChannelAutoTasksEnabled(channelId);
  }

  // Write SQLite first (authoritative local), then mirror to PG (fire-and-forget,
  // following the updateChannel/archiveTask pattern). Returns the SQLite result.
  setChannelAutoTasksEnabled(channelId: string, enabled: boolean): boolean {
    const ok = this.sqlite.setChannelAutoTasksEnabled(channelId, enabled);
    if (ok && this._pg) {
      this._pg
        .setChannelAutoTasksEnabled(channelId, enabled)
        .catch(this.logSyncError("setChannelAutoTasksEnabled"));
    }
    return ok;
  }

  clearChannelProject(channelId: string): void {
    this.sqlite.clearChannelProject(channelId);
  }

  getChannelProjects(workspaceId: string): StoredChannelProject[] {
    return this.sqlite.getChannelProjects(workspaceId);
  }

  // The workspace's Tasks-projects (raw SQLite rows). Passthrough so callers (the
  // solo/PG-less cybo cyborg7_list_projects read) don't reach into `.sqlite`
  // directly — mirrors the cloud read path's PgSync.getTasksProjects.
  getTasksProjects(workspaceId: string): StoredTasksProject[] {
    return this.sqlite.getTasksProjects(workspaceId);
  }

  // ─── Tasks Redesign catalog reads (board/detail) ─────────────────────
  // Pure SQLite reads (catalogs live in the daemon's SQLite); the dispatcher's
  // five catalog RPCs delegate straight through. resolveTasksProjectId /
  // getTasksProject back the gate (resolve wire id → tasks_projects row → its
  // workspace); the rest return the client's camelCase catalog shapes.

  resolveTasksProjectId(projectId: string): string | null {
    return this.sqlite.resolveTasksProjectId(projectId);
  }

  getTasksProject(id: string): StoredTasksProject | undefined {
    return this.sqlite.getTasksProject(id);
  }

  getTaskProjectId(taskId: string): string | null {
    return this.sqlite.getTaskProjectId(taskId);
  }

  getProjectStates(projectId: string): ReturnType<CyborgStorage["getProjectStates"]> {
    return this.sqlite.getProjectStates(projectId);
  }

  getProjectLabels(projectId: string): ReturnType<CyborgStorage["getProjectLabels"]> {
    return this.sqlite.getProjectLabels(projectId);
  }

  getProjectCycles(projectId: string): ReturnType<CyborgStorage["getProjectCycles"]> {
    return this.sqlite.getProjectCycles(projectId);
  }

  getProjectModules(projectId: string): ReturnType<CyborgStorage["getProjectModules"]> {
    return this.sqlite.getProjectModules(projectId);
  }

  getTaskActivity(taskId: string): ReturnType<CyborgStorage["getTaskActivity"]> {
    return this.sqlite.getTaskActivity(taskId);
  }

  getCycleProjectId(cycleId: string): string | null {
    return this.sqlite.getCycleProjectId(cycleId);
  }

  getModuleProjectId(moduleId: string): string | null {
    return this.sqlite.getModuleProjectId(moduleId);
  }

  getProjectPages(projectId: string, userId: string): ReturnType<CyborgStorage["getProjectPages"]> {
    return this.sqlite.getProjectPages(projectId, userId);
  }

  getPage(pageId: string): ReturnType<CyborgStorage["getPage"]> {
    return this.sqlite.getPage(pageId);
  }

  getPageProjectId(pageId: string): string | null {
    return this.sqlite.getPageProjectId(pageId);
  }

  // ─── Tasks Redesign catalog CRUD (cycles / modules) ──────────────────
  // SQLite owns the write (it resolves the wire→tasks_projects id and reads the row
  // back in the client shape); the connected daemon mirrors to PG fire-and-forget by
  // id so the cloud relay's getProjectCycles/getProjectModules agree. PG re-resolves
  // the wire projectId itself, so it receives the same opts.

  createCycle(opts: {
    projectId: string;
    name: string;
    description?: string | null;
    startDate?: number | null;
    endDate?: number | null;
  }): ReturnType<CyborgStorage["createCycle"]> {
    const cycle = this.sqlite.createCycle(opts);
    if (this._pg) {
      this._pg
        .insertCycle({
          projectId: opts.projectId,
          name: opts.name,
          description: opts.description,
          startDate: opts.startDate,
          endDate: opts.endDate,
        })
        .catch(this.logSyncError("createCycle"));
    }
    return cycle;
  }

  updateCycle(
    cycleId: string,
    updates: {
      name?: string;
      description?: string | null;
      startDate?: number | null;
      endDate?: number | null;
    },
  ): ReturnType<CyborgStorage["updateCycle"]> {
    const cycle = this.sqlite.updateCycle(cycleId, updates);
    if (this._pg) {
      this._pg.updateCycle(cycleId, updates).catch(this.logSyncError("updateCycle"));
    }
    return cycle;
  }

  deleteCycle(cycleId: string): void {
    this.sqlite.deleteCycle(cycleId);
    if (this._pg) {
      this._pg.deleteCycle(cycleId).catch(this.logSyncError("deleteCycle"));
    }
  }

  // ─── Project pages catalog CRUD ──────────────────────────────────────
  // SQLite owns the write (resolves wire→tasks_projects id, reads the row back in
  // the client `Page` shape); the connected daemon mirrors to PG fire-and-forget by
  // id. PG re-resolves the wire projectId itself, so it receives the same opts.

  createPage(opts: {
    projectId: string;
    title?: string;
    ownedBy?: string | null;
    parentId?: string | null;
  }): ReturnType<CyborgStorage["createPage"]> {
    const page = this.sqlite.createPage(opts);
    if (this._pg) {
      // Pass the id minted by the SQLite write so the page has the SAME id in
      // both stores; otherwise PG would generate a divergent id for the row.
      this._pg
        .insertPage({
          id: page.id,
          projectId: opts.projectId,
          title: opts.title,
          ownedBy: opts.ownedBy,
          parentId: opts.parentId,
        })
        .catch(this.logSyncError("createPage"));
    }
    return page;
  }

  updatePage(
    pageId: string,
    updates: {
      title?: string;
      content?: string;
      visibility?: string;
      icon?: string | null;
      parentId?: string | null;
      sortOrder?: number;
    },
  ): ReturnType<CyborgStorage["updatePage"]> {
    const page = this.sqlite.updatePage(pageId, updates);
    if (this._pg) {
      this._pg.updatePage(pageId, updates).catch(this.logSyncError("updatePage"));
    }
    return page;
  }

  setPageArchived(pageId: string, archived: boolean): ReturnType<CyborgStorage["setPageArchived"]> {
    const page = this.sqlite.setPageArchived(pageId, archived);
    if (this._pg) {
      this._pg.setPageArchived(pageId, archived).catch(this.logSyncError("setPageArchived"));
    }
    return page;
  }

  deletePage(pageId: string): void {
    this.sqlite.deletePage(pageId);
    if (this._pg) {
      this._pg.deletePage(pageId).catch(this.logSyncError("deletePage"));
    }
  }

  createModule(opts: {
    projectId: string;
    name: string;
    description?: string | null;
    status?: string | null;
  }): ReturnType<CyborgStorage["createModule"]> {
    const mod = this.sqlite.createModule(opts);
    if (this._pg) {
      this._pg
        .insertModule({
          projectId: opts.projectId,
          name: opts.name,
          description: opts.description,
          status: opts.status,
        })
        .catch(this.logSyncError("createModule"));
    }
    return mod;
  }

  updateModule(
    moduleId: string,
    updates: { name?: string; description?: string | null; status?: string },
  ): ReturnType<CyborgStorage["updateModule"]> {
    const mod = this.sqlite.updateModule(moduleId, updates);
    if (this._pg) {
      this._pg.updateModule(moduleId, updates).catch(this.logSyncError("updateModule"));
    }
    return mod;
  }

  deleteModule(moduleId: string): void {
    this.sqlite.deleteModule(moduleId);
    if (this._pg) {
      this._pg.deleteModule(moduleId).catch(this.logSyncError("deleteModule"));
    }
  }

  // ─── Task links + attachments (daemon path) ──────────────────────────
  // SQLite owns the write (it mints the id and reads the row back in the client
  // shape) and is authoritative for reads on the daemon; the connected daemon
  // mirrors the write to PG fire-and-forget so the cloud relay agrees. Like the
  // cycles/modules mirror, PG mints its own id from the same opts (the daemon never
  // reads the PG copy for these rows). Reads + project-id resolvers go to SQLite.

  getTaskLinkProjectId(linkId: string): string | null {
    return this.sqlite.getTaskLinkProjectId(linkId);
  }

  getTaskAttachmentProjectId(attachmentId: string): string | null {
    return this.sqlite.getTaskAttachmentProjectId(attachmentId);
  }

  getTaskLinks(taskId: string): ReturnType<CyborgStorage["getTaskLinks"]> {
    return this.sqlite.getTaskLinks(taskId);
  }

  getTaskAttachments(taskId: string): ReturnType<CyborgStorage["getTaskAttachments"]> {
    return this.sqlite.getTaskAttachments(taskId);
  }

  addTaskLink(opts: {
    taskId: string;
    url: string;
    title?: string | null;
    createdBy: string;
  }): ReturnType<CyborgStorage["addTaskLink"]> {
    const link = this.sqlite.addTaskLink(opts);
    if (this._pg) {
      this._pg.addTaskLink(opts).catch(this.logSyncError("addTaskLink"));
    }
    return link;
  }

  removeTaskLink(linkId: string): void {
    this.sqlite.removeTaskLink(linkId);
    if (this._pg) {
      this._pg.removeTaskLink(linkId).catch(this.logSyncError("removeTaskLink"));
    }
  }

  addTaskAttachment(opts: {
    taskId: string;
    key: string;
    url: string;
    name: string;
    size: number;
    contentType?: string | null;
    uploadedBy: string;
  }): ReturnType<CyborgStorage["addTaskAttachment"]> {
    const attachment = this.sqlite.addTaskAttachment(opts);
    if (this._pg) {
      this._pg.addTaskAttachment(opts).catch(this.logSyncError("addTaskAttachment"));
    }
    return attachment;
  }

  removeTaskAttachment(attachmentId: string): void {
    this.sqlite.removeTaskAttachment(attachmentId);
    if (this._pg) {
      this._pg.removeTaskAttachment(attachmentId).catch(this.logSyncError("removeTaskAttachment"));
    }
  }

  // Provision (or fetch) the 1:1 Tasks-project + default states for a chat
  // project. Local-only mirror (Tasks-projects live in SQLite on the daemon);
  // idempotent via the storage layer's UNIQUE chat_project_id.
  provisionTasksProject(opts: {
    workspaceId: string;
    chatProjectId: string;
    name: string;
    color?: string | null;
  }): StoredTasksProject {
    return this.sqlite.provisionTasksProject(opts);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  async close(): Promise<void> {
    this.sqlite.close();
    if (this._pg) {
      await this._pg.close();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private logSyncError(op: string) {
    return (err: unknown) => {
      this.logger?.error({ err, op }, `[PgSync] ${op} failed`);
    };
  }
}

export function createDualStorage(paseoHome: string, logger?: Logger): DualStorage {
  const sqlite = createCyborgStorage(paseoHome);
  // Ephemeral agents never survive a restart — any ephemeral binding present
  // at boot is a leaked teardown (daemon killed mid-turn). Sweep them so they
  // can't accumulate as ghost "Agent sessions".
  const sweptEphemerals = sqlite.deleteEphemeralAgentBindings();
  if (sweptEphemerals > 0) {
    console.log(`[DualStorage] swept ${sweptEphemerals} stale ephemeral agent binding(s)`);
  }
  let pg: PgSync | null = null;

  if (process.env.DATABASE_URL) {
    try {
      pg = new PgSync();
    } catch (err) {
      logger?.warn(
        { err },
        "[DualStorage] DATABASE_URL set but PG connection failed, running in solo mode",
      );
    }
  }

  return new DualStorage(sqlite, pg, logger);
}

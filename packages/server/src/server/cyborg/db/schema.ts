import { isNull, sql } from "drizzle-orm";
import {
  pgTable,
  text,
  boolean,
  timestamp,
  bigint,
  integer,
  date,
  real,
  doublePrecision,
  jsonb,
  uniqueIndex,
  unique,
  check,
  index,
  primaryKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { Unfurl } from "../unfurl.js";
import type { MessageCard } from "../webhook-card.js";

// ─── Users ────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  imageUrl: text("image_url"),
  passwordHash: text("password_hash"),
  // @deprecated — slash AI config moved to the WORKSPACE level (workspaces.default_slash_daemon_id
  // + slashCommandFallbackDaemons). Column kept for back-compat; no longer read by slash routing.
  // FK ON DELETE SET NULL (#205); `(): AnyPgColumn` breaks the users↔daemons inference cycle.
  defaultSlashDaemonId: text("default_slash_daemon_id").references((): AnyPgColumn => daemons.id, {
    onDelete: "set null",
  }),
  // @deprecated — superseded by workspaces.slashCommandModel (+ channels.slash_command_model
  // override). Column kept for back-compat; no longer read by slash model resolution.
  slashCommandModel: text("slash_command_model"),
  // ── Superadmin moderation (additive, all nullable — backward compatible) ──
  // Suspended account (superadmin action): the relay's auth path rejects login
  // while suspendedAt is set. A NULL = the normal, active state, so every
  // existing user is unaffected. suspendedBy FK SET NULL so removing the acting
  // admin's row doesn't break the suspension record.
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  suspendedReason: text("suspended_reason"),
  suspendedBy: text("suspended_by").references((): AnyPgColumn => users.id, {
    onDelete: "set null",
  }),
  // SOFT delete (superadmin action) — the row is NEVER hard-deleted (it is the
  // FK target of memberships/messages/daemons). deletedAt set = the account is
  // gone for auth + listings, but the data stays for audit/integrity.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: text("deleted_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── User identity aliases (local↔canonical merge) ────────────────
// A single human ends up with TWO user rows: their daemon-LOCAL id (for which
// ensureUser mints a synthetic `<id>@remote.local` placeholder) and their real
// CLOUD account id. This table records the proven link `local_id → canonical_id`
// so ownership reads (tasks "assigned to me", membership, session visibility) can
// match a viewer against ALL of their ids, and a one-time backfill can re-point
// legacy rows onto the canonical id. The link is written ONLY where both ids are
// simultaneously known and verified (the daemon-claim / adoptCanonicalUserId seam),
// NEVER inferred by email similarity. The alias row also acts as the tombstone for
// the retired local id: a stray legacy row still resolves to its canonical owner.
export const userIdentityAliases = pgTable(
  "user_identity_aliases",
  {
    // The retired daemon-local (or otherwise non-canonical) user id.
    localId: text("local_id").primaryKey(),
    // The surviving canonical (cloud account) user id this local id resolves to.
    canonicalId: text("canonical_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Snapshot of the shared email at merge time (audit / debugging only — the merge
    // is authorized by the claim handshake, not by this value).
    email: text("email"),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_user_identity_aliases_canonical").on(t.canonicalId)],
);

// ─── Email OTP (signup verification) ──────────────────────────────
// One pending verification per email. A re-request overwrites the row
// (resets code + attempts). The hashed code, plus the pending account's
// name and pre-hashed password, live here until the code is verified.

export const emailOtps = pgTable("email_otps", {
  email: text("email").primaryKey(),
  codeHash: text("code_hash").notNull(),
  name: text("name"),
  passwordHash: text("password_hash"),
  attempts: integer("attempts").notNull().default(0),
  // 'signup' (verify a new account) | 'reset' (forgot-password). One pending
  // code per email; the latest request wins. The verify endpoints check this
  // so a signup code can't be used to reset a password or vice-versa.
  purpose: text("purpose").notNull().default("signup"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Reset on every (re)send → used as the resend cooldown anchor.
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── WebAuthn / passkeys ──────────────────────────────────────────
// A user may register multiple passkeys (laptop Touch ID, phone, security
// key…). Each row is one public-key credential. The RP ID is derived per
// request from the browser Origin (so cloud + self-hosted both work), so it is
// not stored here — credentials are looked up by their globally-unique
// `credentialId`. `counter` MUST be persisted + monotonically updated to detect
// cloned-authenticator replay.

export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The authenticator's credential ID (base64url). Unique across all users.
    credentialId: text("credential_id").notNull().unique(),
    // The credential public key, base64url-encoded (isoBase64URL.fromBuffer).
    publicKey: text("public_key").notNull(),
    // Signature counter; bumped on each successful assertion (replay defense).
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    // Authenticator transports the browser reported (usb/nfc/ble/internal/hybrid).
    transports: jsonb("transports").$type<string[]>(),
    // 'singleDevice' | 'multiDevice' (synced passkey) — informational.
    deviceType: text("device_type"),
    // Whether a multi-device credential is backed up (e.g. iCloud Keychain).
    backedUp: boolean("backed_up").notNull().default(false),
    // User-facing label ("MacBook Pro", "iPhone"…). Optional.
    nickname: text("nickname"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("idx_webauthn_creds_user").on(t.userId)],
);

// Short-lived WebAuthn challenge, single-use. Mirrors email_otps: written by
// the `/options` call, consumed (read + deleted) by the matching `/verify`.
// `key` is `reg:<userId>` for registration (user is authenticated) or a random
// handle for usernameless authentication (returned to the client to echo back).
export const webauthnChallenges = pgTable("webauthn_challenges", {
  key: text("key").primaryKey(),
  challenge: text("challenge").notNull(),
  // 'register' | 'authenticate'.
  purpose: text("purpose").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Workspaces ───────────────────────────────────────────────────

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  avatarUrl: text("avatar_url"),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  // ── Workspace-level slash-command AI config (admin/owner-controlled) ──
  // Supersedes the per-user defaults (users.defaultSlashDaemonId / slashCommandModel,
  // now deprecated). Added by p11-workspace-slash-config.sql.
  // The daemon that runs this workspace's channel slash commands (/summarize etc.);
  // FK SET NULL so deleting the daemon clears it.
  defaultSlashDaemonId: text("default_slash_daemon_id").references((): AnyPgColumn => daemons.id, {
    onDelete: "set null",
  }),
  // Ordered fallback daemon ids, tried in order when the default is offline.
  slashCommandFallbackDaemons: jsonb("slash_command_fallback_daemons")
    .$type<string[]>()
    .default([]),
  // Preferred model for slash commands as "provider/model" (null = auto-resolve).
  // The channel-level channels.slash_command_model overrides this.
  slashCommandModel: text("slash_command_model"),
  // ── Superadmin moderation (additive, all nullable — backward compatible) ──
  // Disabled workspace (superadmin action): a set disabledAt removes the org from
  // every member's listing (getWorkspacesForUser filters it) and blocks
  // (re)subscribing to its live broadcasts. A NULL = the normal, active state, so
  // every existing workspace is unaffected. disabledBy FK SET NULL so removing the
  // acting admin's row doesn't break the disable record. Mirrors the users
  // suspend/delete moderation columns above.
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  disabledReason: text("disabled_reason"),
  disabledBy: text("disabled_by").references((): AnyPgColumn => users.id, {
    onDelete: "set null",
  }),
  // Per-workspace agent-autonomy switch — DEFAULT ON. NULL/true => autonomy ON
  // (today's behavior: the channel watcher may fire); only an explicit false
  // disables it. The getter is `!== false`, so every existing (NULL) workspace
  // keeps autonomy. @-mentions are unaffected by this flag — they stay live
  // regardless (a separate mention gate handles that). Nullable + additive, so
  // old relays tolerate the column and existing rows stay byte-identical.
  agentAutonomyEnabled: boolean("agent_autonomy_enabled"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Memberships ──────────────────────────────────────────────────

export const memberships = pgTable(
  "memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    membershipType: text("membership_type").notNull().default("active"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] })],
);

// ─── Channels ─────────────────────────────────────────────────────

export const channels = pgTable(
  "channels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isPrivate: boolean("is_private").notNull().default(false),
    // Channel kind (#608): 'regular' for ordinary channels, 'group_dm' for the
    // hidden multi-party DM channels (Mattermost parity). A group_dm is created
    // private + hidden and never appears in the channel browser — it lists under
    // the DM section for its members. Existing rows default to 'regular'.
    type: text("type").notNull().default("regular"),
    // Hidden from the channel browser (#608). Group DMs set this true; regular
    // channels stay false. Distinct from isPrivate (membership gate) and
    // isArchived (soft-delete): a hidden channel is fully live for its members,
    // it just never surfaces in the browse/search/mention surfaces.
    isHidden: boolean("is_hidden").notNull().default(false),
    instructions: text("instructions"),
    // Per-channel override for channel AI slash commands (/summarize etc.), JSON
    // {"provider","model"}. Wins over the user's default; null = inherit/auto.
    // Added by p9-slash-command-model.sql.
    slashCommandModel: text("slash_command_model"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Soft-delete / archive (P2 #3). Distinct from deletedAt (hard delete):
    // archived channels keep their history but are hidden from the active list.
    isArchived: boolean("is_archived").notNull().default(false),
    // Tasks Phase 2 (watcher) — per-channel auto-tasks switch. NULL/false = OFF
    // (opt-in): the channel watcher only fires on un-mentioned human chatter when
    // this is explicitly true. Nullable so existing rows default to OFF.
    autoTasksEnabled: boolean("auto_tasks_enabled"),
  },
  // Channel names are NOT unique within a workspace: the same name may exist
  // under different project tags. Channels are addressed by id, never by name,
  // so duplicates are safe. Plain (non-unique) index for lookup performance
  // (historically this was a UNIQUE index, since dropped).
  (t) => [
    index("idx_channels_workspace_name").on(t.workspaceId, t.name),
    // #608: hot path for the browser/sidebar lists, which fetch only VISIBLE
    // (non-hidden) channels per workspace. Partial so the index stays tiny and
    // only covers the rows those queries actually scan (is_hidden = false). The
    // predicate already constrains is_hidden, so the index keys workspace_id only.
    index("idx_channels_workspace_visible")
      .on(t.workspaceId)
      .where(sql`${t.isHidden} = false`),
    // #608: constrain `type` to the known kinds so a stray value can never reach
    // the visibility/routing logic (a group_dm is the only non-regular kind).
    check("channels_type_valid", sql`${t.type} IN ('regular', 'group_dm')`),
  ],
);

// ─── Channel roles (per-channel admin/member) ───────────────────
// Real per-channel role table (P2 #3) replacing the `channel.createdBy === me`
// admin heuristic. The channel creator is backfilled as "admin" on create.
// Kept SEPARATE from channel_members (membership ≠ role authority) so a role
// can be derived even where membership semantics differ; getChannelRole reads
// from here with channel_members as a fallback for legacy rows.
export const channelRoles = pgTable(
  "channel_roles",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // 'admin' | 'member'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    index("idx_channel_roles_channel").on(t.channelId),
  ],
);

// ─── Channel Members ─────────────────────────────────────────────

// A channel member is EITHER a human (user_id) or a cybo (cybo_id) — exactly one
// is set (member_type discriminates). Cybo membership = the cybo may act in this
// channel (@-mention → invoke). user_id is nullable now, so the old composite PK
// is replaced by a UNIQUE(channel_id, user_id) [NULLs distinct, so it still backs
// the human `ON CONFLICT (channel_id, user_id)` upserts] plus a partial unique on
// the cybo column.
export const channelMembers = pgTable(
  "channel_members",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    cyboId: text("cybo_id").references((): AnyPgColumn => cybos.id, { onDelete: "cascade" }),
    memberType: text("member_type").notNull().default("human"),
    role: text("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_channel_members_channel").on(t.channelId),
    unique("channel_members_user_uniq").on(t.channelId, t.userId),
    uniqueIndex("channel_members_cybo_uniq")
      .on(t.channelId, t.cyboId)
      .where(sql`${t.cyboId} IS NOT NULL`),
    check(
      "channel_members_one_member",
      sql`(${t.userId} IS NOT NULL) <> (${t.cyboId} IS NOT NULL)`,
    ),
  ],
);

// ─── Read state (per user, per channel) ─────────────────────────

export const messageReads = pgTable(
  "message_reads",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.channelId] }),
    index("idx_message_reads_user_ws").on(t.userId, t.workspaceId),
  ],
);

// P2 Item 12: per-(user, DM peer) read cursor — the DM analogue of
// message_reads. DMs have no channelId, so reads are keyed by the conversation
// peer. Drives the DM unread badge AND the frozen "New messages" divider
// snapshot, and syncs cross-device via cyborg:read_broadcast{dmPeerId}.
export const dmReads = pgTable(
  "dm_reads",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    peerId: text("peer_id").notNull(),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Workspace-scoped (SPEC-12): the same user+peer can DM in multiple
    // workspaces, so each pair needs an independent read cursor per workspace.
    primaryKey({ columns: [t.workspaceId, t.userId, t.peerId] }),
    index("idx_dm_reads_user_ws").on(t.userId, t.workspaceId),
  ],
);

// ─── Activity feed (one row per recipient per event) ────────────

export const activityEvents = pgTable(
  "activity_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // recipient
    eventType: text("event_type").notNull(), // 'mention' | 'thread_reply'
    sourceType: text("source_type").notNull(), // 'message'
    sourceId: text("source_id").notNull(), // message id
    channelId: text("channel_id"),
    // Source DM peer (the OTHER user in the DM) for dm-originated activity, so a
    // DM read can clear its activity items. Null for channel-scoped events.
    dmPeerId: text("dm_peer_id"),
    previewText: text("preview_text"),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_activity_user_ws_created").on(t.userId, t.workspaceId, t.createdAt)],
);

// ─── Notification preferences (per user, per scope) ─────────────

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    scopeId: text("scope_id").notNull(), // channelId (or dm:agent:<id> later)
    preference: text("preference").notNull(), // 'all' | 'mentions_only' | 'muted'
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.scopeId] }),
    index("idx_notification_prefs_user_ws").on(t.userId, t.workspaceId),
  ],
);

// ─── Composer drafts (per user, per scope) — server-side draft sync (#610) ──
// An unfinished composer message so it follows the user across devices. `scope`
// identifies the conversation it belongs to (channel:<id> / dm:<peerId> /
// thread:<rootId>) — the same opaque key the UI's drafts store uses. Keyed
// (user_id, scope) like notification_prefs: one draft per conversation per user,
// upserted on edit and deleted on send/clear. Only the TEXT is synced (pending
// File attachments hold live blobs that can't cross devices). `updatedAt` is the
// reconcile tiebreaker — newest write wins when a device's local cache and the
// server disagree on workspace load.
export const drafts = pgTable(
  "drafts",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    scope: text("scope").notNull(), // channel:<id> | dm:<peerId> | thread:<rootId>
    text: text("text").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.scope] }),
    index("idx_drafts_user_ws").on(t.userId, t.workspaceId),
  ],
);

// ─── Messages ─────────────────────────────────────────────────────

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id"),
    fromId: text("from_id").notNull(),
    fromType: text("from_type").notNull(),
    fromName: text("from_name"),
    toId: text("to_id"),
    text: text("text").notNull(),
    mentions: jsonb("mentions").$type<string[]>(),
    parentId: text("parent_id"),
    attachments: jsonb("attachments").$type<
      {
        key: string;
        name: string;
        type: string;
        size: number;
        url: string;
        width?: number;
        height?: number;
        blurhash?: string;
        // Media (video/audio) metadata — additive. jsonb column, no migration.
        duration?: number; // media length in SECONDS (video/audio)
        posterKey?: string; // S3 key of a client-generated poster frame (video only)
        poster?: string; // poster URL for delivery (video only)
      }[]
    >(),
    reactions:
      jsonb("reactions").$type<
        { userId: string; userName?: string; emoji: string; createdAt: number }[]
      >(),
    // URL link previews (Tier 2). Populated fire-and-forget after insert by the
    // relay's unfurl engine; nullable since most messages have no links.
    unfurls: jsonb("unfurls").$type<Unfurl[]>(),
    // Structured rich card (Slack-Block-Kit / Discord-embed style), set at insert
    // time by automations — currently a GitHub release card from a `release`
    // webhook. Rendered by ReleaseCard.svelte instead of the plain text body.
    // Nullable: organic + most automated messages have no card.
    card: jsonb("card").$type<MessageCard>(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedBy: text("pinned_by"),
    // Message origin: NULL for organic (composer) messages, "mcp" for messages
    // posted via the MCP write tools — lets the UI badge automations.
    source: text("source"),
    seq: bigint("seq", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_messages_channel_seq").on(t.channelId, t.seq),
    index("idx_messages_workspace_seq").on(t.workspaceId, t.seq),
    // History/activity now order by createdAt (seq isn't chronologically
    // monotonic); these back those queries + the (createdAt, seq) page cursor.
    index("idx_messages_channel_created").on(t.channelId, t.createdAt, t.seq),
    index("idx_messages_workspace_created").on(t.workspaceId, t.createdAt),
    // DM hot paths: getDmUnreadCounts filters (to_id, workspace_id) on every
    // workspace load; getDmMessages filters the from/to pair per DM open. Without
    // these the planner scans a workspace index and post-filters from_id/to_id.
    index("idx_messages_to_ws_created").on(t.toId, t.workspaceId, t.createdAt),
    index("idx_messages_from_ws_created").on(t.fromId, t.workspaceId, t.createdAt),
  ],
);

// ─── Threads (CRT) ────────────────────────────────────────────────
// One row per root message, created lazily on first reply. reply_count +
// participants + last_reply_at are server-maintained aggregates. unread_replies
// is NOT stored — derived from thread_memberships.last_viewed vs reply timestamps.
export const threads = pgTable(
  "threads",
  {
    rootId: text("root_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    channelId: text("channel_id"),
    replyCount: integer("reply_count").notNull().default(0),
    lastReplyAt: timestamp("last_reply_at", { withTimezone: true }).notNull().defaultNow(),
    participants: jsonb("participants").$type<string[]>().notNull().default([]),
  },
  (t) => [index("idx_threads_ws_lastreply").on(t.workspaceId, t.lastReplyAt)],
);

// One row per (user, thread), created lazily on first follow. Only unread_mentions
// is a stored counter; unread replies are derived from last_viewed.
export const threadMemberships = pgTable(
  "thread_memberships",
  {
    rootId: text("root_id").notNull(),
    userId: text("user_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    following: boolean("following").notNull().default(true),
    lastViewed: timestamp("last_viewed", { withTimezone: true }).notNull().defaultNow(),
    unreadMentions: integer("unread_mentions").notNull().default(0),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.rootId, t.userId] }),
    index("idx_threadmemb_user_ws").on(t.userId, t.workspaceId),
  ],
);

// ─── Tasks ────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("pending"),
    assigneeId: text("assignee_id"),
    createdBy: text("created_by").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    recurrence: text("recurrence"),
    result: text("result"),
    // Tasks Phase 2 (watcher) — the channel a watcher-created task is bound to, so
    // execute-dispatch knows where to post results. Nullable: manual/board tasks
    // need no channel.
    channelId: text("channel_id"),
    // Tasks Phase 2 — optional board priority (e.g. low|medium|high|urgent), kept
    // as free text to match the tool contract. Nullable.
    priority: text("priority"),
    // Tasks Phase 3 (execute dispatch) — atomic dispatch-claim timestamp. A
    // conditional UPDATE on (NULL or stale) wins the right to dispatch, guarding
    // multi-replica / immediate+tick double-fire. Nullable until first claimed.
    lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true }),
    // Tasks Phase 3 — recurrence double-spawn guard. Set atomically when the next
    // occurrence of a recurring task is spawned, so exactly one child is created.
    recurrenceSpawnedAt: timestamp("recurrence_spawned_at", { withTimezone: true }),
    // Tasks Phase 3 — recurrence cap counter. Bounds how many times a recurring
    // task re-spawns. NOT NULL default 0 so every row carries a concrete count.
    recurrenceCount: integer("recurrence_count").notNull().default(0),
    // Tasks Phase 0 (Plane plane UI) — manual ordering within a (workspace,status)
    // lane for board/list/spreadsheet drag-reorder. Nullable: backfilled by
    // ROW_NUMBER over created_at, new rows get a value from the app layer.
    sortOrder: integer("sort_order"),
    // Tasks Phase 0 — optional planned start of work, the left edge of a Gantt bar
    // (paired with dueAt as the right edge). Nullable.
    startDate: timestamp("start_date", { withTimezone: true }),
    // Tasks Phase 0 — soft-archive timestamp. NULL = active; set = archived/hidden
    // from default views without deleting the row.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // Tasks Phase 0 — draft flag for tasks not yet committed to the board. NOT NULL
    // default false so every row carries a concrete value.
    isDraft: boolean("is_draft").notNull().default(false),
    // ── Tasks Redesign P0 (Plane-style projects/states/hierarchy) ──
    // The Tasks-project this task belongs to (one tasks_project per chat project,
    // plus a per-workspace "Inbox" for orphans). Nullable for back-compat; the
    // 0031 backfill assigns every existing row a project. ON DELETE CASCADE so a
    // deleted tasks_project takes its tasks with it. Forward ref via AnyPgColumn
    // (tasksProjects is declared later in this file).
    projectId: text("project_id").references((): AnyPgColumn => tasksProjects.id, {
      onDelete: "cascade",
    }),
    // Sub-task parent (self-FK). NULL = top-level. ON DELETE SET NULL so deleting a
    // parent promotes its children to top-level rather than cascade-deleting them.
    parentId: text("parent_id").references((): AnyPgColumn => tasks.id, {
      onDelete: "set null",
    }),
    // Workflow state (Backlog/Todo/In Progress/Done/Cancelled). The free-text
    // `status` column above stays as the watcher/back-compat mirror of state.group.
    // ON DELETE SET NULL so deleting a state un-sets it rather than dropping tasks.
    stateId: text("state_id").references((): AnyPgColumn => taskStates.id, {
      onDelete: "set null",
    }),
    // Per-project human-facing sequence number (the N in identifier "ENG-N"),
    // backfilled by ROW_NUMBER over created_at and handed out by the app from
    // tasks_projects.sequence_counter. Nullable until assigned.
    sequenceId: integer("sequence_id"),
    // Single cycle (sprint) this task is in. Added in migration 0030. NULL = no
    // cycle. ON DELETE SET NULL so deleting a cycle un-buckets its tasks.
    cycleId: text("cycle_id").references((): AnyPgColumn => cycles.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tasks_workspace_status").on(t.workspaceId, t.status),
    // Phase 3 — the schedule-runner tick selects due agent tasks by (status, dueAt).
    index("idx_tasks_due").on(t.status, t.dueAt),
    // Phase 3 — owned-task catch-up by assignee on daemon reconnect.
    index("idx_tasks_assignee").on(t.workspaceId, t.assigneeId),
    // Phase 0 — ordered fetch of a status lane for drag-reorder layouts.
    index("idx_tasks_workspace_sort").on(t.workspaceId, t.status, t.sortOrder),
    // Redesign P0 — board column fetch (a project's tasks grouped by state).
    index("idx_tasks_project_state").on(t.projectId, t.stateId),
  ],
);

// ─── Schedules (recurring cybo runs) ──────────────────────────────
// A schedule fires a cybo with `prompt` into `channelId` on `cronExpr`.
// The daemon that owns the workspace runs the cron tick and spawns the cybo.

export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // FKs so a deleted cybo/channel/creator can't leave an orphan schedule the
    // cron runner then fires (#205). Cybo gone → drop the schedule; channel gone
    // → null it; creator gone → drop the schedule.
    cyboId: text("cybo_id")
      .notNull()
      .references(() => cybos.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    // Per-task scheduling: the task this schedule fires (run as the task's
    // assignee cybo, unattended). NULL = a raw-prompt cybo schedule (today's
    // behaviour, unchanged). ON DELETE CASCADE so deleting the task drops the
    // schedule the cron runner would otherwise keep firing against a ghost task.
    // Forward ref via AnyPgColumn (tasks is declared earlier, but keep the cast
    // for symmetry with the other self/cross FKs in this file).
    taskId: text("task_id").references((): AnyPgColumn => tasks.id, { onDelete: "cascade" }),
    cronExpr: text("cron_expr").notNull(),
    timezone: text("timezone"),
    prompt: text("prompt").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    // Phase 2 (#619) — one-shots: a positive cap on total fires. NULL = recurring
    // forever; 1 = one-shot ("remind me Friday 17:00") — the runner deactivates the
    // schedule after its single fire. Lifecycle parity with Paseo's maxRuns.
    maxRuns: integer("max_runs"),
    // Total successful/skipped fires so far, so one-shot completion is durable
    // across restarts (counting schedule_runs rows would be racy with the mirror).
    runCount: integer("run_count").notNull().default(0),
    // Phase 2 (#619) — catch-up policy for a daemon that was offline at the
    // scheduled minute. true (default): fire once on the first tick after it
    // returns (a late "morning digest" beats never). false: skip straight to the
    // next future occurrence (a stale "every 5 min health check" is noise, not
    // signal) — mirrors Paseo's recoverInterruptedRuns.
    catchUp: boolean("catch_up").notNull().default(true),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_schedules_workspace").on(t.workspaceId),
    index("idx_schedules_due").on(t.enabled, t.nextRunAt),
    // Per-task scheduling — the relay denormalizes a task's bound schedule onto
    // the wire Task (task list/detail), looked up by task_id.
    index("idx_schedules_task").on(t.taskId),
  ],
);

// ─── Schedule runs (run history — the trust/visibility layer, #619) ──
// One row per fire ATTEMPT of a schedule, written by the daemon's ScheduleRunner
// at fire (status 'running') and finish ('succeeded'|'failed'), or once at decide
// time when a tick is skipped ('skipped' + a closed-set skip_reason). Paseo keeps
// runs[] embedded in the schedule JSON; we split it out so the history is queryable
// and visible in cloud (the relay reads this mirror; the daemon SQLite is the
// authoritative copy). Closed-set status/skip_reason follow the Mattermost
// ScheduledPost.ErrorCode lesson (internal docs): failures are SHOWN, never dropped.
// PG is a write-only mirror like `schedules` (fire-and-forget; never read for
// execution), so a lost mirror write can't change what the runner does.
export const scheduleRuns = pgTable(
  "schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The cron slot this run was for (the next_run_at it fired against).
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    // NULL while a run is in flight; set when it finishes/skips.
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // 'running' | 'succeeded' | 'failed' | 'skipped' (closed set).
    status: text("status").notNull(),
    // Why a 'skipped' run didn't fire (closed set): 'license_paused' (workspace
    // trial ended), 'overlap' (the prior run for this schedule was still in
    // flight, #209), 'unauthorized' (creator lost membership/daemon access).
    // NULL for non-skipped runs.
    skipReason: text("skip_reason"),
    // The spawned cybo agent id (succeeded/failed runs) so the UI can deep-link
    // into the Agents pane. NULL for skipped runs (nothing spawned).
    agentId: text("agent_id"),
    // Failure message for 'failed' runs (closed-set status, open-text detail).
    error: text("error"),
  },
  (t) => [
    index("idx_schedule_runs_schedule").on(t.scheduleId, t.startedAt),
    index("idx_schedule_runs_workspace").on(t.workspaceId, t.startedAt),
  ],
);

// ─── Schedule dispatch claims (cross-daemon exactly-once for the RAW-PROMPT
// cron path) ─────────────────────────────────────────────────────────────
// The PER-TASK fire path is guarded by claimTaskDispatch (tasks.last_dispatched_at)
// so the SAME due task never fires on two daemons at once. The RAW-PROMPT path
// (schedules.task_id NULL — e.g. "every morning DM Seb a brief") had ONLY the
// daemon's in-PROCESS inFlight Set, so when the SAME schedule is present + due on
// more than one daemon EACH fired it → duplicate channel posts + duplicate cybo
// sessions. This table is that path's missing cross-process guard: a per-(schedule,
// fired-slot) atomic claim. The daemon that wins a slot INSERTs the (scheduleId,
// scheduledFor) row; every other daemon conflicts on the PK and skips the fire.
// Unlike `schedules`/`scheduleRuns` (write-only mirrors), this table is the SHARED
// SOURCE OF TRUTH the claim is decided against — it is INSERT…ON CONFLICT and read
// (via RETURNING) in the same statement, never read for execution otherwise.
export const scheduleDispatchClaims = pgTable(
  "schedule_dispatch_claims",
  {
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    // The cron slot (the next_run_at the runner fired against), epoch ms — the
    // same value across every daemon for one logical fire, so it keys the claim.
    scheduledFor: bigint("scheduled_for", { mode: "number" }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    // The serverId of the winning daemon (diagnostics only; not load-bearing).
    claimedBy: text("claimed_by"),
  },
  (t) => [primaryKey({ columns: [t.scheduleId, t.scheduledFor] })],
);

// ─── Invocation dispatch claims (@mention + channel-watch, #16) ───
// Twin of scheduleDispatchClaims for the mention/watch paths. claim_key is the
// invocation guard's own key ("<messageId>:<cyboId>" for a mention,
// "watch:<messageId>" for a watcher — disjoint namespaces share one table). The
// winning daemon INSERTs the row; every other daemon conflicts on the PK and skips
// the double-fire.
export const invocationDispatchClaims = pgTable("invocation_dispatch_claims", {
  claimKey: text("claim_key").primaryKey(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  // The serverId of the winning daemon (diagnostics only; not load-bearing).
  claimedBy: text("claimed_by"),
});

// ─── Scheduled messages (user "send later", #607) ────────────────
// A user-facing "schedule this message to send at a time" feature — distinct from
// `schedules` above (which is recurring CYBO automation, cronExpr). A row is a
// single human post (channel OR DM) deferred to `send_at`; a due-row job fires it
// via the NORMAL message path (so mentions/notifications/persistence all work) and
// stamps `processed_at`. On failure it sets a CLOSED-SET `error_code` instead of
// silently dropping (the Mattermost ScheduledPost.ErrorCode lesson, internal docs
// §2) — the Scheduled list shows the failed row with its reason.
//
// EXACTLY-ONCE: `processed_at IS NULL` is the idempotency guard. The cloud relay's
// tick claims due rows with `FOR UPDATE SKIP LOCKED` then stamps `processed_at` in
// the same txn, so concurrent relay instances (or a relay + a connected daemon)
// can't double-send. A solo daemon (no PG) fires from its SQLite copy instead —
// see ScheduledMessageRunner. Authority is RE-VALIDATED at send time (the author
// may have lost channel access since scheduling).
export const scheduledMessages = pgTable(
  "scheduled_messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Exactly one of channel_id / to_id is set (a channel post vs a DM). Both are
    // nullable+FK'd so a deleted channel/recipient can't leave an unfireable row:
    // channel gone → null it (the runner then fails it `channel_archived`); a DM
    // recipient is a user — handled at send time via re-validation, not an FK here.
    channelId: text("channel_id").references(() => channels.id, { onDelete: "set null" }),
    toId: text("to_id"),
    fromId: text("from_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    // Mentions resolved at SCHEDULE time (same shape the live composer sends); the
    // runner replays them through the normal path so @-notifications fire on send.
    mentions: jsonb("mentions").$type<string[]>(),
    // When to fire. The runner picks rows where send_at <= now AND processed_at IS
    // NULL. Indexed (partial, unprocessed-only) for the hot due-row scan.
    sendAt: timestamp("send_at", { withTimezone: true }).notNull(),
    // NULL = still pending (cancelable/editable). Set on fire (success) AND on
    // permanent failure (with error_code) — a failed send is "processed", never
    // retried into a loop, and stays visible in the list with its error.
    processedAt: timestamp("processed_at", { withTimezone: true }),
    // CLOSED-SET failure reason, NULL on success. See ScheduledMessageErrorCode.
    errorCode: text("error_code").$type<ScheduledMessageErrorCode>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_scheduled_messages_workspace").on(t.workspaceId, t.sendAt),
    // The hot due-row scan: only unprocessed rows, ordered by send_at. Partial
    // index keeps it tiny as processed rows accumulate.
    index("idx_scheduled_messages_due").on(t.sendAt).where(isNull(t.processedAt)),
  ],
);

// Closed set of reasons a scheduled send permanently failed at fire time (the
// Mattermost ScheduledPost.ErrorCode lesson, internal docs). A failure is SHOWN
// on the Scheduled list row, never silently dropped. Kept in sync with the SQLite
// copy in storage.ts and the zod enum in cyborg-messages.ts.
export type ScheduledMessageErrorCode =
  | "channel_archived" // target channel was archived/deleted before send_at
  | "no_permission" // author lost send permission in the workspace/channel
  | "user_deleted" // a DM recipient no longer exists
  | "channel_not_found" // the channel row is gone (FK null'd) — nothing to post to
  | "unknown_error"; // an unexpected throw at send time (detail logged, not lost)

export const SCHEDULED_MESSAGE_ERROR_CODES: readonly ScheduledMessageErrorCode[] = [
  "channel_archived",
  "no_permission",
  "user_deleted",
  "channel_not_found",
  "unknown_error",
] as const;

// ─── Daemons (distributed architecture) ──────────────────────────

export const daemons = pgTable("daemons", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  label: text("label").notNull(),
  // User renamed the daemon from the UI — the hello upsert must never
  // overwrite a user-set label (#441). The reported hostname still lands in
  // meta.host for diagnostics.
  labelUserSet: boolean("label_user_set").notNull().default(false),
  publicKey: text("public_key"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  status: text("status").notNull().default("offline"),
  meta: jsonb("meta").$type<{
    cpu?: number;
    memMb?: number;
    agents?: number;
    queueDepth?: number;
    accepting?: boolean;
    uptime?: number;
    host?: string;
    platform?: string;
    arch?: string;
    cyboInstalled?: boolean;
    // Already persisted via the heartbeat/hello jsonb merge (DaemonMetaSchema
    // carries them) but previously absent from this annotation — declared here so
    // reads off daemons.meta are type-safe. jsonb is schema-less, so no migration.
    version?: string;
    deploymentMode?: "solo" | "connected";
    cyboRuntime?: {
      configured: boolean;
      modelCount: number;
      backends: Array<{ backend: string; modelCount: number }>;
    };
    // Usage-metrics heartbeat (round 1). Live counts + edition reported each
    // heartbeat. jsonb is schema-less, so adding these is a compile-time-only
    // change (no migration for the counts).
    activeSessionCount?: number;
    activeCyboCount?: number;
    edition?: "saas" | "selfhost" | "opensource";
  }>(),
  // DualStorage.mode this daemon reports at hello/heartbeat: 'solo' (SQLite only)
  // or 'connected' (SQLite cache + shared PG). Nullable: an older daemon that
  // doesn't report it stays NULL ('unknown'). Surfaced in the superadmin view.
  deploymentMode: text("deployment_mode"),
  // Deployment edition the daemon reports at hello/heartbeat: 'saas' | 'selfhost'
  // | 'opensource'. Mirrored from meta.edition into a dedicated column for a cheap
  // GROUP BY edition (usage-metrics dashboard). Nullable: an older daemon that
  // doesn't report it stays NULL ('unknown').
  deploymentEdition: text("deployment_edition"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Daemon-Agent bindings ────────────────────────────────────────

export const daemonAgents = pgTable(
  "daemon_agents",
  {
    daemonId: text("daemon_id")
      .notNull()
      .references(() => daemons.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("idle"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.daemonId, t.agentId] }),
    index("idx_daemon_agents_workspace").on(t.workspaceId),
  ],
);

// ─── Workspace-Daemon subscriptions ──────────────────────────────

export const workspaceDaemons = pgTable(
  "workspace_daemons",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    daemonId: text("daemon_id")
      .notNull()
      .references(() => daemons.id, { onDelete: "cascade" }),
    subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(),
    // Owner opt-out per workspace. Default true (a daemon serves all its owner's
    // workspaces). A disabled row survives daemon reconnect (ensureWorkspaceDaemon
    // is onConflictDoNothing), so the limit is sticky.
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.daemonId] })],
);

// ─── Daemon Access (per-workspace agent prompting permissions) ───

export const daemonAccess = pgTable(
  "daemon_access",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    daemonId: text("daemon_id")
      .notNull()
      .references(() => daemons.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by")
      .notNull()
      .references(() => users.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    // Capability scopes for this grant (#705). Replaces the binary "row exists =
    // total access" model with a small set: chat | spawn | terminal | admin.
    // `admin` is the superset (RCE-grade host control). DEFAULT '{admin}' so every
    // EXISTING grant — which WAS total access — migrates to admin and no one
    // loses access. A null/missing column (older relay) is treated as admin by the
    // enforcement layer (see normalizeScopes / getUserDaemonScopes), keeping the
    // fail-safe pointed at today's behavior. A no-access state is the ROW NOT
    // EXISTING, never an empty array.
    scopes: text("scopes").array().notNull().default(["admin"]),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.daemonId, t.userId] }),
    index("idx_daemon_access_workspace").on(t.workspaceId),
  ],
);

// ─── Daemon Access Requests (REQUEST → NOTIFY → APPROVE half of #705) ───
//
// A non-owner asks the daemon OWNER for access at a requested set of scopes. The
// owner is notified (activity inbox + live push) and APPROVEs (runs the existing
// grant via setDaemonAccess with the requested-or-adjusted scopes) or DENYs. This
// is the inbound counterpart to daemonAccess (the grant). The owner is implicitly
// admin, so an owner never appears as a requester (rejected at the relay/dispatcher).
//
// One PENDING request per (workspace, daemon, requester): the partial unique index
// (status='pending') mirrors invitations — re-requesting reuses the existing pending
// row instead of stacking, while still allowing a fresh request after a prior one
// was approved/denied (those rows no longer participate in the index).
export const daemonAccessRequests = pgTable(
  "daemon_access_requests",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    daemonId: text("daemon_id")
      .notNull()
      .references(() => daemons.id, { onDelete: "cascade" }),
    requesterId: text("requester_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Denormalized requester display name, captured at request time so the owner's
    // activity inbox can render "<name> requested ... access" without a join.
    requesterName: text("requester_name"),
    // Requested capability scopes (chat | spawn | terminal | admin), same taxonomy
    // as daemonAccess.scopes. The owner may override these on approve.
    scopes: text("scopes").array().notNull(),
    // pending → approved | denied. Only 'pending' rows participate in the partial
    // unique index, so a resolved request never blocks a new one.
    status: text("status").notNull().default("pending"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_daemon_access_requests_workspace").on(t.workspaceId),
    index("idx_daemon_access_requests_daemon").on(t.daemonId),
    index("idx_daemon_access_requests_requester").on(t.requesterId),
    // One PENDING request per (workspace, daemon, requester). Partial: only pending
    // rows participate, so re-requesting after an approve/deny is allowed and a
    // duplicate pending request reuses the same row (see createDaemonAccessRequest).
    uniqueIndex("idx_daemon_access_requests_pending")
      .on(t.workspaceId, t.daemonId, t.requesterId)
      .where(sql`${t.status} = 'pending'`),
  ],
);

export type DaemonAccessRequest = typeof daemonAccessRequests.$inferSelect;

// ─── Audit log ────────────────────────────────────────────────────

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorId: text("actor_id").notNull(),
    actorType: text("actor_type").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_audit_workspace_time").on(t.workspaceId, t.createdAt)],
);

// ─── Sequences (per-workspace monotonic seq for sync) ─────────────

export const workspaceSequences = pgTable("workspace_sequences", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
});

// ─── Cybos (customizable agent templates) ───────────────────────────

export const cybos = pgTable(
  "cybos",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    avatar: text("avatar"),
    role: text("role"),
    soul: text("soul").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    mcpServers: jsonb("mcp_servers"),
    // Composio (and future provider) tool capability grants — the `CyboToolGrants`
    // blob from composio-types.ts. Nullable like mcp_servers; carries NO credentials
    // (auth binds to an identity at run time via composio_connections).
    toolGrants: jsonb("tool_grants"),
    isDefault: boolean("is_default").notNull().default(false),
    llmAuthMode: text("llm_auth_mode").notNull().default("cli"),
    // DEPRECATED — superseded by autonomyLevel (S2). Kept until S3 drops it.
    behaviorMode: text("behavior_mode").notNull().default("responsive"),
    // Explicit "home" daemon — the machine the cybo lives on / runs on, chosen
    // at creation. Nullable: existing cybos have none → spawn falls back to the
    // sponsor/selected daemon. Not an FK: daemons are not a PG table (they live
    // in the relay's daemon registry / SQLite), so this is a free-form id.
    homeDaemonId: text("home_daemon_id"),
    // Per-cybo autonomy dial (L0..L5). Nullable/additive; null → fall back via
    // behaviorModeToLevel(behavior_mode). Backfilled by migration 0041.
    autonomyLevel: text("autonomy_level"),
    monthlySpendCap: integer("monthly_spend_cap"),
    platformPermissions: jsonb("platform_permissions").$type<string[]>().default([]),
    // DEPRECATED / unused (post-MVP): off-platform capabilities were UI-only and
    // never enforced, so they were removed. Column kept (defaults to []) for DB
    // back-compat; no app code reads or writes it. See cybo-types.ts.
    offPlatformPermissions: jsonb("off_platform_permissions").$type<string[]>().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_cybos_workspace_slug").on(t.workspaceId, t.slug),
    index("idx_cybos_workspace").on(t.workspaceId),
  ],
);

// ─── Composio connected accounts (per-identity toolkit auth refs) ───
// One OAuth'd identity for one toolkit. We store only the Composio
// `connected_account_id` REFERENCE (tokens live in Composio's vault — never here)
// plus who owns it: ownerKind 'user' (personal, ownerId = userId) or 'service'
// (shared, ownerId = workspaceId). One connection per (workspace, owner, toolkit).
export const composioConnections = pgTable(
  "composio_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    ownerKind: text("owner_kind").notNull(), // 'user' | 'service'
    ownerId: text("owner_id").notNull(),
    toolkit: text("toolkit").notNull(),
    connectedAccountId: text("connected_account_id").notNull(),
    status: text("status").notNull(), // 'active' | 'pending' | 'expired'
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (t) => [
    uniqueIndex("idx_composio_connections_owner_toolkit").on(
      t.workspaceId,
      t.ownerKind,
      t.ownerId,
      t.toolkit,
    ),
    index("idx_composio_connections_workspace").on(t.workspaceId),
  ],
);

// ─── Agent Sessions (DM persistent + channel daily) ─────────────

export const agentSessions = pgTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    providerSessionId: text("provider_session_id"),
    title: text("title"),
    sessionType: text("session_type").notNull(),
    status: text("status").notNull().default("active"),
    summary: text("summary"),
    cwd: text("cwd"),
    // Provider + cybo identity, denormalized from the agent binding at session
    // start, so the Home "top agents" grouping needs no join.
    provider: text("provider"),
    cyboId: text("cybo_id"),
    // Cumulative token/cost usage for this session. OVERWRITTEN with the latest
    // (cumulative) agent.lastUsage on each turn — so a weekly workspace total is
    // SUM of one value per session, never a per-event add. Powers "tokens this
    // week" + "top agents".
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }).notNull().default(0),
    totalCostUsd: doublePrecision("total_cost_usd").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_agent_sessions_agent").on(t.agentId),
    index("idx_agent_sessions_workspace").on(t.workspaceId),
    index("idx_agent_sessions_channel_date").on(t.channelId, t.createdAt),
    // Hot path for the weekly workspace aggregate (workspace + created_at range).
    index("idx_agent_sessions_workspace_created").on(t.workspaceId, t.createdAt),
    // Backs the per-cybo max(updated_at) "last active" GROUP BY in
    // pg-sync.getCybos (migration 0027). Partial — cybo_id is nullable and the
    // aggregate filters cybo_id IS NOT NULL.
    index("idx_agent_sessions_cybo")
      .on(t.cyboId)
      .where(sql`${t.cyboId} IS NOT NULL`),
  ],
);

// ─── Daily token ledger (append-only, for the contribution heatmap) ──
// agent_sessions holds CUMULATIVE per-session totals (overwritten each turn), so
// it can't represent true per-day usage — a session's whole total lumps onto its
// start day and gets superseded on reuse. This table accumulates per-day token
// DELTAS instead: recordAgentSessionUsage adds (new_cumulative − last_seen) to the
// current UTC day, so the Home heatmap reflects tokens actually burned each day and
// the history persists. Forward-only (past cumulative data can't be reconstructed).
export const tokenUsageDaily = pgTable(
  "token_usage_daily",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // UTC calendar day (matches the heatmap's UTC bucketing).
    day: date("day").notNull(),
    tokens: bigint("tokens", { mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.day] })],
);

// ─── Agent-Channel assignments (agents don't auto-join) ──────────

export const agentChannelAssignments = pgTable(
  "agent_channel_assignments",
  {
    agentId: text("agent_id").notNull(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    assignedBy: text("assigned_by")
      .notNull()
      .references(() => users.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.channelId] }),
    index("idx_agent_channel_channel").on(t.channelId),
  ],
);

// ─── Archived Sessions ──────────────────────────────────────────

export const archivedSessions = pgTable(
  "archived_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerHandleId: text("provider_handle_id").notNull(),
    title: text("title"),
    cwd: text("cwd"),
    model: text("model"),
    cyboId: text("cybo_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
    // Live agent this archived session was resumed into. Non-null = currently
    // resumed (shown in the active list, hidden from history). Cleared on
    // re-archive. Prevents resume from deleting the session from history.
    resumedAgentId: text("resumed_agent_id"),
    // Owner captured at archive/import time (the live binding's initiator). Used to
    // gate restore/import/list to the owner or a workspace owner/admin (IDOR fix).
    // initiatedBy is a LOCAL daemon id; initiatedByEmail bridges it to the caller's
    // cloud account across the divergent id namespaces.
    initiatedBy: text("initiated_by"),
    initiatedByEmail: text("initiated_by_email"),
  },
  (t) => [
    index("idx_archived_sessions_workspace").on(t.workspaceId, t.archivedAt),
    index("idx_archived_sessions_resumed_agent").on(t.resumedAgentId),
  ],
);

// ─── Agent bindings (durable session list, PG mirror of SQLite) ──
// The daemon's LOCAL SQLite agent_bindings row is the source of truth for a live
// agent session; this table mirrors the NON-ephemeral ones so the cloud relay can
// list a workspace's sessions even when the owning daemon is offline (shown as an
// offline/not-live row, resumable once the daemon is back). Ephemeral summons are
// NEVER mirrored here (they don't survive a restart). Written fire-and-forget by
// DualStorage.createAgentBinding/updateAgentBindingModel/updateAgentBindingSession/
// deleteAgentBinding; read by the relay's list_agents fan-out as the offline
// fallback. initiatedByEmail is the stable cross-namespace identity (the local
// initiated_by id is daemon-scoped, meaningless to the relay) — it powers the
// offline-row visibility filter (a private session shows only to its initiator) and
// the same initiatedBy→global-id bridge the live daemon rows use.
export const agentBindings = pgTable(
  "agent_bindings",
  {
    agentId: text("agent_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    channelId: text("channel_id").references(() => channels.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model"),
    systemPrompt: text("system_prompt"),
    daemonId: text("daemon_id"),
    cyboId: text("cybo_id"),
    // Daemon-LOCAL SQLite user id (NOT a PG users.id) — intentionally no FK.
    initiatedBy: text("initiated_by"),
    // Stable cross-namespace identity for the initiator, resolved from the daemon's
    // SQLite at mirror time. The relay can't map the daemon-local initiated_by id,
    // so this email is what it filters/bridges on.
    initiatedByEmail: text("initiated_by_email"),
    cwd: text("cwd"),
    // Best-effort provider resume id (Paseo's on-disk JSON is the real resume
    // source; this is mirrored for completeness, nullable until a turn reveals it).
    providerSessionId: text("provider_session_id"),
    // AUTONOMOUS (cron / scheduled / webhook) spawn — no human invoker. An
    // autonomous channel-bound session is OWNER-SCOPED in the session list (visible
    // only to whoever scheduled it), unlike a human-spawned interactive channel
    // agent which stays shared. Powers the offline-row visibility filter the same
    // way the live daemon list does (agentBindingVisibleCore).
    autonomous: boolean("autonomous").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_agent_bindings_workspace").on(t.workspaceId),
    index("idx_agent_bindings_daemon").on(t.daemonId),
  ],
);

// ─── Projects (tags on channels) ────────────────────────────────

export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_projects_workspace").on(t.workspaceId)],
);

// ─── Channel-Project assignments ────────────────────────────────

export const channelProjects = pgTable("channel_projects", {
  channelId: text("channel_id")
    .primaryKey()
    .references(() => channels.id, { onDelete: "cascade" }),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
});

// ─── Tasks Redesign P0: Projects / States / Labels / Cycles / Modules ──
// The Plane-style Tasks foundation. A `tasks_project` is the project-of-record for
// the Tasks app, 1:1 linked to a chat `project` (when one exists) plus a synthetic
// per-workspace "Inbox" for orphan tasks. Each project owns its own workflow
// states, labels, cycles (sprints), and modules. See migrations 0028–0031.

// One Tasks-project per chat project (1:1 via chatProjectId), plus one synthetic
// "Inbox" per workspace. `identifier` is the uppercase prefix in task keys
// (e.g. "ENG" → "ENG-12"); `sequenceCounter` is the high-water mark handed out as
// the next task's per-project sequence_id.
export const tasksProjects = pgTable(
  "tasks_projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // 1:1 link to the chat project. UNIQUE so a chat project maps to at most one
    // Tasks-project. ON DELETE CASCADE so hard-deleting the chat project removes
    // the Tasks-project (and, transitively, its tasks). NULL for the synthetic
    // per-workspace "Inbox" project, which has no chat project.
    chatProjectId: text("chat_project_id")
      .unique()
      .references(() => projects.id, { onDelete: "cascade" }),
    // Uppercase short code (<=8 chars), unique per workspace, used as the task key
    // prefix. Backfilled from the (truncated) project name.
    identifier: text("identifier").notNull(),
    // Next per-project task sequence number (the N in "ENG-N"). NOT NULL default 0;
    // the app increments it atomically when minting a task.
    sequenceCounter: integer("sequence_counter").notNull().default(0),
    // Per-project module toggles for the Tasks sidebar (Plane parity). Default ON.
    cyclesEnabled: boolean("cycles_enabled").notNull().default(true),
    modulesEnabled: boolean("modules_enabled").notNull().default(true),
    pagesEnabled: boolean("pages_enabled").notNull().default(true),
    color: text("color"),
    // Soft-archive timestamp. NULL = active; set = archived/hidden from default views.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tasks_projects_workspace").on(t.workspaceId),
    // The task-key prefix must be unique within a workspace.
    uniqueIndex("idx_tasks_projects_workspace_identifier").on(t.workspaceId, t.identifier),
  ],
);

// Per-project workflow states (the board columns). `group` buckets a state into
// one of Plane's five canonical phases so logic (and the legacy `tasks.status`
// mirror) can reason about progress regardless of the custom state name.
export const taskStates = pgTable(
  "task_states",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => tasksProjects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Hex color for the state pill.
    color: text("color").notNull(),
    // Canonical phase bucket: backlog | unstarted | started | completed | cancelled.
    group: text("group").notNull(),
    // Fractional ordering for drag-reorder of board columns.
    sequence: real("sequence").notNull(),
    // The state new tasks land in by default (exactly one per project, by convention).
    isDefault: boolean("is_default").notNull().default(false),
  },
  (t) => [
    index("idx_task_states_project").on(t.projectId),
    // Constrain the bucket to the five canonical Plane phases.
    check(
      "task_states_group_valid",
      sql`${t.group} IN ('backlog', 'unstarted', 'started', 'completed', 'cancelled')`,
    ),
  ],
);

// Per-project labels (free-form tags). Many-to-many with tasks via
// task_label_assignees.
export const taskLabels = pgTable(
  "task_labels",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => tasksProjects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Hex color for the label pill.
    color: text("color").notNull(),
    // Fractional ordering for drag-reorder in the label list.
    sortOrder: real("sort_order").notNull(),
  },
  (t) => [
    index("idx_task_labels_project").on(t.projectId),
    // Django get_or_create semantics: one label per (project, case-insensitive name).
    // The resolver's INSERT … ON CONFLICT (project_id, lower(name)) DO NOTHING relies
    // on this expression index as its conflict target, so every caller (UI, agents,
    // relay RPC, concurrent requests) reuses the existing label instead of duplicating.
    uniqueIndex("ux_task_labels_project_lower_name").on(t.projectId, sql`lower(${t.name})`),
  ],
);

// Join table: which labels are on which task.
export const taskLabelAssignees = pgTable(
  "task_label_assignees",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => taskLabels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.labelId] }),
    index("idx_task_label_assignees_label").on(t.labelId),
  ],
);

// External links attached to a task (Plane "Links").
export const taskLinks = pgTable(
  "task_links",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_task_links_task").on(t.taskId)],
);

// File attachments on a task (S3 asset_key + metadata).
export const taskAttachments = pgTable(
  "task_attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    assetKey: text("asset_key").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    contentType: text("content_type"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_task_attachments_task").on(t.taskId)],
);

// Per-task activity feed: a row per change (verb=created|updated) and per comment.
// Field/old/new describe an attribute change; comment_html is set for comments.
// `epoch` is a fractional sort key (ms timestamp) so the feed orders stably.
export const taskActivity = pgTable(
  "task_activity",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Who did it. Nullable for system-generated activity.
    actorId: text("actor_id"),
    // created | updated.
    verb: text("verb").notNull(),
    // The changed attribute (e.g. "state", "assignee"). NULL for comment rows.
    field: text("field"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    // Rendered comment body; NULL for plain attribute-change rows.
    commentHtml: text("comment_html"),
    // Fractional sort key (ms since epoch) for a stable, mergeable feed order.
    epoch: doublePrecision("epoch").notNull(),
  },
  (t) => [
    index("idx_task_activity_task_epoch").on(t.taskId, t.epoch),
    check("task_activity_verb_valid", sql`${t.verb} IN ('created', 'updated')`),
  ],
);

// Cycles (sprints): a time-boxed bucket of a project's tasks. A task is in at most
// one cycle (tasks.cycle_id), so this is a plain table, not a join.
export const cycles = pgTable(
  "cycles",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => tasksProjects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
    ownedBy: text("owned_by"),
    // Fractional ordering for the cycle list.
    sortOrder: real("sort_order"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_cycles_project").on(t.projectId)],
);

// Project pages (wiki/docs): a rich-text document scoped to a project, with
// public/private visibility + archive. `content` is the serialized editor doc
// (TipTap JSON) stored as text; "" = a blank page.
export const tasksPages = pgTable(
  "tasks_pages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => tasksProjects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    content: text("content").notNull().default(""),
    // "private" (creator only for now) | "public" (any workspace member).
    visibility: text("visibility").notNull().default("private"),
    // Optional page icon: a single emoji glyph the author picks (Plane's page
    // logo). Null = no custom icon (the default page glyph renders). Mirrored in
    // the pages list + the page editor header.
    icon: text("icon"),
    // Self-referential parent for page nesting (Notion/Plane subpages). NULL =
    // a root page. `(): AnyPgColumn` breaks the self-reference inference cycle.
    // ON DELETE SET NULL ORPHANS children to root rather than cascade-deleting
    // them, so removing a parent never silently destroys a subtree.
    parentId: text("parent_id").references((): AnyPgColumn => tasksPages.id, {
      onDelete: "set null",
    }),
    // Sibling ordering within a parent (lower first). Cheap integer ladder; the
    // tree is built in memory by the UI from the flat list.
    sortOrder: integer("sort_order").notNull().default(0),
    ownedBy: text("owned_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tasks_pages_project").on(t.projectId),
    index("idx_tasks_pages_parent").on(t.parentId),
  ],
);

// Modules (feature groupings): a many-to-many bucket of a project's tasks
// (task_modules join), with its own lifecycle status.
export const modules = pgTable(
  "modules",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => tasksProjects.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    startDate: timestamp("start_date", { withTimezone: true }),
    targetDate: timestamp("target_date", { withTimezone: true }),
    // planned | in_progress | paused | completed | cancelled (free text, Plane parity).
    status: text("status").notNull().default("planned"),
    lead: text("lead"),
    // Fractional ordering for the module list.
    sortOrder: real("sort_order"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("idx_modules_project").on(t.projectId)],
);

// Join table: which tasks belong to which modules (many-to-many).
export const taskModules = pgTable(
  "task_modules",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    moduleId: text("module_id")
      .notNull()
      .references(() => modules.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.moduleId] }),
    index("idx_task_modules_module").on(t.moduleId),
  ],
);

// ─── Web Push subscriptions (VAPID) ─────────────────────────────

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_push_subscriptions_user").on(t.userId)],
);

// ─── FCM device tokens (native mobile push via Firebase) ────────
// Parallel to push_subscriptions (web/VAPID): one row per device token. A
// rotated token inserts a new row; the dispatcher prunes dead tokens on an
// UNREGISTERED/INVALID send result. Two same-platform devices on one account
// each keep their own row.

export const fcmTokens = pgTable(
  "fcm_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    platform: text("platform").notNull(), // "android" | "ios"
    deviceName: text("device_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_fcm_tokens_user").on(t.userId)],
);

// ─── MCP tokens (external agents acting in a workspace via MCP) ──
//
// A Personal-Access-Token granting an external agent (Claude Desktop, a custom
// agent, a peer daemon) scoped access to ONE workspace over the relay's MCP
// endpoint. The token acts AS an identity (a cybo by default, or a user) and
// every tool call is permission-checked against that identity. Only the SHA-256
// hash is stored — the raw token is shown once at creation and never persisted.
export const mcpTokens = pgTable(
  "mcp_tokens",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    name: text("name").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The identity the external agent acts as. identityType: "cybo" | "user".
    identityType: text("identity_type").notNull(),
    identityId: text("identity_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_mcp_tokens_workspace").on(t.workspaceId),
    index("idx_mcp_tokens_hash").on(t.tokenHash),
  ],
);

// ─── Webhooks (inbound, GitHub-style per-channel config) ───────────────
// One row per configured inbound webhook, scoped to a channel. The endpoint URL
// is per-channel (POST /api/webhooks/:channelId); this row carries the GitHub-
// style config: an optional HMAC secret (X-Hub-Signature-256 verification), the
// content type, an event allowlist, and an active toggle. The bearer credential
// stays the existing mcp_tokens system; this table layers config on top.
export const webhooks = pgTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Webhook"),
    // HMAC-SHA256 signing secret (GitHub "Secret" field). Stored in PLAINTEXT —
    // unlike a token it must be available to recompute the HMAC of each delivery.
    // NULL = no signature verification required. Shown once on set/rotate in the UI.
    secret: text("secret"),
    // Content type the sender uses (GitHub: application/json | form-urlencoded).
    contentType: text("content_type").notNull().default("application/json"),
    // Event selection. mode "release" = only `release`; "all" = every event;
    // "select" = the `events` allowlist. Default: releases only.
    eventMode: text("event_mode").notNull().default("release"),
    events: jsonb("events").$type<string[]>().notNull().default([]),
    active: boolean("active").notNull().default(true),
    // Reactive trigger (#620, scheduler phase 3): when set, each incoming event
    // ALSO fires this cybo (in addition to the card), forwarding a mention-shaped
    // `fire` to the owning daemon with `promptTemplate` rendered from the payload.
    // NULL = card-only (today's behavior — no regression). Nullable text (not an
    // FK) so deleting a cybo doesn't cascade-delete the webhook config; a dangling
    // id is resolved-or-skipped at fire time, like a stale schedule's cybo_id.
    triggerCyboId: text("trigger_cybo_id"),
    // The fire prompt. Interpolates the HOSTILE, attacker-controlled event payload
    // (e.g. `{{release.tag}}`) — escaped/fenced (parity with the mention-injection
    // hardening, PR #437) so a malicious payload can't break out of the prompt.
    // NULL with a trigger set falls back to a minimal default prompt.
    promptTemplate: text("prompt_template"),
    createdBy: text("created_by").notNull(),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_webhooks_channel").on(t.channelId),
    index("idx_webhooks_workspace").on(t.workspaceId),
  ],
);

// ─── Webhook deliveries ("Recent Deliveries" history) ──────────────────
// One row per inbound POST (success and failure), for the GitHub-style delivery
// log. Carries the request (headers + body) and our response (status + body) so a
// delivery can be inspected and redelivered. Pruned to a recent cap per webhook.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id").notNull(),
    channelId: text("channel_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // GitHub event (X-GitHub-Event header) + the payload action, when present.
    event: text("event"),
    action: text("action"),
    requestHeaders: jsonb("request_headers").$type<Record<string, string>>(),
    requestBody: text("request_body"),
    responseStatus: integer("response_status").notNull(),
    responseBody: text("response_body"),
    ok: boolean("ok").notNull(),
    // When this delivery is a redelivery, the id of the original it replayed.
    redeliveredFrom: text("redelivered_from"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_webhook_deliveries_webhook_created").on(t.webhookId, t.createdAt),
    index("idx_webhook_deliveries_channel").on(t.channelId),
  ],
);

// ─── Outgoing webhooks (Plane-grade, #598) ─────────────────────────────
// Workspace+channel-scoped OUTBOUND webhooks: when a message is created/edited/
// deleted in `channelId`, an event is POSTed to `url` with an HMAC-SHA256
// signature header (X-Cyborg7-Signature). Distinct from the INBOUND `webhooks`
// table above (which RECEIVES GitHub-style events).
//
// SECRET MODEL (like mcp_tokens.token_hash): we generate a random raw secret at
// create time, hand it to the client ONCE in the create response, and persist
// only its SHA-256 HASH in `secret_key`. Deliveries are HMAC-signed with that
// stored hash as the key; the consumer derives the SAME key by hashing the raw
// secret they were given (sha256(rawSecret)) and verifies the signature. Storing
// the hash (not the raw secret) means a DB leak never yields the value the client
// holds, and the secret is never re-shown or logged after creation. Revocation =
// delete the row (and the consumer's stored secret stops verifying).
export const outgoingWebhooks = pgTable(
  "outgoing_webhooks",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Channel scope. FK cascade so deleting the channel drops its webhooks. NULL
    // is NOT allowed — an outgoing webhook always targets one channel's events.
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("Webhook"),
    // Destination URL. Validated https-only + SSRF-guarded at DELIVERY time via
    // the shared secureFetch (a stored URL could resolve to a private IP later).
    url: text("url").notNull(),
    // The HMAC signing key, stored HASHED (sha256 hex). The raw key is shown to
    // the creator ONCE; we sign deliveries with this stored value and never
    // re-expose or log it. A DB leak yields only the hash, which is also exactly
    // the key — acceptable because (a) it never leaves the server except the
    // one-time create response, and (b) it is per-webhook and revocable by delete.
    secretKey: text("secret_key").notNull(),
    // Per-event-type enable flags. { "message.created": true, ... }. An event is
    // delivered only if its flag is true. Defaults below enable creates only.
    events: jsonb("events")
      .$type<{
        "message.created"?: boolean;
        "message.updated"?: boolean;
        "message.deleted"?: boolean;
      }>()
      .notNull()
      .default({ "message.created": true }),
    isActive: boolean("is_active").notNull().default(true),
    // Consecutive delivery failures. Reset to 0 on any 2xx; at the retry cap the
    // delivery runner flips isActive=false and DMs the owner.
    failureCount: integer("failure_count").notNull().default(0),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_outgoing_webhooks_workspace").on(t.workspaceId),
    // The hot enqueue lookup: active webhooks for a channel on each message event.
    index("idx_outgoing_webhooks_channel_active").on(t.channelId, t.isActive),
  ],
);

// ─── Webhook outbox (durable delivery queue, #598) ──────────────────────
// One row per (event, webhook) to deliver. Written when a message event fires
// for a channel that has a matching active webhook; claimed + delivered by the
// WebhookDeliveryRunner tick (FOR UPDATE SKIP LOCKED). `deliveredAt` is the
// terminal stamp (success OR permanently-failed/dead-lettered) — a NULL
// deliveredAt with nextRetryAt <= now is "due". Idempotency: UNIQUE(eventId,
// webhookId) so the same event can't be enqueued twice for one webhook (e.g. a
// ret. of the enqueue path), and the event is delivered at-least-once per webhook.
export const webhookOutbox = pgTable(
  "webhook_outbox",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => outgoingWebhooks.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The domain event id (the message id) — the idempotency anchor with webhookId.
    eventId: text("event_id").notNull(),
    // "message.created" | "message.updated" | "message.deleted".
    eventType: text("event_type").notNull(),
    // The signed JSON body to POST (the rendered event payload), stored so a
    // retry resends the EXACT bytes the signature was computed over.
    eventData: jsonb("event_data").$type<Record<string, unknown>>().notNull(),
    // Delivery bookkeeping. attempts increments per try; nextRetryAt is when the
    // row becomes due again after a transient failure (backoff + jitter).
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
    // Terminal stamp: set on success OR on permanent failure (cap reached). A
    // NULL deliveredAt is "still pending"; the due scan is (deliveredAt IS NULL
    // AND nextRetryAt <= now).
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly-once-per-webhook enqueue guard (idempotency on event + webhook).
    uniqueIndex("idx_webhook_outbox_event_webhook").on(t.eventId, t.webhookId),
    // The hot due-row scan: only undelivered rows, ordered by nextRetryAt.
    index("idx_webhook_outbox_due").on(t.nextRetryAt).where(isNull(t.deliveredAt)),
    index("idx_webhook_outbox_webhook").on(t.webhookId),
  ],
);

// ─── Webhook delivery logs (per-attempt audit, #598) ────────────────────
// One row per delivery ATTEMPT (success and failure), for an auditable history
// (parity with the inbound `webhook_deliveries`). Carries the HTTP status, a
// closed-ish error_code for failures, the attempt's retry_count, and the
// next_retry_at it scheduled (NULL when terminal). Pruned to a recent cap.
export const webhookDeliveryLogs = pgTable(
  "webhook_delivery_logs",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => outgoingWebhooks.id, { onDelete: "cascade" }),
    outboxId: text("outbox_id").notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    // "success" | "failure".
    status: text("status").notNull(),
    // HTTP status code of the attempt (NULL when the request never completed —
    // e.g. DNS/SSRF rejection or timeout before any response).
    responseStatus: integer("response_status"),
    // Closed-set failure reason: 'http_error' (non-2xx) | 'timeout' |
    // 'ssrf_blocked' (guard refused the URL/redirect) | 'network_error'. NULL on
    // success. Open-text detail goes in error_message.
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    // The attempt number this log is for (1-based), and the next_retry_at it
    // scheduled (NULL when this was the final attempt — success or dead-letter).
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_webhook_delivery_logs_webhook_created").on(t.webhookId, t.createdAt),
    index("idx_webhook_delivery_logs_outbox").on(t.outboxId),
  ],
);

// ─── User statuses (per user, per workspace — "Set yourself as away" / custom) ─
// One row per (workspace, user). emoji/text are the custom status; expires_at is
// an optional auto-clear. Synced to co-members so others see the emoji where
// presence shows.

export const userStatuses = pgTable(
  "user_statuses",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji"),
    text: text("text"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_user_statuses_workspace_user").on(t.workspaceId, t.userId),
    index("idx_user_statuses_workspace").on(t.workspaceId),
    index("idx_user_statuses_expires_at").on(t.expiresAt),
  ],
);

// ─── User presence (durable manual away) ────────────────────────
// One row per user (NOT per workspace — presence is the person, not the
// membership). isAway is the persisted "Set yourself as away" toggle (P2 #6a),
// which must survive a full disconnect (manual away ≠ offline). The relay
// hydrates it into memory on startup and re-broadcasts presence so co-members
// see the away dot live.
export const userPresence = pgTable("user_presence", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  isAway: boolean("is_away").notNull().default(false),
  // Do-Not-Disturb expiry: a future timestamp while DND is active, NULL otherwise
  // (swept past-expiry by the relay's statusSweep).
  dndUntil: timestamp("dnd_until", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Session aliases (per-user, display-only) ──────────────────────
// A personal, cosmetic label a user gives an agent session so they can spot it.
// Per-user (never shown to others), isolated table — has no other function and
// affects nothing else. PK (user_id, agent_id): one alias per user per agent.
// See p13-session-aliases.sql.
export const sessionAliases = pgTable(
  "session_aliases",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    alias: text("alias").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.agentId] })],
);

// ─── Terminal aliases (per-user, display-only, cross-device synced) ──
// A personal, cosmetic label a user gives a terminal session so they can spot
// it. Per-user (never shown to others — terminals are private to whoever opened
// them, same as the terminal_output/terminals_changed owner scoping), isolated
// table. PK (user_id, terminal_id): one alias per user per terminal. This is the
// server-backed counterpart to the old localStorage map, so a rename syncs
// across the user's devices. See 0033_terminal_aliases.sql.
export const terminalAliases = pgTable(
  "terminal_aliases",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    terminalId: text("terminal_id").notNull(),
    alias: text("alias").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.terminalId] })],
);

// ─── Subscriptions (Stripe billing / license — cloud only) ──────
// One row per workspace, created lazily the first time a workspace owner starts
// a Stripe Checkout (the webhook upserts it). Mirrors v1's subscriptions table.
// The license state the relay gates on is DERIVED from these columns + the
// workspace's createdAt (the 7-day trial anchor) — see PgSync.getLicenseStatus.
//
// status values mirror Stripe's subscription statuses we care about:
//   'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid'
// plan is 'free' before any paid subscription, 'pro' once subscribed.
export const subscriptions = pgTable("subscriptions", {
  // workspaceId is the PRIMARY KEY (one subscription per workspace). It is also
  // the tenant key carried in Stripe metadata so the webhook can route events.
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  // Unique so invoice.payment_failed (keyed by subscription id) hits one row.
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  plan: text("plan").notNull().default("free"),
  status: text("status").notNull(),
  priceId: text("price_id"),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  // Where this purchase originated, for superadmin reporting: 'web' | 'desktop' |
  // 'apple_iap' | 'google_play'. NULL = unknown (pre-existing rows, or a checkout
  // that didn't thread the platform). Apple/Google stay NULL until IAP exists.
  purchasePlatform: text("purchase_platform"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── License pools (per-buyer seat entitlement on a rail) ─────────
// A pool is ONE buyer's seat entitlement on ONE rail. iOS: one row per
// (userId, rail='ios') — seatCount comes from the purchased tier product
// (mapPriceToSeats). Stripe (only if OQ-2 = "mirror"): one row per Stripe
// subscription, seatCount usually 1. The pool answers "how many workspace
// licenses does this buyer hold and until when". Allocations spend seats from it.
export const licensePools = pgTable(
  "license_pools",
  {
    id: text("id").primaryKey(), // pool_<uuid>
    // The buyer. For iOS this is the RevenueCat app_user_id (= Cyborg7 userId).
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'ios' (RevenueCat) | 'stripe'. One ACTIVE ios pool per user (Apple: 1 sub/group).
    rail: text("rail").notNull(),
    // Seats this pool grants. Derived from the tier product (mapPriceToSeats).
    seatCount: integer("seat_count").notNull().default(0),
    // Mirrors subscriptions.status semantics: 'active' | 'trialing' | 'canceled' |
    // 'past_due' | 'unpaid'. Drives whether allocations from this pool are honored.
    status: text("status").notNull(),
    // Rail identifiers (for reconcile + idempotency). iOS: product id + entitlement
    // id from RevenueCat. Stripe: customer id + subscription id.
    productId: text("product_id"),
    entitlementId: text("entitlement_id"),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_license_pools_owner").on(t.ownerUserId),
    // At most ONE pool per (owner, rail). The iOS pool is unique per user (Apple
    // constraint); a Stripe pool per user is also fine here since Stripe pools are
    // additionally disambiguated by stripeSubscriptionId in allocations. If OQ-2 =
    // "Stripe mirrors seats with ONE pool per sub", relax this to (owner, rail,
    // stripeSubscriptionId). DEFAULT (Stripe stays per-workspace, see §3): the
    // Stripe rail does NOT create pools — only iOS does — so this unique is safe.
    uniqueIndex("idx_license_pools_owner_rail").on(t.ownerUserId, t.rail),
  ],
);

// ─── License allocations (a seat spent on a workspace) ────────────
// One row = the buyer spent ONE seat from `poolId` on `workspaceId`. A workspace
// is Pro iff it has a row here whose pool is in good standing. Removing the row
// frees the seat. workspaceId is UNIQUE: a workspace can be backed by at most one
// allocation at a time (mirrors subscriptions.workspaceId being the PK / one
// license per workspace). The (pool → workspace) edge is also unique so the same
// seat can't be double-spent on one workspace.
export const licenseAllocations = pgTable(
  "license_allocations",
  {
    id: text("id").primaryKey(), // alloc_<uuid>
    poolId: text("pool_id")
      .notNull()
      .references(() => licensePools.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One active allocation per workspace (matches subscriptions PK semantics).
    uniqueIndex("idx_license_allocations_workspace").on(t.workspaceId),
    index("idx_license_allocations_pool").on(t.poolId),
  ],
);

// ─── Superadmin (platform-wide admin role) ────────────────────────
// A user IS a superadmin iff a row exists here with is_superadmin = true. Revoke
// keeps the row (is_superadmin=false + revoked_by/at) for audit; a later grant
// flips it back true and clears the revoked_* fields. The first superadmin is
// bootstrapped via grant-superadmin.ts (granted_by NULL); after that, existing
// superadmins grant others from the UI. Every privileged action is recorded in
// admin_audit_log. granted_by/revoked_by FK SET NULL so removing the acting
// admin's user row never breaks the grant record (the actor id stays in audit).
export const adminUsers = pgTable(
  "admin_users",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    isSuperadmin: boolean("is_superadmin").notNull().default(true),
    grantedBy: text("granted_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedBy: text("revoked_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The hot lookup is "is X an ACTIVE superadmin" + the small admins list.
    // Partial so the index only covers the (few) active rows, not revoked history.
    index("idx_admin_users_active")
      .on(t.isSuperadmin)
      .where(sql`${t.isSuperadmin} = true`),
  ],
);

// ─── Global admin audit log ───────────────────────────────────────
// GLOBAL (not workspace-scoped) audit trail for superadmin actions — the existing
// audit_log requires workspace_id, so it can't record platform-wide actions like
// grant/revoke superadmin, suspend, or soft-delete. actorUserId is the REAL
// superadmin who acted (for impersonated requests, the admin behind it, never the
// impersonated identity). Not FK'd — an audit entry must survive even if a user
// row is later affected; the id is captured at write time for the record.
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    // 'grant_superadmin' | 'revoke_superadmin' | 'suspend_user' | 'unsuspend_user'
    // | 'delete_user' | 'change_plan' | 'set_member_role' | 'impersonate'.
    action: text("action").notNull(),
    // 'user' | 'workspace' | 'subscription' (nullable — some actions have no target).
    targetType: text("target_type"),
    targetId: text("target_id"),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_admin_audit_created").on(t.createdAt),
    index("idx_admin_audit_actor").on(t.actorUserId),
  ],
);

// ─── Invitations (full invite flow with shareable links) ──────────
// One row per outstanding invite. The primary key IS the invite token
// (crypto.randomBytes(32).toString("hex")) so the unauthenticated landing page
// GET /api/invite/:token can look the row up directly. A PENDING invite is one
// with accepted_at IS NULL; the partial unique index enforces a single pending
// invite per (workspace, email) so re-inviting reuses/refreshes the same token
// instead of stacking rows. Membership of type 'invited' is created alongside
// (see relay invite_member); acceptance flips that membership to 'active'.
export const invitations = pgTable(
  "invitations",
  {
    // id = the invite token. Generated with crypto.randomBytes(32).toString("hex").
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Email-bound invites carry the address. An OPEN (reusable) invite has a NULL
    // email + is_open = true: anyone with the link can join, and accepting it does
    // NOT consume it (acceptedAt stays null), so it stays live until reset.
    email: text("email"),
    role: text("role").notNull().default("member"),
    // Reusable workspace invite link (one per workspace; "Reset" rotates the token
    // by replacing the row). Email-bound invites keep this false.
    isOpen: boolean("is_open").notNull().default(false),
    // Channels the invitee is auto-joined to on accept, on top of the default
    // #general (Slack-style "add to channels"). Empty = just the defaults.
    channelIds: jsonb("channel_ids").$type<string[]>().notNull().default([]),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by"),
  },
  (t) => [
    index("idx_invitations_workspace").on(t.workspaceId),
    index("idx_invitations_email").on(t.email),
    // One PENDING email-bound invite per (workspace, email). Partial: only
    // not-yet-accepted, email-bound rows participate, so the same address can be
    // re-invited after an accepted invite, and open invites (NULL email) are
    // excluded (they're keyed per-workspace below).
    uniqueIndex("idx_invitations_pending_workspace_email")
      .on(t.workspaceId, t.email)
      .where(sql`${t.acceptedAt} IS NULL AND ${t.isOpen} = false`),
    // At most ONE live reusable link per workspace. Reset deletes the old row
    // before inserting a new token, so this never blocks a rotation.
    uniqueIndex("idx_invitations_open_workspace")
      .on(t.workspaceId)
      .where(sql`${t.isOpen} = true AND ${t.acceptedAt} IS NULL`),
  ],
);

export type Invitation = typeof invitations.$inferSelect;

// ─── Saved messages (#609 — personal bookmarks) ───────────────────
// A PRIVATE per-user bookmark list, distinct from channel pins (which are
// shared, and live as pinned_at/pinned_by on the messages row). One row per
// (user, message) the user saved; composite PK makes save idempotent and
// guarantees isolation — my saves are mine. The "Saved" sidebar view lists a
// user's saved messages across channels, newest-first (idx on user, created_at).
// message_id is NOT a FK to messages (no ON DELETE cascade): a deleted message's
// saved row is harmless and the list join simply drops tombstoned rows.
export const savedMessages = pgTable(
  "saved_messages",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.messageId] }),
    index("idx_saved_messages_user_created").on(t.userId, t.createdAt),
  ],
);

export type SavedMessage = typeof savedMessages.$inferSelect;

// ─── Prompt templates (#602 — reusable composer snippets) ─────────
// WORKSPACE-SCOPED reusable message bodies a member can drop into the composer
// (triggered from the slash menu's secondary "Templates" group). A row is a
// named body of trusted, member-authored markdown; on SEND the body is expanded
// server-side, substituting {channel}/{user}/{date} with the final, HTML-escaped
// context (see prompt-template-expand.ts). This is DISTINCT from the scheduler's
// webhooks.prompt_template (a webhook-payload renderer) — these are composer
// snippets keyed by (workspace, name), not a per-webhook fire prompt.
//
// FKs: workspace cascade-deletes its templates; created_by SET NULL so a deleted
// author leaves the (still shared, workspace-owned) template intact. The unique
// index on (workspace_id, name) makes a name a stable per-workspace handle and
// blocks duplicates (the create RPC maps a clash to a friendly error).
export const promptTemplates = pgTable(
  "prompt_templates",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    body: text("body").notNull(),
    // Author. SET NULL (not cascade) so removing the creator doesn't delete a
    // template the whole workspace relies on; a null author just reads "unknown".
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One template name per workspace (case-sensitive, matching the SQLite UNIQUE
    // and the create RPC's clash check). Doubles as the workspace-scoped lookup.
    uniqueIndex("idx_prompt_templates_workspace_name").on(t.workspaceId, t.name),
  ],
);

export type PromptTemplate = typeof promptTemplates.$inferSelect;

// ─── GitHub App → Tasks one-way sync (issues → tasks) ──────────────────
// Three tables, modeled on the inbound webhooks/webhookDeliveries pair above, that
// bind a GitHub App installation's repositories to Tasks-projects and back-link
// each synced GitHub issue to the task it created. One-way: GitHub is the source of
// truth, the daemon/relay never writes back to GitHub in this phase.

// One row per GitHub App INSTALLATION a workspace has authorized. The App is
// installed on a GitHub account (a user or an org); `installationId` is GitHub's
// numeric id we mint installation tokens against (Phase 3). A workspace may install
// the App on several accounts, so this is not unique per workspace.
export const githubInstallations = pgTable(
  "github_installations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // GitHub's numeric installation id (stored as text — it's an opaque handle we
    // never do arithmetic on, and bigint-as-string avoids JS number precision risk).
    installationId: text("installation_id").notNull(),
    // The account the App is installed on: login + type (User | Organization).
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").notNull().default("User"),
    // The workspace user who connected the install (the OAuth callback's authed user).
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_github_installations_workspace").on(t.workspaceId),
    // GitHub's installation id is globally unique; one row per install id.
    uniqueIndex("idx_github_installations_installation").on(t.installationId),
  ],
);

// One row per (repository ↔ Tasks-project) binding. A repo binds at the
// tasks_project level (1 repo ↔ 1 tasks-project): an inbound issue webhook resolves
// its target project through this row. ON DELETE CASCADE on tasksProjectId so
// deleting a Tasks-project drops its repo bindings (and, transitively, its
// issue-sync rows). UNIQUE(tasksProjectId, repoId) blocks binding the same repo to
// a project twice while still allowing the same repo to bind to other projects.
export const githubRepoSyncs = pgTable(
  "github_repo_syncs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // The installation that grants access to this repo. Plain text (not an FK) so a
    // de-installed account doesn't cascade-drop a binding the user may re-authorize;
    // the receiver resolves-or-skips a stale installation at event time.
    installationId: text("installation_id").notNull(),
    tasksProjectId: text("tasks_project_id")
      .notNull()
      .references((): AnyPgColumn => tasksProjects.id, { onDelete: "cascade" }),
    // GitHub's numeric repository id (opaque text — the stable key across renames).
    repoId: text("repo_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    repoUrl: text("repo_url").notNull(),
    // Sync direction (0039): 'inbound' = GH→Tasks one-way (the 0034 behavior);
    // 'bidirectional' = GH↔Tasks write-back (wave 2). Defaults to 'inbound'.
    syncDirection: text("sync_direction").notNull().default("inbound"),
    // Optional per-binding overrides for the open/closed task state an inbound issue
    // lands in (Image #4 "Configure Issue Sync State"). Plain text (no FK) — the sync
    // engine resolves-or-falls-back at event time. NULL → getGithubSyncStates default.
    issueOpenStateId: text("issue_open_state_id"),
    issueClosedStateId: text("issue_closed_state_id"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_github_repo_syncs_workspace").on(t.workspaceId),
    index("idx_github_repo_syncs_installation").on(t.installationId),
    index("idx_github_repo_syncs_project").on(t.tasksProjectId),
    // A repo binds to a given project at most once.
    uniqueIndex("idx_github_repo_syncs_project_repo").on(t.tasksProjectId, t.repoId),
  ],
);

// One row per synced GitHub issue, back-linking it to the task it created. ON
// DELETE CASCADE on both FKs: dropping the repo binding or the task removes the
// link. UNIQUE(repoSyncId, taskId) keeps one link per (binding, task);
// index(repoSyncId, issueNumber) is the receiver's lookup ("does an issue already
// have a task?") on every subsequent webhook for that issue.
export const githubIssueSyncs = pgTable(
  "github_issue_syncs",
  {
    id: text("id").primaryKey(),
    repoSyncId: text("repo_sync_id")
      .notNull()
      .references(() => githubRepoSyncs.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    // The human issue number (the N in "#N"), per-repo. Drives the receiver lookup.
    issueNumber: integer("issue_number").notNull(),
    // GitHub's globally-unique numeric issue id (opaque text), for disambiguation.
    githubIssueId: text("github_issue_id").notNull(),
    issueUrl: text("issue_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One link per (binding, task).
    uniqueIndex("idx_github_issue_syncs_reposync_task").on(t.repoSyncId, t.taskId),
    // The receiver's hot path: find the task for an inbound (binding, issue number).
    // UNIQUE so concurrent webhooks for the same issue can't create duplicate tasks.
    uniqueIndex("idx_github_issue_syncs_reposync_number").on(t.repoSyncId, t.issueNumber),
  ],
);

// Project-level PR-state → task-state map (0039; Image #3 "Pull Request State
// Mapping"). prState is one of the 6 GitHub PR states (DRAFT_MR_OPENED, MR_OPENED,
// MR_READY_FOR_MERGE, MR_REVIEW_REQUESTED, MR_MERGED, MR_CLOSED); skipBackward
// prevents a PR update from moving a task to an earlier state group. ON DELETE
// CASCADE on tasksProjectId; UNIQUE(tasksProjectId, prState) maps each state once.
export const githubPrStateMappings = pgTable(
  "github_pr_state_mappings",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tasksProjectId: text("tasks_project_id")
      .notNull()
      .references((): AnyPgColumn => tasksProjects.id, { onDelete: "cascade" }),
    prState: text("pr_state").notNull(),
    // The task state this PR state maps to. Plain text (no FK) for parity with the
    // issue state overrides; NULL = "Set State" not chosen yet (no-op mapping row).
    taskStateId: text("task_state_id"),
    skipBackward: boolean("skip_backward").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_github_pr_state_mappings_workspace").on(t.workspaceId),
    index("idx_github_pr_state_mappings_project").on(t.tasksProjectId),
    // A project maps each PR state at most once.
    uniqueIndex("idx_github_pr_state_mappings_project_state").on(t.tasksProjectId, t.prState),
  ],
);

// One row per synced GitHub pull request, back-linking it to the task it tracks
// (0039). ON DELETE CASCADE on both FKs. index(repoSyncId, prNumber) is the sync
// engine's lookup ("does this PR already map to a task?"); UNIQUE so concurrent PR
// webhooks can't create duplicate links.
export const githubPrSyncs = pgTable(
  "github_pr_syncs",
  {
    id: text("id").primaryKey(),
    repoSyncId: text("repo_sync_id")
      .notNull()
      .references(() => githubRepoSyncs.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    githubPrId: text("github_pr_id").notNull(),
    prUrl: text("pr_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_github_pr_syncs_reposync").on(t.repoSyncId),
    uniqueIndex("idx_github_pr_syncs_reposync_number").on(t.repoSyncId, t.prNumber),
  ],
);

// One row per personal GitHub account a workspace user connected via OAuth (0039;
// Image #3 "Connect Personal Account"). accessToken is stored as returned by GitHub
// — TODO(security): encrypt at rest in a follow-up. UNIQUE(workspaceId, userId): one
// personal connection per (workspace, user).
export const githubUserConnections = pgTable(
  "github_user_connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    githubLogin: text("github_login").notNull(),
    accessToken: text("access_token").notNull(),
    scopes: text("scopes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_github_user_connections_workspace").on(t.workspaceId),
    uniqueIndex("idx_github_user_connections_workspace_user").on(t.workspaceId, t.userId),
  ],
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type GithubRepoSync = typeof githubRepoSyncs.$inferSelect;
export type GithubIssueSync = typeof githubIssueSyncs.$inferSelect;
export type GithubPrStateMapping = typeof githubPrStateMappings.$inferSelect;
export type GithubPrSync = typeof githubPrSyncs.$inferSelect;
export type GithubUserConnection = typeof githubUserConnections.$inferSelect;

// ─── Built-in integrations (recipes) ───────────────────────────────────
// One row per recipe install in a workspace. A "recipe" is a preset automation
// (registry id: "standup"|"retro"|"blocker_sweep") that, when enabled, provisions
// a cybo (preset soul + permissions) + N schedules + channel memberships. Enabling
// records the install here; the provisioned ids (cyboId + scheduleIds) are stamped
// once the daemon has created them. Disabling deletes the cybo (its FK ON DELETE
// CASCADE removes the schedules + channel memberships) and marks the row disabled
// (enabled=false, cyboId=null, scheduleIds=[]) — kept for history, NOT hard-deleted.
//
// The partial UNIQUE index enforces "one ACTIVE install per recipe per workspace"
// (only enabled rows participate, so a disabled row may sit alongside a fresh
// re-enable — the enableRecipe upsert targets that partial conflict). cyboId is
// plain text (not an FK to cybos): a deleted cybo must NOT cascade-drop the history
// row; the disable path nulls it explicitly, and a stale id resolves-or-skips at
// read time, matching the loose coupling github_repo_syncs.installation_id uses.
export const installedRecipes = pgTable(
  "installed_recipes",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recipeId: text("recipe_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    config: jsonb("config").notNull().default({}),
    cyboId: text("cybo_id"),
    scheduleIds: jsonb("schedule_ids").$type<string[]>().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One ACTIVE install per (workspace, recipe). Partial: only enabled rows
    // participate, so re-enabling after a disable reuses this conflict target.
    uniqueIndex("idx_installed_recipes_active")
      .on(t.workspaceId, t.recipeId)
      .where(sql`${t.enabled}`),
    index("idx_installed_recipes_ws").on(t.workspaceId),
  ],
);

export type InstalledRecipe = typeof installedRecipes.$inferSelect;

// ─── Integrations: provider-agnostic installs + Slack customer-comms bridge ──
//
// The Slack bridge mirrors a Slack (Connect) channel into a bound Cyborg channel
// and posts Cyborg replies back (bidirectional, echo-guarded). WAVE 1 locks the
// storage contract ONLY; the Slack Events endpoint, OAuth, and UI ship in WAVE 2.
// Migration: 0047_slack_bridge.sql.

// One row per external integration install on a workspace. Provider-agnostic so
// Slack today and Jira/ClickUp later share the table; `provider` discriminates.
// `accessToken` is the bot/app token as returned by the provider —
// TODO(security): encrypt at rest in a follow-up (do not block on it). Nullable
// because not every provider stores a long-lived token (e.g. a GitHub App mints
// per-call). UNIQUE(workspaceId, provider, externalId): one install per
// (workspace, provider, external team/enterprise id). ON DELETE CASCADE on the
// workspace.
export const integrationInstallations = pgTable(
  "integration_installations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Provider discriminator: 'slack' today; 'jira'/'clickup' later.
    provider: text("provider").notNull(),
    // The provider's tenant id (Slack team_id / enterprise_id).
    externalId: text("external_id").notNull(),
    // Free-form provider config (team name, enterprise id, etc.). Never null —
    // defaults to {} so readers don't branch on null.
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    // The provider bot/app access token as returned by the provider.
    // TODO(security): encrypt at rest in a follow-up — note, don't block.
    accessToken: text("access_token"),
    // Slack bot user id (the bot's own user id; drives the echo guard). Nullable —
    // not every provider has one.
    botUserId: text("bot_user_id"),
    // Granted OAuth scopes, as the provider returns them (space/comma-separated).
    scopes: text("scopes"),
    // The workspace user who connected the install (the OAuth callback's authed user).
    installedBy: text("installed_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_integration_installations_workspace").on(t.workspaceId),
    // One install per (workspace, provider, external tenant id).
    uniqueIndex("idx_integration_installations_ws_provider_external").on(
      t.workspaceId,
      t.provider,
      t.externalId,
    ),
  ],
);

// One row per (Slack channel ↔ Cyborg channel) binding. UNIQUE(slackChannelId): a
// given Slack channel mirrors into exactly one Cyborg channel. index on
// cyborgChannelId is the outbound hot path ("is this channel Slack-linked?"). FKs
// CASCADE so dropping the install, workspace, or channel drops the link.
export const slackChannelLinks = pgTable(
  "slack_channel_links",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    installationId: text("installation_id")
      .notNull()
      .references(() => integrationInstallations.id, { onDelete: "cascade" }),
    cyborgChannelId: text("cyborg_channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    slackChannelId: text("slack_channel_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    // 'bidirectional' (default), 'inbound' (Slack→Cyborg only), 'outbound'.
    syncDirection: text("sync_direction").notNull().default("bidirectional"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_slack_channel_links_workspace").on(t.workspaceId),
    index("idx_slack_channel_links_cyborg_channel").on(t.cyborgChannelId),
    // A given Slack channel binds to exactly one Cyborg channel.
    uniqueIndex("idx_slack_channel_links_slack_channel").on(t.slackChannelId),
  ],
);

// Maps a Slack (team, user) to the synthetic Cyborg guest user that authors its
// mirrored messages (the ensureUser id, e.g. `slack:<team>:<user>`). One row per
// (team, user). workspaceId is denormalized for scoping; no DB FK (the map is a
// bridge-owned lookup cache).
export const slackUserMap = pgTable(
  "slack_user_map",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    slackTeamId: text("slack_team_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),
    // The synthetic Cyborg user id (the ensureUser id) authoring mirrored messages.
    syntheticUserId: text("synthetic_user_id").notNull(),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_slack_user_map_team_user").on(t.slackTeamId, t.slackUserId)],
);

// Back-links a Cyborg message to its provider counterpart (Slack ts) and vice
// versa. Provider-agnostic so GitHub/Jira can reuse it. messageId is the PK (one
// external mapping per Cyborg message); UNIQUE(provider, externalId, workspaceId) is
// the inbound reverse lookup ("which Cyborg message is this Slack ts?") + the echo
// guard + the atomic inbound-dedupe constraint. It's workspace-scoped because a Slack
// ts is unique per channel, NOT globally — a global unique would let one tenant's ts
// block another's mirror; (provider, externalId) is the leading prefix so the reverse
// lookup stays index-served. externalThreadId carries the Slack thread_ts so a reply
// threads. Plain text keys (no FK): the message row may live in a different store
// (SQLite cache) and the mapping is bridge-owned.
export const messageIntegrations = pgTable(
  "message_integrations",
  {
    messageId: text("message_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    externalThreadId: text("external_thread_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_message_integrations_provider_external").on(
      t.provider,
      t.externalId,
      t.workspaceId,
    ),
  ],
);

export type IntegrationInstallation = typeof integrationInstallations.$inferSelect;
export type SlackChannelLink = typeof slackChannelLinks.$inferSelect;
export type SlackUserMap = typeof slackUserMap.$inferSelect;
export type MessageIntegration = typeof messageIntegrations.$inferSelect;

import {
  eq,
  ne,
  gt,
  and,
  or,
  desc,
  lt,
  lte,
  sql,
  asc,
  isNull,
  isNotNull,
  exists,
  inArray,
  notInArray,
  ilike,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { getDb, closePool } from "./connection.js";
import { isStripeConfigured } from "../billing/stripe.js";
import {
  deriveBillingSource,
  mapLicenseStateToBillingState,
  resolveBillingIntent,
  type BillingIntent,
  type BillingPlatform,
  type BillingRole,
} from "../billing/intent.js";
import {
  DAEMON_SCOPES,
  isDaemonScope,
  normalizeScopes,
  type DaemonScope,
} from "../daemon-scopes.js";
import * as schema from "./schema.js";
import type {
  StoredMessage,
  StoredChannel,
  StoredWorkspace,
  StoredTask,
  StoredActivityEvent,
  StoredSchedule,
  StoredScheduleRun,
  ScheduleSkipReason,
  StoredScheduledMessage,
  ScheduledMessageErrorCode,
  StoredPromptTemplate,
  StoredInstalledRecipe,
  PageShape,
} from "../storage.js";
// Phase 0 — shared opaque-cursor + reorder math (defined in the dependency-free
// task-ordering module, NOT storage.ts: importing from storage.ts would pull its
// better-sqlite3 dependency into the Postgres-only relay's startup graph and
// crash-loop it. SQLite and PG read paths page identically off these helpers).
import { encodeTaskCursor, decodeTaskCursor, computeReorderSort } from "../task-ordering.js";
import { PageCycleError, isPageDescendant } from "../page-access.js";
import type { StoredCybo } from "../cybo-types.js";
import type { Unfurl } from "../unfurl.js";
import type { MessageCard } from "../webhook-card.js";

// Map a nullable PG boolean to the SQLite-style tri-state (1 | 0 | null) the
// Stored* row shapes use. NULL stays NULL so "unset" (e.g. auto_tasks_enabled
// opt-in OFF) is distinguishable from an explicit false.
function boolToInt(value: boolean | null | undefined): number | null {
  if (value == null) return null;
  return value ? 1 : 0;
}

// Tasks Redesign P0 — map a workflow state's canonical group to the legacy
// free-text `tasks.status` value, which the watcher/dispatch and older clients
// still read. The status column stays a back-compat mirror of state.group.
function mapStateGroupToStatus(group: string): string {
  switch (group) {
    case "backlog":
    case "unstarted":
      return "pending";
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

// The five default workflow states seeded for every Tasks-project, mirroring the
// 0031 backfill (ids 'ts_' || projectId || '_' || group). is_default on the
// unstarted (Todo) state so new tasks land there.
const DEFAULT_TASK_STATES: ReadonlyArray<{
  group: string;
  name: string;
  color: string;
  sequence: number;
  isDefault: boolean;
}> = [
  { group: "backlog", name: "Backlog", color: "#9ca3af", sequence: 1, isDefault: false },
  { group: "unstarted", name: "Todo", color: "#3b82f6", sequence: 2, isDefault: true },
  { group: "started", name: "In Progress", color: "#f59e0b", sequence: 3, isDefault: false },
  { group: "completed", name: "Done", color: "#22c55e", sequence: 4, isDefault: false },
  { group: "cancelled", name: "Cancelled", color: "#ef4444", sequence: 5, isDefault: false },
];

// Subset of the daemons.meta jsonb a heartbeat/hello may update.
type DaemonMetaUpdate = NonNullable<typeof schema.daemons.$inferSelect.meta>;

// The transaction handle passed to db.transaction(async (tx) => …). Extracted so
// helper methods that run inside a caller's transaction can be explicitly typed.
type PgTx = Parameters<Parameters<NodePgDatabase<typeof schema>["transaction"]>[0]>[0];

// Map a subscription's stripeCustomerId discriminator to its purchase platform:
// `manual_comp_grant` (comp grant), `revenuecat:*` (Apple IAP), `cus_*` (Stripe).
// Returns null for anything unrecognized (stays "unknown").
function derivePurchasePlatform(stripeCustomerId: string | null | undefined): string | null {
  if (!stripeCustomerId) return null;
  if (stripeCustomerId === "manual_comp_grant") return "manual";
  if (stripeCustomerId.startsWith("revenuecat:")) return "apple";
  if (stripeCustomerId.startsWith("cus_")) return "stripe";
  return null;
}

// Row shape returned by the getOrgDetail daemon select (daemons row + ownerEmail
// join + meta jsonb). Extracted so getOrgDetail stays under the complexity cap.
interface OrgDaemonDetailRow {
  id: string;
  label: string;
  ownerEmail: string | null;
  status: string;
  lastSeenAt: Date | null;
  deploymentMode: string | null;
  // Dedicated column mirror of meta.edition (usage-metrics, round 1). Nullable: an
  // older daemon that doesn't report it stays NULL; we fall back to meta.edition.
  deploymentEdition: string | null;
  meta: DaemonMetaUpdate | null;
}
// Project the meta jsonb's per-host fields into the wire shape, normalizing
// undefined → null (meta absent or not carrying a field) for a stable UI contract.
// Split out of toOrgDaemonDetail to keep each helper under the complexity cap.
function toOrgDaemonMeta(meta: DaemonMetaUpdate | null) {
  const m = meta ?? {};
  return {
    platform: m.platform ?? null,
    arch: m.arch ?? null,
    host: m.host ?? null,
    cpu: m.cpu ?? null,
    memMb: m.memMb ?? null,
    agents: m.agents ?? null,
    queueDepth: m.queueDepth ?? null,
    uptime: m.uptime ?? null,
    cyboInstalled: m.cyboInstalled ?? null,
    accepting: m.accepting ?? null,
    // Usage-metrics (round 1): live per-daemon counts off the meta snapshot. Null
    // until the daemon emits them (older daemons / fresh rows stay null).
    activeSessionCount: m.activeSessionCount ?? null,
    activeCyboCount: m.activeCyboCount ?? null,
  };
}
// Project a daemon row + its meta jsonb into the wire shape (meta-derived fields
// normalized undefined → null for a stable UI contract). `edition` prefers the
// dedicated deployment_edition column, falling back to meta.edition.
function toOrgDaemonDetail(d: OrgDaemonDetailRow) {
  return {
    id: d.id,
    label: d.label,
    ownerEmail: d.ownerEmail,
    status: d.status,
    lastSeenAt: d.lastSeenAt?.getTime() ?? null,
    deploymentMode: d.deploymentMode,
    edition: d.deploymentEdition ?? d.meta?.edition ?? null,
    ...toOrgDaemonMeta(d.meta),
  };
}

// Parse the workspace slash model stored as "provider/model" (split on the FIRST
// "/", since model ids can contain slashes — e.g. Pi's "pi/opencode-go/glm-5.1"
// must yield provider "pi", model "opencode-go/glm-5.1", NOT provider "opencode").
// Null/blank → null (auto-resolve). Exported for unit testing.
export function parseProviderModel(raw: string | null): { provider: string; model: string } | null {
  if (!raw) return null;
  const i = raw.indexOf("/");
  if (i <= 0 || i >= raw.length - 1) return null;
  return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
}

// Escape LIKE/ILIKE wildcards so a user typing %, _ or \ searches for the
// literal character instead of a wildcard. Backslash first (it's the escape char).
export function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Enriched, workspace-wide task-search row returned by searchTasks (relay
// cyborg:search_tasks). camelCase; the relay passes it through verbatim and the
// UI client mirrors it as TaskSearchResult. Timestamps are epoch ms.
export interface TaskSearchHit {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: string;
  stateId: string | null;
  sequenceId: number | null;
  priority: string | null;
  assigneeId: string | null;
  createdAt: number;
  updatedAt: number;
  project: {
    id: string;
    identifier: string;
    name: string;
    color: string | null;
    isInbox: boolean;
    chatProjectId: string | null;
  } | null;
  state: { id: string; name: string; color: string; group: string } | null;
  assignee: {
    id: string;
    name: string | null;
    imageUrl: string | null;
    kind: "user" | "cybo";
  } | null;
}

// Row shape of the searchTasks main query (task + left-joined project/chat-project/
// state/user columns). Extracted so the private mapper has a named input type and
// the method body stays simple (complexity cap).
interface TaskSearchRow {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: string;
  stateId: string | null;
  sequenceId: number | null;
  priority: string | null;
  assigneeId: string | null;
  createdAt: Date;
  updatedAt: Date;
  tpId: string | null;
  tpIdentifier: string | null;
  tpColor: string | null;
  chatProjectId: string | null;
  chatProjectName: string | null;
  chatProjectColor: string | null;
  stateRowId: string | null;
  stateName: string | null;
  stateColor: string | null;
  stateGroup: string | null;
  userId: string | null;
  userName: string | null;
  userImageUrl: string | null;
}

export class PgSync {
  private db: NodePgDatabase<typeof schema>;

  constructor() {
    this.db = getDb();
  }

  // ─── Users ───────────────────────────────────────────────────────

  // Returns the CANONICAL user id for this email. Never mutates users.id on
  // conflict: id is the primary key referenced by memberships/channel_members/
  // messages/daemons, so the old `SET id = ...` either violated those FKs or
  // silently churned identity (the root of the local-SQLite↔cloud-PG id
  // divergence). On conflict we keep the existing id and only refresh name.
  async upsertUser(id: string, email: string, name?: string | null): Promise<string> {
    const [row] = await this.db
      .insert(schema.users)
      .values({ id, email, name: name ?? null })
      .onConflictDoUpdate({
        target: schema.users.email,
        set: {
          name: sql`COALESCE(${name ?? null}, ${schema.users.name})`,
        },
      })
      .returning({ id: schema.users.id });
    return row.id;
  }

  async getUserByEmail(email: string): Promise<{
    id: string;
    email: string;
    name: string | null;
    imageUrl: string | null;
    passwordHash: string | null;
  } | null> {
    const [user] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        imageUrl: schema.users.imageUrl,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    return user ?? null;
  }

  // Batch email → global account id lookup. Used by the relay's list_agents
  // finalize to resolve each row's daemon-local initiated_by to the GLOBAL account
  // id by identity (cross-daemon-initiated-by.ts) in ONE round-trip instead of a
  // per-email query loop. Returns only the emails that map to a known account.
  async getUserIdsByEmails(emails: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (emails.length === 0) return out;
    const rows = await this.db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(inArray(schema.users.email, emails));
    for (const r of rows) out.set(r.email, r.id);
    return out;
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
  }

  // ─── Email OTP ──────────────────────────────────────────────────

  async upsertOtp(params: {
    email: string;
    codeHash: string;
    name: string | null;
    passwordHash: string | null;
    expiresAt: Date;
    purpose?: "signup" | "reset";
  }): Promise<void> {
    const purpose = params.purpose ?? "signup";
    await this.db
      .insert(schema.emailOtps)
      .values({
        email: params.email,
        codeHash: params.codeHash,
        name: params.name,
        passwordHash: params.passwordHash,
        attempts: 0,
        purpose,
        expiresAt: params.expiresAt,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.emailOtps.email,
        set: {
          codeHash: params.codeHash,
          name: params.name,
          passwordHash: params.passwordHash,
          attempts: 0,
          purpose,
          expiresAt: params.expiresAt,
          createdAt: new Date(),
        },
      });
  }

  async getOtp(email: string): Promise<{
    email: string;
    codeHash: string;
    name: string | null;
    passwordHash: string | null;
    attempts: number;
    purpose: string;
    expiresAt: Date;
    createdAt: Date;
  } | null> {
    const [row] = await this.db
      .select()
      .from(schema.emailOtps)
      .where(eq(schema.emailOtps.email, email))
      .limit(1);
    return row ?? null;
  }

  async bumpOtpAttempts(email: string): Promise<number> {
    const [row] = await this.db
      .update(schema.emailOtps)
      .set({ attempts: sql`${schema.emailOtps.attempts} + 1` })
      .where(eq(schema.emailOtps.email, email))
      .returning({ attempts: schema.emailOtps.attempts });
    return row?.attempts ?? 0;
  }

  async deleteOtp(email: string): Promise<void> {
    await this.db.delete(schema.emailOtps).where(eq(schema.emailOtps.email, email));
  }

  async getUserById(id: string): Promise<{
    id: string;
    email: string;
    name: string | null;
    imageUrl: string | null;
  } | null> {
    const [user] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        imageUrl: schema.users.imageUrl,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id))
      .limit(1);
    return user ?? null;
  }

  // ─── WebAuthn / passkeys ────────────────────────────────────────

  // Write (or overwrite) a single-use challenge. Latest request per key wins,
  // mirroring upsertOtp — re-requesting `/options` invalidates the prior one.
  async putWebauthnChallenge(params: {
    key: string;
    challenge: string;
    purpose: "register" | "authenticate";
    expiresAt: Date;
  }): Promise<void> {
    // Opportunistic GC: drop expired challenges so abandoned ceremonies (closed
    // tab, cancelled prompt) don't accumulate. Cheap + avoids needing a cron.
    await this.db
      .delete(schema.webauthnChallenges)
      .where(lt(schema.webauthnChallenges.expiresAt, new Date()));
    await this.db
      .insert(schema.webauthnChallenges)
      .values({
        key: params.key,
        challenge: params.challenge,
        purpose: params.purpose,
        expiresAt: params.expiresAt,
        createdAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.webauthnChallenges.key,
        set: {
          challenge: params.challenge,
          purpose: params.purpose,
          expiresAt: params.expiresAt,
          createdAt: new Date(),
        },
      });
  }

  // Consume a challenge: read + delete in one shot (single-use). Returns null if
  // the key is unknown, the purpose mismatches, or it has expired.
  async consumeWebauthnChallenge(
    key: string,
    purpose: "register" | "authenticate",
  ): Promise<string | null> {
    const [row] = await this.db
      .delete(schema.webauthnChallenges)
      .where(eq(schema.webauthnChallenges.key, key))
      .returning({
        challenge: schema.webauthnChallenges.challenge,
        purpose: schema.webauthnChallenges.purpose,
        expiresAt: schema.webauthnChallenges.expiresAt,
      });
    if (!row) return null;
    if (row.purpose !== purpose) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return row.challenge;
  }

  async insertWebauthnCredential(params: {
    id: string;
    userId: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[] | null;
    deviceType: string | null;
    backedUp: boolean;
    nickname: string | null;
  }): Promise<void> {
    await this.db.insert(schema.webauthnCredentials).values({
      id: params.id,
      userId: params.userId,
      credentialId: params.credentialId,
      publicKey: params.publicKey,
      counter: params.counter,
      transports: params.transports,
      deviceType: params.deviceType,
      backedUp: params.backedUp,
      nickname: params.nickname,
      createdAt: new Date(),
    });
  }

  async getWebauthnCredentialsByUser(userId: string): Promise<
    {
      id: string;
      credentialId: string;
      transports: string[] | null;
      nickname: string | null;
      deviceType: string | null;
      createdAt: Date;
      lastUsedAt: Date | null;
    }[]
  > {
    return this.db
      .select({
        id: schema.webauthnCredentials.id,
        credentialId: schema.webauthnCredentials.credentialId,
        transports: schema.webauthnCredentials.transports,
        nickname: schema.webauthnCredentials.nickname,
        deviceType: schema.webauthnCredentials.deviceType,
        createdAt: schema.webauthnCredentials.createdAt,
        lastUsedAt: schema.webauthnCredentials.lastUsedAt,
      })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, userId));
  }

  async getWebauthnCredentialByCredentialId(credentialId: string): Promise<{
    id: string;
    userId: string;
    credentialId: string;
    publicKey: string;
    counter: number;
    transports: string[] | null;
  } | null> {
    const [row] = await this.db
      .select({
        id: schema.webauthnCredentials.id,
        userId: schema.webauthnCredentials.userId,
        credentialId: schema.webauthnCredentials.credentialId,
        publicKey: schema.webauthnCredentials.publicKey,
        counter: schema.webauthnCredentials.counter,
        transports: schema.webauthnCredentials.transports,
      })
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.credentialId, credentialId))
      .limit(1);
    return row ?? null;
  }

  async updateWebauthnCredentialCounter(credentialId: string, counter: number): Promise<void> {
    await this.db
      .update(schema.webauthnCredentials)
      .set({ counter, lastUsedAt: new Date() })
      .where(eq(schema.webauthnCredentials.credentialId, credentialId));
  }

  // Delete a single credential, scoped to its owner so one user can't remove
  // another's passkey. Returns true when a row was actually removed.
  async deleteWebauthnCredential(userId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(schema.webauthnCredentials)
      .where(
        and(eq(schema.webauthnCredentials.userId, userId), eq(schema.webauthnCredentials.id, id)),
      )
      .returning({ id: schema.webauthnCredentials.id });
    return rows.length > 0;
  }

  // Account moderation status for the auth path. Returns only the two nullable
  // flags requireAuth needs to reject a suspended/deleted session (a NULL pair =
  // the normal, active state). Kept minimal + separate from getUserByEmail so the
  // hot auth lookup stays unchanged for every existing caller. Returns null when
  // the user id does not exist.
  async getAccountStatus(
    userId: string,
  ): Promise<{ suspendedAt: Date | null; deletedAt: Date | null } | null> {
    const [row] = await this.db
      .select({
        suspendedAt: schema.users.suspendedAt,
        deletedAt: schema.users.deletedAt,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return row ?? null;
  }

  // The daemon this user's slash commands route to by default (null = unset).
  async getUserDefaultSlashDaemon(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ daemonId: schema.users.defaultSlashDaemonId })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return row?.daemonId ?? null;
  }

  async setUserDefaultSlashDaemon(userId: string, daemonId: string | null): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ defaultSlashDaemonId: daemonId })
      .where(eq(schema.users.id, userId));
  }

  // The model this user's channel AI commands prefer (null = auto-resolve).
  // Stored as JSON {"provider","model"}; a corrupt/legacy value degrades to null.
  async getUserSlashCommandModel(
    userId: string,
  ): Promise<{ provider: string; model: string } | null> {
    const [row] = await this.db
      .select({ model: schema.users.slashCommandModel })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!row?.model) return null;
    try {
      const parsed = JSON.parse(row.model) as { provider?: unknown; model?: unknown };
      if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
        return { provider: parsed.provider, model: parsed.model };
      }
    } catch {
      // fall through to null
    }
    return null;
  }

  async setUserSlashCommandModel(
    userId: string,
    selection: { provider: string; model: string } | null,
  ): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ slashCommandModel: selection ? JSON.stringify(selection) : null })
      .where(eq(schema.users.id, userId));
  }

  // ── Workspace-level slash AI config (#opt-A: per-workspace, admin-controlled) ──
  // `model` is stored as "provider/model" text; returned parsed for the dispatcher.
  async getWorkspaceSlashConfig(workspaceId: string): Promise<{
    defaultSlashDaemonId: string | null;
    fallbackDaemons: string[];
    model: { provider: string; model: string } | null;
  }> {
    const [row] = await this.db
      .select({
        defaultSlashDaemonId: schema.workspaces.defaultSlashDaemonId,
        fallbackDaemons: schema.workspaces.slashCommandFallbackDaemons,
        model: schema.workspaces.slashCommandModel,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return {
      defaultSlashDaemonId: row?.defaultSlashDaemonId ?? null,
      fallbackDaemons: Array.isArray(row?.fallbackDaemons) ? row.fallbackDaemons : [],
      model: parseProviderModel(row?.model ?? null),
    };
  }

  async setWorkspaceSlashConfig(
    workspaceId: string,
    config: {
      defaultSlashDaemonId?: string | null;
      fallbackDaemons?: string[];
      // "provider/model" string, or null to clear.
      model?: string | null;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (config.defaultSlashDaemonId !== undefined)
      set.defaultSlashDaemonId = config.defaultSlashDaemonId;
    if (config.fallbackDaemons !== undefined)
      set.slashCommandFallbackDaemons = config.fallbackDaemons;
    if (config.model !== undefined) set.slashCommandModel = config.model;
    if (Object.keys(set).length === 0) return;
    await this.db.update(schema.workspaces).set(set).where(eq(schema.workspaces.id, workspaceId));
  }

  // Per-workspace agent-autonomy switch — read it directly. DEFAULT ON: a
  // workspace's channel watcher may fire unless autonomy is explicitly turned
  // OFF (v===false). NULL/missing => ON. @-mentions are unaffected by this flag.
  async getWorkspaceAutonomyEnabled(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ v: schema.workspaces.agentAutonomyEnabled })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return row?.v !== false;
  }

  async setWorkspaceAutonomyEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    await this.db
      .update(schema.workspaces)
      .set({ agentAutonomyEnabled: enabled })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  async updateUserImage(id: string, imageUrl: string | null): Promise<void> {
    await this.db.update(schema.users).set({ imageUrl }).where(eq(schema.users.id, id));
  }

  async updateUserName(id: string, name: string): Promise<void> {
    await this.db.update(schema.users).set({ name }).where(eq(schema.users.id, id));
  }

  async ensureUser(id: string, email: string, name?: string | null): Promise<void> {
    await this.db
      .insert(schema.users)
      .values({ id, email, name: name ?? null })
      .onConflictDoNothing();
  }

  // ─── Workspaces ──────────────────────────────────────────────────

  // Create a workspace, its owner membership, and (optionally) the general
  // channel ATOMICALLY in one transaction. Previously DualStorage chained three
  // separate fire-and-forget awaits (workspace → addMember → channel); if
  // addMember failed the workspace was left with ZERO memberships — an orphan
  // invisible to its own owner (19 such rows found in prod). A single
  // transaction guarantees the owner membership always lands with the workspace,
  // or the whole create rolls back. Mirrors SQLite's atomic createWorkspace.
  async createWorkspaceAtomic(opts: {
    id: string;
    name: string;
    ownerId: string;
    settings?: Record<string, unknown>;
    generalChannelId?: string | null;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.workspaces).values({
        id: opts.id,
        name: opts.name,
        ownerId: opts.ownerId,
        settings: opts.settings ?? {},
      });
      await tx
        .insert(schema.memberships)
        .values({
          workspaceId: opts.id,
          userId: opts.ownerId,
          role: "owner",
          membershipType: "active",
        })
        .onConflictDoNothing();
      if (opts.generalChannelId) {
        await tx
          .insert(schema.channels)
          .values({
            id: opts.generalChannelId,
            workspaceId: opts.id,
            name: "general",
            description: "General discussion",
            createdBy: opts.ownerId,
          })
          .onConflictDoNothing();
      }
    });
  }

  // Plain workspace insert (no membership). Kept for the cloud-relay/auth-route
  // callers that create the owner membership themselves in their own flow.
  async createWorkspace(
    id: string,
    name: string,
    ownerId: string,
    settings?: Record<string, unknown>,
  ): Promise<void> {
    await this.db.insert(schema.workspaces).values({
      id,
      name,
      ownerId,
      settings: settings ?? {},
    });
  }

  // Authoritative name + owner for a workspace, for PG→SQLite hydration. The
  // relay forwards RPCs for PG workspaces a daemon's SQLite never created;
  // materializing them as a "Remote"/caller-owned stub diverges the local cache
  // from the truth. ensureMembership pulls the real values from here instead.
  async getWorkspaceNameAndOwner(
    workspaceId: string,
  ): Promise<{ name: string; ownerId: string } | null> {
    const [row] = await this.db
      .select({ name: schema.workspaces.name, ownerId: schema.workspaces.ownerId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return row ?? null;
  }

  async getWorkspacesForUser(userId: string): Promise<Array<StoredWorkspace & { role: string }>> {
    const rows = await this.db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        owner_id: schema.workspaces.ownerId,
        avatar_url: schema.workspaces.avatarUrl,
        settings: schema.workspaces.settings,
        created_at: schema.workspaces.createdAt,
        role: schema.memberships.role,
      })
      .from(schema.workspaces)
      .innerJoin(schema.memberships, eq(schema.memberships.workspaceId, schema.workspaces.id))
      // Exclude DISABLED workspaces (superadmin moderation): a disabled org drops
      // out of every member's list on the next auth/refresh. disabledAt IS NULL is
      // the normal/active state, so unmoderated workspaces are unaffected.
      .where(and(eq(schema.memberships.userId, userId), isNull(schema.workspaces.disabledAt)));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      owner_id: r.owner_id,
      avatar_url: r.avatar_url,
      settings: r.settings ? JSON.stringify(r.settings) : null,
      created_at: r.created_at.getTime(),
      role: r.role,
    }));
  }

  async getWorkspaceById(workspaceId: string): Promise<{ id: string; name: string } | null> {
    const [row] = await this.db
      .select({ id: schema.workspaces.id, name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return row ?? null;
  }

  async updateWorkspace(
    workspaceId: string,
    updates: { name?: string; avatarUrl?: string | null; settings?: Record<string, unknown> },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.avatarUrl !== undefined) set.avatarUrl = updates.avatarUrl;
    if (updates.settings !== undefined) set.settings = updates.settings;
    if (Object.keys(set).length === 0) return;
    await this.db.update(schema.workspaces).set(set).where(eq(schema.workspaces.id, workspaceId));
  }

  // Workspace-scoped child rows cascade via onDelete: "cascade" FK constraints.
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
  }

  // Permanently delete the authenticated user's OWN account (App-Store
  // Guideline 5.1.1(v) — in-app account deletion). Mirrors v1's
  // DELETE /api/account: solely-owned workspaces are deleted, shared ones are
  // reassigned to the next admin (or oldest other member). Run in a transaction
  // so a partial deletion can never leave dangling rows. Idempotent: a userId
  // with no rows simply deletes nothing.
  //
  // Cascade design — what gets removed and why:
  //   - Owned workspaces: DELETED if the user is the sole member; otherwise
  //     OWNERSHIP REASSIGNED to the next admin/oldest member (consistent with v1
  //     and with the workspaces.ownerId FK, which has NO onDelete cascade and
  //     would otherwise block the user delete). Deleting a workspace cascades its
  //     channels / messages / memberships / tasks / cybos / etc. via their
  //     onDelete:"cascade" FKs to workspaces.id.
  //   - Daemons owned by the user: DELETED. daemons.ownerId references users.id
  //     with NO cascade, so it would block the delete. daemon_agents,
  //     workspace_daemons and daemon_access cascade from daemons.id.
  //   - invitations.createdBy / agent_channel_assignments.assignedBy /
  //     daemon_access.grantedBy: all reference users.id with NO cascade, so the
  //     rows the user authored are DELETED explicitly before the user row.
  //   - Everything else keyed on users.id with onDelete:"cascade" is removed
  //     automatically by the final user delete: memberships, channel_members,
  //     channel_roles, message_reads, dm_reads, agent_sessions, mcp_tokens,
  //     user_statuses, user_presence, push_subscriptions and fcm_tokens.
  async deleteAccount(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Reassign or delete every workspace this user OWNS.
      const owned = await tx
        .select({ id: schema.workspaces.id })
        .from(schema.workspaces)
        .where(eq(schema.workspaces.ownerId, userId));

      for (const ws of owned) {
        // Up to two OTHER ACTIVE members — enough to know "sole active member?"
        // and pick a heir. Only "active" memberships qualify: an "invited" row
        // is a pending invite the person never accepted, so it must not inherit
        // ownership. If the only other members are invites, the workspace is
        // effectively solely-owned and is deleted.
        const others = await tx
          .select({ userId: schema.memberships.userId, role: schema.memberships.role })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.workspaceId, ws.id),
              eq(schema.memberships.membershipType, "active"),
              ne(schema.memberships.userId, userId),
            ),
          )
          .limit(2);

        if (others.length === 0) {
          // Sole active member — delete the workspace (children cascade,
          // including any outstanding invited memberships + invitations).
          await tx.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
        } else {
          // Transfer ownership to the first admin, else the first other member,
          // and promote that member to admin so the workspace keeps an owner.
          const heir = others.find((m) => m.role === "admin") ?? others[0];
          await tx
            .update(schema.workspaces)
            .set({ ownerId: heir.userId })
            .where(eq(schema.workspaces.id, ws.id));
          await tx
            .update(schema.memberships)
            .set({ role: "admin" })
            .where(
              and(
                eq(schema.memberships.workspaceId, ws.id),
                eq(schema.memberships.userId, heir.userId),
              ),
            );
          // The user's own membership in this (now reassigned) workspace is
          // removed by the cascade on the final user delete, but drop it here so
          // the leaving owner is gone from the member list within the same tx.
          await tx
            .delete(schema.memberships)
            .where(
              and(eq(schema.memberships.workspaceId, ws.id), eq(schema.memberships.userId, userId)),
            );
        }
      }

      // Non-cascading FK references authored by this user — remove explicitly so
      // the user row can be deleted.
      await tx.delete(schema.daemons).where(eq(schema.daemons.ownerId, userId));
      await tx.delete(schema.invitations).where(eq(schema.invitations.createdBy, userId));
      await tx
        .delete(schema.agentChannelAssignments)
        .where(eq(schema.agentChannelAssignments.assignedBy, userId));
      await tx.delete(schema.daemonAccess).where(eq(schema.daemonAccess.grantedBy, userId));

      // Finally the user row. All remaining users.id references with
      // onDelete:"cascade" (memberships, channel_members, channel_roles,
      // message_reads, dm_reads, agent_sessions, mcp_tokens, user_statuses,
      // user_presence, push_subscriptions, fcm_tokens, daemon_access.userId)
      // are removed automatically by this delete.
      await tx.delete(schema.users).where(eq(schema.users.id, userId));
    });
  }

  // ─── Memberships ─────────────────────────────────────────────────

  async addMember(
    workspaceId: string,
    userId: string,
    role = "member",
    membershipType = "active",
  ): Promise<void> {
    await this.db
      .insert(schema.memberships)
      .values({ workspaceId, userId, role, membershipType })
      .onConflictDoNothing();
  }

  async getMembers(workspaceId: string): Promise<
    Array<{
      userId: string;
      email: string;
      name: string | null;
      imageUrl: string | null;
      role: string;
      membershipType: string;
      joinedAt: number;
    }>
  > {
    const rows = await this.db
      .select({
        userId: schema.memberships.userId,
        email: schema.users.email,
        name: schema.users.name,
        imageUrl: schema.users.imageUrl,
        role: schema.memberships.role,
        membershipType: schema.memberships.membershipType,
        joinedAt: schema.memberships.joinedAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.workspaceId, workspaceId));

    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      imageUrl: r.imageUrl,
      role: r.role,
      membershipType: r.membershipType,
      joinedAt: r.joinedAt.getTime(),
    }));
  }

  async isMember(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: schema.memberships.userId })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)),
      )
      .limit(1);
    return !!row;
  }

  async getMemberRole(workspaceId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(
        and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)),
      )
      .limit(1);
    return row?.role ?? null;
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.db
      .delete(schema.memberships)
      .where(
        and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)),
      );
  }

  async updateMemberRole(workspaceId: string, userId: string, role: string): Promise<void> {
    await this.db
      .update(schema.memberships)
      .set({ role })
      .where(
        and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)),
      );
  }

  async activateInvitedMemberships(userId: string): Promise<string[]> {
    const invited = await this.db
      .select({ workspaceId: schema.memberships.workspaceId })
      .from(schema.memberships)
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.membershipType, "invited"),
        ),
      );
    if (invited.length === 0) return [];
    await this.db
      .update(schema.memberships)
      .set({ membershipType: "active" })
      .where(
        and(
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.membershipType, "invited"),
        ),
      );
    const workspaceIds = invited.map((r) => r.workspaceId);
    // Slack model: auto-join the default public channel (#general) of each
    // workspace the user just became active in, so their channel list isn't
    // empty. Batched — the sequential per-workspace await was an N+1 on login.
    await Promise.all(workspaceIds.map((wsId) => this.joinDefaultChannels(wsId, userId)));
    return workspaceIds;
  }

  // Add the user to the workspace's default public channel (#general). Idempotent.
  async joinDefaultChannels(workspaceId: string, userId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO channel_members (channel_id, user_id, role)
      SELECT c.id, ${userId}, 'member'
      FROM channels c
      WHERE c.workspace_id = ${workspaceId}
        AND c.name = 'general' AND c.is_private = false AND c.deleted_at IS NULL
      ON CONFLICT (channel_id, user_id) DO NOTHING
    `);
  }

  // ─── Cybo channel membership (Phase 2: cybo as an @-mentionable member) ──
  // Adding a cybo to a channel grants it access to act there. Idempotent.
  async addCyboToChannel(channelId: string, cyboId: string): Promise<void> {
    await this.db.execute(sql`
      INSERT INTO channel_members (channel_id, cybo_id, member_type, role)
      VALUES (${channelId}, ${cyboId}, 'cybo', 'member')
      ON CONFLICT (channel_id, cybo_id) WHERE cybo_id IS NOT NULL DO NOTHING
    `);
  }

  async removeCyboFromChannel(channelId: string, cyboId: string): Promise<void> {
    await this.db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.cyboId, cyboId),
        ),
      );
  }

  // Cybo ids that are members of the channel. Ordered deterministically by join
  // order (joined_at ASC, cybo_id ASC) so the Tasks watcher failover chain is
  // stable across calls/replicas — exactly one cybo handles each message, picked
  // as the first online member of this chain (internal docs Decision 2 / C2).
  async getChannelCyboMembers(channelId: string): Promise<string[]> {
    const rows = await this.db
      .select({ cyboId: schema.channelMembers.cyboId })
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, "cybo"),
        ),
      )
      .orderBy(asc(schema.channelMembers.joinedAt), asc(schema.channelMembers.cyboId));
    return rows.map((r) => r.cyboId).filter((id): id is string => id !== null);
  }

  async isCyboChannelMember(channelId: string, cyboId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ cyboId: schema.channelMembers.cyboId })
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.cyboId, cyboId),
        ),
      )
      .limit(1);
    return !!row;
  }

  // Browse view: all public channels in the workspace plus any private channels
  // the user already belongs to, each flagged with whether the user is a member.
  async getChannelsWithMembership(
    workspaceId: string,
    userId: string,
  ): Promise<Array<StoredChannel & { is_member: boolean; member_count: number }>> {
    // The three reads are independent — run them concurrently (navigation hot
    // path). Member counts drive the browse modal's "N members" + the owner-only
    // delete-if-empty affordance.
    const [rows, mem, counts] = await Promise.all([
      this.db
        .select()
        .from(schema.channels)
        .where(
          and(eq(schema.channels.workspaceId, workspaceId), isNull(schema.channels.deletedAt)),
        ),
      this.db
        .select({ channelId: schema.channelMembers.channelId })
        .from(schema.channelMembers)
        .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMembers.channelId))
        .where(
          and(
            eq(schema.channels.workspaceId, workspaceId),
            eq(schema.channelMembers.userId, userId),
          ),
        ),
      this.db
        .select({
          channelId: schema.channelMembers.channelId,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.channelMembers)
        .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMembers.channelId))
        .where(eq(schema.channels.workspaceId, workspaceId))
        .groupBy(schema.channelMembers.channelId),
    ]);
    const memberOf = new Set(mem.map((m) => m.channelId));
    const countMap = new Map(counts.map((c) => [c.channelId, c.count]));
    return (
      rows
        // #608: the channel browser never lists hidden channels (group DMs). They
        // surface only under the DM section for their members, via fetch_channels.
        .filter((r) => !r.isHidden)
        .filter((r) => !r.isPrivate || memberOf.has(r.id))
        .map((r) => ({
          id: r.id,
          workspace_id: r.workspaceId,
          name: r.name,
          description: r.description,
          is_private: r.isPrivate ? 1 : 0,
          instructions: r.instructions,
          slash_command_model: r.slashCommandModel ?? null,
          type: r.type,
          is_hidden: r.isHidden ? 1 : 0,
          created_by: r.createdBy,
          created_at: r.createdAt.getTime(),
          is_member: memberOf.has(r.id),
          member_count: countMap.get(r.id) ?? 0,
        }))
    );
  }

  // ─── Channels ────────────────────────────────────────────────────

  async createChannel(
    id: string,
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
  ): Promise<void> {
    await this.db.insert(schema.channels).values({
      id,
      workspaceId,
      name,
      createdBy,
      description: opts?.description ?? null,
      isPrivate: opts?.isPrivate ?? false,
      instructions: opts?.instructions ?? null,
      type: opts?.type ?? "regular",
      isHidden: opts?.isHidden ?? false,
    });
    await this.db
      .insert(schema.channelMembers)
      .values({ channelId: id, userId: createdBy, role: "admin" })
      .onConflictDoNothing();
    // P2 #3: record the creator as a real channel admin in channel_roles, the
    // authority table that replaces the createdBy === me heuristic.
    await this.db
      .insert(schema.channelRoles)
      .values({ channelId: id, userId: createdBy, role: "admin" })
      .onConflictDoNothing();
  }

  // #608: create a group-DM channel + ALL its members in ONE transaction. A group
  // DM is a channel with type='group_dm', is_hidden=true, is_private=true that
  // reuses the entire channel pipeline (threads/unread/reads). Membership is set
  // at creation only (no add-after-create in v1). The creator is the admin; each
  // participant is a plain member. Atomic so a half-created group DM (channel with
  // no members, or missing a participant) can never be observed.
  async createGroupDm(args: {
    id: string;
    workspaceId: string;
    name: string;
    createdBy: string;
    participantIds: string[];
  }): Promise<void> {
    const { id, workspaceId, name, createdBy, participantIds } = args;
    // De-dupe + drop the creator from the participant list (the creator is added
    // separately as admin) so a caller passing themselves can't trip the
    // one-member-per-channel unique constraint.
    const others = [...new Set(participantIds)].filter((p) => p !== createdBy);
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.channels).values({
        id,
        workspaceId,
        name,
        createdBy,
        isPrivate: true,
        isHidden: true,
        type: "group_dm",
      });
      await tx
        .insert(schema.channelMembers)
        .values([
          { channelId: id, userId: createdBy, role: "admin" },
          ...others.map((userId) => ({ channelId: id, userId, role: "member" })),
        ])
        .onConflictDoNothing();
      await tx
        .insert(schema.channelRoles)
        .values({ channelId: id, userId: createdBy, role: "admin" })
        .onConflictDoNothing();
    });
  }

  async getChannels(workspaceId: string): Promise<StoredChannel[]> {
    const rows = await this.db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.workspaceId, workspaceId), isNull(schema.channels.deletedAt)));

    return rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspaceId,
      name: r.name,
      description: r.description,
      is_private: r.isPrivate ? 1 : 0,
      instructions: r.instructions,
      slash_command_model: r.slashCommandModel ?? null,
      type: r.type,
      is_hidden: r.isHidden ? 1 : 0,
      created_by: r.createdBy,
      created_at: r.createdAt.getTime(),
      is_archived: r.isArchived ? 1 : 0,
      auto_tasks_enabled: boolToInt(r.autoTasksEnabled),
    }));
  }

  async getChannel(channelId: string): Promise<StoredChannel | null> {
    const [row] = await this.db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.id, channelId), isNull(schema.channels.deletedAt)))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      workspace_id: row.workspaceId,
      name: row.name,
      description: row.description,
      is_private: row.isPrivate ? 1 : 0,
      instructions: row.instructions,
      slash_command_model: row.slashCommandModel ?? null,
      type: row.type,
      is_hidden: row.isHidden ? 1 : 0,
      created_by: row.createdBy,
      created_at: row.createdAt.getTime(),
      is_archived: row.isArchived ? 1 : 0,
      auto_tasks_enabled: boolToInt(row.autoTasksEnabled),
    };
  }

  // Tasks Phase 2 — read the per-channel auto-tasks watcher switch directly.
  // OPT-IN (default OFF): a channel watches ONLY when auto_tasks_enabled is
  // explicitly true (NULL/missing/false => OFF), matching the column contract in
  // schema.ts. Cheap single-column read used by the watcher gate before any chain
  // resolution / LLM spawn (internal docs). Opt-in is the safety brake against
  // a cybo acting autonomously in a channel nobody turned the watcher on for.
  async getChannelAutoTasksEnabled(channelId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ v: schema.channels.autoTasksEnabled })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1);
    return row?.v === true;
  }

  // Setter for the per-channel auto-tasks opt-in switch. Returns true when a row
  // was updated (channel exists). Mirrored synchronously in SQLite via
  // DualStorage.setChannelAutoTasksEnabled.
  async setChannelAutoTasksEnabled(channelId: string, enabled: boolean): Promise<boolean> {
    const result = await this.db
      .update(schema.channels)
      .set({ autoTasksEnabled: enabled })
      .where(eq(schema.channels.id, channelId));
    return (result.rowCount ?? 0) > 0;
  }

  // Slack model: the sidebar shows only channels the user is a MEMBER of
  // (public or private). Browsing/joining other public channels goes through
  // getChannelsWithMembership + add_channel_member (self-join).
  async getChannelsForUser(workspaceId: string, userId: string): Promise<StoredChannel[]> {
    const rows = await this.db
      .select()
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.workspaceId, workspaceId),
          isNull(schema.channels.deletedAt),
          // P2 #3: archived channels are excluded from the active list (their
          // history is still reachable via direct fetch / unarchive).
          eq(schema.channels.isArchived, false),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(schema.channelMembers)
              .where(
                and(
                  eq(schema.channelMembers.channelId, schema.channels.id),
                  eq(schema.channelMembers.userId, userId),
                ),
              ),
          ),
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspaceId,
      name: r.name,
      description: r.description,
      is_private: r.isPrivate ? 1 : 0,
      instructions: r.instructions,
      slash_command_model: r.slashCommandModel ?? null,
      type: r.type,
      is_hidden: r.isHidden ? 1 : 0,
      created_by: r.createdBy,
      created_at: r.createdAt.getTime(),
      is_archived: r.isArchived ? 1 : 0,
    }));
  }

  async updateChannel(
    channelId: string,
    updates: {
      name?: string;
      description?: string | null;
      isPrivate?: boolean;
      instructions?: string | null;
      slashCommandModel?: string | null;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.description !== undefined) set.description = updates.description;
    if (updates.isPrivate !== undefined) set.isPrivate = updates.isPrivate;
    if (updates.instructions !== undefined) set.instructions = updates.instructions;
    if (updates.slashCommandModel !== undefined) set.slashCommandModel = updates.slashCommandModel;
    if (Object.keys(set).length === 0) return;
    await this.db.update(schema.channels).set(set).where(eq(schema.channels.id, channelId));
  }

  async softDeleteChannel(channelId: string): Promise<boolean> {
    const result = await this.db
      .update(schema.channels)
      .set({ deletedAt: new Date() })
      .where(eq(schema.channels.id, channelId));
    return (result.rowCount ?? 0) > 0;
  }

  // P2 #3: archive (soft-delete) vs softDeleteChannel (hard delete via
  // deletedAt). Reversible — pass archived=false to restore.
  async setChannelArchived(channelId: string, archived: boolean): Promise<boolean> {
    const result = await this.db
      .update(schema.channels)
      .set({ isArchived: archived })
      .where(eq(schema.channels.id, channelId));
    return (result.rowCount ?? 0) > 0;
  }

  // P2 #3: a user's real per-channel role from channel_roles, falling back to
  // channel_members.role for legacy rows created before channel_roles existed
  // (and not yet backfilled). Returns "admin" | "member" | null.
  async getChannelRole(channelId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ role: schema.channelRoles.role })
      .from(schema.channelRoles)
      .where(
        and(eq(schema.channelRoles.channelId, channelId), eq(schema.channelRoles.userId, userId)),
      )
      .limit(1);
    if (row) return row.role;
    return this.getChannelMemberRole(channelId, userId);
  }

  async setChannelRole(channelId: string, userId: string, role: string): Promise<void> {
    await this.db
      .insert(schema.channelRoles)
      .values({ channelId, userId, role })
      .onConflictDoUpdate({
        target: [schema.channelRoles.channelId, schema.channelRoles.userId],
        set: { role },
      });
  }

  // P2 #4: lightweight count of messages-with-attachments in a channel, for the
  // Files tab badge. Counts MESSAGES (matching the SharedFilesPanel's row
  // grouping), not individual attachments — a multi-attachment message is one
  // file-bearing message.
  async getChannelFileCount(channelId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelId, channelId),
          isNull(schema.messages.deletedAt),
          isNotNull(schema.messages.attachments),
          // Guard jsonb_array_length: it throws if attachments is ever a non-array
          // JSONB value (object/scalar). In practice it's array-or-null, but the
          // typeof check makes the count query crash-proof against bad rows.
          sql`jsonb_typeof(${schema.messages.attachments}) = 'array'`,
          sql`jsonb_array_length(${schema.messages.attachments}) > 0`,
        ),
      );
    return row?.count ?? 0;
  }

  // ─── Channel Members ─────────────────────────────────────────────

  async addChannelMember(channelId: string, userId: string, role = "member"): Promise<void> {
    await this.db
      .insert(schema.channelMembers)
      .values({ channelId, userId, role })
      .onConflictDoNothing();
  }

  async removeChannelMember(channelId: string, userId: string): Promise<void> {
    await this.db
      .delete(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.userId, userId),
        ),
      );
  }

  async getChannelMembers(channelId: string): Promise<
    Array<{
      userId: string;
      email: string;
      name: string | null;
      role: string;
      joinedAt: number;
    }>
  > {
    const rows = await this.db
      .select({
        userId: schema.channelMembers.userId,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.channelMembers.role,
        joinedAt: schema.channelMembers.joinedAt,
      })
      .from(schema.channelMembers)
      .innerJoin(schema.users, eq(schema.users.id, schema.channelMembers.userId))
      .where(eq(schema.channelMembers.channelId, channelId));

    return rows.map((r) => ({
      // user_id is nullable since cybo rows exist, but the innerJoin on users.id
      // guarantees a non-null user_id for every returned (human) row.
      userId: r.userId as string,
      email: r.email,
      name: r.name,
      role: r.role,
      joinedAt: r.joinedAt.getTime(),
    }));
  }

  async getChannelMemberRole(channelId: string, userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ role: schema.channelMembers.role })
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.userId, userId),
        ),
      )
      .limit(1);
    return row?.role ?? null;
  }

  // ─── Messages ────────────────────────────────────────────────────

  async insertMessage(msg: {
    id: string;
    workspaceId: string;
    channelId?: string | null;
    fromId: string;
    fromType: "human" | "agent" | "system";
    fromName?: string | null;
    toId?: string | null;
    text: string;
    mentions?: string[] | null;
    parentId?: string | null;
    attachments?: unknown[] | null;
    source?: string | null;
    card?: MessageCard | null;
    seq: number;
    createdAt: number;
  }): Promise<void> {
    await this.db
      .insert(schema.messages)
      .values({
        id: msg.id,
        workspaceId: msg.workspaceId,
        channelId: msg.channelId ?? null,
        fromId: msg.fromId,
        fromType: msg.fromType,
        fromName: msg.fromName ?? null,
        toId: msg.toId ?? null,
        text: msg.text,
        mentions: msg.mentions ?? null,
        parentId: msg.parentId ?? null,
        attachments: (msg.attachments as typeof schema.messages.$inferInsert.attachments) ?? null,
        source: msg.source ?? null,
        card: msg.card ?? null,
        seq: msg.seq,
        createdAt: new Date(msg.createdAt),
      })
      .onConflictDoNothing();
  }

  async getMessages(opts: {
    channelId: string;
    before?: string;
    limit?: number;
  }): Promise<StoredMessage[]> {
    const limit = opts.limit ?? 50;

    const notDeleted = isNull(schema.messages.deletedAt);
    // Collapsed threads (Mattermost CRT): the channel timeline shows ROOT
    // messages only; replies live in the thread panel. Without this, replies
    // reappeared inline in the channel on reload.
    const topLevel = isNull(schema.messages.parentId);

    // Order by createdAt, not seq: seq is a per-relay-instance counter that
    // resets on restart, so it isn't chronologically monotonic. createdAt is the
    // wall-clock truth for display order. (seq stays the key for sync deltas.)
    let query = this.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.channelId, opts.channelId), notDeleted, topLevel))
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.seq))
      .limit(limit);

    if (opts.before) {
      const [ref] = await this.db
        .select({ createdAt: schema.messages.createdAt, seq: schema.messages.seq })
        .from(schema.messages)
        .where(eq(schema.messages.id, opts.before));
      if (ref) {
        // Composite (createdAt, seq) cursor: a plain `createdAt <` would skip
        // every sibling sharing the cursor's millisecond.
        query = this.db
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.channelId, opts.channelId),
              or(
                lt(schema.messages.createdAt, ref.createdAt),
                and(eq(schema.messages.createdAt, ref.createdAt), lt(schema.messages.seq, ref.seq)),
              ),
              notDeleted,
              topLevel,
            ),
          )
          .orderBy(desc(schema.messages.createdAt), desc(schema.messages.seq))
          .limit(limit);
      }
    }

    const rows = await query;
    return rows.toReversed().map(this.mapMessage);
  }

  async getMessagesSince(
    workspaceId: string,
    sinceSeq: number,
    limit = 500,
  ): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, workspaceId),
          gt(schema.messages.seq, sinceSeq),
          isNull(schema.messages.deletedAt),
        ),
      )
      .orderBy(schema.messages.seq)
      .limit(limit);

    return rows.map(this.mapMessage);
  }

  // Highest persisted seq per workspace — used to re-seed the relay's in-memory
  // seq counter on startup so it stays monotonic across restarts (otherwise
  // sync deltas via getMessagesSince miss everything sent after a restart).
  async getMaxSeqByWorkspace(): Promise<Array<{ workspaceId: string; maxSeq: number }>> {
    const rows = await this.db
      .select({
        workspaceId: schema.messages.workspaceId,
        maxSeq: sql<number>`COALESCE(MAX(${schema.messages.seq}), 0)`,
      })
      .from(schema.messages)
      .groupBy(schema.messages.workspaceId);
    return rows.map((r) => ({ workspaceId: r.workspaceId, maxSeq: Number(r.maxSeq) }));
  }

  // Recent workspace activity SCOPED to what `userId` is allowed to see: messages
  // in channels they're a member of, plus DMs they're party to. Without the scope
  // this returned every message in the workspace — including DMs between OTHER
  // users — which leaked private conversations into the Home "Recent Activity"
  // widget and the Logs pane. Mirrors the access model of getMessages/getDmMessages.
  async getRecentActivity(
    workspaceId: string,
    userId: string,
    limit = 200,
  ): Promise<StoredMessage[]> {
    const channels = await this.getChannelsForUser(workspaceId, userId);
    const channelIds = channels.map((c) => c.id);
    const visibility = or(
      channelIds.length > 0 ? inArray(schema.messages.channelId, channelIds) : sql`false`,
      and(
        isNull(schema.messages.channelId),
        or(eq(schema.messages.fromId, userId), eq(schema.messages.toId, userId)),
      ),
    );
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, workspaceId),
          isNull(schema.messages.deletedAt),
          visibility,
        ),
      )
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.seq))
      .limit(limit);

    return rows.toReversed().map(this.mapMessage);
  }

  async getDmMessages(opts: {
    workspaceId: string;
    userId: string;
    peerId: string;
    before?: string;
    limit?: number;
  }): Promise<StoredMessage[]> {
    const limit = opts.limit ?? 50;

    const baseCondition = and(
      eq(schema.messages.workspaceId, opts.workspaceId),
      isNull(schema.messages.deletedAt),
      sql`${schema.messages.channelId} IS NULL`,
      // Collapsed threads (CRT) parity with getMessages: the DM timeline shows
      // ROOT messages only; replies live in the thread panel. Without this, DM
      // thread replies reappeared inline in the conversation on reload.
      isNull(schema.messages.parentId),
      sql`(
        (${schema.messages.fromId} = ${opts.userId} AND ${schema.messages.toId} = ${opts.peerId})
        OR (${schema.messages.fromId} = ${opts.peerId} AND ${schema.messages.toId} = ${opts.userId})
        OR (${schema.messages.fromId} = ${opts.peerId} AND ${schema.messages.toId} IS NULL)
      )`,
    );

    if (opts.before) {
      const [ref] = await this.db
        .select({ createdAt: schema.messages.createdAt, seq: schema.messages.seq })
        .from(schema.messages)
        .where(eq(schema.messages.id, opts.before));
      if (ref) {
        const rows = await this.db
          .select()
          .from(schema.messages)
          .where(
            and(
              baseCondition,
              // Composite (createdAt, seq) cursor — mirrors getMessages. A plain
              // `createdAt <` skips every sibling sharing the cursor's millisecond,
              // which is exactly what chunked agent messages (many rows, same ms)
              // hit, dropping turns on scroll-up.
              or(
                lt(schema.messages.createdAt, ref.createdAt),
                and(eq(schema.messages.createdAt, ref.createdAt), lt(schema.messages.seq, ref.seq)),
              ),
            ),
          )
          .orderBy(desc(schema.messages.createdAt), desc(schema.messages.seq))
          .limit(limit);
        return rows.toReversed().map(this.mapMessage);
      }
    }

    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(baseCondition!)
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.seq))
      .limit(limit);
    return rows.toReversed().map(this.mapMessage);
  }

  // Seq-cursored DM catch-up (#500): all DM root messages between `userId` and
  // `peerId` with seq > sinceSeq, ASCENDING, paginated. Mirrors getMessagesSince
  // (the channel drain) but scoped to one DM pair. The blind "refetch latest 50"
  // reconnect path silently lost everything older than the 50 newest when >50 DM
  // messages arrived during a long disconnect; draining from the conversation's
  // last-known seq closes that hole. Same DM-pair predicate as getDmMessages.
  async getDmMessagesSince(opts: {
    workspaceId: string;
    userId: string;
    peerId: string;
    sinceSeq: number;
    limit?: number;
  }): Promise<StoredMessage[]> {
    const limit = opts.limit ?? 200;
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.workspaceId, opts.workspaceId),
          isNull(schema.messages.deletedAt),
          isNull(schema.messages.channelId),
          // Roots only — replies live in the thread panel (parity with getDmMessages).
          isNull(schema.messages.parentId),
          gt(schema.messages.seq, opts.sinceSeq),
          // DM-pair predicate via Drizzle builders (type-safe). Same shape as
          // getDmMessages: messages either direction between the two users, plus
          // agent DMs from the peer (toId NULL).
          or(
            and(eq(schema.messages.fromId, opts.userId), eq(schema.messages.toId, opts.peerId)),
            and(eq(schema.messages.fromId, opts.peerId), eq(schema.messages.toId, opts.userId)),
            and(eq(schema.messages.fromId, opts.peerId), isNull(schema.messages.toId)),
          ),
        ),
      )
      .orderBy(schema.messages.seq)
      .limit(limit);
    return rows.map(this.mapMessage);
  }

  // ─── Shared Files (M-files) ──────────────────────────────────────
  //
  // List messages that carry at least one attachment, newest-first, with a
  // composite (createdAt, seq) cursor — same pagination contract as
  // getMessages/getDmMessages. The relay handler flattens each row's
  // `attachments` array into per-file entries and signs the URLs, so these
  // methods deliberately return the RAW attachments column untouched. No
  // migration: we query the existing `messages.attachments` jsonb.
  //
  // `senderName` is resolved here (COALESCE from_name → user name → email) so
  // the relay doesn't need a second round-trip per row.

  private fileRowSelect() {
    return {
      messageId: schema.messages.id,
      createdAt: schema.messages.createdAt,
      seq: schema.messages.seq,
      fromName: schema.messages.fromName,
      userName: schema.users.name,
      userEmail: schema.users.email,
      attachments: schema.messages.attachments,
    };
  }

  // Resolve the (createdAt, seq) cursor anchor for a `before` message id.
  private async fileCursorRef(before: string): Promise<{ createdAt: Date; seq: number } | null> {
    const [ref] = await this.db
      .select({ createdAt: schema.messages.createdAt, seq: schema.messages.seq })
      .from(schema.messages)
      .where(eq(schema.messages.id, before));
    return ref ?? null;
  }

  async getChannelFiles(opts: { channelId: string; before?: string; limit?: number }): Promise<
    Array<{
      messageId: string;
      createdAt: number;
      senderName: string;
      attachments: unknown;
    }>
  > {
    const limit = opts.limit ?? 25;
    const hasAttachments = sql`jsonb_array_length(${schema.messages.attachments}) > 0`;
    const base = and(
      eq(schema.messages.channelId, opts.channelId),
      isNull(schema.messages.deletedAt),
      isNotNull(schema.messages.attachments),
      hasAttachments,
    );

    let where = base;
    if (opts.before) {
      const ref = await this.fileCursorRef(opts.before);
      if (ref) {
        where = and(
          base,
          or(
            lt(schema.messages.createdAt, ref.createdAt),
            and(eq(schema.messages.createdAt, ref.createdAt), lt(schema.messages.seq, ref.seq)),
          ),
        );
      }
    }

    const rows = await this.db
      .select(this.fileRowSelect())
      .from(schema.messages)
      .leftJoin(schema.users, eq(schema.users.id, schema.messages.fromId))
      .where(where)
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.seq))
      .limit(limit);

    return rows.map((r) => ({
      messageId: r.messageId,
      createdAt: r.createdAt.getTime(),
      senderName: r.fromName ?? r.userName ?? r.userEmail ?? "Unknown",
      attachments: r.attachments,
    }));
  }

  async getDmFiles(opts: {
    workspaceId: string;
    userId: string;
    peerId: string;
    before?: string;
    limit?: number;
  }): Promise<
    Array<{
      messageId: string;
      createdAt: number;
      senderName: string;
      attachments: unknown;
    }>
  > {
    const limit = opts.limit ?? 25;
    const hasAttachments = sql`jsonb_array_length(${schema.messages.attachments}) > 0`;
    // Same DM-pair predicate as getDmMessages (1:1 thread, channelId IS NULL).
    const base = and(
      eq(schema.messages.workspaceId, opts.workspaceId),
      isNull(schema.messages.deletedAt),
      sql`${schema.messages.channelId} IS NULL`,
      sql`(
        (${schema.messages.fromId} = ${opts.userId} AND ${schema.messages.toId} = ${opts.peerId})
        OR (${schema.messages.fromId} = ${opts.peerId} AND ${schema.messages.toId} = ${opts.userId})
        OR (${schema.messages.fromId} = ${opts.peerId} AND ${schema.messages.toId} IS NULL)
      )`,
      isNotNull(schema.messages.attachments),
      hasAttachments,
    );

    let where = base;
    if (opts.before) {
      const ref = await this.fileCursorRef(opts.before);
      if (ref) {
        where = and(
          base,
          or(
            lt(schema.messages.createdAt, ref.createdAt),
            and(eq(schema.messages.createdAt, ref.createdAt), lt(schema.messages.seq, ref.seq)),
          ),
        );
      }
    }

    const rows = await this.db
      .select(this.fileRowSelect())
      .from(schema.messages)
      .leftJoin(schema.users, eq(schema.users.id, schema.messages.fromId))
      .where(where)
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.seq))
      .limit(limit);

    return rows.map((r) => ({
      messageId: r.messageId,
      createdAt: r.createdAt.getTime(),
      senderName: r.fromName ?? r.userName ?? r.userEmail ?? "Unknown",
      attachments: r.attachments,
    }));
  }

  async getMessageById(
    messageId: string,
  ): Promise<{ id: string; fromId: string; workspaceId: string; channelId: string | null } | null> {
    const [row] = await this.db
      .select({
        id: schema.messages.id,
        fromId: schema.messages.fromId,
        workspaceId: schema.messages.workspaceId,
        channelId: schema.messages.channelId,
      })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    return row ?? null;
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    // Soft delete the message AND cascade to its thread replies — deleting a
    // root shouldn't orphan its replies (Mattermost-style tombstone cascade).
    const result = await this.db
      .update(schema.messages)
      .set({ deletedAt: new Date() })
      .where(or(eq(schema.messages.id, messageId), eq(schema.messages.parentId, messageId)));
    return (result.rowCount ?? 0) > 0;
  }

  // ─── Tasks ───────────────────────────────────────────────────────

  async createTask(opts: {
    id: string;
    workspaceId: string;
    title: string;
    createdBy: string;
    description?: string;
    assigneeId?: string;
    dueAt?: number;
    channelId?: string | null;
    priority?: string | null;
    // Tasks Phase 0 — lane ordering, planned start, draft. sortOrder is resolved
    // by the SQLite write (lane tail) and mirrored here so PG carries the same slot.
    sortOrder?: number | null;
    startDate?: number | null;
    isDraft?: boolean;
    // Tasks Redesign P0 — the Tasks-project (defaults to the channel's project, or
    // the workspace Inbox), the sub-task parent, the workflow state (defaults to
    // the project's is_default state), and the single cycle. All optional + back-
    // compat; the legacy `status` column is mirrored from the chosen state.group.
    projectId?: string | null;
    parentId?: string | null;
    stateId?: string | null;
    cycleId?: string | null;
    // Redesign P0 — the denormalized many-to-many sets, mirrored to PG at create
    // so the cloud path carries labels/modules from the start instead of dropping
    // them. moduleIds are already-resolved ids; labelNames are free-text label
    // names (the relay guest path has no name→id resolver) resolved against the
    // task's FINAL project inside this transaction via resolveLabelsTx — so a new
    // label lands in the same project (explicit > channel > Inbox) as the task.
    labelNames?: string[];
    moduleIds?: string[];
    // Require-project opt-in (default false). Mirrors storage.createTask: with NO
    // project/channel/parent context, false → workspace Inbox fallback (the 2nd-
    // workspace MCP server, GitHub sync, internal callers); true → throw "provide
    // projectId or channelId" (the user/cybo-facing handlers set it).
    requireProjectContext?: boolean;
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      // 1. Resolve the effective Tasks-project: explicit > channel's chat-project's
      // tasks_project > the per-workspace Inbox. Extracted so createTask stays under
      // the complexity cap and the wire-id translation lives in one place.
      const projectId = await this.resolveCreateProjectTx(tx, {
        projectId: opts.projectId ?? null,
        channelId: opts.channelId ?? null,
        parentId: opts.parentId ?? null,
        workspaceId: opts.workspaceId,
        requireProjectContext: opts.requireProjectContext ?? false,
      });

      // 2. Allocate the per-project sequence number atomically. The UPDATE ...
      // RETURNING bumps the counter and hands back the new value in one round trip,
      // serialized by the row lock so concurrent creates never collide.
      const [seqRow] = await tx
        .update(schema.tasksProjects)
        .set({ sequenceCounter: sql`${schema.tasksProjects.sequenceCounter} + 1` })
        .where(eq(schema.tasksProjects.id, projectId))
        .returning({ sequenceCounter: schema.tasksProjects.sequenceCounter });
      const sequenceId = seqRow?.sequenceCounter ?? null;

      // 3. Resolve the workflow state: explicit > the project's is_default state.
      let stateId = opts.stateId ?? null;
      if (!stateId) {
        const [def] = await tx
          .select({ id: schema.taskStates.id })
          .from(schema.taskStates)
          .where(
            and(eq(schema.taskStates.projectId, projectId), eq(schema.taskStates.isDefault, true)),
          )
          .limit(1);
        stateId = def?.id ?? null;
      }

      // 4. Mirror the legacy free-text `status` from the chosen state's group so the
      // watcher/back-compat reads keep working. No state → default "pending".
      let status = "pending";
      if (stateId) {
        const [st] = await tx
          .select({ group: schema.taskStates.group })
          .from(schema.taskStates)
          .where(eq(schema.taskStates.id, stateId))
          .limit(1);
        if (st) status = mapStateGroupToStatus(st.group);
      }

      await tx.insert(schema.tasks).values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        title: opts.title,
        createdBy: opts.createdBy,
        description: opts.description ?? null,
        assigneeId: opts.assigneeId ?? null,
        dueAt: opts.dueAt ? new Date(opts.dueAt) : null,
        channelId: opts.channelId ?? null,
        priority: opts.priority ?? null,
        sortOrder: opts.sortOrder ?? null,
        startDate: opts.startDate ? new Date(opts.startDate) : null,
        isDraft: opts.isDraft ?? false,
        status,
        projectId,
        parentId: opts.parentId ?? null,
        stateId,
        sequenceId,
        cycleId: opts.cycleId ?? null,
      });

      // Mirror the denormalized label/module sets when provided (same join tables
      // updateTask replaces). Labels arrive as NAMES → resolve (get-or-create) to
      // ids against the just-resolved project. onConflictDoNothing keeps a
      // duplicate id list safe.
      if (opts.labelNames && opts.labelNames.length > 0) {
        const labelIds = await this.resolveLabelsTx(tx, projectId, opts.labelNames);
        if (labelIds.length > 0) {
          await tx
            .insert(schema.taskLabelAssignees)
            .values(labelIds.map((labelId) => ({ taskId: opts.id, labelId })))
            .onConflictDoNothing();
        }
      }
      if (opts.moduleIds && opts.moduleIds.length > 0) {
        await tx
          .insert(schema.taskModules)
          .values(opts.moduleIds.map((moduleId) => ({ taskId: opts.id, moduleId })))
          .onConflictDoNothing();
      }
    });
  }

  // Tasks Redesign — append a row to the per-task Activity feed (the `task_activity`
  // table read by the work-item Activity pane). One row per change: verb 'created'
  // on task creation, verb 'updated' for a field edit (field/oldValue/newValue
  // describe what moved). `actorId` is who made the change — a cybo id for an
  // agent-driven create/update, a human userId for a UI edit, or null for system
  // activity. `epoch` is the fractional ms sort key the feed orders by. Best-effort:
  // a feed-write failure must never fail the underlying task mutation, so callers
  // wrap this in their own try/catch — back-compat with pre-feed task writes.
  async recordTaskActivity(opts: {
    taskId: string;
    workspaceId: string;
    actorId?: string | null;
    verb: "created" | "updated";
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    commentHtml?: string | null;
    epoch?: number;
  }): Promise<void> {
    await this.db.insert(schema.taskActivity).values({
      id: `tact_${randomUUID()}`,
      taskId: opts.taskId,
      workspaceId: opts.workspaceId,
      actorId: opts.actorId ?? null,
      verb: opts.verb,
      field: opts.field ?? null,
      oldValue: opts.oldValue ?? null,
      newValue: opts.newValue ?? null,
      commentHtml: opts.commentHtml ?? null,
      epoch: opts.epoch ?? Date.now(),
    });
  }

  async getTasks(
    workspaceId: string,
    filter?: {
      status?: string;
      assigneeId?: string;
      limit?: number;
      cursor?: string;
      userId?: string;
      // Tasks Redesign — scope to a single Tasks-project. This is the RESOLVED
      // tasks_projects.id ("tp_…"), not a wire/chat id (the relay resolves +
      // visibility-gates the wire id before filtering). Omitted → no project filter.
      projectId?: string;
    },
  ): Promise<StoredTask[]> {
    return (await this.getTasksPage(workspaceId, filter)).tasks;
  }

  // Redesign P0 — project-visibility predicate for the task-list reads. When a
  // `userId` is supplied the page is scoped to tasks whose project the user may
  // see: project_id IS NULL (no Tasks-project to gate — legacy/unassigned tasks)
  // OR project_id IN (the user's visible tasks_projects, same predicate as
  // visibleProjectIds). Composed as a correlated IN-subquery so it stays a single
  // round-trip and reuses the canonical visibilityCondition. Internal/system
  // callers (watcher, dispatch) pass no userId and get the unscoped set.
  private taskVisibilityCondition(workspaceId: string, userId: string) {
    return or(
      isNull(schema.tasks.projectId),
      inArray(
        schema.tasks.projectId,
        this.db
          .select({ id: schema.tasksProjects.id })
          .from(schema.tasksProjects)
          .where(
            and(
              eq(schema.tasksProjects.workspaceId, workspaceId),
              this.visibilityCondition(workspaceId, userId),
            ),
          ),
      ),
    );
  }

  // Phase 0 — paginated, STABLE-ordered read (sort_order NULLS LAST, then
  // created_at, then id), mirroring the SQLite getTasksPage so the opaque cursor
  // is interchangeable between deployment modes. `limit` caps the page; the keyset
  // predicate resumes strictly after the cursor's order tuple.
  //
  // Redesign P0 — when `filter.userId` is set the page is project-scoped to what
  // that user may see (taskVisibilityCondition) so a caller never receives a task
  // in a project they can't see. Omitting userId keeps the back-compat unscoped
  // path for internal/system callers (watcher, dispatch).
  async getTasksPage(
    workspaceId: string,
    filter?: {
      status?: string;
      assigneeId?: string;
      limit?: number;
      cursor?: string;
      userId?: string;
      // Tasks Redesign — scope to a single Tasks-project. RESOLVED tasks_projects.id
      // ("tp_…"), not a wire/chat id (the relay resolves + visibility-gates first).
      projectId?: string;
    },
  ): Promise<{ tasks: StoredTask[]; nextCursor: string | null }> {
    const conditions = [eq(schema.tasks.workspaceId, workspaceId)];
    if (filter?.status) conditions.push(eq(schema.tasks.status, filter.status));
    if (filter?.assigneeId) conditions.push(eq(schema.tasks.assigneeId, filter.assigneeId));
    if (filter?.projectId) conditions.push(eq(schema.tasks.projectId, filter.projectId));
    if (filter?.userId) conditions.push(this.taskVisibilityCondition(workspaceId, filter.userId)!);

    // Keyset from the opaque cursor. Order key tuple: (sortNull, sort_order,
    // created_at, id) ASC where sortNull = (sort_order IS NULL) (so NULLs sort
    // last). The predicate is the lexicographic "strictly after" of that tuple.
    const cur = decodeTaskCursor(filter?.cursor);
    if (cur) {
      const sortNullExpr = sql`(${schema.tasks.sortOrder} IS NULL)`;
      const curCreatedAt = new Date(cur.createdAt);
      if (cur.sortOrder === null) {
        // Cursor row is in the NULL group (last group). Only later NULL-group rows
        // (same sortNull=true) with a greater (created_at,id) remain.
        conditions.push(
          and(
            sql`${sortNullExpr} = TRUE`,
            or(
              gt(schema.tasks.createdAt, curCreatedAt),
              and(eq(schema.tasks.createdAt, curCreatedAt), gt(schema.tasks.id, cur.id)),
            ),
          )!,
        );
      } else {
        // Cursor row is in the non-NULL group. Remaining rows are either any NULL
        // row (sortNull=true > false) OR a non-NULL row strictly after the tuple.
        conditions.push(
          or(
            sql`${sortNullExpr} = TRUE`,
            and(
              sql`${sortNullExpr} = FALSE`,
              or(
                gt(schema.tasks.sortOrder, cur.sortOrder),
                and(
                  eq(schema.tasks.sortOrder, cur.sortOrder),
                  or(
                    gt(schema.tasks.createdAt, curCreatedAt),
                    and(eq(schema.tasks.createdAt, curCreatedAt), gt(schema.tasks.id, cur.id)),
                  ),
                ),
              ),
            ),
          )!,
        );
      }
    }

    const limit = filter?.limit;
    const base = this.db
      .select()
      .from(schema.tasks)
      .where(and(...conditions))
      .orderBy(
        sql`(${schema.tasks.sortOrder} IS NULL) ASC`,
        asc(schema.tasks.sortOrder),
        asc(schema.tasks.createdAt),
        asc(schema.tasks.id),
      );
    // Fetch one extra to detect a further page without a count query.
    const rows = limit !== undefined && limit > 0 ? await base.limit(limit + 1) : await base;

    if (limit !== undefined && limit > 0 && rows.length > limit) {
      const page = await this.mapTaskRowsWithSatellites(rows.slice(0, limit));
      const lastRow = rows[limit - 1];
      return {
        tasks: page,
        nextCursor: encodeTaskCursor({
          sort_order: lastRow.sortOrder,
          created_at: lastRow.createdAt.getTime(),
          id: lastRow.id,
        }),
      };
    }
    return { tasks: await this.mapTaskRowsWithSatellites(rows), nextCursor: null };
  }

  // Phase 0 — drag-reorder in PG (cloud path). Reads the named neighbours, computes
  // a sort_order between them with the shared math, persists. Returns the updated
  // StoredTask, or undefined if the task is missing.
  async reorderTask(
    taskId: string,
    opts: { beforeId?: string; afterId?: string },
  ): Promise<StoredTask | undefined> {
    const [task] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (!task) return undefined;
    const neighbourIds = [opts.beforeId, opts.afterId].filter((v): v is string => !!v);
    const neighbours =
      neighbourIds.length > 0
        ? await this.db.select().from(schema.tasks).where(inArray(schema.tasks.id, neighbourIds))
        : [];
    const before = neighbours.find((n) => n.id === opts.beforeId);
    const after = neighbours.find((n) => n.id === opts.afterId);
    // Lane tail = MAX(sort_order)+1 in the task's (workspace, status) lane.
    const [tailRow] = await this.db
      .select({ maxSort: sql<number | null>`MAX(${schema.tasks.sortOrder})` })
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.workspaceId, task.workspaceId), eq(schema.tasks.status, task.status)),
      );
    const tailSort = (tailRow?.maxSort ?? -1) + 1;
    const newSort = computeReorderSort({
      beforeSort: before?.sortOrder ?? null,
      afterSort: after?.sortOrder ?? null,
      tailSort,
    });
    await this.db
      .update(schema.tasks)
      .set({ sortOrder: newSort, updatedAt: new Date() })
      .where(eq(schema.tasks.id, taskId));
    const [updated] = await this.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    if (!updated) return undefined;
    const { labels, modules } = await this.loadTaskSatelliteIds([updated.id]);
    const chatProjectIds = await this.loadChatProjectIds([updated.projectId]);
    return this.mapTaskRow(updated, {
      labelIds: labels.get(updated.id),
      moduleIds: modules.get(updated.id),
      chatProjectId: updated.projectId ? (chatProjectIds.get(updated.projectId) ?? null) : null,
    });
  }

  // Phase 0 — hard delete a task by id. Idempotent (no-op if already gone).
  async deleteTask(taskId: string): Promise<void> {
    await this.db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
  }

  // Shared row → StoredTask mapper for tasks reads (getTasks, getDueTasks,
  // getOwnedOpenTasks) so the new Phase 2/3 + Redesign P0 columns are surfaced
  // consistently. `extra` carries the denormalized many-to-many arrays (label ids
  // via task_label_assignees, module ids via task_modules) plus the OUTBOUND
  // project id; read paths that join them in pass them here, the rest default to
  // empty so the shape stays stable.
  //
  // OUTBOUND project_id translation: the stored tasks.project_id is the
  // tasks_projects.id ("tp_…"), an id internal to the Tasks domain. The UI's whole
  // world keys off the CHAT project id (route /tasks/[projectId], fetch_projects,
  // the board filter t.projectId === <chat id>). So the mapped projection exposes
  // project_id = the JOINed tasks_projects.chat_project_id (the chat id), passed in
  // via extra.chatProjectId. An Inbox/orphan tasks_project (chat_project_id null)
  // → project_id null: those tasks aren't under a chat project, which is correct.
  // The internal tasks.project_id column (the tp_ id) is unchanged in storage; only
  // this mapped shape carries the chat id.
  private mapTaskRow(
    r: typeof schema.tasks.$inferSelect,
    extra?: { labelIds?: string[]; moduleIds?: string[]; chatProjectId?: string | null },
  ): StoredTask {
    return {
      id: r.id,
      workspace_id: r.workspaceId,
      title: r.title,
      description: r.description,
      status: r.status,
      assignee_id: r.assigneeId,
      created_by: r.createdBy,
      due_at: r.dueAt?.getTime() ?? null,
      recurrence: r.recurrence,
      result: r.result,
      channel_id: r.channelId,
      priority: r.priority,
      last_dispatched_at: r.lastDispatchedAt?.getTime() ?? null,
      recurrence_spawned_at: r.recurrenceSpawnedAt?.getTime() ?? null,
      recurrence_count: r.recurrenceCount,
      // Phase 0 — lane ordering, planned start, soft-archive, draft.
      sort_order: r.sortOrder ?? null,
      start_date: r.startDate?.getTime() ?? null,
      archived_at: r.archivedAt?.getTime() ?? null,
      is_draft: r.isDraft ? 1 : 0,
      // Redesign P0 — Tasks-project, sub-task parent, workflow state, per-project
      // sequence number, single cycle, and the denormalized label/module id arrays.
      // project_id is the OUTBOUND chat project id (from the joined
      // tasks_projects.chat_project_id), NOT the raw tp_ tasks_projects.id, so the
      // UI sees the same id everywhere. Null for an Inbox/orphan project.
      project_id: extra?.chatProjectId ?? null,
      parent_id: r.parentId ?? null,
      state_id: r.stateId ?? null,
      sequence_id: r.sequenceId ?? null,
      cycle_id: r.cycleId ?? null,
      label_ids: extra?.labelIds ?? [],
      module_ids: extra?.moduleIds ?? [],
      created_at: r.createdAt.getTime(),
      updated_at: r.updatedAt.getTime(),
    };
  }

  // Batch-load the denormalized label/module id arrays for a set of task ids in
  // two grouped queries (no N+1), returned as per-task maps. Used by read paths
  // that surface a task projection (getTasksPage, getDueTasks, getOwnedOpenTasks,
  // reorderTask) so each StoredTask carries its labels + modules.
  private async loadTaskSatelliteIds(
    taskIds: readonly string[],
  ): Promise<{ labels: Map<string, string[]>; modules: Map<string, string[]> }> {
    const labels = new Map<string, string[]>();
    const modules = new Map<string, string[]>();
    if (taskIds.length === 0) return { labels, modules };
    const ids = [...taskIds];
    const [labelRows, moduleRows] = await Promise.all([
      this.db
        .select({
          taskId: schema.taskLabelAssignees.taskId,
          labelId: schema.taskLabelAssignees.labelId,
        })
        .from(schema.taskLabelAssignees)
        .where(inArray(schema.taskLabelAssignees.taskId, ids)),
      this.db
        .select({
          taskId: schema.taskModules.taskId,
          moduleId: schema.taskModules.moduleId,
        })
        .from(schema.taskModules)
        .where(inArray(schema.taskModules.taskId, ids)),
    ]);
    for (const row of labelRows) {
      const list = labels.get(row.taskId);
      if (list) list.push(row.labelId);
      else labels.set(row.taskId, [row.labelId]);
    }
    for (const row of moduleRows) {
      const list = modules.get(row.taskId);
      if (list) list.push(row.moduleId);
      else modules.set(row.taskId, [row.moduleId]);
    }
    return { labels, modules };
  }

  // OUTBOUND project_id translation — batch-resolve a set of tasks_projects.id
  // ("tp_…") to each one's chat_project_id (the chat id the UI keys off). Returned
  // as a tpId → chatId|null map; a tasks_project with no chat project (the Inbox)
  // maps to null. A null/empty input set is skipped. Used by the task read paths so
  // each mapped StoredTask exposes the chat id, not the internal tp_ id.
  private async loadChatProjectIds(
    taskProjectIds: readonly (string | null)[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const ids = [...new Set(taskProjectIds.filter((v): v is string => !!v))];
    if (ids.length === 0) return out;
    const rows = await this.db
      .select({ id: schema.tasksProjects.id, chatProjectId: schema.tasksProjects.chatProjectId })
      .from(schema.tasksProjects)
      .where(inArray(schema.tasksProjects.id, ids));
    for (const row of rows) out.set(row.id, row.chatProjectId ?? null);
    return out;
  }

  // Resolve a list of label NAMES to label ids within a project's task_labels
  // catalog, creating any that don't yet exist (idempotent get-or-create). The
  // relay guest path carries labels as free-text names (there is no name→id
  // resolver on that side), so this is where a name first becomes a row. Matching
  // is case-insensitive on the trimmed name; blank entries are skipped; the
  // returned ids preserve the input order and dedupe. New labels get a neutral
  // slate pill color and are appended at the tail of the project's sort order.
  async resolveLabels(projectId: string, names: readonly string[]): Promise<string[]> {
    return this.db.transaction((tx) => this.resolveLabelsTx(tx, projectId, names));
  }

  // Transaction-bound core of resolveLabels, so createTask can resolve label names
  // against its just-resolved project inside the SAME transaction as the insert.
  private async resolveLabelsTx(
    tx: PgTx,
    projectId: string,
    names: readonly string[],
  ): Promise<string[]> {
    const wanted: string[] = [];
    const seenKeys = new Set<string>();
    for (const raw of names) {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      wanted.push(trimmed);
    }
    if (wanted.length === 0) return [];

    // The project anchor may arrive as a WIRE id (the relay update path passes the
    // task's destination chat project id); translate it to the tasks_projects.id so
    // labels anchor to the SAME project the task lands in instead of resolving to []
    // (a chat id never matches tasks_projects.id and would silently drop labels). A
    // "tp_…" id passes through unchanged. Unknown id → no anchor, resolve to [].
    const resolvedProjectId = await this.resolveTasksProjectIdTx(tx, projectId);
    if (!resolvedProjectId) return [];
    projectId = resolvedProjectId;

    const [proj] = await tx
      .select({ workspaceId: schema.tasksProjects.workspaceId })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, projectId))
      .limit(1);
    // Unknown project → nothing to anchor labels to; resolve to no ids rather
    // than orphan-create. (createTask/updateTask only ever pass a real project.)
    if (!proj) return [];

    const existing = await tx
      .select({ id: schema.taskLabels.id, name: schema.taskLabels.name })
      .from(schema.taskLabels)
      .where(eq(schema.taskLabels.projectId, projectId));
    const byName = new Map<string, string>();
    for (const row of existing) byName.set(row.name.trim().toLowerCase(), row.id);

    // Tail of the project's label sort order, so new labels append in order.
    const [tailRow] = await tx
      .select({ maxSort: sql<number | null>`MAX(${schema.taskLabels.sortOrder})` })
      .from(schema.taskLabels)
      .where(eq(schema.taskLabels.projectId, projectId));
    let nextSort = (tailRow?.maxSort ?? -1) + 1;

    const ids: string[] = [];
    for (const name of wanted) {
      const found = byName.get(name.toLowerCase());
      if (found) {
        ids.push(found);
        continue;
      }
      const id = randomUUID();
      await tx.insert(schema.taskLabels).values({
        id,
        projectId,
        workspaceId: proj.workspaceId,
        name,
        color: "#94a3b8",
        sortOrder: nextSort,
      });
      nextSort += 1;
      byName.set(name.toLowerCase(), id);
      ids.push(id);
    }
    return ids;
  }

  // Map a page of task rows, enriching each with its denormalized label/module ids
  // via a single batched satellite fetch, plus the OUTBOUND chat project id (each
  // row's tasks_projects.id → chat_project_id) so the mapped project_id is the chat
  // id the UI keys off, not the internal tp_ id.
  private async mapTaskRowsWithSatellites(
    rows: (typeof schema.tasks.$inferSelect)[],
  ): Promise<StoredTask[]> {
    if (rows.length === 0) return [];
    const [{ labels, modules }, chatProjectIds] = await Promise.all([
      this.loadTaskSatelliteIds(rows.map((r) => r.id)),
      this.loadChatProjectIds(rows.map((r) => r.projectId)),
    ]);
    return rows.map((r) =>
      this.mapTaskRow(r, {
        labelIds: labels.get(r.id),
        moduleIds: modules.get(r.id),
        chatProjectId: r.projectId ? (chatProjectIds.get(r.projectId) ?? null) : null,
      }),
    );
  }

  // Tasks Phase 3 — atomic dispatch claim. Conditional UPDATE that wins iff the
  // task is unclaimed or its claim is stale (last_dispatched_at <= now-30s); the
  // RETURNING id proves the winner. 0 rows => another replica/path already claimed
  // it within the window. This is the multi-replica / immediate+tick double-fire
  // guard (internal docs). staleMs is the claim window (default 30s).
  async claimTaskDispatch(taskId: string, staleMs = 30_000): Promise<boolean> {
    const cutoff = new Date(Date.now() - staleMs);
    const rows = await this.db
      .update(schema.tasks)
      .set({ lastDispatchedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          or(isNull(schema.tasks.lastDispatchedAt), lte(schema.tasks.lastDispatchedAt, cutoff)),
        ),
      )
      .returning({ id: schema.tasks.id });
    return rows.length > 0;
  }

  // Tasks Phase 3 — due-task selection for the schedule-runner tick. Open tasks
  // with an assignee, a due_at at/under `now`, and a claimable dispatch slot
  // (NULL or stale). Backed by idx_tasks_due (internal docs). The atomic
  // claimTaskDispatch is still applied per-task before dispatch.
  //
  // Redesign P0 — "open" is now decided by the workflow state's group
  // (backlog|unstarted|started are open; completed|cancelled are not) via a LEFT
  // JOIN onto task_states. Tasks with no state_id (legacy / no-state) fall back to
  // the free-text `status` (not done/cancelled), so the watcher keeps working
  // across the new and old state models.
  async getDueTasks(now: number = Date.now(), staleMs = 30_000): Promise<StoredTask[]> {
    const nowDate = new Date(now);
    const cutoff = new Date(now - staleMs);
    const rows = await this.db
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .leftJoin(schema.taskStates, eq(schema.taskStates.id, schema.tasks.stateId))
      .where(
        and(
          this.taskIsOpenCondition(),
          isNotNull(schema.tasks.assigneeId),
          isNotNull(schema.tasks.dueAt),
          lte(schema.tasks.dueAt, nowDate),
          or(isNull(schema.tasks.lastDispatchedAt), lte(schema.tasks.lastDispatchedAt, cutoff)),
        ),
      )
      .orderBy(asc(schema.tasks.dueAt));
    return this.mapTaskRowsWithSatellites(rows.map((r) => r.task));
  }

  // Redesign P0 — the shared "task is open" predicate for the watcher/dispatch
  // paths. When the task has a workflow state, openness follows the state's group
  // (backlog|unstarted|started are open). When it has no state (legacy rows or
  // tasks created before states), it falls back to the free-text `status` not
  // being a terminal value. Assumes task_states is LEFT JOINed onto tasks.
  private taskIsOpenCondition() {
    return or(
      // Has a state: open iff its group is a non-terminal phase.
      inArray(schema.taskStates.group, ["backlog", "unstarted", "started"]),
      // No state: fall back to the legacy free-text status.
      and(
        isNull(schema.tasks.stateId),
        ne(schema.tasks.status, "done"),
        ne(schema.tasks.status, "cancelled"),
      ),
    );
  }

  // Tasks Phase 3 — owned-task catch-up on daemon reconnect. Open tasks in the
  // workspace assigned to any of `assigneeIds` (the reconnecting daemon's cybos)
  // that are claimable (NULL/stale dispatch). Ownership is sticky: only the OWNING
  // daemon's cybos are returned, never reassigned elsewhere (internal docs
  // Decision 5). Backed by idx_tasks_assignee. staleMs default 1h.
  //
  // Redesign P0 — "open" follows the workflow state's group
  // (backlog|unstarted|started) via a LEFT JOIN onto task_states, falling back to
  // the legacy free-text status (todo|pending|in_progress) for stateless tasks.
  async getOwnedOpenTasks(
    workspaceId: string,
    assigneeIds: readonly string[],
    staleMs = 3_600_000,
  ): Promise<StoredTask[]> {
    if (assigneeIds.length === 0) return [];
    const cutoff = new Date(Date.now() - staleMs);
    const rows = await this.db
      .select({ task: schema.tasks })
      .from(schema.tasks)
      .leftJoin(schema.taskStates, eq(schema.taskStates.id, schema.tasks.stateId))
      .where(
        and(
          eq(schema.tasks.workspaceId, workspaceId),
          or(
            inArray(schema.taskStates.group, ["backlog", "unstarted", "started"]),
            and(
              isNull(schema.tasks.stateId),
              inArray(schema.tasks.status, ["todo", "pending", "in_progress"]),
            ),
          ),
          inArray(schema.tasks.assigneeId, [...assigneeIds]),
          or(isNull(schema.tasks.lastDispatchedAt), lte(schema.tasks.lastDispatchedAt, cutoff)),
        ),
      )
      .orderBy(asc(schema.tasks.createdAt));
    return this.mapTaskRowsWithSatellites(rows.map((r) => r.task));
  }

  // ─── Tasks Redesign P0: projects, states, visibility ──────────────

  // Provision the Tasks-project that partners a chat project (1:1 via
  // chat_project_id) and seed its five default workflow states. Idempotent:
  // re-running is a no-op (deterministic ids + ON CONFLICT DO NOTHING), matching
  // the 0031 backfill so the app layer and the migration agree on shape. Returns
  // the tasks_project id. The task-key prefix (`identifier`) is derived from
  // `name` and de-duped against the workspace's existing identifiers, mirroring
  // the SQLite storage.ts path so cloud and solo projects look identical.
  async provisionTasksProject(
    workspaceId: string,
    chatProjectId: string,
    name: string,
  ): Promise<string> {
    return this.db.transaction((tx) =>
      this.provisionTasksProjectTx(tx, workspaceId, chatProjectId, name),
    );
  }

  private async provisionTasksProjectTx(
    tx: PgTx,
    workspaceId: string,
    chatProjectId: string,
    name: string,
  ): Promise<string> {
    const projectId = `tp_${chatProjectId}`;
    // A pre-existing link (same deterministic id) is left untouched — keep its
    // identifier rather than re-deriving and risking a needless dedupe bump.
    const [existing] = await tx
      .select({ id: schema.tasksProjects.id })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, projectId))
      .limit(1);
    if (!existing) {
      const identifier = await this.uniqueIdentifierTx(
        tx,
        workspaceId,
        PgSync.deriveIdentifier(name),
      );
      await tx
        .insert(schema.tasksProjects)
        .values({ id: projectId, workspaceId, chatProjectId, identifier })
        .onConflictDoNothing({ target: schema.tasksProjects.id });
    }
    await this.seedDefaultStatesTx(tx, projectId, workspaceId);
    return projectId;
  }

  // Derive a task-key prefix (uppercase, <=8, alnum) from a project name. Empty /
  // non-alnum names fall back to "PROJ" (matching the 0031 backfill). Mirrors the
  // SQLite storage.ts deriveIdentifier so both paths agree on shape.
  private static deriveIdentifier(name: string): string {
    const base = name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    return base.length > 0 ? base : "PROJ";
  }

  // De-dupe a candidate task-key prefix against the workspace's existing Tasks-
  // project identifiers (the UNIQUE (workspace_id, identifier) index). Appends a
  // numeric suffix (ENG, ENG1, ENG2, …), truncating the base so the result stays
  // <=8 chars. Returns the first free identifier.
  private async uniqueIdentifierTx(tx: PgTx, workspaceId: string, base: string): Promise<string> {
    const rows = await tx
      .select({ identifier: schema.tasksProjects.identifier })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.workspaceId, workspaceId));
    const taken = new Set(rows.map((r) => r.identifier));
    if (!taken.has(base)) return base;
    for (let n = 1; ; n++) {
      const suffix = String(n);
      const candidate = base.slice(0, Math.max(0, 8 - suffix.length)) + suffix;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // Seed the five canonical workflow states for a Tasks-project. Deterministic ids
  // ('ts_' || projectId || '_' || group) + ON CONFLICT DO NOTHING make it
  // idempotent and run-twice clean.
  private async seedDefaultStatesTx(
    tx: PgTx,
    projectId: string,
    workspaceId: string,
  ): Promise<void> {
    await tx
      .insert(schema.taskStates)
      .values(
        DEFAULT_TASK_STATES.map((s) => ({
          id: `ts_${projectId}_${s.group}`,
          projectId,
          workspaceId,
          name: s.name,
          color: s.color,
          group: s.group,
          sequence: s.sequence,
          isDefault: s.isDefault,
        })),
      )
      .onConflictDoNothing({ target: schema.taskStates.id });
  }

  // The per-workspace synthetic "Inbox" Tasks-project that holds orphan tasks
  // (no channel/chat-project). Deterministic id 'tp_inbox_' || workspaceId, seeded
  // with the five default states. Idempotent. Returns the tasks_project id.
  async getOrCreateInboxProject(workspaceId: string): Promise<string> {
    return this.db.transaction((tx) => this.getOrCreateInboxProjectTx(tx, workspaceId));
  }

  private async getOrCreateInboxProjectTx(tx: PgTx, workspaceId: string): Promise<string> {
    const projectId = `tp_inbox_${workspaceId}`;
    await tx
      .insert(schema.tasksProjects)
      .values({
        id: projectId,
        workspaceId,
        chatProjectId: null,
        identifier: "INBOX",
      })
      .onConflictDoNothing({ target: schema.tasksProjects.id });
    await this.seedDefaultStatesTx(tx, projectId, workspaceId);
    return projectId;
  }

  // Tasks Redesign — translate a WIRE projectId into the tasks_projects.id it
  // refers to. The UI routes /tasks/[projectId] and sends create/update/fetch with
  // the CHAT project id (cyborg:fetch_projects returns the chat `projects` rows),
  // but every tasks read/write keys off tasks_projects.id ("tp_…"). This bridges
  // the two 1:1-derived id spaces by DB lookup (never by string-prepending "tp_",
  // so Inbox and any other id scheme still resolve):
  //   - a row already keyed by this id (a "tp_…" id) → return it as-is (back-compat),
  //   - else the 1:1 chat link (tasks_projects.chat_project_id = id) → that row's id,
  //   - else null (genuinely unknown — caller turns it into "project not found").
  // `workspaceId` (optional) scopes the lookup defensively when the caller has it;
  // both id and chat_project_id are globally unique, so it only narrows, never
  // changes, a hit. Callers inside a transaction use resolveTasksProjectIdTx.
  async resolveTasksProjectId(projectId: string, workspaceId?: string): Promise<string | null> {
    return this.resolveTasksProjectIdTx(this.db, projectId, workspaceId);
  }

  private async resolveTasksProjectIdTx(
    tx: PgTx | NodePgDatabase<typeof schema>,
    projectId: string,
    workspaceId?: string,
  ): Promise<string | null> {
    const wsScope = workspaceId ? eq(schema.tasksProjects.workspaceId, workspaceId) : undefined;
    const [byId] = await tx
      .select({ id: schema.tasksProjects.id })
      .from(schema.tasksProjects)
      .where(
        wsScope
          ? and(eq(schema.tasksProjects.id, projectId), wsScope)
          : eq(schema.tasksProjects.id, projectId),
      )
      .limit(1);
    if (byId) return byId.id;
    const [byChat] = await tx
      .select({ id: schema.tasksProjects.id })
      .from(schema.tasksProjects)
      .where(
        wsScope
          ? and(eq(schema.tasksProjects.chatProjectId, projectId), wsScope)
          : eq(schema.tasksProjects.chatProjectId, projectId),
      )
      .limit(1);
    return byChat?.id ?? null;
  }

  // createTask's effective-project resolver — the require-one-of rule the product
  // owner decided, mirrored exactly in storage.resolveCreateProject so cybo / CLI /
  // UI behave identically. Precedence:
  //   1. explicit projectId → the Tasks-project it names (CHAT id or "tp_…" id; the
  //      UI routes /tasks/[projectId] off cyborg:fetch_projects, so a chat id is
  //      translated to the tasks_projects.id). Unknown id → throw "project not found"
  //      (fail closed rather than silently filing into Inbox).
  //   2. else channelId → the channel's chat-project's tasks_project, falling back to
  //      the workspace Inbox when the channel has no project (KEPT).
  //   3. else parentId → INHERIT the parent task's Tasks-project (sub-tasks; the UI
  //      passes only parentId). Parents always carry a project, so this resolves; a
  //      missing / project-less parent is a data anomaly and falls through to rule 4.
  //   4. else (no project/channel/parent context) → the require-project flag
  //      decides: requireProjectContext true → throw "provide projectId or
  //      channelId" (the user/cybo-facing handlers; the relay surfaces it via
  //      respondError); false (default) → fall back to the workspace Inbox (the
  //      2nd-workspace MCP server, GitHub sync, internal callers).
  // Returns a non-null tasks_projects id, or throws.
  private async resolveCreateProjectTx(
    tx: PgTx,
    opts: {
      projectId: string | null;
      channelId: string | null;
      parentId?: string | null;
      workspaceId: string;
      requireProjectContext?: boolean;
    },
  ): Promise<string> {
    if (opts.projectId) {
      const resolved = await this.resolveTasksProjectIdTx(tx, opts.projectId, opts.workspaceId);
      if (!resolved) throw new Error("project not found");
      return resolved;
    }
    if (opts.channelId) {
      const [link] = await tx
        .select({ projectId: schema.tasksProjects.id })
        .from(schema.channelProjects)
        .innerJoin(
          schema.tasksProjects,
          eq(schema.tasksProjects.chatProjectId, schema.channelProjects.projectId),
        )
        .where(eq(schema.channelProjects.channelId, opts.channelId))
        .limit(1);
      if (link?.projectId) return link.projectId;
      return this.getOrCreateInboxProjectTx(tx, opts.workspaceId);
    }
    if (opts.parentId) {
      const [parent] = await tx
        .select({ projectId: schema.tasks.projectId })
        .from(schema.tasks)
        .where(
          and(eq(schema.tasks.id, opts.parentId), eq(schema.tasks.workspaceId, opts.workspaceId)),
        )
        .limit(1);
      const parentProjectId = parent?.projectId;
      if (parentProjectId) return parentProjectId;
    }
    if (opts.requireProjectContext) throw new Error("provide projectId or channelId");
    return this.getOrCreateInboxProjectTx(tx, opts.workspaceId);
  }

  // The reusable visibility predicate: a user can see a Tasks-project iff
  //   (a) it is the synthetic per-workspace Inbox (chat_project_id IS NULL), OR
  //   (b) the user is a MEMBER (channel_members) of >=1 non-deleted, non-archived
  //       channel tagged (channel_projects) to its chat_project_id, OR
  //   (c) the user is the workspace owner or admin (memberships.role).
  // Mirrors getChannelsForUser's EXISTS-subquery shape. Returned as a SQL boolean
  // expression so callers can compose it into a WHERE. `projectCol` is the
  // tasks_projects column to evaluate against (its chat_project_id / workspace_id
  // are read off schema.tasksProjects in the surrounding query).
  private visibilityCondition(workspaceId: string, userId: string) {
    return or(
      // (a) Inbox — visible to every workspace member.
      isNull(schema.tasksProjects.chatProjectId),
      // (b) member of a non-deleted, non-archived channel tagged to this project.
      exists(
        this.db
          .select({ one: sql`1` })
          .from(schema.channelProjects)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.channelProjects.channelId))
          .innerJoin(schema.channelMembers, eq(schema.channelMembers.channelId, schema.channels.id))
          .where(
            and(
              eq(schema.channelProjects.projectId, schema.tasksProjects.chatProjectId),
              isNull(schema.channels.deletedAt),
              eq(schema.channels.isArchived, false),
              eq(schema.channelMembers.userId, userId),
            ),
          ),
      ),
      // (c) workspace owner/admin sees every project in the workspace.
      exists(
        this.db
          .select({ one: sql`1` })
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.workspaceId, workspaceId),
              eq(schema.memberships.userId, userId),
              inArray(schema.memberships.role, ["owner", "admin"]),
            ),
          ),
      ),
    );
  }

  // The set of Tasks-project ids the user may see in a workspace (visibility CTE).
  async visibleProjectIds(workspaceId: string, userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: schema.tasksProjects.id })
      .from(schema.tasksProjects)
      .where(
        and(
          eq(schema.tasksProjects.workspaceId, workspaceId),
          this.visibilityCondition(workspaceId, userId),
        ),
      );
    return rows.map((r) => r.id);
  }

  // Tasks Redesign — the enriched Tasks-project list shape the CLI / UI picker and
  // the cybo cyborg7_list_projects read consume: the display `name` (the linked chat
  // project's name, or "Inbox" for the synthetic project), the task-key `identifier`,
  // a display `color`, the synthetic-Inbox flag, and the `chatProjectId` (null for
  // Inbox). `id` is the tasks_projects.id ("tp_…"); both `id` and `chatProjectId`
  // resolve back through create_task / fetch_tasks (resolveTasksProjectId accepts
  // either). Shared by getTasksProjectsForUser (visibility-scoped, human relay
  // endpoint) and getTasksProjects (workspace-wide, cybo read path).
  private mapTasksProjectListRow(r: {
    id: string;
    identifier: string;
    color: string | null;
    chatProjectId: string | null;
    projectName: string | null;
    projectColor: string | null;
  }): {
    id: string;
    identifier: string;
    name: string;
    color: string | null;
    isInbox: boolean;
    chatProjectId: string | null;
  } {
    return {
      id: r.id,
      identifier: r.identifier,
      name: r.chatProjectId ? (r.projectName ?? r.identifier) : "Inbox",
      color: r.color ?? r.projectColor ?? null,
      isInbox: r.chatProjectId === null,
      chatProjectId: r.chatProjectId,
    };
  }

  // Visibility-scoped Tasks-project list for a human (cyborg:fetch_tasks_projects):
  // same predicate as visibleProjectIds (Inbox + channel-tagged projects the user is
  // in + everything for owner/admin), enriched for the picker. The left join to the
  // 1:1 chat `projects` row supplies the display name/color (null for the Inbox,
  // which has no chat project). Ordered by creation.
  async getTasksProjectsForUser(
    workspaceId: string,
    userId: string,
  ): Promise<
    Array<{
      id: string;
      identifier: string;
      name: string;
      color: string | null;
      isInbox: boolean;
      chatProjectId: string | null;
    }>
  > {
    // Drizzle's or()/and() helpers are typed `SQL | undefined`, so nesting the
    // visibility predicate directly inside and() leaks a possibly-undefined arg
    // into the where(). Collect the conditions in an array and only push the
    // visibility predicate when it's present — the same defensive pattern as
    // getTasksPage — so the where() never sees a bare undefined.
    const conditions = [eq(schema.tasksProjects.workspaceId, workspaceId)];
    const visCond = this.visibilityCondition(workspaceId, userId);
    if (visCond) conditions.push(visCond);
    const rows = await this.db
      .select({
        id: schema.tasksProjects.id,
        identifier: schema.tasksProjects.identifier,
        color: schema.tasksProjects.color,
        chatProjectId: schema.tasksProjects.chatProjectId,
        projectName: schema.projects.name,
        projectColor: schema.projects.color,
      })
      .from(schema.tasksProjects)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.tasksProjects.chatProjectId))
      .where(and(...conditions))
      .orderBy(asc(schema.tasksProjects.createdAt));
    return rows.map((r) => this.mapTasksProjectListRow(r));
  }

  // Workspace-wide Tasks-project list (the cybo cloud read path — cyborg7_list_
  // projects on a PG daemon). Not visibility-scoped: mirrors the workspace-wide
  // tasks / roster cybo reads (any cybo in the workspace lists them). Same enriched
  // shape + chat-project left join as getTasksProjectsForUser. Ordered by creation.
  async getTasksProjects(workspaceId: string): Promise<
    Array<{
      id: string;
      identifier: string;
      name: string;
      color: string | null;
      isInbox: boolean;
      chatProjectId: string | null;
    }>
  > {
    const rows = await this.db
      .select({
        id: schema.tasksProjects.id,
        identifier: schema.tasksProjects.identifier,
        color: schema.tasksProjects.color,
        chatProjectId: schema.tasksProjects.chatProjectId,
        projectName: schema.projects.name,
        projectColor: schema.projects.color,
      })
      .from(schema.tasksProjects)
      .leftJoin(schema.projects, eq(schema.projects.id, schema.tasksProjects.chatProjectId))
      .where(eq(schema.tasksProjects.workspaceId, workspaceId))
      .orderBy(asc(schema.tasksProjects.createdAt));
    return rows.map((r) => this.mapTasksProjectListRow(r));
  }

  // Assert a single Tasks-project is visible to the user (same predicate as
  // visibleProjectIds). Returns true/false; callers turn false into a 403.
  // The incoming projectId is a WIRE id (the UI sends the chat project id), so it
  // is translated to the tasks_projects.id first — exactly the id space the
  // visibility predicate, visibleProjectIds, and tasks.project_id all key off, so a
  // chat id passed here gates the SAME project the task reads/writes touch (no
  // lock-out from an id-space mismatch). A "tp_…" id passes through; an unknown id
  // resolves to null → not visible.
  async assertProjectVisible(projectId: string, userId: string): Promise<boolean> {
    const resolvedId = await this.resolveTasksProjectId(projectId);
    if (!resolvedId) return false;
    const [proj] = await this.db
      .select({ workspaceId: schema.tasksProjects.workspaceId })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, resolvedId))
      .limit(1);
    if (!proj) return false;
    const [row] = await this.db
      .select({ id: schema.tasksProjects.id })
      .from(schema.tasksProjects)
      .where(
        and(
          eq(schema.tasksProjects.id, resolvedId),
          this.visibilityCondition(proj.workspaceId, userId),
        ),
      )
      .limit(1);
    return !!row;
  }

  // Cybo-scoped variant of assertProjectVisible: gate a single Tasks-project for a
  // CYBO (not a human user) on the cybo write path, mirroring the human
  // membership gate. A cybo has no workspace role, so its access is purely channel
  // membership: the Inbox (no chat_project_id) is visible to any workspace cybo,
  // and a chat-backed project is visible when the cybo is a member of a
  // non-deleted, non-archived channel tagged to that project's chat project.
  // Returns false for an unknown project (caller turns false into a 403).
  // The incoming projectId is a WIRE id — the cybo write path gates a task's
  // OUTBOUND project_id (now the chat id, post project-id translation) and an MCP
  // `projectId` arg sourced from a list read (also the chat id) — so it is resolved
  // to the tasks_projects.id first, exactly like assertProjectVisible. A "tp_…" id
  // passes through; an unknown id resolves to null → not visible.
  async assertProjectVisibleForCybo(projectId: string, cyboId: string): Promise<boolean> {
    const resolvedId = await this.resolveTasksProjectId(projectId);
    if (!resolvedId) return false;
    const [proj] = await this.db
      .select({ chatProjectId: schema.tasksProjects.chatProjectId })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, resolvedId))
      .limit(1);
    if (!proj) return false;
    // Inbox (synthetic, no chat project) — visible to every cybo in the workspace.
    if (proj.chatProjectId === null) return true;
    const [row] = await this.db
      .select({ one: sql`1` })
      .from(schema.channelProjects)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.channelProjects.channelId))
      .innerJoin(schema.channelMembers, eq(schema.channelMembers.channelId, schema.channels.id))
      .where(
        and(
          eq(schema.channelProjects.projectId, proj.chatProjectId),
          isNull(schema.channels.deletedAt),
          eq(schema.channels.isArchived, false),
          eq(schema.channelMembers.cyboId, cyboId),
        ),
      )
      .limit(1);
    return !!row;
  }

  // ─── Tasks Redesign catalog reads (board/detail) ─────────────────────
  // Five read-only catalog fetches backing the board columns / detail pickers /
  // activity feed. Each incoming projectId is a WIRE (chat) project id — the UI
  // routes /tasks/[projectId] off cyborg:fetch_projects — so it is resolved to
  // the tasks_projects.id FIRST (states/labels/cycles/modules all key off it). An
  // unknown project resolves to null → an empty list (the relay/dispatcher gate
  // visibility separately). Rows are mapped to the client's camelCase shapes
  // (packages/ui/src/lib/core/types.ts) verbatim; timestamp columns become epoch
  // ms numbers (or null) so the wire carries no Date objects.

  // A project's workflow states (board columns), ordered by `sequence`.
  async getProjectStates(projectId: string): Promise<
    Array<{
      id: string;
      projectId: string;
      workspaceId: string;
      name: string;
      color: string;
      group: string;
      sequence: number;
      isDefault: boolean;
    }>
  > {
    const resolvedId = await this.resolveTasksProjectId(projectId);
    if (!resolvedId) return [];
    const rows = await this.db
      .select()
      .from(schema.taskStates)
      .where(eq(schema.taskStates.projectId, resolvedId))
      .orderBy(asc(schema.taskStates.sequence));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      name: r.name,
      color: r.color,
      group: r.group,
      sequence: r.sequence,
      isDefault: r.isDefault,
    }));
  }

  // A project's label catalog (tags), ordered by `sortOrder`.
  async getProjectLabels(projectId: string): Promise<
    Array<{
      id: string;
      projectId: string;
      workspaceId: string;
      name: string;
      color: string;
      sortOrder: number;
    }>
  > {
    const resolvedId = await this.resolveTasksProjectId(projectId);
    if (!resolvedId) return [];
    const rows = await this.db
      .select()
      .from(schema.taskLabels)
      .where(eq(schema.taskLabels.projectId, resolvedId))
      .orderBy(asc(schema.taskLabels.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      name: r.name,
      color: r.color,
      sortOrder: r.sortOrder,
    }));
  }

  // A project's cycles (sprints), ordered by `sortOrder`. Dates → epoch ms / null.
  async getProjectCycles(projectId: string): Promise<
    Array<{
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
    }>
  > {
    const resolvedId = await this.resolveTasksProjectId(projectId);
    if (!resolvedId) return [];
    const rows = await this.db
      .select()
      .from(schema.cycles)
      .where(eq(schema.cycles.projectId, resolvedId))
      .orderBy(asc(schema.cycles.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      name: r.name,
      description: r.description,
      startDate: r.startDate ? r.startDate.getTime() : null,
      endDate: r.endDate ? r.endDate.getTime() : null,
      ownedBy: r.ownedBy,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt ? r.archivedAt.getTime() : null,
      createdAt: r.createdAt.getTime(),
    }));
  }

  // A project's modules (feature groupings), ordered by `sortOrder`. Dates → ms.
  async getProjectModules(projectId: string): Promise<
    Array<{
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
    }>
  > {
    const resolvedId = await this.resolveTasksProjectId(projectId);
    if (!resolvedId) return [];
    const rows = await this.db
      .select()
      .from(schema.modules)
      .where(eq(schema.modules.projectId, resolvedId))
      .orderBy(asc(schema.modules.sortOrder));
    return rows.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      name: r.name,
      description: r.description,
      startDate: r.startDate ? r.startDate.getTime() : null,
      targetDate: r.targetDate ? r.targetDate.getTime() : null,
      status: r.status,
      lead: r.lead,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt ? r.archivedAt.getTime() : null,
    }));
  }

  // ─── Cycles catalog CRUD ──────────────────────────────────────────
  // The wire `projectId` is the CHAT project id (the UI routes /tasks/[projectId]
  // off cyborg:fetch_projects), so it is resolved to the tasks_projects.id (and
  // its workspace) before the row is written — exactly the id space getProjectCycles
  // and tasks.cycle_id key off. Returns the new row in the client `Cycle` shape
  // (camelCase, dates → epoch ms). Throws "project not found" for an unknown id so
  // the relay caller turns it into an error response.
  async insertCycle(opts: {
    projectId: string;
    name: string;
    description?: string | null;
    startDate?: number | null;
    endDate?: number | null;
  }): Promise<{
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
  }> {
    const resolvedId = await this.resolveTasksProjectId(opts.projectId);
    if (!resolvedId) throw new Error("project not found");
    const [proj] = await this.db
      .select({ workspaceId: schema.tasksProjects.workspaceId })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, resolvedId))
      .limit(1);
    if (!proj) throw new Error("project not found");
    const id = `cyc_${randomUUID()}`;
    const [row] = await this.db
      .insert(schema.cycles)
      .values({
        id,
        projectId: resolvedId,
        workspaceId: proj.workspaceId,
        name: opts.name,
        description: opts.description ?? null,
        startDate: opts.startDate != null ? new Date(opts.startDate) : null,
        endDate: opts.endDate != null ? new Date(opts.endDate) : null,
      })
      .returning();
    return this.mapCycleRow(row);
  }

  // Update a cycle's editable fields (name/description/start/end). Only the keys
  // present in `updates` are written; a `null` clears the column. Returns the
  // updated row in the client `Cycle` shape, or null when the cycle is missing.
  async updateCycle(
    cycleId: string,
    updates: {
      name?: string;
      description?: string | null;
      startDate?: number | null;
      endDate?: number | null;
    },
  ): Promise<{
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
  } | null> {
    const patch: Partial<typeof schema.cycles.$inferInsert> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.startDate !== undefined) {
      patch.startDate = updates.startDate != null ? new Date(updates.startDate) : null;
    }
    if (updates.endDate !== undefined) {
      patch.endDate = updates.endDate != null ? new Date(updates.endDate) : null;
    }
    if (Object.keys(patch).length === 0) {
      const [row] = await this.db
        .select()
        .from(schema.cycles)
        .where(eq(schema.cycles.id, cycleId))
        .limit(1);
      return row ? this.mapCycleRow(row) : null;
    }
    const [row] = await this.db
      .update(schema.cycles)
      .set(patch)
      .where(eq(schema.cycles.id, cycleId))
      .returning();
    return row ? this.mapCycleRow(row) : null;
  }

  // Hard-delete a cycle (its tasks' cycle_id is nulled by the schema's ON DELETE
  // SET NULL). Idempotent: a missing cycle is a no-op.
  async deleteCycle(cycleId: string): Promise<void> {
    await this.db.delete(schema.cycles).where(eq(schema.cycles.id, cycleId));
  }

  // Resolve a cycle → its (tasks_projects) project id, so update/delete can gate
  // visibility (assertProjectVisible accepts a "tp_…" id directly). Null when the
  // cycle is missing (caller fails closed).
  async getCycleProjectId(cycleId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.cycles.projectId })
      .from(schema.cycles)
      .where(eq(schema.cycles.id, cycleId))
      .limit(1);
    return row?.projectId ?? null;
  }

  private mapCycleRow(r: typeof schema.cycles.$inferSelect): {
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
  } {
    return {
      id: r.id,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      name: r.name,
      description: r.description,
      startDate: r.startDate ? r.startDate.getTime() : null,
      endDate: r.endDate ? r.endDate.getTime() : null,
      ownedBy: r.ownedBy,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt ? r.archivedAt.getTime() : null,
      createdAt: r.createdAt.getTime(),
    };
  }

  // ─── Project pages catalog CRUD ───────────────────────────────────
  // A project's pages (wiki/docs) VISIBLE to `userId`. Dates → epoch ms / null;
  // ordered non-archived first, then newest-updated first (the UI filters archived
  // itself). Owner-filtered: a non-null-owner private page is returned ONLY to its
  // owner; public + legacy null-owner pages go to every member (mirrors Plane).
  async getProjectPages(projectId: string, userId: string): Promise<PageShape[]> {
    const resolvedId = await this.resolveTasksProjectId(projectId);
    if (!resolvedId) return [];
    const rows = await this.db
      .select()
      .from(schema.tasksPages)
      .where(
        and(
          eq(schema.tasksPages.projectId, resolvedId),
          or(
            eq(schema.tasksPages.visibility, "public"),
            isNull(schema.tasksPages.ownedBy),
            eq(schema.tasksPages.ownedBy, userId),
          ),
        ),
      )
      .orderBy(asc(schema.tasksPages.archivedAt), desc(schema.tasksPages.updatedAt));
    return rows.map((r) => this.mapPageRow(r));
  }

  // A single page by id, or null when missing.
  async getPageById(pageId: string): Promise<PageShape | null> {
    const [row] = await this.db
      .select()
      .from(schema.tasksPages)
      .where(eq(schema.tasksPages.id, pageId))
      .limit(1);
    return row ? this.mapPageRow(row) : null;
  }

  // The wire `projectId` is the CHAT project id (resolved to tasks_projects.id +
  // its workspace before the row is written). Returns the new row in the client
  // `Page` shape. Throws "project not found" for an unknown id. ownedBy = creator.
  async insertPage(opts: {
    id?: string;
    projectId: string;
    title?: string;
    ownedBy?: string | null;
    // Optional parent for nesting; null/undefined = a root page. The FK guards
    // referential integrity (a non-existent parent throws).
    parentId?: string | null;
  }): Promise<PageShape> {
    const resolvedId = await this.resolveTasksProjectId(opts.projectId);
    if (!resolvedId) throw new Error("project not found");
    const [proj] = await this.db
      .select({ workspaceId: schema.tasksProjects.workspaceId })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, resolvedId))
      .limit(1);
    if (!proj) throw new Error("project not found");
    // A nested page's parent must live in the SAME project (so it can't escape
    // the project's visibility gate). Reject a cross-project / nonexistent parent.
    if (opts.parentId) {
      const [parent] = await this.db
        .select({ projectId: schema.tasksPages.projectId })
        .from(schema.tasksPages)
        .where(eq(schema.tasksPages.id, opts.parentId))
        .limit(1);
      if (!parent || parent.projectId !== resolvedId) {
        throw new Error("parent page not found in this project");
      }
    }
    // Use the caller-provided id (from the SQLite write) so the same page has
    // identical ids in both stores; only generate one when none is supplied.
    const id = opts.id ?? `page_${randomUUID()}`;
    const [row] = await this.db
      .insert(schema.tasksPages)
      .values({
        id,
        projectId: resolvedId,
        workspaceId: proj.workspaceId,
        title: opts.title ?? "",
        ownedBy: opts.ownedBy ?? null,
        parentId: opts.parentId ?? null,
      })
      .returning();
    return this.mapPageRow(row);
  }

  // Update a page's editable fields (title/content/visibility). Only present keys
  // are written; `updatedAt` is always bumped. Returns the updated row in the
  // client `Page` shape, or null when the page is missing.
  async updatePage(
    pageId: string,
    updates: {
      title?: string;
      content?: string;
      visibility?: string;
      icon?: string | null;
      // Re-parent the page; null = move to root. Cycle-guarded below.
      parentId?: string | null;
      sortOrder?: number;
    },
  ): Promise<PageShape | null> {
    const patch: Partial<typeof schema.tasksPages.$inferInsert> = {};
    if (updates.title !== undefined) patch.title = updates.title;
    if (updates.content !== undefined) patch.content = updates.content;
    if (updates.visibility !== undefined) patch.visibility = updates.visibility;
    if (updates.icon !== undefined) patch.icon = updates.icon;
    if (updates.sortOrder !== undefined) patch.sortOrder = updates.sortOrder;
    if (updates.parentId !== undefined) {
      // Cycle guard: a page may not be parented to itself or to any of its own
      // descendants (that would detach a subtree into an unreachable loop).
      // Mirrors math-library's FolderService.isDescendant — fetch the project's
      // pages flat ONCE, walk the tree in memory (no per-row queries).
      if (updates.parentId !== null) {
        if (updates.parentId === pageId) {
          throw new PageCycleError(pageId, updates.parentId);
        }
        const [self] = await this.db
          .select({ projectId: schema.tasksPages.projectId })
          .from(schema.tasksPages)
          .where(eq(schema.tasksPages.id, pageId))
          .limit(1);
        if (self) {
          // The project's pages, flat — used BOTH to confirm the parent lives in
          // the same project (cross-project / nonexistent parent → reject, so a
          // move can't escape the project's visibility gate) AND to walk the tree
          // for the cycle check, in ONE query (no N+1).
          const siblings = await this.db
            .select({ id: schema.tasksPages.id, parentId: schema.tasksPages.parentId })
            .from(schema.tasksPages)
            .where(eq(schema.tasksPages.projectId, self.projectId));
          if (!siblings.some((p) => p.id === updates.parentId)) {
            throw new Error("parent page not found in this project");
          }
          if (isPageDescendant(siblings, pageId, updates.parentId)) {
            throw new PageCycleError(pageId, updates.parentId);
          }
        }
      }
      patch.parentId = updates.parentId;
    }
    if (Object.keys(patch).length === 0) {
      const [row] = await this.db
        .select()
        .from(schema.tasksPages)
        .where(eq(schema.tasksPages.id, pageId))
        .limit(1);
      return row ? this.mapPageRow(row) : null;
    }
    patch.updatedAt = new Date();
    const [row] = await this.db
      .update(schema.tasksPages)
      .set(patch)
      .where(eq(schema.tasksPages.id, pageId))
      .returning();
    return row ? this.mapPageRow(row) : null;
  }

  // Toggle a page's soft-archive (archivedAt). Reversible — pass archived=false to
  // restore. Bumps updatedAt. Returns the updated row, or null when missing.
  async setPageArchived(pageId: string, archived: boolean): Promise<PageShape | null> {
    const [row] = await this.db
      .update(schema.tasksPages)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.tasksPages.id, pageId))
      .returning();
    return row ? this.mapPageRow(row) : null;
  }

  // Hard-delete a page. Idempotent: a missing page is a no-op.
  async deletePage(pageId: string): Promise<void> {
    await this.db.delete(schema.tasksPages).where(eq(schema.tasksPages.id, pageId));
  }

  // Resolve a page → its (tasks_projects) project id, so update/archive/delete can
  // gate visibility (assertProjectVisible accepts a "tp_…" id directly). Null when
  // the page is missing (caller fails closed).
  async getPageProjectId(pageId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.tasksPages.projectId })
      .from(schema.tasksPages)
      .where(eq(schema.tasksPages.id, pageId))
      .limit(1);
    return row?.projectId ?? null;
  }

  private mapPageRow(r: typeof schema.tasksPages.$inferSelect): PageShape {
    return {
      id: r.id,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      title: r.title,
      content: r.content,
      visibility: r.visibility,
      icon: r.icon ?? null,
      parentId: r.parentId ?? null,
      sortOrder: r.sortOrder,
      ownedBy: r.ownedBy,
      archivedAt: r.archivedAt ? r.archivedAt.getTime() : null,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
    };
  }

  // ─── Modules catalog CRUD ─────────────────────────────────────────
  // Same wire-id resolution as insertCycle. `status` is free text (Plane parity:
  // planned | in_progress | paused | completed | cancelled), defaulting to the
  // schema's "planned" when unset. Returns the client `Module` shape.
  async insertModule(opts: {
    projectId: string;
    name: string;
    description?: string | null;
    status?: string | null;
  }): Promise<{
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
  }> {
    const resolvedId = await this.resolveTasksProjectId(opts.projectId);
    if (!resolvedId) throw new Error("project not found");
    const [proj] = await this.db
      .select({ workspaceId: schema.tasksProjects.workspaceId })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, resolvedId))
      .limit(1);
    if (!proj) throw new Error("project not found");
    const id = `mod_${randomUUID()}`;
    const [row] = await this.db
      .insert(schema.modules)
      .values({
        id,
        projectId: resolvedId,
        workspaceId: proj.workspaceId,
        name: opts.name,
        description: opts.description ?? null,
        ...(opts.status != null ? { status: opts.status } : {}),
      })
      .returning();
    return this.mapModuleRow(row);
  }

  // Update a module's editable fields (name/description/status). Returns the
  // updated row in the client `Module` shape, or null when the module is missing.
  async updateModule(
    moduleId: string,
    updates: { name?: string; description?: string | null; status?: string },
  ): Promise<{
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
  } | null> {
    const patch: Partial<typeof schema.modules.$inferInsert> = {};
    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.description !== undefined) patch.description = updates.description;
    if (updates.status !== undefined) patch.status = updates.status;
    if (Object.keys(patch).length === 0) {
      const [row] = await this.db
        .select()
        .from(schema.modules)
        .where(eq(schema.modules.id, moduleId))
        .limit(1);
      return row ? this.mapModuleRow(row) : null;
    }
    const [row] = await this.db
      .update(schema.modules)
      .set(patch)
      .where(eq(schema.modules.id, moduleId))
      .returning();
    return row ? this.mapModuleRow(row) : null;
  }

  // Hard-delete a module (its task_modules join rows cascade). Idempotent.
  async deleteModule(moduleId: string): Promise<void> {
    await this.db.delete(schema.modules).where(eq(schema.modules.id, moduleId));
  }

  // Resolve a module → its (tasks_projects) project id, for the update/delete gate.
  async getModuleProjectId(moduleId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.modules.projectId })
      .from(schema.modules)
      .where(eq(schema.modules.id, moduleId))
      .limit(1);
    return row?.projectId ?? null;
  }

  private mapModuleRow(r: typeof schema.modules.$inferSelect): {
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
  } {
    return {
      id: r.id,
      projectId: r.projectId,
      workspaceId: r.workspaceId,
      name: r.name,
      description: r.description,
      startDate: r.startDate ? r.startDate.getTime() : null,
      targetDate: r.targetDate ? r.targetDate.getTime() : null,
      status: r.status,
      lead: r.lead,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt ? r.archivedAt.getTime() : null,
    };
  }

  // A single task's activity feed (history), ordered by `epoch` ascending. The
  // caller resolves task→project and gates visibility before calling this.
  async getTaskActivity(taskId: string): Promise<
    Array<{
      id: string;
      taskId: string;
      workspaceId: string;
      actorId: string | null;
      verb: string;
      field: string | null;
      oldValue: string | null;
      newValue: string | null;
      commentHtml: string | null;
      epoch: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(schema.taskActivity)
      .where(eq(schema.taskActivity.taskId, taskId))
      .orderBy(asc(schema.taskActivity.epoch));
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      workspaceId: r.workspaceId,
      actorId: r.actorId,
      verb: r.verb,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      commentHtml: r.commentHtml,
      epoch: r.epoch,
    }));
  }

  // Resolve a task → its (tasks_projects) project id, for the activity gate. The
  // relay gates task_activity by resolving the task to its project, then running
  // assertProjectVisible on that project's chat id. Returns null for a missing
  // task (caller fails closed).
  async getTaskProjectId(taskId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.tasks.projectId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    return row?.projectId ?? null;
  }

  // ─── Task links (external URLs) ───────────────────────────────────
  // The relay/dispatcher resolves the task→project and gates visibility before
  // calling these. `createdBy` is the acting user. add/get return the client
  // `TaskLink` shape (camelCase, dates → epoch ms).

  async addTaskLink(opts: {
    taskId: string;
    url: string;
    title?: string | null;
    createdBy: string;
  }): Promise<{
    id: string;
    taskId: string;
    url: string;
    title: string | null;
    createdBy: string;
    createdAt: number;
  }> {
    const id = `tlink_${randomUUID()}`;
    const [row] = await this.db
      .insert(schema.taskLinks)
      .values({
        id,
        taskId: opts.taskId,
        url: opts.url,
        title: opts.title ?? null,
        createdBy: opts.createdBy,
      })
      .returning();
    return this.mapTaskLinkRow(row);
  }

  // Hard-delete a link. Idempotent: a missing link is a no-op.
  async removeTaskLink(linkId: string): Promise<void> {
    await this.db.delete(schema.taskLinks).where(eq(schema.taskLinks.id, linkId));
  }

  // A task's links, newest first.
  async getTaskLinks(taskId: string): Promise<
    Array<{
      id: string;
      taskId: string;
      url: string;
      title: string | null;
      createdBy: string;
      createdAt: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(schema.taskLinks)
      .where(eq(schema.taskLinks.taskId, taskId))
      .orderBy(desc(schema.taskLinks.createdAt));
    return rows.map((r) => this.mapTaskLinkRow(r));
  }

  // Resolve a link → its task's (tasks_projects) project id, so remove can gate
  // visibility. Null when the link (or its task's project) is missing.
  async getTaskLinkProjectId(linkId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.tasks.projectId })
      .from(schema.taskLinks)
      .innerJoin(schema.tasks, eq(schema.taskLinks.taskId, schema.tasks.id))
      .where(eq(schema.taskLinks.id, linkId))
      .limit(1);
    return row?.projectId ?? null;
  }

  private mapTaskLinkRow(r: typeof schema.taskLinks.$inferSelect): {
    id: string;
    taskId: string;
    url: string;
    title: string | null;
    createdBy: string;
    createdAt: number;
  } {
    return {
      id: r.id,
      taskId: r.taskId,
      url: r.url,
      title: r.title,
      createdBy: r.createdBy,
      createdAt: r.createdAt.getTime(),
    };
  }

  // ─── Task attachments (S3 asset rows) ─────────────────────────────
  // The client uploads to the presigned URL first, then calls add with the
  // resulting key + delivery url. The row carries the asset_key (for later
  // delete/presign) and the delivery `url` is returned in the client shape but is
  // NOT a stored column (the schema persists asset_key + metadata only) — it's
  // derived/echoed for the client, mirroring the message-attachment contract.

  async addTaskAttachment(opts: {
    taskId: string;
    key: string;
    url: string;
    name: string;
    size: number;
    contentType?: string | null;
    uploadedBy: string;
  }): Promise<{
    id: string;
    taskId: string;
    assetKey: string;
    url: string;
    name: string;
    size: number;
    contentType: string | null;
    uploadedBy: string;
    createdAt: number;
  }> {
    const id = `tatt_${randomUUID()}`;
    const [row] = await this.db
      .insert(schema.taskAttachments)
      .values({
        id,
        taskId: opts.taskId,
        assetKey: opts.key,
        name: opts.name,
        size: opts.size,
        contentType: opts.contentType ?? null,
        uploadedBy: opts.uploadedBy,
      })
      .returning();
    return this.mapTaskAttachmentRow(row, opts.url);
  }

  // Hard-delete an attachment row (the S3 object lifecycle is separate).
  // Idempotent: a missing row is a no-op.
  async removeTaskAttachment(attachmentId: string): Promise<void> {
    await this.db.delete(schema.taskAttachments).where(eq(schema.taskAttachments.id, attachmentId));
  }

  // A task's attachments, newest first. The delivery `url` is derived from the
  // stored asset_key (S3 disabled locally → the raw key is echoed as the url, the
  // caller resolves it to a real URL where S3 is configured).
  async getTaskAttachments(taskId: string): Promise<
    Array<{
      id: string;
      taskId: string;
      assetKey: string;
      url: string;
      name: string;
      size: number;
      contentType: string | null;
      uploadedBy: string;
      createdAt: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(schema.taskAttachments)
      .where(eq(schema.taskAttachments.taskId, taskId))
      .orderBy(desc(schema.taskAttachments.createdAt));
    return rows.map((r) => this.mapTaskAttachmentRow(r, r.assetKey));
  }

  // Resolve an attachment → its task's (tasks_projects) project id, for the
  // remove gate. Null when the attachment (or its task's project) is missing.
  async getTaskAttachmentProjectId(attachmentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ projectId: schema.tasks.projectId })
      .from(schema.taskAttachments)
      .innerJoin(schema.tasks, eq(schema.taskAttachments.taskId, schema.tasks.id))
      .where(eq(schema.taskAttachments.id, attachmentId))
      .limit(1);
    return row?.projectId ?? null;
  }

  private mapTaskAttachmentRow(
    r: typeof schema.taskAttachments.$inferSelect,
    url: string,
  ): {
    id: string;
    taskId: string;
    assetKey: string;
    url: string;
    name: string;
    size: number;
    contentType: string | null;
    uploadedBy: string;
    createdAt: number;
  } {
    return {
      id: r.id,
      taskId: r.taskId,
      assetKey: r.assetKey,
      url,
      name: r.name,
      size: r.size,
      contentType: r.contentType,
      uploadedBy: r.uploadedBy,
      createdAt: r.createdAt.getTime(),
    };
  }

  // Tasks Phase 3 — atomic recurrence spawn-next. Claims the parent's spawn slot
  // (recurrence_spawned_at IS NULL) under the recurrence cap in one conditional
  // UPDATE; only the winner inserts the child carrying the parent's
  // recurrence/assignee/channel/priority. Returns the child's id, or null if
  // already spawned / cap reached / parent missing (internal docs).
  async spawnRecurrenceChild(
    parentId: string,
    childDueAt: number | null,
    maxRecurrenceCount: number,
  ): Promise<string | null> {
    const claimed = await this.db
      .update(schema.tasks)
      .set({
        recurrenceSpawnedAt: new Date(),
        recurrenceCount: sql`${schema.tasks.recurrenceCount} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.tasks.id, parentId),
          isNull(schema.tasks.recurrenceSpawnedAt),
          lt(schema.tasks.recurrenceCount, maxRecurrenceCount),
        ),
      )
      .returning();
    const parent = claimed[0];
    if (!parent) return null;
    const childId = `task_${randomUUID()}`;
    await this.db.insert(schema.tasks).values({
      id: childId,
      workspaceId: parent.workspaceId,
      title: parent.title,
      description: parent.description,
      status: "pending",
      assigneeId: parent.assigneeId,
      createdBy: parent.createdBy,
      dueAt: childDueAt ? new Date(childDueAt) : null,
      recurrence: parent.recurrence,
      channelId: parent.channelId,
      priority: parent.priority,
    });
    return childId;
  }

  // ─── Schedules ───────────────────────────────────────────────────

  async createSchedule(s: {
    id: string;
    workspace_id: string;
    cybo_id: string;
    channel_id: string | null;
    // Per-task scheduling — optional on the mirror write so older callers still
    // type; NULL = a raw-prompt cybo schedule.
    task_id?: string | null;
    cron_expr: string;
    timezone: string | null;
    prompt: string;
    enabled: number;
    next_run_at: number | null;
    // Phase 2 (#619) — optional on the mirror write so older callers still type.
    max_runs?: number | null;
    run_count?: number;
    catch_up?: number;
    created_by: string;
  }): Promise<void> {
    await this.db.insert(schema.schedules).values({
      id: s.id,
      workspaceId: s.workspace_id,
      cyboId: s.cybo_id,
      channelId: s.channel_id,
      taskId: s.task_id ?? null,
      cronExpr: s.cron_expr,
      timezone: s.timezone,
      prompt: s.prompt,
      enabled: s.enabled === 1,
      nextRunAt: s.next_run_at ? new Date(s.next_run_at) : null,
      maxRuns: s.max_runs ?? null,
      runCount: s.run_count ?? 0,
      catchUp: s.catch_up === undefined ? true : s.catch_up === 1,
      createdBy: s.created_by,
    });
  }

  async markScheduleRun(
    id: string,
    lastRunAt: number,
    nextRunAt: number | null,
    incrementRunCount = false,
  ): Promise<void> {
    await this.db
      .update(schema.schedules)
      .set({
        lastRunAt: new Date(lastRunAt),
        nextRunAt: nextRunAt ? new Date(nextRunAt) : null,
        // Keep run_count in lockstep with SQLite so the mirror's one-shot view
        // matches the authoritative copy (#619). +1 via a SQL expression.
        ...(incrementRunCount ? { runCount: sql`${schema.schedules.runCount} + 1` } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.schedules.id, id));
  }

  async setScheduleEnabled(id: string, enabled: boolean, nextRunAt: number | null): Promise<void> {
    const set: Record<string, unknown> = { enabled, updatedAt: new Date() };
    if (nextRunAt !== null) set.nextRunAt = new Date(nextRunAt);
    await this.db.update(schema.schedules).set(set).where(eq(schema.schedules.id, id));
  }

  async updateSchedule(
    id: string,
    fields: {
      cronExpr?: string;
      prompt?: string;
      channelId?: string | null;
      taskId?: string | null;
      timezone?: string | null;
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (fields.cronExpr !== undefined) set.cronExpr = fields.cronExpr;
    if (fields.prompt !== undefined) set.prompt = fields.prompt;
    if (fields.channelId !== undefined) set.channelId = fields.channelId;
    if (fields.taskId !== undefined) set.taskId = fields.taskId;
    if (fields.timezone !== undefined) set.timezone = fields.timezone;
    if (fields.nextRunAt !== undefined) {
      set.nextRunAt = fields.nextRunAt ? new Date(fields.nextRunAt) : null;
    }
    await this.db.update(schema.schedules).set(set).where(eq(schema.schedules.id, id));
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.db.delete(schema.schedules).where(eq(schema.schedules.id, id));
  }

  // ─── Built-in integrations (recipes) ─────────────────────────────
  // The installed_recipes mirror. Unlike schedules, the relay READS this table
  // PG-direct (list_recipes) so cloud users see installs even when the owning
  // daemon is asleep — same pattern as listSchedules. DualStorage writes SQLite
  // first then mirrors here; the daemon's enable/disable handlers are the writers.

  // Enable (install) a recipe. Upsert against the partial UNIQUE (workspace,
  // recipe) WHERE enabled — a re-enable reuses the existing active row (refresh
  // config + enabled + updated_at). Raw SQL because drizzle's onConflictDoUpdate
  // can't express a partial-index conflict target (see addCyboToChannel). config
  // is a JSON object; passed parameterized so it can't break out of the literal.
  async enableRecipe(r: {
    id: string;
    workspaceId: string;
    recipeId: string;
    config?: Record<string, unknown>;
    createdBy: string;
  }): Promise<void> {
    const configJson = JSON.stringify(r.config ?? {});
    await this.db.execute(sql`
      INSERT INTO installed_recipes (id, workspace_id, recipe_id, enabled, config, cybo_id, schedule_ids, created_by)
      VALUES (${r.id}, ${r.workspaceId}, ${r.recipeId}, true, ${configJson}::jsonb, NULL, '[]'::jsonb, ${r.createdBy})
      ON CONFLICT (workspace_id, recipe_id) WHERE enabled
      DO UPDATE SET config = ${configJson}::jsonb, enabled = true, updated_at = now()
    `);
  }

  // Stamp the provisioned cybo + schedule ids onto the active install, scoped by
  // id so a concurrent disable can't resurrect ids onto a torn-down row.
  async setRecipeProvisioned(id: string, cyboId: string, scheduleIds: string[]): Promise<void> {
    await this.db
      .update(schema.installedRecipes)
      .set({ cyboId, scheduleIds, updatedAt: new Date() })
      .where(eq(schema.installedRecipes.id, id));
  }

  // Disable the active install for (workspace, recipe): flip enabled=false and
  // clear the provisioned ids (the cybo + its schedules/memberships are removed by
  // the caller via the cybo FK cascade). The row is kept for history, never deleted.
  async disableRecipe(workspaceId: string, recipeId: string): Promise<void> {
    await this.db
      .update(schema.installedRecipes)
      .set({ enabled: false, cyboId: null, scheduleIds: [], updatedAt: new Date() })
      .where(
        and(
          eq(schema.installedRecipes.workspaceId, workspaceId),
          eq(schema.installedRecipes.recipeId, recipeId),
          eq(schema.installedRecipes.enabled, true),
        ),
      );
  }

  // Cloud READ of the recipe mirror (relay answers list_recipes PG-direct).
  async listRecipesForWorkspace(workspaceId: string): Promise<StoredInstalledRecipe[]> {
    const rows = await this.db
      .select()
      .from(schema.installedRecipes)
      .where(eq(schema.installedRecipes.workspaceId, workspaceId))
      .orderBy(desc(schema.installedRecipes.createdAt));
    return rows.map(mapInstalledRecipeRow);
  }

  // The ACTIVE install for (workspace, recipe), or null. Disabled history rows are
  // excluded so callers see at most one (the live install).
  async getInstalledRecipe(
    workspaceId: string,
    recipeId: string,
  ): Promise<StoredInstalledRecipe | null> {
    const [row] = await this.db
      .select()
      .from(schema.installedRecipes)
      .where(
        and(
          eq(schema.installedRecipes.workspaceId, workspaceId),
          eq(schema.installedRecipes.recipeId, recipeId),
          eq(schema.installedRecipes.enabled, true),
        ),
      )
      .limit(1);
    return row ? mapInstalledRecipeRow(row) : null;
  }

  // Cloud READ of the schedule mirror. Unlike the runner's SQLite reads, the
  // relay answers list_schedules from PG so cloud/DMG users see schedules even
  // when the owning daemon is asleep (internal docs). Read-only — execution
  // truth stays in the daemon's SQLite, so a stale mirror can't double-fire.
  async listSchedules(workspaceId: string): Promise<StoredSchedule[]> {
    const rows = await this.db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.workspaceId, workspaceId))
      .orderBy(desc(schema.schedules.createdAt));
    return rows.map(mapScheduleRow);
  }

  // Cloud READ + stale flag (#619 §3.3): the schedule mirror joined against the
  // daemon heartbeat registry, so the UI can badge schedules whose owning daemon
  // is gone (overdue next_run_at + no live daemon serving the workspace). Returns
  // each schedule with a `stale` boolean. Read-only — never feeds execution.
  async listSchedulesWithStaleness(
    workspaceId: string,
    now: number = Date.now(),
  ): Promise<Array<StoredSchedule & { stale: boolean }>> {
    const [schedules, daemons] = await Promise.all([
      this.listSchedules(workspaceId),
      this.getDaemonsForWorkspace(workspaceId),
    ]);
    const staleIds = detectStaleSchedules(schedules, daemons, now);
    // mapScheduleRow already returns fresh objects, so annotate in place (no
    // shared refs) rather than spreading a new object per row.
    const annotated: Array<StoredSchedule & { stale: boolean }> = [];
    for (const s of schedules) {
      annotated.push(Object.assign(s, { stale: staleIds.has(s.id) }));
    }
    return annotated;
  }

  async getSchedule(id: string): Promise<StoredSchedule | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.schedules)
      .where(eq(schema.schedules.id, id))
      .limit(1);
    return row ? mapScheduleRow(row) : undefined;
  }

  // Per-task scheduling — the schedule(s) bound to each of the given task ids,
  // as a taskId → schedules[] map. Used by the relay to denormalize a minimal
  // read-only schedule summary onto the wire Task (task list/detail). Read-only,
  // like listSchedules; never feeds execution (the runner reads SQLite). A task
  // with no bound schedule simply has no map entry. Returns an empty map for an
  // empty input so a no-task page does no query.
  async getSchedulesByTaskIds(taskIds: readonly string[]): Promise<Map<string, StoredSchedule[]>> {
    const byTask = new Map<string, StoredSchedule[]>();
    if (taskIds.length === 0) return byTask;
    const rows = await this.db
      .select()
      .from(schema.schedules)
      .where(inArray(schema.schedules.taskId, [...taskIds]));
    for (const row of rows) {
      const schedule = mapScheduleRow(row);
      if (schedule.task_id === null) continue;
      const list = byTask.get(schedule.task_id);
      if (list) list.push(schedule);
      else byTask.set(schedule.task_id, [schedule]);
    }
    return byTask;
  }

  // ─── Schedule runs (run-history mirror — #619) ──────────────────
  // Write-only mirror like `schedules`: the daemon's SQLite is authoritative;
  // these PG writes are fire-and-forget for cloud visibility. The relay reads
  // listScheduleRuns to answer the "last runs" drawer when the daemon is asleep.

  async startScheduleRun(run: {
    id: string;
    schedule_id: string;
    workspace_id: string;
    scheduled_for: number | null;
    started_at: number;
  }): Promise<void> {
    await this.db.insert(schema.scheduleRuns).values({
      id: run.id,
      scheduleId: run.schedule_id,
      workspaceId: run.workspace_id,
      scheduledFor: run.scheduled_for ? new Date(run.scheduled_for) : null,
      startedAt: new Date(run.started_at),
      status: "running",
    });
  }

  async finishScheduleRun(run: {
    id: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    error: string | null;
    endedAt: number;
  }): Promise<void> {
    await this.db
      .update(schema.scheduleRuns)
      .set({
        status: run.status,
        agentId: run.agentId,
        error: run.error,
        endedAt: new Date(run.endedAt),
      })
      .where(eq(schema.scheduleRuns.id, run.id));
  }

  async recordSkippedScheduleRun(run: {
    id: string;
    schedule_id: string;
    workspace_id: string;
    scheduled_for: number | null;
    skipReason: ScheduleSkipReason;
    at: number;
  }): Promise<void> {
    await this.db.insert(schema.scheduleRuns).values({
      id: run.id,
      scheduleId: run.schedule_id,
      workspaceId: run.workspace_id,
      scheduledFor: run.scheduled_for ? new Date(run.scheduled_for) : null,
      startedAt: new Date(run.at),
      endedAt: new Date(run.at),
      status: "skipped",
      skipReason: run.skipReason,
    });
  }

  // Cloud READ of the run-history mirror for one schedule (newest first).
  async listScheduleRuns(scheduleId: string, limit = 20): Promise<StoredScheduleRun[]> {
    const rows = await this.db
      .select()
      .from(schema.scheduleRuns)
      .where(eq(schema.scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(schema.scheduleRuns.startedAt))
      .limit(limit);
    return rows.map(mapScheduleRunRow);
  }

  // ─── Scheduled messages (user "send later", #607) ────────────────

  async createScheduledMessage(m: StoredScheduledMessage): Promise<void> {
    await this.db.insert(schema.scheduledMessages).values({
      id: m.id,
      workspaceId: m.workspace_id,
      channelId: m.channel_id,
      toId: m.to_id,
      fromId: m.from_id,
      text: m.text,
      mentions: m.mentions ? (JSON.parse(m.mentions) as string[]) : null,
      sendAt: new Date(m.send_at),
      processedAt: m.processed_at ? new Date(m.processed_at) : null,
      errorCode: m.error_code,
      createdAt: new Date(m.created_at),
    });
  }

  async getScheduledMessage(id: string): Promise<StoredScheduledMessage | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.scheduledMessages)
      .where(eq(schema.scheduledMessages.id, id))
      .limit(1);
    return row ? mapScheduledMessageRow(row) : undefined;
  }

  // The author's scheduled messages (pending + processed) for a workspace, newest
  // send_at first — the cloud "Scheduled" list read path.
  async listScheduledMessages(
    workspaceId: string,
    fromId: string,
  ): Promise<StoredScheduledMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.scheduledMessages)
      .where(
        and(
          eq(schema.scheduledMessages.workspaceId, workspaceId),
          eq(schema.scheduledMessages.fromId, fromId),
        ),
      )
      .orderBy(desc(schema.scheduledMessages.sendAt));
    return rows.map(mapScheduledMessageRow);
  }

  async updateScheduledMessage(
    id: string,
    fields: { text?: string; sendAt?: number; mentions?: string[] | null },
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    if (fields.text !== undefined) set.text = fields.text;
    if (fields.sendAt !== undefined) set.sendAt = new Date(fields.sendAt);
    if (fields.mentions !== undefined) {
      set.mentions = fields.mentions && fields.mentions.length > 0 ? fields.mentions : null;
    }
    if (Object.keys(set).length === 0) return;
    // Only pending rows are editable (mirrors SQLite).
    await this.db
      .update(schema.scheduledMessages)
      .set(set)
      .where(
        and(eq(schema.scheduledMessages.id, id), isNull(schema.scheduledMessages.processedAt)),
      );
  }

  async markScheduledMessageProcessed(
    id: string,
    at: number,
    errorCode: ScheduledMessageErrorCode | null = null,
  ): Promise<void> {
    await this.db
      .update(schema.scheduledMessages)
      .set({ processedAt: new Date(at), errorCode })
      .where(
        and(eq(schema.scheduledMessages.id, id), isNull(schema.scheduledMessages.processedAt)),
      );
  }

  // Record a failure reason on an ALREADY-CLAIMED row (processed_at set). No
  // processed-guard: the relay tick claims via claimDueScheduledMessages, and if
  // the send then throws it stamps the reason here on that id.
  async setScheduledMessageError(id: string, errorCode: ScheduledMessageErrorCode): Promise<void> {
    await this.db
      .update(schema.scheduledMessages)
      .set({ errorCode })
      .where(eq(schema.scheduledMessages.id, id));
  }

  async deleteScheduledMessage(id: string): Promise<void> {
    await this.db
      .delete(schema.scheduledMessages)
      .where(
        and(eq(schema.scheduledMessages.id, id), isNull(schema.scheduledMessages.processedAt)),
      );
  }

  // Relay-side ATOMIC claim of due rows: select due+unprocessed rows FOR UPDATE
  // SKIP LOCKED and stamp processed_at in the SAME transaction, so each row is
  // handed to exactly one tick (even across multiple relay instances or a relay +
  // a connected daemon). The caller then sends each claimed row via the normal
  // path; on a send failure it overwrites error_code via markScheduledMessage
  // Processed (the row is already claimed, so no other tick will retry it). This
  // is the exactly-once guarantee for the cloud fire path.
  async claimDueScheduledMessages(now: number, limit = 50): Promise<StoredScheduledMessage[]> {
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(schema.scheduledMessages)
        .where(
          and(
            isNull(schema.scheduledMessages.processedAt),
            lte(schema.scheduledMessages.sendAt, new Date(now)),
          ),
        )
        .orderBy(asc(schema.scheduledMessages.sendAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      const claimedAt = new Date(now);
      await tx
        .update(schema.scheduledMessages)
        .set({ processedAt: claimedAt })
        .where(
          inArray(
            schema.scheduledMessages.id,
            due.map((r) => r.id),
          ),
        );
      // Reflect the stamp in the returned rows so the caller knows they're claimed.
      return due.map((r) => mapScheduledMessageRow({ ...r, processedAt: claimedAt }));
    });
  }

  // ─── Prompt templates (#602 — reusable composer snippets) ────────
  // Workspace-scoped CRUD, mirrored to PG so the cloud relay serves them PG-direct
  // (the create/update handlers pre-check the unique name and return a friendly
  // error, so the (workspace_id, name) UNIQUE index is a backstop here).

  async createPromptTemplate(t: StoredPromptTemplate): Promise<void> {
    await this.db.insert(schema.promptTemplates).values({
      id: t.id,
      workspaceId: t.workspace_id,
      name: t.name,
      body: t.body,
      createdBy: t.created_by,
      createdAt: new Date(t.created_at),
    });
  }

  async getPromptTemplate(id: string): Promise<StoredPromptTemplate | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.promptTemplates)
      .where(eq(schema.promptTemplates.id, id))
      .limit(1);
    return row ? mapPromptTemplateRow(row) : undefined;
  }

  // Lookup by the per-workspace unique name — the create/update name-clash check.
  async getPromptTemplateByName(
    workspaceId: string,
    name: string,
  ): Promise<StoredPromptTemplate | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.promptTemplates)
      .where(
        and(
          eq(schema.promptTemplates.workspaceId, workspaceId),
          eq(schema.promptTemplates.name, name),
        ),
      )
      .limit(1);
    return row ? mapPromptTemplateRow(row) : undefined;
  }

  // All templates for a workspace, A→Z by name (the composer slash-menu read).
  async listPromptTemplates(workspaceId: string): Promise<StoredPromptTemplate[]> {
    const rows = await this.db
      .select()
      .from(schema.promptTemplates)
      .where(eq(schema.promptTemplates.workspaceId, workspaceId))
      .orderBy(asc(schema.promptTemplates.name));
    return rows.map(mapPromptTemplateRow);
  }

  async updatePromptTemplate(id: string, fields: { name?: string; body?: string }): Promise<void> {
    const set: Record<string, unknown> = {};
    if (fields.name !== undefined) set.name = fields.name;
    if (fields.body !== undefined) set.body = fields.body;
    if (Object.keys(set).length === 0) return;
    await this.db.update(schema.promptTemplates).set(set).where(eq(schema.promptTemplates.id, id));
  }

  async deletePromptTemplate(id: string): Promise<void> {
    await this.db.delete(schema.promptTemplates).where(eq(schema.promptTemplates.id, id));
  }

  async updateTask(
    taskId: string,
    updates: {
      title?: string;
      description?: string;
      status?: string;
      assigneeId?: string | null;
      result?: string;
      // dueAt is epoch ms (or null to clear); the due_at column is a timestamp,
      // so it is converted to a Date below — same mapping as createTask.
      dueAt?: number | null;
      channelId?: string | null;
      priority?: string | null;
      // Phase 0 — lane ordering (reorder), planned start (Gantt), soft-archive,
      // draft. All epoch ms (or null to clear) where they map to a timestamp.
      sortOrder?: number | null;
      startDate?: number | null;
      archivedAt?: number | null;
      isDraft?: boolean;
      // Tasks Redesign P0 — workflow state (mirrors `status` from its group), the
      // Tasks-project, the sub-task parent, the single cycle, and the denormalized
      // label/module sets (each replaces the task's join rows when provided). Pass
      // null to clear a scalar; an empty array to clear all labels/modules.
      stateId?: string | null;
      projectId?: string | null;
      parentId?: string | null;
      cycleId?: string | null;
      labelIds?: string[];
      moduleIds?: string[];
    },
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.title !== undefined) set.title = updates.title;
    if (updates.description !== undefined) set.description = updates.description;
    if (updates.status !== undefined) set.status = updates.status;
    if (updates.assigneeId !== undefined) set.assigneeId = updates.assigneeId;
    if (updates.result !== undefined) set.result = updates.result;
    if (updates.dueAt !== undefined)
      set.dueAt = updates.dueAt === null ? null : new Date(updates.dueAt);
    if (updates.channelId !== undefined) set.channelId = updates.channelId;
    if (updates.priority !== undefined) set.priority = updates.priority;
    if (updates.sortOrder !== undefined) set.sortOrder = updates.sortOrder;
    if (updates.startDate !== undefined)
      set.startDate = updates.startDate === null ? null : new Date(updates.startDate);
    if (updates.archivedAt !== undefined)
      set.archivedAt = updates.archivedAt === null ? null : new Date(updates.archivedAt);
    if (updates.isDraft !== undefined) set.isDraft = updates.isDraft;
    // Redesign P0 scalar columns. projectId is resolved inside the transaction (a
    // wire chat id → tasks_projects.id), so it's deliberately NOT set here.
    if (updates.parentId !== undefined) set.parentId = updates.parentId;
    if (updates.cycleId !== undefined) set.cycleId = updates.cycleId;
    if (updates.stateId !== undefined) set.stateId = updates.stateId;

    await this.db.transaction(async (tx) => {
      // Re-parenting to a Tasks-project: the wire carries the CHAT project id (the
      // UI sends what cyborg:fetch_projects returned), so translate it to the
      // tasks_projects.id before writing tasks.project_id; a "tp_…" id passes
      // through unchanged. A non-null id that resolves to nothing is unknown → fail
      // closed. Clearing the project (null) writes null untouched.
      if (updates.projectId !== undefined) {
        if (updates.projectId === null) {
          set.projectId = null;
        } else {
          const resolved = await this.resolveTasksProjectIdTx(tx, updates.projectId);
          if (!resolved) throw new Error("project not found");
          set.projectId = resolved;
        }
      }

      // When the workflow state changes (and the caller didn't also pass an explicit
      // status override), mirror the legacy free-text `status` from the new state's
      // group so the watcher/back-compat reads stay correct. Clearing the state
      // (null) leaves the existing status untouched.
      if (updates.stateId !== undefined && updates.status === undefined && updates.stateId) {
        const [st] = await tx
          .select({ group: schema.taskStates.group })
          .from(schema.taskStates)
          .where(eq(schema.taskStates.id, updates.stateId))
          .limit(1);
        if (st) set.status = mapStateGroupToStatus(st.group);
      }

      await tx.update(schema.tasks).set(set).where(eq(schema.tasks.id, taskId));

      // Replace the label assignment set when provided (delete-then-insert).
      if (updates.labelIds !== undefined) {
        await tx
          .delete(schema.taskLabelAssignees)
          .where(eq(schema.taskLabelAssignees.taskId, taskId));
        if (updates.labelIds.length > 0) {
          await tx
            .insert(schema.taskLabelAssignees)
            .values(updates.labelIds.map((labelId) => ({ taskId, labelId })))
            .onConflictDoNothing();
        }
      }

      // Replace the module assignment set when provided (delete-then-insert).
      if (updates.moduleIds !== undefined) {
        await tx.delete(schema.taskModules).where(eq(schema.taskModules.taskId, taskId));
        if (updates.moduleIds.length > 0) {
          await tx
            .insert(schema.taskModules)
            .values(updates.moduleIds.map((moduleId) => ({ taskId, moduleId })))
            .onConflictDoNothing();
        }
      }
    });
  }

  async toggleReaction(
    workspaceId: string,
    messageId: string,
    userId: string,
    userName: string,
    emoji: string,
  ): Promise<"added" | "removed"> {
    const [row] = await this.db
      .select({ reactions: schema.messages.reactions })
      .from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.workspaceId, workspaceId)));

    const existing = (row?.reactions ?? []) as {
      userId: string;
      userName?: string;
      emoji: string;
      createdAt: number;
    }[];
    const idx = existing.findIndex((r) => r.userId === userId && r.emoji === emoji);

    let action: "added" | "removed";
    if (idx >= 0) {
      existing.splice(idx, 1);
      action = "removed";
    } else {
      existing.push({ userId, userName, emoji, createdAt: Date.now() });
      action = "added";
    }

    await this.db
      .update(schema.messages)
      .set({ reactions: existing })
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.workspaceId, workspaceId)));

    return action;
  }

  async updateMessageText(messageId: string, text: string): Promise<boolean> {
    const result = await this.db
      .update(schema.messages)
      .set({ text, updatedAt: new Date() })
      .where(eq(schema.messages.id, messageId));
    return (result.rowCount ?? 0) > 0;
  }

  // URL unfurls (Tier 2). Set fire-and-forget by the relay after the unfurl
  // engine resolves link previews for a just-persisted message.
  async setMessageUnfurls(messageId: string, unfurls: Unfurl[]): Promise<void> {
    await this.db.update(schema.messages).set({ unfurls }).where(eq(schema.messages.id, messageId));
  }

  // ─── Workspace-Daemon subscriptions ──────────────────────────────

  async ensureWorkspaceDaemon(workspaceId: string, daemonId: string): Promise<void> {
    // onConflictDoNothing preserves an existing row's `enabled` — a manual
    // opt-out survives the daemon's reconnect re-subscribe.
    await this.db
      .insert(schema.workspaceDaemons)
      .values({ workspaceId, daemonId })
      .onConflictDoNothing();
  }

  // Owner toggles whether a daemon serves a workspace. Upserts so an opt-out can
  // be recorded even before the daemon has ever linked that workspace.
  async setWorkspaceDaemonEnabled(
    workspaceId: string,
    daemonId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.db
      .insert(schema.workspaceDaemons)
      .values({ workspaceId, daemonId, enabled })
      .onConflictDoUpdate({
        target: [schema.workspaceDaemons.workspaceId, schema.workspaceDaemons.daemonId],
        set: { enabled },
      });
  }

  // For the owner-facing toggle UI: every workspace the owner belongs to, with
  // whether this daemon currently serves it (missing row = default-on).
  async getDaemonWorkspaces(
    ownerId: string,
    daemonId: string,
  ): Promise<Array<{ workspaceId: string; name: string; enabled: boolean }>> {
    const rows = await this.db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        enabled: schema.workspaceDaemons.enabled,
      })
      .from(schema.workspaces)
      .innerJoin(
        schema.memberships,
        and(
          eq(schema.memberships.workspaceId, schema.workspaces.id),
          eq(schema.memberships.userId, ownerId),
        ),
      )
      .leftJoin(
        schema.workspaceDaemons,
        and(
          eq(schema.workspaceDaemons.workspaceId, schema.workspaces.id),
          eq(schema.workspaceDaemons.daemonId, daemonId),
        ),
      );
    return rows.map((r) => ({ workspaceId: r.id, name: r.name, enabled: r.enabled ?? true }));
  }

  // Workspace ids (among the owner's) where this daemon is NOT disabled — the set
  // the relay should route to. Default-on: only an explicit enabled=false excludes.
  async getEnabledWorkspaceIdsForDaemon(ownerId: string, daemonId: string): Promise<string[]> {
    const owned = await this.getWorkspacesForUser(ownerId);
    const disabledRows = await this.db
      .select({ workspaceId: schema.workspaceDaemons.workspaceId })
      .from(schema.workspaceDaemons)
      .where(
        and(
          eq(schema.workspaceDaemons.daemonId, daemonId),
          eq(schema.workspaceDaemons.enabled, false),
        ),
      );
    const disabled = new Set(disabledRows.map((r) => r.workspaceId));
    return owned.map((w) => w.id).filter((id) => !disabled.has(id));
  }

  // Authorization for the daemon↔workspace serving toggle: the caller must own
  // the daemon AND be a member of the target workspace. Without the membership
  // check, a daemon owner could subscribe their daemon to any workspace's
  // traffic (cross-tenant leak).
  async canManageDaemonWorkspace(
    userId: string,
    daemonId: string,
    workspaceId: string,
  ): Promise<"ok" | "not_owner" | "not_member"> {
    const owner = await this.getDaemonOwner(daemonId);
    if (owner !== userId) return "not_owner";
    if (!(await this.isMember(workspaceId, userId))) return "not_member";
    return "ok";
  }

  async getDaemonOwner(daemonId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ownerId: schema.daemons.ownerId })
      .from(schema.daemons)
      .where(eq(schema.daemons.id, daemonId))
      .limit(1);
    return row?.ownerId ?? null;
  }

  // ─── Daemons ─────────────────────────────────────────────────────

  async upsertDaemon(
    daemonId: string,
    ownerId: string,
    label: string,
    meta?: DaemonMetaUpdate,
  ): Promise<void> {
    await this.db
      .insert(schema.daemons)
      .values({
        id: daemonId,
        ownerId,
        label,
        publicKey: "",
        status: "online",
        lastSeenAt: new Date(),
        ...(meta ? { meta } : {}),
        // Set the edition column on first INSERT too (not just on conflict), so a
        // brand-new daemon is bucketed correctly in editionBreakdown immediately
        // instead of as 'unknown' until its first heartbeat.
        ...(meta?.edition ? { deploymentEdition: meta.edition } : {}),
      })
      .onConflictDoUpdate({
        target: schema.daemons.id,
        set: {
          ownerId: sql`CASE WHEN ${schema.daemons.ownerId} IN ('system', 'unclaimed') THEN ${ownerId} ELSE ${schema.daemons.ownerId} END`,
          status: "online",
          lastSeenAt: new Date(),
          // Sticky label (#441). os.hostname() is dynamic on macOS — on networks
          // without reverse-DNS it degrades to the raw IP, and the old
          // reported-always-wins COALESCE renamed the daemon to 192.168.x.x on
          // the next reconnect. Keep the existing label unless it's empty, or
          // it's IP-like and the reported one isn't (recovery path). A label the
          // user set from the UI is never overwritten.
          label: sql`CASE
            WHEN ${schema.daemons.labelUserSet} THEN ${schema.daemons.label}
            WHEN ${schema.daemons.label} IS NULL OR ${schema.daemons.label} = '' THEN COALESCE(NULLIF(${label}, ''), ${schema.daemons.label})
            WHEN ${schema.daemons.label} ~ '^([0-9]{1,3}\\.){3}[0-9]{1,3}$'
              AND NULLIF(${label}, '') IS NOT NULL AND ${label} !~ '^([0-9]{1,3}\\.){3}[0-9]{1,3}$' THEN ${label}
            ELSE ${schema.daemons.label}
          END`,
          // Merge reported meta into existing jsonb so a hello carrying only
          // static fields (host/OS/cyboInstalled) doesn't wipe runtime stats,
          // and vice-versa. NULL existing meta starts from an empty object.
          ...(meta
            ? {
                meta: sql`COALESCE(${schema.daemons.meta}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
              }
            : {}),
          // Mirror the reported edition into the dedicated column for a cheap
          // GROUP BY edition (usage-metrics dashboard), exactly as deployment_mode
          // is tracked. Only when present so an older daemon (no edition) keeps the
          // last value / NULL = unknown.
          ...(meta?.edition ? { deploymentEdition: meta.edition } : {}),
        },
      });
  }

  // User-initiated rename from the UI (#441): sets the sticky flag so the
  // hello/heartbeat upsert never overwrites it again.
  async renameDaemon(daemonId: string, label: string): Promise<void> {
    await this.db
      .update(schema.daemons)
      .set({ label, labelUserSet: true })
      .where(eq(schema.daemons.id, daemonId));
  }

  async updateDaemonHeartbeat(daemonId: string, meta?: DaemonMetaUpdate): Promise<void> {
    await this.db
      .update(schema.daemons)
      .set({
        lastSeenAt: new Date(),
        status: "online",
        // Merge so static fields persisted at hello aren't lost when a heartbeat
        // carries only runtime stats (and vice-versa).
        ...(meta
          ? {
              meta: sql`COALESCE(${schema.daemons.meta}, '{}'::jsonb) || ${JSON.stringify(meta)}::jsonb`,
            }
          : {}),
        // Track the latest reported edition in the dedicated column (cheap GROUP BY
        // edition), mirroring deployment_mode. Only when present so an older daemon
        // (no edition) keeps the last value / NULL = unknown.
        ...(meta?.edition ? { deploymentEdition: meta.edition } : {}),
      })
      .where(eq(schema.daemons.id, daemonId));
  }

  async setDaemonOffline(daemonId: string): Promise<void> {
    await this.db
      .update(schema.daemons)
      .set({ status: "offline" })
      .where(eq(schema.daemons.id, daemonId));
  }

  async getDaemonsForWorkspace(workspaceId: string): Promise<
    Array<{
      id: string;
      label: string;
      ownerId: string;
      status: string;
      lastSeenAt: number | null;
      meta: typeof schema.daemons.$inferSelect.meta;
    }>
  > {
    const rows = await this.db
      .select({
        id: schema.daemons.id,
        label: schema.daemons.label,
        ownerId: schema.daemons.ownerId,
        status: schema.daemons.status,
        lastSeenAt: schema.daemons.lastSeenAt,
        meta: schema.daemons.meta,
      })
      .from(schema.daemons)
      .innerJoin(schema.workspaceDaemons, eq(schema.workspaceDaemons.daemonId, schema.daemons.id))
      .where(
        and(
          eq(schema.workspaceDaemons.workspaceId, workspaceId),
          eq(schema.workspaceDaemons.enabled, true),
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      ownerId: r.ownerId,
      status: r.status,
      lastSeenAt: r.lastSeenAt?.getTime() ?? null,
      meta: r.meta,
    }));
  }

  // ─── Daemon Access (#705: scoped) ───────────────────────────────
  //
  // The authoritative mutation is setDaemonAccess (idempotent set of scopes).
  // grant/revoke are kept as thin back-compat shims for call-sites that still
  // speak the binary model (the legacy grant/revoke RPCs, the Settings toggle
  // matrix, the sidebar "remove access"): a grant = ['admin'] (= the old total
  // access), a revoke = [] (= delete the row). Enforcement reads scopes via
  // getUserDaemonScopes; canUserAccessDaemon stays as "has ANY scope".

  // Idempotently SET the scopes a user holds on a daemon. An empty (or all-invalid)
  // scope list REVOKES (deletes the row) — a no-access state is the absence of a
  // row, never an empty array. Invalid scope strings are dropped (defensive: the
  // relay validates too). grantedBy/grantedAt refresh to the acting user + now on
  // every change so the row reflects the last mutation (feeds the #704 audit).
  async setDaemonAccess(
    workspaceId: string,
    daemonId: string,
    userId: string,
    scopes: readonly string[],
    grantedBy: string,
  ): Promise<void> {
    const clean = [...new Set(scopes.filter(isDaemonScope))];
    if (clean.length === 0) {
      await this.revokeDaemonAccess(workspaceId, daemonId, userId);
      return;
    }
    await this.db
      .insert(schema.daemonAccess)
      .values({ workspaceId, daemonId, userId, grantedBy, scopes: clean })
      .onConflictDoUpdate({
        target: [
          schema.daemonAccess.workspaceId,
          schema.daemonAccess.daemonId,
          schema.daemonAccess.userId,
        ],
        set: { scopes: clean, grantedBy, grantedAt: new Date() },
      });
  }

  // Back-compat shim: a legacy "grant" is total access → the `admin` scope.
  async grantDaemonAccess(
    workspaceId: string,
    daemonId: string,
    userId: string,
    grantedBy: string,
  ): Promise<void> {
    await this.setDaemonAccess(workspaceId, daemonId, userId, ["admin"], grantedBy);
  }

  async revokeDaemonAccess(workspaceId: string, daemonId: string, userId: string): Promise<void> {
    await this.db
      .delete(schema.daemonAccess)
      .where(
        and(
          eq(schema.daemonAccess.workspaceId, workspaceId),
          eq(schema.daemonAccess.daemonId, daemonId),
          eq(schema.daemonAccess.userId, userId),
        ),
      );
  }

  async getDaemonAccessForWorkspace(workspaceId: string): Promise<
    Array<{
      daemonId: string;
      userId: string;
      grantedBy: string;
      grantedAt: number;
      scopes: DaemonScope[];
    }>
  > {
    const rows = await this.db
      .select({
        daemonId: schema.daemonAccess.daemonId,
        userId: schema.daemonAccess.userId,
        grantedBy: schema.daemonAccess.grantedBy,
        grantedAt: schema.daemonAccess.grantedAt,
        scopes: schema.daemonAccess.scopes,
      })
      .from(schema.daemonAccess)
      .where(eq(schema.daemonAccess.workspaceId, workspaceId));

    return rows.map((r) => ({
      daemonId: r.daemonId,
      userId: r.userId,
      grantedBy: r.grantedBy,
      grantedAt: r.grantedAt.getTime(),
      // null/missing (older relay) or empty → admin, mirroring enforcement.
      scopes: [...normalizeScopes(r.scopes)],
    }));
  }

  // The scopes a user holds on a daemon. The OWNER is admin implicitly → ALL
  // scopes. A grant row maps to its stored scopes (null/empty → admin, the
  // legacy total-access fail-safe). No owner + no row = the empty set (no access).
  async getUserDaemonScopes(
    workspaceId: string,
    daemonId: string,
    userId: string,
  ): Promise<Set<DaemonScope>> {
    const daemon = await this.db
      .select({ ownerId: schema.daemons.ownerId })
      .from(schema.daemons)
      .where(eq(schema.daemons.id, daemonId))
      .limit(1);
    if (daemon[0]?.ownerId === userId) return new Set<DaemonScope>(DAEMON_SCOPES);

    const [access] = await this.db
      .select({ scopes: schema.daemonAccess.scopes })
      .from(schema.daemonAccess)
      .where(
        and(
          eq(schema.daemonAccess.workspaceId, workspaceId),
          eq(schema.daemonAccess.daemonId, daemonId),
          eq(schema.daemonAccess.userId, userId),
        ),
      )
      .limit(1);
    if (!access) return new Set<DaemonScope>();
    return normalizeScopes(access.scopes);
  }

  // "Has ANY access" = holds at least one scope (owner, or a grant row). Preserved
  // for the many call-sites that only need a boolean reachability check.
  async canUserAccessDaemon(
    workspaceId: string,
    daemonId: string,
    userId: string,
  ): Promise<boolean> {
    return (await this.getUserDaemonScopes(workspaceId, daemonId, userId)).size > 0;
  }

  async hasAnyDaemonAccess(workspaceId: string, userId: string): Promise<boolean> {
    const [owned] = await this.db
      .select({ id: schema.daemons.id })
      .from(schema.daemons)
      .innerJoin(schema.workspaceDaemons, eq(schema.workspaceDaemons.daemonId, schema.daemons.id))
      .where(
        and(
          eq(schema.workspaceDaemons.workspaceId, workspaceId),
          eq(schema.daemons.ownerId, userId),
        ),
      )
      .limit(1);
    if (owned) return true;

    const [access] = await this.db
      .select({ userId: schema.daemonAccess.userId })
      .from(schema.daemonAccess)
      .where(
        and(
          eq(schema.daemonAccess.workspaceId, workspaceId),
          eq(schema.daemonAccess.userId, userId),
        ),
      )
      .limit(1);
    return !!access;
  }

  // ─── Daemon Access Requests (#705: REQUEST → NOTIFY → APPROVE) ───
  //
  // The inbound counterpart to the grant: a non-owner asks the daemon OWNER for
  // access at a requested set of scopes, the owner approves (runs setDaemonAccess)
  // or denies. One PENDING request per (workspace, daemon, requester) — the
  // partial unique index (status='pending') enforces it, mirroring invitations.
  // Owner-ness / forbidden gating lives at the relay+dispatcher, NOT here (this
  // layer is pure CRUD, same split as setDaemonAccess vs the relay owner gate).

  // Create a pending request. If a pending row already exists for this
  // (workspace, daemon, requester), RETURN it unchanged (the partial unique index
  // would otherwise raise) so re-requesting is idempotent and never stacks rows.
  // The requested scopes of an existing pending row are NOT overwritten — the
  // owner is already deciding on it; a fresh ask after approve/deny makes a new row.
  async createDaemonAccessRequest(req: {
    workspaceId: string;
    daemonId: string;
    requesterId: string;
    requesterName?: string | null;
    scopes: readonly string[];
  }): Promise<schema.DaemonAccessRequest> {
    const clean = [...new Set(req.scopes.filter(isDaemonScope))];
    const inserted = await this.db
      .insert(schema.daemonAccessRequests)
      .values({
        id: randomUUID(),
        workspaceId: req.workspaceId,
        daemonId: req.daemonId,
        requesterId: req.requesterId,
        requesterName: req.requesterName ?? null,
        scopes: clean,
        status: "pending",
      })
      // The partial unique index covers only pending rows, so a conflict means a
      // pending request already exists — do nothing and fall through to the read.
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return inserted[0];

    // Conflict path: return the existing pending row for this triple.
    const [existing] = await this.db
      .select()
      .from(schema.daemonAccessRequests)
      .where(
        and(
          eq(schema.daemonAccessRequests.workspaceId, req.workspaceId),
          eq(schema.daemonAccessRequests.daemonId, req.daemonId),
          eq(schema.daemonAccessRequests.requesterId, req.requesterId),
          eq(schema.daemonAccessRequests.status, "pending"),
        ),
      )
      .limit(1);
    if (existing) return existing;
    // Defensive: a non-unique-index conflict (shouldn't happen with this schema)
    // would leave no inserted row AND no pending row. Surface it rather than
    // returning a fabricated request the caller would broadcast.
    throw new Error("createDaemonAccessRequest: insert conflicted but no pending row found");
  }

  // List requests for a workspace, newest-first. Optional status / daemon filters.
  // The caller (relay/dispatcher) further narrows to "requests I own or sent".
  async listDaemonAccessRequests(
    workspaceId: string,
    opts?: { status?: "pending" | "approved" | "denied"; daemonId?: string },
  ): Promise<schema.DaemonAccessRequest[]> {
    const filters = [eq(schema.daemonAccessRequests.workspaceId, workspaceId)];
    if (opts?.status) filters.push(eq(schema.daemonAccessRequests.status, opts.status));
    if (opts?.daemonId) filters.push(eq(schema.daemonAccessRequests.daemonId, opts.daemonId));
    return this.db
      .select()
      .from(schema.daemonAccessRequests)
      .where(and(...filters))
      .orderBy(desc(schema.daemonAccessRequests.createdAt));
  }

  async getDaemonAccessRequestById(id: string): Promise<schema.DaemonAccessRequest | null> {
    const [row] = await this.db
      .select()
      .from(schema.daemonAccessRequests)
      .where(eq(schema.daemonAccessRequests.id, id))
      .limit(1);
    return row ?? null;
  }

  // Resolve a request (approve/deny). Stamps status + resolvedBy + resolvedAt.
  // The actual grant (setDaemonAccess) is the relay/dispatcher's job on approve —
  // this only flips the request row. Returns the updated row (null if id is gone).
  async resolveDaemonAccessRequest(
    id: string,
    decision: "approved" | "denied",
    resolvedBy: string,
  ): Promise<schema.DaemonAccessRequest | null> {
    // ATOMIC + idempotent: only match a row that is STILL `pending`, so two
    // concurrent approvals (or a double-click) can't both win — the first gets the
    // row back, later calls get null. Callers MUST resolve FIRST and only grant
    // when this returns a row, so the grant runs exactly once.
    const [updated] = await this.db
      .update(schema.daemonAccessRequests)
      .set({ status: decision, resolvedBy, resolvedAt: new Date() })
      .where(
        and(
          eq(schema.daemonAccessRequests.id, id),
          eq(schema.daemonAccessRequests.status, "pending"),
        ),
      )
      .returning();
    return updated ?? null;
  }

  // ─── Daemon Agents ──────────────────────────────────────────────

  async registerDaemonAgent(
    daemonId: string,
    agentId: string,
    workspaceId: string,
    provider: string,
    // The agent's live lifecycle ("idle"|"running"|"error"). Persisted as
    // daemon_agents.status so a CROSS-daemon client (which has no live handle on
    // the owning daemon) can resolve the agent's REAL status instead of falling
    // back to "unknown". When OMITTED (the list_agents backfill — it only proves
    // the agent↔daemon binding, not the live status), a new row seeds "idle" but
    // an EXISTING row keeps the status a prior live agent_status report set, so a
    // running agent isn't clobbered down to idle on a bare re-register.
    status?: string,
  ): Promise<void> {
    await this.db
      .insert(schema.daemonAgents)
      .values({ daemonId, agentId, workspaceId, provider, status: status ?? "idle" })
      .onConflictDoUpdate({
        target: [schema.daemonAgents.daemonId, schema.daemonAgents.agentId],
        // Only a real status report overwrites status; the backfill leaves it.
        set: status !== undefined ? { status, provider } : { provider },
      });
  }

  // All agent↔daemon bindings for a workspace, with their last-reported live
  // status. Used by the relay's list_agents finalize to resolve the lifecycle of
  // CROSS-daemon agents (an agent live on daemon B, listed by daemon A, has no
  // live handle on A so A reports lifecycle "unknown"). The relay owns this
  // table, so it is the authoritative cross-daemon status source.
  async getDaemonAgentsByWorkspace(
    workspaceId: string,
  ): Promise<{ daemonId: string; agentId: string; status: string }[]> {
    return this.db
      .select({
        daemonId: schema.daemonAgents.daemonId,
        agentId: schema.daemonAgents.agentId,
        status: schema.daemonAgents.status,
      })
      .from(schema.daemonAgents)
      .where(eq(schema.daemonAgents.workspaceId, workspaceId));
  }

  async removeDaemonAgent(daemonId: string, agentId: string): Promise<void> {
    await this.db
      .delete(schema.daemonAgents)
      .where(
        and(eq(schema.daemonAgents.daemonId, daemonId), eq(schema.daemonAgents.agentId, agentId)),
      );
  }

  async removeDaemonAgents(daemonId: string): Promise<void> {
    await this.db.delete(schema.daemonAgents).where(eq(schema.daemonAgents.daemonId, daemonId));
  }

  async getAgentDaemonId(agentId: string, workspaceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ daemonId: schema.daemonAgents.daemonId })
      .from(schema.daemonAgents)
      .where(
        and(
          eq(schema.daemonAgents.agentId, agentId),
          eq(schema.daemonAgents.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row?.daemonId ?? null;
  }

  // ─── Archived Sessions ──────────────────────────────────────────

  async archiveSession(s: {
    id: string;
    workspaceId: string;
    provider: string;
    providerHandleId: string;
    title: string | null;
    cwd: string | null;
    model: string | null;
    cyboId: string | null;
    archivedAt: number;
  }): Promise<void> {
    await this.db
      .insert(schema.archivedSessions)
      .values({
        id: s.id,
        workspaceId: s.workspaceId,
        provider: s.provider,
        providerHandleId: s.providerHandleId,
        title: s.title,
        cwd: s.cwd,
        model: s.model,
        cyboId: s.cyboId,
        archivedAt: new Date(s.archivedAt),
      })
      .onConflictDoNothing();
  }

  async getArchivedSessions(workspaceId: string): Promise<
    Array<{
      id: string;
      provider: string;
      providerHandleId: string;
      title: string | null;
      cwd: string | null;
      model: string | null;
      cyboId: string | null;
      archivedAt: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(schema.archivedSessions)
      .where(eq(schema.archivedSessions.workspaceId, workspaceId))
      .orderBy(desc(schema.archivedSessions.archivedAt));
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      providerHandleId: r.providerHandleId,
      title: r.title,
      cwd: r.cwd,
      model: r.model,
      cyboId: r.cyboId,
      // epoch ms (NOT ISO) — the client's ArchivedSession.archivedAt is a number
      // and the daemon path returns ms; an ISO string made `Date.now() - ts` NaN
      // ("NaNd ago").
      archivedAt: r.archivedAt.getTime(),
    }));
  }

  // Link an archived session to the live agent it was resumed into (keeps the
  // shared history row in sync with the daemon's SQLite — the row is NOT deleted
  // on resume anymore).
  async markArchivedSessionResumed(id: string, agentId: string): Promise<void> {
    await this.db
      .update(schema.archivedSessions)
      .set({ resumedAgentId: agentId })
      .where(eq(schema.archivedSessions.id, id));
  }

  // Send a resumed session back to history: clear the live link and refresh the
  // archived metadata + timestamp.
  async reviveArchivedSession(s: {
    id: string;
    providerHandleId: string;
    title: string | null;
    cwd: string | null;
    model: string | null;
    cyboId: string | null;
    archivedAt: number;
  }): Promise<void> {
    await this.db
      .update(schema.archivedSessions)
      .set({
        resumedAgentId: null,
        providerHandleId: s.providerHandleId,
        title: s.title,
        cwd: s.cwd,
        model: s.model,
        cyboId: s.cyboId,
        archivedAt: new Date(s.archivedAt),
      })
      .where(eq(schema.archivedSessions.id, s.id));
  }

  async deleteArchivedSession(id: string): Promise<void> {
    await this.db.delete(schema.archivedSessions).where(eq(schema.archivedSessions.id, id));
  }

  // ─── Agent bindings (durable session list) ───────────────────────
  // Mirror of the daemon's LOCAL SQLite agent_bindings (non-ephemeral only). The
  // relay's list_agents fan-out reads these as the OFFLINE fallback so a session
  // created on a daemon survives the daemon closing/restarting and stays visible
  // (resumable once the daemon is back). ephemeral rows are never written here.

  async upsertAgentBinding(b: {
    agentId: string;
    workspaceId: string;
    channelId: string | null;
    provider: string;
    model: string | null;
    systemPrompt: string | null;
    daemonId: string | null;
    cyboId: string | null;
    initiatedBy: string | null;
    initiatedByEmail: string | null;
    cwd: string | null;
    providerSessionId: string | null;
    // AUTONOMOUS (cron / scheduled / webhook) spawn — owner-scoped in the session
    // list (see agentBindingVisibleCore / offlineBindingVisible).
    autonomous: boolean;
  }): Promise<void> {
    await this.db
      .insert(schema.agentBindings)
      .values({
        agentId: b.agentId,
        workspaceId: b.workspaceId,
        channelId: b.channelId,
        provider: b.provider,
        model: b.model,
        systemPrompt: b.systemPrompt,
        daemonId: b.daemonId,
        cyboId: b.cyboId,
        initiatedBy: b.initiatedBy,
        initiatedByEmail: b.initiatedByEmail,
        cwd: b.cwd,
        providerSessionId: b.providerSessionId,
        autonomous: b.autonomous,
      })
      .onConflictDoUpdate({
        target: schema.agentBindings.agentId,
        set: {
          workspaceId: b.workspaceId,
          channelId: b.channelId,
          provider: b.provider,
          model: b.model,
          systemPrompt: b.systemPrompt,
          daemonId: b.daemonId,
          cyboId: b.cyboId,
          initiatedBy: b.initiatedBy,
          initiatedByEmail: b.initiatedByEmail,
          cwd: b.cwd,
          providerSessionId: b.providerSessionId,
          autonomous: b.autonomous,
          updatedAt: new Date(),
        },
      });
  }

  async updateAgentBindingModel(agentId: string, model: string | null): Promise<void> {
    await this.db
      .update(schema.agentBindings)
      .set({ model, updatedAt: new Date() })
      .where(eq(schema.agentBindings.agentId, agentId));
  }

  async updateAgentBindingSession(
    agentId: string,
    providerSessionId: string | null,
  ): Promise<void> {
    await this.db
      .update(schema.agentBindings)
      .set({ providerSessionId, updatedAt: new Date() })
      .where(eq(schema.agentBindings.agentId, agentId));
  }

  async deleteAgentBinding(agentId: string): Promise<void> {
    await this.db.delete(schema.agentBindings).where(eq(schema.agentBindings.agentId, agentId));
  }

  // GC the REQUESTING owner's stale bindings on a now-online daemon (#810 dup
  // sessions). The relay's list_agents fan-out is answered by the daemon with a
  // PER-USER filtered list (dispatcher.handleListAgents applies the
  // agentBindingVisibleCore rule), so `liveAgentIds` is NOT the daemon's complete
  // live set — it is the complete set of THIS user's VISIBLE live agents on that
  // daemon. Pruning daemon-wide would therefore delete a PEER's live PRIVATE
  // binding (which is, by design, absent from this user's list); pruning SCOPED to
  // the requesting owner is restart-safe — every row we touch is one this same
  // user can see live in the very response that drives the prune, so a binding NOT
  // in `liveAgentIds` is genuinely a dead/orphaned session of theirs (e.g. a PG
  // mirror row left behind by a SQLite-cache reset or a failed delete sync).
  //
  // Ownership is matched the SAME way the offline visibility filter matches it:
  // the GLOBAL account id (a cloud-forwarded session stamps initiated_by = the
  // global id) OR the real initiated_by_email (a session created on the owner's
  // own daemon). An EMPTY liveAgentIds is a NO-OP (returns 0): an empty response
  // is ambiguous/transient and must never delete-all (the caller also skips the GC
  // for an empty list — see shouldGcOwnerBindings). Returns the rows deleted.
  async deleteStaleAgentBindingsForOwner(opts: {
    daemonId: string;
    workspaceId: string;
    liveAgentIds: string[];
    ownerGlobalId: string | null;
    ownerEmail: string | null;
  }): Promise<number> {
    // Defense-in-depth: an EMPTY live set must NEVER trigger a "delete every
    // binding of this owner on the daemon" — an empty list_agents response is
    // ambiguous (transient daemon error / cold start), and the caller is supposed
    // to skip the GC entirely in that case (shouldGcOwnerBindings). Refuse here too
    // so the dangerous delete-all branch can never fire.
    if (opts.liveAgentIds.length === 0) return 0;
    const ownerPreds = [];
    if (opts.ownerGlobalId) {
      ownerPreds.push(eq(schema.agentBindings.initiatedBy, opts.ownerGlobalId));
    }
    if (opts.ownerEmail) {
      ownerPreds.push(
        sql`lower(${schema.agentBindings.initiatedByEmail}) = ${opts.ownerEmail.toLowerCase()}`,
      );
    }
    // No owner identity to scope by → NEVER prune (refuse to touch anything we
    // can't attribute to the requester — the restart-safety invariant).
    if (ownerPreds.length === 0) return 0;
    const result = await this.db
      .delete(schema.agentBindings)
      .where(
        and(
          eq(schema.agentBindings.daemonId, opts.daemonId),
          eq(schema.agentBindings.workspaceId, opts.workspaceId),
          notInArray(schema.agentBindings.agentId, opts.liveAgentIds),
          or(...ownerPreds),
        ),
      );
    return result.rowCount ?? 0;
  }

  // Single mirrored binding by agentId. Used by the relay's OFFLINE archive path
  // (#810): when the owning daemon is asleep the relay can't forward the archive,
  // so it reads the binding here to authorize the caller (owner/admin or the
  // session initiator) and then clears the row itself. Returns null when absent.
  async getAgentBinding(agentId: string): Promise<{
    agentId: string;
    workspaceId: string;
    channelId: string | null;
    provider: string;
    model: string | null;
    systemPrompt: string | null;
    daemonId: string | null;
    cyboId: string | null;
    initiatedBy: string | null;
    initiatedByEmail: string | null;
    cwd: string | null;
    providerSessionId: string | null;
  } | null> {
    const rows = await this.db
      .select()
      .from(schema.agentBindings)
      .where(eq(schema.agentBindings.agentId, agentId))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      agentId: r.agentId,
      workspaceId: r.workspaceId,
      channelId: r.channelId,
      provider: r.provider,
      model: r.model,
      systemPrompt: r.systemPrompt,
      daemonId: r.daemonId,
      cyboId: r.cyboId,
      initiatedBy: r.initiatedBy,
      initiatedByEmail: r.initiatedByEmail,
      cwd: r.cwd,
      providerSessionId: r.providerSessionId,
    };
  }

  // Offline fallback for the relay's list_agents fan-out: every mirrored binding
  // in the workspace. The relay dedupes these against the live daemon rows (live
  // wins) and applies the same private-session visibility filter via
  // initiatedByEmail. Ephemeral rows are never mirrored, so none appear here.
  async getAgentBindingsByWorkspace(workspaceId: string): Promise<
    Array<{
      agentId: string;
      workspaceId: string;
      channelId: string | null;
      provider: string;
      model: string | null;
      systemPrompt: string | null;
      daemonId: string | null;
      cyboId: string | null;
      initiatedBy: string | null;
      initiatedByEmail: string | null;
      cwd: string | null;
      providerSessionId: string | null;
      autonomous: boolean;
    }>
  > {
    const rows = await this.db
      .select()
      .from(schema.agentBindings)
      .where(eq(schema.agentBindings.workspaceId, workspaceId));
    return rows.map((r) => ({
      agentId: r.agentId,
      workspaceId: r.workspaceId,
      channelId: r.channelId,
      provider: r.provider,
      model: r.model,
      systemPrompt: r.systemPrompt,
      daemonId: r.daemonId,
      cyboId: r.cyboId,
      initiatedBy: r.initiatedBy,
      initiatedByEmail: r.initiatedByEmail,
      cwd: r.cwd,
      providerSessionId: r.providerSessionId,
      autonomous: r.autonomous,
    }));
  }

  // ─── Cybos ───────────────────────────────────────────────────────

  async createCybo(opts: {
    id: string;
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
  }): Promise<void> {
    await this.db.insert(schema.cybos).values({
      id: opts.id,
      workspaceId: opts.workspaceId,
      slug: opts.slug,
      name: opts.name,
      description: opts.description ?? null,
      avatar: opts.avatar ?? null,
      role: opts.role ?? null,
      soul: opts.soul,
      provider: opts.provider,
      model: opts.model ?? null,
      mcpServers: opts.mcpServers ?? null,
      // Composio grants — only written when present so a cybo create never
      // references the (additive) tool_grants column if migration 0043 hasn't
      // been applied yet. Normal creates stay byte-identical.
      ...(opts.toolGrants != null ? { toolGrants: opts.toolGrants } : {}),
      llmAuthMode: opts.llmAuthMode ?? "cli",
      behaviorMode: opts.behaviorMode ?? "responsive",
      homeDaemonId: opts.homeDaemonId ?? null,
      autonomyLevel: opts.autonomyLevel ?? null,
      monthlySpendCap: opts.monthlySpendCap ?? null,
      platformPermissions: opts.platformPermissions ?? [],
      isDefault: opts.isDefault ?? false,
      createdBy: opts.createdBy,
    });
  }

  async getCybos(workspaceId: string): Promise<StoredCybo[]> {
    // "Last active" per cybo = max(agent_sessions.updated_at) for that cybo in
    // this workspace. Grouped subquery (one row per cybo_id) LEFT JOINed onto
    // cybos, so a cybo with no sessions yields a null lastActive (→ null on the
    // wire, never 0). cybo_id is nullable on agent_sessions (non-cybo sessions),
    // so the subquery filters it out — its null-key bucket would never match a
    // cybo id anyway. See idx_agent_sessions_cybo (migration 0027) for the index
    // backing this GROUP BY.
    const lastActive = this.db
      .select({
        cyboId: schema.agentSessions.cyboId,
        lastActive: sql<Date | null>`max(${schema.agentSessions.updatedAt})`.as("last_active"),
      })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.workspaceId, workspaceId),
          isNotNull(schema.agentSessions.cyboId),
        ),
      )
      .groupBy(schema.agentSessions.cyboId)
      .as("la");

    const rows = await this.db
      .select({ cybo: schema.cybos, lastActive: lastActive.lastActive })
      .from(schema.cybos)
      .leftJoin(lastActive, eq(lastActive.cyboId, schema.cybos.id))
      .where(eq(schema.cybos.workspaceId, workspaceId))
      .orderBy(desc(schema.cybos.isDefault), asc(schema.cybos.name));

    return rows.map((r) => {
      const cybo = this.mapCybo(r.cybo);
      // The max(updated_at) aggregate is returned as a STRING at runtime (the
      // timestamptz parser is NOT applied to the subquery-aliased column, despite
      // the sql<Date|null> annotation), so the old r.lastActive.getTime() threw
      // "getTime is not a function" and crashed getCybos — which broke mcp:list
      // (token identities), cybo spawn, assignee resolution, daemon-access, etc.
      // Coerce via new Date() (accepts string|Date), NaN-guarded.
      const lastActiveMs = r.lastActive ? new Date(r.lastActive).getTime() : null;
      cybo.last_active_at =
        lastActiveMs !== null && !Number.isNaN(lastActiveMs) ? lastActiveMs : null;
      return cybo;
    });
  }

  async updateCybo(
    id: string,
    updates: Partial<{
      name: string;
      description: string | null;
      avatar: string | null;
      role: string | null;
      soul: string;
      provider: string;
      model: string | null;
      mcpServers: Record<string, unknown> | null;
      toolGrants: Record<string, unknown> | null;
      llmAuthMode: string;
      behaviorMode: string;
      homeDaemonId: string | null;
      autonomyLevel: string | null;
      monthlySpendCap: number | null;
      platformPermissions: string[];
    }>,
  ): Promise<void> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.description !== undefined) set.description = updates.description;
    if (updates.avatar !== undefined) set.avatar = updates.avatar;
    if (updates.role !== undefined) set.role = updates.role;
    if (updates.soul !== undefined) set.soul = updates.soul;
    if (updates.provider !== undefined) set.provider = updates.provider;
    if (updates.model !== undefined) set.model = updates.model;
    if (updates.mcpServers !== undefined) set.mcpServers = updates.mcpServers;
    if (updates.toolGrants !== undefined) set.toolGrants = updates.toolGrants;
    if (updates.llmAuthMode !== undefined) set.llmAuthMode = updates.llmAuthMode;
    if (updates.behaviorMode !== undefined) set.behaviorMode = updates.behaviorMode;
    if (updates.homeDaemonId !== undefined) set.homeDaemonId = updates.homeDaemonId;
    if (updates.autonomyLevel !== undefined) set.autonomyLevel = updates.autonomyLevel;
    if (updates.monthlySpendCap !== undefined) set.monthlySpendCap = updates.monthlySpendCap;
    if (updates.platformPermissions !== undefined)
      set.platformPermissions = updates.platformPermissions;

    await this.db.update(schema.cybos).set(set).where(eq(schema.cybos.id, id));
  }

  async deleteCybo(id: string): Promise<void> {
    await this.db.delete(schema.cybos).where(eq(schema.cybos.id, id));
  }

  // ─── Audit ───────────────────────────────────────────────────────

  async audit(opts: {
    id: string;
    workspaceId: string;
    actorId: string;
    actorType: string;
    action: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      id: opts.id,
      workspaceId: opts.workspaceId,
      actorId: opts.actorId,
      actorType: opts.actorType,
      action: opts.action,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      details: opts.details ?? null,
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  async close(): Promise<void> {
    await closePool();
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  private mapMessage(r: typeof schema.messages.$inferSelect): StoredMessage {
    return {
      id: r.id,
      workspace_id: r.workspaceId,
      channel_id: r.channelId,
      from_id: r.fromId,
      from_type: r.fromType as "human" | "agent" | "system",
      from_name: r.fromName ?? null,
      to_id: r.toId,
      text: r.text,
      mentions: r.mentions ? JSON.stringify(r.mentions) : null,
      parent_id: r.parentId,
      attachments: r.attachments ? JSON.stringify(r.attachments) : null,
      reactions: r.reactions ?? null,
      unfurls: r.unfurls ?? null,
      card: r.card ?? null,
      pinned_at: r.pinnedAt?.getTime() ?? null,
      pinned_by: r.pinnedBy ?? null,
      source: r.source ?? null,
      seq: r.seq,
      created_at: r.createdAt.getTime(),
      updated_at: r.updatedAt?.getTime() ?? null,
    };
  }

  async setPinned(messageId: string, pinnedBy: string | null): Promise<void> {
    await this.db
      .update(schema.messages)
      .set({ pinnedAt: pinnedBy ? new Date() : null, pinnedBy })
      .where(eq(schema.messages.id, messageId));
  }

  // ─── Saved messages (#609 — personal bookmarks) ──────────────────
  // A PRIVATE per-user bookmark, distinct from channel pins (setPinned, above).
  // Idempotent: a re-save on the same (user, message) is a no-op via the
  // composite-PK conflict. Returns nothing — the toggle's resulting state is
  // authoritative from the boolean the caller passed.
  async saveMessage(userId: string, messageId: string): Promise<void> {
    await this.db
      .insert(schema.savedMessages)
      .values({ userId, messageId })
      .onConflictDoNothing({
        target: [schema.savedMessages.userId, schema.savedMessages.messageId],
      });
  }

  async unsaveMessage(userId: string, messageId: string): Promise<void> {
    await this.db
      .delete(schema.savedMessages)
      .where(
        and(eq(schema.savedMessages.userId, userId), eq(schema.savedMessages.messageId, messageId)),
      );
  }

  // The caller's saved messages in ONE workspace, newest-saved first. Joins the
  // bookmark rows to their messages and scopes to the workspace (a user can have
  // saves across many workspaces; the "Saved" view is per-workspace). Tombstoned
  // messages (deleted_at set) are dropped so an unsaved-then-deleted note never
  // surfaces. Returns full StoredMessage rows so the UI renders + links them.
  async getSavedMessages(userId: string, workspaceId: string): Promise<StoredMessage[]> {
    const rows = await this.db
      .select({ message: schema.messages })
      .from(schema.savedMessages)
      .innerJoin(schema.messages, eq(schema.savedMessages.messageId, schema.messages.id))
      .where(
        and(
          eq(schema.savedMessages.userId, userId),
          eq(schema.messages.workspaceId, workspaceId),
          isNull(schema.messages.deletedAt),
        ),
      )
      .orderBy(desc(schema.savedMessages.createdAt));
    return rows.map((r) => this.mapMessage(r.message));
  }

  async markRead(
    workspaceId: string,
    userId: string,
    channelId: string,
    lastReadAt: number,
  ): Promise<void> {
    await this.db
      .insert(schema.messageReads)
      .values({ workspaceId, userId, channelId, lastReadAt: new Date(lastReadAt) })
      .onConflictDoUpdate({
        target: [schema.messageReads.userId, schema.messageReads.channelId],
        set: { lastReadAt: new Date(lastReadAt), workspaceId },
      });
  }

  // The caller's last_read_at for one channel as epoch ms, or null if never read
  // (→ /catchup digests the channel from the start). Drives the unread cursor.
  async getChannelLastRead(userId: string, channelId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ lastReadAt: schema.messageReads.lastReadAt })
      .from(schema.messageReads)
      .where(
        and(eq(schema.messageReads.userId, userId), eq(schema.messageReads.channelId, channelId)),
      )
      .limit(1);
    return row?.lastReadAt ? row.lastReadAt.getTime() : null;
  }

  // Top-level, non-deleted channel messages created AFTER `sinceMs`, oldest-first
  // — the unread slice /catchup digests. The relay embeds this in the cloud
  // forward (PG-blind daemon). Mirrors CyborgStorage.getChannelMessagesSince.
  async getChannelMessagesSince(
    channelId: string,
    sinceMs: number,
    limit = 500,
  ): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelId, channelId),
          isNull(schema.messages.parentId),
          isNull(schema.messages.deletedAt),
          gt(schema.messages.createdAt, new Date(sinceMs)),
        ),
      )
      .orderBy(schema.messages.createdAt, schema.messages.seq)
      .limit(limit);
    return rows.map(this.mapMessage);
  }

  async insertActivityEvent(e: {
    id: string;
    workspaceId: string;
    userId: string;
    eventType: string;
    sourceType: string;
    sourceId: string;
    channelId?: string | null;
    dmPeerId?: string | null;
    previewText?: string | null;
    actorId?: string | null;
    actorName?: string | null;
    createdAt: number;
  }): Promise<void> {
    await this.db
      .insert(schema.activityEvents)
      .values({
        id: e.id,
        workspaceId: e.workspaceId,
        userId: e.userId,
        eventType: e.eventType,
        sourceType: e.sourceType,
        sourceId: e.sourceId,
        channelId: e.channelId ?? null,
        dmPeerId: e.dmPeerId ?? null,
        previewText: e.previewText ?? null,
        actorId: e.actorId ?? null,
        actorName: e.actorName ?? null,
        createdAt: new Date(e.createdAt),
      })
      .onConflictDoNothing();
  }

  async setNotificationPref(
    workspaceId: string,
    userId: string,
    scopeId: string,
    preference: string,
  ): Promise<void> {
    await this.db
      .insert(schema.notificationPrefs)
      .values({ workspaceId, userId, scopeId, preference })
      .onConflictDoUpdate({
        target: [schema.notificationPrefs.userId, schema.notificationPrefs.scopeId],
        set: { preference, workspaceId },
      });
  }

  async markActivityRead(eventId: string, userId: string): Promise<void> {
    await this.db
      .update(schema.activityEvents)
      .set({ isRead: true })
      .where(and(eq(schema.activityEvents.id, eventId), eq(schema.activityEvents.userId, userId)));
  }

  async markAllActivityRead(workspaceId: string, userId: string): Promise<void> {
    await this.db
      .update(schema.activityEvents)
      .set({ isRead: true })
      .where(
        and(
          eq(schema.activityEvents.workspaceId, workspaceId),
          eq(schema.activityEvents.userId, userId),
        ),
      );
  }

  // ─── Chat-port reads (cloud gateway): unread / reads / activity / prefs /
  // threads. Mirror the SQLite queries in storage.ts but against PG; timestamps
  // are returned as epoch ms so the shapes match the daemon path 1:1.

  // Per-channel unread: top-level, non-deleted messages newer than the user's
  // last_read (or all if never read), excluding their own.
  async getUnreadCounts(workspaceId: string, userId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ channelId: schema.messages.channelId, count: sql<number>`COUNT(*)` })
      .from(schema.messages)
      .leftJoin(
        schema.messageReads,
        and(
          eq(schema.messageReads.userId, userId),
          eq(schema.messageReads.channelId, schema.messages.channelId),
        ),
      )
      .where(
        and(
          eq(schema.messages.workspaceId, workspaceId),
          isNotNull(schema.messages.channelId),
          isNull(schema.messages.parentId),
          isNull(schema.messages.deletedAt),
          // A webhook/automation card is injected under its creator's user id but
          // is NOT their own typing, so it must still count as unread for them
          // (matches the client notify/divider rule that source==="webhook" is
          // not a self-send). Exclude only genuine self-sends.
          sql`(${schema.messages.fromId} <> ${userId} OR ${schema.messages.source} = 'webhook')`,
          // Only badge ACTIVE channels the user actually belongs to. Without
          // this, a message in a channel the user isn't a member of (e.g. a
          // system "X joined" post in a channel they can't even open), or in a
          // channel that has since been archived/soft-deleted, produces a
          // phantom unread that can never be cleared — the channel isn't in
          // their sidebar (getChannelsForUser excludes deleted + archived), so
          // there's no way to mark it read.
          exists(
            this.db
              .select({ one: sql`1` })
              .from(schema.channelMembers)
              .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMembers.channelId))
              .where(
                and(
                  eq(schema.channelMembers.channelId, schema.messages.channelId),
                  eq(schema.channelMembers.userId, userId),
                  isNull(schema.channels.deletedAt),
                  eq(schema.channels.isArchived, false),
                ),
              ),
          ),
          // System posts (join/leave/etc.) are noise, not unread messages —
          // Slack/Mattermost don't badge them either.
          sql`${schema.messages.fromType} <> 'system'`,
          sql`${schema.messages.createdAt} > COALESCE(${schema.messageReads.lastReadAt}, to_timestamp(0))`,
        ),
      )
      .groupBy(schema.messages.channelId);
    const out: Record<string, number> = {};
    for (const r of rows) if (r.channelId) out[r.channelId] = Number(r.count);
    return out;
  }

  // BUG #2: per-channel MENTION count → the RED numeric badge. Mirrors
  // getUnreadCounts (top-level, non-deleted, newer than the user's read cursor,
  // not their own) but additionally requires the message to MENTION this user,
  // by EITHER:
  //   (a) the `mentions` jsonb array CONTAINING this userId (an explicit @user —
  //       the client's resolveMentions writes resolved member ids here), OR
  //   (b) the TEXT containing a group token (@everyone / @here / @channel) — the
  //       client does NOT expand these into mentions[] (resolveMentions only maps
  //       @name → a known member id), so they must be matched in text to stay in
  //       parity with the live path's hasMention() group-token rule.
  // Guard the jsonb containment with a typeof check (mirrors getChannelFileCount)
  // so a bad non-array row can never crash the query; null mentions just don't
  // match. The whole mention test is wrapped in OR so a group-token-only message
  // (mentions = null) still counts.
  async getMentionCounts(workspaceId: string, userId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ channelId: schema.messages.channelId, count: sql<number>`COUNT(*)` })
      .from(schema.messages)
      .leftJoin(
        schema.messageReads,
        and(
          eq(schema.messageReads.userId, userId),
          eq(schema.messageReads.channelId, schema.messages.channelId),
        ),
      )
      .where(
        and(
          eq(schema.messages.workspaceId, workspaceId),
          isNotNull(schema.messages.channelId),
          isNull(schema.messages.parentId),
          isNull(schema.messages.deletedAt),
          // A webhook/automation card is injected under its creator's user id but
          // is NOT their own typing, so it must still count as unread for them
          // (matches the client notify/divider rule that source==="webhook" is
          // not a self-send). Exclude only genuine self-sends.
          sql`(${schema.messages.fromId} <> ${userId} OR ${schema.messages.source} = 'webhook')`,
          // Mirror getUnreadCounts: the red numeric badge is seeded from
          // mentionCounts, so it needs the same guards. A group token
          // (@everyone/@here/@channel) is matched in TEXT below and would
          // otherwise match in ANY workspace channel regardless of membership —
          // producing a phantom red badge in a non-member or archived/deleted
          // channel that can never be cleared (not in the sidebar to open).
          exists(
            this.db
              .select({ one: sql`1` })
              .from(schema.channelMembers)
              .innerJoin(schema.channels, eq(schema.channels.id, schema.channelMembers.channelId))
              .where(
                and(
                  eq(schema.channelMembers.channelId, schema.messages.channelId),
                  eq(schema.channelMembers.userId, userId),
                  isNull(schema.channels.deletedAt),
                  eq(schema.channels.isArchived, false),
                ),
              ),
          ),
          // System posts (join/leave/etc.) never count as mentions.
          sql`${schema.messages.fromType} <> 'system'`,
          sql`${schema.messages.createdAt} > COALESCE(${schema.messageReads.lastReadAt}, to_timestamp(0))`,
          or(
            and(
              sql`jsonb_typeof(${schema.messages.mentions}) = 'array'`,
              sql`${schema.messages.mentions} @> to_jsonb(${userId}::text)`,
            ),
            sql`${schema.messages.text} LIKE '%@everyone%'`,
            sql`${schema.messages.text} LIKE '%@here%'`,
            sql`${schema.messages.text} LIKE '%@channel%'`,
          ),
        ),
      )
      .groupBy(schema.messages.channelId);
    const out: Record<string, number> = {};
    for (const r of rows) if (r.channelId) out[r.channelId] = Number(r.count);
    return out;
  }

  async getReadsForUser(workspaceId: string, userId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({
        channelId: schema.messageReads.channelId,
        lastReadAt: schema.messageReads.lastReadAt,
      })
      .from(schema.messageReads)
      .where(
        and(
          eq(schema.messageReads.userId, userId),
          eq(schema.messageReads.workspaceId, workspaceId),
        ),
      );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.channelId] = r.lastReadAt.getTime();
    return out;
  }

  // ─── P2 Item 12: DM read cursors (the DM analogue of the channel reads above) ─

  // Upsert the user's last-read cursor for a DM peer. Monotonic at the relay
  // layer is enforced by callers; here we just take the latest write.
  async markDmRead(
    workspaceId: string,
    userId: string,
    peerId: string,
    lastReadAt: number,
  ): Promise<void> {
    await this.db
      .insert(schema.dmReads)
      .values({ workspaceId, userId, peerId, lastReadAt: new Date(lastReadAt) })
      .onConflictDoUpdate({
        target: [schema.dmReads.workspaceId, schema.dmReads.userId, schema.dmReads.peerId],
        set: { lastReadAt: new Date(lastReadAt) },
      });
  }

  // peerId → lastReadAt (epoch ms). Frozen-divider snapshot source for DMs.
  async getDmReadsForUser(workspaceId: string, userId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ peerId: schema.dmReads.peerId, lastReadAt: schema.dmReads.lastReadAt })
      .from(schema.dmReads)
      .where(and(eq(schema.dmReads.userId, userId), eq(schema.dmReads.workspaceId, workspaceId)));
    const out: Record<string, number> = {};
    for (const r of rows) out[r.peerId] = r.lastReadAt.getTime();
    return out;
  }

  // peerId → unread count: DM messages the peer sent ME (channel_id null, top-
  // level, not deleted) newer than my dm_reads cursor for that peer.
  async getDmUnreadCounts(workspaceId: string, userId: string): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ peerId: schema.messages.fromId, count: sql<number>`COUNT(*)` })
      .from(schema.messages)
      .leftJoin(
        schema.dmReads,
        and(
          eq(schema.dmReads.workspaceId, workspaceId),
          eq(schema.dmReads.userId, userId),
          eq(schema.dmReads.peerId, schema.messages.fromId),
        ),
      )
      .where(
        and(
          eq(schema.messages.workspaceId, workspaceId),
          isNull(schema.messages.channelId),
          isNull(schema.messages.parentId),
          isNull(schema.messages.deletedAt),
          eq(schema.messages.toId, userId),
          // A webhook/automation card is injected under its creator's user id but
          // is NOT their own typing, so it must still count as unread for them
          // (matches the client notify/divider rule that source==="webhook" is
          // not a self-send). Exclude only genuine self-sends.
          sql`(${schema.messages.fromId} <> ${userId} OR ${schema.messages.source} = 'webhook')`,
          sql`${schema.messages.createdAt} > COALESCE(${schema.dmReads.lastReadAt}, to_timestamp(0))`,
        ),
      )
      .groupBy(schema.messages.fromId);
    const out: Record<string, number> = {};
    for (const r of rows) if (r.peerId) out[r.peerId] = Number(r.count);
    return out;
  }

  async getNotificationPrefs(workspaceId: string, userId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({
        scopeId: schema.notificationPrefs.scopeId,
        preference: schema.notificationPrefs.preference,
      })
      .from(schema.notificationPrefs)
      .where(
        and(
          eq(schema.notificationPrefs.userId, userId),
          eq(schema.notificationPrefs.workspaceId, workspaceId),
        ),
      );
    const out: Record<string, string> = {};
    for (const r of rows) out[r.scopeId] = r.preference;
    return out;
  }

  // ─── Composer drafts (server-side draft sync, #610) ──────────────
  // Upsert the caller's draft for a (workspace, scope). One row per conversation
  // per user (PK user_id+scope), so a re-save overwrites in place rather than
  // duplicating. `updatedAt` is the CLIENT's edit time — it's the reconcile
  // tiebreaker the client uses (newest wins) on workspace load, so we must
  // persist exactly what the client sent (NOT now()), or PG would disagree with
  // the SQLite mirror and break cross-device conflict resolution. Falls back to
  // now() only when the client omits it.
  async setDraft(opts: {
    workspaceId: string;
    userId: string;
    scope: string;
    text: string;
    updatedAt?: Date;
  }): Promise<void> {
    const updatedAt = opts.updatedAt ?? new Date();
    await this.db
      .insert(schema.drafts)
      .values({
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        scope: opts.scope,
        text: opts.text,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [schema.drafts.userId, schema.drafts.scope],
        set: { text: opts.text, workspaceId: opts.workspaceId, updatedAt },
      });
  }

  // Delete the caller's draft for a (workspace, scope) — on send or explicit
  // clear. A no-op if the row is already gone (idempotent).
  async clearDraft(workspaceId: string, userId: string, scope: string): Promise<void> {
    await this.db
      .delete(schema.drafts)
      .where(
        and(
          eq(schema.drafts.userId, userId),
          eq(schema.drafts.scope, scope),
          eq(schema.drafts.workspaceId, workspaceId),
        ),
      );
  }

  // All of a user's drafts in a workspace, for seeding a fresh device on
  // workspace load. `updatedAt` is returned as epoch ms so the reconcile shape
  // matches the daemon path and the client clock 1:1.
  async getDrafts(
    workspaceId: string,
    userId: string,
  ): Promise<Array<{ scope: string; text: string; updatedAt: number }>> {
    const rows = await this.db
      .select({
        scope: schema.drafts.scope,
        text: schema.drafts.text,
        updatedAt: schema.drafts.updatedAt,
      })
      .from(schema.drafts)
      .where(and(eq(schema.drafts.userId, userId), eq(schema.drafts.workspaceId, workspaceId)));
    return rows.map((r) => ({ scope: r.scope, text: r.text, updatedAt: r.updatedAt.getTime() }));
  }

  // Notification preference of every user who set one for a given scope (channelId).
  // Used by the push dispatcher to honor mute / mentions_only per recipient.
  async getNotificationPrefsForScope(
    workspaceId: string,
    scopeId: string,
  ): Promise<Map<string, string>> {
    const rows = await this.db
      .select({
        userId: schema.notificationPrefs.userId,
        preference: schema.notificationPrefs.preference,
      })
      .from(schema.notificationPrefs)
      .where(
        and(
          eq(schema.notificationPrefs.workspaceId, workspaceId),
          eq(schema.notificationPrefs.scopeId, scopeId),
        ),
      );
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.userId, r.preference);
    return out;
  }

  async getActivity(
    workspaceId: string,
    userId: string,
    opts?: { limit?: number; before?: number; unreadOnly?: boolean },
  ): Promise<StoredActivityEvent[]> {
    const limit = Math.min(opts?.limit ?? 40, 100);
    const conds = [
      eq(schema.activityEvents.workspaceId, workspaceId),
      eq(schema.activityEvents.userId, userId),
    ];
    if (opts?.unreadOnly) conds.push(eq(schema.activityEvents.isRead, false));
    if (opts?.before != null) {
      conds.push(lt(schema.activityEvents.createdAt, new Date(opts.before)));
    }
    const rows = await this.db
      .select()
      .from(schema.activityEvents)
      .where(and(...conds))
      .orderBy(desc(schema.activityEvents.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      workspace_id: r.workspaceId,
      user_id: r.userId,
      event_type: r.eventType,
      source_type: r.sourceType,
      source_id: r.sourceId,
      channel_id: r.channelId,
      // Expose dm_peer_id so the client can build/dedupe DM-originated activity
      // items and clear them on DM read (P2 Item 9, server-authoritative seed).
      dm_peer_id: r.dmPeerId,
      preview_text: r.previewText,
      actor_id: r.actorId,
      actor_name: r.actorName,
      is_read: r.isRead ? 1 : 0,
      created_at: r.createdAt.getTime(),
    }));
  }

  async getUnreadActivityCount(workspaceId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({ c: sql<number>`COUNT(*)` })
      .from(schema.activityEvents)
      .where(
        and(
          eq(schema.activityEvents.workspaceId, workspaceId),
          eq(schema.activityEvents.userId, userId),
          eq(schema.activityEvents.isRead, false),
        ),
      );
    return Number(rows[0]?.c ?? 0);
  }

  async getThreadReplies(parentId: string): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.parentId, parentId), isNull(schema.messages.deletedAt)))
      .orderBy(asc(schema.messages.createdAt));
    return rows.map(this.mapMessage);
  }

  // Derived reply count + last reply time per root id (non-deleted replies only).
  // Derived, not the stored threads.reply_count, so deletes self-correct and the
  // count never drifts. Used to attach the thread footer on channel fetch.
  async getReplyCountsForRoots(
    rootIds: string[],
  ): Promise<Map<string, { replyCount: number; lastReplyAt: number }>> {
    const m = new Map<string, { replyCount: number; lastReplyAt: number }>();
    if (rootIds.length === 0) return m;
    const rows = await this.db
      .select({
        parentId: schema.messages.parentId,
        c: sql<number>`count(*)::int`,
        lastAt: sql<number>`extract(epoch from max(${schema.messages.createdAt})) * 1000`,
      })
      .from(schema.messages)
      .where(and(inArray(schema.messages.parentId, rootIds), isNull(schema.messages.deletedAt)))
      .groupBy(schema.messages.parentId);
    for (const r of rows) {
      if (r.parentId) m.set(r.parentId, { replyCount: Number(r.c), lastReplyAt: Number(r.lastAt) });
    }
    return m;
  }

  // ─── Threads (CRT) ──────────────────────────────────────────────
  // Maintain the threads + thread_memberships aggregates when a reply is
  // inserted. Returns the follower user ids (for per-follower WS emission).
  // unread_replies is NEVER stored — derived from last_viewed (see getThreads).
  async maintainThreadOnReply(opts: {
    rootId: string;
    workspaceId: string;
    channelId: string | null;
    authorId: string;
    mentionedUserIds: string[];
    replyAt: number;
  }): Promise<{ followers: string[] }> {
    const at = new Date(opts.replyAt).toISOString();
    // Thread aggregate: reply_count++, last_reply_at, dedup-append author.
    await this.db.execute(sql`
      INSERT INTO threads (root_id, workspace_id, channel_id, reply_count, last_reply_at, participants)
      VALUES (${opts.rootId}, ${opts.workspaceId}, ${opts.channelId}, 1, ${at}, ${JSON.stringify([opts.authorId])}::jsonb)
      ON CONFLICT (root_id) DO UPDATE SET
        reply_count = threads.reply_count + 1,
        last_reply_at = ${at},
        participants = (
          SELECT COALESCE(jsonb_agg(DISTINCT p), '[]'::jsonb)
          FROM (SELECT jsonb_array_elements_text(threads.participants) AS p
                UNION ALL SELECT ${opts.authorId}) s
        )
    `);
    // Author auto-follows and is marked read up to their own reply.
    await this.db.execute(sql`
      INSERT INTO thread_memberships (root_id, user_id, workspace_id, following, last_viewed, unread_mentions, last_updated)
      VALUES (${opts.rootId}, ${opts.authorId}, ${opts.workspaceId}, true, ${at}, 0, ${at})
      ON CONFLICT (root_id, user_id) DO UPDATE SET following = true, last_viewed = ${at}, last_updated = ${at}
    `);
    // Mentioned users follow + get a mention bump (create at epoch-0 last_viewed
    // so their unread_replies counts everything until they open it). One bulk
    // INSERT instead of one round-trip per mention (N+1). Dedup so a user
    // mentioned twice in the same reply gets +1, not +2, and so a single
    // statement never tries to ON CONFLICT the same row twice (which errors).
    const mentioned = [...new Set(opts.mentionedUserIds)].filter((uid) => uid !== opts.authorId);
    if (mentioned.length > 0) {
      const rows = mentioned.map(
        (uid) =>
          sql`(${opts.rootId}, ${uid}, ${opts.workspaceId}, true, to_timestamp(0), 1, ${at})`,
      );
      await this.db.execute(sql`
        INSERT INTO thread_memberships (root_id, user_id, workspace_id, following, last_viewed, unread_mentions, last_updated)
        VALUES ${sql.join(rows, sql`, `)}
        ON CONFLICT (root_id, user_id) DO UPDATE SET unread_mentions = thread_memberships.unread_mentions + 1, last_updated = ${at}
      `);
    }
    const res = await this.db.execute(
      sql`SELECT user_id FROM thread_memberships WHERE root_id = ${opts.rootId} AND following = true`,
    );
    return { followers: (res.rows as { user_id: string }[]).map((r) => r.user_id) };
  }

  // Per-user unread for a thread: derived replies + stored mentions. Used for the
  // prev/new values on WS events so the client diffs aggregates without refetch.
  async getThreadUnreadForUser(
    rootId: string,
    userId: string,
  ): Promise<{ unreadReplies: number; unreadMentions: number }> {
    const res = await this.db.execute(sql`
      SELECT tm.unread_mentions AS unread_mentions,
        (SELECT count(*) FROM messages m
          WHERE m.parent_id = ${rootId} AND m.deleted_at IS NULL AND m.created_at > tm.last_viewed) AS unread_replies
      FROM thread_memberships tm WHERE tm.root_id = ${rootId} AND tm.user_id = ${userId}
    `);
    const row = (res.rows as { unread_mentions: number; unread_replies: number }[])[0];
    if (!row) return { unreadReplies: 0, unreadMentions: 0 };
    return {
      unreadReplies: Number(row.unread_replies),
      unreadMentions: Number(row.unread_mentions),
    };
  }

  // Batched variant: derived unread for ALL members of a thread in ONE query,
  // keyed by userId. Callers fanning a thread_updated out to every follower
  // should use this instead of getThreadUnreadForUser-in-a-loop (was an N+1:
  // one round-trip per follower on every reply).
  async getThreadUnreadForRoot(
    rootId: string,
  ): Promise<Map<string, { unreadReplies: number; unreadMentions: number }>> {
    // LEFT JOIN + GROUP BY rather than a per-row correlated subquery — one pass
    // the planner can optimize instead of a count() per membership row.
    const res = await this.db.execute(sql`
      SELECT tm.user_id AS user_id, tm.unread_mentions AS unread_mentions,
        count(m.id) AS unread_replies
      FROM thread_memberships tm
      LEFT JOIN messages m
        ON m.parent_id = ${rootId} AND m.deleted_at IS NULL AND m.created_at > tm.last_viewed
      WHERE tm.root_id = ${rootId}
      GROUP BY tm.user_id, tm.unread_mentions
    `);
    const rows = res.rows as { user_id: string; unread_mentions: number; unread_replies: number }[];
    const map = new Map<string, { unreadReplies: number; unreadMentions: number }>();
    for (const r of rows) {
      map.set(r.user_id, {
        unreadReplies: Number(r.unread_replies),
        unreadMentions: Number(r.unread_mentions),
      });
    }
    return map;
  }

  // List the user's followed threads with the root message + derived unread.
  async getThreads(
    workspaceId: string,
    userId: string,
    opts?: { unreadOnly?: boolean; limit?: number },
  ): Promise<
    Array<{
      root: StoredMessage | null;
      replyCount: number;
      lastReplyAt: number;
      participants: string[];
      unreadReplies: number;
      unreadMentions: number;
    }>
  > {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const res = await this.db.execute(sql`
      SELECT t.root_id, t.reply_count, t.participants,
        extract(epoch from t.last_reply_at) * 1000 AS last_reply_at,
        tm.unread_mentions,
        (SELECT count(*) FROM messages m
          WHERE m.parent_id = t.root_id AND m.deleted_at IS NULL AND m.created_at > tm.last_viewed) AS unread_replies
      FROM threads t
      JOIN thread_memberships tm ON tm.root_id = t.root_id AND tm.user_id = ${userId}
      WHERE t.workspace_id = ${workspaceId} AND tm.following = true
      ORDER BY t.last_reply_at DESC
      LIMIT ${limit}
    `);
    const rows = res.rows as Array<{
      root_id: string;
      reply_count: number;
      participants: string[];
      last_reply_at: number;
      unread_mentions: number;
      unread_replies: number;
    }>;
    const filtered = opts?.unreadOnly
      ? rows.filter((r) => Number(r.unread_replies) > 0 || Number(r.unread_mentions) > 0)
      : rows;
    const out: Array<{
      root: StoredMessage | null;
      replyCount: number;
      lastReplyAt: number;
      participants: string[];
      unreadReplies: number;
      unreadMentions: number;
    }> = [];
    for (const r of filtered) {
      const [rootRow] = await this.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, r.root_id))
        .limit(1);
      out.push({
        root: rootRow ? this.mapMessage(rootRow) : null,
        replyCount: Number(r.reply_count),
        lastReplyAt: Number(r.last_reply_at),
        participants: Array.isArray(r.participants) ? r.participants : [],
        unreadReplies: Number(r.unread_replies),
        unreadMentions: Number(r.unread_mentions),
      });
    }
    return out;
  }

  // Aggregate badge seed: how many followed threads are unread + total mentions.
  async getThreadCounts(
    workspaceId: string,
    userId: string,
  ): Promise<{ totalUnreadThreads: number; totalUnreadMentions: number }> {
    const res = await this.db.execute(sql`
      SELECT
        count(*) FILTER (WHERE unread_replies > 0 OR unread_mentions > 0) AS unread_threads,
        COALESCE(sum(unread_mentions), 0) AS unread_mentions
      FROM (
        SELECT tm.unread_mentions AS unread_mentions,
          (SELECT count(*) FROM messages m
            WHERE m.parent_id = tm.root_id AND m.deleted_at IS NULL AND m.created_at > tm.last_viewed) AS unread_replies
        FROM thread_memberships tm
        WHERE tm.workspace_id = ${workspaceId} AND tm.user_id = ${userId} AND tm.following = true
      ) s
    `);
    const row = (res.rows as { unread_threads: number; unread_mentions: number }[])[0];
    return {
      totalUnreadThreads: Number(row?.unread_threads ?? 0),
      totalUnreadMentions: Number(row?.unread_mentions ?? 0),
    };
  }

  // ─── Agent-session history (Home stats) ─────────────────────────
  // We are the first writer of agent_sessions (it was abandoned). One row per
  // agent/session, keyed by agentId: written at session start, token-updated on
  // each turn (cumulative OVERWRITE), archived on session end.

  async upsertAgentSession(params: {
    agentId: string;
    workspaceId: string;
    channelId: string | null;
    userId: string | null;
    provider: string | null;
    cyboId: string | null;
    sessionType: string;
    cwd: string | null;
  }): Promise<void> {
    await this.db
      .insert(schema.agentSessions)
      .values({
        id: params.agentId,
        agentId: params.agentId,
        workspaceId: params.workspaceId,
        channelId: params.channelId,
        userId: params.userId,
        provider: params.provider,
        cyboId: params.cyboId,
        sessionType: params.sessionType,
        status: "active",
        cwd: params.cwd,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      // Re-create/restore of the same agent id keeps the original createdAt and
      // accumulated tokens — only refreshes identity + reactivates.
      .onConflictDoUpdate({
        target: schema.agentSessions.id,
        set: {
          workspaceId: params.workspaceId,
          channelId: params.channelId,
          userId: params.userId,
          provider: params.provider,
          cyboId: params.cyboId,
          status: "active",
          cwd: params.cwd,
          updatedAt: new Date(),
        },
      });
  }

  // Overwrite cumulative usage with the latest snapshot (lastUsage is cumulative).
  // Only fields present in the payload are written — passing `undefined` to a
  // column makes Drizzle omit it from the UPDATE, so a provider that reports a
  // subset of metrics never zeroes out the others' accumulated totals.
  async recordAgentSessionUsage(
    agentId: string,
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      totalCostUsd?: number;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Read the PRIOR cumulative (+ workspace) BEFORE overwriting, so we can
      // credit only the per-turn DELTA to today's token_usage_daily bucket — the
      // session row keeps a cumulative total, but the heatmap needs per-day usage.
      // FOR UPDATE locks the row so concurrent turns for the same session serialize
      // (READ COMMITTED would otherwise let them read the same prior → double-count
      // or lost ledger deltas).
      const [prior] = await tx
        .select({
          workspaceId: schema.agentSessions.workspaceId,
          inputTokens: schema.agentSessions.inputTokens,
          outputTokens: schema.agentSessions.outputTokens,
        })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.id, agentId))
        .for("update");

      await tx
        .update(schema.agentSessions)
        .set({
          // Number.isFinite guards against a provider emitting NaN/Infinity, which
          // would otherwise reach the pg driver as an invalid numeric write.
          inputTokens: Number.isFinite(usage.inputTokens)
            ? Math.round(usage.inputTokens as number)
            : undefined,
          outputTokens: Number.isFinite(usage.outputTokens)
            ? Math.round(usage.outputTokens as number)
            : undefined,
          cachedInputTokens: Number.isFinite(usage.cachedInputTokens)
            ? Math.round(usage.cachedInputTokens as number)
            : undefined,
          totalCostUsd: Number.isFinite(usage.totalCostUsd) ? usage.totalCostUsd : undefined,
          updatedAt: new Date(),
        })
        .where(eq(schema.agentSessions.id, agentId));

      // No session row (the UPDATE matched nothing) → nothing to attribute.
      if (!prior) return;

      // input+output is the heatmap metric. The "new" cumulative is the reported
      // value, or the prior one when this report omits that field.
      const newInput = Number.isFinite(usage.inputTokens)
        ? Math.round(usage.inputTokens as number)
        : prior.inputTokens;
      const newOutput = Number.isFinite(usage.outputTokens)
        ? Math.round(usage.outputTokens as number)
        : prior.outputTokens;
      const priorTotal = prior.inputTokens + prior.outputTokens;
      const newTotal = newInput + newOutput;
      // Reset-aware (counter-rate style): a fresh agent process reusing the same
      // id reports a cumulative that restarts below the prior — credit its full
      // new total in that case rather than a negative delta.
      const delta = newTotal >= priorTotal ? newTotal - priorTotal : newTotal;
      if (delta > 0) {
        await tx.execute(sql`
          INSERT INTO token_usage_daily (workspace_id, day, tokens)
          VALUES (${prior.workspaceId}, (now() AT TIME ZONE 'UTC')::date, ${delta})
          ON CONFLICT (workspace_id, day)
          DO UPDATE SET tokens = token_usage_daily.tokens + ${delta}
        `);
      }
    });
  }

  // Ensure an agent_sessions row exists so usage can be recorded even when no
  // agent_status ever arrived to create it — e.g. EPHEMERAL cybo summons (channel
  // mentions / slash) skip the agent_status broadcast, so the relay would
  // otherwise UPDATE 0 rows and silently drop the tokens they burned. Idempotent:
  // an existing row (full identity from agent_status) is left untouched.
  async ensureAgentSession(agentId: string, workspaceId: string): Promise<void> {
    await this.db
      .insert(schema.agentSessions)
      .values({
        id: agentId,
        agentId,
        workspaceId,
        sessionType: "session",
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.agentSessions.id });
  }

  async archiveAgentSession(agentId: string): Promise<void> {
    await this.db
      .update(schema.agentSessions)
      .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.agentSessions.id, agentId));
  }

  // The Home "This week" + heatmap + top-agents aggregate, workspace-wide.
  // 'done'/'completed' is the tasks-shipped convention (status is free-form text);
  // agent-hours = summed session wall-clock (archived_at or now − created_at).
  async getWorkspaceHomeStats(
    workspaceId: string,
    range: "today" | "week" | "month" | "year" = "month",
  ): Promise<{
    sessionsThisWeek: number;
    tokensThisWeek: number;
    agentHoursThisWeek: number;
    tasksShippedThisWeek: number;
    dailyActivity: { day: string; count: number }[];
    topAgents: {
      provider: string | null;
      cyboId: string | null;
      sessions: number;
      tokens: number;
    }[];
  }> {
    // Rolling window for the scalar tiles + top agents. The heatmap below always
    // spans a full year regardless of the selected range.
    const RANGE_DAYS: Record<string, number> = { today: 1, week: 7, month: 30, year: 365 };
    const days = RANGE_DAYS[range] ?? 30;

    const weekScalars = await this.db.execute(sql`
      SELECT
        count(*) AS sessions,
        COALESCE(sum(input_tokens + output_tokens), 0) AS tokens,
        COALESCE(sum(EXTRACT(EPOCH FROM (COALESCE(archived_at, now()) - created_at))), 0) AS seconds
      FROM agent_sessions
      WHERE workspace_id = ${workspaceId} AND created_at > now() - make_interval(days => ${days})
    `);
    const ws = (weekScalars.rows as { sessions: number; tokens: number; seconds: number }[])[0];

    const tasksRow = await this.db.execute(sql`
      SELECT count(*) AS n FROM tasks
      WHERE workspace_id = ${workspaceId}
        AND status IN ('done', 'completed')
        AND updated_at > now() - make_interval(days => ${days})
    `);
    const tasksShipped = Number((tasksRow.rows as { n: number }[])[0]?.n ?? 0);

    // A full year of daily TOKEN usage for the contribution heatmap (range-
    // independent — always the year, GitHub-style; darker = more tokens burned
    // that day). Sourced from token_usage_daily, the append-only per-day DELTA
    // ledger (recordAgentSessionUsage), so each day reflects tokens actually
    // burned that day and the history persists — unlike the old created_at
    // bucketing of cumulative per-session totals, which collapsed onto day 1.
    const daily = await this.db.execute(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, tokens AS count
      FROM token_usage_daily
      WHERE workspace_id = ${workspaceId}
        AND day > (now() AT TIME ZONE 'UTC')::date - 371
      ORDER BY day ASC
    `);

    const top = await this.db.execute(sql`
      SELECT provider, cybo_id,
        count(*) AS sessions,
        COALESCE(sum(input_tokens + output_tokens), 0) AS tokens
      FROM agent_sessions
      WHERE workspace_id = ${workspaceId} AND created_at > now() - make_interval(days => ${days})
      GROUP BY provider, cybo_id
      ORDER BY sessions DESC
      LIMIT 8
    `);

    return {
      sessionsThisWeek: Number(ws?.sessions ?? 0),
      tokensThisWeek: Number(ws?.tokens ?? 0),
      agentHoursThisWeek: Number(ws?.seconds ?? 0) / 3600,
      tasksShippedThisWeek: tasksShipped,
      dailyActivity: (daily.rows as { day: string; count: number }[]).map((r) => ({
        day: r.day,
        count: Number(r.count),
      })),
      topAgents: (
        top.rows as {
          provider: string | null;
          cybo_id: string | null;
          sessions: number;
          tokens: number;
        }[]
      ).map((r) => ({
        provider: r.provider,
        cyboId: r.cybo_id,
        sessions: Number(r.sessions),
        tokens: Number(r.tokens),
      })),
    };
  }

  async markThreadRead(rootId: string, userId: string, viewedAt?: number): Promise<void> {
    const at = new Date(viewedAt ?? Date.now()).toISOString();
    await this.db.execute(sql`
      INSERT INTO thread_memberships (root_id, user_id, workspace_id, following, last_viewed, unread_mentions, last_updated)
      SELECT ${rootId}, ${userId}, t.workspace_id, true, ${at}, 0, ${at} FROM threads t WHERE t.root_id = ${rootId}
      ON CONFLICT (root_id, user_id) DO UPDATE SET last_viewed = ${at}, unread_mentions = 0, last_updated = ${at}
    `);
  }

  // Viewer's per-thread last_viewed cursor (epoch ms), or null if no membership
  // row exists yet. Used by fetch_thread (#7) to seed the frozen per-thread
  // "New replies" divider before mark_thread_read advances the cursor on open.
  async getThreadLastViewed(rootId: string, userId: string): Promise<number | null> {
    const res = await this.db.execute(sql`
      SELECT extract(epoch from last_viewed) * 1000 AS last_viewed
      FROM thread_memberships WHERE root_id = ${rootId} AND user_id = ${userId}
    `);
    const row = (res.rows as { last_viewed: number | null }[])[0];
    if (!row || row.last_viewed == null) return null;
    return Number(row.last_viewed);
  }

  // Mark a thread unread (#7): rewind last_viewed to just before the given reply
  // timestamp so that reply (and everything after it) counts as unread again.
  // Mirrors markThreadRead's lazy-insert shape; never touches unread_mentions.
  async markThreadUnread(rootId: string, userId: string, beforeMs: number): Promise<void> {
    // 1ms before the target reply: the reply itself becomes the first unread.
    const at = new Date(Math.max(0, beforeMs - 1)).toISOString();
    await this.db.execute(sql`
      INSERT INTO thread_memberships (root_id, user_id, workspace_id, following, last_viewed, unread_mentions, last_updated)
      SELECT ${rootId}, ${userId}, t.workspace_id, true, ${at}, 0, ${at} FROM threads t WHERE t.root_id = ${rootId}
      ON CONFLICT (root_id, user_id) DO UPDATE SET last_viewed = ${at}, last_updated = ${at}
    `);
  }

  async followThread(
    rootId: string,
    userId: string,
    workspaceId: string,
    following: boolean,
  ): Promise<void> {
    const at = new Date().toISOString();
    await this.db.execute(sql`
      INSERT INTO thread_memberships (root_id, user_id, workspace_id, following, last_viewed, unread_mentions, last_updated)
      VALUES (${rootId}, ${userId}, ${workspaceId}, ${following}, ${at}, 0, ${at})
      ON CONFLICT (root_id, user_id) DO UPDATE SET following = ${following}, last_updated = ${at}
    `);
  }

  // Full-text message search (Postgres-only, no extensions). Uses the generated
  // `tsv` column (migration 0006) + GIN index via websearch_to_tsquery, scoped in
  // SQL to channels the user can see. Short terms fall back to ILIKE (FTS needs a
  // lexeme; mirrors Mattermost's CJK/short fallback). Any error → log + [] so a
  // bad query never surfaces a DB error to the client.
  // Channel-scoped search for the cybo MCP path (cybo_read kind:"search"). NO
  // user scope here — the caller has ALREADY membership-gated the channel for
  // the cybo (workspace-relay handleCyboRead), so scoping to the single channel
  // is the authorization. Mirrors searchMessages' ILIKE/tsquery split.
  async searchChannelMessages(
    channelId: string,
    query: string,
    limit = 20,
  ): Promise<StoredMessage[]> {
    const q = query.trim();
    if (!q) return [];
    const cap = Math.min(Math.max(1, limit), 100);
    const baseConds = [eq(schema.messages.channelId, channelId), isNull(schema.messages.deletedAt)];
    try {
      if (q.length <= 2) {
        const rows = await this.db
          .select()
          .from(schema.messages)
          .where(and(...baseConds, sql`${schema.messages.text} ILIKE ${`%${q}%`}`))
          .orderBy(desc(schema.messages.createdAt))
          .limit(cap);
        return rows.map(this.mapMessage);
      }
      const tsq = sql`websearch_to_tsquery('simple', ${q})`;
      const rows = await this.db
        .select()
        .from(schema.messages)
        .where(and(...baseConds, sql`tsv @@ ${tsq}`))
        .orderBy(desc(sql`ts_rank_cd(tsv, ${tsq})`), desc(schema.messages.createdAt))
        .limit(cap);
      return rows.map(this.mapMessage);
    } catch (err) {
      console.warn("[search] channel query failed:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  async searchMessages(
    workspaceId: string,
    userId: string,
    query: string,
    limit = 50,
  ): Promise<StoredMessage[]> {
    const q = query.trim();
    if (!q) return [];
    const cap = Math.min(limit, 100);
    // Channels the user can read: their memberships ∪ public channels in the ws.
    const channelScope = sql`${schema.messages.channelId} IN (
      SELECT channel_id FROM channel_members WHERE user_id = ${userId}
      UNION SELECT id FROM channels WHERE workspace_id = ${workspaceId} AND is_private = false
    )`;
    const baseConds = [
      eq(schema.messages.workspaceId, workspaceId),
      isNull(schema.messages.deletedAt),
      isNotNull(schema.messages.channelId),
      channelScope,
    ];
    try {
      if (q.length <= 2) {
        const rows = await this.db
          .select()
          .from(schema.messages)
          .where(and(...baseConds, sql`${schema.messages.text} ILIKE ${`%${q}%`}`))
          .orderBy(desc(schema.messages.createdAt))
          .limit(cap);
        return rows.map(this.mapMessage);
      }
      const tsq = sql`websearch_to_tsquery('simple', ${q})`;
      const rows = await this.db
        .select()
        .from(schema.messages)
        .where(and(...baseConds, sql`tsv @@ ${tsq}`))
        .orderBy(desc(sql`ts_rank_cd(tsv, ${tsq})`), desc(schema.messages.createdAt))
        .limit(cap);
      return rows.map(this.mapMessage);
    } catch (err) {
      console.warn("[search] query failed:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  // Workspace-wide task search: case-insensitive ILIKE over title OR description,
  // scoped to the workspace AND fail-closed to the projects the user may see. The
  // relay only enforces workspace-level membership; per-PROJECT visibility is NOT
  // implied by it, so this read must gate it itself (same as getTasksPage and
  // searchMessages). taskVisibilityCondition keeps legacy/no-project tasks visible
  // and limits project-tagged tasks to the user's visible tasks_projects — a member
  // can never read a task in a private-channel project they were not given access to.
  // No FTS / index — a plain ILIKE with the workspace + visibility filter is enough.
  // Returns enriched rows (project/state/assignee resolved) ordered by most-recently-
  // updated. Short (<2 char) or empty queries short-circuit to []. Any error → log +
  // [] so a bad query never surfaces a DB error to the client (mirrors searchMessages).
  async searchTasks(
    workspaceId: string,
    userId: string,
    query: string,
    limit = 50,
  ): Promise<TaskSearchHit[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const cap = Math.min(Math.max(1, limit), 100);
    const pattern = `%${escapeLikePattern(q)}%`;
    try {
      const rows: TaskSearchRow[] = await this.db
        .select({
          id: schema.tasks.id,
          workspaceId: schema.tasks.workspaceId,
          title: schema.tasks.title,
          description: schema.tasks.description,
          status: schema.tasks.status,
          stateId: schema.tasks.stateId,
          sequenceId: schema.tasks.sequenceId,
          priority: schema.tasks.priority,
          assigneeId: schema.tasks.assigneeId,
          createdAt: schema.tasks.createdAt,
          updatedAt: schema.tasks.updatedAt,
          tpId: schema.tasksProjects.id,
          tpIdentifier: schema.tasksProjects.identifier,
          tpColor: schema.tasksProjects.color,
          chatProjectId: schema.tasksProjects.chatProjectId,
          chatProjectName: schema.projects.name,
          chatProjectColor: schema.projects.color,
          stateRowId: schema.taskStates.id,
          stateName: schema.taskStates.name,
          stateColor: schema.taskStates.color,
          stateGroup: schema.taskStates.group,
          userId: schema.users.id,
          userName: schema.users.name,
          userImageUrl: schema.users.imageUrl,
        })
        .from(schema.tasks)
        .leftJoin(schema.tasksProjects, eq(schema.tasksProjects.id, schema.tasks.projectId))
        .leftJoin(schema.projects, eq(schema.projects.id, schema.tasksProjects.chatProjectId))
        .leftJoin(schema.taskStates, eq(schema.taskStates.id, schema.tasks.stateId))
        .leftJoin(schema.users, eq(schema.users.id, schema.tasks.assigneeId))
        .where(
          and(
            eq(schema.tasks.workspaceId, workspaceId),
            this.taskVisibilityCondition(workspaceId, userId)!,
            or(ilike(schema.tasks.title, pattern), ilike(schema.tasks.description, pattern)),
          ),
        )
        .orderBy(desc(schema.tasks.updatedAt))
        .limit(cap);

      // Cybo-assignee fallback: rows whose assignee is set but matched no users row
      // are cybo-assigned. Batch-resolve those ids in ONE query (no N+1), mirroring
      // loadChatProjectIds.
      const cyboMap = await this.loadTaskSearchCybos(rows);
      return rows.map((row) => this.mapTaskSearchRow(row, cyboMap));
    } catch (err) {
      console.warn("[search] task query failed:", err instanceof Error ? err.message : err);
      return [];
    }
  }

  // Batch-load the cybo (id → name/avatar) for task-search rows whose assignee is a
  // cybo (assigneeId set but the users join returned null). One query; empty input
  // skipped. Mirrors loadChatProjectIds' batch pattern.
  private async loadTaskSearchCybos(
    rows: readonly TaskSearchRow[],
  ): Promise<Map<string, { name: string; avatar: string | null }>> {
    const out = new Map<string, { name: string; avatar: string | null }>();
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.assigneeId !== null && r.userId === null)
          .map((r) => r.assigneeId as string),
      ),
    ];
    if (ids.length === 0) return out;
    const cyboRows = await this.db
      .select({ id: schema.cybos.id, name: schema.cybos.name, avatar: schema.cybos.avatar })
      .from(schema.cybos)
      .where(inArray(schema.cybos.id, ids));
    for (const c of cyboRows) out.set(c.id, { name: c.name, avatar: c.avatar ?? null });
    return out;
  }

  // Resolve a task-search row's project block (null when the task has no
  // tasks_project). Reuses mapTasksProjectListRow's name/color/Inbox logic.
  private mapTaskSearchProject(row: TaskSearchRow): TaskSearchHit["project"] {
    if (!row.tpId) return null;
    return {
      id: row.tpId,
      identifier: row.tpIdentifier ?? "",
      name: row.chatProjectId ? (row.chatProjectName ?? row.tpIdentifier ?? "") : "Inbox",
      color: row.tpColor ?? row.chatProjectColor ?? null,
      isInbox: row.chatProjectId === null,
      chatProjectId: row.chatProjectId,
    };
  }

  // Resolve a task-search row's assignee block: a matched users row → kind "user";
  // else a batch-resolved cybo → kind "cybo"; else null.
  private mapTaskSearchAssignee(
    row: TaskSearchRow,
    cyboMap: Map<string, { name: string; avatar: string | null }>,
  ): TaskSearchHit["assignee"] {
    if (row.assigneeId === null) return null;
    if (row.userId !== null) {
      return { id: row.assigneeId, name: row.userName, imageUrl: row.userImageUrl, kind: "user" };
    }
    const cybo = cyboMap.get(row.assigneeId);
    if (cybo) return { id: row.assigneeId, name: cybo.name, imageUrl: cybo.avatar, kind: "cybo" };
    return null;
  }

  // Row → TaskSearchHit. Sub-blocks (project/state/assignee) live in small helpers
  // so the per-row mapping stays under the complexity cap.
  private mapTaskSearchRow(
    row: TaskSearchRow,
    cyboMap: Map<string, { name: string; avatar: string | null }>,
  ): TaskSearchHit {
    const state =
      row.stateRowId && row.stateName && row.stateColor && row.stateGroup
        ? {
            id: row.stateRowId,
            name: row.stateName,
            color: row.stateColor,
            group: row.stateGroup,
          }
        : null;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      description: row.description,
      status: row.status,
      stateId: row.stateId,
      sequenceId: row.sequenceId,
      priority: row.priority,
      assigneeId: row.assigneeId,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
      project: this.mapTaskSearchProject(row),
      state,
      assignee: this.mapTaskSearchAssignee(row, cyboMap),
    };
  }

  private mapCybo(r: typeof schema.cybos.$inferSelect): StoredCybo {
    return {
      id: r.id,
      workspace_id: r.workspaceId,
      slug: r.slug,
      name: r.name,
      description: r.description,
      avatar: r.avatar,
      role: r.role,
      soul: r.soul,
      provider: r.provider,
      model: r.model,
      mcp_servers: r.mcpServers ? JSON.stringify(r.mcpServers) : null,
      tool_grants: r.toolGrants ? JSON.stringify(r.toolGrants) : null,
      llm_auth_mode: r.llmAuthMode,
      behavior_mode: r.behaviorMode,
      home_daemon_id: r.homeDaemonId,
      autonomy_level: r.autonomyLevel ?? null,
      monthly_spend_cap: r.monthlySpendCap,
      platform_permissions: JSON.stringify(r.platformPermissions ?? []),
      is_default: r.isDefault ? 1 : 0,
      created_by: r.createdBy,
      created_at: r.createdAt.getTime(),
      updated_at: r.updatedAt.getTime(),
    };
  }

  // ─── Projects ─────────────────────────────────────────────────────

  async createProject(
    id: string,
    workspaceId: string,
    name: string,
    color: string,
  ): Promise<{ id: string; name: string; color: string; createdAt: number }> {
    const [row] = await this.db
      .insert(schema.projects)
      .values({ id, workspaceId, name, color })
      .returning();
    return { id: row.id, name: row.name, color: row.color, createdAt: row.createdAt.getTime() };
  }

  // One-time-ish startup backfill: give every existing workspace that has zero
  // projects a default project named after the workspace (+ its partner Tasks
  // project + default states), so existing companies never sit on an empty
  // "No projects yet" Tasks screen. Idempotent — only touches projectless
  // workspaces; mirrors the seeding new workspaces get in cyborg:create_workspace.
  // Returns how many workspaces were seeded.
  async backfillDefaultProjects(): Promise<number> {
    // Multi-replica safety: only one instance runs the backfill. A non-blocking
    // session advisory lock means a second replica booting concurrently just
    // skips it (returns 0) instead of racing to double-seed the same workspace.
    const BACKFILL_LOCK_KEY = 0xc7_de_fa_17; // "c7 default" — stable arbitrary key
    const lockRes = await this.db.execute(
      sql`SELECT pg_try_advisory_lock(${BACKFILL_LOCK_KEY}) AS locked`,
    );
    if (!(lockRes.rows as { locked: boolean }[])[0]?.locked) return 0;
    try {
      // DB-level filter: workspaces with NO project. Avoids loading every
      // workspace + every project into memory.
      const targets = await this.db
        .select({ id: schema.workspaces.id, name: schema.workspaces.name })
        .from(schema.workspaces)
        .where(
          sql`NOT EXISTS (SELECT 1 FROM ${schema.projects} WHERE ${schema.projects.workspaceId} = ${schema.workspaces.id})`,
        );
      let seeded = 0;
      for (const ws of targets) {
        try {
          const projId = randomUUID();
          await this.createProject(projId, ws.id, ws.name, "#6366f1");
          await this.provisionTasksProject(ws.id, projId, ws.name);
          seeded++;
        } catch (err) {
          console.error("[backfillDefaultProjects] failed for workspace (continuing)", {
            workspaceId: ws.id,
            err,
          });
        }
      }
      return seeded;
    } finally {
      await this.db.execute(sql`SELECT pg_advisory_unlock(${BACKFILL_LOCK_KEY})`);
    }
  }

  // Redesign P0 — when `userId` is supplied the chat-project list is visibility
  // filtered to projects the user may see: a project tagged (channel_projects) on a
  // non-deleted/non-archived channel the user is a member of, OR any project when
  // the user is the workspace owner/admin. Omitting userId keeps the unscoped
  // back-compat path for internal/system callers. (Note: the Tasks app's own
  // project list is governed by visibleProjectIds over tasks_projects; this filters
  // the older chat `projects` table.)
  async getProjects(
    workspaceId: string,
    userId?: string,
  ): Promise<Array<{ id: string; name: string; color: string; createdAt: number }>> {
    const conditions = [eq(schema.projects.workspaceId, workspaceId)];
    if (userId)
      conditions.push(
        or(
          exists(
            this.db
              .select({ one: sql`1` })
              .from(schema.channelProjects)
              .innerJoin(schema.channels, eq(schema.channels.id, schema.channelProjects.channelId))
              .innerJoin(
                schema.channelMembers,
                eq(schema.channelMembers.channelId, schema.channels.id),
              )
              .where(
                and(
                  eq(schema.channelProjects.projectId, schema.projects.id),
                  isNull(schema.channels.deletedAt),
                  eq(schema.channels.isArchived, false),
                  eq(schema.channelMembers.userId, userId),
                ),
              ),
          ),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(schema.memberships)
              .where(
                and(
                  eq(schema.memberships.workspaceId, workspaceId),
                  eq(schema.memberships.userId, userId),
                  inArray(schema.memberships.role, ["owner", "admin"]),
                ),
              ),
          ),
        )!,
      );
    const rows = await this.db
      .select()
      .from(schema.projects)
      .where(and(...conditions))
      .orderBy(asc(schema.projects.createdAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      createdAt: r.createdAt.getTime(),
    }));
  }

  async updateProject(projectId: string, name: string, color: string): Promise<void> {
    await this.db
      .update(schema.projects)
      .set({ name, color })
      .where(eq(schema.projects.id, projectId));
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.db.delete(schema.projects).where(eq(schema.projects.id, projectId));
  }

  async getChannelProjects(
    workspaceId: string,
  ): Promise<Array<{ channelId: string; projectId: string }>> {
    const rows = await this.db
      .select({
        channelId: schema.channelProjects.channelId,
        projectId: schema.channelProjects.projectId,
      })
      .from(schema.channelProjects)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.channelProjects.projectId))
      .where(eq(schema.projects.workspaceId, workspaceId));
    return rows;
  }

  async setChannelProject(channelId: string, projectId: string | null): Promise<void> {
    if (projectId) {
      await this.db
        .insert(schema.channelProjects)
        .values({ channelId, projectId })
        .onConflictDoUpdate({
          target: schema.channelProjects.channelId,
          set: { projectId },
        });
    } else {
      await this.db
        .delete(schema.channelProjects)
        .where(eq(schema.channelProjects.channelId, channelId));
    }
  }

  // ─── Web Push subscriptions ─────────────────────────────────────

  async upsertPushSubscription(opts: {
    id: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string | null;
  }): Promise<void> {
    await this.db
      .insert(schema.pushSubscriptions)
      .values({
        id: opts.id,
        userId: opts.userId,
        endpoint: opts.endpoint,
        p256dh: opts.p256dh,
        auth: opts.auth,
        userAgent: opts.userAgent ?? null,
      })
      .onConflictDoUpdate({
        target: schema.pushSubscriptions.endpoint,
        set: {
          userId: opts.userId,
          p256dh: opts.p256dh,
          auth: opts.auth,
          userAgent: opts.userAgent ?? null,
          lastSeenAt: new Date(),
        },
      });
  }

  async deletePushSubscriptionByEndpoint(userId: string, endpoint: string): Promise<void> {
    await this.db
      .delete(schema.pushSubscriptions)
      .where(
        and(
          eq(schema.pushSubscriptions.userId, userId),
          eq(schema.pushSubscriptions.endpoint, endpoint),
        ),
      );
  }

  async deletePushSubscriptionById(id: string): Promise<void> {
    await this.db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, id));
  }

  async getPushSubscriptionsForUsers(
    userIds: string[],
  ): Promise<
    Array<{ id: string; userId: string; endpoint: string; p256dh: string; auth: string }>
  > {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: schema.pushSubscriptions.id,
        userId: schema.pushSubscriptions.userId,
        endpoint: schema.pushSubscriptions.endpoint,
        p256dh: schema.pushSubscriptions.p256dh,
        auth: schema.pushSubscriptions.auth,
      })
      .from(schema.pushSubscriptions)
      .where(inArray(schema.pushSubscriptions.userId, userIds));
    return rows;
  }

  // ─── FCM device tokens (native mobile push) ─────────────────────

  async upsertFcmToken(opts: {
    id: string;
    userId: string;
    token: string;
    platform: string;
    deviceName?: string | null;
  }): Promise<void> {
    await this.db
      .insert(schema.fcmTokens)
      .values({
        id: opts.id,
        userId: opts.userId,
        token: opts.token,
        platform: opts.platform,
        deviceName: opts.deviceName ?? null,
      })
      .onConflictDoUpdate({
        target: schema.fcmTokens.token,
        set: {
          userId: opts.userId,
          platform: opts.platform,
          deviceName: opts.deviceName ?? null,
          lastSeenAt: new Date(),
        },
      });
  }

  async deleteFcmToken(token: string): Promise<void> {
    await this.db.delete(schema.fcmTokens).where(eq(schema.fcmTokens.token, token));
  }

  async getFcmTokensForUsers(
    userIds: string[],
  ): Promise<Array<{ id: string; userId: string; token: string; platform: string }>> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: schema.fcmTokens.id,
        userId: schema.fcmTokens.userId,
        token: schema.fcmTokens.token,
        platform: schema.fcmTokens.platform,
      })
      .from(schema.fcmTokens)
      .where(inArray(schema.fcmTokens.userId, userIds));
    return rows;
  }

  // Per-recipient iOS app-icon badge count for an outgoing push. Ported from v1
  // dispatch.ts `badgeCountsForRecipients`: a single grouped COUNT(*) of the
  // user's UNREAD activity rows across ALL workspaces (iOS shows one badge per
  // app — partitioning per-workspace would be invisible to the user), `+1` for
  // the in-flight push (the recipient's activity row isn't written until they
  // sync, so the raw count is stale-by-one), clamped to 9999 (the badge tile
  // only shows 4 digits). Recipients with no unread rows get 1 (just the
  // incoming push). Batched so dispatch computes counts ONCE, never per-token.
  async badgeCountsForRecipients(userIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (userIds.length === 0) return result;
    const rows = await this.db
      .select({
        userId: schema.activityEvents.userId,
        n: sql<number>`COUNT(*)::int`,
      })
      .from(schema.activityEvents)
      .where(
        and(
          inArray(schema.activityEvents.userId, userIds),
          eq(schema.activityEvents.isRead, false),
        ),
      )
      .groupBy(schema.activityEvents.userId);
    for (const r of rows) result.set(r.userId, Math.min(Number(r.n ?? 0) + 1, 9999));
    // Users with no unread rows still need a badge (=1 for the incoming push).
    for (const id of userIds) if (!result.has(id)) result.set(id, 1);
    return result;
  }

  // RAW unread-activity badge count for one user across ALL workspaces, with NO
  // +1 in-flight bump and NO floor-at-1 — the clear-on-read badge sync (#605).
  // badgeCountsForRecipients adds +1 for the push that's still in flight and
  // floors at 1; a read event has no in-flight push and MUST be able to clear
  // the badge all the way to 0, so this returns the true current count (clamped
  // to 9999, the 4-digit badge tile).
  async unreadBadgeCount(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.activityEvents)
      .where(
        and(eq(schema.activityEvents.userId, userId), eq(schema.activityEvents.isRead, false)),
      );
    return Math.min(Number(row?.n ?? 0), 9999);
  }

  // ─── MCP tokens ──────────────────────────────────────────────────

  async createMcpToken(opts: {
    id: string;
    tokenHash: string;
    name: string;
    workspaceId: string;
    ownerId: string;
    identityType: "cybo" | "user";
    identityId: string;
    scopes: string[];
    expiresAt?: Date | null;
  }): Promise<void> {
    await this.db.insert(schema.mcpTokens).values({
      id: opts.id,
      tokenHash: opts.tokenHash,
      name: opts.name,
      workspaceId: opts.workspaceId,
      ownerId: opts.ownerId,
      identityType: opts.identityType,
      identityId: opts.identityId,
      scopes: opts.scopes,
      expiresAt: opts.expiresAt ?? null,
    });
  }

  // Look a token up by its SHA-256 hash. Returns null when missing, disabled, or
  // expired — callers must still re-check workspace membership before granting.
  async getMcpTokenByHash(tokenHash: string): Promise<StoredMcpToken | null> {
    const [row] = await this.db
      .select()
      .from(schema.mcpTokens)
      .where(eq(schema.mcpTokens.tokenHash, tokenHash))
      .limit(1);
    if (!row) return null;
    if (!row.enabled) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspaceId,
      ownerId: row.ownerId,
      identityType: row.identityType as "cybo" | "user",
      identityId: row.identityId,
      scopes: row.scopes ?? [],
    };
  }

  async touchMcpToken(id: string): Promise<void> {
    await this.db
      .update(schema.mcpTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.mcpTokens.id, id));
  }

  // Tokens are isolated PER USER: every query is scoped to (workspace, owner)
  // so a member can only ever see or manage tokens they created themselves.
  async listMcpTokens(
    workspaceId: string,
    ownerId: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      identityType: string;
      identityId: string;
      scopes: string[];
      enabled: boolean;
      lastUsedAt: number | null;
      createdAt: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(schema.mcpTokens)
      .where(
        and(eq(schema.mcpTokens.workspaceId, workspaceId), eq(schema.mcpTokens.ownerId, ownerId)),
      )
      .orderBy(desc(schema.mcpTokens.createdAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      identityType: r.identityType,
      identityId: r.identityId,
      scopes: r.scopes ?? [],
      enabled: r.enabled,
      lastUsedAt: r.lastUsedAt ? r.lastUsedAt.getTime() : null,
      createdAt: r.createdAt.getTime(),
    }));
  }

  // Enable/disable a token, scoped to its workspace AND owner — a caller can't
  // flip someone else's token. Returns false if no row matched.
  async setMcpTokenEnabled(
    id: string,
    workspaceId: string,
    ownerId: string,
    enabled: boolean,
  ): Promise<boolean> {
    const result = await this.db
      .update(schema.mcpTokens)
      .set({ enabled })
      .where(
        and(
          eq(schema.mcpTokens.id, id),
          eq(schema.mcpTokens.workspaceId, workspaceId),
          eq(schema.mcpTokens.ownerId, ownerId),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  // Hard-delete (revoke) a token, scoped to its workspace AND owner.
  async revokeMcpToken(id: string, workspaceId: string, ownerId: string): Promise<boolean> {
    const result = await this.db
      .delete(schema.mcpTokens)
      .where(
        and(
          eq(schema.mcpTokens.id, id),
          eq(schema.mcpTokens.workspaceId, workspaceId),
          eq(schema.mcpTokens.ownerId, ownerId),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  // Workspace MCP master switch, stored in workspaces.settings.mcpEnabled (no
  // schema change). Off by default: absent/false both mean disabled.
  async getMcpEnabled(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return row?.settings?.mcpEnabled === true;
  }

  // Authoritative workspace settings (the relay's source of truth for the
  // create-agent/cybo permission rule, which the daemon's local SQLite never
  // syncs). Returns {} when the workspace has no settings row.
  async getWorkspaceSettings(workspaceId: string): Promise<Record<string, unknown>> {
    const [row] = await this.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return (row?.settings as Record<string, unknown> | null) ?? {};
  }

  async setMcpEnabled(workspaceId: string, enabled: boolean): Promise<void> {
    const [row] = await this.db
      .select({ settings: schema.workspaces.settings })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    const settings = { ...row?.settings, mcpEnabled: enabled };
    await this.db
      .update(schema.workspaces)
      .set({ settings })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  // ─── Webhooks (inbound, GitHub-style config) ─────────────────────
  // Per-channel webhook config: HMAC secret, content type, event allowlist,
  // active toggle. The secret NEVER leaves the server except once on set/rotate
  // (returned by the RPC, not from these read methods).

  async createWebhook(opts: {
    id: string;
    channelId: string;
    workspaceId: string;
    name: string;
    secret?: string | null;
    contentType?: string;
    eventMode?: string;
    events?: string[];
    active?: boolean;
    createdBy: string;
  }): Promise<void> {
    await this.db.insert(schema.webhooks).values({
      id: opts.id,
      channelId: opts.channelId,
      workspaceId: opts.workspaceId,
      name: opts.name,
      secret: opts.secret ?? null,
      contentType: opts.contentType ?? "application/json",
      eventMode: opts.eventMode ?? "release",
      events: opts.events ?? [],
      active: opts.active ?? true,
      createdBy: opts.createdBy,
    });
  }

  // Webhook config WITHOUT the secret — safe to return to the UI. hasSecret tells
  // the panel whether a secret is set (it can never read the value back).
  private mapWebhook(r: typeof schema.webhooks.$inferSelect): StoredWebhook {
    return {
      id: r.id,
      channelId: r.channelId,
      workspaceId: r.workspaceId,
      name: r.name,
      hasSecret: !!r.secret,
      contentType: r.contentType,
      eventMode: r.eventMode,
      events: r.events ?? [],
      active: r.active,
      createdBy: r.createdBy,
      lastDeliveryAt: r.lastDeliveryAt ? r.lastDeliveryAt.getTime() : null,
      createdAt: r.createdAt.getTime(),
    };
  }

  async listWebhooks(channelId: string): Promise<StoredWebhook[]> {
    const rows = await this.db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.channelId, channelId))
      .orderBy(desc(schema.webhooks.createdAt));
    return rows.map((r) => this.mapWebhook(r));
  }

  async getWebhook(id: string): Promise<StoredWebhook | null> {
    const [row] = await this.db
      .select()
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, id))
      .limit(1);
    return row ? this.mapWebhook(row) : null;
  }

  // The most-recently-created ACTIVE webhook for a channel, INCLUDING its secret
  // — used only server-side by the receive endpoint to verify the HMAC signature.
  async getActiveWebhookForChannel(channelId: string): Promise<StoredWebhookWithSecret | null> {
    const [row] = await this.db
      .select()
      .from(schema.webhooks)
      .where(and(eq(schema.webhooks.channelId, channelId), eq(schema.webhooks.active, true)))
      .orderBy(desc(schema.webhooks.createdAt))
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      channelId: row.channelId,
      workspaceId: row.workspaceId,
      secret: row.secret,
      eventMode: row.eventMode,
      events: row.events ?? [],
      createdBy: row.createdBy,
      // Reactive trigger (#620): the cybo to fire + the prompt template rendered
      // from the event payload. NULL/absent → card-only (today's behavior).
      triggerCyboId: row.triggerCyboId ?? null,
      promptTemplate: row.promptTemplate ?? null,
    };
  }

  async updateWebhook(
    id: string,
    workspaceId: string,
    patch: {
      name?: string;
      contentType?: string;
      eventMode?: string;
      events?: string[];
      active?: boolean;
    },
  ): Promise<boolean> {
    const set: Partial<typeof schema.webhooks.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.contentType !== undefined) set.contentType = patch.contentType;
    if (patch.eventMode !== undefined) set.eventMode = patch.eventMode;
    if (patch.events !== undefined) set.events = patch.events;
    if (patch.active !== undefined) set.active = patch.active;
    if (Object.keys(set).length === 0) return false;
    const result = await this.db
      .update(schema.webhooks)
      .set(set)
      .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.workspaceId, workspaceId)));
    return (result.rowCount ?? 0) > 0;
  }

  // Set or rotate the HMAC secret (null clears it). Scoped to the workspace.
  async setWebhookSecret(id: string, workspaceId: string, secret: string | null): Promise<boolean> {
    const result = await this.db
      .update(schema.webhooks)
      .set({ secret })
      .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.workspaceId, workspaceId)));
    return (result.rowCount ?? 0) > 0;
  }

  async deleteWebhook(id: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .delete(schema.webhooks)
      .where(and(eq(schema.webhooks.id, id), eq(schema.webhooks.workspaceId, workspaceId)));
    return (result.rowCount ?? 0) > 0;
  }

  async touchWebhookDelivery(id: string): Promise<void> {
    await this.db
      .update(schema.webhooks)
      .set({ lastDeliveryAt: new Date() })
      .where(eq(schema.webhooks.id, id));
  }

  // ─── Webhook deliveries ("Recent Deliveries" history) ────────────

  async insertWebhookDelivery(opts: {
    id: string;
    webhookId: string;
    channelId: string;
    workspaceId: string;
    event?: string | null;
    action?: string | null;
    requestHeaders?: Record<string, string> | null;
    requestBody?: string | null;
    responseStatus: number;
    responseBody?: string | null;
    ok: boolean;
    redeliveredFrom?: string | null;
  }): Promise<void> {
    await this.db.insert(schema.webhookDeliveries).values({
      id: opts.id,
      webhookId: opts.webhookId,
      channelId: opts.channelId,
      workspaceId: opts.workspaceId,
      event: opts.event ?? null,
      action: opts.action ?? null,
      requestHeaders: opts.requestHeaders ?? null,
      requestBody: opts.requestBody ?? null,
      responseStatus: opts.responseStatus,
      responseBody: opts.responseBody ?? null,
      ok: opts.ok,
      redeliveredFrom: opts.redeliveredFrom ?? null,
    });
    // Cap retained deliveries per webhook (keep the most recent 50) so the log
    // doesn't grow unbounded — GitHub keeps a recent window too.
    await this.db.execute(sql`
      DELETE FROM webhook_deliveries
      WHERE webhook_id = ${opts.webhookId}
        AND id NOT IN (
          SELECT id FROM webhook_deliveries
          WHERE webhook_id = ${opts.webhookId}
          ORDER BY created_at DESC
          LIMIT 50
        )
    `);
  }

  async listWebhookDeliveries(webhookId: string, limit = 30): Promise<StoredWebhookDelivery[]> {
    const rows = await this.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      webhookId: r.webhookId,
      channelId: r.channelId,
      event: r.event,
      action: r.action,
      requestHeaders: r.requestHeaders ?? null,
      requestBody: r.requestBody,
      responseStatus: r.responseStatus,
      responseBody: r.responseBody,
      ok: r.ok,
      redeliveredFrom: r.redeliveredFrom,
      createdAt: r.createdAt.getTime(),
    }));
  }

  async getWebhookDelivery(id: string): Promise<StoredWebhookDelivery | null> {
    const [r] = await this.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, id))
      .limit(1);
    if (!r) return null;
    return {
      id: r.id,
      webhookId: r.webhookId,
      channelId: r.channelId,
      event: r.event,
      action: r.action,
      requestHeaders: r.requestHeaders ?? null,
      requestBody: r.requestBody,
      responseStatus: r.responseStatus,
      responseBody: r.responseBody,
      ok: r.ok,
      redeliveredFrom: r.redeliveredFrom,
      createdAt: r.createdAt.getTime(),
    };
  }

  // ─── Outgoing webhooks (#598) ───────────────────────────────────

  private mapOutgoingWebhook(
    r: typeof schema.outgoingWebhooks.$inferSelect,
  ): StoredOutgoingWebhook {
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      channelId: r.channelId,
      name: r.name,
      url: r.url,
      events: r.events ?? {},
      isActive: r.isActive,
      failureCount: r.failureCount,
      lastTriggeredAt: r.lastTriggeredAt?.getTime() ?? null,
      lastSuccessAt: r.lastSuccessAt?.getTime() ?? null,
      lastFailureAt: r.lastFailureAt?.getTime() ?? null,
      lastError: r.lastError,
      createdBy: r.createdBy,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
    };
  }

  // Persist a new outgoing webhook. `secretKeyHash` is the sha256 of the raw
  // secret (the raw is returned to the client once by the caller, never stored).
  async createOutgoingWebhook(opts: {
    id: string;
    workspaceId: string;
    channelId: string;
    url: string;
    secretKeyHash: string;
    name?: string;
    events: OutgoingWebhookEventFlags;
    createdBy: string;
  }): Promise<StoredOutgoingWebhook> {
    const [row] = await this.db
      .insert(schema.outgoingWebhooks)
      .values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        url: opts.url,
        secretKey: opts.secretKeyHash,
        name: opts.name ?? "Webhook",
        events: opts.events,
        createdBy: opts.createdBy,
      })
      .returning();
    return this.mapOutgoingWebhook(row);
  }

  async listOutgoingWebhooks(
    workspaceId: string,
    channelId?: string,
  ): Promise<StoredOutgoingWebhook[]> {
    const where = channelId
      ? and(
          eq(schema.outgoingWebhooks.workspaceId, workspaceId),
          eq(schema.outgoingWebhooks.channelId, channelId),
        )
      : eq(schema.outgoingWebhooks.workspaceId, workspaceId);
    const rows = await this.db
      .select()
      .from(schema.outgoingWebhooks)
      .where(where)
      .orderBy(desc(schema.outgoingWebhooks.createdAt));
    return rows.map((r) => this.mapOutgoingWebhook(r));
  }

  // Single webhook scoped to its workspace (so one workspace can't fetch
  // another's by guessing an id).
  async getOutgoingWebhook(id: string, workspaceId: string): Promise<StoredOutgoingWebhook | null> {
    const [row] = await this.db
      .select()
      .from(schema.outgoingWebhooks)
      .where(
        and(
          eq(schema.outgoingWebhooks.id, id),
          eq(schema.outgoingWebhooks.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ? this.mapOutgoingWebhook(row) : null;
  }

  // Patch mutable fields. Scoped to the workspace. Returns the updated row, or
  // null when nothing matched. `secretKeyHash` rotates the signing secret.
  async updateOutgoingWebhook(
    id: string,
    workspaceId: string,
    patch: {
      name?: string;
      url?: string;
      events?: OutgoingWebhookEventFlags;
      isActive?: boolean;
      secretKeyHash?: string;
    },
  ): Promise<StoredOutgoingWebhook | null> {
    const set: Partial<typeof schema.outgoingWebhooks.$inferInsert> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.url !== undefined) set.url = patch.url;
    if (patch.events !== undefined) set.events = patch.events;
    if (patch.isActive !== undefined) {
      set.isActive = patch.isActive;
      // Re-enabling clears the failure counter so the backoff starts fresh.
      if (patch.isActive) set.failureCount = 0;
    }
    if (patch.secretKeyHash !== undefined) set.secretKey = patch.secretKeyHash;
    const [row] = await this.db
      .update(schema.outgoingWebhooks)
      .set(set)
      .where(
        and(
          eq(schema.outgoingWebhooks.id, id),
          eq(schema.outgoingWebhooks.workspaceId, workspaceId),
        ),
      )
      .returning();
    return row ? this.mapOutgoingWebhook(row) : null;
  }

  async deleteOutgoingWebhook(id: string, workspaceId: string): Promise<boolean> {
    const result = await this.db
      .delete(schema.outgoingWebhooks)
      .where(
        and(
          eq(schema.outgoingWebhooks.id, id),
          eq(schema.outgoingWebhooks.workspaceId, workspaceId),
        ),
      );
    return (result.rowCount ?? 0) > 0;
  }

  // The ACTIVE outgoing webhooks for a channel, projected to (id, events) — the
  // enqueue path's hot lookup on each message event. Backed by
  // idx_outgoing_webhooks_channel_active.
  async getActiveOutgoingWebhooksForChannel(
    channelId: string,
  ): Promise<ActiveOutgoingWebhookForChannel[]> {
    const rows = await this.db
      .select({ id: schema.outgoingWebhooks.id, events: schema.outgoingWebhooks.events })
      .from(schema.outgoingWebhooks)
      .where(
        and(
          eq(schema.outgoingWebhooks.channelId, channelId),
          eq(schema.outgoingWebhooks.isActive, true),
        ),
      );
    return rows.map((r) => ({ id: r.id, events: r.events ?? {} }));
  }

  // Enqueue one outbox row for (event, webhook). Idempotent via the unique index
  // (event_id, webhook_id) — a re-enqueue of the same event is a no-op. Returns
  // true when a NEW row was inserted. next_retry_at defaults to now() so the row
  // is immediately due.
  async enqueueWebhookOutbox(opts: {
    id: string;
    webhookId: string;
    workspaceId: string;
    eventId: string;
    eventType: string;
    eventData: Record<string, unknown>;
  }): Promise<boolean> {
    const result = await this.db
      .insert(schema.webhookOutbox)
      .values({
        id: opts.id,
        webhookId: opts.webhookId,
        workspaceId: opts.workspaceId,
        eventId: opts.eventId,
        eventType: opts.eventType,
        eventData: opts.eventData,
      })
      .onConflictDoNothing({
        target: [schema.webhookOutbox.eventId, schema.webhookOutbox.webhookId],
      });
    return (result.rowCount ?? 0) > 0;
  }

  // Batched enqueue: insert MANY outbox rows in ONE statement (vs one round-trip
  // per webhook). Same idempotency anchor — the unique index (event_id,
  // webhook_id) + onConflictDoNothing makes a re-enqueue of any (event, webhook)
  // a no-op. Returns the count of rows actually inserted (rowCount excludes
  // conflicts). An empty input is a no-op.
  async enqueueWebhookOutboxBatch(
    rows: Array<{
      id: string;
      webhookId: string;
      workspaceId: string;
      eventId: string;
      eventType: string;
      eventData: Record<string, unknown>;
    }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await this.db
      .insert(schema.webhookOutbox)
      .values(
        rows.map((r) => ({
          id: r.id,
          webhookId: r.webhookId,
          workspaceId: r.workspaceId,
          eventId: r.eventId,
          eventType: r.eventType,
          eventData: r.eventData,
        })),
      )
      .onConflictDoNothing({
        target: [schema.webhookOutbox.eventId, schema.webhookOutbox.webhookId],
      });
    return result.rowCount ?? 0;
  }

  // ATOMIC claim of due outbox rows: select due+undelivered rows FOR UPDATE SKIP
  // LOCKED, bump their attempts + push next_retry_at out so a concurrent tick (or
  // another relay instance) can't grab the same row, and return them joined to
  // the parent webhook's url + secret hash. The push is a SHORT lease (not the
  // real backoff) — the runner overwrites next_retry_at/delivered_at with the
  // true outcome after the HTTP call. A row whose webhook went inactive between
  // enqueue and claim is skipped (inner join on is_active).
  async claimDueWebhookDeliveries(now: number, limit = 20): Promise<DueWebhookDelivery[]> {
    const LEASE_MS = 60_000; // hide a claimed row for 60s while we attempt it
    return this.db.transaction(async (tx) => {
      const due = await tx
        .select({
          outboxId: schema.webhookOutbox.id,
          webhookId: schema.webhookOutbox.webhookId,
          workspaceId: schema.webhookOutbox.workspaceId,
          eventId: schema.webhookOutbox.eventId,
          eventType: schema.webhookOutbox.eventType,
          eventData: schema.webhookOutbox.eventData,
          attempts: schema.webhookOutbox.attempts,
          url: schema.outgoingWebhooks.url,
          secretKeyHash: schema.outgoingWebhooks.secretKey,
          createdBy: schema.outgoingWebhooks.createdBy,
        })
        .from(schema.webhookOutbox)
        .innerJoin(
          schema.outgoingWebhooks,
          eq(schema.webhookOutbox.webhookId, schema.outgoingWebhooks.id),
        )
        .where(
          and(
            isNull(schema.webhookOutbox.deliveredAt),
            lte(schema.webhookOutbox.nextRetryAt, new Date(now)),
            eq(schema.outgoingWebhooks.isActive, true),
          ),
        )
        .orderBy(asc(schema.webhookOutbox.nextRetryAt))
        .limit(limit)
        // Lock ONLY the outbox rows (FOR UPDATE OF webhook_outbox) — the join to
        // outgoing_webhooks is just for the url/secret, so we must not lock (and
        // serialize concurrent ticks against) the parent webhook rows too.
        .for("update", { skipLocked: true, of: schema.webhookOutbox });
      if (due.length === 0) return [];
      const ids = due.map((r) => r.outboxId);
      await tx
        .update(schema.webhookOutbox)
        .set({
          attempts: sql`${schema.webhookOutbox.attempts} + 1`,
          nextRetryAt: new Date(now + LEASE_MS),
        })
        .where(inArray(schema.webhookOutbox.id, ids));
      // Reflect the incremented attempt count in the returned rows (so the runner
      // sees the attempt number it's about to make).
      return due.map((r) => ({
        outboxId: r.outboxId,
        webhookId: r.webhookId,
        workspaceId: r.workspaceId,
        eventId: r.eventId,
        eventType: r.eventType,
        eventData: (r.eventData ?? {}) as Record<string, unknown>,
        attempts: r.attempts + 1,
        url: r.url,
        secretKeyHash: r.secretKeyHash,
        createdBy: r.createdBy,
      }));
    });
  }

  // Mark a claimed outbox row delivered (terminal: success OR dead-letter). On
  // success/dead-letter we stamp delivered_at; a transient failure instead calls
  // rescheduleWebhookOutbox below.
  async markWebhookOutboxDelivered(outboxId: string, now: number): Promise<void> {
    await this.db
      .update(schema.webhookOutbox)
      .set({ deliveredAt: new Date(now) })
      .where(eq(schema.webhookOutbox.id, outboxId));
  }

  // Reschedule a claimed outbox row after a transient failure: push next_retry_at
  // to the backoff time so the next tick re-claims it.
  async rescheduleWebhookOutbox(outboxId: string, nextRetryAt: number): Promise<void> {
    await this.db
      .update(schema.webhookOutbox)
      .set({ nextRetryAt: new Date(nextRetryAt) })
      .where(eq(schema.webhookOutbox.id, outboxId));
  }

  // Apply the outcome of a delivery attempt to the parent webhook row. On
  // success: reset failure_count, stamp last_success_at + last_triggered_at,
  // clear last_error. On failure: increment failure_count, stamp last_failure_at
  // + last_triggered_at + last_error, and DEACTIVATE when `deactivate` (cap hit).
  async applyWebhookDeliveryOutcome(opts: {
    webhookId: string;
    now: number;
    success: boolean;
    deactivate?: boolean;
    error?: string | null;
  }): Promise<{ deactivated: boolean; createdBy: string; name: string; url: string } | null> {
    const at = new Date(opts.now);
    const set: Partial<typeof schema.outgoingWebhooks.$inferInsert> = {
      updatedAt: at,
      lastTriggeredAt: at,
    };
    if (opts.success) {
      set.failureCount = 0;
      set.lastSuccessAt = at;
      set.lastError = null;
    } else {
      set.failureCount = sql`${schema.outgoingWebhooks.failureCount} + 1` as unknown as number;
      set.lastFailureAt = at;
      set.lastError = opts.error ?? null;
      if (opts.deactivate) set.isActive = false;
    }
    const [row] = await this.db
      .update(schema.outgoingWebhooks)
      .set(set)
      .where(eq(schema.outgoingWebhooks.id, opts.webhookId))
      .returning({
        isActive: schema.outgoingWebhooks.isActive,
        createdBy: schema.outgoingWebhooks.createdBy,
        name: schema.outgoingWebhooks.name,
        url: schema.outgoingWebhooks.url,
      });
    if (!row) return null;
    return {
      deactivated: opts.success ? false : opts.deactivate === true,
      createdBy: row.createdBy,
      name: row.name,
      url: row.url,
    };
  }

  // Append a per-attempt audit row + prune to a recent cap per webhook (parity
  // with insertWebhookDelivery's window).
  async insertWebhookDeliveryLog(opts: {
    id: string;
    webhookId: string;
    outboxId: string;
    workspaceId: string;
    eventType: string;
    status: "success" | "failure";
    responseStatus?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryCount: number;
    nextRetryAt?: number | null;
  }): Promise<void> {
    await this.db.insert(schema.webhookDeliveryLogs).values({
      id: opts.id,
      webhookId: opts.webhookId,
      outboxId: opts.outboxId,
      workspaceId: opts.workspaceId,
      eventType: opts.eventType,
      status: opts.status,
      responseStatus: opts.responseStatus ?? null,
      errorCode: opts.errorCode ?? null,
      errorMessage: opts.errorMessage ?? null,
      retryCount: opts.retryCount,
      nextRetryAt: opts.nextRetryAt ? new Date(opts.nextRetryAt) : null,
    });
    // Retention prune. Running a `DELETE ... NOT IN (... LIMIT 100)` on EVERY
    // insert is wasted work — the table only needs to stay bounded, not trimmed
    // to the exact cap on every row. Probabilistically prune ~2% of inserts so
    // the table converges toward the 100-row window without a delete per attempt.
    if (Math.random() < 0.02) {
      await this.db.execute(sql`
        DELETE FROM webhook_delivery_logs
        WHERE webhook_id = ${opts.webhookId}
          AND id NOT IN (
            SELECT id FROM webhook_delivery_logs
            WHERE webhook_id = ${opts.webhookId}
            ORDER BY created_at DESC
            LIMIT 100
          )
      `);
    }
  }

  // ─── User statuses (P2 Item 6) ──────────────────────────────────
  // Upsert the caller's custom status for a workspace. A null emoji+text clears
  // it (we delete the row so getUserStatuses naturally omits it).
  async setUserStatus(opts: {
    id: string;
    workspaceId: string;
    userId: string;
    emoji: string | null;
    text: string | null;
    expiresAt: number | null;
  }): Promise<void> {
    if (opts.emoji === null && opts.text === null) {
      await this.db
        .delete(schema.userStatuses)
        .where(
          and(
            eq(schema.userStatuses.workspaceId, opts.workspaceId),
            eq(schema.userStatuses.userId, opts.userId),
          ),
        );
      return;
    }
    const expiresAt = opts.expiresAt ? new Date(opts.expiresAt) : null;
    await this.db
      .insert(schema.userStatuses)
      .values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        emoji: opts.emoji,
        text: opts.text,
        expiresAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.userStatuses.workspaceId, schema.userStatuses.userId],
        set: {
          emoji: opts.emoji,
          text: opts.text,
          expiresAt,
          updatedAt: new Date(),
        },
      });
  }

  // Statuses for a set of users in a workspace. Expired rows are filtered out (and
  // not returned) so callers always get live statuses; epoch-ms timestamps match
  // the rest of the gateway.
  async getUserStatuses(
    workspaceId: string,
    userIds: string[],
  ): Promise<
    Array<{ userId: string; emoji: string | null; text: string | null; expiresAt: number | null }>
  > {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select({
        userId: schema.userStatuses.userId,
        emoji: schema.userStatuses.emoji,
        text: schema.userStatuses.text,
        expiresAt: schema.userStatuses.expiresAt,
      })
      .from(schema.userStatuses)
      .where(
        and(
          eq(schema.userStatuses.workspaceId, workspaceId),
          inArray(schema.userStatuses.userId, userIds),
          or(isNull(schema.userStatuses.expiresAt), gt(schema.userStatuses.expiresAt, new Date())),
        ),
      );
    return rows.map((r) => ({
      userId: r.userId,
      emoji: r.emoji,
      text: r.text,
      expiresAt: r.expiresAt?.getTime() ?? null,
    }));
  }

  // ── Session aliases (per-user, display-only) ───────────────────────
  // Personal cosmetic label for an agent session; one alias per (user, agent).
  async setSessionAlias(userId: string, agentId: string, alias: string): Promise<void> {
    await this.db
      .insert(schema.sessionAliases)
      .values({ userId, agentId, alias, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.sessionAliases.userId, schema.sessionAliases.agentId],
        set: { alias, updatedAt: new Date() },
      });
  }

  async deleteSessionAlias(userId: string, agentId: string): Promise<void> {
    await this.db
      .delete(schema.sessionAliases)
      .where(
        and(eq(schema.sessionAliases.userId, userId), eq(schema.sessionAliases.agentId, agentId)),
      );
  }

  // All of a user's aliases as { agentId: alias }. The caller is always the user
  // themselves (per-user, never shared).
  async getSessionAliases(userId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({
        agentId: schema.sessionAliases.agentId,
        alias: schema.sessionAliases.alias,
      })
      .from(schema.sessionAliases)
      .where(eq(schema.sessionAliases.userId, userId));
    const out: Record<string, string> = {};
    for (const r of rows) out[r.agentId] = r.alias;
    return out;
  }

  // ── Terminal aliases (per-user, display-only, cross-device synced) ──
  // Personal cosmetic label for a terminal session; one alias per (user, terminal).
  async setTerminalAlias(userId: string, terminalId: string, alias: string): Promise<void> {
    await this.db
      .insert(schema.terminalAliases)
      .values({ userId, terminalId, alias, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.terminalAliases.userId, schema.terminalAliases.terminalId],
        set: { alias, updatedAt: new Date() },
      });
  }

  async deleteTerminalAlias(userId: string, terminalId: string): Promise<void> {
    await this.db
      .delete(schema.terminalAliases)
      .where(
        and(
          eq(schema.terminalAliases.userId, userId),
          eq(schema.terminalAliases.terminalId, terminalId),
        ),
      );
  }

  // All of a user's terminal aliases as { terminalId: alias }. The caller is
  // always the user themselves (per-user, never shared).
  async getTerminalAliases(userId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({
        terminalId: schema.terminalAliases.terminalId,
        alias: schema.terminalAliases.alias,
      })
      .from(schema.terminalAliases)
      .where(eq(schema.terminalAliases.userId, userId));
    const out: Record<string, string> = {};
    for (const r of rows) out[r.terminalId] = r.alias;
    return out;
  }

  // Drop every status whose expires_at has passed. Cheap housekeeping; safe to
  // call opportunistically (e.g. on workspace open) so stale statuses don't leak.
  // Returns the (workspaceId, userId) of each cleared row so the caller can
  // broadcast a `user_status_changed` clear to live clients — otherwise a status
  // that expires while a client is connected lingers until the next full resync.
  async clearExpiredStatuses(): Promise<Array<{ workspaceId: string; userId: string }>> {
    return this.db
      .delete(schema.userStatuses)
      .where(
        and(
          isNotNull(schema.userStatuses.expiresAt),
          lt(schema.userStatuses.expiresAt, new Date()),
        ),
      )
      .returning({
        workspaceId: schema.userStatuses.workspaceId,
        userId: schema.userStatuses.userId,
      });
  }

  // ─── Activity read-by-source (P2 Item 9) ────────────────────────
  // Mark every unread activity row a user has for a given channel as read, so
  // reading a channel clears its mentions/thread-replies from the Activity feed.
  // Returns whether anything changed (drives whether to broadcast).
  async markActivityReadByChannel(
    workspaceId: string,
    userId: string,
    channelId: string,
  ): Promise<boolean> {
    const res = await this.db
      .update(schema.activityEvents)
      .set({ isRead: true })
      .where(
        and(
          eq(schema.activityEvents.workspaceId, workspaceId),
          eq(schema.activityEvents.userId, userId),
          eq(schema.activityEvents.channelId, channelId),
          eq(schema.activityEvents.isRead, false),
        ),
      );
    return (res.rowCount ?? 0) > 0;
  }

  // DM-scoped counterpart: mark a user's activity from a specific DM peer read.
  async markActivityReadByDmPeer(
    workspaceId: string,
    userId: string,
    peerId: string,
  ): Promise<boolean> {
    const res = await this.db
      .update(schema.activityEvents)
      .set({ isRead: true })
      .where(
        and(
          eq(schema.activityEvents.workspaceId, workspaceId),
          eq(schema.activityEvents.userId, userId),
          eq(schema.activityEvents.dmPeerId, peerId),
          eq(schema.activityEvents.isRead, false),
        ),
      );
    return (res.rowCount ?? 0) > 0;
  }

  // Task-scoped counterpart: opening a task's detail card clears that task's
  // Activity rows (task_assigned / task_status_changed). Task rows carry no
  // channelId/dmPeerId, so they're keyed by sourceType="task" + sourceId=taskId.
  async markActivityReadByTask(
    workspaceId: string,
    userId: string,
    taskId: string,
  ): Promise<boolean> {
    const res = await this.db
      .update(schema.activityEvents)
      .set({ isRead: true })
      .where(
        and(
          eq(schema.activityEvents.workspaceId, workspaceId),
          eq(schema.activityEvents.userId, userId),
          eq(schema.activityEvents.sourceType, "task"),
          eq(schema.activityEvents.sourceId, taskId),
          eq(schema.activityEvents.isRead, false),
        ),
      );
    return (res.rowCount ?? 0) > 0;
  }

  // ─── User presence: durable manual away (P2 #6a) ──────────────────
  // Persist the caller's manual "away" toggle. Unlike connection-derived online
  // status, manual away survives a full disconnect (it's a person's choice, not
  // their socket state), so it lives in PG and is hydrated on relay startup.
  async setUserAway(userId: string, isAway: boolean): Promise<void> {
    await this.db
      .insert(schema.userPresence)
      .values({ userId, isAway, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.userPresence.userId,
        set: { isAway, updatedAt: new Date() },
      });
  }

  // Every user who is currently flagged manually away. Hydrated into the relay's
  // in-memory awayUsers set on startup so away persists across relay restarts.
  async getAwayUserIds(): Promise<string[]> {
    const rows = await this.db
      .select({ userId: schema.userPresence.userId })
      .from(schema.userPresence)
      .where(eq(schema.userPresence.isAway, true));
    return rows.map((r) => r.userId);
  }

  // Push gating (#604): of `userIds`, the subset whose push should be SUPPRESSED
  // right now — manually away (is_away) OR inside an unexpired Do-Not-Disturb
  // window (dnd_until > now). The relay's dispatchPush drops these before BOTH
  // the web-push and FCM arms. The presence data is already persisted + broadcast
  // for the away/DND dots; it was just never consulted at push time. A user with
  // no presence row matches nothing → not suppressed (the common case).
  async getPushSuppressedUserIds(userIds: string[], now: Date): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    // Chunk the IN list: a post to a large #general fans out to thousands of
    // recipients, and a single huge `inArray` can blow past Postgres's 65535
    // bind-parameter limit. 1000/query stays well under it; the union is the
    // same suppressed set.
    const CHUNK = 1000;
    const suppressed = new Set<string>();
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const batch = userIds.slice(i, i + CHUNK);
      const rows = await this.db
        .select({ userId: schema.userPresence.userId })
        .from(schema.userPresence)
        .where(
          and(
            inArray(schema.userPresence.userId, batch),
            or(eq(schema.userPresence.isAway, true), gt(schema.userPresence.dndUntil, now)),
          ),
        );
      for (const r of rows) suppressed.add(r.userId);
    }
    return suppressed;
  }

  // ─── Subscriptions / license (Stripe billing — cloud only) ────────

  // The owner of a workspace. Checkout/portal are owner-only (a member must not
  // be able to start or cancel billing), so the Stripe routes resolve this.
  async getWorkspaceOwnerId(workspaceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ownerId: schema.workspaces.ownerId })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return row?.ownerId ?? null;
  }

  // The workspace creation timestamp — the trial anchor. The server is
  // authoritative for the 7-day trial: trialing = created within 7 days AND no
  // paid subscription yet. (The old client localStorage clock is advisory only.)
  async getWorkspaceCreatedAt(workspaceId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ createdAt: schema.workspaces.createdAt })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return row?.createdAt ?? null;
  }

  async getSubscription(
    workspaceId: string,
  ): Promise<typeof schema.subscriptions.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.workspaceId, workspaceId))
      .limit(1);
    return row ?? null;
  }

  // Upsert keyed by workspaceId — survives Stripe's concurrent/duplicate webhook
  // delivery (checkout.session.completed can arrive more than once). Mirrors v1.
  async upsertSubscription(params: {
    workspaceId: string;
    stripeCustomerId: string;
    stripeSubscriptionId?: string | null;
    plan?: string;
    status: string;
    priceId?: string | null;
    currentPeriodEnd?: Date | null;
    trialEndsAt?: Date | null;
    cancelAtPeriodEnd?: boolean;
    // Acquisition channel ('web' | 'desktop' | ...). Only written when present so
    // a later webhook (which doesn't know the platform) never nulls an existing
    // value. Stays NULL = unknown for rows that never carried it (e.g. IAP).
    purchasePlatform?: string | null;
  }): Promise<void> {
    const now = new Date();
    // Safety net: when the caller doesn't tag the platform, derive it from the
    // stripeCustomerId discriminator (manual comp sentinel / `revenuecat:` →
    // Apple / `cus_` → Stripe). Guarantees manual grants and untagged callers
    // still populate purchase_platform; unrecognized ids stay NULL = unknown.
    const derivedPlatform =
      params.purchasePlatform ?? derivePurchasePlatform(params.stripeCustomerId);
    const set = {
      stripeCustomerId: params.stripeCustomerId,
      stripeSubscriptionId: params.stripeSubscriptionId ?? null,
      plan: params.plan ?? "pro",
      status: params.status,
      priceId: params.priceId ?? null,
      currentPeriodEnd: params.currentPeriodEnd ?? null,
      trialEndsAt: params.trialEndsAt ?? null,
      cancelAtPeriodEnd: params.cancelAtPeriodEnd ?? false,
      updatedAt: now,
      // Only set the platform when the caller has one (checkout completion) or one
      // could be derived, so a re-delivered/subsequent event without platform
      // metadata doesn't clear it.
      ...(derivedPlatform ? { purchasePlatform: derivedPlatform } : {}),
    };
    await this.db
      .insert(schema.subscriptions)
      .values({ workspaceId: params.workspaceId, createdAt: now, ...set })
      .onConflictDoUpdate({ target: schema.subscriptions.workspaceId, set });
  }

  // Partial update keyed by workspaceId (customer.subscription.updated/deleted).
  async updateSubscriptionByWorkspace(
    workspaceId: string,
    updates: Partial<{
      plan: string;
      status: string;
      currentPeriodEnd: Date | null;
      trialEndsAt: Date | null;
      cancelAtPeriodEnd: boolean;
    }>,
  ): Promise<void> {
    await this.db
      .update(schema.subscriptions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(schema.subscriptions.workspaceId, workspaceId));
  }

  // invoice.payment_failed carries the Stripe subscription id, not workspaceId.
  async markSubscriptionPastDue(stripeSubscriptionId: string): Promise<void> {
    await this.db
      .update(schema.subscriptions)
      .set({ status: "past_due", updatedAt: new Date() })
      .where(eq(schema.subscriptions.stripeSubscriptionId, stripeSubscriptionId));
  }

  // ─── License pools + allocations (per-workspace seat model) ───────
  //
  // A pool is one buyer's seat entitlement on one rail (iOS/Stripe); an
  // allocation spends a seat on a workspace. The derive step in
  // billing/license-pool.ts reads these to recompute the subscriptions cache.
  // These methods are additive persistence only — guards live in their callers.

  // A pool by its primary key.
  async getPoolById(poolId: string): Promise<typeof schema.licensePools.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(schema.licensePools)
      .where(eq(schema.licensePools.id, poolId))
      .limit(1);
    return row ?? null;
  }

  // The (owner, rail) pool — hits the unique idx_license_pools_owner_rail index.
  async getPoolByOwnerRail(
    ownerUserId: string,
    rail: string,
  ): Promise<typeof schema.licensePools.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(schema.licensePools)
      .where(
        and(eq(schema.licensePools.ownerUserId, ownerUserId), eq(schema.licensePools.rail, rail)),
      )
      .limit(1);
    return row ?? null;
  }

  // All pools a user owns (at most one per rail), oldest-first.
  async getPoolsForUser(
    ownerUserId: string,
  ): Promise<Array<typeof schema.licensePools.$inferSelect>> {
    return await this.db
      .select()
      .from(schema.licensePools)
      .where(eq(schema.licensePools.ownerUserId, ownerUserId))
      .orderBy(asc(schema.licensePools.createdAt));
  }

  // Upsert a pool keyed by the unique (owner_user_id, rail) index. On insert a
  // fresh `pool_<uuid>` id + timestamps are written; on conflict id/createdAt are
  // preserved.
  //
  // The on-conflict `set` is built CONDITIONALLY: only the OPTIONAL fields the
  // caller actually passed (`!== undefined`) are overwritten. Always-set fields
  // are `seatCount`, `status`, `updatedAt`. This stops a partial upsert (e.g. a
  // flag-cancel or a status flip that omits product/period/customer) from
  // NULLING fields the caller never meant to touch — the previous unconditional
  // `?? null` / `?? false` erased the existing customer id / product / period on
  // every such update. The INSERT branch still materializes the omitted optional
  // columns to NULL/false via their column defaults / explicit values below.
  async upsertPool(params: {
    ownerUserId: string;
    rail: string;
    seatCount: number;
    status: string;
    productId?: string | null;
    entitlementId?: string | null;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
  }): Promise<typeof schema.licensePools.$inferSelect> {
    const now = new Date();
    // Always-overwrite fields.
    const set: Partial<typeof schema.licensePools.$inferInsert> = {
      seatCount: params.seatCount,
      status: params.status,
      updatedAt: now,
    };
    // Conditionally-overwrite optional fields — only when the caller passed them,
    // so an omitted field keeps its existing value on conflict.
    if (params.productId !== undefined) set.productId = params.productId;
    if (params.entitlementId !== undefined) set.entitlementId = params.entitlementId;
    if (params.stripeCustomerId !== undefined) set.stripeCustomerId = params.stripeCustomerId;
    if (params.stripeSubscriptionId !== undefined)
      set.stripeSubscriptionId = params.stripeSubscriptionId;
    if (params.currentPeriodEnd !== undefined) set.currentPeriodEnd = params.currentPeriodEnd;
    if (params.cancelAtPeriodEnd !== undefined) set.cancelAtPeriodEnd = params.cancelAtPeriodEnd;

    const [row] = await this.db
      .insert(schema.licensePools)
      .values({
        id: `pool_${randomUUID()}`,
        ownerUserId: params.ownerUserId,
        rail: params.rail,
        createdAt: now,
        // Insert branch: materialize omitted optionals to their null/false
        // defaults so a fresh row is fully specified.
        seatCount: params.seatCount,
        status: params.status,
        productId: params.productId ?? null,
        entitlementId: params.entitlementId ?? null,
        stripeCustomerId: params.stripeCustomerId ?? null,
        stripeSubscriptionId: params.stripeSubscriptionId ?? null,
        currentPeriodEnd: params.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: params.cancelAtPeriodEnd ?? false,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.licensePools.ownerUserId, schema.licensePools.rail],
        set,
      })
      .returning();
    return row;
  }

  // Flag/clear an end-of-period cancel on the (owner, rail) pool. Used by the
  // RevenueCat CANCELLATION path (revenuecat.ts flagPoolCancel, Unit C); the
  // caller then reconcilePool to propagate cancelAtPeriodEnd to the cache rows.
  async setPoolCancelAtPeriodEnd(
    ownerUserId: string,
    rail: string,
    cancel: boolean,
  ): Promise<void> {
    await this.db
      .update(schema.licensePools)
      .set({ cancelAtPeriodEnd: cancel, updatedAt: new Date() })
      .where(
        and(eq(schema.licensePools.ownerUserId, ownerUserId), eq(schema.licensePools.rail, rail)),
      );
  }

  // A pool's allocations, oldest-first. The honored-set ordering (§6.1) depends
  // on this createdAt ASC order, so keep it deterministic.
  async getAllocationsForPool(
    poolId: string,
  ): Promise<Array<typeof schema.licenseAllocations.$inferSelect>> {
    return await this.db
      .select()
      .from(schema.licenseAllocations)
      .where(eq(schema.licenseAllocations.poolId, poolId))
      .orderBy(asc(schema.licenseAllocations.createdAt));
  }

  // The single allocation backing a workspace (workspaceId is unique).
  async getAllocationForWorkspace(
    workspaceId: string,
  ): Promise<typeof schema.licenseAllocations.$inferSelect | null> {
    const [row] = await this.db
      .select()
      .from(schema.licenseAllocations)
      .where(eq(schema.licenseAllocations.workspaceId, workspaceId))
      .limit(1);
    return row ?? null;
  }

  // Every allocation whose pool is owned by this user (join allocations→pools).
  // Returns the allocation rows (the seats the buyer has spent across rails).
  async getAllocationsForUserWorkspaces(
    ownerUserId: string,
  ): Promise<Array<typeof schema.licenseAllocations.$inferSelect>> {
    const rows = await this.db
      .select({ allocation: schema.licenseAllocations })
      .from(schema.licenseAllocations)
      .innerJoin(schema.licensePools, eq(schema.licenseAllocations.poolId, schema.licensePools.id))
      .where(eq(schema.licensePools.ownerUserId, ownerUserId));
    return rows.map((r) => r.allocation);
  }

  // Idempotently persist a (pool → workspace) seat allocation. Re-inserting the
  // same workspace is a no-op (the unique idx_license_allocations_workspace
  // index) — it returns the existing row, never throws.
  //
  // Callers (Unit E `cyborg:allocate_license`) MUST enforce: (1) owner-only,
  // (2) free seat available (countAllocationsForPool < pool.seatCount),
  // (3) no-dual-rail (target workspace not already Pro on the other rail) BEFORE
  // calling this. This method only persists the edge idempotently.
  async insertAllocation(params: {
    poolId: string;
    workspaceId: string;
  }): Promise<typeof schema.licenseAllocations.$inferSelect> {
    await this.db
      .insert(schema.licenseAllocations)
      .values({
        id: `alloc_${randomUUID()}`,
        poolId: params.poolId,
        workspaceId: params.workspaceId,
        createdAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.licenseAllocations.workspaceId });
    // Re-select so we return the canonical row whether we just inserted it or it
    // already existed (the conflict no-op leaves the prior row untouched).
    const [row] = await this.db
      .select()
      .from(schema.licenseAllocations)
      .where(eq(schema.licenseAllocations.workspaceId, params.workspaceId))
      .limit(1);
    return row;
  }

  // Atomically claim a free seat from a pool for a workspace. Closes the
  // write-skew race the non-atomic count-then-insert had under READ COMMITTED:
  // two concurrent `cyborg:allocate_license` calls could each read
  // `count < seatCount` and both insert, exceeding the seat budget. Here we
  // open a transaction, take a ROW LOCK on the pool (`SELECT ... FOR UPDATE`) so
  // concurrent allocations on the SAME pool serialize, re-count allocations
  // under that lock, and insert ONLY if a seat is still free — else return
  // `no_free_seat`. The unique workspaceId index makes a duplicate insert a
  // no-op, so re-allocating an already-allocated workspace returns `ok` without
  // consuming a seat. Callers still enforce owner / no_pool / no-dual-rail
  // around this (those are not seat-budget races).
  async allocateSeatAtomic(
    poolId: string,
    workspaceId: string,
  ): Promise<{ ok: boolean; reason?: "no_pool" | "no_free_seat" }> {
    return this.db.transaction(async (tx) => {
      // Lock the pool row so a concurrent allocate on the same pool waits here
      // until we commit/rollback — the count below is then race-free.
      const [pool] = await tx
        .select({ seatCount: schema.licensePools.seatCount })
        .from(schema.licensePools)
        .where(eq(schema.licensePools.id, poolId))
        .limit(1)
        .for("update");
      if (!pool) return { ok: false, reason: "no_pool" as const };

      // Already allocated to THIS workspace → idempotent success, no seat spent.
      const [existing] = await tx
        .select({ id: schema.licenseAllocations.id })
        .from(schema.licenseAllocations)
        .where(eq(schema.licenseAllocations.workspaceId, workspaceId))
        .limit(1);
      if (existing) return { ok: true };

      // Re-count under the lock; refuse if no free seat remains.
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.licenseAllocations)
        .where(eq(schema.licenseAllocations.poolId, poolId));
      if ((counted?.count ?? 0) >= pool.seatCount) {
        return { ok: false, reason: "no_free_seat" as const };
      }

      await tx
        .insert(schema.licenseAllocations)
        .values({
          id: `alloc_${randomUUID()}`,
          poolId,
          workspaceId,
          createdAt: new Date(),
        })
        .onConflictDoNothing({ target: schema.licenseAllocations.workspaceId });
      return { ok: true };
    });
  }

  // Free a seat by removing a workspace's allocation (deallocate).
  async deleteAllocation(workspaceId: string): Promise<void> {
    await this.db
      .delete(schema.licenseAllocations)
      .where(eq(schema.licenseAllocations.workspaceId, workspaceId));
  }

  // Allocations currently spent from a pool (for free-seat checks by Unit E).
  async countAllocationsForPool(poolId: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.licenseAllocations)
      .where(eq(schema.licenseAllocations.poolId, poolId));
    return row?.count ?? 0;
  }

  // Authoritative license state for a workspace. The relay gates paid agent
  // features (create + prompt/run) on this; reads + human messaging stay open.
  //
  //   - 'active'   — a paid subscription in good standing (Stripe active|trialing).
  //   - 'trialing' — no paid subscription yet, but the workspace was created
  //                  within TRIAL_DAYS days (the free 7-day evaluation window).
  //   - 'paused'   — the trial has ended AND there is no active subscription
  //                  (no row, or status canceled/past_due/unpaid). HARD PAUSE:
  //                  agent create + prompt are blocked until the owner subscribes.
  //
  // Self-hosted/solo (no DATABASE_URL) never reaches PgSync, so there is no
  // gating there — only the cloud relay enforces this.
  // oxlint-disable-next-line eslint/complexity -- linear branch ladder (billing-off → sub-active → trial); clearer inline than split
  async getLicenseStatus(workspaceId: string): Promise<{
    state: "trialing" | "active" | "paused";
    plan: string;
    trialEndsAt: number | null;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
    status: string | null;
  }> {
    // Billing dormant until configured: with no Stripe keys on the relay there's
    // no way to charge, so report full access (no trial/paused bar, no lockout)
    // and don't even query the subscriptions table. Mirrors the gating guard in
    // relay-standalone — billing only activates once Stripe is configured.
    if (!isStripeConfigured()) {
      return {
        state: "active",
        plan: "free",
        trialEndsAt: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        status: null,
      };
    }

    const TRIAL_DAYS = 7;
    const sub = await this.getSubscription(workspaceId);

    if (sub && (sub.status === "active" || sub.status === "trialing")) {
      return {
        state: "active",
        plan: sub.plan,
        trialEndsAt: sub.trialEndsAt?.getTime() ?? null,
        currentPeriodEnd: sub.currentPeriodEnd?.getTime() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        status: sub.status,
      };
    }

    // No active paid subscription — fall back to the workspace-creation trial.
    const createdAt = await this.getWorkspaceCreatedAt(workspaceId);
    const trialEnd = createdAt ? createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000 : 0;
    const withinTrial = trialEnd > Date.now();

    return {
      state: withinTrial ? "trialing" : "paused",
      plan: sub?.plan ?? "free",
      trialEndsAt: createdAt ? trialEnd : null,
      currentPeriodEnd: sub?.currentPeriodEnd?.getTime() ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
      status: sub?.status ?? null,
    };
  }

  // Context-aware billing INTENT for one caller on one surface: WHAT action to
  // offer (and with what copy) given the rail that holds the license (Stripe /
  // IAP / manual), the license state, the client platform, and the caller's
  // role. The matrix + copy live in ../billing/intent.ts (pure + unit-tested);
  // this method only derives the three signals from storage and delegates.
  //
  //   • source   ← the subscriptions row's customer-id slot (cus_/revenuecat:/
  //                manual_comp_grant/none) via deriveBillingSource.
  //   • state    ← getLicenseStatus().state collapsed to trialing/active/expired.
  //   • role     ← the caller's workspace membership role (unknown → "member",
  //                the most-restricted role, so a stranger never gets an
  //                owner-only affordance).
  //
  // `platform` is client-supplied (the same surface the caller is on) — the relay
  // can't know whether the request came from web, desktop, iOS, or Android.
  async getBillingIntent(
    workspaceId: string,
    userId: string,
    platform: BillingPlatform,
  ): Promise<BillingIntent> {
    const [sub, license, rawRole] = await Promise.all([
      this.getSubscription(workspaceId),
      this.getLicenseStatus(workspaceId),
      this.getMemberRole(workspaceId, userId),
    ]);
    const source = deriveBillingSource(sub?.stripeCustomerId ?? null);
    const state = mapLicenseStateToBillingState(license.state, license.status);
    // Only "owner" | "admin" | "member" drive the role overlay; any other / null
    // value (not a member) falls back to "member" = most restricted.
    const role: BillingRole = rawRole === "owner" || rawRole === "admin" ? rawRole : "member";
    return resolveBillingIntent({ source, state, platform, role });
  }

  // ─── Memberships (invitation acceptance) ────────────────────────

  // Flip an existing membership's type (e.g. 'invited' → 'active' on accept).
  // No-op if the (workspace, user) row doesn't exist — accept_invitation falls
  // back to addMember when the membership is absent.
  async setMembershipType(workspaceId: string, userId: string, type: string): Promise<void> {
    await this.db
      .update(schema.memberships)
      .set({ membershipType: type })
      .where(
        and(eq(schema.memberships.workspaceId, workspaceId), eq(schema.memberships.userId, userId)),
      );
  }

  // ─── Invitations (full invite flow with shareable links) ────────

  async createInvitation(params: {
    id: string;
    workspaceId: string;
    email: string;
    role: string;
    createdBy: string;
    expiresAt: Date;
    // Channels the invitee is auto-joined to on accept (Slack "add to channels").
    channelIds?: string[];
  }): Promise<schema.Invitation> {
    const [row] = await this.db
      .insert(schema.invitations)
      .values({
        id: params.id,
        workspaceId: params.workspaceId,
        email: params.email,
        role: params.role,
        createdBy: params.createdBy,
        expiresAt: params.expiresAt,
        channelIds: params.channelIds ?? [],
      })
      .returning();
    return row;
  }

  // Update the stored auto-join channels on an existing (pending) invite — used
  // when a re-invite reuses the pending row but the inviter picked new channels.
  async setInvitationChannels(id: string, channelIds: string[]): Promise<void> {
    await this.db
      .update(schema.invitations)
      .set({ channelIds })
      .where(eq(schema.invitations.id, id));
  }

  // The workspace's single live reusable (OPEN) invite link, if one exists. Open
  // invites have NULL email + is_open = true and are never consumed on accept.
  async getOpenInvitation(workspaceId: string): Promise<schema.Invitation | null> {
    const [row] = await this.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.workspaceId, workspaceId),
          eq(schema.invitations.isOpen, true),
          isNull(schema.invitations.acceptedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // Create or update the workspace's ONE reusable link. rotate=true mints a fresh
  // token (revoking the old link) by deleting the existing row first; otherwise an
  // existing link's role/channels/expiry are updated in place (token preserved).
  // email stays NULL (open = anyone with the link can join as `role`).
  async upsertOpenInvitation(params: {
    workspaceId: string;
    role: string;
    channelIds: string[];
    createdBy: string;
    expiresAt: Date;
    newId: string;
    rotate?: boolean;
  }): Promise<schema.Invitation> {
    // Reset: drop the current link first so the insert below mints a fresh token.
    if (params.rotate) {
      const existing = await this.getOpenInvitation(params.workspaceId);
      if (existing) {
        await this.db.delete(schema.invitations).where(eq(schema.invitations.id, existing.id));
      }
    }
    // Insert the new token, or — if a live link already exists (non-rotate, incl.
    // a concurrent create) — atomically UPDATE it in place via the one-per-
    // workspace partial unique index. onConflictDoUpdate keeps the existing token
    // and avoids the check-then-insert race (two admins generating the link at once).
    const [row] = await this.db
      .insert(schema.invitations)
      .values({
        id: params.newId,
        workspaceId: params.workspaceId,
        email: null,
        role: params.role,
        isOpen: true,
        channelIds: params.channelIds,
        createdBy: params.createdBy,
        expiresAt: params.expiresAt,
      })
      .onConflictDoUpdate({
        target: schema.invitations.workspaceId,
        targetWhere: sql`${schema.invitations.isOpen} = true AND ${schema.invitations.acceptedAt} IS NULL`,
        set: {
          role: params.role,
          channelIds: params.channelIds,
          expiresAt: params.expiresAt,
        },
      })
      .returning();
    return row;
  }

  async getInvitation(id: string): Promise<schema.Invitation | null> {
    const [row] = await this.db
      .select()
      .from(schema.invitations)
      .where(eq(schema.invitations.id, id))
      .limit(1);
    return row ?? null;
  }

  // The single PENDING (not-yet-accepted) invite for (workspace, email), if any.
  // Used to dedup re-invites: an existing pending invite is reused + refreshed
  // rather than inserting a second row (matching the partial unique index).
  async getPendingInvitation(
    workspaceId: string,
    email: string,
  ): Promise<schema.Invitation | null> {
    const [row] = await this.db
      .select()
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.workspaceId, workspaceId),
          eq(schema.invitations.email, email),
          isNull(schema.invitations.acceptedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async markInvitationAccepted(id: string, userId: string): Promise<void> {
    await this.db
      .update(schema.invitations)
      .set({ acceptedAt: new Date(), acceptedBy: userId })
      .where(eq(schema.invitations.id, id));
  }

  async updateInvitationExpiry(id: string, expiresAt: Date): Promise<void> {
    await this.db
      .update(schema.invitations)
      .set({ expiresAt })
      .where(eq(schema.invitations.id, id));
  }

  // Pending invites for a workspace, newest first, joined to users for the
  // inviter's display name. Drives the members pane's "Pending invitations" list.
  async getPendingInvitations(workspaceId: string): Promise<
    Array<{
      id: string;
      email: string;
      role: string;
      createdAt: number;
      expiresAt: number;
      createdByName: string | null;
    }>
  > {
    const rows = await this.db
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.role,
        createdAt: schema.invitations.createdAt,
        expiresAt: schema.invitations.expiresAt,
        createdByName: schema.users.name,
      })
      .from(schema.invitations)
      .leftJoin(schema.users, eq(schema.users.id, schema.invitations.createdBy))
      .where(
        and(
          eq(schema.invitations.workspaceId, workspaceId),
          isNull(schema.invitations.acceptedAt),
          // Email-bound only — the reusable open link isn't a per-person pending invite.
          eq(schema.invitations.isOpen, false),
        ),
      )
      .orderBy(desc(schema.invitations.createdAt));

    return rows.map((r) => ({
      id: r.id,
      // Non-null in practice (filtered to email-bound rows above); coerce for the type.
      email: r.email ?? "",
      role: r.role,
      createdAt: r.createdAt.getTime(),
      expiresAt: r.expiresAt.getTime(),
      createdByName: r.createdByName,
    }));
  }

  async deleteInvitation(id: string): Promise<void> {
    await this.db.delete(schema.invitations).where(eq(schema.invitations.id, id));
  }

  // ─── Superadmin: role checks + grant/revoke ──────────────────────
  // A user is a superadmin iff an admin_users row exists with is_superadmin=true.
  // Revoke keeps the row (flips the flag + records revoked_*) for audit; a later
  // grant flips it back true and clears revoked_*. The relay re-checks this on
  // every privileged request — never a client claim.

  async isSuperadmin(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: schema.adminUsers.userId })
      .from(schema.adminUsers)
      .where(and(eq(schema.adminUsers.userId, userId), eq(schema.adminUsers.isSuperadmin, true)))
      .limit(1);
    return !!row;
  }

  // Active superadmins, joined to users for display. Revoked rows are excluded.
  async listSuperadmins(): Promise<
    Array<{
      userId: string;
      email: string;
      name: string | null;
      grantedBy: string | null;
      grantedAt: number;
    }>
  > {
    const rows = await this.db
      .select({
        userId: schema.adminUsers.userId,
        email: schema.users.email,
        name: schema.users.name,
        grantedBy: schema.adminUsers.grantedBy,
        grantedAt: schema.adminUsers.grantedAt,
      })
      .from(schema.adminUsers)
      .innerJoin(schema.users, eq(schema.users.id, schema.adminUsers.userId))
      .where(eq(schema.adminUsers.isSuperadmin, true))
      .orderBy(asc(schema.adminUsers.grantedAt));
    return rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      grantedBy: r.grantedBy,
      grantedAt: r.grantedAt.getTime(),
    }));
  }

  // Active superadmin count — used to block removing the LAST superadmin.
  async countSuperadmins(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.isSuperadmin, true));
    return row?.n ?? 0;
  }

  // Idempotent grant: upsert on user_id. A fresh row OR a previously-revoked row
  // both end up is_superadmin=true with granted_by/at refreshed and revoked_*
  // cleared. grantedBy is null for the SQL bootstrap (grant-superadmin.ts).
  async grantSuperadmin(targetUserId: string, grantedBy: string | null): Promise<void> {
    const now = new Date();
    await this.db
      .insert(schema.adminUsers)
      .values({
        userId: targetUserId,
        isSuperadmin: true,
        grantedBy,
        grantedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.adminUsers.userId,
        set: {
          isSuperadmin: true,
          grantedBy,
          grantedAt: now,
          revokedBy: null,
          revokedAt: null,
          updatedAt: now,
        },
      });
  }

  // Revoke keeps the row (audit trail): flip the flag + stamp revoked_*. ATOMIC
  // last-superadmin guard: the UPDATE only fires when the target is currently an
  // active superadmin AND more than one active superadmin exists, so two
  // concurrent cross-revokes can never both succeed and drop the count to zero
  // (the count is evaluated inside the same statement, not in a read-then-write
  // race). The result discriminates the three outcomes for the caller:
  //   "revoked"         — the flag was flipped (rowCount > 0).
  //   "last_superadmin" — target IS an active superadmin but is the last one.
  //   "not_superadmin"  — target is not an active superadmin (no-op).
  async revokeSuperadmin(
    targetUserId: string,
    revokedBy: string,
  ): Promise<"revoked" | "last_superadmin" | "not_superadmin"> {
    const now = new Date();
    // The "never drop to zero superadmins" invariant must hold under concurrency.
    // A count-guarded UPDATE alone is NOT enough: under READ COMMITTED two
    // concurrent revokes of DIFFERENT rows both see count > 1 (the count subquery
    // and the single-row UPDATE take no conflicting lock — write skew), so both
    // commit and the count hits zero. Serialize by locking ALL active superadmin
    // rows FOR UPDATE inside a transaction: the second revoke blocks until the
    // first commits, then re-reads the now-smaller set and correctly refuses.
    return await this.db.transaction(async (tx) => {
      const active = await tx
        .select({ userId: schema.adminUsers.userId })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.isSuperadmin, true))
        .for("update");

      if (active.length <= 1) {
        return active.some((a) => a.userId === targetUserId) ? "last_superadmin" : "not_superadmin";
      }
      const result = await tx
        .update(schema.adminUsers)
        .set({ isSuperadmin: false, revokedBy, revokedAt: now, updatedAt: now })
        .where(
          and(eq(schema.adminUsers.userId, targetUserId), eq(schema.adminUsers.isSuperadmin, true)),
        );
      // 0 rows here means the target wasn't an active superadmin (the count > 1
      // case is already handled above, inside the lock).
      return (result.rowCount ?? 0) > 0 ? "revoked" : "not_superadmin";
    });
  }

  // ─── Superadmin: user moderation (suspend + SOFT delete) ─────────
  // All set the nullable users columns; NULL = active/normal. A soft-deleted row
  // is NEVER hard-deleted (it is the FK target of memberships/messages/daemons).

  async suspendUser(targetUserId: string, reason: string | null, byUserId: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ suspendedAt: new Date(), suspendedReason: reason, suspendedBy: byUserId })
      .where(eq(schema.users.id, targetUserId));
  }

  async unsuspendUser(targetUserId: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ suspendedAt: null, suspendedReason: null, suspendedBy: null })
      .where(eq(schema.users.id, targetUserId));
  }

  async softDeleteUser(targetUserId: string, byUserId: string): Promise<void> {
    await this.db
      .update(schema.users)
      .set({ deletedAt: new Date(), deletedBy: byUserId })
      .where(eq(schema.users.id, targetUserId));
  }

  // ─── Superadmin: workspace moderation (disable) ──────────────────
  // Sets the nullable workspaces.disabled_* columns; NULL = active/normal (no
  // regression). A disabled workspace disappears from members' listings
  // (getWorkspacesForUser filters disabledAt IS NULL) and can't be (re)subscribed
  // to (the relay rejects subscribe_workspace). The row is NEVER deleted — its
  // data stays for audit/re-enable. disabledReason is nullable (an empty reason
  // stores NULL).

  async disableWorkspace(
    workspaceId: string,
    reason: string | null,
    byUserId: string,
  ): Promise<void> {
    await this.db
      .update(schema.workspaces)
      .set({ disabledAt: new Date(), disabledReason: reason, disabledBy: byUserId })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  async enableWorkspace(workspaceId: string): Promise<void> {
    await this.db
      .update(schema.workspaces)
      .set({ disabledAt: null, disabledReason: null, disabledBy: null })
      .where(eq(schema.workspaces.id, workspaceId));
  }

  async isWorkspaceDisabled(workspaceId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ disabled: sql<boolean>`${schema.workspaces.disabledAt} IS NOT NULL` })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    return row?.disabled ?? false;
  }

  // ─── Superadmin: workspace plan override ─────────────────────────
  // Updates an EXISTING subscription row. Returns 'not_found' (a typed signal,
  // not a throw) when the workspace has no subscription row to change.
  async setSubscriptionPlan(
    workspaceId: string,
    plan: string,
    status?: string,
  ): Promise<"ok" | "not_found"> {
    const existing = await this.getSubscription(workspaceId);
    if (!existing) return "not_found";
    await this.db
      .update(schema.subscriptions)
      .set({ plan, ...(status ? { status } : {}), updatedAt: new Date() })
      .where(eq(schema.subscriptions.workspaceId, workspaceId));
    return "ok";
  }

  // ─── Superadmin: global audit log ────────────────────────────────

  async recordAdminAudit(params: {
    actorUserId: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    details?: Record<string, unknown> | null;
  }): Promise<void> {
    await this.db.insert(schema.adminAuditLog).values({
      id: randomUUID(),
      actorUserId: params.actorUserId,
      action: params.action,
      targetType: params.targetType ?? null,
      targetId: params.targetId ?? null,
      details: params.details ?? null,
    });
  }

  // Recent audit entries, newest first. `before` is an epoch-ms keyset cursor
  // (createdAt < before) for "load older" paging.
  async listAdminAudit(params: { limit: number; before?: number }): Promise<
    Array<{
      id: string;
      actorUserId: string;
      action: string;
      targetType: string | null;
      targetId: string | null;
      details: Record<string, unknown> | null;
      createdAt: number;
    }>
  > {
    const rows = await this.db
      .select()
      .from(schema.adminAuditLog)
      .where(
        params.before !== undefined
          ? lt(schema.adminAuditLog.createdAt, new Date(params.before))
          : undefined,
      )
      .orderBy(desc(schema.adminAuditLog.createdAt))
      .limit(params.limit);
    return rows.map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      details: r.details,
      createdAt: r.createdAt.getTime(),
    }));
  }

  // ─── Daemon deployment mode (superadmin reporting) ───────────────
  // The DualStorage mode a daemon reports ('solo' | 'connected'). Threaded from
  // the daemon hello/heartbeat path (owned by the relay/daemon-client layer);
  // exposed here as a standalone setter so that path can persist it.
  async setDaemonDeploymentMode(daemonId: string, mode: string): Promise<void> {
    await this.db
      .update(schema.daemons)
      .set({ deploymentMode: mode })
      .where(eq(schema.daemons.id, daemonId));
  }

  // ─── Superadmin: platform metrics overview ───────────────────────
  // One aggregate object for the dashboard landing. A handful of independent
  // aggregate queries (run concurrently), never a per-row N+1.
  // oxlint-disable-next-line eslint/complexity -- flat fan-out of independent aggregate queries + `?? 0` fallbacks; splitting it would only scatter one cohesive read.
  async getSuperadminOverview(): Promise<SuperadminOverview> {
    const [
      userTotals,
      workspaceTotal,
      membershipTotal,
      daemonRows,
      subscriptionTotal,
      superadminTotal,
      planRows,
      platformRows,
      workspaceCloudRows,
      agentSessionTotal,
      daemonAgentTotal,
      archivedSessionTotal,
      usageRows,
      editionRows,
      recent,
    ] = await Promise.all([
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          deleted: sql<number>`count(*) FILTER (WHERE ${schema.users.deletedAt} IS NOT NULL)::int`,
        })
        .from(schema.users),
      this.db.select({ n: sql<number>`count(*)::int` }).from(schema.workspaces),
      this.db.select({ n: sql<number>`count(*)::int` }).from(schema.memberships),
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          online: sql<number>`count(*) FILTER (WHERE ${schema.daemons.status} = 'online')::int`,
        })
        .from(schema.daemons),
      this.db.select({ n: sql<number>`count(*)::int` }).from(schema.subscriptions),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.isSuperadmin, true)),
      this.db
        .select({
          plan: schema.subscriptions.plan,
          status: schema.subscriptions.status,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.subscriptions)
        .groupBy(schema.subscriptions.plan, schema.subscriptions.status),
      this.db
        .select({
          platform: sql<string>`COALESCE(${schema.subscriptions.purchasePlatform}, 'unknown')`,
          count: sql<number>`count(*)::int`,
        })
        .from(schema.subscriptions)
        .groupBy(sql`COALESCE(${schema.subscriptions.purchasePlatform}, 'unknown')`),
      // Per-workspace daemon rollup over NON-disabled workspaces: a workspace is
      // "cloud" if it has ≥1 associated daemon (those daemons sync it to the
      // shared cloud via the relay), "no daemon" if zero. `online` counts cloud
      // workspaces with a daemon currently online. Counts come from a CTE so the
      // top-level FILTERs see one row per workspace.
      this.db.execute(sql`
        with w as (
          select ws.id,
            count(distinct wd.daemon_id)::int as daemons,
            count(distinct wd.daemon_id) filter (where d.status = 'online')::int as online
          from workspaces ws
          left join workspace_daemons wd on wd.workspace_id = ws.id
          left join daemons d on d.id = wd.daemon_id
          where ws.disabled_at is null
          group by ws.id
        )
        select
          count(*)::int as total,
          count(*) filter (where daemons > 0)::int as cloud,
          count(*) filter (where online > 0)::int as online,
          count(*) filter (where daemons = 0)::int as no_daemon
        from w
      `),
      this.db.select({ n: sql<number>`count(*)::int` }).from(schema.agentSessions),
      this.db.select({ n: sql<number>`count(*)::int` }).from(schema.daemonAgents),
      this.db.select({ n: sql<number>`count(*)::int` }).from(schema.archivedSessions),
      // Usage-metrics rollup (round 1). Read the LIVE daemons.meta snapshot — NOT
      // agent_sessions/daemon_agents (those tables are abandoned/empty). A single
      // global WHERE status = 'online' scopes every aggregate to online daemons so
      // a dead daemon's stale snapshot can't inflate live counts (and lets PG use a
      // status index / skip offline rows). `activeUsers` is the count of distinct
      // owners with ≥1 online daemon; the means divide by it in JS below (guarded
      // to 0 when there are no active users). Counts/sums COALESCE to 0 (meta fields
      // are null until the daemon emits them). One row.
      this.db.execute(sql`
        SELECT
          COALESCE(SUM((meta->>'activeSessionCount')::int), 0)::int AS active_sessions,
          COALESCE(SUM((meta->>'activeCyboCount')::int), 0)::int AS active_cybos,
          COALESCE(SUM((meta->>'agents')::int), 0)::int AS agents,
          COUNT(DISTINCT owner_id)::int AS active_users
        FROM daemons
        WHERE status = 'online'
      `),
      // Per-edition rollup over ONLINE daemons, grouping NULL editions under
      // 'unknown'. daemons / activeSessions / activeCybos per edition.
      this.db.execute(sql`
        SELECT
          COALESCE(deployment_edition, 'unknown') AS edition,
          COUNT(*)::int AS daemons,
          COALESCE(SUM((meta->>'activeSessionCount')::int), 0)::int AS active_sessions,
          COALESCE(SUM((meta->>'activeCyboCount')::int), 0)::int AS active_cybos
        FROM daemons
        WHERE status = 'online'
        GROUP BY COALESCE(deployment_edition, 'unknown')
        ORDER BY daemons DESC
      `),
      this.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          imageUrl: schema.users.imageUrl,
          createdAt: schema.users.createdAt,
        })
        .from(schema.users)
        .orderBy(desc(schema.users.createdAt))
        .limit(10),
    ]);

    const daemonTotal = daemonRows[0]?.total ?? 0;
    const daemonOnline = daemonRows[0]?.online ?? 0;
    const wsCloud = (
      workspaceCloudRows.rows as Array<{
        total: number;
        cloud: number;
        online: number;
        no_daemon: number;
      }>
    )[0];
    // Usage rollup (single row) + per-edition breakdown off the online-daemon
    // meta snapshot. Means are activeSessions/activeCybos/agents per ACTIVE user,
    // rounded to 1 decimal; the mean1 helper guards `activeUsers > 0` and returns
    // 0 when there are no active users.
    const usage = (
      usageRows.rows as Array<{
        active_sessions: number;
        active_cybos: number;
        agents: number;
        active_users: number;
      }>
    )[0];
    const activeSessions = Number(usage?.active_sessions ?? 0);
    const activeCybos = Number(usage?.active_cybos ?? 0);
    const agentsTotal = Number(usage?.agents ?? 0);
    const activeUsers = Number(usage?.active_users ?? 0);
    const mean1 = (sum: number) =>
      activeUsers > 0 ? Math.round((sum / activeUsers) * 10) / 10 : 0;
    const editionBreakdown = (
      editionRows.rows as Array<{
        edition: string;
        daemons: number;
        active_sessions: number;
        active_cybos: number;
      }>
    ).map((r) => ({
      edition: r.edition,
      daemons: Number(r.daemons),
      activeSessions: Number(r.active_sessions),
      activeCybos: Number(r.active_cybos),
    }));
    return {
      totals: {
        users: userTotals[0]?.total ?? 0,
        deletedUsers: userTotals[0]?.deleted ?? 0,
        workspaces: workspaceTotal[0]?.n ?? 0,
        memberships: membershipTotal[0]?.n ?? 0,
        daemons: { online: daemonOnline, offline: daemonTotal - daemonOnline, total: daemonTotal },
        subscriptions: subscriptionTotal[0]?.n ?? 0,
        superadmins: superadminTotal[0]?.n ?? 0,
      },
      plans: planRows.map((r) => ({ plan: r.plan, status: r.status, count: r.count })),
      purchasePlatform: platformRows.map((r) => ({ platform: r.platform, count: r.count })),
      workspaceCloud: {
        total: Number(wsCloud?.total ?? 0),
        cloud: Number(wsCloud?.cloud ?? 0),
        online: Number(wsCloud?.online ?? 0),
        noDaemon: Number(wsCloud?.no_daemon ?? 0),
      },
      sessions: {
        agentSessions: agentSessionTotal[0]?.n ?? 0,
        daemonAgents: daemonAgentTotal[0]?.n ?? 0,
        archivedSessions: archivedSessionTotal[0]?.n ?? 0,
        activeSessions,
        activeCybos,
      },
      perUserMetrics: {
        activeUsers,
        meanActiveSessions: mean1(activeSessions),
        meanActiveCybos: mean1(activeCybos),
        meanAgents: mean1(agentsTotal),
      },
      editionBreakdown,
      recentSignups: recent.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        imageUrl: r.imageUrl,
        createdAt: r.createdAt.getTime(),
      })),
    };
  }

  // ─── Superadmin: organizations (workspaces) listing + detail ─────
  // member/daemon counts come from correlated aggregate subqueries so the page
  // is a single round trip (no per-workspace N+1). Optional name/owner-email
  // search via ILIKE.
  async listOrgs(params: { limit: number; offset: number; search?: string }): Promise<{
    orgs: Array<{
      id: string;
      name: string;
      avatarUrl: string | null;
      ownerEmail: string | null;
      memberCount: number;
      plan: string | null;
      status: string | null;
      daemonCount: number;
      createdAt: number;
      // Superadmin moderation: epoch-ms when this org was disabled, else null
      // (active). Drives the "Disabled" badge in the orgs list.
      disabledAt: number | null;
    }>;
    total: number;
  }> {
    const search = params.search?.trim();
    const searchFilter = search
      ? or(ilike(schema.workspaces.name, `%${search}%`), ilike(schema.users.email, `%${search}%`))
      : undefined;

    const memberCount = sql<number>`(
      SELECT count(*)::int FROM ${schema.memberships}
      WHERE ${schema.memberships.workspaceId} = ${schema.workspaces.id}
    )`;
    const daemonCount = sql<number>`(
      SELECT count(*)::int FROM ${schema.workspaceDaemons}
      WHERE ${schema.workspaceDaemons.workspaceId} = ${schema.workspaces.id}
    )`;

    const rows = await this.db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        avatarUrl: schema.workspaces.avatarUrl,
        ownerEmail: schema.users.email,
        memberCount,
        plan: schema.subscriptions.plan,
        status: schema.subscriptions.status,
        daemonCount,
        createdAt: schema.workspaces.createdAt,
        disabledAt: schema.workspaces.disabledAt,
      })
      .from(schema.workspaces)
      .leftJoin(schema.users, eq(schema.users.id, schema.workspaces.ownerId))
      .leftJoin(schema.subscriptions, eq(schema.subscriptions.workspaceId, schema.workspaces.id))
      .where(searchFilter)
      .orderBy(desc(schema.workspaces.createdAt))
      .limit(params.limit)
      .offset(params.offset);

    const [totalRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.workspaces)
      .leftJoin(schema.users, eq(schema.users.id, schema.workspaces.ownerId))
      .where(searchFilter);

    return {
      orgs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        avatarUrl: r.avatarUrl,
        ownerEmail: r.ownerEmail,
        memberCount: r.memberCount,
        plan: r.plan,
        status: r.status,
        daemonCount: r.daemonCount,
        createdAt: r.createdAt.getTime(),
        disabledAt: r.disabledAt?.getTime() ?? null,
      })),
      total: totalRow?.n ?? 0,
    };
  }

  async getOrgDetail(workspaceId: string): Promise<OrgDetail | null> {
    const [ws] = await this.db
      .select({
        id: schema.workspaces.id,
        name: schema.workspaces.name,
        avatarUrl: schema.workspaces.avatarUrl,
        ownerId: schema.workspaces.ownerId,
        ownerEmail: schema.users.email,
        ownerName: schema.users.name,
        createdAt: schema.workspaces.createdAt,
        disabledAt: schema.workspaces.disabledAt,
        disabledReason: schema.workspaces.disabledReason,
        disabledBy: schema.workspaces.disabledBy,
      })
      .from(schema.workspaces)
      .leftJoin(schema.users, eq(schema.users.id, schema.workspaces.ownerId))
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    if (!ws) return null;

    const [members, subscription, daemonRows, countsRow] = await Promise.all([
      this.db
        .select({
          userId: schema.memberships.userId,
          email: schema.users.email,
          name: schema.users.name,
          imageUrl: schema.users.imageUrl,
          role: schema.memberships.role,
          membershipType: schema.memberships.membershipType,
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.workspaceId, workspaceId))
        .orderBy(asc(schema.memberships.joinedAt)),
      this.getSubscription(workspaceId),
      // Rich per-daemon info: the daemons row + the user join (ownerEmail) + the
      // meta jsonb. meta is nullable; the meta-derived fields are read off it with
      // a null-guard below. A daemon reaches an org via the workspace_daemons join.
      this.db
        .select({
          id: schema.daemons.id,
          label: schema.daemons.label,
          ownerEmail: schema.users.email,
          status: schema.daemons.status,
          lastSeenAt: schema.daemons.lastSeenAt,
          deploymentMode: schema.daemons.deploymentMode,
          deploymentEdition: schema.daemons.deploymentEdition,
          meta: schema.daemons.meta,
        })
        .from(schema.daemons)
        .innerJoin(schema.workspaceDaemons, eq(schema.workspaceDaemons.daemonId, schema.daemons.id))
        .leftJoin(schema.users, eq(schema.users.id, schema.daemons.ownerId))
        .where(eq(schema.workspaceDaemons.workspaceId, workspaceId)),
      // One round trip for every count via correlated aggregate subqueries (no
      // N+1). channels/messages have a deletedAt soft-delete column → count only
      // live rows; cybos/agent_sessions/daemons have none → count all. daemons is
      // counted via the workspace_daemons join (org → daemon mapping).
      this.db
        .select({
          channels: sql<number>`(
            SELECT count(*)::int FROM ${schema.channels}
            WHERE ${schema.channels.workspaceId} = ${workspaceId}
              AND ${schema.channels.deletedAt} IS NULL
          )`,
          messages: sql<number>`(
            SELECT count(*)::int FROM ${schema.messages}
            WHERE ${schema.messages.workspaceId} = ${workspaceId}
              AND ${schema.messages.deletedAt} IS NULL
          )`,
          cybos: sql<number>`(
            SELECT count(*)::int FROM ${schema.cybos}
            WHERE ${schema.cybos.workspaceId} = ${workspaceId}
          )`,
          agentSessions: sql<number>`(
            SELECT count(*)::int FROM ${schema.agentSessions}
            WHERE ${schema.agentSessions.workspaceId} = ${workspaceId}
          )`,
          daemons: sql<number>`(
            SELECT count(*)::int FROM ${schema.workspaceDaemons}
            WHERE ${schema.workspaceDaemons.workspaceId} = ${workspaceId}
          )`,
        })
        .from(sql`(SELECT 1) AS _one`),
    ]);

    return {
      id: ws.id,
      name: ws.name,
      avatarUrl: ws.avatarUrl,
      ownerId: ws.ownerId,
      ownerEmail: ws.ownerEmail,
      ownerName: ws.ownerName,
      createdAt: ws.createdAt.getTime(),
      disabled: {
        at: ws.disabledAt?.getTime() ?? null,
        reason: ws.disabledReason,
        by: ws.disabledBy,
      },
      members: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        name: m.name,
        imageUrl: m.imageUrl,
        role: m.role,
        membershipType: m.membershipType,
      })),
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            stripeCustomerId: subscription.stripeCustomerId,
            priceId: subscription.priceId,
            currentPeriodEnd: subscription.currentPeriodEnd?.getTime() ?? null,
            trialEndsAt: subscription.trialEndsAt?.getTime() ?? null,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            purchasePlatform: subscription.purchasePlatform,
          }
        : null,
      daemons: daemonRows.map((d) => toOrgDaemonDetail(d)),
      counts: {
        members: members.length,
        channels: countsRow[0]?.channels ?? 0,
        messages: countsRow[0]?.messages ?? 0,
        cybos: countsRow[0]?.cybos ?? 0,
        agentSessions: countsRow[0]?.agentSessions ?? 0,
        daemons: countsRow[0]?.daemons ?? 0,
      },
    };
  }

  // ─── Superadmin: users listing + detail ──────────────────────────
  // Per-user aggregates (workspace/daemon/session counts, isSuperadmin, owned
  // plans) come from correlated subqueries — one round trip, no N+1. Search by
  // email or name ILIKE.
  async listUsersAdmin(params: { limit: number; offset: number; search?: string }): Promise<{
    users: Array<{
      id: string;
      email: string;
      name: string | null;
      imageUrl: string | null;
      createdAt: number;
      isSuperadmin: boolean;
      suspendedAt: number | null;
      deletedAt: number | null;
      workspaceCount: number;
      daemonCount: number;
      agentSessionCount: number;
      // Usage-metrics (round 1): live counts SUMmed over this user's ONLINE
      // daemons (a dead daemon's stale snapshot must not inflate the row). 0 until
      // the user's daemons emit them.
      activeSessions: number;
      activeCybos: number;
      plans: string[];
    }>;
    total: number;
  }> {
    const search = params.search?.trim();
    const searchFilter = search
      ? or(ilike(schema.users.email, `%${search}%`), ilike(schema.users.name, `%${search}%`))
      : undefined;

    const isSuperadmin = sql<boolean>`EXISTS (
      SELECT 1 FROM ${schema.adminUsers}
      WHERE ${schema.adminUsers.userId} = ${schema.users.id} AND ${schema.adminUsers.isSuperadmin} = true
    )`;
    const workspaceCount = sql<number>`(
      SELECT count(*)::int FROM ${schema.memberships}
      WHERE ${schema.memberships.userId} = ${schema.users.id}
    )`;
    // The outer `users` row must be referenced fully-qualified ("users"."id").
    // Drizzle renders ${schema.users.id} as a bare "id" inside these correlated
    // subqueries; when the inner FROM table ALSO has an `id` column (daemons,
    // agent_sessions, workspaces) Postgres shadow-binds the bare "id" to the
    // INNER table, so the correlation silently matches nothing (count 0 / empty
    // array). sql.raw('"users"."id"') forces the qualified outer reference.
    const outerUserId = sql.raw('"users"."id"');
    const daemonCount = sql<number>`(
      SELECT count(*)::int FROM ${schema.daemons}
      WHERE ${schema.daemons.ownerId} = ${outerUserId}
    )`;
    const agentSessionCount = sql<number>`(
      SELECT count(*)::int FROM ${schema.agentSessions}
      WHERE ${schema.agentSessions.userId} = ${outerUserId}
    )`;
    // Usage-metrics (round 1): live active session/cybo counts SUMmed over this
    // user's ONLINE daemons, read off the daemons.meta snapshot. Online-only so a
    // dead daemon's stale snapshot can't inflate the row; COALESCE to 0 (the meta
    // fields are null until the daemon emits them). Same qualified-correlation
    // (outerUserId) the daemon/session subqueries use, to dodge the shadow-bind.
    const activeSessions = sql<number>`(
      SELECT COALESCE(SUM((${schema.daemons.meta}->>'activeSessionCount')::int), 0)::int
      FROM ${schema.daemons}
      WHERE ${schema.daemons.ownerId} = ${outerUserId} AND ${schema.daemons.status} = 'online'
    )`;
    const activeCybos = sql<number>`(
      SELECT COALESCE(SUM((${schema.daemons.meta}->>'activeCyboCount')::int), 0)::int
      FROM ${schema.daemons}
      WHERE ${schema.daemons.ownerId} = ${outerUserId} AND ${schema.daemons.status} = 'online'
    )`;
    // Distinct plans across the workspaces this user OWNS, aggregated to a text[].
    const plans = sql<string[]>`COALESCE((
      SELECT array_agg(DISTINCT ${schema.subscriptions.plan})
      FROM ${schema.subscriptions}
      JOIN ${schema.workspaces} ON ${schema.workspaces.id} = ${schema.subscriptions.workspaceId}
      WHERE ${schema.workspaces.ownerId} = ${outerUserId}
    ), ARRAY[]::text[])`;

    const rows = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        imageUrl: schema.users.imageUrl,
        createdAt: schema.users.createdAt,
        suspendedAt: schema.users.suspendedAt,
        deletedAt: schema.users.deletedAt,
        isSuperadmin,
        workspaceCount,
        daemonCount,
        agentSessionCount,
        activeSessions,
        activeCybos,
        plans,
      })
      .from(schema.users)
      .where(searchFilter)
      .orderBy(desc(schema.users.createdAt))
      .limit(params.limit)
      .offset(params.offset);

    const [totalRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.users)
      .where(searchFilter);

    return {
      users: rows.map((r) => ({
        id: r.id,
        email: r.email,
        name: r.name,
        imageUrl: r.imageUrl,
        createdAt: r.createdAt.getTime(),
        isSuperadmin: r.isSuperadmin,
        suspendedAt: r.suspendedAt?.getTime() ?? null,
        deletedAt: r.deletedAt?.getTime() ?? null,
        workspaceCount: r.workspaceCount,
        daemonCount: r.daemonCount,
        agentSessionCount: r.agentSessionCount,
        activeSessions: r.activeSessions,
        activeCybos: r.activeCybos,
        plans: r.plans,
      })),
      total: totalRow?.n ?? 0,
    };
  }

  async getUserDetailAdmin(userId: string): Promise<UserDetailAdmin | null> {
    const [user] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        imageUrl: schema.users.imageUrl,
        createdAt: schema.users.createdAt,
        suspendedAt: schema.users.suspendedAt,
        suspendedReason: schema.users.suspendedReason,
        suspendedBy: schema.users.suspendedBy,
        deletedAt: schema.users.deletedAt,
        deletedBy: schema.users.deletedBy,
      })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user) return null;

    const [superadmin, workspaceRows, daemonRows, sessionCount, archivedCount] = await Promise.all([
      this.isSuperadmin(userId),
      this.db
        .select({
          id: schema.workspaces.id,
          name: schema.workspaces.name,
          avatarUrl: schema.workspaces.avatarUrl,
          role: schema.memberships.role,
        })
        .from(schema.memberships)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.memberships.workspaceId))
        .where(eq(schema.memberships.userId, userId))
        .orderBy(asc(schema.workspaces.createdAt)),
      this.db
        .select({
          id: schema.daemons.id,
          label: schema.daemons.label,
          status: schema.daemons.status,
          lastSeenAt: schema.daemons.lastSeenAt,
          deploymentMode: schema.daemons.deploymentMode,
          deploymentEdition: schema.daemons.deploymentEdition,
          meta: schema.daemons.meta,
        })
        .from(schema.daemons)
        .where(eq(schema.daemons.ownerId, userId)),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.userId, userId)),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.archivedSessions)
        .innerJoin(schema.workspaces, eq(schema.workspaces.id, schema.archivedSessions.workspaceId))
        .where(eq(schema.workspaces.ownerId, userId)),
    ]);

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      imageUrl: user.imageUrl,
      createdAt: user.createdAt.getTime(),
      isSuperadmin: superadmin,
      suspendedAt: user.suspendedAt?.getTime() ?? null,
      suspendedReason: user.suspendedReason,
      suspendedBy: user.suspendedBy,
      deletedAt: user.deletedAt?.getTime() ?? null,
      deletedBy: user.deletedBy,
      workspaces: workspaceRows.map((w) => ({
        id: w.id,
        name: w.name,
        avatarUrl: w.avatarUrl,
        role: w.role,
      })),
      daemons: daemonRows.map((d) => ({
        id: d.id,
        label: d.label,
        status: d.status,
        lastSeenAt: d.lastSeenAt?.getTime() ?? null,
        deploymentMode: d.deploymentMode,
        // Usage-metrics (round 1): live per-daemon counts + edition off the meta
        // snapshot. Null until the daemon emits them; edition prefers the
        // dedicated column, falling back to meta.edition.
        activeSessionCount: d.meta?.activeSessionCount ?? null,
        activeCyboCount: d.meta?.activeCyboCount ?? null,
        edition: d.deploymentEdition ?? d.meta?.edition ?? null,
      })),
      sessions: {
        agentSessions: sessionCount[0]?.n ?? 0,
        archivedSessions: archivedCount[0]?.n ?? 0,
      },
    };
  }

  // ─── GitHub App → Tasks one-way issue sync ───────────────────────
  // Mirrors the inbound-webhook DAL above. GitHub is the source of truth; these
  // methods record installations, repo↔project bindings, and issue↔task back-links.
  // The webhook receiver (routes/github.ts) is the only writer of the sync rows.

  // Upsert a GitHub App installation row. Idempotent on the (globally unique)
  // installation_id — a re-install / re-authorize refreshes the account + creator
  // rather than inserting a duplicate. Returns nothing; the receiver doesn't need
  // the row id back (it keys off installation_id everywhere).
  async upsertGithubInstallation(opts: {
    id: string;
    workspaceId: string;
    installationId: string;
    accountLogin: string;
    accountType?: string;
    createdBy: string;
  }): Promise<void> {
    await this.db
      .insert(schema.githubInstallations)
      .values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        installationId: opts.installationId,
        accountLogin: opts.accountLogin,
        accountType: opts.accountType ?? "User",
        createdBy: opts.createdBy,
      })
      .onConflictDoUpdate({
        target: schema.githubInstallations.installationId,
        set: {
          workspaceId: opts.workspaceId,
          accountLogin: opts.accountLogin,
          accountType: opts.accountType ?? "User",
          createdBy: opts.createdBy,
        },
      });
  }

  // Claim a brand-new installation for a workspace WITHOUT reassigning it if another
  // workspace already owns it. Unlike upsertGithubInstallation (which onConflictDoUpdate
  // overwrites workspace_id — the cross-tenant reassignment vector), this inserts on
  // conflict-do-NOTHING then reads back the row's workspace, so the FIRST claimant wins a
  // race and the loser learns who won. Returns the workspace that owns the row after the
  // call. The install-confirm callback compares it to the caller's workspace.
  async claimGithubInstallation(opts: {
    id: string;
    workspaceId: string;
    installationId: string;
    accountLogin: string;
    accountType?: string;
    createdBy: string;
  }): Promise<string | null> {
    await this.db
      .insert(schema.githubInstallations)
      .values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        installationId: opts.installationId,
        accountLogin: opts.accountLogin,
        accountType: opts.accountType ?? "User",
        createdBy: opts.createdBy,
      })
      .onConflictDoNothing({ target: schema.githubInstallations.installationId });
    return this.getInstallationWorkspace(opts.installationId);
  }

  // The workspace a known installation belongs to (null for an unknown install).
  // The webhook receiver reads it back so an `installation` refresh doesn't blank
  // the workspace binding the authed callback recorded.
  async getInstallationWorkspace(installationId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ workspaceId: schema.githubInstallations.workspaceId })
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.installationId, installationId))
      .limit(1);
    return row?.workspaceId ?? null;
  }

  // A single repo binding by id (null if unknown). Used by the unbind callback to
  // resolve the binding's workspace for the membership check before deleting it.
  async getRepoSyncById(id: string): Promise<StoredGithubRepoSync | null> {
    const [row] = await this.db
      .select()
      .from(schema.githubRepoSyncs)
      .where(eq(schema.githubRepoSyncs.id, id))
      .limit(1);
    return row ? mapRepoSync(row) : null;
  }

  // Remove an installation and every repo binding under it (and, transitively, the
  // issue-sync rows). repo_syncs.installation_id is plain text (no FK cascade), so
  // the bindings are deleted explicitly. Used by the `installation: deleted` event.
  async deleteGithubInstallation(installationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.githubRepoSyncs)
        .where(eq(schema.githubRepoSyncs.installationId, installationId));
      await tx
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.installationId, installationId));
    });
  }

  // The workspace a Tasks-project belongs to (or null if the id is unknown). Used
  // by the bind callback to confirm the authed user's workspace owns the project,
  // and by the receiver to attribute a created task to the right workspace.
  async getTasksProjectWorkspace(tasksProjectId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ workspaceId: schema.tasksProjects.workspaceId })
      .from(schema.tasksProjects)
      .where(eq(schema.tasksProjects.id, tasksProjectId))
      .limit(1);
    return row?.workspaceId ?? null;
  }

  // Bind a repository to a Tasks-project (1 repo ↔ 1 tasks-project). Idempotent on
  // the UNIQUE(tasks_project_id, repo_id) — re-binding refreshes the owner/name/url
  // (a repo rename) and returns the existing row's id. Returns the binding id.
  async bindRepoSync(opts: {
    id: string;
    workspaceId: string;
    installationId: string;
    tasksProjectId: string;
    repoId: string;
    owner: string;
    name: string;
    repoUrl: string;
    createdBy: string;
    // 0039: optional sync direction + per-binding issue state overrides. Omitted by
    // the legacy per-project bind (ConnectGithubPanel) → defaults to 'inbound' on
    // insert and is LEFT UNCHANGED on a re-bind (so a plain rename doesn't clobber a
    // direction the user configured in the detail modal).
    syncDirection?: string;
    issueOpenStateId?: string | null;
    issueClosedStateId?: string | null;
  }): Promise<string> {
    // Only update the 0039 columns on conflict when the caller actually supplied
    // them — otherwise a webhook/rename re-bind would reset a configured direction.
    const conflictSet: Partial<typeof schema.githubRepoSyncs.$inferInsert> = {
      installationId: opts.installationId,
      owner: opts.owner,
      name: opts.name,
      repoUrl: opts.repoUrl,
    };
    if (opts.syncDirection !== undefined) conflictSet.syncDirection = opts.syncDirection;
    if (opts.issueOpenStateId !== undefined) conflictSet.issueOpenStateId = opts.issueOpenStateId;
    if (opts.issueClosedStateId !== undefined) {
      conflictSet.issueClosedStateId = opts.issueClosedStateId;
    }
    const [row] = await this.db
      .insert(schema.githubRepoSyncs)
      .values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        installationId: opts.installationId,
        tasksProjectId: opts.tasksProjectId,
        repoId: opts.repoId,
        owner: opts.owner,
        name: opts.name,
        repoUrl: opts.repoUrl,
        syncDirection: opts.syncDirection ?? "inbound",
        issueOpenStateId: opts.issueOpenStateId ?? null,
        issueClosedStateId: opts.issueClosedStateId ?? null,
        createdBy: opts.createdBy,
      })
      .onConflictDoUpdate({
        target: [schema.githubRepoSyncs.tasksProjectId, schema.githubRepoSyncs.repoId],
        set: conflictSet,
      })
      .returning({ id: schema.githubRepoSyncs.id });
    return row.id;
  }

  // Drop a repo binding (and its issue-sync rows, via cascade). Used by the
  // `installation_repositories: removed` event. Scoped to the binding id.
  async unbindRepoSync(id: string): Promise<void> {
    await this.db.delete(schema.githubRepoSyncs).where(eq(schema.githubRepoSyncs.id, id));
  }

  // The repo binding for a (installation, GitHub repo id), if any. The receiver's
  // first lookup on an inbound `issues`/`issue_comment`/`label` event: no row → the
  // repo isn't synced to any project, skip. Returns the minimal shape the receiver
  // needs (the binding id + its target project + workspace).
  async getRepoSync(installationId: string, repoId: string): Promise<StoredGithubRepoSync | null> {
    const [row] = await this.db
      .select()
      .from(schema.githubRepoSyncs)
      .where(
        and(
          eq(schema.githubRepoSyncs.installationId, installationId),
          eq(schema.githubRepoSyncs.repoId, repoId),
        ),
      )
      .limit(1);
    return row ? mapRepoSync(row) : null;
  }

  // The repo binding(s) for a Tasks-project — drives the settings panel's "this
  // project is connected to <owner/name>" state. Returns every binding (a project
  // can bind more than one repo) ordered newest-first.
  async getRepoSyncForProject(tasksProjectId: string): Promise<StoredGithubRepoSync[]> {
    const rows = await this.db
      .select()
      .from(schema.githubRepoSyncs)
      .where(eq(schema.githubRepoSyncs.tasksProjectId, tasksProjectId))
      .orderBy(desc(schema.githubRepoSyncs.createdAt));
    return rows.map(mapRepoSync);
  }

  // Record (or refresh) the issue↔task back-link. Idempotent on
  // UNIQUE(repo_sync_id, task_id) — re-syncing the same issue refreshes its number/
  // id/url. The receiver creates the task first, then calls this to remember it.
  async upsertIssueSync(opts: {
    id: string;
    repoSyncId: string;
    taskId: string;
    issueNumber: number;
    githubIssueId: string;
    issueUrl: string;
  }): Promise<void> {
    await this.db
      .insert(schema.githubIssueSyncs)
      .values({
        id: opts.id,
        repoSyncId: opts.repoSyncId,
        taskId: opts.taskId,
        issueNumber: opts.issueNumber,
        githubIssueId: opts.githubIssueId,
        issueUrl: opts.issueUrl,
      })
      .onConflictDoUpdate({
        target: [schema.githubIssueSyncs.repoSyncId, schema.githubIssueSyncs.taskId],
        set: {
          issueNumber: opts.issueNumber,
          githubIssueId: opts.githubIssueId,
          issueUrl: opts.issueUrl,
        },
      });
  }

  // The task an inbound issue already maps to, looked up by (binding, issue
  // number) — the receiver's de-dup key. No row → first time we've seen the issue,
  // create a task. Returns the linked task id (+ the sync row id for updates).
  async getTaskByIssue(
    repoSyncId: string,
    issueNumber: number,
  ): Promise<{ syncId: string; taskId: string } | null> {
    const [row] = await this.db
      .select({ syncId: schema.githubIssueSyncs.id, taskId: schema.githubIssueSyncs.taskId })
      .from(schema.githubIssueSyncs)
      .where(
        and(
          eq(schema.githubIssueSyncs.repoSyncId, repoSyncId),
          eq(schema.githubIssueSyncs.issueNumber, issueNumber),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // The default/backlog state a new issue's task should land in (the project's
  // is_default state, else its first backlog/unstarted state by sequence), and the
  // completed-group state a closed issue moves to. Returned together so the receiver
  // resolves both in one round trip. Either may be null (a project with no states).
  async getGithubSyncStates(
    tasksProjectId: string,
  ): Promise<{ openStateId: string | null; closedStateId: string | null }> {
    const states = await this.db
      .select({
        id: schema.taskStates.id,
        group: schema.taskStates.group,
        sequence: schema.taskStates.sequence,
        isDefault: schema.taskStates.isDefault,
      })
      .from(schema.taskStates)
      .where(eq(schema.taskStates.projectId, tasksProjectId))
      .orderBy(asc(schema.taskStates.sequence));

    const byGroup = (g: string) => states.filter((s) => s.group === g);
    // Open: the project default, else the first backlog state, else the first
    // unstarted state (matches createTask's "is_default else null" with a sensible
    // fallback to the leftmost incomplete column).
    const openStateId =
      states.find((s) => s.isDefault)?.id ??
      byGroup("backlog")[0]?.id ??
      byGroup("unstarted")[0]?.id ??
      null;
    // Closed: the first completed-group state.
    const closedStateId = byGroup("completed")[0]?.id ?? null;
    return { openStateId, closedStateId };
  }

  // Does `stateId` belong to `tasksProjectId`? Guards the PR-mapping + issue-state-
  // override targets so a caller can't point a binding/mapping at a task state from a
  // DIFFERENT project (cross-project state leak). `tasksProjectId` must already be the
  // canonical tasks_projects.id (the routes resolve it via resolveTasksProjectId first).
  // Returns false for a missing/foreign state.
  async stateBelongsToProject(stateId: string, tasksProjectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.taskStates.id })
      .from(schema.taskStates)
      .where(
        and(eq(schema.taskStates.id, stateId), eq(schema.taskStates.projectId, tasksProjectId)),
      )
      .limit(1);
    return row !== undefined;
  }

  // ─── GitHub Plane-parity: installations, direction, PR mappings, OAuth (0039) ──

  // Every GitHub App installation a workspace authorized — drives the account/org
  // picker and the integration detail page's connected-org row(s). Newest first.
  async listGithubInstallationsForWorkspace(
    workspaceId: string,
  ): Promise<StoredGithubInstallation[]> {
    const rows = await this.db
      .select()
      .from(schema.githubInstallations)
      .where(eq(schema.githubInstallations.workspaceId, workspaceId))
      .orderBy(desc(schema.githubInstallations.createdAt));
    return rows.map(mapInstallation);
  }

  // Disconnect an installation FROM A WORKSPACE: drop its repo bindings (and, via
  // cascade, their issue/PR-sync rows) then the install row, both scoped to the
  // workspace. Unlike deleteGithubInstallation (the `installation: deleted` webhook,
  // which is workspace-agnostic), this only touches rows the caller's workspace owns.
  async deleteGithubInstallationForWorkspace(
    workspaceId: string,
    installationId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(schema.githubRepoSyncs)
        .where(
          and(
            eq(schema.githubRepoSyncs.workspaceId, workspaceId),
            eq(schema.githubRepoSyncs.installationId, installationId),
          ),
        );
      await tx
        .delete(schema.githubInstallations)
        .where(
          and(
            eq(schema.githubInstallations.workspaceId, workspaceId),
            eq(schema.githubInstallations.installationId, installationId),
          ),
        );
    });
  }

  // Patch a repo binding's sync direction / issue state overrides (Image #5 edit).
  // Only the supplied fields are written; an empty patch is a no-op.
  async patchRepoSync(
    id: string,
    patch: {
      syncDirection?: string;
      issueOpenStateId?: string | null;
      issueClosedStateId?: string | null;
    },
  ): Promise<void> {
    const set: Partial<typeof schema.githubRepoSyncs.$inferInsert> = {};
    if (patch.syncDirection !== undefined) set.syncDirection = patch.syncDirection;
    if (patch.issueOpenStateId !== undefined) set.issueOpenStateId = patch.issueOpenStateId;
    if (patch.issueClosedStateId !== undefined) set.issueClosedStateId = patch.issueClosedStateId;
    if (Object.keys(set).length === 0) return;
    await this.db.update(schema.githubRepoSyncs).set(set).where(eq(schema.githubRepoSyncs.id, id));
  }

  // Every repo binding in a workspace, across all projects — drives the detail
  // page's workspace-wide "Project Issue Sync" list. Newest first.
  async getRepoSyncsForWorkspace(workspaceId: string): Promise<StoredGithubRepoSync[]> {
    const rows = await this.db
      .select()
      .from(schema.githubRepoSyncs)
      .where(eq(schema.githubRepoSyncs.workspaceId, workspaceId))
      .orderBy(desc(schema.githubRepoSyncs.createdAt));
    return rows.map(mapRepoSync);
  }

  // The PR-state → task-state mappings for a project (Image #3). One per PR state.
  async getPrStateMappingsForProject(
    tasksProjectId: string,
  ): Promise<StoredGithubPrStateMapping[]> {
    const rows = await this.db
      .select()
      .from(schema.githubPrStateMappings)
      .where(eq(schema.githubPrStateMappings.tasksProjectId, tasksProjectId))
      .orderBy(desc(schema.githubPrStateMappings.createdAt));
    return rows.map(mapPrStateMapping);
  }

  // A single PR-state mapping by id (null if unknown). Used by the delete callback
  // to resolve the mapping's workspace for the membership check before removing it.
  async getPrStateMappingById(id: string): Promise<StoredGithubPrStateMapping | null> {
    const [row] = await this.db
      .select()
      .from(schema.githubPrStateMappings)
      .where(eq(schema.githubPrStateMappings.id, id))
      .limit(1);
    return row ? mapPrStateMapping(row) : null;
  }

  // Upsert one PR-state mapping. Idempotent on UNIQUE(tasks_project_id, pr_state) —
  // re-saving the same PR state refreshes its target state + skip-backward flag.
  // Returns the mapping id.
  async upsertPrStateMapping(opts: {
    id: string;
    workspaceId: string;
    tasksProjectId: string;
    prState: string;
    taskStateId: string | null;
    skipBackward: boolean;
    createdBy: string;
  }): Promise<string> {
    const [row] = await this.db
      .insert(schema.githubPrStateMappings)
      .values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        tasksProjectId: opts.tasksProjectId,
        prState: opts.prState,
        taskStateId: opts.taskStateId,
        skipBackward: opts.skipBackward,
        createdBy: opts.createdBy,
      })
      .onConflictDoUpdate({
        target: [schema.githubPrStateMappings.tasksProjectId, schema.githubPrStateMappings.prState],
        set: { taskStateId: opts.taskStateId, skipBackward: opts.skipBackward },
      })
      .returning({ id: schema.githubPrStateMappings.id });
    return row.id;
  }

  // Remove a PR-state mapping by id.
  async deletePrStateMapping(id: string): Promise<void> {
    await this.db
      .delete(schema.githubPrStateMappings)
      .where(eq(schema.githubPrStateMappings.id, id));
  }

  // Record (or refresh) a PR↔task back-link (wave-2 PR sync engine writes these).
  // Idempotent on UNIQUE(repo_sync_id, pr_number).
  async upsertPrSync(opts: {
    id: string;
    repoSyncId: string;
    taskId: string;
    prNumber: number;
    githubPrId: string;
    prUrl: string;
  }): Promise<void> {
    await this.db
      .insert(schema.githubPrSyncs)
      .values({
        id: opts.id,
        repoSyncId: opts.repoSyncId,
        taskId: opts.taskId,
        prNumber: opts.prNumber,
        githubPrId: opts.githubPrId,
        prUrl: opts.prUrl,
      })
      .onConflictDoUpdate({
        target: [schema.githubPrSyncs.repoSyncId, schema.githubPrSyncs.prNumber],
        set: { taskId: opts.taskId, githubPrId: opts.githubPrId, prUrl: opts.prUrl },
      });
  }

  // ─── GitHub PR sync engine reads (wave-2a) ───────────────────────────

  // EVERY repo binding for a (installation, GitHub repo id) — unlike getRepoSync
  // (which limits to one), a `pull_request` event fans out to all projects the repo
  // is bound to, each with its own PR-state mapping. Newest first.
  async getRepoSyncsForRepo(
    installationId: string,
    repoId: string,
  ): Promise<StoredGithubRepoSync[]> {
    const rows = await this.db
      .select()
      .from(schema.githubRepoSyncs)
      .where(
        and(
          eq(schema.githubRepoSyncs.installationId, installationId),
          eq(schema.githubRepoSyncs.repoId, repoId),
        ),
      )
      .orderBy(desc(schema.githubRepoSyncs.createdAt));
    return rows.map(mapRepoSync);
  }

  // The task a PR already maps to, by (binding, PR number) — the PR sync engine's
  // stickiness lookup so a later event whose body no longer references the issue
  // still moves the same task. Null when this PR was never linked.
  async getPrSyncByNumber(
    repoSyncId: string,
    prNumber: number,
  ): Promise<{ taskId: string } | null> {
    const [row] = await this.db
      .select({ taskId: schema.githubPrSyncs.taskId })
      .from(schema.githubPrSyncs)
      .where(
        and(
          eq(schema.githubPrSyncs.repoSyncId, repoSyncId),
          eq(schema.githubPrSyncs.prNumber, prNumber),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // The task id for a Plane-style task-key reference (`<IDENT>-<N>`) in a PR branch:
  // a task in `tasksProjectId` whose project identifier + per-project sequence match.
  // Null when no such task exists (the ref points elsewhere). `identifier` is matched
  // verbatim (callers pass it uppercased, the stored convention).
  async getTaskIdByRef(
    tasksProjectId: string,
    identifier: string,
    sequence: number,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .innerJoin(schema.tasksProjects, eq(schema.tasksProjects.id, schema.tasks.projectId))
      .where(
        and(
          eq(schema.tasks.projectId, tasksProjectId),
          eq(schema.tasks.sequenceId, sequence),
          eq(schema.tasksProjects.identifier, identifier),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }

  // The phase groups for a skip_backward check: the task's CURRENT state group (via
  // its state_id) and the TARGET state's group. Either is null when the state/join is
  // missing (no current state, or an unknown target id) — the caller treats unknown
  // ranks as "don't block".
  async getMoveGroups(
    taskId: string,
    targetStateId: string,
  ): Promise<{ currentGroup: string | null; targetGroup: string | null }> {
    const [cur] = await this.db
      .select({ group: schema.taskStates.group })
      .from(schema.tasks)
      .innerJoin(schema.taskStates, eq(schema.taskStates.id, schema.tasks.stateId))
      .where(eq(schema.tasks.id, taskId))
      .limit(1);
    const [tgt] = await this.db
      .select({ group: schema.taskStates.group })
      .from(schema.taskStates)
      .where(eq(schema.taskStates.id, targetStateId))
      .limit(1);
    return { currentGroup: cur?.group ?? null, targetGroup: tgt?.group ?? null };
  }

  // Every GitHub issue a task is linked to, joined to its repo binding's owner/name/
  // installation + sync direction. Drives the OUTBOUND write-back (github-outbound.ts)
  // — it filters to the bidirectional links before touching GitHub.
  async getIssueSyncsForTaskWithRepo(taskId: string): Promise<GithubIssueSyncWithRepo[]> {
    const rows = await this.db
      .select({
        repoSyncId: schema.githubIssueSyncs.repoSyncId,
        issueNumber: schema.githubIssueSyncs.issueNumber,
        githubIssueId: schema.githubIssueSyncs.githubIssueId,
        issueUrl: schema.githubIssueSyncs.issueUrl,
        owner: schema.githubRepoSyncs.owner,
        name: schema.githubRepoSyncs.name,
        installationId: schema.githubRepoSyncs.installationId,
        syncDirection: schema.githubRepoSyncs.syncDirection,
      })
      .from(schema.githubIssueSyncs)
      .innerJoin(
        schema.githubRepoSyncs,
        eq(schema.githubRepoSyncs.id, schema.githubIssueSyncs.repoSyncId),
      )
      .where(eq(schema.githubIssueSyncs.taskId, taskId));
    return rows;
  }

  // The personal GitHub connection for a (workspace, user), if any (null otherwise).
  // SERVER-INTERNAL: includes the OAuth accessToken — callers surface only safe
  // fields. Used to render "Personal account connected" and (wave 2) for write-back.
  async getGithubUserConnection(
    workspaceId: string,
    userId: string,
  ): Promise<StoredGithubUserConnection | null> {
    const [row] = await this.db
      .select()
      .from(schema.githubUserConnections)
      .where(
        and(
          eq(schema.githubUserConnections.workspaceId, workspaceId),
          eq(schema.githubUserConnections.userId, userId),
        ),
      )
      .limit(1);
    return row ? mapUserConnection(row) : null;
  }

  // Every personal GitHub connection in a workspace (drives the detail page's
  // "Personal account connected" state so it persists across reloads). SERVER-
  // INTERNAL rows carry the accessToken — the route surfaces only safe fields,
  // never the token. Newest first.
  async listGithubUserConnectionsForWorkspace(
    workspaceId: string,
  ): Promise<StoredGithubUserConnection[]> {
    const rows = await this.db
      .select()
      .from(schema.githubUserConnections)
      .where(eq(schema.githubUserConnections.workspaceId, workspaceId))
      .orderBy(desc(schema.githubUserConnections.createdAt));
    return rows.map(mapUserConnection);
  }

  // Upsert a personal GitHub connection. Idempotent on UNIQUE(workspace_id, user_id)
  // — re-connecting refreshes the login/token/scopes. Returns nothing.
  async upsertGithubUserConnection(opts: {
    id: string;
    workspaceId: string;
    userId: string;
    githubLogin: string;
    accessToken: string;
    scopes: string | null;
  }): Promise<void> {
    await this.db
      .insert(schema.githubUserConnections)
      .values({
        id: opts.id,
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        githubLogin: opts.githubLogin,
        accessToken: opts.accessToken,
        scopes: opts.scopes,
      })
      .onConflictDoUpdate({
        target: [schema.githubUserConnections.workspaceId, schema.githubUserConnections.userId],
        set: {
          githubLogin: opts.githubLogin,
          accessToken: opts.accessToken,
          scopes: opts.scopes,
        },
      });
  }
}

// Map a github_repo_syncs row to the receiver/UI shape (epoch-ms createdAt).
function mapRepoSync(r: typeof schema.githubRepoSyncs.$inferSelect): StoredGithubRepoSync {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    installationId: r.installationId,
    tasksProjectId: r.tasksProjectId,
    repoId: r.repoId,
    owner: r.owner,
    name: r.name,
    repoUrl: r.repoUrl,
    syncDirection: r.syncDirection,
    issueOpenStateId: r.issueOpenStateId,
    issueClosedStateId: r.issueClosedStateId,
    createdBy: r.createdBy,
    createdAt: r.createdAt.getTime(),
  };
}

// Map a github_installations row to the read/UI shape (epoch-ms createdAt).
function mapInstallation(
  r: typeof schema.githubInstallations.$inferSelect,
): StoredGithubInstallation {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    installationId: r.installationId,
    accountLogin: r.accountLogin,
    accountType: r.accountType,
    createdBy: r.createdBy,
    createdAt: r.createdAt.getTime(),
  };
}

// Map a github_pr_state_mappings row to the read/UI shape (epoch-ms createdAt).
function mapPrStateMapping(
  r: typeof schema.githubPrStateMappings.$inferSelect,
): StoredGithubPrStateMapping {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    tasksProjectId: r.tasksProjectId,
    prState: r.prState,
    taskStateId: r.taskStateId,
    skipBackward: r.skipBackward,
    createdBy: r.createdBy,
    createdAt: r.createdAt.getTime(),
  };
}

// Map a github_user_connections row to the server-internal shape (epoch-ms createdAt).
function mapUserConnection(
  r: typeof schema.githubUserConnections.$inferSelect,
): StoredGithubUserConnection {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    userId: r.userId,
    githubLogin: r.githubLogin,
    accessToken: r.accessToken,
    scopes: r.scopes,
    createdAt: r.createdAt.getTime(),
  };
}

// ─── Superadmin DAL return shapes ────────────────────────────────
// Named (no inline complex types in public signatures). Epoch-ms numbers for
// every timestamp, matching the rest of PgSync's read shapes.

export interface SuperadminOverview {
  totals: {
    users: number;
    deletedUsers: number;
    workspaces: number;
    memberships: number;
    daemons: { online: number; offline: number; total: number };
    subscriptions: number;
    superadmins: number;
  };
  plans: Array<{ plan: string; status: string; count: number }>;
  purchasePlatform: Array<{ platform: string; count: number }>;
  workspaceCloud: { total: number; cloud: number; online: number; noDaemon: number };
  // Usage-metrics (round 1): active{Sessions,Cybos} are SUMs over ONLINE daemons'
  // meta snapshots; agentSessions/daemonAgents/archivedSessions are the legacy
  // table counts (kept for back-compat). All 0 until daemons emit the new fields.
  sessions: {
    agentSessions: number;
    daemonAgents: number;
    archivedSessions: number;
    activeSessions: number;
    activeCybos: number;
  };
  // Platform-wide per-ACTIVE-user means (activeUsers = distinct owners with ≥1
  // online daemon). Means are rounded to 1 decimal; 0 when no active users.
  perUserMetrics: {
    activeUsers: number;
    meanActiveSessions: number;
    meanActiveCybos: number;
    meanAgents: number;
  };
  // Per-deployment-edition rollup over ONLINE daemons (NULL edition → 'unknown').
  editionBreakdown: Array<{
    edition: string;
    daemons: number;
    activeSessions: number;
    activeCybos: number;
  }>;
  recentSignups: Array<{
    id: string;
    email: string;
    name: string | null;
    imageUrl: string | null;
    createdAt: number;
  }>;
}

export interface OrgDetail {
  id: string;
  name: string;
  avatarUrl: string | null;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  createdAt: number;
  // Superadmin moderation. `at` is epoch-ms when the org was disabled (null =
  // active, today's behavior); `reason`/`by` are the disable reason + acting
  // admin's userId (both nullable).
  disabled: {
    at: number | null;
    reason: string | null;
    by: string | null;
  };
  members: Array<{
    userId: string;
    email: string;
    name: string | null;
    imageUrl: string | null;
    role: string;
    membershipType: string;
  }>;
  subscription: {
    plan: string;
    status: string;
    stripeCustomerId: string;
    priceId: string | null;
    currentPeriodEnd: number | null;
    trialEndsAt: number | null;
    cancelAtPeriodEnd: boolean;
    purchasePlatform: string | null;
  } | null;
  daemons: Array<{
    id: string;
    label: string;
    ownerEmail: string | null;
    status: string;
    lastSeenAt: number | null;
    deploymentMode: string | null;
    // From daemons.meta (nullable jsonb); each is null when meta is absent or
    // doesn't carry the field.
    platform: string | null;
    arch: string | null;
    host: string | null;
    cpu: number | null;
    memMb: number | null;
    agents: number | null;
    queueDepth: number | null;
    uptime: number | null;
    cyboInstalled: boolean | null;
    accepting: boolean | null;
    // Usage-metrics (round 1): live counts off meta + the deployment edition
    // (column-or-meta). Null until the daemon emits them.
    activeSessionCount: number | null;
    activeCyboCount: number | null;
    edition: string | null;
  }>;
  counts: {
    members: number;
    channels: number;
    messages: number;
    cybos: number;
    agentSessions: number;
    daemons: number;
  };
}

export interface UserDetailAdmin {
  id: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  createdAt: number;
  isSuperadmin: boolean;
  suspendedAt: number | null;
  suspendedReason: string | null;
  suspendedBy: string | null;
  deletedAt: number | null;
  deletedBy: string | null;
  workspaces: Array<{ id: string; name: string; avatarUrl: string | null; role: string }>;
  daemons: Array<{
    id: string;
    label: string;
    status: string;
    lastSeenAt: number | null;
    deploymentMode: string | null;
    // Usage-metrics (round 1): live per-daemon counts off meta + the deployment
    // edition (column-or-meta). Null until the daemon emits them.
    activeSessionCount: number | null;
    activeCyboCount: number | null;
    edition: string | null;
  }>;
  sessions: { agentSessions: number; archivedSessions: number };
}

export interface StoredMcpToken {
  id: string;
  name: string;
  workspaceId: string;
  ownerId: string;
  identityType: "cybo" | "user";
  identityId: string;
  scopes: string[];
}

// Webhook config returned to the UI — never carries the secret value (only
// whether one is set, via hasSecret).
export interface StoredWebhook {
  id: string;
  channelId: string;
  workspaceId: string;
  name: string;
  hasSecret: boolean;
  contentType: string;
  eventMode: string;
  events: string[];
  active: boolean;
  createdBy: string;
  lastDeliveryAt: number | null;
  createdAt: number;
}

// Server-only: the active webhook for a channel WITH its secret, used by the
// receive endpoint to verify the HMAC signature. Never sent to clients.
// `createdBy` is the posting identity for signature-authenticated deliveries
// (a GitHub webhook carries no MCP token, so the message is attributed to the
// user who created the webhook).
export interface StoredWebhookWithSecret {
  id: string;
  channelId: string;
  workspaceId: string;
  secret: string | null;
  eventMode: string;
  events: string[];
  createdBy: string;
  // Reactive trigger (#620, scheduler phase 3): when `triggerCyboId` is set, an
  // incoming event ALSO fires that cybo (mention-shaped forward to the owning
  // daemon) with `promptTemplate` rendered from the payload. NULL = card-only.
  triggerCyboId: string | null;
  promptTemplate: string | null;
}

// A github_repo_syncs row in the receiver/UI shape (epoch-ms createdAt). The
// receiver resolves an inbound event's target Tasks-project through this; the
// settings panel renders the "connected to <owner/name>" state from it.
export interface StoredGithubRepoSync {
  id: string;
  workspaceId: string;
  installationId: string;
  tasksProjectId: string;
  repoId: string;
  owner: string;
  name: string;
  repoUrl: string;
  // 0039: sync direction + optional per-binding issue state overrides.
  syncDirection: string;
  issueOpenStateId: string | null;
  issueClosedStateId: string | null;
  createdBy: string;
  createdAt: number;
}

// A github_installations row in the read/UI shape (epoch-ms createdAt). Drives the
// account/org picker + the integration detail page's connected-org row(s).
export interface StoredGithubInstallation {
  id: string;
  workspaceId: string;
  installationId: string;
  accountLogin: string;
  accountType: string;
  createdBy: string;
  createdAt: number;
}

// A github_pr_state_mappings row in the read/UI shape (epoch-ms createdAt). One per
// (project, PR state); taskStateId NULL = "Set State" not chosen yet.
export interface StoredGithubPrStateMapping {
  id: string;
  workspaceId: string;
  tasksProjectId: string;
  prState: string;
  taskStateId: string | null;
  skipBackward: boolean;
  createdBy: string;
  createdAt: number;
}

// A github_user_connections row. SERVER-INTERNAL: carries the OAuth accessToken used
// for wave-2 personal-account write-back — never auto-serialized to a client (routes
// surface only { connected, githubLogin }). epoch-ms createdAt.
export interface StoredGithubUserConnection {
  id: string;
  workspaceId: string;
  userId: string;
  githubLogin: string;
  accessToken: string;
  scopes: string | null;
  createdAt: number;
}

// A task's GitHub issue link joined to its repo binding — the OUTBOUND write-back
// (github-outbound.ts) reads these, filters to syncDirection==="bidirectional", and
// PATCHes the issue. owner/name/installationId locate the issue + mint a token.
export interface GithubIssueSyncWithRepo {
  repoSyncId: string;
  issueNumber: number;
  githubIssueId: string;
  issueUrl: string;
  owner: string;
  name: string;
  installationId: string;
  syncDirection: string;
}

export interface StoredWebhookDelivery {
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

// ─── Outgoing webhooks (#598) ────────────────────────────────────────────────

// Client-safe view of an outgoing webhook — NEVER includes secret_key. epoch-ms
// numbers, parsed event flags. Returned by list/fetch/create (create also adds
// the one-time raw secret separately).
export interface StoredOutgoingWebhook {
  id: string;
  workspaceId: string;
  channelId: string;
  name: string;
  url: string;
  events: OutgoingWebhookEventFlags;
  isActive: boolean;
  failureCount: number;
  lastTriggeredAt: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface OutgoingWebhookEventFlags {
  "message.created"?: boolean;
  "message.updated"?: boolean;
  "message.deleted"?: boolean;
}

// Server-only: a due outbox row WITH the parent webhook's secret hash + url,
// joined for the delivery runner. Never sent to clients.
export interface DueWebhookDelivery {
  outboxId: string;
  webhookId: string;
  workspaceId: string;
  eventId: string;
  eventType: string;
  eventData: Record<string, unknown>;
  attempts: number;
  url: string;
  secretKeyHash: string;
  createdBy: string;
}

// A channel's active outgoing webhook, minimally projected for the enqueue path
// (no secret needed — enqueue only writes the outbox row).
export interface ActiveOutgoingWebhookForChannel {
  id: string;
  events: OutgoingWebhookEventFlags;
}

// PG schedule row → the SQLite-shaped StoredSchedule the rest of the code uses
// (epoch-ms numbers, 0/1 enabled), so the relay's PG reads return the same shape
// the daemon's SQLite reads do.
function mapScheduleRow(r: typeof schema.schedules.$inferSelect): StoredSchedule {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    cybo_id: r.cyboId,
    channel_id: r.channelId,
    task_id: r.taskId,
    cron_expr: r.cronExpr,
    timezone: r.timezone,
    prompt: r.prompt,
    enabled: r.enabled ? 1 : 0,
    last_run_at: r.lastRunAt?.getTime() ?? null,
    next_run_at: r.nextRunAt?.getTime() ?? null,
    max_runs: r.maxRuns,
    run_count: r.runCount,
    catch_up: r.catchUp ? 1 : 0,
    created_by: r.createdBy,
    created_at: r.createdAt.getTime(),
    updated_at: r.updatedAt.getTime(),
  };
}

// Map an installed_recipes row to the Stored shape. PG `config`/`schedule_ids` are
// jsonb (returned as JS object/array); StoredInstalledRecipe keeps them as JSON TEXT
// (the SQLite shape), so we re-serialize — the same convention mapScheduledMessageRow
// uses for `mentions`. A NULL schedule_ids normalizes to '[]'.
function mapInstalledRecipeRow(
  r: typeof schema.installedRecipes.$inferSelect,
): StoredInstalledRecipe {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    recipe_id: r.recipeId,
    enabled: r.enabled ? 1 : 0,
    config: JSON.stringify(r.config ?? {}),
    cybo_id: r.cyboId,
    schedule_ids: JSON.stringify(r.scheduleIds ?? []),
    created_by: r.createdBy,
    created_at: r.createdAt.getTime(),
    updated_at: r.updatedAt.getTime(),
  };
}

function mapScheduledMessageRow(
  r: typeof schema.scheduledMessages.$inferSelect,
): StoredScheduledMessage {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    channel_id: r.channelId,
    to_id: r.toId,
    from_id: r.fromId,
    text: r.text,
    mentions: r.mentions ? JSON.stringify(r.mentions) : null,
    send_at: r.sendAt.getTime(),
    processed_at: r.processedAt?.getTime() ?? null,
    error_code: r.errorCode,
    created_at: r.createdAt.getTime(),
  };
}

function mapPromptTemplateRow(r: typeof schema.promptTemplates.$inferSelect): StoredPromptTemplate {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    name: r.name,
    body: r.body,
    created_by: r.createdBy,
    created_at: r.createdAt.getTime(),
  };
}

// A daemon counts as alive for staleness if it's marked online AND its heartbeat
// is recent. The relay's heartbeat sweep marks daemons offline after ~90s, but a
// hard crash can leave a stale 'online' row until the next sweep, so we also
// gate on lastSeenAt to avoid calling a just-crashed daemon's schedules healthy.
const DAEMON_HEARTBEAT_GRACE_MS = 90_000;
// A schedule is "stale" only once its missed slot is clearly in the past, not on
// the inevitable few-second lag between next_run_at and the once-a-minute tick.
const DEFAULT_STALE_GRACE_MS = 5 * 60_000;

interface StaleDaemonInput {
  status: string;
  lastSeenAt: number | null;
}

function anyDaemonAlive(daemons: StaleDaemonInput[], now: number): boolean {
  return daemons.some(
    (d) =>
      d.status === "online" &&
      d.lastSeenAt !== null &&
      now - d.lastSeenAt <= DAEMON_HEARTBEAT_GRACE_MS,
  );
}

// Pure staleness check (#619 §3.3): a schedule is stale when its owning daemon is
// gone — no live daemon serves the workspace AND the schedule has a missed run
// (enabled, next_run_at in the past beyond the grace). Workspace-level because a
// schedule runs on whichever of the workspace's daemons is up; if none is, every
// enabled-but-overdue schedule is stranded. Read-only: drives a UI badge, never
// execution (the runner only fires off live SQLite, so this can't double-fire).
export function detectStaleSchedules(
  schedules: StoredSchedule[],
  daemons: StaleDaemonInput[],
  now: number,
  graceMs: number = DEFAULT_STALE_GRACE_MS,
): Set<string> {
  const stale = new Set<string>();
  if (anyDaemonAlive(daemons, now)) return stale; // a live daemon will run them
  for (const s of schedules) {
    if (s.enabled === 1 && s.next_run_at !== null && s.next_run_at < now - graceMs) {
      stale.add(s.id);
    }
  }
  return stale;
}

// PG schedule_runs row → the SQLite-shaped StoredScheduleRun (epoch-ms numbers).
function mapScheduleRunRow(r: typeof schema.scheduleRuns.$inferSelect): StoredScheduleRun {
  return {
    id: r.id,
    schedule_id: r.scheduleId,
    workspace_id: r.workspaceId,
    scheduled_for: r.scheduledFor?.getTime() ?? null,
    started_at: r.startedAt.getTime(),
    ended_at: r.endedAt?.getTime() ?? null,
    status: r.status as StoredScheduleRun["status"],
    skip_reason: (r.skipReason as ScheduleSkipReason | null) ?? null,
    agent_id: r.agentId,
    error: r.error,
  };
}

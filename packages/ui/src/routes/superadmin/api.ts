// Superadmin REST client. Every call hits the relay's `/api/superadmin/*`
// endpoints (contract §3) over plain HTTP with the active session's Bearer
// token. The relay serves this UI, so in production the base origin is the
// same one the saved-session WS url points at — derived via
// relayHttpBaseFromWsUrl (the same helper the invite landing + webhooks panel
// use), which keeps dev (Vite on a different origin) working too.
//
// All responses are JSON. Non-2xx throws SuperadminApiError carrying the HTTP
// status + the server's `{ error }` message so callers can show it verbatim.

import { authState, getSavedSession } from "$lib/state/app.svelte.js";
import { relayHttpBaseFromWsUrl } from "$lib/core/client.js";

// ─── Error type ──────────────────────────────────────────────────────────────

export class SuperadminApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SuperadminApiError";
    this.status = status;
  }
}

// ─── Response shapes (contract §2/§3) ────────────────────────────────────────

export interface SuperadminMe {
  isSuperadmin: boolean;
}

export interface OverviewTotals {
  users: number;
  deletedUsers: number;
  workspaces: number;
  memberships: number;
  daemons: { online: number; offline: number; total: number };
  subscriptions: number;
  superadmins: number;
}

export interface PlanBreakdownRow {
  plan: string | null;
  status: string | null;
  count: number;
}

export interface PlatformBreakdownRow {
  platform: string;
  count: number;
}

export interface OverviewSessions {
  agentSessions: number;
  daemonAgents: number;
  archivedSessions: number;
  // Usage-metrics (round 1): live SUMs over ONLINE daemons' meta snapshots. 0
  // until daemons emit the new counts.
  activeSessions: number;
  activeCybos: number;
}

export interface RecentSignup {
  id: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  createdAt: number | string;
}

export interface SuperadminOverview {
  totals: OverviewTotals;
  plans: PlanBreakdownRow[];
  purchasePlatform: PlatformBreakdownRow[];
  workspaceCloud: { total: number; cloud: number; online: number; noDaemon: number };
  sessions: OverviewSessions;
  // Usage-metrics (round 1): platform-wide per-active-user means + per-edition
  // rollup, both over ONLINE daemons. Zeroed until daemons emit the new counts.
  perUserMetrics: {
    activeUsers: number;
    meanActiveSessions: number;
    meanActiveCybos: number;
    meanAgents: number;
  };
  editionBreakdown: Array<{
    edition: string;
    daemons: number;
    activeSessions: number;
    activeCybos: number;
  }>;
  recentSignups: RecentSignup[];
}

export interface OrgListRow {
  id: string;
  name: string;
  avatarUrl: string | null;
  ownerEmail: string | null;
  memberCount: number;
  plan: string | null;
  status: string | null;
  daemonCount: number;
  createdAt: number | string;
  // Superadmin moderation: epoch-ms when this org was disabled, else null
  // (active). Drives the "Disabled" pill in the orgs list.
  disabledAt: number | string | null;
}

export interface OrgListResponse {
  orgs: OrgListRow[];
  total: number;
}

export interface OrgMember {
  userId: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  role: string;
  membershipType: string | null;
}

export interface OrgSubscription {
  plan: string | null;
  status: string | null;
  stripeCustomerId?: string | null;
  priceId?: string | null;
  currentPeriodEnd?: number | string | null;
  trialEndsAt?: number | string | null;
  cancelAtPeriodEnd?: boolean | null;
  purchasePlatform?: string | null;
}

// Per-daemon detail. Core fields always present; the meta-derived fields
// (platform/arch/host/cpu/memMb/agents/queueDepth/uptime/cyboInstalled/accepting)
// are null when the daemon's meta jsonb is absent or doesn't carry them.
export interface OrgDaemon {
  id: string;
  label: string | null;
  ownerEmail?: string | null;
  status: string | null;
  lastSeenAt: number | string | null;
  deploymentMode: string | null;
  platform?: string | null;
  arch?: string | null;
  host?: string | null;
  cpu?: number | null;
  memMb?: number | null;
  agents?: number | null;
  queueDepth?: number | null;
  uptime?: number | null;
  cyboInstalled?: boolean | null;
  accepting?: boolean | null;
  // Usage-metrics (round 1): live per-daemon counts off meta + the deployment
  // edition (column-or-meta). Null until the daemon emits them.
  activeSessionCount: number | null;
  activeCyboCount: number | null;
  edition: string | null;
}

// Superadmin moderation state: `at` is epoch-ms when the org was disabled
// (null = active); `reason`/`by` are the disable reason + acting admin's userId.
export interface OrgDisabled {
  at: number | string | null;
  reason: string | null;
  by: string | null;
}

export interface OrgDetail {
  id: string;
  name: string;
  avatarUrl: string | null;
  ownerId?: string;
  ownerEmail?: string | null;
  ownerName?: string | null;
  createdAt?: number | string;
  disabled: OrgDisabled;
  members: OrgMember[];
  subscription: OrgSubscription | null;
  daemons: OrgDaemon[];
  counts?: Record<string, number>;
}

export interface UserListRow {
  id: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  createdAt: number | string;
  isSuperadmin: boolean;
  suspendedAt: number | string | null;
  deletedAt: number | string | null;
  workspaceCount: number;
  daemonCount: number;
  agentSessionCount: number;
  // Usage-metrics (round 1): live counts SUMmed over this user's ONLINE daemons.
  // 0 until the user's daemons emit them.
  activeSessions: number;
  activeCybos: number;
  plans: string[];
}

export interface UserListResponse {
  users: UserListRow[];
  total: number;
}

export interface UserDetailWorkspace {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: string;
}

export interface UserDetail {
  id: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
  createdAt?: number | string;
  isSuperadmin: boolean;
  suspendedAt: number | string | null;
  suspendedReason: string | null;
  deletedAt: number | string | null;
  workspaces: UserDetailWorkspace[];
  daemons: OrgDaemon[];
  counts: { agentSessions?: number; workspaces?: number; daemons?: number } & Record<
    string,
    number
  >;
}

export interface SuperadminEntry {
  userId: string;
  email: string;
  name: string | null;
  grantedBy: string | null;
  grantedAt: number | string | null;
}

export interface AuditEntry {
  id: string;
  actorUserId: string;
  actorEmail?: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  createdAt: number | string;
}

export interface ImpersonateResult {
  token: string;
  user: { id: string; email: string; name: string | null };
  expiresInSec: number;
}

// ─── Core fetch wrapper ──────────────────────────────────────────────────────

function relayBase(): string {
  // The saved session carries the relay's WS url; convert to its HTTP origin.
  // Falling back to the current origin keeps the call relative when no session
  // url is stored (production: UI + relay share an origin).
  const saved = getSavedSession();
  if (saved?.url) return relayHttpBaseFromWsUrl(saved.url);
  return "";
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const token = authState.token;
  if (!token) throw new SuperadminApiError(401, "Not authenticated");

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const init: RequestInit = { method, headers, signal: controller.signal };
  if (body !== undefined) init.body = JSON.stringify(body);
  let resp: Response;
  try {
    resp = await fetch(`${relayBase()}${path}`, init);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new SuperadminApiError(0, "Request timed out. Try again in a moment.");
    }
    throw new SuperadminApiError(0, "Can't reach the server. Try again in a moment.");
  } finally {
    clearTimeout(timeoutId);
  }

  if (!resp.ok) {
    // An error response may carry a non-JSON/empty body; fall back to the HTTP
    // status message below rather than masking the real failure with a parse error.
    // intentional: parse failure here is non-fatal — the throw below surfaces the error.
    const data = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new SuperadminApiError(resp.status, data?.error || `HTTP ${resp.status}`);
  }

  // 204/empty bodies resolve to an empty object so callers needn't special-case.
  const text = await resp.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// Some list endpoints may return a bare array OR a `{ <key>: [...] }` wrapper.
// Normalize to an array so the pages don't depend on which the relay chose.
function unwrapList<T>(raw: unknown, key: string): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)[key])) {
    return (raw as Record<string, T[]>)[key];
  }
  return [];
}

// ─── Endpoints (one function per contract §3 route) ──────────────────────────

export function getMe(): Promise<SuperadminMe> {
  return request<SuperadminMe>("GET", "/api/superadmin/me");
}

export function getOverview(): Promise<SuperadminOverview> {
  return request<SuperadminOverview>("GET", "/api/superadmin/overview");
}

export function listOrgs(opts: {
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<OrgListResponse> {
  return request<OrgListResponse>(
    "GET",
    `/api/superadmin/orgs${qs({ limit: opts.limit, offset: opts.offset, search: opts.search })}`,
  );
}

export function getOrg(id: string): Promise<OrgDetail> {
  return request<OrgDetail>("GET", `/api/superadmin/orgs/${encodeURIComponent(id)}`);
}

export function listUsers(opts: {
  limit?: number;
  offset?: number;
  search?: string;
}): Promise<UserListResponse> {
  return request<UserListResponse>(
    "GET",
    `/api/superadmin/users${qs({ limit: opts.limit, offset: opts.offset, search: opts.search })}`,
  );
}

export function getUser(id: string): Promise<UserDetail> {
  return request<UserDetail>("GET", `/api/superadmin/users/${encodeURIComponent(id)}`);
}

export async function listAdmins(): Promise<SuperadminEntry[]> {
  const raw = await request<unknown>("GET", "/api/superadmin/admins");
  return unwrapList<SuperadminEntry>(raw, "admins");
}

export async function listAudit(opts?: { limit?: number; before?: number }): Promise<AuditEntry[]> {
  const raw = await request<unknown>(
    "GET",
    `/api/superadmin/audit${qs({ limit: opts?.limit, before: opts?.before })}`,
  );
  return unwrapList<AuditEntry>(raw, "entries");
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export function setSuperadmin(userId: string, grant: boolean): Promise<{ isSuperadmin: boolean }> {
  return request("POST", `/api/superadmin/users/${encodeURIComponent(userId)}/superadmin`, {
    grant,
  });
}

export function suspendUser(userId: string, reason: string): Promise<unknown> {
  return request("POST", `/api/superadmin/users/${encodeURIComponent(userId)}/suspend`, {
    reason,
  });
}

export function unsuspendUser(userId: string): Promise<unknown> {
  return request("POST", `/api/superadmin/users/${encodeURIComponent(userId)}/unsuspend`);
}

export function deleteUser(userId: string, confirmEmail: string): Promise<unknown> {
  return request("POST", `/api/superadmin/users/${encodeURIComponent(userId)}/delete`, {
    confirmEmail,
  });
}

export function impersonateUser(userId: string): Promise<ImpersonateResult> {
  return request<ImpersonateResult>(
    "POST",
    `/api/superadmin/users/${encodeURIComponent(userId)}/impersonate`,
  );
}

export function setWorkspacePlan(
  workspaceId: string,
  plan: string,
  status?: string,
): Promise<unknown> {
  return request("POST", `/api/superadmin/workspaces/${encodeURIComponent(workspaceId)}/plan`, {
    plan,
    ...(status ? { status } : {}),
  });
}

export function setMemberRole(workspaceId: string, userId: string, role: string): Promise<unknown> {
  return request(
    "POST",
    `/api/superadmin/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/role`,
    { role },
  );
}

// Disable an org (moderation). Reason is OPTIONAL — an empty string stores NULL
// server-side rather than blocking the disable (mirrors suspendUser).
export async function disableOrg(workspaceId: string, reason: string): Promise<void> {
  await request("POST", `/api/superadmin/workspaces/${encodeURIComponent(workspaceId)}/disable`, {
    reason,
  });
}

// Re-enable a disabled org. No body (mirrors unsuspendUser).
export async function enableOrg(workspaceId: string): Promise<void> {
  await request("POST", `/api/superadmin/workspaces/${encodeURIComponent(workspaceId)}/enable`);
}

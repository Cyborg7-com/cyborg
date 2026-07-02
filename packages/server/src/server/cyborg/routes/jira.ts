import { Hono, type Context } from "hono";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PgSync, StoredIntegrationInstallation, StoredProjectSync } from "../db/pg-sync.js";
import type { RelayEnv, RequireAuth } from "./types.js";
import {
  exchangeCode,
  getAccessibleResources,
  getJiraOAuthClientId,
  getJiraOAuthClientSecret,
  isJiraConfigured,
  refreshAccessToken,
} from "../jira-app.js";
import {
  jiraAdapter,
  JIRA_PROVIDER,
  JIRA_WEBHOOK_SECRET_HEADER,
} from "../integrations/jira-adapter.js";
import type {
  NormalizedTaskEvent,
  NormalizedTaskItem,
  SourceStatus,
} from "../integrations/task-integration-adapter.js";
import { dispatchInboundTaskEvents } from "../task-sync-engine.js";
import { decryptToken, encryptToken } from "../task-sync-crypto.js";
import { runJiraPersonalDataReportCycle } from "../jira-personal-data.js";
import { timingSafeEqualStr } from "../auth.js";

// Jira Cloud HTTP routes (OAuth 3LO connect + inbound webhook + project binding +
// status-mapping + import), a SELF-CONTAINED Hono sub-app on top of the committed Jira
// core (jira-app.ts / integrations/jira-adapter.ts / task-sync-engine.ts). It mirrors
// routes/slack-oauth.ts + routes/github.ts EXACTLY: requireAuth + isMember on every
// authed route, a credential-gated `{ configured:false }`, a STABLE-base redirect
// (CYBORG_APP_URL, never the raw Host — open-redirect hardening), a SIGNED OAuth `state`,
// BOLA guards so a member of one workspace can never act on another's install/binding,
// tokens ENCRYPTED at rest (task-sync-crypto.ts) and STRIPPED from every client response,
// and a best-effort webhook that never throws to the provider ack.
//
// Surfaces:
//   GET    /api/jira/config                          — authed: gate + Atlassian authorize URL.
//   GET    /api/jira/oauth/callback                  — PUBLIC: Atlassian's browser redirect.
//   GET    /api/jira/installations                   — authed: this workspace's jira installs.
//   DELETE /api/jira/installation/:id                — authed: disconnect an install (BOLA).
//   POST   /api/jira/project-syncs                   — authed: bind a project + seed mappings.
//   GET    /api/jira/project-syncs?tasksProjectId=   — authed: list a project's bindings.
//   DELETE /api/jira/project-sync/:id                — authed: unbind a project (BOLA).
//   GET    /api/jira/project-syncs/:id/statuses      — authed: source catalog + mappings.
//   PUT    /api/jira/project-syncs/:id/status-mappings — authed: save status → state map.
//   POST   /api/jira/project-syncs/:id/import        — authed: paged backfill via the engine.
//   POST   /api/jira/webhook                         — PUBLIC: inbound Jira REST webhook.
//
// WEBHOOK REGISTRATION: our 3LO app now holds the `manage:jira-webhook` scope, so POST
// /project-syncs AUTO-REGISTERS a dynamic webhook via the REST API (jiraAdapter.registerWebhook)
// pointing at our receiver — no manual admin step (parity with ClickUp). The registered URL is
// the SAME receiver + secret the manual path used:
//   <appBase>/api/jira/webhook?install=<installationId>&secret=<secret>
// The `install` query lets the PUBLIC webhook resolve the site's cloudId + stored secret via
// the existing getIntegrationInstallationById (no new DAL); `secret` is the authenticator the
// route copies into JIRA_WEBHOOK_SECRET_HEADER for jiraAdapter.verifyWebhook. REST-registered
// webhooks EXPIRE after 30 days, so their ids + expiry are stored on the install config and a
// daily sweep (jira-webhook-refresh.ts) extends them. If auto-registration fails (e.g. the
// scope is missing / Jira rejects the url), the bind still succeeds and FALLS BACK to returning
// the manual paste-URL (manualRegistrationRequired: true) — a webhook failure never fails the
// bind.

// The Atlassian OAuth scopes the connect flow requests (space-separated per Atlassian).
// Atlassian bounds a token's granted scopes to what the authorize URL asks for, so a scope
// NOT listed here is never granted — even if it's added in the developer console. Keep this
// in sync with the console app's Permissions.
//   read:jira-work      — listStatuses + search/import
//   write:jira-work     — outbound write-back (issue fields + transitions)
//   read:jira-user      — assignee resolution (accountId <-> email)
//   offline_access      — a rotating refresh_token (~1h access tokens)
//   manage:jira-webhook — register/refresh/delete the dynamic webhook (auto-registration).
//     WITHOUT this, every registerWebhook call 403s and inbound sync silently falls back to
//     the manual paste-URL. Existing installs must re-connect (re-consent) to gain it.
const JIRA_OAUTH_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "offline_access",
  "manage:jira-webhook",
].join(" ");

const ATLASSIAN_AUTHORIZE_URL = "https://auth.atlassian.com/authorize";

// The dynamic-webhook events we auto-register — EXACTLY the set the committed mapper
// (jira-issue-mapper.ts mapJiraWebhookToEvents) understands. Registering anything else would
// deliver events the mapper drops. Docs (events list):
// https://developer.atlassian.com/cloud/jira/platform/webhooks/#configuring-webhooks
const JIRA_WEBHOOK_EVENTS = [
  "jira:issue_created",
  "jira:issue_updated",
  "jira:issue_deleted",
  "comment_created",
];

// The sync directions a binding may carry (parity with routes/github.ts SYNC_DIRECTIONS).
const SYNC_DIRECTIONS = new Set(["inbound", "outbound", "bidirectional"]);

// Import loop bounds: cap total item pages so a huge project can't run unbounded, and cap
// consecutive 429 back-offs so a persistently rate-limited site fails fast instead of
// looping forever.
const IMPORT_MAX_PAGES = 100;
const IMPORT_MAX_RATE_LIMIT_RETRIES = 5;

export interface JiraRoutesDeps {
  pg: PgSync | null;
  requireAuth: RequireAuth;
}

// ── untrusted-body coercion (parity with routes/slack-oauth.ts + routes/github.ts) ──

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

// ── stable-base redirect helpers (verbatim discipline from routes/slack-oauth.ts) ──

// The origin the relay is reached at, derived from the request. Behind the deploy's reverse
// proxy the real host/scheme arrive in X-Forwarded-Host / X-Forwarded-Proto; fall back to
// Host + https. "" when no host header is present (→ a relative redirect).
function requestOrigin(c: Context<RelayEnv>): string {
  const fwdHost = c.req.header("x-forwarded-host");
  const host = (fwdHost || c.req.header("host") || "").split(",")[0]?.trim() ?? "";
  if (!host) return "";
  const fwdProto = c.req.header("x-forwarded-proto");
  const proto = (fwdProto || "https").split(",")[0]?.trim() ?? "https";
  return `${proto}://${host}`;
}

// The base URL the PUBLIC oauth/callback redirects the BROWSER to (and the base the webhook
// URL is built from). SECURITY (open-redirect hardening): the callback is unauthenticated
// and requestOrigin() trusts the attacker-influenceable X-Forwarded-Host / Host, so when
// CYBORG_APP_URL is set we ALWAYS use it and NEVER the request host. The request-origin
// fallback is dev-only. PROD MUST set CYBORG_APP_URL.
function resolveAppBaseUrl(c: Context<RelayEnv>): string {
  const configured = process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  return requestOrigin(c);
}

// The OAuth `redirect_uri` Atlassian calls back to. Atlassian REQUIRES this to be byte-
// identical at authorize-time (/config) and token-exchange-time (oauth/callback) and to
// match the app's registered Callback URL. The two requests are SEPARATE (one authed, one
// Atlassian's browser redirect) so their Host headers are attacker-influenceable behind a
// proxy — we resolve a STABLE configured base, never the request host: prefer
// JIRA_OAUTH_CALLBACK_BASE, else CYBORG_APP_URL, else the request origin ONLY in dev. Both
// call sites use THIS helper so the redirect_uri always matches. PROD MUST set one env var.
function jiraCallbackUrl(c: Context<RelayEnv>): string {
  const configured =
    process.env.JIRA_OAUTH_CALLBACK_BASE?.replace(/\/$/, "") ||
    process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  const base = configured || requestOrigin(c);
  return `${base}/api/jira/oauth/callback`;
}

// ── signed OAuth state (mirrors routes/slack-oauth.ts signSlackOAuthState) ──

// Sign the OAuth `state` so the PUBLIC callback can trust the (workspaceId, userId) it
// carries WITHOUT a session. `<base64url(json)>.<hmac>`, keyed on the Jira client secret
// (always present when configured). The state is minted ONLY by /config AFTER an isMember
// check, so the public callback — which writes a credential-bearing install row attributed
// to {workspaceId, installedBy:userId} — can never be tricked (via a forged Host or a
// guessed workspaceId) into storing an attacker's tokens under a victim's workspace.
export interface JiraOAuthState {
  workspaceId: string;
  userId: string;
}

export function signJiraOAuthState(payload: JiraOAuthState): string {
  const secret = getJiraOAuthClientSecret() ?? "";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyJiraOAuthState(state: string): JiraOAuthState | null {
  const secret = getJiraOAuthClientSecret() ?? "";
  const dot = state.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<JiraOAuthState>;
    if (typeof parsed.workspaceId !== "string" || typeof parsed.userId !== "string") return null;
    return { workspaceId: parsed.workspaceId, userId: parsed.userId };
  } catch {
    return null;
  }
}

// ── install config helpers (typed reads of the JSONB bag) ──

// One auto-registered dynamic-webhook record on an install config, keyed by the binding's
// externalProjectId ("<cloudId>:<projectKey>"). webhookIds are Jira's numeric ids (for
// refresh/teardown); expiresAt is epoch-ms of the 30-day expiry so the refresh sweep can find
// near-expiry rows. No secret here — the shared webhookSecret below authenticates delivery.
export interface JiraWebhookRecord {
  webhookIds: number[];
  expiresAt: number;
}

// The install's config JSONB shape. accessToken (the ENCRYPTED access token) lives in the
// dedicated column; the refresh token is ENCRYPTED here; webhookSecret is the plaintext
// shared secret (it rides in the registered webhook URL query anyway, so encrypting it at
// rest would be theater — the real provider credentials are the tokens). webhooks holds the
// auto-registered dynamic-webhook ids/expiry per bound project (mirrors ClickUp storing its
// webhook bookkeeping on the install config — no schema migration).
interface JiraInstallConfig {
  siteUrl?: string;
  siteName?: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  webhookSecret?: string;
  webhooks?: Record<string, JiraWebhookRecord>;
}

// Coerce the raw config.webhooks JSON into a typed record map, dropping any malformed entry.
// A defensive read: the JSONB bag is untrusted, and a bad entry must never crash a refresh.
function coerceWebhookRecords(raw: unknown): Record<string, JiraWebhookRecord> {
  const out: Record<string, JiraWebhookRecord> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const ids = Array.isArray(value.webhookIds)
      ? value.webhookIds.filter((n): n is number => typeof n === "number" && Number.isFinite(n))
      : [];
    const expiresAt = typeof value.expiresAt === "number" ? value.expiresAt : 0;
    if (ids.length === 0 || expiresAt <= 0) continue;
    out[key] = { webhookIds: ids, expiresAt };
  }
  return out;
}

function readConfig(install: StoredIntegrationInstallation): JiraInstallConfig {
  const cfg = install.config;
  const webhooks = coerceWebhookRecords(cfg.webhooks);
  return {
    siteUrl: typeof cfg.siteUrl === "string" ? cfg.siteUrl : undefined,
    siteName: typeof cfg.siteName === "string" ? cfg.siteName : undefined,
    refreshToken: typeof cfg.refreshToken === "string" ? cfg.refreshToken : undefined,
    expiresAt: typeof cfg.expiresAt === "number" ? cfg.expiresAt : undefined,
    scope: typeof cfg.scope === "string" ? cfg.scope : undefined,
    webhookSecret: typeof cfg.webhookSecret === "string" ? cfg.webhookSecret : undefined,
    // Preserve the webhook records through every config spread (token refresh / secret ensure
    // both rebuild config from readConfig) — dropping them would orphan the refresh sweep.
    webhooks: Object.keys(webhooks).length > 0 ? webhooks : undefined,
  };
}

// Read the auto-registered webhook records off an install (typed, best-effort). Exported so
// the refresh sweep (jira-webhook-refresh.ts) enumerates due webhooks without re-parsing the
// raw JSONB bag.
export function readJiraWebhookRecords(
  install: StoredIntegrationInstallation,
): Record<string, JiraWebhookRecord> {
  return coerceWebhookRecords(install.config.webhooks);
}

// Persist an updated webhook-records map onto an install, preserving every OTHER column and
// config key. The stored accessToken is ALREADY encrypted, so it is passed through unchanged
// (never re-encrypted / double-wrapped). Exported so the refresh sweep can write back a
// refreshed expiry. Idempotent on (workspace, provider, externalId).
export async function persistJiraWebhookRecords(
  pg: PgSync,
  install: StoredIntegrationInstallation,
  records: Record<string, JiraWebhookRecord>,
): Promise<void> {
  const config: JiraInstallConfig = { ...readConfig(install), webhooks: records };
  await pg.upsertIntegrationInstallation({
    id: install.id,
    workspaceId: install.workspaceId,
    provider: install.provider,
    externalId: install.externalId,
    config: config as Record<string, unknown>,
    accessToken: install.accessToken,
    botUserId: install.botUserId,
    scopes: install.scopes,
    installedBy: install.installedBy,
  });
}

// ── token lifecycle (encrypt at rest; refresh a near-expiry access token) ──

// Persist the OAuth grant as a jira install row: externalId = cloudId, the access token
// ENCRYPTED in the column, the refresh token ENCRYPTED in config, plus site url/name +
// expiry + scope. Returns true when an install was stored, false when the exchange or the
// accessible-resources lookup yields nothing usable. Throws only on a network error — the
// callback catches it. Extracted so the callback handler stays under the complexity budget.
export async function exchangeAndStoreJiraInstall(
  c: Context<RelayEnv>,
  pg: PgSync,
  state: JiraOAuthState,
  code: string,
): Promise<boolean> {
  const token = await exchangeCode(code, jiraCallbackUrl(c));
  if (!token || !token.ok) return false;
  const resources = await getAccessibleResources(token.accessToken);
  const site = resources?.[0];
  // No reachable Jira site → the grant is unusable; don't persist a blank install.
  if (!site || !site.id) return false;
  const config: JiraInstallConfig = {
    siteUrl: site.url || undefined,
    siteName: site.name || undefined,
    refreshToken: token.refreshToken ? encryptToken(token.refreshToken) : undefined,
    expiresAt: token.expiresInSeconds ? Date.now() + token.expiresInSeconds * 1000 : undefined,
    scope: token.scope ?? undefined,
  };
  await pg.upsertIntegrationInstallation({
    id: `intg_${randomUUID()}`,
    workspaceId: state.workspaceId,
    provider: JIRA_PROVIDER,
    externalId: site.id,
    config: config as Record<string, unknown>,
    accessToken: encryptToken(token.accessToken),
    scopes: token.scope ?? null,
    installedBy: state.userId,
  });
  return true;
}

// Resolve a USABLE access token for an install: decrypt the stored one and, when it is at /
// past expiry and a refresh token is present, mint a fresh one (Atlassian rotates the
// refresh token, so persist the newest) and re-encrypt both. Returns null when there is no
// stored token or decryption fails. Never throws to the caller.
export async function resolveJiraAccessToken(
  pg: PgSync,
  install: StoredIntegrationInstallation,
): Promise<string | null> {
  if (!install.accessToken) return null;
  let accessToken: string;
  try {
    accessToken = decryptToken(install.accessToken);
  } catch {
    return null;
  }
  const cfg = readConfig(install);
  // Refresh only when we KNOW the token is near/at expiry (60s buffer) AND hold a refresh
  // token — an unknown expiry uses the stored token as-is (fresh right after connect).
  const nearExpiry = cfg.expiresAt !== undefined && cfg.expiresAt - Date.now() < 60_000;
  if (!nearExpiry || !cfg.refreshToken) return accessToken;

  let refreshToken: string;
  try {
    refreshToken = decryptToken(cfg.refreshToken);
  } catch {
    return accessToken;
  }
  const refreshed = await refreshAccessToken(refreshToken);
  if (!refreshed || !refreshed.ok) return accessToken;

  const nextConfig: JiraInstallConfig = {
    ...cfg,
    refreshToken: encryptToken(refreshed.refreshToken ?? refreshToken),
    expiresAt: refreshed.expiresInSeconds
      ? Date.now() + refreshed.expiresInSeconds * 1000
      : cfg.expiresAt,
    scope: refreshed.scope ?? cfg.scope,
  };
  await pg
    .upsertIntegrationInstallation({
      id: install.id,
      workspaceId: install.workspaceId,
      provider: install.provider,
      externalId: install.externalId,
      config: nextConfig as Record<string, unknown>,
      accessToken: encryptToken(refreshed.accessToken),
      botUserId: install.botUserId,
      scopes: refreshed.scope ?? install.scopes,
      installedBy: install.installedBy,
    })
    .catch((err: unknown) => {
      // Best-effort persistence of the rotated token — a transient write failure must not
      // fail the caller's operation; the next refresh recovers.
      console.error("[jira] failed to persist refreshed token", err);
    });
  return refreshed.accessToken;
}

// Ensure the install carries a webhook shared secret (generating + persisting one on first
// use), and return it. The secret is per-SITE (per install) because a Jira REST webhook is
// registered at the site level, not per project. The upsert preserves the existing
// ENCRYPTED access token (passed through unchanged, never re-encrypted) and merges config.
async function ensureWebhookSecret(
  pg: PgSync,
  install: StoredIntegrationInstallation,
): Promise<string> {
  const existing = readConfig(install).webhookSecret;
  if (existing) return existing;
  const secret = randomBytes(24).toString("base64url");
  const config: JiraInstallConfig = { ...readConfig(install), webhookSecret: secret };
  await pg.upsertIntegrationInstallation({
    id: install.id,
    workspaceId: install.workspaceId,
    provider: install.provider,
    externalId: install.externalId,
    config: config as Record<string, unknown>,
    accessToken: install.accessToken,
    botUserId: install.botUserId,
    scopes: install.scopes,
    installedBy: install.installedBy,
  });
  return secret;
}

// ── status-mapping seed (category → task-state group affinity) ──

// Seed one status_mappings row per source status, pre-selecting the project's task-state
// whose GROUP matches the source status's normalized category (the same affinity the engine
// falls back to when no explicit mapping exists). An unmatched category seeds a row with a
// null target the user can fill in. Returns the seeded rows for the response.
export interface SeededStatusMapping {
  sourceStatusId: string;
  sourceStatusName: string;
  taskStateId: string | null;
  category: string;
}

async function seedStatusMappings(
  pg: PgSync,
  opts: {
    workspaceId: string;
    projectSyncId: string;
    tasksProjectId: string;
    userId: string;
    statuses: SourceStatus[];
  },
): Promise<SeededStatusMapping[]> {
  const states = await pg.getProjectStates(opts.tasksProjectId);
  const firstStateByGroup = new Map<string, string>();
  for (const s of states) if (!firstStateByGroup.has(s.group)) firstStateByGroup.set(s.group, s.id);

  const seeded: SeededStatusMapping[] = [];
  for (const status of opts.statuses) {
    const taskStateId = firstStateByGroup.get(status.category) ?? null;
    await pg.upsertStatusMapping({
      workspaceId: opts.workspaceId,
      projectSyncId: opts.projectSyncId,
      provider: JIRA_PROVIDER,
      sourceStatusId: status.id,
      sourceStatusName: status.name,
      taskStateId,
      skipBackward: false,
      createdBy: opts.userId,
    });
    seeded.push({
      sourceStatusId: status.id,
      sourceStatusName: status.name,
      taskStateId,
      category: status.category,
    });
  }
  return seeded;
}

// ── import loop (paged, 429-aware, engine-reused) ──

// Convert an imported work item to a normalized event so the SHARED engine create/refresh
// path handles it — no duplicated task-create here. externalProjectId is the binding's (an
// import item carries only its own key), and only present fields are copied (an absent field
// is left untouched by the engine on a re-import).
function itemToEvent(item: NormalizedTaskItem, externalProjectId: string): NormalizedTaskEvent {
  const event: NormalizedTaskEvent = {
    itemType: item.itemType,
    externalProjectId,
    itemNumber: item.itemNumber,
    providerItemId: item.providerItemId,
    itemUrl: item.itemUrl ?? null,
    title: item.title,
    description: item.description ?? null,
    sourceStatusId: item.sourceStatusId ?? null,
    sourceStatusName: item.sourceStatusName ?? null,
    assigneeEmail: item.assigneeEmail ?? null,
    // Carry the assignee accountId through the import path too, so a backfilled issue records
    // its personal-data subject in provider_user_connections (parity with the webhook path).
    assigneeAccountId: item.assigneeAccountId ?? null,
    labels: item.labels,
    dueAt: item.dueAt ?? null,
  };
  if (item.statusCategory) event.statusCategory = item.statusCategory;
  if (item.priority !== undefined) event.priority = item.priority;
  if (item.startAt !== undefined && item.startAt !== null) event.startAt = item.startAt;
  return event;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface JiraImportResult {
  imported: number;
  pages: number;
  capped: boolean;
  rateLimited: boolean;
}

// Page through the project's issues, feeding each page's items through the engine create
// path. The adapter signals a 429 by returning an EMPTY page WITH a resumable nextCursor;
// we back off (capped) and retry the same cursor. A genuine end returns an empty page with
// NO cursor. Item pages are capped so a huge project can't run unbounded.
async function runJiraImport(
  pg: PgSync,
  token: string,
  externalProjectId: string,
): Promise<JiraImportResult> {
  let cursor: string | undefined;
  let imported = 0;
  let pages = 0;
  let rateLimitRetries = 0;
  let rateLimited = false;

  while (pages < IMPORT_MAX_PAGES) {
    const page = await jiraAdapter.importItems(token, externalProjectId, cursor);
    if (page.items.length === 0) {
      // Empty page WITH a cursor == rate-limited (429); back off + retry the same cursor.
      if (page.nextCursor !== undefined && rateLimitRetries < IMPORT_MAX_RATE_LIMIT_RETRIES) {
        rateLimited = true;
        rateLimitRetries += 1;
        cursor = page.nextCursor;
        await sleep(Math.min(1000 * rateLimitRetries, 5000));
        continue;
      }
      break; // genuine end (no cursor) or retries exhausted.
    }
    rateLimitRetries = 0;
    const events = page.items.map((item) => itemToEvent(item, externalProjectId));
    await dispatchInboundTaskEvents(pg, jiraAdapter, events);
    imported += page.items.length;
    pages += 1;
    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }

  const capped = pages >= IMPORT_MAX_PAGES;
  console.log(
    `[jira] import for ${externalProjectId}: ${imported} items over ${pages} page(s)` +
      `${capped ? " (page cap reached)" : ""}${rateLimited ? " (rate-limited)" : ""}`,
  );
  return { imported, pages, capped, rateLimited };
}

// ── binding resolution for the :id sub-routes (no get-by-id DAL → resolve via project) ──

// The project_syncs DAL has no get-by-id, so the :id sub-routes carry `tasksProjectId` and
// resolve the binding from that project's binding list (parity with slack-oauth's
// "confirm via the workspace's list" delete). BOLA holds: the caller must be a member of the
// project's workspace, and a foreign binding id is simply absent from that list → 404.
type BindingResolution =
  | { ok: true; binding: StoredProjectSync; workspaceId: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

async function resolveBindingForProject(
  pg: PgSync,
  tasksProjectIdParam: string,
  bindingId: string,
  userId: string,
): Promise<BindingResolution> {
  if (!tasksProjectIdParam) return { ok: false, status: 400, error: "tasksProjectId required" };
  const tasksProjectId = await pg.resolveTasksProjectId(tasksProjectIdParam);
  if (!tasksProjectId) return { ok: false, status: 404, error: "project not found" };
  const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
  if (!workspaceId) return { ok: false, status: 404, error: "project not found" };
  if (!(await pg.isMember(workspaceId, userId)))
    return { ok: false, status: 403, error: "not a member" };
  const bindings = await pg.getProjectSyncsForTasksProject(tasksProjectId);
  const binding = bindings.find((b) => b.id === bindingId && b.provider === JIRA_PROVIDER);
  if (!binding) return { ok: false, status: 404, error: "not found" };
  return { ok: true, binding, workspaceId };
}

// Strip the credential-bearing fields (accessToken + config.refreshToken/webhookSecret) from
// an install before it leaves the relay — the client never sees provider secrets.
function toClientInstallation(r: StoredIntegrationInstallation): Record<string, unknown> {
  const cfg = readConfig(r);
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    provider: r.provider,
    externalId: r.externalId,
    config: { siteUrl: cfg.siteUrl, siteName: cfg.siteName, scope: cfg.scope },
    scopes: r.scopes,
    installedBy: r.installedBy,
    createdAt: r.createdAt,
  };
}

// The authed routes' shared membership guard — a thin, unit-testable wrapper over
// pg.isMember (parity with routes/slack-oauth.ts validateWorkspaceAccess).
export function validateWorkspaceAccess(
  pg: PgSync,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  return pg.isMember(workspaceId, userId);
}

// Mounted as a Hono sub-app — the orchestrator does `app.route("/", createJiraRoutes(...))`
// alongside createGithubRoutes / createSlackOAuthRoutes in relay-standalone.ts.
export function createJiraRoutes(deps: JiraRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth } = deps;
  const app = new Hono<RelayEnv>();

  // ── authed: the Jira app's config + the ready-to-use Atlassian authorize URL ──
  // GATED: { configured:false } when the Jira OAuth secrets are absent (jira-app.ts) so the
  // UI shows a "not configured" state. With a workspaceId the authorize URL embeds a SIGNED
  // state {workspaceId, userId} (minted here only after an isMember check). redirect_uri is
  // the stable callback base.
  app.get("/api/jira/config", requireAuth, async (c) => {
    if (!isJiraConfigured()) return c.json({ configured: false, authorizeUrl: null });
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ configured: true, authorizeUrl: null });
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const state = signJiraOAuthState({ workspaceId, userId: c.get("userId") });
    const params = new URLSearchParams({
      audience: "api.atlassian.com",
      client_id: getJiraOAuthClientId() ?? "",
      scope: JIRA_OAUTH_SCOPES,
      redirect_uri: jiraCallbackUrl(c),
      state,
      response_type: "code",
      prompt: "consent",
    });
    return c.json({
      configured: true,
      authorizeUrl: `${ATLASSIAN_AUTHORIZE_URL}?${params.toString()}`,
    });
  });

  // ── PUBLIC: Atlassian's OAuth callback. Atlassian redirects the BROWSER here (no session)
  //    with code + the signed state. Best-effort: exchange the code, store the ENCRYPTED
  //    tokens, then redirect to the Jira integration detail page. Never throws to the
  //    browser — a failure still lands the user with a status note. ──
  app.get("/api/jira/oauth/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = verifyJiraOAuthState(c.req.query("state") ?? "");
    const base = resolveAppBaseUrl(c);
    // A bad/forged state → we can't trust which workspace this is for; land at root.
    if (!state) return c.redirect(`${base || ""}/?jira=oauth_error`, 302);
    const detail = `${base}/workspace/${encodeURIComponent(state.workspaceId)}/settings/integrations/jira`;
    if (!code || !isJiraConfigured() || !pg) {
      return c.redirect(`${detail}?jira=oauth_error`, 302);
    }
    try {
      if (await exchangeAndStoreJiraInstall(c, pg, state, code)) {
        return c.redirect(`${detail}?jira=connected`, 302);
      }
    } catch (err) {
      // Best-effort: a failed exchange must not 500 the browser. Log + land with a note.
      console.error("[jira] oauth callback failed", err);
    }
    return c.redirect(`${detail}?jira=oauth_error`, 302);
  });

  // ── authed: every Jira installation this workspace authorized ──
  // Scoped to the caller's workspace (membership-checked). SECURITY: the access + refresh
  // tokens are STRIPPED (toClientInstallation) — they must never leave the relay.
  app.get("/api/jira/installations", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const rows = await pg.listIntegrationInstallations(workspaceId, JIRA_PROVIDER);
    return c.json({ installations: rows.map(toClientInstallation) });
  });

  // ── authed: disconnect an installation from this workspace ──
  // BOLA guard: `workspaceId` is membership-checked AND the install must belong to it (a
  // foreign install id is rejected, never deleted). Its project_syncs cascade away.
  app.delete("/api/jira/installation/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const install = await pg.getIntegrationInstallationById(id);
    if (!install || install.workspaceId !== workspaceId || install.provider !== JIRA_PROVIDER) {
      return c.json({ error: "not found" }, 404);
    }
    await pg.deleteIntegrationInstallation(id);
    return c.json({ ok: true });
  });

  // ── authed: bind a Cyborg tasks-project to a Jira project + seed status mappings ──
  app.post("/api/jira/project-syncs", requireAuth, (c) => handleCreateProjectSync(c, pg));

  // ── authed: current bindings for a tasks-project ──
  app.get("/api/jira/project-syncs", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const idParam = c.req.query("tasksProjectId");
    if (!idParam) return c.json({ error: "tasksProjectId required" }, 400);
    const tasksProjectId = await pg.resolveTasksProjectId(idParam);
    if (!tasksProjectId) return c.json({ error: "project not found" }, 404);
    const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
    if (!workspaceId) return c.json({ error: "project not found" }, 404);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const all = await pg.getProjectSyncsForTasksProject(tasksProjectId);
    return c.json({ syncs: all.filter((s) => s.provider === JIRA_PROVIDER) });
  });

  // ── authed: unbind a Jira project from a tasks-project ──
  // BOLA guard: `workspaceId` is membership-checked, and deleteProjectSync is scoped by BOTH
  // id AND workspaceId so a foreign binding id is a no-op (never another workspace's row).
  app.delete("/api/jira/project-sync/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    await pg.deleteProjectSync(id, workspaceId);
    return c.json({ ok: true });
  });

  // ── authed: the binding's source status catalog + current mappings (mapping UI) ──
  app.get("/api/jira/project-syncs/:id/statuses", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const resolved = await resolveBindingForProject(
      pg,
      c.req.query("tasksProjectId") ?? "",
      c.req.param("id"),
      c.get("userId"),
    );
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const mappings = await pg.listStatusMappings(resolved.binding.id);
    // Live-fetch the source catalog best-effort — a provider hiccup must not blank the
    // mapping UI (it still renders the saved mappings + a fetch note).
    let statuses: SourceStatus[] = [];
    let statusError: string | null = null;
    const token = await tokenForBinding(pg, resolved.binding);
    if (!token) {
      statusError = "installation token unavailable";
    } else {
      try {
        statuses = await jiraAdapter.listStatuses(token, resolved.binding.externalProjectId);
      } catch (err) {
        statusError = err instanceof Error ? err.message : "failed to fetch statuses";
        console.error("[jira] listStatuses failed", err);
      }
    }
    return c.json({ statuses, mappings, statusError });
  });

  // ── authed: save source status → task-state mappings for a binding ──
  app.put("/api/jira/project-syncs/:id/status-mappings", requireAuth, (c) =>
    handleSaveStatusMappings(c, pg),
  );

  // ── authed: run a paged import (backfill) through the SHARED sync engine ──
  app.post("/api/jira/project-syncs/:id/import", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const resolved = await resolveBindingForProject(
      pg,
      c.req.query("tasksProjectId") ?? "",
      c.req.param("id"),
      c.get("userId"),
    );
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const token = await tokenForBinding(pg, resolved.binding);
    if (!token) return c.json({ error: "installation token unavailable" }, 409);
    try {
      const result = await runJiraImport(pg, token, resolved.binding.externalProjectId);
      return c.json(result);
    } catch (err) {
      console.error("[jira] import failed", err);
      return c.json({ error: "import failed" }, 502);
    }
  });

  // ── PUBLIC: inbound Jira REST webhook. Registered MANUALLY as
  //    <base>/api/jira/webhook?install=<id>&secret=<secret>. Resolve the install by id →
  //    its stored secret + cloudId; verify the query secret (copied into the adapter's
  //    header) constant-time; inject cloudId into the body; parse + dispatch best-effort;
  //    200-ack FAST (like the Slack events route) so a slow apply never makes Jira retry. ──
  app.post("/api/jira/webhook", async (c) => {
    if (!pg) return c.json({ ok: true });
    const rawBody = await c.req.text().catch(() => "");
    const install = await installForWebhook(pg, c.req.query("install") ?? "");
    const storedSecret = install ? readConfig(install).webhookSecret : undefined;
    if (!install || !storedSecret) return c.json({ error: "unknown webhook" }, 401);
    const headers = { [JIRA_WEBHOOK_SECRET_HEADER]: c.req.query("secret") ?? "" };
    if (!jiraAdapter.verifyWebhook(rawBody, headers, storedSecret)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    // Ack first, then process asynchronously (dispatchInboundTaskEvents is best-effort and
    // never throws; the .catch is belt-and-suspenders so an unexpected error can't reject).
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (isRecord(parsed)) parsed.cloudId = install.externalId; // the mapper reads body.cloudId.
      const events = jiraAdapter.parseInbound(parsed);
      if (events.length > 0) {
        void dispatchInboundTaskEvents(pg, jiraAdapter, events).catch((err: unknown) => {
          console.error("[jira] webhook dispatch failed", err);
        });
      }
    } catch (err) {
      console.error("[jira] webhook parse failed", err);
    }
    return c.json({ ok: true });
  });

  // ── INTERNAL ops/QA trigger: run ONE Atlassian Personal Data Reporting cycle on demand ──
  // This is NOT an Atlassian-facing receiver — for a 3LO OAuth app the model is PUSH /
  // OUTBOUND POLL (our app calls Atlassian; Atlassian never calls us, so there is no inbound
  // request signature to verify). It lets a cron/operator kick the weekly report+erase cycle
  // (jira-personal-data.ts) outside the unwired boot scheduler. Contract:
  // https://developer.atlassian.com/cloud/jira/platform/user-privacy-developer-guide/
  // Auth: a shared secret (env JIRA_PERSONAL_DATA_REPORT_SECRET) presented in the
  // x-cyborg-personal-data-report-secret header, compared CONSTANT-TIME. Purely additive —
  // never mounted into the OAuth/webhook flows.
  app.post("/api/jira/personal-data-report/run", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const secret = process.env.JIRA_PERSONAL_DATA_REPORT_SECRET ?? "";
    if (!secret) return c.json({ error: "personal data reporting not configured" }, 503);
    const presented = c.req.header("x-cyborg-personal-data-report-secret") ?? "";
    if (!timingSafeEqualStr(secret, presented)) return c.json({ error: "unauthorized" }, 401);
    const summary = await runJiraPersonalDataReportCycle(pg);
    return c.json(summary);
  });

  return app;
}

// ── extracted handlers (keep the factory's inline closures small) ──

// The install a webhook belongs to, by the `install` id in its registered URL. null when the
// id is absent, unknown, or points at a non-jira install.
async function installForWebhook(
  pg: PgSync,
  installId: string,
): Promise<StoredIntegrationInstallation | null> {
  if (!installId) return null;
  const install = await pg.getIntegrationInstallationById(installId);
  if (!install || install.provider !== JIRA_PROVIDER) return null;
  return install;
}

// Resolve a fresh access token for a binding via its installation, or null when the binding
// has no installation / the install is gone / no usable token.
async function tokenForBinding(pg: PgSync, binding: StoredProjectSync): Promise<string | null> {
  if (!binding.installationId) return null;
  const install = await pg.getIntegrationInstallationById(binding.installationId);
  if (!install || install.provider !== JIRA_PROVIDER) return null;
  return resolveJiraAccessToken(pg, install);
}

// The validated shape of a project-sync create request (post body parse + format checks).
interface ParsedProjectSyncBody {
  tasksProjectIdParam: string;
  installationId: string;
  externalProjectId: string;
  externalProjectName: string | null;
  externalUrl: string | null;
  syncDirection: string | undefined;
  cloudId: string;
}

// Parse + validate the create-binding body: required fields, a valid syncDirection, and the
// "<cloudId>:<projectKey>" shape (cloudId is a UUID, so split on the FIRST colon — parity
// with the adapter's parseExternalProjectId). Extracted to keep the handler's complexity in
// budget. Returns the parsed value or a client-facing 400 reason.
function parseProjectSyncBody(
  body: Record<string, unknown>,
): { ok: true; value: ParsedProjectSyncBody } | { ok: false; error: string } {
  const tasksProjectIdParam = asString(body.tasksProjectId).trim();
  const installationId = asString(body.installationId).trim();
  const externalProjectId = asString(body.externalProjectId).trim();
  if (!tasksProjectIdParam || !installationId || !externalProjectId) {
    return { ok: false, error: "tasksProjectId, installationId, externalProjectId required" };
  }
  const rawDirection = asString(body.syncDirection).trim();
  if (rawDirection && !SYNC_DIRECTIONS.has(rawDirection)) {
    return { ok: false, error: "invalid syncDirection (inbound|outbound|bidirectional)" };
  }
  const colon = externalProjectId.indexOf(":");
  if (colon <= 0 || colon === externalProjectId.length - 1) {
    return { ok: false, error: 'externalProjectId must be "<cloudId>:<projectKey>"' };
  }
  return {
    ok: true,
    value: {
      tasksProjectIdParam,
      installationId,
      externalProjectId,
      externalProjectName: asString(body.externalProjectName).trim() || null,
      externalUrl: asString(body.externalUrl).trim() || null,
      syncDirection: rawDirection || undefined,
      cloudId: externalProjectId.slice(0, colon),
    },
  };
}

// Seed the binding's status_mappings from the LIVE source status catalog, best-effort: a
// missing token or a provider hiccup returns an empty seed + a note rather than failing the
// bind. Extracted from handleCreateProjectSync to keep its complexity in budget.
async function seedFromLiveStatuses(
  pg: PgSync,
  install: StoredIntegrationInstallation,
  opts: {
    workspaceId: string;
    projectSyncId: string;
    tasksProjectId: string;
    externalProjectId: string;
    userId: string;
  },
): Promise<{ statusMappings: SeededStatusMapping[]; statusError: string | null }> {
  const token = await resolveJiraAccessToken(pg, install);
  if (!token) return { statusMappings: [], statusError: "installation token unavailable" };
  try {
    const statuses = await jiraAdapter.listStatuses(token, opts.externalProjectId);
    const statusMappings = await seedStatusMappings(pg, {
      workspaceId: opts.workspaceId,
      projectSyncId: opts.projectSyncId,
      tasksProjectId: opts.tasksProjectId,
      userId: opts.userId,
      statuses,
    });
    return { statusMappings, statusError: null };
  } catch (err) {
    console.error("[jira] seed status mappings failed", err);
    return {
      statusMappings: [],
      statusError: err instanceof Error ? err.message : "failed to fetch statuses",
    };
  }
}

// Best-effort auto-registration of the inbound dynamic webhook for a freshly-bound project.
// Registers our receiver URL (install id + shared secret in the query) for the mapper's event
// set, JQL-filtered to this project, then persists the returned webhook id(s) + 30-day expiry
// onto the install config for the refresh sweep. A missing token, a missing scope, or any Jira
// error returns { autoRegistered:false } so the caller falls back to the manual URL — the bind
// never fails on a webhook error.
async function tryAutoRegisterJiraWebhook(
  pg: PgSync,
  install: StoredIntegrationInstallation,
  opts: { cloudId: string; projectKey: string; externalProjectId: string; webhookUrl: string },
): Promise<{ autoRegistered: boolean; expiresAt: number | null }> {
  const token = await resolveJiraAccessToken(pg, install);
  if (!token) return { autoRegistered: false, expiresAt: null };
  const jqlFilter = `project = "${opts.projectKey.replace(/"/g, '\\"')}"`;
  const result = await jiraAdapter.registerWebhook(token, opts.cloudId, {
    url: opts.webhookUrl,
    events: JIRA_WEBHOOK_EVENTS,
    jqlFilter,
  });
  if (!result.ok) {
    console.error("[jira] webhook auto-register failed", result.status, result.error);
    return { autoRegistered: false, expiresAt: null };
  }
  const expiresAt = Date.parse(result.registration.expirationDate) || Date.now();
  // Re-read the install so we merge onto the FRESHEST config (ensureWebhookSecret + any token
  // rotation may have just rewritten it) rather than clobbering those writes.
  const fresh = (await pg.getIntegrationInstallationById(install.id)) ?? install;
  const records = readJiraWebhookRecords(fresh);
  records[opts.externalProjectId] = { webhookIds: result.registration.webhookIds, expiresAt };
  await persistJiraWebhookRecords(pg, fresh, records);
  return { autoRegistered: true, expiresAt };
}

// POST /api/jira/project-syncs: bind a Cyborg tasks-project to a Jira project. Asserts the
// install + tasks-project belong to the caller's workspace and the externalProjectId's
// cloudId matches the install's site (tenant integrity), upserts the binding, then seeds
// status_mappings by category→group affinity and returns the manual webhook URL + secret.
async function handleCreateProjectSync(c: Context<RelayEnv>, pg: PgSync | null): Promise<Response> {
  if (!pg) return c.json({ error: "database unavailable" }, 503);
  const parsed = parseProjectSyncBody(asObject(await c.req.json().catch(() => ({}))));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { installationId, externalProjectId, externalProjectName, externalUrl, syncDirection } =
    parsed.value;

  const tasksProjectId = await pg.resolveTasksProjectId(parsed.value.tasksProjectIdParam);
  if (!tasksProjectId) return c.json({ error: "project not found" }, 404);
  const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
  if (!workspaceId) return c.json({ error: "project not found" }, 404);
  const userId = c.get("userId");
  if (!(await pg.isMember(workspaceId, userId))) return c.json({ error: "not a member" }, 403);

  // BOLA / tenant-integrity: the install must be one THIS workspace authorized, and the
  // externalProjectId's cloudId must match that install's site — so a member can't bind a
  // FOREIGN install or a project on a different site into this workspace's sync.
  const install = await pg.getIntegrationInstallationById(installationId);
  if (!install || install.workspaceId !== workspaceId || install.provider !== JIRA_PROVIDER) {
    return c.json({ error: "installation not found" }, 404);
  }
  if (parsed.value.cloudId !== install.externalId) {
    return c.json({ error: "externalProjectId cloudId does not match installation" }, 400);
  }

  const bindingId = await pg.upsertProjectSync({
    workspaceId,
    provider: JIRA_PROVIDER,
    installationId,
    tasksProjectId,
    externalProjectId,
    externalProjectName,
    externalUrl,
    syncDirection,
    createdBy: userId,
  });

  const { statusMappings, statusError } = await seedFromLiveStatuses(pg, install, {
    workspaceId,
    projectSyncId: bindingId,
    tasksProjectId,
    externalProjectId,
    userId,
  });

  const secret = await ensureWebhookSecret(pg, install);
  const webhookUrl = `${resolveAppBaseUrl(c)}/api/jira/webhook?install=${encodeURIComponent(
    installationId,
  )}&secret=${encodeURIComponent(secret)}`;

  // Try to auto-register the webhook (best-effort); fall back to the manual URL on any failure.
  const colon = externalProjectId.indexOf(":");
  const projectKey = externalProjectId.slice(colon + 1);
  const auto = await tryAutoRegisterJiraWebhook(pg, install, {
    cloudId: parsed.value.cloudId,
    projectKey,
    externalProjectId,
    webhookUrl,
  });

  return c.json({
    binding: {
      id: bindingId,
      workspaceId,
      provider: JIRA_PROVIDER,
      installationId,
      tasksProjectId,
      externalProjectId,
      externalProjectName,
      externalUrl,
      syncDirection: syncDirection ?? "inbound",
    },
    statusMappings,
    statusError,
    webhook: auto.autoRegistered
      ? {
          // Auto-registered via the dynamic-webhook REST API — no manual step. Expires in 30
          // days; the refresh sweep (jira-webhook-refresh.ts) extends it before then.
          url: webhookUrl,
          autoRegistered: true,
          manualRegistrationRequired: false,
          expiresAt: auto.expiresAt,
        }
      : {
          // Fallback: registration was unavailable (no token / missing scope / Jira rejected
          // the url). The bind still succeeded; the site admin pastes this URL manually.
          url: webhookUrl,
          secret,
          autoRegistered: false,
          manualRegistrationRequired: true,
          instructions:
            "In Jira: Settings → System → WebHooks → Create a WebHook, paste this URL, and " +
            "enable the Issue (created/updated/deleted) and Comment (created) events.",
        },
  });
}

// PUT /api/jira/project-syncs/:id/status-mappings: persist source status → task-state maps.
// Each provided taskStateId must belong to the binding's OWN project (cross-project guard,
// parity with routes/github.ts's state overrides).
async function handleSaveStatusMappings(
  c: Context<RelayEnv>,
  pg: PgSync | null,
): Promise<Response> {
  if (!pg) return c.json({ error: "database unavailable" }, 503);
  const resolved = await resolveBindingForProject(
    pg,
    c.req.query("tasksProjectId") ?? "",
    c.req.param("id") ?? "",
    c.get("userId"),
  );
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  const body = asObject(await c.req.json().catch(() => ({})));
  const rawMappings = Array.isArray(body.mappings) ? body.mappings : [];

  let count = 0;
  for (const raw of rawMappings) {
    const m = asObject(raw);
    const sourceStatusName = asString(m.sourceStatusName).trim();
    if (!sourceStatusName) continue;
    const sourceStatusId = asString(m.sourceStatusId).trim() || null;
    const taskStateId = asString(m.taskStateId).trim() || null;
    const skipBackward = m.skipBackward === true;
    // Cross-project guard: a chosen target state must be one of THIS project's states.
    if (
      taskStateId &&
      !(await pg.stateBelongsToProject(taskStateId, resolved.binding.tasksProjectId))
    ) {
      return c.json({ error: "state does not belong to project" }, 400);
    }
    await pg.upsertStatusMapping({
      workspaceId: resolved.workspaceId,
      projectSyncId: resolved.binding.id,
      provider: JIRA_PROVIDER,
      sourceStatusId,
      sourceStatusName,
      taskStateId,
      skipBackward,
      createdBy: c.get("userId"),
    });
    count += 1;
  }
  return c.json({ ok: true, count });
}

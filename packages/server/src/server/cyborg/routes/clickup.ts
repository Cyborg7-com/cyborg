import { Hono, type Context } from "hono";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PgSync, StoredIntegrationInstallation, StoredProjectSync } from "../db/pg-sync.js";
import type { RelayEnv, RequireAuth } from "./types.js";
import {
  isClickUpConfigured,
  getClickUpOAuthClientId,
  getClickUpOAuthClientSecret,
  exchangeCode,
  clickUpAuthHeaderValue,
} from "../clickup-app.js";
import { clickUpAdapter } from "../integrations/clickup-adapter.js";
import { dispatchInboundTaskEvents } from "../task-sync-engine.js";
import { encryptToken, decryptToken } from "../task-sync-crypto.js";
import type {
  NormalizedTaskEvent,
  NormalizedTaskItem,
  SourceStatus,
} from "../integrations/task-integration-adapter.js";

// ClickUp (API v2) → Tasks integration HTTP surface — a SELF-CONTAINED Hono sub-app the
// relay mounts with `app.route("/", createClickUpRoutes(...))`. It sits on top of the
// committed ClickUp core (clickup-app.ts / integrations/clickup-adapter.ts), the
// provider-generic sync engine (task-sync-engine.ts), and the token crypto
// (task-sync-crypto.ts) — none of which this file modifies.
//
// It mirrors routes/slack-oauth.ts + routes/github.ts EXACTLY: requireAuth + isMember on
// every authed route, a credential-gated `{ configured:false }`, a SIGNED OAuth `state`,
// a STABLE-base redirect (CYBORG_APP_URL, never the raw Host), BOLA guards so a member of
// one workspace can never act on another's install/binding, and the provider token
// STRIPPED from every response (+ encrypted at rest).
//
// Surfaces:
//   GET    /api/clickup/config                              — authed: gate + authorize URL.
//   GET    /api/clickup/oauth/callback                      — PUBLIC: ClickUp's redirect.
//   GET    /api/clickup/installations                       — authed: installs (token STRIPPED).
//   DELETE /api/clickup/installation/:id                    — authed: disconnect (BOLA).
//   POST   /api/clickup/project-syncs                       — authed: bind + seed + register hook.
//   GET    /api/clickup/project-syncs?tasksProjectId=       — authed: a project's bindings.
//   DELETE /api/clickup/project-sync/:id                    — authed: unbind (BOLA).
//   GET    /api/clickup/project-syncs/:id/statuses          — authed: catalog + mappings.
//   PUT    /api/clickup/project-syncs/:id/status-mappings   — authed: save mappings.
//   POST   /api/clickup/project-syncs/:id/import            — authed: paged backfill.
//   POST   /api/clickup/webhook                             — PUBLIC: inbound task events.
//
// ClickUp specifics baked in: OAuth access tokens do NOT expire (no refresh — exchangeCode
// is one-shot); the token is sent VERBATIM in the Authorization header (no "Bearer "); the
// webhook signature is a hex HMAC-SHA256 of the raw body under the per-webhook secret
// ClickUp returns at registration; externalProjectId == the ClickUp LIST id.

// The provider key stored in integration_installations / project_syncs / status_mappings.
// A local literal (not imported from the adapter) so this surface stays decoupled from the
// engine — parity with slack-oauth.ts's SLACK_PROVIDER.
const CLICKUP_PROVIDER = "clickup";

// ClickUp API v2 base — the two raw calls this route makes (list authorized teams at OAuth
// time, register a webhook at bind time) that are NOT part of the committed adapter's seam.
const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

// ClickUp's OAuth authorize page — the user is redirected here to grant the app access.
const CLICKUP_AUTHORIZE_URL = "https://app.clickup.com/api";

// The task webhook events this integration subscribes to at registration — exactly the set
// the committed mapper (clickup-task-mapper.ts mapClickUpWebhookToEvents) understands.
const CLICKUP_WEBHOOK_EVENTS = [
  "taskCreated",
  "taskUpdated",
  "taskStatusUpdated",
  "taskCommentPosted",
  "taskDeleted",
];

// Backfill safety cap: at 100 tasks/page this bounds one import request to 5,000 tasks so a
// huge List can't run the handler unbounded. The UI re-triggers import to continue.
const MAX_IMPORT_PAGES = 50;

export interface ClickUpRoutesDeps {
  pg: PgSync | null;
  requireAuth: RequireAuth;
}

// ── untrusted-body coercion (parity with routes/github.ts) ──

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

// A trimmed state-id string, or null for "" / a missing/non-string value (an explicit JSON
// null clears the mapping's target state).
function optStateId(v: unknown): string | null {
  const s = asString(v).trim();
  return s || null;
}

// ── stable-base redirect helpers (verbatim discipline from routes/slack-oauth.ts) ──

function requestOrigin(c: Context<RelayEnv>): string {
  const fwdHost = c.req.header("x-forwarded-host");
  const host = (fwdHost || c.req.header("host") || "").split(",")[0]?.trim() ?? "";
  if (!host) return "";
  const fwdProto = c.req.header("x-forwarded-proto");
  const proto = (fwdProto || "https").split(",")[0]?.trim() ?? "https";
  return `${proto}://${host}`;
}

// The base URL the PUBLIC oauth/callback redirects the BROWSER to (the app origin).
// Open-redirect hardening: the callback is unauthenticated and requestOrigin() trusts the
// attacker-influenceable X-Forwarded-Host / Host, so when CYBORG_APP_URL is set we ALWAYS
// use it and NEVER the request host. The request-origin fallback is dev-only. PROD MUST set
// CYBORG_APP_URL.
function resolveAppBaseUrl(c: Context<RelayEnv>): string {
  const configured = process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  return requestOrigin(c);
}

// The OAuth `redirect_uri` ClickUp calls back to. MUST be byte-identical at authorize-time
// (/config) and token-exchange-time (oauth/callback). The two requests are separate and
// their Host headers are attacker-influenceable behind a proxy, so resolve a STABLE base:
// prefer CLICKUP_OAUTH_CALLBACK_BASE, else CYBORG_APP_URL, else the request origin ONLY in
// dev. Both call sites use THIS helper. PROD MUST set one of the two env vars.
function clickUpCallbackUrl(c: Context<RelayEnv>): string {
  const configured =
    process.env.CLICKUP_OAUTH_CALLBACK_BASE?.replace(/\/$/, "") ||
    process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  const base = configured || requestOrigin(c);
  return `${base}/api/clickup/oauth/callback`;
}

// The public endpoint URL a registered ClickUp webhook POSTs to. It embeds the install id
// AND the List id so the PUBLIC receiver can resolve the install (→ the signing secret) and
// the externalProjectId WITHOUT a lookup-by-webhook-id (the raw ClickUp webhook body may
// not echo the List id). The query params are only a lookup hint — the HMAC over the raw
// body is the real gate — so a spoofed value can never forge an event. Same stable-base
// discipline: CLICKUP_WEBHOOK_BASE, else CYBORG_APP_URL, else the request origin in dev.
function webhookEndpointUrl(c: Context<RelayEnv>, installId: string, listId: string): string {
  const configured =
    process.env.CLICKUP_WEBHOOK_BASE?.replace(/\/$/, "") ||
    process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  const base = configured || requestOrigin(c);
  const params = new URLSearchParams({ install: installId, list: listId });
  return `${base}/api/clickup/webhook?${params.toString()}`;
}

// ── signed OAuth state (mirrors routes/slack-oauth.ts signSlackOAuthState) ──

// The PUBLIC callback trusts the (workspaceId, userId) it carries WITHOUT a session because
// the HMAC is keyed on the ClickUp OAuth client secret and the state is minted ONLY by
// /config AFTER an isMember check — so the callback (which writes a credential-bearing
// install attributed to {workspaceId, installedBy:userId}) can never be tricked into
// storing an attacker's token under a victim's workspace.
export interface ClickUpOAuthState {
  workspaceId: string;
  userId: string;
}

export function signClickUpOAuthState(payload: ClickUpOAuthState): string {
  const secret = getClickUpOAuthClientSecret() ?? "";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyClickUpOAuthState(state: string): ClickUpOAuthState | null {
  const secret = getClickUpOAuthClientSecret() ?? "";
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
    ) as Partial<ClickUpOAuthState>;
    if (typeof parsed.workspaceId !== "string" || typeof parsed.userId !== "string") return null;
    return { workspaceId: parsed.workspaceId, userId: parsed.userId };
  } catch {
    return null;
  }
}

// ── ClickUp team lookup (raw v2 call — not part of the committed adapter seam) ──

// One authorized ClickUp team ("Workspace" in the UI). The install keys on the primary
// team's id (integration_installations UNIQUE is (workspace, provider, externalId)).
export interface ClickUpTeam {
  id: string;
  name: string;
}

// The teams an OAuth token is authorized for (GET /api/v2/team → { teams:[{id,name}] }).
// Best-effort: any transport/parse/provider error yields [] so the callback degrades to a
// stable fallback externalId rather than 500-ing the browser. The token goes VERBATIM in
// the Authorization header (ClickUp uses no "Bearer " prefix — clickUpAuthHeaderValue).
export async function fetchClickUpTeams(token: string): Promise<ClickUpTeam[]> {
  try {
    const res = await fetch(`${CLICKUP_API_BASE}/team`, {
      method: "GET",
      headers: { Authorization: clickUpAuthHeaderValue(token), Accept: "application/json" },
    });
    if (!res.ok) {
      // intentional: best-effort stream cleanup on a failed team lookup; not actionable.
      await res.body?.cancel().catch(() => {});
      return [];
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const rows = Array.isArray(json.teams) ? json.teams : [];
    const teams: ClickUpTeam[] = [];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const id = asString(raw.id).trim();
      if (!id) continue;
      teams.push({ id, name: asString(raw.name).trim() });
    }
    return teams;
  } catch {
    return [];
  }
}

// ── webhook registration (raw v2 call — the committed adapter has no register method) ──

// The identity of a registered ClickUp webhook — its id (for later teardown) and the
// signing secret ClickUp returns ONCE at creation (used by verifyWebhook on every inbound
// POST). The secret is stored ENCRYPTED at rest on the install config.
export interface ClickUpWebhookRegistration {
  id: string;
  secret: string;
}

// Register a ClickUp webhook on a team, filtered to one List, pointing at `endpoint`. POST
// /api/v2/team/{team_id}/webhook → the created webhook carries its `secret` (the HMAC key)
// and `id`. ClickUp nests these under a `webhook` key; some responses surface them at the
// top level too, so read either. Best-effort: any error returns null (the binding still
// succeeds; inbound sync is simply not wired until a retry). Exported for direct testing.
export async function registerClickUpWebhook(opts: {
  token: string;
  teamId: string;
  endpoint: string;
  listId: string;
}): Promise<ClickUpWebhookRegistration | null> {
  try {
    const res = await fetch(`${CLICKUP_API_BASE}/team/${encodeURIComponent(opts.teamId)}/webhook`, {
      method: "POST",
      headers: {
        Authorization: clickUpAuthHeaderValue(opts.token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        endpoint: opts.endpoint,
        events: CLICKUP_WEBHOOK_EVENTS,
        list_id: opts.listId,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return null;
    const hook = isRecord(json.webhook) ? json.webhook : json;
    const id = asString(hook.id).trim() || asString(json.id).trim();
    const secret = asString(hook.secret).trim() || asString(json.secret).trim();
    if (!id || !secret) return null;
    return { id, secret };
  } catch {
    return null;
  }
}

// ── install-config webhook bookkeeping (secrets live on the install's JSON config) ──

// The stored per-List webhook records on an install config: config.webhooks[listId] =
// { id, secret } with `secret` encrypted at rest. project_syncs has no config column, so
// the install (which does) is the natural home; one webhook per (install, List).
function readWebhooksConfig(config: Record<string, unknown>): Record<string, unknown> {
  return isRecord(config.webhooks) ? config.webhooks : {};
}

// The DECRYPTED signing secret registered for a List on this install, or null when absent.
function webhookSecretForList(config: Record<string, unknown>, listId: string): string | null {
  const rec = readWebhooksConfig(config)[listId];
  if (!isRecord(rec)) return null;
  const stored = asString(rec.secret).trim();
  if (!stored) return null;
  return decryptToken(stored);
}

// Merge a freshly-registered webhook record (secret ENCRYPTED) into an install config,
// leaving every other config key intact.
function withWebhookRecord(
  config: Record<string, unknown>,
  listId: string,
  reg: ClickUpWebhookRegistration,
): Record<string, unknown> {
  const webhooks = { ...readWebhooksConfig(config) };
  webhooks[listId] = { id: reg.id, secret: encryptToken(reg.secret) };
  return { ...config, webhooks };
}

// Re-persist an install row with a new config, passing every other column verbatim. The
// accessToken is ALREADY encrypted on the stored row, so it is passed through unchanged
// (never re-encrypted / double-wrapped). Idempotent on (workspace, provider, externalId).
async function persistInstallConfig(
  pg: PgSync,
  install: StoredIntegrationInstallation,
  config: Record<string, unknown>,
): Promise<void> {
  await pg.upsertIntegrationInstallation({
    id: install.id,
    workspaceId: install.workspaceId,
    provider: install.provider,
    externalId: install.externalId,
    config,
    accessToken: install.accessToken,
    botUserId: install.botUserId,
    scopes: install.scopes,
    installedBy: install.installedBy,
  });
}

// The decrypted API token for an install, or null when the row carries no token.
function installToken(install: StoredIntegrationInstallation): string | null {
  if (install.accessToken == null) return null;
  return decryptToken(install.accessToken);
}

// ── OAuth exchange + persist (mirrors slack-oauth.ts exchangeAndStoreSlackInstall) ──

// Exchange the OAuth code for a (non-expiring) token, learn the authorized team, and persist
// the install with the token ENCRYPTED. Returns true when an install was stored, false when
// the exchange fails. Never throws — the callback catches. externalId is the primary team's
// id; if the /team lookup fails we still record the install under a STABLE per-workspace
// fallback id (documented degradation) so a transient team-lookup blip doesn't lose the
// connection — a later reconnect records the real team id.
export async function exchangeAndStoreClickUpInstall(
  pg: PgSync,
  state: ClickUpOAuthState,
  code: string,
): Promise<boolean> {
  const result = await exchangeCode(code);
  if (!result.ok) return false;
  const token = result.accessToken;
  const teams = await fetchClickUpTeams(token);
  const primary = teams[0];
  const externalId = primary?.id || `clickup_ws_${state.workspaceId}`;
  const config: Record<string, unknown> = primary
    ? { teamName: primary.name, teams }
    : { needsTeamResolution: true };
  await pg.upsertIntegrationInstallation({
    id: `intg_${randomUUID()}`,
    workspaceId: state.workspaceId,
    provider: CLICKUP_PROVIDER,
    externalId,
    config,
    accessToken: encryptToken(token),
    scopes: null,
    installedBy: state.userId,
  });
  return true;
}

// ── binding resolution for the :id sub-routes (reuses existing PgSync methods) ──

// There is no getProjectSyncById in PgSync, so a :id sub-route resolves its binding through
// the caller-supplied tasksProjectId: resolve → workspace → membership → find-by-id in that
// project's ClickUp bindings. This keeps full BOLA (the caller must be a member of the
// project the binding lives in) WITHOUT adding a DAL method.
type BindingResolution =
  | { ok: true; binding: StoredProjectSync; workspaceId: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

async function resolveBinding(
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
  if (!(await pg.isMember(workspaceId, userId))) {
    return { ok: false, status: 403, error: "not a member" };
  }
  const syncs = await pg.getProjectSyncsForTasksProject(tasksProjectId);
  const binding = syncs.find((s) => s.id === bindingId && s.provider === CLICKUP_PROVIDER);
  if (!binding) return { ok: false, status: 404, error: "not found" };
  return { ok: true, binding, workspaceId };
}

// ── status-mapping seeding (type→group affinity) ──

// The client-safe view of a status mapping (mirrors the DAL shape; no sensitive fields).
interface StatusMappingView {
  id: string;
  sourceStatusId: string | null;
  sourceStatusName: string;
  taskStateId: string | null;
  skipBackward: boolean;
}

// Seed one status_mappings row per source status, pre-selecting the project's state whose
// GROUP matches the source status's normalized category (the affinity fallback the engine
// also applies at runtime). Idempotent on (project_sync, source_status_name). Returns the
// seeded mappings for the response. Best-effort per row so one bad seed can't abort the set.
async function seedStatusMappings(
  pg: PgSync,
  opts: {
    binding: StoredProjectSync;
    workspaceId: string;
    userId: string;
    sourceStatuses: SourceStatus[];
  },
): Promise<void> {
  const states = await pg.getProjectStates(opts.binding.tasksProjectId);
  for (const source of opts.sourceStatuses) {
    const match = states.find((s) => s.group === source.category);
    await pg
      .upsertStatusMapping({
        workspaceId: opts.workspaceId,
        projectSyncId: opts.binding.id,
        provider: CLICKUP_PROVIDER,
        sourceStatusId: source.id || null,
        sourceStatusName: source.name,
        taskStateId: match?.id ?? null,
        createdBy: opts.userId,
      })
      .catch((err) => {
        console.error("[clickup] status-mapping seed failed", source.name, err);
      });
  }
}

// Project a stored status mapping to the client view.
function toStatusMappingView(m: {
  id: string;
  sourceStatusId: string | null;
  sourceStatusName: string;
  taskStateId: string | null;
  skipBackward: boolean;
}): StatusMappingView {
  return {
    id: m.id,
    sourceStatusId: m.sourceStatusId,
    sourceStatusName: m.sourceStatusName,
    taskStateId: m.taskStateId,
    skipBackward: m.skipBackward,
  };
}

// ── inbound webhook receive helpers ──

// Resolve the decrypted signing secret for an inbound webhook from its `install`/`list`
// query hints. Returns "" (→ verifyWebhook fails → 401) when the install is missing, is not
// a ClickUp install, or has no secret stored for the List — an unverifiable request.
async function inboundWebhookSecret(
  pg: PgSync,
  installId: string,
  listId: string,
): Promise<string> {
  if (!installId || !listId) return "";
  const install = await pg.getIntegrationInstallationById(installId);
  if (!install || install.provider !== CLICKUP_PROVIDER) return "";
  return webhookSecretForList(install.config, listId) ?? "";
}

// ── import: item → event conversion (feeds the engine's create path) ──

// Turn a backfilled work item into the inbound event the engine already knows how to
// create-or-refresh from. externalProjectId is the binding's List id (the item shape omits
// it); every other field maps 1:1. Reusing the engine here means NO duplicated task-create.
function itemToEvent(item: NormalizedTaskItem, externalProjectId: string): NormalizedTaskEvent {
  return { ...item, externalProjectId };
}

// Mounted as a Hono sub-app — the relay does `app.route("/", createClickUpRoutes(...))`
// alongside createSlackOAuthRoutes / createGithubRoutes (the orchestrator owns the mount).
export function createClickUpRoutes(deps: ClickUpRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth } = deps;
  const app = new Hono<RelayEnv>();

  // ── authed: the ClickUp app's config + the ready-to-use authorize URL ──
  // GATED: { configured:false } when the ClickUp OAuth secrets are absent (clickup-app.ts)
  // so the UI shows a "not configured" state. With a workspaceId the authorize URL embeds a
  // SIGNED state {workspaceId, userId} minted here only after an isMember check.
  app.get("/api/clickup/config", requireAuth, async (c) => {
    if (!isClickUpConfigured()) return c.json({ configured: false, authorizeUrl: null });
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ configured: true, authorizeUrl: null });
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const state = signClickUpOAuthState({ workspaceId, userId: c.get("userId") });
    const params = new URLSearchParams({
      client_id: getClickUpOAuthClientId() ?? "",
      redirect_uri: clickUpCallbackUrl(c),
      state,
    });
    return c.json({
      configured: true,
      authorizeUrl: `${CLICKUP_AUTHORIZE_URL}?${params.toString()}`,
    });
  });

  // ── PUBLIC: ClickUp's OAuth callback. ClickUp redirects the BROWSER here (no session)
  //    with code + the signed state. Best-effort: exchange the code, store the install
  //    (token encrypted), then redirect to the ClickUp integration detail page. Never
  //    throws to the browser — a failure still lands the user with a status note. ──
  app.get("/api/clickup/oauth/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = verifyClickUpOAuthState(c.req.query("state") ?? "");
    const base = resolveAppBaseUrl(c);
    if (!state) return c.redirect(`${base || ""}/?clickup=oauth_error`, 302);
    const detail = `${base}/workspace/${encodeURIComponent(state.workspaceId)}/settings/integrations/clickup`;
    if (!code || !isClickUpConfigured() || !pg) {
      return c.redirect(`${detail}?clickup=oauth_error`, 302);
    }
    try {
      if (await exchangeAndStoreClickUpInstall(pg, state, code)) {
        return c.redirect(`${detail}?clickup=connected`, 302);
      }
    } catch (err) {
      // Best-effort: a failed exchange must not 500 the browser. Log + land with a note.
      console.error("[clickup] oauth callback failed", err);
    }
    return c.redirect(`${detail}?clickup=oauth_error`, 302);
  });

  // ── authed: every ClickUp installation this workspace authorized ──
  // Scoped to the caller's workspace (membership-checked). SECURITY: the access_token is
  // STRIPPED and the config's encrypted webhook secrets are NOT projected — neither may
  // leave the relay.
  app.get("/api/clickup/installations", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const rows = await pg.listIntegrationInstallations(workspaceId, CLICKUP_PROVIDER);
    const installations = rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      provider: r.provider,
      externalId: r.externalId,
      // Surface only the display-safe team metadata; never the webhook secrets.
      teamName: asString(r.config.teamName) || null,
      scopes: r.scopes,
      installedBy: r.installedBy,
      createdAt: r.createdAt,
    }));
    return c.json({ installations });
  });

  // ── authed: disconnect an installation from this workspace ──
  // BOLA guard: `workspaceId` is membership-checked AND the install must belong to it (an
  // install id from a foreign workspace is rejected, never deleted). Its project_syncs /
  // status_mappings are the workspace's own; a follow-up unbind removes those.
  app.delete("/api/clickup/installation/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const install = await pg.getIntegrationInstallationById(id);
    if (!install || install.workspaceId !== workspaceId || install.provider !== CLICKUP_PROVIDER) {
      return c.json({ error: "not found" }, 404);
    }
    await pg.deleteIntegrationInstallation(id);
    return c.json({ ok: true });
  });

  // ── authed: bind a Cyborg tasks-project to a ClickUp List, seed status mappings, and
  //    register the inbound webhook ──
  // BOLA: membership on the project's workspace; the install must belong to it; and the
  // supplied List is trusted only as the external key. After the bind we (best-effort) read
  // the List's statuses to seed mappings by group affinity and register a per-List webhook,
  // storing the returned signing secret (encrypted) on the install config.
  app.post("/api/clickup/project-syncs", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = asObject(await c.req.json().catch(() => ({})));
    const idParam = asString(body.tasksProjectId).trim();
    const installationId = asString(body.installationId).trim();
    const externalProjectId = asString(body.externalProjectId).trim();
    const externalProjectName = asString(body.externalProjectName).trim() || null;
    if (!idParam || !installationId || !externalProjectId) {
      return c.json({ error: "tasksProjectId, installationId, externalProjectId required" }, 400);
    }
    const rawDirection = asString(body.syncDirection).trim();
    if (rawDirection && !["inbound", "outbound", "bidirectional"].includes(rawDirection)) {
      return c.json({ error: "invalid syncDirection (inbound|outbound|bidirectional)" }, 400);
    }
    const tasksProjectId = await pg.resolveTasksProjectId(idParam);
    if (!tasksProjectId) return c.json({ error: "project not found" }, 404);
    const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
    if (!workspaceId) return c.json({ error: "project not found" }, 404);
    const userId = c.get("userId");
    if (!(await pg.isMember(workspaceId, userId))) return c.json({ error: "not a member" }, 403);
    // BOLA / tenant-integrity: the install must be one THIS workspace authorized — never a
    // foreign install fanning another tenant's webhooks into this project.
    const install = await pg.getIntegrationInstallationById(installationId);
    if (!install || install.workspaceId !== workspaceId || install.provider !== CLICKUP_PROVIDER) {
      return c.json({ error: "installation not found" }, 404);
    }

    const bindingId = await pg.upsertProjectSync({
      workspaceId,
      provider: CLICKUP_PROVIDER,
      installationId,
      tasksProjectId,
      externalProjectId,
      externalProjectName,
      syncDirection: rawDirection || undefined,
      createdBy: userId,
    });
    const binding: StoredProjectSync = {
      id: bindingId,
      workspaceId,
      provider: CLICKUP_PROVIDER,
      installationId,
      tasksProjectId,
      externalProjectId,
      externalProjectName,
      externalUrl: null,
      syncDirection: rawDirection || "inbound",
      createdBy: userId,
      createdAt: Date.now(),
    };

    // Best-effort enrichment (a failure never fails the bind — the binding is the primary
    // outcome). Seed mappings from the List's statuses, then register the inbound webhook.
    const token = installToken(install);
    await seedFromStatuses(pg, binding, workspaceId, userId, token, externalProjectId);
    const webhookRegistered = await ensureWebhook(c, pg, install, token, externalProjectId);
    const mappings = (await pg.listStatusMappings(bindingId)).map(toStatusMappingView);
    return c.json({ binding: toBindingView(binding), mappings, webhookRegistered });
  });

  // ── authed: every ClickUp binding for a Cyborg tasks-project ──
  app.get("/api/clickup/project-syncs", requireAuth, async (c) => {
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
    const syncs = (await pg.getProjectSyncsForTasksProject(tasksProjectId))
      .filter((s) => s.provider === CLICKUP_PROVIDER)
      .map(toBindingView);
    return c.json({ syncs });
  });

  // ── authed: unbind a ClickUp binding (BOLA) ──
  // deleteProjectSync is scoped by (id, workspaceId), so a wrong-workspace id is a no-op;
  // we still membership-check the workspace first.
  app.delete("/api/clickup/project-sync/:id", requireAuth, async (c) => {
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

  // ── authed: the source-status catalog + current mappings for a binding ──
  // Requires tasksProjectId to resolve the binding (no getProjectSyncById); the live List
  // statuses come from ClickUp via the install token (best-effort — [] on a provider error).
  app.get("/api/clickup/project-syncs/:id/statuses", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const resolved = await resolveBinding(
      pg,
      c.req.query("tasksProjectId") ?? "",
      c.req.param("id"),
      c.get("userId"),
    );
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { binding } = resolved;
    const install = binding.installationId
      ? await pg.getIntegrationInstallationById(binding.installationId)
      : null;
    const token = install ? installToken(install) : null;
    const statuses = await listStatusesSafe(token, binding.externalProjectId);
    const mappings = (await pg.listStatusMappings(binding.id)).map(toStatusMappingView);
    return c.json({ statuses, mappings });
  });

  // ── authed: save the source-status → task-state mappings for a binding ──
  // Body: { tasksProjectId, mappings: [{ sourceStatusName, sourceStatusId?, taskStateId,
  // skipBackward? }] }. Each chosen taskStateId (when set) must belong to the binding's OWN
  // project — a cross-project state is rejected.
  app.put("/api/clickup/project-syncs/:id/status-mappings", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = asObject(await c.req.json().catch(() => ({})));
    const resolved = await resolveBinding(
      pg,
      asString(body.tasksProjectId).trim(),
      c.req.param("id"),
      c.get("userId"),
    );
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { binding, workspaceId } = resolved;
    const rows = Array.isArray(body.mappings) ? body.mappings : [];
    for (const raw of rows) {
      const row = asObject(raw);
      const sourceStatusName = asString(row.sourceStatusName).trim();
      if (!sourceStatusName) return c.json({ error: "sourceStatusName required" }, 400);
      const taskStateId = optStateId(row.taskStateId);
      if (taskStateId && !(await pg.stateBelongsToProject(taskStateId, binding.tasksProjectId))) {
        return c.json({ error: "state does not belong to project" }, 400);
      }
      await pg.upsertStatusMapping({
        workspaceId,
        projectSyncId: binding.id,
        provider: CLICKUP_PROVIDER,
        sourceStatusId: optStateId(row.sourceStatusId),
        sourceStatusName,
        taskStateId,
        skipBackward: row.skipBackward === true,
        createdBy: c.get("userId"),
      });
    }
    const mappings = (await pg.listStatusMappings(binding.id)).map(toStatusMappingView);
    return c.json({ mappings });
  });

  // ── authed: backfill a List's tasks into the bound project ──
  // Pages the List (100/page) through the committed adapter, converts each item to the
  // inbound event the ENGINE already creates-or-refreshes from (no duplicated task-create),
  // and dispatches per page. Bounded by MAX_IMPORT_PAGES; a 429 rate-limit stall (the
  // adapter returns the same cursor) breaks the loop so the request can't spin.
  app.post("/api/clickup/project-syncs/:id/import", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const resolved = await resolveBinding(
      pg,
      c.req.query("tasksProjectId") ?? "",
      c.req.param("id"),
      c.get("userId"),
    );
    if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
    const { binding } = resolved;
    const install = binding.installationId
      ? await pg.getIntegrationInstallationById(binding.installationId)
      : null;
    const token = install ? installToken(install) : null;
    if (!token) return c.json({ error: "installation token unavailable" }, 400);

    let imported = 0;
    let pages = 0;
    let rateLimited = false;
    let cursor: string | undefined;
    try {
      while (pages < MAX_IMPORT_PAGES) {
        const requested = cursor;
        const page = await clickUpAdapter.importItems(token, binding.externalProjectId, cursor);
        pages += 1;
        if (page.items.length > 0) {
          const events = page.items.map((item) => itemToEvent(item, binding.externalProjectId));
          await dispatchInboundTaskEvents(pg, clickUpAdapter, events);
          imported += page.items.length;
        }
        // No cursor → last page. Same cursor back with no items → a 429 stall (the adapter
        // resends the same page on rate-limit) → stop rather than spin.
        if (page.nextCursor === undefined) break;
        if (page.nextCursor === requested) {
          rateLimited = true;
          break;
        }
        cursor = page.nextCursor;
      }
    } catch (err) {
      console.error("[clickup] import failed", err);
      return c.json({ error: "import failed", imported, pages }, 502);
    }
    return c.json({ imported, pages, rateLimited });
  });

  // ── PUBLIC: ClickUp's inbound webhook. ClickUp POSTs task events here signed with the
  //    per-webhook secret (hex HMAC-SHA256 of the RAW body in X-Signature). Read the raw
  //    body FIRST, resolve the secret from the `install`/`list` query hints, verify, then
  //    parse + dispatch. Best-effort: 401 only on a bad signature; otherwise always 200 so
  //    an internal error never makes ClickUp retry-storm. ──
  app.post("/api/clickup/webhook", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const rawBody = await c.req.text().catch(() => "");
    const installId = c.req.query("install") ?? "";
    const listId = c.req.query("list") ?? "";
    const secret = await inboundWebhookSecret(pg, installId, listId);
    const headers = { "x-signature": c.req.header("x-signature") };
    if (!clickUpAdapter.verifyWebhook(rawBody, headers, secret)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    try {
      const payload = asObject(safeJsonParse(rawBody));
      // The raw ClickUp webhook body may not echo the List id; inject the one from the
      // registration hint so parseInbound stamps externalProjectId (the binding key).
      payload.list_id = payload.list_id ?? listId;
      const events = clickUpAdapter.parseInbound(payload);
      await dispatchInboundTaskEvents(pg, clickUpAdapter, events);
    } catch (err) {
      // Best-effort: a parse/dispatch failure must not retry-storm ClickUp. Log + 200-ack.
      console.error("[clickup] error processing webhook", err);
    }
    return c.json({ ok: true });
  });

  return app;
}

// ── small handler helpers (kept out of the closures for the complexity budget) ──

// Seed status mappings from the List's live statuses; best-effort (a provider/token error
// leaves the binding with no seeded mappings — the engine still resolves state by category
// affinity at runtime, and the user can map manually).
async function seedFromStatuses(
  pg: PgSync,
  binding: StoredProjectSync,
  workspaceId: string,
  userId: string,
  token: string | null,
  externalProjectId: string,
): Promise<void> {
  if (!token) return;
  const sourceStatuses = await listStatusesSafe(token, externalProjectId);
  if (sourceStatuses.length === 0) return;
  await seedStatusMappings(pg, { binding, workspaceId, userId, sourceStatuses });
}

// Register the inbound webhook for a List unless one is already stored for it (idempotent).
// Persists the returned signing secret (encrypted) on the install config. Returns whether a
// webhook is now in place. Best-effort — a registration failure just leaves inbound unwired.
async function ensureWebhook(
  c: Context<RelayEnv>,
  pg: PgSync,
  install: StoredIntegrationInstallation,
  token: string | null,
  listId: string,
): Promise<boolean> {
  if (!token) return false;
  if (webhookSecretForList(install.config, listId)) return true; // already registered.
  const reg = await registerClickUpWebhook({
    token,
    teamId: install.externalId,
    endpoint: webhookEndpointUrl(c, install.id, listId),
    listId,
  });
  if (!reg) return false;
  await persistInstallConfig(pg, install, withWebhookRecord(install.config, listId, reg));
  return true;
}

// The List's selectable statuses, or [] on any provider/token error (listStatuses throws).
async function listStatusesSafe(
  token: string | null,
  externalProjectId: string,
): Promise<SourceStatus[]> {
  if (!token) return [];
  try {
    return await clickUpAdapter.listStatuses(token, externalProjectId);
  } catch (err) {
    console.error("[clickup] listStatuses failed", err);
    return [];
  }
}

// Parse a raw webhook body, tolerating a non-JSON body (→ {} downstream).
function safeJsonParse(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// The client-safe binding view (parity with StoredProjectSync minus nothing sensitive).
function toBindingView(b: StoredProjectSync): {
  id: string;
  workspaceId: string;
  provider: string;
  installationId: string | null;
  tasksProjectId: string;
  externalProjectId: string;
  externalProjectName: string | null;
  syncDirection: string;
  createdAt: number;
} {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    provider: b.provider,
    installationId: b.installationId,
    tasksProjectId: b.tasksProjectId,
    externalProjectId: b.externalProjectId,
    externalProjectName: b.externalProjectName,
    syncDirection: b.syncDirection,
    createdAt: b.createdAt,
  };
}

import { Hono, type Context } from "hono";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { PgSync, StoredGithubRepoSync } from "../db/pg-sync.js";
import type { RelayEnv, RequireAuth } from "./types.js";
import {
  mapIssueToTask,
  mapComment,
  resolveIssueTargetState,
  type MappedIssue,
} from "../github-issue-mapper.js";
import { handlePullRequest } from "../github-pr-mapper.js";
import { markInbound } from "../github-outbound.js";
import {
  isGithubAppConfigured,
  getGithubAppSlug,
  githubAppInstallUrl,
  listInstallationRepos,
  getInstallationAccount,
  isGithubOAuthConfigured,
  getGithubOAuthClientId,
  getGithubOAuthClientSecret,
} from "../github-app.js";

// GitHub App → Tasks one-way issue sync (GH issues → Cyborg7 tasks).
//
// Two surfaces, mirroring stripe.ts + webhooks.ts:
//   1. POST /api/github/webhook — PUBLIC (no requireAuth). GitHub authenticates via
//      the X-Hub-Signature-256 HMAC over the EXACT raw body (read c.req.text()
//      BEFORE any parse — same raw-body discipline as the Stripe + channel-webhook
//      receivers). Dispatches on X-GitHub-Event: `issues`, `issue_comment`,
//      `label`, `installation`, `installation_repositories`.
//   2. The authed binding callbacks (requireAuth) the Tasks settings panel calls:
//      GET  /api/github/repo-syncs?tasksProjectId= — current bindings for a project.
//      POST /api/github/repo-sync — bind a repo to a project (bindRepoSync RPC).
//      DELETE /api/github/repo-sync/:id — unbind.
//
// GitHub is the source of truth; nothing here writes back to GitHub in this phase.

export interface GithubRoutesDeps {
  pg: PgSync | null;
  requireAuth: RequireAuth;
}

// ── permissive payload extraction (untrusted JSON; validate at the edges) ──

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// Coerce an already-parsed JSON value to a plain object — {} for a null/array/primitive
// body — so an untrusted request payload can be indexed (and `in`-probed) without
// throwing a TypeError that would 500 the request. The fallback lives here (not at each
// call site) so the handlers stay branch-free for the complexity budget.
function asObject(v: unknown): Record<string, unknown> {
  return obj(v) ?? {};
}

// A trimmed state-id string, or null for "" / a missing/non-string value (an
// explicit JSON null clears the override). Used by the bind/patch state-map fields.
function optStateId(v: unknown): string | null {
  const s = asString(v).trim();
  return s || null;
}

// HTML-escape a GitHub-controlled string before it's interpolated into a
// commentHtml/HTML string. task_activity.comment_html is markdown-rendered in the
// UI (TaskActivityFeed → MessageRenderer), so a raw `<…>`/quote from an attacker's
// issue body, comment, repo name, or login could otherwise inject markup. Ampersand
// FIRST so an already-escaped entity isn't double-escaped wrongly, then the angle
// brackets + quotes a renderer could interpret as markup/attributes.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Best-effort parse of the raw body to an object (GitHub always sends JSON).
function parseBody(rawBody: string): Record<string, unknown> {
  if (!rawBody) return {};
  try {
    const v = JSON.parse(rawBody);
    return obj(v) ?? {};
  } catch {
    return {};
  }
}

// Constant-time compare of `X-Hub-Signature-256` against HMAC-SHA256(rawBody,
// secret). Identical logic to webhooks.ts:verifySignature (GitHub sends
// `sha256=<hex>`); the timingSafeEqual call is length-guarded to avoid a throw.
function verifySignature(rawBody: string, secret: string, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// The installation id from any App-delivered payload (`installation.id`), as text.
function installationIdOf(payload: Record<string, unknown>): string | null {
  const id = num(obj(payload.installation)?.id);
  return id !== null ? String(id) : null;
}

// The repo identity from an `issues`/`issue_comment`/`label` payload.
interface RepoRef {
  repoId: string;
  owner: string;
  name: string;
  repoUrl: string;
}
function repoRefOf(payload: Record<string, unknown>): RepoRef | null {
  const repo = obj(payload.repository);
  if (!repo) return null;
  const id = num(repo.id);
  if (id === null) return null;
  const owner = asString(obj(repo.owner)?.login).trim();
  const name = asString(repo.name).trim();
  if (!owner || !name) return null;
  return {
    repoId: String(id),
    owner,
    name,
    repoUrl: asString(repo.html_url).trim() || `https://github.com/${owner}/${name}`,
  };
}

// The valid sync directions for a repo binding. 'inbound' = GH→Tasks one-way (the
// 0034 behavior); 'bidirectional' = GH↔Tasks write-back (wave 2).
const SYNC_DIRECTIONS = new Set(["inbound", "bidirectional"]);

// The 6 GitHub PR states the PR-state mapping editor maps (Image #3). The exact
// tokens Plane's integration uses (see plane en/integration.json).
const PR_STATES = new Set([
  "DRAFT_MR_OPENED",
  "MR_OPENED",
  "MR_READY_FOR_MERGE",
  "MR_REVIEW_REQUESTED",
  "MR_MERGED",
  "MR_CLOSED",
]);

// The origin the relay is reached at, derived from the request. Behind the deploy's
// reverse proxy the real host/scheme arrive in X-Forwarded-Host / X-Forwarded-Proto;
// fall back to Host + https. Returns "" when no host header is present (→ a relative
// redirect). Used to build the OAuth redirect_uri (must point back at THIS relay).
function requestOrigin(c: Context<RelayEnv>): string {
  const fwdHost = c.req.header("x-forwarded-host");
  const host = (fwdHost || c.req.header("host") || "").split(",")[0]?.trim() ?? "";
  if (!host) return "";
  const fwdProto = c.req.header("x-forwarded-proto");
  const proto = (fwdProto || "https").split(",")[0]?.trim() ?? "https";
  return `${proto}://${host}`;
}

// The base URL the post-install/OAuth callbacks redirect the BROWSER to (the app
// origin). SECURITY (open-redirect hardening): the /api/github/callback and
// /api/github/oauth/callback endpoints are PUBLIC (no session), and requestOrigin()
// trusts the attacker-influenceable X-Forwarded-Host / Host headers. So when
// CYBORG_APP_URL is set we ALWAYS use it and NEVER the request-derived host — otherwise
// a crafted Host/X-Forwarded-Host could make these callbacks 302 a victim to an
// attacker-controlled origin. We fall back to the request origin ONLY when
// CYBORG_APP_URL is unset (local dev, where the relay also serves the UI so its own
// origin is a valid landing spot). PROD MUST set CYBORG_APP_URL.
function resolveAppBaseUrl(c: Context<RelayEnv>): string {
  const configured = process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  if (configured) return configured; // trusted operator-set origin — never the request host.
  return requestOrigin(c); // dev-only fallback (CYBORG_APP_URL unset).
}

// The OAuth `redirect_uri` GitHub calls back to. OAuth REQUIRES this value to be
// byte-identical at authorize-time (oauth/start) and at token-exchange-time
// (oauth/callback), and to match the OAuth App's registered callback URL. The two
// requests are SEPARATE (start is an authed app call; callback is GitHub's browser
// redirect), so their Host headers can differ — and the Host/X-Forwarded-Host is
// attacker-influenceable behind a proxy. We therefore resolve a STABLE configured
// base, never the request host: prefer GITHUB_OAUTH_CALLBACK_BASE (set this when the
// relay's public API origin differs from the UI origin), else CYBORG_APP_URL (the
// relay-standalone gateway serves /api/github/oauth/callback at the SAME origin it
// serves the UI, so the app URL is the relay's callback origin in the cloud deploy),
// else fall back to the request origin ONLY in dev (no stable base set). Both call
// sites use THIS one helper so the redirect_uri always matches. PROD MUST set one of
// GITHUB_OAUTH_CALLBACK_BASE or CYBORG_APP_URL.
function oauthCallbackUrl(c: Context<RelayEnv>): string {
  const configured =
    process.env.GITHUB_OAUTH_CALLBACK_BASE?.replace(/\/$/, "") ||
    process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  const base = configured || requestOrigin(c); // dev-only fallback (no stable base set).
  return `${base}/api/github/oauth/callback`;
}

// Sign an OAuth `state` so the PUBLIC callback can trust the (workspaceId, userId,
// returnTo) it carries without a session. `<base64url(json)>.<hmac>` keyed on the
// OAuth client secret (always present when OAuth is configured). The callback
// re-derives + constant-time compares the HMAC before acting on the payload.
interface OAuthState {
  workspaceId: string;
  userId: string;
  returnTo: string;
}
function signOAuthState(payload: OAuthState): string {
  const secret = getGithubOAuthClientSecret() ?? "";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function verifyOAuthState(state: string): OAuthState | null {
  const secret = getGithubOAuthClientSecret() ?? "";
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
    ) as Partial<OAuthState>;
    if (typeof parsed.workspaceId !== "string" || typeof parsed.userId !== "string") return null;
    return {
      workspaceId: parsed.workspaceId,
      userId: parsed.userId,
      returnTo: typeof parsed.returnTo === "string" ? parsed.returnTo : "",
    };
  } catch {
    return null;
  }
}

// ── per-event handlers (each best-effort; the receiver always 2xx-acks) ──

// OUTBOUND write-back (wave-2a) lives in github-outbound.ts and fires from the task
// mutation path (relay-standalone's cyborg:update_task / bulk_update_tasks), NOT from
// here — the two directions are deliberately separate code paths. This INBOUND
// handler only MARKS the echo guard (markInbound) so that the task mutation it makes
// below is recognized as GitHub-originated and never re-emitted back to GitHub.
//
// `issues`: opened/reopened → create-or-refresh a task in the bound project (in its
// configured/default open state); closed → move the linked task to the configured/
// completed state; edited → refresh title/description. The open/closed target state
// honors the binding's issue_open_state_id/issue_closed_state_id overrides (Image #4
// "Configure Issue Sync State") when set, else the project default. Stores the
// issue↔task back-link.
async function handleIssues(
  pg: PgSync,
  repoSync: StoredGithubRepoSync,
  payload: Record<string, unknown>,
): Promise<void> {
  const mapped = mapIssueToTask(payload);
  if (!mapped) return; // an action/shape we don't act on.

  const existing = await pg.getTaskByIssue(repoSync.id, mapped.number);
  const states = await pg.getGithubSyncStates(repoSync.tasksProjectId);
  // The configured per-binding override wins over the project default (the 0034
  // behavior is the fallback). A null result (project with no states) leaves the
  // task's state untouched on update.
  const targetStateId = resolveIssueTargetState(mapped.state, {
    overrideOpenStateId: repoSync.issueOpenStateId,
    overrideClosedStateId: repoSync.issueClosedStateId,
    fallbackOpenStateId: states.openStateId,
    fallbackClosedStateId: states.closedStateId,
  });

  if (!existing) {
    // First time we've seen this issue → create a task in the bound project.
    const taskId = `task_${randomUUID()}`;
    await pg.createTask({
      id: taskId,
      workspaceId: repoSync.workspaceId,
      title: mapped.title,
      description: mapped.body ?? undefined,
      createdBy: repoSync.createdBy,
      projectId: repoSync.tasksProjectId,
      stateId: targetStateId,
      labelNames: mapped.labels.length > 0 ? mapped.labels : undefined,
    });
    await pg.upsertIssueSync({
      id: `ghis_${randomUUID()}`,
      repoSyncId: repoSync.id,
      taskId,
      issueNumber: mapped.number,
      githubIssueId: mapped.githubIssueId,
      issueUrl: mapped.url,
    });
    await recordIssueActivity(pg, repoSync, taskId, mapped, "created");
    return;
  }

  // The issue already maps to a task → refresh its fields + state.
  await pg.updateTask(existing.taskId, {
    title: mapped.title,
    description: mapped.body ?? undefined,
    ...(targetStateId ? { stateId: targetStateId } : {}),
  });
  // Echo guard: this task change ORIGINATED from GitHub, so mark it so the outbound
  // write-back (github-outbound.ts), if it ever observes this same change, suppresses
  // re-emitting it back to GitHub (prevents an A→B→A loop). Mark ONLY the field(s) this
  // event actually moved — NOT every field unconditionally. A blanket mark would let an
  // inbound event for one field (e.g. a state-only close) suppress a genuine, unrelated
  // human/agent edit of a DIFFERENT field (e.g. a title rename) on the same task within
  // the echo TTL, silently dropping it and leaving GitHub permanently diverged. A state
  // transition arrives as the `closed`/`reopened` action; a title/body edit arrives as
  // an `edited` action whose `changes` object names the field(s) that moved.
  if (mapped.action === "closed") markInbound(existing.taskId, "close");
  else if (mapped.action === "reopened") markInbound(existing.taskId, "reopen");
  if (mapped.action === "edited") {
    const changes = obj(payload.changes);
    if (changes?.title) markInbound(existing.taskId, "title");
    if (changes?.body) markInbound(existing.taskId, "body");
  }
  // Keep the back-link's number/url current (e.g. a transfer renumbers the issue).
  await pg.upsertIssueSync({
    id: `ghis_${randomUUID()}`,
    repoSyncId: repoSync.id,
    taskId: existing.taskId,
    issueNumber: mapped.number,
    githubIssueId: mapped.githubIssueId,
    issueUrl: mapped.url,
  });
  await recordIssueActivity(pg, repoSync, existing.taskId, mapped, "updated");
}

// Append a task_activity row describing the GitHub-driven change. Best-effort: a
// feed-write failure must never fail the sync (parity with recordTaskActivity's
// contract), so callers don't await its success path strictly.
async function recordIssueActivity(
  pg: PgSync,
  repoSync: StoredGithubRepoSync,
  taskId: string,
  mapped: MappedIssue,
  verb: "created" | "updated",
): Promise<void> {
  // Escape every GitHub-controlled field before it lands in the HTML feed string.
  const who = mapped.authorLogin ? `@${escapeHtml(mapped.authorLogin)}` : "GitHub";
  const action = escapeHtml(mapped.state === "closed" ? "closed" : mapped.action);
  const repo = `${escapeHtml(repoSync.owner)}/${escapeHtml(repoSync.name)}`;
  await pg
    .recordTaskActivity({
      taskId,
      workspaceId: repoSync.workspaceId,
      actorId: null, // system-generated (a GitHub user has no Cyborg7 user id).
      verb,
      commentHtml: `${who} ${action} GitHub issue #${mapped.number} (${repo})`,
    })
    .catch(() => {}); // intentional: best-effort task_activity feed row for a synced issue; a feed-write failure must not fail the issue sync (parity with recordTaskActivity's contract).
}

// `issue_comment`: append a task_activity comment row to the linked task.
async function handleIssueComment(
  pg: PgSync,
  repoSync: StoredGithubRepoSync,
  payload: Record<string, unknown>,
): Promise<void> {
  const mapped = mapComment(payload);
  if (!mapped) return;
  const existing = await pg.getTaskByIssue(repoSync.id, mapped.issueNumber);
  if (!existing) return; // a comment on an issue we never synced — nothing to attach.
  // HTML-escape the GitHub-controlled author + comment body before building the
  // markdown-rendered feed string — raw `<…>`/quotes would otherwise be stored XSS.
  const who = mapped.authorLogin ? `@${escapeHtml(mapped.authorLogin)}` : "GitHub";
  const escapedBody = escapeHtml(mapped.body ?? "");
  await pg
    .recordTaskActivity({
      taskId: existing.taskId,
      workspaceId: repoSync.workspaceId,
      actorId: null,
      verb: "updated",
      commentHtml: `${who} commented: ${escapedBody}`,
    })
    .catch(() => {}); // intentional: best-effort task_activity comment row mirroring a GitHub issue_comment; a feed-write failure must not 500 the webhook ack (else GitHub redelivers).
}

// `label`: a repo label was created/edited/deleted on GitHub. We don't reconcile a
// project's whole label catalog from this (labels land per-issue via handleIssues);
// the event is acked so GitHub keeps the delivery green. Reserved for a future
// catalog-reconcile pass (rename/recolor); intentionally a no-op for now.
function handleLabel(): void {
  // no-op (see comment) — labels are synced per-issue, not from the repo catalog.
}

// `installation` (created/deleted) — upsert/destroy the install row. The repo
// bindings are created later via the authed bind callback, not from this event.
async function handleInstallation(pg: PgSync, payload: Record<string, unknown>): Promise<void> {
  const action = asString(payload.action).trim().toLowerCase();
  const install = obj(payload.installation);
  const installationId = installationIdOf(payload);
  if (!installationId) return;

  if (action === "deleted") {
    await pg.deleteGithubInstallation(installationId);
    return;
  }
  // created (or the catch-all upsert for new_permissions_accepted etc.).
  const account = obj(install?.account);
  const login = asString(account?.login).trim();
  const accountType = asString(account?.type).trim() || "User";
  const senderId = asString(obj(payload.sender)?.login).trim() || login;
  if (!login) return;
  // The workspace is bound when the user completes the OAuth/bind callback (not known
  // from the raw webhook). A webhook-only upsert can't attribute a workspace, so the
  // receiver only REFRESHES installs it can already resolve to one; a brand-new
  // install with no prior row + no workspace context is skipped here (an upsert with
  // workspaceId "" would only violate the FK and be swallowed) and recorded by the
  // authed callback instead. We still update an EXISTING install's account metadata.
  const workspaceId = (await firstInstallWorkspace(pg, installationId)) ?? "";
  if (workspaceId) {
    await pg
      .upsertGithubInstallation({
        id: `ghin_${randomUUID()}`,
        workspaceId,
        installationId,
        accountLogin: login,
        accountType,
        createdBy: senderId,
      })
      .catch(() => {}); // intentional: best-effort metadata refresh of a KNOWN install; a transient write failure must not 500 the webhook ack (else GitHub redelivers) — the row already exists with its real workspace.
  }
}

// The workspace a known install already belongs to (null for a brand-new install).
async function firstInstallWorkspace(pg: PgSync, installationId: string): Promise<string | null> {
  // The install row, if any, carries the workspace recorded by the authed callback.
  // We read it back so a webhook refresh doesn't blank the workspace binding.
  return pg.getInstallationWorkspace(installationId);
}

// `installation_repositories` (added/removed) — when a repo the App can access is
// removed, drop any binding to it. We DON'T auto-create bindings on "added": a repo
// is bound to a project explicitly via the authed callback, not implicitly.
async function handleInstallationRepositories(
  pg: PgSync,
  payload: Record<string, unknown>,
): Promise<void> {
  const installationId = installationIdOf(payload);
  if (!installationId) return;
  const removed = Array.isArray(payload.repositories_removed) ? payload.repositories_removed : [];
  for (const r of removed) {
    const repoId = num(obj(r)?.id);
    if (repoId === null) continue;
    const binding = await pg.getRepoSync(installationId, String(repoId));
    if (binding) await pg.unbindRepoSync(binding.id);
  }
}

// Is `userId` allowed to act on `workspaceId`? A thin, exported, unit-testable
// wrapper over the membership check the other authed callbacks use inline
// (`pg.isMember`). Centralizing it keeps the BOLA guard on the repo-list route
// identical to the bind/unbind/list guards and lets a test pin both branches.
export function validateWorkspaceAccess(
  pg: PgSync,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  return pg.isMember(workspaceId, userId);
}

// Inbound GitHub App webhook + the authed bind callbacks. Mounted as a Hono
// sub-app — see `app.route("/", createGithubRoutes(...))` in relay-standalone.ts.
export function createGithubRoutes(deps: GithubRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth } = deps;
  const app = new Hono<RelayEnv>();

  // ── PUBLIC webhook receiver ──
  app.post("/api/github/webhook", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);

    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) {
      // The App isn't wired (no signing secret) — 503 so a misconfigured deploy is
      // visible, rather than silently accepting unauthenticated posts.
      console.error("[github] webhook not configured (missing GITHUB_APP_WEBHOOK_SECRET)");
      return c.json({ error: "github webhook not configured" }, 503);
    }

    // RAW body first — the HMAC must be computed over the EXACT bytes GitHub signed.
    const rawBody = await c.req.text().catch(() => "");
    if (!verifySignature(rawBody, secret, c.req.header("x-hub-signature-256"))) {
      return c.json({ error: "invalid signature" }, 401);
    }

    const payload = parseBody(rawBody);
    const event = (c.req.header("x-github-event") ?? "").trim().toLowerCase();

    // `ping` is GitHub's one-time setup handshake — ack without work.
    if (event === "ping") return c.json({ ok: true });

    try {
      await dispatchEvent(pg, event, payload);
    } catch (err) {
      // Best-effort: a handler failure must not retry-storm GitHub. Log + 2xx-ack.
      console.error("[github] error processing event", event, err);
    }
    return c.json({ ok: true });
  });

  // ── PUBLIC post-install landing (UX-only) ──
  // GitHub's App "Setup URL" / OAuth-during-install Callback URL redirects the
  // browser HERE after the user installs the App (unauthenticated — GitHub does not
  // carry our session). This route is UX-only: it never trusts the query for a
  // security-sensitive write. The authoritative install record comes from the SIGNED
  // `installation` webhook (handleInstallation above); here we just land the user
  // back in the app gracefully so the Setup/Callback URL never 404s.
  app.get("/api/github/callback", (c) => {
    // GitHub-supplied params: installation_id + setup_action accompany an App install;
    // `state` is the workspace id we set on the install URL (githubAppInstallUrl) and
    // GitHub echoes back. We do NOT trust `state` for any security-sensitive write —
    // the authoritative install record still comes from the SIGNED `installation`
    // webhook; here it only chooses WHICH workspace's detail page to land on.
    const installationId = c.req.query("installation_id") ?? "";
    const setupAction = c.req.query("setup_action") ?? "";
    const state = c.req.query("state") ?? "";
    const hasOauth = !!c.req.query("code");
    const base = resolveAppBaseUrl(c);
    let note = "github";
    if (installationId) note = "installed";
    else if (hasOauth) note = "connected";

    // With a workspace id (the common path), land on that workspace's integration
    // DETAIL page so the user sees the freshly-connected org. Without one, fall back
    // to the app root with a status note (a local/unconfigured relay still lands).
    let target: string;
    if (state) {
      const params = new URLSearchParams({ github: note });
      if (installationId) params.set("installation_id", installationId);
      target = `${base}/workspace/${encodeURIComponent(state)}/settings/integrations?${params.toString()}`;
    } else {
      target = `${base || ""}/?github=${note === "github" ? "github" : `github_${note}`}`;
    }
    console.log(
      `[github] post-install callback: installation_id=${installationId || "-"} ` +
        `setup_action=${setupAction || "-"} state=${state || "-"} oauth=${hasOauth} → ${target}`,
    );
    return c.redirect(target, 302);
  });

  // ── authed: the GitHub App's public config (drives the UI Connect button) ──
  // Surfaces the App's public slug so the UI can render the "Connect GitHub" button
  // and build its install link (github.com/apps/<slug>/installations/new). The slug
  // is PUBLIC (it lives in the install URL on github.com), so this leaks nothing
  // sensitive; it sits behind requireAuth only to match the sibling github GET
  // callbacks. `configured:false` (slug unset) → the UI shows the "App not
  // configured yet" hint and disables the button. No `pg` needed.
  app.get("/api/github/config", requireAuth, (c) => {
    const slug = getGithubAppSlug();
    // Build the install URL server-side so the `state=<workspaceId>` param is carried
    // consistently (the callback reads it to land on the right detail page). The UI
    // passes its current workspace id; with none, the URL omits state.
    const workspaceId = c.req.query("workspaceId") ?? undefined;
    const installUrl = githubAppInstallUrl(workspaceId);
    return c.json({ configured: slug !== null, slug, installUrl });
  });

  // ── authed: every GitHub App installation this workspace authorized ──
  // Drives the account/org picker in the bind modal and the detail page's
  // connected-org row(s). Scoped to the caller's workspace (membership-checked).
  app.get("/api/github/installations", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const installations = await pg.listGithubInstallationsForWorkspace(workspaceId);
    return c.json({ installations });
  });

  // ── authed: CLAIM a freshly-installed App for this workspace ──
  // The post-install GitHub redirect is UNAUTHENTICATED (no session), so it cannot do a
  // trusted write — and the SIGNED `installation` webhook carries the account but no
  // workspace. Without a trusted writer the github_installations row was NEVER created
  // from the install flow, so fetchGithubInstallations returned [] forever: the connected
  // state (Configure / Link Repository) was unreachable. This authed callback closes that
  // gap. The browser lands on the integrations card with ?github=installed&installation_id
  // and the (authenticated) page calls this to record the row. SECURITY: (1) membership-
  // checked on the workspace; (2) NO-REASSIGN — an installation already owned by another
  // workspace is rejected, never stolen; (3) a NEW claim is VERIFIED against GitHub (App
  // JWT) so a guessed/foreign installation id (ids are low-entropy sequential ints) can't
  // mint a bogus row, and the real account login is recorded for display.
  app.post("/api/github/installations/confirm", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    // Untrusted body: coerce to a plain object so a `null`, array, or primitive
    // JSON payload can't crash property access / the `in` operator below (→ 500).
    const body = asObject(await c.req.json().catch(() => ({})));
    const workspaceId = asString(body.workspaceId).trim();
    const installationId = asString(body.installationId).trim();
    if (!workspaceId || !installationId) {
      return c.json({ error: "workspaceId, installationId required" }, 400);
    }
    const userId = c.get("userId");
    if (!(await pg.isMember(workspaceId, userId))) return c.json({ error: "not a member" }, 403);

    // No-reassign: an already-claimed installation may only be re-confirmed by the SAME
    // workspace; a different workspace's attempt is rejected (never reassigned).
    const existing = await pg.getInstallationWorkspace(installationId);
    if (existing) {
      if (existing === workspaceId) return c.json({ ok: true });
      return c.json({ error: "installation already linked to another workspace" }, 409);
    }

    // First claim — verify the installation is REAL via the App JWT (and learn its
    // account login) before recording it. With the App unconfigured we can't verify, so
    // we record nothing and report it (the feature can't function without the App anyway).
    if (!isGithubAppConfigured()) return c.json({ configured: false });
    const account = await getInstallationAccount(installationId);
    if (!account) return c.json({ error: "installation not found" }, 404);
    const ownerWorkspace = await pg.claimGithubInstallation({
      id: `ghin_${randomUUID()}`,
      workspaceId,
      installationId,
      accountLogin: account.login,
      accountType: account.type,
      createdBy: userId,
    });
    // A concurrent claim by another workspace may have won the insert race — honor it.
    if (ownerWorkspace !== workspaceId) {
      return c.json({ error: "installation already linked to another workspace" }, 409);
    }
    return c.json({ ok: true });
  });

  // ── authed: disconnect an installation from this workspace ──
  // Drops the install row + its repo bindings (and, via cascade, their issue/PR-sync
  // rows) for THIS workspace only. `workspaceId` is a query param (membership-checked).
  // TODO(wave2 ops): also revoke the install on GitHub (DELETE /app/installations/:id
  // with an App JWT) — left to ops so a DB disconnect never depends on a live App.
  app.delete("/api/github/installation/:installationId", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const installationId = c.req.param("installationId");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    await pg.deleteGithubInstallationForWorkspace(workspaceId, installationId);
    return c.json({ ok: true });
  });

  // ── authed: current bindings for a Tasks-project ──
  // `tasksProjectId` may be the tasks_projects.id OR the chat project id (the UI
  // routes off the chat id) — resolveTasksProjectId accepts either.
  app.get("/api/github/repo-syncs", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const idParam = c.req.query("tasksProjectId");
    const wsParam = c.req.query("workspaceId");
    // Workspace-wide form (detail page "Project Issue Sync" list): every binding
    // across all projects in the workspace. Takes precedence is per-project unless
    // tasksProjectId is given.
    if (!idParam && wsParam) {
      if (!(await pg.isMember(wsParam, c.get("userId")))) {
        return c.json({ error: "not a member" }, 403);
      }
      const syncs = await pg.getRepoSyncsForWorkspace(wsParam);
      return c.json({ syncs });
    }
    if (!idParam) return c.json({ error: "tasksProjectId or workspaceId required" }, 400);
    const tasksProjectId = await pg.resolveTasksProjectId(idParam);
    if (!tasksProjectId) return c.json({ error: "project not found" }, 404);
    const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
    if (!workspaceId) return c.json({ error: "project not found" }, 404);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const syncs = await pg.getRepoSyncForProject(tasksProjectId);
    return c.json({ syncs });
  });

  // ── authed: bind a repo to a project (the bindRepoSync RPC) ──
  app.post("/api/github/repo-sync", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    // Untrusted body: coerce to a plain object so a `null`, array, or primitive
    // JSON payload can't crash property access / the `in` operator below (→ 500).
    const body = asObject(await c.req.json().catch(() => ({})));
    const idParam = asString(body.tasksProjectId).trim();
    const installationId = asString(body.installationId).trim();
    const repoId = asString(body.repoId).trim();
    const owner = asString(body.owner).trim();
    const name = asString(body.name).trim();
    const repoUrl = asString(body.repoUrl).trim() || `https://github.com/${owner}/${name}`;
    if (!idParam || !installationId || !repoId || !owner || !name) {
      return c.json({ error: "tasksProjectId, installationId, repoId, owner, name required" }, 400);
    }
    // Optional 0039 fields (Image #4). syncDirection defaults to 'inbound' server-side
    // when omitted; an explicit invalid value is rejected. The state overrides are
    // passed through only when present (so a legacy bind doesn't clobber them).
    const rawDirection = asString(body.syncDirection).trim();
    if (rawDirection && !SYNC_DIRECTIONS.has(rawDirection)) {
      return c.json({ error: "invalid syncDirection (inbound|bidirectional)" }, 400);
    }
    const syncDirection = rawDirection || undefined;
    const issueOpenStateId =
      "issueOpenStateId" in body ? optStateId(body.issueOpenStateId) : undefined;
    const issueClosedStateId =
      "issueClosedStateId" in body ? optStateId(body.issueClosedStateId) : undefined;

    const tasksProjectId = await pg.resolveTasksProjectId(idParam);
    if (!tasksProjectId) return c.json({ error: "project not found" }, 404);
    const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
    if (!workspaceId) return c.json({ error: "project not found" }, 404);
    const userId = c.get("userId");
    if (!(await pg.isMember(workspaceId, userId))) return c.json({ error: "not a member" }, 403);
    // BOLA / tenant-integrity guard: `installationId` is caller-supplied. Require it to
    // be an installation THIS workspace authorized (the github_installations row written
    // at install-confirm). Without this a member could bind a repo under a FOREIGN
    // installation — fanning that repo's pull_request/issue webhooks into this
    // workspace's project (getRepoSyncsForRepo matches by installationId+repoId across
    // workspaces). The previous code instead did a bootstrap upsertGithubInstallation
    // here, which — because github_installations is unique on installation_id alone —
    // REASSIGNED a victim's install row to the caller's workspace. The install row is now
    // created only by the membership-checked, no-reassign POST
    // /api/github/installations/confirm, so a bind just verifies an existing claim.
    if ((await pg.getInstallationWorkspace(installationId)) !== workspaceId) {
      return c.json({ error: "installation not found" }, 404);
    }
    // Cross-project guard: each issue-state override (when provided) must be a task
    // state of THIS project — never one borrowed from a different project.
    for (const sid of [issueOpenStateId, issueClosedStateId]) {
      if (sid && !(await pg.stateBelongsToProject(sid, tasksProjectId))) {
        return c.json({ error: "state does not belong to project" }, 400);
      }
    }

    const id = await pg.bindRepoSync({
      id: `ghrs_${randomUUID()}`,
      workspaceId,
      installationId,
      tasksProjectId,
      repoId,
      owner,
      name,
      repoUrl,
      createdBy: userId,
      syncDirection,
      issueOpenStateId,
      issueClosedStateId,
    });
    return c.json({ id });
  });

  // ── authed: unbind a repo from a project ──
  app.delete("/api/github/repo-sync/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const sync = await pg.getRepoSyncById(id);
    if (!sync) return c.json({ error: "not found" }, 404);
    if (!(await pg.isMember(sync.workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    await pg.unbindRepoSync(id);
    return c.json({ ok: true });
  });

  // ── authed: edit a binding's sync direction / issue state map (Image #5 edit) ──
  app.patch("/api/github/repo-sync/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const sync = await pg.getRepoSyncById(id);
    if (!sync) return c.json({ error: "not found" }, 404);
    if (!(await pg.isMember(sync.workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    // Untrusted body: coerce to a plain object so a `null`, array, or primitive
    // JSON payload can't crash property access / the `in` operator below (→ 500).
    const body = asObject(await c.req.json().catch(() => ({})));
    const patch: {
      syncDirection?: string;
      issueOpenStateId?: string | null;
      issueClosedStateId?: string | null;
    } = {};
    if ("syncDirection" in body) {
      const dir = asString(body.syncDirection).trim();
      if (!SYNC_DIRECTIONS.has(dir)) {
        return c.json({ error: "invalid syncDirection (inbound|bidirectional)" }, 400);
      }
      patch.syncDirection = dir;
    }
    if ("issueOpenStateId" in body) patch.issueOpenStateId = optStateId(body.issueOpenStateId);
    if ("issueClosedStateId" in body)
      patch.issueClosedStateId = optStateId(body.issueClosedStateId);
    // Cross-project guard: a provided issue-state override must belong to the binding's
    // OWN project, never one borrowed from a different project.
    for (const sid of [patch.issueOpenStateId, patch.issueClosedStateId]) {
      if (sid && !(await pg.stateBelongsToProject(sid, sync.tasksProjectId))) {
        return c.json({ error: "state does not belong to project" }, 400);
      }
    }
    await pg.patchRepoSync(id, patch);
    return c.json({ ok: true });
  });

  // ── authed: PR-state → task-state mappings for a project (Image #3) ──
  app.get("/api/github/pr-mappings", requireAuth, async (c) => {
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
    const mappings = await pg.getPrStateMappingsForProject(tasksProjectId);
    return c.json({ mappings });
  });

  // Upsert one PR-state mapping (one row per (project, prState)). Returns its id.
  app.post("/api/github/pr-mappings", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    // Untrusted body: coerce to a plain object so a `null`, array, or primitive
    // JSON payload can't crash property access / the `in` operator below (→ 500).
    const body = asObject(await c.req.json().catch(() => ({})));
    const idParam = asString(body.tasksProjectId).trim();
    const prState = asString(body.prState).trim();
    if (!idParam || !prState) return c.json({ error: "tasksProjectId, prState required" }, 400);
    if (!PR_STATES.has(prState)) return c.json({ error: "invalid prState" }, 400);
    const tasksProjectId = await pg.resolveTasksProjectId(idParam);
    if (!tasksProjectId) return c.json({ error: "project not found" }, 404);
    const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
    if (!workspaceId) return c.json({ error: "project not found" }, 404);
    const userId = c.get("userId");
    if (!(await pg.isMember(workspaceId, userId))) return c.json({ error: "not a member" }, 403);
    // Cross-project guard: the chosen task state (when set) must be a state of THIS
    // project — never one borrowed from a different project.
    const taskStateId = optStateId(body.taskStateId);
    if (taskStateId && !(await pg.stateBelongsToProject(taskStateId, tasksProjectId))) {
      return c.json({ error: "state does not belong to project" }, 400);
    }
    const id = await pg.upsertPrStateMapping({
      id: `ghprm_${randomUUID()}`,
      workspaceId,
      tasksProjectId,
      prState,
      taskStateId,
      skipBackward: body.skipBackward === true,
      createdBy: userId,
    });
    return c.json({ id });
  });

  // Remove a PR-state mapping by id.
  app.delete("/api/github/pr-mapping/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const mapping = await pg.getPrStateMappingById(id);
    if (!mapping) return c.json({ error: "not found" }, 404);
    if (!(await pg.isMember(mapping.workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    await pg.deletePrStateMapping(id);
    return c.json({ ok: true });
  });

  // ── authed: list the repos an installation can access (repo picker source) ──
  // PHASE 3 (live App): this calls the GitHub API with an installation token. It is
  // GATED — without GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY it returns an empty list
  // (+ `configured:false`) so the UI degrades to a manual-entry form instead of
  // failing. See github-app.ts for the gated mint.
  app.get("/api/github/installation-repos", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const installationId = c.req.query("installationId");
    if (!installationId) return c.json({ error: "installationId required" }, 400);
    // BOLA guard: the repo list is scoped to a workspace via the project the caller
    // is about to bind into. Require `tasksProjectId`, resolve it to its workspace,
    // and confirm the caller is a member — otherwise any authed user could enumerate
    // ANY installation's repos by guessing an installationId.
    const projectParam = c.req.query("tasksProjectId");
    if (!projectParam) return c.json({ error: "tasksProjectId required" }, 400);
    const tasksProjectId = await pg.resolveTasksProjectId(projectParam);
    if (!tasksProjectId) return c.json({ error: "project not found" }, 404);
    const workspaceId = await pg.getTasksProjectWorkspace(tasksProjectId);
    if (!workspaceId) return c.json({ error: "project not found" }, 404);
    if (!(await validateWorkspaceAccess(pg, workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    // BOLA guard #2 (tenant isolation): membership on the PROJECT's workspace is not
    // enough — the `installationId` is attacker-controlled and GitHub installation ids
    // are low-entropy sequential integers. Without binding it to the workspace, any
    // member of ANY workspace could pass a victim's installationId (+ one of their own
    // projects) and mint a LIVE installation token for it via listInstallationRepos,
    // enumerating the victim's repos. Require the installation to be one THIS workspace
    // actually authorized (the github_installations row recorded at install-confirm).
    const installOwner = await pg.getInstallationWorkspace(installationId);
    if (installOwner !== workspaceId) {
      return c.json({ error: "installation not found" }, 404);
    }
    if (!isGithubAppConfigured()) {
      // App creds absent → can't mint a token → no live repo list. The UI falls
      // back to manual repo entry (owner/name/repoId).
      return c.json({ configured: false, repos: [] });
    }
    // Live path: mint an installation token (inside listInstallationRepos) and GET
    // /installation/repositories. A mint/fetch failure degrades to an empty list (the
    // helper logs + swallows), so the UI still falls back to manual entry.
    const repos = await listInstallationRepos(installationId);
    return c.json({ configured: true, repos });
  });

  // ── authed: the personal GitHub accounts connected for this workspace (Image #3
  //    "Connect Personal Account"). Drives the detail page's authoritative "Personal
  //    account connected" state so it PERSISTS across reloads — not just transiently
  //    from the OAuth callback's redirect note. Scoped to the caller's workspace
  //    (membership-checked). Surfaces ONLY safe fields; never the OAuth access_token. ──
  app.get("/api/github/user-connections", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const rows = await pg.listGithubUserConnectionsForWorkspace(workspaceId);
    // Project to the safe client shape — the StoredGithubUserConnection rows carry
    // the OAuth accessToken (+ userId/workspaceId), which must never leave the relay.
    const connections = rows.map((r) => ({
      id: r.id,
      githubLogin: r.githubLogin,
      scopes: r.scopes,
      createdAt: r.createdAt,
    }));
    return c.json({ connections });
  });

  // ── authed: start the personal-account OAuth flow (Image #3 "Connect Personal
  //    Account"). Returns the GitHub authorize URL for the BROWSER to navigate to
  //    (this is an authed fetch, so we can't 302 the browser directly — the client
  //    navigates to `url`). GATED: { configured:false } when GITHUB_OAUTH_* is unset
  //    so the UI shows a "not configured" state instead of a broken link. ──
  app.get("/api/github/oauth/start", requireAuth, async (c) => {
    if (!isGithubOAuthConfigured()) return c.json({ configured: false });
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    // Membership guard (parity with every sibling endpoint). The PUBLIC oauth/callback
    // has no session, so it trusts the SIGNED state minted HERE and writes a
    // github_user_connections row (carrying a real OAuth access_token) for
    // {workspaceId, userId}. This is therefore the ONLY place the workspace can be
    // authorized — without it an authed user could pass a workspaceId they are not a
    // member of and have the callback persist a credential-bearing row attributed to a
    // foreign workspace.
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const returnTo = c.req.query("return") ?? "";
    const state = signOAuthState({ workspaceId, userId: c.get("userId"), returnTo });
    const clientId = getGithubOAuthClientId() ?? "";
    // redirect_uri must point back at THIS relay (where the public callback lives),
    // match the OAuth App's registered callback URL, and be byte-identical to the value
    // sent at token-exchange time (below). oauthCallbackUrl() resolves a stable base for
    // both — never the request host.
    const redirectUri = oauthCallbackUrl(c);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "repo read:user",
      state,
    });
    return c.json({ configured: true, url: `https://github.com/login/oauth/authorize?${params}` });
  });

  // ── PUBLIC: personal-account OAuth callback. GitHub redirects the BROWSER here
  //    (no session) with code + the signed state. Best-effort: exchange the code,
  //    store github_user_connections, then redirect to the integration detail page.
  //    Never throws to the browser — a failure still lands the user with a note. ──
  app.get("/api/github/oauth/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const stateRaw = c.req.query("state") ?? "";
    const state = verifyOAuthState(stateRaw);
    const base = resolveAppBaseUrl(c);
    // A bad/forged state → we can't trust which workspace this is for; land at root.
    if (!state) return c.redirect(`${base || ""}/?github=oauth_error`, 302);
    const detail = `${base}/workspace/${encodeURIComponent(state.workspaceId)}/settings/integrations`;
    if (!code || !isGithubOAuthConfigured() || !pg) {
      return c.redirect(`${detail}?github=oauth_error`, 302);
    }
    try {
      const tokenResp = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: getGithubOAuthClientId(),
          client_secret: getGithubOAuthClientSecret(),
          code,
          // MUST byte-match the redirect_uri sent at authorize-time (oauth/start).
          redirect_uri: oauthCallbackUrl(c),
        }),
      });
      const tokenJson = (await tokenResp.json().catch(() => ({}))) as Record<string, unknown>;
      const accessToken = asString(tokenJson.access_token).trim();
      const scopes = asString(tokenJson.scope).trim() || null;
      if (accessToken) {
        const userResp = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "cyborg7",
          },
        });
        // An invalid / rate-limited token yields a non-2xx body (no `login`); storing
        // it would persist an empty-login connection. Land on oauth_error, don't upsert.
        if (!userResp.ok) {
          return c.redirect(`${detail}?github=oauth_error`, 302);
        }
        const userJson = (await userResp.json().catch(() => ({}))) as Record<string, unknown>;
        const login = asString(userJson.login).trim();
        // A 2xx with no usable login is equally unusable — don't persist a blank handle.
        if (!login) {
          return c.redirect(`${detail}?github=oauth_error`, 302);
        }
        await pg.upsertGithubUserConnection({
          id: `ghuc_${randomUUID()}`,
          workspaceId: state.workspaceId,
          userId: state.userId,
          githubLogin: login,
          accessToken,
          scopes,
        });
        return c.redirect(`${detail}?github=personal_connected`, 302);
      }
    } catch (err) {
      // Best-effort: a failed exchange must not 500 the browser. Log + land with note.
      console.error("[github] personal-account OAuth callback failed", err);
    }
    return c.redirect(`${detail}?github=oauth_error`, 302);
  });

  return app;
}

// Route a verified webhook event to its handler. Resolves the repo binding for
// repo-scoped events (issues/issue_comment/label); skips silently when the repo
// isn't synced to any project.
async function dispatchEvent(
  pg: PgSync,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (event === "installation") {
    await handleInstallation(pg, payload);
    return;
  }
  if (event === "installation_repositories") {
    await handleInstallationRepositories(pg, payload);
    return;
  }

  // `pull_request` (opened / reopened / ready_for_review / review_requested /
  // converted_to_draft / closed[→merged]) → derive the PR state, look up each bound
  // project's github_pr_state_mappings[pr_state], move the LINKED task (respecting
  // skip_backward), and track it in github_pr_syncs. The engine resolves the repo
  // binding(s) itself (a repo may bind multiple projects), so it doesn't share the
  // single-binding resolution the issue events use below.
  if (event === "pull_request") {
    await handlePullRequest(pg, payload);
    return;
  }

  // Repo-scoped events need a binding to know which project to write to.
  if (event === "issues" || event === "issue_comment" || event === "label") {
    const installationId = installationIdOf(payload);
    const repo = repoRefOf(payload);
    if (!installationId || !repo) return;
    const repoSync = await pg.getRepoSync(installationId, repo.repoId);
    if (!repoSync) return; // repo not bound to any project — nothing to do.

    if (event === "issues") await handleIssues(pg, repoSync, payload);
    else if (event === "issue_comment") await handleIssueComment(pg, repoSync, payload);
    else handleLabel();
  }
}

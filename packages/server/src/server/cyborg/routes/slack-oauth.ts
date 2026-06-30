import { Hono, type Context } from "hono";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv, RequireAuth } from "./types.js";
import { isSlackConfigured, getSlackClientId, getSlackClientSecret } from "../slack-app.js";

// Slack OAuth (bot install) + the authed Settings-UI callbacks. This is a SEPARATE
// file from routes/slack.ts (the WAVE-2a Events endpoint + bridge engine) so the two
// disjoint surfaces never collide. It mirrors routes/github.ts's OAuth + bind
// callbacks exactly: requireAuth + isMember on every authed route, a credential-gated
// `{ configured:false }`, a STABLE-base redirect (CYBORG_APP_URL, never the raw Host),
// a SIGNED OAuth `state`, and BOLA guards so a member of one workspace can never act
// on another's installation/link.
//
// Surfaces (mirroring github.ts):
//   GET    /api/slack/config             — authed: the gate + the ready-to-use install URL.
//   GET    /api/slack/oauth/callback     — PUBLIC: Slack's browser redirect after consent.
//   GET    /api/slack/installations      — authed: this workspace's Slack installs (token STRIPPED).
//   DELETE /api/slack/installation/:id    — authed: disconnect an install (workspace-scoped).
//   GET    /api/slack/channel-links      — authed: this workspace's Slack↔Cyborg channel links.
//   POST   /api/slack/channel-links      — authed: link a Slack channel to a Cyborg channel.
//   DELETE /api/slack/channel-link/:id   — authed: unlink (workspace-scoped).
//
// Credential gate: with the Slack secrets absent (slack-app.ts isSlackConfigured()),
// /config returns { configured:false } and the OAuth flow is inert — the UI renders a
// clear "not configured" state and nothing touches Slack. PROD MUST set CYBORG_APP_URL.

// The provider key stored in integration_installations.provider. Kept as a local
// literal (not imported from integrations/slack-adapter.ts, the WAVE-2a coder's file)
// so this OAuth surface stays decoupled from the bridge engine.
const SLACK_PROVIDER = "slack";

// The bot scopes the install requests (WAVE-2 contract). chat:write (outbound post),
// channels/groups history+read (read public + private channel messages + metadata),
// users:read (resolve author display names), reactions:read + files:read (WAVE-2a
// edits/reactions/file mirroring), and conversations.connect:read/write (Slack Connect
// shared-channel support — the customer-comms use case). Comma-separated per Slack v2.
const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
  "reactions:read",
  "files:read",
  "conversations.connect:read",
  "conversations.connect:write",
].join(",");

export interface SlackOAuthRoutesDeps {
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

// Coerce an already-parsed JSON value to a plain object — {} for a null/array/primitive
// body — so an untrusted POST payload can be indexed without throwing a TypeError (→500).
function asObject(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

// ── stable-base redirect helpers (verbatim discipline from routes/github.ts) ──

// The origin the relay is reached at, derived from the request. Behind the deploy's
// reverse proxy the real host/scheme arrive in X-Forwarded-Host / X-Forwarded-Proto;
// fall back to Host + https. "" when no host header is present (→ a relative redirect).
function requestOrigin(c: Context<RelayEnv>): string {
  const fwdHost = c.req.header("x-forwarded-host");
  const host = (fwdHost || c.req.header("host") || "").split(",")[0]?.trim() ?? "";
  if (!host) return "";
  const fwdProto = c.req.header("x-forwarded-proto");
  const proto = (fwdProto || "https").split(",")[0]?.trim() ?? "https";
  return `${proto}://${host}`;
}

// The base URL the PUBLIC oauth/callback redirects the BROWSER to (the app origin).
// SECURITY (open-redirect hardening): the callback is unauthenticated and
// requestOrigin() trusts the attacker-influenceable X-Forwarded-Host / Host. So when
// CYBORG_APP_URL is set we ALWAYS use it and NEVER the request host — otherwise a
// crafted Host could 302 a victim to an attacker origin. The request-origin fallback
// is dev-only (CYBORG_APP_URL unset; the relay then also serves the UI). PROD MUST set
// CYBORG_APP_URL.
function resolveAppBaseUrl(c: Context<RelayEnv>): string {
  const configured = process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  return requestOrigin(c);
}

// The OAuth `redirect_uri` Slack calls back to. Slack REQUIRES this to be byte-
// identical at authorize-time (/config) and at token-exchange-time (oauth/callback),
// and to match the Slack app's registered Redirect URL. The two requests are SEPARATE
// (one is an authed app call, the other Slack's browser redirect) so their Host headers
// can differ and are attacker-influenceable behind a proxy — we therefore resolve a
// STABLE configured base, never the request host: prefer SLACK_OAUTH_CALLBACK_BASE (set
// when the relay's public API origin differs from the UI origin), else CYBORG_APP_URL
// (the relay serves /api/slack/oauth/callback at the same origin it serves the UI in the
// cloud deploy), else the request origin ONLY in dev. Both call sites use THIS helper so
// the redirect_uri always matches. PROD MUST set one of the two env vars.
function slackCallbackUrl(c: Context<RelayEnv>): string {
  const configured =
    process.env.SLACK_OAUTH_CALLBACK_BASE?.replace(/\/$/, "") ||
    process.env.CYBORG_APP_URL?.replace(/\/$/, "");
  const base = configured || requestOrigin(c);
  return `${base}/api/slack/oauth/callback`;
}

// ── signed OAuth state (mirrors routes/github.ts signOAuthState/verifyOAuthState) ──

// Sign the OAuth `state` so the PUBLIC callback can trust the (workspaceId, userId) it
// carries WITHOUT a session. `<base64url(json)>.<hmac>`, keyed on the Slack client
// secret (always present when configured). The state is minted ONLY by /config AFTER an
// isMember check, so the public callback — which writes a credential-bearing install row
// attributed to {workspaceId, installedBy:userId} — can never be tricked (via a forged
// Host or a guessed workspaceId) into storing an attacker's bot token under a victim's
// workspace. The callback re-derives + constant-time compares the HMAC before acting.
interface OAuthState {
  workspaceId: string;
  userId: string;
}

export function signSlackOAuthState(payload: OAuthState): string {
  const secret = getSlackClientSecret() ?? "";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySlackOAuthState(state: string): OAuthState | null {
  const secret = getSlackClientSecret() ?? "";
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
    return { workspaceId: parsed.workspaceId, userId: parsed.userId };
  } catch {
    return null;
  }
}

// The authed routes' shared membership guard — a thin, unit-testable wrapper over
// pg.isMember (parity with github.ts validateWorkspaceAccess).
export function validateWorkspaceAccess(
  pg: PgSync,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  return pg.isMember(workspaceId, userId);
}

// Exchange the OAuth `code` for a bot token (oauth.v2.access) and persist the install.
// Returns true when an install was stored, false when the exchange yields an unusable
// response (no team id / no bot token). Throws only on a network error — the callback
// catches it. Extracted from the callback handler so that handler stays under the
// per-function complexity budget while keeping the same best-effort behavior.
async function exchangeAndStoreSlackInstall(
  c: Context<RelayEnv>,
  pg: PgSync,
  state: OAuthState,
  code: string,
): Promise<boolean> {
  // No-token WebClient: oauth.v2.access authenticates with client_id/client_secret.
  const res = await new WebClient().oauth.v2.access({
    client_id: getSlackClientId() ?? "",
    client_secret: getSlackClientSecret() ?? "",
    code,
    // MUST byte-match the redirect_uri sent at authorize-time (/config).
    redirect_uri: slackCallbackUrl(c),
  });
  const teamId = typeof res.team?.id === "string" ? res.team.id : "";
  const accessToken = typeof res.access_token === "string" ? res.access_token : "";
  // A response without a team id or bot token is unusable — don't persist a blank row.
  if (!res.ok || !teamId || !accessToken) return false;
  const botUserId = typeof res.bot_user_id === "string" ? res.bot_user_id : null;
  const scopes = typeof res.scope === "string" ? res.scope : null;
  const teamName = typeof res.team?.name === "string" ? res.team.name : "";
  await pg.upsertIntegrationInstallation({
    id: `intg_${randomUUID()}`,
    workspaceId: state.workspaceId,
    provider: SLACK_PROVIDER,
    externalId: teamId,
    config: teamName ? { teamName } : {},
    accessToken,
    botUserId,
    scopes,
    installedBy: state.userId,
  });
  return true;
}

// Mounted as a Hono sub-app — the relay does `app.route("/", createSlackOAuthRoutes(...))`
// alongside createGithubRoutes (see relay-standalone.ts; the WAVE-2a coder owns that
// file's mount line).
export function createSlackOAuthRoutes(deps: SlackOAuthRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth } = deps;
  const app = new Hono<RelayEnv>();

  // ── authed: the Slack app's config + the ready-to-use install URL ──
  // GATED: { configured:false } when the Slack secrets are absent (slack-app.ts) so the
  // UI shows a "not configured" state instead of a broken link. With a workspaceId the
  // install URL embeds a SIGNED state {workspaceId, userId} (minted here only after an
  // isMember check) — see signSlackOAuthState. redirect_uri is the stable callback base.
  app.get("/api/slack/config", requireAuth, async (c) => {
    if (!isSlackConfigured()) return c.json({ configured: false, installUrl: null });
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ configured: true, installUrl: null });
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const state = signSlackOAuthState({ workspaceId, userId: c.get("userId") });
    const params = new URLSearchParams({
      client_id: getSlackClientId() ?? "",
      scope: SLACK_BOT_SCOPES,
      redirect_uri: slackCallbackUrl(c),
      state,
    });
    return c.json({
      configured: true,
      installUrl: `https://slack.com/oauth/v2/authorize?${params.toString()}`,
    });
  });

  // ── PUBLIC: Slack's OAuth callback. Slack redirects the BROWSER here (no session)
  //    with code + the signed state. Best-effort: exchange the code via oauth.v2.access,
  //    store the install (bot token), then redirect to the Slack integration detail page.
  //    Never throws to the browser — a failure still lands the user with a status note. ──
  app.get("/api/slack/oauth/callback", async (c) => {
    const code = c.req.query("code") ?? "";
    const state = verifySlackOAuthState(c.req.query("state") ?? "");
    const base = resolveAppBaseUrl(c);
    // A bad/forged state → we can't trust which workspace this is for; land at root.
    if (!state) return c.redirect(`${base || ""}/?slack=oauth_error`, 302);
    const detail = `${base}/workspace/${encodeURIComponent(state.workspaceId)}/settings/integrations/slack`;
    if (!code || !isSlackConfigured() || !pg) {
      return c.redirect(`${detail}?slack=oauth_error`, 302);
    }
    try {
      if (await exchangeAndStoreSlackInstall(c, pg, state, code)) {
        return c.redirect(`${detail}?slack=connected`, 302);
      }
    } catch (err) {
      // Best-effort: a failed exchange must not 500 the browser. Log + land with a note.
      console.error("[slack] oauth callback failed", err);
    }
    return c.redirect(`${detail}?slack=oauth_error`, 302);
  });

  // ── authed: every Slack installation this workspace authorized ──
  // Drives the detail page's connected-workspace row(s). Scoped to the caller's
  // workspace (membership-checked). SECURITY: the access_token (bot token) is STRIPPED
  // — it must never leave the relay.
  app.get("/api/slack/installations", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const rows = await pg.listIntegrationInstallations(workspaceId, SLACK_PROVIDER);
    // Project to the safe client shape — never the accessToken (the bot token).
    const installations = rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      provider: r.provider,
      externalId: r.externalId,
      config: r.config,
      botUserId: r.botUserId,
      scopes: r.scopes,
      installedBy: r.installedBy,
      createdAt: r.createdAt,
    }));
    return c.json({ installations });
  });

  // ── authed: disconnect an installation from this workspace ──
  // BOLA guard: `workspaceId` is membership-checked AND the install must belong to it
  // (an install id from a foreign workspace is rejected, never deleted). Its
  // slack_channel_links cascade away (0045 FK).
  app.delete("/api/slack/installation/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const install = await pg.getIntegrationInstallationById(id);
    if (!install || install.workspaceId !== workspaceId || install.provider !== SLACK_PROVIDER) {
      return c.json({ error: "not found" }, 404);
    }
    await pg.deleteIntegrationInstallation(id);
    return c.json({ ok: true });
  });

  // ── authed: this workspace's Slack↔Cyborg channel links ──
  app.get("/api/slack/channel-links", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const links = await pg.listSlackChannelLinksForWorkspace(workspaceId);
    return c.json({ links });
  });

  // ── authed: link a Slack channel to a Cyborg channel ──
  // BOLA guards: membership on the workspace; the installation must belong to it; and
  // the cyborg channel must belong to it — so a member can never bind a foreign
  // installation or a foreign channel into this workspace's bridge.
  app.post("/api/slack/channel-links", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = asObject(await c.req.json().catch(() => ({})));
    const workspaceId = asString(body.workspaceId).trim();
    const installationId = asString(body.installationId).trim();
    const cyborgChannelId = asString(body.cyborgChannelId).trim();
    const slackChannelId = asString(body.slackChannelId).trim();
    const slackTeamId = asString(body.slackTeamId).trim();
    if (!workspaceId || !installationId || !cyborgChannelId || !slackChannelId || !slackTeamId) {
      return c.json(
        {
          error:
            "workspaceId, installationId, cyborgChannelId, slackChannelId, slackTeamId required",
        },
        400,
      );
    }
    const userId = c.get("userId");
    if (!(await pg.isMember(workspaceId, userId))) return c.json({ error: "not a member" }, 403);
    const install = await pg.getIntegrationInstallationById(installationId);
    if (!install || install.workspaceId !== workspaceId || install.provider !== SLACK_PROVIDER) {
      return c.json({ error: "installation not found" }, 404);
    }
    // Team-scoping (defense in depth): the body's slackTeamId MUST match the Slack
    // team/enterprise id this install was minted for (install.externalId, captured at
    // OAuth). Without it a member could bind a link under a forged team id that doesn't
    // belong to the install they're binding through.
    if (slackTeamId !== install.externalId) {
      return c.json({ error: "slackTeamId does not match installation" }, 400);
    }
    const channel = await pg.getChannel(cyborgChannelId);
    if (!channel || channel.workspace_id !== workspaceId) {
      return c.json({ error: "channel not found" }, 404);
    }
    // BOLA guard (cross-tenant write): slackChannelId is GLOBALLY unique (a Slack channel
    // binds to exactly one Cyborg channel) and createSlackChannelLink upserts on it
    // WITHOUT re-checking workspaceId. Without this guard a member of workspace B could
    // pass a slackChannelId already linked by workspace A — passing every check above with
    // their own B-owned install + channel — and silently re-point A's row at B's resources
    // (A keeps workspaceId=A but loses its mirror). Reject a claim on a Slack channel owned
    // by another workspace; a same-workspace re-link still upserts as before.
    const existingLink = await pg.getSlackChannelLinkBySlackChannel(slackChannelId);
    if (existingLink && existingLink.workspaceId !== workspaceId) {
      return c.json({ error: "slack channel already linked in another workspace" }, 409);
    }
    const id = await pg.createSlackChannelLink({
      id: `slkl_${randomUUID()}`,
      workspaceId,
      installationId,
      cyborgChannelId,
      slackChannelId,
      slackTeamId,
      createdBy: userId,
    });
    return c.json({ id });
  });

  // ── authed: unlink a Slack↔Cyborg channel link ──
  // BOLA guard: `workspaceId` is membership-checked AND the link must belong to it. The
  // DAL has no get-by-id, so we confirm via the workspace's link list before deleting.
  app.delete("/api/slack/channel-link/:id", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const id = c.req.param("id");
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    if (!(await pg.isMember(workspaceId, c.get("userId")))) {
      return c.json({ error: "not a member" }, 403);
    }
    const links = await pg.listSlackChannelLinksForWorkspace(workspaceId);
    if (!links.some((l) => l.id === id)) return c.json({ error: "not found" }, 404);
    await pg.deleteSlackChannelLink(id);
    return c.json({ ok: true });
  });

  return app;
}

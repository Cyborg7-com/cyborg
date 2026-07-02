// Jira Cloud OAuth 3LO (three-legged) config + token helpers. Mirrors github-app.ts:
// every live-call path is guarded by `isJiraConfigured()`, so this module compiles and
// runs inert WITHOUT credentials (the UI renders a clear "not configured" state and the
// helpers return null). The routes coder consumes these to run the connect flow; the
// adapter (jira-adapter.ts) is stateless and never reads env — it takes the minted access
// token as an argument.
//
// GATED ON (both present for a live, end-to-end Jira integration):
//   - JIRA_OAUTH_CLIENT_ID      — the OAuth 2.0 (3LO) app client id (public; authorize URL).
//   - JIRA_OAUTH_CLIENT_SECRET  — the app client secret (server-side code -> token). NEVER
//     surfaced to a client.
//
// TOKEN MODEL: Atlassian access tokens expire in ~1h and (with the `offline_access` scope)
// come with a rotating refresh_token. Callers store BOTH — the refresh token encrypted at
// rest (task-sync-crypto.ts) — and call refreshAccessToken when the access token nears
// expiry. All network is via global fetch; every helper returns a TYPED result (or null
// when unconfigured) and NEVER throws to the caller.

// The Atlassian OAuth token endpoint (auth server, NOT the API gateway).
const ATLASSIAN_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
// The accessible-resources endpoint: given an access token, lists the Jira sites (each
// with its `id` = cloudId) the token can reach. The cloudId keys every REST API call.
const ATLASSIAN_RESOURCES_URL = "https://api.atlassian.com/oauth/token/accessible-resources";

// True only when BOTH OAuth secrets are present. Every live path checks this first; with
// it false the Jira integration is inert (no throw, no network).
export function isJiraConfigured(): boolean {
  return !!(process.env.JIRA_OAUTH_CLIENT_ID && process.env.JIRA_OAUTH_CLIENT_SECRET);
}

// The OAuth app's public client id (used to build the authorize URL), or null.
export function getJiraOAuthClientId(): string | null {
  return process.env.JIRA_OAUTH_CLIENT_ID ?? null;
}

// The OAuth app's client secret (server-side only, for the code -> token exchange), or
// null. NEVER surfaced to a client.
export function getJiraOAuthClientSecret(): string | null {
  return process.env.JIRA_OAUTH_CLIENT_SECRET ?? null;
}

// A successful token mint/refresh. `refreshToken` is present when the `offline_access`
// scope was granted (and rotates on every refresh — always persist the newest one).
export interface JiraTokenSuccess {
  ok: true;
  accessToken: string;
  refreshToken: string | null;
  // Seconds until the access token expires (Atlassian returns ~3600), or null if absent.
  expiresInSeconds: number | null;
  scope: string | null;
  tokenType: string;
}

// A failed token mint/refresh — the reason is safe to log (no secret material).
export interface JiraTokenFailure {
  ok: false;
  error: string;
}

export type JiraTokenResult = JiraTokenSuccess | JiraTokenFailure;

// One Jira site the access token can reach. `id` is the cloudId (the base-URL segment for
// every REST call); `url` is the human site base (e.g. https://acme.atlassian.net).
export interface JiraAccessibleResource {
  id: string;
  url: string;
  name: string;
  scopes: string[];
}

/**
 * Exchange an authorization code for tokens (the OAuth callback). GATED: returns null
 * (no throw) when the app isn't configured, so the caller degrades gracefully. On a
 * provider/transport error returns a typed { ok: false } — never throws.
 */
export async function exchangeCode(
  code: string,
  redirectUri: string,
): Promise<JiraTokenResult | null> {
  const clientId = getJiraOAuthClientId();
  const clientSecret = getJiraOAuthClientSecret();
  if (!clientId || !clientSecret) return null;
  return postToken({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
}

/**
 * Mint a fresh access token from a stored refresh token. GATED: returns null when the app
 * isn't configured. On a provider/transport error returns { ok: false } — never throws.
 * Atlassian ROTATES the refresh token on every refresh, so persist the returned
 * `refreshToken` (when present) over the old one.
 */
export async function refreshAccessToken(refreshToken: string): Promise<JiraTokenResult | null> {
  const clientId = getJiraOAuthClientId();
  const clientSecret = getJiraOAuthClientSecret();
  if (!clientId || !clientSecret) return null;
  return postToken({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
}

/**
 * List the Jira sites (cloudId + site url) an access token can reach — the connect flow
 * uses the returned cloudId to build the REST base URL and to compose the adapter's
 * externalProjectId ("<cloudId>:<projectKey>"). GATED: returns null when unconfigured or
 * on a provider/transport error — never throws.
 */
export async function getAccessibleResources(
  token: string,
): Promise<JiraAccessibleResource[] | null> {
  if (!isJiraConfigured()) return null;
  try {
    const res = await fetch(ATLASSIAN_RESOURCES_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`[jira-app] accessible-resources returned ${res.status}`);
      return null;
    }
    const data: unknown = await res.json();
    const out: JiraAccessibleResource[] = [];
    for (const r of arr(data)) {
      const resource = obj(r);
      const id = asString(resource?.id).trim();
      if (!id) continue;
      out.push({
        id,
        url: asString(resource?.url).trim(),
        name: asString(resource?.name).trim(),
        scopes: arr(resource?.scopes)
          .map((s) => asString(s).trim())
          .filter(Boolean),
      });
    }
    return out;
  } catch (err) {
    console.error("[jira-app] failed to fetch accessible resources", err);
    return null;
  }
}

// POST a token grant to the Atlassian auth server + normalize the response into a typed
// result. Shared by exchangeCode + refreshAccessToken. Never throws.
async function postToken(body: Record<string, string>): Promise<JiraTokenResult> {
  try {
    const res = await fetch(ATLASSIAN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Atlassian token endpoint returned ${res.status}: ${await safeText(res)}`,
      };
    }
    const data: unknown = await res.json();
    const parsed = obj(data);
    const accessToken = asString(parsed?.access_token).trim();
    if (!accessToken) return { ok: false, error: "Atlassian token response missing access_token" };
    return {
      ok: true,
      accessToken,
      refreshToken: asString(parsed?.refresh_token).trim() || null,
      expiresInSeconds: num(parsed?.expires_in),
      scope: asString(parsed?.scope).trim() || null,
      tokenType: asString(parsed?.token_type).trim() || "Bearer",
    };
  } catch (err) {
    return { ok: false, error: `Atlassian token request failed: ${errMessage(err)}` };
  }
}

// ── permissive extraction helpers (untrusted JSON) ──

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

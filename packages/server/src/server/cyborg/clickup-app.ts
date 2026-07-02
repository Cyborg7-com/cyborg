// ClickUp app config + credential gate + OAuth code→token exchange. Mirrors
// github-app.ts / slack-app.ts: every ClickUp feature (the OAuth install/callback,
// the webhook receiver, outbound writes) checks `isClickUpConfigured()` first; with
// the secrets ABSENT the feature is inert (no throw, no network) and the UI renders a
// clear "not configured" state.
//
// ClickUp specifics baked in here:
//   - OAuth access tokens do NOT expire — there is no refresh dance, so this module
//     exposes `exchangeCode` (one-shot code→token) and nothing else token-lifecycle-wise.
//   - ClickUp authenticates via the `Authorization` header: a PERSONAL token (a `pk_…`
//     value a user pastes) is sent VERBATIM, while an OAuth access token uses the
//     documented `Bearer ` prefix. `clickUpAuthHeaderValue` is the single place that
//     encodes this so every caller can pass whichever token kind was stored.
//
// GATED ON (both present for a live OAuth install):
//   - CLICKUP_OAUTH_CLIENT_ID      — the app's OAuth client id (public; authorize URL).
//   - CLICKUP_OAUTH_CLIENT_SECRET  — the app's OAuth client secret (server-side only).

// ClickUp's OAuth token endpoint (API v2). The code→token exchange POSTs here with the
// client id/secret + code in an x-www-form-urlencoded body (ClickUp's documented form).
export const CLICKUP_OAUTH_TOKEN_URL = "https://api.clickup.com/api/v2/oauth/token";

// True only when BOTH ClickUp OAuth secrets are present. The OAuth callback + any live
// call site checks this first; with it false the integration is inert (no throw, no
// network) and the UI can render a clear "not configured" state. A raw personal-token
// install path does NOT require these (the user supplies the token directly).
export function isClickUpConfigured(): boolean {
  return !!(process.env.CLICKUP_OAUTH_CLIENT_ID && process.env.CLICKUP_OAUTH_CLIENT_SECRET);
}

// The OAuth client id (public — used to build the authorize URL), or null. Single
// source of truth for the env read.
export function getClickUpOAuthClientId(): string | null {
  return process.env.CLICKUP_OAUTH_CLIENT_ID ?? null;
}

// The OAuth client secret (server-side only, for the code → token exchange), or null.
// NEVER surfaced to a client.
export function getClickUpOAuthClientSecret(): string | null {
  return process.env.CLICKUP_OAUTH_CLIENT_SECRET ?? null;
}

// The exact bytes to send in the `Authorization` header for a ClickUp API call. Per the
// current ClickUp docs a personal token (`pk_…`) is sent VERBATIM, while an OAuth access
// token uses the `Bearer ` prefix. (ClickUp v2 has historically tolerated a raw OAuth token
// too, but Bearer is the documented form.) This helper lets every caller pass whatever
// token was stored for the installation and get the correct header for its kind.
export function clickUpAuthHeaderValue(token: string): string {
  return token.startsWith("pk_") ? token : `Bearer ${token}`;
}

// The typed result of an OAuth code→token exchange. Discriminated so callers branch on
// `ok` and never see a thrown error (this module never throws to the caller).
export type ClickUpTokenExchangeResult =
  | { ok: true; accessToken: string }
  | { ok: false; error: string };

// Exchange an OAuth authorization `code` for a (non-expiring) ClickUp access token.
// GATED: returns { ok:false } (no throw) when the app isn't configured, so callers
// degrade gracefully. POSTs to CLICKUP_OAUTH_TOKEN_URL with client_id/client_secret/code
// in an x-www-form-urlencoded BODY (ClickUp's documented form) and reads `access_token`
// from the JSON body. NEVER throws — any transport/parse/provider error → { ok:false, error }.
export async function exchangeCode(code: string): Promise<ClickUpTokenExchangeResult> {
  const clientId = getClickUpOAuthClientId();
  const clientSecret = getClickUpOAuthClientSecret();
  if (!clientId || !clientSecret) return { ok: false, error: "clickup_not_configured" };
  if (!code) return { ok: false, error: "missing_code" };

  try {
    const body = new URLSearchParams();
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    body.set("code", code);

    const res = await fetch(CLICKUP_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const accessToken = asString(json.access_token).trim();
    if (!res.ok || !accessToken) {
      const err = asString(json.err).trim() || `token exchange failed: ${res.status}`;
      return { ok: false, error: err };
    }
    return { ok: true, accessToken };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "token exchange error" };
  }
}

// Coerce an untrusted JSON value to a string ("" when absent / not a string).
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

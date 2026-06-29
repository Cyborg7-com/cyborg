// Mirrors how the WS client resolves the cloud relay (state.svelte.ts CLOUD_WS_URL
// + client.ts relayHttpBaseFromWsUrl): the UI persists `{ url, token }` under the
// "cyborg7-session" localStorage key, where `url` is the relay WS endpoint. We
// derive the HTTP(S) origin from that same saved WS url so client-error beacons go
// to the exact relay the socket talks to. When there's no saved session we fall
// back to the canonical Cyborg Cloud relay.

const SESSION_KEY = "cyborg7-session";
const CLOUD_WS_URL = "wss://relay.cyborg7.com/api/ws";

// ws(s)://host[/api/ws] → http(s)://host. Identical transform to
// client.ts `relayHttpBaseFromWsUrl`.
function httpBaseFromWsUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/api\/ws\/?$/, "")
    .replace(/\/ws\/?$/, "");
}

function savedSessionWsUrl(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed?.url === "string" && parsed.url ? parsed.url : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the relay HTTP(S) base for client-error beacons.
 *
 * Returns "" (same-origin) when the saved-session relay is the SAME origin as the
 * current page — then the beacon uses a relative path and rides the page origin.
 * Otherwise returns the relay's absolute HTTP origin (saved session, else the
 * canonical cloud relay). On a non-browser host, returns the cloud relay origin.
 */
export function resolveRelayBase(): string {
  const wsUrl = savedSessionWsUrl() ?? CLOUD_WS_URL;
  const relayHttpBase = httpBaseFromWsUrl(wsUrl);

  try {
    if (typeof window !== "undefined" && window.location?.origin) {
      // Same origin as the page → relative path (keeps the beacon first-party).
      if (new URL(relayHttpBase).origin === window.location.origin) {
        return "";
      }
    }
  } catch {
    // Malformed origin — fall back to the absolute relay base.
  }
  return relayHttpBase;
}

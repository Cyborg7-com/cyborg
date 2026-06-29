// Pure helpers for the main-process error beacon, split out of main.ts so they
// can be unit-tested without importing Electron. main.ts wires these to the
// actual relay POST (Electron `net`) + the $PASEO_HOME relay-url file.
//
// The Logfire WRITE TOKEN never ships in the desktop bundle — the desktop process
// POSTs its errors to the relay's /api/cyborg/client-log endpoint (which holds the
// token and emits the Logfire exception), exactly like the web + mobile beacons.

// Canonical Cyborg Cloud relay WS endpoint — the fallback when the desktop hasn't
// recorded a bound relay yet. Mirrors CLOUD_WS_URL in
// @cyborg7/observability/web → relay-url.ts and the UI's state.svelte.ts.
export const CLOUD_RELAY_WS_URL = "wss://relay.cyborg7.com/api/ws";
export const CLIENT_LOG_PATH = "/api/cyborg/client-log";

export interface MainErrorPayload {
  source: string;
  message: string;
  stack: string | null;
  kind?: string;
  [key: string]: unknown;
}

// ws(s)://host[/api/ws] → http(s)://host. Identical transform to the web beacon's
// relay-url.ts httpBaseFromWsUrl + client.ts relayHttpBaseFromWsUrl.
export function httpBaseFromWsUrl(wsUrl: string): string {
  return wsUrl
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/api\/ws\/?$/, "")
    .replace(/\/ws\/?$/, "");
}

// Normalize an arbitrary thrown value into the relay client-log payload shape,
// preserving the original stack when present so Logfire records a real exception.
export function toMainErrorPayload(source: string, value: unknown, kind: string): MainErrorPayload {
  const err = value instanceof Error ? value : new Error(String(value));
  return { source, message: err.message || `error in ${source}`, stack: err.stack ?? null, kind };
}

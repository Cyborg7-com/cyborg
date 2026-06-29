import { resolveRelayBase } from "./relay-url.js";

// Field caps mirror v1's `/api/client-error` route: message <= 4000, stack <= 12000.
const MAX_MESSAGE = 4000;
const MAX_STACK = 12000;

// Relay ingest path for client logs. (The relay route itself is wired separately;
// this package only emits the beacon.)
const CLIENT_LOG_PATH = "/api/cyborg/client-log";

export interface ClientErrorInput {
  // Where the error came from: "window.onerror", "unhandledrejection",
  // "react-error-boundary", a feature name, etc.
  source: string;
  message: string;
  stack?: string | null;
  platform?: string;
  version?: string;
  workspaceId?: string | null;
  // Any extra context (pathname, href, userAgent, …). Merged into the payload.
  [key: string]: unknown;
}

export interface ClientErrorPayload {
  source: string;
  message: string;
  stack: string | null;
  platform?: string;
  version?: string;
  workspaceId?: string | null;
  [key: string]: unknown;
}

// Build + clamp the beacon payload. Pure + exported for unit testing the clamping
// and field shaping.
export function buildClientErrorPayload(input: ClientErrorInput): ClientErrorPayload {
  const { source, message, stack, ...rest } = input;
  return {
    ...rest,
    source: source || "client",
    message: String(message ?? "Unknown client error").slice(0, MAX_MESSAGE),
    stack: stack ? String(stack).slice(0, MAX_STACK) : null,
  };
}

function sendPayload(body: string): void {
  const base = resolveRelayBase();
  const url = `${base}${CLIENT_LOG_PATH}`;

  // Prefer sendBeacon — survives page unload, the original error path.
  try {
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon(url, blob)) return;
    }
  } catch {
    // fall through to fetch
  }

  // Fallback: keepalive fetch (works cross-origin to the relay; survives unload).
  try {
    if (typeof fetch === "function") {
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        // Cross-origin relay beacons don't need cookies; keep it simple + CORS-safe.
        mode: "cors",
        // intentional: beacon is best-effort; local console.error already fired
      }).catch(() => {});
    }
  } catch {
    // Nothing else we can do — the console.error in reportClientError still fired.
  }
}

/**
 * Report a client-side error. Builds + clamps the payload (message <= 4000,
 * stack <= 12000) and ALWAYS logs locally via console.error.
 *
 * ALWAYS beacons to the relay's /api/cyborg/client-log (sendBeacon, with a
 * keepalive-fetch fallback) — for web, the Electron desktop renderer, AND the
 * mobile WebView alike. The relay holds the Logfire write token and emits the
 * exception server-side; no client bundle (the distributed desktop DMG included)
 * ever ships the token. The relay base is resolved from the same saved-session WS
 * url the SlackClient uses (relative when same-origin). Never throws.
 */
export function reportClientError(input: ClientErrorInput): void {
  const payload = buildClientErrorPayload(input);

  // Always surface locally so a dev/console sees it even if delivery is dropped.
  try {
    // eslint-disable-next-line no-console
    console.error("[ClientError]", payload.source, payload.message, input);
  } catch {
    // ignore
  }

  try {
    sendPayload(JSON.stringify(payload));
  } catch {
    // Never let error reporting throw into the caller.
  }
}

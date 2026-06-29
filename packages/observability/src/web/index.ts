// @cyborg7/observability/web — client-error beacons for UI / Electron-renderer /
// Tauri WebView. NO token, NO OpenTelemetry, tiny + tree-shakeable. Reports client
// errors to the relay's /api/cyborg/client-log via sendBeacon (keepalive-fetch
// fallback) and always console.error.

export { reportClientError, buildClientErrorPayload } from "./client-error.js";
export type { ClientErrorInput, ClientErrorPayload } from "./client-error.js";
export { installGlobalErrorHandlers } from "./global-handlers.js";
export { resolveRelayBase } from "./relay-url.js";

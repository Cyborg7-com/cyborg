// @cyborg7/observability/node — Logfire-on-OpenTelemetry for the daemon, relay, CLI.
//
// Frontends MUST NOT import this entry: it pulls the OTel Node SDK. Use
// `@cyborg7/observability/web` in UI / Electron-renderer / Tauri WebView code.
//
// No LOGFIRE_TOKEN ⇒ every API below is a real no-op (configureObservability
// short-circuits and the rest read the disabled state), so an end-user npm
// install stays silent.

export { configureObservability } from "./config.js";
export type { ConfigureObservabilityOptions } from "./config.js";
export { getScopedLogger } from "./logger.js";
export type { ScopedLogger } from "./logger.js";
export { logError } from "./errors.js";
export { withSpan } from "./span.js";
export type { SpanLike } from "./span.js";
export { flush, shutdown } from "./lifecycle.js";
export { attachPinoBridge } from "./pino-bridge.js";

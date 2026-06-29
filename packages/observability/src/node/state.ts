import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

// Single OTel scope for the whole platform — mirrors v1's `service.name = "cyborg7"`
// and the Python project's single `service_name`. The Logfire JS SDK takes ONE
// global `otelScope` (no per-logger `custom_scope_suffix` like Python), so we use
// this constant and express the per-logger scope as a `scope:<name>` tag instead.
export const OTEL_SCOPE = "cyborg7";

// Shared module-level observability state. A SINGLE instance per process — the
// node entry points all read from here. When `enabled` is false (no token) every
// public API is a no-op, which is how an end-user `npm install` of a Cyborg7
// package stays silent.
export interface ObservabilityState {
  enabled: boolean;
  configured: boolean;
  // Global tags applied to every span/log: the literal scope + platform + version.
  globalTags: string[];
  // Logfire `environment` (deployment.environment.name). Empty when disabled.
  environment: string;
  // Held only so flush()/shutdown() can forceFlush() the exporter. Null when disabled.
  provider: NodeTracerProvider | null;
}

const state: ObservabilityState = {
  enabled: false,
  configured: false,
  globalTags: [],
  environment: "",
  provider: null,
};

export function getState(): ObservabilityState {
  return state;
}

// Test-only: reset the module-level guard so each test starts from a clean slate.
// Never called from production code paths.
export function __resetStateForTests(): void {
  state.enabled = false;
  state.configured = false;
  state.globalTags = [];
  state.environment = "";
  state.provider = null;
}

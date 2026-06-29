import { getState } from "./state.js";

/**
 * Best-effort flush of pending spans to Logfire. For short-lived processes (CLI,
 * one-shot jobs) call this before exit so the SimpleSpanProcessor's exporter
 * drains. No-op + never throws when observability is disabled. Ported from v1's
 * `shutdown()` (provider.forceFlush wrapped in try/catch).
 */
export async function flush(): Promise<void> {
  const provider = getState().provider;
  if (!provider) return;
  try {
    await provider.forceFlush();
  } catch {
    // best effort
  }
}

/**
 * Flush then shut down the tracer provider. For process teardown. No-op + never
 * throws when disabled.
 */
export async function shutdown(): Promise<void> {
  const provider = getState().provider;
  if (!provider) return;
  try {
    await provider.forceFlush();
  } catch {
    // best effort
  }
  try {
    await provider.shutdown();
  } catch {
    // best effort
  }
}

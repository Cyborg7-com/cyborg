import { SpanStatusCode, trace } from "@opentelemetry/api";
import * as logfire from "logfire";
import { getState } from "./state.js";

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

/**
 * The canonical error sink. Records an exception under `scope` with `ctx`
 * attributes through BOTH the Logfire exception API (`reportError`) and, when a
 * span is currently active, the OTel span (`recordException` + `setStatus(ERROR)`).
 *
 * Never throws — an error inside the error reporter must not crash the caller.
 * When observability is disabled (no token) this is a no-op.
 */
export function logError(scope: string, err: unknown, ctx?: Record<string, unknown>): void {
  const state = getState();
  if (!state.enabled) return;

  const error = toError(err);
  const attributes: Record<string, unknown> = { scope, ...ctx };

  try {
    logfire.reportError(error.message || `error in ${scope}`, error, attributes);
  } catch {
    // The error sink must never throw.
  }

  try {
    const span = trace.getActiveSpan();
    if (span) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    }
  } catch {
    // Best effort — recording on the span is opportunistic.
  }
}

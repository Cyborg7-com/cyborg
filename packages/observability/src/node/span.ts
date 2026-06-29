import type { Span } from "@opentelemetry/api";
import { span as logfireSpan } from "logfire";
import { getState } from "./state.js";

// Minimal span surface the callback receives. Ported from v1's
// `instrumentation.ts` so call sites that only touch `setAttributes` keep working
// whether observability is enabled (a real OTel span) or disabled (the noop).
export interface SpanLike {
  setAttributes(attrs: Record<string, string | number | boolean>): void;
}

const noopSpan: SpanLike = { setAttributes() {} };

/**
 * Run `fn` inside a Logfire span named `name` with `attributes`. Ported from v1's
 * `lambda/audit-evaluator/src/instrumentation.ts`: when observability is disabled
 * the function runs against a noop span (no telemetry, zero overhead). `undefined`
 * attribute values are stripped, matching v1.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  const cleanAttrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v !== undefined) cleanAttrs[k] = v;
  }

  const state = getState();
  if (!state.enabled) {
    return fn(noopSpan);
  }

  return logfireSpan(name, {
    attributes: cleanAttrs,
    tags: state.globalTags,
    callback: (activeSpan: Span) => fn(activeSpan as unknown as SpanLike),
  });
}

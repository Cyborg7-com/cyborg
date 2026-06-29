import * as logfire from "logfire";
import { getState } from "./state.js";

// The Logfire JS SDK is functional (logfire.info/warning/error/…), unlike the
// Python SDK's `logfire.with_settings(custom_scope_suffix=…).with_tags(…)`. A
// ScopedLogger is the JS-idiomatic analogue: a thin object bound to a `scope`
// that injects the merged tag set (global + `scope:<scope>` + per-call) into every
// call. Same hierarchy as Python (project → agent/scope → log), expressed as tags.
export interface ScopedLogger {
  trace(message: string, attributes?: Record<string, unknown>): void;
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  notice(message: string, attributes?: Record<string, unknown>): void;
  warning(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
  fatal(message: string, attributes?: Record<string, unknown>): void;
}

const NOOP_LOGGER: ScopedLogger = {
  trace() {},
  debug() {},
  info() {},
  notice() {},
  warning() {},
  error() {},
  fatal() {},
};

// Merge global tags + the scope tag + per-call tags, de-duplicated and order-
// stable. Exported for unit testing the tag-merge contract.
export function mergeScopeTags(
  globalTags: string[],
  scope: string,
  callTags: string[] | undefined,
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  const push = (tag: string): void => {
    if (!seen.has(tag)) {
      seen.add(tag);
      merged.push(tag);
    }
  };
  for (const tag of globalTags) push(tag);
  push(`scope:${scope}`);
  for (const tag of callTags ?? []) push(tag);
  return merged;
}

/**
 * Returns a Logfire logger bound to `scope`, merging the global tag set with the
 * per-logger `tags`. Mirrors the Jex `get_agent_logfire(scope, tags)` shape.
 *
 * When observability is disabled (no token) this returns a no-op logger — every
 * method is a silent no-op, never throws.
 */
export function getScopedLogger(scope: string, tags?: string[]): ScopedLogger {
  const state = getState();
  if (!state.enabled) {
    return NOOP_LOGGER;
  }

  const baseTags = mergeScopeTags(state.globalTags, scope, tags);
  const emit =
    (fn: (msg: string, attrs?: Record<string, unknown>, opts?: logfire.LogOptions) => void) =>
    (message: string, attributes?: Record<string, unknown>): void => {
      fn(message, attributes, { tags: baseTags });
    };

  return {
    trace: emit(logfire.trace),
    debug: emit(logfire.debug),
    info: emit(logfire.info),
    notice: emit(logfire.notice),
    warning: emit(logfire.warning),
    error: emit(logfire.error),
    fatal: emit(logfire.fatal),
  };
}

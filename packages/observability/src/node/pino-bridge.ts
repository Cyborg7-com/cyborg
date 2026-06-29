import type { Logger } from "pino";
import { logError } from "./errors.js";
import { getState } from "./state.js";

// Marker so attachPinoBridge is idempotent and never double-wraps a logger
// (re-running it on the same instance, or on a child of an already-bridged parent).
const BRIDGED = Symbol.for("@cyborg7/observability.pinoBridged");

interface MaybeBridged {
  [BRIDGED]?: boolean;
}

// The slice of pino's surface this bridge touches. Keeping it loose (vs the
// generic `Logger<CustomLevels>`) lets attachPinoBridge accept any pino logger —
// including custom-level and child loggers — without fighting pino's generics.
interface PinoLike {
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(...args: unknown[]): PinoLike;
  bindings?(): Record<string, unknown>;
}

// Pull a scope out of pino's bindings — `createChildLogger` sets `{ name }`, so a
// child error is attributed to its component. Falls back to "pino".
function resolveScope(logger: PinoLike): string {
  try {
    const bindings = logger.bindings?.() as { name?: unknown } | undefined;
    if (bindings && typeof bindings.name === "string" && bindings.name) {
      return bindings.name;
    }
  } catch {
    // bindings() can throw on exotic logger shapes — fall through.
  }
  return "pino";
}

// pino error calls take one of: error(err), error(err, msg), error({ err|error }, msg),
// or error(msg). Extract the Error (if any) plus the remaining context object so we
// can mirror it to Logfire without disturbing pino's own record.
function extractError(args: unknown[]): { err: unknown; ctx: Record<string, unknown> } {
  const [first] = args;
  if (first instanceof Error) {
    return { err: first, ctx: {} };
  }
  if (first && typeof first === "object") {
    const obj = first as Record<string, unknown>;
    const candidate = obj.err ?? obj.error;
    if (candidate !== undefined) {
      const { err: _err, error: _error, ...rest } = obj;
      return { err: candidate, ctx: rest };
    }
  }
  return { err: undefined, ctx: {} };
}

// pino's `child.error(...)` delegates the actual write UP to the root instance's
// method, so a bridged child AND its bridged parent would both fire — double-
// mirroring the same record, attributed to the wrong (parent) scope. This guard
// makes the OUTERMOST (most-derived) wrapper own the single mirror: it reports
// with its own scope, then sets the flag while delegating to the parent's method
// so the parent wrapper skips its mirror. Sync log calls can't interleave, so a
// simple boolean is sufficient.
let mirroring = false;

function wrapLevel(logger: PinoLike, level: "error" | "fatal"): void {
  const original = logger[level].bind(logger);
  logger[level] = (...args: unknown[]): void => {
    // pino runs first and unchanged — its file sink + REDACT_PATHS redaction stay
    // intact because we call the real method.
    const alreadyMirroring = mirroring;
    mirroring = true;
    try {
      original(...args);
    } finally {
      mirroring = alreadyMirroring;
    }
    if (alreadyMirroring) return; // a more-derived wrapper already owns this record
    const { err, ctx } = extractError(args);
    if (err !== undefined) {
      logError(resolveScope(logger), err, ctx);
    }
  };
}

/**
 * Hook an existing pino logger so records at level >= 50 (error / fatal) ALSO emit
 * a Logfire exception (the serialized `err`/`error` field), WITHOUT replacing pino
 * — its file sink and REDACT_PATHS redaction stay intact, and call sites are
 * unchanged (they still call `logger.error(...)`). Children inherit the bridge.
 *
 * Idempotent, and a no-op when observability is disabled. The bridge is applied to
 * the live instance, so `pino` stays the source of truth for console/file output;
 * Logfire only mirrors the exception.
 */
export function attachPinoBridge<L extends Logger>(logger: L): L {
  const state = getState();
  if (!state.enabled) return logger;

  const pino = logger as unknown as PinoLike & MaybeBridged;
  // OWN-property check only: pino children prototype-inherit from their parent, so
  // a child would otherwise read the parent's BRIDGED via the chain and skip its
  // own wrap — leaving child errors mis-attributed to the parent's scope.
  if (Object.prototype.hasOwnProperty.call(pino, BRIDGED)) return logger;
  pino[BRIDGED] = true;

  wrapLevel(pino, "error");
  wrapLevel(pino, "fatal");

  // Propagate to children so component loggers (createChildLogger → { name })
  // mirror too, attributed to their own scope, without callers re-bridging.
  const originalChild = pino.child.bind(pino);
  pino.child = (...args: unknown[]): PinoLike => {
    const child = originalChild(...args);
    return attachPinoBridge(child as unknown as Logger) as unknown as PinoLike;
  };

  return logger;
}

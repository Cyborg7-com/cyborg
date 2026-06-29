// AuditSink — the minimal re-route seam that lets an existing `cyborg/` pino call
// ALSO emit a structured AuditEvent onto the Logs-tab stream. The pino line stays
// (ops still get daemon.log / Logfire); the sink is one extra `sink.emit({...})`
// next to it.
//
// This is deliberately a PER-SITE sink, NOT a generic "tap every pino log"
// interceptor — a global tap would sweep Paseo `agent/` upstream logs into the
// workspace stream (a package-boundary violation), can't redact safely, and
// floods. Only the explicitly-chosen `cyborg/` traces are re-routed.
//
// Two guarantees the seam relies on:
//   1. `emit` is BEST-EFFORT and NEVER THROWS — a spawn / reaper / credential write
//      must never fail because an audit broadcast threw (same contract as the
//      task-event seam's try/caught broadcast).
//   2. `debug`-level events are gated behind `CYBORG7_AUDIT_VERBOSE` (default off):
//      high-frequency low-signal events (silent autonomy-gate skips, dedup-guard
//      returns, per-stream broadcast warnings) emit NOTHING unless verbose is on —
//      identical to today's behavior, zero flood risk.

import type { AuditEvent } from "./audit-event-log.js";

export interface AuditSink {
  // Best-effort, never throws. A `debug` event is dropped unless verbose is on.
  emit(event: AuditEvent): void;
}

// Whether `debug`-level audit events should be emitted. Env, default OFF. Any of
// `1`/`true`/`on`/`yes` (case-insensitive) enables; unset / anything else disables.
export function isAuditVerbose(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.CYBORG7_AUDIT_VERBOSE;
  if (!raw) return false;
  return ["1", "true", "on", "yes"].includes(raw.trim().toLowerCase());
}

// A broadcast function the sink fans each (formatted) event through. The daemon
// binds this to `MessageRouter.broadcastAuditEvent`; the relay to
// `emitAuditEventForWorkspace`. It may throw — the sink swallows it.
export type AuditBroadcastFn = (event: AuditEvent) => void;

/**
 * Build an AuditSink backed by a broadcast function. Drops `debug` events unless
 * `CYBORG7_AUDIT_VERBOSE` is set, and swallows any broadcast error so the calling
 * operation always completes normally.
 */
export function createAuditSink(
  broadcast: AuditBroadcastFn,
  opts: { verbose?: boolean } = {},
): AuditSink {
  const verbose = opts.verbose ?? isAuditVerbose();
  return {
    emit(event: AuditEvent): void {
      if (event.level === "debug" && !verbose) return;
      try {
        broadcast(event);
      } catch {
        // intentional: observability fan-out is best-effort; a broadcast failure
        // must not poison the operation it rides on.
      }
    },
  };
}

// A no-op sink for callers that have no transport wired (existing call sites /
// tests that don't assert on audit). `emit` does nothing.
export const NOOP_AUDIT_SINK: AuditSink = { emit() {} };

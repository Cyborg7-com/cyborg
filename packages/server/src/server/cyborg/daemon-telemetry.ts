// Daemon → relay telemetry over the existing daemon WebSocket.
//
// Daemons run on USERS' machines with no CloudWatch credentials, but they are
// already connected to the relay over WS. We reuse that channel to make
// daemon-side failures (cybo spawn, provider/quota errors) visible CENTRALLY —
// the relay logs each telemetry event through its pino logger (JSON → stdout →
// the /cyborg7/relay log group), where ops can actually see it. This complements
// #736 (which routes the daemon's own console.error → its LOCAL daemon.log): the
// LOG stays local, the TELEMETRY goes central. Distinct sinks, no overlap.
//
// The module is PURE (no I/O, no WS, no Date) so the failure-handling decision is
// trivially unit-testable: `buildCyboSpawnFailureOutcome` turns an error + context
// into (a) the structured telemetry event and (b) the author-facing channel notice.

import { z } from "zod";

const REASON_MAX = 500;
const STACK_MAX = 4000;

// The closed set of telemetry kinds. `cybo_spawn_failure` is the first; run-time
// provider/quota errors (an agent turn failing AFTER a successful spawn) will add
// `cybo_run_failure` on the same frame — kept as an enum so the relay log schema
// and any future routing stay exhaustive.
export const DaemonTelemetryKindSchema = z.enum(["cybo_spawn_failure"]);
export type DaemonTelemetryKind = z.infer<typeof DaemonTelemetryKindSchema>;

export const DaemonTelemetryEventSchema = z.object({
  kind: DaemonTelemetryKindSchema,
  cyboId: z.string().max(256).nullable(),
  channelId: z.string().max(256).nullable(),
  workspaceId: z.string().max(256).nullable(),
  // The harness/provider the cybo would run on (claude / codex / pi / …), when known.
  provider: z.string().max(256).nullable(),
  // One-line human reason (the error message). The sending daemon caps it, but the
  // relay must NOT trust that — a compromised/buggy daemon could send a huge string
  // and bloat the /cyborg7/relay log. The schema enforces the cap on receipt.
  reason: z.string().max(REASON_MAX),
  // Full stack for debugging, capped (same defense-in-depth as reason). Null when
  // the thrown value carried none.
  stack: z.string().max(STACK_MAX).nullable(),
  // Epoch ms — passed in by the caller (the pure builder never reads the clock).
  at: z.number(),
});
export type DaemonTelemetryEvent = z.infer<typeof DaemonTelemetryEventSchema>;

// The WS frame the daemon sends to the relay. `cyborg:telemetry` terminates at the
// relay (logged, not forwarded to clients).
export const DaemonTelemetryFrameSchema = z.object({
  type: z.literal("cyborg:telemetry"),
  event: DaemonTelemetryEventSchema,
});
export type DaemonTelemetryFrame = z.infer<typeof DaemonTelemetryFrameSchema>;

// Normalize any thrown value into a (reason, stack) pair, capped.
export function describeError(err: unknown): { reason: string; stack: string | null } {
  if (err instanceof Error) {
    const reason = (err.message || err.name || "unknown error").slice(0, REASON_MAX);
    const stack = err.stack ? err.stack.slice(0, STACK_MAX) : null;
    return { reason, stack };
  }
  return { reason: String(err).slice(0, REASON_MAX), stack: null };
}

export interface CyboSpawnFailureContext {
  err: unknown;
  cyboId: string | null;
  cyboSlug: string | null;
  provider: string | null;
  channelId: string | null;
  workspaceId: string | null;
  authorUserId: string;
  at: number;
}

export interface CyboSpawnFailureOutcome {
  telemetry: DaemonTelemetryEvent;
  // Author-only ephemeral channel notice — same shape MessageRouter already
  // broadcasts via cyborg:cybo_mention_notice, so the caller just forwards it.
  notice: {
    type: "cyborg:cybo_mention_notice";
    payload: {
      toUserId: string;
      workspaceId: string | null;
      channelId: string | null;
      text: string;
    };
  };
}

// Pure: error + context → the telemetry event AND the author notice. The caller
// (MessageRouter's spawn catch) sends `telemetry` over the relay client and
// broadcasts `notice` to the author. Tested in isolation — no WS, no storage.
export function buildCyboSpawnFailureOutcome(
  ctx: CyboSpawnFailureContext,
): CyboSpawnFailureOutcome {
  const { reason, stack } = describeError(ctx.err);
  const label = ctx.cyboSlug ? `@${ctx.cyboSlug}` : "The cybo";
  return {
    telemetry: {
      kind: "cybo_spawn_failure",
      cyboId: ctx.cyboId,
      channelId: ctx.channelId,
      workspaceId: ctx.workspaceId,
      provider: ctx.provider,
      reason,
      stack,
      at: ctx.at,
    },
    notice: {
      type: "cyborg:cybo_mention_notice",
      payload: {
        toUserId: ctx.authorUserId,
        workspaceId: ctx.workspaceId,
        channelId: ctx.channelId,
        text: `${label} couldn't run: ${reason}`,
      },
    },
  };
}

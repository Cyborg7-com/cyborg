// User "send later" scheduled posts (#607) — the PURE send-decision core, shared
// by the daemon runner (ScheduledMessageRunner, DualStorage + MessageRouter) and
// the cloud relay tick (relay-standalone.ts, PgSync + relay broadcast). Kept free
// of any storage/transport so the authority re-validation + closed-set error_code
// mapping (the Mattermost ScheduledPost.ErrorCode lesson) is unit-tested directly
// instead of asserted through a live DB.

import type { ScheduledMessageErrorCode } from "./storage.js";

// The minimal facts the decision needs about a scheduled row's target. Channel
// posts and DMs differ: a channel can be missing or archived; a DM peer can be
// deleted. Authority (can the author still send here?) is shared.
export interface ScheduledSendContext {
  // Is exactly one of channelId / toId set? (A malformed row with neither/both
  // can never fire — it's failed as unknown_error rather than looping.)
  channelId: string | null;
  toId: string | null;
  // The author can still send_message in this workspace (membership + role at
  // SEND time — re-validated, since the author may have lost access since
  // scheduling). False → no_permission.
  authorCanSend: boolean;
  // Channel-post target state (ignored for DMs):
  //   channelExists — the channel row is present (FK not null'd by a delete).
  //   channelArchived — the channel is archived (closed to new posts).
  channelExists: boolean;
  channelArchived: boolean;
  // DM target state (ignored for channel posts): the recipient user still exists.
  recipientExists: boolean;
}

// The outcome of evaluating a due row BEFORE the actual send. "send" means
// proceed; otherwise a closed-set error_code to stamp (a failed scheduled send is
// SHOWN, never silently dropped).
export type ScheduledSendDecision =
  | { kind: "send" }
  | { kind: "fail"; errorCode: ScheduledMessageErrorCode };

// Decide whether a due scheduled message may fire, re-validating authority + the
// target at send time. Order matters: authority first (a deauthorized author
// can't post anywhere), then target existence, then archived state. A row with
// neither or both of channelId/toId is structurally unfireable → unknown_error.
export function decideScheduledSend(ctx: ScheduledSendContext): ScheduledSendDecision {
  const isChannel = ctx.channelId !== null && ctx.toId === null;
  const isDm = ctx.toId !== null && ctx.channelId === null;
  if (!isChannel && !isDm) {
    // Malformed (no target, or both) — can't ever fire; fail it so it stops being
    // due instead of looping forever.
    return { kind: "fail", errorCode: "unknown_error" };
  }

  // Authority is re-checked at SEND time: the author may have been removed from
  // the workspace (or had their role demoted below send_message) after scheduling.
  if (!ctx.authorCanSend) {
    return { kind: "fail", errorCode: "no_permission" };
  }

  if (isChannel) {
    // The channel FK is set to null on delete (see the migration), so a missing
    // channel row means the channel was deleted between schedule and fire.
    if (!ctx.channelExists) {
      return { kind: "fail", errorCode: "channel_not_found" };
    }
    if (ctx.channelArchived) {
      return { kind: "fail", errorCode: "channel_archived" };
    }
    return { kind: "send" };
  }

  // DM: the recipient must still exist.
  if (!ctx.recipientExists) {
    return { kind: "fail", errorCode: "user_deleted" };
  }
  return { kind: "send" };
}

// A scheduled row is due to fire when it hasn't been processed yet AND its
// send_at has arrived. The daemon/relay queries already filter on this; the
// predicate is exported so the "what counts as due" rule is tested in one place
// and can't drift between the SQL and any in-memory re-check.
export function isScheduledMessageDue(
  row: { processed_at: number | null; send_at: number },
  now: number,
): boolean {
  return row.processed_at === null && row.send_at <= now;
}

import { describe, it, expect } from "vitest";
import {
  decideScheduledSend,
  isScheduledMessageDue,
  type ScheduledSendContext,
} from "./scheduled-message-send.js";

// Pure unit tests for the send-decision core of user "send later" (#607). No DB,
// no transport — every branch of the closed-set error_code mapping + the "is due"
// predicate is asserted directly. Mirrors the module's own doc: a failed scheduled
// send is SHOWN (a fail with a code), never silently dropped, and authority is
// re-validated BEFORE the target so a deauthorized author can't probe targets.

// Base context = a healthy channel post by an authorized author. Each test flips
// exactly the fields under test so the asserted branch is unambiguous.
function ctx(over: Partial<ScheduledSendContext> = {}): ScheduledSendContext {
  return {
    channelId: "ch_1",
    toId: null,
    authorCanSend: true,
    channelExists: true,
    channelArchived: false,
    recipientExists: true,
    ...over,
  };
}

describe("decideScheduledSend — channel posts (#607)", () => {
  it("sends when the author can post and the channel exists + is not archived", () => {
    expect(decideScheduledSend(ctx())).toEqual({ kind: "send" });
  });

  it("fails no_permission when the author can no longer send", () => {
    expect(decideScheduledSend(ctx({ authorCanSend: false }))).toEqual({
      kind: "fail",
      errorCode: "no_permission",
    });
  });

  it("fails channel_not_found when the channel row is gone", () => {
    expect(decideScheduledSend(ctx({ channelExists: false }))).toEqual({
      kind: "fail",
      errorCode: "channel_not_found",
    });
  });

  it("fails channel_archived when the channel is archived", () => {
    expect(decideScheduledSend(ctx({ channelArchived: true }))).toEqual({
      kind: "fail",
      errorCode: "channel_archived",
    });
  });
});

describe("decideScheduledSend — DMs (#607)", () => {
  // A DM has toId set and channelId null; channel fields are ignored.
  function dm(over: Partial<ScheduledSendContext> = {}): ScheduledSendContext {
    return ctx({ channelId: null, toId: "user_2", ...over });
  }

  it("sends when the recipient still exists", () => {
    expect(decideScheduledSend(dm())).toEqual({ kind: "send" });
  });

  it("fails user_deleted when the recipient is gone", () => {
    expect(decideScheduledSend(dm({ recipientExists: false }))).toEqual({
      kind: "fail",
      errorCode: "user_deleted",
    });
  });
});

describe("decideScheduledSend — malformed targets (#607)", () => {
  it("fails unknown_error when NEITHER channelId nor toId is set", () => {
    expect(decideScheduledSend(ctx({ channelId: null, toId: null }))).toEqual({
      kind: "fail",
      errorCode: "unknown_error",
    });
  });

  it("fails unknown_error when BOTH channelId and toId are set", () => {
    expect(decideScheduledSend(ctx({ channelId: "ch_1", toId: "user_2" }))).toEqual({
      kind: "fail",
      errorCode: "unknown_error",
    });
  });
});

describe("decideScheduledSend — check order: authority before target (#607)", () => {
  it("a deauthorized author on a missing channel fails no_permission, not channel_not_found", () => {
    // Authority is checked first, so the author never learns the channel is gone.
    expect(decideScheduledSend(ctx({ authorCanSend: false, channelExists: false }))).toEqual({
      kind: "fail",
      errorCode: "no_permission",
    });
  });

  it("a deauthorized author on an archived channel still fails no_permission first", () => {
    expect(decideScheduledSend(ctx({ authorCanSend: false, channelArchived: true }))).toEqual({
      kind: "fail",
      errorCode: "no_permission",
    });
  });

  it("a deauthorized author DMing a deleted recipient fails no_permission first", () => {
    expect(
      decideScheduledSend(
        ctx({ channelId: null, toId: "user_2", authorCanSend: false, recipientExists: false }),
      ),
    ).toEqual({ kind: "fail", errorCode: "no_permission" });
  });

  it("malformed-target check precedes authority (no target → unknown_error even if deauthorized)", () => {
    // A structurally unfireable row is unknown_error regardless of authority, so it
    // stops being due instead of looping.
    expect(decideScheduledSend(ctx({ channelId: null, toId: null, authorCanSend: false }))).toEqual(
      { kind: "fail", errorCode: "unknown_error" },
    );
  });
});

describe("isScheduledMessageDue — due predicate (#607)", () => {
  const NOW = 1_000_000_000_000;

  it("is due when unprocessed and send_at is in the past", () => {
    expect(isScheduledMessageDue({ processed_at: null, send_at: NOW - 1 }, NOW)).toBe(true);
  });

  it("is due when unprocessed and send_at exactly equals now (inclusive)", () => {
    expect(isScheduledMessageDue({ processed_at: null, send_at: NOW }, NOW)).toBe(true);
  });

  it("is NOT due when send_at is in the future", () => {
    expect(isScheduledMessageDue({ processed_at: null, send_at: NOW + 1 }, NOW)).toBe(false);
  });

  it("is NOT due once processed, even if send_at is well in the past", () => {
    expect(isScheduledMessageDue({ processed_at: NOW - 5_000, send_at: NOW - 10_000 }, NOW)).toBe(
      false,
    );
  });
});

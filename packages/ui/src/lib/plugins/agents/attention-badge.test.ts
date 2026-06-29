import { describe, expect, it } from "vitest";
import {
  attentionBadgeFor,
  attentionReasonForTurnEvent,
  badgeForReason,
  reconcileAttentionFromSnapshot,
} from "./attention-badge.js";
import type { AgentAttention } from "./types.js";

describe("attentionBadgeFor (snapshot projection → badge)", () => {
  it("returns null when there is no attention object", () => {
    expect(attentionBadgeFor(undefined)).toBeNull();
    expect(attentionBadgeFor(null)).toBeNull();
  });

  it("returns null when requiresAttention is false (regardless of reason)", () => {
    const a: AgentAttention = { requiresAttention: false, reason: "finished" };
    expect(attentionBadgeFor(a)).toBeNull();
  });

  it("maps a finished flag to the Done badge (positive tone)", () => {
    const badge = attentionBadgeFor({ requiresAttention: true, reason: "finished" });
    expect(badge).toEqual({
      reason: "finished",
      label: "Done",
      tone: "done",
      description: "Finished its turn — review the result",
    });
  });

  it("maps an error flag to the Error badge (error tone)", () => {
    const badge = attentionBadgeFor({ requiresAttention: true, reason: "error" });
    expect(badge?.reason).toBe("error");
    expect(badge?.tone).toBe("error");
    expect(badge?.label).toBe("Error");
  });

  it("does NOT render a badge for a 'permission' reason (that has its own UI)", () => {
    // requiresAttention true but reason permission → no derived badge, so the
    // pending-permission chip is the sole surface (no double-count).
    expect(attentionBadgeFor({ requiresAttention: true, reason: "permission" })).toBeNull();
  });

  it("returns null for a missing/unknown reason even when requiresAttention is true", () => {
    expect(attentionBadgeFor({ requiresAttention: true })).toBeNull();
    expect(attentionBadgeFor({ requiresAttention: true, reason: null })).toBeNull();
    expect(
      attentionBadgeFor({ requiresAttention: true, reason: "weird" as unknown as "finished" }),
    ).toBeNull();
  });
});

describe("badgeForReason", () => {
  it("covers finished/error and nulls everything else", () => {
    expect(badgeForReason("finished")?.label).toBe("Done");
    expect(badgeForReason("error")?.label).toBe("Error");
    expect(badgeForReason("permission")).toBeNull();
    expect(badgeForReason(null)).toBeNull();
    expect(badgeForReason(undefined)).toBeNull();
  });
});

describe("attentionReasonForTurnEvent (live transition → reason)", () => {
  it("a completed turn raises 'finished'", () => {
    expect(attentionReasonForTurnEvent("turn_completed")).toBe("finished");
  });

  it("a failed turn raises 'error'", () => {
    expect(attentionReasonForTurnEvent("turn_failed")).toBe("error");
  });

  it("a started turn raises nothing (the agent is active, not 'review me')", () => {
    expect(attentionReasonForTurnEvent("turn_started")).toBeNull();
  });

  it("a canceled turn raises nothing (user-initiated, not an attention edge)", () => {
    expect(attentionReasonForTurnEvent("turn_canceled")).toBeNull();
  });
});

describe("reconcileAttentionFromSnapshot (clear-on-view safety)", () => {
  it("adopts a fresh server-set finished/error reason", () => {
    expect(
      reconcileAttentionFromSnapshot({
        snapshot: { requiresAttention: true, reason: "finished" },
        locallyCleared: false,
      }),
    ).toBe("finished");
    expect(
      reconcileAttentionFromSnapshot({
        snapshot: { requiresAttention: true, reason: "error" },
        locallyCleared: false,
      }),
    ).toBe("error");
  });

  it("does NOT re-raise a flag the user already cleared this session", () => {
    // The clear-on-view transition: even if an in-flight snapshot still says the
    // agent requires attention, a locally-cleared agent stays cleared.
    expect(
      reconcileAttentionFromSnapshot({
        snapshot: { requiresAttention: true, reason: "finished" },
        locallyCleared: true,
      }),
    ).toBeNull();
  });

  it("clears when the server reports it no longer requires attention", () => {
    expect(
      reconcileAttentionFromSnapshot({
        snapshot: { requiresAttention: false },
        locallyCleared: false,
      }),
    ).toBeNull();
    expect(reconcileAttentionFromSnapshot({ snapshot: null, locallyCleared: false })).toBeNull();
    expect(
      reconcileAttentionFromSnapshot({ snapshot: undefined, locallyCleared: false }),
    ).toBeNull();
  });

  it("ignores a 'permission' reason from the snapshot (not a rendered badge)", () => {
    expect(
      reconcileAttentionFromSnapshot({
        snapshot: { requiresAttention: true, reason: "permission" },
        locallyCleared: false,
      }),
    ).toBeNull();
  });
});

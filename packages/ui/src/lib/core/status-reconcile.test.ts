import { describe, expect, it } from "vitest";
import {
  applyStatusChange,
  isActiveStatus,
  reconcileStatusSnapshot,
  type MemberStatus,
} from "./status-reconcile.js";

// #671 client-half reconcile. A status with neither emoji nor text is "cleared"
// and must be ABSENT from the map — that absence is what makes an expired status
// disappear when the server sweep broadcasts the empty shape or omits the user
// from a snapshot. These exercise that decision directly (the rune class in
// state.svelte.ts only assigns what these return).

const cleared: MemberStatus = { emoji: null, text: null, expiresAt: null };

describe("isActiveStatus", () => {
  it("is true with an emoji or text, false when both are empty", () => {
    expect(isActiveStatus({ emoji: "🍔", text: null, expiresAt: null })).toBe(true);
    expect(isActiveStatus({ emoji: null, text: "lunch", expiresAt: null })).toBe(true);
    expect(isActiveStatus(cleared)).toBe(false);
  });
});

describe("reconcileStatusSnapshot (#671)", () => {
  it("builds a fresh map keeping only active statuses (absent users are dropped)", () => {
    const next = reconcileStatusSnapshot([
      { userId: "a", emoji: "🍔", text: "lunch", expiresAt: 123 },
      { userId: "b", ...cleared }, // empty in snapshot → not kept
    ]);
    expect(next).toEqual({ a: { emoji: "🍔", text: "lunch", expiresAt: 123 } });
    expect(next).not.toHaveProperty("b");
  });

  it("returns a brand-new object (snapshot replaces, never merges prior state)", () => {
    // A regression to a merge would strand a user who expired and is now absent.
    const empty = reconcileStatusSnapshot([]);
    expect(empty).toEqual({});
  });
});

describe("applyStatusChange (#671)", () => {
  const current: Record<string, MemberStatus> = {
    a: { emoji: "🍔", text: "lunch", expiresAt: 123 },
  };

  it("stores an active status without mutating the input map", () => {
    const next = applyStatusChange(current, "b", { emoji: "🌴", text: null, expiresAt: 456 });
    expect(next).toEqual({
      a: { emoji: "🍔", text: "lunch", expiresAt: 123 },
      b: { emoji: "🌴", text: null, expiresAt: 456 },
    });
    expect(current).not.toHaveProperty("b"); // input untouched
  });

  it("DROPS the entry on a cleared status (the expiry-sweep clear broadcast)", () => {
    const next = applyStatusChange(current, "a", cleared);
    expect(next).not.toHaveProperty("a");
  });
});

import { describe, it, expect } from "vitest";
import { stableAttachId, rememberAttachId, forgetAttachId } from "./terminal-attach-id.js";

// #778/#779 regression: the attachId must be STABLE across remounts of the same
// terminal in one app realm so a remount re-presents the same id and the daemon
// replaces this view's attacher in place instead of stacking a duplicate (which
// double-rendered output/echo: `ls` → `llss`).

describe("stableAttachId (#778/#779)", () => {
  it("returns the SAME id across remounts of a known terminalId", () => {
    const a = stableAttachId("term-x");
    const b = stableAttachId("term-x");
    expect(a).toBe(b);
  });

  it("returns DISTINCT ids for different terminalIds (independent views)", () => {
    expect(stableAttachId("term-a")).not.toBe(stableAttachId("term-b"));
  });

  it("mints a fresh id for a brand-new start (no terminalId yet)", () => {
    expect(stableAttachId(undefined)).not.toBe(stableAttachId(undefined));
  });

  it("rememberAttachId pins a fresh-start id to its terminalId so a later remount reuses it", () => {
    const startId = stableAttachId(undefined);
    rememberAttachId("term-pinned", startId);
    expect(stableAttachId("term-pinned")).toBe(startId);
  });

  it("forgetAttachId drops the mapping so a recycled id can't be reused after the pty is gone", () => {
    const first = stableAttachId("term-gone");
    forgetAttachId("term-gone");
    expect(stableAttachId("term-gone")).not.toBe(first);
  });
});

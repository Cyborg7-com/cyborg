import { describe, expect, it, vi } from "vitest";
import { createSeqGapState, recoverSeqGap, type SeqGapDeps } from "./seq-gap-recovery.js";

// #639: a seq-gap on an OPEN socket can swallow ROSTER broadcasts, not just
// messages, so recovery must reconcile the panels — not only drain messages.
// This exercises the REAL orchestration (recoverSeqGap, extracted from the
// onSeqGap handler) with spies standing in for drainSync / catchUpDm /
// reconcileWorkspacePanels, the #638 behavior-over-source-grep pattern.

const WS = "ws_1";

function makeDeps(over: Partial<SeqGapDeps> = {}): {
  deps: SeqGapDeps;
  spies: {
    drainMessages: ReturnType<typeof vi.fn>;
    catchUpDm: ReturnType<typeof vi.fn>;
    reconcilePanels: ReturnType<typeof vi.fn>;
  };
} {
  const spies = {
    drainMessages: vi.fn(async () => {}),
    catchUpDm: vi.fn(async () => {}),
    reconcilePanels: vi.fn(async () => {}),
  };
  return {
    spies,
    deps: {
      isActiveWorkspace: () => true,
      now: () => 1_000_000,
      drainMessages: spies.drainMessages,
      catchUpDm: spies.catchUpDm,
      reconcilePanels: spies.reconcilePanels,
      ...over,
    },
  };
}

describe("recoverSeqGap (#639)", () => {
  it("drains messages AND reconciles roster panels", async () => {
    const { deps, spies } = makeDeps();
    await recoverSeqGap(WS, deps, createSeqGapState(), 10_000);
    expect(spies.drainMessages).toHaveBeenCalledWith(WS);
    expect(spies.catchUpDm).toHaveBeenCalledWith(WS);
    expect(spies.reconcilePanels).toHaveBeenCalledWith(WS); // the #639 fix
  });

  it("reconciles AFTER draining messages (order)", async () => {
    const calls: string[] = [];
    const { deps } = makeDeps({
      drainMessages: vi.fn(async () => void calls.push("drain")),
      reconcilePanels: vi.fn(async () => void calls.push("reconcile")),
    });
    await recoverSeqGap(WS, deps, createSeqGapState(), 10_000);
    expect(calls).toEqual(["drain", "reconcile"]);
  });

  it("does nothing when the gap is for a non-active workspace", async () => {
    const { deps, spies } = makeDeps({ isActiveWorkspace: () => false });
    await recoverSeqGap(WS, deps, createSeqGapState(), 10_000);
    expect(spies.drainMessages).not.toHaveBeenCalled();
    expect(spies.reconcilePanels).not.toHaveBeenCalled();
  });

  it("skips reconcile if the workspace changed mid-recovery (after the drain await)", async () => {
    let active = true;
    const drainMessages = vi.fn(async () => {
      active = false; // user switched workspace while draining
    });
    const { deps, spies } = makeDeps({ isActiveWorkspace: () => active, drainMessages });
    await recoverSeqGap(WS, deps, createSeqGapState(), 10_000);
    expect(drainMessages).toHaveBeenCalledTimes(1);
    expect(spies.reconcilePanels).not.toHaveBeenCalled();
  });

  it("coalesces: a second gap within the min-interval is a no-op", async () => {
    const state = createSeqGapState();
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t });
    await recoverSeqGap(WS, deps, state, 10_000);
    t += 5_000; // < 10s later
    await recoverSeqGap(WS, deps, state, 10_000);
    expect(spies.reconcilePanels).toHaveBeenCalledTimes(1);
  });

  it("runs again once the min-interval has elapsed", async () => {
    const state = createSeqGapState();
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t });
    await recoverSeqGap(WS, deps, state, 10_000);
    t += 10_001; // > 10s later
    await recoverSeqGap(WS, deps, state, 10_000);
    expect(spies.reconcilePanels).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight lock even when a dep throws (best-effort)", async () => {
    const state = createSeqGapState();
    let t = 1_000_000;
    const { deps, spies } = makeDeps({
      now: () => t,
      reconcilePanels: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await recoverSeqGap(WS, deps, state, 10_000);
    expect(state.inFlight.has(WS)).toBe(false);
    // A later gap (past the interval) still runs — the throw didn't wedge it.
    t += 10_001;
    await recoverSeqGap(WS, deps, state, 10_000);
    expect(spies.drainMessages).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createUnreadReconcileState,
  reconcileUnread,
  type UnreadReconcileDeps,
} from "./unread-reconcile.js";

// #672: the red unread badge lives in PERSISTED localStorage and only
// self-corrects on a fetch_unread reseed, which onForeground() previously ran
// ONLY when away ≥ 30s + a needed reconnect — so a brief background → read
// elsewhere → foreground left the stale badge. This exercises the REAL
// orchestration (reconcileUnread, extracted from the onForeground handler) with a
// spy standing in for the per-workspace fetch_unread → seedCounts reseed, the
// behavior-over-source-grep pattern used by seq-gap-recovery.test.ts.

function makeDeps(over: Partial<UnreadReconcileDeps> = {}): {
  deps: UnreadReconcileDeps;
  spies: { reconcileWorkspaceUnread: ReturnType<typeof vi.fn> };
} {
  const spies = { reconcileWorkspaceUnread: vi.fn(async () => {}) };
  return {
    spies,
    deps: {
      listWorkspaceIds: () => ["ws_1", "ws_2"],
      now: () => 1_000_000,
      reconcileWorkspaceUnread: spies.reconcileWorkspaceUnread,
      ...over,
    },
  };
}

describe("reconcileUnread (#672)", () => {
  it("reconciles every workspace's unread on foreground (the fix)", async () => {
    const { deps, spies } = makeDeps();
    await reconcileUnread(deps, createUnreadReconcileState(), 10_000);
    expect(spies.reconcileWorkspaceUnread).toHaveBeenCalledWith("ws_1");
    expect(spies.reconcileWorkspaceUnread).toHaveBeenCalledWith("ws_2");
    expect(spies.reconcileWorkspaceUnread).toHaveBeenCalledTimes(2);
  });

  it("coalesces: a second foreground within the min-interval is a no-op", async () => {
    const state = createUnreadReconcileState();
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t });
    await reconcileUnread(deps, state, 10_000);
    t += 5_000; // < 10s later (rapid background/foreground flap)
    await reconcileUnread(deps, state, 10_000);
    expect(spies.reconcileWorkspaceUnread).toHaveBeenCalledTimes(2); // one pass, 2 workspaces
  });

  it("runs again once the min-interval has elapsed", async () => {
    const state = createUnreadReconcileState();
    let t = 1_000_000;
    const { deps, spies } = makeDeps({ now: () => t });
    await reconcileUnread(deps, state, 10_000);
    t += 10_001; // > 10s later
    await reconcileUnread(deps, state, 10_000);
    expect(spies.reconcileWorkspaceUnread).toHaveBeenCalledTimes(4); // two passes × 2 workspaces
  });

  it("does not re-enter while a reconcile is already in flight", async () => {
    const state = createUnreadReconcileState();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reconcileWorkspaceUnread = vi.fn(async () => {
      await gate;
    });
    const { deps } = makeDeps({ reconcileWorkspaceUnread });
    const first = reconcileUnread(deps, state, 10_000);
    // A foreground event arrives while the first reconcile is still awaiting.
    await reconcileUnread(deps, state, 10_000);
    expect(reconcileWorkspaceUnread).toHaveBeenCalledTimes(2); // only the first pass started
    release();
    await first;
  });

  it("no-swallow: a failed reconcile does NOT arm the min-interval (next foreground retries)", async () => {
    const state = createUnreadReconcileState();
    let t = 1_000_000;
    let fail = true;
    const reconcileWorkspaceUnread = vi.fn(async (wsId: string) => {
      if (fail) throw new Error(`transport down for ${wsId}`);
    });
    const { deps } = makeDeps({ now: () => t, reconcileWorkspaceUnread });
    await reconcileUnread(deps, state, 10_000); // both fail → lastRun NOT bumped
    expect(state.inFlight).toBe(false); // lock released despite the throw
    expect(state.lastRun).toBe(0); // unarmed — the persisted-stale cache isn't blessed
    fail = false;
    t += 1_000; // well within the min-interval — but the failure left it unarmed
    await reconcileUnread(deps, state, 10_000);
    // The retry ran immediately instead of being coalesced away → the stale badge
    // never outlives a successful server reconcile.
    expect(reconcileWorkspaceUnread).toHaveBeenCalledTimes(4);
  });

  it("a PARTIAL failure (one workspace) still forces a retry; the healthy one isn't stranded either", async () => {
    const state = createUnreadReconcileState();
    let t = 1_000_000;
    const reconcileWorkspaceUnread = vi.fn(async (wsId: string) => {
      if (wsId === "ws_2") throw new Error("ws_2 down");
    });
    const { deps } = makeDeps({ now: () => t, reconcileWorkspaceUnread });
    await reconcileUnread(deps, state, 10_000);
    // ws_1 reconciled, ws_2 threw → allSettled means ws_1 still ran this pass…
    expect(reconcileWorkspaceUnread).toHaveBeenCalledWith("ws_1");
    expect(state.lastRun).toBe(0); // not fully successful → stays unarmed
    // …and because the pass wasn't fully successful, the next foreground retries
    // (recovering ws_2) rather than coalescing it away.
    t += 1_000;
    await reconcileUnread(deps, state, 10_000);
    expect(reconcileWorkspaceUnread).toHaveBeenCalledTimes(4);
  });
});

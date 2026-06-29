/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { CyborgTerminalController } from "./terminal-controller.js";
import type { ServerMessage, TerminalExitInfo, TerminalSession } from "../../terminal/terminal.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

// Minimal fake session (same surface the controller uses: id/send/subscribe/
// getExitInfo/onExit/kill) — see terminal-controller.test.ts for the full rationale.
function makeFakeSession(id: string, cwd: string) {
  const listeners = new Set<(msg: ServerMessage) => void>();
  let exitListener: ((info: TerminalExitInfo) => void) | null = null;
  let exitInfo: TerminalExitInfo | null = null;
  const session = {
    id,
    name: id,
    cwd,
    send: () => {},
    getExitInfo: () => exitInfo,
    // The controller PULLS the fresh subscribe snapshot via getStateSnapshot()
    // (the real worker/PtyHost managers never push one on attach).
    getStateSnapshot: () => ({
      state: { rows: 24, cols: 80, grid: [], scrollback: [], cursor: { row: 0, col: 0 } },
      revision: 1,
    }),
    subscribe: (listener: (msg: ServerMessage) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onExit: (listener: (info: TerminalExitInfo) => void) => {
      exitListener = listener;
      return () => {
        exitListener = null;
      };
    },
    kill: () => {
      exitInfo = { exitCode: 0, signal: null, lastOutputLines: [] };
      exitListener?.(exitInfo);
    },
  } as unknown as TerminalSession;
  return session;
}

// A manager that hands out a distinct session per createTerminal() call, keyed by
// cwd, so the test can spawn several terminals in different workspaces/cwds.
function makeFakeManager() {
  let n = 0;
  const manager = {
    createTerminal: async (opts: { cwd: string }) => makeFakeSession(`term-${++n}`, opts.cwd),
  } as unknown as TerminalManager;
  return manager;
}

const noopEmit = () => {};

describe("CyborgTerminalController — workspace directory (CLI-UI unification)", () => {
  it("listForWorkspace() returns the owner's live sessions for a workspace, oldest first", async () => {
    let clock = 1000;
    const ctrl = new CyborgTerminalController(makeFakeManager(), "/home/u", null, {
      now: () => clock,
      reapIntervalMs: 0,
    });

    clock = 1000;
    await ctrl.start(
      { cwd: "/home/u/repo", cols: 80, rows: 24, ownerUserId: "alice", workspaceId: "ws1" },
      noopEmit,
    );
    clock = 2000;
    await ctrl.start(
      { cwd: "/home/u/other", cols: 80, rows: 24, ownerUserId: "alice", workspaceId: "ws1" },
      noopEmit,
    );

    const list = ctrl.listForWorkspace({ workspaceId: "ws1", ownerUserId: "alice" });
    expect(list).toHaveLength(2);
    // Oldest first; cwd basename drives the title.
    expect(list[0].cwd).toBe("/home/u/repo");
    expect(list[0].title).toBe("repo");
    expect(list[0].live).toBe(true);
    expect(list[0].workspaceId).toBe("ws1");
    expect(list[1].cwd).toBe("/home/u/other");
  });

  it("is owner-scoped and workspace-scoped", async () => {
    const ctrl = new CyborgTerminalController(makeFakeManager(), "/home/u", null, {
      reapIntervalMs: 0,
    });
    await ctrl.start(
      { cwd: "/a", cols: 80, rows: 24, ownerUserId: "alice", workspaceId: "ws1" },
      noopEmit,
    );
    await ctrl.start(
      { cwd: "/b", cols: 80, rows: 24, ownerUserId: "bob", workspaceId: "ws1" },
      noopEmit,
    );
    await ctrl.start(
      { cwd: "/c", cols: 80, rows: 24, ownerUserId: "alice", workspaceId: "ws2" },
      noopEmit,
    );

    expect(ctrl.listForWorkspace({ workspaceId: "ws1", ownerUserId: "alice" })).toHaveLength(1);
    // bob's terminal in ws1 is not visible to alice.
    expect(
      ctrl
        .listForWorkspace({ workspaceId: "ws1", ownerUserId: "alice" })
        .every((e) => e.cwd === "/a"),
    ).toBe(true);
    // alice's ws2 terminal is not in ws1.
    expect(ctrl.listForWorkspace({ workspaceId: "ws2", ownerUserId: "alice" })).toHaveLength(1);
  });

  it("fires onDirectoryChanged on start AND on kill (the push feed)", async () => {
    const changes: Array<{ workspaceId: string; ownerUserId: string }> = [];
    const ctrl = new CyborgTerminalController(makeFakeManager(), "/home/u", null, {
      reapIntervalMs: 0,
      onDirectoryChanged: (input) => changes.push(input),
    });

    const res = await ctrl.start(
      { cwd: "/a", cols: 80, rows: 24, ownerUserId: "alice", workspaceId: "ws1" },
      noopEmit,
    );
    expect(changes).toEqual([{ workspaceId: "ws1", ownerUserId: "alice" }]);

    // Killing it fires the hook again — the snapshot the consumer pulls is now empty,
    // which is how a CLI kill clears the UI sidebar row.
    ctrl.kill(res.terminalId as string, "alice");
    expect(changes).toEqual([
      { workspaceId: "ws1", ownerUserId: "alice" },
      { workspaceId: "ws1", ownerUserId: "alice" },
    ]);
    expect(ctrl.listForWorkspace({ workspaceId: "ws1", ownerUserId: "alice" })).toEqual([]);
  });

  it("does NOT fire onDirectoryChanged for a workspace-less (local) start", async () => {
    const changes: unknown[] = [];
    const ctrl = new CyborgTerminalController(makeFakeManager(), "/home/u", null, {
      reapIntervalMs: 0,
      onDirectoryChanged: (input) => changes.push(input),
    });
    await ctrl.start({ cwd: "/a", cols: 80, rows: 24, ownerUserId: "alice" }, noopEmit);
    // No workspaceId → nothing to surface in a workspace sidebar → no broadcast.
    expect(changes).toEqual([]);
  });
});

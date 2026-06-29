/* eslint-disable @typescript-eslint/no-explicit-any */
//
// Terminal lifecycle — REAL-PTY integration test (#762, internal docs).
//
// The collocated terminal-controller.test.ts proves the controller's *logic*
// with a fake TerminalSession. This file proves the same lifecycle against a
// REAL OS process (node-pty + the default shell), which is the only way to
// verify the two claims the unit tests structurally cannot:
//
//   1. "nothing is lost" — a tab switch (client unsubscribes, then re-subscribes)
//      does NOT kill the pty; on re-subscribe a fresh Paseo snapshot repaints the
//      on-screen state so the user is back where they were.
//   2. "no zombie" — kill() (and a graceful dispose()) actually REAP the OS
//      process. We capture the shell's own pid ($$) and assert the kernel no
//      longer knows it (process.kill(pid, 0) → ESRCH). A defunct/zombie process
//      would still answer signal 0, so ESRCH is a genuine "reaped" proof.
//
// The server-side model of a UI tab switch (internal docs P0b):
// TerminalView unmount does NOT kill the daemon pty; it UNSUBSCRIBEs this view's
// viewer, and a remount calls subscribe(), which opens a fresh Paseo subscription
// whose self-heal snapshot repaints the screen. Here that is: unsubscribe the
// first emit, keep streaming, then subscribe() a second emit and assert the
// snapshot self-heal.
//
// POSIX-only: the test drives a real shell with `echo $$` / `echo MARKER`, which
// behaves consistently on bash/dash but not cmd/PowerShell. Skipped on win32.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { CyborgTerminalController } from "./terminal-controller.js";
import { TerminalPersistenceStore } from "./terminal-persistence.js";
import { createTerminalManager } from "../../terminal/terminal-manager.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Poll until `predicate` is truthy or the deadline passes — no fixed sleeps, so
// the test is as fast as the real shell and doesn't flake on a slow CI box.
async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

// EPERM ⇒ the pid exists but we may not signal it (still alive); ESRCH ⇒ gone.
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Concatenate every output frame the controller emitted for this terminal.
function outputText(frames: any[], terminalId: string): string {
  return frames
    .filter((m) => m.type === "cyborg:terminal_output" && m.payload?.terminalId === terminalId)
    .map((m) => m.payload.data as string)
    .join("");
}

// Did the controller emit a terminal_exit frame for this terminal yet?
function sawExit(frames: any[], terminalId: string): boolean {
  return frames.some(
    (m) => m.type === "cyborg:terminal_exit" && m.payload?.terminalId === terminalId,
  );
}

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("CyborgTerminalController — real-pty lifecycle (#762)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  function tmp(prefix: string): string {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), prefix));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("create → unsubscribe (tab switch) → re-subscribe → kill: nothing lost, no zombie", async () => {
    const cwd = tmp("term-life-");
    const ctrl = new CyborgTerminalController(createTerminalManager(), cwd);
    cleanups.push(() => ctrl.dispose());

    // ── CREATE: spawn a real shell ──────────────────────────────────────────
    const clientA: any[] = [];
    // Named emit so the tab-switch below can unsubscribe exactly this viewer by ref.
    const clientAEmit = (m: any) => clientA.push(m);
    const res = await ctrl.start({ cwd, cols: 80, rows: 24, ownerUserId: "alice" }, clientAEmit);
    expect(res.ok).toBe(true);
    const terminalId = res.terminalId!;
    expect(ctrl.sessionCount).toBe(1);

    // Capture the shell's OWN pid so we can later prove it was reaped. The shell
    // writes $$ to a file in its cwd; we read the file rather than scrape the
    // terminal stream (robust against prompt/echo noise).
    const pidFile = join(cwd, "shell.pid");
    expect(ctrl.input(terminalId, `echo $$ > ${JSON.stringify(pidFile)}\n`, "alice")).toBe(true);
    await waitFor(
      "pid file written",
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0,
    );
    const shellPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    expect(Number.isInteger(shellPid)).toBe(true);
    expect(processAlive(shellPid)).toBe(true);

    // Produce a distinctive marker BEFORE the tab switch.
    ctrl.input(terminalId, "echo MARKER_ALPHA\n", "alice");
    await waitFor("ALPHA on client A", () =>
      outputText(clientA, terminalId).includes("MARKER_ALPHA"),
    );

    // ── UNSUBSCRIBE (tab switch): the client goes away — its viewer (and its Paseo
    // subscription) is dropped, but the daemon must NOT kill the pty. Output keeps
    // buffering into the persistence ring while "away". ──────────────────────────
    ctrl.input(terminalId, "echo MARKER_BETA\n", "alice");
    await waitFor("BETA buffered", () => outputText(clientA, terminalId).includes("MARKER_BETA"));
    expect(ctrl.unsubscribe(terminalId, "alice", { emit: clientAEmit })).toBe(true);
    // The pty survived the unsubscribe — still tracked, OS process still alive.
    expect(ctrl.sessionCount).toBe(1);
    expect(processAlive(shellPid)).toBe(true);

    // ── RE-SUBSCRIBE (remount): a fresh client subscribes and self-heals from a
    // fresh Paseo snapshot (internal docs P0b — its OWN subscription delivers the
    // snapshot carrying the on-screen state; there is no scrollback replay). ──────
    const clientB: any[] = [];
    const sub = ctrl.subscribe(terminalId, "alice", (m) => clientB.push(m));
    expect(sub).toMatchObject({ ok: true, terminalId, live: true });
    const sawSnapshot = () =>
      clientB.some(
        (m: any) => m.type === "cyborg:terminal_snapshot" && m.payload?.terminalId === terminalId,
      );
    await waitFor("snapshot self-heal on client B", sawSnapshot);

    // New output now flows to the re-subscribed client, not the unsubscribed one.
    const aLenBefore = clientA.length;
    ctrl.input(terminalId, "echo MARKER_GAMMA\n", "alice");
    await waitFor("GAMMA on client B", () =>
      outputText(clientB, terminalId).includes("MARKER_GAMMA"),
    );
    expect(clientA.length).toBe(aLenBefore); // unsubscribed emit no longer receives output

    // ── KILL: explicit teardown emits exit, untracks, and reaps the process. ──
    expect(ctrl.kill(terminalId, "alice")).toBe(true);
    await waitFor("exit frame", () => sawExit(clientB, terminalId));
    expect(ctrl.sessionCount).toBe(0);
    // No zombie: the kernel no longer knows the pid (ESRCH), i.e. it was reaped —
    // not left defunct. node-pty's SIGCHLD reaping; poll to allow the wait().
    await waitFor("shell pid reaped (no zombie)", () => !processAlive(shellPid));

    // Post-kill control is a no-op (session gone) — nothing lingers.
    expect(ctrl.input(terminalId, "x", "alice")).toBe(false);
  });

  it("graceful dispose() reaps the pty and persists history a new daemon replays read-only", async () => {
    const baseDir = tmp("term-restart-");
    const cwd = tmp("term-restart-cwd-");
    const persistence = () =>
      new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });

    // ── Daemon process #1: run a session, capture its pid, then shut down. ────
    const ctrl1 = new CyborgTerminalController(createTerminalManager(), cwd, persistence());
    const clientA: any[] = [];
    const res = await ctrl1.start(
      { cwd, cols: 100, rows: 30, ownerUserId: "alice", workspaceId: "ws-1" },
      (m) => clientA.push(m),
    );
    const terminalId = res.terminalId!;

    const pidFile = join(cwd, "restart.pid");
    ctrl1.input(terminalId, `echo $$ > ${JSON.stringify(pidFile)}\n`, "alice");
    await waitFor(
      "pid file",
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0,
    );
    const shellPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);

    ctrl1.input(terminalId, "echo BUILT_OK\n", "alice");
    await waitFor("output flushed", () => outputText(clientA, terminalId).includes("BUILT_OK"));

    ctrl1.dispose(); // graceful shutdown: flush the tail, then kill ptys

    // No zombie left behind by a graceful shutdown either.
    await waitFor("pid reaped after dispose", () => !processAlive(shellPid));

    // ── Daemon process #2: a fresh controller scans the same dir and surfaces
    // the previous session as read-only history (the pty is GONE). ─────────────
    const ctrl2 = new CyborgTerminalController(createTerminalManager(), cwd, persistence());
    cleanups.push(() => ctrl2.dispose());
    expect(ctrl2.deadSessionCount).toBe(1);

    const clientB: any[] = [];
    const attach = ctrl2.subscribe(terminalId, "alice", (m) => clientB.push(m));
    expect(attach).toMatchObject({
      ok: true,
      terminalId,
      live: false,
      endedReason: "daemon_restart",
    });
    expect(outputText(clientB, terminalId)).toContain("BUILT_OK"); // history survived the restart
    expect(ctrl2.sessionCount).toBe(0); // no fresh pty spawned for the dead session
  });
});

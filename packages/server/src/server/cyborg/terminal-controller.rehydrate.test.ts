/* eslint-disable @typescript-eslint/no-explicit-any */
// CyborgTerminalController — PtyHost rehydrate + flag-gated dispose
// (internal docs §A.6).
//
//   • rehydrate test: a host with a live pty + a matching #750 sidecar →
//     rehydrateLiveSessions() yields a live session, and a subsequent subscribe()
//     returns { ok:true, live:true } (NOT attachDead).
//   • dispose test: with the flag ON, dispose() does NOT kill the pty (still alive
//     in the fake host) but DOES persist the tail.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyborgTerminalController } from "./terminal-controller.js";
import {
  resolvePersistEnabled,
  TerminalPersistenceStore,
  type PersistedTerminalMeta,
} from "./terminal-persistence.js";
import type { ServerMessage, TerminalExitInfo, TerminalSession } from "../../terminal/terminal.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

// A live fake pty as it would survive in the host: getExitInfo() returns null
// (alive), subscribe() is a real listener set with the Paseo snapshot self-heal,
// and kill() is observable so the dispose test can assert it was NOT called.
function makeLiveSession(id: string, cwd: string) {
  const listeners = new Set<(msg: ServerMessage) => void>();
  let exitListener: ((info: TerminalExitInfo) => void) | null = null;
  let killed = false;
  let exitInfo: TerminalExitInfo | null = null;
  const session = {
    id,
    name: id,
    cwd,
    send: () => {},
    getExitInfo: () => exitInfo,
    getSize: () => ({ rows: 24, cols: 80 }),
    // The controller PULLS the fresh subscribe snapshot via getStateSnapshot() —
    // the real worker/PtyHost managers never push one on attach (the pty-host
    // replays its ring as output and drops snapshots), so the controller must pull.
    getStateSnapshot: () => ({
      state: { rows: 24, cols: 80, grid: [], scrollback: [], cursor: { row: 0, col: 0 } },
      revision: 1,
    }),
    subscribe: (listener: (msg: ServerMessage) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onExit: (listener: (info: TerminalExitInfo) => void) => {
      exitListener = listener;
      return () => {
        exitListener = null;
      };
    },
    kill: () => {
      killed = true;
      exitInfo = { exitCode: 0, signal: null, lastOutputLines: [] };
      exitListener?.(exitInfo);
    },
  } as unknown as TerminalSession;
  return {
    session,
    emitOutput: (data: string) => {
      for (const l of listeners) l({ type: "output", data });
    },
    get killed() {
      return killed;
    },
  };
}

// A host-capable fake manager: it OWNS the surviving sessions (listTerminals +
// getTerminal) and records detach. This is the PtyHostCapableManager shape the
// controller probes for.
function makeHostManager(sessions: TerminalSession[]) {
  let detached = false;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const manager = {
    createTerminal: async () => {
      throw new Error("not used in rehydrate test");
    },
    getTerminal: (id: string) => byId.get(id),
    listTerminals: () => sessions.map((s) => ({ id: s.id, name: s.name, cwd: s.cwd })),
    detachAll: () => {
      detached = true;
    },
  } as unknown as TerminalManager;
  return {
    manager,
    get detached() {
      return detached;
    },
  };
}

// A host-capable manager whose live set starts EMPTY and is populated LATER — the
// boot-rehydrate-races-the-host-connection scenario (#880 runtime evidence). At
// construct/boot the daemon-side client has not yet synced the host's terminal list,
// so listTerminals()/getTerminal() see nothing; once the socket connect+sync lands,
// connect() reveals the surviving ptys.
function makeRacyHostManager(sessions: TerminalSession[]) {
  let connected = false;
  let detached = false;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const manager = {
    createTerminal: async () => {
      throw new Error("not used in race test");
    },
    getTerminal: (id: string) => (connected ? byId.get(id) : undefined),
    listTerminals: () =>
      connected ? sessions.map((s) => ({ id: s.id, name: s.name, cwd: s.cwd })) : [],
    detachAll: () => {
      detached = true;
    },
  } as unknown as TerminalManager;
  return {
    manager,
    connect: () => {
      connected = true;
    },
    get detached() {
      return detached;
    },
  };
}

function writeSidecar(dir: string, meta: PersistedTerminalMeta): void {
  const terminalsDir = join(dir, "terminals");
  mkdirSync(terminalsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(terminalsDir, `${meta.terminalId}.json`), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });
}

// Write the #750 plaintext scrollback log next to a sidecar so the boot scan
// surfaces it as the dead session's persisted history.
function writeLog(dir: string, terminalId: string, data: string): void {
  const terminalsDir = join(dir, "terminals");
  mkdirSync(terminalsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(terminalsDir, `${terminalId}.log`), data, { mode: 0o600 });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noopEmit = () => {};

describe("CyborgTerminalController — PtyHost rehydrate (internal docs)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("re-wraps a surviving pty + matching sidecar → subscribe returns live:true", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "rehydrate-"));
    dirs.push(baseDir);

    const live = makeLiveSession("term-survivor", "/work");
    // A persisted sidecar from the previous daemon run, endedAt:null (daemon
    // died while running) — this is what the host reattach matches against.
    const meta: PersistedTerminalMeta = {
      schemaVersion: 1,
      terminalId: "term-survivor",
      ownerUserId: "user-alice",
      workspaceId: null,
      daemonId: null,
      cwd: "/work",
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
      endedAt: null,
      exitCode: null,
    };
    writeSidecar(baseDir, meta);

    const { manager } = makeHostManager([live.session]);
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(manager, "/default", persistence, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });

    // Before rehydrate the live map is empty; the sidecar is in the dead map.
    expect(ctrl.sessionCount).toBe(0);
    expect(ctrl.deadSessionCount).toBe(1);

    const count = ctrl.rehydrateLiveSessions();
    expect(count).toBe(1);
    expect(ctrl.sessionCount).toBe(1);
    // The pty is alive again → it must NOT linger as read-only history.
    expect(ctrl.deadSessionCount).toBe(0);

    // A subscribe by the persisted owner now attaches to the LIVE pty → live:true,
    // NOT the attachDead read-only path.
    const res = ctrl.subscribe("term-survivor", "user-alice", noopEmit, "attach-1");
    expect(res).toEqual({ ok: true, terminalId: "term-survivor", live: true });

    ctrl.dispose();
  });

  it("seeds the rehydrated ring from persisted history → re-attach replays the pre-restart scrollback (internal docs #5)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "rehydrate-hist-"));
    dirs.push(baseDir);

    const live = makeLiveSession("term-hist", "/work");
    const meta: PersistedTerminalMeta = {
      schemaVersion: 1,
      terminalId: "term-hist",
      ownerUserId: "user-alice",
      workspaceId: null,
      daemonId: null,
      cwd: "/work",
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
      endedAt: null,
      exitCode: null,
    };
    writeSidecar(baseDir, meta);
    // The scrollback the previous daemon persisted before it restarted — this is the
    // ONLY surviving copy (the in-memory ring died with the old process).
    writeLog(baseDir, "term-hist", "before-restart-line-A\nbefore-restart-line-B\n");

    const { manager } = makeHostManager([live.session]);
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(manager, "/default", persistence, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });

    expect(ctrl.rehydrateLiveSessions()).toBe(1);

    // A re-attach to the rehydrated LIVE pty replays the seeded pre-restart history
    // (NOT just the current screen) before the snapshot.
    const view: any[] = [];
    const res = ctrl.subscribe("term-hist", "user-alice", (m) => view.push(m), "attach-1");
    expect(res).toEqual({ ok: true, terminalId: "term-hist", live: true });
    await sleep(5);
    const history = view.find((m) => m.type === "cyborg:terminal_output");
    expect(history).toBeTruthy();
    expect(history.payload.data).toContain("before-restart-line-A");
    expect(history.payload.data).toContain("before-restart-line-B");
    const snap = view.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap.payload.historyReplayed).toBe(true);

    ctrl.dispose();
  });

  it("does not rehydrate when ptyHostMode is off (default worker path)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "rehydrate-"));
    dirs.push(baseDir);
    const live = makeLiveSession("term-x", "/work");
    const { manager } = makeHostManager([live.session]);
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    // ptyHostMode omitted → false → rehydrate is a no-op even though the manager
    // is host-capable.
    const ctrl = new CyborgTerminalController(manager, "/default", persistence, {
      reapIntervalMs: 0,
    });
    expect(ctrl.rehydrateLiveSessions()).toBe(0);
    expect(ctrl.sessionCount).toBe(0);
    ctrl.dispose();
  });
});

describe("CyborgTerminalController — flag-gated dispose (internal docs)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("ptyHostMode dispose DETACHES — pty stays alive, tail is persisted", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dispose-"));
    dirs.push(baseDir);

    const live = makeLiveSession("term-keep", "/work");
    const meta: PersistedTerminalMeta = {
      schemaVersion: 1,
      terminalId: "term-keep",
      ownerUserId: "user-alice",
      workspaceId: null,
      daemonId: null,
      cwd: "/work",
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
      endedAt: null,
      exitCode: null,
    };
    writeSidecar(baseDir, meta);

    const host = makeHostManager([live.session]);
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(host.manager, "/default", persistence, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });
    ctrl.rehydrateLiveSessions();
    expect(ctrl.sessionCount).toBe(1);

    // Produce some output so there is a tail to persist.
    live.emitOutput("hello from the survivor\n");
    await sleep(10);

    ctrl.dispose();

    // The pty was NOT killed (it lives on in the host) ...
    expect(live.killed).toBe(false);
    // ... the daemon-side link was detached ...
    expect(host.detached).toBe(true);
    // ... and the tail was persisted (the safety net is kept).
    const logPath = join(baseDir, "terminals", "term-keep.log");
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, "utf8")).toContain("hello from the survivor");
  });

  it("default (worker) dispose KILLS the pty — survival is opt-in", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "dispose-"));
    dirs.push(baseDir);
    const live = makeLiveSession("term-die", "/work");
    // Non-host-capable manager (only createTerminal) → worker path.
    const manager = {
      createTerminal: async () => live.session,
    } as unknown as TerminalManager;
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(manager, "/default", persistence, {
      reapIntervalMs: 0,
    });
    await ctrl.start({ cwd: "/work", cols: 80, rows: 24, ownerUserId: "user-alice" }, noopEmit);
    expect(ctrl.sessionCount).toBe(1);

    ctrl.dispose();
    // Worker path: dispose kills the pty (no survival).
    expect(live.killed).toBe(true);
  });
});

// #856 REGRESSION: a SURVIVING pty-host session must stay re-attachable after a
// daemon restart. The shipped default shipped INCONSISTENT — PtyHost ON but
// persistence OFF — so no #750 owner sidecar was written; on reboot rehydrate fell
// to syntheticMeta (ownerUserId "") and the owner-lock then REJECTED the real
// owner → "this terminal session is no longer available". The old rehydrate tests
// always passed enabled:true WITH a sidecar, so they never exercised the
// production default. These two tests pin both halves of the fix.
describe("CyborgTerminalController — #856 owner recovery after restart", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("persistence DISABLED + NO sidecar: an owner-less survivor is still attachable via adopt-on-subscribe (not dead-ended)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "adopt-"));
    dirs.push(baseDir);

    const live = makeLiveSession("term-orphan", "/work");
    const { manager } = makeHostManager([live.session]);
    // The PRODUCTION-DEFAULT inconsistency: PtyHost on, persistence OFF → no sidecar
    // was ever written, so rehydrate has only syntheticMeta (ownerUserId "").
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: false, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(manager, "/default", persistence, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });

    // Rehydrate finds the live survivor but no sidecar → owner-less session.
    expect(ctrl.rehydrateLiveSessions()).toBe(1);
    expect(ctrl.sessionCount).toBe(1);

    // BEFORE the fix this dead-ended in owned() → attachDead() → "session not
    // found". The first subscribe now ADOPTS the owner-less survivor → live:true.
    const res = ctrl.subscribe("term-orphan", "user-alice", noopEmit, "attach-1");
    expect(res).toEqual({ ok: true, terminalId: "term-orphan", live: true });

    // The adopted owner now owns it: a re-subscribe by the same user stays live, and
    // a DIFFERENT user is rejected (owner-lock holds after adoption).
    const again = ctrl.subscribe("term-orphan", "user-alice", noopEmit, "attach-2");
    expect(again.live).toBe(true);
    const other = ctrl.subscribe("term-orphan", "user-mallory", noopEmit, "attach-3");
    expect(other).toEqual({ ok: false, error: "terminal session not found" });

    ctrl.dispose();
  });

  it("persistence following PtyHost (default ON): a started session's owner sidecar is written, so a fresh controller rehydrates the REAL owner and the owner-lock passes for them / rejects others", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "persist-follows-"));
    dirs.push(baseDir);

    // resolvePersistEnabled with no env override follows the PtyHost default.
    delete process.env.CYBORG7_PERSIST_TERMINALS;
    const enabled = resolvePersistEnabled(/* ptyHostOn */ true);
    expect(enabled).toBe(true);

    // FIRST daemon process: PtyHost on, persistence following it → start() writes the
    // owner sidecar. Use a host-capable manager so dispose DETACHES (pty survives).
    const live = makeLiveSession("term-persist", "/work");
    const host1 = makeHostManager([live.session]);
    const persistence1 = new TerminalPersistenceStore({ baseDir, enabled, debounceMs: 0 });
    const ctrl1 = new CyborgTerminalController(host1.manager, "/default", persistence1, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });
    // Drive start() through the host-capable manager (getTerminal/createTerminal).
    (
      host1.manager as unknown as { createTerminal: () => Promise<TerminalSession> }
    ).createTerminal = async () => live.session;
    await ctrl1.start({ cwd: "/work", cols: 80, rows: 24, ownerUserId: "user-alice" }, noopEmit);
    // The sidecar carrying the REAL owner is on disk.
    const sidecarPath = join(baseDir, "terminals", "term-persist.json");
    expect(existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(readFileSync(sidecarPath, "utf8")).ownerUserId).toBe("user-alice");
    // Detach (leave the pty alive in the host) — simulates the daemon restart.
    ctrl1.dispose();
    expect(live.killed).toBe(false);

    // SECOND daemon process: a fresh controller over the same host + baseDir. Because
    // the sidecar exists, rehydrate restores the REAL owner (NOT syntheticMeta "").
    const host2 = makeHostManager([live.session]);
    const persistence2 = new TerminalPersistenceStore({ baseDir, enabled, debounceMs: 0 });
    const ctrl2 = new CyborgTerminalController(host2.manager, "/default", persistence2, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });
    expect(ctrl2.rehydrateLiveSessions()).toBe(1);

    // The owner-lock now passes for the original owner WITHOUT needing adoption ...
    const owner = ctrl2.subscribe("term-persist", "user-alice", noopEmit, "attach-1");
    expect(owner).toEqual({ ok: true, terminalId: "term-persist", live: true });
    // ... and rejects a different user.
    const other = ctrl2.subscribe("term-persist", "user-mallory", noopEmit, "attach-2");
    expect(other).toEqual({ ok: false, error: "terminal session not found" });

    ctrl2.dispose();
  });
});

// #880 RUNTIME EVIDENCE (owner's Mac daemon.log, 0.0.189): after a daemon restart the
// surviving pty was NOT in the controller's session map — subscribe found no session,
// owned() rejected, attachDead → "this terminal session is no longer available". Root
// cause: the boot rehydrate (rehydrateLiveSessions, run SYNCHRONOUSLY during terminal
// setup) iterates the PtyHost manager's listTerminals(), but on the cloud/macOS path
// the host connect+terminal-list sync can land AFTER that sync call → listTerminals()
// is EMPTY at boot → 0 rehydrated → the live pty is never registered. The fix is a
// LAZY rehydrate: the first subscribe that finds no session re-queries the host and
// rehydrates the id on demand (with its real sidecar owner) before falling to
// attachDead. These two tests pin the race (death before, live after).
describe("CyborgTerminalController — #880 boot rehydrate races the pty-host connect", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("boot rehydrate sees an EMPTY host list (host not yet connected) → 0 rehydrated, but the first subscribe LAZILY rehydrates the survivor → live:true with the real owner", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "rehydrate-race-"));
    dirs.push(baseDir);

    const live = makeLiveSession("term-race", "/work");
    // The #750 sidecar the PREVIOUS daemon wrote, endedAt:null (it died running). This
    // is the real owner the lazy rehydrate must restore — NOT syntheticMeta "".
    const meta: PersistedTerminalMeta = {
      schemaVersion: 1,
      terminalId: "term-race",
      ownerUserId: "user-alice",
      ownerEmail: "alice@example.com",
      workspaceId: null,
      daemonId: null,
      cwd: "/work",
      cols: 80,
      rows: 24,
      createdAt: Date.now(),
      endedAt: null,
      exitCode: null,
    };
    writeSidecar(baseDir, meta);

    // The host has the surviving pty, but the daemon-side client has NOT yet synced its
    // list — listTerminals()/getTerminal() are empty until connect() lands.
    const host = makeRacyHostManager([live.session]);
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(host.manager, "/default", persistence, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });

    // The sidecar is loaded into the dead map on construct (so the owner is available
    // for the later lazy rehydrate) ...
    expect(ctrl.deadSessionCount).toBe(1);
    // ... but the BOOT rehydrate races the host connection: the list is empty → 0.
    expect(ctrl.rehydrateLiveSessions()).toBe(0);
    expect(ctrl.sessionCount).toBe(0);

    // ── DEATH BEFORE THE FIX: a subscribe right now (host still not synced) finds no
    // LIVE session in the map and falls to attachDead — which, for a daemon_restart
    // sidecar, returns live:FALSE (the read-only "this terminal session is no longer
    // available / here is its history" view), even though the pty is very much alive in
    // the host. This is exactly the 0.0.189 failure: a live terminal shown as ended.
    const early = ctrl.subscribe(
      "term-race",
      "user-alice",
      noopEmit,
      "attach-early",
      "alice@example.com",
    );
    expect(early.ok).toBe(true);
    expect(early.live).toBe(false);
    expect(early.endedReason).toBe("daemon_restart");
    expect(ctrl.sessionCount).toBe(0);

    // ── The pty-host connection completes — the surviving pty is now visible to the
    // client (this is the async event the synchronous boot rehydrate had raced).
    host.connect();

    // ── LIVE AFTER THE FIX: the owner's next subscribe LAZILY rehydrates the survivor
    // (re-queries the host, registers it with the real sidecar owner) → live:true,
    // emitting the snapshot — NOT attachDead.
    const view: any[] = [];
    const res = ctrl.subscribe(
      "term-race",
      "user-alice",
      (m) => view.push(m),
      "attach-1",
      "alice@example.com",
    );
    expect(res).toEqual({ ok: true, terminalId: "term-race", live: true });
    expect(ctrl.sessionCount).toBe(1);
    // The pty is alive again → it must NOT linger as read-only history.
    expect(ctrl.deadSessionCount).toBe(0);
    // The (re)subscribe delivered a fresh snapshot so the UI resolves the view live.
    const snap = view.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap).toBeTruthy();
    expect(snap.payload.terminalId).toBe("term-race");

    // The lazily-rehydrated session carries the REAL owner from the sidecar: the owner
    // re-subscribes live, a DIFFERENT user is rejected (owner-lock holds).
    const again = ctrl.subscribe(
      "term-race",
      "user-alice",
      noopEmit,
      "attach-2",
      "alice@example.com",
    );
    expect(again.live).toBe(true);
    const other = ctrl.subscribe(
      "term-race",
      "user-mallory",
      noopEmit,
      "attach-3",
      "mallory@example.com",
    );
    expect(other).toEqual({ ok: false, error: "terminal session not found" });

    ctrl.dispose();
  });

  it("lazy rehydrate does NOT resurrect an id the host no longer owns (gone pty stays attachDead → history)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "rehydrate-gone-"));
    dirs.push(baseDir);

    // Host owns NO ptys (the pty really exited while the daemon was down).
    const host = makeRacyHostManager([]);
    host.connect();
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(host.manager, "/default", persistence, {
      ptyHostMode: true,
      reapIntervalMs: 0,
    });
    expect(ctrl.rehydrateLiveSessions()).toBe(0);

    // A subscribe to an unknown id is not lazily resurrected — it falls to attachDead.
    const res = ctrl.subscribe(
      "term-ghost",
      "user-alice",
      noopEmit,
      "attach-1",
      "alice@example.com",
    );
    expect(res).toEqual({ ok: false, error: "terminal session not found" });
    expect(ctrl.sessionCount).toBe(0);

    ctrl.dispose();
  });
});

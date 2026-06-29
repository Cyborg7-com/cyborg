/* eslint-disable @typescript-eslint/no-explicit-any */
// CyborgTerminalController — Bug A: a rehydrated PtyHost survivor must re-enter the
// workspace DIRECTORY so the UI can re-discover it after a daemon restart.
//
// Root cause (confirmed end-to-end via a relay guest: list_terminals returned
// terminals:[] from the owner's online Mac daemon): listForWorkspace() filtered by
// PURE id-equality (t.ownerUserId === input.ownerUserId). A pty that survived a
// restart is re-wrapped (rehydrate) with meta from the #750 sidecar, whose
// ownerUserId is the SQLite-namespace id — which DIVERGES from the relay/PG id the
// caller arrives under. So the survivor failed the owner filter → invisible →
// black terminal the UI could never subscribe to (and thus adoptOwnerless could
// never re-stamp it: chicken-and-egg).
//
// The fix: listForWorkspace() matches the owner EMAIL-first (with id fallback), like
// owned(), and surfaces truly owner-less survivors (only within their workspace) so
// the first subscribe can adopt them. rehydrateLiveSessions() additionally pushes a
// directory-changed notification so a connected owner's UI self-heals.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyborgTerminalController } from "./terminal-controller.js";
import { TerminalPersistenceStore, type PersistedTerminalMeta } from "./terminal-persistence.js";
import type { ServerMessage, TerminalExitInfo, TerminalSession } from "../../terminal/terminal.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

// A live fake pty as it would survive in the host (getExitInfo() === null ⇒ alive).
function makeLiveSession(id: string, cwd: string): TerminalSession {
  const listeners = new Set<(msg: ServerMessage) => void>();
  let exitListener: ((info: TerminalExitInfo) => void) | null = null;
  let exitInfo: TerminalExitInfo | null = null;
  return {
    id,
    name: id,
    cwd,
    send: () => {},
    getExitInfo: () => exitInfo,
    getSize: () => ({ rows: 24, cols: 80 }),
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
      exitInfo = { exitCode: 0, signal: null, lastOutputLines: [] };
      exitListener?.(exitInfo);
    },
  } as unknown as TerminalSession;
}

// A host-capable manager that OWNS the surviving sessions (listTerminals/getTerminal)
// — the PtyHostCapableManager shape the controller probes for.
function makeHostManager(sessions: TerminalSession[]): TerminalManager {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    createTerminal: async () => {
      throw new Error("not used in survivor test");
    },
    getTerminal: (id: string) => byId.get(id),
    listTerminals: () => sessions.map((s) => ({ id: s.id, name: s.name, cwd: s.cwd })),
    detachAll: () => {},
  } as unknown as TerminalManager;
}

function writeSidecar(dir: string, meta: PersistedTerminalMeta): void {
  const terminalsDir = join(dir, "terminals");
  mkdirSync(terminalsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(terminalsDir, `${meta.terminalId}.json`), JSON.stringify(meta, null, 2), {
    mode: 0o600,
  });
}

// The diverged human: rodrigo opened the terminal under one id-namespace; he
// re-attaches under a DIFFERENT id but the SAME stable email.
const RODRIGO_EMAIL = "rodrigo@x";
const RODRIGO_SQLITE_ID = "sqlite-rodrigo-uuid"; // what the sidecar carries
const RODRIGO_PG_ID = "pg-rodrigo-uuid"; // what the relay caller arrives under

function sidecar(terminalId: string, over: Partial<PersistedTerminalMeta>): PersistedTerminalMeta {
  return {
    schemaVersion: 1,
    terminalId,
    ownerUserId: RODRIGO_SQLITE_ID,
    ownerEmail: RODRIGO_EMAIL,
    workspaceId: "W",
    daemonId: null,
    cwd: "/work",
    cols: 80,
    rows: 24,
    createdAt: Date.now(),
    endedAt: null,
    exitCode: null,
    ...over,
  };
}

describe("CyborgTerminalController — Bug A: rehydrated survivor re-enters the directory", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function controllerWith(sessions: TerminalSession[], metas: PersistedTerminalMeta[]) {
    const baseDir = mkdtempSync(join(tmpdir(), "survivor-dir-"));
    dirs.push(baseDir);
    for (const m of metas) writeSidecar(baseDir, m);
    const changes: Array<{ workspaceId: string; ownerUserId: string }> = [];
    const persistence = new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
    const ctrl = new CyborgTerminalController(makeHostManager(sessions), "/default", persistence, {
      ptyHostMode: true,
      reapIntervalMs: 0,
      onDirectoryChanged: (input) => changes.push(input),
    });
    return { ctrl, changes };
  }

  it("a survivor with a DIVERGED id but the right email is HIDDEN by id-only match, SURFACED by email match", () => {
    const live = makeLiveSession("term-diverged", "/work");
    const { ctrl } = controllerWith([live], [sidecar("term-diverged", {})]);
    expect(ctrl.rehydrateLiveSessions()).toBe(1);

    // REPRO of the bug: the relay caller's id (PG) differs from the sidecar id
    // (SQLite). A pure id-equality match (the old code, simulated by passing NO email)
    // returns EMPTY — the survivor is invisible → black terminal.
    const idOnly = ctrl.listForWorkspace({ workspaceId: "W", ownerUserId: RODRIGO_PG_ID });
    expect(idOnly).toEqual([]);

    // THE FIX: pass the caller's email (the dispatcher threads auth.user.email). The
    // survivor now surfaces to its real owner despite the divergent id.
    const withEmail = ctrl.listForWorkspace({
      workspaceId: "W",
      ownerUserId: RODRIGO_PG_ID,
      ownerEmail: RODRIGO_EMAIL,
    });
    expect(withEmail).toHaveLength(1);
    expect(withEmail[0].terminalId).toBe("term-diverged");
    expect(withEmail[0].workspaceId).toBe("W");
    expect(withEmail[0].live).toBe(true);
  });

  it("a survivor with EMPTY id but a right email + workspace (synthetic-but-attributable) surfaces by email", () => {
    const live = makeLiveSession("term-empty-id", "/work");
    // ownerUserId "" (no id stamped) but ownerEmail + workspaceId present — the
    // no-sidecar/synthetic-shaped case the task calls out, attributable by email.
    const { ctrl } = controllerWith([live], [sidecar("term-empty-id", { ownerUserId: "" })]);
    expect(ctrl.rehydrateLiveSessions()).toBe(1);

    const idOnly = ctrl.listForWorkspace({ workspaceId: "W", ownerUserId: RODRIGO_PG_ID });
    expect(idOnly).toEqual([]);

    const withEmail = ctrl.listForWorkspace({
      workspaceId: "W",
      ownerUserId: RODRIGO_PG_ID,
      ownerEmail: RODRIGO_EMAIL,
    });
    expect(withEmail).toHaveLength(1);
    expect(withEmail[0].terminalId).toBe("term-empty-id");
  });

  it("a DIFFERENT user does NOT see another user's survivor (no leak)", () => {
    const live = makeLiveSession("term-rodrigos", "/work");
    const { ctrl } = controllerWith([live], [sidecar("term-rodrigos", {})]);
    expect(ctrl.rehydrateLiveSessions()).toBe(1);

    // mallory: different id AND different email → must not see rodrigo's survivor.
    const mallory = ctrl.listForWorkspace({
      workspaceId: "W",
      ownerUserId: "pg-mallory-uuid",
      ownerEmail: "mallory@x",
    });
    expect(mallory).toEqual([]);
  });

  it("a truly owner-less survivor (empty id AND empty email, workspaceId null) never leaks into a real workspace", () => {
    const live = makeLiveSession("term-orphan", "/work");
    // No sidecar → syntheticMeta on rehydrate: ownerUserId "", ownerEmail "",
    // workspaceId null. It must NOT appear in workspace "W" for anyone.
    const { ctrl } = controllerWith([live], []);
    expect(ctrl.rehydrateLiveSessions()).toBe(1);

    const inW = ctrl.listForWorkspace({
      workspaceId: "W",
      ownerUserId: "pg-anyone-uuid",
      ownerEmail: "anyone@x",
    });
    expect(inW).toEqual([]);
  });

  it("rehydrateLiveSessions() fires onDirectoryChanged for the recovered owner/workspace", () => {
    const live = makeLiveSession("term-notify", "/work");
    const { ctrl, changes } = controllerWith([live], [sidecar("term-notify", {})]);
    expect(ctrl.rehydrateLiveSessions()).toBe(1);
    // The push that lets a connected owner's UI self-heal without a manual pull. The
    // notification carries the survivor's stored (sidecar) owner id + workspace.
    expect(changes).toEqual([{ workspaceId: "W", ownerUserId: RODRIGO_SQLITE_ID }]);
  });
});

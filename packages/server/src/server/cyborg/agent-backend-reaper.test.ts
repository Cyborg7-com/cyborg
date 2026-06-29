import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import {
  identifyDescendantAgentBackends,
  identifyOrphanedAgentBackends,
  killOwnAgentBackends,
  matchAgentBackendMarker,
  parsePsOutput,
  PTY_HOST_EXCLUDE_TOKEN,
  reapOrphanedAgentBackends,
  type ProcessEntry,
} from "./agent-backend-reaper.js";

function fakeLogger(): Logger {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => fakeLogger(),
  } as unknown as Logger;
}

// A representative process snapshot: the daemon, a detached opencode backend, a
// detached codex backend, the pty-host (detached, MUST survive), a pty child of
// the host, and unrelated user processes that must never be touched.
const DAEMON_PID = 100;
const PTY_HOST_PID = 300;

function snapshot(): ProcessEntry[] {
  return [
    { pid: DAEMON_PID, ppid: 1, command: "node /opt/cyborg7/daemon-worker.js" },
    // Daemon-owned backends (children of the daemon) — these MUST be killed.
    { pid: 101, ppid: DAEMON_PID, command: "/usr/local/bin/opencode serve --port 5123" },
    { pid: 102, ppid: DAEMON_PID, command: "/usr/local/bin/codex app-server --enable goals" },
    // pty-host detached child of daemon — MUST be preserved.
    {
      pid: PTY_HOST_PID,
      ppid: DAEMON_PID,
      command: `node /opt/cyborg7/cyborg/${PTY_HOST_PID}-${PTY_HOST_EXCLUDE_TOKEN}.js`,
    },
    // A pty running under the host — also preserved (we don't descend the host).
    { pid: 301, ppid: PTY_HOST_PID, command: "/bin/zsh -l" },
    // Unrelated user processes — never matched.
    { pid: 900, ppid: 1, command: "/Applications/Visual Studio Code.app codex-helper" },
    { pid: 901, ppid: 1, command: "opencode" }, // bare TUI, not `serve`
  ];
}

describe("matchAgentBackendMarker", () => {
  it("matches opencode serve and codex app-server", () => {
    expect(matchAgentBackendMarker("/usr/local/bin/opencode serve --port 5123")?.id).toBe(
      "opencode-serve",
    );
    expect(matchAgentBackendMarker("/usr/local/bin/codex app-server")?.id).toBe("codex-app-server");
  });

  it("does not match a bare opencode TUI or unrelated processes", () => {
    expect(matchAgentBackendMarker("opencode")).toBeNull();
    expect(matchAgentBackendMarker("/bin/zsh -l")).toBeNull();
    expect(matchAgentBackendMarker("node server.js")).toBeNull();
  });

  it("NEVER matches the pty-host, even if it otherwise looks like a backend", () => {
    // Pathological: a pty-host command line that ALSO contains backend tokens.
    const ptyHostCommand = `node ${PTY_HOST_EXCLUDE_TOKEN}.js opencode serve`;
    expect(matchAgentBackendMarker(ptyHostCommand)).toBeNull();
  });
});

describe("identifyOrphanedAgentBackends", () => {
  it("selects only PPID-1 backends, never the pty-host or unrelated procs", () => {
    const procs: ProcessEntry[] = [
      { pid: 10, ppid: 1, command: "/usr/local/bin/opencode serve --port 7001" },
      { pid: 11, ppid: 1, command: "/usr/local/bin/codex app-server" },
      // Backend with a LIVE parent (another daemon) — not an orphan, leave it.
      { pid: 12, ppid: 50, command: "/usr/local/bin/opencode serve --port 7002" },
      // Orphaned pty-host — MUST be preserved despite PPID 1.
      { pid: 13, ppid: 1, command: `node ${PTY_HOST_EXCLUDE_TOKEN}.js` },
      // Unrelated orphan.
      { pid: 14, ppid: 1, command: "/usr/sbin/cupsd" },
    ];
    expect(identifyOrphanedAgentBackends(procs).sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it("reproduces the ~375-orphan leak: all PPID-1 opencode serve are reaped", () => {
    const procs: ProcessEntry[] = Array.from({ length: 375 }, (_, i) => ({
      pid: 1000 + i,
      ppid: 1,
      command: `/usr/local/bin/opencode serve --port ${20000 + i}`,
    }));
    const victims = identifyOrphanedAgentBackends(procs);
    expect(victims).toHaveLength(375);
  });
});

describe("identifyDescendantAgentBackends", () => {
  it("kills daemon-owned backends and NEVER the pty-host or its ptys", () => {
    const victims = identifyDescendantAgentBackends(snapshot(), DAEMON_PID).sort((a, b) => a - b);
    expect(victims).toEqual([101, 102]);
    // Safety invariant: pty-host pid and its pty child are absent from the kill set.
    expect(victims).not.toContain(PTY_HOST_PID);
    expect(victims).not.toContain(301);
  });

  it("walks transitive descendants (backend nested under a wrapper)", () => {
    const procs: ProcessEntry[] = [
      { pid: 100, ppid: 1, command: "node daemon-worker.js" },
      { pid: 200, ppid: 100, command: "/bin/sh -c launch" },
      { pid: 201, ppid: 200, command: "/usr/local/bin/opencode serve --port 9000" },
    ];
    expect(identifyDescendantAgentBackends(procs, 100)).toEqual([201]);
  });

  it("ignores backends owned by OTHER daemons (different root)", () => {
    const procs: ProcessEntry[] = [
      { pid: 100, ppid: 1, command: "node daemon-worker.js" },
      { pid: 500, ppid: 1, command: "node other-daemon-worker.js" },
      { pid: 501, ppid: 500, command: "/usr/local/bin/opencode serve --port 9001" },
    ];
    // Reaping our root (100) must not touch the other daemon's backend (501).
    expect(identifyDescendantAgentBackends(procs, 100)).toEqual([]);
  });
});

describe("parsePsOutput", () => {
  it("parses pid/ppid/command triples and skips garbage lines", () => {
    const stdout = [
      "  101     100 /usr/local/bin/opencode serve --port 5123",
      "  300     100 node pty-host-process.js",
      "garbage line without numbers",
      "",
    ].join("\n");
    expect(parsePsOutput(stdout)).toEqual([
      { pid: 101, ppid: 100, command: "/usr/local/bin/opencode serve --port 5123" },
      { pid: 300, ppid: 100, command: "node pty-host-process.js" },
    ]);
  });
});

describe("killOwnAgentBackends", () => {
  it("kills only the daemon's backends; pty-host is NEVER in the kill set", async () => {
    if (process.platform === "win32") return;
    const killed: number[] = [];
    const victims = await killOwnAgentBackends(fakeLogger(), {
      rootPid: DAEMON_PID,
      snapshot: () => Promise.resolve(snapshot()),
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
    });
    expect(victims.sort((a, b) => a - b)).toEqual([101, 102]);
    expect(killed.sort((a, b) => a - b)).toEqual([101, 102]);
    expect(killed).not.toContain(PTY_HOST_PID);
    expect(killed).not.toContain(301);
  });

  it("returns [] and does not throw when the snapshot fails", async () => {
    if (process.platform === "win32") return;
    const kill = vi.fn();
    const victims = await killOwnAgentBackends(fakeLogger(), {
      rootPid: DAEMON_PID,
      snapshot: () => Promise.reject(new Error("ps failed")),
      kill,
    });
    expect(victims).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  // #995: a reaper kill re-routes a daemon_operation audit event when an audit
  // context is supplied (pino line is unaffected).
  it("emits a daemon_operation audit event for the kill set", async () => {
    if (process.platform === "win32") return;
    const events: import("./audit-event-log.js").AuditEvent[] = [];
    await killOwnAgentBackends(fakeLogger(), {
      rootPid: DAEMON_PID,
      snapshot: () => Promise.resolve(snapshot()),
      kill: () => Promise.resolve(),
      audit: {
        sink: { emit: (e) => events.push(e) },
        workspaceId: "ws1",
        daemonId: "srv1",
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe("daemon_operation");
    expect(events[0].kind).toBe("reaper.own_backends");
    expect((events[0].payload as { count: number }).count).toBe(2);
  });
});

describe("reapOrphanedAgentBackends", () => {
  it("kills orphaned backends and never the pty-host", async () => {
    if (process.platform === "win32") return;
    const procs: ProcessEntry[] = [
      { pid: 10, ppid: 1, command: "/usr/local/bin/opencode serve --port 7001" },
      { pid: 13, ppid: 1, command: `node ${PTY_HOST_EXCLUDE_TOKEN}.js` },
    ];
    const killed: number[] = [];
    const victims = await reapOrphanedAgentBackends(fakeLogger(), {
      snapshot: () => Promise.resolve(procs),
      kill: (pid) => {
        killed.push(pid);
        return Promise.resolve();
      },
    });
    expect(victims).toEqual([10]);
    expect(killed).toEqual([10]);
    expect(killed).not.toContain(13);
  });
});

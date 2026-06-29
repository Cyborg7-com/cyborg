// PtyHostReaper — the load-bearing #860 safety proof: empty orphan hosts are
// reaped, but a host serving LIVE PTYS is NEVER reaped.
import { describe, it, expect, vi } from "vitest";
import type { Logger } from "pino";

import {
  identifyOrphanPtyHosts,
  reapOrphanPtyHosts,
  type IdentifyOrphanPtyHostsInput,
} from "./pty-host-reaper.js";
import type { ProcessEntry } from "./agent-backend-reaper.js";

const HOST_CMD = "node --experimental-strip-types /opt/app/cyborg/pty-host-process.ts";
const SHELL_CMD = "/bin/zsh -il";

function noopLogger(): Logger {
  return {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as Logger;
}

describe("identifyOrphanPtyHosts", () => {
  it("reaps an EMPTY orphan pty-host (PPID 1, zero child ptys)", () => {
    const processes: ProcessEntry[] = [
      { pid: 1000, ppid: 1, command: HOST_CMD }, // orphan host, no children
    ];
    expect(identifyOrphanPtyHosts(processes)).toEqual([1000]);
  });

  it("NEVER reaps an orphan pty-host that is serving a LIVE pty (has a child)", () => {
    const processes: ProcessEntry[] = [
      { pid: 1000, ppid: 1, command: HOST_CMD }, // orphan host...
      { pid: 1001, ppid: 1000, command: SHELL_CMD }, // ...with a live pty child
    ];
    // The single most important invariant of #860: live-pty host is spared.
    expect(identifyOrphanPtyHosts(processes)).toEqual([]);
  });

  it("reaps the EMPTY orphan but spares the one with a live pty when both exist", () => {
    const processes: ProcessEntry[] = [
      { pid: 1000, ppid: 1, command: HOST_CMD }, // empty orphan → reap
      { pid: 2000, ppid: 1, command: HOST_CMD }, // live orphan → spare
      { pid: 2001, ppid: 2000, command: SHELL_CMD }, // its pty child
    ];
    expect(identifyOrphanPtyHosts(processes)).toEqual([1000]);
  });

  it("never reaps the host the daemon just connected to (livePid), even if childless", () => {
    const processes: ProcessEntry[] = [
      { pid: 1000, ppid: 1, command: HOST_CMD }, // the live, connected host
    ];
    const input: IdentifyOrphanPtyHostsInput = { livePid: 1000 };
    expect(identifyOrphanPtyHosts(processes, input)).toEqual([]);
  });

  it("never reaps a host with a live (non-init) parent — belongs to a running daemon", () => {
    const processes: ProcessEntry[] = [
      { pid: 500, ppid: 1, command: "node daemon.js" }, // a running daemon
      { pid: 1000, ppid: 500, command: HOST_CMD }, // host parented to it
    ];
    expect(identifyOrphanPtyHosts(processes)).toEqual([]);
  });

  it("ignores non-pty-host orphans (only matches the host entry token)", () => {
    const processes: ProcessEntry[] = [
      { pid: 1000, ppid: 1, command: "node --some-other-thing server.js" },
      { pid: 1001, ppid: 1, command: "opencode serve --port 9999" },
    ];
    expect(identifyOrphanPtyHosts(processes)).toEqual([]);
  });

  it("never returns pid <= 1", () => {
    const processes: ProcessEntry[] = [{ pid: 1, ppid: 1, command: HOST_CMD }];
    expect(identifyOrphanPtyHosts(processes)).toEqual([]);
  });

  it("with a homeMarker, reaps only THIS daemon-home's orphan — not another daemon's host", () => {
    const myHome = "/home/me/.paseo/pty-host.sock";
    const otherHome = "/home/other/.paseo/pty-host.sock";
    const processes: ProcessEntry[] = [
      { pid: 1000, ppid: 1, command: `${HOST_CMD} ${myHome}` }, // our empty orphan → reap
      { pid: 2000, ppid: 1, command: `${HOST_CMD} ${otherHome}` }, // another daemon's idle host → SPARE
    ];
    expect(identifyOrphanPtyHosts(processes, { homeMarker: myHome })).toEqual([1000]);
  });

  it("with a homeMarker set, a host whose command lacks the marker is never reaped", () => {
    const processes: ProcessEntry[] = [
      { pid: 2000, ppid: 1, command: HOST_CMD }, // legacy host without the socket arg
    ];
    expect(
      identifyOrphanPtyHosts(processes, { homeMarker: "/home/me/.paseo/pty-host.sock" }),
    ).toEqual([]);
  });
});

describe("reapOrphanPtyHosts", () => {
  it("kills only the empty orphan, passing livePid through to spare the live host", async () => {
    const snapshot = async (): Promise<ProcessEntry[]> => [
      { pid: 1000, ppid: 1, command: HOST_CMD }, // empty orphan → reaped
      { pid: 2000, ppid: 1, command: HOST_CMD }, // the live connected host
      { pid: 2001, ppid: 2000, command: SHELL_CMD }, // its pty child
    ];
    const killed: number[] = [];
    const kill = async (pid: number): Promise<void> => {
      killed.push(pid);
    };

    const reaped = await reapOrphanPtyHosts(noopLogger(), { livePid: 2000, snapshot, kill });

    expect(reaped).toEqual([1000]);
    expect(killed).toEqual([1000]);
    // The live host AND its pty child are never killed.
    expect(killed).not.toContain(2000);
    expect(killed).not.toContain(2001);
  });

  it("kills nothing and never throws when the snapshot fails", async () => {
    const snapshot = async (): Promise<ProcessEntry[]> => {
      throw new Error("ps blew up");
    };
    const kill = vi.fn(async () => undefined);
    const reaped = await reapOrphanPtyHosts(noopLogger(), { snapshot, kill });
    expect(reaped).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });
});

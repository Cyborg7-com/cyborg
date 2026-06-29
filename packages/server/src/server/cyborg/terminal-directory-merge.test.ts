import { describe, it, expect } from "vitest";
import {
  finalizeTerminalDirectory,
  mergeTerminalDirectoryResponse,
  type TerminalDirectoryRow,
} from "./terminal-directory-merge.js";

// The "CLI terminals don't show in the sidebar" fix (PR #838 follow-up): the
// sidebar pulls `cyborg:list_terminals` with NO daemonId, the relay now FANS it
// out across every workspace daemon and merges the per-daemon responses here.
// These lock the merge contract the relay relies on: dedupe by terminalId, stamp
// the answering daemon, and reply newest-first — including the multi-daemon,
// single-daemon, and zero-daemon cases.

function row(over: Partial<TerminalDirectoryRow>): TerminalDirectoryRow {
  return { terminalId: "t1", workspaceId: "ws-1", live: true, ...over };
}

describe("mergeTerminalDirectoryResponse", () => {
  it("MULTI-DAEMON: merges terminals from every daemon (the CLI-terminal fix)", () => {
    const agg = new Map<string, TerminalDirectoryRow>();
    // Daemon A (e.g. srv_H6jVAoB7sED2) — the daemon that owns a CLI-created terminal.
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "term-cli", startedAt: 100 })], "srvA");
    // Daemon B — a peer daemon with its own terminal.
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "term-ui", startedAt: 200 })], "srvB");

    const merged = finalizeTerminalDirectory(agg);
    expect(merged.map((t) => t.terminalId)).toEqual(["term-ui", "term-cli"]); // newest first
    expect(merged.find((t) => t.terminalId === "term-cli")?.daemonId).toBe("srvA");
    expect(merged.find((t) => t.terminalId === "term-ui")?.daemonId).toBe("srvB");
  });

  it("stamps the answering daemon id onto every row (daemon can't self-report it)", () => {
    const agg = new Map<string, TerminalDirectoryRow>();
    mergeTerminalDirectoryResponse(
      agg,
      [row({ daemonId: null }), row({ terminalId: "t2" })],
      "srvX",
    );
    for (const t of finalizeTerminalDirectory(agg)) {
      expect(t.daemonId).toBe("srvX");
    }
  });

  it("dedupes by terminalId across daemons (first write wins, no double row)", () => {
    const agg = new Map<string, TerminalDirectoryRow>();
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "dup", startedAt: 1 })], "srvA");
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "dup", startedAt: 2 })], "srvB");

    const merged = finalizeTerminalDirectory(agg);
    expect(merged).toHaveLength(1);
    expect(merged[0].daemonId).toBe("srvA"); // first daemon to answer wins
  });

  it("skips rows without a terminalId rather than crashing", () => {
    const agg = new Map<string, TerminalDirectoryRow>();
    mergeTerminalDirectoryResponse(agg, [{ workspaceId: "ws-1", live: true }], "srvA");
    expect(finalizeTerminalDirectory(agg)).toHaveLength(0);
  });

  it("does NOT stamp the placeholder 'guest' daemon id", () => {
    const agg = new Map<string, TerminalDirectoryRow>();
    mergeTerminalDirectoryResponse(agg, [row({ daemonId: "real" })], "guest");
    expect(finalizeTerminalDirectory(agg)[0].daemonId).toBe("real");
  });
});

describe("finalizeTerminalDirectory", () => {
  it("SINGLE-DAEMON: returns that daemon's terminals", () => {
    const agg = new Map<string, TerminalDirectoryRow>();
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "only" })], "srvA");
    expect(finalizeTerminalDirectory(agg).map((t) => t.terminalId)).toEqual(["only"]);
  });

  it("ZERO-DAEMON: an empty aggregate yields an empty list (not an error)", () => {
    expect(finalizeTerminalDirectory(new Map())).toEqual([]);
  });

  it("sorts newest-first and treats a missing startedAt as oldest", () => {
    const agg = new Map<string, TerminalDirectoryRow>();
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "no-ts" })], "srvA");
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "old", startedAt: 10 })], "srvA");
    mergeTerminalDirectoryResponse(agg, [row({ terminalId: "new", startedAt: 99 })], "srvA");
    expect(finalizeTerminalDirectory(agg).map((t) => t.terminalId)).toEqual([
      "new",
      "old",
      "no-ts",
    ]);
  });
});

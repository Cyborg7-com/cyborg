import { describe, expect, it } from "vitest";

import { filterAudit, filterAuditBySession } from "./audit-filter.js";
import type { LogEntry } from "./state.svelte.js";

let seq = 0;
function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    id: `e${++seq}`,
    timestamp: new Date().toISOString(),
    level: "info",
    source: "spawn",
    message: "msg",
    category: "context_injection",
    agentId: null,
    cyboId: null,
    daemonId: null,
    kind: null,
    payload: null,
    ...overrides,
  };
}

const entries: LogEntry[] = [
  entry({ agentId: "a1", cyboId: "c1", daemonId: "d1", kind: "spawn.context", level: "info" }),
  entry({ agentId: "a1", cyboId: "c1", daemonId: "d1", kind: "spawn.tools", level: "info" }),
  entry({ agentId: "a2", cyboId: "c2", daemonId: "d1", kind: "reaper.kill", level: "warn" }),
  entry({ agentId: "a3", cyboId: "c1", daemonId: "d2", kind: "gate.skip", level: "debug" }),
];

describe("filterAuditBySession", () => {
  it("returns only entries for the given session (agentId)", () => {
    const out = filterAuditBySession(entries, "a1");
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.agentId === "a1")).toBe(true);
  });

  it("returns [] for an unknown session", () => {
    expect(filterAuditBySession(entries, "nope")).toHaveLength(0);
  });
});

describe("filterAudit", () => {
  it("returns all entries when no criteria supplied", () => {
    expect(filterAudit(entries, {})).toHaveLength(entries.length);
  });

  it("treats 'all'/empty/null as no constraint", () => {
    expect(filterAudit(entries, { session: "all", cybo: "", daemon: null })).toHaveLength(
      entries.length,
    );
  });

  it("filters by kind", () => {
    const out = filterAudit(entries, { kind: "reaper.kill" });
    expect(out).toHaveLength(1);
    expect(out[0].agentId).toBe("a2");
  });

  it("filters by level", () => {
    expect(filterAudit(entries, { level: "debug" })).toHaveLength(1);
    expect(filterAudit(entries, { level: "info" })).toHaveLength(2);
  });

  it("ANDs multiple criteria (cybo + daemon)", () => {
    const out = filterAudit(entries, { cybo: "c1", daemon: "d1" });
    expect(out).toHaveLength(2);
    expect(out.every((e) => e.cyboId === "c1" && e.daemonId === "d1")).toBe(true);
  });

  it("ANDs to empty when criteria conflict", () => {
    expect(filterAudit(entries, { cybo: "c2", daemon: "d2" })).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const copy = [...entries];
    filterAudit(entries, { kind: "spawn.tools" });
    expect(entries).toEqual(copy);
  });
});

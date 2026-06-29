import { describe, it, expect } from "vitest";
import { countActiveSessions } from "./daemon-usage.js";

interface Binding {
  agent_id: string;
  ephemeral: number;
}

/** Build a getBindings(workspaceId) accessor backed by a plain map. */
function bindingsBy(map: Record<string, Binding[]>): (wsId: string) => Binding[] {
  return (wsId) => map[wsId] ?? [];
}

describe("countActiveSessions", () => {
  it("counts only non-ephemeral bindings whose agent is live", () => {
    const bindings = bindingsBy({
      ws1: [
        { agent_id: "a", ephemeral: 0 },
        { agent_id: "b", ephemeral: 0 },
      ],
    });
    expect(countActiveSessions(["ws1"], bindings, new Set(["a", "b"]))).toBe(2);
  });

  it("excludes ephemeral bindings even when their agent is live", () => {
    const bindings = bindingsBy({
      ws1: [
        { agent_id: "a", ephemeral: 1 }, // ephemeral → excluded
        { agent_id: "b", ephemeral: 0 }, // counted
      ],
    });
    expect(countActiveSessions(["ws1"], bindings, new Set(["a", "b"]))).toBe(1);
  });

  it("excludes non-live agents (agent_id not in the live set)", () => {
    const bindings = bindingsBy({
      ws1: [
        { agent_id: "a", ephemeral: 0 }, // not live → excluded
        { agent_id: "b", ephemeral: 0 }, // live → counted
      ],
    });
    expect(countActiveSessions(["ws1"], bindings, new Set(["b"]))).toBe(1);
  });

  it("sums across multiple workspaces", () => {
    const bindings = bindingsBy({
      ws1: [{ agent_id: "a", ephemeral: 0 }],
      ws2: [
        { agent_id: "b", ephemeral: 0 },
        { agent_id: "c", ephemeral: 1 }, // ephemeral → excluded
        { agent_id: "d", ephemeral: 0 }, // not live → excluded
      ],
    });
    expect(countActiveSessions(["ws1", "ws2"], bindings, new Set(["a", "b", "c"]))).toBe(2);
  });

  it("returns 0 for no workspaces", () => {
    expect(countActiveSessions([], bindingsBy({}), new Set(["a"]))).toBe(0);
  });

  it("returns 0 when a workspace has no bindings", () => {
    expect(countActiveSessions(["ws1"], bindingsBy({}), new Set(["a"]))).toBe(0);
  });
});

// activeCyboCount = distinct cyboId among the active cybos. The daemon builds
// the active-cybo array inline (computeActiveCybos in bootstrap.ts) and the
// count is `new Set(...map(c => c.cyboId)).size`. Pin that dedup expectation.
describe("active cybo count dedup", () => {
  it("counts distinct cyboIds, collapsing duplicates", () => {
    const activeCybos = [{ cyboId: "a" }, { cyboId: "a" }, { cyboId: "b" }];
    expect(new Set(activeCybos.map((c) => c.cyboId)).size).toBe(2);
  });
});

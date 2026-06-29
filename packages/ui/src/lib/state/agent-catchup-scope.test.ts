import { describe, expect, it } from "vitest";
import { agentIdsForDaemonCatchUp, type CatchUpAgent } from "./agent-catchup-scope.js";

const agents: CatchUpAgent[] = [
  { agentId: "a1", daemonId: "dA" },
  { agentId: "a2", daemonId: "dB" },
  { agentId: "a3", daemonId: null }, // solo / local session
  { agentId: "a4", daemonId: "dA" },
  // a5 intentionally absent from the agent list (owner unknown)
];

describe("agentIdsForDaemonCatchUp", () => {
  it("no daemonId (client reconnect) → every open session", () => {
    expect(agentIdsForDaemonCatchUp(["a1", "a2", "a3"], agents)).toEqual(["a1", "a2", "a3"]);
  });

  it("a daemonId → only sessions owned by that daemon", () => {
    expect(agentIdsForDaemonCatchUp(["a1", "a2", "a4"], agents, "dA")).toEqual(["a1", "a4"]);
  });

  it("excludes sessions provably owned by a DIFFERENT daemon", () => {
    expect(agentIdsForDaemonCatchUp(["a1", "a2"], agents, "dA")).toEqual(["a1"]);
    expect(agentIdsForDaemonCatchUp(["a1", "a2"], agents, "dB")).toEqual(["a2"]);
  });

  it("includes null-owner (solo/local) sessions on any daemon reconnect", () => {
    expect(agentIdsForDaemonCatchUp(["a2", "a3"], agents, "dA")).toEqual(["a3"]);
  });

  it("includes sessions whose owner is unknown (agent row not loaded) — never miss", () => {
    expect(agentIdsForDaemonCatchUp(["a5", "a2"], agents, "dA")).toEqual(["a5"]);
  });

  it("empty open set → empty result", () => {
    expect(agentIdsForDaemonCatchUp([], agents, "dA")).toEqual([]);
  });

  it("preserves the input order", () => {
    expect(agentIdsForDaemonCatchUp(["a4", "a3", "a1"], agents, "dA")).toEqual(["a4", "a3", "a1"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  collectInitiatedByEmails,
  resolveInitiatedByGlobalIds,
} from "./cross-daemon-initiated-by.js";

// A list row as the relay merges it from a daemon's list_agents response: the
// daemon-local initiated_by plus the bridge key (the initiator's email).
function row(args: {
  agentId: string;
  initiatedBy: string | null;
  initiatedByEmail?: string | null;
}): Record<string, unknown> {
  return {
    agentId: args.agentId,
    provider: "claude",
    initiatedBy: args.initiatedBy,
    ...(args.initiatedByEmail !== undefined ? { initiatedByEmail: args.initiatedByEmail } : {}),
  };
}

describe("resolveInitiatedByGlobalIds", () => {
  // The bug: R launches a session on S's daemon. The row carries S-daemon's LOCAL
  // id for R (7d8395e3) — NOT R's global account id (4871b232) — so the UI groups
  // it under a phantom local id. Resolving by email maps it to R's global id.
  it("resolves a local initiated_by to the viewer's global account id by email", () => {
    const agents = [
      row({ agentId: "a1", initiatedBy: "7d8395e3", initiatedByEmail: "r@test.com" }),
    ];
    const map = new Map([["r@test.com", "4871b232"]]);

    resolveInitiatedByGlobalIds(agents, map);

    // → groups under R's "You" (session-scope groupByOwner keys on initiatedBy).
    expect(agents[0].initiatedBy).toBe("4871b232");
  });

  // Attribution must stay correct: a session genuinely owned by a DIFFERENT real
  // user resolves (by that user's distinct email) to that user's distinct global
  // id — never mis-merged into the viewer's "You".
  it("keeps a different real user's session under that user", () => {
    const agents = [
      row({ agentId: "mine", initiatedBy: "local-r", initiatedByEmail: "r@test.com" }),
      row({ agentId: "seb", initiatedBy: "local-s", initiatedByEmail: "s@test.com" }),
    ];
    const map = new Map([
      ["r@test.com", "global-r"],
      ["s@test.com", "global-s"],
    ]);

    resolveInitiatedByGlobalIds(agents, map);

    expect(agents[0].initiatedBy).toBe("global-r");
    expect(agents[1].initiatedBy).toBe("global-s");
    expect(agents[0].initiatedBy).not.toBe(agents[1].initiatedBy);
  });

  // Same-daemon case: the local id IS the account id the viewer already knows.
  // The map round-trips it to the same id — grouping is unchanged.
  it("leaves the same-daemon case unchanged (id round-trips to itself)", () => {
    const agents = [row({ agentId: "a", initiatedBy: "u1", initiatedByEmail: "u1@test.com" })];
    const map = new Map([["u1@test.com", "u1"]]);

    resolveInitiatedByGlobalIds(agents, map);

    expect(agents[0].initiatedBy).toBe("u1");
  });

  // A legacy/unattributable row (no email) is left exactly as-is — it must not be
  // dropped or coerced (session-scope treats null initiatedBy as "stays visible").
  it("leaves a row with no initiatedByEmail untouched", () => {
    const agents = [
      row({ agentId: "legacy", initiatedBy: "local-x" }),
      row({ agentId: "empty", initiatedBy: "local-y", initiatedByEmail: "" }),
      row({ agentId: "nullowner", initiatedBy: null, initiatedByEmail: null }),
    ];
    const map = new Map([["r@test.com", "global-r"]]);

    resolveInitiatedByGlobalIds(agents, map);

    expect(agents[0].initiatedBy).toBe("local-x");
    expect(agents[1].initiatedBy).toBe("local-y");
    expect(agents[2].initiatedBy).toBeNull();
  });

  // An email PG doesn't know (not in the map) leaves the row on its local id —
  // degrade gracefully, same as before the bridge, rather than blanking owner.
  it("leaves a row whose email is absent from the map on its local id", () => {
    const agents = [
      row({ agentId: "a", initiatedBy: "local-z", initiatedByEmail: "unknown@test.com" }),
    ];
    const map = new Map([["other@test.com", "global-other"]]);

    resolveInitiatedByGlobalIds(agents, map);

    expect(agents[0].initiatedBy).toBe("local-z");
  });

  it("is a no-op on an empty list or empty map", () => {
    expect(resolveInitiatedByGlobalIds([], new Map([["a@b.com", "g"]]))).toEqual([]);
    const agents = [row({ agentId: "a", initiatedBy: "x", initiatedByEmail: "x@test.com" })];
    resolveInitiatedByGlobalIds(agents, new Map());
    expect(agents[0].initiatedBy).toBe("x"); // untouched
  });
});

describe("collectInitiatedByEmails", () => {
  it("collects distinct non-empty emails", () => {
    const agents = [
      row({ agentId: "a", initiatedBy: "1", initiatedByEmail: "r@test.com" }),
      row({ agentId: "b", initiatedBy: "2", initiatedByEmail: "r@test.com" }), // dup
      row({ agentId: "c", initiatedBy: "3", initiatedByEmail: "s@test.com" }),
      row({ agentId: "d", initiatedBy: "4", initiatedByEmail: "" }), // skipped
      row({ agentId: "e", initiatedBy: "5" }), // no email → skipped
    ];

    expect(collectInitiatedByEmails(agents).sort()).toEqual(["r@test.com", "s@test.com"]);
  });

  it("returns [] when no row carries an email", () => {
    expect(collectInitiatedByEmails([row({ agentId: "a", initiatedBy: "1" })])).toEqual([]);
  });
});

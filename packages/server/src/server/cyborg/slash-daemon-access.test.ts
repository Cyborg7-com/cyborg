import { describe, expect, it } from "vitest";
import {
  findInaccessibleSlashDaemon,
  slashDaemonAccessError,
  type DaemonAccessChecker,
} from "./slash-daemon-access.js";

// pg stub: the access matrix is a set of "workspaceId/daemonId/userId" grants
// (ownership and daemon_access collapse to the same answer here, exactly like
// pg-sync.canUserAccessDaemon does).
function checker(granted: string[]): DaemonAccessChecker & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async canUserAccessDaemon(w, d, u) {
      calls.push(`${w}/${d}/${u}`);
      return granted.includes(`${w}/${d}/${u}`);
    },
  };
}

const EMPTY = { defaultSlashDaemonId: null, fallbackDaemons: [] as string[] };

describe("findInaccessibleSlashDaemon", () => {
  it("rejects a default daemon the user cannot access (RCE-equivalent designation)", async () => {
    const pg = checker([]);
    const bad = await findInaccessibleSlashDaemon({
      pg,
      workspaceId: "ws1",
      userId: "admin1",
      requested: { defaultSlashDaemonId: "d-foreign" },
      current: EMPTY,
    });
    expect(bad).toBe("d-foreign");
  });

  it("rejects the first inaccessible fallback daemon", async () => {
    const pg = checker(["ws1/d-mine/admin1"]);
    const bad = await findInaccessibleSlashDaemon({
      pg,
      workspaceId: "ws1",
      userId: "admin1",
      requested: { defaultSlashDaemonId: "d-mine", fallbackDaemons: ["d-mine", "d-foreign"] },
      current: EMPTY,
    });
    expect(bad).toBe("d-foreign");
  });

  it("accepts daemons the user owns or was granted access to", async () => {
    const pg = checker(["ws1/d-mine/admin1", "ws1/d-granted/admin1"]);
    const bad = await findInaccessibleSlashDaemon({
      pg,
      workspaceId: "ws1",
      userId: "admin1",
      requested: { defaultSlashDaemonId: "d-mine", fallbackDaemons: ["d-granted"] },
      current: EMPTY,
    });
    expect(bad).toBeNull();
  });

  it("allows KEEPING a saved daemon the editor can't access (no lockout on other fields)", async () => {
    // Admin B edits the model while admin A's daemon stays configured — keeping
    // an existing value introduces nothing, so B isn't blocked.
    const pg = checker([]);
    const bad = await findInaccessibleSlashDaemon({
      pg,
      workspaceId: "ws1",
      userId: "admin-b",
      requested: { defaultSlashDaemonId: "d-of-admin-a", fallbackDaemons: ["d-fb"] },
      current: { defaultSlashDaemonId: "d-of-admin-a", fallbackDaemons: ["d-fb"] },
    });
    expect(bad).toBeNull();
    expect(pg.calls).toEqual([]); // nothing introduced → no access queries
  });

  it("still rejects a NEW daemon even when others are kept", async () => {
    const pg = checker([]);
    const bad = await findInaccessibleSlashDaemon({
      pg,
      workspaceId: "ws1",
      userId: "admin-b",
      requested: { defaultSlashDaemonId: "d-of-admin-a", fallbackDaemons: ["d-new"] },
      current: { defaultSlashDaemonId: "d-of-admin-a", fallbackDaemons: [] },
    });
    expect(bad).toBe("d-new");
  });

  it("clearing the default (null) and omitted fields introduce nothing", async () => {
    const pg = checker([]);
    const bad = await findInaccessibleSlashDaemon({
      pg,
      workspaceId: "ws1",
      userId: "admin1",
      requested: { defaultSlashDaemonId: null },
      current: { defaultSlashDaemonId: "d-x", fallbackDaemons: ["d-y"] },
    });
    expect(bad).toBeNull();
    expect(pg.calls).toEqual([]);
  });
});

describe("slashDaemonAccessError", () => {
  it("names the daemon and the required grant", () => {
    const msg = slashDaemonAccessError("d-foreign");
    expect(msg).toContain("d-foreign");
    expect(msg).toContain("daemons you own or were granted access to");
  });
});

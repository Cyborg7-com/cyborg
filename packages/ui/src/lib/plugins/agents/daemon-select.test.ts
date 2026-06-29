import { describe, it, expect } from "vitest";
import { accessibleOnlineDaemons, pickDefaultDaemon } from "./daemon-select.js";

interface D {
  id: string;
  ownerId: string;
}

const SEB = "seb";
const RODRIGO = "rodrigo";

// Build the (isOnline, hasAccess) predicates the way DaemonState does.
function selectors(online: Set<string>, access: Record<string, Set<string>>, userId: string) {
  return {
    isOnline: (d: D) => online.has(d.id),
    // owner always has access; else an explicit grant.
    hasAccess: (d: D) => d.ownerId === userId || (access[d.id]?.has(userId) ?? false),
  };
}

describe("pickDefaultDaemon", () => {
  it("returns null when there are no daemons", () => {
    const { isOnline, hasAccess } = selectors(new Set(), {}, SEB);
    expect(pickDefaultDaemon([], SEB, isOnline, hasAccess)).toBeNull();
  });

  it("prefers the user's OWN online daemon", () => {
    const daemons: D[] = [
      { id: "rod-1", ownerId: RODRIGO },
      { id: "seb-1", ownerId: SEB },
    ];
    const { isOnline, hasAccess } = selectors(new Set(["rod-1", "seb-1"]), {}, SEB);
    expect(pickDefaultDaemon(daemons, SEB, isOnline, hasAccess)).toBe("seb-1");
  });

  // THE BUG: Seb's own daemon is offline; the list starts with Rodrigo's. The old
  // code fell back to list[0] (Rodrigo's) → cybos created on a stranger's machine.
  it("NEVER falls back to a foreign daemon — prefers own even when offline", () => {
    const daemons: D[] = [
      { id: "rod-1", ownerId: RODRIGO }, // first in the list, ONLINE, not Seb's
      { id: "seb-1", ownerId: SEB }, // Seb's own, OFFLINE
    ];
    const { isOnline, hasAccess } = selectors(new Set(["rod-1"]), {}, SEB);
    expect(pickDefaultDaemon(daemons, SEB, isOnline, hasAccess)).toBe("seb-1");
  });

  it("uses an ONLINE daemon Seb has a grant to before his own OFFLINE one", () => {
    const daemons: D[] = [
      { id: "rod-1", ownerId: RODRIGO }, // online + Seb has access
      { id: "seb-1", ownerId: SEB }, // offline
    ];
    const { isOnline, hasAccess } = selectors(new Set(["rod-1"]), { "rod-1": new Set([SEB]) }, SEB);
    // accessible+online beats own-offline (reachability wins once it's a daemon
    // Seb is actually allowed on).
    expect(pickDefaultDaemon(daemons, SEB, isOnline, hasAccess)).toBe("rod-1");
  });

  it("falls back to an accessible OFFLINE daemon, but still never a foreign no-access one", () => {
    const daemons: D[] = [
      { id: "rod-no", ownerId: RODRIGO }, // foreign, NO access, online
      { id: "rod-yes", ownerId: RODRIGO }, // foreign but Seb HAS access, offline
    ];
    const { isOnline, hasAccess } = selectors(
      new Set(["rod-no"]),
      { "rod-yes": new Set([SEB]) },
      SEB,
    );
    expect(pickDefaultDaemon(daemons, SEB, isOnline, hasAccess)).toBe("rod-yes");
  });

  it("returns null when nothing is owned or accessible (never a foreign daemon)", () => {
    const daemons: D[] = [
      { id: "rod-1", ownerId: RODRIGO },
      { id: "rod-2", ownerId: RODRIGO },
    ];
    const { isOnline, hasAccess } = selectors(new Set(["rod-1", "rod-2"]), {}, SEB);
    expect(pickDefaultDaemon(daemons, SEB, isOnline, hasAccess)).toBeNull();
  });
});

describe("accessibleOnlineDaemons (capability/provider row source)", () => {
  const daemons: D[] = [
    { id: "seb-1", ownerId: SEB }, // own
    { id: "rod-granted", ownerId: RODRIGO }, // foreign, grant for Seb
    { id: "rod-foreign", ownerId: RODRIGO }, // foreign, NO grant — the #W2 leak
    { id: "seb-offline", ownerId: SEB }, // own but offline
  ];
  const grants = { "rod-granted": new Set([SEB]) };

  it("keeps own + granted online daemons, drops foreign and offline ones", () => {
    const { isOnline, hasAccess } = selectors(
      new Set(["seb-1", "rod-granted", "rod-foreign"]),
      grants,
      SEB,
    );
    const ids = accessibleOnlineDaemons(daemons, isOnline, hasAccess).map((d) => d.id);
    expect(ids).toEqual(["seb-1", "rod-granted"]);
  });

  it("a foreign online daemon alone yields an empty list (no setup target offered)", () => {
    const { isOnline, hasAccess } = selectors(new Set(["rod-foreign"]), {}, SEB);
    expect(accessibleOnlineDaemons(daemons, isOnline, hasAccess)).toEqual([]);
  });

  it("revoking the grant removes the daemon from the rows", () => {
    const { isOnline, hasAccess } = selectors(new Set(["rod-granted"]), {}, SEB);
    expect(accessibleOnlineDaemons(daemons, isOnline, hasAccess)).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import {
  isMine,
  isChannelBound,
  belongsInMineSidebar,
  isOthersPersonalSession,
  filterMine,
  remoteDaemonLabel,
  countOthersPersonalSessions,
  soleOthersDaemonId,
  filterByDaemon,
  groupByOwner,
  type SessionScopeFields,
} from "./session-scope.js";

// Pure scoping tests (#706) — the mine/daemon/channel-bound predicates + the
// "others" count behind the sidebar redirect hint. No DOM, no client. Encodes
// the central trade-off: a SHARED channel-bound cybo stays visible even when
// another user launched it; another user's PERSONAL session is moved out.

const ME = "user-me";
const OTHER = "user-other";
const D1 = "daemon-1";

// Row factory — only the scoping fields matter here.
function s(over: Partial<SessionScopeFields> = {}): SessionScopeFields {
  return { initiatedBy: null, channelId: null, daemonId: D1, ...over };
}

describe("isMine", () => {
  it("true only when initiatedBy === current user", () => {
    expect(isMine(s({ initiatedBy: ME }), ME)).toBe(true);
    expect(isMine(s({ initiatedBy: OTHER }), ME)).toBe(false);
  });
  it("false for unattributable rows or no current user", () => {
    expect(isMine(s({ initiatedBy: null }), ME)).toBe(false);
    expect(isMine(s({ initiatedBy: ME }), undefined)).toBe(false);
  });
});

describe("isChannelBound — the shared-cybo exception", () => {
  it("true when the agent posts into a channel", () => {
    expect(isChannelBound(s({ channelId: "chan-1" }))).toBe(true);
  });
  it("false for a personal/ephemeral session (no channel)", () => {
    expect(isChannelBound(s({ channelId: null }))).toBe(false);
    expect(isChannelBound(s({ channelId: "" }))).toBe(false);
  });
});

describe("belongsInMineSidebar — what stays in the chat sidebar", () => {
  it("keeps MY sessions", () => {
    expect(belongsInMineSidebar(s({ initiatedBy: ME }), ME)).toBe(true);
  });

  // The trade-off, explicitly: another user's CHANNEL-BOUND cybo is shared and
  // must stay visible in the sidebar.
  it("keeps another user's SHARED channel-bound cybo", () => {
    expect(belongsInMineSidebar(s({ initiatedBy: OTHER, channelId: "chan-1" }), ME)).toBe(true);
  });

  // The other half of the trade-off: another user's PERSONAL session is moved.
  it("moves another user's PERSONAL session out", () => {
    expect(belongsInMineSidebar(s({ initiatedBy: OTHER, channelId: null }), ME)).toBe(false);
  });

  it("keeps an unattributable row (conservative — never silently hide it)", () => {
    expect(belongsInMineSidebar(s({ initiatedBy: null, channelId: null }), ME)).toBe(true);
  });

  it("keeps MY personal session even with no channel", () => {
    expect(belongsInMineSidebar(s({ initiatedBy: ME, channelId: null }), ME)).toBe(true);
  });
});

describe("isOthersPersonalSession — the moved-out set", () => {
  it("true only for another user's personal (non-channel) session", () => {
    expect(isOthersPersonalSession(s({ initiatedBy: OTHER, channelId: null }), ME)).toBe(true);
  });
  it("false for a shared channel-bound cybo from another user", () => {
    expect(isOthersPersonalSession(s({ initiatedBy: OTHER, channelId: "chan-1" }), ME)).toBe(false);
  });
  it("false for my own session", () => {
    expect(isOthersPersonalSession(s({ initiatedBy: ME, channelId: null }), ME)).toBe(false);
  });
  it("false for an unattributable row", () => {
    expect(isOthersPersonalSession(s({ initiatedBy: null }), ME)).toBe(false);
  });
});

describe("filterMine — the sidebar Agents derive", () => {
  it("keeps mine + shared cybos, drops others' personal sessions", () => {
    const list = [
      s({ initiatedBy: ME, channelId: null }), // mine → keep
      s({ initiatedBy: OTHER, channelId: "chan-1" }), // shared → keep
      s({ initiatedBy: OTHER, channelId: null }), // others' personal → drop
      s({ initiatedBy: null, channelId: null }), // unattributable → keep
    ];
    const kept = filterMine(list, ME);
    expect(kept).toHaveLength(3);
    expect(kept).not.toContain(list[2]);
  });
});

describe("filterMine — the my-sessions view is CROSS-DAEMON", () => {
  // The regression this fixes: the chat sidebar's my-sessions view must show MY
  // sessions on EVERY daemon, not just one. filterMine filters by user only, so
  // sessions on daemon-1, daemon-2, daemon-3 all survive — none are dropped just
  // because they run on a different machine.
  const D2 = "daemon-2";
  const D3 = "daemon-3";
  it("keeps my sessions from multiple daemons (not scoped to one)", () => {
    const list = [
      s({ initiatedBy: ME, daemonId: D1 }),
      s({ initiatedBy: ME, daemonId: D2 }),
      s({ initiatedBy: ME, daemonId: D3 }),
    ];
    const kept = filterMine(list, ME);
    expect(kept).toHaveLength(3);
    expect(new Set(kept.map((x) => x.daemonId))).toEqual(new Set([D1, D2, D3]));
  });
});

describe("remoteDaemonLabel — each cross-daemon row is tagged with its daemon", () => {
  const nameFor = (id: string): string | null =>
    ({ "daemon-1": "MacBook", "daemon-2": "build-box" })[id] ?? null;

  it("returns null for a local/default-daemon session (no badge)", () => {
    expect(remoteDaemonLabel({ daemonLocal: true, daemonId: "daemon-1" }, nameFor)).toBeNull();
    // Absent daemonLocal is treated as local (conservative — only an explicit
    // `false` from the server marks a session as remote).
    expect(remoteDaemonLabel({ daemonId: "daemon-1" }, nameFor)).toBeNull();
  });

  it("labels a remote session with its resolved daemon name", () => {
    expect(remoteDaemonLabel({ daemonLocal: false, daemonId: "daemon-2" }, nameFor)).toBe(
      "build-box",
    );
  });

  it("falls back to 'Remote' when the daemon name is unknown", () => {
    expect(remoteDaemonLabel({ daemonLocal: false, daemonId: "daemon-x" }, nameFor)).toBe("Remote");
    expect(remoteDaemonLabel({ daemonLocal: false, daemonId: null }, nameFor)).toBe("Remote");
  });

  it("each session in a cross-daemon list gets its own daemon tag", () => {
    const mine = filterMine(
      [
        s({ initiatedBy: ME, daemonId: "daemon-1" }) as SessionScopeFields & {
          daemonLocal?: boolean;
        },
        { ...s({ initiatedBy: ME, daemonId: "daemon-2" }), daemonLocal: false },
      ],
      ME,
    );
    const tags = mine.map((m) => remoteDaemonLabel(m, nameFor));
    expect(tags).toEqual([null, "build-box"]);
  });
});

describe("countOthersPersonalSessions — the redirect-hint count", () => {
  it("counts only OTHER users' personal sessions", () => {
    const list = [
      s({ initiatedBy: ME }),
      s({ initiatedBy: OTHER, channelId: null }),
      s({ initiatedBy: OTHER, channelId: null }),
      s({ initiatedBy: "user-c", channelId: "chan-1" }), // shared → not counted
      s({ initiatedBy: null }), // unattributable → not counted
    ];
    expect(countOthersPersonalSessions(list, ME)).toBe(2);
  });
  it("is zero on an all-mine list", () => {
    expect(countOthersPersonalSessions([s({ initiatedBy: ME })], ME)).toBe(0);
  });
});

describe("soleOthersDaemonId — deep-link target for the hint", () => {
  it("returns the daemon when all others' sessions share one", () => {
    const list = [
      s({ initiatedBy: ME, daemonId: "daemon-x" }),
      s({ initiatedBy: OTHER, channelId: null, daemonId: D1 }),
      s({ initiatedBy: "user-c", channelId: null, daemonId: D1 }),
    ];
    expect(soleOthersDaemonId(list, ME)).toBe(D1);
  });
  it("returns null when others' sessions span multiple daemons", () => {
    const list = [
      s({ initiatedBy: OTHER, channelId: null, daemonId: D1 }),
      s({ initiatedBy: "user-c", channelId: null, daemonId: "daemon-2" }),
    ];
    expect(soleOthersDaemonId(list, ME)).toBeNull();
  });
  it("returns null when there are no others' sessions", () => {
    expect(soleOthersDaemonId([s({ initiatedBy: ME })], ME)).toBeNull();
  });
});

describe("filterByDaemon — the daemon-detail derive (all users)", () => {
  it("keeps every user's session on the target daemon", () => {
    const list = [
      s({ initiatedBy: ME, daemonId: D1 }),
      s({ initiatedBy: OTHER, daemonId: D1 }),
      s({ initiatedBy: OTHER, daemonId: "daemon-2" }),
    ];
    const kept = filterByDaemon(list, D1);
    expect(kept).toHaveLength(2);
    expect(kept.every((x) => x.daemonId === D1)).toBe(true);
  });
});

describe("groupByOwner — daemon-detail rows led by owner", () => {
  const names: Record<string, string> = { [ME]: "Me", [OTHER]: "Zara", "user-c": "Alice" };
  const nameFor = (id: string) => names[id] ?? id;

  it("groups sessions by their launching user", () => {
    const list = [s({ initiatedBy: ME }), s({ initiatedBy: OTHER }), s({ initiatedBy: OTHER })];
    const groups = groupByOwner(list, ME, nameFor);
    const other = groups.find((g) => g.userId === OTHER);
    expect(other?.sessions).toHaveLength(2);
  });

  it("orders mine first, then others alphabetically, unattributable last", () => {
    const list = [
      s({ initiatedBy: OTHER }), // Zara
      s({ initiatedBy: null }), // unattributable
      s({ initiatedBy: ME }), // Me
      s({ initiatedBy: "user-c" }), // Alice
    ];
    const order = groupByOwner(list, ME, nameFor).map((g) => g.userId);
    expect(order).toEqual([ME, "user-c", OTHER, null]);
  });
});

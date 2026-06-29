import { describe, expect, it } from "vitest";
import { AgentStreamState, AttentionState, LogState } from "./state.svelte.js";

// #995: pushAudit retains the structured audit ids the plain `push` drops, and
// shares the same 500-entry FIFO cap so the audit stream stays memory-bounded.
describe("LogState — pushAudit (audit-trace stream)", () => {
  it("retains the structured audit ids on the entry", () => {
    const log = new LogState();
    log.pushAudit({
      level: "info",
      category: "context_injection",
      source: "spawn",
      message: "Context injected for Apex",
      kind: "spawn.context",
      agentId: "agent-1",
      cyboId: "cybo-1",
      daemonId: "srv-1",
      payload: { promptLength: 42 },
    });
    expect(log.entries).toHaveLength(1);
    const e = log.entries[0];
    expect(e.category).toBe("context_injection");
    expect(e.kind).toBe("spawn.context");
    expect(e.agentId).toBe("agent-1");
    expect(e.cyboId).toBe("cybo-1");
    expect(e.daemonId).toBe("srv-1");
    expect((e.payload as { promptLength: number }).promptLength).toBe(42);
  });

  it("trims to the 500-entry FIFO cap", () => {
    const log = new LogState();
    for (let i = 0; i < 700; i++) {
      log.pushAudit({
        level: "info",
        category: "daemon_operation",
        source: "daemon",
        message: `op ${i}`,
        kind: "daemon.op",
        agentId: `a${i}`,
      });
    }
    expect(log.entries.length).toBeLessThanOrEqual(500);
    // The newest entry survives the head-trim.
    expect(log.entries[log.entries.length - 1].message).toBe("op 699");
  });
});

// AgentStreamState.entries is the per-agent live timeline. It grew UNBOUNDED
// (every append an O(n) spread, each entry pinned in the renderer's keyed
// {#each}) → a steady renderer-RAM leak on a long session. capEntries() bounds it
// to MAX_ENTRIES (mirrors LogState cap 500 / ActivityState cap 200), trimming the
// oldest turns from the head so the visible tail is always preserved.
describe("AgentStreamState — entries RAM cap (internal docs §#10 sibling)", () => {
  it("never grows the entry array without bound", () => {
    const s = new AgentStreamState();
    for (let i = 0; i < 5000; i++) {
      s.addUserMessage("a1", `msg ${i}`);
    }
    const entries = s.getEntries("a1");
    // Bounded well under the number appended (cap is 1000, trim-to-80%).
    expect(entries.length).toBeLessThanOrEqual(1000);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("keeps the MOST RECENT entries (drops the oldest from the head)", () => {
    const s = new AgentStreamState();
    for (let i = 0; i < 5000; i++) {
      s.addUserMessage("a1", `msg ${i}`);
    }
    const entries = s.getEntries("a1");
    const texts = entries.map((e) => (e.kind === "user_message" ? e.content : ""));
    // The newest message survives; the oldest is trimmed away.
    expect(texts).toContain("msg 4999");
    expect(texts).not.toContain("msg 0");
  });

  it("does not trim a short stream (under the cap)", () => {
    const s = new AgentStreamState();
    for (let i = 0; i < 10; i++) s.addUserMessage("a1", `m${i}`);
    expect(s.getEntries("a1")).toHaveLength(10);
  });
});

// AttentionState holds the per-agent "needs attention" reason behind the
// agents-list badge (#591). The badge is read live via badgeFor()/
// requiresAttention()/getReason(), all backed by a Svelte 5 reactive Map
// ($state(new Map())). The class mutates that proxy IN PLACE (.set/.delete/
// .clear) rather than reassigning a fresh Map — so these tests lock the
// observable contract the in-place mutations must keep: after each transition
// the public readers reflect the new state. (In the node vitest env `$state`
// compiles to a plain field, so this asserts the state machine, not Svelte's
// effect scheduler — but it's the same surface a reactive read observes.)

const FINISHED = { requiresAttention: true, reason: "finished" } as const;
const ERROR = { requiresAttention: true, reason: "error" } as const;

// Scroll-up lazy-load of older agent-session history. hydrateFromTimeline seeds
// the pagination cursor from the server meta; prependTimeline splices an older
// page at the HEAD (re-id'd with this stream's counter, bridged by a turn
// boundary) and advances the cursor. This is the state contract behind the
// "can't see older messages" fix — the daemon now pages backward (direction:
// "older") and the UI stitches each page above the existing head.
function userMsg(text: string): Record<string, unknown> {
  return { type: "user_message", text };
}

describe("AgentStreamState — older-history lazy-load", () => {
  it("hydrateFromTimeline seeds hasOlder/olderCursor from server meta", () => {
    const s = new AgentStreamState();
    s.hydrateFromTimeline("a1", [userMsg("recent")], {
      hasOlder: true,
      olderCursor: "cur-1",
    });
    expect(s.hasOlder("a1")).toBe(true);
    expect(s.olderCursor("a1")).toBe("cur-1");
  });

  it("defaults to no older page when meta is absent", () => {
    const s = new AgentStreamState();
    s.hydrateFromTimeline("a1", [userMsg("only")]);
    expect(s.hasOlder("a1")).toBe(false);
    expect(s.olderCursor("a1")).toBeNull();
  });

  it("prependTimeline splices the older page ABOVE the existing head", () => {
    const s = new AgentStreamState();
    s.hydrateFromTimeline("a1", [userMsg("newest")], {
      hasOlder: true,
      olderCursor: "cur-1",
    });
    s.prependTimeline("a1", [userMsg("older-A"), userMsg("older-B")], {
      hasOlder: false,
      olderCursor: null,
    });
    const texts = s
      .getEntries("a1")
      .filter((e) => e.kind === "user_message")
      .map((e) => (e.kind === "user_message" ? e.content : ""));
    // Older page comes first, original head stays last.
    expect(texts).toEqual(["older-A", "older-B", "newest"]);
    // Cursor advanced: nothing older remains.
    expect(s.hasOlder("a1")).toBe(false);
    expect(s.olderCursor("a1")).toBeNull();
  });

  it("prepended entries get UNIQUE ids (no key collision with the head)", () => {
    const s = new AgentStreamState();
    s.hydrateFromTimeline("a1", [userMsg("newest")], { hasOlder: true, olderCursor: "c" });
    s.prependTimeline("a1", [userMsg("older")], { hasOlder: false, olderCursor: null });
    const ids = s.getEntries("a1").map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("an empty older page just clears the cursor without touching entries", () => {
    const s = new AgentStreamState();
    s.hydrateFromTimeline("a1", [userMsg("newest")], { hasOlder: true, olderCursor: "c" });
    const before = s.getEntries("a1").length;
    s.prependTimeline("a1", [], { hasOlder: false, olderCursor: null });
    expect(s.getEntries("a1").length).toBe(before);
    expect(s.hasOlder("a1")).toBe(false);
  });

  it("setLoadingOlder flips the re-entry guard read by isLoadingOlder", () => {
    const s = new AgentStreamState();
    s.hydrateFromTimeline("a1", [userMsg("x")], { hasOlder: true, olderCursor: "c" });
    expect(s.isLoadingOlder("a1")).toBe(false);
    s.setLoadingOlder("a1", true);
    expect(s.isLoadingOlder("a1")).toBe(true);
    s.setLoadingOlder("a1", false);
    expect(s.isLoadingOlder("a1")).toBe(false);
  });

  it("never produces two consecutive turn_boundary entries across prepends", () => {
    // The bridge boundary between the older page and the existing head must not
    // double up an existing boundary (e.g. when capEntries left the head starting
    // with one). Invariant: no two adjacent turn_boundary entries, ever.
    const s = new AgentStreamState();
    s.hydrateFromTimeline("a1", [userMsg("h1"), userMsg("h2")], {
      hasOlder: true,
      olderCursor: "c1",
    });
    s.prependTimeline("a1", [userMsg("o1"), userMsg("o2")], {
      hasOlder: true,
      olderCursor: "c2",
    });
    s.prependTimeline("a1", [userMsg("o3"), userMsg("o4")], {
      hasOlder: false,
      olderCursor: null,
    });
    const kinds = s.getEntries("a1").map((e) => e.kind);
    const hasAdjacentBoundaries = kinds.some(
      (k, i) => k === "turn_boundary" && kinds[i + 1] === "turn_boundary",
    );
    expect(hasAdjacentBoundaries).toBe(false);
  });
});

describe("AttentionState — snapshot seeding", () => {
  it("raises a Done badge from a finished snapshot and reads it back live", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", FINISHED);
    expect(s.requiresAttention("a1")).toBe(true);
    expect(s.getReason("a1")).toBe("finished");
    expect(s.badgeFor("a1")?.label).toBe("Done");
  });

  it("raises an Error badge from an error snapshot", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", ERROR);
    expect(s.badgeFor("a1")?.tone).toBe("error");
    expect(s.getReason("a1")).toBe("error");
  });

  it("clears in place when the snapshot no longer requires attention", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", FINISHED);
    s.seedFromSnapshot("a1", { requiresAttention: false });
    expect(s.requiresAttention("a1")).toBe(false);
    expect(s.badgeFor("a1")).toBeNull();
  });

  it("ignores a 'permission' snapshot reason (it has its own surface)", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", { requiresAttention: true, reason: "permission" });
    expect(s.requiresAttention("a1")).toBe(false);
  });

  it("seedFromAgents bulk-seeds each row's attention projection", () => {
    const s = new AttentionState();
    s.seedFromAgents([
      { agentId: "a1", attention: FINISHED },
      { agentId: "a2", attention: ERROR },
      { agentId: "a3", attention: null },
    ]);
    expect(s.getReason("a1")).toBe("finished");
    expect(s.getReason("a2")).toBe("error");
    expect(s.requiresAttention("a3")).toBe(false);
  });
});

describe("AttentionState — live turn edges", () => {
  it("a completed turn raises 'finished'", () => {
    const s = new AttentionState();
    s.noteTurnEvent("a1", "turn_completed");
    expect(s.getReason("a1")).toBe("finished");
  });

  it("a failed turn raises 'error'", () => {
    const s = new AttentionState();
    s.noteTurnEvent("a1", "turn_failed");
    expect(s.getReason("a1")).toBe("error");
  });

  it("a STARTING turn drops a stale badge (the agent is active again)", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", FINISHED);
    s.noteTurnEvent("a1", "turn_started");
    expect(s.requiresAttention("a1")).toBe(false);
  });
});

describe("AttentionState — clear-on-view (the falsifiable DONE)", () => {
  it("clearForView drops the badge and is reflected by every reader", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", FINISHED);
    s.clearForView("a1");
    expect(s.requiresAttention("a1")).toBe(false);
    expect(s.getReason("a1")).toBeNull();
    expect(s.badgeFor("a1")).toBeNull();
  });

  it("an in-flight snapshot cannot resurrect a badge cleared this session", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", FINISHED);
    s.clearForView("a1");
    // Stale snapshot still claims attention — but the local clear wins.
    s.seedFromSnapshot("a1", FINISHED);
    expect(s.requiresAttention("a1")).toBe(false);
  });

  it("a genuinely new turn after a view re-raises (session guard lifts)", () => {
    const s = new AttentionState();
    s.seedFromSnapshot("a1", FINISHED);
    s.clearForView("a1");
    // A fresh turn starts (un-suppresses), then completes → badge is back.
    s.noteTurnEvent("a1", "turn_started");
    s.noteTurnEvent("a1", "turn_completed");
    expect(s.getReason("a1")).toBe("finished");
  });
});

describe("AttentionState — mutation observability (no-touch() regression guard)", () => {
  it("a raise is observable WITHOUT reassigning the backing Map reference", () => {
    const s = new AttentionState();
    // Capture the readers' view before and after an in-place mutation. The fix
    // removed the touch() reassignment helper; this guards that the in-place
    // .set() still flips the observable state the badge reads.
    expect(s.badgeFor("a1")).toBeNull();
    s.noteTurnEvent("a1", "turn_completed");
    expect(s.badgeFor("a1")?.reason).toBe("finished");
    // A second raise to a NEW reason is also observed (surgical key update).
    s.seedFromSnapshot("a1", ERROR);
    expect(s.badgeFor("a1")?.reason).toBe("error");
  });

  it("clearAll empties the store in place", () => {
    const s = new AttentionState();
    s.seedFromAgents([
      { agentId: "a1", attention: FINISHED },
      { agentId: "a2", attention: ERROR },
    ]);
    s.clearAll();
    expect(s.requiresAttention("a1")).toBe(false);
    expect(s.requiresAttention("a2")).toBe(false);
  });
});

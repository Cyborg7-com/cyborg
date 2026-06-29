import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TerminalSessionsState,
  terminalTitle,
  type TerminalSessionEntry,
} from "./terminal-sessions.svelte.js";

// The store persists open terminal sessions (#701) to localStorage so the
// "Terminals" sidebar section survives a tab switch AND a full reload. The
// vitest env is plain `node` (no DOM), so we install a minimal in-memory
// localStorage stand-in — the same seed-the-global approach the other
// localStorage-backed state tests use. The `*.svelte.ts` runes compile fine
// under vitest's Svelte transform; `$state` behaves as a plain field here.

const STORAGE_KEY = "cyborg7_terminal_sessions";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

function entry(over: Partial<TerminalSessionEntry> = {}): TerminalSessionEntry {
  return {
    terminalId: "t1",
    daemonId: "d1",
    workspaceId: "ws1",
    title: "Terminal",
    startedAt: 1000,
    ...over,
  };
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage =
    new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("TerminalSessionsState (#701)", () => {
  it("add() tracks an entry and exposes it via forWorkspace()", () => {
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "t1", workspaceId: "ws1" }));
    expect(state.forWorkspace("ws1")).toEqual([entry({ terminalId: "t1", workspaceId: "ws1" })]);
  });

  it("add() is idempotent on terminalId (direct-nav re-add is a no-op)", () => {
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "t1", title: "first" }));
    state.add(entry({ terminalId: "t1", title: "second" }));
    const list = state.forWorkspace("ws1");
    expect(list).toHaveLength(1);
    // The first wins — re-adding does not overwrite the tracked title.
    expect(list[0].title).toBe("first");
  });

  it("add() ignores entries missing terminalId or workspaceId", () => {
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "" }));
    state.add(entry({ workspaceId: "" }));
    expect(state.forWorkspace("ws1")).toHaveLength(0);
  });

  it("remove() stops tracking a terminal; removing an unknown id is a no-op", () => {
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "t1" }));
    state.add(entry({ terminalId: "t2" }));
    state.remove("t1");
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["t2"]);
    state.remove("nope"); // no-op, must not throw or clear the list
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["t2"]);
  });

  it("forWorkspace() filters by workspaceId and preserves insertion order", () => {
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "a", workspaceId: "ws1" }));
    state.add(entry({ terminalId: "b", workspaceId: "ws2" }));
    state.add(entry({ terminalId: "c", workspaceId: "ws1" }));
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["a", "c"]);
    expect(state.forWorkspace("ws2").map((s) => s.terminalId)).toEqual(["b"]);
    expect(state.forWorkspace("missing")).toEqual([]);
  });

  it("persists to localStorage and a fresh instance restores the list (round-trip)", () => {
    const a = new TerminalSessionsState();
    a.add(entry({ terminalId: "t1", workspaceId: "ws1", title: "repo-a" }));
    a.add(entry({ terminalId: "t2", workspaceId: "ws2", title: "repo-b" }));

    // The write hit localStorage…
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();

    // …and a brand-new instance (simulating a reload re-running module init)
    // hydrates from it.
    const b = new TerminalSessionsState();
    expect(b.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["t1"]);
    expect(b.forWorkspace("ws2")[0].title).toBe("repo-b");
  });

  it("remove() persists, so the deletion survives a reload too", () => {
    const a = new TerminalSessionsState();
    a.add(entry({ terminalId: "t1" }));
    a.add(entry({ terminalId: "t2" }));
    a.remove("t1");

    const b = new TerminalSessionsState();
    expect(b.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["t2"]);
  });

  it("dismiss() removes the row AND makes a subsequent add() of that id a no-op", () => {
    // Reproduces #701-followup: the terminal route's $effect re-add()s the
    // session it is viewing on every mount, so a plain remove() of the
    // currently-viewed terminal is instantly resurrected and can never be
    // cleared. dismiss() must make that re-add() a no-op so removal sticks.
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "t1" }));
    state.dismiss("t1");
    expect(state.forWorkspace("ws1")).toHaveLength(0);
    // The route re-adds the still-mounted terminal — must stay gone.
    state.add(entry({ terminalId: "t1" }));
    expect(state.forWorkspace("ws1")).toHaveLength(0);
  });

  it("dismiss() succeeds even for an id that was never tracked (no-op removal)", () => {
    // The user can dismiss a row whose route hasn't add()ed it yet; dismissal
    // must not throw and must still suppress a later add() of that id.
    const state = new TerminalSessionsState();
    state.dismiss("ghost");
    expect(state.forWorkspace("ws1")).toEqual([]);
    state.add(entry({ terminalId: "ghost" }));
    expect(state.forWorkspace("ws1")).toEqual([]);
  });

  it("dismiss() does not block a fresh, distinct terminalId", () => {
    // terminalIds are daemon-issued and unique per session, so suppressing a
    // dismissed id must never affect a brand-new terminal.
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "t1" }));
    state.dismiss("t1");
    state.add(entry({ terminalId: "t2" }));
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["t2"]);
  });

  it("remove() (daemon exit) does NOT suppress a later add() of the same id", () => {
    // Only an explicit user dismissal is sticky. remove() reflects a genuine
    // pty exit; it must not poison the dismissed-set (ids are unique, so a
    // re-add of the same id can only be the route's idempotent mount path).
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "t1" }));
    state.remove("t1");
    state.add(entry({ terminalId: "t1", title: "rebuilt" }));
    const list = state.forWorkspace("ws1");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("rebuilt");
  });

  it("dismiss() persists the removal across a reload", () => {
    const a = new TerminalSessionsState();
    a.add(entry({ terminalId: "t1" }));
    a.add(entry({ terminalId: "t2" }));
    a.dismiss("t1");
    const b = new TerminalSessionsState();
    expect(b.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["t2"]);
  });

  it("caps the rehydrated list, keeping the most recent sessions (RAM bound, internal docs §#10)", () => {
    // A daemon restart doesn't emit cyborg:terminal_exit, so dead rows persist and
    // accumulate across launches. hydrate() must bound the restored list (newest by
    // startedAt) so it can't grow without limit and re-mount a fresh xterm per row.
    const many: TerminalSessionEntry[] = Array.from({ length: 50 }, (_, i) =>
      entry({ terminalId: `t${i}`, startedAt: i }),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(many));
    const state = new TerminalSessionsState();
    const list = state.forWorkspace("ws1");
    // Capped well below 50.
    expect(list.length).toBeLessThanOrEqual(30);
    expect(list.length).toBeGreaterThan(0);
    // The newest (highest startedAt) survives; the oldest (t0) is pruned.
    expect(list.some((s) => s.terminalId === "t49")).toBe(true);
    expect(list.some((s) => s.terminalId === "t0")).toBe(false);
  });

  it("does NOT prune when the persisted list is within the cap", () => {
    const few: TerminalSessionEntry[] = Array.from({ length: 5 }, (_, i) =>
      entry({ terminalId: `t${i}`, startedAt: i }),
    );
    localStorage.setItem(STORAGE_KEY, JSON.stringify(few));
    const state = new TerminalSessionsState();
    expect(state.forWorkspace("ws1")).toHaveLength(5);
  });

  it("ignores a corrupt / non-array localStorage blob on hydrate", () => {
    localStorage.setItem(STORAGE_KEY, "{ not json");
    expect(new TerminalSessionsState().forWorkspace("ws1")).toEqual([]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: "an array" }));
    expect(new TerminalSessionsState().forWorkspace("ws1")).toEqual([]);
  });

  it("drops malformed entries (missing fields) when hydrating", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        entry({ terminalId: "good" }),
        { terminalId: "bad", daemonId: "d1" }, // missing workspaceId/title/startedAt
      ]),
    );
    const state = new TerminalSessionsState();
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["good"]);
  });
});

// Terminal CLI-UI unification: a terminal created out-of-band (CLI `cyborg terminal
// create --workspace`, or another client) reaches THIS client via the daemon's
// directory feed, NOT via add(). ingestDirectory() merges those entries.
describe("TerminalSessionsState.ingestDirectory()", () => {
  it("renders a daemon-sourced terminal the client never started", () => {
    const state = new TerminalSessionsState();
    state.ingestDirectory("ws1", [
      { terminalId: "cli-1", workspaceId: "ws1", daemonId: "d1", cwd: "/home/me/repo" },
    ]);
    const list = state.forWorkspace("ws1");
    expect(list).toHaveLength(1);
    expect(list[0].terminalId).toBe("cli-1");
    // Title is derived from the cwd basename when the daemon omits one.
    expect(list[0].title).toBe("repo");
    expect(list[0].daemonId).toBe("d1");
  });

  it("is workspace-scoped — ignores entries for another workspace", () => {
    const state = new TerminalSessionsState();
    state.ingestDirectory("ws1", [
      { terminalId: "a", workspaceId: "ws1", daemonId: "d1" },
      { terminalId: "b", workspaceId: "ws2", daemonId: "d1" },
    ]);
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["a"]);
    expect(state.forWorkspace("ws2")).toEqual([]);
  });

  it("de-dupes against a client-started row (no duplicate on overlap)", () => {
    const state = new TerminalSessionsState();
    state.add(entry({ terminalId: "t1", workspaceId: "ws1", title: "local" }));
    state.ingestDirectory("ws1", [
      { terminalId: "t1", workspaceId: "ws1", daemonId: "d1", cwd: "/x/repo" },
    ]);
    const list = state.forWorkspace("ws1");
    expect(list).toHaveLength(1);
    // add() is idempotent on terminalId — the first (client) title wins.
    expect(list[0].title).toBe("local");
  });

  it("removes a directory-sourced row when it vanishes from a later snapshot (CLI kill)", () => {
    const state = new TerminalSessionsState();
    state.ingestDirectory("ws1", [{ terminalId: "cli-1", workspaceId: "ws1", daemonId: "d1" }]);
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["cli-1"]);
    // A subsequent snapshot no longer lists cli-1 → the daemon killed it.
    state.ingestDirectory("ws1", []);
    expect(state.forWorkspace("ws1")).toEqual([]);
  });

  it("does NOT prune a client-started row missing from a snapshot (start/snapshot race)", () => {
    const state = new TerminalSessionsState();
    // The client just started t1 (not yet in any directory snapshot)…
    state.add(entry({ terminalId: "t1", workspaceId: "ws1" }));
    // …and a snapshot taken before the start landed arrives without it.
    state.ingestDirectory("ws1", []);
    // Client-started rows are never directory-sourced, so they survive.
    expect(state.forWorkspace("ws1").map((s) => s.terminalId)).toEqual(["t1"]);
  });

  it("respects the dismissed set — a dismissed terminal isn't re-added by the feed", () => {
    const state = new TerminalSessionsState();
    state.ingestDirectory("ws1", [{ terminalId: "cli-1", workspaceId: "ws1", daemonId: "d1" }]);
    state.dismiss("cli-1");
    expect(state.forWorkspace("ws1")).toEqual([]);
    // A later snapshot that still lists it must NOT resurrect the dismissed row.
    state.ingestDirectory("ws1", [{ terminalId: "cli-1", workspaceId: "ws1", daemonId: "d1" }]);
    expect(state.forWorkspace("ws1")).toEqual([]);
  });
});

describe("terminalTitle()", () => {
  it("returns the trailing path segment (POSIX and Windows)", () => {
    expect(terminalTitle("/home/me/repo")).toBe("repo");
    expect(terminalTitle("/home/me/repo/")).toBe("repo");
    expect(terminalTitle("C:\\Users\\me\\repo")).toBe("repo");
  });

  it("falls back to 'Terminal' for empty / root / home-only cwds", () => {
    expect(terminalTitle("")).toBe("Terminal");
    expect(terminalTitle(null)).toBe("Terminal");
    expect(terminalTitle(undefined)).toBe("Terminal");
    expect(terminalTitle("/")).toBe("Terminal");
    expect(terminalTitle("~")).toBe("Terminal");
  });
});

describe("TerminalSessionsState — persisted dismissal (ghost-terminal fix)", () => {
  it("a dismissed terminal stays gone after a reload even if the daemon still reports it", () => {
    // Session 1: the terminal is live in the daemon directory; user dismisses it.
    const s1 = new TerminalSessionsState();
    s1.ingestDirectory("ws1", [{ terminalId: "ghost", workspaceId: "ws1", daemonId: "d1" }]);
    expect(s1.forWorkspace("ws1")).toHaveLength(1);
    s1.dismiss("ghost");
    expect(s1.forWorkspace("ws1")).toHaveLength(0);

    // Session 2 (reload): same localStorage, the daemon STILL reports the (un-killed)
    // pty. Before the fix the dismissal was in-memory only → it reappeared. Now the
    // persisted dismissal suppresses the re-add.
    const s2 = new TerminalSessionsState();
    s2.ingestDirectory("ws1", [{ terminalId: "ghost", workspaceId: "ws1", daemonId: "d1" }]);
    expect(s2.forWorkspace("ws1")).toHaveLength(0);
  });

  it("the persisted dismissal never blocks a genuinely new terminal (unique ids)", () => {
    const s1 = new TerminalSessionsState();
    s1.add(entry({ terminalId: "old" }));
    s1.dismiss("old");
    const s2 = new TerminalSessionsState();
    s2.ingestDirectory("ws1", [{ terminalId: "brand-new", workspaceId: "ws1", daemonId: "d1" }]);
    expect(s2.forWorkspace("ws1").map((e) => e.terminalId)).toEqual(["brand-new"]);
  });
});

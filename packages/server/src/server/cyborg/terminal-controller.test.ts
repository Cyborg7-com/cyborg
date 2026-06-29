/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CyborgTerminalController } from "./terminal-controller.js";
import { TerminalPersistenceStore } from "./terminal-persistence.js";
import type { ServerMessage, TerminalExitInfo, TerminalSession } from "../../terminal/terminal.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";

// A fake TerminalSession that records send() calls and lets the test drive the
// output/exit streams — enough surface for the controller (which only uses
// id/send/subscribe/getExitInfo/onExit/kill). It faithfully mirrors Paseo's
// subscribe() contract (terminal.ts:971-1011): a SET of listeners (multi-viewer),
// and every subscribe() delivers a fresh `{type:"snapshot"}` to that one listener
// on a microtask (terminal.ts:992-1002) before any output. This matters since
// internal docs P0b: each controller viewer owns its OWN Paseo subscription, so the
// fake must be a real listener Set (not a single slot) for the snapshot self-heal
// + multi-viewer fan-out to behave like production.
function makeFakeSession(id: string) {
  const sends: any[] = [];
  const listeners = new Set<(msg: ServerMessage) => void>();
  let exitListener: ((info: TerminalExitInfo) => void) | null = null;
  let killed = false;
  let exitInfo: TerminalExitInfo | null = null;
  const session = {
    id,
    name: id,
    cwd: "/home/u",
    send: (msg: any) => sends.push(msg),
    // Mirrors Paseo's terminal.ts getExitInfo(): null while the pty is alive,
    // populated once it has exited. The reaper keys its liveness gate off this.
    getExitInfo: () => exitInfo,
    // The controller PULLS the fresh subscribe snapshot via getStateSnapshot()
    // (the real worker/PtyHost managers never push one on attach — the pty-host
    // replays its ring as output and drops snapshots). Mirror that here.
    getStateSnapshot: () => ({
      state: { rows: 24, cols: 80, grid: [], scrollback: [], cursor: { row: 0, col: 0 } },
      revision: 1,
    }),
    subscribe: (listener: (msg: ServerMessage) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onExit: (listener: (info: TerminalExitInfo) => void) => {
      exitListener = listener;
      return () => {
        exitListener = null;
      };
    },
    kill: () => {
      if (killed) return;
      killed = true;
      exitInfo = { exitCode: 0, signal: null, lastOutputLines: [] };
      exitListener?.(exitInfo);
    },
  } as unknown as TerminalSession;
  return {
    session,
    sends,
    emitOutput: (data: string) => {
      for (const l of listeners) l({ type: "output", data });
    },
    get killed() {
      return killed;
    },
    // Simulate the pty exiting on its own (process died) WITHOUT going through the
    // controller's onExit→cleanup path — i.e. an orphaned, dead-but-uncleaned
    // session, exactly what the idle reaper is supposed to reclaim. We populate
    // exitInfo (so getExitInfo() reports it as gone) but deliberately do NOT fire
    // exitListener, leaving the controller's bookkeeping stale.
    markExitedOrphaned: () => {
      exitInfo = { exitCode: 0, signal: null, lastOutputLines: [] };
    },
  };
}

function makeFakeManager(fake: ReturnType<typeof makeFakeSession>) {
  const created: Array<{ cwd: string }> = [];
  const manager = {
    createTerminal: async (opts: { cwd: string }) => {
      created.push({ cwd: opts.cwd });
      return fake.session;
    },
  } as unknown as TerminalManager;
  return { manager, created };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noopEmit = () => {};

describe("CyborgTerminalController (#654) — start → input → output → kill", () => {
  it("drives the full lifecycle and streams coalesced output to the owner", async () => {
    const fake = makeFakeSession("term-1");
    const { manager, created } = makeFakeManager(fake);
    const ctrl = new CyborgTerminalController(manager, "/default/home");
    const emitted: any[] = [];

    // START — no cwd → falls back to the default; initial geometry applied.
    const res = await ctrl.start(
      { cwd: null, cols: 80, rows: 24, ownerUserId: "user-alice" },
      (m) => emitted.push(m),
    );
    expect(res).toEqual({ ok: true, terminalId: "term-1" });
    expect(created[0].cwd).toBe("/default/home");
    expect(fake.sends[0]).toEqual({ type: "resize", rows: 24, cols: 80 });
    expect(ctrl.sessionCount).toBe(1);

    // INPUT — owner can write; a non-owner is refused (owner-lock).
    expect(ctrl.input("term-1", "ls\r", "user-alice")).toBe(true);
    expect(fake.sends.at(-1)).toEqual({ type: "input", data: "ls\r" });
    expect(ctrl.input("term-1", "rm -rf /\r", "user-mallory")).toBe(false);
    expect(fake.sends.at(-1)).toEqual({ type: "input", data: "ls\r" }); // unchanged

    // RESIZE — owner only.
    expect(ctrl.resize("term-1", 120, 40, "user-alice")).toBe(true);
    expect(fake.sends.at(-1)).toEqual({ type: "resize", rows: 40, cols: 120 });

    // OUTPUT — coalesced (5ms), tagged with the owner for relay scoping.
    fake.emitOutput("hello ");
    fake.emitOutput("world");
    await sleep(20);
    const out = emitted.find((m) => m.type === "cyborg:terminal_output");
    expect(out.payload).toEqual({
      terminalId: "term-1",
      data: "hello world",
      toUserId: "user-alice",
    });

    // KILL — exits, emits terminal_exit, and the session is untracked.
    expect(ctrl.kill("term-1", "user-alice")).toBe(true);
    expect(fake.killed).toBe(true);
    const exit = emitted.find((m) => m.type === "cyborg:terminal_exit");
    expect(exit.payload).toEqual({ terminalId: "term-1", code: 0, toUserId: "user-alice" });
    expect(ctrl.sessionCount).toBe(0);

    // Post-kill control is a no-op (session gone).
    expect(ctrl.input("term-1", "x", "user-alice")).toBe(false);
  });

  it("a process that exits on its own emits terminal_exit and self-cleans", async () => {
    const fake = makeFakeSession("term-2");
    const { manager } = makeFakeManager(fake);
    const ctrl = new CyborgTerminalController(manager, "/home");
    const emitted: any[] = [];
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, (m) => emitted.push(m));
    expect(ctrl.sessionCount).toBe(1);

    fake.session.kill(); // simulate the PTY ending by itself
    expect(emitted.some((m) => m.type === "cyborg:terminal_exit")).toBe(true);
    expect(ctrl.sessionCount).toBe(0);
  });

  it("honors an explicit cwd", async () => {
    const fake = makeFakeSession("term-3");
    const { manager, created } = makeFakeManager(fake);
    const ctrl = new CyborgTerminalController(manager, "/default");
    await ctrl.start({ cwd: "/work/proj", cols: 80, rows: 24, ownerUserId: "u" }, () => {});
    expect(created[0].cwd).toBe("/work/proj");
  });

  it("rejects start past the per-daemon session cap (no unbounded PTY spawn)", async () => {
    // Distinct fake sessions so each start tracks a new entry.
    let n = 0;
    const manager = {
      createTerminal: async () => makeFakeSession(`t${n++}`).session,
    } as unknown as TerminalManager;
    const ctrl = new CyborgTerminalController(manager, "/h");
    let lastOk = true;
    for (let i = 0; i < 256; i++) {
      const r = await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
      lastOk = r.ok;
    }
    expect(lastOk).toBe(true);
    expect(ctrl.sessionCount).toBe(256);
    const over = await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/limit/i);
    expect(ctrl.sessionCount).toBe(256);
  });

  it("holds the per-daemon cap under concurrent starts (no TOCTOU over-spawn)", async () => {
    // createTerminal is awaited, so without an in-flight reservation N concurrent
    // start()s each pass the size check while the map is still empty and every one
    // spawns a real pty. Fire well past the cap at once; the controller must never
    // exceed MAX_TERMINAL_SESSIONS and the surplus must be rejected.
    let n = 0;
    const created: string[] = [];
    const manager = {
      createTerminal: async () => {
        // Yield so all callers interleave at the await point — the race window.
        await Promise.resolve();
        const id = `c${n++}`;
        created.push(id);
        return makeFakeSession(id).session;
      },
    } as unknown as TerminalManager;
    const ctrl = new CyborgTerminalController(manager, "/h");

    const startOnce = () => ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, noopEmit);
    const results = await Promise.all(Array.from({ length: 300 }, startOnce));
    const ok = results.filter((r) => r.ok).length;
    const rejected = results.filter((r) => !r.ok);

    expect(ctrl.sessionCount).toBe(256);
    expect(ok).toBe(256);
    expect(rejected).toHaveLength(44);
    expect(rejected.every((r) => /limit/i.test(r.error ?? ""))).toBe(true);
    // No pty is created for a rejected start — the cap is enforced BEFORE spawn.
    expect(created).toHaveLength(256);

    // Once sessions free up, the cap admits new starts again (reservation released).
    ctrl.dispose();
    expect(ctrl.sessionCount).toBe(0);
    const after = await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
    expect(after.ok).toBe(true);
  });

  it("a failed spawn releases its reserved cap slot (no permanent leak)", async () => {
    // A createTerminal rejection must not consume a cap slot forever, or repeated
    // transient spawn failures would wedge the daemon below its real ceiling.
    let fail = true;
    const manager = {
      createTerminal: async () => {
        if (fail) throw new Error("pty spawn failed");
        return makeFakeSession("ok").session;
      },
    } as unknown as TerminalManager;
    const ctrl = new CyborgTerminalController(manager, "/h");

    for (let i = 0; i < 10; i++) {
      const r = await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
      expect(r.ok).toBe(false);
    }
    expect(ctrl.sessionCount).toBe(0);
    // The 10 failures must not have eaten any slots: a real start still succeeds.
    fail = false;
    const r = await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
    expect(r.ok).toBe(true);
    expect(ctrl.sessionCount).toBe(1);
  });

  it("dispose() tears down every session even if one pty's kill() throws", async () => {
    // One misbehaving pty must not abort shutdown and leak the rest. Build three
    // sessions; the middle one throws on kill().
    const ids = ["d0", "d1", "d2"];
    const fakes = ids.map((id) => makeFakeSession(id));
    let i = 0;
    const manager = {
      createTerminal: async () => fakes[i++].session,
    } as unknown as TerminalManager;
    const ctrl = new CyborgTerminalController(manager, "/h");
    for (const _ of ids) {
      await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
    }
    expect(ctrl.sessionCount).toBe(3);

    // Make the second session's kill() throw.
    (fakes[1].session as unknown as { kill: () => void }).kill = () => {
      throw new Error("kill exploded");
    };

    expect(() => ctrl.dispose()).not.toThrow();
    // All three are untracked despite the middle one throwing.
    expect(ctrl.sessionCount).toBe(0);
    expect(fakes[0].killed).toBe(true);
    expect(fakes[2].killed).toBe(true);
  });

  // ── Re-subscribe replays full scrollback, then self-heals from the snapshot ──
  // (internal docs #5). A returning view first receives the FULL scrollback ring as
  // an authoritative history output frame (so the user keeps everything that
  // scrolled past the visible screen), then a fresh Paseo snapshot stamped
  // historyReplayed (so the client doesn't reset+repaint over the byte replay). The
  // multi-viewer / unsubscribe lifecycle is structural — viewers are Paseo listeners.

  it("subscribe() replays scrollback as history then a historyReplayed snapshot; after the old view unsubscribes, only the new one streams", async () => {
    const fake = makeFakeSession("term-r");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    const first: any[] = [];
    const emitFirst = (m: any) => first.push(m);
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emitFirst);

    // Output arrives while the original client is "connected", then it reconnects
    // on a fresh socket (tab switch / WS reconnect). The persistence subscription
    // buffers it into the ring regardless of viewers.
    fake.emitOutput("line-1\n");
    fake.emitOutput("line-2\n");
    await sleep(20);
    expect(first.some((m) => m.type === "cyborg:terminal_output")).toBe(true);

    // RE-SUBSCRIBE with a fresh emit: the new view first gets the full scrollback
    // ring replayed as ONE history output frame (internal docs #5), then a snapshot
    // stamped historyReplayed. This ADDS a viewer rather than zombifying the prev.
    const second: any[] = [];
    const res = ctrl.subscribe("term-r", "u", (m) => second.push(m));
    expect(res).toEqual({ ok: true, terminalId: "term-r", live: true });
    await Promise.resolve();
    await Promise.resolve();
    // The history replay carries BOTH scrolled-up lines (not just the visible
    // screen), prefixed by the in-band clear so a re-attach onto a stale buffer
    // doesn't double-render.
    const history = second.find((m) => m.type === "cyborg:terminal_output");
    expect(history).toBeTruthy();
    expect(history.payload.toUserId).toBe("u");
    expect(history.payload.data).toContain("line-1");
    expect(history.payload.data).toContain("line-2");
    expect(history.payload.data.startsWith("\x1b[H\x1b[2J\x1b[3J")).toBe(true);
    const snap = second.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap.payload.toUserId).toBe("u");
    expect(snap.payload.terminalId).toBe("term-r");
    // The snapshot is stamped historyReplayed so the client skips its reset+repaint.
    expect(snap.payload.historyReplayed).toBe(true);
    // Ordering: the history replay precedes the snapshot.
    expect(second.indexOf(history)).toBeLessThan(second.indexOf(snap));

    // The reconnecting client unsubscribes its dead socket (UI unmount of old tab).
    expect(ctrl.unsubscribe("term-r", "u", { emit: emitFirst })).toBe(true);

    // New output now flows to the RE-SUBSCRIBED client only — the unsubscribed old
    // view receives nothing further.
    const firstLen = first.length;
    fake.emitOutput("line-3\n");
    await sleep(20);
    expect(second.some((m) => m.payload?.data?.includes("line-3"))).toBe(true);
    expect(first.length).toBe(firstLen); // detached emit no longer receives output
  });

  it("a FRESH start replays no history — the opener viewer gets only the snapshot (internal docs #5)", async () => {
    const fake = makeFakeSession("term-fresh");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    const opener: any[] = [];
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, (m) => opener.push(m));
    await Promise.resolve();
    await Promise.resolve();
    // The opener's first frame is the snapshot, NOT a history replay (the ring is
    // empty at start). No clear-prefixed output frame is emitted.
    expect(opener.some((m) => m.type === "cyborg:terminal_snapshot")).toBe(true);
    expect(opener.some((m) => m.type === "cyborg:terminal_output")).toBe(false);
    // The snapshot is NOT stamped historyReplayed on a fresh start.
    const snap = opener.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap.payload.historyReplayed).toBeUndefined();
    ctrl.dispose();
  });

  it("re-attach restores ALL N scrolled-up lines, in order, exactly once (internal docs #5)", async () => {
    const fake = makeFakeSession("term-n");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, noopEmit);
    // Produce N lines, more than a 24-row visible screen — these are the scrolled-up
    // history the screen snapshot alone would drop.
    const N = 200;
    for (let i = 0; i < N; i++) fake.emitOutput(`history-line-${i}\n`);
    await sleep(20);

    const view: any[] = [];
    ctrl.subscribe("term-n", "u", (m) => view.push(m), "attach-n");
    await Promise.resolve();
    await Promise.resolve();
    const history = view.find((m) => m.type === "cyborg:terminal_output");
    expect(history).toBeTruthy();
    const data: string = history.payload.data;
    // Every line is present and in order — none lost to the visible-screen-only bug.
    for (let i = 0; i < N; i++) {
      expect(data.includes(`history-line-${i}`)).toBe(true);
    }
    expect(data.indexOf("history-line-0")).toBeLessThan(data.indexOf(`history-line-${N - 1}`));
    // Exactly once: only ONE history output frame precedes the snapshot.
    const outputs = view.filter((m) => m.type === "cyborg:terminal_output");
    expect(outputs.length).toBe(1);
    ctrl.dispose();
  });

  it("tags the re-attach history frame with the pty's capture width so the client can reflow (#48)", async () => {
    const fake = makeFakeSession("term-cap");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    // The pty (and its tracked meta) is 90×30 — the width the scrollback bytes are
    // produced at. A reopen restores this prior-session geometry, so it doubles as the
    // capture width the replay must be tagged with.
    await ctrl.start({ cols: 90, rows: 30, ownerUserId: "u" }, noopEmit);
    fake.emitOutput("captured-at-90-cols\n");
    await sleep(20);

    const view: any[] = [];
    ctrl.subscribe("term-cap", "u", (m) => view.push(m), "attach-cap");
    await Promise.resolve();
    await Promise.resolve();
    const history = view.find((m) => m.type === "cyborg:terminal_output");
    expect(history).toBeTruthy();
    // A client now on a DIFFERENT width reproduces the bytes at this width, then
    // resizes to let the emulator reflow them (the mobile→desktop garble fix).
    expect(history.payload.replayCols).toBe(90);
    expect(history.payload.replayRows).toBe(30);
    ctrl.dispose();
  });

  it("bound caps the replay at 256 KiB even when the live stream wrote far more (internal docs #5)", async () => {
    const fake = makeFakeSession("term-big");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, noopEmit);
    // Write ~1 MiB so the 256 KiB ring drops from the front.
    const chunk = "x".repeat(64 * 1024);
    for (let i = 0; i < 16; i++) fake.emitOutput(chunk);
    await sleep(20);

    const view: any[] = [];
    ctrl.subscribe("term-big", "u", (m) => view.push(m), "attach-big");
    await Promise.resolve();
    const history = view.find((m) => m.type === "cyborg:terminal_output");
    expect(history).toBeTruthy();
    const data: string = history.payload.data;
    // The clear prefix is 9 bytes; the rest is the bounded tail. The replayed body
    // must not exceed the 256 KiB budget.
    const body = data.slice("\x1b[H\x1b[2J\x1b[3J".length);
    expect(body.length).toBeLessThanOrEqual(256 * 1024);
    ctrl.dispose();
  });

  it("subscribe() on an unknown terminalId reports not-found (dead session, #718)", () => {
    const ctrl = new CyborgTerminalController(makeFakeManager(makeFakeSession("x")).manager, "/h");
    const res = ctrl.subscribe("ghost", "u", () => {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("subscribe() is owner-locked — a non-owner cannot hijack the stream", async () => {
    const fake = makeFakeSession("term-o");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "alice" }, () => {});
    const res = ctrl.subscribe("term-o", "mallory", () => {});
    expect(res.ok).toBe(false);
  });

  // ── #874: email-keyed owner-lock survives the per-store user-id divergence ────
  // ROOT CAUSE: the same human's email resolves to DIFFERENT opaque UUIDs per
  // storage layer — a terminal is CREATED via one id namespace (e.g. the SQLite
  // sidecar id "idA") but RE-SUBSCRIBED via another (the relay-override PG id "idB").
  // The OLD exact-id owner-lock (`ownerUserId !== userId`) rejected the real owner →
  // attachDead → "session ended / Restart" banner, and #872's snapshot never ran.
  // The FIX: match the owner by EMAIL (the stable human identity) first, id second.

  it("REPRO #874: create with idA+email, re-subscribe with a DIVERGENT idB but SAME email → re-attaches LIVE and emits the snapshot", async () => {
    const fake = makeFakeSession("term-divergent");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    // CREATE under the SQLite-id namespace (idA), stamped with the human's email.
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "idA", ownerEmail: "rodrigo@x" }, () => {});

    // RE-SUBSCRIBE under the relay-override PG-id namespace (idB ≠ idA) but the SAME
    // email — exactly the divergence that killed the terminal after Cmd+Q. BEFORE
    // the fix this hit attachDead → { ok:false } and NO snapshot. AFTER the fix the
    // email match re-admits the owner.
    const view: any[] = [];
    const res = ctrl.subscribe(
      "term-divergent",
      "idB",
      (m) => view.push(m),
      "attach-divergent",
      "rodrigo@x",
    );

    // The subscribe re-attaches LIVE (not a dead read-only replay).
    expect(res).toEqual({ ok: true, terminalId: "term-divergent", live: true });

    // And #872's snapshot IS emitted on this re-attach (the frame the UI resolves
    // its subscribe() to live:true on — the thing that was missing before).
    await Promise.resolve();
    await Promise.resolve();
    const snap = view.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap).toBeTruthy();
    expect(snap.payload.terminalId).toBe("term-divergent");
    expect(snap.payload.toUserId).toBe("idB");
  });

  it("REPRO #874 (negative control): WITHOUT the email, the divergent idB is rejected — proving id alone is the death path", async () => {
    const fake = makeFakeSession("term-noemail");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    // Same create, but the re-subscribe carries NO email (pre-fix behavior). With
    // only the divergent id and no email to match on, owned() rejects → attachDead.
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "idA", ownerEmail: "rodrigo@x" }, () => {});
    const res = ctrl.subscribe("term-noemail", "idB", () => {});
    expect(res.ok).toBe(false);
  });

  it("#874: adoptOwnerless re-stamps the live id on an email match so drive ops (input) then work under idB", async () => {
    const fake = makeFakeSession("term-reclaim");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "idA", ownerEmail: "rodrigo@x" }, () => {});
    // Re-subscribe under idB+same-email re-claims the session for idB (re-stamps the
    // live ownerUserId). Input under idB must now drive the pty.
    ctrl.subscribe("term-reclaim", "idB", () => {}, "a", "rodrigo@x");
    expect(ctrl.input("term-reclaim", "ls\n", "idB", "rodrigo@x")).toBe(true);
    expect(fake.sends.some((s: any) => s.type === "input" && s.data === "ls\n")).toBe(true);
    // A genuinely DIFFERENT human (different email AND id) is still rejected.
    expect(ctrl.input("term-reclaim", "rm -rf\n", "idM", "mallory@x")).toBe(false);
  });

  it("#874: a DIFFERENT human (different email) still cannot hijack a session by a divergent id", async () => {
    const fake = makeFakeSession("term-guard");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "idA", ownerEmail: "rodrigo@x" }, () => {});
    // Mallory has a different email and a different id — neither gate admits her.
    const res = ctrl.subscribe("term-guard", "idM", () => {}, "m", "mallory@x");
    expect(res.ok).toBe(false);
  });

  it("REPRO #876 cloud-path: create under idA + 'Rodrigo@X', re-subscribe under PG idB + ' rodrigo@x ' (different case/whitespace) → re-attaches LIVE", async () => {
    // The cloud failure: the relay forwards CREATE and SUBSCRIBE with the SAME human
    // but the relay overrides user.id to the PG guestId, so the daemon sees a
    // DIVERGENT id (idB) on subscribe vs the create id (idA). The email is the only
    // stable key — but the two paths can present it with different casing/whitespace
    // (JWT-derived vs PG-canonical). BEFORE normalization the exact-string email match
    // failed → attachDead → death. AFTER normalization (trim+lowercase both sides) the
    // same human is re-admitted live.
    const fake = makeFakeSession("term-cloud");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    await ctrl.start(
      { cols: 80, rows: 24, ownerUserId: "idA", ownerEmail: "Rodrigo@X.com" },
      () => {},
    );
    const view: any[] = [];
    const res = ctrl.subscribe(
      "term-cloud",
      "idB",
      (m) => view.push(m),
      "attach-cloud",
      "  rodrigo@x.com  ",
    );
    expect(res).toEqual({ ok: true, terminalId: "term-cloud", live: true });
    await Promise.resolve();
    await Promise.resolve();
    const snap = view.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap).toBeTruthy();
    expect(snap.payload.terminalId).toBe("term-cloud");
    expect(snap.payload.toUserId).toBe("idB");
  });

  it("#876: a different human (different email) still cannot hijack via a divergent id even with casing tricks", async () => {
    const fake = makeFakeSession("term-cloud-guard");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    await ctrl.start(
      { cols: 80, rows: 24, ownerUserId: "idA", ownerEmail: "Rodrigo@X.com" },
      () => {},
    );
    // Mallory normalizes to a genuinely different email — neither gate admits her.
    const res = ctrl.subscribe("term-cloud-guard", "idM", () => {}, "m", "MALLORY@x.com");
    expect(res.ok).toBe(false);
  });

  it("#876: diagnostic logger fires on create + subscribe with non-secret owner ids/emails (no token)", async () => {
    const logs: Array<{ obj: Record<string, unknown>; msg?: string }> = [];
    const fake = makeFakeSession("term-diag");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h", null, {
      logger: { info: (obj, msg) => logs.push({ obj, msg }) },
    });
    await ctrl.start(
      { cols: 80, rows: 24, ownerUserId: "idA", ownerEmail: "Rodrigo@X.com" },
      () => {},
    );
    ctrl.subscribe("term-diag", "idB", () => {}, "a", "rodrigo@x.com");
    const create = logs.find((l) => l.obj.event === "terminal_create");
    const subscribe = logs.find((l) => l.obj.event === "terminal_subscribe");
    expect(create?.obj.ownerEmail).toBe("rodrigo@x.com"); // normalized at create
    expect(subscribe?.obj.ownsByEmail).toBe(true);
    expect(subscribe?.obj.ownedPassed).toBe(true);
    expect(subscribe?.obj.willAttachDead).toBe(false);
    // No token field is ever logged.
    expect(JSON.stringify(logs)).not.toMatch(/token/i);
  });

  it("#874: legacy session with NO ownerEmail still owner-locks by exact id (backward compatible)", async () => {
    const fake = makeFakeSession("term-legacy");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h");
    // A pre-#874 start: no ownerEmail. Owner matching falls back to exact id.
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "legacy-id" }, () => {});
    // Same id (even with a stray email) still works.
    const ok = ctrl.subscribe("term-legacy", "legacy-id", () => {}, "l", "whoever@x");
    expect(ok).toEqual({ ok: true, terminalId: "term-legacy", live: true });
    // A different id with no matching email is still rejected.
    const bad = ctrl.subscribe("term-legacy", "other-id", () => {}, "o", "other@x");
    expect(bad.ok).toBe(false);
  });

  it("dispose() kills every tracked session", async () => {
    const f1 = makeFakeSession("a");
    const ctrl = new CyborgTerminalController(makeFakeManager(f1).manager, "/h");
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
    expect(ctrl.sessionCount).toBe(1);
    ctrl.dispose();
    expect(f1.killed).toBe(true);
    expect(ctrl.sessionCount).toBe(0);
  });
});

// ── Detached/multi-attach + idle reap (internal docs GAP-1/BUG-2/BUG-3) ────────

describe("CyborgTerminalController — detached state + multi-attach + idle reap", () => {
  // Disable the background reaper for these tests so we drive reapIdle() / time
  // explicitly (reapIntervalMs: 0). A manual clock makes idle TTL deterministic.
  function controllerWithClock(
    fake: ReturnType<typeof makeFakeSession>,
    opts: { idleTtlMs?: number } = {},
  ) {
    let nowMs = 1_000_000;
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h", null, {
      reapIntervalMs: 0,
      idleTtlMs: opts.idleTtlMs ?? 1000,
      now: () => nowMs,
    });
    return { ctrl, advance: (ms: number) => (nowMs += ms) };
  }

  it("two concurrent attachers both receive output (multi-tab, no zombie)", async () => {
    const fake = makeFakeSession("term-multi");
    const { ctrl } = controllerWithClock(fake);
    // Tab A opens the terminal (start = first attacher).
    const tabA: any[] = [];
    const emitA = (m: any) => tabA.push(m);
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emitA);

    // Tab B attaches to the SAME session (second tab) — old single-slot model would
    // have zombified tab A here.
    const tabB: any[] = [];
    const emitB = (m: any) => tabB.push(m);
    expect(ctrl.subscribe("term-multi", "u", emitB)).toEqual({
      ok: true,
      terminalId: "term-multi",
      live: true,
    });
    expect(ctrl.attacherCount("term-multi")).toBe(2);

    // Output now fans out to BOTH tabs.
    fake.emitOutput("shared-output\n");
    await sleep(20);
    expect(tabA.some((m) => m.payload?.data?.includes("shared-output"))).toBe(true);
    expect(tabB.some((m) => m.payload?.data?.includes("shared-output"))).toBe(true);

    // Tab A detaches by its own emit ref; tab B keeps receiving.
    expect(ctrl.unsubscribe("term-multi", "u", { emit: emitA })).toBe(true);
    expect(ctrl.attacherCount("term-multi")).toBe(1);
    const aLen = tabA.length;
    fake.emitOutput("only-b\n");
    await sleep(20);
    expect(tabB.some((m) => m.payload?.data?.includes("only-b"))).toBe(true);
    expect(tabA.length).toBe(aLen); // detached tab A receives nothing further
  });

  it("detach() leaves the pty running; a re-attach self-heals from a fresh snapshot", async () => {
    const fake = makeFakeSession("term-reattach");
    const { ctrl } = controllerWithClock(fake);
    const tabA: any[] = [];
    const emitA = (m: any) => tabA.push(m);
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emitA);
    fake.emitOutput("line-1\n");
    await sleep(20);

    // Detach — session stays live.
    expect(ctrl.unsubscribe("term-reattach", "u", { emit: emitA })).toBe(true);
    expect(ctrl.attacherCount("term-reattach")).toBe(0);
    expect(ctrl.sessionCount).toBe(1); // pty NOT killed by detach
    expect(fake.killed).toBe(false);

    // Output keeps streaming while detached (buffered for persistence #750).
    fake.emitOutput("line-2-while-detached\n");
    await sleep(20);

    // Re-attach (later tab): the new view first gets the full scrollback ring
    // replayed as history (internal docs #5 — incl. what scrolled by while detached),
    // then a historyReplayed snapshot, and resumes the live stream as a fresh viewer.
    const tabB: any[] = [];
    const res = ctrl.subscribe("term-reattach", "u", (m) => tabB.push(m));
    expect(res.live).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(tabB.some((m) => m.type === "cyborg:terminal_snapshot")).toBe(true);
    // The history replay carries BOTH the pre-detach line and the line that streamed
    // while detached — the "where was I" buffer the screen snapshot alone drops.
    const history = tabB.find((m) => m.type === "cyborg:terminal_output");
    expect(history).toBeTruthy();
    expect(history.payload.data).toContain("line-1");
    expect(history.payload.data).toContain("line-2-while-detached");
    // The re-attached view streams subsequent live output (a SECOND output frame).
    fake.emitOutput("line-3-after-reattach\n");
    await sleep(20);
    expect(tabB.some((m) => m.payload?.data?.includes("line-3-after-reattach"))).toBe(true);
  });

  it("reaps an orphaned dead-pty session but spares a still-alive idle one", async () => {
    // Manager hands out two distinct fake sessions in order. Both go detached and
    // idle past the TTL; the difference is liveness — one pty has exited (orphan),
    // the other is still running (a backgrounded Claude Code, must survive).
    const fakeDead = makeFakeSession("term-dead-pty");
    const fakeAlive = makeFakeSession("term-alive-pty");
    const queue = [fakeDead.session, fakeAlive.session];
    let nowMs = 1_000_000;
    const ctrl = new CyborgTerminalController(
      { createTerminal: async () => queue.shift()! } as unknown as TerminalManager,
      "/h",
      null,
      { reapIntervalMs: 0, idleTtlMs: 1000, now: () => nowMs },
    );
    const advance = (ms: number) => (nowMs += ms);

    const emitD = () => {};
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emitD);
    const emitA = () => {};
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emitA);
    expect(ctrl.sessionCount).toBe(2);

    // Both go detached.
    ctrl.unsubscribe("term-dead-pty", "u", { emit: emitD });
    ctrl.unsubscribe("term-alive-pty", "u", { emit: emitA });
    expect(ctrl.attacherCount("term-dead-pty")).toBe(0);
    expect(ctrl.attacherCount("term-alive-pty")).toBe(0);

    // The first session's pty dies without the controller's onExit firing (a
    // missed cleanup), leaving an orphaned, dead-but-tracked slot. The second
    // session's pty is still very much alive.
    fakeDead.markExitedOrphaned();

    // Move both well past the idle TTL.
    advance(5000);

    const reaped = ctrl.reapIdle();
    expect(reaped).toBe(1); // only the dead-pty orphan
    expect(ctrl.sessionCount).toBe(1);
    // The still-alive session is untouched — its pty was never killed.
    expect(fakeAlive.killed).toBe(false);
    expect(ctrl.attacherCount("term-alive-pty")).toBe(0); // still tracked, still live
  });

  it("NEVER reaps a detached, idle session whose pty is still alive (backgrounded Claude Code)", async () => {
    // The #1 regression: a Claude Code terminal the user backgrounds (tab switched
    // away ⇒ 0 attachers) while it sits idle waiting for input emits NO output, so
    // nothing bumps lastActivityAt. The OLD reaper killed it at the TTL even though
    // the pty + agent process were alive. The corrected reaper spares it forever as
    // long as the pty has not exited, and a re-subscribe repaints from a snapshot.
    const fake = makeFakeSession("term-bg-claude");
    const { ctrl, advance } = controllerWithClock(fake, { idleTtlMs: 1000 });
    const emit = () => {};
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emit);

    // Background it: detach (0 attachers) and let it sit idle, producing nothing.
    ctrl.unsubscribe("term-bg-claude", "u", { emit });
    expect(ctrl.attacherCount("term-bg-claude")).toBe(0);

    // Far past the idle TTL with zero activity — the exact trigger of the old bug.
    advance(10 * 60 * 1000);
    expect(ctrl.reapIdle()).toBe(0); // pty alive ⇒ not an orphan ⇒ spared
    expect(fake.killed).toBe(false);
    expect(ctrl.sessionCount).toBe(1);

    // The user returns: a fresh subscribe finds the session still live and repaints
    // from a snapshot — never the "session no longer available" dead-session path.
    const repaint: any[] = [];
    const res = ctrl.subscribe("term-bg-claude", "u", (m) => repaint.push(m));
    expect(res).toMatchObject({ ok: true, terminalId: "term-bg-claude", live: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(repaint.some((m) => m.type === "cyborg:terminal_snapshot")).toBe(true);
  });

  it("does NOT reap a session that still has a live attacher, however idle", async () => {
    const fake = makeFakeSession("term-attached");
    const { ctrl, advance } = controllerWithClock(fake, { idleTtlMs: 1000 });
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, () => {});
    expect(ctrl.attacherCount("term-attached")).toBe(1);
    advance(10_000); // far past the TTL, but a tab is still attached
    expect(ctrl.reapIdle()).toBe(0);
    expect(fake.killed).toBe(false);
  });

  it("output activity keeps a detached session off the reaper (long-running job)", async () => {
    const fake = makeFakeSession("term-busy");
    const { ctrl, advance } = controllerWithClock(fake, { idleTtlMs: 1000 });
    const emit = () => {};
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emit);
    ctrl.unsubscribe("term-busy", "u", { emit }); // detached, but still producing output

    advance(2000);
    // A burst of output just landed — bumps lastActivityAt past the cutoff.
    fake.emitOutput("still working...\n");
    await sleep(20);
    expect(ctrl.reapIdle()).toBe(0);
    expect(fake.killed).toBe(false);
  });

  // The cloud/relay path hands a FRESH emit closure to every forwarded RPC, so the
  // detach RPC can't match the attacher by emit reference (internal docs GAP-1).
  // detach-by-attachId is the wiring that makes detach work across that boundary.
  it("detach-by-attachId drops exactly this view even with a different emit closure", async () => {
    const fake = makeFakeSession("term-attid");
    const { ctrl } = controllerWithClock(fake);
    // start() registers the FIRST attacher carrying attachId "mount-1".
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "mount-1" }, () => {});
    expect(ctrl.attacherCount("term-attid")).toBe(1);

    // A detach arrives with a BRAND-NEW emit closure (the per-RPC closure the relay
    // would hand the daemon) but the same attachId. Emit-ref matching would miss;
    // attachId matching drops the attacher.
    expect(ctrl.unsubscribe("term-attid", "u", { emit: () => {} })).toBe(false); // wrong emit, no id
    expect(ctrl.attacherCount("term-attid")).toBe(1);
    expect(ctrl.unsubscribe("term-attid", "u", { attachId: "mount-1" })).toBe(true);
    expect(ctrl.attacherCount("term-attid")).toBe(0);
    expect(fake.killed).toBe(false); // detach is NOT kill — pty survives (#738/#762)
  });

  it("re-attach with the same attachId replaces the emit in place (no duplicate fan-out)", async () => {
    const fake = makeFakeSession("term-reattid");
    const { ctrl } = controllerWithClock(fake);
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "mount-1" }, () => {});
    expect(ctrl.attacherCount("term-reattid")).toBe(1);

    // A reconnect re-issues attach with the SAME per-mount id (its old socket's
    // detach hasn't landed yet). It must replace the emit, not stack a 2nd attacher.
    const tabReconnect: any[] = [];
    const res = ctrl.subscribe("term-reattid", "u", (m) => tabReconnect.push(m), "mount-1");
    expect(res).toEqual({ ok: true, terminalId: "term-reattid", live: true });
    expect(ctrl.attacherCount("term-reattid")).toBe(1); // replaced, not duplicated

    // Output fans out exactly once to the replacement emit.
    fake.emitOutput("hello\n");
    await sleep(20);
    const frames = tabReconnect.filter(
      (m) => m.type === "cyborg:terminal_output" && m.payload?.data?.includes("hello"),
    );
    expect(frames.length).toBe(1);
  });

  it("a detached, aged-out session whose pty is still alive is NEVER reaped (no heartbeat needed)", async () => {
    // internal docs P0b: with each viewer owning its own Paseo subscription and the
    // reaper gated on pty LIVENESS (getExitInfo), a quiet detached session no longer
    // needs a heartbeat to survive — a live pty is spared regardless of idleness.
    const fake = makeFakeSession("term-hb");
    const { ctrl, advance } = controllerWithClock(fake, { idleTtlMs: 1000 });
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "m1" }, () => {});
    ctrl.unsubscribe("term-hb", "u", { attachId: "m1" });
    expect(ctrl.attacherCount("term-hb")).toBe(0);

    // Far past the idle TTL with zero activity and no heartbeat — the live pty is
    // still spared (idleness alone is not orphanhood, the corrected liveness gate).
    advance(10_000);
    expect(ctrl.reapIdle()).toBe(0);
    expect(fake.killed).toBe(false);

    // Only once the pty actually exits (orphaned, dead-but-tracked) does the aged-
    // out session become reclaimable.
    fake.markExitedOrphaned();
    expect(ctrl.reapIdle()).toBe(1);
  });
});

// ── #778/#779 regression: multi-attach must never double-render output/echo ──
//
// The bug: the cloud/relay path mints a FRESH emit closure per dispatched RPC and
// a remount minted a FRESH attachId, so each re-subscription STACKED a new
// attacher. fanOut() then wrote every output frame — and every keystroke's pty
// echo — to the same logical client N times (`ls` → `llss`, output 2-4×). These
// pin the invariant: one logical client = exactly ONE attacher = output ONCE,
// across attach/reconnect with AND without a stable attachId, via fresh-emit
// closures (the relay shape).

describe("CyborgTerminalController (#778/#779) — dedup attachers, never double-render", () => {
  function controller(fake: ReturnType<typeof makeFakeSession>) {
    return new CyborgTerminalController(makeFakeManager(fake).manager, "/h", null, {
      reapIntervalMs: 0,
    });
  }

  // Count output FRAMES (not concatenated bytes) a client received for a marker —
  // a stacked attacher shows up as the same frame delivered more than once.
  function framesWith(sink: any[], marker: string): number {
    return sink.filter(
      (m) => m.type === "cyborg:terminal_output" && m.payload?.data?.includes(marker),
    ).length;
  }

  it("relay path: re-attach with the SAME attachId + a FRESH emit replaces in place (count stays 1, output once)", async () => {
    const fake = makeFakeSession("term-relay");
    const ctrl = controller(fake);
    // Each RPC arrives with a fresh emit closure (the relay-forward shape).
    const sink: any[] = [];
    const freshEmit = () => (m: any) => sink.push(m);

    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "mount-1" }, freshEmit());
    expect(ctrl.attacherCount("term-relay")).toBe(1);

    // A remount/reconnect re-issues attach with the SAME per-mount id but a brand
    // new emit closure — BEFORE the prior detach landed (or it never did). Must
    // REPLACE, not stack.
    ctrl.subscribe("term-relay", "u", freshEmit(), "mount-1");
    ctrl.subscribe("term-relay", "u", freshEmit(), "mount-1");
    expect(ctrl.attacherCount("term-relay")).toBe(1);

    sink.length = 0;
    fake.emitOutput("ls\n");
    await sleep(20);
    // Delivered EXACTLY once — not 2-4× as in the regression.
    expect(framesWith(sink, "ls")).toBe(1);
  });

  it("no attachId: re-attach with the SAME emit reference is idempotent (count stays 1)", async () => {
    const fake = makeFakeSession("term-emit");
    const ctrl = controller(fake);
    const sink: any[] = [];
    const emit = (m: any) => sink.push(m);

    // Desktop/in-process path: a single long-lived emit, no attachId.
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, emit);
    ctrl.subscribe("term-emit", "u", emit);
    ctrl.subscribe("term-emit", "u", emit);
    expect(ctrl.attacherCount("term-emit")).toBe(1);

    sink.length = 0;
    fake.emitOutput("echo\n");
    await sleep(20);
    expect(framesWith(sink, "echo")).toBe(1);
  });

  it("start → reconnect → attach (fresh emits, stable attachId) delivers output EXACTLY once", async () => {
    const fake = makeFakeSession("term-seq");
    const ctrl = controller(fake);
    // The client renders into one sink, but the transport hands the daemon a new
    // emit closure on every RPC — exactly the relay-forward behavior.
    const sink: any[] = [];
    const freshEmit = () => (m: any) => sink.push(m);

    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "view" }, freshEmit());
    // WS blips: the client re-attaches the SAME view (reattachLive, #774).
    ctrl.subscribe("term-seq", "u", freshEmit(), "view");
    // A later remount (tab switch, #761) re-attaches the SAME stable id again.
    ctrl.subscribe("term-seq", "u", freshEmit(), "view");
    expect(ctrl.attacherCount("term-seq")).toBe(1);

    sink.length = 0;
    fake.emitOutput("output-line\n");
    await sleep(20);
    expect(framesWith(sink, "output-line")).toBe(1);
  });

  it("owner's start viewer + owner's reopen (cloud path) collapse to ONE viewer — output once", async () => {
    // Terminals are owner-locked, so every viewer shares the owner's userId. On the
    // cloud path (attachId) the relay re-fans by userId to all the owner's sockets,
    // so the start viewer + a reopen must collapse to ONE — not fan the same frame
    // to two viewers (which the relay would then double onto the one live socket).
    const fake = makeFakeSession("term-owner-reopen");
    const ctrl = controller(fake);
    const sink: any[] = [];
    const emit = () => (m: any) => sink.push(m);

    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "start" }, emit());
    ctrl.subscribe("term-owner-reopen", "u", emit(), "reopen");
    expect(ctrl.attacherCount("term-owner-reopen")).toBe(1);

    sink.length = 0;
    fake.emitOutput("broadcast\n");
    await sleep(20);
    expect(framesWith(sink, "broadcast")).toBe(1);
  });
});

// ── #807 regression: leaked per-user viewer after a dirty disconnect ──────────
//
// The bug: in the cloud path the relay re-fans every owner-tagged frame to ALL of
// a user's live sockets BY userId. When a guest's socket died dirtily (app crash)
// nothing dropped its daemon-side terminal viewer. The user reopened with a FRESH
// attachId; findViewer couldn't match the stale viewer, so a 2nd viewer STACKED.
// The daemon then fanned every pty echo to two viewers, both re-fanned by the
// relay to the user's current socket → EVERY CHARACTER DOUBLED (triples after a
// second crash). The fix: on the cloud path (attachId present) addViewer collapses
// ANY existing viewer for the SAME userId before adding the new one.

describe("CyborgTerminalController (#807) — collapse leaked per-user viewer on re-subscribe", () => {
  function controller(fake: ReturnType<typeof makeFakeSession>) {
    return new CyborgTerminalController(makeFakeManager(fake).manager, "/h", null, {
      reapIntervalMs: 0,
    });
  }
  function framesWith(sink: any[], marker: string): number {
    return sink.filter(
      (m) => m.type === "cyborg:terminal_output" && m.payload?.data?.includes(marker),
    ).length;
  }

  it("a leaked viewer (dirty disconnect, no unsubscribe) is collapsed by a reopen with a fresh attachId — output once, not twice", async () => {
    const fake = makeFakeSession("term-leak");
    const ctrl = controller(fake);
    // The single browser the user actually has open renders into ONE sink — the
    // relay re-fans by userId to whatever sockets the user holds. Model that: every
    // surviving viewer's emit writes to the same sink.
    const sink: any[] = [];
    const reFannedEmit = () => (m: any) => sink.push(m);

    // First mount (attachId A). Then the app CRASHES — the socket dies dirtily, so
    // NO unsubscribe ever lands: the viewer for attachId A LEAKS on the daemon.
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "A" }, reFannedEmit());
    expect(ctrl.attacherCount("term-leak")).toBe(1);

    // The user reopens the app: a NEW mount with a FRESH attachId B. Pre-fix this
    // stacked a 2nd viewer (no attachId match). The per-user collapse drops the
    // leaked A viewer first, so there is EXACTLY ONE viewer for the user.
    ctrl.subscribe("term-leak", "u", reFannedEmit(), "B");
    expect(ctrl.attacherCount("term-leak")).toBe(1);

    // A single pty output frame now produces EXACTLY ONE emit (not two).
    sink.length = 0;
    fake.emitOutput("ls\n");
    await sleep(20);
    expect(framesWith(sink, "ls")).toBe(1);
  });

  it("a second crash+reopen still collapses to one viewer (no triple)", async () => {
    const fake = makeFakeSession("term-leak2");
    const ctrl = controller(fake);
    const sink: any[] = [];
    const emit = () => (m: any) => sink.push(m);

    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "A" }, emit());
    ctrl.subscribe("term-leak2", "u", emit(), "B"); // 1st reopen → collapse A
    ctrl.subscribe("term-leak2", "u", emit(), "C"); // 2nd reopen → collapse B
    expect(ctrl.attacherCount("term-leak2")).toBe(1);

    sink.length = 0;
    fake.emitOutput("x\n");
    await sleep(20);
    expect(framesWith(sink, "x")).toBe(1);
  });

  it("the collapse is keyed by userId, not global — a different user's viewer is never collapsed", async () => {
    // Terminals are owner-locked, so the public subscribe() path can't seat two
    // users' viewers. Drive addViewer directly (the unit under test) to prove the
    // collapse loop keys on userId: seating "bob" then re-seating "alice" with a
    // fresh attachId collapses ONLY alice's prior viewer, never bob's.
    const fake = makeFakeSession("term-twousers");
    const ctrl = controller(fake);
    // start() seats alice (the owner) with attachId "a1".
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "alice", attachId: "a1" }, () => {});
    const add = (ctrl as any).addViewer.bind(ctrl);
    const tracked = (ctrl as any).sessions.get("term-twousers");
    // Seat a second, DIFFERENT user's viewer directly (bypassing the owner-lock that
    // guards subscribe()) to construct the cross-user state under test.
    add(tracked, "bob", () => {}, "b1");
    expect(ctrl.attacherCount("term-twousers")).toBe(2);

    // Alice reopens with a FRESH attachId: only HER prior viewer collapses; bob's
    // is untouched (no cross-user collapse).
    add(tracked, "alice", () => {}, "a2");
    expect(ctrl.attacherCount("term-twousers")).toBe(2);
    const users = [...tracked.viewers].map((v: any) => v.userId).sort();
    expect(users).toEqual(["alice", "bob"]);
  });

  it("same-attachId re-subscribe still replaces in place (existing behavior preserved)", async () => {
    const fake = makeFakeSession("term-sameid");
    const ctrl = controller(fake);
    const sink: any[] = [];
    const emit = () => (m: any) => sink.push(m);

    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u", attachId: "view" }, emit());
    ctrl.subscribe("term-sameid", "u", emit(), "view"); // same id → replace in place
    expect(ctrl.attacherCount("term-sameid")).toBe(1);

    sink.length = 0;
    fake.emitOutput("once\n");
    await sleep(20);
    expect(framesWith(sink, "once")).toBe(1);
  });

  it("the LOCAL (non-relay) path is NOT collapsed — distinct emit closures stay distinct views", async () => {
    // No attachId = local/in-process path: there is no relay userId re-fan, so two
    // distinct local emit closures are two legitimately distinct views and must
    // NOT be collapsed (that would break the desktop/in-process multi-view path).
    const fake = makeFakeSession("term-local");
    const ctrl = controller(fake);
    const viewA: any[] = [];
    const viewB: any[] = [];

    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "u" }, (m) => viewA.push(m));
    ctrl.subscribe("term-local", "u", (m) => viewB.push(m)); // no attachId
    expect(ctrl.attacherCount("term-local")).toBe(2);

    fake.emitOutput("local\n");
    await sleep(20);
    expect(framesWith(viewA, "local")).toBe(1);
    expect(framesWith(viewB, "local")).toBe(1);
  });
});

// ── BUG-5: same-process re-attach to a freshly-exited shell ──────────────────

describe("CyborgTerminalController (internal docs BUG-5) — same-process dead history", () => {
  it("re-attach after a shell exit replays history without a daemon restart", async () => {
    const fake = makeFakeSession("term-justexited");
    const ctrl = new CyborgTerminalController(makeFakeManager(fake).manager, "/h", null, {
      reapIntervalMs: 0,
    });
    const tabA: any[] = [];
    await ctrl.start({ cols: 80, rows: 24, ownerUserId: "alice" }, (m) => tabA.push(m));
    fake.emitOutput("done\n");
    await sleep(20);

    // The shell exits on its own (NOT a daemon shutdown).
    fake.session.kill();
    expect(ctrl.sessionCount).toBe(0);
    // BUG-5: it became reachable history in the SAME process (no boot needed).
    expect(ctrl.deadSessionCount).toBe(1);

    const tabB: any[] = [];
    const res = ctrl.subscribe("term-justexited", "alice", (m) => tabB.push(m));
    expect(res.ok).toBe(true);
    expect(res.live).toBe(false);
    expect(res.endedReason).toBe("shell_exit");
    const out = tabB.find((m) => m.type === "cyborg:terminal_output");
    expect(out.payload.data).toContain("done");

    // Owner-locked even for same-process history.
    expect(ctrl.subscribe("term-justexited", "mallory", () => {}).ok).toBe(false);
  });
});

// ── Cross-restart persistence (#750) — controller ↔ persistence integration ──

describe("CyborgTerminalController (#750) — cross-restart history", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "term-ctrl-persist-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function persistence() {
    return new TerminalPersistenceStore({ baseDir, enabled: true, debounceMs: 0 });
  }

  it("a graceful dispose() persists the tail; the next daemon replays it read-only", async () => {
    // Daemon process #1: start a session, stream output, then shut down gracefully.
    const fake1 = makeFakeSession("term-restart");
    const ctrl1 = new CyborgTerminalController(
      makeFakeManager(fake1).manager,
      "/work/repo",
      persistence(),
    );
    await ctrl1.start(
      { cwd: "/work/repo", cols: 100, rows: 30, ownerUserId: "alice", workspaceId: "ws-1" },
      () => {},
    );
    fake1.emitOutput("$ npm run build\n");
    fake1.emitOutput("Built in 3.2s\n");
    await sleep(20);
    ctrl1.dispose(); // graceful shutdown flushes the final tail (endedAt stays null)

    // Daemon process #2: a NEW controller scans the same dir and finds the history.
    const fake2 = makeFakeSession("unused");
    const ctrl2 = new CyborgTerminalController(makeFakeManager(fake2).manager, "/h", persistence());
    expect(ctrl2.deadSessionCount).toBe(1);

    // Re-attaching to the dead session replays its scrollback as read-only history.
    const replayed: any[] = [];
    const res = ctrl2.subscribe("term-restart", "alice", (m) => replayed.push(m));
    expect(res.ok).toBe(true);
    expect(res.live).toBe(false); // the pty is GONE — read-only history
    expect(res.endedReason).toBe("daemon_restart");
    const out = replayed.find((m) => m.type === "cyborg:terminal_output");
    expect(out.payload.data).toContain("Built in 3.2s");
    expect(out.payload.toUserId).toBe("alice");
    // No new pty was spawned for the dead session.
    expect(ctrl2.sessionCount).toBe(0);
  });

  it("drains the coalescer tail into the .log BEFORE flush on graceful dispose (BUG-4)", async () => {
    // The bug: dispose() flushed persistence BEFORE draining the 5ms coalescer
    // window, so the very last burst of output never reached disk. Here we emit
    // output and dispose IMMEDIATELY — before the coalescer's 5ms timer fires — so
    // the bytes live only in the coalescer. A correct dispose drains first, so the
    // next daemon's history MUST contain them.
    const fake1 = makeFakeSession("term-tail");
    const ctrl1 = new CyborgTerminalController(
      makeFakeManager(fake1).manager,
      "/work",
      persistence(),
    );
    await ctrl1.start({ cols: 80, rows: 24, ownerUserId: "alice" }, () => {});
    fake1.emitOutput("FINAL_TAIL_BYTES");
    // NO sleep — the coalescer has NOT flushed; the tail is still buffered in it.
    ctrl1.dispose();

    const ctrl2 = new CyborgTerminalController(
      makeFakeManager(makeFakeSession("x")).manager,
      "/h",
      persistence(),
    );
    const replayed: any[] = [];
    const res = ctrl2.subscribe("term-tail", "alice", (m) => replayed.push(m));
    expect(res.ok).toBe(true);
    const out = replayed.find((m) => m.type === "cyborg:terminal_output");
    // The final pre-shutdown window survived to disk.
    expect(out.payload.data).toContain("FINAL_TAIL_BYTES");
  });

  it("post-restart history is owner-locked — a different user gets not-found", async () => {
    const fake1 = makeFakeSession("term-priv");
    const ctrl1 = new CyborgTerminalController(makeFakeManager(fake1).manager, "/h", persistence());
    await ctrl1.start({ cols: 80, rows: 24, ownerUserId: "alice" }, () => {});
    fake1.emitOutput("secret output\n");
    await sleep(20);
    ctrl1.dispose();

    const ctrl2 = new CyborgTerminalController(
      makeFakeManager(makeFakeSession("x")).manager,
      "/h",
      persistence(),
    );
    const res = ctrl2.subscribe("term-priv", "mallory", () => {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("forget() deletes the persisted history so it no longer surfaces", async () => {
    const fake1 = makeFakeSession("term-gone");
    const ctrl1 = new CyborgTerminalController(makeFakeManager(fake1).manager, "/h", persistence());
    await ctrl1.start({ cols: 80, rows: 24, ownerUserId: "alice" }, () => {});
    fake1.emitOutput("history\n");
    await sleep(20);
    ctrl1.dispose();

    const ctrl2 = new CyborgTerminalController(
      makeFakeManager(makeFakeSession("x")).manager,
      "/h",
      persistence(),
    );
    expect(ctrl2.deadSessionCount).toBe(1);
    // Owner-locked: a stranger can't forget it.
    expect(ctrl2.forget("term-gone", "mallory")).toBe(false);
    expect(ctrl2.forget("term-gone", "alice")).toBe(true);
    expect(ctrl2.subscribe("term-gone", "alice", () => {}).ok).toBe(false);
    expect(existsSync(join(baseDir, "terminals", "term-gone.log"))).toBe(false);
  });

  it("a shell that exits on its own persists as shell_exit history", async () => {
    const fake1 = makeFakeSession("term-exit");
    const ctrl1 = new CyborgTerminalController(makeFakeManager(fake1).manager, "/h", persistence());
    await ctrl1.start({ cols: 80, rows: 24, ownerUserId: "alice" }, () => {});
    fake1.emitOutput("bye\n");
    await sleep(20);
    fake1.session.kill(); // the shell exits by itself (NOT a daemon shutdown)

    const ctrl2 = new CyborgTerminalController(
      makeFakeManager(makeFakeSession("x")).manager,
      "/h",
      persistence(),
    );
    const res = ctrl2.subscribe("term-exit", "alice", () => {});
    expect(res.ok).toBe(true);
    expect(res.live).toBe(false);
    expect(res.endedReason).toBe("shell_exit"); // endedAt was stamped on exit
  });

  it("without a persistence store, terminals stay purely in-memory (no history)", async () => {
    const fake1 = makeFakeSession("term-mem");
    const ctrl1 = new CyborgTerminalController(makeFakeManager(fake1).manager, "/h"); // no store
    await ctrl1.start({ cols: 80, rows: 24, ownerUserId: "alice" }, () => {});
    fake1.emitOutput("ephemeral\n");
    await sleep(20);
    ctrl1.dispose();
    expect(existsSync(join(baseDir, "terminals"))).toBe(false);

    const ctrl2 = new CyborgTerminalController(makeFakeManager(makeFakeSession("x")).manager, "/h");
    expect(ctrl2.deadSessionCount).toBe(0);
    expect(ctrl2.subscribe("term-mem", "alice", () => {}).ok).toBe(false);
  });
});

// internal docs Phase 0 — the controller CONSUMES the snapshot Paseo delivers on
// every subscribe() (terminal.ts:998) and forwards it as a cyborg:terminal_snapshot
// frame. Previously this snapshot was DROPPED (the subscribe callback only handled
// "output"). These tests pin: (1) the snapshot is forwarded with the owner id, and
// (2) an output frame still flows after it (the live stream is untouched).
describe("CyborgTerminalController — Paseo snapshot forwarding (internal docs Phase 0)", () => {
  // A fake session whose subscribe() captures the listener so the test can drive a
  // Paseo `snapshot` (and `output`) message, mirroring terminal.ts's contract.
  function makeSnapshotSession(id: string) {
    let listener: ((msg: ServerMessage) => void) | null = null;
    const session = {
      id,
      name: id,
      cwd: "/h",
      send: () => {},
      // The controller PULLS a subscribe snapshot via getStateSnapshot(); this
      // test then drives a SEPARATE manager push (revision 7) to prove a later
      // pushed snapshot is also forwarded.
      getStateSnapshot: () => ({ state: state as any, revision: 0 }),
      subscribe: (l: (msg: ServerMessage) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
      onExit: () => () => {},
      kill: () => {},
    } as unknown as TerminalSession;
    const state = {
      rows: 1,
      cols: 2,
      grid: [[{ char: "Z" }]],
      scrollback: [],
      cursor: { row: 0, col: 1 },
    };
    return {
      session,
      state,
      emitSnapshot: () => listener?.({ type: "snapshot", state: state as any, revision: 7 }),
      emitOutput: (data: string) => listener?.({ type: "output", data }),
    };
  }

  it("forwards a cyborg:terminal_snapshot frame (owner-tagged) when Paseo emits a snapshot", async () => {
    const fake = makeSnapshotSession("term-snap");
    const manager = { createTerminal: async () => fake.session } as unknown as TerminalManager;
    const ctrl = new CyborgTerminalController(manager, "/h", null, { reapIntervalMs: 0 });
    const emitted: any[] = [];
    await ctrl.start({ cols: 2, rows: 1, ownerUserId: "alice" }, (m) => emitted.push(m));

    fake.emitSnapshot();

    // The manager-pushed snapshot (revision 7) is forwarded — distinct from the
    // proactive pull snapshot the controller emits on subscribe (revision 0).
    const snap = emitted.find(
      (m) => m.type === "cyborg:terminal_snapshot" && m.payload.revision === 7,
    );
    expect(snap).toBeDefined();
    expect(snap.payload.terminalId).toBe("term-snap");
    expect(snap.payload.toUserId).toBe("alice");
    expect(snap.payload.revision).toBe(7);
    // The serialized state round-trips as plain JSON (the Phase-0 serialization flag).
    expect(JSON.parse(JSON.stringify(snap.payload.state))).toEqual(fake.state);
    ctrl.dispose();
  });

  it("still streams live output after a snapshot (the live stream is unchanged)", async () => {
    const fake = makeSnapshotSession("term-snap2");
    const manager = { createTerminal: async () => fake.session } as unknown as TerminalManager;
    const ctrl = new CyborgTerminalController(manager, "/h", null, { reapIntervalMs: 0 });
    const emitted: any[] = [];
    await ctrl.start({ cols: 2, rows: 1, ownerUserId: "bob" }, (m) => emitted.push(m));

    fake.emitSnapshot();
    fake.emitOutput("after");
    await sleep(20);

    expect(emitted.some((m) => m.type === "cyborg:terminal_snapshot")).toBe(true);
    const out = emitted.find((m) => m.type === "cyborg:terminal_output");
    expect(out).toBeDefined();
    expect(out.payload.data).toContain("after");
    ctrl.dispose();
  });
});

// internal docs Phase 2 — subscribe/unsubscribe delegate to Paseo's MULTI-VIEWER
// listener Set: every subscribe() re-delivers a FRESH screen snapshot (the
// self-heal), unsubscribe drops one viewer and NEVER touches the pty, and live
// output fans out to all viewers without duplication. These tests prove the
// structural properties that kill #778/#784/#789 by construction.
describe("CyborgTerminalController — subscribe/unsubscribe (internal docs Phase 2)", () => {
  // A fake session that faithfully mirrors Paseo's subscribe() contract: it holds
  // a SET of listeners (multi-viewer), and EVERY subscribe() delivers a fresh
  // `{type:"snapshot"}` to that one listener on a microtask (terminal.ts:992-1002),
  // then streams output to all listeners. Returns an unsubscribe that drops just
  // that listener. This is what the controller's deliverFreshSnapshot() drives.
  function makeMultiViewerSession(id: string, markers: { value: string }) {
    const listeners = new Set<(msg: ServerMessage) => void>();
    let killed = false;
    let exitListener: ((info: TerminalExitInfo) => void) | null = null;
    const state = () =>
      ({
        rows: 1,
        cols: 2,
        grid: [[{ char: markers.value }]],
        scrollback: [],
        cursor: { row: 0, col: 1 },
      }) as unknown;
    const session = {
      id,
      name: id,
      cwd: "/h",
      send: () => {},
      // The controller PULLS the fresh subscribe snapshot via getStateSnapshot()
      // (the real worker/PtyHost managers never push one on attach). Each viewer's
      // subscribe just registers its listener for live output.
      getStateSnapshot: () => ({ state: state() as any, revision: 1 }),
      subscribe: (l: (msg: ServerMessage) => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      onExit: (l: (info: TerminalExitInfo) => void) => {
        exitListener = l;
        return () => {
          exitListener = null;
        };
      },
      kill: () => {
        if (killed) return;
        killed = true;
        exitListener?.({ exitCode: 0, signal: null, lastOutputLines: [] });
      },
    } as unknown as TerminalSession;
    return {
      session,
      get killed() {
        return killed;
      },
      emitOutput: (data: string) => {
        for (const l of listeners) l({ type: "output", data });
      },
    };
  }

  function controllerFor(fake: { session: TerminalSession }) {
    const manager = { createTerminal: async () => fake.session } as unknown as TerminalManager;
    return new CyborgTerminalController(manager, "/h", null, { reapIntervalMs: 0 });
  }

  it("subscribe() on a live session emits exactly one fresh snapshot before any output", async () => {
    const markers = { value: "A" };
    const fake = makeMultiViewerSession("term-sub", markers);
    const ctrl = controllerFor(fake);
    // start() is the first viewer; ignore its emit.
    await ctrl.start({ cols: 2, rows: 1, ownerUserId: "u" }, () => {});

    const viewer: any[] = [];
    const res = ctrl.subscribe("term-sub", "u", (m) => viewer.push(m));
    expect(res).toEqual({ ok: true, terminalId: "term-sub", live: true });

    // The fresh snapshot is delivered on a microtask (Paseo's write-flush seam).
    await Promise.resolve();
    await Promise.resolve();

    const snaps = viewer.filter((m) => m.type === "cyborg:terminal_snapshot");
    expect(snaps.length).toBe(1);
    expect(snaps[0].payload.terminalId).toBe("term-sub");
    expect(snaps[0].payload.toUserId).toBe("u");
    expect(snaps[0].payload.state.grid[0][0].char).toBe("A");

    // Live output then fans out to this viewer (it's now an attacher) and is NOT a
    // duplicate snapshot.
    fake.emitOutput("live\n");
    await sleep(20);
    const out = viewer.find((m) => m.type === "cyborg:terminal_output");
    expect(out.payload.data).toContain("live");
    // Still exactly one snapshot — output did not re-trigger it.
    expect(viewer.filter((m) => m.type === "cyborg:terminal_snapshot").length).toBe(1);
    ctrl.dispose();
  });

  it("two LOCAL-path subscribers each get their OWN fresh snapshot and BOTH receive output without duplication", async () => {
    // Proves Paseo's structural multi-viewer correctness (each viewer owns its own
    // subscription → its own snapshot, no double-delivery). Uses the LOCAL path
    // (no attachId) so the cloud per-user collapse (#807) — which keeps at most one
    // viewer per (terminal, userId) on the relay path — does not apply; distinct
    // local emit closures are legitimately distinct views.
    const markers = { value: "A" };
    const fake = makeMultiViewerSession("term-two", markers);
    const ctrl = controllerFor(fake);
    await ctrl.start({ cols: 2, rows: 1, ownerUserId: "u" }, () => {});

    const tabA: any[] = [];
    const tabB: any[] = [];
    ctrl.subscribe("term-two", "u", (m) => tabA.push(m)); // local path: no attachId
    // A second viewer subscribing must NOT disturb the first (Set, not single slot).
    ctrl.subscribe("term-two", "u", (m) => tabB.push(m));
    await Promise.resolve();
    await Promise.resolve();

    // Each viewer received exactly one snapshot of its own.
    expect(tabA.filter((m) => m.type === "cyborg:terminal_snapshot").length).toBe(1);
    expect(tabB.filter((m) => m.type === "cyborg:terminal_snapshot").length).toBe(1);
    expect(ctrl.attacherCount("term-two")).toBe(3); // start + 2 local subscribers

    // Live output fans out to BOTH, once each (no double-delivery — the #784 class).
    fake.emitOutput("shared\n");
    await sleep(20);
    expect(tabA.filter((m) => m.type === "cyborg:terminal_output").length).toBe(1);
    expect(tabB.filter((m) => m.type === "cyborg:terminal_output").length).toBe(1);
    ctrl.dispose();
  });

  it("unsubscribe() drops the viewer but does NOT kill the pty; resubscribe repaints from a fresh snapshot (no start)", async () => {
    const markers = { value: "A" };
    const fake = makeMultiViewerSession("term-re", markers);
    const ctrl = controllerFor(fake);
    const createdBefore = ctrl.sessionCount;
    // Cloud path: the owner's start carries an attachId, and a later owner mount
    // collapses onto it (one viewer per (terminal, userId) — #807).
    await ctrl.start({ cols: 2, rows: 1, ownerUserId: "u", attachId: "start" }, () => {});
    expect(ctrl.sessionCount).toBe(createdBefore + 1);

    const tab: any[] = [];
    ctrl.subscribe("term-re", "u", (m) => tab.push(m), "mount-1");
    await Promise.resolve();
    await Promise.resolve();
    // The owner's reopen collapsed the start viewer → exactly one viewer.
    expect(ctrl.attacherCount("term-re")).toBe(1);

    // Unsubscribe (tab switch): the viewer is dropped, the pty SURVIVES (not kill).
    expect(ctrl.unsubscribe("term-re", "u", { attachId: "mount-1" })).toBe(true);
    expect(ctrl.attacherCount("term-re")).toBe(0); // detached
    expect(ctrl.sessionCount).toBe(createdBefore + 1); // pty NOT killed
    expect(fake.killed).toBe(false);

    // Resubscribe (returning tab): a FRESH snapshot repaints — no new pty created.
    markers.value = "B";
    const tab2: any[] = [];
    ctrl.subscribe("term-re", "u", (m) => tab2.push(m), "mount-2");
    await Promise.resolve();
    await Promise.resolve();
    const snap = tab2.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap).toBeDefined();
    expect(snap.payload.state.grid[0][0].char).toBe("B");
    // The session count never grew past the single start() — resubscribe spawns no pty.
    expect(ctrl.sessionCount).toBe(createdBefore + 1);
    ctrl.dispose();
  });

  it("resubscribe (same attachId, FRESH emit) replaces the viewer in place: fresh snapshot, no double-render, dead old emit stops (internal docs P0b — #778/#789 impossible by construction)", async () => {
    // The structural payoff of "each viewer owns its own Paseo subscription": a
    // remount on the relay path re-issues subscribe with the SAME per-mount
    // attachId but a BRAND-NEW emit closure (the per-RPC forward emit), often
    // BEFORE the prior unsubscribe lands. Because the controller REPLACES the
    // viewer's subscription in place, (a) the new emit gets a FRESH self-heal
    // snapshot (no ack to drop — #789), (b) live output reaches the client EXACTLY
    // once (no stacked listener — #778/#784), and (c) the stale closure (its socket
    // is dead) receives nothing further.
    const markers = { value: "A" };
    const fake = makeMultiViewerSession("term-replace", markers);
    const ctrl = controllerFor(fake);
    await ctrl.start({ cols: 2, rows: 1, ownerUserId: "u", attachId: "view" }, () => {});

    const stale: any[] = [];
    ctrl.subscribe("term-replace", "u", (m) => stale.push(m), "view-tab");
    await Promise.resolve();
    await Promise.resolve();
    // Owner's start viewer ("view") collapsed onto this owner mount — one viewer
    // per (terminal, userId) on the cloud path (#807).
    expect(ctrl.attacherCount("term-replace")).toBe(1);

    // Remount: SAME attachId, FRESH emit, before any unsubscribe. Replace in place.
    markers.value = "B";
    const fresh: any[] = [];
    const res = ctrl.subscribe("term-replace", "u", (m) => fresh.push(m), "view-tab");
    expect(res).toEqual({ ok: true, terminalId: "term-replace", live: true });
    // STILL one viewer (the single logical owner view) — NOT two (no stacking).
    expect(ctrl.attacherCount("term-replace")).toBe(1);
    await Promise.resolve();
    await Promise.resolve();

    // The fresh emit got its own self-heal snapshot (the current screen, "B"). No
    // ack, no start — the snapshot IS the repaint.
    const snap = fresh.find((m) => m.type === "cyborg:terminal_snapshot");
    expect(snap).toBeDefined();
    expect(snap.payload.state.grid[0][0].char).toBe("B");

    // Live output now reaches the fresh emit EXACTLY once, and the stale (replaced)
    // emit — whose Paseo subscription was torn down — receives nothing further.
    const staleLen = stale.length;
    fake.emitOutput("after-remount\n");
    await sleep(20);
    expect(
      fresh.filter(
        (m) => m.type === "cyborg:terminal_output" && m.payload?.data?.includes("after-remount"),
      ).length,
    ).toBe(1);
    expect(stale.length).toBe(staleLen);
    ctrl.dispose();
  });

  it("subscribe() to an unknown/dead session reports not-found (no pty spawned)", () => {
    const markers = { value: "A" };
    const fake = makeMultiViewerSession("term-x", markers);
    const ctrl = controllerFor(fake);
    const res = ctrl.subscribe("ghost", "u", () => {});
    expect(res.ok).toBe(false);
    expect(ctrl.sessionCount).toBe(0);
    ctrl.dispose();
  });

  it("subscribe() is owner-locked — a non-owner cannot watch the stream", async () => {
    const markers = { value: "A" };
    const fake = makeMultiViewerSession("term-own", markers);
    const ctrl = controllerFor(fake);
    await ctrl.start({ cols: 2, rows: 1, ownerUserId: "alice" }, () => {});
    const res = ctrl.subscribe("term-own", "mallory", () => {});
    expect(res.ok).toBe(false);
    ctrl.dispose();
  });
});

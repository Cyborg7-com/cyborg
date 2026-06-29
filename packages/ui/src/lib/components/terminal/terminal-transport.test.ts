import { describe, it, expect, vi } from "vitest";
import {
  accessoryKeyBytes,
  ctrlByte,
  relayTerminalTransport,
  desktopBridgeTransport,
  resolveTerminalSession,
  type TerminalSocket,
  type TerminalSubscribeResult,
} from "./terminal-transport.js";

describe("accessoryKeyBytes", () => {
  it("encodes the special keys the soft keyboard lacks", () => {
    expect(accessoryKeyBytes("esc")).toBe("\x1b");
    expect(accessoryKeyBytes("tab")).toBe("\t");
    expect(accessoryKeyBytes("up")).toBe("\x1b[A");
    expect(accessoryKeyBytes("down")).toBe("\x1b[B");
    expect(accessoryKeyBytes("right")).toBe("\x1b[C");
    expect(accessoryKeyBytes("left")).toBe("\x1b[D");
    expect(accessoryKeyBytes("pipe")).toBe("|");
    expect(accessoryKeyBytes("tilde")).toBe("~");
    expect(accessoryKeyBytes("slash")).toBe("/");
  });
});

describe("ctrlByte", () => {
  it("maps letters to their control codes (Ctrl-C = 0x03)", () => {
    expect(ctrlByte("c")).toBe("\x03");
    expect(ctrlByte("C")).toBe("\x03");
    expect(ctrlByte("a")).toBe("\x01");
    expect(ctrlByte("z")).toBe("\x1a");
    expect(ctrlByte("[")).toBe("\x1b"); // Ctrl-[ = ESC
  });

  it("returns null for input with no control form", () => {
    expect(ctrlByte("1")).toBeNull();
    expect(ctrlByte("")).toBeNull();
    expect(ctrlByte("ab")).toBeNull();
  });
});

function fakeSocket(opts: { withReconnect?: boolean; withDaemonReconnect?: boolean } = {}) {
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const sent: Record<string, unknown>[] = [];
  const reconnectHandlers = new Set<() => void>();
  const daemonReconnectHandlers = new Map<string, Set<() => void>>();
  const socket: TerminalSocket = {
    send: (m) => sent.push(m),
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set();
      set.add(handler);
      handlers.set(type, set);
      return () => set.delete(handler);
    },
  };
  // A desktop/older socket omits onReconnect; the relay socket provides it.
  if (opts.withReconnect) {
    socket.onReconnect = (handler) => {
      reconnectHandlers.add(handler);
      return () => reconnectHandlers.delete(handler);
    };
  }
  // internal docs FIX-1: the relay socket also surfaces a daemon offline→online edge.
  if (opts.withDaemonReconnect) {
    socket.onDaemonReconnect = (daemonId, handler) => {
      const set = daemonReconnectHandlers.get(daemonId) ?? new Set();
      set.add(handler);
      daemonReconnectHandlers.set(daemonId, set);
      return () => set.delete(handler);
    };
  }
  const emit = (type: string, payload: Record<string, unknown>) => {
    for (const h of handlers.get(type) ?? []) h(payload);
  };
  const fireReconnect = () => {
    for (const h of reconnectHandlers) h();
  };
  const fireDaemonReconnect = (daemonId: string) => {
    for (const h of daemonReconnectHandlers.get(daemonId) ?? []) h();
  };
  return { socket, sent, emit, fireReconnect, fireDaemonReconnect };
}

describe("relayTerminalTransport (#657 contract)", () => {
  it("start sends cyborg:start_terminal and resolves on ok + matching requestId", async () => {
    const { socket, sent, emit } = fakeSocket();
    const t = relayTerminalTransport({
      socket,
      workspaceId: "ws1",
      daemonId: "d1",
      newRequestId: () => "req-1",
    });
    const p = t.start({ cols: 80, rows: 24, command: "bash", cwd: "/tmp" });
    // No `command` on the wire — the daemon runs the login shell.
    expect(sent[0]).toEqual({
      type: "cyborg:start_terminal",
      requestId: "req-1",
      workspaceId: "ws1",
      daemonId: "d1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
    });
    // A response for a DIFFERENT request is ignored…
    emit("cyborg:start_terminal_response", { requestId: "other", ok: true, terminalId: "nope" });
    // …the matching ok one resolves with terminalId → id.
    emit("cyborg:start_terminal_response", { requestId: "req-1", ok: true, terminalId: "term-9" });
    await expect(p).resolves.toEqual({ id: "term-9" });
  });

  it("start rejects on an ok:false response, surfacing the error", async () => {
    const { socket, emit } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "req-1" });
    const p = t.start({ cols: 80, rows: 24 });
    emit("cyborg:start_terminal_response", {
      requestId: "req-1",
      ok: false,
      error: "daemon offline",
    });
    await expect(p).rejects.toThrow(/daemon offline/);
  });

  it("start rejects (and unsubscribes) on timeout when the daemon never responds", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = fakeSocket();
      const t = relayTerminalTransport({
        socket,
        workspaceId: "ws1",
        newRequestId: () => "req-1",
        startTimeoutMs: 1000,
      });
      const p = t.start({ cols: 80, rows: 24 });
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("start reaper kills an orphan pty when a late ack lands after the timeout (#48 BUG-5)", async () => {
    vi.useFakeTimers();
    try {
      const { socket, sent, emit } = fakeSocket();
      const t = relayTerminalTransport({
        socket,
        workspaceId: "ws1",
        daemonId: "d1",
        newRequestId: () => "req-1",
        startTimeoutMs: 1000,
      });
      const p = t.start({ cols: 80, rows: 24 });
      const assertion = expect(p).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(1000); // start rejects; reaper armed
      await assertion;
      // The daemon DID spawn the pty; its ack arrives after we gave up. We can no
      // longer surface it, so reap it instead of leaking it on the daemon.
      emit("cyborg:start_terminal_response", {
        requestId: "req-1",
        ok: true,
        terminalId: "orphan-1",
      });
      expect(sent).toContainEqual({
        type: "cyborg:kill_terminal",
        workspaceId: "ws1",
        daemonId: "d1",
        terminalId: "orphan-1",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("start reaper stops listening after its bounded window (no permanent leak)", async () => {
    vi.useFakeTimers();
    try {
      const { socket, sent, emit } = fakeSocket();
      const t = relayTerminalTransport({
        socket,
        workspaceId: "ws1",
        newRequestId: () => "req-1",
        startTimeoutMs: 1000,
      });
      const p = t.start({ cols: 80, rows: 24 });
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(1000); // reject + reaper armed
      await vi.advanceTimersByTimeAsync(1000); // reaper window elapses → unsubscribe
      const before = sent.length;
      emit("cyborg:start_terminal_response", {
        requestId: "req-1",
        ok: true,
        terminalId: "too-late",
      });
      expect(sent.length).toBe(before); // listener gone → no kill sent
    } finally {
      vi.useRealTimers();
    }
  });

  it("start reaper does not kill on a late ok:false ack (nothing was spawned)", async () => {
    vi.useFakeTimers();
    try {
      const { socket, sent, emit } = fakeSocket();
      const t = relayTerminalTransport({
        socket,
        workspaceId: "ws1",
        newRequestId: () => "req-1",
        startTimeoutMs: 1000,
      });
      const p = t.start({ cols: 80, rows: 24 });
      p.catch(() => {});
      await vi.advanceTimersByTimeAsync(1000);
      const before = sent.length;
      emit("cyborg:start_terminal_response", { requestId: "req-1", ok: false, error: "no pty" });
      expect(sent.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("input/resize/kill send the contract messages with terminalId", () => {
    const { socket, sent } = fakeSocket();
    const t = relayTerminalTransport({
      socket,
      workspaceId: "ws1",
      daemonId: "d1",
      newRequestId: () => "r",
    });
    t.input("term-9", "ls\n");
    t.resize("term-9", 100, 30);
    t.kill("term-9");
    expect(sent).toEqual([
      {
        type: "cyborg:terminal_input",
        workspaceId: "ws1",
        daemonId: "d1",
        terminalId: "term-9",
        data: "ls\n",
      },
      {
        type: "cyborg:terminal_resize",
        workspaceId: "ws1",
        daemonId: "d1",
        terminalId: "term-9",
        cols: 100,
        rows: 30,
      },
      { type: "cyborg:kill_terminal", workspaceId: "ws1", daemonId: "d1", terminalId: "term-9" },
    ]);
  });

  it("onData forwards only well-formed terminal_output payloads", () => {
    const { socket, emit } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "r" });
    const seen: { id: string; data: string }[] = [];
    t.onData((p) => seen.push(p));
    emit("cyborg:terminal_output", { terminalId: "t1", data: "hello" });
    emit("cyborg:terminal_output", { terminalId: "t1" }); // malformed — dropped
    emit("cyborg:terminal_output", { data: "x" }); // malformed — dropped
    expect(seen).toEqual([{ id: "t1", data: "hello" }]);
  });

  it("onExit maps a null/missing code to 0 and ignores id-less payloads", () => {
    const { socket, emit } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "r" });
    const seen: { id: string; exitCode: number }[] = [];
    t.onExit((p) => seen.push(p));
    emit("cyborg:terminal_exit", { terminalId: "t1", code: 137 });
    emit("cyborg:terminal_exit", { terminalId: "t1", code: null }); // signal kill
    emit("cyborg:terminal_exit", { code: 1 }); // no terminalId — dropped
    expect(seen).toEqual([
      { id: "t1", exitCode: 137 },
      { id: "t1", exitCode: 0 },
    ]);
  });

  it("onData/onExit return working unsubscribers", () => {
    const { socket, emit } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "r" });
    const seen: unknown[] = [];
    const off = t.onData((p) => seen.push(p));
    off();
    emit("cyborg:terminal_output", { terminalId: "t1", data: "x" });
    expect(seen).toEqual([]);
  });

  it("onReconnect is undefined when the socket has no reconnect signal (desktop/older socket)", () => {
    const { socket } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "r" });
    expect(t.onReconnect).toBeUndefined();
  });

  it("onReconnect forwards the socket's reconnect signal, and its unsubscriber works (#48 BUG-2)", () => {
    const { socket, fireReconnect } = fakeSocket({ withReconnect: true });
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "r" });
    expect(t.onReconnect).toBeDefined();
    let fired = 0;
    const off = t.onReconnect!(() => {
      fired++;
    });
    fireReconnect();
    expect(fired).toBe(1);
    off();
    fireReconnect();
    expect(fired).toBe(1); // unsubscribed → no further calls
  });

  // ── internal docs FIX-2: subscribe/attach distinguish DEAD vs TRANSIENT, and
  // thread live/endedReason through (internal docs PART B) ─────────────────────
  it("subscribe TIMEOUT resolves { ok:false, dead:false } (transient, not a dead-end)", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = fakeSocket();
      const t = relayTerminalTransport({
        socket,
        workspaceId: "ws1",
        newRequestId: () => "req-1",
        startTimeoutMs: 1000,
      });
      const p = t.subscribe!("term-1");
      await vi.advanceTimersByTimeAsync(1000);
      // A timeout is transient — dead must be false so the caller retries.
      await expect(p).resolves.toMatchObject({ ok: false, dead: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribe NEGATIVE ack resolves { ok:false, dead:true } (authoritative dead session)", async () => {
    const { socket, emit } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "req-1" });
    const p = t.subscribe!("term-1");
    emit("cyborg:attach_terminal_response", {
      requestId: "req-1",
      ok: false,
      error: "session gone",
      endedReason: "daemon_restart",
    });
    await expect(p).resolves.toEqual({
      ok: false,
      dead: true,
      endedReason: "daemon_restart",
      error: "session gone",
    });
  });

  it("subscribe POSITIVE ack with live:false resolves { ok:true, live:false, endedReason } (#750 read-only history)", async () => {
    const { socket, emit } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "req-1" });
    const p = t.subscribe!("term-1");
    emit("cyborg:attach_terminal_response", {
      requestId: "req-1",
      ok: true,
      live: false,
      endedReason: "shell_exit",
    });
    await expect(p).resolves.toEqual({ ok: true, live: false, endedReason: "shell_exit" });
  });

  it("subscribe SNAPSHOT (live) resolves { ok:true, live:true } (ack-free Phase 2)", async () => {
    const { socket, emit } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "req-1" });
    const p = t.subscribe!("term-1");
    emit("cyborg:terminal_snapshot", { terminalId: "term-1", state: {} });
    await expect(p).resolves.toEqual({ ok: true, live: true });
  });

  // ── internal docs FIX-1: onDaemonReconnect forwarding ─────────────────────────
  it("onDaemonReconnect is undefined when the socket has no daemon-status signal", () => {
    const { socket } = fakeSocket();
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "r" });
    expect(t.onDaemonReconnect).toBeUndefined();
  });

  it("onDaemonReconnect forwards the socket's daemon offline→online edge, gated on daemonId", () => {
    const { socket, fireDaemonReconnect } = fakeSocket({ withDaemonReconnect: true });
    const t = relayTerminalTransport({ socket, workspaceId: "ws1", newRequestId: () => "r" });
    expect(t.onDaemonReconnect).toBeDefined();
    let fired = 0;
    const off = t.onDaemonReconnect!("d1", () => {
      fired++;
    });
    // A flip for a DIFFERENT daemon does nothing.
    fireDaemonReconnect("d2");
    expect(fired).toBe(0);
    // The view's daemon flipping back online fires the handler.
    fireDaemonReconnect("d1");
    expect(fired).toBe(1);
    off();
    fireDaemonReconnect("d1");
    expect(fired).toBe(1); // unsubscribed → no further calls
  });

  it("start/subscribe carry the per-mount attachId on the wire (internal docs GAP-1)", async () => {
    const { socket, sent, emit } = fakeSocket();
    const t = relayTerminalTransport({
      socket,
      workspaceId: "ws1",
      daemonId: "d1",
      newRequestId: () => "req-1",
    });
    const p = t.start({ cols: 80, rows: 24, attachId: "mount-1" });
    expect(sent[0]).toMatchObject({ type: "cyborg:start_terminal", attachId: "mount-1" });
    emit("cyborg:start_terminal_response", { requestId: "req-1", ok: true, terminalId: "t1" });
    await p;
    const ps = t.subscribe!("t1", "mount-1");
    expect(sent.at(-1)).toMatchObject({ type: "cyborg:subscribe_terminal", attachId: "mount-1" });
    // A live subscribe self-heals via the snapshot frame (ack-free).
    emit("cyborg:terminal_snapshot", { terminalId: "t1" });
    await ps;
  });

  it("unsubscribe sends cyborg:unsubscribe_terminal with the attachId and does NOT kill", () => {
    const { socket, sent } = fakeSocket();
    const t = relayTerminalTransport({
      socket,
      workspaceId: "ws1",
      daemonId: "d1",
      newRequestId: () => "r",
    });
    t.unsubscribe!("term-9", "mount-1");
    expect(sent).toEqual([
      {
        type: "cyborg:unsubscribe_terminal",
        workspaceId: "ws1",
        daemonId: "d1",
        terminalId: "term-9",
        attachId: "mount-1",
      },
    ]);
    // unsubscribe must NOT emit a kill — the pty survives for re-subscribe (#738/#762).
    expect(sent.some((m) => m.type === "cyborg:kill_terminal")).toBe(false);
  });
});

describe("resolveTerminalSession (subscribe — NO start-fallback, internal docs)", () => {
  // Minimal deps factory: spies for subscribe/start/kill + a controllable token.
  function makeDeps(
    overrides: Partial<{
      terminalId?: string;
      subscribe?: (id: string) => Promise<TerminalSubscribeResult>;
      start?: () => Promise<{ id: string }>;
      // isCurrent() answers, consumed in order; the last value sticks. Models a
      // mount that's still alive at one checkpoint but torn down at a later one.
      current: boolean[];
    }> = {},
  ) {
    const subscribe = vi.fn(overrides.subscribe ?? (async () => ({ ok: true })));
    const start = vi.fn(overrides.start ?? (async () => ({ id: "fresh-pty" })));
    const kill = vi.fn(async () => {});
    const attachAttempts: string[] = [];
    const disposed: number[] = [];
    let n = 0;
    const currentAnswers = overrides.current ?? [true];
    let currentCall = 0;
    const deps = {
      terminalId: "terminalId" in overrides ? overrides.terminalId : "existing-pty",
      subscribe:
        "subscribe" in overrides && overrides.subscribe === undefined ? undefined : subscribe,
      start,
      kill,
      isCurrent: () => currentAnswers[Math.min(currentCall++, currentAnswers.length - 1)],
      onAttachAttempt: (id: string) => {
        attachAttempts.push(id);
        const tag = ++n;
        return () => disposed.push(tag);
      },
    };
    return { deps, subscribe, start, kill, attachAttempts, disposed };
  }

  it("subscribe SUCCEEDS → no start() call (no duplicate pty), reuses the existing id", async () => {
    const { deps, subscribe, start } = makeDeps({ subscribe: async () => ({ ok: true }) });
    const outcome = await resolveTerminalSession(deps);
    expect(outcome).toEqual({ kind: "subscribed", id: "existing-pty" });
    expect(subscribe).toHaveBeenCalledWith("existing-pty");
    expect(start).not.toHaveBeenCalled();
  });

  it("subscribe AUTHORITATIVE DEAD ack (ok:false, dead:true) → 'ended', NEVER a fresh start() (internal docs FIX-2)", async () => {
    const { deps, subscribe, start, disposed } = makeDeps({
      subscribe: async () => ({ ok: false, dead: true, endedReason: "daemon_restart" }),
    });
    const outcome = await resolveTerminalSession(deps);
    // An authoritative dead session dead-ends to the read-only/[Restart] UX — and
    // NEVER spawns a new pty (the deleted #789 fallback), so it's never orphaned.
    expect(outcome.kind).toBe("ended");
    expect(outcome.id).toBeNull();
    expect(outcome.endedReason).toBe("daemon_restart");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    // The early subscription is unwound.
    expect(disposed).toEqual([1]);
  });

  it("subscribe TRANSIENT failure (ok:false, dead:false) → 'transient', KEEPS the wire-up (cold-reopen blank fix)", async () => {
    const { deps, subscribe, start, disposed } = makeDeps({
      subscribe: async () => ({ ok: false, dead: false, error: "timed out" }),
    });
    const outcome = await resolveTerminalSession(deps);
    // A timeout / link-down is recoverable: the caller shows "reconnecting" and
    // retries (FIX-3), never the "no longer available" dead-end.
    expect(outcome.kind).toBe("transient");
    // REGRESSION GUARD (cold-reopen blank, root-caused 2026-06-22): the wire-up must
    // NOT be disposed on a transient. On a fast reopen the subscribe ACK times out
    // (transient) while the daemon is mid-pty-host-reattach, then replays the ring +
    // snapshot a beat LATER. If we unwound the onData/onSnapshot listeners here, those
    // late frames (and reattachLive's re-subscribe) would land on listeners=0 and the
    // terminal would stay BLANK forever. So the subscription survives + the id is
    // returned so the caller re-attaches to it.
    expect(outcome.id).toBe("existing-pty");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    expect(disposed).toEqual([]);
  });

  it("subscribe POSITIVE ack onto a DEAD session (ok:true, live:false) → 'ended' (read-only #750 history)", async () => {
    const { deps, start, disposed } = makeDeps({
      subscribe: async () => ({ ok: true, live: false, endedReason: "shell_exit" }),
    });
    const outcome = await resolveTerminalSession(deps);
    // The daemon attached + replayed dead scrollback — surface 'ended' so the view
    // renders it read-only with [Restart]. Crucially the wire-up is NOT disposed
    // (the scrollback output frames flow through it), so disposed stays empty.
    expect(outcome.kind).toBe("ended");
    expect(outcome.id).toBe("existing-pty");
    expect(outcome.endedReason).toBe("shell_exit");
    expect(start).not.toHaveBeenCalled();
    expect(disposed).toEqual([]);
  });

  it("subscribe THROWS → 'transient' (a transport bug is treated as recoverable, never spawns a duplicate)", async () => {
    const { deps, start, disposed } = makeDeps({
      subscribe: async () => {
        throw new Error("socket exploded");
      },
    });
    const outcome = await resolveTerminalSession(deps);
    expect(outcome.kind).toBe("transient");
    expect(start).not.toHaveBeenCalled();
    // Same cold-reopen guard: a transient (here from a thrown transport error) keeps
    // the wire-up so a late/retried daemon response still has listeners to paint into.
    expect(disposed).toEqual([]);
  });

  it("no subscribe support (desktop bridge) → start() directly", async () => {
    const { deps, start } = makeDeps({
      subscribe: undefined,
      terminalId: undefined,
    });
    const outcome = await resolveTerminalSession(deps);
    expect(outcome).toEqual({ kind: "started", id: "fresh-pty" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("brand-new terminal (no terminalId) → start() even when subscribe is available", async () => {
    const { deps, subscribe, start } = makeDeps({
      terminalId: undefined,
      subscribe: async () => ({ ok: true }),
    });
    const outcome = await resolveTerminalSession(deps);
    expect(outcome).toEqual({ kind: "started", id: "fresh-pty" });
    expect(subscribe).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("start (new terminal) fails → 'failed' surfaces the error screen", async () => {
    const { deps } = makeDeps({
      terminalId: undefined,
      subscribe: undefined,
      start: async () => {
        throw new Error("daemon offline");
      },
    });
    const outcome = await resolveTerminalSession(deps);
    expect(outcome.kind).toBe("failed");
    expect(outcome.id).toBeNull();
    expect(outcome.error).toMatch(/daemon offline/);
  });

  it("aborts (and kills the orphan) when the mount is torn down during a NEW start()", async () => {
    const { deps, start, kill } = makeDeps({
      terminalId: undefined,
      subscribe: undefined,
      current: [false], // torn down by the post-start check (only one isCurrent call)
    });
    const outcome = await resolveTerminalSession(deps);
    expect(outcome).toEqual({ kind: "aborted", id: null });
    expect(start).toHaveBeenCalledTimes(1);
    // The orphan pty we opened post-unmount must be killed, never leaked.
    expect(kill).toHaveBeenCalledWith("fresh-pty");
  });

  it("aborts WITHOUT start() when the mount is torn down during subscribe()", async () => {
    const { deps, start, disposed } = makeDeps({
      subscribe: async () => ({ ok: true }),
      current: [false], // unmounted by the post-subscribe check
    });
    const outcome = await resolveTerminalSession(deps);
    expect(outcome).toEqual({ kind: "aborted", id: null });
    // Lost the race during subscribe — do NOT spawn a fresh pty into a dead view.
    expect(start).not.toHaveBeenCalled();
    // The early subscription is unwound on abort.
    expect(disposed).toEqual([1]);
  });
});

describe("resolveTerminalSession onStartAttempt (early-frame wiring, BUG-3)", () => {
  // A StartSubscription spy: records adopt(id)/dispose() in call order so we can
  // assert the early-frame subscription is bound BEFORE start() resolves and
  // unwound on the right edges.
  function startSub() {
    const calls: string[] = [];
    return {
      sub: {
        adopt: (id: string) => calls.push(`adopt:${id}`),
        dispose: () => calls.push("dispose"),
      },
      calls,
    };
  }

  it("calls onStartAttempt BEFORE start() resolves, then adopt(id) on success", async () => {
    const { sub, calls } = startSub();
    const order: string[] = [];
    const onStartAttempt = vi.fn(() => {
      order.push("subscribe");
      return sub;
    });
    const start = vi.fn(async () => {
      order.push("start");
      return { id: "fresh-pty" };
    });
    const outcome = await resolveTerminalSession({
      terminalId: undefined,
      start,
      kill: async () => {},
      isCurrent: () => true,
      onStartAttempt,
    });
    expect(outcome).toEqual({ kind: "started", id: "fresh-pty" });
    // Subscription wired before start() was even invoked — no lost first frame.
    expect(order).toEqual(["subscribe", "start"]);
    expect(calls).toEqual(["adopt:fresh-pty"]);
  });

  it("disposes the early subscription (no adopt) when start() fails", async () => {
    const { sub, calls } = startSub();
    const outcome = await resolveTerminalSession({
      terminalId: undefined,
      start: async () => {
        throw new Error("daemon offline");
      },
      kill: async () => {},
      isCurrent: () => true,
      onStartAttempt: () => sub,
    });
    expect(outcome.kind).toBe("failed");
    expect(calls).toEqual(["dispose"]);
  });

  it("disposes the early subscription AND kills the orphan when torn down mid-start", async () => {
    const { sub, calls } = startSub();
    const kill = vi.fn(async () => {});
    let alive = true;
    const outcome = await resolveTerminalSession({
      terminalId: undefined,
      start: async () => {
        alive = false; // unmounted while start() was in flight
        return { id: "fresh-pty" };
      },
      kill,
      isCurrent: () => alive,
      onStartAttempt: () => sub,
    });
    expect(outcome).toEqual({ kind: "aborted", id: null });
    // Early sub unwound, never adopted; the orphan pty killed (never leaked).
    expect(calls).toEqual(["dispose"]);
    expect(kill).toHaveBeenCalledWith("fresh-pty");
  });

  it("a FAILED (re)subscribe never invokes onStartAttempt (no start-fallback, deleted #789 path)", async () => {
    const onStartAttempt = vi.fn(() => startSub().sub);
    const outcome = await resolveTerminalSession({
      terminalId: "existing-pty",
      subscribe: async () => ({ ok: false, dead: true, error: "session not found" }),
      start: async () => ({ id: "fresh-pty" }),
      kill: async () => {},
      isCurrent: () => true,
      onAttachAttempt: () => () => {},
      onStartAttempt,
    });
    // No start() wiring on a dead session — the fallback is gone.
    expect(outcome.kind).toBe("ended");
    expect(onStartAttempt).not.toHaveBeenCalled();
  });

  it("subscribe SUCCESS never invokes onStartAttempt (no duplicate wiring)", async () => {
    const onStartAttempt = vi.fn(() => startSub().sub);
    const outcome = await resolveTerminalSession({
      terminalId: "existing-pty",
      subscribe: async () => ({ ok: true }),
      start: async () => ({ id: "fresh-pty" }),
      kill: async () => {},
      isCurrent: () => true,
      onAttachAttempt: () => () => {},
      onStartAttempt,
    });
    expect(outcome).toEqual({ kind: "subscribed", id: "existing-pty" });
    expect(onStartAttempt).not.toHaveBeenCalled();
  });
});

describe("desktopBridgeTransport", () => {
  it("passes through to the bridge with command mapping", async () => {
    const bridge = {
      start: vi.fn(async () => ({ id: "b1" })),
      input: vi.fn(async () => {}),
      resize: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    };
    const t = desktopBridgeTransport(bridge);
    await t.start({ cols: 80, rows: 24, command: "cybo-login", cwd: "/x" });
    expect(bridge.start).toHaveBeenCalledWith({ cols: 80, rows: 24, command: "cybo-login" });
    t.input("b1", "y");
    expect(bridge.input).toHaveBeenCalledWith("b1", "y");
  });
});

// PtyHost — the detached, long-lived process that OWNS every pty so a LIVE
// session survives a daemon restart (internal docs PART A, internal docs).
//
// One host per daemon-home. On start it unlink+listen on a stable unix socket
// ($PASEO_HOME/pty-host.sock, 0700 dir / 0600 sock). It REUSES Paseo's engine
// verbatim — createTerminal() from ../../terminal/terminal.ts — so we never
// re-own xterm/node-pty behavior; we own only the lifetime + socket transport
// (internal docs). It holds Map<terminalId, TerminalSession> plus a
// per-terminal output ring buffer, so a re-attaching daemon replays whatever
// scrolled by while it was down.
//
// THE SURVIVAL PROPERTY (the inversion of the Paseo worker's suicide-on-IPC-
// disconnect, terminal-worker-process.ts:241): when a client socket drops, the
// host keeps every pty ALIVE and waits for the next attach. It exits only when
// (a) zero live ptys AND zero clients past a grace window, or (b) an explicit
// shutdown request. This is the abduco/dtach model rmux validated.
//
// This file is the host ENTRY when run as a child process (see the bottom
// guard), and also exports startPtyHost() so tests can spawn a host in-process.

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import {
  createTerminal,
  type TerminalSession,
  type ServerMessage,
} from "../../terminal/terminal.js";
import {
  ensurePtyHostBaseDir,
  resolvePtyHostSocketPath,
  resolvePtyHostSocketPathFromEnv,
} from "./pty-host-paths.js";
import {
  FrameDecoder,
  encodeFrame,
  PTY_HOST_CAPABILITIES,
  PTY_HOST_WIRE_VERSION,
  type PtyHostCreateOptions,
  type PtyHostEvent,
  type PtyHostHelloResult,
  type PtyHostRequest,
  type PtyHostTerminalInfo,
  type PtyHostToClientMessage,
} from "./pty-host-protocol.js";

// Each output chunk pushed to attached clients is also appended to a per-terminal
// ring, trimmed to this budget. A re-attaching daemon replays the ring so the
// user sees what scrolled while the daemon was down (internal docs). Same
// 256 KiB budget the #750 on-disk history uses.
const RING_LIMIT_BYTES = 256 * 1024;

// Grace window after the LAST client detaches with zero live ptys before the host
// self-exits (internal docs (a)). Generous so a daemon restart's brief
// reconnect gap never trips it.
const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

interface HostTerminal {
  session: TerminalSession;
  unsubMessage: () => void;
  unsubExit: () => void;
  unsubTitle: () => void;
  unsubCommand: () => void;
  ring: Buffer[];
  ringBytes: number;
  rows: number;
  cols: number;
  exited: boolean;
}

export interface PtyHostHandle {
  socketPath: string;
  close(): Promise<void>;
  // Test/introspection.
  terminalCount(): number;
  clientCount(): number;
}

export interface StartPtyHostOptions {
  baseDir?: string;
  socketPath?: string;
  idleShutdownMs?: number;
  // When true (the default for the standalone entry), the host arranges to exit
  // the process on idle/shutdown. Tests pass false and call close() themselves.
  exitProcessOnShutdown?: boolean;
}

export async function startPtyHost(options: StartPtyHostOptions = {}): Promise<PtyHostHandle> {
  const baseDir = ensurePtyHostBaseDir(options.baseDir);
  // Path precedence: explicit option (tests) → CYBORG7_PTY_HOST_SOCKET env the
  // launcher set → PASEO_HOME-derived path. Reading the env (#860 latent fix) keeps
  // launcher + host on the SAME socket instead of relying on both deriving the same
  // PASEO_HOME. When a baseDir is given explicitly (in-process hosts / tests), it
  // wins over the ambient env so an isolated host never grabs the real daemon sock.
  const socketPath =
    options.socketPath ??
    (options.baseDir !== undefined
      ? resolvePtyHostSocketPath(options.baseDir)
      : resolvePtyHostSocketPathFromEnv(baseDir));
  const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
  const exitProcessOnShutdown = options.exitProcessOnShutdown ?? false;

  const terminals = new Map<string, HostTerminal>();
  const clients = new Set<Socket>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;

  // Stale socket from a previous host that died without cleanup: unlink before
  // bind, else listen() throws EADDRINUSE (internal docs connect-or-start path —
  // the launcher only spawns us after a failed connect, so any leftover sock is
  // dead).
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // intentional: if unlink fails, listen() surfaces the real bind error below.
    }
  }

  function broadcast(event: PtyHostEvent): void {
    const frame = encodeFrame(event);
    for (const client of clients) {
      if (client.writable) {
        client.write(frame);
      }
    }
  }

  function appendRing(t: HostTerminal, chunk: Buffer): void {
    let piece = chunk;
    if (piece.length > RING_LIMIT_BYTES) {
      piece = piece.subarray(piece.length - RING_LIMIT_BYTES);
    }
    t.ring.push(piece);
    t.ringBytes += piece.length;
    while (t.ringBytes > RING_LIMIT_BYTES && t.ring.length > 1) {
      const dropped = t.ring.shift();
      if (dropped) t.ringBytes -= dropped.length;
    }
  }

  function toInfo(id: string, t: HostTerminal): PtyHostTerminalInfo {
    const title = t.session.getTitle();
    return {
      id,
      name: t.session.name,
      cwd: t.session.cwd,
      ...(title ? { title } : {}),
      rows: t.rows,
      cols: t.cols,
    };
  }

  function wireTerminal(session: TerminalSession): HostTerminal {
    const size = session.getSize();
    const t: HostTerminal = {
      session,
      unsubMessage: () => {},
      unsubExit: () => {},
      unsubTitle: () => {},
      unsubCommand: () => {},
      ring: [],
      ringBytes: 0,
      rows: size.rows,
      cols: size.cols,
      exited: false,
    };
    // Session-level subscription independent of any client (so output keeps
    // filling the ring even while no daemon is attached). The host forwards every
    // output frame to attached clients AND appends it to the ring; it ignores the
    // self-heal `snapshot` (each daemon-side viewer pulls its own on re-attach).
    t.unsubMessage = session.subscribe((msg: ServerMessage) => {
      if (msg.type === "output") {
        appendRing(t, Buffer.from(msg.data, "utf8"));
      }
      broadcast({ type: "terminalMessage", terminalId: session.id, message: msg });
    });
    t.unsubExit = session.onExit((info) => {
      t.exited = true;
      broadcast({ type: "terminalExit", terminalId: session.id, info });
      cleanupTerminal(session.id);
      scheduleIdleShutdownCheck();
    });
    t.unsubTitle = session.onTitleChange((title) => {
      broadcast({ type: "terminalTitleChange", terminalId: session.id, title });
    });
    t.unsubCommand = session.onCommandFinished((info) => {
      broadcast({ type: "terminalCommandFinished", terminalId: session.id, info });
    });
    return t;
  }

  function cleanupTerminal(id: string): void {
    const t = terminals.get(id);
    if (!t) return;
    terminals.delete(id);
    try {
      t.unsubMessage();
      t.unsubExit();
      t.unsubTitle();
      t.unsubCommand();
    } catch {
      // best-effort teardown — never throw out of cleanup.
    }
  }

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // Self-exit only when there is nothing left to host AND nobody attached
  // (internal docs (a)). A live pty or any connected client keeps the host up.
  function scheduleIdleShutdownCheck(): void {
    clearIdleTimer();
    if (closing) return;
    if (terminals.size > 0 || clients.size > 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (terminals.size === 0 && clients.size === 0 && !closing) {
        void close();
      }
    }, idleShutdownMs);
    (idleTimer as { unref?: () => void })?.unref?.();
  }

  async function killAllAndWait(): Promise<void> {
    const ids = Array.from(terminals.keys());
    await Promise.all(
      ids.map(async (id) => {
        const t = terminals.get(id);
        if (!t) return;
        try {
          await t.session.killAndWait();
        } catch {
          // best-effort — a pty that throws on kill must not block shutdown.
        }
        cleanupTerminal(id);
      }),
    );
  }

  function handleRequest(socket: Socket, req: PtyHostRequest): void {
    void dispatchRequest(socket, req).catch((err: unknown) => {
      respond(socket, req.requestId, {
        ok: false,
        error: err instanceof Error ? err.message : "pty-host request failed",
      });
    });
  }

  function respond(
    socket: Socket,
    requestId: string,
    result: { ok: true; result?: unknown } | { ok: false; error: string },
  ): void {
    if (!socket.writable) return;
    socket.write(encodeFrame({ type: "response", requestId, ...result } as PtyHostToClientMessage));
  }

  // Replay the ring to a single freshly-attaching client as one output event so
  // the daemon's viewer repaints what scrolled while it was detached/down
  // (internal docs). Sent only to the attaching socket, not broadcast.
  function replayRing(socket: Socket, id: string, t: HostTerminal): void {
    if (t.ring.length === 0 || !socket.writable) return;
    const data = Buffer.concat(t.ring).toString("utf8");
    socket.write(
      encodeFrame({
        type: "terminalMessage",
        terminalId: id,
        message: { type: "output", data },
      } as PtyHostEvent),
    );
  }

  function handleHello(socket: Socket, req: Extract<PtyHostRequest, { type: "hello" }>): void {
    const result: PtyHostHelloResult = {
      wireVersion: PTY_HOST_WIRE_VERSION,
      capabilities: [...PTY_HOST_CAPABILITIES],
      pid: process.pid,
    };
    respond(socket, req.requestId, { ok: true, result });
  }

  function handleListTerminals(
    socket: Socket,
    req: Extract<PtyHostRequest, { type: "listTerminals" }>,
  ): void {
    const list: PtyHostTerminalInfo[] = [];
    for (const [id, t] of terminals) {
      if (!t.exited) list.push(toInfo(id, t));
    }
    respond(socket, req.requestId, { ok: true, result: list });
  }

  async function handleCreateTerminal(
    socket: Socket,
    req: Extract<PtyHostRequest, { type: "createTerminal" }>,
  ): Promise<void> {
    const opts: PtyHostCreateOptions = req.options;
    const session = await createTerminal({
      ...(opts.id ? { id: opts.id } : {}),
      cwd: opts.cwd,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.command ? { command: opts.command } : {}),
      ...(opts.args ? { args: opts.args } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    const t = wireTerminal(session);
    terminals.set(session.id, t);
    clearIdleTimer();
    respond(socket, req.requestId, { ok: true, result: toInfo(session.id, t) });
  }

  function handleAttach(socket: Socket, req: Extract<PtyHostRequest, { type: "attach" }>): void {
    const t = terminals.get(req.terminalId);
    if (!t || t.exited) {
      respond(socket, req.requestId, { ok: false, error: "terminal not found" });
      return;
    }
    replayRing(socket, req.terminalId, t);
    respond(socket, req.requestId, { ok: true, result: toInfo(req.terminalId, t) });
  }

  function handleInput(socket: Socket, req: Extract<PtyHostRequest, { type: "input" }>): void {
    const t = terminals.get(req.terminalId);
    if (!t) {
      respond(socket, req.requestId, { ok: false, error: "terminal not found" });
      return;
    }
    if (req.message.type === "resize") {
      t.rows = req.message.rows;
      t.cols = req.message.cols;
    }
    t.session.send(req.message);
    respond(socket, req.requestId, { ok: true });
  }

  function handleSetTitle(
    socket: Socket,
    req: Extract<PtyHostRequest, { type: "setTitle" }>,
  ): void {
    const t = terminals.get(req.terminalId);
    if (!t) {
      respond(socket, req.requestId, { ok: false, error: "terminal not found" });
      return;
    }
    t.session.setTitle(req.title);
    respond(socket, req.requestId, { ok: true });
  }

  async function handleKillAndWait(
    socket: Socket,
    req: Extract<PtyHostRequest, { type: "killAndWait" }>,
  ): Promise<void> {
    const t = terminals.get(req.terminalId);
    if (!t) {
      respond(socket, req.requestId, { ok: true });
      return;
    }
    await t.session.killAndWait(req.options);
    cleanupTerminal(req.terminalId);
    respond(socket, req.requestId, { ok: true });
  }

  async function dispatchRequest(socket: Socket, req: PtyHostRequest): Promise<void> {
    switch (req.type) {
      case "hello":
        return handleHello(socket, req);
      case "listTerminals":
        return handleListTerminals(socket, req);
      case "createTerminal":
        return handleCreateTerminal(socket, req);
      case "attach":
        return handleAttach(socket, req);
      case "detach":
        // The host does not track per-socket attachment beyond connection
        // membership; detach is an explicit ack so the daemon can re-attach later.
        return respond(socket, req.requestId, { ok: true });
      case "input":
        return handleInput(socket, req);
      case "setTitle":
        return handleSetTitle(socket, req);
      case "kill":
        terminals.get(req.terminalId)?.session.kill();
        return respond(socket, req.requestId, { ok: true });
      case "killAndWait":
        return handleKillAndWait(socket, req);
      case "shutdown":
        respond(socket, req.requestId, { ok: true });
        return close();
    }
  }

  function onConnection(socket: Socket): void {
    clients.add(socket);
    clearIdleTimer();
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: string) => {
      let frames: unknown[];
      try {
        frames = decoder.feed(chunk);
      } catch (err) {
        // A malformed frame is a protocol violation on a trusted local socket —
        // drop the connection rather than risk mis-parsing the stream.
        socket.destroy(err instanceof Error ? err : new Error("bad pty-host frame"));
        return;
      }
      for (const frame of frames) {
        handleRequest(socket, frame as PtyHostRequest);
      }
    });
    const drop = (): void => {
      // THE SURVIVAL INVERSION: a dropped client NEVER kills ptys. We only remove
      // it from the client set and, if nothing is left to host, arm the idle exit.
      if (clients.delete(socket)) {
        scheduleIdleShutdownCheck();
      }
    };
    socket.on("close", drop);
    socket.on("error", () => {
      // A socket error is just a dead client on a local rendezvous; never fatal to
      // the host. Surfaced here so it doesn't bubble to an unhandled 'error'.
      drop();
    });
  }

  const server: Server = createServer(onConnection);

  async function close(): Promise<void> {
    if (closing) return;
    closing = true;
    clearIdleTimer();
    await killAllAndWait();
    for (const client of clients) {
      client.destroy();
    }
    clients.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // intentional: a failed unlink on shutdown is harmless — the next host
        // unlinks any stale sock before binding.
      }
    }
    if (exitProcessOnShutdown) {
      process.exit(0);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  // A host with no clients yet (just spawned) must not instantly self-exit before
  // the launcher's first connect lands; the grace window covers that, and the
  // first connection clears the timer.
  scheduleIdleShutdownCheck();

  return {
    socketPath,
    close,
    terminalCount: () => terminals.size,
    clientCount: () => clients.size,
  };
}

// Standalone entry: when this module is the process's main module (spawned
// detached by the launcher), boot a host that exits the process on shutdown.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url.endsWith(entry);
}

if (isMainModule()) {
  // The launcher passes the socket path as a trailing argv (in ADDITION to the
  // CYBORG7_PTY_HOST_SOCKET env) so it shows up in this host's `ps` command line —
  // the orphan reaper scopes its kill set to a daemon's PASEO_HOME by matching it.
  // The env stays the source of truth; argv is the visible-in-ps mirror, used here
  // only when present so an env-only spawn still works.
  const socketArg = process.argv[2];
  const startOptions = {
    exitProcessOnShutdown: true,
    ...(socketArg ? { socketPath: socketArg } : {}),
  };
  startPtyHost(startOptions).catch((err: unknown) => {
    // A host that can't bind its socket is unusable — exit non-zero so the
    // launcher's connect-or-start probe falls back cleanly rather than hanging on
    // a half-booted host.
    process.stderr.write(
      `pty-host: failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

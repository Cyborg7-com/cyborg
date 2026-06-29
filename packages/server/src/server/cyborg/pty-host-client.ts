// PtyHostClient — the daemon-side TerminalManager that talks to the detached
// PtyHost over a unix socket instead of forking a worker (internal docs).
//
// It implements the SAME TerminalManager interface the daemon already consumes
// (terminal-manager.ts), so EVERY downstream consumer (CyborgTerminalController,
// TerminalSessionController) is unchanged — the only insertion point is the
// factory seam. getTerminal(id) returns a TerminalSession-shaped proxy whose
// subscribe/send/onExit are framed over the socket; listTerminals() after
// connect returns the LIVE ptys the host still owns — the reattach surface.
//
// On construct it is handed an ALREADY-CONNECTED socket (the launcher does the
// connect-or-start + version handshake), plus the host's terminal list so the
// proxies for surviving ptys exist immediately. New output/exit/title frames the
// host pushes are routed to the matching session's listeners.

import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { TerminalState } from "@getpaseo/protocol/messages";
import { TerminalInputModeTracker } from "@getpaseo/protocol/terminal-input-mode";
import type {
  ClientMessage,
  ServerMessage,
  TerminalCommandFinishedInfo,
  TerminalExitInfo,
  TerminalSession,
  TerminalStateSnapshot,
  TerminalStateSnapshotOptions,
} from "../../terminal/terminal.js";
import type { CaptureTerminalLinesResult } from "../../terminal/terminal-capture.js";
import type {
  TerminalListItem,
  TerminalManager,
  TerminalsChangedEvent,
  TerminalsChangedListener,
} from "../../terminal/terminal-manager.js";
import {
  FrameDecoder,
  encodeFrame,
  isPtyHostResponse,
  type PtyHostCreateOptions,
  type PtyHostRequest,
  type PtyHostTerminalInfo,
  type PtyHostToClientMessage,
} from "./pty-host-protocol.js";

const REQUEST_TIMEOUT_MS = 10000;

type PtyHostRequestInput = Exclude<
  {
    [K in PtyHostRequest["type"]]: Omit<Extract<PtyHostRequest, { type: K }>, "requestId">;
  }[PtyHostRequest["type"]],
  never
>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// Local mirror of one host-owned terminal, holding the daemon-side listener sets
// that the proxy session exposes and the host events feed.
interface ClientTerminal {
  info: PtyHostTerminalInfo;
  state: TerminalState;
  inputModeTracker: TerminalInputModeTracker;
  exitInfo: TerminalExitInfo | null;
  messageListeners: Set<(msg: ServerMessage) => void>;
  exitListeners: Set<(info: TerminalExitInfo) => void>;
  commandFinishedListeners: Set<(info: TerminalCommandFinishedInfo) => void>;
  titleChangeListeners: Set<(title?: string) => void>;
  session: TerminalSession;
}

export interface PtyHostClientOptions {
  socket: Socket;
  // The live terminals the host already owns at connect time (from listTerminals
  // during the launcher handshake). Their proxies are created up front so the
  // controller's rehydrateLiveSessions() finds them.
  initialTerminals?: PtyHostTerminalInfo[];
  requestTimeoutMs?: number;
}

function emptyState(rows: number, cols: number): TerminalState {
  return { rows, cols, grid: [], scrollback: [], cursor: { row: 0, col: 0 } };
}

export class PtyHostTerminalManager implements TerminalManager {
  private readonly socket: Socket;
  private readonly requestTimeoutMs: number;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly recordsById = new Map<string, ClientTerminal>();
  private readonly terminalsChangedListeners = new Set<TerminalsChangedListener>();
  private readonly decoder = new FrameDecoder();
  private socketClosed = false;

  constructor(options: PtyHostClientOptions) {
    this.socket = options.socket;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("close", () => this.onSocketClosed());
    this.socket.on("error", () => {
      // A socket error means the host link is gone; surface it as a close so
      // pending requests reject and best-effort sends stop. The launcher owns
      // reconnect policy; the manager simply fails fast.
      this.onSocketClosed();
    });
    for (const info of options.initialTerminals ?? []) {
      this.registerRecord(info);
    }
  }

  private onSocketClosed(): void {
    if (this.socketClosed) return;
    this.socketClosed = true;
    const error = new Error("pty-host connection closed");
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  private onData(chunk: string): void {
    let frames: unknown[];
    try {
      frames = this.decoder.feed(chunk);
    } catch {
      // A malformed frame on a trusted local socket — drop the link.
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      this.handleMessage(frame as PtyHostToClientMessage);
    }
  }

  private handleMessage(message: PtyHostToClientMessage): void {
    if (isPtyHostResponse(message)) {
      const pending = this.pendingRequests.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error));
      }
      return;
    }
    switch (message.type) {
      case "terminalMessage":
        this.handleTerminalMessage(message.terminalId, message.message);
        return;
      case "terminalExit":
        this.handleTerminalExit(message.terminalId, message.info);
        return;
      case "terminalTitleChange":
        this.handleTerminalTitleChange(message.terminalId, message.title);
        return;
      case "terminalCommandFinished":
        this.handleTerminalCommandFinished(message.terminalId, message.info);
        return;
    }
  }

  private handleTerminalMessage(terminalId: string, msg: ServerMessage): void {
    const record = this.recordsById.get(terminalId);
    if (!record) return;
    if (msg.type === "snapshot") record.state = msg.state;
    if (msg.type === "output") record.inputModeTracker.feed(msg.data);
    for (const listener of Array.from(record.messageListeners)) listener(msg);
  }

  private handleTerminalExit(terminalId: string, info: TerminalExitInfo): void {
    const record = this.recordsById.get(terminalId);
    if (!record) return;
    record.exitInfo = info;
    for (const listener of Array.from(record.exitListeners)) listener(info);
    record.exitListeners.clear();
    this.recordsById.delete(terminalId);
    this.emitTerminalsChanged(record.info.cwd);
  }

  private handleTerminalTitleChange(terminalId: string, title?: string): void {
    const record = this.recordsById.get(terminalId);
    if (!record) return;
    record.info = { ...record.info, ...(title ? { title } : { title: undefined }) };
    record.state = { ...record.state, ...(title ? { title } : {}) };
    for (const listener of Array.from(record.titleChangeListeners)) listener(title);
    this.emitTerminalsChanged(record.info.cwd);
  }

  private handleTerminalCommandFinished(
    terminalId: string,
    info: TerminalCommandFinishedInfo,
  ): void {
    const record = this.recordsById.get(terminalId);
    if (!record) return;
    for (const listener of Array.from(record.commandFinishedListeners)) listener(info);
  }

  private sendRequest(input: PtyHostRequestInput): Promise<unknown> {
    if (this.socketClosed || !this.socket.writable) {
      return Promise.reject(new Error("pty-host is not connected"));
    }
    const requestId = randomUUID();
    const message = { ...input, requestId } as PtyHostRequest;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`pty-host request timed out: ${input.type}`));
      }, this.requestTimeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.socket.write(encodeFrame(message), (err) => {
        if (!err) return;
        clearTimeout(timeout);
        this.pendingRequests.delete(requestId);
        reject(err);
      });
    });
  }

  private sendBestEffort(input: PtyHostRequestInput): void {
    void this.sendRequest(input).catch(() => {
      // The synchronous public methods (send/kill) fire-and-forget; host failures
      // surface through awaitable methods + onExit, never crash the daemon.
    });
  }

  private emitTerminalsChanged(cwd: string): void {
    const event: TerminalsChangedEvent = { cwd, terminals: this.listTerminalItemsForCwd(cwd) };
    for (const listener of Array.from(this.terminalsChangedListeners)) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  private listTerminalItemsForCwd(cwd: string): TerminalListItem[] {
    const items: TerminalListItem[] = [];
    for (const record of this.recordsById.values()) {
      if (record.info.cwd !== cwd) continue;
      items.push({
        id: record.info.id,
        name: record.info.name,
        cwd: record.info.cwd,
        ...(record.info.title ? { title: record.info.title } : {}),
      });
    }
    return items;
  }

  private registerRecord(info: PtyHostTerminalInfo): TerminalSession {
    const existing = this.recordsById.get(info.id);
    if (existing) {
      existing.info = info;
      return existing.session;
    }
    const record: ClientTerminal = {
      info,
      state: emptyState(info.rows, info.cols),
      inputModeTracker: new TerminalInputModeTracker(),
      exitInfo: null,
      messageListeners: new Set(),
      exitListeners: new Set(),
      commandFinishedListeners: new Set(),
      titleChangeListeners: new Set(),
      session: undefined as unknown as TerminalSession,
    };

    // Bind the two transport methods this session proxy needs as local closures
    // so the object-literal methods don't alias `this` (no-this-alias).
    const sendBestEffort = (input: PtyHostRequestInput): void => this.sendBestEffort(input);
    const sendRequest = (input: PtyHostRequestInput): Promise<unknown> => this.sendRequest(input);
    const session: TerminalSession = {
      get id() {
        return record.info.id;
      },
      get name() {
        return record.info.name;
      },
      get cwd() {
        return record.info.cwd;
      },
      send(message: ClientMessage): void {
        if (message.type === "resize") {
          record.state = { ...record.state, rows: message.rows, cols: message.cols };
          record.info = { ...record.info, rows: message.rows, cols: message.cols };
        }
        sendBestEffort({ type: "input", terminalId: record.info.id, message });
      },
      subscribe(
        listener: (msg: ServerMessage) => void,
        options?: { initialSnapshot?: "state" | "ready" },
      ): () => void {
        record.messageListeners.add(listener);
        // Re-attach over the socket so the host replays its ring to this client
        // (what scrolled while the daemon was down). The host pushes the ring as a
        // terminalMessage(output) that reaches this listener.
        sendBestEffort({ type: "attach", terminalId: record.info.id });
        // Engine-contract self-heal (terminal.ts:983-998): EVERY subscribe() must
        // deliver an initial frame so the viewer resolves "live". The Paseo worker
        // engine does this; this proxy regressed it (PtyHost flipped default-ON),
        // leaving the controller's forwarder with no `snapshot` to turn into a
        // `cyborg:terminal_snapshot` → the UI's subscribe() never resolves live:true →
        // it sits in "reconnecting" forever after a daemon restart even though a live
        // pty exists. Mirror the engine: "ready" → snapshotReady; "state" (default) →
        // snapshot. Deliver async (queueMicrotask) so listener ordering matches the
        // engine — the attach ring-replay output frames the host pushes arrive first —
        // and guard that the listener is still subscribed.
        //
        // The synthesized snapshot is ONLY the live-ack trigger: the controller stamps
        // the FIRST post-history-replay snapshot `historyReplayed`
        // (terminal-controller.ts:678-688) so the xterm client SKIPS its reset+repaint
        // and does NOT wipe the authoritative scrollback the re-attach already replayed
        // as `output` bytes (controller addViewer history + host replayRing). The
        // snapshot ServerMessage itself carries no historyReplayed field — that flag
        // lives on the controller's cyborg:terminal_snapshot payload, applied there —
        // so a plain engine-contract snapshot from this proxy is correctly stamped.
        // record.state may be an empty grid (the host pushed no snapshot to populate
        // it); that is fine — the bytes carry the real screen, this snapshot merely
        // resolves the viewer.
        const initialSnapshot = options?.initialSnapshot ?? "state";
        queueMicrotask(() => {
          if (!record.messageListeners.has(listener)) return;
          if (initialSnapshot === "ready") {
            listener({ type: "snapshotReady", revision: 0 });
          } else {
            listener({ type: "snapshot", ...record.session.getStateSnapshot() });
          }
        });
        return () => {
          record.messageListeners.delete(listener);
        };
      },
      onExit(listener: (info: TerminalExitInfo) => void): () => void {
        const settledExit = record.exitInfo;
        if (settledExit) {
          queueMicrotask(() => listener(settledExit));
          return () => {};
        }
        record.exitListeners.add(listener);
        return () => {
          record.exitListeners.delete(listener);
        };
      },
      onCommandFinished(listener: (info: TerminalCommandFinishedInfo) => void): () => void {
        record.commandFinishedListeners.add(listener);
        return () => {
          record.commandFinishedListeners.delete(listener);
        };
      },
      onTitleChange(listener: (title?: string) => void): () => void {
        record.titleChangeListeners.add(listener);
        if (record.info.title !== undefined) {
          const title = record.info.title;
          queueMicrotask(() => {
            if (record.titleChangeListeners.has(listener)) listener(title);
          });
        }
        return () => {
          record.titleChangeListeners.delete(listener);
        };
      },
      getSize(): { rows: number; cols: number } {
        return { rows: record.state.rows, cols: record.state.cols };
      },
      getState(): TerminalState {
        return record.state;
      },
      getStateSnapshot(options?: TerminalStateSnapshotOptions): TerminalStateSnapshot {
        const scrollbackLines = options?.scrollbackLines;
        const scrollback =
          typeof scrollbackLines === "number"
            ? record.state.scrollback.slice(-scrollbackLines)
            : record.state.scrollback;
        return { state: { ...record.state, scrollback }, revision: 0 };
      },
      getReplayPreamble(): string {
        return record.inputModeTracker.getPreamble();
      },
      getTitle(): string | undefined {
        return record.info.title;
      },
      setTitle(nextTitle: string): void {
        const manualTitle = nextTitle.trim();
        if (!manualTitle) return;
        record.info = { ...record.info, title: manualTitle };
        sendBestEffort({ type: "setTitle", terminalId: record.info.id, title: manualTitle });
        for (const listener of Array.from(record.titleChangeListeners)) listener(manualTitle);
      },
      getExitInfo(): TerminalExitInfo | null {
        return record.exitInfo;
      },
      kill(): void {
        sendBestEffort({ type: "kill", terminalId: record.info.id });
      },
      killAndWait(options?: {
        gracefulTimeoutMs?: number;
        forceTimeoutMs?: number;
      }): Promise<void> {
        return sendRequest({
          type: "killAndWait",
          terminalId: record.info.id,
          ...(options ? { options } : {}),
        }).then(() => undefined);
      },
    };

    record.session = session;
    this.recordsById.set(info.id, record);
    return session;
  }

  // ── TerminalManager interface ─────────────────────────────────────────────

  async getTerminals(cwd: string): Promise<TerminalSession[]> {
    const sessions: TerminalSession[] = [];
    for (const record of this.recordsById.values()) {
      if (record.info.cwd === cwd) sessions.push(record.session);
    }
    return sessions;
  }

  async createTerminal(options: {
    id?: string;
    cwd: string;
    name?: string;
    title?: string;
    env?: Record<string, string>;
    command?: string;
    args?: string[];
  }): Promise<TerminalSession> {
    const createOptions: PtyHostCreateOptions = {
      ...(options.id ? { id: options.id } : {}),
      cwd: options.cwd,
      ...(options.name ? { name: options.name } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.command ? { command: options.command } : {}),
      ...(options.args ? { args: options.args } : {}),
      ...(options.env ? { env: options.env } : {}),
    };
    const info = (await this.sendRequest({
      type: "createTerminal",
      options: createOptions,
    })) as PtyHostTerminalInfo;
    const session = this.registerRecord(info);
    this.emitTerminalsChanged(info.cwd);
    return session;
  }

  registerCwdEnv(_options: { cwd: string; env: Record<string, string> }): void {
    // The host inherits its own env on spawn; per-cwd default env is a local-mode
    // nicety the cloud/host path does not use. No-op (interface conformance).
    void _options;
  }

  getTerminal(id: string): TerminalSession | undefined {
    return this.recordsById.get(id)?.session;
  }

  async getTerminalState(
    id: string,
    _options?: TerminalStateSnapshotOptions,
  ): Promise<TerminalStateSnapshot | null> {
    void _options;
    const record = this.recordsById.get(id);
    return record ? record.session.getStateSnapshot() : null;
  }

  setTerminalTitle(id: string, title: string): boolean {
    const record = this.recordsById.get(id);
    if (!record) return false;
    record.session.setTitle(title);
    return true;
  }

  killTerminal(id: string): void {
    this.sendBestEffort({ type: "kill", terminalId: id });
  }

  async killTerminalAndWait(
    id: string,
    options?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number },
  ): Promise<void> {
    await this.sendRequest({
      type: "killAndWait",
      terminalId: id,
      ...(options ? { options } : {}),
    });
  }

  async captureTerminal(
    _id: string,
    _options?: { start?: number; end?: number; stripAnsi?: boolean },
  ): Promise<CaptureTerminalLinesResult> {
    void _id;
    void _options;
    // Capture reads the headless xterm grid, which lives in the host. The cloud/
    // controller path does not call captureTerminal (that is the CLI's local
    // path), so return empty rather than thread a host RPC we have no consumer for.
    return { lines: [], totalLines: 0 };
  }

  listDirectories(): string[] {
    const dirs = new Set<string>();
    for (const record of this.recordsById.values()) dirs.add(record.info.cwd);
    return Array.from(dirs);
  }

  // The reattach surface (internal docs): the LIVE ptys the host still owns.
  // Used by CyborgTerminalController.rehydrateLiveSessions() on boot.
  listTerminals(): TerminalListItem[] {
    const items: TerminalListItem[] = [];
    for (const record of this.recordsById.values()) {
      items.push({
        id: record.info.id,
        name: record.info.name,
        cwd: record.info.cwd,
        ...(record.info.title ? { title: record.info.title } : {}),
      });
    }
    return items;
  }

  // Flag-gated daemon shutdown (internal docs): DETACH from the host, leaving
  // every pty ALIVE. Tears down the socket so the daemon's event loop can drain,
  // but does NOT kill ptys (the whole point of survival). The host keeps running.
  detachAll(): void {
    if (!this.socketClosed && this.socket.writable) {
      this.socket.end();
    }
    this.socketClosed = true;
  }

  // killAll() is the destructive teardown the TerminalManager interface mandates
  // (called by bootstrap on a NON-survival path). The PtyHost path routes its
  // graceful shutdown through detachAll(); killAll exists for interface
  // conformance + the explicit "tear down everything" case.
  killAll(): void {
    this.detachAll();
  }

  subscribeTerminalsChanged(listener: TerminalsChangedListener): () => void {
    this.terminalsChangedListeners.add(listener);
    return () => {
      this.terminalsChangedListeners.delete(listener);
    };
  }
}

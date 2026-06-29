// Wire protocol for the cyborg PtyHost (internal docs PART A, internal docs).
//
// The PtyHost is a cyborg-owned, detached, long-lived process that OWNS every
// pty (it reuses Paseo's createTerminal() engine verbatim) and exposes
// attach/input/resize/kill/listTerminals over a unix domain socket. A restarted
// daemon RECONNECTS to the same running host and re-attaches to live ptys — the
// control plane is the socket (a function of $PASEO_HOME), NOT a parent↔child
// IPC pipe a restart would sever (internal docs).
//
// This module is the ONLY shared surface between pty-host-process.ts (server)
// and pty-host-client.ts (the daemon-side TerminalManager). It defines:
//   • the newline-delimited JSON framing both ends speak,
//   • the request/response/event message union,
//   • the wire-protocol VERSION + capability set for the version-skew handshake
// (internal docs): on connect the daemon inspects the host's version → if
//     compatible it reuses live ptys; if incompatible it drains the host's ptys
//     into #750 history and respawns a fresh host instead of hanging.

import type { ServerMessage, ClientMessage, TerminalExitInfo } from "../../terminal/terminal.js";

// Bump ON ANY incompatible change to the frames below. The launcher compares the
// host's reported version against this on connect; a mismatch routes to the
// drain-and-respawn fallback (internal docs).
export const PTY_HOST_WIRE_VERSION = 1 as const;

// Capability tokens the host advertises in its hello. Lets a newer daemon detect
// a still-compatible-but-older host (subset of capabilities) without a hard
// version bump. Reserved for forward-compat; today the host advertises all.
export type PtyHostCapability = "create" | "attach" | "input" | "resize" | "kill" | "list";

export const PTY_HOST_CAPABILITIES: readonly PtyHostCapability[] = [
  "create",
  "attach",
  "input",
  "resize",
  "kill",
  "list",
];

// A live terminal the host owns, surfaced by listTerminals() — the reattach
// surface (internal docs). Mirrors TerminalListItem but is the wire shape.
export interface PtyHostTerminalInfo {
  id: string;
  name: string;
  cwd: string;
  title?: string;
  rows: number;
  cols: number;
}

export interface PtyHostCreateOptions {
  id?: string;
  cwd: string;
  name?: string;
  title?: string;
  env?: Record<string, string>;
  command?: string;
  args?: string[];
}

// ── Client → host requests (each carries a correlation id) ──────────────────

export type PtyHostRequest =
  | { type: "hello"; requestId: string }
  | { type: "listTerminals"; requestId: string }
  | { type: "createTerminal"; requestId: string; options: PtyHostCreateOptions }
  | { type: "attach"; requestId: string; terminalId: string }
  | { type: "detach"; requestId: string; terminalId: string }
  | { type: "input"; requestId: string; terminalId: string; message: ClientMessage }
  | { type: "setTitle"; requestId: string; terminalId: string; title: string }
  | { type: "kill"; requestId: string; terminalId: string }
  | {
      type: "killAndWait";
      requestId: string;
      terminalId: string;
      options?: { gracefulTimeoutMs?: number; forceTimeoutMs?: number };
    }
  // Explicit shutdown: kill every pty and exit. Used by the drain-and-respawn
  // fallback (internal docs) once the daemon has read the host's history.
  | { type: "shutdown"; requestId: string };

// ── Host → client responses + async events ──────────────────────────────────

export interface PtyHostHelloResult {
  wireVersion: number;
  capabilities: PtyHostCapability[];
  // The host's own pid — diagnostics only, NEVER used as a re-attach handle
  // (internal docs: a pid is not a re-attachable handle, the socket path is).
  pid: number;
}

export type PtyHostResponse =
  | { type: "response"; requestId: string; ok: true; result?: unknown }
  | { type: "response"; requestId: string; ok: false; error: string };

// Per-terminal frames the host pushes to ALL currently-attached clients. The
// daemon's PtyHostClient re-shapes these into the TerminalSession proxy's
// subscribe/onExit listeners.
export type PtyHostEvent =
  | { type: "terminalMessage"; terminalId: string; message: ServerMessage }
  | { type: "terminalExit"; terminalId: string; info: TerminalExitInfo }
  | { type: "terminalTitleChange"; terminalId: string; title?: string }
  | { type: "terminalCommandFinished"; terminalId: string; info: { exitCode: number | null } };

export type PtyHostToClientMessage = PtyHostResponse | PtyHostEvent;

export function isPtyHostResponse(message: PtyHostToClientMessage): message is PtyHostResponse {
  return message.type === "response";
}

// ── newline-delimited JSON framing ──────────────────────────────────────────
//
// Each frame is one JSON object on its own line. Both ends accumulate bytes and
// split on "\n" so a partial TCP read never mis-parses a frame. We keep this
// transport-only (a unix socket carries the trust) — no length-prefix or binary
// encoding is needed for the volume a single terminal produces.

const FRAME_DELIMITER = "\n";

export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}${FRAME_DELIMITER}`;
}

// Stateful line splitter — feed it raw socket chunks, get back complete frames.
// Holds the trailing partial line between feeds.
export class FrameDecoder {
  private buffer = "";

  feed(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let index = this.buffer.indexOf(FRAME_DELIMITER);
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        out.push(JSON.parse(line));
      }
      index = this.buffer.indexOf(FRAME_DELIMITER);
    }
    return out;
  }
}

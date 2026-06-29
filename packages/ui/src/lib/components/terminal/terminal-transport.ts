// Transport abstraction for TerminalView — the component depends ONLY on this
// interface, never on a concrete socket or the desktop bridge. That keeps the
// mobile UI buildable while the cloud terminal protocol (#654, the
// start_terminal / terminal_input / terminal_output / terminal_resize /
// kill_terminal messages) is still landing on the daemon+relay side: this file
// owns the call-site, and a relay adapter drops in once #654 ships.
//
// The shape mirrors the desktop bridge (desktop-terminal.ts) AND the #654
// message contract one-to-one, so the same component drives both a local
// desktop pty and a cloud daemon pty.

import type { TerminalState } from "./terminal-snapshot.js";

// Why a session ended, as reported by the daemon's negative attach/subscribe ack
// (#750 read-only history). `daemon_restart` = the pty died with the daemon
// (sidecar still has endedAt:null); `shell_exit` = the user's shell exited on its
// own. Used to pick the "session ended" banner copy in TerminalView (internal docs
// PART B). A plain string fallback covers any future reason the daemon adds.
export type TerminalEndedReason = "daemon_restart" | "shell_exit" | (string & {});

// The result of a (re)subscribe / attach. internal docs FIX-2 + internal docs PART B:
//   - `dead` distinguishes an AUTHORITATIVE dead ack (the daemon says the session
//     is gone) from a TRANSIENT failure (a timeout / link-down during a flap).
//     Only `dead:true` may surface the "session ended" dead-end; a transient
//     (`dead:false`) keeps the view mounted and retries (FIX-3).
//   - `live`/`endedReason` thread the #750 read-only-history signal through (they
//     were previously dropped on the floor): `live:false` + a reason means the
//     daemon replayed dead scrollback and the view must render it read-only with a
//     [Restart] affordance instead of treating it as an interactive session.
export interface TerminalSubscribeResult {
  ok: boolean;
  // Only meaningful when ok:false. true = authoritative dead ack; false/undefined
  // = transient (timeout / link-down) — retry, don't dead-end.
  dead?: boolean;
  // Only meaningful when ok:true. false = the daemon attached a DEAD session and
  // is replaying read-only scrollback (#750). Undefined/true = a live pty.
  live?: boolean;
  endedReason?: TerminalEndedReason;
  error?: string;
}

export interface TerminalStartOptions {
  cols: number;
  rows: number;
  // Initial command to run in the pty (e.g. the user's login shell or a fixed
  // command). Omitted → the daemon/bridge picks the default shell.
  command?: string;
  // Working directory for the session, when the backend supports it (#654's
  // start_terminal carries an optional cwd).
  cwd?: string;
  // Stable per-mount viewer id (internal docs GAP-1). The view mints one id per
  // mount and reuses it for subscribe/unsubscribe so the daemon can drop exactly
  // this view on unmount — the daemon's per-RPC emit closure isn't reference-
  // stable, so unsubscribe can't match by emit. Cloud relay only; ignored by
  // backends without server-side session retention (the desktop bridge).
  attachId?: string;
}

export interface TerminalTransport {
  start(opts: TerminalStartOptions): Promise<{ id: string }>;
  // Watch an EXISTING session via the snapshot-on-(re)subscribe model (internal docs).
  // Sends cyborg:subscribe_terminal; resolves as soon as the daemon's FRESH
  // cyborg:terminal_snapshot frame arrives (NO ack on the critical path), so a
  // returning tab self-heals from the snapshot alone — the #789 class (dropped ack
  // → timeout → fresh start()) is structurally impossible, and the start-fallback
  // is gone. Each subscribe registers a viewer that owns its own daemon-side Paseo
  // subscription, so two viewers never double-render (#784) and a remount that
  // resubscribes before the prior unsubscribe lands collapses in place (#778). A
  // dead/gone session resolves { ok:false } via the shared attach_terminal_response
  // shape so the caller cleans the stale sidebar pointer (#718). `attachId` is the
  // stable per-mount viewer id so the matching unsubscribe drops exactly this view.
  // OPTIONAL: the desktop bridge has no daemon-side snapshot and omits it (uses
  // start()).
  subscribe?(id: string, attachId?: string): Promise<TerminalSubscribeResult>;
  // Stop watching a session WITHOUT killing it (internal docs) — the unsubscribe
  // counterpart of subscribe(). The pty survives for re-subscribe. `attachId`
  // identifies which view to drop. OPTIONAL: the desktop bridge omits it.
  unsubscribe?(id: string, attachId?: string): Promise<void> | void;
  input(id: string, data: string): Promise<void> | void;
  resize(id: string, cols: number, rows: number): Promise<void> | void;
  kill(id: string): Promise<void> | void;
  // Subscribe to pty output / exit. Both return an unsubscribe function.
  // `replayCols`/`replayRows` are present ONLY on a re-attach history-replay frame:
  // the width the replayed bytes were captured at, so a view now on a different width
  // can reproduce them at that width and resize to reflow (the #48 mobile→desktop
  // garble fix). Absent on live output — callers treat absence as "no reflow".
  onData(
    handler: (payload: {
      id: string;
      data: string;
      replayCols?: number;
      replayRows?: number;
    }) => void,
  ): () => void;
  onExit(handler: (payload: { id: string; exitCode: number }) => void): () => void;
  // Subscribe to the SCREEN SNAPSHOT the daemon forwards on every (re)subscribe
  // (internal docs Phase 0/1) — Paseo's self-heal payload. `state` is the serialized
  // TerminalState (terminal-snapshot.ts) the view repaints from (clear + write the
  // rendered ANSI). `historyReplayed` is true on the first snapshot of a re-attach
  // where the daemon already replayed the full scrollback ring as output bytes
  // (internal docs #5) — the view then SKIPS its reset+repaint so the byte-replayed
  // scrollback isn't clobbered. OPTIONAL: backends without a snapshot stream (the
  // desktop bridge) omit it, so callers feature-detect with `transport.onSnapshot?`.
  // Returns an unsubscribe fn.
  onSnapshot?(
    handler: (payload: { id: string; state: TerminalState; historyReplayed?: boolean }) => void,
  ): () => void;
  // Fire each time the underlying transport RE-connects after a drop (cloud
  // relay only). The daemon stops streaming a daemon-scoped pty to the dropped
  // socket and never re-binds it to the new one, so the view goes silently
  // frozen (#48 BUG-2) until it re-issues attach(). OPTIONAL: the desktop bridge
  // has no socket to reconnect and omits it. Returns an unsubscribe fn.
  onReconnect?(handler: () => void): () => void;
  // Fire when the DAEMON↔relay link flaps offline→online while THIS view's guest
  // socket stays OPEN (internal docs FIX-1, GAP-1). On a daemon-side flap the UI
  // guest socket never drops, so `onReconnect` (which keys off the guest socket)
  // NEVER fires — yet the daemon stopped streaming during the gap and never
  // re-pushes a snapshot, so the terminal freezes. The relay already broadcasts
  // cyborg:daemon_status_broadcast online/offline; this surfaces the offline→online
  // transition for the view's daemon so it can re-subscribe (reattachLive). Gated
  // on the daemonId the transport was built with. OPTIONAL: the desktop bridge has
  // no daemon-status stream and omits it. Returns an unsubscribe fn.
  onDaemonReconnect?(daemonId: string, handler: () => void): () => void;
}

// ── Desktop bridge adapter ──────────────────────────────────────────────────
// Wraps the Electron embedded-terminal bridge into the TerminalTransport shape.
// This makes TerminalView work end-to-end on desktop TODAY, before the cloud
// (#654) path exists — the bridge already speaks start/input/resize/kill/
// onData/onExit, so the adapter is a thin pass-through.

export interface DesktopBridgeLike {
  start(opts: { cols: number; rows: number; command?: string }): Promise<{ id: string }>;
  input(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  kill(id: string): Promise<void>;
  onData(handler: (payload: { id: string; data: string }) => void): () => void;
  onExit(handler: (payload: { id: string; exitCode: number }) => void): () => void;
}

export function desktopBridgeTransport(bridge: DesktopBridgeLike): TerminalTransport {
  return {
    start: (opts) => bridge.start({ cols: opts.cols, rows: opts.rows, command: opts.command }),
    input: (id, data) => bridge.input(id, data),
    resize: (id, cols, rows) => bridge.resize(id, cols, rows),
    kill: (id) => bridge.kill(id),
    onData: (handler) => bridge.onData(handler),
    onExit: (handler) => bridge.onExit(handler),
  };
}

// ── Cloud relay adapter (#654/#657 message contract) ────────────────────────
// Speaks the cloud terminal protocol over a minimal socket. The socket type is
// intentionally generic (send a message, subscribe to a message type) so this
// file needs NO import from the server package — wire it to the typed ws-client
// at the app boundary. The `on` handler receives the inbound message's PAYLOAD
// object (the relay wraps stream messages as `{type, payload}`).
//
// Contract (merged #657 — cyborg-messages.ts):
//   client→daemon: cyborg:start_terminal {requestId?, workspaceId, daemonId?, cwd?, cols, rows}
//                  cyborg:terminal_input  {workspaceId, daemonId?, terminalId, data}
//                  cyborg:terminal_resize {workspaceId, daemonId?, terminalId, cols, rows}
//                  cyborg:kill_terminal   {workspaceId, daemonId?, terminalId}
//   daemon→client: cyborg:start_terminal_response payload{requestId?, ok, terminalId?, error?}
//                  cyborg:terminal_output payload{terminalId, data, toUserId?}
//                  cyborg:terminal_exit   payload{terminalId, code|null, toUserId?}
// (No `command` field — the daemon runs the user's login shell.)

export interface TerminalSocket {
  send(message: Record<string, unknown>): void;
  // Subscribe to an inbound message type; handler gets the message PAYLOAD.
  // Returns an unsubscribe fn.
  on(type: string, handler: (payload: Record<string, unknown>) => void): () => void;
  // Fire once each time the socket re-establishes AFTER a drop (NOT the first
  // connect), once it's re-authenticated — so a re-attach issued from the handler
  // isn't dropped by the relay as an unauthenticated send. Returns an
  // unsubscribe fn. OPTIONAL: sockets without reconnect semantics omit it.
  onReconnect?(handler: () => void): () => void;
  // Fire on a daemon offline→online transition for `daemonId` (internal docs FIX-1),
  // fed by the relay's cyborg:daemon_status_broadcast the client already consumes.
  // Already re-authenticated when it fires (the guest socket stayed up, but the
  // gate keeps the re-subscribe send safe if both flapped). Returns an unsubscribe
  // fn. OPTIONAL: sockets without daemon-status semantics omit it.
  onDaemonReconnect?(daemonId: string, handler: () => void): () => void;
}

export interface RelayTransportOptions {
  socket: TerminalSocket;
  workspaceId: string;
  daemonId?: string;
  // Generates a unique id for the start request↔response correlation. Injected
  // so the module stays free of crypto/Date globals (testable, deterministic).
  newRequestId: () => string;
  // How long to wait for start_terminal_response before failing (ms). A dropped
  // daemon/relay must not leave the promise pending and the listener leaked.
  startTimeoutMs?: number;
}

export function relayTerminalTransport(opts: RelayTransportOptions): TerminalTransport {
  const { socket, workspaceId, daemonId, newRequestId, startTimeoutMs = 15_000 } = opts;
  // Shared by kill() and the start-timeout reaper (BUG-5) below.
  const killTerminal = (id: string) =>
    socket.send({ type: "cyborg:kill_terminal", workspaceId, daemonId, terminalId: id });
  return {
    start({ cols, rows, cwd, attachId }) {
      const requestId = newRequestId();
      return new Promise<{ id: string }>((resolve, reject) => {
        let settled = false;
        let off: (() => void) | undefined;
        let reaperTimer: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => {
          settled = true;
          reject(new Error("start_terminal: timed out waiting for the daemon"));
          // Don't fully unsubscribe yet: a LATE ack may still name a pty the
          // daemon actually spawned. Keep the listener alive (bounded) to reap
          // that orphan so it doesn't leak on the daemon (#48 BUG-5).
          reaperTimer = setTimeout(() => off?.(), startTimeoutMs);
        }, startTimeoutMs);
        off = socket.on("cyborg:start_terminal_response", (payload) => {
          if (payload.requestId !== requestId) return;
          if (settled) {
            // Late ack after timeout — we already rejected the start(), so the
            // client can't surface this pty. Reap it instead of leaking it.
            clearTimeout(reaperTimer);
            off?.();
            if (payload.ok === true && typeof payload.terminalId === "string") {
              killTerminal(payload.terminalId);
            }
            return;
          }
          clearTimeout(timer);
          off?.();
          if (payload.ok === true && typeof payload.terminalId === "string") {
            resolve({ id: payload.terminalId });
          } else {
            const error = typeof payload.error === "string" ? payload.error : "start failed";
            reject(new Error(`start_terminal: ${error}`));
          }
        });
        socket.send({
          type: "cyborg:start_terminal",
          requestId,
          workspaceId,
          daemonId,
          cwd,
          cols,
          rows,
          attachId,
        });
      });
    },
    subscribe(id, attachId) {
      const requestId = newRequestId();
      // internal docs Phase 2 — there is NO ack on the success path: the daemon
      // delegates to Paseo's listener Set, which re-delivers a FRESH screen
      // snapshot on every subscribe. We resolve { ok:true } the instant that
      // cyborg:terminal_snapshot for THIS terminal arrives (TerminalView repaints
      // from it via its own onSnapshot listener). The only response we listen for
      // is a dead/unavailable-session attach_terminal_response (ok:false) so a
      // gone session still resolves { ok:false } and the caller cleans the stale
      // pointer (#718). A timeout also resolves { ok:false } — but, crucially, the
      // caller no longer falls back to a fresh start() (the #789 blast radius is
      // deleted): a returning tab simply shows nothing new until the next frame.
      return new Promise<TerminalSubscribeResult>((resolve) => {
        let settled = false;
        let offSnap: (() => void) | undefined;
        let offResp: (() => void) | undefined;
        const finish = (result: TerminalSubscribeResult) => {
          // The `settled` latch guarantees resolve() runs at most once across the
          // snapshot / negative-ack / timeout race — the linter can't see the guard.
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          offSnap?.();
          offResp?.();
          // oxlint-disable-next-line no-multiple-resolved -- guarded by `settled`
          resolve(result);
        };
        const timer = setTimeout(
          // internal docs FIX-2: a TIMEOUT is transient (link-down during a flap),
          // NOT an authoritative dead session. dead:false → the caller shows
          // "reconnecting" and retries instead of the "no longer available" dead-end.
          () =>
            finish({
              ok: false,
              dead: false,
              error: "subscribe_terminal: timed out waiting for the daemon",
            }),
          startTimeoutMs,
        );
        offSnap = socket.on("cyborg:terminal_snapshot", (payload) => {
          if (payload.terminalId === id) finish({ ok: true, live: true });
        });
        offResp = socket.on("cyborg:attach_terminal_response", (payload) => {
          if (payload.requestId !== requestId) return;
          // A POSITIVE ack carrying live:false is the #750 read-only-history attach
          // (attachDead): the daemon replayed dead scrollback. Thread live +
          // endedReason through so the caller renders the read-only/[Restart] UX —
          // these were previously dropped on the floor (internal docs PART B Gap 2).
          if (payload.ok === true) {
            if (payload.live === false) {
              finish({
                ok: true,
                live: false,
                endedReason:
                  typeof payload.endedReason === "string"
                    ? (payload.endedReason as TerminalEndedReason)
                    : undefined,
              });
            }
            // ok:true + live:true is ack-free in Phase 2 — the snapshot above heals
            // and resolves; ignore here.
            return;
          }
          // A NEGATIVE ack is authoritative: the session is genuinely gone (dead),
          // so the caller cleans the stale sidebar pointer (#718) and dead-ends.
          finish({
            ok: false,
            dead: true,
            endedReason:
              typeof payload.endedReason === "string"
                ? (payload.endedReason as TerminalEndedReason)
                : undefined,
            error: typeof payload.error === "string" ? payload.error : "subscribe failed",
          });
        });
        socket.send({
          type: "cyborg:subscribe_terminal",
          requestId,
          workspaceId,
          daemonId,
          terminalId: id,
          attachId,
        });
      });
    },
    unsubscribe(id, attachId) {
      socket.send({
        type: "cyborg:unsubscribe_terminal",
        workspaceId,
        daemonId,
        terminalId: id,
        attachId,
      });
    },
    input(id, data) {
      socket.send({ type: "cyborg:terminal_input", workspaceId, daemonId, terminalId: id, data });
    },
    resize(id, cols, rows) {
      socket.send({
        type: "cyborg:terminal_resize",
        workspaceId,
        daemonId,
        terminalId: id,
        cols,
        rows,
      });
    },
    kill(id) {
      killTerminal(id);
    },
    onData(handler) {
      return socket.on("cyborg:terminal_output", (payload) => {
        if (typeof payload.terminalId === "string" && typeof payload.data === "string") {
          // Forward the history-replay capture dims when present (the daemon sets
          // them only on the re-attach history frame) so the view can reflow.
          handler({
            id: payload.terminalId,
            data: payload.data,
            replayCols: typeof payload.replayCols === "number" ? payload.replayCols : undefined,
            replayRows: typeof payload.replayRows === "number" ? payload.replayRows : undefined,
          });
        }
      });
    },
    onExit(handler) {
      return socket.on("cyborg:terminal_exit", (payload) => {
        if (typeof payload.terminalId === "string") {
          // code is nullable in the contract (signal kills) → 0 fallback.
          const code = typeof payload.code === "number" ? payload.code : 0;
          handler({ id: payload.terminalId, exitCode: code });
        }
      });
    },
    onSnapshot(handler) {
      // The screen self-heal frame the daemon forwards on every (re)subscribe
      // (internal docs). `state` is Paseo's serialized TerminalState — pass it
      // through verbatim; TerminalView renders it to ANSI and repaints xterm.
      return socket.on("cyborg:terminal_snapshot", (payload) => {
        if (typeof payload.terminalId === "string" && payload.state) {
          handler({
            id: payload.terminalId,
            state: payload.state as TerminalState,
            historyReplayed: payload.historyReplayed === true,
          });
        }
      });
    },
    // Forward the socket's reconnect signal so the view can re-attach (BUG-2).
    // Present only when the socket supports it; absent otherwise so callers can
    // feature-detect with `transport.onReconnect?`.
    onReconnect: socket.onReconnect ? (handler) => socket.onReconnect!(handler) : undefined,
    // Forward a daemon offline→online transition (internal docs FIX-1) so the view
    // re-subscribes after a daemon↔relay flap that left the guest socket open. The
    // socket implementation gates on the daemonId; we pass the view's daemonId
    // through. Present only when the socket supports it (feature-detect with
    // `transport.onDaemonReconnect?`).
    onDaemonReconnect: socket.onDaemonReconnect
      ? (targetDaemonId, handler) => socket.onDaemonReconnect!(targetDaemonId, handler)
      : undefined,
  };
}

// ── Session resolution (subscribe — NO start-fallback) ──────────────────────
// Decides how TerminalView obtains a live pty for a (re)mount. internal docs: when
// an existing session id is known, (re)SUBSCRIBE to it — the daemon re-delivers a
// FRESH screen snapshot that repaints the view (snapshot-on-(re)subscribe). A
// returning tab heals from that snapshot alone.
//
// DELETED (the #789 blast radius): the attach→15s-timeout→fresh-start() fallback.
// Previously a dropped ack / timeout on the existing-session path fell back to
// spawning a NEW pty, ORPHANING the live session and resetting the shell on every
// tab switch. With snapshot-on-subscribe there is no ack to drop and the snapshot
// self-heals, so a failed (re)subscribe must NOT spawn a fresh pty — it returns a
// dead/failed outcome (the daemon session is gone or will heal on the next frame),
// never a duplicate. A genuinely NEW terminal (no terminalId) and the desktop
// bridge (no subscribe) still take the start() path.
//
// Pure + dependency-injected (no DOM, no xterm): the caller passes the resolution
// thunks plus an isCurrent() generation-token check so a resolution that races an
// unmount aborts cleanly and never leaks a pty.

export interface TerminalSessionOutcome {
  // internal docs FIX-2 + internal docs PART B added "ended" and "transient":
  //   - "ended": a (re)subscribe to a GENUINELY-gone session (authoritative dead
  //     ack, or a positive ack with live:false = #750 read-only history). The
  //     caller renders the read-only scrollback + [Restart] affordance, NOT the
  //     raw "no longer available" dead-end. `endedReason` picks the banner copy.
  //   - "transient": a (re)subscribe that TIMED OUT (link-down during a flap). The
  //     caller keeps the view mounted, shows "reconnecting", and retries (FIX-3).
  //   - "failed": a genuine START failure (Retry).
  kind: "subscribed" | "started" | "aborted" | "failed" | "ended" | "transient";
  // The live pty id, for the "subscribed"/"started" outcomes. null otherwise.
  id: string | null;
  // Populated for "failed": the surfaced error (a failed start()).
  error?: string;
  // Populated for "ended": why the session ended, for the banner copy. Also set
  // (live:false) when a subscribe succeeded but onto a dead session.
  endedReason?: TerminalEndedReason;
}

export interface ResolveTerminalSessionDeps {
  // The id of the existing session to re-subscribe to, when present.
  terminalId?: string;
  // (Re)subscribe to an existing session via the snapshot self-heal model
  // (internal docs). Resolves { ok:false } for a dead/gone session. Omitted by the
  // desktop bridge (which has no daemon-side snapshot — it uses start()).
  subscribe?: (id: string) => Promise<TerminalSubscribeResult>;
  // Spawn a fresh pty (NEW terminal, or the desktop bridge). Resolves the new id.
  start: () => Promise<{ id: string }>;
  // Kill a pty we opened after the component already tore down (race cleanup).
  kill: (id: string) => Promise<void> | void;
  // Generation-token guard: false once the component unmounted / re-ran, so a
  // resolution that lost the race aborts (and kills any orphan it just opened).
  isCurrent: () => boolean;
  // Called the moment a (re)subscribe is about to be attempted, BEFORE awaiting
  // it, so the caller can wire the snapshot/output subscription and adopt the id as
  // the live session. Returning a disposer lets the caller unwind it if the
  // (re)subscribe fails.
  onAttachAttempt?: (id: string) => (() => void) | void;
  // Called the moment a fresh start() is about to be attempted, BEFORE awaiting
  // it (BUG-3). The daemon can emit the shell prompt/banner the instant it acks
  // start, racing the client's subscription — so the caller subscribes here,
  // buffering output until start() resolves with the real id. The returned hook
  // exposes adopt(id) to bind+flush the buffer once the id is known, and
  // dispose() to unwind the early subscription on abort/failure.
  onStartAttempt?: () => StartSubscription | void;
}

// Returned by onStartAttempt: lets resolveTerminalSession hand back the real pty
// id (adopt) once start() resolves, or unwind the pre-subscription on abort.
export interface StartSubscription {
  // Adopt the now-known pty id: bind the buffered subscription to it and flush
  // any frames the daemon emitted before start() resolved.
  adopt: (id: string) => void;
  // Unwind the early subscription (start failed / aborted before adopt).
  dispose: () => void;
}

export async function resolveTerminalSession(
  deps: ResolveTerminalSessionDeps,
): Promise<TerminalSessionOutcome> {
  const { terminalId, subscribe, start, kill, isCurrent, onAttachAttempt, onStartAttempt } = deps;

  // Existing session: (re)SUBSCRIBE. On success the fresh snapshot repaints the
  // view. On failure we do NOT fall back to a fresh start() — that orphaned the
  // live pty on every dropped ack (#789). A dead session surfaces as a
  // failed/ended outcome instead.
  const watch = subscribe;
  if (terminalId && watch) {
    const disposeWatch = onAttachAttempt?.(terminalId) ?? undefined;
    // Default to a TRANSIENT result so an unexpected throw is treated as a
    // recoverable link-down (retry), never an authoritative dead-end.
    let res: TerminalSubscribeResult = { ok: false, dead: false };
    try {
      res = await watch(terminalId);
      // Raced an unmount while subscribing — bail (the component is gone; the
      // daemon session survives for the next mount).
      if (!isCurrent()) {
        disposeWatch?.();
        return { kind: "aborted", id: null };
      }
    } catch {
      // watch() threw (it normally maps failure to a result object; an unexpected
      // throw must not crash the mount). no-silent-catch: the handling is the
      // explicit transient/ended outcome below, not a swallow. A throw is treated
      // as transient (link-down), so the caller retries rather than dead-ending.
      if (!isCurrent()) {
        disposeWatch?.();
        return { kind: "aborted", id: null };
      }
      res = { ok: false, dead: false };
    }

    // Live re-subscribe succeeded onto a LIVE pty: the fresh snapshot repaints.
    if (res.ok && res.live !== false) {
      return { kind: "subscribed", id: terminalId };
    }

    // internal docs PART B: the daemon attached but onto a DEAD session (live:false)
    // and is replaying read-only scrollback (#750). The wire-up stays so onData
    // paints the history; surface "ended" so the caller renders it read-only with
    // a [Restart] affordance. Do NOT dispose the watch here — the output frames
    // carrying the scrollback flow through it.
    if (res.ok && res.live === false) {
      return { kind: "ended", id: terminalId, endedReason: res.endedReason };
    }

    // internal docs FIX-2: distinguish an authoritative DEAD ack from a TRANSIENT
    // timeout. Only `dead:true` dead-ends ("session ended"); a transient keeps the
    // view mounted so the caller retries (FIX-3). NEVER spawn a fresh pty here (the
    // deleted #789 fallback).
    if (res.dead) {
      // Genuinely-gone session: unwind the early wire-up.
      disposeWatch?.();
      return { kind: "ended", id: null, endedReason: res.endedReason };
    }
    // TRANSIENT (cold-reopen blank, root-caused 2026-06-22 via relay + UI probes):
    // on a fast reopen the daemon is mid-pty-host-reattach, so the subscribe ACK
    // TIMES OUT (transient) — but the daemon still replays the scrollback ring +
    // snapshot a beat LATER. Do NOT dispose the wire-up here: those late frames (and
    // reattachLive's re-subscribe on the SAME id) MUST find the onData/onSnapshot
    // listeners still wired, or the ring paints into a listener-less void and the
    // terminal stays BLANK forever (terminal_output dropped at ws-client with
    // listeners=0). The wire-up is the legitimate session subscription — reattachLive
    // reuses it; teardown() disposes it on unmount, so it never leaks.
    return { kind: "transient", id: terminalId, error: res.error };
  }

  // start() path: spawn a fresh pty (a NEW terminal — no terminalId — or the
  // desktop bridge, which has no subscribe/attach). Extracted so this function
  // stays under the complexity budget.
  return resolveStart({ start, kill, isCurrent, onStartAttempt });
}

// Spawn a fresh pty and adopt it. BUG-3: subscribe BEFORE awaiting start() so an
// instant prompt/banner frame the daemon emits the moment it acks start isn't
// dropped. The early subscription buffers output until adopt(id) binds it to the
// now-known pty and flushes the buffer; dispose() unwinds it on abort/failure.
async function resolveStart(deps: {
  start: () => Promise<{ id: string }>;
  kill: (id: string) => Promise<void> | void;
  isCurrent: () => boolean;
  onStartAttempt?: () => StartSubscription | void;
}): Promise<TerminalSessionOutcome> {
  const { start, kill, isCurrent, onStartAttempt } = deps;
  const startSub = onStartAttempt?.() ?? undefined;
  try {
    const { id } = await start();
    // Torn down while the backend was starting — kill the orphan and bail.
    if (!isCurrent()) {
      startSub?.dispose();
      await kill(id);
      return { kind: "aborted", id: null };
    }
    startSub?.adopt(id);
    return { kind: "started", id };
  } catch (err) {
    startSub?.dispose();
    if (!isCurrent()) return { kind: "aborted", id: null };
    return {
      kind: "failed",
      id: null,
      error: err instanceof Error ? err.message : "Failed to start the terminal.",
    };
  }
}

// ── Accessory-bar key encoding (mobile) ─────────────────────────────────────
// A phone has no physical keyboard, so the accessory bar sends raw control
// bytes. Pure + exported so it's unit-testable without a DOM.

export type AccessoryKey =
  | "esc"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pipe"
  | "tilde"
  | "slash";

const ACCESSORY_BYTES: Record<AccessoryKey, string> = {
  esc: "\x1b",
  tab: "\t",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pipe: "|",
  tilde: "~",
  slash: "/",
};

export function accessoryKeyBytes(key: AccessoryKey): string {
  return ACCESSORY_BYTES[key];
}

// Ctrl+<char>: map a printable key to its control byte (Ctrl-A = 0x01 … and
// Ctrl-[ = ESC, etc.). Returns null for input that has no control form, so the
// caller can fall back to sending the raw char. This powers the sticky-Ctrl
// accessory key: arm Ctrl, then the next typed letter becomes its control code.
export function ctrlByte(char: string): string | null {
  if (char.length !== 1) return null;
  const upper = char.toUpperCase();
  const code = upper.charCodeAt(0);
  // A–Z → 0x01–0x1A; the @ [ \ ] ^ _ block → 0x00–0x1F.
  if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f);
  if (upper === " ") return "\x00";
  return null;
}

<script lang="ts">
  // Mobile-first xterm.js terminal (epic #653 part 2, #655). A phone has no
  // physical keyboard, so this pairs the terminal with a touch accessory bar
  // (Ctrl / Esc / Tab / arrows / | ~ /) above the on-screen keyboard, handles
  // the soft-keyboard viewport resize, and re-fits on every resize/rotation.
  //
  // Backend-agnostic: it drives a TerminalTransport (terminal-transport.ts) —
  // the desktop bridge today, the cloud relay (#654) once that lands. It never
  // imports a socket or the server package directly.
  import type { Terminal } from "@xterm/xterm";
  import "@xterm/xterm/css/xterm.css";
  import {
    accessoryKeyBytes,
    ctrlByte,
    resolveTerminalSession,
    type AccessoryKey,
    type StartSubscription,
    type TerminalEndedReason,
    type TerminalTransport,
  } from "./terminal-transport.js";
  import { stableAttachId, rememberAttachId, forgetAttachId } from "./terminal-attach-id.js";
  import { canFitContainer, shouldPinViewportHeight } from "./terminal-fit.js";
  import { isDesktopApp } from "$lib/utils.js";
  import { isTauriIOS, isTauriAndroid } from "$lib/mobile/platform.js";
  import { isBlankTerminalState, renderTerminalSnapshotToAnsi } from "./terminal-snapshot.js";
  import {
    createPredictorState,
    classifyInput,
    enqueuePrediction,
    reconcile,
    resetPredictions,
    teardownPredictor,
    type PredictorState,
  } from "./terminal-predict.js";

  let {
    transport,
    // The id of an EXISTING daemon session to (re)attach to (#732). When set and
    // the transport supports attach(), the view re-subscribes to the live pty and
    // replays scrollback instead of spawning a new one — so a tab switch returns
    // to the same shell. Falls back to start() when absent (desktop bridge).
    terminalId,
    // The daemon this session runs on (internal docs FIX-1). Threaded so the view
    // can wire transport.onDaemonReconnect: a daemon↔relay flap (offline→online)
    // re-subscribes the live pty even though THIS view's guest socket never dropped
    // (so transport.onReconnect never fires). OPTIONAL — the desktop bridge has no
    // daemon-status stream.
    daemonId,
    command,
    cwd,
    // Readable default for a small screen; callers can bump it.
    fontSize = 14,
    onExit,
  }: {
    transport: TerminalTransport;
    terminalId?: string;
    daemonId?: string;
    command?: string;
    cwd?: string;
    fontSize?: number;
    onExit?: (exitCode: number) => void;
  } = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  let rootEl: HTMLDivElement | undefined = $state();
  // internal docs PART B — a discriminated status replaces the old
  // `startError`/`connecting` booleans (server CLAUDE.md "discriminated unions over
  // bags of booleans"):
  //   connecting   — start/subscribe in flight (≤15s); shows "Connecting…"
  //   live         — pty alive + interactive (steady state)
  //   reconnecting — a recoverable drop (WS blip or daemon flap), auto-retrying;
  //                  shows "Reconnecting… (attempt N)" (FIX-3 composes here)
  //   ended        — a genuinely-gone session (#750): read-only scrollback + [Restart]
  //   error        — a genuine START failure: shows the message + [Retry]
  type TerminalStatus =
    | { kind: "connecting" }
    | { kind: "live" }
    | { kind: "reconnecting"; attempt: number }
    | { kind: "ended"; reason?: TerminalEndedReason }
    | { kind: "error"; message: string };
  // Starts "connecting" — the $effect re-asserts it on (re)mount. The accessory
  // bar is interactive only in "live"; every other status disables input.
  let status = $state<TerminalStatus>({ kind: "connecting" });
  // The accessory bar / typing are live only when the pty is interactive. Every
  // non-"live" status (connecting / reconnecting / ended) disables input. The
  // terminal surface stays mounted for all of these (only "error" replaces it with
  // the error+Retry pane) so the read-only #750 scrollback stays visible in "ended".
  const inputDisabled = $derived(status.kind !== "live");
  // Sticky Ctrl: arm it, the next typed character becomes its control code.
  let ctrlArmed = $state(false);
  // internal docs B.5 [Restart]: when the user restarts an ENDED session we drop the
  // dead terminalId so resolveTerminalSession takes the start() branch (a brand-new
  // pty, same cwd) instead of re-subscribing to the gone session. Null = use the
  // `terminalId` prop; "" (set by restart) = force a fresh start even when the prop
  // still carries the dead id. The $effect reads this to pick the effective id.
  let terminalIdOverride: string | null = $state(null);
  const effectiveTerminalId = $derived(
    terminalIdOverride !== null ? terminalIdOverride || undefined : terminalId,
  );

  let term: Terminal | null = null;
  let fitAddon: { fit: () => void } | null = null;
  let sessionId: string | null = null;
  // Stable per-mount viewer id (internal docs GAP-1). Minted once per effect run and
  // reused for start/subscribe AND the matching unsubscribe on unmount, so the
  // daemon drops exactly THIS view's viewer (its per-RPC emit closure isn't
  // reference-stable, so it can't match unsubscribe by emit). Fresh on every
  // remount.
  let attachId: string | null = null;
  let disposers: Array<() => void> = [];
  // Predictive local echo / "ghost text" (#731, internal docs). A pure predictor
  // (terminal-predict.ts) renders dim SGR-2 graphemes at the cursor the instant
  // the user types, then reconciles them against the authoritative output stream
  // (confirm on prefix-match, roll back on divergence). It NEVER alters the bytes
  // sent to the pty — overlay only. Gated by alt-screen + RTT + transport identity
  // (see predictionEnabled below): ON only for the cloud relay (real latency),
  // OFF for the desktop bridge (local pty, no latency → pointless flicker). The
  // desktop bridge is detected by the ABSENCE of subscribe()/onSnapshot — the same
  // proxy internal docs C.4 recommends.
  // ghost text disabled — reconcile() swallows real output (#793 regression);
  // re-enable only after reconcile is proven to always emit the full authoritative
  // output. On the cloud relay this gate was ALWAYS true (subscribe + onSnapshot
  // both present), so EVERY pty output chunk was routed through reconcile() in
  // writeOutput() and only its (empty/partial) `write` reached xterm — the terminal
  // froze after the initial snapshot ("I type and nothing appears"). Forcing this to
  // `false` makes writeOutput take the `term.write(data)` pass-through (FULL output)
  // and bypasses the input prediction path in sendData. terminal-predict.ts and the
  // predictor are kept intact for a later fix; the regression test in
  // terminal-predict.test.ts pins "reconcile must never drop authoritative output".
  const predictionEnabled = false;
  // Original gate (re-enable once reconcile() is proven to always emit full output):
  // const predictionEnabled = $derived(Boolean(transport.subscribe && transport.onSnapshot));
  // Created once (disabled); its enabled flag is kept in sync with the gate below.
  const predictor: PredictorState = createPredictorState({ enabled: false });
  $effect(() => {
    predictor.enabled = predictionEnabled;
  });
  // Generation token: bumped on every (re)mount and on teardown so a startup
  // whose dynamic import / transport.start is still in flight when the component
  // unmounts (or re-runs) aborts instead of writing into a torn-down terminal or
  // leaking the backend session it just opened.
  let startToken = 0;
  // internal docs FIX-3 — bounded auto-retry of reattachLive() for TRANSIENT
  // re-subscribe failures. A daemon mid-restart (internal docs PART A) needs a few
  // seconds for its host-reattach to surface the pty, so a single dropped
  // re-subscribe must not wedge the view when there's no later UI reconnect to
  // retry it. We retry with capped backoff (0.5s → 8s, ~5 attempts) before
  // concluding the session is gone; a remount/unmount cancels via startToken.
  const MAX_REATTACH_ATTEMPTS = 5;
  const REATTACH_BASE_MS = 500;
  const REATTACH_MAX_MS = 8_000;
  let reattachTimer: ReturnType<typeof setTimeout> | null = null;
  // #797 — a single re-subscribe must be in flight at a time. The daemon↔relay
  // flap fires onDaemonReconnect on EVERY offline→online edge, and the relay can
  // re-broadcast `online` (or the link flaps repeatedly) within ~1s, so without a
  // guard every edge calls reattachLive() and stacks a fresh subscribe — the daemon
  // showed 3 viewers for one terminal in ~1s. Each re-subscribe makes the daemon
  // push a fresh snapshot whose onSnapshot handler term.reset()s, wiping the live
  // output that arrived since: the visible xterm freezes on the snapshot. This latch
  // collapses a burst of edges into ONE in-flight re-subscribe; an edge that arrives
  // while one is running is dropped (the in-flight re-subscribe already heals from
  // the freshest snapshot — a later edge would only restart the same heal). The
  // bounded FIX-3 retry chain runs UNDER this latch (it owns it for the whole chain),
  // so a retry never stacks either.
  let reattaching = false;

  // COLD-START SUBSCRIBE RACE (confirmed 2026-06-21 via CDP against the live app):
  // on app reopen the daemon re-attaches to the detached pty-host ASYNCHRONOUSLY. A
  // (re)subscribe that lands BEFORE the daemon has surfaced the pty returns
  // live:true but the daemon replays NO ring — the screen paints blank (the grid's
  // empty rows, no error overlay). Nothing re-pushes: the guest socket stayed OPEN
  // so onReconnect/onDaemonReconnect never fire, and the daemon does not proactively
  // replay to an already-attached viewer. Proven fix: a bounded re-subscribe watchdog
  // — if NO output paints within the window, re-subscribe (which re-delivers the ring
  // once the daemon is warm; verified the daemon emits ~86KB on a fresh subscribe
  // while the raced view stayed blank). Disarmed the instant any output arrives, so a
  // genuinely idle terminal stops after the cap instead of re-subscribing forever.
  const BLANK_REATTACH_ATTEMPTS = 8;
  const BLANK_REATTACH_MS = 1_500;
  let receivedOutput = false;
  let blankWatchdog: ReturnType<typeof setTimeout> | null = null;
  let blankAttempts = 0;
  // COLD-DAEMON LOADING HINT: on a cold reopen the daemon takes a beat to replay the
  // ring, so the eagerly-"live" surface is briefly EMPTY (the blank the user saw).
  // Show a "reattaching" overlay once content is still absent after a short grace
  // window — long enough that a warm reattach (content within tens of ms) never
  // flashes it, but a cold one surfaces clear feedback instead of a blank screen.
  const COLD_HINT_MS = 500;
  let coldHint = $state(false);
  let coldHintTimer: ReturnType<typeof setTimeout> | null = null;

  function clearColdHint(): void {
    coldHint = false;
    if (coldHintTimer) {
      clearTimeout(coldHintTimer);
      coldHintTimer = null;
    }
  }

  function armColdHint(): void {
    if (coldHintTimer || receivedOutput) return;
    coldHintTimer = setTimeout(() => {
      coldHintTimer = null;
      if (!receivedOutput) coldHint = true;
    }, COLD_HINT_MS);
  }

  function clearBlankWatchdog(): void {
    if (blankWatchdog) {
      clearTimeout(blankWatchdog);
      blankWatchdog = null;
    }
  }

  // The daemon served real screen content (output bytes OR a non-blank snapshot) →
  // this is NOT a blank cold-start, so retire the watchdog + loading hint.
  function noteContentArrived(): void {
    if (receivedOutput) return;
    receivedOutput = true;
    clearBlankWatchdog();
    clearColdHint();
  }

  // Arm (or re-arm) the cold-start blank watchdog. Idempotent + a no-op once any
  // output has painted or the retry cap is reached.
  function armBlankWatchdog(): void {
    if (receivedOutput || blankWatchdog || blankAttempts >= BLANK_REATTACH_ATTEMPTS) return;
    blankWatchdog = setTimeout(() => {
      blankWatchdog = null;
      // Output landed, we left the live state, or the cap is hit → give up healing.
      if (receivedOutput || status.kind !== "live" || blankAttempts >= BLANK_REATTACH_ATTEMPTS) {
        return;
      }
      blankAttempts += 1;
      // Re-subscribe to re-pull the ring now that the daemon may be warm, then re-arm
      // for the next window in case it is still cold (bounded by blankAttempts).
      reattachLive();
      armBlankWatchdog();
    }, BLANK_REATTACH_MS);
  }

  // MOBILE keyboard smoothness (epic #653): the soft keyboard show/hide and the
  // visualViewport scroll/resize events fire in rapid bursts during the keyboard
  // open/close animation. Re-fitting xterm or recomputing the height pin on every
  // edge thrashes layout and makes typing feel laggy, so the mobile viewport path
  // coalesces work into ONE recompute per animation frame (rAF). The fit() inside
  // that recompute is additionally debounced (fitSoon) so a long burst collapses
  // to a single fit + pty resize instead of one per frame.
  let vvFrame: number | null = null;
  let fitTimer: ReturnType<typeof setTimeout> | null = null;

  // True for the brief window while a re-attach history replay is being reproduced at
  // its capture width before being resized back to fit (#48 mobile→desktop reflow, see
  // writeOutput). A container re-fit landing mid-reflow would resize xterm out from
  // under the replay and defeat the reflow, so fitAndResize defers while this is set;
  // the reflow's own resize-back restores the correct geometry and a trailing fit
  // re-runs from the ResizeObserver.
  let reflowingHistory = false;

  // Debounced re-fit: collapse a burst of layout ticks (keyboard animation,
  // rotation) into ONE guarded fit + pty resize. Shares the same guard as
  // fitAndResize so it never pushes degenerate dimensions to a hidden pane.
  function fitSoon(): void {
    if (fitTimer) clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = null;
      fitAndResize();
    }, 60);
  }

  function fitAndResize(): void {
    if (!fitAddon || !term) return;
    // Don't fight an in-progress history reflow (#48): it temporarily sizes xterm to
    // the replay's capture width and resizes back itself. Re-fitting now would write
    // the old-width bytes into the wrong grid. The ResizeObserver re-fires after.
    if (reflowingHistory) return;
    // KEEP-ALIVE sizing guard (internal docs): in a TerminalPaneHost an inactive
    // pane is `display:none`, so its container is 0×0 with a null offsetParent.
    // xterm's FitAddon does NOT throw on a zero-size element — it computes a
    // degenerate 1×1-ish geometry that, if forwarded, pushes a garbage `resize`
    // to the pty and cuts off output when the pane returns. So SKIP fit() while
    // hidden; the ResizeObserver re-fires the instant the pane becomes visible
    // (0×0 → real size is a size change) and this guard then passes, re-fitting
    // correctly. See terminal-fit.ts.
    if (!canFitContainer(containerEl)) return;
    try {
      fitAddon.fit();
    } catch {
      // Defensive: fit() can still throw if the addon's measurement element is
      // mid-teardown. Ignore — the next resize/observer tick re-fits once stable.
      return;
    }
    if (sessionId) void transport.resize(sessionId, term.cols, term.rows);
  }

  // True on a touch device with a soft keyboard where THIS component must self-pin
  // to visualViewport.height — i.e. plain mobile web. False in the Electron desktop
  // shell (windowed sub-pane) AND in the native Tauri shell (its root +layout owns
  // the keyboard viewport via --app-vh; the terminal just re-fits its flex slot via
  // the ResizeObserver). This gates BOTH the root height-pin (applyViewportHeight)
  // and TerminalView's own visualViewport listeners — see shouldPinViewportHeight().
  function softKeyboardSizing(): boolean {
    const coarse =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
    return shouldPinViewportHeight({
      isDesktopApp: isDesktopApp(),
      coarsePointer: coarse,
      nativeShellManagesViewport: isTauriIOS() || isTauriAndroid(),
    });
  }

  // Keep the prompt / last line visible: pin xterm to the bottom of its
  // scrollback. Called whenever the input is focused and on every keyboard
  // geometry change so the cursor never ends up hidden behind the keyboard.
  function scrollTerminalToBottom(): void {
    // scrollToBottom is a no-op when already at the bottom, so this is cheap to
    // call on every viewport tick.
    term?.scrollToBottom();
  }

  // The on-screen keyboard shrinks the visual viewport without firing a window
  // resize. On MOBILE we pin the terminal to visualViewport.height so it sits
  // ABOVE the keyboard instead of being covered, then re-fit. On DESKTOP the
  // terminal is a windowed sub-pane: pinning it to the whole-window height
  // overflows the bottom edge and clips the last TUI rows, so we clear any pin
  // and let the flex `h-full` layout size the pane (internal docs sibling).
  //
  // The JUMP/BOUNCE fix: when the keyboard opens, the browser scrolls the page
  // (visualViewport.offsetTop) to keep the focused element visible, leaving the
  // terminal translated under the keyboard. We pin the root to the EXACT visual
  // viewport rect — height = vv.height AND a transform of vv.offsetTop — so the
  // terminal+accessory bar track the visible area precisely and never rubber-band
  // or get covered. We also nudge the document scroll back to 0 so the layout-
  // viewport scroll (the source of the "page jumps up" feel) is neutralised.
  function applyViewportHeight(): void {
    if (!rootEl) return;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (vv && softKeyboardSizing()) {
      // offsetTop is how far the visual viewport is pushed down from the layout
      // viewport (nonzero while the page scrolled under the keyboard). Translating
      // the root by it keeps the pinned area glued to what the user can see.
      rootEl.style.height = `${vv.height}px`;
      rootEl.style.transform = vv.offsetTop ? `translateY(${vv.offsetTop}px)` : "";
      // Cancel the implicit page scroll the keyboard triggered — without this the
      // page rubber-bands as the keyboard animates. Cheap + idempotent.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    } else {
      rootEl.style.height = "";
      rootEl.style.transform = "";
    }
    fitSoon();
    // The geometry just changed — keep the last line above the keyboard.
    scrollTerminalToBottom();
  }

  // MOBILE-only rAF-throttled entry point for the high-frequency visualViewport
  // resize/scroll bursts during the keyboard animation. Coalesces every edge in a
  // frame into ONE applyViewportHeight so typing stays responsive (no per-event
  // layout recompute). Desktop never reaches here — its listeners aren't wired.
  function scheduleViewportSync(): void {
    if (vvFrame !== null) return;
    vvFrame = requestAnimationFrame(() => {
      vvFrame = null;
      applyViewportHeight();
    });
  }

  function sendData(data: string): void {
    if (!sessionId) return;
    // Sticky-Ctrl: convert the next single printable char to its control byte.
    // A control byte is never predicted (it's not a printable-at-cursor), so this
    // path bypasses the predictor entirely.
    if (ctrlArmed && data.length === 1) {
      const ctrl = ctrlByte(data);
      ctrlArmed = false;
      void transport.input(sessionId, ctrl ?? data);
      return;
    }
    // Predictive local echo (#731): paint a dim "ghost" grapheme at the cursor
    // BEFORE the pty's real echo round-trips, then reconcile on the output path.
    // The predictor decides whether it's safe (printable-at-cursor / simple
    // backspace, not alt-screen, RTT-gated). The real bytes are ALWAYS sent
    // unchanged regardless of the decision — overlay only (internal docs C.1).
    if (predictionEnabled && term) {
      const decision = classifyInput(data, predictor);
      if (decision.kind === "predict") {
        term.write(enqueuePrediction(decision.prediction, predictor));
      }
    }
    void transport.input(sessionId, data);
  }

  // Route an authoritative output chunk through the predictor's reconciler before
  // writing to xterm (internal docs C.2). Confirmed predictions are overwritten by
  // the real echo (looks instant); a divergence erases the stale ghost cells and
  // repaints. Also syncs alt-screen state from xterm's parsed buffer type (the
  // robust runtime backstop to the byte scan). When prediction is off (desktop
  // bridge), this is a pass-through write.
  function writeOutput(data: string, replayDims?: { cols: number; rows: number }): void {
    if (!term) return;
    // Any real output means the daemon is serving this pty → the cold-start race is
    // over; stop the blank-screen re-subscribe watchdog.
    if (data.length > 0) noteContentArrived();
    // HISTORY-REPLAY REFLOW (#48 mobile→desktop garble): the daemon tags the re-attach
    // history frame with the width its bytes were CAPTURED at. Those bytes encode that
    // width's wrap + cursor layout; writing them straight into a now-wider xterm
    // desyncs cursor positioning so rows overlap/mis-wrap and scroll dies. Reproduce
    // them at the capture width FIRST, then resize xterm back to the current width so
    // xterm's native reflow re-wraps the whole buffer to fit — exactly what a real
    // terminal does when you widen its window. Only when the capture width actually
    // differs (a same-width re-attach skips this and writes normally). This frame is
    // an authoritative scrollback rebuild, so it bypasses the predictor (no pending
    // local echo at re-attach) and writes raw, like a snapshot repaint.
    if (
      replayDims &&
      replayDims.cols > 0 &&
      replayDims.rows > 0 &&
      (replayDims.cols !== term.cols || replayDims.rows !== term.rows)
    ) {
      const targetCols = term.cols;
      const targetRows = term.rows;
      reflowingHistory = true;
      term.resize(replayDims.cols, replayDims.rows);
      term.write(data, () => {
        // The capture-width bytes are now parsed; widen back so xterm reflows them
        // to the current geometry. Clear the flag here on the normal path; the
        // disposed/raced case (term.dispose() abandons this pending callback so it
        // never fires) is covered separately by teardown() resetting the flag, so a
        // torn-down reflow can't wedge fitAndResize off for a same-instance remount.
        reflowingHistory = false;
        // If the component was torn down while this async write was draining, term is
        // null — bail before scheduling fitSoon() (a timer that would dangle past
        // teardown) or touching a dead terminal. teardown() already cleared the flag.
        if (!term) return;
        term.resize(targetCols, targetRows);
        // Real xterm flushes its write buffer ASYNCHRONOUSLY, so a large scrollback
        // blob keeps reflowingHistory=true for tens-to-hundreds of ms. On MOBILE the
        // soft keyboard (or rotation, or a pane reveal) can fire visualViewport
        // resize/scroll DURING that window → applyViewportHeight → fitSoon → but
        // fitAndResize early-returns while reflowingHistory is set, DROPPING that fit.
        // fitSoon does not self-re-arm, and the resize-back above restores the STALE
        // pre-keyboard target (and sends no pty resize), so xterm + pty are left
        // mis-sized under the keyboard until the next gesture. Re-run a guarded fit
        // here so the dropped fit is replayed against the TRUE current container
        // geometry (fitAndResize re-measures the container and re-sends the pty
        // resize); the 60ms debounce coalesces it with any pending keyboard fit. Also
        // re-pin to the bottom: a width reflow re-wraps the buffer and can push the
        // prompt below the keyboard fold.
        fitSoon();
        scrollTerminalToBottom();
      });
      return;
    }
    if (!predictionEnabled) {
      term.write(data);
      return;
    }
    // xterm has already parsed any ?1049h/l in earlier chunks — trust its buffer
    // type as the authoritative alt-screen signal (internal docs C.3).
    predictor.altScreen = term.buffer.active.type === "alternate";
    const { write } = reconcile(data, predictor);
    term.write(write);
  }

  function tapAccessory(key: AccessoryKey): void {
    if (!sessionId) return;
    void transport.input(sessionId, accessoryKeyBytes(key));
    ctrlArmed = false;
    term?.focus();
  }

  function tapCtrl(): void {
    ctrlArmed = !ctrlArmed;
    term?.focus();
  }

  // Re-bind a live session after the WebSocket dropped and re-connected (#48
  // BUG-2). The component stays MOUNTED across a socket blip, so this is NOT a
  // remount: term, the xterm buffer, and the output/exit subscriptions all
  // survive (the latter live on the client and ride the reconnect). What does
  // NOT survive is the daemon's binding of the ephemeral pty stream to the old
  // socket — so without re-issuing attach(), output goes silently frozen. We
  // re-attach the CURRENT live session; the daemon re-points its stream and
  // replays scrollback, so we reset the viewport first to reproduce the buffer
  // instead of stacking a duplicate copy under the old one. A dead session
  // (ok:false) is left as-is — we do NOT spawn a fresh pty here (that is the
  // remount path's job, #762); input simply no-ops until the user navigates back.
  // Public entry — guards against a re-subscribe LOOP (#797). Every trigger
  // (onReconnect, onDaemonReconnect on each offline→online edge, the initial
  // transient outcome) routes through here. While a re-subscribe (incl. its bounded
  // FIX-3 retry chain) is in flight, a fresh trigger is a NO-OP: the in-flight
  // re-subscribe already heals from the daemon's freshest snapshot, so a second
  // concurrent subscribe would only stack another viewer on the daemon (the 3-in-1s
  // signal) and churn another term.reset() that wipes live output. The latch is
  // released by the worker on every terminal outcome (live / ended / cap) and on an
  // early bail; it is HELD across a scheduled retry so the chain owns it end-to-end.
  function reattachLive(): void {
    if (reattaching) return;
    reattaching = true;
    void reattachLiveAttempt(0);
  }

  async function reattachLiveAttempt(attempt: number): Promise<void> {
    const id = sessionId;
    // Re-SUBSCRIBE (internal docs): the daemon re-delivers a fresh snapshot that
    // repaints the post-reconnect screen via this viewer's own Paseo subscription.
    const rewatch = transport.subscribe;
    if (!id || !rewatch || !term) {
      reattaching = false;
      return;
    }
    const token = startToken;
    // Surface the recoverable drop so the user sees "Reconnecting… (attempt N)"
    // instead of a frozen/black surface (internal docs B.4). 1-based for display.
    status = { kind: "reconnecting", attempt: attempt + 1 };
    let res: { ok: boolean; dead?: boolean; live?: boolean; endedReason?: TerminalEndedReason };
    try {
      // Re-subscribe with the SAME per-mount attachId (internal docs GAP-1) so the
      // daemon REPLACES this view's viewer in place (tears down the stale Paseo
      // subscription whose socket is now dead, opens a fresh one) rather than
      // stacking a duplicate.
      res = await rewatch(id, attachId ?? undefined);
    } catch {
      // An unexpected throw is treated as TRANSIENT (link-down): schedule a retry
      // rather than dead-ending. no-silent-catch: the handling is the bounded
      // retry below, not a swallow.
      res = { ok: false, dead: false };
    }
    // Raced an unmount or a new session while re-watching — abandon quietly.
    if (token !== startToken || sessionId !== id) {
      reattaching = false;
      return;
    }

    if (res.ok && res.live !== false) {
      // Re-subscribe landed onto a LIVE pty. Back to interactive. Subscribe heals
      // via a fresh snapshot whose listener resets + repaints, so we do NOT reset
      // here (that would race the snapshot repaint).
      status = { kind: "live" };
      // Re-sync the pty geometry to our current fit (it may have changed while
      // disconnected); fitAndResize sends the resize since sessionId is set.
      fitAndResize();
      reattaching = false;
      // A re-subscribe can ALSO land blank if the daemon is still warming up — keep
      // the watchdog armed until output actually paints.
      armBlankWatchdog();
      return;
    }

    // Re-subscribe onto a DEAD session (live:false) OR an authoritative dead ack:
    // the pty is genuinely gone. Show the read-only-history + [Restart] UX
    // (internal docs B.5). The scrollback (live:false) flows through onData.
    if ((res.ok && res.live === false) || res.dead) {
      makeReadOnly();
      status = { kind: "ended", reason: res.endedReason };
      reattaching = false;
      return;
    }

    // TRANSIENT failure (timeout / link-down): bounded auto-retry with capped
    // backoff (internal docs FIX-3) before concluding the session is gone — a daemon
    // mid-restart needs a few seconds. Only after the cap do we dead-end to "ended".
    if (attempt + 1 >= MAX_REATTACH_ATTEMPTS) {
      makeReadOnly();
      status = { kind: "ended", reason: res.endedReason };
      reattaching = false;
      return;
    }
    // Keep the reattaching latch HELD across the scheduled retry — the chain owns it
    // end-to-end so a stray trigger can't start a SECOND chain in parallel.
    const delay = Math.min(REATTACH_BASE_MS * 2 ** attempt, REATTACH_MAX_MS);
    if (reattachTimer) clearTimeout(reattachTimer);
    reattachTimer = setTimeout(() => {
      reattachTimer = null;
      // Re-check generation before retrying so a remount/unmount cancels.
      if (token === startToken && sessionId === id) {
        void reattachLiveAttempt(attempt + 1);
      } else {
        // Generation changed (remount/unmount) — release the latch we were holding.
        reattaching = false;
      }
    }, delay);
  }

  // Make the xterm buffer read-only (internal docs B.5): the daemon replayed dead
  // scrollback (#750), so keystrokes must NOT vanish into a gone session. Drops the
  // term.onData wiring effect by disabling stdin; the [Restart] affordance is the
  // way forward.
  function makeReadOnly(): void {
    if (term) term.options.disableStdin = true;
    resetPredictions(predictor);
    ctrlArmed = false;
  }

  // Subscribe to output/exit and wire the resize observers once a live sessionId
  // exists. Shared by both the attach (existing session) and start (new pty)
  // paths. Listeners are filtered by the current sessionId. Every disposer it
  // registers is also collected into `own` and returned, so a single early-wire
  // (the attach path) can be unwound on its own if attach fails and we fall back
  // to start() — without disposing the rest of the component.
  function wireSession(el: HTMLDivElement): () => void {
    const own: Array<() => void> = [];
    const track = (dispose: () => void) => {
      own.push(dispose);
      disposers.push(dispose);
    };

    track(
      transport.onData(({ id: evId, data, replayCols, replayRows }) => {
        if (evId !== sessionId) return;
        writeOutput(
          data,
          replayCols && replayRows ? { cols: replayCols, rows: replayRows } : undefined,
        );
      }),
    );
    // Repaint from the daemon's screen SNAPSHOT (internal docs Phase 1). Paseo
    // re-delivers a full screen snapshot on every (re)subscribe — the self-heal
    // payload. When one arrives for THIS session, reset xterm and write the
    // rendered snapshot so the view shows the authoritative current screen
    // (cells + cursor), then live `output` continues incrementally on top. This is
    // ADDITIVE to the existing scrollback-replay attach path: whichever arrives
    // repaints; a later phase deletes the scrollback replay once subscribe lands.
    if (transport.onSnapshot) {
      track(
        transport.onSnapshot(({ id: evId, state, historyReplayed }) => {
          if (evId !== sessionId || !term) return;
          // HISTORY-REPLAYED RE-ATTACH (internal docs #5): the daemon already pushed
          // the full scrollback ring as a cyborg:terminal_output history frame just
          // before this snapshot. Those bytes reproduced the authoritative terminal
          // state (scrollback + screen + cursor + alt-screen mode) into xterm, so a
          // term.reset()+repaint here would WIPE the just-rebuilt scrollback and
          // leave only the visible screen — the exact bug we're fixing. Treat the
          // snapshot as confirmatory and skip the reset; drop in-flight predictions
          // (the replay is the new ground truth) but leave the buffer intact.
          if (historyReplayed) {
            // The scrollback ring was replayed as output just before this → the
            // daemon served real content; retire the cold-start blank watchdog.
            noteContentArrived();
            resetPredictions(predictor);
            return;
          }
          // EMPTY snapshot guard (the "reattached terminal is black" bug): a
          // PtyHost rehydrated re-attach replays the real screen as terminal_output
          // bytes, then emits a SECOND, blank snapshot (historyReplayed:false — the
          // proxied session has no tracked grid). term.reset()+repaint from that
          // blank state would WIPE the byte-replayed screen and leave it black with
          // input gated off. A blank snapshot must never clear a populated screen —
          // the live output is the ground truth — so skip the repaint.
          if (isBlankTerminalState(state)) {
            resetPredictions(predictor);
            return;
          }
          // A (re)subscribe snapshot is an AUTHORITATIVE full-screen repaint
          // (internal docs C.6): drop all in-flight predictions and reset mode
          // flags BEFORE the reset+write, so stale ghosts can't survive the
          // repaint. term.reset() clears the screen (incl. dim cells), so we write
          // the snapshot raw — no reconcile needed. This self-heals any divergence.
          resetPredictions(predictor);
          term.reset();
          term.write(renderTerminalSnapshotToAnsi(state));
          // A non-blank snapshot painted authoritative content → not a cold-start
          // blank; retire the watchdog.
          noteContentArrived();
        }),
      );
    }
    track(
      transport.onExit(({ id: evId, exitCode: code }) => {
        if (evId !== sessionId) return;
        // The pty is gone for good — drop its stable-attachId mapping so the realm
        // map can't grow unbounded and a recycled terminalId can't reuse a stale id.
        forgetAttachId(evId);
        // Drop any in-flight ghost predictions — the pty is gone, nothing will
        // ever confirm them (internal docs C.5.7).
        resetPredictions(predictor);
        sessionId = null;
        // The session is gone — drop a dangling sticky-Ctrl latch so it can't
        // silently mangle the next keystroke after a restart (#48 BUG-9).
        ctrlArmed = false;
        // Surface the exit code inline (BUG-7). Non-zero codes read as an error tint.
        const tint = code === 0 ? "2m" : "31m";
        term?.write(`\r\n\x1b[${tint}[process exited (code ${code})]\x1b[0m\r\n`);
        // internal docs B.3: the shell exited on its own — show the read-only buffer
        // + [Restart] affordance (shell_exit reason) rather than leaving a live-but-
        // dead surface. makeReadOnly drops stdin so keystrokes can't vanish.
        makeReadOnly();
        status = { kind: "ended", reason: "shell_exit" };
        onExit?.(code);
      }),
    );
    const dataSub = term?.onData(sendData);
    if (dataSub) track(() => dataSub.dispose());

    // Re-attach on WS reconnect so a socket blip doesn't silently freeze the
    // terminal (#48 BUG-2). Tracked like every other subscription so teardown
    // (and the attach→start fallback's scoped unwind) cleans it up.
    if (transport.onReconnect) {
      track(transport.onReconnect(() => void reattachLive()));
    }
    // internal docs FIX-1 (headline fix): on a DAEMON↔relay flap the guest socket
    // stays OPEN so onReconnect above never fires, yet the daemon stopped streaming
    // and never re-pushes a snapshot — the terminal freezes / dead-ends. Re-subscribe
    // on the daemon offline→online transition (same reattachLive path) so the live
    // pty repaints from a fresh snapshot. Gated on this view's daemonId.
    if (transport.onDaemonReconnect && daemonId) {
      track(transport.onDaemonReconnect(daemonId, () => void reattachLive()));
    }

    // Re-fit on container resize AND on rotation / soft-keyboard changes. This
    // is ALSO the keep-alive re-fit path (internal docs): when an inactive pane
    // flips `display:none → visible`, its box goes 0×0 → real, which the observer
    // reports as a size change, so the (now-visible, canFitContainer-guarded)
    // fitAndResize lands the correct cols×rows and forwards the resize to the pty.
    // Lightly debounced so a burst of layout ticks (drag-resize, keyboard
    // animation) collapses into one fit instead of spamming the pty with resizes.
    let roTimer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (roTimer) clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        roTimer = null;
        // If the view was pinned to the bottom (the typing case), KEEP it there
        // across the resize so the soft keyboard shrinking the viewport can't hide
        // the cursor/prompt behind it (#48: "I can't see what I'm typing"). If the
        // user had scrolled up to read history, leave their scroll position alone.
        const wasAtBottom = term
          ? term.buffer.active.viewportY >= term.buffer.active.baseY
          : false;
        fitAndResize();
        if (wasAtBottom) scrollTerminalToBottom();
      }, 50);
    });
    ro.observe(el);
    track(() => {
      if (roTimer) clearTimeout(roTimer);
      ro.disconnect();
    });

    const onWindowResize = () => fitAndResize();
    // Rotation changes both the viewport height (re-pin) and the fit. On mobile
    // route through the viewport sync so the keyboard-above height pin is recomputed
    // too, not just the fit; desktop just re-fits. The delay lets the new geometry
    // settle before we measure.
    const onOrientation = () =>
      setTimeout(softKeyboardSizing() ? scheduleViewportSync : fitAndResize, 150);
    window.addEventListener("resize", onWindowResize);
    window.addEventListener("orientationchange", onOrientation);
    track(() => window.removeEventListener("resize", onWindowResize));
    track(() => window.removeEventListener("orientationchange", onOrientation));

    // Keep the prompt above the keyboard when the input gains focus. The keyboard
    // opens a beat AFTER focus, so re-pin to the bottom on focusin on EVERY platform
    // (the xterm textarea is the hidden helper inside our container). On plain mobile
    // web (softKeyboardSizing) ALSO re-run this component's viewport sync; on the
    // native shell the root +layout's --app-vh + the ResizeObserver handle the
    // resize, so scroll-to-bottom is all we add here.
    const onFocusIn = () => {
      scrollTerminalToBottom();
      if (softKeyboardSizing()) scheduleViewportSync();
    };
    el.addEventListener("focusin", onFocusIn);
    track(() => el.removeEventListener("focusin", onFocusIn));

    // First-tap focus (#48 mobile): the other focus calls are programmatic (accessory
    // -bar buttons, the post-attach term.focus()), so without a handler on the body a
    // deliberate tap focused nothing — the user had to tap repeatedly to get a cursor.
    // Use `click`, NOT `pointerdown` (Gemini #946): click fires only on a tap (pointer
    // down+up with no significant move), so DRAGGING to scroll scrollback never
    // focuses / yanks to bottom / raises the keyboard mid-gesture. A tap is still a
    // genuine user gesture, which iOS WKWebView accepts to raise the soft keyboard for
    // xterm's hidden textarea.
    const onClick = () => {
      if (status.kind === "live") term?.focus();
    };
    el.addEventListener("click", onClick);
    track(() => el.removeEventListener("click", onClick));

    // Track the visual viewport ONLY where THIS component owns the soft-keyboard pin
    // (plain mobile web). On desktop these fire on page scroll / window resize
    // (already covered by the ResizeObserver + window "resize" above); on the native
    // shell softKeyboardSizing() is false because the root +layout owns --app-vh.
    // The keyboard resize does NOT fire a window "resize", so visualViewport's own
    // resize + scroll are the only signals — routed through the rAF-throttled
    // scheduler so a keyboard-animation burst stays smooth (one recompute/frame).
    const vv = softKeyboardSizing() ? window.visualViewport : null;
    if (vv) {
      const onVv = () => scheduleViewportSync();
      vv.addEventListener("resize", onVv);
      vv.addEventListener("scroll", onVv);
      track(() => vv.removeEventListener("resize", onVv));
      track(() => vv.removeEventListener("scroll", onVv));
    }
    applyViewportHeight();
    term?.focus();

    // Unwind ONLY this wire-up's disposers (used by the attach→start fallback).
    return () => {
      for (const dispose of own) {
        dispose();
        const at = disposers.indexOf(dispose);
        if (at !== -1) disposers.splice(at, 1);
      }
    };
  }

  // BUG-3: subscribe to output BEFORE start() resolves so the prompt/banner the
  // daemon emits the instant it acks start isn't dropped. The pty id isn't known
  // until start() returns, so this buffers every output frame; adopt(id) then
  // claims the id, flushes the frames that match it, and hands off to the durable
  // wireSession() subscription. dispose() unwinds the pre-subscription if start
  // fails or the mount is torn down before adoption.
  function preWireStart(el: HTMLDivElement): StartSubscription {
    let live = true;
    const buffered: Array<{
      id: string;
      data: string;
      replayCols?: number;
      replayRows?: number;
    }> = [];
    const offData = transport.onData((frame) => {
      if (live) buffered.push(frame);
    });
    return {
      adopt(id: string) {
        live = false;
        offData();
        sessionId = id;
        // Install the durable filtered listeners + observers first, then replay
        // the buffered frames into the now-open terminal in arrival order.
        wireSession(el);
        for (const frame of buffered) {
          if (frame.id === id)
            writeOutput(
              frame.data,
              frame.replayCols && frame.replayRows
                ? { cols: frame.replayCols, rows: frame.replayRows }
                : undefined,
            );
        }
        buffered.length = 0;
      },
      dispose() {
        live = false;
        offData();
        buffered.length = 0;
      },
    };
  }

  async function initTerminal(el: HTMLDivElement, token: number): Promise<void> {
    // Fresh per-mount state for the cold-start blank watchdog (first mount never
    // runs teardown first).
    receivedOutput = false;
    blankAttempts = 0;
    clearBlankWatchdog();
    clearColdHint();
    armColdHint();
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      // Unmounted/re-run while the chunk loaded — abort before touching the DOM.
      if (token !== startToken) return;
      const fit = new FitAddon();
      fitAddon = fit;
      term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
        // Slightly looser line height reads better at small sizes.
        lineHeight: 1.1,
        theme: { background: "#1e242d", foreground: "#d7dce5" },
        // The terminal owns scrolling; the page must not bounce under a touch.
        scrollback: 2000,
      });
      term.loadAddon(fit);
      term.open(el);
      fitAndResize();

      // Resolve a live pty (internal docs Phase 2): prefer (re)SUBSCRIBE to the
      // existing session — the daemon re-delivers a FRESH screen snapshot that
      // repaints the view (snapshot-on-(re)subscribe). A failed (re)subscribe does
      // NOT fall back to a fresh start() (the deleted #789 blast radius): it
      // surfaces a dead-end instead of orphaning the live pty. start() runs only
      // for a brand-new terminal (no terminalId) or the desktop bridge (no
      // subscribe).
      const outcome = await resolveTerminalSession({
        terminalId: effectiveTerminalId,
        subscribe: transport.subscribe
          ? (id) => transport.subscribe!(id, attachId ?? undefined)
          : undefined,
        start: () =>
          transport.start({
            cols: term!.cols,
            rows: term!.rows,
            command,
            cwd,
            attachId: attachId ?? undefined,
          }),
        kill: (id) => transport.kill(id),
        isCurrent: () => token === startToken,
        // Early-wire the (re)subscribe path BEFORE it awaits, so the daemon's
        // fresh snapshot / scrollback-replay frame isn't missed. If it fails, the
        // returned disposer unwinds just this subscription.
        onAttachAttempt: (id) => {
          sessionId = id;
          // The snapshot/scrollback repaints immediately — go live so the remount
          // path never flashes "Connecting…". A subsequent dead/transient outcome
          // (below) downgrades to ended/reconnecting.
          status = { kind: "live" };
          return wireSession(el);
        },
        // Early-wire the start path too (BUG-3): buffer output before start()
        // resolves, then adopt the id + flush. Symmetric with the subscribe path.
        onStartAttempt: () => preWireStart(el),
      });

      // Lost the mount race — teardown already ran (or will). Nothing to show.
      if (outcome.kind === "aborted") return;

      if (outcome.kind === "subscribed") {
        // Already wired in onAttachAttempt; the live stream + fresh snapshot repaint
        // flow through the existing subscription. Do NOT spawn a second pty.
        status = { kind: "live" };
        // Heal a cold-start race: the subscribe can land before the daemon has
        // surfaced the pty (blank screen, no ring) — re-subscribe until output paints.
        armBlankWatchdog();
        return;
      }

      if (outcome.kind === "started" && outcome.id) {
        // Pin the fresh-start attachId to the daemon-assigned terminalId so a later
        // remount-as-subscribe reuses the SAME id and the daemon replaces this
        // view's viewer in place rather than stacking a duplicate (#778/#779 fix).
        if (attachId) rememberAttachId(outcome.id, attachId);
        // Already wired + adopted in preWireStart's adopt(id); the prompt/banner
        // emitted before the ack was buffered and flushed. Go live now that a real
        // pty exists (#48 BUG-4). wireSession(el) is NOT called here — preWireStart's
        // adopt(id) already installed the durable listeners + observers and flushed
        // the buffered early frames (#777).
        status = { kind: "live" };
        return;
      }

      // internal docs PART B Gap 2: a (re)subscribe onto a GENUINELY-gone session
      // (#750 read-only history — the daemon replayed dead scrollback through the
      // already-wired onData listener). Do NOT teardown (that would drop the buffer
      // we just painted) and do NOT dump the raw "no longer available" string. Make
      // the buffer read-only and show the "session ended — [Restart]" affordance.
      if (outcome.kind === "ended") {
        makeReadOnly();
        status = { kind: "ended", reason: outcome.endedReason };
        return;
      }

      // internal docs FIX-2/3: a TRANSIENT (re)subscribe failure (timeout / link-down
      // during a flap), NOT an authoritative dead session. Keep the view mounted,
      // show "Reconnecting…", and auto-retry with backoff — only a real dead ack or
      // an exhausted retry budget dead-ends. The session id was adopted in
      // onAttachAttempt, so reattachLive() has an id to retry.
      if (outcome.kind === "transient") {
        void reattachLive();
        return;
      }

      // A fresh start() that FAILED (genuine error, not a dead existing session).
      // Clean up the partial state and surface the error with a [Retry] affordance.
      teardown();
      status = { kind: "error", message: outcome.error ?? "Failed to start the terminal." };
    } catch (err) {
      // Clean up whatever partial state was built (listeners, term, session)
      // before surfacing the error — a failed start must not leak.
      if (token === startToken) {
        teardown();
        status = {
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to start the terminal.",
        };
      }
    }
  }

  function teardown(): void {
    // Invalidate any in-flight initTerminal so its post-await checks bail.
    startToken++;
    // Stop the cold-start blank watchdog + reset its per-mount state so a fresh
    // (re)mount starts with a full retry budget and no stale timer firing into it.
    clearBlankWatchdog();
    clearColdHint();
    receivedOutput = false;
    blankAttempts = 0;
    // Cancel a pending bounded reattach retry (internal docs FIX-3) so it can't fire
    // into a torn-down view (the startToken bump also guards it, belt-and-suspenders).
    if (reattachTimer) {
      clearTimeout(reattachTimer);
      reattachTimer = null;
    }
    // Release the re-subscribe latch (#797) so a fresh mount can reattach again —
    // a pending attempt's post-await generation check bails on the startToken bump.
    reattaching = false;
    // Cancel pending mobile keyboard recompute work so a queued rAF / debounced
    // fit can't fire into a torn-down terminal.
    if (vvFrame !== null) {
      cancelAnimationFrame(vvFrame);
      vvFrame = null;
    }
    if (fitTimer) {
      clearTimeout(fitTimer);
      fitTimer = null;
    }
    // Clear the history-reflow latch (#48). Its ONLY other clear path is the
    // term.write completion callback — but term.dispose() below abandons xterm's
    // pending write queue, so if teardown lands DURING a reflow that callback never
    // fires and the flag would stay true. Because it is component-instance-scoped, a
    // same-instance remount (retry/restart/status flip) would then inherit
    // reflowingHistory=true and silently drop EVERY future fitAndResize (keyboard,
    // rotation, ResizeObserver) for the life of that mount. Reset it here so a torn-
    // down/raced reflow can never wedge responsiveness off permanently.
    reflowingHistory = false;
    for (const dispose of disposers) dispose();
    disposers = [];
    // Reset the predictor so no ghost state (queue, RTT history) crosses a
    // session boundary into the next mount (internal docs C.5.7).
    teardownPredictor(predictor);
    // #732/internal docs: do NOT kill the pty on unmount — UNSUBSCRIBE it. A tab
    // switch / navigation unmounts this component, but the daemon session must
    // SURVIVE so the user can return to it (re-subscribe → fresh snapshot).
    // Unsubscribe just drops THIS view's viewer (and its Paseo subscription) so the
    // daemon stops streaming output here and a truly abandoned pty becomes reapable
    // once it exits. The pty dies only on an EXPLICIT close (sidebar →
    // cyborg:kill_terminal) or when the shell exits on its own.
    if (sessionId && attachId) {
      void transport.unsubscribe?.(sessionId, attachId);
    }
    sessionId = null;
    attachId = null;
    ctrlArmed = false;
    term?.dispose();
    term = null;
    fitAddon = null;
  }

  $effect(() => {
    const el = containerEl;
    if (!el) return;
    const token = ++startToken;
    // Reset to the connecting status on every (re)mount. A prior "ended"/"error"
    // is cleared so a Restart/Retry that re-mounts the surface starts clean.
    status = { kind: "connecting" };
    // Subscriber id (internal docs GAP-1) BEFORE start/attach so the daemon
    // registers this exact id and the teardown detach can match it. STABLE across
    // remounts when terminalId is known (#778/#779 fix): a remount re-presents the
    // same id so the daemon replaces this view's attacher in place instead of
    // stacking a duplicate (which double-rendered output/echo). Fresh per call for
    // a brand-new start (no terminalId yet); pinned to the real id once start
    // resolves (see onStartAttempt below).
    attachId = stableAttachId(effectiveTerminalId);
    // The connecting overlay shows until a live pty exists (status already set
    // above). The attach path flips to "live" eagerly (onAttachAttempt) so a
    // remount doesn't flash it.
    void initTerminal(el, token);
    return () => teardown();
  });

  // BUG-5: a genuine start failure lands in status "error". Without a way out the
  // user is stuck until they navigate away and back. Flipping status back to
  // "connecting" re-mounts the terminal surface (`bind:this={containerEl}`), which
  // re-fires the $effect and runs a fresh initTerminal — a clean in-place retry
  // with no route change. RE-attempts the SAME id (vs. restart, which drops it).
  function retry(): void {
    status = { kind: "connecting" };
  }

  // internal docs B.5 [Restart]: respawn a fresh pty IN THE SAME TAB after a session
  // ended (#750). The difference from retry(): we DROP the dead terminalId
  // (terminalIdOverride = "") so resolveTerminalSession takes the start() branch (a
  // brand-new pty, same cwd) instead of re-subscribing to the gone session. Setting
  // the override + flipping to "connecting" re-fires the $effect (terminalEffective
  // changed) → fresh initTerminal → start(). A one-line evolution of retry().
  function restart(): void {
    terminalIdOverride = "";
    status = { kind: "connecting" };
  }

  // internal docs B.5 [Dismiss]: drop the ended read-only view. We don't have a
  // forget RPC plumbed (out of scope here), so this simply tears the surface down
  // and parks the view in an "error"-shaped empty state — the sidebar row removal
  // is owned by the route's onExit. Kept minimal: it just stops showing dead
  // scrollback. (A forget-sidecar RPC is the #750 §B.5 follow-up.)
  function dismiss(): void {
    teardown();
    status = { kind: "error", message: "Session ended." };
  }

  // internal docs B.5: pick the "session ended" banner copy from the reason.
  function endedBannerText(reason?: TerminalEndedReason): string {
    if (reason === "daemon_restart") return "This terminal stopped when the app restarted.";
    if (reason === "shell_exit") return "Session ended.";
    return "This terminal session is no longer available.";
  }

  // The accessory bar layout: label + the key it sends.
  const ACCESSORY_KEYS: { key: AccessoryKey; label: string }[] = [
    { key: "esc", label: "Esc" },
    { key: "tab", label: "Tab" },
    { key: "left", label: "←" },
    { key: "up", label: "↑" },
    { key: "down", label: "↓" },
    { key: "right", label: "→" },
    { key: "pipe", label: "|" },
    { key: "tilde", label: "~" },
    { key: "slash", label: "/" },
  ];
</script>

<div
  bind:this={rootEl}
  class="flex h-full min-h-0 w-full flex-col overflow-hidden"
  style="background: #1e242d;"
>
  {#if status.kind === "error"}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <div class="text-[13px] text-error">{status.message}</div>
      <!-- BUG-5: a recoverable affordance instead of a dead error screen. -->
      <button
        type="button"
        onclick={retry}
        class="shrink-0 rounded-[7px] px-4 py-1.5 text-[13px] font-semibold text-content"
        style="background: rgba(255,255,255,0.08);"
      >
        Retry
      </button>
    </div>
  {:else}
    <!-- Terminal surface (relative so the connecting/reconnecting/ended overlays can
         sit on top of the live xterm without unmounting it — term.open() needs the
         element, and "ended" keeps the read-only #750 scrollback visible). -->
    <div class="relative min-h-0 flex-1 overflow-hidden">
      <div bind:this={containerEl} class="h-full w-full px-1.5 py-1"></div>
      {#if status.kind === "connecting"}
        <!-- BUG-4: no longer a black "is it frozen?" surface during the start
             window — show a clear status. pointer-events-none so it never eats a
             tap; the accessory bar below is disabled instead. -->
        <div
          class="pointer-events-none absolute inset-0 flex items-center justify-center text-[13px] text-content/70"
          aria-live="polite"
        >
          Connecting…
        </div>
      {:else if status.kind === "reconnecting"}
        <!-- internal docs B.4: a visible "Reconnecting…" during a transient drop
             (WS blip or daemon flap), composed with the FIX-3 bounded auto-retry,
             instead of the old black/frozen surface. The buffer stays visible
             underneath; this is a slim top banner, not a full cover. -->
        <div
          class="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 px-3 py-1.5 text-[12px] text-content"
          style="background: rgba(91,181,240,0.18);"
          aria-live="polite"
        >
          Reconnecting… (attempt {status.attempt})
        </div>
      {:else if status.kind === "live" && coldHint}
        <!-- COLD-DAEMON LOADING HINT: the surface went eagerly-"live" but no output
             has painted yet (a cold reopen — the daemon is still surfacing the
             reattached pty). Show clear feedback instead of a blank screen; it clears
             the instant the first byte paints (a warm reattach never reaches it). -->
        <div
          class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-[13px] text-content/70"
          aria-live="polite"
        >
          <div
            class="h-4 w-4 animate-spin rounded-full border-2 border-content/25"
            style="border-top-color: var(--accent, #5BB5F0);"
          ></div>
          Reattaching to the live session…
        </div>
      {:else if status.kind === "ended"}
        <!-- internal docs B.5: a GENUINELY-ended session. The read-only #750
             scrollback is already painted into xterm below (stdin disabled in
             makeReadOnly); this banner sits over it with a one-click [Restart]
             (respawn in the same tab) + [Dismiss]. pointer-events-auto so the
             buttons are clickable. -->
        <div
          class="absolute inset-x-0 top-0 flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-[12px] text-content"
          style="border-color: rgba(255,255,255,0.08); background: rgba(17,21,31,0.95);"
          aria-live="polite"
        >
          <span>{endedBannerText(status.reason)}</span>
          <div class="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onclick={restart}
              class="rounded-[7px] px-3 py-1 text-[12px] font-semibold text-content"
              style="background: var(--accent, #5BB5F0); color: #000;"
            >
              Restart
            </button>
            <button
              type="button"
              onclick={dismiss}
              class="rounded-[7px] px-3 py-1 text-[12px] font-semibold text-content"
              style="background: rgba(255,255,255,0.08);"
            >
              Dismiss
            </button>
          </div>
        </div>
      {/if}
    </div>

    <!-- Touch accessory bar: control keys a soft keyboard doesn't offer. Sits
         directly above the on-screen keyboard. Horizontally scrollable so it
         never wraps on a narrow phone. Disabled whenever the pty isn't interactive
         (connecting / reconnecting / ended). -->
    <div
      class="flex shrink-0 items-stretch gap-1 overflow-x-auto border-t px-1.5 py-1.5"
      style="border-color: rgba(255,255,255,0.08); background: #262d37; -webkit-overflow-scrolling: touch;"
      role="toolbar"
      aria-label="Terminal keys"
    >
      <button
        type="button"
        onclick={tapCtrl}
        disabled={inputDisabled}
        aria-pressed={ctrlArmed}
        class={[
          "shrink-0 rounded-[7px] px-3 py-1.5 text-[13px] font-semibold tabular-nums transition-opacity",
          ctrlArmed ? "text-black" : "text-content",
          inputDisabled && "opacity-40",
        ]}
        style="background: {ctrlArmed ? 'var(--accent, #5BB5F0)' : 'rgba(255,255,255,0.08)'};"
      >
        Ctrl
      </button>
      {#each ACCESSORY_KEYS as item (item.key)}
        <button
          type="button"
          onclick={() => tapAccessory(item.key)}
          disabled={inputDisabled}
          class={[
            "shrink-0 rounded-[7px] px-3 py-1.5 text-[13px] font-semibold text-content transition-opacity",
            inputDisabled && "opacity-40",
          ]}
          style="background: rgba(255,255,255,0.08); min-width: 38px;"
          aria-label={item.key}
        >
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* The terminal must not let the page rubber-band under touch scrolling. */
  div :global(.xterm) {
    height: 100%;
    overscroll-behavior: contain;
    touch-action: pan-y;
  }
  /* xterm's ACTUAL scroll element is the inner viewport — `.xterm` is just the
     wrapper. Give the viewport iOS momentum scrolling + contained overscroll +
     vertical-only touch so a finger drag scrolls the terminal smoothly instead of
     stuttering or fighting the WebView's outer scroll (#48: mobile scroll "super
     junky"). -webkit-overflow-scrolling enables the native momentum/inertia pass. */
  div :global(.xterm-viewport) {
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    touch-action: pan-y;
    scrollbar-width: none;
  }
  div :global(.xterm-viewport)::-webkit-scrollbar {
    display: none;
  }
</style>

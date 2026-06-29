// Predictive local echo ("ghost text") for the terminal — internal docs, #731.
//
// Pure, DOM-free, xterm-free (like terminal-transport.ts) so the prediction +
// reconciliation logic is unit-testable without a real terminal. TerminalView
// wires it between onData→transport.input (input overlay) and the output path
// (reconcile against the authoritative stream).
//
// The model is copied from mosh's tentative/epoch cells and VSCode's
// TypeAheadAddon prediction queue (both cited in internal docs PART B):
//
//   predict → display tentatively (dim/SGR-2) → confirm (real echo overwrites
//   the dim cell, looks instant) OR roll back (erase the dim cells, let the
//   authoritative output repaint).
//
// KEY INVARIANT (internal docs C.1): the predictor NEVER alters the bytes sent to
// the pty. `sendData` always sends the exact bytes. Prediction is a purely local
// visual overlay the authoritative stream confirms or erases. Worst case the user
// sees a brief dim char that gets erased — never a wrong byte reaching the shell.
//
// Scope = Phase 0 (instrument, off by default) + Phase 1 (minimal but VISIBLE
// predictor): printable-append + single-line backspace, gated by alt-screen +
// RTT, dim render, prefix-match confirm + total rollback on divergence, with a
// (re)subscribe snapshot treated as an authoritative repaint that drops all
// predictions. Cursor-move / multi-line / excludePrograms are Phase 2.

// ── Public decision + state types ───────────────────────────────────────────

export type PredictDecision =
  // Predict: write `render` (dim bytes) at the cursor NOW; the real bytes still go
  // to the pty unchanged. `prediction` is pushed onto the queue by the caller via
  // the value returned from onPredict (the decision only carries what to render).
  | { kind: "predict"; render: string; prediction: Prediction }
  // Passthrough: send to the pty, but DO NOT predict (control bytes, paste, RTT
  // gate closed, alt-screen, etc.).
  | { kind: "passthrough" };

export type PredictionKind = "char" | "backspace";

export interface Prediction {
  // The exact printable grapheme we optimistically painted (send order). For a
  // backspace prediction this is the empty string (it erases rather than emits).
  input: string;
  // The dim (SGR 2) bytes we wrote to xterm for this prediction. Used to compute
  // the rollback erase length.
  rendered: string;
  kind: PredictionKind;
  // Monotonic id / send timestamp — feeds RTT measurement + ordering.
  seq: number;
  sentAt: number;
}

export interface PredictorState {
  // Master flag (feature flag / transport gate). Off by default → ship dark (P0).
  enabled: boolean;
  // true ⇒ never predict (an app switched to the alt buffer: vim/less/htop/tmux).
  // Set by the output scanner AND by TerminalView from xterm's buffer type.
  altScreen: boolean;
  // true after a divergence / cursor-addressing / clear sequence until the line
  // resets (next prompt / Enter cycle). While set, classifyInput passes through.
  suspendedUntilReset: boolean;
  // Rolling RTT samples (ms) from confirmed predictions; median feeds the gate.
  rttSamples: number[];
  // localEchoLatencyThreshold analogue (VSCode default 30ms). Predict only when
  // the measured median RTT ≥ threshold. 0 = always predict, -1 = disabled.
  thresholdMs: number;
  // Pending (unconfirmed) predictions, in send order.
  queue: Prediction[];
  // Monotonic sequence counter for predictions.
  nextSeq: number;
}

export interface PredictorConfig {
  enabled?: boolean;
  thresholdMs?: number;
}

const DEFAULT_THRESHOLD_MS = 30;
// Rolling RTT window (internal docs C.4): keep the last N confirmed samples.
const RTT_WINDOW = 20;
// Need at least this many samples before the median is trusted enough to open the
// gate (measure-then-enable, policy (a) — avoids flicker on a fast/local link).
const RTT_MIN_SAMPLES = 3;

export function createPredictorState(config: PredictorConfig = {}): PredictorState {
  return {
    enabled: config.enabled ?? false,
    altScreen: false,
    suspendedUntilReset: false,
    rttSamples: [],
    thresholdMs: config.thresholdMs ?? DEFAULT_THRESHOLD_MS,
    queue: [],
    nextSeq: 1,
  };
}

// ── Dim render helpers (SGR 2 = dim on, 22 = dim off) ───────────────────────

const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[22m";

// Wrap a printable grapheme in dim SGR so the prediction is visually distinct
// ("ghost text") until the real echo confirms it. internal docs C.1.2.
function dimWrap(grapheme: string): string {
  return `${DIM_ON}${grapheme}${DIM_OFF}`;
}

// ── RTT measurement (internal docs C.4) ──────────────────────────────────────

export function recordRtt(sampleMs: number, state: PredictorState): void {
  if (!Number.isFinite(sampleMs) || sampleMs < 0) return;
  state.rttSamples.push(sampleMs);
  if (state.rttSamples.length > RTT_WINDOW) state.rttSamples.shift();
}

// Median of the rolling RTT window, or null while we still lack enough samples
// to trust it (measure-then-enable bootstrap).
export function medianRtt(state: PredictorState): number | null {
  if (state.rttSamples.length < RTT_MIN_SAMPLES) return null;
  const sorted = [...state.rttSamples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Is the RTT gate open? internal docs C.4 policy (a) — measure-then-enable:
//   thresholdMs === -1  → disabled (never)
//   thresholdMs === 0   → always (predict eagerly, even with no samples)
//   thresholdMs > 0     → predict only once the median is known AND ≥ threshold
export function rttGateOpen(state: PredictorState): boolean {
  if (state.thresholdMs < 0) return false;
  if (state.thresholdMs === 0) return true;
  const median = medianRtt(state);
  if (median === null) return false; // measuring — don't predict yet (no flicker)
  return median >= state.thresholdMs;
}

// ── Input classification (internal docs C.1.1) ───────────────────────────────

// A single printable grapheme: visible ASCII (0x20–0x7e) or a printable Unicode
// letter/symbol from the BMP. v1 deliberately excludes control bytes, ESC/CSI,
// and (to avoid mis-width erase on rollback) non-BMP / wide CJK — those pass
// through (internal docs PART F). `\x7f`/`\b` (backspace) is handled separately.
function isSinglePrintable(data: string): boolean {
  // Exactly one UTF-16 code unit, in the BMP, not a control char, not DEL.
  if (data.length !== 1) return false;
  const code = data.charCodeAt(0);
  if (code < 0x20) return false; // control bytes (incl. \r \n \t)
  if (code === 0x7f) return false; // DEL / backspace — handled separately
  if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
  return true;
}

function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

// Decide whether a keystroke is safe to predict. Returns a `predict` decision
// (with the dim render + the Prediction to enqueue) or `passthrough`. The caller
// ALWAYS sends the real bytes to the pty regardless — this only governs the
// local overlay.
export function classifyInput(
  data: string,
  state: PredictorState,
  now: number = Date.now(),
): PredictDecision {
  // Master gates: feature flag, alt-screen, post-divergence suspension, RTT.
  if (!state.enabled) return { kind: "passthrough" };
  if (state.altScreen) return { kind: "passthrough" };
  if (state.suspendedUntilReset) return { kind: "passthrough" };
  if (!rttGateOpen(state)) return { kind: "passthrough" };

  // Printable grapheme appended at the cursor → predict it dim.
  if (isSinglePrintable(data)) {
    const rendered = dimWrap(data);
    const prediction: Prediction = {
      input: data,
      rendered,
      kind: "char",
      seq: state.nextSeq++,
      sentAt: now,
    };
    return { kind: "predict", render: rendered, prediction };
  }

  // Single-line backspace: predict erasing the tail ONLY when it's an
  // un-confirmed char we just predicted on this line (internal docs C.1.2, F).
  // Erasing confirmed/unknown content is unsafe → passthrough.
  if (isBackspace(data)) {
    const tail = state.queue[state.queue.length - 1];
    if (tail && tail.kind === "char") {
      // Erase one cell: backspace, overwrite with space, backspace again.
      const rendered = "\b \b";
      const prediction: Prediction = {
        input: "",
        rendered,
        kind: "backspace",
        seq: state.nextSeq++,
        sentAt: now,
      };
      return { kind: "predict", render: rendered, prediction };
    }
    return { kind: "passthrough" };
  }

  // Everything else (control bytes, ESC/CSI arrows, Tab, Enter, multi-char paste,
  // accessory-bar / sticky-Ctrl bytes) → passthrough, never predict.
  return { kind: "passthrough" };
}

// Push a prediction onto the queue. Returns the dim bytes the caller writes to
// xterm. A backspace prediction POPS the char prediction it undoes (so a typed
// "a" then backspace nets to an empty queue and the erase confirms trivially).
export function enqueuePrediction(prediction: Prediction, state: PredictorState): string {
  if (prediction.kind === "backspace") {
    // Undo the optimistic char we just painted: drop it from the queue so the
    // authoritative echo isn't expected to contain it.
    state.queue.pop();
    return prediction.rendered;
  }
  state.queue.push(prediction);
  return prediction.rendered;
}

// ── Screen-mode detection (internal docs C.3) ────────────────────────────────

// Byte-scan signals that mean "this is no longer a cooked-mode line editor" —
// suspend prediction and drop the queue. The xterm buffer-type check in
// TerminalView is the runtime backstop; this lets the gate be unit-tested.
// The patterns are built with `new RegExp` from an ESC constant (not a regex
// LITERAL) so the source carries no raw control character (oxlint no-control-regex)
// while still requiring the leading ESC of a real CSI sequence.
const ESC = String.fromCharCode(27);
const ALT_SCREEN_ENTER = new RegExp(`${ESC}\\[\\?1049h`);
const ALT_SCREEN_LEAVE = new RegExp(`${ESC}\\[\\?1049l`);
// Cursor addressing (CUP) `ESC[<n>;<m>H` or `...f`, full clear `ESC[2J`,
// scroll-region `ESC[<n>;<m>r`. Presence ⇒ app is doing its own redraw.
const CURSOR_ADDRESSING = new RegExp(`${ESC}\\[(?:\\d+;\\d+[Hf]|2J|\\d+;\\d+r)`);

export interface ScreenMode {
  entersAlt: boolean;
  leavesAlt: boolean;
  cursorAddressed: boolean;
}

export function scanScreenMode(output: string): ScreenMode {
  return {
    entersAlt: ALT_SCREEN_ENTER.test(output),
    leavesAlt: ALT_SCREEN_LEAVE.test(output),
    cursorAddressed: CURSOR_ADDRESSING.test(output),
  };
}

// ── Rollback erase (internal docs C.5.6, PART F) ─────────────────────────────

// Compute the bytes that erase all currently-painted dim cells, so the
// authoritative output can repaint cleanly. Predictions are cursor-append only,
// so erase = one `\b \b` per visible char cell we predicted. Backspace
// predictions consumed a char already (they pop the queue), so only char
// predictions remain to erase.
function eraseQueue(state: PredictorState): string {
  let cells = 0;
  for (const p of state.queue) {
    if (p.kind === "char") cells += 1;
  }
  return "\b \b".repeat(cells);
}

// ── Reconciliation (internal docs C.1.3) ─────────────────────────────────────

export interface ReconcileResult {
  // The exact bytes TerminalView should `term.write(...)` for this output chunk
  // (the authoritative output, prefixed by any rollback erase).
  write: string;
  // True when a divergence forced a rollback (queue cleared, dim cells erased).
  // Feeds misprediction telemetry (P3).
  rolledBack: boolean;
}

// Reconcile a chunk of authoritative output against the prediction queue.
//
//  1. Scan for screen-mode signals. Alt-screen enter / cursor-addressing /
//     clear ⇒ authoritative repaint: drop all predictions, suspend, write raw.
//  2. Otherwise prefix-match the queue against the output bytes: each leading
//     byte equal to the next pending char prediction's `input` CONFIRMS it (pop,
//     record RTT) — the real (non-dim) echo overwrites the identical dim cell, so
//     it paints instantly and the dimness disappears with no extra write.
//  3. On the first divergence, ROLL BACK: erase the remaining dim cells and let
//     the authoritative output repaint. Predictions are dim overlays at the
//     cursor; a divergence means they're wrong, so we erase then write raw.
export function reconcile(
  output: string,
  state: PredictorState,
  now: number = Date.now(),
): ReconcileResult {
  const mode = scanScreenMode(output);

  // Alt-screen enter: a full-screen app took over. Drop predictions, mark alt.
  if (mode.entersAlt) {
    const rolledBack = state.queue.length > 0;
    const erase = eraseQueue(state);
    state.queue = [];
    state.altScreen = true;
    return { write: erase + output, rolledBack };
  }
  // Alt-screen leave: back to a cooked-mode line editor; predictions can resume
  // after the next clean line (suspendedUntilReset is cleared on the reset cycle).
  if (mode.leavesAlt) {
    state.altScreen = false;
    state.suspendedUntilReset = false;
  }
  // Cursor-addressing / clear / scroll-region while NOT alt-screen: the app is
  // redrawing. Suspend prediction, drop the queue, write raw (authoritative).
  if (mode.cursorAddressed) {
    const rolledBack = state.queue.length > 0;
    const erase = eraseQueue(state);
    state.queue = [];
    state.suspendedUntilReset = true;
    return { write: erase + output, rolledBack };
  }

  // No queue → nothing to reconcile; pass the output through untouched.
  if (state.queue.length === 0) return { write: output, rolledBack: false };

  // Prefix-walk: confirm leading bytes that match the next pending char
  // prediction. A single coalesced chunk can confirm several predictions at once.
  let i = 0;
  while (i < output.length && state.queue.length > 0) {
    const next = state.queue[0];
    if (next.kind !== "char") {
      // A backspace prediction left in the queue shouldn't normally happen
      // (enqueue pops the char it undoes), but if it does, stop matching here.
      break;
    }
    if (output[i] === next.input) {
      // Confirmed: the real echo overwrites the dim cell. Record RTT, pop.
      recordRtt(now - next.sentAt, state);
      state.queue.shift();
      i += 1;
    } else {
      // Divergence: roll back the rest of the queue and repaint authoritatively.
      const erase = eraseQueue(state);
      state.queue = [];
      return { write: erase + output, rolledBack: true };
    }
  }

  // All matched bytes were confirmations; the remaining output bytes (if any)
  // are authoritative content beyond the predictions — write them as-is. The
  // confirmed prefix is already on screen as the (now-overwritten) dim cells, so
  // we must NOT re-write it; only the unconsumed remainder is written.
  return { write: output.slice(i), rolledBack: false };
}

// ── Snapshot / lifecycle reset (internal docs C.6, C.5.7) ────────────────────

// A (re)subscribe snapshot is an AUTHORITATIVE full-screen repaint → drop all
// predictions and reset mode flags. The snapshot self-heals the screen, so any
// in-flight predictions are correctly discarded for free. Also used on exit /
// teardown so predictions never cross a session boundary. NOTE: this does NOT
// emit an erase — the snapshot repaint (term.reset + write) clears the screen
// itself, so the dim cells vanish with the reset.
export function resetPredictions(state: PredictorState): void {
  state.queue = [];
  state.altScreen = false;
  state.suspendedUntilReset = false;
}

// Full teardown reset: also clears RTT history so a new session re-measures.
export function teardownPredictor(state: PredictorState): void {
  resetPredictions(state);
  state.rttSamples = [];
  state.nextSeq = 1;
}

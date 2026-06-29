import { describe, it, expect } from "vitest";
import {
  createPredictorState,
  classifyInput,
  enqueuePrediction,
  reconcile,
  recordRtt,
  medianRtt,
  rttGateOpen,
  scanScreenMode,
  resetPredictions,
  teardownPredictor,
  type PredictorState,
} from "./terminal-predict.js";

// A predictor with the RTT gate forced open (median ≥ threshold) so input-level
// tests don't have to feed the warm-up samples each time. thresholdMs:0 = always.
function readyPredictor(): PredictorState {
  return createPredictorState({ enabled: true, thresholdMs: 0 });
}

// Helper: classify + (if predicted) enqueue, returning the dim bytes written.
function type(state: PredictorState, data: string, now = 0): string | null {
  const decision = classifyInput(data, state, now);
  if (decision.kind === "predict") return enqueuePrediction(decision.prediction, state);
  return null;
}

describe("classifyInput — what is safe to predict", () => {
  it("predicts a single printable char", () => {
    const s = readyPredictor();
    const d = classifyInput("a", s);
    expect(d.kind).toBe("predict");
    if (d.kind === "predict") {
      expect(d.render).toBe("\x1b[2ma\x1b[22m"); // dim-wrapped
      expect(d.prediction.kind).toBe("char");
      expect(d.prediction.input).toBe("a");
    }
  });

  it("passes through control bytes, arrows, Tab, Enter, paste", () => {
    const s = readyPredictor();
    expect(classifyInput("\x03", s).kind).toBe("passthrough"); // Ctrl-C
    expect(classifyInput("\x1b[A", s).kind).toBe("passthrough"); // up arrow
    expect(classifyInput("\t", s).kind).toBe("passthrough"); // Tab
    expect(classifyInput("\r", s).kind).toBe("passthrough"); // Enter
    expect(classifyInput("\n", s).kind).toBe("passthrough"); // newline
    expect(classifyInput("hello", s).kind).toBe("passthrough"); // multi-char paste
    expect(classifyInput("\x1b", s).kind).toBe("passthrough"); // bare ESC
  });

  it("passes through non-BMP / wide graphemes (v1 conservative)", () => {
    const s = readyPredictor();
    // An emoji is a surrogate pair (length 2) → not a single printable.
    expect(classifyInput("😀", s).kind).toBe("passthrough");
  });
});

// #793 regression — "reconcile must NEVER drop authoritative output". The ghost
// text predictor was disabled in TerminalView (predictionEnabled forced false)
// because, on the cloud relay, ALL pty output was routed through reconcile() and a
// short/empty `write` froze the terminal ("I type and nothing appears"). These
// tests pin the invariant the broken contract violated: with NO active predictions
// (the steady state for the overwhelming majority of output), reconcile must return
// the FULL output verbatim. When ghost text is re-enabled it must keep passing.
describe("#793 regression — reconcile must never drop authoritative output", () => {
  it("returns the full output verbatim when there are NO active predictions", () => {
    const s = readyPredictor();
    expect(s.queue.length).toBe(0);
    const output = "hello world\r\n$ ";
    const res = reconcile(output, s, 0);
    expect(res.write).toBe(output);
    expect(res.rolledBack).toBe(false);
  });

  it("passes a large/multi-line plain chunk through untouched (no predictions)", () => {
    const s = readyPredictor();
    const output = "total 24\r\ndrwxr-xr-x  3 user  staff   96 Jun 18 file.txt\r\n$ ";
    const res = reconcile(output, s, 0);
    expect(res.write).toBe(output);
    expect(res.rolledBack).toBe(false);
  });

  it("never returns a write SHORTER than the output when the queue is empty", () => {
    const s = readyPredictor();
    for (const output of ["a", "ls -la\r\n", "\x1b[32mok\x1b[0m\r\n", "x".repeat(4096)]) {
      const res = reconcile(output, s, 0);
      expect(res.write).toBe(output);
    }
  });

  it("a disabled predictor still never drops authoritative output", () => {
    // The predictor is also created disabled in TerminalView; even so, any output
    // that reached reconcile must pass through whole when nothing is queued.
    const s = createPredictorState({ enabled: false });
    const output = "authoritative\r\n";
    const res = reconcile(output, s, 0);
    expect(res.write).toBe(output);
  });
});

describe("predict → echo-match (confirm)", () => {
  it("confirms a single prediction and empties the queue", () => {
    const s = readyPredictor();
    type(s, "a", 100);
    expect(s.queue.length).toBe(1);
    const res = reconcile("a", s, 130);
    expect(s.queue.length).toBe(0);
    expect(res.rolledBack).toBe(false);
    // The confirmed byte is already on screen as the (overwritten) dim cell —
    // nothing extra to write.
    expect(res.write).toBe("");
  });

  it("records an RTT sample on confirm", () => {
    const s = readyPredictor();
    type(s, "a", 100);
    reconcile("a", s, 142);
    expect(s.rttSamples).toEqual([42]);
  });

  it("confirms a coalesced chunk (abc) against three predictions at once", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    type(s, "b", 0);
    type(s, "c", 0);
    expect(s.queue.length).toBe(3);
    const res = reconcile("abc", s, 50);
    expect(s.queue.length).toBe(0);
    expect(res.rolledBack).toBe(false);
    expect(res.write).toBe("");
  });

  it("writes only the authoritative remainder beyond the confirmed prefix", () => {
    const s = readyPredictor();
    type(s, "l", 0);
    type(s, "s", 0);
    // Shell echoes "ls" then completes the line: "ls\r\n<listing>".
    const res = reconcile("ls\r\nfile.txt\r\n", s, 10);
    expect(s.queue.length).toBe(0);
    expect(res.rolledBack).toBe(false);
    expect(res.write).toBe("\r\nfile.txt\r\n");
  });
});

describe("predict → divergence (rollback)", () => {
  it("rolls back: erases dim cells and writes authoritative output", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    const res = reconcile("x", s, 10);
    expect(res.rolledBack).toBe(true);
    expect(s.queue.length).toBe(0);
    // One predicted cell → one erase (\b \b) then the authoritative "x".
    expect(res.write).toBe("\b \bx");
  });

  it("erases all remaining cells on a mid-queue divergence", () => {
    const s = readyPredictor();
    type(s, "a", 0); // will confirm
    type(s, "b", 0); // will diverge
    type(s, "c", 0); // still queued
    // Output confirms 'a', then diverges at 'X'.
    const res = reconcile("aXc", s, 10);
    expect(res.rolledBack).toBe(true);
    expect(s.queue.length).toBe(0);
    // After confirming 'a', two char cells (b,c) remain → two erases, then "aXc"
    // is repainted from the divergence point (the whole chunk is authoritative).
    expect(res.write).toBe("\b \b\b \baXc");
  });
});

describe("alt-screen disable (internal docs C.5.1)", () => {
  it("drops the queue, sets altScreen, and suppresses prediction on ?1049h", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    const res = reconcile("\x1b[?1049h\x1b[2J", s, 10);
    expect(s.altScreen).toBe(true);
    expect(s.queue.length).toBe(0);
    expect(res.rolledBack).toBe(true);
    // Subsequent input is not predicted while in alt-screen.
    expect(classifyInput("a", s).kind).toBe("passthrough");
  });

  it("re-enables prediction on ?1049l", () => {
    const s = readyPredictor();
    reconcile("\x1b[?1049h", s, 0);
    expect(s.altScreen).toBe(true);
    reconcile("\x1b[?1049l", s, 0);
    expect(s.altScreen).toBe(false);
    expect(classifyInput("a", s).kind).toBe("predict");
  });
});

describe("cursor-addressing disable (internal docs C.5.2)", () => {
  it("suspends prediction until reset on a CUP sequence", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    const res = reconcile("\x1b[5;1Hredraw", s, 0);
    expect(s.suspendedUntilReset).toBe(true);
    expect(s.queue.length).toBe(0);
    expect(res.rolledBack).toBe(true);
    expect(classifyInput("a", s).kind).toBe("passthrough");
  });
});

describe("backspace prediction (internal docs C.1.2)", () => {
  it("predicts erasing an un-confirmed tail char and pops the queue", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    type(s, "b", 0);
    expect(s.queue.length).toBe(2);
    const rendered = type(s, "\x7f", 0); // backspace
    expect(rendered).toBe("\b \b");
    // The 'b' prediction is undone (popped); only 'a' remains pending.
    expect(s.queue.length).toBe(1);
    expect(s.queue[0].input).toBe("a");
  });

  it("passes through backspace on an empty queue", () => {
    const s = readyPredictor();
    expect(classifyInput("\x7f", s).kind).toBe("passthrough");
  });
});

describe("RTT gating (internal docs C.4 — measure-then-enable)", () => {
  it("passes through with no samples yet (threshold > 0)", () => {
    const s = createPredictorState({ enabled: true, thresholdMs: 30 });
    expect(rttGateOpen(s)).toBe(false);
    expect(classifyInput("a", s).kind).toBe("passthrough");
  });

  it("opens once the median meets the threshold", () => {
    const s = createPredictorState({ enabled: true, thresholdMs: 30 });
    recordRtt(50, s);
    recordRtt(60, s);
    recordRtt(70, s);
    expect(medianRtt(s)).toBe(60);
    expect(rttGateOpen(s)).toBe(true);
    expect(classifyInput("a", s).kind).toBe("predict");
  });

  it("stays closed when the median is below the threshold (fast link)", () => {
    const s = createPredictorState({ enabled: true, thresholdMs: 30 });
    recordRtt(2, s);
    recordRtt(3, s);
    recordRtt(4, s);
    expect(rttGateOpen(s)).toBe(false);
    expect(classifyInput("a", s).kind).toBe("passthrough");
  });

  it("threshold -1 disables, threshold 0 always predicts", () => {
    const off = createPredictorState({ enabled: true, thresholdMs: -1 });
    expect(rttGateOpen(off)).toBe(false);
    const always = createPredictorState({ enabled: true, thresholdMs: 0 });
    expect(rttGateOpen(always)).toBe(true);
  });

  it("keeps only the last 20 samples", () => {
    const s = createPredictorState({ enabled: true });
    for (let i = 0; i < 25; i++) recordRtt(i, s);
    expect(s.rttSamples.length).toBe(20);
    expect(s.rttSamples[0]).toBe(5);
  });
});

describe("master enabled flag (P0 ship-dark)", () => {
  it("never predicts when disabled", () => {
    const s = createPredictorState({ enabled: false, thresholdMs: 0 });
    expect(classifyInput("a", s).kind).toBe("passthrough");
  });
});

describe("scanScreenMode", () => {
  it("detects alt enter/leave and cursor addressing", () => {
    expect(scanScreenMode("\x1b[?1049h").entersAlt).toBe(true);
    expect(scanScreenMode("\x1b[?1049l").leavesAlt).toBe(true);
    expect(scanScreenMode("\x1b[5;10H").cursorAddressed).toBe(true);
    expect(scanScreenMode("\x1b[2J").cursorAddressed).toBe(true);
    expect(scanScreenMode("plain text").cursorAddressed).toBe(false);
  });
});

describe("snapshot / lifecycle reset (internal docs C.6)", () => {
  it("resetPredictions clears the queue and mode flags but keeps RTT", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    s.altScreen = true;
    s.suspendedUntilReset = true;
    recordRtt(40, s);
    resetPredictions(s);
    expect(s.queue.length).toBe(0);
    expect(s.altScreen).toBe(false);
    expect(s.suspendedUntilReset).toBe(false);
    expect(s.rttSamples).toEqual([40]); // RTT history survives a snapshot
  });

  it("teardownPredictor also clears RTT history", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    recordRtt(40, s);
    teardownPredictor(s);
    expect(s.queue.length).toBe(0);
    expect(s.rttSamples).toEqual([]);
    expect(s.nextSeq).toBe(1);
  });
});

// ── Latency-simulated integration: a typed line under high RTT ──────────────
describe("integration — latency-simulated typing + reconcile", () => {
  it("ghosts chars immediately under high RTT, then confirms on the delayed echo", () => {
    const s = createPredictorState({ enabled: true, thresholdMs: 30 });
    // Warm up the RTT estimate above threshold (simulated slow link).
    recordRtt(80, s);
    recordRtt(90, s);
    recordRtt(85, s);
    expect(rttGateOpen(s)).toBe(true);

    // User types "ls" at t=0,5 — both ghosted immediately (before any echo).
    const writes: string[] = [];
    let w = type(s, "l", 0);
    if (w) writes.push(w);
    w = type(s, "s", 5);
    if (w) writes.push(w);
    expect(writes).toEqual(["\x1b[2ml\x1b[22m", "\x1b[2ms\x1b[22m"]);
    expect(s.queue.length).toBe(2);

    // The coalesced echo arrives ~85ms later as one chunk → both confirmed.
    const res = reconcile("ls", s, 90);
    expect(res.rolledBack).toBe(false);
    expect(s.queue.length).toBe(0);
    // RTT samples recorded for both confirmations (90-0, 90-5).
    expect(s.rttSamples).toContain(90);
    expect(s.rttSamples).toContain(85);
  });

  it("a mispredicted line rolls back with no stuck ghost", () => {
    const s = createPredictorState({ enabled: true, thresholdMs: 0 });
    // User optimistically types "cd" but the shell echoes a corrected "ls"
    // (e.g. a remapped key / different content) → divergence at position 0.
    type(s, "c", 0);
    type(s, "d", 0);
    expect(s.queue.length).toBe(2);
    const res = reconcile("ls", s, 10);
    expect(res.rolledBack).toBe(true);
    expect(s.queue.length).toBe(0);
    // Two predicted cells erased, then the authoritative "ls" repaints — no ghost.
    expect(res.write).toBe("\b \b\b \bls");
  });

  it("a re-subscribe snapshot drops in-flight predictions (self-heal)", () => {
    const s = readyPredictor();
    type(s, "a", 0);
    type(s, "b", 0);
    expect(s.queue.length).toBe(2);
    // TerminalView calls resetPredictions on every snapshot before term.reset().
    resetPredictions(s);
    expect(s.queue.length).toBe(0);
  });
});

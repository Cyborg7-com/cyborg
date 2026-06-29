// Ordered first-viable failover walk — the de-triplicated core of the watcher
// chains.
//
// The tasks epic grew three near-identical loops that each "try candidates in a
// FIXED order, STOP on the first success, ADVANCE on a skip or a failure":
//   • runWatcherFailover (message-router.ts) — daemon-LOCAL: spawn the first chain
//     cybo this daemon can run, route the prompt, stop.
//   • forwardWatchToChain (cybo-mention-invoke.ts) — relay: forward to the first
//     chain cybo whose owning daemon is online + capability-matched, stop.
// (The third was the per-mention invoke fan-in that these two grew out of.)
//
// Each copy reimplemented the same index walk, the same "skip vs fail vs stop"
// branching, and the same advance-logging. This module extracts that control
// flow ONCE so the two loops keep their distinct I/O (spawn vs forward, their own
// telemetry) but share the walk.
//
// NOT a Markov chain. There are NO probabilities, NO transition matrix, NO random
// state. It is a DETERMINISTIC ordered fallback: candidate[0], then [1], … until
// one succeeds. "Chain" here means the channel's ordered cybo fallback chain.
//
// PURE by contract: this file has ZERO dependencies and ZERO I/O. It never
// imports daemon-side code (no spawnCybo, no AgentManager, no storage). All
// effects — spawning, forwarding, logging, telemetry — live in the caller's
// `attempt` and `onAdvance` callbacks. That purity is what lets the relay-light
// cybo-mention-invoke.ts use it without dragging daemon deps into the EC2 bundle.

// The result of attempting one candidate:
//   • success — this candidate handled it; the walk STOPS and returns `result`.
//   • skip    — this candidate isn't viable right now (e.g. not in this daemon's
//               roster, no online daemon for it); ADVANCE, no failure recorded.
//   • fail    — the attempt was made and failed (e.g. spawn threw, forward was
//               rejected); ADVANCE. `reason` is free-form for the caller's logs.
// `skip` and `fail` both advance — they differ only so the caller can log/telemeter
// a real failure while staying silent on a benign skip (the original loops do
// exactly this: a `continue` on non-viability emitted nothing, whereas a caught
// spawn error / a `false` forward emitted a task_event).
export type ChainStep<R> =
  | { outcome: "success"; result: R }
  | { outcome: "skip"; reason?: string }
  | { outcome: "fail"; reason?: string };

/**
 * Walk `candidates` in order, invoking `attempt` on each. Return the FIRST
 * success — its `result`, the `candidate`, and its `index` — and stop (later
 * candidates are NEVER attempted). On a `skip` or `fail`, invoke `onAdvance`
 * (for the caller's logging/telemetry) and move to the next candidate. If no
 * candidate succeeds (all skipped/failed, or the list is empty), return `null`.
 *
 * Pure: no I/O and no daemon dependencies. Every side effect is the caller's,
 * carried by `attempt` (which performs the work) and `onAdvance` (which observes
 * the advance). `attempt`s run strictly sequentially, in index order — the next
 * is awaited only after the previous resolved, so a success short-circuits the
 * remainder.
 *
 * @param candidates  The ordered fallback list (e.g. a channel's cybo chain).
 * @param attempt     Try one candidate; resolve to its {@link ChainStep}.
 * @param onAdvance   Optional; called once per non-success step (skip OR fail),
 *                    with the candidate, its index, and the step, BEFORE advancing.
 */
export async function runFallbackChain<C, R>(
  candidates: readonly C[],
  attempt: (candidate: C, index: number) => Promise<ChainStep<R>>,
  onAdvance?: (candidate: C, index: number, step: ChainStep<R>) => void,
): Promise<{ result: R; candidate: C; index: number } | null> {
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const step = await attempt(candidate, index);
    if (step.outcome === "success") {
      return { result: step.result, candidate, index };
    }
    onAdvance?.(candidate, index, step);
  }
  return null;
}

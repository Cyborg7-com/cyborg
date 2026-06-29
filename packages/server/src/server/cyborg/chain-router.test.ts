import { describe, it, expect } from "vitest";
import { runFallbackChain, type ChainStep } from "./chain-router.js";

describe("runFallbackChain", () => {
  it("returns the first success and stops (later candidates are NOT attempted)", async () => {
    const attempted: string[] = [];
    const result = await runFallbackChain<string, string>(["a", "b", "c"], async (c) => {
      attempted.push(c);
      if (c === "b") return { outcome: "success", result: `handled-${c}` };
      return { outcome: "fail" };
    });
    expect(result).toEqual({ result: "handled-b", candidate: "b", index: 1 });
    // "c" must never be attempted once "b" succeeds.
    expect(attempted).toEqual(["a", "b"]);
  });

  it("advances through skips to a later success", async () => {
    const attempted: string[] = [];
    const result = await runFallbackChain<string, number>(["x", "y", "z"], async (c, i) => {
      attempted.push(c);
      if (i < 2) return { outcome: "skip" };
      return { outcome: "success", result: i };
    });
    expect(result).toEqual({ result: 2, candidate: "z", index: 2 });
    expect(attempted).toEqual(["x", "y", "z"]);
  });

  it("returns null when every candidate skips", async () => {
    const result = await runFallbackChain<string, string>(["a", "b"], async () => ({
      outcome: "skip",
    }));
    expect(result).toBeNull();
  });

  it("returns null when every candidate fails", async () => {
    const result = await runFallbackChain<string, string>(["a", "b"], async () => ({
      outcome: "fail",
    }));
    expect(result).toBeNull();
  });

  it("returns null for an empty candidate list (attempt never invoked)", async () => {
    let calls = 0;
    const result = await runFallbackChain<string, string>([], async () => {
      calls++;
      return { outcome: "success", result: "nope" };
    });
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it("walks candidates in order, passing the correct index", async () => {
    const order: Array<{ candidate: string; index: number }> = [];
    await runFallbackChain<string, string>(["p", "q", "r"], async (c, i) => {
      order.push({ candidate: c, index: i });
      return { outcome: "skip" };
    });
    expect(order).toEqual([
      { candidate: "p", index: 0 },
      { candidate: "q", index: 1 },
      { candidate: "r", index: 2 },
    ]);
  });

  it("invokes onAdvance once per non-success step (skip OR fail), never for the success", async () => {
    const advances: Array<{ candidate: string; index: number; step: ChainStep<string> }> = [];
    const result = await runFallbackChain<string, string>(
      ["a", "b", "c", "d"],
      async (c) => {
        if (c === "a") return { outcome: "skip", reason: "not-viable" };
        if (c === "b") return { outcome: "fail", reason: "boom" };
        if (c === "c") return { outcome: "success", result: "ok" };
        return { outcome: "skip" }; // "d" — never reached (c succeeds first)
      },
      (candidate, index, step) => advances.push({ candidate, index, step }),
    );
    expect(result).toEqual({ result: "ok", candidate: "c", index: 2 });
    // onAdvance fired for the skip ("a") and the fail ("b"), but NOT for the
    // success ("c"), and "d" was never attempted so never advanced.
    expect(advances).toEqual([
      { candidate: "a", index: 0, step: { outcome: "skip", reason: "not-viable" } },
      { candidate: "b", index: 1, step: { outcome: "fail", reason: "boom" } },
    ]);
  });

  it("invokes onAdvance for every candidate when all advance (no success)", async () => {
    const advances: number[] = [];
    const result = await runFallbackChain<string, string>(
      ["a", "b", "c"],
      async (_c, i) => (i % 2 === 0 ? { outcome: "skip" } : { outcome: "fail" }),
      (_c, index) => advances.push(index),
    );
    expect(result).toBeNull();
    expect(advances).toEqual([0, 1, 2]);
  });

  it("works without an onAdvance callback", async () => {
    const result = await runFallbackChain<string, string>(["a", "b"], async (c) =>
      c === "b" ? { outcome: "success", result: "done" } : { outcome: "skip" },
    );
    expect(result).toEqual({ result: "done", candidate: "b", index: 1 });
  });
});

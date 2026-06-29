import { describe, it, expect } from "vitest";
import {
  buildContextWindowView,
  formatTokens,
  formatCost,
  contextWindowTooltip,
} from "./context-window.js";

// #580: the agent context-window meter must show tokens used + % of context +
// estimated cost, fed by AgentUsage from the stream, and DEGRADE GRACEFULLY when
// a provider reports only a subset (backend-agnostic). These pure helpers carry
// that logic so it's testable without a Svelte runtime.

describe("buildContextWindowView", () => {
  it("returns null when there's nothing to show", () => {
    expect(buildContextWindowView(null)).toBeNull();
    expect(buildContextWindowView(undefined)).toBeNull();
    expect(buildContextWindowView({})).toBeNull();
    // cachedInputTokens alone isn't a displayable signal.
    expect(buildContextWindowView({ cachedInputTokens: 10 })).toBeNull();
  });

  it("computes % + used/max when the provider reports a context window", () => {
    const v = buildContextWindowView({
      contextWindowUsedTokens: 84_000,
      contextWindowMaxTokens: 200_000,
      totalCostUsd: 0.0123,
    });
    expect(v).toEqual({
      pct: 42,
      usedTokens: 84_000,
      maxTokens: 200_000,
      costUsd: 0.0123,
      level: "ok",
    });
  });

  it("clamps % at 100 and flags pressure levels (ok <75, high ≥75, critical ≥90)", () => {
    expect(
      buildContextWindowView({ contextWindowUsedTokens: 250_000, contextWindowMaxTokens: 200_000 })
        ?.pct,
    ).toBe(100);
    expect(
      buildContextWindowView({ contextWindowUsedTokens: 100_000, contextWindowMaxTokens: 200_000 })
        ?.level,
    ).toBe("ok"); // 50%
    expect(
      buildContextWindowView({ contextWindowUsedTokens: 150_000, contextWindowMaxTokens: 200_000 })
        ?.level,
    ).toBe("high"); // 75%
    expect(
      buildContextWindowView({ contextWindowUsedTokens: 180_000, contextWindowMaxTokens: 200_000 })
        ?.level,
    ).toBe("critical"); // 90%
    expect(
      buildContextWindowView({ contextWindowUsedTokens: 250_000, contextWindowMaxTokens: 200_000 })
        ?.level,
    ).toBe("critical"); // clamped 100%
  });

  it("degrades to a token count (no %) when there's no max — uses in+out", () => {
    const v = buildContextWindowView({ inputTokens: 1200, outputTokens: 800 });
    expect(v).toMatchObject({ pct: null, usedTokens: 2000, maxTokens: null, level: "ok" });
  });

  it("degrades to cost-only when no token signal", () => {
    const v = buildContextWindowView({ totalCostUsd: 0.5 });
    expect(v).toMatchObject({ pct: null, usedTokens: null, maxTokens: null, costUsd: 0.5 });
  });

  it("ignores a zero/invalid max (no divide-by-zero)", () => {
    const v = buildContextWindowView({ contextWindowUsedTokens: 100, contextWindowMaxTokens: 0 });
    expect(v).toMatchObject({ pct: null, usedTokens: 100, maxTokens: null });
  });

  it("guards against NaN fields (typeof number) — never emits NaN", () => {
    // NaN max → no %; NaN used falls through to in+out; NaN cost → null.
    const v = buildContextWindowView({
      contextWindowUsedTokens: Number.NaN,
      contextWindowMaxTokens: Number.NaN,
      inputTokens: 1000,
      outputTokens: 500,
      totalCostUsd: Number.NaN,
    });
    expect(v).toMatchObject({ pct: null, usedTokens: 1500, maxTokens: null, costUsd: null });
    // All-NaN with no other signal → null (nothing to show).
    expect(
      buildContextWindowView({ inputTokens: Number.NaN, totalCostUsd: Number.NaN }),
    ).toBeNull();
  });
});

describe("formatTokens", () => {
  it("formats with k/M and trims decimals", () => {
    expect(formatTokens(920)).toBe("920");
    expect(formatTokens(84_000)).toBe("84k");
    expect(formatTokens(84_500)).toBe("84.5k"); // <100k keeps 1 decimal when not whole
    expect(formatTokens(99_950)).toBe("100k"); // rounds up cleanly, no ".0"
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(999_500)).toBe("1.0M"); // transitions to M, not "1000k"
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});

describe("formatCost", () => {
  it("keeps precision for small spends, 2 decimals for larger", () => {
    expect(formatCost(0.0123)).toBe("$0.012");
    expect(formatCost(0.5)).toBe("$0.500");
    expect(formatCost(1.5)).toBe("$1.50");
    expect(formatCost(12.345)).toBe("$12.35");
  });
});

describe("contextWindowTooltip", () => {
  it("lists only the parts the provider reported", () => {
    const usage = {
      contextWindowUsedTokens: 84_000,
      contextWindowMaxTokens: 200_000,
      inputTokens: 80_000,
      outputTokens: 4_000,
      totalCostUsd: 0.0123,
    };
    const view = buildContextWindowView(usage)!;
    const t = contextWindowTooltip(usage, view);
    expect(t).toContain("Context: 84k / 200k tokens (42%)");
    expect(t).toContain("In 80k · Out 4k");
    expect(t).toContain("Cost: $0.012");
  });
});

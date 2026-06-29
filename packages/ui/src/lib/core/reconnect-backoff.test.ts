import { describe, it, expect } from "vitest";
import { reconnectBackoffMs } from "./client.js";

// #504: the reconnect backoff must carry FULL JITTER so a mass-disconnect (every
// client dropping on the same relay deploy) no longer retries in a synchronized
// thundering herd. These tests pin the capped-exponential ENVELOPE and that the
// jitter spreads the actual delay uniformly across [0, envelope].

const envelope = (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000);

describe("reconnectBackoffMs", () => {
  it("grows the envelope exponentially (rand=1 → top of window)", () => {
    const top = () => 1;
    expect(reconnectBackoffMs(0, top)).toBe(1000);
    expect(reconnectBackoffMs(1, top)).toBe(2000);
    expect(reconnectBackoffMs(2, top)).toBe(4000);
    expect(reconnectBackoffMs(3, top)).toBe(8000);
  });

  it("caps the envelope at 30s", () => {
    const top = () => 1;
    // 2**5 * 1000 = 32_000 > cap → clamped.
    expect(reconnectBackoffMs(5, top)).toBe(30_000);
    expect(reconnectBackoffMs(50, top)).toBe(30_000);
  });

  it("applies jitter: rand=0 → 0, rand=0.5 → half the envelope", () => {
    expect(reconnectBackoffMs(3, () => 0)).toBe(0);
    expect(reconnectBackoffMs(3, () => 0.5)).toBe(envelope(3) / 2);
    expect(reconnectBackoffMs(10, () => 0.5)).toBe(envelope(10) / 2); // capped→15_000
  });

  it("always stays within [0, envelope] for any rand in [0,1)", () => {
    for (let attempt = 0; attempt <= 8; attempt++) {
      const cap = envelope(attempt);
      for (const r of [0, 0.1, 0.37, 0.5, 0.99]) {
        const d = reconnectBackoffMs(attempt, () => r);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("de-synchronizes the herd: N clients at the same attempt do NOT collide on one delay", () => {
    // Real Math.random per "client". With full jitter over a wide envelope the
    // delays must spread out — a deterministic backoff would yield a single value.
    const attempt = 4; // envelope 16_000ms — wide enough to spread
    const delays = Array.from({ length: 200 }, () => reconnectBackoffMs(attempt));
    const distinct = new Set(delays);
    // Deterministic backoff → distinct.size === 1. Jittered → many buckets.
    expect(distinct.size).toBeGreaterThan(100);
    // No more than a tiny fraction lands in the first 100ms (instant-retry burst).
    const earlyBurst = delays.filter((d) => d < 100).length;
    expect(earlyBurst).toBeLessThan(delays.length * 0.1);
  });
});

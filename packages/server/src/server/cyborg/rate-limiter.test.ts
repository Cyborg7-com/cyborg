import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

describe("RateLimiter", () => {
  it("allows up to the limit, then blocks with a retry hint", () => {
    const rl = new RateLimiter();
    // message: 60 / 60s
    for (let i = 0; i < 60; i++) {
      expect(rl.check("u1", "message").allowed).toBe(true);
    }
    const over = rl.check("u1", "message");
    expect(over.allowed).toBe(false);
    expect(over.retryAfterMs).toBeGreaterThan(0);
  });

  it("treats an unknown action as unlimited", () => {
    const rl = new RateLimiter();
    expect(rl.check("u1", "does-not-exist").allowed).toBe(true);
    expect(rl.size()).toBe(0); // no bucket created for an unlimited action
  });

  it("sweep() evicts buckets whose timestamps have all expired (leak fix)", () => {
    const rl = new RateLimiter();
    rl.check("a", "message");
    rl.check("b", "message");
    rl.check("c", "agent_spawn");
    expect(rl.size()).toBe(3);

    // Sweep far enough in the future that every window (max 1h) has elapsed.
    rl.sweep(Date.now() + 2 * 3_600_000);
    expect(rl.size()).toBe(0);
  });

  it("sweep() keeps buckets that still have live timestamps", () => {
    const rl = new RateLimiter();
    rl.check("a", "message");
    rl.sweep(Date.now()); // nothing expired yet
    expect(rl.size()).toBe(1);
  });

  it("reset() drops a single bucket", () => {
    const rl = new RateLimiter();
    rl.check("a", "message");
    rl.check("b", "message");
    rl.reset("a", "message");
    expect(rl.size()).toBe(1);
  });

  // Lock in the provider_recheck budget: "Re-check providers" runs the FULL
  // provider probe suite per call, so the 7th call inside a minute must block.
  it("provider_recheck allows 6/min then blocks with a retry hint", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 6; i++) {
      expect(rl.check("user:ws", "provider_recheck").allowed).toBe(true);
    }
    const denied = rl.check("user:ws", "provider_recheck");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    // Other keys (another user/workspace) are unaffected.
    expect(rl.check("other:ws", "provider_recheck").allowed).toBe(true);
  });
});

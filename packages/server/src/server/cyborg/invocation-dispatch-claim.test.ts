import { describe, expect, it } from "vitest";
import { mentionClaimKey, watchClaimKey } from "./cybo-mention-invoke.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgStorage } from "./storage.js";

// #16 — the @mention / channel-watch paths get a cross-daemon exactly-once claim,
// mirroring the cron claimScheduleDispatch. These prove the primitive that stops
// "cybo sessions keep multiplying": a given invocation key wins AT MOST ONCE.
describe("claimInvocationDispatch (mention/watch exactly-once)", () => {
  it("SQLite: a claim_key can be won exactly once", () => {
    const storage = new CyborgStorage(":memory:");
    const key = mentionClaimKey("msg-1", "cybo_apex");

    expect(storage.claimInvocationDispatch(key, "daemon-A")).toBe(true); // winner
    expect(storage.claimInvocationDispatch(key, "daemon-B")).toBe(false); // loser skips
    expect(storage.claimInvocationDispatch(key, "daemon-A")).toBe(false); // even the winner, again
  });

  it("SQLite: distinct keys (other cybo, other message, watch namespace) each win once", () => {
    const storage = new CyborgStorage(":memory:");

    // Same message, different cybo → independent claims (both invoke).
    expect(storage.claimInvocationDispatch(mentionClaimKey("msg-1", "cybo_apex"))).toBe(true);
    expect(storage.claimInvocationDispatch(mentionClaimKey("msg-1", "cybo_seb"))).toBe(true);
    // Different message → new claim.
    expect(storage.claimInvocationDispatch(mentionClaimKey("msg-2", "cybo_apex"))).toBe(true);
    // Watch namespace is disjoint from mention keys: a message that is BOTH mentioned
    // and watched fires once per path, not deduped against each other.
    expect(storage.claimInvocationDispatch(watchClaimKey("msg-1"))).toBe(true);
    expect(storage.claimInvocationDispatch(watchClaimKey("msg-1"))).toBe(false);
  });

  it("DualStorage solo mode (no PG) also dedupes via the SQLite claim", async () => {
    const storage = new DualStorage(new CyborgStorage(":memory:"), null);
    const key = watchClaimKey("msg-42");

    await expect(storage.claimInvocationDispatch(key, "srv-1")).resolves.toBe(true);
    await expect(storage.claimInvocationDispatch(key, "srv-1")).resolves.toBe(false);
  });
});

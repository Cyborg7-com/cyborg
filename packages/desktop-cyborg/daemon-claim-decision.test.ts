import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDaemonClaim } from "./daemon-claim-decision.js";

const ME = "a4e9d6d4-cb8d-4697-b208-c00335027b11";
const OTHER = "c08f5eff-0d65-4a63-b55f-d61f07432745";
const CYBORG = "wss://relay.cyborg7.com/relay";
const CYBORG2 = "wss://relay-staging.cyborg7.com/relay";
const PASEO = "wss://relay.paseo.sh/relay";

test("fresh device (no prior claim) → reclaim, not a heal", () => {
  assert.deepEqual(decideDaemonClaim("", "", ME, CYBORG), { action: "reclaim", healed: false });
});

test("already bound to me on this relay → noop", () => {
  assert.deepEqual(decideDaemonClaim(ME, CYBORG, ME, CYBORG), { action: "noop" });
});

test("mine but relay changed (e.g. relay migration) → reclaim, not a heal", () => {
  assert.deepEqual(decideDaemonClaim(ME, CYBORG2, ME, CYBORG), { action: "reclaim", healed: false });
});

// The real-world bug this fixes: a stale/foreign owner + NO relay url (an old
// Paseo / pre-migration claim) used to make the app silently bail.
test("POISONED: foreign owner + no relay url → AUTO-HEAL (reclaim, healed)", () => {
  assert.deepEqual(decideDaemonClaim(OTHER, "", ME, CYBORG), { action: "reclaim", healed: true });
});

test("foreign owner pointed at a DIFFERENT (paseo) relay → auto-heal", () => {
  assert.deepEqual(decideDaemonClaim(OTHER, PASEO, ME, CYBORG), { action: "reclaim", healed: true });
});

// The ONE case we must NOT steal: another user actively running this device's
// daemon on the SAME Cyborg relay (legit shared machine) → defer.
test("foreign owner actively on the SAME cyborg relay → defer (don't steal)", () => {
  const d = decideDaemonClaim(OTHER, CYBORG, ME, CYBORG);
  assert.equal(d.action, "defer");
});

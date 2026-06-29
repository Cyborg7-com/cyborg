// REAL-machine artifact test for the cybo runtime capability profile
// (internal docs auth-UX item 3). No mocks: builds a real ProviderSnapshotManager,
// really probes THIS host's cybo runtime (launch + RPC session + model list — the
// same path isAvailable() takes) and prints the profile a daemon on this build
// would publish in its meta. Behind the *.local.e2e.test.ts suffix
// (test:integration:local) because it spawns the host runtime and needs it
// installed.
//
// On the reference machine for this feature (runtime 0.78.1 installed,
// ~/.pi/agent/auth.json = {}): the profile MUST come out configured:false —
// the exact input that renders "⚠ needs setup on <daemon> [Set up →]" in the
// wizard instead of an unconditional "available".
import { describe, it, expect } from "vitest";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { buildCyboRuntimeProfile } from "./cybo-runtime-profile.js";

const noop = (): void => {};
const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => logger,
} as never;

describe("cybo runtime profile — REAL probe on this host", () => {
  it("publishes the honest configured dimension for this machine", async () => {
    const manager = new ProviderSnapshotManager({ logger });
    // Settle the real snapshot (launches the runtime; bounded by the manager's
    // own refresh timeout).
    await manager.listProviders({ wait: true, providers: ["pi"] });
    const profile = await buildCyboRuntimeProfile(manager);

    // eslint-disable-next-line no-console
    console.log("[artifact] cyboRuntime profile for this host:", JSON.stringify(profile));

    // The runtime is installed on this host, so the snapshot MUST settle to a
    // publishable profile (null would mean "no pi entry", i.e. not installed).
    expect(profile).not.toBeNull();
    const p = profile!;
    // Coherence, whatever the host's auth state: configured ⟺ ≥1 model, and
    // the per-backend counts can never exceed the total.
    expect(p.configured).toBe(p.modelCount > 0);
    const backendSum = p.backends.reduce((acc, b) => acc + b.modelCount, 0);
    expect(backendSum).toBeLessThanOrEqual(p.modelCount);
    for (const b of p.backends) {
      expect(b.backend).not.toContain("/");
      expect(b.modelCount).toBeGreaterThan(0);
    }
  }, 60_000);
});

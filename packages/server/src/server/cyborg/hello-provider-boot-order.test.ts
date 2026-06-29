// FIX-2 startup race (internal docs #3): the FIRST daemon_hello must not advertise
// a SIGNED-OUT native harness. Boot warms the provider snapshot before connect()
// but the logged-out-native probe used to be fire-and-forget (`void …then`), so at
// the moment connect() fires the first hello, loggedOutNativeProviders is still the
// empty boot set → honestHelloProviders filters nothing → a signed-out claude/codex
// daemon advertises it as available.
//
// This reproduces bootstrap's getter (setProvidersFn reads honestHelloProviders
// over a mutable loggedOutNativeProviders set populated by refreshLoggedOutNative)
// and proves the fix: the FIRST read after AWAITing the refresh is honest, whereas
// reading before awaiting (the old race) leaks.
import { describe, it, expect, afterEach } from "vitest";
import { vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const probeState: Record<string, "logged_in" | "logged_out"> = {
  claude: "logged_out",
  codex: "logged_in",
};
vi.mock("./native-harness-login.js", async (importActual) => {
  const actual = await importActual<typeof import("./native-harness-login.js")>();
  return {
    ...actual,
    probeNativeHarnessLogin: async (provider: string) =>
      probeState[provider] === "logged_out"
        ? { state: "logged_out", reason: "signed out" }
        : { state: "logged_in" },
  };
});

import { computeLoggedOutNativeProviders, honestHelloProviders } from "./hello-provider-list.js";

afterEach(() => {
  probeState.claude = "logged_out";
  probeState.codex = "logged_in";
});

// Models the bootstrap boot path: the providers getter reads a mutable set that a
// refresh fills asynchronously. The caller chooses whether to AWAIT refresh()
// before reading providersFn() (the fix) or read after a fire-and-forget (the race).
function bootProvidersGetter(opts: { ready: string[] }) {
  let loggedOutNative = new Set<string>(); // starts empty at boot
  const refresh = (): Promise<void> =>
    computeLoggedOutNativeProviders(opts.ready).then((set) => {
      loggedOutNative = set;
      return undefined;
    });
  const providersFn = () => honestHelloProviders(opts.ready, loggedOutNative);
  return { refresh, providersFn };
}

describe("first daemon_hello is honest about native login (internal docs #3)", () => {
  it("the OLD race (no await before first hello) leaks a signed-out native provider", () => {
    const boot = bootProvidersGetter({ ready: ["claude", "pi"] });
    // Fire-and-forget — first hello reads the still-empty set.
    void boot.refresh();
    expect(boot.providersFn()).toContain("claude"); // BUG: signed-out claude advertised
  });

  it("the FIX (await the probe before the first hello) drops the signed-out native provider", async () => {
    const boot = bootProvidersGetter({ ready: ["claude", "pi"] });
    await boot.refresh();
    const firstHello = boot.providersFn();
    expect(firstHello).not.toContain("claude"); // signed out → not advertised
    expect(firstHello).toEqual(["pi"]);
  });

  it("a SIGNED-IN native provider is still advertised in the first hello after the await", async () => {
    probeState.claude = "logged_in";
    const boot = bootProvidersGetter({ ready: ["claude", "codex", "pi"] });
    await boot.refresh();
    expect(boot.providersFn()).toEqual(["claude", "codex", "pi"]);
  });

  // Anti-recurrence guard: the real boot path must AWAIT the logged-out-native
  // probe before connect()/the first hello. If someone reverts it to fire-and-
  // forget (`void refreshLoggedOutNativeProviders()` before connect), the race
  // returns. Source-scan: `await refreshLoggedOutNativeProviders()` must appear
  // BEFORE `cyborgRelayClient.connect()`.
  it("bootstrap awaits the logged-out-native probe BEFORE connect (source guard)", () => {
    const bootstrap = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "bootstrap.ts"),
      "utf-8",
    );
    const awaitIdx = bootstrap.indexOf("await refreshLoggedOutNativeProviders()");
    const connectIdx = bootstrap.indexOf("cyborgRelayClient.connect()");
    expect(awaitIdx).toBeGreaterThan(-1);
    expect(connectIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeLessThan(connectIdx);
  });
});

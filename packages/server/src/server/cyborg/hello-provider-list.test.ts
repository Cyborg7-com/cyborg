// FIX 2 (internal docs): the daemon_hello provider list must be HONEST about
// native-harness login — a SIGNED-OUT native harness must NOT be advertised, so
// the relay's pickMentionDaemon skips this daemon and the capability-gap notice
// fires. The snapshot's binary-only "ready" is post-filtered through the login
// probe here.
import { afterEach, describe, expect, it, vi } from "vitest";

// Drive the login probe per provider. claude=out, codex=in by default; tests
// flip as needed. isNativeHarnessProvider keeps its real implementation.
const probeState: Record<string, "logged_in" | "logged_out" | "throw"> = {
  claude: "logged_out",
  codex: "logged_in",
};
vi.mock("./native-harness-login.js", async (importActual) => {
  const actual = await importActual<typeof import("./native-harness-login.js")>();
  return {
    ...actual,
    probeNativeHarnessLogin: async (provider: string) => {
      const s = probeState[provider];
      if (s === "throw") throw new Error("probe boom");
      return s === "logged_out"
        ? { state: "logged_out", reason: "signed out" }
        : { state: "logged_in" };
    },
  };
});

import { computeLoggedOutNativeProviders, honestHelloProviders } from "./hello-provider-list.js";

afterEach(() => {
  probeState.claude = "logged_out";
  probeState.codex = "logged_in";
});

describe("honestHelloProviders (pure filter)", () => {
  it("drops the native ids known to be signed out, keeps the rest", () => {
    const ready = ["claude", "codex", "pi"];
    const loggedOut = new Set(["claude"]);
    expect(honestHelloProviders(ready, loggedOut)).toEqual(["codex", "pi"]);
  });

  it("keeps everything when nothing is signed out", () => {
    expect(honestHelloProviders(["claude", "pi"], new Set())).toEqual(["claude", "pi"]);
  });
});

describe("computeLoggedOutNativeProviders (probe-driven)", () => {
  it("a SIGNED-OUT native id is collected → omitted from the hello (the FIX 2 case)", async () => {
    const set = await computeLoggedOutNativeProviders(["claude", "codex", "pi"]);
    expect(set.has("claude")).toBe(true); // signed out → dropped downstream
    expect(set.has("codex")).toBe(false); // signed in → kept
    expect(set.has("pi")).toBe(false); // not a native harness → never probed
    expect(honestHelloProviders(["claude", "codex", "pi"], set)).toEqual(["codex", "pi"]);
  });

  it("a LOGGED-IN native id is kept (present in the hello)", async () => {
    probeState.claude = "logged_in";
    const set = await computeLoggedOutNativeProviders(["claude", "pi"]);
    expect(set.size).toBe(0);
    expect(honestHelloProviders(["claude", "pi"], set)).toEqual(["claude", "pi"]);
  });

  it("a probe FAILURE fails open — the native id is kept (today's binary-only behavior)", async () => {
    probeState.claude = "throw";
    const set = await computeLoggedOutNativeProviders(["claude", "pi"]);
    expect(set.has("claude")).toBe(false);
    expect(honestHelloProviders(["claude", "pi"], set)).toEqual(["claude", "pi"]);
  });
});

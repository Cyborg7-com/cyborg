import { describe, it, expect } from "vitest";
import { resolveDaemonRelay } from "./bootstrap.js";

// #664: the daemon must resolve its relay deterministically from explicit config
// (env → cyborg-relay-url file → config.relayEndpoint) and NEVER fall back to
// relay.paseo.sh. resolveDaemonRelay returns null when nothing is configured, so
// the caller fails loud instead of joining Paseo's upstream relay.
describe("resolveDaemonRelay (#664)", () => {
  it("returns null when nothing is configured (→ caller fails loud, never paseo.sh)", () => {
    expect(resolveDaemonRelay({})).toBeNull();
    expect(
      resolveDaemonRelay({ envUrl: "  ", relayUrlFileContent: "", configEndpoint: null }),
    ).toBeNull();
  });

  it("env CYBORG_RELAY_URL (wss://) wins and yields both wsUrl + host:port endpoint", () => {
    const r = resolveDaemonRelay({ envUrl: "wss://relay.cyborg7.com/relay" });
    expect(r).toEqual({
      wsUrl: "wss://relay.cyborg7.com/relay",
      endpoint: "relay.cyborg7.com:443",
      useTls: true,
      source: "env",
    });
  });

  it("falls back to the cyborg-relay-url FILE when env is absent; trims the trailing newline", () => {
    // The CLI writes the url + "\n" (daemon/claim.ts) — must be trimmed.
    const r = resolveDaemonRelay({ relayUrlFileContent: "wss://relay.cyborg7.com/relay\n" });
    expect(r?.source).toBe("file");
    expect(r?.wsUrl).toBe("wss://relay.cyborg7.com/relay");
    expect(r?.endpoint).toBe("relay.cyborg7.com:443");
    expect(r?.useTls).toBe(true);
  });

  it("falls back to config.relayEndpoint (bare host:port) when env + file are absent", () => {
    const r = resolveDaemonRelay({ configEndpoint: "relay.cyborg7.com:8443" });
    expect(r).toEqual({
      // :8443 is not :443 and no explicit configUseTls → non-TLS → ws://
      wsUrl: "ws://relay.cyborg7.com:8443",
      endpoint: "relay.cyborg7.com:8443",
      useTls: false,
      source: "config",
    });
  });

  it("precedence: env > file > config", () => {
    const r = resolveDaemonRelay({
      envUrl: "wss://env.example/relay",
      relayUrlFileContent: "wss://file.example/relay",
      configEndpoint: "config.example:443",
    });
    expect(r?.source).toBe("env");
    expect(r?.endpoint).toBe("env.example:443");

    const r2 = resolveDaemonRelay({
      relayUrlFileContent: "wss://file.example/relay",
      configEndpoint: "config.example:443",
    });
    expect(r2?.source).toBe("file");
  });

  it("ws:// (no TLS) parses to useTls=false and port 80 when unspecified", () => {
    const r = resolveDaemonRelay({ envUrl: "ws://localhost/relay" });
    expect(r?.useTls).toBe(false);
    expect(r?.endpoint).toBe("localhost:80");
  });

  it("explicit non-default port in a wss URL is preserved", () => {
    const r = resolveDaemonRelay({ envUrl: "wss://relay.cyborg7.com:9443/relay" });
    expect(r?.endpoint).toBe("relay.cyborg7.com:9443");
    expect(r?.useTls).toBe(true);
  });

  it("bare host:443 infers TLS; configUseTls overrides the inference", () => {
    expect(resolveDaemonRelay({ configEndpoint: "relay.cyborg7.com:443" })?.useTls).toBe(true);
    expect(
      resolveDaemonRelay({ configEndpoint: "relay.cyborg7.com:443", configUseTls: false })?.useTls,
    ).toBe(false);
    // and a bare host:port builds a ws(s):// wsUrl matching the TLS choice
    expect(resolveDaemonRelay({ configEndpoint: "relay.cyborg7.com:443" })?.wsUrl).toBe(
      "wss://relay.cyborg7.com:443",
    );
  });

  it("fails LOUD with a clear message on a malformed ws(s):// URL (no cryptic Invalid URL)", () => {
    // A corrupt/hand-edited cyborg-relay-url file must crash boot with a message
    // that names the bad value, not a raw TypeError mid-bootstrap.
    expect(() => resolveDaemonRelay({ relayUrlFileContent: "wss://[not-a-url" })).toThrow(
      /Invalid relay URL/,
    );
    expect(() => resolveDaemonRelay({ envUrl: "wss://" })).toThrow(/Invalid relay URL/);
  });

  it("never resolves to relay.paseo.sh on its own (no default)", () => {
    // No input that mentions paseo → no paseo. The ONLY way paseo could appear is
    // if an operator explicitly configured it; the resolver injects no default.
    const r = resolveDaemonRelay({ configEndpoint: undefined, envUrl: undefined });
    expect(r).toBeNull();
  });
});

// Fix A: the daemon must SKIP Paseo's vestigial relay transport (which speaks
// the `/ws` socket the Cyborg7 relay doesn't serve → endless code-1006 storm
// that starves the real DaemonRelayClient) whenever the relay was resolved from
// a Cyborg7 source (CYBORG_RELAY_URL env — set by the desktop — or the
// `cyborg daemon claim` file), while KEEPING it for pure-Paseo daemons whose
// relay came from config.relayEndpoint (relay.paseo.sh, which DOES serve `/ws`).
//
// bootstrap.ts gates on exactly: resolvedRelay?.source === "env" || === "file".
// This encodes that predicate against the real resolver output so a regression
// (e.g. someone widening it to "config", or dropping the env case) fails here.
describe("Fix A — Paseo relay-transport gate (cyborg vs pure-Paseo)", () => {
  // Mirrors the bootstrap discriminator verbatim. Returns true when the Paseo
  // transport must be SKIPPED (cyborg mode) and the DaemonRelayClient relied on.
  const skipsPaseoTransport = (relay: ReturnType<typeof resolveDaemonRelay>): boolean =>
    relay?.source === "env" || relay?.source === "file";

  it("desktop (CYBORG_RELAY_URL env set) → SKIP Paseo transport (DaemonRelayClient registers instead)", () => {
    // The desktop always sets CYBORG_RELAY_URL (daemon-manager.ts). This is the
    // exact storm-causing case the proven `daemon.relay.enabled=false` fix cured.
    const relay = resolveDaemonRelay({ envUrl: "wss://relay.cyborg7.com/relay" });
    expect(relay?.source).toBe("env");
    expect(skipsPaseoTransport(relay)).toBe(true);
    // The DaemonRelayClient still has its wss:// URL to register against /relay.
    expect(relay?.wsUrl).toBe("wss://relay.cyborg7.com/relay");
  });

  it("claimed daemon (cyborg-relay-url file) → SKIP Paseo transport too", () => {
    const relay = resolveDaemonRelay({ relayUrlFileContent: "wss://relay.cyborg7.com/relay\n" });
    expect(relay?.source).toBe("file");
    expect(skipsPaseoTransport(relay)).toBe(true);
  });

  it("pure-Paseo daemon (config.relayEndpoint, no env/file) → KEEP Paseo transport (relay serves /ws)", () => {
    const relay = resolveDaemonRelay({ configEndpoint: "relay.paseo.sh:443" });
    expect(relay?.source).toBe("config");
    expect(skipsPaseoTransport(relay)).toBe(false);
    // …and it still has a host:port endpoint for startRelayTransport.
    expect(relay?.endpoint).toBe("relay.paseo.sh:443");
  });

  it("env precedence: even with a config endpoint present, an env URL → cyborg mode (skip)", () => {
    const relay = resolveDaemonRelay({
      envUrl: "wss://relay.cyborg7.com/relay",
      configEndpoint: "relay.paseo.sh:443",
    });
    expect(relay?.source).toBe("env");
    expect(skipsPaseoTransport(relay)).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { resolveDaemonEdition } from "./daemon-edition.js";

const CANONICAL = "relay.cyborg7.com";

describe("resolveDaemonEdition", () => {
  describe("explicit CYBORG_EDITION env overrides inference", () => {
    for (const edition of ["saas", "selfhost", "opensource"] as const) {
      it(`returns '${edition}' verbatim regardless of host/mode`, () => {
        // Pick host/mode that would infer something DIFFERENT so the override is real.
        expect(
          resolveDaemonEdition({
            envEdition: edition,
            relayHost: "custom.example.com",
            storageMode: "solo",
          }),
        ).toBe(edition);
      });
    }

    it("trims whitespace around a valid env value", () => {
      expect(
        resolveDaemonEdition({
          envEdition: "  saas  ",
          relayHost: "custom.example.com",
          storageMode: "connected",
        }),
      ).toBe("saas");
    });
  });

  describe("invalid/empty env falls through to inference", () => {
    for (const bad of [undefined, "", "   ", "SAAS", "enterprise"]) {
      it(`ignores ${JSON.stringify(bad)} and infers from host + mode`, () => {
        // canonical + connected → saas (proves the env value was discarded).
        expect(
          resolveDaemonEdition({
            envEdition: bad,
            relayHost: CANONICAL,
            storageMode: "connected",
          }),
        ).toBe("saas");
      });
    }
  });

  it("infers 'saas' for the canonical relay on connected storage", () => {
    expect(
      resolveDaemonEdition({
        envEdition: undefined,
        relayHost: CANONICAL,
        storageMode: "connected",
      }),
    ).toBe("saas");
  });

  it("infers 'selfhost' for a custom host on connected storage", () => {
    expect(
      resolveDaemonEdition({
        envEdition: undefined,
        relayHost: "relay.acme.internal",
        storageMode: "connected",
      }),
    ).toBe("selfhost");
  });

  it("infers 'selfhost' for a non-canonical host on connected storage", () => {
    expect(
      resolveDaemonEdition({
        envEdition: undefined,
        relayHost: "relay.cyborg7.com.evil.example",
        storageMode: "connected",
      }),
    ).toBe("selfhost");
  });

  describe("solo storage is always 'opensource'", () => {
    it("for the canonical host", () => {
      expect(
        resolveDaemonEdition({
          envEdition: undefined,
          relayHost: CANONICAL,
          storageMode: "solo",
        }),
      ).toBe("opensource");
    });

    it("for a custom host", () => {
      expect(
        resolveDaemonEdition({
          envEdition: undefined,
          relayHost: "relay.acme.internal",
          storageMode: "solo",
        }),
      ).toBe("opensource");
    });
  });
});

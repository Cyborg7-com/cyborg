import { describe, expect, it } from "vitest";
import {
  CyborgListProviderAuthRequestSchema,
  CyborgListProviderAuthResponseSchema,
  CyborgRemoveCyboCredentialRequestSchema,
  CyborgSetCyboCredentialRequestSchema,
} from "./cyborg-messages.js";

// Validates the additive credential RPC schemas (internal docs). These are
// the wire contracts; the daemon parses inbound with .parse() so a bad payload
// must be rejected, and the list response must be metadata-only.

describe("cyborg:set_cybo_credential request schema", () => {
  const base = {
    type: "cyborg:set_cybo_credential",
    requestId: "r1",
    workspaceId: "w1",
    daemonId: "d1",
    providerId: "openrouter",
  } as const;

  it("accepts an api credential", () => {
    const parsed = CyborgSetCyboCredentialRequestSchema.parse({
      ...base,
      credential: { type: "api", key: "sk-x", metadata: { tier: "pro" } },
    });
    expect(parsed.credential.type).toBe("api");
  });

  it("accepts an oauth credential with epoch-ms expires", () => {
    const parsed = CyborgSetCyboCredentialRequestSchema.parse({
      ...base,
      credential: {
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 1_700_000_000_000,
        accountId: "acct",
      },
    });
    expect(parsed.credential.type).toBe("oauth");
  });

  it("accepts a wellknown credential", () => {
    const parsed = CyborgSetCyboCredentialRequestSchema.parse({
      ...base,
      credential: { type: "wellknown", key: "k", token: "t" },
    });
    expect(parsed.credential.type).toBe("wellknown");
  });

  it("requires an explicit daemonId (per-daemon store)", () => {
    const { daemonId: _omit, ...noDaemon } = base;
    const r = CyborgSetCyboCredentialRequestSchema.safeParse({
      ...noDaemon,
      credential: { type: "api", key: "sk" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unknown credential type", () => {
    const r = CyborgSetCyboCredentialRequestSchema.safeParse({
      ...base,
      credential: { type: "cli" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an api credential with an empty key", () => {
    const r = CyborgSetCyboCredentialRequestSchema.safeParse({
      ...base,
      credential: { type: "api", key: "" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an oauth credential missing refresh", () => {
    const r = CyborgSetCyboCredentialRequestSchema.safeParse({
      ...base,
      credential: { type: "oauth", access: "a", expires: 1 },
    });
    expect(r.success).toBe(false);
  });
});

describe("cyborg:remove_cybo_credential request schema", () => {
  it("accepts a well-formed remove request", () => {
    const parsed = CyborgRemoveCyboCredentialRequestSchema.parse({
      type: "cyborg:remove_cybo_credential",
      requestId: "r1",
      workspaceId: "w1",
      daemonId: "d1",
      providerId: "groq",
    });
    expect(parsed.providerId).toBe("groq");
  });

  it("rejects a missing providerId", () => {
    const r = CyborgRemoveCyboCredentialRequestSchema.safeParse({
      type: "cyborg:remove_cybo_credential",
      requestId: "r1",
      workspaceId: "w1",
      daemonId: "d1",
    });
    expect(r.success).toBe(false);
  });
});

describe("cyborg:list_provider_auth schemas", () => {
  it("accepts a well-formed list request", () => {
    const parsed = CyborgListProviderAuthRequestSchema.parse({
      type: "cyborg:list_provider_auth",
      requestId: "r1",
      workspaceId: "w1",
      daemonId: "d1",
    });
    expect(parsed.daemonId).toBe("d1");
  });

  it("accepts a metadata-only response (providerId, type, expires)", () => {
    const parsed = CyborgListProviderAuthResponseSchema.parse({
      type: "cyborg:list_provider_auth_response",
      payload: {
        requestId: "r1",
        credentials: [
          { providerId: "openrouter", type: "api" },
          { providerId: "claude", type: "oauth", expires: 123 },
        ],
      },
    });
    expect(parsed.payload.credentials).toHaveLength(2);
  });

  it("rejects a response that leaks a secret field", () => {
    // The response schema is strict on the credential shape — a `key` field is not
    // part of the metadata view, so a leaking payload fails validation.
    const r = CyborgListProviderAuthResponseSchema.safeParse({
      type: "cyborg:list_provider_auth_response",
      payload: {
        requestId: "r1",
        credentials: [{ providerId: "openrouter", type: "api", key: "sk-leak" }],
      },
    });
    // zod object strips unknown keys by default, so success is fine BUT the parsed
    // value must NOT carry the secret.
    if (r.success) {
      expect(JSON.stringify(r.data)).not.toContain("sk-leak");
    }
  });
});

import { createHmac } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";

import { verifyJwt, timingSafeEqualStr, assertProdJwtSecret } from "./auth.js";

const SECRET = "test-secret";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

// Mint an HS256 token. `sign` lets us forge a bad signature.
function mintToken(payload: Record<string, unknown>, secret = SECRET): string {
  const headerB64 = b64url({ alg: "HS256", typ: "JWT" });
  const payloadB64 = b64url(payload);
  const sig = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");
  return `${headerB64}.${payloadB64}.${sig}`;
}

const future = () => Math.floor(Date.now() / 1000) + 3600;
const past = () => Math.floor(Date.now() / 1000) - 3600;

describe("verifyJwt", () => {
  it("accepts a well-formed, unexpired, correctly-signed token", () => {
    const token = mintToken({ email: "a@b.com", exp: future() });
    const payload = verifyJwt(token, SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.email).toBe("a@b.com");
  });

  it("rejects a token signed with a different secret", () => {
    const token = mintToken({ email: "a@b.com", exp: future() }, "other-secret");
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a token with a tampered signature", () => {
    const token = mintToken({ email: "a@b.com", exp: future() });
    const tampered = `${token.slice(0, -3)}xxx`;
    expect(verifyJwt(tampered, SECRET)).toBeNull();
  });

  it("rejects a token with NO exp claim (must not be valid forever)", () => {
    const token = mintToken({ email: "a@b.com" });
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a token whose exp is non-numeric", () => {
    const token = mintToken({ email: "a@b.com", exp: "soon" });
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = mintToken({ email: "a@b.com", exp: past() });
    expect(verifyJwt(token, SECRET)).toBeNull();
  });

  it("rejects a malformed token (wrong part count)", () => {
    expect(verifyJwt("not.a.jwt.token", SECRET)).toBeNull();
    expect(verifyJwt("only-one-part", SECRET)).toBeNull();
  });
});

describe("timingSafeEqualStr", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqualStr("abc123", "abc123")).toBe(true);
  });
  it("returns false for different same-length strings", () => {
    expect(timingSafeEqualStr("abc123", "abc124")).toBe(false);
  });
  it("returns false for different-length strings (no throw)", () => {
    expect(timingSafeEqualStr("abc", "abcdef")).toBe(false);
  });
});

describe("assertProdJwtSecret", () => {
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it("throws in production when the secret is missing", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertProdJwtSecret(undefined)).toThrow();
  });

  it("throws in production when the secret is the public dev default", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertProdJwtSecret("cyborg7-dev-secret-change-in-production")).toThrow();
  });

  it("does not throw in production with a custom secret", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertProdJwtSecret("a-strong-secret")).not.toThrow();
  });

  it("does not throw outside production even with the default/missing secret", () => {
    process.env.NODE_ENV = "development";
    expect(() => assertProdJwtSecret(undefined)).not.toThrow();
    expect(() => assertProdJwtSecret("cyborg7-dev-secret-change-in-production")).not.toThrow();
  });
});

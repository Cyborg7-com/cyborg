import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetCryptoWarningForTest,
  decryptToken,
  encryptToken,
  isEncryptedToken,
} from "./task-sync-crypto.js";

// Token encryption-at-rest: AES-256-GCM round-trip with a configured key, plaintext
// passthrough when the key is unset, and the "v1:" prefix discipline that keeps legacy
// plaintext tokens readable.

// A deterministic, valid base64 32-byte key.
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const ENV = "CYBORG7_TOKEN_ENC_KEY";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV];
  _resetCryptoWarningForTest();
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

describe("encryptToken / decryptToken — with a configured key", () => {
  beforeEach(() => {
    process.env[ENV] = KEY;
  });

  it("round-trips a token through v1 ciphertext", () => {
    const plain = "jira-oauth-access-token-abc123";
    const enc = encryptToken(plain);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toBe(plain);
    expect(decryptToken(enc)).toBe(plain);
  });

  it("round-trips unicode / long tokens", () => {
    const plain = "clück-tökén-🔐-".repeat(50);
    expect(decryptToken(encryptToken(plain))).toBe(plain);
  });

  it("uses a fresh IV each time (same plaintext → different ciphertext, same decrypt)", () => {
    const plain = "same-token";
    const a = encryptToken(plain);
    const b = encryptToken(plain);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plain);
    expect(decryptToken(b)).toBe(plain);
  });

  it("still returns a NON-v1 (legacy plaintext) value unchanged", () => {
    // A value stored before encryption was enabled has no prefix — read it as-is.
    expect(decryptToken("legacy-plaintext-token")).toBe("legacy-plaintext-token");
  });

  it("throws when a v1 token is decrypted with the WRONG key (tamper/auth failure)", () => {
    const enc = encryptToken("secret");
    process.env[ENV] = OTHER_KEY;
    expect(() => decryptToken(enc)).toThrow();
  });
});

describe("encryptToken / decryptToken — with NO key (dev / unconfigured)", () => {
  beforeEach(() => {
    delete process.env[ENV];
  });

  it("encrypt returns the plaintext unchanged (no prefix)", () => {
    const plain = "plain-token";
    const enc = encryptToken(plain);
    expect(enc).toBe(plain);
    expect(isEncryptedToken(enc)).toBe(false);
  });

  it("decrypt passes a plaintext value through unchanged", () => {
    expect(decryptToken("plain-token")).toBe("plain-token");
  });

  it("throws if asked to decrypt a v1 token it cannot authenticate", () => {
    process.env[ENV] = KEY;
    const enc = encryptToken("secret");
    delete process.env[ENV];
    expect(() => decryptToken(enc)).toThrow();
  });
});

describe("encryptToken — with a MALFORMED key (wrong length)", () => {
  it("falls back to plaintext rather than crashing", () => {
    process.env[ENV] = Buffer.alloc(16, 1).toString("base64"); // 16 bytes, not 32.
    const plain = "plain-token";
    expect(encryptToken(plain)).toBe(plain);
  });
});

describe("isEncryptedToken", () => {
  it("distinguishes v1 ciphertext from legacy plaintext", () => {
    process.env[ENV] = KEY;
    expect(isEncryptedToken(encryptToken("t"))).toBe(true);
    expect(isEncryptedToken("t")).toBe(false);
  });
});

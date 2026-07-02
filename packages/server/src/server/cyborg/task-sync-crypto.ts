// Token encryption-at-rest for task-integration provider tokens (Jira / ClickUp OAuth
// + API tokens). A small, self-contained util the NEW provider flows use when storing a
// token; it does NOT rewire the existing Slack/GitHub token storage (out of scope — that
// risks the live integrations).
//
// Design:
//   - AES-256-GCM (node:crypto only, no new deps) with a 32-byte key from the base64
//     env var CYBORG7_TOKEN_ENC_KEY.
//   - Self-describing ciphertext: "v1:" + base64(iv ‖ authTag ‖ ciphertext). The prefix
//     lets decryptToken tell an encrypted value from a legacy plaintext one.
//   - DEV / unconfigured fallback: with no (or a malformed) key, encryptToken returns
//     the PLAINTEXT unchanged (logging a one-time warning) so dev and the current
//     unencrypted flow keep working; decryptToken returns any value WITHOUT the "v1:"
//     prefix unchanged, so pre-existing plaintext tokens still read.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// The ciphertext scheme tag. A value that does not start with this is treated as legacy
// plaintext by decryptToken and returned unchanged.
const V1_PREFIX = "v1:";
// AES-256-GCM parameters: 96-bit IV (the GCM standard) + 128-bit auth tag.
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const ENV_KEY = "CYBORG7_TOKEN_ENC_KEY";

// Fire the "no key configured" warning at most once per process, so a dev run isn't
// spammed on every token write while an operator still sees the misconfiguration.
let warnedMissingKey = false;

function warnMissingKeyOnce(): void {
  if (warnedMissingKey) return;
  warnedMissingKey = true;
  console.warn(
    `[task-sync-crypto] ${ENV_KEY} is unset or malformed — provider tokens are stored ` +
      `as PLAINTEXT. Set a base64 32-byte key to enable encryption at rest.`,
  );
}

// The decoded 32-byte key, or null when the env var is unset or not a valid base64
// 32-byte value. Read on every call (not cached) so a key set later in a process — and
// tests that toggle the env var between cases — take effect.
function loadKey(): Buffer | null {
  const raw = process.env[ENV_KEY];
  if (!raw) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  if (decoded.length !== KEY_BYTES) return null;
  return decoded;
}

/**
 * Encrypt a token for storage. With a valid key → "v1:" + base64(iv ‖ tag ‖ ciphertext).
 * With NO / a malformed key → the plaintext unchanged (+ a one-time warning), so dev and
 * the legacy unencrypted flow keep working. Not idempotent: encrypting a "v1:" value
 * re-wraps it — callers store the plaintext token, not an already-encrypted one.
 */
export function encryptToken(plain: string): string {
  const key = loadKey();
  if (!key) {
    warnMissingKeyOnce();
    return plain;
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return V1_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/**
 * Decrypt a stored token. A value WITHOUT the "v1:" prefix is legacy plaintext and is
 * returned unchanged (so existing tokens keep reading). A "v1:" value is decrypted with
 * the configured key; a missing key or a tampered/corrupt payload throws — a "v1:" value
 * we cannot authenticate must fail loudly, never be returned as if it were plaintext.
 */
export function decryptToken(enc: string): string {
  if (!enc.startsWith(V1_PREFIX)) return enc; // legacy plaintext — pass through unchanged.
  const key = loadKey();
  if (!key) {
    warnMissingKeyOnce();
    throw new Error(
      `[task-sync-crypto] cannot decrypt a v1 token: ${ENV_KEY} is unset or malformed`,
    );
  }
  const packed = Buffer.from(enc.slice(V1_PREFIX.length), "base64");
  if (packed.length < IV_BYTES + TAG_BYTES) {
    throw new Error("[task-sync-crypto] malformed v1 token payload");
  }
  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Whether a stored value is an encrypted "v1:" token (vs legacy plaintext). */
export function isEncryptedToken(value: string): boolean {
  return value.startsWith(V1_PREFIX);
}

/** TEST-ONLY: reset the one-time "missing key" warning latch between cases. */
export function _resetCryptoWarningForTest(): void {
  warnedMissingKey = false;
}

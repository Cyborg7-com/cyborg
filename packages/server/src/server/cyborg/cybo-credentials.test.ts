import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  type CyboCredentialApi,
  type CyboCredentialOauth,
  type CyboCredentialWellKnown,
  CyboCredentialStore,
  credentialsDirFor,
  credentialTypeForAuthMode,
} from "./cybo-credentials.js";

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");

describe("cybo-credentials — encryption round-trip", () => {
  const key = Buffer.alloc(32, 3);

  it("encrypts then decrypts an api credential losslessly", () => {
    const cred: CyboCredentialApi = {
      type: "api",
      key: "sk-secret-123",
      metadata: { tier: "pro" },
    };
    const record = __testing.encryptCredential(key, cred);
    expect(record.v).toBe(1);
    // The ciphertext must NOT contain the plaintext secret.
    expect(`${record.iv}${record.tag}${record.data}`).not.toContain("sk-secret-123");
    const out = __testing.decryptCredential(key, record);
    expect(out).toEqual(cred);
  });

  it("round-trips an oauth credential including expires/accountId", () => {
    const cred: CyboCredentialOauth = {
      type: "oauth",
      access: "access-tok",
      refresh: "refresh-tok",
      expires: 1_700_000_000_000,
      accountId: "acct_42",
    };
    const out = __testing.decryptCredential(key, __testing.encryptCredential(key, cred));
    expect(out).toEqual(cred);
  });

  it("round-trips a wellknown credential", () => {
    const cred: CyboCredentialWellKnown = { type: "wellknown", key: "k", token: "t" };
    const out = __testing.decryptCredential(key, __testing.encryptCredential(key, cred));
    expect(out).toEqual(cred);
  });

  it("uses a fresh random IV per encryption (no nonce reuse)", () => {
    const cred: CyboCredentialApi = { type: "api", key: "same" };
    const a = __testing.encryptCredential(key, cred);
    const b = __testing.encryptCredential(key, cred);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  it("rejects a tampered ciphertext (bad auth tag throws)", () => {
    const cred: CyboCredentialApi = { type: "api", key: "secret" };
    const record = __testing.encryptCredential(key, cred);
    const flipped = Buffer.from(record.data, "base64");
    flipped[0] ^= 0xff;
    const tampered = { ...record, data: flipped.toString("base64") };
    expect(() => __testing.decryptCredential(key, tampered)).toThrow();
  });

  it("rejects decryption under the wrong key", () => {
    const cred: CyboCredentialApi = { type: "api", key: "secret" };
    const record = __testing.encryptCredential(key, cred);
    const wrongKey = Buffer.alloc(32, 9);
    expect(() => __testing.decryptCredential(wrongKey, record)).toThrow();
  });
});

describe("cybo-credentials — auth-mode reconciliation (internal docs)", () => {
  it("maps each llm_auth_mode to its credential type", () => {
    expect(credentialTypeForAuthMode("api-key")).toBe("api");
    expect(credentialTypeForAuthMode("oauth")).toBe("oauth");
    expect(credentialTypeForAuthMode("wellknown")).toBe("wellknown");
  });

  it("returns null for cli (host login — store never consulted)", () => {
    expect(credentialTypeForAuthMode("cli")).toBeNull();
  });

  it("returns null for managed (Phase 5 workspace/PG path)", () => {
    expect(credentialTypeForAuthMode("managed")).toBeNull();
  });

  it("returns null for unknown / null / undefined modes (lenient)", () => {
    expect(credentialTypeForAuthMode("totally-unknown")).toBeNull();
    expect(credentialTypeForAuthMode(null)).toBeNull();
    expect(credentialTypeForAuthMode(undefined)).toBeNull();
  });
});

describe("cybo-credentials — store (per-daemon encrypted file)", () => {
  let baseDir: string;

  function makeStore(): CyboCredentialStore {
    // Use an explicit env-injected key so tests don't depend on master.key gen.
    return new CyboCredentialStore({ baseDir, masterKeyBase64: KEY_B64 });
  }

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "cybo-cred-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns undefined for an absent credential", async () => {
    const store = makeStore();
    expect(await store.getCredential("openrouter")).toBeUndefined();
  });

  it("stores and retrieves a credential round-trip", async () => {
    const store = makeStore();
    const cred: CyboCredentialApi = { type: "api", key: "sk-or-xyz" };
    await store.setCredential("openrouter", cred);
    expect(await store.getCredential("openrouter")).toEqual(cred);
  });

  it("persists across store instances (same baseDir + key)", async () => {
    await makeStore().setCredential("groq", { type: "api", key: "gsk_abc" });
    const fresh = new CyboCredentialStore({ baseDir, masterKeyBase64: KEY_B64 });
    expect(await fresh.getCredential("groq")).toEqual({ type: "api", key: "gsk_abc" });
  });

  it("removes a credential", async () => {
    const store = makeStore();
    await store.setCredential("minimax", { type: "api", key: "mk" });
    await store.removeCredential("minimax");
    expect(await store.getCredential("minimax")).toBeUndefined();
  });

  // #995: set/remove re-route a daemon_operation audit event (the secret value
  // never appears in the payload — only providerId + auth type).
  it("emits a daemon_operation audit event on set/remove (no secret in payload)", async () => {
    const store = makeStore();
    const events: import("./audit-event-log.js").AuditEvent[] = [];
    const sink = { emit: (e: import("./audit-event-log.js").AuditEvent) => events.push(e) };

    await store.setCredential(
      "openrouter",
      { type: "api", key: "sk-super-secret-xyz" },
      { sink, workspaceId: "ws1", userId: "u1" },
    );
    await store.removeCredential("openrouter", { sink, workspaceId: "ws1", userId: "u1" });

    expect(events).toHaveLength(2);
    expect(events[0].category).toBe("daemon_operation");
    expect(events[0].kind).toBe("credential.set");
    expect(events[0].workspaceId).toBe("ws1");
    expect(events[1].kind).toBe("credential.remove");
    // The secret value must NEVER be in any emitted payload.
    expect(JSON.stringify(events)).not.toContain("sk-super-secret-xyz");
  });

  it("remove is a no-op for an absent provider", async () => {
    const store = makeStore();
    await expect(store.removeCredential("nope")).resolves.toBeUndefined();
  });

  it("isolates credentials by providerId", async () => {
    const store = makeStore();
    await store.setCredential("openrouter", { type: "api", key: "or" });
    await store.setCredential("groq", { type: "api", key: "gq" });
    expect(await store.getCredential("openrouter")).toEqual({ type: "api", key: "or" });
    expect(await store.getCredential("groq")).toEqual({ type: "api", key: "gq" });
  });

  it("listCredentialMeta returns SHAPE ONLY — never the secret", async () => {
    const store = makeStore();
    await store.setCredential("openrouter", { type: "api", key: "sk-leak-me" });
    await store.setCredential("claude", {
      type: "oauth",
      access: "a",
      refresh: "r",
      expires: 1234,
    });
    const meta = await store.listCredentialMeta();
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("sk-leak-me");
    expect(serialized).not.toContain('"access"');
    expect(serialized).not.toContain('"refresh"');
    const byProvider = Object.fromEntries(meta.map((m) => [m.providerId, m]));
    expect(byProvider.openrouter).toEqual({ providerId: "openrouter", type: "api" });
    // oauth carries expires (for the UI countdown) but no secret.
    expect(byProvider.claude).toEqual({ providerId: "claude", type: "oauth", expires: 1234 });
  });

  it("writes auth.json and master.key with 0600 perms (generated-key path)", async () => {
    // No env key → exercises the generate-master.key branch.
    const store = new CyboCredentialStore({ baseDir });
    await store.setCredential("openrouter", { type: "api", key: "k" });
    const dir = credentialsDirFor(baseDir);
    const authMode = statSync(join(dir, "auth.json")).mode & 0o777;
    const keyMode = statSync(join(dir, "master.key")).mode & 0o777;
    expect(authMode).toBe(0o600);
    expect(keyMode).toBe(0o600);
  });

  it("the on-disk auth.json never contains the plaintext secret", async () => {
    const store = makeStore();
    await store.setCredential("openrouter", { type: "api", key: "sk-disk-secret" });
    const raw = readFileSync(join(credentialsDirFor(baseDir), "auth.json"), "utf8");
    expect(raw).not.toContain("sk-disk-secret");
  });

  it("treats a tampered on-disk record as absent (never crashes)", async () => {
    const store = makeStore();
    await store.setCredential("openrouter", { type: "api", key: "secret" });
    const authPath = join(credentialsDirFor(baseDir), "auth.json");
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      { v: number; iv: string; tag: string; data: string }
    >;
    const flipped = Buffer.from(parsed.openrouter.data, "base64");
    flipped[0] ^= 0xff;
    parsed.openrouter.data = flipped.toString("base64");
    writeFileSync(authPath, JSON.stringify(parsed));
    const reread = new CyboCredentialStore({ baseDir, masterKeyBase64: KEY_B64 });
    expect(await reread.getCredential("openrouter")).toBeUndefined();
    // And it is skipped from the listing rather than throwing.
    expect(await reread.listCredentialMeta()).toEqual([]);
  });

  it("treats records as absent when the master key changes (wrong key)", async () => {
    await makeStore().setCredential("openrouter", { type: "api", key: "secret" });
    const otherKey = Buffer.alloc(32, 1).toString("base64");
    const reread = new CyboCredentialStore({ baseDir, masterKeyBase64: otherKey });
    expect(await reread.getCredential("openrouter")).toBeUndefined();
  });

  it("rejects a malformed env master key (wrong byte length)", () => {
    const store = new CyboCredentialStore({
      baseDir,
      masterKeyBase64: Buffer.alloc(16, 1).toString("base64"),
    });
    // Read path degrades to absent rather than throwing...
    return expect(store.getCredential("x")).resolves.toBeUndefined();
  });

  it("throws on a malformed env master key for a WRITE (loud failure)", async () => {
    const store = new CyboCredentialStore({
      baseDir,
      masterKeyBase64: Buffer.alloc(16, 1).toString("base64"),
    });
    await expect(store.setCredential("x", { type: "api", key: "k" })).rejects.toThrow();
  });

  it("serializes concurrent writes without clobbering (read-modify-write)", async () => {
    const store = makeStore();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.setCredential(`p${i}`, { type: "api", key: `k${i}` }),
      ),
    );
    const meta = await store.listCredentialMeta();
    expect(meta).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(await store.getCredential(`p${i}`)).toEqual({ type: "api", key: `k${i}` });
    }
  });

  it("rejects an invalid credential shape on set", async () => {
    const store = makeStore();
    // @ts-expect-error — deliberately invalid at runtime
    await expect(store.setCredential("x", { type: "api" })).rejects.toThrow();
  });

  it("does not create the credentials dir until first use", () => {
    makeStore();
    expect(existsSync(credentialsDirFor(baseDir))).toBe(false);
  });
});

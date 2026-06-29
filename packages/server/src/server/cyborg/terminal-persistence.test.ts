import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  TerminalPersistenceStore,
  PERSIST_SCROLLBACK_LIMIT_BYTES,
  __testing,
  type PersistedTerminalMeta,
} from "./terminal-persistence.js";

function makeMeta(overrides: Partial<PersistedTerminalMeta> = {}): PersistedTerminalMeta {
  return {
    schemaVersion: 1,
    terminalId: "term-1",
    ownerUserId: "user-alice",
    workspaceId: "ws-1",
    daemonId: "daemon-1",
    cwd: "/home/me/repo",
    cols: 120,
    rows: 40,
    createdAt: Date.now(),
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

// Synchronous writes (debounceMs:0) keep the round-trip tests deterministic.
function makeStore(baseDir: string, overrides = {}): TerminalPersistenceStore {
  return new TerminalPersistenceStore({
    baseDir,
    enabled: true,
    debounceMs: 0,
    ...overrides,
  });
}

describe("TerminalPersistenceStore (#750) — cross-restart scrollback persistence", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "term-persist-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("persist → restart → replay: a saved session reloads as daemon_restart history", () => {
    // First daemon process: register + flush a session that never cleanly exits.
    const store1 = makeStore(baseDir);
    const meta = makeMeta();
    let ring = Buffer.from("npm install\nadded 42 packages\n");
    store1.register(meta, () => ring);
    ring = Buffer.from("npm install\nadded 42 packages\nbuilding...\n");
    store1.flush(meta.terminalId);

    // Second daemon process boots and scans the same dir.
    const store2 = makeStore(baseDir);
    const dead = store2.loadDeadSessions();
    const session = dead.get("term-1");
    expect(session).toBeDefined();
    expect(session?.endedReason).toBe("daemon_restart"); // endedAt was null
    expect(session?.scrollback.toString("utf8")).toContain("building...");
    expect(session?.meta.cwd).toBe("/home/me/repo");
    expect(session?.meta.ownerUserId).toBe("user-alice");
    expect(session?.meta.cols).toBe(120);
  });

  it("a cleanly-exited shell reloads as shell_exit history", () => {
    const store1 = makeStore(baseDir);
    const meta = makeMeta({ terminalId: "term-exit" });
    const ring = Buffer.from("exit\n");
    store1.register(meta, () => ring);
    // finalize stamps endedAt (clean shell exit).
    store1.finalize({ ...meta, endedAt: Date.now(), exitCode: 0 });

    const dead = makeStore(baseDir).loadDeadSessions();
    expect(dead.get("term-exit")?.endedReason).toBe("shell_exit");
    expect(dead.get("term-exit")?.meta.exitCode).toBe(0);
  });

  it("ring caps the on-disk log to 256 KiB (tail kept, head dropped)", () => {
    const store = makeStore(baseDir);
    const meta = makeMeta({ terminalId: "term-big" });
    // 512 KiB: head 'A', tail 'B'. Only the trailing 256 KiB should survive.
    const head = Buffer.alloc(PERSIST_SCROLLBACK_LIMIT_BYTES, 0x41);
    const tail = Buffer.alloc(PERSIST_SCROLLBACK_LIMIT_BYTES, 0x42);
    const ring = Buffer.concat([head, tail]);
    store.register(meta, () => ring);
    store.flush(meta.terminalId);

    const logPath = join(baseDir, "terminals", "term-big.log");
    expect(statSync(logPath).size).toBe(PERSIST_SCROLLBACK_LIMIT_BYTES);
    const loaded = makeStore(baseDir).loadDeadSessions().get("term-big");
    expect(loaded?.scrollback.length).toBe(PERSIST_SCROLLBACK_LIMIT_BYTES);
    // It kept the tail (all 'B'), not the head ('A').
    expect(loaded?.scrollback[0]).toBe(0x42);
    expect(loaded?.scrollback[loaded.scrollback.length - 1]).toBe(0x42);
  });

  it("files are written 0600 and the dir 0700", () => {
    const store = makeStore(baseDir);
    const meta = makeMeta({ terminalId: "term-perm" });
    store.register(meta, () => Buffer.from("hi"));
    store.flush(meta.terminalId);

    const dir = join(baseDir, "terminals");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "term-perm.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "term-perm.log")).mode & 0o777).toBe(0o600);
  });

  it("prunes cleanly-exited sessions older than 24h on boot", () => {
    const store = makeStore(baseDir);
    const old = makeMeta({
      terminalId: "term-old",
      endedAt: Date.now() - (__testing.CLEAN_EXIT_TTL_MS + 60_000),
      exitCode: 0,
    });
    const fresh = makeMeta({ terminalId: "term-fresh", endedAt: Date.now(), exitCode: 0 });
    store.register(old, () => Buffer.from("old"));
    store.finalize(old);
    store.register(fresh, () => Buffer.from("fresh"));
    store.finalize(fresh);

    const dead = makeStore(baseDir).loadDeadSessions();
    expect(dead.has("term-old")).toBe(false);
    expect(dead.has("term-fresh")).toBe(true);
    // The pruned session's files are gone from disk.
    expect(existsSync(join(baseDir, "terminals", "term-old.json"))).toBe(false);
    expect(existsSync(join(baseDir, "terminals", "term-old.log"))).toBe(false);
  });

  it("LRU-prunes to the newest 50 sessions, deleting the oldest", () => {
    const store = makeStore(baseDir);
    const total = __testing.MAX_PERSISTED_SESSIONS + 5;
    for (let i = 0; i < total; i++) {
      const meta = makeMeta({ terminalId: `t${i}`, createdAt: 1000 + i }); // ascending age
      store.register(meta, () => Buffer.from(`s${i}`));
      store.flush(meta.terminalId);
    }
    const dead = makeStore(baseDir).loadDeadSessions();
    expect(dead.size).toBe(__testing.MAX_PERSISTED_SESSIONS);
    // The 5 oldest (t0..t4) are gone; the newest survive.
    expect(dead.has("t0")).toBe(false);
    expect(dead.has("t4")).toBe(false);
    expect(dead.has(`t${total - 1}`)).toBe(true);
  });

  it("forget() deletes a session's sidecar + log", () => {
    const store = makeStore(baseDir);
    const meta = makeMeta({ terminalId: "term-forget" });
    store.register(meta, () => Buffer.from("bye"));
    store.flush(meta.terminalId);
    expect(existsSync(join(baseDir, "terminals", "term-forget.log"))).toBe(true);

    store.forget("term-forget");
    expect(existsSync(join(baseDir, "terminals", "term-forget.log"))).toBe(false);
    expect(existsSync(join(baseDir, "terminals", "term-forget.json"))).toBe(false);
  });

  it("disabled store is a no-op — nothing hits disk", () => {
    const store = new TerminalPersistenceStore({ baseDir, enabled: false, debounceMs: 0 });
    const meta = makeMeta({ terminalId: "term-off" });
    store.register(meta, () => Buffer.from("secret"));
    store.flush(meta.terminalId);
    store.finalize(meta);
    expect(existsSync(join(baseDir, "terminals"))).toBe(false);
  });

  it("encryption: encrypted .log round-trips and is NOT plaintext on disk", () => {
    const masterKeyBase64 = randomBytes(32).toString("base64");
    const store = makeStore(baseDir, { encrypt: true, masterKeyBase64 });
    const meta = makeMeta({ terminalId: "term-enc" });
    const secret = "export AWS_SECRET=hunter2-do-not-leak";
    const ring = Buffer.from(`${secret}\n`);
    store.register(meta, () => ring);
    store.flush(meta.terminalId);

    // The raw file must not contain the plaintext secret and must carry the magic.
    const raw = readFileSync(join(baseDir, "terminals", "term-enc.log"));
    expect(raw.subarray(0, __testing.ENC_MAGIC.length).toString("latin1")).toBe(
      __testing.ENC_MAGIC,
    );
    expect(raw.toString("utf8")).not.toContain("hunter2");

    // A boot scan with the SAME key decrypts it back.
    const dead = makeStore(baseDir, { encrypt: true, masterKeyBase64 }).loadDeadSessions();
    expect(dead.get("term-enc")?.scrollback.toString("utf8")).toContain(secret);
  });

  it("encryption: a wrong key yields empty history (treated as absent), never a crash", () => {
    const keyA = randomBytes(32).toString("base64");
    const keyB = randomBytes(32).toString("base64");
    const store = makeStore(baseDir, { encrypt: true, masterKeyBase64: keyA });
    const meta = makeMeta({ terminalId: "term-tamper" });
    const ring = Buffer.from("topsecret\n");
    store.register(meta, () => ring);
    store.flush(meta.terminalId);

    const dead = makeStore(baseDir, { encrypt: true, masterKeyBase64: keyB }).loadDeadSessions();
    // Sidecar still loads (metadata isn't encrypted), but the log decrypts empty.
    expect(dead.get("term-tamper")?.scrollback.length).toBe(0);
  });

  it("safeId blocks path traversal in the on-disk filename", () => {
    expect(__testing.safeId("../../etc/passwd")).not.toContain("/");
    expect(__testing.safeId("a/b\\c")).toBe("a_b_c");
    const files = makeStore(baseDir);
    const meta = makeMeta({ terminalId: "../evil" });
    files.register(meta, () => Buffer.from("x"));
    files.flush(meta.terminalId);
    // The id was sanitized (separators → "_"); the file lives INSIDE terminals/
    // and nothing was written to the parent dir.
    const dir = join(baseDir, "terminals");
    const written = readdirSync(dir);
    expect(written.every((f) => !f.includes("/") && !f.includes("\\"))).toBe(true);
    expect(written).toContain(".._evil.log");
    expect(existsSync(join(baseDir, "evil"))).toBe(false);
  });
});

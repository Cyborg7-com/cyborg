// Per-daemon terminal scrollback persistence (#750, internal docs).
//
// A pty is an OS process owned by the daemon: when the daemon exits, the kernel
// reaps the shell and the running process is GONE. There is no way to resume a
// half-typed command across a restart (that needs a tmux/abduco session leader —
// out of scope, internal docs). So "persistence" here means exactly two
// things: (1) persist the last 256 KiB of scrollback + session metadata to disk,
// (2) on re-attach to a now-dead session, replay it as READ-ONLY history with a
// clear "session ended — here is its history" signal. We never claim the process
// resumes.
//
// WHY DISK, NOT PG (internal docs): a terminal is owner-locked, single-user,
// single-daemon — the opposite of the collaborative entities (messages/channels)
// that belong in shared PG. Its output is high-frequency binary. Its history
// belongs on the host the pty ran on. Locus: $PASEO_HOME/terminals/<id>.{log,json},
// dir 0700, files 0600 (matching the credential store).
//
// SHIPS DARK by default (internal docs open question 2): writing terminal
// bytes to disk is gated behind `enabled` (env CYBORG7_PERSIST_TERMINALS=1),
// default OFF until the at-rest encryption story is reviewed. The in-memory live
// re-attach (#738) already covers the 90% tab-switch case; disk persistence is the
// long-tail "the daemon actually restarted" case.
//
// ENCRYPTION (internal docs): when `encrypt` is on, the .log bytes are sealed
// with the SAME per-daemon AES-256-GCM master key the credential store uses
// (resolveDaemonMasterKey) — no second key path. Default OFF until reviewed, so
// the 0600 file perms are the documented safe behavior on first ship.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { resolveDaemonMasterKey } from "./cybo-credentials.js";

// Same recent-output budget the in-memory ring uses (terminal-controller.ts
// SCROLLBACK_LIMIT_BYTES). The on-disk tail is bounded to the same 256 KiB.
export const PERSIST_SCROLLBACK_LIMIT_BYTES = 256 * 1024;

// Cap the NUMBER of persisted dead sessions so a long-lived daemon doesn't
// accumulate thousands of .log files (internal docs). LRU prune by createdAt.
const MAX_PERSISTED_SESSIONS = 50;

// Cleanly-exited shells older than this are pruned on boot (internal docs).
const CLEAN_EXIT_TTL_MS = 24 * 60 * 60 * 1000;

// Debounce window for ring writes (internal docs): a hard crash loses at most
// this much trailing output — acceptable for a "where was I" buffer.
const DEFAULT_DEBOUNCE_MS = 1500;

const SIDECAR_SCHEMA_VERSION = 1 as const;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const ENC_MAGIC = "C7TLOG1\n"; // 8-byte header marking an encrypted .log

export type TerminalEndedReason = "shell_exit" | "daemon_restart";

// JSON sidecar persisted per session — mirrors TrackedTerminal minus live handles
// (internal docs).
export interface PersistedTerminalMeta {
  schemaVersion: typeof SIDECAR_SCHEMA_VERSION;
  terminalId: string;
  ownerUserId: string;
  // The owner's STABLE human identity (their email) — the email-keyed owner-lock
  // (#874). The opaque ownerUserId resolves to DIFFERENT UUIDs per storage layer
  // (PG users.id vs a fresh randomUUID() per email per SQLite file), so a terminal
  // created via one id-namespace (sidecar ownerUserId) is re-subscribed via another
  // (relay-override PG-id) and the exact-id owner-lock rejects the real owner →
  // attachDead → "ended/Restart" banner. The email is the same across all layers,
  // so matching on it survives the per-store id divergence. Optional: OLD sidecars
  // (pre-#874) have no ownerEmail and fall back to id-only owner matching.
  ownerEmail?: string;
  workspaceId: string | null;
  daemonId: string | null;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  // null while live; set on the shell exiting (onExit). null after a boot scan
  // means "the daemon died while this was running" → endedReason daemon_restart.
  endedAt: number | null;
  exitCode: number | null;
}

// A dead session reconstructed on boot — history only, no pty.
export interface DeadTerminalSession {
  meta: PersistedTerminalMeta;
  scrollback: Buffer;
  endedReason: TerminalEndedReason;
}

export interface TerminalPersistenceOptions {
  // Base dir for the terminals/ directory. Default: $PASEO_HOME, else ~/.cyborg7.
  baseDir?: string;
  // Master OFF switch (internal docs). Default: env CYBORG7_PERSIST_TERMINALS
  // is "1"/"true". When false, every method is a cheap no-op (nothing hits disk).
  enabled?: boolean;
  // Encrypt the .log at rest with the shared credential-store key. Default: env
  // CYBORG7_PERSIST_TERMINALS_ENCRYPT is "1"/"true". Default OFF until reviewed.
  encrypt?: boolean;
  // Override the debounce window (tests use 0 for synchronous writes).
  debounceMs?: number;
  // Override the master-key base64 (tests / prod KMS). Forwarded to the resolver.
  masterKeyBase64?: string;
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

interface DirtyEntry {
  meta: PersistedTerminalMeta;
  // Snapshot getter — the controller hands us a closure that returns the current
  // ring tail so we read the latest bytes at write time, not at markDirty time.
  getScrollback: () => Buffer;
  timer: ReturnType<typeof setTimeout> | null;
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

// Resolve whether the persistence store should be ENABLED, given a default that
// the caller derives from PtyHost (the #856 fix: persistence must follow PtyHost
// so the owner sidecar is written and rehydrate can restore ownership). The
// explicit env override WINS: CYBORG7_PERSIST_TERMINALS set to 1/true force-
// ENABLES, set to anything else (0/false/off/empty) force-DISABLES. When the env
// var is UNSET, fall back to `defaultEnabled` (= isPtyHostEnabled()). This lets an
// operator FORCE-disable disk persistence even with PtyHost on (the at-rest-
// encryption escape hatch from internal docs), while making "PtyHost on" imply
// "persist on" out of the box.
export function resolvePersistEnabled(defaultEnabled: boolean): boolean {
  const raw = process.env.CYBORG7_PERSIST_TERMINALS;
  if (raw === undefined) return defaultEnabled;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

export class TerminalPersistenceStore {
  private readonly dir: string;
  readonly enabled: boolean;
  private readonly encrypt: boolean;
  private readonly debounceMs: number;
  private readonly masterKeyBase64: string | undefined;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly logger: Pick<Logger, "info" | "warn" | "error"> | undefined;
  private readonly dirty = new Map<string, DirtyEntry>();
  private cachedKey: Buffer | null = null;

  constructor(options: TerminalPersistenceOptions = {}) {
    const base = options.baseDir ?? process.env.PASEO_HOME ?? join(homedir(), ".cyborg7");
    this.dir = join(base, "terminals");
    this.enabled = options.enabled ?? envFlag("CYBORG7_PERSIST_TERMINALS");
    this.encrypt = options.encrypt ?? envFlag("CYBORG7_PERSIST_TERMINALS_ENCRYPT");
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.masterKeyBase64 = options.masterKeyBase64;
    this.setTimeoutFn = options.timers?.setTimeout ?? setTimeout;
    this.clearTimeoutFn = options.timers?.clearTimeout ?? clearTimeout;
    this.logger = options.logger;
  }

  // Record a session's metadata and begin tracking its scrollback for debounced
  // persistence. `getScrollback` is a closure into the controller's live ring so
  // each flush reads the latest tail. No-op when disabled.
  register(meta: PersistedTerminalMeta, getScrollback: () => Buffer): void {
    if (!this.enabled) return;
    this.persistMeta(meta);
    this.dirty.set(meta.terminalId, { meta, getScrollback, timer: null });
  }

  // Mark a session dirty after new coalesced output. Schedules a single debounced
  // ring write (internal docs) — does NOT fsync per flush.
  markDirty(terminalId: string): void {
    if (!this.enabled) return;
    const entry = this.dirty.get(terminalId);
    if (!entry || entry.timer) return;
    entry.timer = this.setTimeoutFn(() => {
      entry.timer = null;
      this.writeLog(terminalId, entry.getScrollback());
    }, this.debounceMs);
    // Don't let a pending write keep the process alive on shutdown.
    (entry.timer as { unref?: () => void })?.unref?.();
  }

  // Persist metadata on a state change (start, resize, exit) — internal docs
  // writes the sidecar on state-change events only, never per output frame.
  persistMeta(meta: PersistedTerminalMeta): void {
    if (!this.enabled) return;
    const entry = this.dirty.get(meta.terminalId);
    if (entry) entry.meta = meta;
    this.writeSidecar(meta);
  }

  // Flush a single session's ring immediately (e.g. on exit), cancelling any
  // pending debounced write.
  flush(terminalId: string): void {
    if (!this.enabled) return;
    const entry = this.dirty.get(terminalId);
    if (!entry) return;
    if (entry.timer) {
      this.clearTimeoutFn(entry.timer);
      entry.timer = null;
    }
    this.writeLog(terminalId, entry.getScrollback());
  }

  // Stop tracking a session (it exited / was killed). Flushes the final tail and
  // sidecar so a graceful teardown persists the last bytes (internal docs).
  finalize(meta: PersistedTerminalMeta): void {
    if (!this.enabled) return;
    const entry = this.dirty.get(meta.terminalId);
    if (entry?.timer) {
      this.clearTimeoutFn(entry.timer);
      entry.timer = null;
    }
    this.writeLog(meta.terminalId, entry ? entry.getScrollback() : Buffer.alloc(0));
    this.writeSidecar(meta);
    this.dirty.delete(meta.terminalId);
  }

  // Boot scan (internal docs): load every sidecar, rebuild the dead-session
  // map, prune stale/over-cap entries. Sidecars with endedAt==null are "the daemon
  // died while I was running" → endedReason daemon_restart; endedAt!=null is a
  // clean shell_exit. Returns history-only entries (NO pty). Safe when disabled
  // (still loads any sidecars a previous enabled run left, so users can read them).
  loadDeadSessions(): Map<string, DeadTerminalSession> {
    const out = new Map<string, DeadTerminalSession>();
    if (!existsSync(this.dir)) return out;
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      // intentional: an unreadable terminals/ dir means "no history", never a crash.
      return out;
    }
    const metas: PersistedTerminalMeta[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const meta = this.readSidecar(join(this.dir, file));
      if (meta) metas.push(meta);
    }
    // Prune by 24h-clean-exit, then LRU to newest-50 (internal docs §B.5).
    const now = Date.now();
    const live: PersistedTerminalMeta[] = [];
    for (const meta of metas) {
      if (meta.endedAt !== null && now - meta.endedAt > CLEAN_EXIT_TTL_MS) {
        this.deleteFiles(meta.terminalId);
        continue;
      }
      live.push(meta);
    }
    live.sort((a, b) => b.createdAt - a.createdAt);
    for (const meta of live.slice(MAX_PERSISTED_SESSIONS)) {
      this.deleteFiles(meta.terminalId);
    }
    for (const meta of live.slice(0, MAX_PERSISTED_SESSIONS)) {
      const scrollback = this.readLog(meta.terminalId);
      const endedReason: TerminalEndedReason =
        meta.endedAt === null ? "daemon_restart" : "shell_exit";
      out.set(meta.terminalId, { meta, scrollback, endedReason });
    }
    return out;
  }

  // Delete a session's sidecar + log (explicit forget, internal docs). Always
  // runs regardless of `enabled` so a user can clear a dead row left by a prior run.
  forget(terminalId: string): void {
    this.deleteFiles(terminalId);
    const entry = this.dirty.get(terminalId);
    if (entry?.timer) this.clearTimeoutFn(entry.timer);
    this.dirty.delete(terminalId);
  }

  // ── disk primitives ──────────────────────────────────────────────────────

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private logPath(terminalId: string): string {
    return join(this.dir, `${safeId(terminalId)}.log`);
  }

  private sidecarPath(terminalId: string): string {
    return join(this.dir, `${safeId(terminalId)}.json`);
  }

  private writeAtomic(path: string, data: Buffer | string): void {
    this.ensureDir();
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  }

  private writeSidecar(meta: PersistedTerminalMeta): void {
    try {
      this.writeAtomic(this.sidecarPath(meta.terminalId), JSON.stringify(meta, null, 2));
    } catch (err) {
      // intentional: persistence is best-effort; a write failure must not break
      // the live terminal. Log the event (never the bytes).
      this.logger?.warn(
        { terminalId: meta.terminalId, event: "sidecar_write_failed" },
        "terminal-persistence: failed to write sidecar",
      );
      void err;
    }
  }

  private readSidecar(path: string): PersistedTerminalMeta | null {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!isPersistedMeta(parsed)) return null;
      return parsed;
    } catch {
      // intentional: a garbled/partial sidecar reads as absent, never a crash.
      return null;
    }
  }

  // Ring write: persist only the trailing 256 KiB (the in-memory tail is already
  // trimmed to that, but re-clamp defensively). Encrypts when configured.
  private writeLog(terminalId: string, scrollback: Buffer): void {
    let tail = scrollback;
    if (tail.length > PERSIST_SCROLLBACK_LIMIT_BYTES) {
      tail = tail.subarray(tail.length - PERSIST_SCROLLBACK_LIMIT_BYTES);
    }
    try {
      this.writeAtomic(this.logPath(terminalId), this.encrypt ? this.seal(tail) : tail);
    } catch {
      // intentional: best-effort; a failed ring write must not break the terminal.
      this.logger?.warn(
        { terminalId, event: "log_write_failed" },
        "terminal-persistence: failed to write scrollback log",
      );
    }
  }

  private readLog(terminalId: string): Buffer {
    const path = this.logPath(terminalId);
    if (!existsSync(path)) return Buffer.alloc(0);
    try {
      const raw = readFileSync(path);
      if (
        raw.length >= ENC_MAGIC.length &&
        raw.subarray(0, ENC_MAGIC.length).toString("latin1") === ENC_MAGIC
      ) {
        return this.unseal(raw);
      }
      return raw;
    } catch {
      // intentional: undecryptable / unreadable history reads as empty, never a crash.
      this.logger?.warn(
        { terminalId, event: "log_unreadable" },
        "terminal-persistence: scrollback log unreadable, treating as empty",
      );
      return Buffer.alloc(0);
    }
  }

  private deleteFiles(terminalId: string): void {
    for (const path of [this.logPath(terminalId), this.sidecarPath(terminalId)]) {
      try {
        rmSync(path, { force: true });
      } catch {
        // intentional: a failed unlink is harmless — boot prune retries next time.
      }
    }
  }

  // ── encryption (reuses the credential-store master key) ────────────────────

  private key(): Buffer {
    if (this.cachedKey) return this.cachedKey;
    this.cachedKey = resolveDaemonMasterKey({
      baseDir: process.env.PASEO_HOME ?? undefined,
      masterKeyBase64: this.masterKeyBase64,
      logger: this.logger,
    });
    return this.cachedKey;
  }

  // Sealed format: MAGIC(8) | iv(12) | tag(16) | ciphertext.
  private seal(plaintext: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([Buffer.from(ENC_MAGIC, "latin1"), iv, tag, data]);
  }

  private unseal(sealed: Buffer): Buffer {
    const off = ENC_MAGIC.length;
    const iv = sealed.subarray(off, off + IV_BYTES);
    const tag = sealed.subarray(off + IV_BYTES, off + IV_BYTES + 16);
    const data = sealed.subarray(off + IV_BYTES + 16);
    const decipher = createDecipheriv(ALGORITHM, this.key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
}

// Block path traversal / separators in the id (ids are server-minted, but defence
// in depth — a persisted file must never escape terminals/).
function safeId(terminalId: string): string {
  return terminalId.replace(/[^A-Za-z0-9._-]/g, "_");
}

function isPersistedMeta(value: unknown): value is PersistedTerminalMeta {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.schemaVersion === SIDECAR_SCHEMA_VERSION &&
    typeof m.terminalId === "string" &&
    typeof m.ownerUserId === "string" &&
    // ownerEmail is OPTIONAL (#874): present on post-#874 sidecars, absent on old
    // ones (which fall back to id-only owner matching). Accept absent or string.
    (m.ownerEmail === undefined || typeof m.ownerEmail === "string") &&
    (m.workspaceId === null || typeof m.workspaceId === "string") &&
    (m.daemonId === null || typeof m.daemonId === "string") &&
    typeof m.cwd === "string" &&
    typeof m.cols === "number" &&
    typeof m.rows === "number" &&
    typeof m.createdAt === "number" &&
    (m.endedAt === null || typeof m.endedAt === "number") &&
    (m.exitCode === null || typeof m.exitCode === "number")
  );
}

export const __testing = {
  MAX_PERSISTED_SESSIONS,
  CLEAN_EXIT_TTL_MS,
  ENC_MAGIC,
  safeId,
  isPersistedMeta,
};

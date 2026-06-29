// Per-daemon encrypted credential store for cybo providers (TRACK B / Phase 1).
//
// Ports opencode's discriminated-union auth model (`~/others/opencode/packages/
// opencode/src/auth/index.ts`) onto the Cyborg7 daemon. The store holds one
// credential per `providerId` (claude, codex, openrouter, minimax, groq, …),
// encrypted at rest with AES-256-GCM. The host-login (`cli`) path stores NOTHING
// and never touches this store — it stays byte-identical to today's behavior.
//
// SHIPS DARK: nothing resolves credentials from here at spawn yet. The injection
// seam (a LATER phase) is the existing `createAgent(config, agentId, { env })`
// parameter (`agent-manager.ts`). This module only provides the store + RPC
// surface. See internal docs (§1, §3) for the full design.
//
// Security invariants (internal docs §6.4):
//   - The store lives under $PASEO_HOME (per-daemon), mode 0600. The key never
//     crosses the relay/PG; the blast radius is one machine.
//   - Never log a key/token/access/refresh. `listCredentialMeta` returns SHAPE
//     ONLY (providerId, type, expires) — never the secret.
//   - A missing/garbled master key or a tampered record is treated as "credential
//     absent" (the cybo falls back to a clear refusal upstream), never a crash.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AuditSink } from "./audit-sink.js";

// #995: optional audit context a credential mutation re-routes its pino line
// through. The store is daemon-global, so the caller (the dispatcher handler, which
// HAS the workspace) supplies the workspaceId the event is scoped to.
export interface CredentialAuditContext {
  sink: AuditSink;
  workspaceId: string;
  userId?: string;
}

// ─── The credential model (mirror opencode's Auth.Info union) ──────────
//
// The discriminator is the credential TYPE (what is stored), distinct from but
// mapped to `cybos.llm_auth_mode` (the cybo-facing power-source choice). See the
// reconciliation table in internal docs (credentialTypeForAuthMode).
//
//   - `cli`        host login — store NOTHING (a `cli` cybo never hits the store)
//   - `api`        API key (OpenRouter, Groq, MiniMax, …)
//   - `oauth`      subscription via OAuth bearer + refresh (Claude Pro/Max, Codex)
//   - `wellknown`  pre-shared key+token pair (parity; no provider needs it day one)

export interface CyboCredentialApi {
  type: "api";
  key: string;
  metadata?: Record<string, string>;
}

export interface CyboCredentialOauth {
  type: "oauth";
  // Short-lived bearer (injected as `Authorization: Bearer`).
  access: string;
  // Long-lived refresh token.
  refresh: string;
  // Expiry as epoch MILLISECONDS (`Date.now() + expires_in * 1000`).
  expires: number;
  // Optional org/account header (Codex/ChatGPT `ChatGPT-Account-Id`).
  accountId?: string;
  // Optional enterprise base URL (self-hosted provider deployments).
  enterpriseUrl?: string;
}

export interface CyboCredentialWellKnown {
  type: "wellknown";
  key: string;
  token: string;
}

// `cli` carries no secret, so it is never persisted; the persisted union is the
// three secret-bearing variants. `CyboCredential` includes `cli` for callers that
// reason about the cybo-facing power source as a whole.
export type StoredCyboCredential =
  | CyboCredentialApi
  | CyboCredentialOauth
  | CyboCredentialWellKnown;

export type CyboCredential = { type: "cli" } | StoredCyboCredential;

export type StoredCredentialType = StoredCyboCredential["type"];

// Metadata view of a stored credential — SHAPE ONLY, never the secret. This is
// what the `cyborg:list_provider_auth` RPC serializes (internal docs §6.2).
export interface CredentialMeta {
  providerId: string;
  type: StoredCredentialType;
  // Present only for `oauth` so the UI can show "expires in 23m / auto-refreshes".
  expires?: number;
}

// ─── Auth-mode ↔ credential-type reconciliation (internal docs) ────
//
// `cybos.llm_auth_mode` is the cybo-facing choice (persisted per cybo, set by the
// wizard). The credential `type` is what's in the store (per provider, per
// daemon). They are related but not equal. This map is the read-time bridge; it
// must respect the EXISTING `api-key` / `managed` values or the wizard breaks.
//
//   llm_auth_mode  → resolved credential type
//   cli            → none (host login; store never consulted)
//   api-key        → "api"
//   oauth          → "oauth"
//   wellknown      → "wellknown"
//   managed        → resolved by workspace (Phase 5) — not handled here

// Maps an `llm_auth_mode` value to the stored credential `type` it resolves to, or
// `null` when no daemon-local credential applies (`cli` host login, or `managed`
// which is a future workspace/PG path). Lenient: unknown modes return `null`.
export function credentialTypeForAuthMode(
  authMode: string | null | undefined,
): StoredCredentialType | null {
  switch (authMode) {
    case "api-key":
      return "api";
    case "oauth":
      return "oauth";
    case "wellknown":
      return "wellknown";
    // "cli" (host login), "managed" (Phase 5), null/undefined, and any unknown
    // value resolve to no daemon-local credential.
    default:
      return null;
  }
}

// ─── Encryption envelope (AES-256-GCM, built fresh) ────────────────────
//
// One authenticated envelope per record, random 12-byte IV per write. Built fresh
// per internal docs — there is no prior AES-256-GCM impl in the repo.

interface EncryptedRecord {
  // Scheme version (forward-compat).
  v: 1;
  // base64, 12 bytes (GCM nonce).
  iv: string;
  // base64, 16-byte GCM auth tag.
  tag: string;
  // base64 ciphertext of JSON.stringify(StoredCyboCredential).
  data: string;
}

const SCHEME_VERSION = 1 as const;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === SCHEME_VERSION &&
    typeof r.iv === "string" &&
    typeof r.tag === "string" &&
    typeof r.data === "string"
  );
}

function encryptCredential(key: Buffer, cred: StoredCyboCredential): EncryptedRecord {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(cred), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: SCHEME_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

// Throws on tamper (bad auth tag) or on a malformed/garbled record. Callers treat
// a throw as "credential absent" — never a crash, never a leak of the bytes.
function decryptCredential(key: Buffer, record: EncryptedRecord): StoredCyboCredential {
  const iv = Buffer.from(record.iv, "base64");
  const tag = Buffer.from(record.tag, "base64");
  const data = Buffer.from(record.data, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
  if (!isStoredCredential(parsed)) {
    throw new Error("decrypted credential failed shape validation");
  }
  return parsed;
}

function isStoredCredential(value: unknown): value is StoredCyboCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  switch (c.type) {
    case "api":
      return typeof c.key === "string";
    case "oauth":
      return (
        typeof c.access === "string" &&
        typeof c.refresh === "string" &&
        typeof c.expires === "number"
      );
    case "wellknown":
      return typeof c.key === "string" && typeof c.token === "string";
    default:
      return false;
  }
}

// ─── The store ─────────────────────────────────────────────────────────
//
// Per-daemon encrypted file at $PASEO_HOME/credentials/auth.json (0600), keyed by
// providerId, with the 32-byte master key at credentials/master.key (0600) OR
// injected via env (prod, KMS). Writes are read-modify-write, serialized through
// an in-process queue to make concurrent ephemeral-cybo spawns safe.

export interface CyboCredentialStoreOptions {
  // Base dir for the credentials directory. Default: $PASEO_HOME, else ~/.cyborg7.
  baseDir?: string;
  // Base64 32-byte master key (env override; prod/KMS path). Default:
  // process.env.CYBORG7_CRED_KEY.
  masterKeyBase64?: string;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

type AuthFileShape = Record<string, EncryptedRecord>;

export class CyboCredentialStore {
  private readonly dir: string;
  private readonly authPath: string;
  private readonly keyPath: string;
  private readonly masterKeyBase64: string | undefined;
  private readonly logger: Pick<Logger, "info" | "warn" | "error"> | undefined;
  // Serializes read-modify-write so parallel spawns don't clobber auth.json.
  private writeChain: Promise<void> = Promise.resolve();
  private cachedKey: Buffer | null = null;

  constructor(options: CyboCredentialStoreOptions = {}) {
    const base = options.baseDir ?? process.env.PASEO_HOME ?? join(homedir(), ".cyborg7");
    this.dir = join(base, "credentials");
    this.authPath = join(this.dir, "auth.json");
    this.keyPath = join(this.dir, "master.key");
    this.masterKeyBase64 = options.masterKeyBase64 ?? process.env.CYBORG7_CRED_KEY;
    this.logger = options.logger;
  }

  // Resolve the 32-byte AES key (internal docs resolution order):
  //   1) env CYBORG7_CRED_KEY (base64, KMS/secrets-manager — prod)
  //   2) master.key file
  //   3) generate 32 random bytes, write master.key 0600 (dev / self-host default)
  // Deliberately does NOT reuse CYBORG7_JWT_SECRET (wrong trust boundary).
  // Public accessor so other per-daemon at-rest stores can reuse the SAME master
  // key (internal docs) instead of forking a second key path. Throws on a
  // missing/garbled env key, same as the internal resolver.
  resolveMasterKey(): Buffer {
    return this.resolveKey();
  }

  private resolveKey(): Buffer {
    if (this.cachedKey) return this.cachedKey;

    if (this.masterKeyBase64) {
      const key = Buffer.from(this.masterKeyBase64, "base64");
      if (key.length !== KEY_BYTES) {
        throw new Error(`CYBORG7_CRED_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
      }
      this.cachedKey = key;
      return key;
    }

    this.ensureDir();
    if (existsSync(this.keyPath)) {
      const key = readFileSync(this.keyPath);
      if (key.length === KEY_BYTES) {
        this.cachedKey = key;
        return key;
      }
      // Garbled key file — fall through to regenerate. Existing records become
      // undecryptable and are treated as absent (logged as an event, not bytes).
      this.logger?.warn(
        { keyBytes: key.length },
        "cybo-credentials: master.key has wrong length, regenerating (existing records become unreadable)",
      );
    }

    const key = randomBytes(KEY_BYTES);
    writeFileSync(this.keyPath, key, { mode: 0o600 });
    chmodSync(this.keyPath, 0o600);
    this.cachedKey = key;
    return key;
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  private readAuthFile(): AuthFileShape {
    if (!existsSync(this.authPath)) return {};
    try {
      const raw = readFileSync(this.authPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return {};
      const out: AuthFileShape = {};
      for (const [providerId, record] of Object.entries(parsed as Record<string, unknown>)) {
        if (isEncryptedRecord(record)) out[providerId] = record;
      }
      return out;
    } catch {
      // A corrupt file is treated as empty (every record absent), never a crash.
      this.logger?.warn(
        { event: "auth_file_unreadable" },
        "cybo-credentials: auth.json unreadable, treating as empty",
      );
      return {};
    }
  }

  private writeAuthFile(data: AuthFileShape): void {
    this.ensureDir();
    // Atomic-ish write: temp + rename so a crash never leaves a half-written file.
    const tmp = `${this.authPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.authPath);
    chmodSync(this.authPath, 0o600);
  }

  // Serialize a read-modify-write mutation through the write chain.
  private enqueue(mutate: () => void): Promise<void> {
    const next = this.writeChain.then(() => mutate());
    // Keep the chain alive even if a mutation throws.
    this.writeChain = next.catch(() => undefined); // intentional: chain-keepalive only; the real error is surfaced via the returned `next`
    return next;
  }

  // Returns the stored credential for a provider, or undefined when absent /
  // tampered / unreadable. `cli` is implicit — it is never stored, so a `cli`
  // provider always returns undefined here (callers must NOT consult the store
  // for `cli`).
  async getCredential(providerId: string): Promise<StoredCyboCredential | undefined> {
    const key = this.resolveKeyOrNull();
    if (!key) return undefined;
    const record = this.readAuthFile()[providerId];
    if (!record) return undefined;
    try {
      return decryptCredential(key, record);
    } catch {
      // Tamper / wrong key / garbled — treat as absent. Log the event, not bytes.
      this.logger?.warn(
        { providerId, event: "credential_undecryptable" },
        "cybo-credentials: stored credential could not be decrypted, treating as absent",
      );
      return undefined;
    }
  }

  // Writes (or replaces) the credential for a provider. NEVER logs the secret.
  async setCredential(
    providerId: string,
    cred: StoredCyboCredential,
    audit?: CredentialAuditContext,
  ): Promise<void> {
    if (!isStoredCredential(cred)) {
      throw new Error("setCredential: invalid credential shape");
    }
    const key = this.resolveKey();
    await this.enqueue(() => {
      const data = this.readAuthFile();
      data[providerId] = encryptCredential(key, cred);
      this.writeAuthFile(data);
    });
    this.logger?.info(
      { providerId, type: cred.type, event: "credential_set" },
      "cybo-credentials: credential stored",
    );
    // #995: re-route onto the Logs-tab audit stream (pino line kept above). The
    // provider id + auth TYPE are safe; the secret value never leaves the store.
    audit?.sink.emit({
      kind: "credential.set",
      category: "daemon_operation",
      level: "info",
      workspaceId: audit.workspaceId,
      userId: audit.userId ?? null,
      source: "credentials",
      message: `Stored ${providerId} credential`,
      payload: { providerId, type: cred.type },
    });
  }

  // Removes the credential for a provider (no-op if absent).
  async removeCredential(providerId: string, audit?: CredentialAuditContext): Promise<void> {
    await this.enqueue(() => {
      const data = this.readAuthFile();
      if (!(providerId in data)) return;
      delete data[providerId];
      this.writeAuthFile(data);
    });
    this.logger?.info(
      { providerId, event: "credential_removed" },
      "cybo-credentials: credential removed",
    );
    audit?.sink.emit({
      kind: "credential.remove",
      category: "daemon_operation",
      level: "info",
      workspaceId: audit.workspaceId,
      userId: audit.userId ?? null,
      source: "credentials",
      message: `Removed ${providerId} credential`,
      payload: { providerId },
    });
  }

  // Returns SHAPE ONLY for every stored credential — never the secret. This backs
  // the `cyborg:list_provider_auth` RPC.
  async listCredentialMeta(): Promise<CredentialMeta[]> {
    const key = this.resolveKeyOrNull();
    if (!key) return [];
    const file = this.readAuthFile();
    const out: CredentialMeta[] = [];
    for (const [providerId, record] of Object.entries(file)) {
      let cred: StoredCyboCredential;
      try {
        cred = decryptCredential(key, record);
      } catch {
        // Skip undecryptable records in the listing (they read as absent).
        continue;
      }
      const meta: CredentialMeta = { providerId, type: cred.type };
      if (cred.type === "oauth") meta.expires = cred.expires;
      out.push(meta);
    }
    return out;
  }

  // Like resolveKey but returns null instead of throwing on a missing/garbled env
  // key — read paths must degrade to "absent", not crash.
  private resolveKeyOrNull(): Buffer | null {
    try {
      return this.resolveKey();
    } catch {
      this.logger?.warn(
        { event: "master_key_unavailable" },
        "cybo-credentials: master key unavailable, treating all records as absent",
      );
      return null;
    }
  }
}

// Exported for tests and for callers that want the dir without a store instance.
export function credentialsDirFor(baseDir?: string): string {
  const base = baseDir ?? process.env.PASEO_HOME ?? join(homedir(), ".cyborg7");
  return join(base, "credentials");
}

export interface MasterKeyOptions {
  // Base dir for the credentials directory. Default: $PASEO_HOME, else ~/.cyborg7.
  baseDir?: string;
  // Base64 32-byte master key (env override; prod/KMS path). Default:
  // process.env.CYBORG7_CRED_KEY.
  masterKeyBase64?: string;
  logger?: Pick<Logger, "info" | "warn" | "error">;
}

// Resolve the SAME per-daemon 32-byte AES master key the credential store uses
// (env CYBORG7_CRED_KEY → credentials/master.key → generate). Exposed so other
// per-daemon at-rest stores (e.g. terminal scrollback persistence, internal docs)
// can REUSE the credential-store key rather than invent a second key path. Throws
// on a missing/garbled env key — callers that must degrade to "absent" should
// catch and treat a throw as "no key available". Side effect: on the file path it
// may create credentials/ (0700) and write master.key (0600) if absent.
export function resolveDaemonMasterKey(options: MasterKeyOptions = {}): Buffer {
  const store = new CyboCredentialStore({
    baseDir: options.baseDir,
    masterKeyBase64: options.masterKeyBase64,
    logger: options.logger,
  });
  return store.resolveMasterKey();
}

// Internal helpers exposed for unit tests (round-trip, tamper). Not part of the
// public store surface.
export const __testing = {
  encryptCredential,
  decryptCredential,
  isStoredCredential,
  isEncryptedRecord,
};

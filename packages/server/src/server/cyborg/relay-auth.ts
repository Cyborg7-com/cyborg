// Auth primitives for the standalone relay: JWT verify/mint, password hashing,
// and agent-access checks. Extracted from relay-standalone.ts (god-file split,
// issue #53) — behaviour-identical, just relocated to a cohesive module.

import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { assertProdJwtSecret, resolveDaemonTokenSecret, verifyJwt } from "./auth.js";
import { isScopeAllowed, type DaemonScope } from "./daemon-scopes.js";
import type { PgSync } from "./db/pg-sync.js";

const JWT_SECRET = process.env.CYBORG7_JWT_SECRET ?? "cyborg7-dev-secret-change-in-production";
// Refuse to boot in production with the public dev default (token-forgery risk).
assertProdJwtSecret(process.env.CYBORG7_JWT_SECRET);

// Shared verifier (auth.ts): timing-safe signature + required, unexpired exp.
export function decodeJwt(token: string): Record<string, unknown> | null {
  return verifyJwt(token, JWT_SECRET);
}

export function validateDaemonToken(token: string): { daemonId: string; ownerId: string } | null {
  // Verify with the PINNED daemon-token secret (CYBORG-58), decoupled from the
  // user-JWT secret so a user-secret rotation never rejects daemon registrations.
  const payload = verifyJwt(token, resolveDaemonTokenSecret());
  if (!payload) return null;
  if (payload.type !== "daemon" || !payload.sub || !payload.owner) return null;
  return { daemonId: payload.sub as string, ownerId: payload.owner as string };
}

// Gate access to an EXISTING agent by the scope the action needs (#705).
// `requiredScope` defaults to "chat" — prompting/messaging/cancelling an agent is
// the low-risk chat capability (the prompt/cancel/permission paths). Agent-control
// ops (set model/mode/thinking, rewind, archive, restore) pass "spawn", so a
// chat-only grantee can talk to an agent but not reconfigure it. `admin` (and the
// daemon owner, mapped to all scopes) satisfies every requirement.
export async function checkAgentAccess(
  pg: PgSync,
  workspaceId: string,
  userId: string,
  agentId: string,
  requiredScope: DaemonScope = "chat",
): Promise<{ allowed: boolean; reason?: string }> {
  const role = await pg.getMemberRole(workspaceId, userId);
  if (!role) return { allowed: false, reason: "not a member of this workspace" };
  if (role === "viewer") return { allowed: false, reason: "viewers cannot interact with agents" };

  const daemonId = await pg.getAgentDaemonId(agentId, workspaceId);
  if (daemonId) {
    const scopes = await pg.getUserDaemonScopes(workspaceId, daemonId, userId);
    if (scopes.size === 0) return { allowed: false, reason: "no access to this daemon" };
    if (!isScopeAllowed(scopes, requiredScope)) {
      return { allowed: false, reason: `requires ${requiredScope} access to this daemon` };
    }
  } else {
    // Agent not mapped to a daemon (degraded path): fall back to the binary
    // any-access check. We can't resolve which daemon to scope-check, so this
    // stays as it was — the agent-control flow always resolves a daemon above.
    const hasAny = await pg.hasAnyDaemonAccess(workspaceId, userId);
    if (!hasAny) return { allowed: false, reason: "no access to any daemon" };
  }
  return { allowed: true };
}

export function validateUserToken(token: string): { email: string; name?: string } | null {
  const payload = decodeJwt(token);
  if (!payload) return null;
  if (typeof payload.email !== "string") return null;
  return { email: payload.email, name: payload.name as string | undefined };
}

export function createUserToken(email: string, name?: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    email,
    name,
    exp: Math.floor(Date.now() / 1000) + 86400 * 30,
    iat: Math.floor(Date.now() / 1000),
  };
  const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const pB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", JWT_SECRET).update(`${hB64}.${pB64}`).digest("base64url");
  return `${hB64}.${pB64}.${sig}`;
}

// Mint a SHORT-LIVED token a superadmin uses to act as another user (impersonate).
// Same HS256 scheme as createUserToken, so validateUserToken (which only reads
// `email`) accepts it transparently — impersonation "just works". The extra
// `imp`/`by` claims (impersonation flag + the REAL admin's user id) are carried
// for audit/debugging only. TTL is short (default 30 min) so a leaked token
// can't outlive the session.
export function createImpersonationToken(
  email: string,
  byUserId: string,
  ttlSec: number = 1800,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    email,
    imp: true,
    by: byUserId,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    iat: Math.floor(Date.now() / 1000),
  };
  const hB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const pB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", JWT_SECRET).update(`${hB64}.${pB64}`).digest("base64url");
  return `${hB64}.${pB64}.${sig}`;
}

// Async scrypt: the sync variant blocked the event loop ~50-100ms per call on
// the auth path, stalling every connected WS during a login burst.
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, 64)).toString("hex");
  return `${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const buf = await scryptAsync(password, salt, 64);
  return timingSafeEqual(buf, Buffer.from(hash, "hex"));
}

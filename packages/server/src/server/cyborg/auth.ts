import { createHmac, timingSafeEqual } from "node:crypto";
import type { DualStorage } from "./dual-storage.js";

export interface CyborgUser {
  id: string;
  email: string;
  name: string | null;
}

export interface CyborgAuthContext {
  user: CyborgUser;
  workspaces: Array<{
    id: string;
    name: string;
    role: string;
  }>;
}

interface JwtPayload {
  sub?: string;
  userId?: string;
  email: string;
  name?: string;
  type?: "user" | "daemon";
  owner?: string;
  exp: number;
  iat?: number;
}

export interface DaemonTokenPayload {
  daemonId: string;
  ownerId: string;
}

const DEFAULT_DEV_SECRET = "cyborg7-dev-secret-change-in-production";

// Constant-time string compare — avoids leaking HMAC bytes via a timing oracle.
// Length mismatch short-circuits to false (length is not the secret being probed).
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Minimum entropy floor for the prod HMAC secret. 32 chars ≈ the 256-bit HMAC-SHA256
// block; a shorter secret is brute-forceable and defeats the whole guard. `openssl
// rand -base64 48` yields 64 chars, comfortably above this.
const MIN_PROD_JWT_SECRET_LEN = 32;

// Fail-fast: never run in production with a weak/default/missing secret. A prod relay
// signs EVERY user + daemon JWT with this one HMAC key, so a guessable secret is a
// full account-takeover + daemon-RCE vector (SEC-AUDIT P0). Reject when NODE_ENV is
// production AND the secret is missing, equals the public source-visible default, or
// is under the entropy floor. Outside production the dev default is allowed for local
// convenience. Throws → the relay/daemon import path (relay-auth.ts calls this at
// module load) fails CLOSED at boot instead of serving forgeable tokens.
export function assertProdJwtSecret(secret: string | undefined | null): void {
  if (process.env.NODE_ENV !== "production") return;
  const tooWeak =
    !secret || secret === DEFAULT_DEV_SECRET || secret.length < MIN_PROD_JWT_SECRET_LEN;
  if (tooWeak) {
    throw new Error(
      `CYBORG7_JWT_SECRET must be a strong secret (>=${MIN_PROD_JWT_SECRET_LEN} chars, not the public dev default) in production — refusing to boot with a forgeable token key.`,
    );
  }
}

// Single source of the HMAC secret shared by every HS256 surface (guest JWTs and
// signed message actions, #600). Same secret means signer == verifier across the
// daemon/relay boundary, so a card signed on one is verifiable on the other.
export function resolveCyborgJwtSecret(): string {
  const secret = process.env.CYBORG7_JWT_SECRET;
  assertProdJwtSecret(secret);
  return secret || DEFAULT_DEV_SECRET;
}

// The DAEMON-token signing secret, PINNED SEPARATELY from the user-JWT secret
// (CYBORG-58). Rotating CYBORG7_JWT_SECRET (user login tokens, the SEC-AUDIT P0
// rotation) must NEVER invalidate daemon relay tokens — the coupling that took the
// whole fleet offline on 2026-07-02. When CYBORG7_DAEMON_TOKEN_SECRET is unset this
// FALLS BACK to the user-JWT secret: that is the transition seam — set
// CYBORG7_DAEMON_TOKEN_SECRET = the CURRENT strong CYBORG7_JWT_SECRET value on the
// first deploy so already-connected daemons (self-minting with the strong secret)
// keep validating against an identical value with zero interruption, then leave it
// UNTOUCHED on future user-secret rotations. Never the public dev default in prod
// (same fail-closed guard as the user secret).
export function resolveDaemonTokenSecret(): string {
  const pinned = process.env.CYBORG7_DAEMON_TOKEN_SECRET;
  if (pinned) {
    assertProdJwtSecret(pinned);
    return pinned;
  }
  return resolveCyborgJwtSecret();
}

// Mint a relay-signed daemon token (CYBORG-58). Standalone so the relay's enroll
// endpoint can issue one from an authenticated USER request without a CyborgAuth
// instance — the daemon never self-signs on the relay path. Signed with the pinned
// daemon-token secret, so a user-secret rotation never invalidates it. `type:"daemon"`
// is what validateDaemonToken requires (a user token can never pass as a daemon token).
export function mintDaemonToken(
  daemonId: string,
  ownerId: string,
  expiresInSecs = 86400 * 365,
): string {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: daemonId,
    type: "daemon" as const,
    owner: ownerId,
    email: `daemon-${daemonId}@local`,
    exp: now + expiresInSecs,
    iat: now,
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", resolveDaemonTokenSecret())
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${signature}`;
}

// Single source of truth for HS256 verification used by both CyborgAuth and the
// standalone relay. Timing-safe signature check + a REQUIRED, numeric, unexpired
// `exp` (a missing or non-numeric exp must NOT pass — otherwise tokens never die).
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  const expectedSig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  if (!timingSafeEqualStr(expectedSig, signatureB64 ?? "")) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64!)) as Record<string, unknown>;
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

export class CyborgAuth {
  private readonly jwtSecret: string;

  constructor(
    private storage: DualStorage,
    jwtSecret?: string,
  ) {
    assertProdJwtSecret(jwtSecret);
    this.jwtSecret = jwtSecret || DEFAULT_DEV_SECRET;
  }

  validateToken(token: string): CyborgAuthContext | null {
    const payload = this.decodeAndVerifyJwt(token);
    if (!payload) return null;

    if (payload.exp < Date.now() / 1000) return null;

    // Resolve the user to a STABLE id. upsertUser now derives a deterministic,
    // email-derived id (and, in connected mode, reconciles SQLite onto PG's real
    // account id) so we never bind to a per-SQLite-file random id whose workspace
    // list is empty. If the token itself carries the canonical account id
    // (`userId`/`sub` minted by the cloud), PREFER it: adopt the local row onto
    // that exact id so getWorkspacesForUser reads the right memberships.
    const upserted = this.storage.upsertUser(payload.email, payload.name);
    const canonicalFromToken = payload.userId ?? payload.sub;
    const user =
      canonicalFromToken && canonicalFromToken !== upserted.id
        ? this.storage.adoptCanonicalUserId(payload.email, canonicalFromToken, payload.name)
        : upserted;
    let workspaces = this.storage.getWorkspacesForUser(user.id);

    if (workspaces.length === 0) {
      this.storage.createWorkspace("My Workspace", user.id);
      workspaces = this.storage.getWorkspacesForUser(user.id);
    }

    return {
      user: { id: user.id, email: user.email, name: user.name },
      workspaces: workspaces.map((ws) => ({
        id: ws.id,
        name: ws.name,
        role: ws.role,
      })),
    };
  }

  createToken(email: string, name?: string, expiresInSecs = 86400 * 30): string {
    const header = { alg: "HS256", typ: "JWT" };
    const payload: JwtPayload = {
      email,
      name,
      exp: Math.floor(Date.now() / 1000) + expiresInSecs,
      iat: Math.floor(Date.now() / 1000),
    };

    const headerB64 = base64UrlEncode(JSON.stringify(header));
    const payloadB64 = base64UrlEncode(JSON.stringify(payload));
    const signature = createHmac("sha256", this.jwtSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64url");

    return `${headerB64}.${payloadB64}.${signature}`;
  }

  createDaemonToken(daemonId: string, ownerId: string, expiresInSecs = 86400 * 365): string {
    return mintDaemonToken(daemonId, ownerId, expiresInSecs);
  }

  validateDaemonToken(token: string): DaemonTokenPayload | null {
    // Verify against the daemon-token secret (CYBORG-58), decoupled from the user
    // secret. NOT decodeAndVerifyJwt (that uses this.jwtSecret = the user secret).
    const payload = verifyJwt(token, resolveDaemonTokenSecret()) as JwtPayload | null;
    if (!payload) return null;
    if (payload.exp < Date.now() / 1000) return null;
    if (payload.type !== "daemon" || !payload.sub || !payload.owner) return null;
    return { daemonId: payload.sub, ownerId: payload.owner };
  }

  private decodeAndVerifyJwt(token: string): JwtPayload | null {
    // Shared verifier enforces timing-safe signature + required, unexpired exp.
    const payload = verifyJwt(token, this.jwtSecret) as JwtPayload | null;
    if (!payload || !payload.email) return null;
    return payload;
  }
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString("base64url");
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf-8");
}

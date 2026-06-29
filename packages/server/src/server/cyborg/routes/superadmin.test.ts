import { describe, it, expect } from "vitest";
import type { Context, Next } from "hono";
import { createSuperadminRoutes } from "./superadmin.js";
import { createImpersonationToken, createUserToken, decodeJwt } from "../relay-auth.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

// The superadmin routes carry the platform's most dangerous privileges
// (grant/revoke superadmin, suspend, soft-delete, impersonate). These tests pin
// the ENFORCEMENT decisions an adversarial review flagged, driving the REAL Hono
// app via createSuperadminRoutes with a typed-fake pg (no live PG) and a stub
// requireAuth that sets a chosen caller id. We assert status codes + that a
// rejected mutation never reaches the pg write (the captured-call sink).

// A simple user shape getUserById returns. deletedAt/suspendedAt live in the
// separate accountStatus map below (getUserById doesn't filter them — the routes
// must guard explicitly).
interface FakeUser {
  id: string;
  email: string;
  name: string | null;
  imageUrl: string | null;
}

interface FakeOpts {
  // The caller's userId (what the stub requireAuth sets) and whether they are a
  // superadmin (drives the requireSuperadmin gate).
  callerId: string;
  callerIsSuperadmin?: boolean;
  // Users getUserById can resolve, keyed by id. Missing id → 404.
  users?: Record<string, FakeUser>;
  // Per-user superadmin flag (isSuperadmin). Caller is added automatically.
  superadmins?: Set<string>;
  // Per-user account status (suspendedAt/deletedAt). Absent → active (both null).
  status?: Record<string, { suspendedAt: Date | null; deletedAt: Date | null }>;
  // The discriminated result revokeSuperadmin returns. Defaults "revoked".
  revokeResult?: "revoked" | "last_superadmin" | "not_superadmin";
}

interface Captured {
  granted: string[];
  revoked: string[];
  suspended: string[];
  softDeleted: string[];
  evicted: string[];
  audits: Array<{ action: string; targetId?: string | null }>;
}

// Build the real Hono app over a typed-fake pg + a stub requireAuth that injects
// `callerId`. The bearer the test sends is what requireSuperadmin actually
// decodes (the imp-claim gate), so each request controls its own authorization
// header; requireAuth here only sets the userId variable.
function makeApp(opts: FakeOpts) {
  const cap: Captured = {
    granted: [],
    revoked: [],
    suspended: [],
    softDeleted: [],
    evicted: [],
    audits: [],
  };
  const superadmins = new Set(opts.superadmins ?? []);
  if (opts.callerIsSuperadmin) superadmins.add(opts.callerId);

  const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
    c.set("userId", opts.callerId);
    c.set("userEmail", opts.users?.[opts.callerId]?.email ?? `${opts.callerId}@e2e.dev`);
    await next();
  };

  const pg = {
    async isSuperadmin(userId: string) {
      return superadmins.has(userId);
    },
    async getUserById(id: string) {
      return opts.users?.[id] ?? null;
    },
    async getAccountStatus(userId: string) {
      return opts.status?.[userId] ?? { suspendedAt: null, deletedAt: null };
    },
    async grantSuperadmin(targetId: string) {
      cap.granted.push(targetId);
    },
    async revokeSuperadmin(targetId: string) {
      cap.revoked.push(targetId);
      return opts.revokeResult ?? "revoked";
    },
    async suspendUser(targetId: string) {
      cap.suspended.push(targetId);
    },
    async softDeleteUser(targetId: string) {
      cap.softDeleted.push(targetId);
    },
    async recordAdminAudit(params: { action: string; targetId?: string | null }) {
      cap.audits.push({ action: params.action, targetId: params.targetId });
    },
  } as unknown as PgSync;

  const app = createSuperadminRoutes({
    pg,
    requireAuth,
    evictUser: (userId: string) => {
      cap.evicted.push(userId);
    },
  });
  return { app, cap };
}

// POST a JSON body with an optional bearer. No bearer → requireSuperadmin's
// decodeJwt sees "" (null payload, no imp claim) and falls through to the
// is-superadmin check, exactly as a normal session would.
function post(
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body: Record<string, unknown>,
  bearer?: string,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return app.request(path, { method: "POST", body: JSON.stringify(body), headers });
}

const SUPER = "u_super";
const OTHER = "u_other";

function user(id: string, email: string): FakeUser {
  return { id, email, name: null, imageUrl: null };
}

describe("superadmin routes — enforcement gates", () => {
  it("(1) a non-superadmin caller gets 403 on a mutation (no write)", async () => {
    const { app, cap } = makeApp({
      callerId: OTHER,
      callerIsSuperadmin: false,
      users: { [SUPER]: user(SUPER, "s@e2e.dev") },
    });

    const res = await post(app, `/api/superadmin/users/${SUPER}/superadmin`, { grant: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "superadmin access required" });
    expect(cap.granted).toHaveLength(0);
  });

  it("(2) self-revoke is rejected with 400 (caller can't strip their own access)", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [SUPER]: user(SUPER, "s@e2e.dev") },
    });

    const res = await post(app, `/api/superadmin/users/${SUPER}/superadmin`, { grant: false });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot revoke your own superadmin" });
    expect(cap.revoked).toHaveLength(0);
  });

  it("(3) a last_superadmin revoke result maps to 400 (can't drop to zero)", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
      revokeResult: "last_superadmin",
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/superadmin`, { grant: false });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot remove the last superadmin" });
    // The atomic UPDATE still ran (it's the source of truth) but no audit row is
    // recorded for a revoke that didn't happen.
    expect(cap.revoked).toEqual([OTHER]);
    expect(cap.audits).toHaveLength(0);
  });

  it("(3b) a successful revoke returns 200 and records the audit", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
      revokeResult: "revoked",
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/superadmin`, { grant: false });

    expect(res.status).toBe(200);
    expect(cap.revoked).toEqual([OTHER]);
    expect(cap.audits).toEqual([{ action: "revoke_superadmin", targetId: OTHER }]);
  });

  it("(4) impersonating a superadmin target is rejected with 403", async () => {
    const { app } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
      superadmins: new Set([OTHER]),
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/impersonate`, {});

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cannot impersonate a superadmin" });
  });

  it("(5) an imp:true bearer is rejected by requireSuperadmin (privilege can't launder)", async () => {
    // The caller IS a superadmin AND requireAuth admits them — the ONLY thing
    // rejecting the request is the imp-claim gate on the raw bearer.
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
    });
    const impToken = createImpersonationToken("s@e2e.dev", SUPER, 1800);

    const res = await post(
      app,
      `/api/superadmin/users/${OTHER}/superadmin`,
      { grant: true },
      impToken,
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "impersonation session cannot use superadmin" });
    expect(cap.granted).toHaveLength(0);
  });

  it("(5b) a NON-imp bearer for the same superadmin passes the gate", async () => {
    // Sanity counterpart to (5): the imp gate must not block an ordinary session.
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
    });
    const plainToken = createUserToken("s@e2e.dev");

    const res = await post(
      app,
      `/api/superadmin/users/${OTHER}/superadmin`,
      { grant: true },
      plainToken,
    );

    expect(res.status).toBe(200);
    expect(cap.granted).toEqual([OTHER]);
  });

  it("(6a) suspending a superadmin target is rejected with 400 (revoke first)", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
      superadmins: new Set([OTHER]),
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/suspend`, { reason: "abuse" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "revoke superadmin first" });
    expect(cap.suspended).toHaveLength(0);
    expect(cap.evicted).toHaveLength(0);
  });

  it("(6b) deleting a superadmin target is rejected with 400 (revoke first)", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
      superadmins: new Set([OTHER]),
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/delete`, {
      confirmEmail: "o@e2e.dev",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "revoke superadmin first" });
    expect(cap.softDeleted).toHaveLength(0);
    expect(cap.evicted).toHaveLength(0);
  });

  it("(6c) a successful suspend evicts live sockets and audits", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/suspend`, { reason: "abuse" });

    expect(res.status).toBe(200);
    expect(cap.suspended).toEqual([OTHER]);
    // The live-socket teardown ran AFTER the DB mutation succeeded.
    expect(cap.evicted).toEqual([OTHER]);
    expect(cap.audits).toEqual([{ action: "suspend_user", targetId: OTHER }]);
  });

  it("(7) delete with a mismatched confirmEmail is rejected with 400 (no write, no evict)", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "real@e2e.dev") },
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/delete`, {
      confirmEmail: "typo@e2e.dev",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "confirmEmail must match the target's email" });
    expect(cap.softDeleted).toHaveLength(0);
    expect(cap.evicted).toHaveLength(0);
  });

  it("(extra) impersonating a suspended target is rejected with 409", async () => {
    const { app } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
      status: { [OTHER]: { suspendedAt: new Date(), deletedAt: null } },
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/impersonate`, {});

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "cannot impersonate a suspended or deleted user",
    });
  });

  it("(extra) granting superadmin to a soft-deleted target is rejected with 400", async () => {
    const { app, cap } = makeApp({
      callerId: SUPER,
      callerIsSuperadmin: true,
      users: { [OTHER]: user(OTHER, "o@e2e.dev") },
      status: { [OTHER]: { suspendedAt: null, deletedAt: new Date() } },
    });

    const res = await post(app, `/api/superadmin/users/${OTHER}/superadmin`, { grant: true });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "cannot grant superadmin to a deleted user" });
    expect(cap.granted).toHaveLength(0);
  });
});

// ─── Impersonation token lifetime ─────────────────────────────────────
// createImpersonationToken must carry a SHORT exp and the imp claim, and an
// expired one must fail verification (decodeJwt → null), so a leaked token can't
// outlive its window. decodeJwt uses verifyJwt, which rejects an exp in the past.
describe("createImpersonationToken — short-lived + verifiable", () => {
  it("sets a short exp (≈ttl from now) and the imp/by claims", () => {
    const ttl = 1800;
    const before = Math.floor(Date.now() / 1000);
    const token = createImpersonationToken("victim@e2e.dev", "u_admin", ttl);
    const after = Math.floor(Date.now() / 1000);

    const payload = decodeJwt(token);
    expect(payload).not.toBeNull();
    expect(payload?.imp).toBe(true);
    expect(payload?.by).toBe("u_admin");
    expect(payload?.email).toBe("victim@e2e.dev");
    const exp = payload?.exp as number;
    // exp is within [before+ttl, after+ttl] — a tight, short-lived window.
    expect(exp).toBeGreaterThanOrEqual(before + ttl);
    expect(exp).toBeLessThanOrEqual(after + ttl);
  });

  it("an EXPIRED impersonation token fails decodeJwt/verifyJwt", () => {
    // A negative ttl puts exp in the past, so verifyJwt's exp check rejects it.
    const expired = createImpersonationToken("victim@e2e.dev", "u_admin", -60);
    expect(decodeJwt(expired)).toBeNull();
  });
});

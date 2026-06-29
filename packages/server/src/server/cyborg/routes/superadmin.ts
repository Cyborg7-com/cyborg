import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { PgSync } from "../db/pg-sync.js";
import { createImpersonationToken, decodeJwt } from "../relay-auth.js";
import type { RelayEnv, RequireAuth } from "./types.js";

export interface SuperadminRoutesDeps {
  pg: PgSync;
  requireAuth: RequireAuth;
  // Drop EVERY live WebSocket for a userId immediately (suspend/soft-delete must
  // not wait for the victim to reconnect). Implemented at the mount site over the
  // relay's live `guests` map, mirroring the cyborg:delete_account teardown.
  evictUser: (userId: string) => void;
  // Live-unsubscribe EVERY connected member from a disabled workspace WITHOUT
  // closing their socket (they may be in other workspaces). Implemented at the
  // mount site over the relay's live `guestSubs`/`guests` maps. Their next
  // workspace-scoped op then hits the "not a member" path → client refresh →
  // getWorkspacesForUser excludes the now-disabled org.
  evictWorkspace: (workspaceId: string) => void;
}

// Impersonation tokens are SHORT-LIVED (default 30 min) so a leaked one can't
// outlive the admin's session. Surfaced to the client so the UI knows the window.
const IMPERSONATION_TTL_SEC = 1800;

// Allowlists for the few mutation bodies that carry a constrained enum. Defined
// once so the route handlers stay declarative and a bad value is rejected with a
// 400 before it reaches the DB (never trust a client claim).
const VALID_PLANS = new Set(["free", "pro"]);
const VALID_SUBSCRIPTION_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
]);
const VALID_MEMBER_ROLES = new Set(["owner", "admin", "member", "viewer"]);

// Superadmin admin surface (#superadmin). A self-contained Hono sub-app mounted
// in relay-standalone.ts next to the other route factories:
// `app.route("/", createSuperadminRoutes({ pg: pg!, requireAuth }))`. Mirrors
// routes/workspace-rest.ts + routes/stripe.ts: the factory takes a non-null `pg`
// (the caller asserts it once at the mount site) and the relay's `requireAuth`
// middleware, so each handler stays a pure sub-app.
//
// Security model: every privileged endpoint goes through `requireSuperadmin`,
// which re-checks the DB on EVERY request (never a cached/claimed flag). A
// suspended/deleted superadmin is already rejected at `requireAuth` (see
// relay-standalone.ts), so revoking/suspending an admin removes their access on
// the next request. Every mutation records an admin_audit_log row attributed to
// the REAL caller (c.get("userId")) — for impersonation that is the admin, not
// the impersonated user.
export function createSuperadminRoutes(deps: SuperadminRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth, evictUser, evictWorkspace } = deps;
  const app = new Hono<RelayEnv>();

  // Gate every privileged endpoint: run requireAuth first (resolves + blocks
  // suspended/deleted users), then re-confirm superadmin status against the DB.
  // Defined inside the factory so it closes over the injected `pg`.
  async function requireSuperadmin(c: Context<RelayEnv>, next: Next): Promise<Response | void> {
    // An impersonation session must NEVER satisfy a superadmin gate, even though
    // the underlying token validates as the (real) admin's identity for ordinary
    // access. Decode the RAW bearer and reject on the `imp` claim BEFORE the
    // is-superadmin check — otherwise an admin impersonating themselves (or a
    // leaked imp token) would launder full superadmin privilege. Normal access as
    // the impersonated user is unaffected; only this gate rejects imp tokens.
    const payload = decodeJwt(c.req.header("authorization")?.slice(7) ?? "");
    if (payload?.imp === true) {
      return c.json({ error: "impersonation session cannot use superadmin" }, 403);
    }
    if (!(await pg.isSuperadmin(c.get("userId")))) {
      return c.json({ error: "superadmin access required" }, 403);
    }
    await next();
  }

  // ─── Self check (authed, NOT superadmin-gated) ────────────────────
  // Lets the UI decide whether to render the admin surface without leaking any
  // platform data to a non-superadmin.
  app.get("/api/superadmin/me", requireAuth, async (c) => {
    return c.json({ isSuperadmin: await pg.isSuperadmin(c.get("userId")) });
  });

  // ─── Read-only platform metrics + listings ────────────────────────

  app.get("/api/superadmin/overview", requireAuth, requireSuperadmin, async (c) => {
    return c.json(await pg.getSuperadminOverview());
  });

  app.get("/api/superadmin/orgs", requireAuth, requireSuperadmin, async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const offset = clampOffset(c.req.query("offset"));
    const search = clampSearch(c.req.query("search"));
    return c.json(await pg.listOrgs({ limit, offset, search }));
  });

  app.get("/api/superadmin/orgs/:id", requireAuth, requireSuperadmin, async (c) => {
    const detail = await pg.getOrgDetail(c.req.param("id"));
    if (!detail) return c.json({ error: "workspace not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/superadmin/users", requireAuth, requireSuperadmin, async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const offset = clampOffset(c.req.query("offset"));
    const search = clampSearch(c.req.query("search"));
    return c.json(await pg.listUsersAdmin({ limit, offset, search }));
  });

  app.get("/api/superadmin/users/:id", requireAuth, requireSuperadmin, async (c) => {
    const detail = await pg.getUserDetailAdmin(c.req.param("id"));
    if (!detail) return c.json({ error: "user not found" }, 404);
    return c.json(detail);
  });

  app.get("/api/superadmin/admins", requireAuth, requireSuperadmin, async (c) => {
    return c.json({ admins: await pg.listSuperadmins() });
  });

  app.get("/api/superadmin/audit", requireAuth, requireSuperadmin, async (c) => {
    const limit = clampLimit(c.req.query("limit"));
    const beforeRaw = c.req.query("before");
    const before = beforeRaw !== undefined ? Number.parseInt(beforeRaw, 10) : undefined;
    return c.json({
      entries: await pg.listAdminAudit({
        limit,
        before: before !== undefined && Number.isFinite(before) ? before : undefined,
      }),
    });
  });

  // ─── Superadmin grant / revoke ────────────────────────────────────
  // Two hard guards, exactly as specced: a caller can never revoke their OWN
  // superadmin, and the system can never drop to zero active superadmins.
  app.post("/api/superadmin/users/:id/superadmin", requireAuth, requireSuperadmin, async (c) => {
    const targetId = c.req.param("id");
    const callerId = c.get("userId");
    const body = await readJson<{ grant?: unknown }>(c);
    if (typeof body.grant !== "boolean") {
      return c.json({ error: "grant (boolean) required" }, 400);
    }
    const grant = body.grant;

    const target = await pg.getUserById(targetId);
    if (!target) return c.json({ error: "user not found" }, 404);

    if (grant) {
      // Never grant superadmin to a soft-deleted account (getUserById doesn't
      // filter deletedAt, so a deleted row still resolves here).
      const status = await pg.getAccountStatus(targetId);
      if (status?.deletedAt) {
        return c.json({ error: "cannot grant superadmin to a deleted user" }, 400);
      }
      // TODO(superadmin): make mutation+audit atomic
      await pg.grantSuperadmin(targetId, callerId);
    } else {
      // Self-revoke is always rejected (a caller can't strip their own access).
      if (targetId === callerId) {
        return c.json({ error: "cannot revoke your own superadmin" }, 400);
      }
      // The last-superadmin guard lives INSIDE revokeSuperadmin as a single
      // atomic UPDATE — two concurrent cross-revokes can't both win and drop the
      // count to zero. The non-atomic countSuperadmins()/isSuperadmin() pre-check
      // is gone; we act on the discriminated result instead.
      // TODO(superadmin): make mutation+audit atomic
      const result = await pg.revokeSuperadmin(targetId, callerId);
      if (result === "last_superadmin") {
        return c.json({ error: "cannot remove the last superadmin" }, 400);
      }
      // A no-op revoke (target wasn't a superadmin) must NOT record a spurious
      // "revoke_superadmin" audit row or report success — reject it.
      if (result === "not_superadmin") {
        return c.json({ error: "user is not a superadmin" }, 400);
      }
    }
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: grant ? "grant_superadmin" : "revoke_superadmin",
      targetType: "user",
      targetId,
    });
    return c.json({ isSuperadmin: await pg.isSuperadmin(targetId) });
  });

  // ─── Suspend / unsuspend ──────────────────────────────────────────
  app.post("/api/superadmin/users/:id/suspend", requireAuth, requireSuperadmin, async (c) => {
    const targetId = c.req.param("id");
    const callerId = c.get("userId");
    const body = await readJson<{ reason?: unknown }>(c);
    // Reason is OPTIONAL (the column is nullable and the UI labels it optional):
    // an empty/absent reason stores NULL rather than blocking the suspend.
    const reasonText = typeof body.reason === "string" ? body.reason.trim() : "";
    const reason = reasonText || null;

    const target = await pg.getUserById(targetId);
    if (!target) return c.json({ error: "user not found" }, 404);
    if (targetId === callerId) return c.json({ error: "cannot suspend yourself" }, 400);
    if (await pg.isSuperadmin(targetId)) {
      return c.json({ error: "revoke superadmin first" }, 400);
    }

    // TODO(superadmin): make mutation+audit atomic
    await pg.suspendUser(targetId, reason, callerId);
    // Drop every live socket for this user NOW — a suspend that only takes effect
    // on reconnect is effectively a no-op for an already-connected cloud session
    // (the UI runs over WS). Their next reconnect is re-blocked at auth.
    evictUser(targetId);
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: "suspend_user",
      targetType: "user",
      targetId,
      details: { reason },
    });
    return c.json({ ok: true });
  });

  app.post("/api/superadmin/users/:id/unsuspend", requireAuth, requireSuperadmin, async (c) => {
    const targetId = c.req.param("id");
    const callerId = c.get("userId");

    const target = await pg.getUserById(targetId);
    if (!target) return c.json({ error: "user not found" }, 404);

    await pg.unsuspendUser(targetId);
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: "unsuspend_user",
      targetType: "user",
      targetId,
    });
    return c.json({ ok: true });
  });

  // ─── Soft delete ──────────────────────────────────────────────────
  // SOFT delete only (sets deleted_at; the row is never removed — it is the FK
  // target of memberships/messages/daemons). confirmEmail must match the
  // target's email exactly (typo guard against deleting the wrong account).
  app.post("/api/superadmin/users/:id/delete", requireAuth, requireSuperadmin, async (c) => {
    const targetId = c.req.param("id");
    const callerId = c.get("userId");
    const body = await readJson<{ confirmEmail?: unknown }>(c);
    const confirmEmail =
      typeof body.confirmEmail === "string" ? body.confirmEmail.trim().toLowerCase() : "";

    const target = await pg.getUserById(targetId);
    if (!target) return c.json({ error: "user not found" }, 404);
    if (targetId === callerId) return c.json({ error: "cannot delete yourself" }, 400);
    if (await pg.isSuperadmin(targetId)) {
      return c.json({ error: "revoke superadmin first" }, 400);
    }
    if (!confirmEmail || confirmEmail !== target.email.trim().toLowerCase()) {
      return c.json({ error: "confirmEmail must match the target's email" }, 400);
    }

    // TODO(superadmin): make mutation+audit atomic
    await pg.softDeleteUser(targetId, callerId);
    // Same live-teardown as suspend: a soft-deleted user's open sockets must be
    // dropped immediately (their next PG-backed RPC would fail anyway) rather
    // than lingering until they reconnect.
    evictUser(targetId);
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: "delete_user",
      targetType: "user",
      targetId,
      details: { email: target.email },
    });
    return c.json({ ok: true });
  });

  // ─── Workspace plan override ──────────────────────────────────────
  app.post("/api/superadmin/workspaces/:wid/plan", requireAuth, requireSuperadmin, async (c) => {
    const workspaceId = c.req.param("wid");
    const callerId = c.get("userId");
    const body = await readJson<{ plan?: unknown; status?: unknown }>(c);
    const plan = typeof body.plan === "string" ? body.plan : "";
    if (!VALID_PLANS.has(plan)) return c.json({ error: "plan must be one of: free, pro" }, 400);
    let status: string | undefined;
    if (body.status !== undefined) {
      if (typeof body.status !== "string" || !VALID_SUBSCRIPTION_STATUSES.has(body.status)) {
        return c.json({ error: "invalid status" }, 400);
      }
      status = body.status;
    }

    const result = await pg.setSubscriptionPlan(workspaceId, plan, status);
    if (result === "not_found") {
      return c.json({ error: "workspace has no subscription to change" }, 404);
    }
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: "change_plan",
      targetType: "workspace",
      targetId: workspaceId,
      details: { plan, ...(status ? { status } : {}) },
    });
    return c.json({ ok: true });
  });

  // ─── Workspace disable / enable (moderation) ──────────────────────
  // Disable sets workspaces.disabled_at — the org drops out of every member's
  // listing (getWorkspacesForUser filters it) and can't be (re)subscribed to (the
  // relay rejects subscribe_workspace). The row is NEVER deleted; enable clears
  // the columns. Reason is OPTIONAL (the column is nullable) — an empty/absent
  // reason stores NULL rather than blocking the disable.
  app.post("/api/superadmin/workspaces/:wid/disable", requireAuth, requireSuperadmin, async (c) => {
    const workspaceId = c.req.param("wid");
    const callerId = c.get("userId");
    const body = await readJson<{ reason?: unknown }>(c);
    const reasonText = typeof body.reason === "string" ? body.reason.trim() : "";
    const reason = reasonText || null;

    // 404 if the workspace doesn't exist (getWorkspaceOwnerId returns null then).
    if ((await pg.getWorkspaceOwnerId(workspaceId)) === null) {
      return c.json({ error: "workspace not found" }, 404);
    }

    // TODO(superadmin): make mutation+audit atomic
    await pg.disableWorkspace(workspaceId, reason, callerId);
    // Live-unsubscribe every connected member NOW — a disable that only takes
    // effect on reconnect is a no-op for an already-open cloud session.
    evictWorkspace(workspaceId);
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: "disable_workspace",
      targetType: "workspace",
      targetId: workspaceId,
      details: { reason },
    });
    return c.json({ ok: true });
  });

  app.post("/api/superadmin/workspaces/:wid/enable", requireAuth, requireSuperadmin, async (c) => {
    const workspaceId = c.req.param("wid");
    const callerId = c.get("userId");

    if ((await pg.getWorkspaceOwnerId(workspaceId)) === null) {
      return c.json({ error: "workspace not found" }, 404);
    }

    await pg.enableWorkspace(workspaceId);
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: "enable_workspace",
      targetType: "workspace",
      targetId: workspaceId,
    });
    return c.json({ ok: true });
  });

  // ─── Workspace member role override ───────────────────────────────
  app.post(
    "/api/superadmin/workspaces/:wid/members/:uid/role",
    requireAuth,
    requireSuperadmin,
    async (c) => {
      const workspaceId = c.req.param("wid");
      const targetUserId = c.req.param("uid");
      const callerId = c.get("userId");
      const body = await readJson<{ role?: unknown }>(c);
      const role = typeof body.role === "string" ? body.role : "";
      if (!VALID_MEMBER_ROLES.has(role)) {
        return c.json({ error: "role must be one of: owner, admin, member, viewer" }, 400);
      }

      if (!(await pg.isMember(workspaceId, targetUserId))) {
        return c.json({ error: "user is not a member of this workspace" }, 404);
      }

      await pg.updateMemberRole(workspaceId, targetUserId, role);
      await pg.recordAdminAudit({
        actorUserId: callerId,
        action: "set_member_role",
        targetType: "workspace",
        targetId: workspaceId,
        details: { userId: targetUserId, role },
      });
      return c.json({ ok: true });
    },
  );

  // ─── Impersonate ──────────────────────────────────────────────────
  // Mints a SHORT-LIVED token for the target's email. validateUserToken only
  // reads `email`, so impersonation "just works"; the extra imp/by claims are for
  // audit. The audit row is attributed to the REAL admin (callerId).
  app.post("/api/superadmin/users/:id/impersonate", requireAuth, requireSuperadmin, async (c) => {
    const targetId = c.req.param("id");
    const callerId = c.get("userId");

    const target = await pg.getUserById(targetId);
    if (!target) return c.json({ error: "user not found" }, 404);

    // Never mint an impersonation session for a privileged identity: a superadmin
    // session laundered through impersonation would dodge the imp-token gate on
    // requireSuperadmin and re-acquire full admin as someone else.
    if (await pg.isSuperadmin(targetId)) {
      return c.json({ error: "cannot impersonate a superadmin" }, 403);
    }
    // Never mint a session for a deactivated identity (getUserById doesn't filter
    // suspended/deletedAt). A suspended/soft-deleted account is gone — 409.
    const status = await pg.getAccountStatus(targetId);
    if (status?.suspendedAt || status?.deletedAt) {
      return c.json({ error: "cannot impersonate a suspended or deleted user" }, 409);
    }

    const token = createImpersonationToken(target.email, callerId, IMPERSONATION_TTL_SEC);
    await pg.recordAdminAudit({
      actorUserId: callerId,
      action: "impersonate",
      targetType: "user",
      targetId,
      details: { targetEmail: target.email },
    });
    return c.json({
      token,
      user: { id: target.id, email: target.email, name: target.name },
      expiresInSec: IMPERSONATION_TTL_SEC,
    });
  });

  return app;
}

// Parse a JSON body, tolerating an empty/malformed one (returns {}). Mirrors the
// `.catch(() => ({}))` pattern in routes/stripe.ts so a missing body becomes a
// validation 400 rather than a 500.
async function readJson<T extends Record<string, unknown>>(c: Context<RelayEnv>): Promise<T> {
  return c.req.json<T>().catch(() => ({}) as T);
}

// List paging: default 50, clamped to [1, 200] so a hostile/typo'd limit can't
// scan the whole table in one request.
function clampLimit(raw: string | undefined): number {
  const n = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(n, 1), 200);
}

function clampOffset(raw: string | undefined): number {
  const n = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

// Trim + cap the free-text search term at 256 chars. Empty → undefined (no
// filter). The cap is cheap DoS hardening: a megabyte-long ILIKE term can't be
// pushed into the query planner.
const MAX_SEARCH_LEN = 256;
function clampSearch(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_SEARCH_LEN);
}

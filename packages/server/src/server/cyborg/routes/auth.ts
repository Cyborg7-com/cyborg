import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { PgSync } from "../db/pg-sync.js";
import {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  otpExpiry,
  sendOtpEmail,
  OTP_MAX_ATTEMPTS,
  resendCooldownRemainingMs,
} from "../email-otp.js";
import type { RelayEnv } from "./types.js";

export interface AuthRoutesDeps {
  pg: PgSync | null;
  // Injected (not moved) because these are shared with the WS layer / global
  // broadcast and crypto that stay in relay-standalone.ts.
  broadcastToGuests: (workspaceId: string, message: Record<string, unknown>, seq?: number) => void;
  hashPassword: (password: string) => Promise<string>;
  verifyPassword: (password: string, stored: string) => Promise<boolean>;
  createUserToken: (email: string, name?: string) => string;
}

// Email/password auth (OTP signup, login, password reset, change password).
// Extracted from relay-standalone.ts (compositor) as a mounted Hono sub-app —
// see `app.route("/", createAuthRoutes(...))`. Pure mechanical move.
export function createAuthRoutes(deps: AuthRoutesDeps): Hono<RelayEnv> {
  const { pg, broadcastToGuests, hashPassword, verifyPassword, createUserToken } = deps;
  const app = new Hono<RelayEnv>();

  // Provision an existing passwordless (invite-only / OAuth) user who is now
  // setting a password via signup-verify: set the hash, activate invites,
  // create their personal workspace, and return a session. Split out of the
  // register/verify handler to keep its cyclomatic complexity within the lint
  // budget; behavior matches the previous inline branch.
  async function provisionPasswordlessUser(
    db: PgSync,
    otp: NonNullable<Awaited<ReturnType<PgSync["getOtp"]>>>,
    email: string,
    existing: NonNullable<Awaited<ReturnType<PgSync["getUserByEmail"]>>>,
    passwordHash: string,
  ) {
    const displayName = otp.name ?? existing.name ?? email.split("@")[0];
    await db.setPasswordHash(existing.id, passwordHash);
    if (otp.name) await db.upsertUser(existing.id, email, otp.name);

    const activatedWs = await db.activateInvitedMemberships(existing.id);
    for (const wsId of activatedWs) {
      const members = await db.getMembers(wsId);
      broadcastToGuests(wsId, {
        type: "cyborg:members_updated",
        payload: { workspaceId: wsId, members },
      });
    }

    const personalWsId = randomUUID();
    await db.createWorkspace(personalWsId, `${displayName}'s Workspace`, existing.id);
    await db.addMember(personalWsId, existing.id, "owner", "active");

    const workspaces = await db.getWorkspacesForUser(existing.id);
    const token = createUserToken(email, displayName);
    return {
      token,
      user: { id: existing.id, email, name: otp.name ?? existing.name },
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    };
  }

  // Step 1 of signup: validate the new account, email a 6-digit OTP, and stash
  // the pending account (name + pre-hashed password) until the code is verified.
  // No user/workspace is created here — only after /register/verify succeeds.
  app.post("/api/auth/register/start", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = await c.req.json<{
      email?: string;
      password?: string;
      name?: string;
    }>();
    if (!body.email || !body.password) return c.json({ error: "email and password required" }, 400);
    if (body.password.length < 6)
      return c.json({ error: "password must be at least 6 characters" }, 400);

    const email = body.email.trim().toLowerCase();
    const existing = await pg.getUserByEmail(email);
    if (existing && existing.passwordHash) {
      return c.json({ error: "email already registered" }, 409);
    }

    // Anti-spam: refuse a fresh code if one was just sent (resend has its own
    // endpoint, but a fast double-submit of "start" shouldn't email twice).
    const pendingStart = await pg.getOtp(email);
    if (pendingStart) {
      const wait = resendCooldownRemainingMs(pendingStart.createdAt);
      if (wait > 0)
        return c.json(
          { error: "please wait before requesting another code", retryAfterMs: wait },
          429,
        );
    }

    const code = generateOtpCode();
    await pg.upsertOtp({
      email,
      codeHash: hashOtpCode(code),
      name: body.name ?? null,
      passwordHash: await hashPassword(body.password),
      expiresAt: otpExpiry(),
      purpose: "signup",
    });

    try {
      const result = await sendOtpEmail(email, code);
      return c.json({ otpSent: true, ...(result.devCode ? { devCode: result.devCode } : {}) });
    } catch (err) {
      console.error("[auth] failed to send OTP email:", err);
      await pg.deleteOtp(email);
      return c.json({ error: "failed to send verification email" }, 502);
    }
  });

  // Step 2 of signup: verify the OTP and, on success, create the user, their
  // personal workspace, activate any pending invitations, and return a token.
  app.post("/api/auth/register/verify", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = await c.req.json<{ email?: string; code?: string }>();
    if (!body.email || !body.code) return c.json({ error: "email and code required" }, 400);

    const email = body.email.trim().toLowerCase();
    const otp = await pg.getOtp(email);
    if (!otp || otp.purpose !== "signup")
      return c.json({ error: "no pending verification for this email" }, 400);

    if (otp.expiresAt.getTime() < Date.now()) {
      await pg.deleteOtp(email);
      return c.json({ error: "verification code expired" }, 400);
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await pg.deleteOtp(email);
      return c.json({ error: "too many attempts, request a new code" }, 429);
    }
    if (!verifyOtpCode(body.code, otp.codeHash)) {
      const attempts = await pg.bumpOtpAttempts(email);
      const remaining = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
      return c.json({ error: "invalid code", attemptsRemaining: remaining }, 400);
    }

    // Code is valid — consume it and provision the account.
    await pg.deleteOtp(email);
    const passwordHash = otp.passwordHash ?? (await hashPassword(randomUUID()));
    const existing = await pg.getUserByEmail(email);

    if (existing && existing.passwordHash) {
      // Raced with another registration that already set a password.
      return c.json({ error: "email already registered" }, 409);
    }

    if (existing && !existing.passwordHash) {
      // An existing (passwordless/invite-only) account that a superadmin has
      // suspended or soft-deleted must NOT be able to mint a session by setting a
      // password — block before provisionPasswordlessUser issues a token.
      const status = await pg.getAccountStatus(existing.id);
      if (status?.suspendedAt || status?.deletedAt) {
        return c.json({ error: "account suspended" }, 403);
      }
      return c.json(await provisionPasswordlessUser(pg, otp, email, existing, passwordHash));
    }

    const userId = randomUUID();
    await pg.upsertUser(userId, email, otp.name ?? null);
    await pg.setPasswordHash(userId, passwordHash);

    const workspaceId = randomUUID();
    await pg.createWorkspace(workspaceId, "My Workspace", userId);
    await pg.addMember(workspaceId, userId, "owner", "active");

    const token = createUserToken(email, otp.name ?? undefined);
    return c.json({
      token,
      user: { id: userId, email, name: otp.name ?? null },
      workspaces: [{ id: workspaceId, name: "My Workspace", role: "owner" }],
    });
  });

  // Resend the signup verification code. Re-issues a fresh code for a PENDING
  // signup (no password is required — the pending account's data is reused),
  // gated by a cooldown so it can't be used to spam an inbox.
  app.post("/api/auth/register/resend", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = await c.req.json<{ email?: string }>();
    if (!body.email) return c.json({ error: "email required" }, 400);
    const email = body.email.trim().toLowerCase();

    const pending = await pg.getOtp(email);
    // No pending signup → nothing to resend. Don't reveal whether the email is
    // known; just report sent (avoids enumeration). Only genuinely resend when
    // a signup is actually pending.
    if (!pending || pending.purpose !== "signup") {
      return c.json({ otpSent: true });
    }
    const wait = resendCooldownRemainingMs(pending.createdAt);
    if (wait > 0) {
      return c.json(
        { error: "please wait before requesting another code", retryAfterMs: wait },
        429,
      );
    }

    const code = generateOtpCode();
    await pg.upsertOtp({
      email,
      codeHash: hashOtpCode(code),
      name: pending.name,
      passwordHash: pending.passwordHash,
      expiresAt: otpExpiry(),
      purpose: "signup",
    });
    try {
      const result = await sendOtpEmail(email, code, "signup");
      return c.json({ otpSent: true, ...(result.devCode ? { devCode: result.devCode } : {}) });
    } catch (err) {
      console.error("[auth] failed to resend OTP email:", err);
      return c.json({ error: "failed to send verification email" }, 502);
    }
  });

  // Forgot password — step 1: issue a reset code to an existing account.
  // Always returns 200 (no user enumeration); only actually emails when the
  // account exists with a password. Cooldown-gated like the other sends.
  app.post("/api/auth/password/reset/start", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = await c.req.json<{ email?: string }>();
    if (!body.email) return c.json({ error: "email required" }, 400);
    const email = body.email.trim().toLowerCase();

    const user = await pg.getUserByEmail(email);
    if (!user || !user.passwordHash) {
      // Unknown / passwordless (OAuth-only) account — pretend success.
      return c.json({ otpSent: true });
    }

    const pending = await pg.getOtp(email);
    if (pending) {
      const wait = resendCooldownRemainingMs(pending.createdAt);
      if (wait > 0)
        return c.json(
          { error: "please wait before requesting another code", retryAfterMs: wait },
          429,
        );
    }

    const code = generateOtpCode();
    await pg.upsertOtp({
      email,
      codeHash: hashOtpCode(code),
      name: user.name,
      passwordHash: null, // reset flow sets the NEW password at verify time
      expiresAt: otpExpiry(),
      purpose: "reset",
    });
    try {
      const result = await sendOtpEmail(email, code, "reset");
      return c.json({ otpSent: true, ...(result.devCode ? { devCode: result.devCode } : {}) });
    } catch (err) {
      console.error("[auth] failed to send reset email:", err);
      await pg.deleteOtp(email);
      return c.json({ error: "failed to send reset email" }, 502);
    }
  });

  // Forgot password — step 2: verify the reset code + set the new password.
  // On success the code is consumed and a fresh session token is returned
  // (auto sign-in), matching the signup-verify behavior.
  app.post("/api/auth/password/reset/verify", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = await c.req.json<{ email?: string; code?: string; newPassword?: string }>();
    if (!body.email || !body.code || !body.newPassword)
      return c.json({ error: "email, code and newPassword required" }, 400);
    if (body.newPassword.length < 6)
      return c.json({ error: "password must be at least 6 characters" }, 400);

    const email = body.email.trim().toLowerCase();
    const otp = await pg.getOtp(email);
    if (!otp || otp.purpose !== "reset")
      return c.json({ error: "no pending reset for this email" }, 400);
    if (otp.expiresAt.getTime() < Date.now()) {
      await pg.deleteOtp(email);
      return c.json({ error: "reset code expired" }, 400);
    }
    if (otp.attempts >= OTP_MAX_ATTEMPTS) {
      await pg.deleteOtp(email);
      return c.json({ error: "too many attempts, request a new code" }, 429);
    }
    if (!verifyOtpCode(body.code, otp.codeHash)) {
      const attempts = await pg.bumpOtpAttempts(email);
      return c.json(
        { error: "invalid code", attemptsRemaining: Math.max(0, OTP_MAX_ATTEMPTS - attempts) },
        400,
      );
    }

    const user = await pg.getUserByEmail(email);
    if (!user) {
      await pg.deleteOtp(email);
      return c.json({ error: "account no longer exists" }, 400);
    }
    // A suspended/soft-deleted account can still hold a valid reset code — block
    // here so a password reset can't be used to recover access to a deactivated
    // account (the token mint below would otherwise hand back a live session).
    const status = await pg.getAccountStatus(user.id);
    if (status?.suspendedAt || status?.deletedAt) {
      await pg.deleteOtp(email);
      return c.json({ error: "account suspended" }, 403);
    }
    await pg.deleteOtp(email);
    await pg.setPasswordHash(user.id, await hashPassword(body.newPassword));

    const workspaces = await pg.getWorkspacesForUser(user.id);
    const token = createUserToken(user.email, user.name ?? undefined);
    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    });
  });

  app.post("/api/auth/login", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = await c.req.json<{ email?: string; password?: string }>();
    if (!body.email || !body.password) return c.json({ error: "email and password required" }, 400);

    const user = await pg.getUserByEmail(body.email);
    if (!user || !user.passwordHash) return c.json({ error: "invalid credentials" }, 401);
    if (!(await verifyPassword(body.password, user.passwordHash)))
      return c.json({ error: "invalid credentials" }, 401);

    // Credentials are correct, but a suspended/soft-deleted account must not get a
    // session. Checked AFTER password verification so it doesn't leak account
    // status to an unauthenticated caller (same 401-then-403 ordering the REST
    // requireAuth path follows).
    const status = await pg.getAccountStatus(user.id);
    if (status?.suspendedAt || status?.deletedAt) {
      return c.json({ error: "account suspended" }, 403);
    }

    const activatedWs = await pg.activateInvitedMemberships(user.id);
    for (const wsId of activatedWs) {
      const members = await pg.getMembers(wsId);
      broadcastToGuests(wsId, {
        type: "cyborg:members_updated",
        payload: { workspaceId: wsId, members },
      });
    }
    const workspaces = await pg.getWorkspacesForUser(user.id);
    const token = createUserToken(user.email, user.name ?? undefined);
    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        role: w.role,
      })),
    });
  });

  app.post("/api/auth/change-password", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const body = await c.req.json<{
      email?: string;
      currentPassword?: string;
      newPassword?: string;
    }>();
    if (!body.email || !body.currentPassword || !body.newPassword)
      return c.json({ error: "email, currentPassword, and newPassword required" }, 400);
    if (body.newPassword.length < 6)
      return c.json({ error: "newPassword must be at least 6 characters" }, 400);

    const user = await pg.getUserByEmail(body.email);
    if (!user || !user.passwordHash) return c.json({ error: "invalid credentials" }, 401);
    if (!(await verifyPassword(body.currentPassword, user.passwordHash)))
      return c.json({ error: "invalid credentials" }, 401);

    await pg.setPasswordHash(user.id, await hashPassword(body.newPassword));
    return c.json({ ok: true });
  });

  return app;
}

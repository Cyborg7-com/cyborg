import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

export interface PasskeyRoutesDeps {
  pg: PgSync | null;
  // Mint the SAME session token the password login mints — passkey auth is just
  // another way to prove identity; everything downstream is identical.
  createUserToken: (email: string, name?: string) => string;
  // Validate a bearer token for the authenticated register/list/delete routes.
  validateUserToken: (token: string) => { email: string; name?: string } | null;
  // Shared with the WS layer (same helper the password login uses).
  broadcastToGuests: (workspaceId: string, message: Record<string, unknown>, seq?: number) => void;
}

// User-visible RP name and a 5-minute challenge window.
const RP_NAME = process.env.CYBORG7_WEBAUTHN_RP_NAME?.trim() || "Cyborg7";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// WebAuthn binds a credential to the Relying Party ID, which MUST be a suffix of
// the page (browser) origin — NOT the API server's host. So we derive it from
// the request's Origin header (the browser's page origin), which works for
// same-origin and cross-origin (frontend → relay) calls, on cloud and on any
// self-hosted domain. `CYBORG7_WEBAUTHN_RP_ID` overrides for prod setups that
// want to share one passkey across subdomains (e.g. rpID "cyborg7.com").
function deriveRp(c: Context<RelayEnv>): { rpID: string; expectedOrigin: string } | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  const envRpId = process.env.CYBORG7_WEBAUTHN_RP_ID?.trim();
  return { rpID: envRpId || host, expectedOrigin: origin };
}

// Passwordless passkey auth + management. Mounted next to createAuthRoutes in
// relay-standalone.ts, so it lives in the cloud relay AND any self-hosted relay
// deployment. Self-hosted solo daemons have no /api/auth surface and are out of
// scope (they have no password login either).
export function createPasskeyRoutes(deps: PasskeyRoutesDeps): Hono<RelayEnv> {
  const { pg, createUserToken, validateUserToken, broadcastToGuests } = deps;
  const app = new Hono<RelayEnv>();

  // Resolve the bearer-authenticated user for the register/list/delete routes.
  async function requireUser(c: Context<RelayEnv>) {
    if (!pg) return null;
    const authz = c.req.header("authorization");
    const token = authz?.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : undefined;
    if (!token) return null;
    const claims = validateUserToken(token);
    if (!claims?.email) return null;
    return pg.getUserByEmail(claims.email);
  }

  // The login success tail, shared with /api/auth/login: reject suspended/
  // deleted accounts, activate any pending invites, return token + workspaces.
  async function issueSession(userId: string) {
    if (!pg) return null;
    const user = await pg.getUserById(userId);
    if (!user) return null;
    const status = await pg.getAccountStatus(user.id);
    if (status?.suspendedAt || status?.deletedAt) return null;
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
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name },
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role })),
    };
  }

  // ─── Registration (authenticated: add a passkey to your account) ──

  app.post("/api/auth/passkey/register/options", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const user = await requireUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const rp = deriveRp(c);
    if (!rp) return c.json({ error: "origin header required" }, 400);

    const existing = await pg.getWebauthnCredentialsByUser(user.id);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userName: user.email,
      userID: isoUint8Array.fromUTF8String(user.id),
      userDisplayName: user.name ?? user.email,
      attestationType: "none",
      // Stop the user re-registering an authenticator they already have.
      excludeCredentials: existing.map((cr) => ({
        id: cr.credentialId,
        transports: (cr.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined,
      })),
      // residentKey "preferred" → discoverable credential so usernameless login
      // works; userVerification "required" → always Touch ID / Face ID / PIN,
      // since passkeys here REPLACE the password (not a 2nd factor).
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });

    await pg.putWebauthnChallenge({
      key: `reg:${user.id}`,
      challenge: options.challenge,
      purpose: "register",
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });
    return c.json(options);
  });

  app.post("/api/auth/passkey/register/verify", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const user = await requireUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const rp = deriveRp(c);
    if (!rp) return c.json({ error: "origin header required" }, 400);

    const body = await c.req.json<{ response?: RegistrationResponseJSON; nickname?: string }>();
    if (!body.response) return c.json({ error: "response required" }, 400);

    const expectedChallenge = await pg.consumeWebauthnChallenge(`reg:${user.id}`, "register");
    if (!expectedChallenge) return c.json({ error: "challenge expired — try again" }, 400);

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin: rp.expectedOrigin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "verification failed" }, 400);
    }
    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: "verification failed" }, 400);
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    await pg.insertWebauthnCredential({
      id: randomUUID(),
      userId: user.id,
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: body.response.response.transports ?? credential.transports ?? null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      nickname: body.nickname?.trim().slice(0, 64) || null,
    });
    return c.json({ ok: true });
  });

  // ─── Authentication (usernameless / passwordless login) ───────────

  app.post("/api/auth/passkey/auth/options", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const rp = deriveRp(c);
    if (!rp) return c.json({ error: "origin header required" }, 400);

    // No allowCredentials → discoverable-credential flow: the authenticator
    // offers whatever passkey it holds for this RP (the "tap and Touch ID" UX).
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: "required",
    });
    // No user is known yet, so key the challenge by a random handle the client
    // echoes back at /verify.
    const challengeKey = randomUUID();
    await pg.putWebauthnChallenge({
      key: challengeKey,
      challenge: options.challenge,
      purpose: "authenticate",
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    });
    return c.json({ options, challengeKey });
  });

  app.post("/api/auth/passkey/auth/verify", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const rp = deriveRp(c);
    if (!rp) return c.json({ error: "origin header required" }, 400);

    const body = await c.req.json<{
      response?: AuthenticationResponseJSON;
      challengeKey?: string;
    }>();
    if (!body.response || !body.challengeKey) {
      return c.json({ error: "response and challengeKey required" }, 400);
    }

    const expectedChallenge = await pg.consumeWebauthnChallenge(body.challengeKey, "authenticate");
    if (!expectedChallenge) return c.json({ error: "challenge expired — try again" }, 400);

    const stored = await pg.getWebauthnCredentialByCredentialId(body.response.id);
    if (!stored) return c.json({ error: "invalid credentials" }, 401);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge,
        expectedOrigin: rp.expectedOrigin,
        expectedRPID: rp.rpID,
        credential: {
          id: stored.credentialId,
          publicKey: isoBase64URL.toBuffer(stored.publicKey),
          counter: stored.counter,
          transports: (stored.transports ?? undefined) as
            | AuthenticatorTransportFuture[]
            | undefined,
        },
        requireUserVerification: true,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "verification failed" }, 400);
    }
    if (!verification.verified) return c.json({ error: "invalid credentials" }, 401);

    // Persist the new signature counter (clone/replay defense).
    await pg.updateWebauthnCredentialCounter(
      stored.credentialId,
      verification.authenticationInfo.newCounter,
    );

    const session = await issueSession(stored.userId);
    if (!session) return c.json({ error: "account unavailable" }, 403);
    return c.json(session);
  });

  // ─── Management (authenticated) ───────────────────────────────────

  app.get("/api/auth/passkey/list", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const user = await requireUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const creds = await pg.getWebauthnCredentialsByUser(user.id);
    return c.json({
      passkeys: creds.map((cr) => ({
        id: cr.id,
        nickname: cr.nickname,
        deviceType: cr.deviceType,
        createdAt: cr.createdAt,
        lastUsedAt: cr.lastUsedAt,
      })),
    });
  });

  app.delete("/api/auth/passkey/:id", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const user = await requireUser(c);
    if (!user) return c.json({ error: "unauthorized" }, 401);
    const removed = await pg.deleteWebauthnCredential(user.id, c.req.param("id"));
    if (!removed) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}

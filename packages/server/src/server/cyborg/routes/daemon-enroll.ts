import { Hono } from "hono";
import { mintDaemonToken } from "../auth.js";
import type { RelayEnv, RequireAuth } from "./types.js";

export interface DaemonEnrollDeps {
  requireAuth: RequireAuth;
}

// CYBORG-58 daemon enrollment. A daemon no longer self-mints its relay token with a
// shared HMAC secret (the coupling that took the fleet offline when the user-JWT
// secret was rotated). Instead, at claim time — which the desktop already runs on
// every login and the CLI runs on `cyborg daemon claim` — the daemon exchanges the
// logged-in user's guest token for a RELAY-SIGNED daemon token bound to
// (daemonId, ownerId=the authenticated user). The daemon stores it and presents it
// at registration; it never holds any signing secret.
//
// SECURITY: `requireAuth` rejects anything without a valid USER token (no public-
// default forgery path). The minted token's owner is the AUTHENTICATED caller —
// a client-supplied owner is ignored — and its `type:"daemon"` means a user token
// can never masquerade as a daemon token. Worst case an authenticated user enrolls a
// daemonId they don't actually run: inert, because a daemon only becomes real when it
// connects and the hello path re-asserts ownership.
export function createDaemonEnrollRoutes(deps: DaemonEnrollDeps): Hono<RelayEnv> {
  const app = new Hono<RelayEnv>();

  app.post("/api/cyborg/daemon/enroll", deps.requireAuth, async (c) => {
    const ownerId = c.get("userId");
    if (!ownerId) return c.json({ error: "unauthorized" }, 401);
    let body: { daemonId?: unknown } = {};
    try {
      const parsed: unknown = await c.req.json();
      // `null` is valid JSON but c.req.json() returns it without throwing — guard so
      // the property access below can't TypeError. Non-object bodies fall through to
      // the missing-daemonId 400.
      if (parsed && typeof parsed === "object") body = parsed as { daemonId?: unknown };
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const daemonId = typeof body.daemonId === "string" ? body.daemonId.trim() : "";
    if (!daemonId) return c.json({ error: "daemonId is required" }, 400);
    // Bind the token to the AUTHENTICATED user, never a client-supplied owner.
    const token = mintDaemonToken(daemonId, ownerId);
    return c.json({ token });
  });

  return app;
}

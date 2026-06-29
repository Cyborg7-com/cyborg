import { Hono } from "hono";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv, RequireAuth } from "./types.js";
import { applyRevenueCatEventToPool, reconcileUserIapLicense } from "../billing/revenuecat.js";

export interface IapRoutesDeps {
  pg: PgSync | null;
  requireAuth: RequireAuth;
}

// RevenueCat in-app-purchase routes. Extracted (like the Stripe routes) as a
// mounted Hono sub-app — see `app.route("/", createIapRoutes(...))` in
// relay-standalone.ts. iOS subscriptions are validated by RevenueCat; these
// endpoints mirror the entitlement into the `subscriptions` table so
// getLicenseStatus stays the single source of truth across web + iOS clients.
//
// Rail guards live in ../billing/revenuecat.ts: grant/revoke never overwrite or
// downgrade a workspace whose access is held by the Stripe rail.
export function createIapRoutes(deps: IapRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth } = deps;
  const app = new Hono<RelayEnv>();

  // ─── RevenueCat IAP webhook (iOS in-app subscriptions) ──────────
  // POST /api/iap/revenuecat-webhook — PUBLIC (no requireAuth). RevenueCat
  // authenticates via a shared Authorization header (configured in the
  // RevenueCat dashboard) that we compare against REVENUECAT_WEBHOOK_AUTH.
  //
  // Mapping (per-workspace seat model, spec §2.3): RevenueCat is keyed by
  // `app_user_id`, which the iOS client sets to the Cyborg7 user id (see
  // lib/mobile/iap.ts → configureIap(appUserId)). The purchased TIER product's
  // id maps to a seat count, modeled as ONE (userId,'ios') POOL. An event upserts
  // that pool's seatCount/status/expiry and re-derives ONLY the workspaces the
  // owner has explicitly ALLOCATED to it — it does NOT fan out to every owned
  // workspace and never auto-allocates one. Allocation is the owner-only
  // `cyborg:allocate_license` message.
  //
  // Safety: with no REVENUECAT_WEBHOOK_AUTH set the route returns 503 (billing-
  // dormant, never crashes). On a bad/missing Authorization header it returns
  // 401. Every accepted event returns 200 so RevenueCat doesn't retry-storm.
  app.post("/api/iap/revenuecat-webhook", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const expectedAuth = process.env.REVENUECAT_WEBHOOK_AUTH;
    if (!expectedAuth) {
      console.error("[revenuecat] webhook not configured (missing REVENUECAT_WEBHOOK_AUTH)");
      return c.json({ error: "webhook not configured" }, 503);
    }
    // RevenueCat sends the dashboard's configured value verbatim as the
    // Authorization header. Tolerate an optional "Bearer " prefix on EITHER side
    // so it matches whether or not the operator typed "Bearer " — a mismatch
    // here is a silent 401 that's painful to debug.
    const stripBearer = (v: string): string => v.replace(/^Bearer\s+/i, "").trim();
    const auth = c.req.header("authorization");
    if (!auth || stripBearer(auth) !== stripBearer(expectedAuth)) {
      console.error("[revenuecat] webhook auth mismatch");
      return c.json({ error: "unauthorized" }, 401);
    }

    // RevenueCat envelope: { api_version, event: { type, app_user_id, ... } }.
    // `product_id` is the StoreKit tier product (→ seat count). See
    // https://www.revenuecat.com/docs/webhooks.
    let body: {
      event?: {
        type?: string;
        app_user_id?: string;
        original_app_user_id?: string;
        product_id?: string | null;
        expiration_at_ms?: number | null;
        entitlement_ids?: string[] | null;
      };
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }

    const event = body.event;
    const eventType = event?.type ?? "";
    // app_user_id is the Cyborg7 user id the client bound via configureIap.
    // Fall back to original_app_user_id (RevenueCat sends both; the original is
    // stable across aliasing).
    const userId = event?.app_user_id || event?.original_app_user_id;
    if (!userId) {
      // TEST events + transfers without a user id: ack so RC stops retrying.
      return c.json({ received: true });
    }

    try {
      // Apply to the user's ios POOL + re-derive its ALLOCATED workspaces (rail-
      // guarded inside the derive step). The event-type routing (grant/cancel/
      // revoke) + product→seats mapping live in billing/revenuecat.ts. Unhandled
      // types (TEST, TRANSFER, SUBSCRIBER_ALIAS, …) are a no-op there.
      await applyRevenueCatEventToPool(pg, {
        type: eventType,
        userId,
        productId: event?.product_id ?? null,
        expiresAt:
          typeof event?.expiration_at_ms === "number" ? new Date(event.expiration_at_ms) : null,
        entitlementId: event?.entitlement_ids?.[0] ?? null,
      });
    } catch (err) {
      console.error("[revenuecat] error processing event", eventType, err);
      return c.json({ error: "webhook processing failed" }, 500);
    }

    return c.json({ received: true });
  });

  // ─── Reconcile (client-driven self-heal / backfill) ─────────────
  // POST /api/iap/reconcile — authed. Syncs the caller's ios license POOL from
  // RevenueCat's live entitlement (seatCount from the active product) and re-
  // derives the workspaces ALREADY allocated to it — it does NOT auto-allocate.
  // Called by the iOS client right after a StoreKit purchase/restore (so the pool
  // reflects immediately, not only once the webhook lands) and when it sees a
  // `paused` license (so a missed webhook self-heals). Authoritative when
  // REVENUECAT_SECRET_API_KEY is set; on a transient failure (or no key) it is a
  // safe no-op (never revokes — see ../billing/revenuecat.ts). Returns the
  // requested workspace's fresh license (unchanged endpoint contract).
  app.post("/api/iap/reconcile", requireAuth, async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const userId = c.get("userId");
    const body = await c.req
      .json<{ workspaceId?: string }>()
      .catch(() => ({}) as { workspaceId?: string });

    try {
      await reconcileUserIapLicense(pg, userId);
    } catch (err) {
      console.error("[revenuecat] reconcile failed", err);
      return c.json({ error: "reconcile failed" }, 500);
    }

    const workspaceId = body.workspaceId;
    if (workspaceId && (await pg.isMember(workspaceId, userId))) {
      return c.json({ reconciled: true, license: await pg.getLicenseStatus(workspaceId) });
    }
    return c.json({ reconciled: true });
  });

  return app;
}

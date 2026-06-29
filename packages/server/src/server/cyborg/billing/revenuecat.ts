// RevenueCat (iOS in-app purchase) entitlement reconciliation + cross-rail
// guards, on the PER-WORKSPACE SEAT MODEL (spec §2). RevenueCat is keyed by
// `app_user_id` (= Cyborg7 userId); a purchase grants a TIER product whose
// product id maps to a seat count (`mapProductToSeats`). We model that as ONE
// `(userId, rail='ios')` POOL with `seatCount` seats; the owner then ALLOCATES
// seats to specific workspaces (the `cyborg:allocate_license` message, Unit E).
// A workspace is Pro iff it has an honored allocation from a good-standing pool
// (`deriveWorkspaceLicense`, license-pool.ts). This module:
//
//   • Reconcile (`reconcileUserIapLicense`) — read RevenueCat's REST entitlement
//     (its active product), upsert the user's ios pool's seatCount/status/expiry,
//     then re-derive ONLY the workspaces ALREADY allocated to that pool. It NEVER
//     auto-allocates a workspace (no more fan-out to every owned workspace) and,
//     on a transient REST failure (null entitlement), leaves the pool untouched
//     so a network blip can't wrongly revoke a paying user (§6.4).
//   • Webhook applier (`applyRevenueCatEventToPool`) — the pure pool mutation the
//     RC webhook (routes/iap.ts) runs per event: grant/renew/change → upsert pool
//     + reconcile; cancellation → flag pending cancel + reconcile; expiration /
//     billing-issue → zero the pool + reconcile (allocation rows are kept so an
//     UNCANCELLATION/RENEWAL restores them).
//   • Rail guards (`isIapRow`/`isStripeRow`/`isActiveRow`) — Stripe (web/desktop)
//     and RevenueCat (iOS) both write the SAME per-workspace subscriptions row;
//     these let `deriveWorkspaceLicense` never clobber/downgrade a workspace whose
//     access is held by the OTHER rail. (Consumed by license-pool.ts + stripe.ts.)
//
// Rail discriminator: an IAP-written row carries the `revenuecat:<userId>`
// sentinel in the customer-id slot (subscriptions.stripeCustomerId is NOT NULL
// and there is no Stripe customer for an IAP purchase). Anything else is Stripe.
// This needs no schema change — the existing columns disambiguate the rail.

import type { PgSync } from "../db/pg-sync.js";
import { mapProductToSeats, reconcilePool } from "./license-pool.js";

const RC_API_BASE = "https://api.revenuecat.com/v1";

// The iOS pool's rail discriminator (one pool per (userId, 'ios')).
const IOS_RAIL = "ios";

type SubRow = Awaited<ReturnType<PgSync["getSubscription"]>>;

/** A row written by the RevenueCat webhook (its customer-id slot is the
 * `revenuecat:` sentinel). */
export function isIapRow(sub: SubRow): boolean {
  return (
    !!sub &&
    typeof sub.stripeCustomerId === "string" &&
    sub.stripeCustomerId.startsWith("revenuecat:")
  );
}

/** A row backed by a real Stripe customer (anything that isn't the IAP
 * sentinel). */
export function isStripeRow(sub: SubRow): boolean {
  return !!sub && !isIapRow(sub);
}

/** Access in good standing on either rail. */
export function isActiveRow(sub: SubRow): boolean {
  return sub?.status === "active" || sub?.status === "trialing";
}

export interface RcEntitlement {
  active: boolean;
  expiresAt: Date | null;
  entitlementId: string | null;
  // The active entitlement's StoreKit PRODUCT identifier (e.g.
  // "com.cyborg7.mobile.pro.monthly.3"), needed so the seat model can map
  // product → seat count (`mapProductToSeats`). The native entitlement payload
  // does NOT carry it (CyborgPushPlugin customerInfoPayload), so the SERVER reads
  // it from RevenueCat's REST response — `entitlements[id].product_identifier`.
  // Null when no active entitlement (or REST omitted it) → maps to 0 seats.
  productId: string | null;
}

/**
 * Query RevenueCat's REST API for a subscriber's current entitlement. Returns
 * `null` when REVENUECAT_SECRET_API_KEY is not set (the caller then falls back
 * to a DB-mirror) OR on a transient error — `null` means "could not determine",
 * never "not entitled", so a network blip can't wrongly revoke a paying user.
 *
 * On success, reports the active entitlement's expiry, its id, AND its
 * `product_identifier` (the seat-tier product) so the reconcile can size the
 * pool via `mapProductToSeats`.
 */
export async function fetchRevenueCatEntitlement(userId: string): Promise<RcEntitlement | null> {
  const secret = process.env.REVENUECAT_SECRET_API_KEY;
  if (!secret) return null;
  try {
    const resp = await fetch(`${RC_API_BASE}/subscribers/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    });
    if (!resp.ok) {
      console.error("[revenuecat] subscriber fetch failed:", resp.status);
      return null;
    }
    const body = (await resp.json()) as {
      subscriber?: {
        entitlements?: Record<
          string,
          { expires_date?: string | null; product_identifier?: string | null }
        >;
      };
    };
    const ents = body.subscriber?.entitlements ?? {};
    const now = Date.now();
    let active = false;
    let soonest: Date | null = null;
    let entitlementId: string | null = null;
    let productId: string | null = null;
    for (const [id, ent] of Object.entries(ents)) {
      const exp = ent.expires_date ? new Date(ent.expires_date) : null;
      // A null expiry = non-expiring (lifetime); a future expiry = still live.
      if (exp === null || exp.getTime() > now) {
        active = true;
        if (entitlementId === null) {
          entitlementId = id;
          // Pair the product with the entitlement we adopt as the representative
          // active one, so seat-mapping reads the SAME entitlement's product.
          productId = ent.product_identifier ?? null;
        }
        if (exp && (!soonest || exp < soonest)) soonest = exp;
      }
    }
    return { active, expiresAt: soonest, entitlementId, productId };
  } catch (err) {
    console.error("[revenuecat] subscriber fetch error:", err);
    return null;
  }
}

/**
 * Grant IAP "pro/active" to a workspace — UNLESS a Stripe row already holds it
 * in good standing (rail guard: the Stripe rail wins; we must not overwrite its
 * customer/subscription identity with the IAP sentinel).
 *
 * Under the seat model this is NO LONGER called by the reconcile/webhook path
 * (the derive step writes the cache row from allocations). It is retained as an
 * exported helper for edge/grandfather paths that write a single workspace's IAP
 * cache row directly (spec §2.2).
 */
export async function grantIap(
  pg: PgSync,
  workspaceId: string,
  userId: string,
  expiresAt: Date | null,
  entitlementId: string | null,
): Promise<void> {
  const existing = await pg.getSubscription(workspaceId);
  if (isStripeRow(existing) && isActiveRow(existing)) return;
  await pg.upsertSubscription({
    workspaceId,
    stripeCustomerId: `revenuecat:${userId}`,
    stripeSubscriptionId: null,
    plan: "pro",
    status: "active",
    priceId: entitlementId,
    currentPeriodEnd: expiresAt,
    trialEndsAt: null,
    cancelAtPeriodEnd: false,
    purchasePlatform: "apple",
  });
}

/**
 * Revoke access on a workspace because the iOS entitlement lapsed — UNLESS the
 * row is Stripe-owned (rail guard: a stale/cross-rail IAP revoke must never
 * downgrade a workspace that Stripe is paying for).
 */
export async function revokeIap(pg: PgSync, workspaceId: string): Promise<void> {
  const existing = await pg.getSubscription(workspaceId);
  if (!existing || isStripeRow(existing)) return;
  await pg.updateSubscriptionByWorkspace(workspaceId, {
    plan: "free",
    status: "canceled",
    cancelAtPeriodEnd: false,
  });
}

/**
 * Flag a pending (end-of-period) cancel — only on an IAP-owned row. Retained for
 * edge paths; the seat model flags the cancel on the POOL (`flagPoolCancel`) and
 * lets the derive step propagate it to the cache rows.
 */
export async function flagIapCancel(pg: PgSync, workspaceId: string): Promise<void> {
  const existing = await pg.getSubscription(workspaceId);
  if (isIapRow(existing))
    await pg.updateSubscriptionByWorkspace(workspaceId, { cancelAtPeriodEnd: true });
}

/**
 * Flag/clear an end-of-period cancel on a user's ios POOL, then re-derive every
 * workspace allocated to it so the cache rows reflect the pending cancel. Used by
 * the RevenueCat CANCELLATION webhook (auto-renew off but still in the paid
 * period — access continues until expiry). No-op if the user has no ios pool.
 */
export async function flagPoolCancel(pg: PgSync, userId: string, cancel: boolean): Promise<void> {
  const pool = await pg.getPoolByOwnerRail(userId, IOS_RAIL);
  if (!pool) return;
  await pg.setPoolCancelAtPeriodEnd(userId, IOS_RAIL, cancel);
  const updated = await pg.getPoolByOwnerRail(userId, IOS_RAIL);
  if (updated) await reconcilePool(pg, updated);
}

/**
 * Reconcile a user's iOS (RevenueCat) entitlement into the PER-WORKSPACE SEAT
 * MODEL (spec §2.2). This replaces the old fan-out-to-every-owned-workspace
 * behavior: it NEVER auto-allocates a workspace.
 *
 *  • Authoritative path (REVENUECAT_SECRET_API_KEY set): ask RevenueCat REST for
 *    the live entitlement, size the user's `(userId,'ios')` pool from the active
 *    product (`mapProductToSeats`), upsert it, then re-derive ONLY the workspaces
 *    already allocated to that pool (`reconcilePool`). Active → seatCount from the
 *    product, status 'active'; inactive → seatCount 0, status 'canceled' (the
 *    derive step then revokes those allocations' cache rows). This makes a
 *    purchase/restore reflect instantly and missed webhooks self-heal.
 *  • Transient REST failure (`fetchRevenueCatEntitlement` → null): SKIP all pool
 *    mutation — "could not determine" must never zero seats / revoke a paying
 *    user (§6.4). No DB-mirror fan-out exists anymore (the old mirror granted
 *    every owned workspace, which the seat model forbids); without the secret key
 *    the webhook is the source of truth and a reconcile is a safe no-op.
 *
 * Allocation creation is a separate, explicit, owner-only action (the
 * `cyborg:allocate_license` message, Unit E) — reconcile only syncs the pool +
 * re-derives existing allocations.
 */
export async function reconcileUserIapLicense(pg: PgSync, userId: string): Promise<void> {
  if (!userId) return;

  const ent = await fetchRevenueCatEntitlement(userId);
  // null = could not determine (no secret key / transient error). Never mutate
  // the pool on null — a blip must not revoke a paying user (§6.4).
  if (!ent) return;

  const pool = ent.active
    ? await pg.upsertPool({
        ownerUserId: userId,
        rail: IOS_RAIL,
        seatCount: mapProductToSeats(ent.productId),
        status: "active",
        productId: ent.productId,
        entitlementId: ent.entitlementId,
        currentPeriodEnd: ent.expiresAt,
        cancelAtPeriodEnd: false,
      })
    : // Inactive entitlement: only zero an EXISTING pool (don't fabricate one for
      // a user who never purchased). seatCount 0 + canceled → derive revokes all
      // its allocations' cache rows, but the allocation ROWS are kept so a later
      // renewal restores them.
      await zeroExistingPool(pg, userId);

  if (pool) await reconcilePool(pg, pool);
}

/**
 * Mark a user's existing ios pool canceled with 0 seats, returning the updated
 * pool (or null if they have none). Used when RevenueCat reports the entitlement
 * inactive — see `reconcileUserIapLicense` / the EXPIRATION webhook path.
 */
async function zeroExistingPool(
  pg: PgSync,
  userId: string,
): Promise<Awaited<ReturnType<PgSync["getPoolByOwnerRail"]>>> {
  const existing = await pg.getPoolByOwnerRail(userId, IOS_RAIL);
  if (!existing) return null;
  return await pg.upsertPool({
    ownerUserId: userId,
    rail: IOS_RAIL,
    seatCount: 0,
    status: "canceled",
    productId: existing.productId,
    entitlementId: existing.entitlementId,
    currentPeriodEnd: existing.currentPeriodEnd,
    cancelAtPeriodEnd: existing.cancelAtPeriodEnd,
  });
}

// ─── RevenueCat webhook event → pool mutation (routes/iap.ts) ─────────
// The set of event types that GRANT/refresh active access (purchase, renewal,
// tier crossgrade, un-cancel, non-renewing). CANCELLATION (auto-renew off, still
// in the paid period) keeps access and only flags the pending cancel; EXPIRATION
// / BILLING_ISSUE actually lapse the pool.
const RC_GRANT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
]);
const RC_REVOKE_TYPES = new Set(["EXPIRATION", "BILLING_ISSUE"]);

export interface RevenueCatPoolEvent {
  type: string;
  userId: string;
  productId: string | null;
  expiresAt: Date | null;
  entitlementId: string | null;
}

/**
 * Apply ONE RevenueCat webhook event to the user's ios pool, then re-derive the
 * workspaces allocated to it (spec §2.3). Pure pool/allocation mutation — it does
 * NOT auto-allocate any workspace; allocations are created only by the explicit
 * owner-only `cyborg:allocate_license` message. Returns silently for event types
 * that don't touch the license (TEST/TRANSFER/SUBSCRIBER_ALIAS, etc.).
 *
 *   • grant types  → upsert pool { seatCount = mapProductToSeats(productId),
 *                    status 'active', currentPeriodEnd, cancelAtPeriodEnd false }
 *                    + reconcilePool. A PRODUCT_CHANGE that shrinks seats is
 *                    handled by `honoredAllocations` (oldest-first; over-limit
 *                    allocations' cache rows are revoked on re-derive).
 *   • CANCELLATION → flag the pool cancelAtPeriodEnd + reconcilePool (access
 *                    continues until expiry; only the pending-cancel flag flips).
 *   • revoke types → zero the existing pool (seatCount 0, status 'canceled') +
 *                    reconcilePool (allocation rows kept; cache rows revoked).
 */
export async function applyRevenueCatEventToPool(
  pg: PgSync,
  event: RevenueCatPoolEvent,
): Promise<void> {
  if (!event.userId) return;

  if (RC_GRANT_TYPES.has(event.type)) {
    const pool = await pg.upsertPool({
      ownerUserId: event.userId,
      rail: IOS_RAIL,
      seatCount: mapProductToSeats(event.productId),
      status: "active",
      productId: event.productId,
      entitlementId: event.entitlementId,
      currentPeriodEnd: event.expiresAt,
      cancelAtPeriodEnd: false,
    });
    await reconcilePool(pg, pool);
    return;
  }

  if (event.type === "CANCELLATION") {
    await flagPoolCancel(pg, event.userId, true);
    return;
  }

  if (RC_REVOKE_TYPES.has(event.type)) {
    const pool = await zeroExistingPool(pg, event.userId);
    if (pool) await reconcilePool(pg, pool);
  }
  // Any other type (TEST, TRANSFER, SUBSCRIBER_ALIAS, …) is a no-op.
}

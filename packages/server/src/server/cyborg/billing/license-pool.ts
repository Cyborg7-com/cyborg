// License pools — the per-workspace seat model's core (per-buyer entitlement +
// the derive step that recomputes the gate cache).
//
// A *pool* is ONE buyer's seat entitlement on ONE rail (iOS via RevenueCat, or
// Stripe). It grants `seatCount` seats. An *allocation* spends one seat on one
// workspace. A workspace is Pro iff it has an allocation that is HONORED (within
// the pool's seat budget, deterministic oldest-first) from a good-standing pool.
//
// This module is the SINGLE source of truth for product→seats mapping and for
// recomputing the `subscriptions` gate-cache row from the pool/allocation tables.
// It mirrors `revenuecat.ts`'s shape: pure-ish functions over a `PgSync` handle.
//
// IAP-ONLY: pools/allocations are an iOS (RevenueCat) concept. Stripe stays
// per-workspace and writes the `subscriptions` row DIRECTLY (routes/stripe.ts) —
// it creates NO pool and NO allocation, so the ONLY caller of
// `deriveWorkspaceLicense` is the iOS reconcile/webhook/allocate path. A
// Stripe-written row is its own allocation; the derive must never create or
// clobber one.
//
// Rail guard (no-dual-rail, OQ-6 / spec §6.3): iOS and Stripe both write the
// same per-workspace `subscriptions` row, discriminated by the `revenuecat:`
// sentinel. `deriveWorkspaceLicense` reuses `isIapRow`/`isStripeRow`/
// `isActiveRow` so an iOS-sourced derive (a) never WRITES over a workspace held
// in good standing by a live Stripe row, and (b) on revoke, downgrades ONLY an
// iOS-written row — it leaves any Stripe row untouched. It must NEVER touch a
// Stripe row in either direction.

import type { PgSync } from "../db/pg-sync.js";
import { isActiveRow, isIapRow, isStripeRow } from "./revenuecat.js";

// Pool / allocation row shapes, sourced from the PgSync return types so they
// stay in lockstep with the Drizzle schema (no hand-written duplicate).
type Pool = NonNullable<Awaited<ReturnType<PgSync["getPoolById"]>>>;
type Allocation = Awaited<ReturnType<PgSync["getAllocationsForPool"]>>[number];

/**
 * Product id → seat count. The SINGLE place seats are decided (spec §2.1, ids
 * from DECISIONS OQ-1). Tri-state default:
 *
 *   - `null` / `undefined` / empty string → 0. No product = no seats. This is
 *     the §6.4 transient-null / missing-product guard: a webhook/REST blip that
 *     reports no product must NEVER fabricate a seat (and so never wrongly grant
 *     access). Callers that get a null product skip the pool update instead.
 *   - A non-empty product id that is NOT one of the known tiers → 1. Any other
 *     live Pro product is treated as the base 1-seat tier, so an
 *     unrecognized-but-present paid product never strands a paying user at 0
 *     seats (e.g. a future/renamed tier id we haven't mapped yet).
 *   - A known tier id → its seat count (1 / 2 / 3).
 *
 * NOTE: spec §2.1 suggested failing closed to 0 for unknown products, but the
 * orchestrator directed default→1 for a *present* unknown product (a live paid
 * product should not lock a user out); only null/empty stays 0.
 */
export function mapProductToSeats(productId: string | null | undefined): number {
  if (!productId) return 0; // null / undefined / "" → no product → no seats.
  switch (productId) {
    case "com.cyborg7.mobile.pro.monthly":
      return 1;
    case "com.cyborg7.mobile.pro.monthly.2":
      return 2;
    case "com.cyborg7.mobile.pro.monthly.3":
      return 3;
    default:
      // Present-but-unknown paid product → treat as the base 1-seat tier.
      return 1;
  }
}

/** A pool whose allocations should be honored: live on either rail. */
export function isPoolActive(pool: Pool): boolean {
  return pool.status === "active" || pool.status === "trialing";
}

/**
 * The honored allocation rows for a pool: its allocations ordered oldest-first
 * (`createdAt ASC`, deterministic per §6.1) and sliced to `seatCount`. The
 * over-limit remainder (the newest N−seatCount) is simply the rest; callers that
 * need it compute it from the full list themselves. A non-positive `seatCount`
 * (e.g. a canceled pool with seatCount 0) honors nothing.
 */
export async function honoredAllocations(pg: PgSync, pool: Pool): Promise<Allocation[]> {
  const allocs = await pg.getAllocationsForPool(pool.id);
  return allocs.slice(0, Math.max(0, pool.seatCount));
}

/**
 * Recompute the gate cache (`subscriptions` row) for ONE workspace from its
 * allocation. This is the derive step (spec §2.1). `getLicenseStatus` reads the
 * row this writes; it is never modified here.
 *
 * Honored + good-standing pool → write/refresh the paid cache row (subject to
 * the rail guard). Otherwise → revoke the PAID part of the cache only, NEVER
 * fabricating a `paused` row that would defeat the 7-day trial: downgrade an
 * existing row to free/canceled, or leave the row absent so `getLicenseStatus`
 * falls through to the workspace-creation trial.
 */
export async function deriveWorkspaceLicense(pg: PgSync, workspaceId: string): Promise<void> {
  const alloc = await pg.getAllocationForWorkspace(workspaceId);

  if (alloc) {
    const pool = await pg.getPoolById(alloc.poolId);
    // FK cascade makes a dangling poolId unlikely; treat a missing pool as
    // not-honored (revoke path) rather than crashing the derive.
    if (pool) {
      const honored = (await honoredAllocations(pg, pool)).some((a) => a.id === alloc.id);
      if (honored && isPoolActive(pool)) {
        const existing = await pg.getSubscription(workspaceId);

        // RAIL GUARD (no-dual-rail, §6.3 / OQ-6): an iOS-sourced derive must not
        // overwrite a workspace held in good standing by a live Stripe row —
        // Stripe wins; the iOS seat stays allocated but doesn't clobber the
        // Stripe identity. (Pools are iOS-only now; the symmetric Stripe-pool
        // case can't occur, but the guard stays defensive if a `stripe` pool is
        // ever introduced.)
        if (pool.rail === "ios" && isStripeRow(existing) && isActiveRow(existing)) return;
        if (pool.rail === "stripe" && isIapRow(existing) && isActiveRow(existing)) return;

        // subscriptions.stripeCustomerId is NOT NULL. iOS rows carry the
        // `revenuecat:<ownerUserId>` sentinel (the rail discriminator the guards
        // read); a Stripe pool with a null customer id falls back to "" so the
        // NOT NULL constraint holds.
        await pg.upsertSubscription({
          workspaceId,
          stripeCustomerId:
            pool.rail === "ios" ? `revenuecat:${pool.ownerUserId}` : (pool.stripeCustomerId ?? ""),
          stripeSubscriptionId: pool.stripeSubscriptionId ?? null,
          plan: "pro",
          status: pool.status,
          priceId: pool.productId ?? pool.entitlementId ?? null,
          currentPeriodEnd: pool.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: pool.cancelAtPeriodEnd,
          trialEndsAt: null,
          purchasePlatform: pool.rail === "ios" ? "apple" : "stripe",
        });
        return;
      }
    }
  }

  // No alloc, or not honored, or pool not active → revoke the PAID part only.
  const existing = await pg.getSubscription(workspaceId);
  // Rail guard on revoke: this derive is iOS-sourced, so it may downgrade ONLY
  // an iOS-written row (the `revenuecat:` sentinel). It must NEVER touch a Stripe
  // row — Stripe owns its own per-workspace row directly. `isStripeRow` is true
  // for any non-IAP row and false for a null row, so an iOS deallocation still
  // downgrades its own iOS row, an active-or-stale Stripe row is left intact, and
  // an absent row falls through to the trial.
  if (isStripeRow(existing)) return;
  if (existing) {
    await pg.updateSubscriptionByWorkspace(workspaceId, {
      plan: "free",
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
  }
  // No existing row → do nothing; getLicenseStatus falls back to the trial.
}

/**
 * Re-derive every workspace this pool touches (honored, over-limit, and
 * just-freed alike). Called after a pool's seats/status change (webhook,
 * reconcile, tier change) so the whole pool's cache rows reflect the new budget.
 */
export async function reconcilePool(pg: PgSync, pool: Pool): Promise<void> {
  for (const a of await pg.getAllocationsForPool(pool.id)) {
    await deriveWorkspaceLicense(pg, a.workspaceId);
  }
}

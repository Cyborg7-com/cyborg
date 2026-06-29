import { Hono } from "hono";
import type { PgSync } from "../db/pg-sync.js";
import {
  getStripe,
  isStripeConfigured,
  getProMonthlyPriceId,
  getPeriodEnd,
  TRIAL_PERIOD_DAYS,
  type RawStripeSubscription,
} from "../billing/stripe.js";
import type { RelayEnv, RequireAuth } from "./types.js";
import { isIapRow, isActiveRow } from "../billing/revenuecat.js";
import { normalizeBillingPlatform } from "../billing/intent.js";

// Stripe stays per-workspace (DECISIONS OQ-2) and is a TRUE NO-OP w.r.t. the
// license-pool model: the webhook handlers write the per-workspace
// `subscriptions` gate-cache row DIRECTLY (one Stripe subscription = one
// workspace's row), creating NO `stripe` license_pool and NO allocation. The
// pool/allocation model is iOS-ONLY (RevenueCat tiers grant N seats the owner
// allocates). A "Stripe-written `subscriptions` row" IS its own allocation — the
// gate reads it as-is, and `deriveWorkspaceLicense` (iOS-only) leaves any live
// Stripe row untouched (its revoke branch returns early on `isStripeRow`).
//
// WHY direct-write and not pools (the bug this reverts): routing Stripe through
// pools (a) made `deriveWorkspaceLicense` early-return on Stripe rows so a
// CANCELED Stripe sub was never revoked, and (b) collapsed multiple
// per-workspace Stripe subs into ONE pool via the `(owner_user_id, rail)` unique
// index, wrongly revoking the 2nd workspace. With Stripe creating no pools, that
// unique index is correct again (one ios pool per user) — no schema change.
//
// NO-DUAL-RAIL (OQ-6 / spec §6.3): if the workspace already has a live, active
// iOS row, the Stripe write must not clobber it. We mirror the iOS side's rail
// guard (`isIapRow` + `isActiveRow`) before every write/activate — Stripe must
// not overwrite an iOS-active workspace (and vice-versa, enforced on the iOS
// derive in license-pool.ts).

// Stripe sub status → cache status. Anything unrecognized fails closed to
// `unpaid` (treated as not-Pro by the gate), never to a paid status.
const STRIPE_STATUS_MAP: Record<string, string> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
};

function mapStripeStatus(status: string): string {
  return STRIPE_STATUS_MAP[status] ?? "unpaid";
}

// The Stripe subscription id from an invoice: prefer the new-API value passed
// from `invoice.parent.subscription_details.subscription`, else fall back to the
// legacy top-level `invoice.subscription`. Returns null when neither is a string.
function readInvoiceSubscriptionId(
  invoice: Record<string, unknown>,
  fromSubDetails: unknown,
): string | null {
  if (typeof fromSubDetails === "string") return fromSubDetails;
  if (typeof invoice.subscription === "string") return invoice.subscription;
  return null;
}

export interface StripeRoutesDeps {
  pg: PgSync | null;
  requireAuth: RequireAuth;
}

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

// NO-DUAL-RAIL guard (OQ-6 / §6.3): a Stripe webhook must not write/activate a
// workspace's `subscriptions` row when that row is currently a LIVE, ACTIVE iOS
// (RevenueCat) row — the iOS rail wins; clobbering it with the Stripe customer
// id would lose the rail identity. Mirrors the iOS side's guard direction
// (revenuecat.ts grantIap:149, license-pool.ts deriveWorkspaceLicense). Returns
// true when the Stripe path must stand down (leave the iOS row untouched).
function iosRowHolds(existing: Awaited<ReturnType<PgSync["getSubscription"]>>): boolean {
  return isIapRow(existing) && isActiveRow(existing);
}

// Only the allowlisted platform tags reach the column — a metadata value from a
// hand-crafted checkout can't poison purchase_platform.
function normalizePurchasePlatform(value: string | undefined): string | null {
  return value === "web" || value === "desktop" ? "stripe" : null;
}

async function onCheckoutCompleted(pg: PgSync, event: StripeEvent): Promise<void> {
  const session = event.data.object;
  const sessionMeta = session.metadata as Record<string, string> | undefined;
  const workspaceId = sessionMeta?.workspaceId;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : null;
  const customerId = typeof session.customer === "string" ? session.customer : null;
  if (!workspaceId || !subscriptionId || !customerId) return;
  // NO-DUAL-RAIL: don't clobber a live iOS row with the Stripe checkout.
  if (iosRowHolds(await pg.getSubscription(workspaceId))) return;

  // Retrieve the subscription to read trial / period / price details.
  const stripe = await getStripe();
  const rawSub = (await stripe.subscriptions.retrieve(
    subscriptionId,
  )) as unknown as RawStripeSubscription;

  // Direct-write the per-workspace cache row (Stripe is its own allocation).
  // Acquisition channel set at checkout: prefer the session metadata, fall back
  // to the subscription metadata (subscription_data.metadata). NULL = unknown.
  const purchasePlatform = normalizePurchasePlatform(
    sessionMeta?.platform ?? rawSub.metadata?.platform,
  );

  await pg.upsertSubscription({
    workspaceId,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    plan: "pro",
    status: rawSub.status === "trialing" ? "trialing" : "active",
    priceId: rawSub.items?.data?.[0]?.price?.id ?? getProMonthlyPriceId() ?? null,
    currentPeriodEnd: getPeriodEnd(rawSub),
    trialEndsAt: rawSub.trial_end ? new Date(rawSub.trial_end * 1000) : null,
    cancelAtPeriodEnd: rawSub.cancel_at_period_end ?? false,
    purchasePlatform,
  });
}

async function onSubscriptionUpdated(pg: PgSync, event: StripeEvent): Promise<void> {
  const rawSub = event.data.object as unknown as RawStripeSubscription;
  const workspaceId = rawSub.metadata?.workspaceId;
  if (!workspaceId) return;
  // Rail guard: never let a Stripe event mutate a live iOS-held workspace.
  if (iosRowHolds(await pg.getSubscription(workspaceId))) return;
  await pg.updateSubscriptionByWorkspace(workspaceId, {
    status: mapStripeStatus(rawSub.status),
    currentPeriodEnd: getPeriodEnd(rawSub),
    trialEndsAt: rawSub.trial_end ? new Date(rawSub.trial_end * 1000) : null,
    cancelAtPeriodEnd: rawSub.cancel_at_period_end ?? false,
  });
}

async function onSubscriptionDeleted(pg: PgSync, event: StripeEvent): Promise<void> {
  const rawSub = event.data.object as unknown as RawStripeSubscription;
  const workspaceId = rawSub.metadata?.workspaceId;
  if (!workspaceId) return;
  // Rail guard: a stale Stripe deletion must not downgrade an IAP-active row.
  if (iosRowHolds(await pg.getSubscription(workspaceId))) return;
  await pg.updateSubscriptionByWorkspace(workspaceId, {
    plan: "free",
    status: "canceled",
    cancelAtPeriodEnd: false,
  });
}

async function onPaymentFailed(pg: PgSync, event: StripeEvent): Promise<void> {
  const invoice = event.data.object;

  // Resolve the subscription id. In the current Stripe API version the
  // subscription link lives under `invoice.parent.subscription_details`; older
  // payloads exposed `invoice.subscription` at the top level. Read the new path
  // first, fall back to the legacy one (a genuinely-good non-pool improvement
  // kept from the prior revision).
  const parent = invoice.parent as
    | { subscription_details?: { subscription?: unknown } }
    | undefined;
  const subId = readInvoiceSubscriptionId(invoice, parent?.subscription_details?.subscription);

  // Flip the per-workspace cache row to past_due by subscription id. The
  // subsequent `customer.subscription.updated` (status=past_due) Stripe also
  // fires reconciles it through onSubscriptionUpdated. markSubscriptionPastDue
  // only matches rows whose stripeSubscriptionId is this sub, so it never
  // touches an iOS row (those carry a null subscription id + the sentinel).
  if (subId) await pg.markSubscriptionPastDue(subId);
}

// Apply a signature-verified Stripe webhook event to the subscriptions table.
// Thin dispatcher — each case lives in its own function so complexity stays
// within the lint budget; behavior matches the previous inline switch.
async function applyStripeEvent(pg: PgSync, event: StripeEvent): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
      return onCheckoutCompleted(pg, event);
    case "customer.subscription.updated":
      return onSubscriptionUpdated(pg, event);
    case "customer.subscription.deleted":
      return onSubscriptionDeleted(pg, event);
    case "invoice.payment_failed":
      return onPaymentFailed(pg, event);
  }
}

// Stripe billing. Extracted from relay-standalone.ts (compositor) as a mounted
// Hono sub-app — see `app.route("/", createStripeRoutes(...))`.
export function createStripeRoutes(deps: StripeRoutesDeps): Hono<RelayEnv> {
  const { pg, requireAuth } = deps;
  const appUrl = process.env.CYBORG_APP_URL?.replace(/\/$/, "") ?? "https://app.cyborg7.com";
  const app = new Hono<RelayEnv>();

  // POST /api/stripe/checkout — owner-only. Creates a subscription Checkout
  // Session (7-day trial) and returns its hosted URL for the client to redirect.
  app.post("/api/stripe/checkout", requireAuth, async (c) => {
    if (!isStripeConfigured()) return c.json({ error: "billing not configured" }, 503);
    const body = await c.req
      .json<{ workspaceId?: string; platform?: string }>()
      .catch(() => ({}) as { workspaceId?: string; platform?: string });
    const workspaceId = body.workspaceId;
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);

    // Acquisition channel for purchase_platform reporting. Allowlist-only: any
    // other value (or absent) is ignored so a client can't write an arbitrary
    // platform tag. Apple/Google IAP rows stay NULL (no Stripe checkout).
    const platform = body.platform === "web" || body.platform === "desktop" ? body.platform : null;

    // Owner-only: a non-owner member must not be able to start billing.
    const ownerId = await pg!.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return c.json({ error: "workspace not found" }, 404);
    if (ownerId !== c.get("userId")) return c.json({ error: "owner only" }, 403);

    const priceId = getProMonthlyPriceId();
    if (!priceId) return c.json({ error: "stripe price not configured" }, 503);

    const stripe = await getStripe();

    try {
      // Reuse the existing Stripe customer if this workspace ever subscribed,
      // else create one tagged with workspaceId+userId so the webhook can route.
      const existing = await pg!.getSubscription(workspaceId);
      let customerId = existing?.stripeCustomerId;
      // IAP (revenuecat:…) and manual-comp (manual_comp_grant) workspaces store a
      // NON-Stripe value here. Passing it to Stripe → 400 "No such customer" → 500.
      // Only reuse a real Stripe customer (cus_…); otherwise create a fresh one so the
      // user can subscribe/renew via Stripe regardless of their prior platform.
      if (!customerId || !customerId.startsWith("cus_")) {
        const customer = await stripe.customers.create({
          email: c.get("userEmail"),
          metadata: { workspaceId, userId: c.get("userId") },
        });
        customerId = customer.id;
      }

      const checkoutSession = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        subscription_data: {
          trial_period_days: TRIAL_PERIOD_DAYS,
          // Tag both the subscription and the session so the webhook can read the
          // platform from either object. Omitted entirely when unknown.
          metadata: { workspaceId, ...(platform ? { platform } : {}) },
        },
        success_url: `${appUrl}/workspace/${workspaceId}?billing=success`,
        cancel_url: `${appUrl}/workspace/${workspaceId}?billing=canceled`,
        metadata: { workspaceId, userId: c.get("userId"), ...(platform ? { platform } : {}) },
      });

      return c.json({ url: checkoutSession.url });
    } catch (err) {
      console.error("[stripe] checkout failed", err);
      return c.json({ error: "checkout failed" }, 502);
    }
  });

  // POST /api/stripe/portal — owner-only. Billing portal (manage / cancel /
  // update card / invoices) for the workspace's existing Stripe customer.
  app.post("/api/stripe/portal", requireAuth, async (c) => {
    if (!isStripeConfigured()) return c.json({ error: "billing not configured" }, 503);
    const body = await c.req
      .json<{ workspaceId?: string }>()
      .catch(() => ({}) as { workspaceId?: string });
    const workspaceId = body.workspaceId;
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);

    const ownerId = await pg!.getWorkspaceOwnerId(workspaceId);
    if (!ownerId) return c.json({ error: "workspace not found" }, 404);
    if (ownerId !== c.get("userId")) return c.json({ error: "owner only" }, 403);

    const sub = await pg!.getSubscription(workspaceId);
    if (!sub?.stripeCustomerId) {
      return c.json({ error: "no billing account found — upgrade first" }, 404);
    }

    const stripe = await getStripe();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${appUrl}/workspace/${workspaceId}`,
    });
    return c.json({ url: portalSession.url });
  });

  // POST /api/stripe/webhook — PUBLIC (no requireAuth). Stripe authenticates via
  // the signature header, NOT a Bearer token.
  //
  // CRITICAL: the signature is an HMAC over the EXACT raw request bytes. We read
  // c.req.text() (the unmodified body) and verify BEFORE any JSON parse — Hono's
  // global logger()/cors() middleware do not read/transform the body, so the raw
  // bytes survive. (A reverse proxy in front of the relay must likewise forward
  // the body unbuffered/unmodified or verification will fail.) Returns 400 ONLY
  // on signature failure; every handled/unhandled event returns 200 so Stripe
  // does not retry-storm.
  app.post("/api/stripe/webhook", async (c) => {
    if (!pg) return c.json({ error: "database unavailable" }, 503);
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret || !isStripeConfigured()) {
      console.error("[stripe] webhook not configured (missing secret/key)");
      return c.json({ error: "webhook not configured" }, 503);
    }

    const signature = c.req.header("stripe-signature");
    if (!signature) return c.json({ error: "missing stripe-signature header" }, 400);

    // RAW body — must NOT be JSON-parsed before constructEvent.
    const rawBody = await c.req.text();

    let event: StripeEvent;
    try {
      const stripe = await getStripe();
      event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      ) as unknown as StripeEvent;
    } catch (err) {
      console.error("[stripe] signature verification failed:", err);
      return c.json({ error: "invalid signature" }, 400);
    }

    try {
      await applyStripeEvent(pg, event);
    } catch (err) {
      console.error("[stripe] error processing event", event.type, err);
      return c.json({ error: "webhook processing failed" }, 500);
    }

    return c.json({ received: true });
  });

  // GET /api/stripe/license?workspaceId=&platform= — authed; the workspace's
  // authoritative license state (trialing | active | paused) + trialEndsAt, AND
  // the context-aware billing `intent` (what action to offer + copy) computed from
  // source × state × platform × role. HTTP companion to the cyborg:fetch_license
  // WS message so the client can hydrate the trial bar / gate / billing card from
  // a server source. `platform` is client-supplied (web|desktop|ios|android),
  // defaulting to "web" when absent/invalid.
  app.get("/api/stripe/license", requireAuth, async (c) => {
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ error: "workspaceId required" }, 400);
    const userId = c.get("userId");
    if (!(await pg!.isMember(workspaceId, userId))) return c.json({ error: "not a member" }, 403);
    const platform = normalizeBillingPlatform(c.req.query("platform"));
    const [license, intent] = await Promise.all([
      pg!.getLicenseStatus(workspaceId),
      pg!.getBillingIntent(workspaceId, userId, platform),
    ]);
    return c.json({ license, intent });
  });

  return app;
}

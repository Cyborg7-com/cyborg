// Cross-platform billing INTENT resolver — the single source of truth for "what
// can this caller do about billing, right now, on this surface?". The license
// payload already says WHETHER the workspace is paid (state); this module says
// WHAT ACTION to offer and with WHAT COPY, given the rail that holds the license
// (Stripe / IAP / manual), the license state, the client platform, and the
// caller's role.
//
// Why a shared module: web/desktop (Stripe) and iOS/Android (RevenueCat IAP) are
// two billing rails on ONE per-workspace entitlement. The action a user is
// offered depends on the rail that OWNS the license, NOT the device they're on —
// e.g. a Stripe-billed subscription opened on iOS must say "manage on the web",
// not show an App Store purchase. Centralizing the matrix here keeps the WS and
// HTTP delivery paths (and any future client) from drifting.
//
// PURE MODULE: no I/O, no PgSync. The caller (PgSync.getBillingIntent) reads the
// subscription row, license status, and role, derives the three inputs via the
// helpers here, and calls `resolveBillingIntent`. That keeps the decision table
// testable in isolation.

// The rail that owns the workspace's license. Derived from the subscriptions
// row's customer-id slot (see `deriveBillingSource`). `none` = no row at all.
export type BillingSource = "none" | "stripe" | "iap" | "manual";

// The collapsed, UI-facing license state (3 values). Maps from the richer
// license `state`+`status` via `mapLicenseStateToBillingState`.
export type BillingState = "trialing" | "active" | "expired";

// The client surface. web/desktop behave identically ("web/desktop"); ios/android
// behave identically ("mobile") EXCEPT the store name in copy.
export type BillingPlatform = "web" | "desktop" | "ios" | "android";

// The caller's role in the workspace. Only the owner may manage billing today
// (see `canManageBilling`).
export type BillingRole = "owner" | "admin" | "member";

// The action the client should offer. The client maps each to a concrete control
// (a Stripe checkout redirect, a StoreKit purchase sheet, a deep link, or a
// read-only notice).
export type BillingAction =
  | "stripe_checkout"
  | "stripe_portal"
  | "iap_purchase"
  | "iap_manage"
  | "manage_on_web"
  | "manage_in_mobile"
  | "contact_admin"
  | "owner_only";

// The resolved intent: the action plus ready-to-render copy. `ctaLabel` is
// omitted for read-only / informational intents (manage_in_mobile, contact_admin,
// owner_only).
export interface BillingIntent {
  action: BillingAction;
  title: string;
  message: string;
  ctaLabel?: string;
}

// ─── Pure input derivers ────────────────────────────────────────────

/**
 * Derive the billing rail from a subscriptions row's customer-id slot.
 *   • `cus_…`            → "stripe"  (a real Stripe customer)
 *   • `revenuecat:…`     → "iap"     (the RevenueCat sentinel, see revenuecat.ts)
 *   • `manual_comp_grant…` → "manual" (a comp/grant sentinel — FORWARD-LOOKING:
 *                          NOTHING writes this sentinel anywhere in the codebase
 *                          yet. The derivation rule is implemented now so that a
 *                          future manual-grant path is covered without touching
 *                          this resolver. Do not assume any row carries it today.)
 *   • null / empty / anything else → "none" (no subscription row).
 */
export function deriveBillingSource(customerId: string | null | undefined): BillingSource {
  if (!customerId) return "none";
  if (customerId.startsWith("cus_")) return "stripe";
  if (customerId.startsWith("revenuecat:")) return "iap";
  // FORWARD-LOOKING: no writer exists for this sentinel yet (no manual-grant path
  // in the codebase as of this change). Recognized here so the matrix's `manual`
  // rows light up the day such a path is added.
  if (customerId.startsWith("manual_comp_grant")) return "manual";
  return "none";
}

/**
 * Whitelist a client-supplied platform string to a `BillingPlatform`. The relay
 * can't trust the value, so anything outside the four known surfaces (or a
 * non-string) falls back to "web" — the safest default (Stripe checkout, the
 * universally available rail). Used by both delivery paths (WS + HTTP).
 */
export function normalizeBillingPlatform(raw: unknown): BillingPlatform {
  return raw === "desktop" || raw === "ios" || raw === "android" ? raw : "web";
}

/**
 * Collapse the license `state`+raw `status` (from `getLicenseStatus`) into the
 * 3-value UI BillingState. The license `state` is the PRIMARY signal — it already
 * collapses canceled/past_due/unpaid into `paused`:
 *   • "trialing" → "trialing"
 *   • "active"   → "active"
 *   • "paused"   → "expired"  (trial ended / canceled / past_due / unpaid)
 * The raw `status` is accepted for disambiguation/future use, but the license
 * `state` already resolves every case, so it is authoritative here.
 */
export function mapLicenseStateToBillingState(
  state: "trialing" | "active" | "paused",
  // Accepted for disambiguation/future use; `state` is authoritative so it is
  // unused. `_`-prefixed to satisfy noUnusedParameters.
  _status: string | null,
): BillingState {
  switch (state) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "paused":
      return "expired";
    // Safety net: any non-trialing/non-active value (a malformed runtime state, or
    // a future license state) collapses to "expired" — the safe, action-required
    // fallback, matching the "treat paused/canceled/past_due/expired as expired"
    // intent. Guarantees this function ALWAYS returns a valid BillingState.
    default:
      return "expired";
  }
}

// ─── Role overlay ───────────────────────────────────────────────────

// Who may manage billing. DEFAULT: owner only. To later allow admins, flip this
// to: role === "owner" || role === "admin". Do NOT implement admin access now.
function canManageBilling(role: BillingRole): boolean {
  return role === "owner";
}

// ─── Copy helpers ───────────────────────────────────────────────────

// The human store name per platform, for IAP copy. web/desktop never reach these
// (they're on the Stripe rail), but ios/android pick the right store.
function storeName(platform: BillingPlatform): string {
  return platform === "android" ? "Google Play" : "App Store";
}

function isMobile(platform: BillingPlatform): boolean {
  return platform === "ios" || platform === "android";
}

// ─── Intent builders (copy lives here, one place per action) ─────────

function stripeCheckoutIntent(): BillingIntent {
  return {
    action: "stripe_checkout",
    title: "Activate your license",
    message: "Start your subscription to unlock the full workspace for your team.",
    ctaLabel: "Continue to checkout",
  };
}

function stripePortalIntent(): BillingIntent {
  return {
    action: "stripe_portal",
    title: "Manage your subscription",
    message: "Update your plan, payment method, or invoices in the billing portal.",
    ctaLabel: "Manage subscription",
  };
}

function iapPurchaseIntent(platform: BillingPlatform): BillingIntent {
  const store = storeName(platform);
  return {
    action: "iap_purchase",
    title: "Activate your license",
    message: `Subscribe through the ${store} to unlock the full workspace for your team.`,
    ctaLabel: "Subscribe",
  };
}

function iapManageIntent(platform: BillingPlatform): BillingIntent {
  const store = storeName(platform);
  return {
    action: "iap_manage",
    title: "Manage your subscription",
    message: `Your subscription is billed through the ${store} — manage it there.`,
    ctaLabel: `Manage in ${store}`,
  };
}

function manageOnWebIntent(): BillingIntent {
  return {
    action: "manage_on_web",
    title: "Manage on the web",
    message: "Your subscription is billed on the web — manage it at app.cyborg7.com",
    ctaLabel: "Open app.cyborg7.com",
  };
}

function manageInMobileIntent(): BillingIntent {
  return {
    action: "manage_in_mobile",
    title: "Manage in the mobile app",
    message: "Purchased in the mobile app — manage it in App Store / Google Play",
  };
}

function contactAdminIntent(): BillingIntent {
  return {
    action: "contact_admin",
    title: "Access granted by Cyborg7",
    message: "Access was granted by the Cyborg7 team — contact your administrator",
  };
}

function ownerOnlyIntent(): BillingIntent {
  return {
    action: "owner_only",
    title: "Owner-only",
    message: "Only the workspace owner can manage billing — ask the owner.",
  };
}

// ─── The locked matrix ──────────────────────────────────────────────

/**
 * Resolve the source × state × platform action, BEFORE the role overlay. This is
 * the LOCKED matrix — change copy in the builders above, never the wiring here:
 *
 *   source           state                  web/desktop        mobile
 *   ───────────────  ─────────────────────  ─────────────────  ───────────────
 *   none OR stripe   trialing OR expired    stripe_checkout    iap_purchase
 *   stripe           active                 stripe_portal      manage_on_web
 *   iap              active                 manage_in_mobile   iap_manage
 *   iap              expired                stripe_checkout    iap_purchase
 *   manual           active                 contact_admin      contact_admin
 *   manual           expired                stripe_checkout    iap_purchase
 *
 * DORMANT / FULL-ACCESS GAP (none + active): the matrix has NO `none`+`active`
 * row. That combination only occurs when billing is dormant (Stripe not
 * configured → getLicenseStatus returns state:"active", source stays "none"),
 * i.e. FULL ACCESS with nothing to buy or manage. To keep this function TOTAL
 * without inventing a new action, it falls through to `stripe_checkout`. The
 * CLIENT does not display this card: state is `active` and source is `none`, so
 * there is nothing to do. See `resolveBillingIntent` for the explicit fallback.
 */
function resolveByMatrix(
  source: BillingSource,
  state: BillingState,
  platform: BillingPlatform,
): BillingIntent {
  const mobile = isMobile(platform);

  // manual + active → informational notice on every platform.
  if (source === "manual" && state === "active") {
    return contactAdminIntent();
  }

  // stripe + active → manage where it's billed (web portal vs. "manage on web").
  if (source === "stripe" && state === "active") {
    return mobile ? manageOnWebIntent() : stripePortalIntent();
  }

  // iap + active → manage where it's billed (store vs. "manage in mobile").
  if (source === "iap" && state === "active") {
    return mobile ? iapManageIntent(platform) : manageInMobileIntent();
  }

  // Everything else (none/stripe/iap/manual + trialing/expired, AND the dormant
  // none+active fallback) → activate. Web/desktop go to Stripe checkout; mobile
  // goes to an IAP purchase.
  return mobile ? iapPurchaseIntent(platform) : stripeCheckoutIntent();
}

/**
 * Resolve the billing intent for a caller: run the locked source×state×platform
 * matrix, then apply the role overlay LAST. A non-owner who cannot manage billing
 * gets `owner_only` on EVERY cell (including manual+active, which is correct —
 * a member still cannot manage billing).
 */
export function resolveBillingIntent(i: {
  source: BillingSource;
  state: BillingState;
  platform: BillingPlatform;
  role: BillingRole;
}): BillingIntent {
  // Role overlay (computed LAST): if the caller may not manage billing, every
  // cell becomes owner_only. DEFAULT = owner-only; admins are NOT yet allowed.
  if (!canManageBilling(i.role)) {
    return ownerOnlyIntent();
  }

  return resolveByMatrix(i.source, i.state, i.platform);
}

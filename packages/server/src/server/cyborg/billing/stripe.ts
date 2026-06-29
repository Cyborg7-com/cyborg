// The default export IS the Stripe class. Aliased (StripeSdk) because oxlint's
// no-named-as-default flags naming the default import `Stripe` (a same-named
// named export also exists). `StripeClient` is the type alias for readability.
import type StripeSdk from "stripe";

type StripeClient = StripeSdk;

// Lazy singleton — ported from v1 (src/lib/billing/stripe.ts). The key is read
// from the relay's environment (STRIPE_SECRET_KEY); never hardcoded. Throwing
// (rather than returning null) keeps the failure loud: a billing route hit with
// no key configured returns a clear 503 instead of silently no-op'ing.
let _stripe: StripeClient | null = null;

export async function getStripe(): Promise<StripeClient> {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    const { default: StripeSdk } = await import("stripe");
    _stripe = new StripeSdk(key);
  }
  return _stripe;
}

export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

// The recurring $49/mo price id (reuses v1's Stripe product). Read at call time
// (not module load) so a late-set env still works.
export function getProMonthlyPriceId(): string | undefined {
  return process.env.STRIPE_PRO_MONTHLY_PRICE_ID || undefined;
}

// Trial length kept in sync with the client's 7-day cadence and the server's
// getLicenseStatus trial anchor (DECISION: 7 days, matched to Stripe).
export const TRIAL_PERIOD_DAYS = 7;

// Raw subscription shape from Stripe webhook/retrieve payloads. Some fields the
// typed SDK object doesn't surface live here (and current_period_end moved onto
// items in newer API versions — getPeriodEnd reads both). Ported from v1.
export interface RawStripeSubscription {
  id: string;
  status: string;
  metadata?: Record<string, string>;
  current_period_end?: number;
  trial_end?: number | null;
  cancel_at_period_end?: boolean;
  items?: { data?: Array<{ current_period_end?: number; price?: { id?: string } }> };
}

// Period-end shim — newer Stripe API versions move current_period_end onto the
// subscription items. Read both. Ported verbatim from v1's webhook handler.
export function getPeriodEnd(sub: RawStripeSubscription): Date | null {
  const ts = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return ts ? new Date(ts * 1000) : null;
}

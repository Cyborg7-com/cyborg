/**
 * RevenueCat in-app-purchase bridge (Tauri iOS shell only).
 *
 * iOS in-app subscriptions must use StoreKit; Apple rejects apps that take
 * payment for digital goods any other way. RevenueCat's `Purchases` SDK (native,
 * in `CyborgIapPlugin.swift`) wraps StoreKit + server-side receipt validation +
 * entitlement state. This module is the typed JS boundary over the Tauri plugin
 * commands. Everything here is gated on `isTauriIOS()` and no-ops (returns empty
 * shapes) on web / desktop / Android, where Stripe remains the billing path.
 *
 * Native command surface (Tauri `invoke('plugin:cyborg-push|…')`):
 *   - iap_configure     { apiKey, appUserId }  → Purchases.configure + bind user
 *   - iap_offerings                            → { offeringId, packages: [...] }
 *   - iap_purchase      { packageId }          → { active, expiresAt }
 *   - iap_restore                              → { active, expiresAt }
 *   - iap_customer_info                        → { active, expiresAt }
 *
 * Native event (`listen('iap-entitlements-changed', …)`):
 *   - fires on renewal / cross-device restore / promo grant; payload is the same
 *     `{ appUserId, active, expiresAt }` shape so subscribers can refetch.
 *
 * The RevenueCat appUserID is set to the Cyborg7 user id so the relay webhook
 * (`POST /api/iap/revenuecat-webhook`) can route entitlement events back to that
 * user's workspace license, keeping iOS + web/desktop clients in agreement.
 */

import { isTauriIOS } from "./push.js";

/** A purchasable subscription package flattened from RevenueCat's offering. */
export interface IapPackage {
  /** RevenueCat package identifier — pass back to `purchase()`. */
  id: string;
  /** Underlying StoreKit product id. */
  productId: string;
  /** Localized product title. */
  title: string;
  /** Localized product description. */
  description: string;
  /** Localized price string, e.g. "$49.00". */
  priceString: string;
  /** ISO-8601 subscription period, e.g. "P1M" (monthly). Empty for non-subs. */
  period: string;
}

export interface IapOfferings {
  /** RevenueCat offering identifier (the "current" offering), or null. */
  offeringId: string | null;
  packages: IapPackage[];
}

/** Snapshot of the user's active RevenueCat entitlements. */
export interface IapEntitlements {
  /** RevenueCat appUserID the snapshot belongs to (empty when unconfigured). */
  appUserId: string;
  /** Active entitlement identifiers (e.g. ["pro"]). Empty = no paid access. */
  active: string[];
  /** Soonest active-entitlement expiration (epoch ms), or null (lifetime/none). */
  expiresAt: number | null;
}

const EMPTY_ENTITLEMENTS: IapEntitlements = { appUserId: "", active: [], expiresAt: null };

// Raw shapes the Swift side resolves (untyped at the bridge — narrowed here).
interface RawPackage {
  id?: string;
  productId?: string;
  title?: string;
  description?: string;
  priceString?: string;
  period?: string;
}
interface RawOfferings {
  offeringId?: string;
  packages?: RawPackage[];
}
interface RawEntitlements {
  appUserId?: string;
  active?: string[];
  expiresAt?: number | null;
}

function normalizePackage(p: RawPackage): IapPackage {
  return {
    id: p.id ?? "",
    productId: p.productId ?? "",
    title: p.title ?? "",
    description: p.description ?? "",
    priceString: p.priceString ?? "",
    period: p.period ?? "",
  };
}

function normalizeEntitlements(raw: RawEntitlements | null | undefined): IapEntitlements {
  if (!raw) return EMPTY_ENTITLEMENTS;
  return {
    appUserId: raw.appUserId ?? "",
    active: Array.isArray(raw.active) ? raw.active : [],
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : null,
  };
}

/**
 * Configure the RevenueCat SDK and bind the current Cyborg7 user. Idempotent on
 * the native side (configure runs once; later calls re-bind the appUserId via
 * logIn). No-op off iOS.
 *
 * `apiKey` is optional: when omitted, the native side falls back to the public
 * key embedded in the iOS build's Info.plist (REVENUECAT_PUBLIC_IOS_KEY). Pass
 * it explicitly only if you want to override the embedded key.
 */
export async function configureIap(appUserId: string, apiKey?: string): Promise<void> {
  if (!isTauriIOS()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:cyborg-push|iap_configure", { apiKey: apiKey ?? null, appUserId });
  } catch (err) {
    // Surface the real native error instead of silently showing an empty
    // paywall — the paywall's init() catch renders e.message so we can see WHY
    // IAP failed (key missing, command unreachable, RevenueCat init error, …).
    console.warn("[iap] configure failed", err);
    throw err instanceof Error ? err : new Error(`IAP configure failed: ${String(err)}`);
  }
}

/** Fetch the current offering's packages. Returns empty off iOS / on error. */
export async function getOfferings(): Promise<IapOfferings> {
  if (!isTauriIOS()) return { offeringId: null, packages: [] };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<RawOfferings>("plugin:cyborg-push|iap_offerings");
    return {
      offeringId: raw?.offeringId ?? null,
      packages: (raw?.packages ?? []).map(normalizePackage),
    };
  } catch (err) {
    console.warn("[iap] getOfferings failed", err);
    return { offeringId: null, packages: [] };
  }
}

/**
 * Purchase a package by its RevenueCat identifier. Resolves with the
 * post-purchase entitlements. Throws on a genuine failure; a user cancel
 * rejects with a `userCancelled` code, which callers can detect to stay silent.
 */
export async function purchase(packageId: string): Promise<IapEntitlements> {
  if (!isTauriIOS()) return EMPTY_ENTITLEMENTS;
  const { invoke } = await import("@tauri-apps/api/core");
  const raw = await invoke<RawEntitlements>("plugin:cyborg-push|iap_purchase", { packageId });
  return normalizeEntitlements(raw);
}

/** Restore previously-purchased entitlements (App Store requirement). */
export async function restorePurchases(): Promise<IapEntitlements> {
  if (!isTauriIOS()) return EMPTY_ENTITLEMENTS;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<RawEntitlements>("plugin:cyborg-push|iap_restore");
    return normalizeEntitlements(raw);
  } catch (err) {
    console.warn("[iap] restore failed", err);
    return EMPTY_ENTITLEMENTS;
  }
}

/**
 * Open the system "Manage Subscriptions" surface (App Store account →
 * subscriptions) so an active subscriber can upgrade / downgrade / cancel.
 * Apple requires that management happen through Apple, not our UI. No-op off iOS.
 */
export async function manageSubscriptions(): Promise<void> {
  if (!isTauriIOS()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("plugin:cyborg-push|iap_manage_subscriptions");
  } catch (err) {
    console.warn("[iap] manageSubscriptions failed", err);
  }
}

/** Read the current active entitlements. Empty off iOS / on error. */
export async function getEntitlements(): Promise<IapEntitlements> {
  if (!isTauriIOS()) return EMPTY_ENTITLEMENTS;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const raw = await invoke<RawEntitlements>("plugin:cyborg-push|iap_customer_info");
    return normalizeEntitlements(raw);
  } catch (err) {
    console.warn("[iap] getEntitlements failed", err);
    return EMPTY_ENTITLEMENTS;
  }
}

/**
 * True when at least one entitlement is active (any paid access). Convenience
 * over `getEntitlements().active.length > 0`.
 */
export function hasActiveEntitlement(e: IapEntitlements): boolean {
  return e.active.length > 0;
}

/**
 * Subscribe to native entitlement-change events (RevenueCat pushes a fresh
 * snapshot on renewal / cross-device restore / promo grant). Returns an
 * unsubscribe function. No-op off iOS (returns a no-op unsubscribe).
 */
export async function onEntitlementsChanged(
  handler: (entitlements: IapEntitlements) => void,
): Promise<() => void> {
  if (!isTauriIOS()) return () => {};
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<RawEntitlements>("iap-entitlements-changed", (e) => {
      handler(normalizeEntitlements(e.payload));
    });
    return unlisten;
  } catch (err) {
    console.warn("[iap] onEntitlementsChanged subscribe failed", err);
    return () => {};
  }
}

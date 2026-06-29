<script lang="ts">
  // iOS in-app-purchase paywall (RevenueCat). A full-screen, safe-area-aware
  // upgrade sheet shown ONLY inside the Tauri iOS shell — web/desktop keep the
  // Stripe-hosted ActivateLicenseModal. It lists the current RevenueCat offering
  // and drives subscribe + restore through the native bridge (lib/mobile/iap.ts).
  //
  // Apple requires a visible "Restore Purchases" affordance, so it's a
  // first-class button here. The component is presentation-only: it does NOT
  // wire itself into a route. A parent mounts it (e.g. when licenseState.paused
  // && isTauriIOS()) and reacts to `onActivated` to refetch the license.
  import { onMount } from "svelte";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { setNativeVisibility, hasActiveComposer } from "$lib/mobile/nativeComposer.js";
  import {
    configureIap,
    getOfferings,
    purchase,
    restorePurchases,
    hasActiveEntitlement,
    type IapPackage,
  } from "$lib/mobile/iap.js";

  let {
    open = $bindable(false),
    appUserId,
    onActivated,
    onClose,
  }: {
    /** Controls visibility. Bindable so a parent can close it after activation. */
    open?: boolean;
    /** Cyborg7 user id → RevenueCat appUserID (lets the webhook route events). */
    appUserId: string;
    /** Fired once a purchase or restore yields an active entitlement. */
    onActivated?: () => void;
    /** Fired when the user dismisses the sheet without subscribing. */
    onClose?: () => void;
  } = $props();

  // Only ever render inside the iOS shell. On every other surface this is inert
  // so importing/mounting it elsewhere is harmless.
  const onIos = isTauriIOS();

  let packages = $state<IapPackage[]>([]);
  let selectedId = $state<string | null>(null);
  let loading = $state(true);
  let working = $state(false);
  let error = $state("");

  const selected = $derived(packages.find((p) => p.id === selectedId) ?? packages[0] ?? null);

  // The native composer pill is a UIKit overlay ABOVE the WKWebView, so it bleeds
  // through this full-screen web paywall (it was overlapping the Subscribe button
  // + hiding the legal text). Hide it while the paywall is open; restore on
  // close/unmount. Same fix MessageActionSheet uses.
  $effect(() => {
    if (!onIos || !open) return;
    setNativeVisibility(false);
    // Restore ONLY if a composer still owns the pill (chat/dm/agent route). The
    // paywall opens from anywhere (trial bar, Home, settings) — forcing the pill
    // back unconditionally left it floating over screens that never had one. (#23)
    return () => setNativeVisibility(hasActiveComposer());
  });

  onMount(() => {
    if (!onIos) return;
    void init();
  });

  async function init(): Promise<void> {
    loading = true;
    error = "";
    try {
      // Configure (idempotent native-side) + bind the user, then load offerings.
      await configureIap(appUserId);
      const offerings = await getOfferings();
      packages = offerings.packages;
      selectedId = packages[0]?.id ?? null;
      if (packages.length === 0) {
        error = "No subscription options are available right now.";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load subscription options.";
    } finally {
      loading = false;
    }
  }

  async function handleSubscribe(): Promise<void> {
    if (working || !selected) return;
    working = true;
    error = "";
    try {
      const result = await purchase(selected.id);
      if (hasActiveEntitlement(result)) {
        onActivated?.();
        open = false;
      } else {
        error = "Purchase completed but no entitlement was granted yet. Try Restore Purchases.";
      }
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      // User backed out of the StoreKit sheet — stay silent, no error toast.
      if (code === "userCancelled") {
        working = false;
        return;
      }
      error = e instanceof Error ? e.message : "Purchase failed. Please try again.";
    } finally {
      working = false;
    }
  }

  async function handleRestore(): Promise<void> {
    if (working) return;
    working = true;
    error = "";
    try {
      const result = await restorePurchases();
      if (hasActiveEntitlement(result)) {
        onActivated?.();
        open = false;
      } else {
        error = "No previous purchases were found for this Apple ID.";
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not restore purchases.";
    } finally {
      working = false;
    }
  }

  function handleClose(): void {
    open = false;
    onClose?.();
  }

  const PLAN_FEATURES = [
    "Bring your own model keys (Claude, OpenAI, OpenRouter)",
    "Shared workspace state across devices",
    "Priority cloud relay",
  ];

  // ── Seat-tier ladder (DECISIONS OQ-1: 1/2/3 seat tiers; price set in App
  // Store Connect, shown live from StoreKit) ───────────────────────────────────
  // The offering flattens 3 tier packages (1/2/3 seats), each a StoreKit
  // product. We don't trust the product TITLE for the seat count (it's localized
  // ASC copy); we map the productId → seats with the SAME ladder the server's
  // mapProductToSeats uses (billing/license-pool.ts). Suffix-based so finalized
  // ASC ids still resolve.
  function seatsForProduct(productId: string): number {
    const id = productId.toLowerCase();
    if (id.endsWith(".3") || /(^|[._-])3(seat|[._-]|$)/.test(id)) return 3;
    if (id.endsWith(".2") || /(^|[._-])2(seat|[._-]|$)/.test(id)) return 2;
    // The base 1-seat product has no numeric suffix (com.cyborg7.mobile.pro.monthly).
    return 1;
  }

  // Sort packages cheapest-first (1 → 3 seats) so the ladder reads top-down.
  const sortedPackages = $derived(
    [...packages].sort((a, b) => seatsForProduct(a.productId) - seatsForProduct(b.productId)),
  );

  // Human seat label for a tier card, e.g. "1 workspace" / "5 workspaces".
  function seatLabel(productId: string): string {
    const n = seatsForProduct(productId);
    return `${n} workspace${n === 1 ? "" : "s"}`;
  }

  // Localized monthly cadence for the per-tier 3.1.2 length disclosure. The
  // bridge gives an ISO period (e.g. "P1M"); fall back to "month" for monthlies.
  function periodLabel(period: string): string {
    if (period === "P1M" || period === "") return "month";
    if (period === "P1Y") return "year";
    if (period === "P1W") return "week";
    return "period";
  }
</script>

{#if onIos && open}
  <!-- Full-screen sheet. Pinned to the viewport with safe-area insets so the
       content clears the Dynamic Island / home indicator. -->
  <div
    class="fixed inset-0 z-50 flex flex-col bg-surface"
    style="padding-top: var(--sat); padding-bottom: var(--sab);"
    role="dialog"
    aria-modal="true"
    aria-label="Upgrade Cyborg7"
  >
    <!-- Top bar: close affordance. -->
    <div class="flex items-center justify-end px-4 py-3">
      <button
        type="button"
        onclick={handleClose}
        class="flex h-8 w-8 items-center justify-center rounded-full text-content-muted active:bg-surface-alt touch-target"
        aria-label="Close"
      >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-6 pb-2">
      <!-- Hero -->
      <div class="pt-2">
        <p class="text-[11px] font-bold uppercase tracking-wide text-content-muted">Upgrade</p>
        <h1 class="mt-1 text-[26px] font-bold leading-tight tracking-tight text-content">
          Unlock Cyborg7 Pro
        </h1>
        <p class="mt-2 text-[13.5px] leading-relaxed text-content-muted">
          Choose how many workspaces to license. You'll assign your seats to
          specific workspaces after subscribing — each seat brings one workspace's
          agents online.
        </p>
      </div>

      <!-- Feature list -->
      <ul class="mt-6 space-y-3">
        {#each PLAN_FEATURES as feature (feature)}
          <li class="flex items-start gap-3 text-[14px] text-content">
            <svg class="mt-0.5 h-4 w-4 shrink-0 text-btn-primary-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>
            <span>{feature}</span>
          </li>
        {/each}
      </ul>

      <!-- Tier ladder (spec §3): one card per seat tier (1/2/3 workspaces).
           Each card carries the seat count + price + monthly cadence so the
           Apple 3.1.2 length/price disclosure sits adjacent to the choice. -->
      <div class="mt-7 space-y-2.5">
        {#if loading}
          <div class="rounded-2xl border border-edge bg-surface-alt p-4 text-[13px] text-content-muted">
            Loading subscription options…
          </div>
        {:else}
          {#each sortedPackages as pkg (pkg.id)}
            <button
              type="button"
              onclick={() => (selectedId = pkg.id)}
              aria-pressed={selectedId === pkg.id}
              class="flex w-full items-center justify-between rounded-2xl border p-4 text-left transition-colors touch-target {selectedId === pkg.id ? 'border-btn-primary-bg bg-surface-alt' : 'border-edge bg-surface-alt/40'}"
            >
              <div class="min-w-0">
                <div class="text-[15px] font-bold text-content">
                  {pkg.title || `Cyborg7 Pro — ${seatLabel(pkg.productId)}`}
                </div>
                <div class="mt-0.5 text-[12px] text-content-muted">
                  {pkg.description || `Pro license for up to ${seatLabel(pkg.productId)}`}
                </div>
              </div>
              <div class="shrink-0 pl-3 text-right">
                <div class="text-[18px] font-bold tracking-tight text-content">{pkg.priceString}</div>
                <!-- Per-tier 3.1.2 length disclosure, derived from pkg.period. -->
                <div class="text-[11px] text-content-muted">/ {periodLabel(pkg.period)}</div>
              </div>
            </button>
          {/each}
        {/if}
      </div>

      {#if error}
        <p class="mt-4 text-[12.5px] text-error">{error}</p>
      {/if}
    </div>

    <!-- Sticky footer: Subscribe + Restore + legal. -->
    <div class="border-t border-edge px-6 pt-4" style="padding-bottom: max(1rem, var(--sab));">
      <button
        type="button"
        onclick={handleSubscribe}
        disabled={working || loading || !selected}
        class="w-full rounded-2xl bg-btn-primary-bg py-3.5 text-[15px] font-semibold text-btn-primary-text transition-colors active:bg-btn-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        {#if working}
          Processing…
        {:else if selected}
          Subscribe — {seatLabel(selected.productId)} · {selected.priceString}
        {:else}
          Subscribe
        {/if}
      </button>

      <button
        type="button"
        onclick={handleRestore}
        disabled={working || loading}
        class="mt-2 w-full py-2 text-[13px] font-medium text-content-muted active:text-content disabled:opacity-40"
      >
        Restore Purchases
      </button>

      <p class="mt-1 text-center text-[11px] leading-relaxed text-content-muted">
        {#if selected}
          {seatLabel(selected.productId)} · {selected.priceString} per {periodLabel(
            selected.period,
          )}.
        {/if}
        Payment is charged to your Apple ID. Subscriptions renew automatically
        unless cancelled at least 24 hours before the end of the period. Manage in
        your Apple ID settings.
      </p>

      <!-- App-Store Guideline 3.1.2: EULA (Terms) + Privacy Policy adjacent to
           the purchase. Canonical www URLs (the #807 form Apple approved). -->
      <p class="mt-2 text-center text-[11px] leading-relaxed text-content-muted">
        <a href="https://www.cyborg7.com/terms" class="text-content-dim underline">Terms of Use (EULA)</a>
        &nbsp;·&nbsp;
        <a href="https://www.cyborg7.com/privacy" class="text-content-dim underline">Privacy Policy</a>
      </p>
    </div>
  </div>
{/if}

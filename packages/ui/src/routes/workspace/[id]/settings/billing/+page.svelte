<script lang="ts">
  import { toast } from "svelte-sonner";
  import { authState, workspaceState, openBillingPortal, refreshLicense } from "$lib/state/app.svelte.js";
  import { licenseState } from "$lib/state/license.svelte.js";
  import ActivateLicenseModal from "$lib/components/trial/ActivateLicenseModal.svelte";
  import LicenseAllocationPanel from "$lib/components/billing/LicenseAllocationPanel.svelte";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { manageSubscriptions } from "$lib/mobile/iap.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";

  // On iOS the subscription is an Apple IAP (its stripeCustomerId is the
  // `revenuecat:<uid>` sentinel, not a real Stripe customer), so opening the
  // Stripe billing portal 500s ("No such customer"). Manage it via the native
  // App Store subscriptions surface instead. (Stripe portal stays for web/desktop.)
  const onIos = isTauriIOS();

  const license = $derived(licenseState.license);
  const workspace = $derived(workspaceState.current);
  const daysLeft = $derived(licenseState.daysLeft);

  // Only the workspace owner can manage billing (Stripe portal/checkout are
  // owner-only on the relay). Mirrors the gate used elsewhere.
  const isOwner = $derived(
    workspace?.role === "owner" || (!!authState.user && workspace?.ownerId === authState.user.id),
  );

  // Cloud billing only matters when Stripe is configured. When it's dormant
  // (self-hosted / no Stripe), the relay reports plan "free" + status null +
  // state "active" — there's no real subscription to manage.
  const billingConfigured = $derived(
    !!license && !(license.plan === "free" && license.status === null),
  );

  // Re-fetch the license whenever the active workspace changes (and on open), so
  // the page is authoritative — reflects a just-completed checkout/cancel — and
  // doesn't leak in-progress state across workspaces. (Gemini review: $effect
  // over onMount avoids the workspace-switch race.)
  // `loading` ends in finally() so a failed refresh (older relay / self-hosted)
  // falls back to "No subscription" instead of spinning forever. (Gemini review.)
  let loading = $state(true);
  $effect(() => {
    const ws = workspace?.id;
    busy = false;
    if (!ws) {
      // No active workspace (logout / workspace deletion): clear the stale
      // license too so it can't leak into a later session. (Gemini review.)
      loading = false;
      licenseState.clear();
      return;
    }
    loading = true;
    // Clear first so a failed refresh can't leak the PREVIOUS workspace's
    // license onto this page. (Gemini review.)
    licenseState.clear();
    // Only the latest in-flight refresh may flip `loading` — a slow previous
    // workspace's refresh resolving after a switch must not clear it early.
    // (Gemini review.)
    let active = true;
    // Call with NO arg: passing wsId would make refreshLicense's internal
    // stale-check (workspaceState.current?.id === wsId || workspaceId === wsId)
    // trivially true, letting an out-of-order fetch clobber the global license.
    // (Gemini review.)
    void refreshLicense().finally(() => {
      if (active) loading = false;
    });
    return () => {
      active = false;
    };
  });

  function fmtDate(ms: number | null): string {
    if (!ms || Number.isNaN(ms)) return "—";
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
  }

  type Tone = "success" | "info" | "warn" | "error" | "muted";
  const badge = $derived.by((): { label: string; tone: Tone } => {
    if (!license) return { label: "Loading…", tone: "muted" };
    if (license.state === "trialing") {
      return { label: `Trial · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`, tone: "info" };
    }
    if (license.state === "paused") return { label: "Paused", tone: "error" };
    // active
    if (license.status === "past_due" || license.status === "unpaid") {
      return { label: "Payment overdue", tone: "error" };
    }
    if (license.status === "canceled") return { label: "Canceled", tone: "muted" };
    if (license.cancelAtPeriodEnd) return { label: "Canceling", tone: "warn" };
    return { label: "Active", tone: "success" };
  });

  const TONE_COLOR: Record<Tone, string> = {
    success: "var(--color-online, #3daa7c)",
    info: "var(--c7-accent, var(--color-link))",
    warn: "var(--color-warning, #e8ab5a)",
    error: "var(--color-error, #e01e5a)",
    muted: "var(--text-muted)",
  };

  let busy = $state(false);
  async function manage(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (onIos) {
        // Apple IAP — open the system App Store subscriptions (the Stripe portal
        // would 500 on the revenuecat: sentinel customer).
        await manageSubscriptions();
      } else {
        // Web/desktop: navigates to the Stripe billing portal on success.
        await openBillingPortal();
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't open subscription management");
    } finally {
      // Reset even if the navigation is cancelled / restored from BFCache, so the
      // button never stays permanently disabled. (Gemini review.)
      busy = false;
    }
  }

  function activate(): void {
    licenseState.openModal();
  }

  // ── Context-aware billing action card (server intent) ───────────────────────
  // The server resolves WHAT action this caller can take on THIS surface
  // (source × state × platform × role) and ships it as `intent`. We render its
  // copy and dispatch the click by `action`. Falls back to the legacy
  // owner/active/paused branching below when the intent hasn't loaded yet (older
  // relay / first paint).
  const intent = $derived(licenseState.intent);

  // Open the Stripe-billed subscription on the web (the mobile `manage_on_web`
  // cell — a Stripe sub viewed inside the mobile app, which can't open the portal
  // there). On web/desktop this action never occurs, but the link is harmless.
  function openManageOnWeb(): void {
    if (typeof window !== "undefined") {
      window.open("https://app.cyborg7.com", "_blank", "noopener");
    }
  }

  // Run the intent's primary action. Only `stripe_checkout`, `iap_purchase`,
  // `stripe_portal`, `iap_manage`, and `manage_on_web` are actionable; the rest
  // are informational (no button is rendered for them).
  async function runIntentAction(): Promise<void> {
    switch (intent?.action) {
      case "stripe_checkout":
        activate();
        break;
      case "iap_purchase":
        // iOS/Android: open the activate modal, which on iOS swaps the Stripe
        // dialog for the native StoreKit/RevenueCat IapPaywall (same purchase
        // surface the TrialBar opens).
        activate();
        break;
      case "stripe_portal":
        await manage();
        break;
      case "iap_manage":
        // iOS/Android: open the native store-subscriptions surface.
        await manage();
        break;
      case "manage_on_web":
        openManageOnWeb();
        break;
      default:
        // informational intents (manage_in_mobile / contact_admin / owner_only)
        // render copy only — no action.
        break;
    }
  }

  // Whether the current intent has a clickable CTA (vs. an info-only notice).
  const intentHasCta = $derived(
    intent?.action === "stripe_checkout" ||
      intent?.action === "iap_purchase" ||
      intent?.action === "stripe_portal" ||
      intent?.action === "iap_manage" ||
      intent?.action === "manage_on_web",
  );
</script>

{#if viewportState.isMobile}
  <!-- ── Mobile: iOS grouped inset cards ── -->
  <div class="px-4 pb-8 pt-3 space-y-6">

    {#if loading}
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[24px] text-center">
        <p class="text-[15px] text-content-muted">Loading subscription details…</p>
      </div>
    {:else if license === null || !billingConfigured}
      <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[24px] text-center space-y-1">
        <p class="text-[16px] font-medium text-content">No subscription</p>
        <p class="text-[13px] text-content-muted">
          This workspace isn't on a paid cloud plan — there's nothing to manage here.
        </p>
      </div>
    {:else}
      <!-- Subscription status card -->
      <div>
        <p class="mb-2 px-[4px] text-[13px] font-semibold uppercase tracking-wide text-content-muted">Subscription</p>
        <div class="overflow-hidden rounded-[14px] bg-surface-alt">
          <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
            <span class="text-[16px] text-content">Status</span>
            <span
              class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold"
              style="color: {TONE_COLOR[badge.tone]}; background: color-mix(in srgb, {TONE_COLOR[badge.tone]} 14%, transparent);"
            >
              <span class="h-[6px] w-[6px] rounded-full bg-current"></span>
              {badge.label}
            </span>
          </div>
          <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
          <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
            <span class="text-[16px] text-content">Plan</span>
            <span class="text-[16px] font-semibold capitalize text-content">{license.plan}</span>
          </div>
          {#if license.state === "trialing" && license.trialEndsAt}
            <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
            <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
              <span class="text-[16px] text-content">Trial ends</span>
              <span class="text-[15px] text-content-muted">{fmtDate(license.trialEndsAt)}</span>
            </div>
          {/if}
          {#if license.currentPeriodEnd && license.state !== "trialing"}
            <!-- During a trial, Stripe sets current_period_end == trial_end, so a
                 separate "Renews" row would just duplicate "Trial ends". (Gemini.) -->
            <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
            <div class="flex min-h-[44px] items-center justify-between px-[16px] py-[10px]">
              <span class="text-[16px] text-content">
                {license.cancelAtPeriodEnd ? "Access until" : "Renews"}
              </span>
              <span class="text-[15px] text-content-muted">{fmtDate(license.currentPeriodEnd)}</span>
            </div>
          {/if}
        </div>
      </div>

      <!-- Action — driven by the server-computed billing intent (source × state
           × platform × role). Falls back to the legacy owner/active/paused
           branching when the intent hasn't loaded (older relay / first paint). -->
      <div>
        {#if intent}
          {#if intentHasCta}
            <div class="overflow-hidden rounded-[14px] bg-surface-alt">
              <button
                type="button"
                onclick={runIntentAction}
                disabled={busy}
                class="pressable-row flex h-[48px] w-full items-center justify-center px-[16px] focus-ring disabled:opacity-50"
              >
                <span class="text-[16px] font-semibold text-accent">
                  {busy ? "Opening…" : (intent.ctaLabel ?? intent.title)}
                </span>
              </button>
            </div>
            <p class="mt-2 px-[4px] text-[13px] text-content-muted">{intent.message}</p>
          {:else}
            <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
              <p class="text-[14px] text-content-muted">{intent.message}</p>
            </div>
          {/if}
        {:else if !isOwner}
          <div class="overflow-hidden rounded-[14px] bg-surface-alt px-[16px] py-[14px]">
            <p class="text-[14px] text-content-muted">
              Only the workspace owner can manage billing. Ask your owner to update the subscription.
            </p>
          </div>
        {:else if license.state === "active" && license.plan !== "free"}
          <!-- Only a real paid plan has a Stripe subscription to manage. A "free"
               plan (e.g. after cancellation) has no customer to open the portal
               for, so it falls through to Activate below. (Gemini review.) -->
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            <button
              type="button"
              onclick={manage}
              disabled={busy}
              class="pressable-row flex h-[48px] w-full items-center justify-center px-[16px] focus-ring disabled:opacity-50"
            >
              <span class="text-[16px] font-semibold text-accent">
                {busy ? "Opening…" : "Manage subscription"}
              </span>
            </button>
          </div>
          <p class="mt-2 px-[4px] text-[13px] text-content-muted">
            {onIos
              ? "Manage or cancel your subscription in the App Store."
              : "Update your card, view invoices, or cancel in the Stripe billing portal."}
          </p>
        {:else}
          <div class="overflow-hidden rounded-[14px] bg-surface-alt">
            <button
              type="button"
              onclick={activate}
              class="pressable-row flex h-[48px] w-full items-center justify-center px-[16px] focus-ring"
            >
              <span class="text-[16px] font-semibold text-accent">Activate license</span>
            </button>
          </div>
          <p class="mt-2 px-[4px] text-[13px] text-content-muted">
            {license.plan === "free"
              ? "Activate your license to bring your agents back online."
              : license.state === "paused"
                ? "Your trial ended — activate your license to bring your agents back online."
                : "Activate before your trial ends to keep your agents running without interruption."}
          </p>
        {/if}
      </div>

      <!-- Per-workspace seat allocation (spec §4): assign this account's seats
           to specific workspaces. Renders its own owner/empty/over-allocated
           states; surfaces only for a real subscription (billingConfigured). -->
      <div class="pt-1">
        <LicenseAllocationPanel />
      </div>
    {/if}

  </div>
{:else}
  <!-- ── Desktop: original layout (byte-equal) ── -->
  <div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
    <header>
      <h1 class="text-lg font-semibold text-content">Billing</h1>
      <p class="mt-1 text-xs text-content-muted">Manage your Cyborg cloud subscription</p>
    </header>

    {#if loading}
      <!-- Still fetching: don't flash "No subscription" while the first
           getLicenseStatus is in flight. `loading` (not license===null) so a
           FAILED refresh still resolves to "No subscription". Per Gemini review. -->
      <section class="rounded-lg border border-edge px-4 py-8 text-center">
        <p class="text-sm text-content-muted">Loading subscription details…</p>
      </section>
    {:else if license === null || !billingConfigured}
      <section class="rounded-lg border border-edge px-4 py-8 text-center space-y-1.5">
        <p class="text-sm text-content">No subscription</p>
        <p class="text-xs text-content-muted">
          This workspace isn't on a paid cloud plan — there's nothing to manage here.
        </p>
      </section>
    {:else}
      <!-- Status -->
      <section class="space-y-3">
        <span class="block text-xs font-medium text-content-muted uppercase tracking-wider">
          Subscription
        </span>
        <div class="rounded-lg border border-edge divide-y divide-edge">
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Status</span>
            <span
              class="inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-[3px] rounded-full"
              style="color: {TONE_COLOR[badge.tone]}; background: color-mix(in srgb, {TONE_COLOR[badge.tone]} 14%, transparent);"
            >
              <span class="w-[6px] h-[6px] rounded-full bg-current"></span>
              {badge.label}
            </span>
          </div>
          <div class="flex items-center justify-between px-4 py-3">
            <span class="text-sm text-content-dim">Plan</span>
            <span class="text-sm font-semibold text-content capitalize">{license.plan}</span>
          </div>
          {#if license.state === "trialing" && license.trialEndsAt}
            <div class="flex items-center justify-between px-4 py-3">
              <span class="text-sm text-content-dim">Trial ends</span>
              <span class="text-sm text-content-muted">{fmtDate(license.trialEndsAt)}</span>
            </div>
          {/if}
          {#if license.currentPeriodEnd && license.state !== "trialing"}
            <!-- During a trial, Stripe sets current_period_end == trial_end, so a
                 separate "Renews" row would just duplicate "Trial ends". (Gemini.) -->
            <div class="flex items-center justify-between px-4 py-3">
              <span class="text-sm text-content-dim">
                {license.cancelAtPeriodEnd ? "Access until" : "Renews"}
              </span>
              <span class="text-sm text-content-muted">{fmtDate(license.currentPeriodEnd)}</span>
            </div>
          {/if}
        </div>
      </section>

      <!-- Actions — driven by the server-computed billing intent (source × state
           × platform × role). Falls back to the legacy owner/active/paused
           branching when the intent hasn't loaded (older relay / first paint). -->
      <section class="space-y-2">
        {#if intent}
          {#if intentHasCta}
            <button
              type="button"
              onclick={runIntentAction}
              disabled={busy}
              class="rounded-lg bg-btn-primary-bg text-btn-primary-text px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? "Opening…" : (intent.ctaLabel ?? intent.title)}
            </button>
          {/if}
          <p class="text-xs text-content-muted">{intent.message}</p>
        {:else if !isOwner}
          <p class="text-xs text-content-muted">
            Only the workspace owner can manage billing. Ask your owner to update the subscription.
          </p>
        {:else if license.state === "active" && license.plan !== "free"}
          <!-- Only a real paid plan has a Stripe subscription to manage. A "free"
               plan (e.g. after cancellation) has no customer to open the portal
               for, so it falls through to Activate below. (Gemini review.) -->
          <button
            type="button"
            onclick={manage}
            disabled={busy}
            class="rounded-lg bg-btn-primary-bg text-btn-primary-text px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Opening…" : "Manage subscription"}
          </button>
          <p class="text-xs text-content-muted">
            {onIos
              ? "Manage or cancel your subscription in the App Store."
              : "Update your card, view invoices, or cancel in the Stripe billing portal."}
          </p>
        {:else}
          <button
            type="button"
            onclick={activate}
            class="rounded-lg bg-btn-primary-bg text-btn-primary-text px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90"
          >
            Activate license
          </button>
          <p class="text-xs text-content-muted">
            {license.plan === "free"
              ? "Activate your license to bring your agents back online."
              : license.state === "paused"
                ? "Your trial ended — activate your license to bring your agents back online."
                : "Activate before your trial ends to keep your agents running without interruption."}
          </p>
        {/if}
      </section>

      <!-- Per-workspace seat allocation (spec §4): assign this account's seats
           to specific workspaces. Renders its own owner/empty/over-allocated
           states; surfaces only for a real subscription (billingConfigured). -->
      <LicenseAllocationPanel />
    {/if}
  </div>
{/if}

<ActivateLicenseModal bind:open={licenseState.modalOpen} />

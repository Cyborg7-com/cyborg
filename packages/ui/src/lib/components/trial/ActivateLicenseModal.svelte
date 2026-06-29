<script lang="ts">
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog/index.js";
  import {
    authState,
    workspaceState,
    startCheckout,
    refreshLicense,
    reconcileIapLicense,
    fetchLicensePool,
    allocateLicense,
  } from "$lib/state/app.svelte.js";
  import { licenseState } from "$lib/state/license.svelte.js";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import IapPaywall from "$lib/components/IapPaywall.svelte";
  import LicenseAllocationPanel from "$lib/components/billing/LicenseAllocationPanel.svelte";
  import { onDestroy } from "svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  // iOS must take payment through StoreKit (RevenueCat), not a Stripe redirect —
  // Apple rejects external payment for digital goods. Same trigger (TrialBar →
  // openModal), iOS-native surface: the IapPaywall sheet replaces the Stripe
  // dialog. Web/desktop/Android keep the Stripe checkout flow below.
  const onIos = isTauriIOS();

  // Per-workspace billing (spec §4.1 + §4.2): when this workspace is paused but
  // the owner already holds a FREE seat in their pool, activating it is a one-tap
  // allocation with NO purchase (DECISIONS OQ-5). Fetch the pool when the modal
  // opens so we know whether to offer "Activate this workspace (uses a seat)"
  // before routing to checkout/StoreKit. Best-effort (the action no-ops the bar
  // if the relay handler isn't live yet).
  $effect(() => {
    if (open) void fetchLicensePool();
  });
  const freeSeats = $derived(licenseState.freeSeats);
  const currentWsId = $derived(workspaceState.current?.id ?? null);
  const currentAllocated = $derived(!!currentWsId && licenseState.isAllocated(currentWsId));
  // Offer the no-charge activation only when there's a spare seat AND this
  // workspace isn't already spending one.
  const canActivateWithFreeSeat = $derived(freeSeats > 0 && !currentAllocated);

  let allocating = $state(false);
  async function handleActivateWithFreeSeat(): Promise<void> {
    if (allocating || !isOwner || !currentWsId) return;
    allocating = true;
    error = "";
    const code = await allocateLicense(currentWsId);
    allocating = false;
    if (code) {
      error =
        code === "no_free_seat"
          ? "No free seat left — buy more to activate this workspace."
          : "Couldn't activate this workspace. Please try again.";
      return;
    }
    // allocateLicense flips this workspace's gate to active, so the bar clears.
    open = false;
  }

  // Post-purchase seat assignment (owner's rule): after a successful iOS
  // purchase, gate on the count of OWNED workspaces — NOT the seat count.
  //   • exactly 1 owned workspace → auto-assign a seat to it instantly (no extra
  //     tap); any extra seats from a multi-seat tier stay free for later.
  //   • more than 1 owned workspace → present the allocation chooser INLINE so
  //     the owner picks which workspace(s) get seats without leaving for Settings.
  // `assignStep` flips the modal from the paywall to the inline chooser view.
  let assignStep = $state(false);

  async function handleIapActivated(): Promise<void> {
    // StoreKit purchase succeeded and RevenueCat granted the entitlement.
    // Reflect active immediately so the trial/paused bar clears, then confirm
    // server-side: reconcile adopts the real license now (instant when
    // REVENUECAT_SECRET_API_KEY is set; otherwise it's a no-op and the webhook
    // flips the row). A delayed refresh backstops the webhook-only case.
    licenseState.set({
      state: "active",
      plan: "pro",
      trialEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      status: "active",
    });
    await reconcileIapLicense();
    // Per-workspace billing (spec §4.1): a tier purchase creates a seat POOL but
    // allocates NOTHING server-side — the owner must assign seats. AWAIT the pool
    // refresh (not fire-and-forget) so we can read the authoritative owned-list +
    // seats before deciding the post-purchase UX.
    await fetchLicensePool();
    const owned = licenseState.ownedWorkspaces;
    setTimeout(() => {
      void refreshLicense();
    }, 4000);

    // Allocation is owner-only (server enforces). The post-purchase user IS the
    // buyer/owner, but guard on the active workspace's role where the state
    // exposes it so we never auto-fire for a non-owner. When ownership is
    // unknown, fall through to the chooser rather than auto-allocating.
    if (owned.length === 1 && isOwner) {
      // Exactly one workspace → auto-assign instantly, no extra tap. Extra seats
      // (multi-seat tier) stay free for later. Surface the rare error instead of
      // crashing — shouldn't happen right after buying.
      const code = await allocateLicense(owned[0].id);
      if (code) {
        error =
          code === "no_free_seat"
            ? "Purchase complete, but no seat was free to assign. Open Billing to assign one."
            : "Purchase complete, but we couldn't assign a seat automatically. Open Billing to assign one.";
        // Show the inline chooser so the owner can finish manually.
        assignStep = true;
        return;
      }
      // Seat assigned → the workspace gate flips active; close out.
      open = false;
      return;
    }

    if (owned.length > 1) {
      // More than one workspace → DON'T auto-allocate; present the chooser inline
      // so the owner picks which workspace(s) get the new seats right here.
      assignStep = true;
      return;
    }

    // 0 owned workspaces (or owner unknown with a single ws): nothing to assign
    // here — just close. Seats remain in the pool for Settings → Billing.
    open = false;
  }

  // Dismiss the inline chooser: clear the step AND close the modal so a later
  // re-open starts at the paywall, never a stale chooser.
  function finishAssignment(): void {
    assignStep = false;
    open = false;
  }

  const PLAN_PRICE = 49;
  const PLAN_FEATURES = [
    "Unlimited human seats",
    "Bring your own model keys (Claude, OpenAI, OpenRouter)",
    "Shared workspace state across devices",
    "Priority cloud relay",
  ];

  // Only the workspace owner can start billing — the relay 403s everyone else.
  const isOwner = $derived(
    workspaceState.current?.role === "owner" ||
      (!!authState.user && workspaceState.current?.ownerId === authState.user.id),
  );
  const paused = $derived(licenseState.paused);

  // Server-computed billing intent for this surface (web/desktop here — the iOS
  // branch renders the native paywall above and is out of scope). Drives the
  // owner-only / manual-grant cards; the trialing/expired path keeps the existing
  // Stripe checkout flow (intent.action === "stripe_checkout" on web/desktop).
  const intent = $derived(licenseState.intent);
  // Manual (Cyborg7-team-granted) access: nothing to purchase here — show the
  // contact-admin notice instead of the checkout flow.
  const isManualGrant = $derived(intent?.action === "contact_admin");
  // The owner-only copy (members can't manage billing). Prefer the server message;
  // fall back to the existing static copy if the intent hasn't loaded yet.
  const ownerOnlyMessage = $derived(
    intent?.action === "owner_only"
      ? intent.message
      : "Only the workspace owner can activate the license. Ask them to set up billing.",
  );

  let submitting = $state(false);
  let error = $state("");

  // Desktop-only "waiting for activation" surface. On web, startCheckout()
  // navigates the tab to Stripe and the page leaves, so there's nothing to wait
  // on. On desktop the main process denies in-place navigation off the app
  // origin (main.ts `will-navigate`), so startCheckout() opens Stripe in the OS
  // browser and the app page STAYS. We can't be redirected back into the app, so
  // we switch to a waiting state and poll the license until it flips active.
  let waiting = $state(false);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // True once we observe an activated license while waiting → close the modal.
  // Captured at wait-start: a workspace can be paused (trial ended) or still
  // trialing (proactive upgrade). "Activated" = state went `active`, OR a
  // previously-paused workspace is no longer paused.
  let wasPausedAtWait = false;

  const POLL_INTERVAL_MS = 3000;
  // Stop polling after ~5 min so a tab the user abandoned doesn't refetch
  // forever. The manual "I've completed payment" button stays as the fallback.
  const POLL_TIMEOUT_MS = 5 * 60 * 1000;

  function stopPolling(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // True when the current license reflects a completed activation, given the
  // paused-ness we recorded when waiting began.
  function isActivated(): boolean {
    if (licenseState.state === "active") return true;
    if (wasPausedAtWait && !licenseState.paused) return true;
    return false;
  }

  async function checkActivation(): Promise<void> {
    await refreshLicense();
    if (isActivated()) {
      stopPolling();
      open = false;
    }
  }

  function startPolling(): void {
    stopPolling();
    wasPausedAtWait = licenseState.paused;
    const startedAt = Date.now();
    pollTimer = setInterval(() => {
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        // Give up the automatic poll; the manual refresh button remains.
        stopPolling();
        return;
      }
      void checkActivation();
    }, POLL_INTERVAL_MS);
  }

  // Manual fallback: refresh the license immediately when the user says they've
  // finished paying in the external browser. Closes the modal if it took.
  async function handleManualRefresh(): Promise<void> {
    await checkActivation();
  }

  // Stop polling the moment the modal closes (Cancel / Esc / activated) so a
  // dismissed modal doesn't keep refetching, and reset the waiting surface so a
  // later re-open starts clean.
  $effect(() => {
    if (!open) {
      stopPolling();
      waiting = false;
    }
  });

  // Belt-and-suspenders: never leak the interval if the component unmounts while
  // a poll is in flight.
  onDestroy(stopPolling);

  async function handleContinue(): Promise<void> {
    if (submitting || !isOwner) return;
    submitting = true;
    error = "";
    try {
      // startCheckout() returns true on desktop (opened Stripe in the OS browser
      // — the app page stays) and false on web (navigated the tab to Stripe —
      // the page leaves, so leaving "Redirecting…" up is fine, it's gone).
      const openedExternally = await startCheckout();
      if (openedExternally) {
        // Desktop: don't leave the button stuck on "Redirecting…". Switch to the
        // waiting surface and poll for the webhook to flip the license active.
        submitting = false;
        waiting = true;
        startPolling();
      }
      // Web: leave `submitting` true; the page is navigating away.
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not start checkout";
      submitting = false;
    }
  }
</script>

{#if onIos && assignStep}
  <!-- Post-purchase seat chooser (owner's >1-workspace rule): rendered INLINE
       right after the StoreKit purchase resolves so the owner assigns their new
       seats here, without being kicked to Settings → Billing. Reuses the same
       LicenseAllocationPanel that Settings mounts (single source of truth for the
       toggle list + "N of M used" + free-seat hints). Full-screen, safe-area
       aware — mirrors IapPaywall's sheet chrome. -->
  <div
    class="fixed inset-0 z-50 flex flex-col bg-surface"
    style="padding-top: var(--sat); padding-bottom: var(--sab);"
    role="dialog"
    aria-modal="true"
    aria-label="Assign your seats"
  >
    <div class="flex items-center justify-between px-5 py-3">
      <p class="text-[11px] font-bold uppercase tracking-wide text-content-muted">
        Subscription active
      </p>
      <button
        type="button"
        onclick={finishAssignment}
        class="flex h-8 w-8 items-center justify-center rounded-full text-content-muted active:bg-surface-alt touch-target"
        aria-label="Done"
      >
        <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>

    <div class="flex-1 overflow-y-auto px-5 pb-2">
      <h1 class="text-[24px] font-bold leading-tight tracking-tight text-content">
        Assign your seats
      </h1>
      <p class="mt-2 text-[13.5px] leading-relaxed text-content-muted">
        Turn on each workspace you want to bring online. Each seat lights up one
        workspace — extra seats stay free until you assign them.
      </p>

      {#if error}
        <p class="mt-3 text-[12.5px] text-error">{error}</p>
      {/if}

      <div class="mt-5">
        <LicenseAllocationPanel />
      </div>
    </div>

    <!-- Sticky footer: a single Done action returns the user to the app. They can
         revisit Settings → Billing any time to change allocations. -->
    <div class="border-t border-edge px-5 pt-4" style="padding-bottom: max(1rem, var(--sab));">
      <button
        type="button"
        onclick={finishAssignment}
        class="min-h-[44px] w-full rounded-2xl bg-btn-primary-bg py-3 text-[15px] font-semibold text-btn-primary-text transition-colors active:bg-btn-primary-hover"
      >
        Done
      </button>
    </div>
  </div>
{:else if onIos}
  <!-- iOS: native StoreKit/RevenueCat paywall (offerings + subscribe + the
       Apple-required Restore Purchases). Bound to the same `open` the trial bar
       toggles, so the trigger is unchanged — only the surface differs. -->
  <IapPaywall
    bind:open
    appUserId={authState.user?.id ?? ""}
    onActivated={handleIapActivated}
    onClose={() => (open = false)}
  />
{:else}
<Dialog bind:open>
  <DialogContent class="sm:max-w-[480px] p-0 overflow-hidden">
    <DialogHeader class="p-5 pb-0">
      <p class="text-[11px] font-bold uppercase tracking-wide text-content-muted">Activate your license</p>
      <DialogTitle class="text-lg font-bold">
        {paused ? "Your trial has ended" : "Activate Cyborg7"}
      </DialogTitle>
    </DialogHeader>

    {#if !isManualGrant}
      <!-- The plan/price card is the self-serve checkout pitch — hidden for a
           manual (team-granted) workspace, which has nothing to purchase. -->
      <div class="px-5 pt-4">
        <div class="rounded-xl border border-edge bg-surface-alt p-4">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-[14px] font-bold text-content">Cyborg7 License</div>
              <div class="mt-0.5 text-[11.5px] text-content-muted">Monthly, cancel anytime</div>
            </div>
            <div class="text-right">
              <div class="text-[22px] font-bold tracking-tight text-content">
                ${PLAN_PRICE}<span class="text-[12px] font-medium text-content-dim"> / mo</span>
              </div>
            </div>
          </div>
          <ul class="mt-3 space-y-2">
            {#each PLAN_FEATURES as feature (feature)}
              <li class="flex items-start gap-2 text-[12.5px] text-content">
                <svg class="mt-0.5 h-3.5 w-3.5 shrink-0 text-btn-primary-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10"/></svg>
                <span>{feature}</span>
              </li>
            {/each}
          </ul>
        </div>
      </div>
    {/if}

    <div class="space-y-3 p-5">
      <p class="text-[12.5px] leading-relaxed text-content-muted">
        {#if waiting}
          Complete checkout in your browser. We'll bring your agents back online
          automatically once your payment goes through — you can keep this open.
        {:else if isManualGrant}
          {intent?.message ?? "Access was granted by the Cyborg7 team — contact your administrator"}
        {:else if paused}
          Activate your license to bring your agents back online. Your channels,
          messages, and history stay exactly as they are.
        {:else}
          Continue to Stripe to start your subscription. You won't be charged
          until your trial ends.
        {/if}
      </p>

      {#if waiting}
        <!-- Desktop: Stripe opened in the OS browser, so the app page never
             leaves. Show a clear waiting state (no frozen "Redirecting…") and
             poll the license; the manual button is the fallback if the webhook
             is slow. -->
        <div class="flex items-center justify-center gap-2 rounded-lg border border-edge bg-surface-alt px-3 py-2.5 text-[12.5px] text-content-muted">
          <svg class="h-3.5 w-3.5 shrink-0 animate-spin text-btn-primary-bg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
          <span>Waiting for activation… complete checkout in your browser.</span>
        </div>
        {#if error}
          <p class="text-xs text-error">{error}</p>
        {/if}
        <button
          type="button"
          onclick={handleManualRefresh}
          class="w-full rounded-lg border border-edge bg-surface-alt py-2 text-sm font-medium text-content transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40"
        >
          I've completed payment — refresh
        </button>
        <button
          type="button"
          onclick={() => (open = false)}
          class="w-full py-1 text-center text-[11px] text-content-muted underline hover:text-content"
        >
          Cancel
        </button>
      {:else if isManualGrant}
        <!-- Manual (Cyborg7-team-granted) access: there is no self-serve
             subscription to start — surface the server's contact-admin notice
             and a single dismiss, NOT the Stripe checkout flow. -->
        <p class="rounded-lg border border-edge bg-surface-alt px-3 py-2.5 text-[12.5px] leading-relaxed text-content">
          {intent?.message ?? "Access was granted by the Cyborg7 team — contact your administrator"}
        </p>
        <button
          type="button"
          onclick={() => (open = false)}
          class="w-full rounded-lg border border-edge bg-surface-alt py-2 text-sm font-medium text-content transition-colors hover:bg-surface"
        >
          Got it
        </button>
      {:else}
      {#if !isOwner}
        <p class="rounded-lg border border-edge bg-surface-alt px-3 py-2 text-[12px] text-content-muted">
          {ownerOnlyMessage}
        </p>
      {/if}

      {#if isOwner && canActivateWithFreeSeat}
        <!-- Free seat available (spec §4.2): activating consumes an OWNED seat —
             no purchase (DECISIONS OQ-5). Shown above checkout so the no-charge
             path is the obvious default; checkout below becomes "buy more". -->
        <div class="rounded-lg border border-edge bg-surface-alt px-3 py-2.5">
          <p class="text-[12px] text-content">
            You have {freeSeats} free license{freeSeats === 1 ? "" : "s"}. Activate this
            workspace with no extra charge.
          </p>
          <button
            type="button"
            onclick={handleActivateWithFreeSeat}
            disabled={allocating}
            class="mt-2 min-h-[44px] w-full rounded-lg bg-btn-primary-bg py-2 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {allocating ? "Activating…" : "Activate this workspace (uses 1 seat)"}
          </button>
        </div>
        <p class="text-center text-[11px] text-content-muted">or buy more seats below</p>
      {/if}

      {#if error}
        <p class="text-xs text-error">{error}</p>
      {/if}

      <button
        type="button"
        onclick={handleContinue}
        disabled={!isOwner || submitting}
        class="w-full rounded-lg bg-btn-primary-bg py-2 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? "Redirecting…" : canActivateWithFreeSeat ? "Buy more seats" : "Continue to checkout"}
      </button>
      <p class="flex items-center justify-center gap-1.5 text-center text-[11px] text-content-muted">
        <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        Secure checkout via Stripe
      </p>
      <p class="text-center text-[11px] leading-relaxed text-content-muted">
        <a href="https://www.cyborg7.com/terms" class="text-content-dim underline">Terms of Use (EULA)</a>
        &nbsp;·&nbsp;
        <a href="https://www.cyborg7.com/privacy" class="text-content-dim underline">Privacy Policy</a>
      </p>
      {/if}
    </div>
  </DialogContent>
</Dialog>
{/if}

<script lang="ts">
  // Seat-assignment surface (per-workspace billing, spec §4). The owner of a
  // seat POOL (an iOS tier sub or a Stripe sub) designates WHICH workspaces
  // spend their seats here. Activating a workspace with a FREE seat is no-charge
  // (DECISIONS OQ-5); when no free seat is left, the CTA routes to the tier
  // paywall to buy more. Owner-only affordances (DECISIONS OQ-5).
  //
  // Presentation + light orchestration only: the round-trips live in
  // app.svelte.ts (fetchLicensePool / allocateLicense / deallocateLicense), the
  // state in license.svelte.ts. The upgrade/buy CTA reuses the existing
  // ActivateLicenseModal (which already branches iOS→IapPaywall, web→Stripe) via
  // licenseState.openModal() — no new purchase flow is invented here.
  import { Switch } from "$lib/components/ui/switch/index.js";
  import {
    authState,
    workspaceState,
    fetchLicensePool,
    allocateLicense,
    deallocateLicense,
  } from "$lib/state/app.svelte.js";
  import { licenseState } from "$lib/state/license.svelte.js";
  import { isTauriIOS } from "$lib/mobile/push.js";

  // Only a workspace OWNER may allocate/deallocate seats (DECISIONS OQ-5; mirrors
  // the relay's owner 403 used for Stripe checkout). Non-owners see a read-only
  // explainer instead of toggles. Uses the ACTIVE workspace's role — the panel
  // lives on the billing settings page of the workspace the user is in.
  const isOwner = $derived(
    workspaceState.current?.role === "owner" ||
      (!!authState.user && workspaceState.current?.ownerId === authState.user.id),
  );

  const onIos = isTauriIOS();

  const pool = $derived(licenseState.pool);
  const seats = $derived(licenseState.seats);
  const used = $derived(licenseState.usedSeats);
  const freeSeats = $derived(licenseState.freeSeats);
  const overAllocated = $derived(licenseState.overAllocated);
  const owned = $derived(licenseState.ownedWorkspaces);
  const loading = $derived(licenseState.poolLoading);

  // No ACTIVE seat pool: the subscription is paused/expired so the pool collapsed
  // to zero seats (seatCount 0). Any workspaces still flagged `used` linger from
  // before the lapse, so the over-allocated "downgrade re-pick" band, the "N of 0
  // used" math, and the "Upgrade tier" CTA would all be nonsense (keeping 0 seats
  // is meaningless). We render a "renew to restore your seats" state instead. This
  // is distinct from the REAL downgrade case (0 < seats < used), which still shows
  // the re-pick band below. Guarded inside the `{:else}` (pool != null) branch, so
  // a true free/trial caller (pool === null) still gets the tier-picker CTA above.
  const noActivePool = $derived(!!pool && seats === 0);

  // The server-computed billing intent tells us WHAT this caller can do about a
  // lapsed pool on THIS surface (source × state × platform × role). We render its
  // copy and only expose a clickable CTA for the action the panel can perform here
  // (stripe_checkout on web/desktop, iap_purchase on iOS/Android → both reopen the
  // activate/renew modal, which routes to Stripe checkout or the native IapPaywall
  // respectively). manage_in_mobile / contact_admin (and any other) are
  // informational — copy only, no button — matching the billing page's contract.
  const intent = $derived(licenseState.intent);
  const pausedIntentHasCta = $derived(
    intent?.action === "stripe_checkout" || intent?.action === "iap_purchase",
  );

  // First load + on workspace switch — pull the caller's pool. A SINGLE $effect
  // (no separate onMount, which would double-fetch on initial mount). It depends
  // ONLY on the workspace id and must NOT read any pool $state that
  // fetchLicensePool writes, or it would re-run on its own fetch and loop. The
  // `lastWs` sentinel starts at a value no real id can equal, so the effect fires
  // exactly once on mount and again only when the id actually changes. The
  // actions are best-effort, so a missing relay handler leaves the demoable stub.
  let lastWs = $state<string | null | undefined>(undefined);
  $effect(() => {
    const ws = workspaceState.current?.id ?? null;
    if (ws !== lastWs) {
      lastWs = ws;
      void fetchLicensePool();
    }
  });

  // Per-row error (e.g. a toggle rejected no_free_seat / already_active_other_rail).
  let rowError = $state<{ workspaceId: string; message: string } | null>(null);

  function errorCopy(code: string): string {
    switch (code) {
      case "no_free_seat":
        return "No free seat — upgrade your tier to activate more workspaces.";
      case "not_owner":
        return "Only the workspace owner can change this.";
      case "no_pool":
        return "No active subscription — start one to allocate seats.";
      case "already_active_other_rail":
        return onIos
          ? "Already active on the web (Stripe) — manage it there."
          : "Already active on iOS — manage it in the App Store.";
      case "error":
        return "Couldn't reach the server. Please try again.";
      default:
        return "Couldn't update this workspace. Please try again.";
    }
  }

  // Per-row status line for an un-allocated workspace — mirrors the spec §4.4
  // wireframe: "Trial (4d left)" / "Paused" / free-seat availability copy.
  function rowStatusOff(ws: (typeof owned)[number]): string {
    if (ws.state === "paused") return "Paused";
    if (ws.state === "trialing") {
      const daysLeft =
        ws.trialEndsAt != null
          ? Math.max(0, Math.ceil((ws.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
          : null;
      const trialStr = daysLeft != null ? `Trial · ${daysLeft}d left` : "Trial";
      return freeSeats > 0 ? `${trialStr} · free seat available` : `${trialStr} · no free seat`;
    }
    // state === "active" but not yet allocated (seat freed by a deallocation, or
    // an extra workspace the owner added since their last allocation).
    return freeSeats > 0 ? "Not activated · free seat available" : "Not activated · no free seat";
  }

  async function toggle(workspaceId: string, next: boolean): Promise<void> {
    if (!isOwner || loading) return;
    rowError = null;
    const code = next ? await allocateLicense(workspaceId) : await deallocateLicense(workspaceId);
    if (code) rowError = { workspaceId, message: errorCopy(code) };
  }

  // The buy/upgrade CTA reuses the real paywall (ActivateLicenseModal → iOS
  // IapPaywall tier ladder / web Stripe). The modal is mounted by TrialBar /
  // the billing page; here we just open it.
  function openUpgrade(): void {
    licenseState.openModal();
  }

  function fmtDate(ms: number | null): string {
    if (!ms || Number.isNaN(ms)) return "—";
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  // Product label from the pool's seat count, e.g. "Cyborg7 Pro — 5 Workspaces".
  const productLabel = $derived(
    pool ? `Cyborg7 Pro — ${seats} Workspace${seats === 1 ? "" : "s"}` : "Cyborg7 Pro",
  );

  // Manage copy depends on the rail (Apple manages iOS subs; Stripe portal for web).
  const manageHint = $derived(
    pool?.rail === "ios"
      ? "Change your tier or cancel in the App Store."
      : "Change your plan or cancel in the Stripe billing portal.",
  );
</script>

<section class="space-y-3">
  <span class="block text-xs font-medium uppercase tracking-wider text-content-muted">
    Workspace licenses
  </span>

  {#if loading && !pool}
    <!-- First load, no cached pool yet. -->
    <div class="rounded-lg border border-edge px-4 py-8 text-center">
      <p class="text-sm text-content-muted">Loading your seats…</p>
    </div>
  {:else if !pool}
    <!-- ── No pool: free/trial only → route to the tier picker / checkout ── -->
    <div class="rounded-lg border border-edge px-4 py-6 text-center space-y-3">
      <div class="space-y-1">
        <p class="text-sm font-medium text-content">No seats yet</p>
        <p class="text-xs text-content-muted">
          Subscribe to Cyborg7 Pro to get workspace seats, then assign them to the
          workspaces you want to keep online.
        </p>
      </div>
      {#if isOwner}
        <button
          type="button"
          onclick={openUpgrade}
          class="min-h-[44px] rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-semibold text-btn-primary-text transition-opacity hover:opacity-90"
        >
          {onIos ? "Choose a plan" : "Subscribe"}
        </button>
      {:else}
        <p class="text-xs text-content-muted">
          Only the workspace owner can start a subscription.
        </p>
      {/if}
    </div>
  {:else if noActivePool}
    <!-- ── Paused/expired pool: seatCount collapsed to 0 ──────────────────────
         The subscription lapsed, so the pool grants 0 seats. Showing the
         over-allocated re-pick band, the "N of 0 used" math, or an "Upgrade
         tier" CTA here is meaningless — there are no seats to keep or upgrade.
         Renew to restore the pool. The CTA is routed via the server billing
         intent (stripe_checkout → reopen the activate/renew modal); other
         intents (manage_in_mobile / contact_admin) are informational copy. -->
    <div
      class="rounded-lg border border-edge px-4 py-6 text-center space-y-3"
      style="background: color-mix(in srgb, var(--color-error, #e01e5a) 8%, transparent);"
    >
      <div class="space-y-1">
        <p class="text-sm font-medium text-content">
          {intent?.title ?? "Subscription paused"}
        </p>
        <p class="text-xs text-content-muted">
          {intent?.message ??
            "Your subscription is paused — renew to restore your workspace seats."}
        </p>
      </div>
      {#if pausedIntentHasCta}
        <button
          type="button"
          onclick={openUpgrade}
          class="min-h-[44px] rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-semibold text-btn-primary-text transition-opacity hover:opacity-90"
        >
          {intent?.ctaLabel ?? "Renew"}
        </button>
      {:else if !intent && isOwner}
        <!-- No intent yet (older relay / first paint): fall back to the owner
             renew affordance so the paused state is never a dead end. -->
        <button
          type="button"
          onclick={openUpgrade}
          class="min-h-[44px] rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-semibold text-btn-primary-text transition-opacity hover:opacity-90"
        >
          Renew
        </button>
      {/if}
    </div>
  {:else}
    <!-- ── Pool header: "N of M used" + product line + manage ── -->
    <div class="rounded-lg border border-edge">
      <div class="flex items-start justify-between gap-3 px-4 py-3">
        <div class="min-w-0">
          <div class="text-sm font-semibold text-content">{productLabel}</div>
          <div class="mt-0.5 text-[11.5px] text-content-muted">
            {#if pool.cancelAtPeriodEnd}
              Access until {fmtDate(pool.currentPeriodEnd)}
            {:else if pool.currentPeriodEnd}
              Renews {fmtDate(pool.currentPeriodEnd)}
            {:else}
              Monthly
            {/if}
          </div>
        </div>
        <span
          class="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
          style="color: var(--c7-accent, var(--color-link)); background: color-mix(in srgb, var(--c7-accent, var(--color-link)) 14%, transparent);"
        >
          {used} of {seats} used
        </span>
      </div>

      {#if overAllocated}
        <!-- ── Over-allocated (DECISIONS OQ-4 = FORCE RE-PICK) ──────────────
             A downgrade left more workspaces allocated than the pool grants.
             Until the owner turns enough OFF, the over-limit workspaces are
             PAUSED server-side — they choose which {seats} stay Pro. -->
        <div
          class="border-t border-edge px-4 py-3"
          style="background: color-mix(in srgb, var(--color-warning, #e8ab5a) 10%, transparent);"
        >
          <p class="text-[12.5px] font-semibold text-content">
            You downgraded to {seats} seat{seats === 1 ? "" : "s"} but have {used} workspaces active.
          </p>
          <p class="mt-1 text-[12px] text-content-muted">
            Turn off {used - seats} workspace{used - seats === 1 ? "" : "s"} to choose which
            {seats} keep Pro. The rest stay paused until you pick.
          </p>
        </div>
      {/if}
    </div>

    <!-- ── Owned-workspace list with per-row Pro toggles ── -->
    {#if !isOwner}
      <p class="rounded-lg border border-edge px-4 py-3 text-xs text-content-muted">
        Only the workspace owner can assign seats. Ask your owner to activate this
        workspace.
      </p>
    {:else if owned.length === 0}
      <p class="rounded-lg border border-edge px-4 py-3 text-xs text-content-muted">
        You don't own any workspaces to assign seats to.
      </p>
    {:else}
      <div class="rounded-lg border border-edge divide-y divide-edge">
        {#each owned as ws (ws.id)}
          {@const on = licenseState.isAllocated(ws.id)}
          {@const canEnable = on || freeSeats > 0}
          <div class="flex min-h-[44px] items-center gap-3 px-4 py-2.5">
            <!-- Status dot: filled (accent) when allocated, hollow otherwise. -->
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              style={on
                ? "background: var(--color-online, #3daa7c);"
                : "background: transparent; box-shadow: inset 0 0 0 1.5px var(--text-muted);"}
            ></span>
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm text-content">{ws.name}</div>
              <div class="text-[11px] text-content-muted">
                {#if on}
                  Pro · active
                {:else}
                  {rowStatusOff(ws)}
                {/if}
              </div>
              {#if rowError && rowError.workspaceId === ws.id}
                <div class="mt-0.5 text-[11px] text-error">{rowError.message}</div>
              {/if}
            </div>
            {#if !on && !canEnable}
              <!-- All seats used + this one is off → upgrade instead of toggle. -->
              <button
                type="button"
                onclick={openUpgrade}
                class="min-h-[44px] shrink-0 text-[12px] font-semibold text-accent hover:underline"
              >
                Upgrade
              </button>
            {:else}
              <!-- ≥44pt tap target around the switch for touch. -->
              <label
                class="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-end {loading
                  ? 'opacity-60'
                  : ''}"
              >
                <span class="sr-only">Pro for {ws.name}</span>
                <Switch
                  checked={on}
                  disabled={loading}
                  onCheckedChange={(next) => void toggle(ws.id, next)}
                />
              </label>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Free-seat hint + upgrade CTA (matches the wireframe footer). -->
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-xs text-content-muted">
          {#if overAllocated}
            Over your seat limit — turn workspaces off to continue.
          {:else if freeSeats > 0}
            {freeSeats} seat{freeSeats === 1 ? "" : "s"} free. Toggle a workspace on to
            activate it — no extra charge.
          {:else}
            All {seats} seat{seats === 1 ? "" : "s"} in use.
          {/if}
        </p>
        <button
          type="button"
          onclick={openUpgrade}
          class="min-h-[44px] shrink-0 rounded-lg border border-edge px-3 py-2 text-[12px] font-semibold text-content transition-colors hover:bg-surface-alt"
        >
          {freeSeats > 0 ? `Need more than ${seats}?` : "Upgrade tier"}
        </button>
      </div>
      <p class="text-[11px] text-content-muted">{manageHint}</p>
    {/if}
  {/if}
</section>

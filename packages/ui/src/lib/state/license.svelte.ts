// Server-authoritative license state. Replaces the old localStorage trial clock
// (trial.svelte.ts) with the relay's getLicenseStatus payload, fetched on
// workspace open/connect and re-fetched after returning from Stripe Checkout.
//
// The SERVER is authoritative: `state` ('trialing' | 'active' | 'paused') and
// `trialEndsAt` come straight from the relay. The localStorage trial is gone —
// the only thing persisted here is which workspace's bar the user dismissed,
// which lives in workspaces.settings.trialDismissed (handled by TrialBar).

// Mirror of PgSync.getLicenseStatus (relay-standalone cyborg:fetch_license /
// GET /api/stripe/license). All time fields are epoch ms or null.
export interface ServerLicense {
  state: "trialing" | "active" | "paused";
  plan: string;
  trialEndsAt: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  status: string | null;
}

// Mirror of the server's BillingIntent (packages/server/.../billing/intent.ts).
// The CONTEXT-AWARE billing card: WHAT action this caller can take about billing
// right now on THIS surface (source × state × platform × role), plus ready copy.
// The server computes it (the matrix lives there, unit-tested); the client only
// renders `title`/`message`/`ctaLabel` and dispatches on `action`. Keep the
// BillingAction union in lockstep with the server.
export type BillingAction =
  | "stripe_checkout"
  | "stripe_portal"
  | "iap_purchase"
  | "iap_manage"
  | "manage_on_web"
  | "manage_in_mobile"
  | "contact_admin"
  | "owner_only";

export interface BillingIntent {
  action: BillingAction;
  title: string;
  message: string;
  ctaLabel?: string;
}

// ─── License pool + allocation (per-workspace seat model, spec §4.3) ──────────
// The pool is the caller's seat ENTITLEMENT on a rail; allocations are the seats
// they've SPENT on specific workspaces. The LicenseAllocationPanel renders
// "N of M used" from these. Shapes mirror the ws-client `LicensePoolPayload` /
// `OwnedWorkspaceEntry` (kept structurally identical so the panel can store the
// relay's `cyborg:fetch_license_pool` response here verbatim).

export interface LicensePool {
  /** Seats the pool grants (M in "N of M used"). */
  seatCount: number;
  /** Mirrors subscriptions.status: 'active' | 'trialing' | 'canceled' | … */
  status: string;
  /** Renewal/expiry of the pool (epoch ms) or null. */
  currentPeriodEnd: number | null;
  /** Which rail funds the pool (drives the manage/upgrade affordance). */
  rail: "ios" | "stripe";
  /** Pool will not renew (Apple cancel-in-period / Stripe cancel). */
  cancelAtPeriodEnd: boolean;
}

/** A workspace the caller owns (the relay's authoritative owned-list). */
export interface OwnedWorkspace {
  id: string;
  name: string;
  /** Mirror of getLicenseStatus.state — drives per-row status in the panel. */
  state: "trialing" | "active" | "paused";
  /** Epoch ms trial expiry, or null (non-trial workspaces). */
  trialEndsAt: number | null;
}

// UI phase the TrialBar renders. Derived from the server `state` + trialEndsAt.
// "trial-ending" is a soft warning band inside the trial; "none" hides the bar.
type Phase = "trial-active" | "trial-ending" | "expired" | "active-plan" | "none";

const ENDING_THRESHOLD_DAYS = 3;

const inner = $state({
  // null until the first fetch resolves — the bar stays hidden meanwhile.
  license: null as ServerLicense | null,
  // The server-computed billing intent for the CURRENT platform (what action the
  // billing UI should offer + copy). null until the first fetch resolves, or when
  // a non-fetch path (gate-rejection error payload, seat allocation) sets only the
  // license — those paths trigger a refreshLicense that repopulates it.
  intent: null as BillingIntent | null,
  now: Date.now(),
  // Drives the activate modal from anywhere (trial bar, paused-gate handler).
  modalOpen: false,

  // ── Seat-allocation surface (spec §4) ──────────────────────────────────────
  // The caller's seat ENTITLEMENT on a rail; null = no pool (free/trial only),
  // so the LicenseAllocationPanel shows the tier picker / checkout CTA instead
  // of toggles. Populated by app.svelte.ts fetchLicensePool().
  pool: null as LicensePool | null,
  // workspaceIds that currently SPEND a seat. A Set so toggles are O(1) and the
  // panel can render each owned workspace's on/off state directly.
  allocations: new Set<string>(),
  // The relay's authoritative list of workspaces the caller OWNS (the only
  // workspaces a seat can be allocated to). Comes from the same pool fetch — we
  // do NOT derive ownership from workspaceState.list (its `ownerId` is unset).
  ownedWorkspaces: [] as OwnedWorkspace[],
  // True while a fetch/allocate/deallocate round-trip is in flight (panel spinner
  // + disables toggles to prevent double-spend races).
  poolLoading: false,
});

// Roll daysLeft over once an hour while the tab is open so the chip updates
// without a refresh (mirrors the old trial scaffold's interval).
if (typeof window !== "undefined") {
  setInterval(
    () => {
      inner.now = Date.now();
    },
    60 * 60 * 1000,
  );
}

function computeDaysLeft(endsAt: number | null, now: number): number {
  if (endsAt == null || Number.isNaN(endsAt)) return 0;
  return Math.max(0, Math.ceil((endsAt - now) / (24 * 60 * 60 * 1000)));
}

export const licenseState = {
  get license(): ServerLicense | null {
    return inner.license;
  },
  get state(): ServerLicense["state"] | null {
    return inner.license?.state ?? null;
  },
  // The server-computed billing intent for this surface (null until first fetch).
  // Drives the context-aware billing cards (modal / trial bar / settings page).
  get intent(): BillingIntent | null {
    return inner.intent;
  },
  get phase(): Phase {
    const lic = inner.license;
    if (!lic) return "none";
    if (lic.state === "active") return "active-plan";
    if (lic.state === "paused") return "expired";
    // trialing
    const days = computeDaysLeft(lic.trialEndsAt, inner.now);
    if (days <= ENDING_THRESHOLD_DAYS) return "trial-ending";
    return "trial-active";
  },
  get daysLeft(): number {
    return computeDaysLeft(inner.license?.trialEndsAt ?? null, inner.now);
  },
  get paused(): boolean {
    return inner.license?.state === "paused";
  },
  get modalOpen(): boolean {
    return inner.modalOpen;
  },
  set modalOpen(value: boolean) {
    inner.modalOpen = value;
  },
  openModal(): void {
    inner.modalOpen = true;
  },
  set(license: ServerLicense | null): void {
    inner.license = license;
    inner.now = Date.now();
  },
  // Adopt the server-computed billing intent (from the same fetch as `set`). Kept
  // a SEPARATE setter so the non-fetch `set` call sites (gate-rejection error
  // payload, seat allocation) don't have to thread an intent they don't carry.
  setIntent(intent: BillingIntent | null): void {
    inner.intent = intent;
  },
  clear(): void {
    inner.license = null;
    inner.intent = null;
    // Also drop the allocation surface so it can't leak across workspaces /
    // sessions (mirrors the billing page's clear-before-refetch guard).
    inner.pool = null;
    inner.allocations = new Set();
    inner.ownedWorkspaces = [];
    inner.poolLoading = false;
  },

  // ── Seat-allocation getters (spec §4) ───────────────────────────────────────
  get pool(): LicensePool | null {
    return inner.pool;
  },
  /** workspaceIds currently spending a seat. Read-only snapshot for the panel. */
  get allocations(): ReadonlySet<string> {
    return inner.allocations;
  },
  get ownedWorkspaces(): readonly OwnedWorkspace[] {
    return inner.ownedWorkspaces;
  },
  get poolLoading(): boolean {
    return inner.poolLoading;
  },
  set poolLoading(value: boolean) {
    inner.poolLoading = value;
  },
  /** Seats the pool grants (M in "N of M used"). 0 when there is no pool. */
  get seats(): number {
    return inner.pool?.seatCount ?? 0;
  },
  /** Seats spent = honored allocations (N in "N of M used"). */
  get usedSeats(): number {
    return inner.allocations.size;
  },
  /** Seats available to allocate with no purchase. Never negative. */
  get freeSeats(): number {
    return Math.max(0, this.seats - this.usedSeats);
  },
  /**
   * More workspaces are allocated than the pool now grants (e.g. after a tier
   * downgrade). Drives the spec §6.1 forced-re-pick screen — until the owner
   * re-picks which M to keep, over-limit workspaces are paused server-side.
   */
  get overAllocated(): boolean {
    return this.usedSeats > this.seats;
  },
  /** True iff `workspaceId` currently spends a seat. */
  isAllocated(workspaceId: string): boolean {
    return inner.allocations.has(workspaceId);
  },
  /**
   * Adopt a fresh `cyborg:fetch_license_pool` (or allocate/deallocate) response.
   * Replaces the whole surface atomically so the panel re-renders once. Accepts
   * the wire shape (cancelAtPeriodEnd optional) and normalizes it to a definite
   * boolean so the rest of the UI never has to null-check it.
   */
  setPool(
    pool: PoolInput | null,
    allocations: { workspaceId: string }[],
    ownedWorkspaces: OwnedWorkspace[],
  ): void {
    inner.pool = normalizePool(pool);
    inner.allocations = new Set(allocations.map((a) => a.workspaceId));
    inner.ownedWorkspaces = ownedWorkspaces;
  },
  /**
   * Adopt just the pool + allocations after an allocate/deallocate mutation
   * (the owned-workspaces list is unchanged by a toggle, so it's preserved).
   */
  setPoolAndAllocations(pool: PoolInput | null, allocations: { workspaceId: string }[]): void {
    inner.pool = normalizePool(pool);
    inner.allocations = new Set(allocations.map((a) => a.workspaceId));
  },
};

// The relay/ws-client pool shape has `cancelAtPeriodEnd` optional; the stored
// LicensePool makes it definite. Accept the looser input at the setter boundary.
type PoolInput = Omit<LicensePool, "cancelAtPeriodEnd"> & { cancelAtPeriodEnd?: boolean };

function normalizePool(pool: PoolInput | null): LicensePool | null {
  if (!pool) return null;
  return { ...pool, cancelAtPeriodEnd: pool.cancelAtPeriodEnd ?? false };
}

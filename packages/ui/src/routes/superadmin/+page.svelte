<script lang="ts">
  // Overview (contract §5). Metric cards + workspace-cloud status + plan /
  // purchase-platform breakdowns + recent signups. Consumes GET
  // /api/superadmin/overview.
  //
  // No <a>/<ul>/<li>: navigation goes through <button onclick={goto}>, lists are
  // <div> rows (the unlayered global a/ul rules in app.css beat Tailwind).
  import { goto } from "$app/navigation";
  import Avatar from "$lib/components/Avatar.svelte";
  import { getOverview, type SuperadminOverview } from "./api.js";
  import { fmtNumber, fmtRelative } from "./format.js";
  import { editionClass, editionLabel } from "./badges.js";

  let data = $state<SuperadminOverview | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  $effect(() => {
    void load();
  });

  let loaded = false;
  async function load(): Promise<void> {
    if (loaded) return;
    loaded = true;
    loading = true;
    error = null;
    try {
      data = await getOverview();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load overview";
    } finally {
      loading = false;
    }
  }

  type MetricIcon = "users" | "building" | "card" | "shield";
  const cards = $derived.by((): { label: string; value: string; icon: MetricIcon; href: string }[] => {
    if (!data) return [];
    return [
      { label: "Users", value: fmtNumber(data.totals.users), icon: "users", href: "/superadmin/users" },
      { label: "Workspaces", value: fmtNumber(data.totals.workspaces), icon: "building", href: "/superadmin/orgs" },
      { label: "Subscriptions", value: fmtNumber(data.totals.subscriptions), icon: "card", href: "/superadmin/orgs" },
      { label: "Superadmins", value: fmtNumber(data.totals.superadmins), icon: "shield", href: "/superadmin/admins" },
    ];
  });

  // Plan chip tone: paid plans get the positive token, free/unknown stay quiet.
  function planChipClass(plan: string | null): string {
    return plan && plan !== "free" ? "bg-online/15 text-online" : "bg-surface-alt text-content-muted";
  }
</script>

<!-- Shared card chrome used across the breakdown panels. -->
{#snippet metricIcon(icon: MetricIcon)}
  <svg
    class="h-4 w-4"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if icon === "users"}
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    {:else if icon === "building"}
      <path d="M3 21h18" />
      <path d="M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16" />
      <path d="M17 21V9h2a2 2 0 0 1 2 2v10" />
    {:else if icon === "card"}
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    {:else if icon === "shield"}
      <path d="M12 2l8 4v5c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V6l8-4z" />
    {/if}
  </svg>
{/snippet}

<div class="mx-auto max-w-5xl space-y-6 px-6 py-7">
  <header>
    <h1 class="text-[28px] font-bold tracking-[-0.01em] text-content">Platform overview</h1>
    <p class="mt-1 text-sm text-content-muted">
      Totals, plans, and recent activity across the platform.
    </p>
  </header>

  {#if loading}
    <!-- Skeleton dashboard (not bare "Loading…"). -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {#each Array(4) as _, i (i)}
        <div
          class="rounded-[14px] px-4 py-4"
          style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
        >
          <div class="skeleton h-3 w-16 rounded"></div>
          <div class="skeleton mt-3 h-7 w-12 rounded"></div>
        </div>
      {/each}
    </div>
    <div class="grid gap-5 lg:grid-cols-3">
      {#each Array(3) as _, i (i)}
        <div
          class="rounded-[14px] p-4"
          style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
        >
          <div class="skeleton h-4 w-24 rounded"></div>
          <div class="mt-4 space-y-3">
            {#each Array(3) as _, j (j)}
              <div class="skeleton h-4 w-full rounded"></div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div class="rounded-[14px] border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">
      {error}
    </div>
  {:else if data}
    <!-- Primary metric cards — each navigates to its section. -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {#each cards as card (card.label)}
        <button
          type="button"
          onclick={() => goto(card.href)}
          class="cursor-pointer rounded-[14px] px-4 py-4 text-left transition-colors hover:bg-surface-alt/60"
          style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
        >
          <div class="flex items-center justify-between">
            <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">
              {card.label}
            </span>
            <span class="text-content-dim">{@render metricIcon(card.icon)}</span>
          </div>
          <div class="mt-2 text-2xl font-bold text-content">{card.value}</div>
        </button>
      {/each}
    </div>

    <!-- Workspace cloud status — cloud (≥1 daemon) vs. no daemon connected. -->
    <div
      class="rounded-[14px] px-4 py-4"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <h2 class="text-sm font-bold text-content">Workspace cloud status</h2>
      <p class="mt-0.5 text-[12px] text-content-muted">
        Workspaces syncing to the shared cloud via daemons vs. none connected.
      </p>
      <div class="mt-3 grid grid-cols-2 gap-3">
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full bg-online"></span>
            <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">Cloud</span>
          </div>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.workspaceCloud.cloud)}</div>
          <div class="mt-0.5 text-[11px] text-content-dim">
            {fmtNumber(data.workspaceCloud.online)} online now
          </div>
        </div>
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full bg-content-dim"></span>
            <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">No daemon</span>
          </div>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.workspaceCloud.noDaemon)}</div>
          <div class="mt-0.5 text-[11px] text-content-dim">not connected</div>
        </div>
      </div>
    </div>

    <!-- Live usage — active agent sessions / cybos across online daemons + the
         per-active-user averages and per-edition rollup. All 0 / empty until
         daemons emit the new counts (renders cleanly at zero). -->
    <div
      class="rounded-[14px] px-4 py-4"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <h2 class="text-sm font-bold text-content">Live usage</h2>
      <p class="mt-0.5 text-[12px] text-content-muted">
        Active agent sessions and cybos across online daemons, and per-user averages.
      </p>

      <!-- (a) Platform-wide active totals -->
      <div class="mt-3 grid grid-cols-3 gap-3">
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">Active sessions</span>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.sessions.activeSessions)}</div>
        </div>
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">Active cybos</span>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.sessions.activeCybos)}</div>
        </div>
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">Active users</span>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.perUserMetrics.activeUsers)}</div>
          <div class="mt-0.5 text-[11px] text-content-dim">users with an online daemon</div>
        </div>
      </div>

      <!-- (b) Per-user averages (own sub-block, divided off the totals) -->
      <div class="mt-4" style="height: 0.5px; background: var(--hairline);"></div>
      <div class="mt-3 flex items-baseline justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">Per-user averages</span>
        <span class="text-[11px] text-content-dim">averaged over active daemon-owners</span>
      </div>
      <div class="mt-2 grid grid-cols-3 gap-3">
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">Mean sessions / user</span>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.perUserMetrics.meanActiveSessions)}</div>
        </div>
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">Mean cybos / user</span>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.perUserMetrics.meanActiveCybos)}</div>
        </div>
        <div class="rounded-[12px] bg-surface-alt px-4 py-3">
          <span class="text-[11px] font-medium uppercase tracking-wide text-content-muted">Mean agents / user</span>
          <div class="mt-2 text-2xl font-bold text-content">{fmtNumber(data.perUserMetrics.meanAgents)}</div>
        </div>
      </div>

      <!-- (c) Per-edition rollup (saas | selfhost | opensource) -->
      <div class="mt-4" style="height: 0.5px; background: var(--hairline);"></div>
      <div class="mt-3 flex items-baseline justify-between gap-2">
        <span class="text-[11px] font-semibold uppercase tracking-wide text-content-muted">Editions</span>
        <span class="text-[11px] text-content-dim">edition = saas | selfhost | opensource</span>
      </div>
      <div class="mt-2">
        {#each data.editionBreakdown as row, i (row.edition)}
          {#if i > 0}<div class="mx-1" style="height: 0.5px; background: var(--hairline);"></div>{/if}
          <div class="flex items-center justify-between gap-3 px-1 py-2 text-sm">
            <span
              class="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {editionClass(
                row.edition,
              )}"
            >
              {editionLabel(row.edition)}
            </span>
            <div class="flex items-center gap-4 text-[12px] text-content-muted">
              <span>{fmtNumber(row.daemons)} <span class="text-content-dim">daemons</span></span>
              <span>{fmtNumber(row.activeSessions)} <span class="text-content-dim">sessions</span></span>
              <span>{fmtNumber(row.activeCybos)} <span class="text-content-dim">cybos</span></span>
            </div>
          </div>
        {:else}
          <p class="px-1 py-2 text-sm text-content-muted">No daemons reporting yet.</p>
        {/each}
      </div>
    </div>

    <!-- Breakdowns: plans + purchase platform -->
    <div class="grid gap-5 lg:grid-cols-2">
      <!-- Plan breakdown -->
      <div
        class="overflow-hidden rounded-[14px]"
        style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
      >
        <div class="px-4 py-3">
          <h2 class="text-sm font-bold text-content">Plans</h2>
        </div>
        <div style="height: 0.5px; background: var(--hairline);"></div>
        <div>
          {#each data.plans as row, i (`${row.plan}-${row.status}`)}
            {#if i > 0}<div class="mx-4" style="height: 0.5px; background: var(--hairline);"></div>{/if}
            <div class="flex items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <div class="flex min-w-0 items-center gap-2">
                <span
                  class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {planChipClass(
                    row.plan,
                  )}"
                >
                  {row.plan ?? "unknown"}
                </span>
                {#if row.status}
                  <span class="truncate text-[12px] text-content-muted">{row.status}</span>
                {/if}
              </div>
              <span class="font-semibold text-content">{fmtNumber(row.count)}</span>
            </div>
          {:else}
            <p class="px-4 py-3 text-sm text-content-muted">No subscriptions.</p>
          {/each}
        </div>
      </div>

      <!-- Purchase platform -->
      <div
        class="overflow-hidden rounded-[14px]"
        style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
      >
        <div class="px-4 py-3">
          <h2 class="text-sm font-bold text-content">Purchase platform</h2>
        </div>
        <div style="height: 0.5px; background: var(--hairline);"></div>
        <div>
          {#each data.purchasePlatform as row, i (row.platform)}
            {#if i > 0}<div class="mx-4" style="height: 0.5px; background: var(--hairline);"></div>{/if}
            <div class="flex items-center justify-between px-4 py-2.5 text-sm">
              <span
                class="inline-flex items-center rounded bg-surface-alt px-1.5 py-0.5 text-[11px] font-medium capitalize text-content-muted"
              >
                {row.platform}
              </span>
              <span class="font-semibold text-content">{fmtNumber(row.count)}</span>
            </div>
          {:else}
            <p class="px-4 py-3 text-sm text-content-muted">No data.</p>
          {/each}
        </div>
      </div>
    </div>

    <!-- Recent signups -->
    <div
      class="overflow-hidden rounded-[14px]"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <div class="px-4 py-3">
        <h2 class="text-sm font-bold text-content">Recent signups</h2>
      </div>
      <div style="height: 0.5px; background: var(--hairline);"></div>
      <div>
        {#each data.recentSignups as u, i (u.id)}
          {#if i > 0}<div class="ml-[60px]" style="height: 0.5px; background: var(--hairline);"></div>{/if}
          <button
            type="button"
            onclick={() => goto(`/superadmin/users/${u.id}`)}
            class="pressable-row flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-surface-alt/60"
          >
            <Avatar name={u.name ?? u.email} image={u.imageUrl} size="sm" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium text-content">{u.name ?? u.email}</div>
              {#if u.name}<div class="truncate text-[12px] text-content-muted">{u.email}</div>{/if}
            </div>
            <span class="shrink-0 text-[12px] text-content-muted">{fmtRelative(u.createdAt)}</span>
          </button>
        {:else}
          <p class="px-4 py-3 text-sm text-content-muted">No recent signups.</p>
        {/each}
      </div>
    </div>
  {/if}
</div>

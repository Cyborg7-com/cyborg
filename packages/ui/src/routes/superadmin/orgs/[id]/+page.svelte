<script lang="ts">
  // Organization detail (contract §5). Members + subscription + daemons + the
  // rich daemon "more info" grid. Superadmin actions: change plan (POST
  // /workspaces/:wid/plan), per-member change role (POST
  // /workspaces/:wid/members/:uid/role), and disable/enable the whole org
  // (POST /workspaces/:wid/disable | /enable). Consumes GET
  // /api/superadmin/orgs/:id.
  //
  // No <a>/<ul>/<li>: nav is <button onclick={goto}>, lists are <div> rows.
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import Avatar from "$lib/components/Avatar.svelte";
  import {
    getOrg,
    setWorkspacePlan,
    setMemberRole,
    disableOrg,
    enableOrg,
    type OrgDetail,
    type OrgDaemon,
  } from "../../api.js";
  import { fmtDate, fmtCpu, fmtMem, fmtUptime, fmtBool } from "../../format.js";
  import {
    daemonStatusClass,
    subscriptionStatusClass,
    deploymentModeClass,
    deploymentModeLabel,
    editionClass,
    editionLabel,
  } from "../../badges.js";
  import ConfirmDialog from "../../ConfirmDialog.svelte";

  const PLANS = ["free", "pro"];
  const ROLES = ["owner", "admin", "member", "viewer"];

  const orgId = $derived(page.params.id);

  let data = $state<OrgDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let flash = $state("");

  // Plan editor state.
  let planValue = $state("");
  let statusValue = $state("");
  let savingPlan = $state(false);

  // Per-member role-change in flight (by userId).
  let savingRole = $state<string | null>(null);

  // Disable/enable dialog state. Disable carries an OPTIONAL reason.
  let disableReason = $state("");
  let disableOpen = $state(false);
  let enableOpen = $state(false);

  const isDisabled = $derived(data?.disabled?.at != null);

  $effect(() => {
    const id = orgId;
    if (id) void load(id);
  });

  async function load(id: string): Promise<void> {
    loading = true;
    error = null;
    try {
      data = await getOrg(id);
      planValue = data.subscription?.plan ?? "free";
      statusValue = data.subscription?.status ?? "";
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load organization";
    } finally {
      loading = false;
    }
  }

  function showFlash(msg: string) {
    flash = msg;
    setTimeout(() => (flash = ""), 2500);
  }

  async function handleSavePlan(): Promise<void> {
    if (!data || savingPlan) return;
    savingPlan = true;
    try {
      await setWorkspacePlan(data.id, planValue, statusValue || undefined);
      showFlash("Plan updated");
      await load(data.id);
    } catch (e) {
      showFlash(e instanceof Error ? e.message : "Failed to update plan");
    } finally {
      savingPlan = false;
    }
  }

  async function handleRoleChange(userId: string, role: string): Promise<void> {
    if (!data) return;
    savingRole = userId;
    try {
      await setMemberRole(data.id, userId, role);
      // Mutate only the affected member so unrelated `data.*` reads don't react.
      const member = data.members.find((m) => m.userId === userId);
      if (member) member.role = role;
      showFlash("Role updated");
    } catch (e) {
      showFlash(e instanceof Error ? e.message : "Failed to update role");
      // Reload to resync the select with server truth on failure.
      await load(data.id);
    } finally {
      savingRole = null;
    }
  }

  // The dialog surfaces its own thrown error inline and only closes on success;
  // a thrown error here keeps the dialog open. We refetch after each so the
  // header pill + toolbar flip to the new state.
  async function doDisable(): Promise<void> {
    if (!data) return;
    await disableOrg(data.id, disableReason.trim());
    disableReason = "";
    showFlash("Organization disabled");
    await load(data.id);
  }

  async function doEnable(): Promise<void> {
    if (!data) return;
    await enableOrg(data.id);
    showFlash("Organization enabled");
    await load(data.id);
  }

  // Secondary-button base shared by the action toolbar (matches user-detail).
  const secondaryBtn =
    "rounded-lg border border-edge px-3 py-1.5 text-sm font-medium text-content-muted transition-colors hover:bg-surface-alt hover:text-content disabled:cursor-not-allowed disabled:opacity-40";

  // Per-daemon key/value pairs for the "more info" grid. Built from the present
  // fields only; null/absent fields render greyed with an em-dash so the grid
  // stays uniform but signals "no data" rather than hiding it.
  interface DaemonField {
    label: string;
    value: string;
    muted: boolean;
  }
  function daemonFields(d: OrgDaemon): DaemonField[] {
    const fields: { label: string; value: string; present: boolean }[] = [
      { label: "Owner", value: d.ownerEmail ?? "—", present: d.ownerEmail != null },
      { label: "Host", value: d.host ?? "—", present: d.host != null },
      {
        label: "Platform",
        value:
          d.platform != null && d.arch != null
            ? `${d.platform} · ${d.arch}`
            : (d.platform ?? d.arch ?? "—"),
        present: d.platform != null || d.arch != null,
      },
      { label: "CPU", value: fmtCpu(d.cpu), present: d.cpu != null },
      { label: "Memory", value: fmtMem(d.memMb), present: d.memMb != null },
      { label: "Agents", value: d.agents != null ? String(d.agents) : "—", present: d.agents != null },
      {
        label: "Active sessions",
        value: d.activeSessionCount != null ? String(d.activeSessionCount) : "—",
        present: d.activeSessionCount != null,
      },
      {
        label: "Active cybos",
        value: d.activeCyboCount != null ? String(d.activeCyboCount) : "—",
        present: d.activeCyboCount != null,
      },
      {
        label: "Queue depth",
        value: d.queueDepth != null ? String(d.queueDepth) : "—",
        present: d.queueDepth != null,
      },
      { label: "Uptime", value: fmtUptime(d.uptime), present: d.uptime != null },
      { label: "Accepting", value: fmtBool(d.accepting), present: d.accepting != null },
      { label: "Cybo installed", value: fmtBool(d.cyboInstalled), present: d.cyboInstalled != null },
      { label: "Last seen", value: fmtDate(d.lastSeenAt), present: d.lastSeenAt != null },
    ];
    return fields.map((f) => ({ label: f.label, value: f.value, muted: !f.present }));
  }
</script>

<div class="mx-auto max-w-4xl space-y-6 px-6 py-7">
  <button
    type="button"
    onclick={() => goto("/superadmin/orgs")}
    class="inline-flex items-center gap-1 text-[13px] text-content-muted transition-colors hover:text-content"
  >
    <svg
      class="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
    All organizations
  </button>

  {#if loading}
    <!-- Skeleton detail (not bare "Loading…"). -->
    <div class="flex items-center gap-3.5">
      <div class="skeleton h-12 w-12 rounded-[12px]"></div>
      <div class="flex-1 space-y-2">
        <div class="skeleton h-6 w-48 rounded"></div>
        <div class="skeleton h-3.5 w-64 rounded"></div>
      </div>
    </div>
    <div class="skeleton h-16 w-full rounded-[14px]"></div>
    <div class="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {#each Array(6) as _, i (i)}<div class="skeleton h-16 rounded-[14px]"></div>{/each}
    </div>
    {#each Array(3) as _, i (i)}
      <div
        class="rounded-[14px] p-4"
        style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
      >
        <div class="skeleton h-4 w-28 rounded"></div>
        <div class="mt-4 space-y-3">
          {#each Array(2) as _, j (j)}<div class="skeleton h-5 w-full rounded"></div>{/each}
        </div>
      </div>
    {/each}
  {:else if error}
    <div class="rounded-[14px] border border-error/30 bg-error/5 px-4 py-3 text-sm text-error">{error}</div>
  {:else if data}
    <!-- Header: org identity + owner + disabled state -->
    <div class="flex items-start justify-between gap-4">
      <div class="flex min-w-0 items-center gap-3.5">
        <Avatar name={data.name} image={data.avatarUrl} size="lg" borderRadius={12} />
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-[28px] font-bold tracking-[-0.01em] text-content">{data.name}</h1>
            {#if isDisabled}
              <span class="inline-flex items-center rounded bg-error/15 px-2 py-0.5 text-[12px] font-medium text-error">
                Disabled
              </span>
            {/if}
          </div>
          <p class="mt-0.5 text-[13px] text-content-muted">
            {#if data.ownerEmail}Owner: {data.ownerEmail}{/if}
            {#if data.createdAt}· Created {fmtDate(data.createdAt)}{/if}
          </p>
          {#if isDisabled}
            <p class="mt-1.5 text-[12px] text-error/90">
              Disabled {fmtDate(data.disabled.at)}{#if data.disabled.reason} · {data.disabled.reason}{/if}
            </p>
          {/if}
        </div>
      </div>
      {#if flash}
        <span class="shrink-0 text-[13px] {flash.toLowerCase().includes('fail') ? 'text-error' : 'text-online'}">{flash}</span>
      {/if}
    </div>

    <!-- Action toolbar -->
    <section
      class="flex flex-wrap items-center gap-2 rounded-[14px] p-4"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      {#if isDisabled}
        <span class="text-[13px] text-content-muted">This organization is disabled — members can't access it.</span>
        <button
          type="button"
          onclick={() => (enableOpen = true)}
          class="ml-auto rounded-lg bg-btn-primary-bg px-3 py-1.5 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
        >
          Enable organization
        </button>
      {:else}
        <span class="text-[13px] text-content-muted">Disabling removes this org from every member's workspace list.</span>
        <button
          type="button"
          onclick={() => { disableReason = ""; disableOpen = true; }}
          class="ml-auto rounded-lg bg-error/15 px-3 py-1.5 text-sm font-medium text-error transition-colors hover:bg-error/25"
        >
          Disable organization
        </button>
      {/if}
    </section>

    <!-- Stat counts -->
    {#if data.counts}
      <div class="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {#each [
          { label: "Members", value: data.counts.members ?? data.members.length },
          { label: "Channels", value: data.counts.channels ?? 0 },
          { label: "Messages", value: data.counts.messages ?? 0 },
          { label: "Cybos", value: data.counts.cybos ?? 0 },
          { label: "Agent sessions", value: data.counts.agentSessions ?? 0 },
          { label: "Daemons", value: data.counts.daemons ?? data.daemons.length },
        ] as stat (stat.label)}
          <div class="rounded-[14px] bg-surface-alt px-4 py-3">
            <div class="text-[11px] font-medium uppercase tracking-wide text-content-muted">{stat.label}</div>
            <div class="mt-1 text-lg font-semibold text-content">{stat.value}</div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- Subscription / plan -->
    <div
      class="overflow-hidden rounded-[14px]"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <div class="flex flex-wrap items-center gap-2 px-4 py-3">
        <h2 class="text-sm font-bold text-content">Subscription</h2>
        {#if data.subscription}
          <span
            class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {data.subscription.plan && data.subscription.plan !== 'free' ? 'bg-online/15 text-online' : 'bg-surface-alt text-content-muted'}"
          >
            {data.subscription.plan ?? "free"}
          </span>
          {#if data.subscription.status}
            <span
              class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {subscriptionStatusClass(data.subscription.status)}"
            >
              {data.subscription.status}
            </span>
          {/if}
        {/if}
      </div>
      <div style="height: 0.5px; background: var(--hairline);"></div>

      <!-- Editor -->
      <div class="flex flex-wrap items-end gap-4 p-4">
        <div class="space-y-1.5">
          <label for="plan-select" class="block text-xs font-medium text-content-muted">Plan</label>
          <select
            id="plan-select"
            bind:value={planValue}
            class="h-9 rounded-lg border border-edge bg-surface px-2.5 text-sm text-content outline-none transition-colors focus:border-edge-light focus:ring-1 focus:ring-edge-light"
          >
            {#each PLANS as p (p)}
              <option value={p}>{p}</option>
            {/each}
          </select>
        </div>
        <div class="space-y-1.5">
          <label for="status-input" class="block text-xs font-medium text-content-muted">
            Status <span class="text-content-dim">(optional)</span>
          </label>
          <input
            id="status-input"
            bind:value={statusValue}
            placeholder="active / trialing / canceled"
            class="h-9 w-56 rounded-lg border border-edge bg-surface px-3 text-sm text-content outline-none transition-colors placeholder:text-content-muted focus:border-edge-light focus:ring-1 focus:ring-edge-light"
          />
        </div>
        <button
          type="button"
          onclick={handleSavePlan}
          disabled={savingPlan}
          class="rounded-lg bg-btn-primary-bg px-4 py-2 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover disabled:opacity-50"
        >
          {savingPlan ? "Saving…" : "Change plan"}
        </button>
      </div>

      <!-- Details grid -->
      {#if data.subscription}
        <div style="height: 0.5px; background: var(--hairline);"></div>
        <div class="grid grid-cols-2 gap-x-6 gap-y-3 p-4 sm:grid-cols-3">
          {#each [
            { label: "Stripe customer", value: data.subscription.stripeCustomerId ?? "—" },
            { label: "Price ID", value: data.subscription.priceId ?? "—" },
            { label: "Current period end", value: fmtDate(data.subscription.currentPeriodEnd) },
            { label: "Trial ends", value: fmtDate(data.subscription.trialEndsAt) },
            { label: "Cancel at period end", value: fmtBool(data.subscription.cancelAtPeriodEnd) },
            { label: "Purchase platform", value: data.subscription.purchasePlatform ?? "Unknown" },
          ] as field (field.label)}
            <div class="min-w-0">
              <div class="text-[11px] font-medium uppercase tracking-wide text-content-muted">{field.label}</div>
              <div class="mt-0.5 truncate text-[13px] text-content">{field.value}</div>
            </div>
          {/each}
        </div>
      {:else}
        <div style="height: 0.5px; background: var(--hairline);"></div>
        <p class="px-4 py-3 text-sm text-content-muted">No subscription on record.</p>
      {/if}
    </div>

    <!-- Members -->
    <div
      class="overflow-hidden rounded-[14px]"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <div class="flex items-center gap-2 px-4 py-3">
        <h2 class="text-sm font-bold text-content">Members</h2>
        <span class="text-[12px] text-content-muted">{data.members.length}</span>
      </div>
      <div style="height: 0.5px; background: var(--hairline);"></div>
      <div>
        {#each data.members as m, i (m.userId)}
          {#if i > 0}<div class="ml-[60px]" style="height: 0.5px; background: var(--hairline);"></div>{/if}
          <div class="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={m.name ?? m.email} image={m.imageUrl} size="sm" />
            <div class="min-w-0 flex-1">
              <button
                type="button"
                onclick={() => goto(`/superadmin/users/${m.userId}`)}
                class="truncate text-left text-sm font-medium text-content hover:text-accent"
              >
                {m.name ?? m.email}
              </button>
              {#if m.name}<div class="truncate text-[12px] text-content-muted">{m.email}</div>{/if}
            </div>
            {#if m.membershipType && m.membershipType !== "member"}
              <span
                class="inline-flex items-center rounded bg-surface-alt px-1.5 py-0.5 text-[11px] font-medium capitalize text-content-muted"
              >
                {m.membershipType}
              </span>
            {/if}
            <select
              value={m.role}
              disabled={savingRole === m.userId}
              onchange={(e) => handleRoleChange(m.userId, (e.target as HTMLSelectElement).value)}
              class="h-8 rounded-lg border border-edge bg-surface px-2 text-[13px] text-content outline-none transition-colors focus:border-edge-light focus:ring-1 focus:ring-edge-light disabled:opacity-50"
              aria-label="Member role"
            >
              {#each ROLES as r (r)}
                <option value={r}>{r}</option>
              {/each}
            </select>
          </div>
        {:else}
          <p class="px-4 py-3 text-sm text-content-muted">No members.</p>
        {/each}
      </div>
    </div>

    <!-- Daemons (rich "more info" grid) -->
    <div
      class="overflow-hidden rounded-[14px]"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <div class="flex items-center gap-2 px-4 py-3">
        <h2 class="text-sm font-bold text-content">Daemons</h2>
        <span class="text-[12px] text-content-muted">{data.daemons.length}</span>
      </div>
      <div style="height: 0.5px; background: var(--hairline);"></div>
      <div>
        {#each data.daemons as d, i (d.id)}
          {#if i > 0}<div class="mx-4" style="height: 0.5px; background: var(--hairline);"></div>{/if}
          <div class="px-4 py-3.5">
            <!-- Row header: label + status + deployment mode -->
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate text-sm font-bold text-content">{d.label ?? d.id}</span>
              <span
                class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {daemonStatusClass(d.status)}"
              >
                {d.status ?? "unknown"}
              </span>
              <span
                class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium {deploymentModeClass(d.deploymentMode)}"
              >
                {deploymentModeLabel(d.deploymentMode)}
              </span>
              <span
                class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {editionClass(d.edition)}"
              >
                {editionLabel(d.edition)}
              </span>
            </div>
            <!-- Metadata grid -->
            <div class="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-3">
              {#each daemonFields(d) as field (field.label)}
                <div class="min-w-0">
                  <div class="text-[11px] font-medium uppercase tracking-wide text-content-muted">{field.label}</div>
                  <div class="mt-0.5 truncate text-[13px] {field.muted ? 'text-content-dim' : 'text-content'}">
                    {field.value}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        {:else}
          <p class="px-4 py-3 text-sm text-content-muted">No daemons.</p>
        {/each}
      </div>
    </div>

    <!-- ── Confirm dialogs ── -->
    <ConfirmDialog
      bind:open={disableOpen}
      title="Disable organization?"
      description={`${data.name} will be removed from every member's workspace list until re-enabled. The data is not deleted.`}
      confirmLabel="Disable organization"
      bind:reason={disableReason}
      reasonLabel="Reason (optional)"
      reasonPlaceholder="Why is this org being disabled?"
      onConfirm={doDisable}
    />

    <ConfirmDialog
      bind:open={enableOpen}
      title="Enable organization?"
      description={`Restore ${data.name} for its members.`}
      confirmLabel="Enable organization"
      confirmVariant="default"
      onConfirm={doEnable}
    />
  {/if}
</div>

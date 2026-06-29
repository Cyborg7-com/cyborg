<script lang="ts">
  // User detail (contract §5). Shows workspaces/daemons/session counts + the
  // destructive action buttons: Grant/Revoke superadmin, Suspend/Unsuspend,
  // Delete (soft, email-typed confirm), Impersonate. Every destructive action
  // goes through ConfirmDialog. On Impersonate success we swap the active session
  // to the target via startImpersonation, which HARD-navigates to /workspace (the
  // GLOBAL impersonation banner in the root layout handles exit + restore).
  // Consumes GET /api/superadmin/users/:id + the POST action endpoints.
  //
  // No <a>/<ul>/<li>: nav is <button onclick={goto}>, lists are <div> rows.
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { authState } from "$lib/state/app.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import {
    getUser,
    setSuperadmin,
    suspendUser,
    unsuspendUser,
    deleteUser,
    impersonateUser,
    type UserDetail,
  } from "../../api.js";
  import { fmtDate, fmtNumber } from "../../format.js";
  import { daemonStatusClass, editionClass, editionLabel } from "../../badges.js";
  import { startImpersonation } from "../../impersonation.svelte.js";
  import ConfirmDialog from "../../ConfirmDialog.svelte";

  const userId = $derived(page.params.id);

  let data = $state<UserDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let flash = $state("");

  // Suspend needs a reason; captured in the suspend dialog body via an input.
  let suspendReason = $state("");

  // Dialog open flags.
  let grantOpen = $state(false);
  let revokeOpen = $state(false);
  let suspendOpen = $state(false);
  let unsuspendOpen = $state(false);
  let deleteOpen = $state(false);
  let impersonateOpen = $state(false);

  const isSelf = $derived(data?.id === authState.user?.id);

  $effect(() => {
    const id = userId;
    if (id) void load(id);
  });

  async function load(id: string): Promise<void> {
    loading = true;
    error = null;
    try {
      data = await getUser(id);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load user";
    } finally {
      loading = false;
    }
  }

  function showFlash(msg: string) {
    flash = msg;
    setTimeout(() => (flash = ""), 2500);
  }

  async function doGrant(): Promise<void> {
    if (!data) return;
    await setSuperadmin(data.id, true);
    showFlash("Superadmin granted");
    await load(data.id);
  }

  async function doRevoke(): Promise<void> {
    if (!data) return;
    await setSuperadmin(data.id, false);
    showFlash("Superadmin revoked");
    await load(data.id);
  }

  async function doSuspend(): Promise<void> {
    if (!data) return;
    await suspendUser(data.id, suspendReason.trim());
    suspendReason = "";
    showFlash("User suspended");
    await load(data.id);
  }

  async function doUnsuspend(): Promise<void> {
    if (!data) return;
    await unsuspendUser(data.id);
    showFlash("User unsuspended");
    await load(data.id);
  }

  async function doDelete(): Promise<void> {
    if (!data) return;
    await deleteUser(data.id, data.email);
    showFlash("User deleted");
    await load(data.id);
  }

  async function doImpersonate(): Promise<void> {
    if (!data) return;
    const result = await impersonateUser(data.id);
    // Swap the active session to the target. startImpersonation stashes the admin
    // session, overwrites the saved session with the target token, and HARD-
    // navigates to /workspace (full reload re-boots as the target). It does not
    // return — no goto afterward, and the global banner handles exit.
    startImpersonation(result.token, result.user.email);
  }

  // Secondary-button base shared by the action toolbar.
  const secondaryBtn =
    "rounded-lg border border-edge px-3 py-1.5 text-sm font-medium text-content-muted transition-colors hover:bg-surface-alt hover:text-content disabled:cursor-not-allowed disabled:opacity-40";
</script>

<div class="mx-auto max-w-4xl space-y-6 px-6 py-7">
  <button
    type="button"
    onclick={() => goto("/superadmin/users")}
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
    All users
  </button>

  {#if loading}
    <!-- Skeleton detail (not bare "Loading…"). -->
    <div class="flex items-center gap-3.5">
      <div class="skeleton h-12 w-12 rounded-full"></div>
      <div class="flex-1 space-y-2">
        <div class="skeleton h-6 w-48 rounded"></div>
        <div class="skeleton h-3.5 w-64 rounded"></div>
      </div>
    </div>
    <div class="skeleton h-16 w-full rounded-[14px]"></div>
    <div class="grid grid-cols-3 gap-3">
      {#each Array(3) as _, i (i)}<div class="skeleton h-16 rounded-[14px]"></div>{/each}
    </div>
    {#each Array(2) as _, i (i)}
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
    <div class="flex items-start justify-between gap-4">
      <div class="flex min-w-0 items-start gap-3.5">
        <Avatar name={data.name ?? data.email} image={data.imageUrl} size="lg" />
        <div class="min-w-0">
          <h1 class="text-[28px] font-bold tracking-[-0.01em] text-content">{data.name ?? data.email}</h1>
          <p class="mt-0.5 truncate text-[13px] text-content-muted">{data.email}</p>
          <div class="mt-2 flex flex-wrap gap-1.5">
            {#if data.isSuperadmin}
              <span class="inline-flex items-center rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent">Superadmin</span>
            {/if}
            {#if data.deletedAt}
              <span class="inline-flex items-center rounded bg-error/15 px-1.5 py-0.5 text-[11px] font-medium text-error">Deleted {fmtDate(data.deletedAt)}</span>
            {:else if data.suspendedAt}
              <span class="inline-flex items-center rounded bg-warning/15 px-1.5 py-0.5 text-[11px] font-medium text-warning">Suspended {fmtDate(data.suspendedAt)}</span>
            {:else}
              <span class="inline-flex items-center rounded bg-online/15 px-1.5 py-0.5 text-[11px] font-medium text-online">Active</span>
            {/if}
          </div>
          {#if data.suspendedReason}
            <p class="mt-1.5 text-[12px] text-content-muted">Reason: {data.suspendedReason}</p>
          {/if}
        </div>
      </div>
      {#if flash}
        <span class="shrink-0 text-[13px] {flash.toLowerCase().includes('fail') ? 'text-error' : 'text-online'}">{flash}</span>
      {/if}
    </div>

    <!-- Action buttons -->
    <section
      class="flex flex-wrap items-center gap-2 rounded-[14px] p-4"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      {#if data.isSuperadmin}
        <button
          type="button"
          onclick={() => (revokeOpen = true)}
          disabled={isSelf}
          title={isSelf ? "You cannot revoke your own superadmin" : ""}
          class={secondaryBtn}
        >
          Revoke superadmin
        </button>
      {:else}
        <button
          type="button"
          onclick={() => (grantOpen = true)}
          class="rounded-lg bg-btn-primary-bg px-3 py-1.5 text-sm font-medium text-btn-primary-text transition-colors hover:bg-btn-primary-hover"
        >
          Grant superadmin
        </button>
      {/if}

      {#if data.suspendedAt}
        <button type="button" onclick={() => (unsuspendOpen = true)} class={secondaryBtn}>Unsuspend</button>
      {:else}
        <button
          type="button"
          onclick={() => { suspendReason = ""; suspendOpen = true; }}
          disabled={isSelf || !!data.deletedAt}
          class={secondaryBtn}
        >
          Suspend
        </button>
      {/if}

      <button
        type="button"
        onclick={() => (impersonateOpen = true)}
        disabled={isSelf || !!data.deletedAt}
        class={secondaryBtn}
      >
        Impersonate
      </button>

      <button
        type="button"
        onclick={() => (deleteOpen = true)}
        disabled={isSelf || !!data.deletedAt}
        class="ml-auto rounded-lg bg-error/15 px-3 py-1.5 text-sm font-medium text-error transition-colors hover:bg-error/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Delete user
      </button>
    </section>

    <!-- Stat counts -->
    <div class="grid grid-cols-3 gap-3">
      {#each [
        { label: "Workspaces", value: data.workspaces.length },
        { label: "Daemons", value: data.daemons.length },
        { label: "Agent sessions", value: data.counts?.agentSessions ?? 0 },
      ] as stat (stat.label)}
        <div class="rounded-[14px] bg-surface-alt px-4 py-3">
          <div class="text-[11px] font-medium uppercase tracking-wide text-content-muted">{stat.label}</div>
          <div class="mt-1 text-lg font-semibold text-content">{stat.value}</div>
        </div>
      {/each}
    </div>

    <!-- Workspaces -->
    <div
      class="overflow-hidden rounded-[14px]"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <div class="px-4 py-3"><h2 class="text-sm font-bold text-content">Workspaces</h2></div>
      <div style="height: 0.5px; background: var(--hairline);"></div>
      <div>
        {#each data.workspaces as ws, i (ws.id)}
          {#if i > 0}<div class="mx-4" style="height: 0.5px; background: var(--hairline);"></div>{/if}
          <button
            type="button"
            onclick={() => goto(`/superadmin/orgs/${ws.id}`)}
            class="pressable-row flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm transition-colors hover:bg-surface-alt/60"
          >
            <div class="flex min-w-0 items-center gap-2.5">
              <Avatar name={ws.name} image={ws.avatarUrl} size="sm" />
              <span class="truncate font-medium text-content">{ws.name}</span>
            </div>
            <span class="inline-flex items-center rounded bg-surface-alt px-1.5 py-0.5 text-[11px] font-medium capitalize text-content-muted">{ws.role}</span>
          </button>
        {:else}
          <p class="px-4 py-3 text-sm text-content-muted">No workspaces.</p>
        {/each}
      </div>
    </div>

    <!-- Daemons -->
    <div
      class="overflow-hidden rounded-[14px]"
      style="background: var(--bg-surface); border: 1px solid var(--hairline); box-shadow: var(--shadow-divider);"
    >
      <div class="px-4 py-3"><h2 class="text-sm font-bold text-content">Daemons</h2></div>
      <div style="height: 0.5px; background: var(--hairline);"></div>
      <div>
        {#each data.daemons as d, i (d.id)}
          {#if i > 0}<div class="mx-4" style="height: 0.5px; background: var(--hairline);"></div>{/if}
          <div class="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <div class="min-w-0">
              <div class="truncate font-medium text-content">{d.label ?? d.id}</div>
              <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-content-muted">
                <span>Last seen {fmtDate(d.lastSeenAt)}</span>
                <span class="text-content-dim">·</span>
                <span>{fmtNumber(d.activeSessionCount ?? 0)} sessions</span>
                <span class="text-content-dim">·</span>
                <span>{fmtNumber(d.activeCyboCount ?? 0)} cybos</span>
                <span class="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium capitalize {editionClass(d.edition)}">{editionLabel(d.edition)}</span>
                {#if d.deploymentMode}
                  <span class="inline-flex items-center rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium capitalize text-accent">{d.deploymentMode}</span>
                {/if}
              </div>
            </div>
            <span class="inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium capitalize {daemonStatusClass(d.status)}">
              {d.status ?? "unknown"}
            </span>
          </div>
        {:else}
          <p class="px-4 py-3 text-sm text-content-muted">No daemons.</p>
        {/each}
      </div>
    </div>

    <!-- ── Confirm dialogs ── -->
    <ConfirmDialog
      bind:open={grantOpen}
      title="Grant superadmin?"
      description={`${data.email} will get full platform admin access.`}
      confirmLabel="Grant"
      confirmVariant="default"
      onConfirm={doGrant}
    />

    <ConfirmDialog
      bind:open={revokeOpen}
      title="Revoke superadmin?"
      description={`${data.email} will lose platform admin access.`}
      confirmLabel="Revoke"
      onConfirm={doRevoke}
    />

    <ConfirmDialog
      bind:open={unsuspendOpen}
      title="Unsuspend user?"
      description={`Restore ${data.email}'s access to the platform.`}
      confirmLabel="Unsuspend"
      confirmVariant="default"
      onConfirm={doUnsuspend}
    />

    <ConfirmDialog
      bind:open={impersonateOpen}
      title="Impersonate user?"
      description={`You'll sign in AS ${data.email} with a short-lived token. A banner lets you exit and restore your own session. This is audited.`}
      confirmLabel="Impersonate"
      confirmVariant="default"
      onConfirm={doImpersonate}
    />

    <ConfirmDialog
      bind:open={suspendOpen}
      title="Suspend user?"
      description={`${data.email} will be blocked from signing in until unsuspended.`}
      confirmLabel="Suspend"
      bind:reason={suspendReason}
      reasonLabel="Reason (optional)"
      reasonPlaceholder="Why is this account being suspended?"
      onConfirm={doSuspend}
    />

    <ConfirmDialog
      bind:open={deleteOpen}
      title="Delete user (soft)?"
      description={`This soft-deletes ${data.email}. Type their email to confirm.`}
      confirmLabel="Delete user"
      confirmText={data.email}
      confirmTextLabel="Confirm the user's email"
      onConfirm={doDelete}
    />
  {/if}
</div>

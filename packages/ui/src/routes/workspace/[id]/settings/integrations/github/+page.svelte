<script lang="ts">
  // GitHub integration DETAIL page (Image #3) — Plane's connected-integration screen.
  // Sections, top to bottom:
  //   • "Back to integrations" link + the GitHub header.
  //   • Connect Organization: the install link + the connected-org row(s), each with
  //     a Disconnect (confirm → disconnectGithubInstallation).
  //   • Connect Personal Account: the OAuth start row (not-configured hint when the
  //     GitHub OAuth App env is absent; "Personal account connected" after a return).
  //   • Pull Request State Mapping: per-project PR-state → task-state editor.
  //   • Project Issue Sync: the workspace's repo↔project bindings (add/edit/delete via
  //     the Link modal).
  //
  // Token-only styling; verbatim Plane integration copy (en/integration.json). All
  // GitHub RPCs go through the authed client github* helpers.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { client } from "$lib/state/app.svelte.js";
  import GitHubIcon from "$lib/components/GitHubIcon.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import LinkGithubRepoModal from "$lib/components/integrations/LinkGithubRepoModal.svelte";
  import GithubProjectSyncList from "$lib/components/integrations/GithubProjectSyncList.svelte";
  import GithubPrStateMapping from "$lib/components/integrations/GithubPrStateMapping.svelte";
  import type {
    GithubInstallation,
    GithubRepoSync,
    GithubUserConnection,
    Project,
  } from "$lib/ws-client.js";

  const workspaceId = $derived(page.params.id ?? "");
  const integrationsHref = $derived(`/workspace/${workspaceId}/settings/integrations`);

  let config = $state<{ configured: boolean; slug: string | null; installUrl: string | null } | null>(
    null,
  );
  const installUrl = $derived(config?.installUrl ?? null);

  let installations = $state<GithubInstallation[]>([]);
  let projects = $state<Project[]>([]);
  let loadingInstalls = $state(true);
  let error = $state<string | null>(null);

  // Personal account: the AUTHORITATIVE connected state comes from the relay
  // (fetchGithubUserConnections), so it persists across reloads — not just the
  // transient note the OAuth callback sets via ?github=personal_connected. The note
  // gives instant post-redirect feedback before the list resolves (it augments, the
  // list confirms). `personalConnected` is true if either source says so.
  let personalConnections = $state<GithubUserConnection[]>([]);
  let personalConnectedNote = $state(false);
  const personalConnected = $derived(personalConnections.length > 0 || personalConnectedNote);
  let oauthError = $state(false);
  let personalNotConfigured = $state(false);
  let personalConnecting = $state(false);

  // Link modal (create + edit) + the Project Issue Sync list refresh signal.
  let modalOpen = $state(false);
  let editSync = $state<GithubRepoSync | null>(null);
  let syncRefresh = $state(0);

  // Disconnect confirmation target.
  let pendingDisconnect = $state<GithubInstallation | null>(null);
  let disconnectBusy = $state(false);

  async function loadConfig(): Promise<void> {
    try {
      config = await client.fetchGithubAppConfig(workspaceId);
    } catch {
      config = { configured: false, slug: null, installUrl: null };
    }
  }

  async function loadInstallations(): Promise<void> {
    loadingInstalls = true;
    try {
      installations = await client.fetchGithubInstallations(workspaceId);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load GitHub connections";
    } finally {
      loadingInstalls = false;
    }
  }

  async function loadProjects(): Promise<void> {
    try {
      const res = await client.fetchProjects(workspaceId);
      projects = res.projects;
    } catch {
      projects = [];
    }
  }

  async function loadUserConnections(): Promise<void> {
    try {
      const res = await client.fetchGithubUserConnections(workspaceId);
      personalConnections = res.connections;
    } catch (e) {
      // Non-fatal: a failed personal-account read must not blank the page. Degrade
      // to "none connected" (the Connect CTA stays available) and log it so the
      // failure isn't swallowed silently.
      console.error("[github] failed to load personal connections", e);
      personalConnections = [];
    }
  }

  onMount(() => {
    // Capture + strip the post-redirect status note so a reload doesn't re-show it.
    // The note is transient feedback only; loadUserConnections is the authoritative
    // source that persists the connected state across reloads.
    const note = page.url.searchParams.get("github");
    if (note === "personal_connected") personalConnectedNote = true;
    if (note === "oauth_error") oauthError = true;
    if (note) {
      const u = new URL(page.url);
      u.searchParams.delete("github");
      u.searchParams.delete("installation_id");
      replaceState(u, {});
    }
    void loadConfig();
    void loadInstallations();
    void loadProjects();
    void loadUserConnections();
  });

  async function connectPersonal(): Promise<void> {
    if (personalConnecting) return;
    personalConnecting = true;
    personalNotConfigured = false;
    oauthError = false;
    try {
      const res = await client.startGithubOAuth(workspaceId, page.url.pathname);
      if (res.configured && res.url) {
        window.location.href = res.url;
        return;
      }
      personalNotConfigured = true;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to start the GitHub sign-in";
    } finally {
      personalConnecting = false;
    }
  }

  async function confirmDisconnect(): Promise<void> {
    const target = pendingDisconnect;
    if (!target) return;
    disconnectBusy = true;
    error = null;
    try {
      await client.disconnectGithubInstallation(workspaceId, target.installationId);
      pendingDisconnect = null;
      await loadInstallations();
      // A disconnect drops the install's repo-syncs too — refresh that list.
      syncRefresh += 1;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to disconnect";
    } finally {
      disconnectBusy = false;
    }
  }

  function openAdd(): void {
    editSync = null;
    modalOpen = true;
  }

  function openEdit(sync: GithubRepoSync): void {
    editSync = sync;
    modalOpen = true;
  }

  function onModalSaved(): void {
    syncRefresh += 1;
  }
</script>

<div class="mx-auto max-w-2xl px-6 py-8 space-y-8">
  <!-- Back link -->
  <a
    href={integrationsHref}
    class="inline-flex items-center gap-1.5 text-[13px] text-content-muted transition-colors hover:text-content"
  >
    <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
    Back to integrations
  </a>

  <!-- Header -->
  <header class="flex items-start gap-4">
    <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-content">
      <GitHubIcon size={24} />
    </div>
    <div class="min-w-0">
      <h1 class="text-lg font-semibold text-content">GitHub</h1>
      <p class="mt-0.5 text-[13px] text-content-muted">
        Connect and sync your GitHub work items with Plane
      </p>
    </div>
  </header>

  {#if oauthError}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error">
      We couldn't complete the GitHub sign-in. Please try again.
    </p>
  {/if}
  {#if error}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error" role="alert">
      {error}
    </p>
  {/if}

  <!-- Connect Organization -->
  <section class="space-y-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold text-content">Connect Organization</h2>
        <p class="mt-0.5 text-[13px] text-content-muted">
          Connect your GitHub organization with Plane
        </p>
      </div>
      {#if installUrl}
        <Button href={installUrl} size="sm">Connect Organization</Button>
      {:else}
        <Button
          size="sm"
          disabled
          title={config === null
            ? "Checking GitHub App configuration…"
            : "The GitHub App is not configured yet"}
        >
          Connect Organization
        </Button>
      {/if}
    </div>

    {#if loadingInstalls}
      <p class="text-[13px] text-content-muted">Loading…</p>
    {:else if installations.length === 0}
      <p class="rounded-md border border-dashed border-edge px-3 py-4 text-[13px] text-content-muted">
        No organizations connected yet.
      </p>
    {:else}
      <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
        {#each installations as inst (inst.id)}
          <li class="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2.5">
            <div class="flex min-w-0 items-center gap-2.5">
              <GitHubIcon size={18} class="text-content-muted" />
              <span class="truncate text-[13px] font-medium text-content">{inst.accountLogin}</span>
              {#if inst.accountType}
                <span class="rounded-full border border-edge bg-surface px-2 py-0.5 text-[11px] text-content-muted">
                  {inst.accountType}
                </span>
              {/if}
            </div>
            <Button
              size="sm"
              variant="destructive"
              disabled={disconnectBusy}
              onclick={() => (pendingDisconnect = inst)}
            >
              Disconnect
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Connect Personal Account -->
  <section class="space-y-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold text-content">Connect Personal Account</h2>
        <p class="mt-0.5 text-[13px] text-content-muted">
          Connect your personal GitHub account with Plane.
        </p>
      </div>
      {#if personalConnected}
        <span class="inline-flex items-center gap-1.5 text-[13px] font-medium text-success">
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          Personal account connected
        </span>
      {:else}
        <Button size="sm" variant="outline" disabled={personalConnecting} onclick={connectPersonal}>
          {personalConnecting ? "Connecting…" : "Connect Personal Account"}
        </Button>
      {/if}
    </div>

    {#if personalConnections.length > 0}
      <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
        {#each personalConnections as conn (conn.id)}
          <li class="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2.5">
            <div class="flex min-w-0 items-center gap-2.5">
              <GitHubIcon size={18} class="text-content-muted" />
              <span class="truncate text-[13px] font-medium text-content">{conn.githubLogin}</span>
            </div>
            <span class="inline-flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-success">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              Personal account connected
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if personalNotConfigured}
      <p class="rounded-md border border-dashed border-edge px-3 py-2 text-[12px] text-content-dim">
        Personal GitHub sign-in isn't configured on this server yet. Once the GitHub OAuth app
        credentials are set, this will connect your personal account.
      </p>
    {/if}
  </section>

  <!-- Pull Request State Mapping -->
  <section class="space-y-3">
    <div class="min-w-0">
      <h2 class="text-[15px] font-semibold text-content">Pull Request State Mapping</h2>
      <p class="mt-0.5 text-[13px] text-content-muted">
        Map GitHub pull request states to your Plane project
      </p>
    </div>
    <GithubPrStateMapping {workspaceId} {projects} />
  </section>

  <!-- Project Issue Sync -->
  <section class="space-y-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold text-content">Project Issue Sync</h2>
        <p class="mt-0.5 text-[13px] text-content-muted">
          Sync issues from GitHub to your Plane project
        </p>
      </div>
      <Button size="sm" disabled={installations.length === 0} onclick={openAdd}>Link Repository</Button>
    </div>
    <GithubProjectSyncList {workspaceId} {projects} refreshSignal={syncRefresh} onEdit={openEdit} />
  </section>
</div>

<LinkGithubRepoModal
  bind:open={modalOpen}
  {workspaceId}
  {projects}
  {installations}
  {editSync}
  onSaved={onModalSaved}
/>

<ConfirmDialog
  open={pendingDisconnect !== null}
  title="Disconnect GitHub"
  message={pendingDisconnect
    ? `Disconnect ${pendingDisconnect.accountLogin}? This removes its repository syncs from this workspace.`
    : ""}
  confirmLabel="Disconnect"
  cancelLabel="Cancel"
  destructive
  onconfirm={confirmDisconnect}
  oncancel={() => (pendingDisconnect = null)}
/>

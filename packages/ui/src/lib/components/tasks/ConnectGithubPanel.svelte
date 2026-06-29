<script lang="ts">
  // Connect GitHub — a Tasks-project settings panel that binds GitHub repositories
  // to this project so their issues sync in as work items (GH → Tasks, one-way).
  //
  // Two pieces:
  //   1. A "Connect GitHub" button that redirects to the GitHub App's public
  //      install page (github.com/apps/<slug>/installations/new). After the user
  //      installs + authorizes, GitHub redirects back and the install is recorded;
  //      they then pick a repo here.
  //   2. A bind list + form: the repos already bound to this project (with unbind),
  //      and an "Add repository" form. When the App's live creds are present the
  //      form is a picker of the installation's repos; until then (Phase 3 pending)
  //      it degrades to a manual entry of installationId / repoId / owner / name.
  //
  // Token-only styling (dark + light both resolve). HTTP RPCs go through the
  // CyborgClient github* helpers (the authed /api/github/* callbacks).
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { client } from "$lib/state/app.svelte.js";
  import type { GithubRepoSync, GithubInstallationRepo } from "$lib/ws-client.js";

  // `tasksProjectId` is the tasks_projects.id (NOT the chat project id). The route
  // wrapper resolves it before rendering this panel.
  let { tasksProjectId }: { tasksProjectId: string } = $props();

  // The GitHub App's public slug, fetched from the server (/api/github/config). When
  // present the "Connect GitHub" button links to the App's install page; when null
  // the App isn't registered yet and the button is disabled with a clear hint.
  let appSlug = $state<string | null>(null);
  const installUrl = $derived(
    appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null,
  );

  onMount(() => {
    void client
      .fetchGithubAppConfig()
      .then((cfg) => {
        appSlug = cfg.slug;
      })
      .catch(() => {
        // Best-effort: leave the slug null so the button stays in its clear "App not
        // configured" state rather than throwing on a transient config-fetch failure.
        appSlug = null;
      });
  });

  let syncs = $state<GithubRepoSync[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);

  // The bind form. `installationId` identifies the authorized install; the repo
  // fields identify the repository. In picker mode the repo fields are filled from
  // a selection; in manual mode the user types them.
  let installationId = $state("");
  let repoId = $state("");
  let owner = $state("");
  let name = $state("");

  // Picker state (Phase 3): the installation's repos, when the App is configured.
  let pickerRepos = $state<GithubInstallationRepo[]>([]);
  let appConfigured = $state<boolean | null>(null); // null = not yet probed

  async function load() {
    loading = true;
    error = null;
    try {
      syncs = await client.fetchGithubRepoSyncs(tasksProjectId);
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load GitHub connections";
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (tasksProjectId) void load();
  });

  // Probe the installation for its repos (picker mode). On `configured:false` the
  // form stays in manual mode. Best-effort: a probe failure leaves manual entry.
  async function probeInstallation() {
    const id = installationId.trim();
    if (!id) return;
    try {
      const res = await client.fetchGithubInstallationRepos(id, tasksProjectId);
      appConfigured = res.configured;
      pickerRepos = res.repos;
    } catch {
      appConfigured = false;
      pickerRepos = [];
    }
  }

  function selectRepo(r: GithubInstallationRepo) {
    repoId = r.repoId;
    owner = r.owner;
    name = r.name;
  }

  async function bind() {
    if (!installationId.trim() || !repoId.trim() || !owner.trim() || !name.trim()) return;
    busy = true;
    error = null;
    try {
      await client.bindGithubRepoSync({
        tasksProjectId,
        installationId: installationId.trim(),
        repoId: repoId.trim(),
        owner: owner.trim(),
        name: name.trim(),
      });
      // Reset the repo fields (keep the installation id for binding more repos).
      repoId = "";
      owner = "";
      name = "";
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to bind repository";
    } finally {
      busy = false;
    }
  }

  async function unbind(id: string) {
    busy = true;
    error = null;
    try {
      await client.unbindGithubRepoSync(id);
      await load();
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to remove connection";
    } finally {
      busy = false;
    }
  }
</script>

<section class="flex w-full flex-col gap-4">
  <header class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-[15px] font-semibold text-content">GitHub</h2>
      <p class="mt-0.5 text-[13px] text-content-muted">
        Sync issues from connected repositories into this project as work items.
      </p>
    </div>
    {#if installUrl}
      <Button href={installUrl} target="_blank" rel="noopener" size="sm">Connect GitHub</Button>
    {:else}
      <Button size="sm" disabled title="The GitHub App is not configured yet">
        Connect GitHub
      </Button>
    {/if}
  </header>

  {#if !installUrl}
    <p class="rounded-md border border-dashed border-edge px-3 py-2 text-[12px] text-content-dim">
      The GitHub App is not configured yet. Once it is registered, the Connect button opens its
      install page; for now you can bind a repository manually below using its installation and
      repository ids.
    </p>
  {/if}

  {#if error}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-error">
      {error}
    </p>
  {/if}

  <!-- Current bindings -->
  <div class="flex flex-col gap-2">
    <h3 class="text-[12px] font-medium uppercase tracking-wide text-content-muted">
      Connected repositories
    </h3>
    {#if loading}
      <p class="text-[13px] text-content-muted">Loading…</p>
    {:else if syncs.length === 0}
      <p class="rounded-md border border-dashed border-edge px-3 py-2 text-[13px] text-content-muted">
        No repositories connected yet.
      </p>
    {:else}
      <ul class="divide-y divide-edge overflow-hidden rounded-md border border-edge">
        {#each syncs as s (s.id)}
          <li class="flex items-center justify-between gap-3 bg-surface-alt px-3 py-2">
            <a
              href={s.repoUrl}
              target="_blank"
              rel="noopener"
              class="min-w-0 truncate text-[13px] font-medium text-content hover:text-accent hover:underline"
            >
              {s.owner}/{s.name}
            </a>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onclick={() => unbind(s.id)}
            >
              Remove
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <!-- Bind form -->
  <div class="flex flex-col gap-2 rounded-md border border-edge bg-surface-alt p-3">
    <h3 class="text-[12px] font-medium uppercase tracking-wide text-content-muted">
      Add a repository
    </h3>

    <div class="flex items-end gap-2">
      <label class="flex flex-1 flex-col gap-1">
        <span class="text-[12px] text-content-dim">Installation ID</span>
        <Input bind:value={installationId} placeholder="e.g. 12345678" />
      </label>
      <Button size="sm" variant="secondary" disabled={!installationId.trim()} onclick={probeInstallation}>
        Find repos
      </Button>
    </div>

    {#if appConfigured === true && pickerRepos.length > 0}
      <!-- Picker mode (Phase 3 live creds): choose from the installation's repos. -->
      <div class="flex flex-col gap-1">
        <span class="text-[12px] text-content-dim">Repository</span>
        <ul class="max-h-40 divide-y divide-edge overflow-y-auto rounded-md border border-edge">
          {#each pickerRepos as r (r.repoId)}
            <li>
              <button
                type="button"
                class="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] text-content hover:bg-hover-gray"
                class:font-semibold={repoId === r.repoId}
                onclick={() => selectRepo(r)}
              >
                <span class="truncate">{r.owner}/{r.name}</span>
                {#if repoId === r.repoId}<span class="text-accent">selected</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {:else}
      <!-- Manual mode: enter the repo fields directly (Phase 3 picker pending). -->
      {#if appConfigured === false}
        <p class="text-[12px] text-content-dim">
          Live repo discovery is unavailable; enter the repository details manually.
        </p>
      {/if}
      <div class="grid grid-cols-3 gap-2">
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-content-dim">Repo ID</span>
          <Input bind:value={repoId} placeholder="e.g. 555" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-content-dim">Owner</span>
          <Input bind:value={owner} placeholder="acme" />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-[12px] text-content-dim">Name</span>
          <Input bind:value={name} placeholder="app" />
        </label>
      </div>
    {/if}

    <div class="flex justify-end">
      <Button
        size="sm"
        disabled={busy || !installationId.trim() || !repoId.trim() || !owner.trim() || !name.trim()}
        onclick={bind}
      >
        Connect repository
      </Button>
    </div>
  </div>
</section>

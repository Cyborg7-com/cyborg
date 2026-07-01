<script lang="ts">
  // Workspace Settings → Integrations. The discoverable home for connecting external
  // services to the workspace (Plane parity: a list of integration cards). Today it
  // holds one card — GitHub. Once the workspace has ≥1 GitHub App installation the
  // card flips to a CONNECTED state (✓ + "Configure") that links to the integration
  // DETAIL page; otherwise it shows "Connect GitHub" (the App install link, which
  // carries the workspace id as the GitHub `state` so the post-install redirect lands
  // back here). The post-install / OAuth callbacks return here with a ?github=* note.
  //
  // Token-only styling (dark + light both resolve). Config + installations come from
  // the authed client github* helpers.
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { goto, replaceState } from "$app/navigation";
  import { Button } from "$lib/components/ui/button/index.js";
  import GitHubIcon from "$lib/components/GitHubIcon.svelte";
  import SlackIcon from "$lib/components/SlackIcon.svelte";
  import RecipeIcon from "$lib/components/integrations/RecipeIcon.svelte";
  import { client, recipesState } from "$lib/state/app.svelte.js";
  import { RECIPE_CATALOG } from "$lib/integrations/recipes-catalog.js";
  import { openExternalUrl } from "$lib/desktop-terminal.js";
  import type { GithubInstallation, SlackInstallation } from "$lib/ws-client.js";

  const workspaceId = $derived(page.params.id ?? "");
  const detailHref = $derived(`/workspace/${workspaceId}/settings/integrations/github`);
  const slackDetailHref = $derived(`/workspace/${workspaceId}/settings/integrations/slack`);
  const recipeHref = $derived(
    (recipeId: string) => `/workspace/${workspaceId}/settings/integrations/recipes/${recipeId}`,
  );

  // null = not yet probed (loading). `installUrl` is the server-built install link
  // (github.com/apps/<slug>/installations/new?state=<workspaceId>); non-null exactly
  // when the App is registered.
  let config = $state<{ configured: boolean; slug: string | null; installUrl: string | null } | null>(
    null,
  );
  const loadingConfig = $derived(config === null);
  const installUrl = $derived(config?.installUrl ?? null);

  let installations = $state<GithubInstallation[]>([]);
  let loadingInstalls = $state(true);
  const connected = $derived(installations.length > 0);

  // Post-install confirmation note (?github=installed). Personal-account notes are
  // forwarded to the detail page (where that UI lives) on mount.
  let justInstalled = $state(false);

  // Slack: same card shape as GitHub. The Slack OAuth callback redirects straight to
  // the Slack DETAIL page (?slack=connected), so this card only reflects the connected
  // state — it has no post-install note of its own to strip.
  let slackConfig = $state<{ configured: boolean; installUrl: string | null } | null>(null);
  const slackLoadingConfig = $derived(slackConfig === null);
  const slackInstallUrl = $derived(slackConfig?.installUrl ?? null);
  let slackInstallations = $state<SlackInstallation[]>([]);
  let slackLoadingInstalls = $state(true);
  const slackConnected = $derived(slackInstallations.length > 0);

  onMount(() => {
    const note = page.url.searchParams.get("github");
    if (note === "personal_connected" || note === "oauth_error") {
      // The personal-account UI lives on the detail page — carry the note there.
      void goto(`${detailHref}?github=${note}`, { replaceState: true });
      return;
    }
    // The GitHub installation id GitHub appended to the post-install redirect. Captured
    // BEFORE we strip the query so we can claim the install for this workspace below.
    const installedId = note === "installed" ? page.url.searchParams.get("installation_id") : null;
    if (note === "installed") {
      justInstalled = true;
      const u = new URL(page.url);
      u.searchParams.delete("github");
      u.searchParams.delete("installation_id");
      replaceState(u, {});
    }

    void client
      .fetchGithubAppConfig(workspaceId)
      .then((cfg) => {
        config = cfg;
        return undefined;
      })
      .catch(() => {
        config = { configured: false, slug: null, installUrl: null };
      });

    // Load the workspace's built-in recipe installs so the "Built-in" cards below
    // know which recipes are enabled (the store also stays live via the
    // `cyborg:recipes_changed` broadcast wired in app.svelte.ts).
    void recipesState.load(workspaceId);

    // Claim the freshly-installed App for this workspace BEFORE loading installations, so
    // the github_installations row exists and the card flips to the connected state. The
    // post-install GitHub redirect is unauthenticated and can't write it; this authed call
    // can. A failure degrades to the not-connected state (the user can retry the install).
    void (async () => {
      if (installedId) {
        try {
          await client.confirmGithubInstallation(workspaceId, installedId);
        } catch (e) {
          console.error("[github] failed to confirm installation", e);
        }
      }
      try {
        installations = await client.fetchGithubInstallations(workspaceId);
      } catch {
        installations = [];
      } finally {
        loadingInstalls = false;
      }
    })();

    // Slack: independent of GitHub — load the config (gate + install URL) + this
    // workspace's installations so the card reflects the connected state.
    void client
      .fetchSlackConfig(workspaceId)
      .then((cfg) => {
        slackConfig = cfg;
        return undefined;
      })
      .catch(() => {
        slackConfig = { configured: false, installUrl: null };
      });
    void (async () => {
      try {
        slackInstallations = await client.fetchSlackInstallations(workspaceId);
      } catch {
        slackInstallations = [];
      } finally {
        slackLoadingInstalls = false;
      }
    })();
  });
</script>

<div class="mx-auto max-w-2xl px-6 py-8 space-y-6">
  <header>
    <h1 class="text-lg font-semibold text-content">Integrations</h1>
    <p class="mt-1 text-xs text-content-muted">
      Connect external services to your workspace.
    </p>
  </header>

  {#if justInstalled}
    <p class="rounded-md border border-edge bg-surface-alt px-3 py-2 text-[12px] text-success">
      GitHub connected. Configure repositories and sync below.
    </p>
  {/if}

  <div class="overflow-hidden rounded-lg border border-edge">
    <!-- GitHub integration card (Plane single-integration-card shape). -->
    <div class="flex items-center justify-between gap-4 bg-surface-alt px-4 py-5">
      <div class="flex min-w-0 items-start gap-4">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-content"
        >
          <GitHubIcon size={22} />
        </div>
        <div class="min-w-0">
          <h3 class="flex items-center gap-1.5 text-[14px] font-medium text-content">
            GitHub
            {#if connected}
              <svg
                class="h-4 w-4 text-success"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                role="img"
                aria-label="GitHub connected"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            {/if}
          </h3>
          <p class="mt-0.5 text-[13px] text-content-muted">
            Connect and sync your GitHub work items with Plane
          </p>
        </div>
      </div>

      {#if loadingConfig || loadingInstalls}
        <Button size="sm" disabled title="Checking GitHub connection…">Loading…</Button>
      {:else if connected}
        <Button href={detailHref} size="sm" variant="outline">Configure</Button>
      {:else if installUrl}
        <Button size="sm" onclick={() => { if (installUrl) openExternalUrl(installUrl); }}>Connect GitHub</Button>
      {:else}
        <Button
          size="sm"
          disabled
          title="The GitHub App is not configured yet"
        >
          Connect GitHub
        </Button>
      {/if}
    </div>

    <!-- Slack integration card (same shape as GitHub). -->
    <div class="flex items-center justify-between gap-4 border-t border-edge bg-surface-alt px-4 py-5">
      <div class="flex min-w-0 items-start gap-4">
        <div
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-edge bg-surface"
        >
          <SlackIcon size={22} />
        </div>
        <div class="min-w-0">
          <h3 class="flex items-center gap-1.5 text-[14px] font-medium text-content">
            Slack
            {#if slackConnected}
              <svg
                class="h-4 w-4 text-success"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                role="img"
                aria-label="Slack connected"
              >
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
            {/if}
          </h3>
          <p class="mt-0.5 text-[13px] text-content-muted">
            Connect and sync your Slack customer channels
          </p>
        </div>
      </div>

      {#if slackLoadingConfig || slackLoadingInstalls}
        <Button size="sm" disabled title="Checking Slack connection…">Loading…</Button>
      {:else if slackConnected}
        <Button href={slackDetailHref} size="sm" variant="outline">Configure</Button>
      {:else if slackInstallUrl}
        <Button size="sm" onclick={() => { if (slackInstallUrl) openExternalUrl(slackInstallUrl); }}>Connect Slack</Button>
      {:else}
        <Button size="sm" disabled title="Slack is not configured yet">Connect Slack</Button>
      {/if}
    </div>
  </div>

  <p class="text-[12px] text-content-dim">
    Connect a GitHub organization, then link its repositories to your projects to sync issues and
    pull requests.
  </p>

  <!-- Built-in integrations (recipes): a card per catalog recipe, same shape as the
       GitHub card. Installed = the recipe's enabled install exists (✓ + Configure);
       otherwise an Enable action that opens the Configure page to provision it. -->
  <section class="space-y-3">
    <header>
      <h2 class="text-[15px] font-semibold text-content">Built-in</h2>
      <p class="mt-0.5 text-xs text-content-muted">
        Turn-key automations that run in your workspace.
      </p>
    </header>

    <div class="overflow-hidden rounded-lg border border-edge divide-y divide-edge">
      {#each RECIPE_CATALOG as recipe (recipe.recipeId)}
        {@const installed = recipesState.isInstalled(recipe.recipeId)}
        <div class="flex items-center justify-between gap-4 bg-surface-alt px-4 py-5">
          <div class="flex min-w-0 items-start gap-4">
            <div
              class="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-edge bg-surface text-content"
            >
              <RecipeIcon name={recipe.icon} size={22} />
            </div>
            <div class="min-w-0">
              <h3 class="flex items-center gap-1.5 text-[14px] font-medium text-content">
                {recipe.name}
                {#if installed}
                  <svg
                    class="h-4 w-4 text-success"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    role="img"
                    aria-label="{recipe.name} enabled"
                  >
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                {/if}
              </h3>
              <p class="mt-0.5 text-[13px] text-content-muted">
                {recipe.description}
              </p>
            </div>
          </div>

          {#if recipesState.loading}
            <Button size="sm" disabled title="Checking built-in integrations…">Loading…</Button>
          {:else if installed}
            <Button href={recipeHref(recipe.recipeId)} size="sm" variant="outline">Configure</Button>
          {:else}
            <Button href={recipeHref(recipe.recipeId)} size="sm">Enable</Button>
          {/if}
        </div>
      {/each}
    </div>
  </section>
</div>

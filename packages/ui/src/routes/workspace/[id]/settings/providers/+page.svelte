<script lang="ts">
  import { providerState, fetchProviders } from "$lib/state/app.svelte.js";
  import ProviderRow from "$lib/plugins/agents/components/settings/ProviderRow.svelte";
  import ProviderDetail from "$lib/plugins/agents/components/settings/ProviderDetail.svelte";

  let expandedId: string | null = $state(null);
  let refreshing = $state(false);

  const providers = $derived(providerState.list);
  const availableCount = $derived(providerState.available.length);

  $effect(() => {
    if (providerState.list.length === 0 && !providerState.loading) {
      fetchProviders();
    }
  });

  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  async function handleRefresh() {
    refreshing = true;
    try {
      await fetchProviders();
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="mx-auto max-w-2xl px-6 py-8 space-y-6">
  <header class="flex items-center justify-between">
    <div>
      <h1 class="text-lg font-semibold text-content">Providers</h1>
      {#if providers.length > 0}
        <p class="mt-1 text-xs text-content-muted">
          {availableCount} available of {providers.length} detected
        </p>
      {:else}
        <p class="mt-1 text-xs text-content-muted">Agent providers and their available models</p>
      {/if}
    </div>
    <button
      onclick={handleRefresh}
      disabled={refreshing || providerState.loading}
      class="flex items-center gap-1.5 rounded-md bg-btn-secondary-bg border border-btn-secondary-border px-3 py-1.5 text-xs font-medium text-btn-secondary-text hover:bg-btn-secondary-hover disabled:opacity-40 transition-colors"
    >
      <svg
        class={["h-3.5 w-3.5", refreshing && "animate-spin"]}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="23 4 23 10 17 10"/>
        <polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
      </svg>
      Refresh
    </button>
  </header>

  {#if providerState.loading && providers.length === 0}
    <div class="flex items-center gap-2 py-12 justify-center">
      <div class="h-3 w-3 rounded-full border-2 border-content-muted border-t-transparent animate-spin"></div>
      <span class="text-sm text-content-muted">Detecting providers...</span>
    </div>
  {:else if providers.length === 0}
    <div class="py-12 text-center text-sm text-content-muted">
      <p>No providers detected.</p>
      <button
        onclick={handleRefresh}
        class="mt-2 text-link hover:underline"
      >
        Retry detection
      </button>
    </div>
  {:else}
    <div class="space-y-2">
      {#each providers as provider (provider.id)}
        <div>
          <ProviderRow
            {provider}
            expanded={expandedId === provider.id}
            onToggle={() => toggleExpand(provider.id)}
          />
          {#if expandedId === provider.id}
            <div class="mt-2">
              <ProviderDetail {provider} />
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

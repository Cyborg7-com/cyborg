<script lang="ts">
  import { onMount } from "svelte";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { cn } from "$lib/utils.js";
  import { modelPrefs } from "$lib/state/modelPrefs.svelte.js";
  import type { ProviderInfo } from "$lib/plugins/agents/types.js";
  import ProviderIcon from "$lib/plugins/agents/components/ProviderIcon.svelte";

  // Reusable model picker with Favorites / Recent sections, text search, and a
  // provider-grouped full list. Works for a single provider (live agent model
  // switch) or many (e.g. picking a starting model across providers). The repo
  // has no shadcn Popover/Command primitive, so this follows the established
  // inline-popover pattern (see AgentComposer) and uses the ScrollArea primitive.
  let {
    providers,
    value,
    disabled = false,
    loading = false,
    openUp = false,
    align = "left",
    placeholder = "model",
    triggerClass,
    onSelect,
  }: {
    providers: ProviderInfo[];
    value: string | null;
    disabled?: boolean;
    loading?: boolean;
    openUp?: boolean;
    align?: "left" | "right";
    placeholder?: string;
    /** Extra classes merged onto the trigger button (mobile chip restyle). */
    triggerClass?: string;
    onSelect: (modelId: string) => void | Promise<void>;
  } = $props();

  interface FlatModel {
    id: string;
    label: string;
    providerId: string;
    providerLabel: string;
  }

  // Synthetic provider id for user-entered custom models (not in any catalog).
  const CUSTOM_PROVIDER_ID = "__custom__";
  const MIN_CUSTOM_LENGTH = 3;

  let open = $state(false);
  let search = $state("");
  let container: HTMLDivElement | undefined = $state();

  // Load persisted favorites/recents on the client only (post-hydration).
  onMount(() => modelPrefs.load());

  function shortModel(model: string): string {
    const parts = model.split("/");
    return parts[parts.length - 1] ?? model;
  }

  const allModels = $derived.by<FlatModel[]>(() => {
    const out: FlatModel[] = [];
    for (const p of providers) {
      for (const m of p.models) {
        out.push({
          id: m.id,
          label: m.label ?? shortModel(m.id),
          providerId: p.id,
          providerLabel: p.label,
        });
      }
    }
    // Merge user-entered custom models that aren't already in the catalog.
    const known = new Set(out.map((m) => m.id));
    for (const id of modelPrefs.getCustomModels()) {
      if (known.has(id)) continue;
      out.push({
        id,
        label: shortModel(id),
        providerId: CUSTOM_PROVIDER_ID,
        providerLabel: "Custom",
      });
    }
    return out;
  });

  const byId = $derived(new Map(allModels.map((m) => [m.id, m])));

  const filtered = $derived.by<FlatModel[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allModels;
    return allModels.filter((m) =>
      `${m.label} ${m.id} ${m.providerLabel}`.toLowerCase().includes(q),
    );
  });

  const favorites = $derived(filtered.filter((m) => modelPrefs.isFavorite(m.id)));

  const recents = $derived.by<FlatModel[]>(() => {
    const ids = new Set(filtered.map((m) => m.id));
    return modelPrefs.recents
      .filter((id) => ids.has(id) && !modelPrefs.isFavorite(id))
      .map((id) => byId.get(id))
      .filter((m): m is FlatModel => !!m);
  });

  const groups = $derived.by<{ id: string; label: string; models: FlatModel[] }[]>(() => {
    const map = new Map<string, { id: string; label: string; models: FlatModel[] }>();
    for (const m of filtered) {
      let g = map.get(m.providerId);
      if (!g) {
        g = { id: m.providerId, label: m.providerLabel, models: [] };
        map.set(m.providerId, g);
      }
      g.models.push(m);
    }
    // Custom group always renders first, before the catalog groups.
    return [...map.values()].sort((a, b) => {
      if (a.id === b.id) return 0;
      if (a.id === CUSTOM_PROVIDER_ID) return -1;
      if (b.id === CUSTOM_PROVIDER_ID) return 1;
      return 0;
    });
  });

  const displayLabel = $derived(value ? (byId.get(value)?.label ?? shortModel(value)) : placeholder);
  const showGroupHeaders = $derived(providers.length > 1);

  // Offer "Use <typed> as model id" when the query is long enough and matches no
  // existing model id exactly. setAgentModel accepts arbitrary ids, so this works
  // without any backend change.
  const trimmedSearch = $derived(search.trim());
  const canAddCustom = $derived(
    trimmedSearch.length >= MIN_CUSTOM_LENGTH && !allModels.some((m) => m.id === trimmedSearch),
  );

  function toggle(): void {
    if (disabled) return;
    open = !open;
    if (open) search = "";
  }

  async function choose(modelId: string): Promise<void> {
    open = false;
    modelPrefs.addRecent(modelId);
    await onSelect(modelId);
  }

  async function addCustom(): Promise<void> {
    if (!canAddCustom) return;
    modelPrefs.addCustomModel(trimmedSearch);
    await choose(trimmedSearch);
  }

  function handleWindowClick(e: MouseEvent): void {
    if (!open) return;
    if (container && !container.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={handleWindowClick} />

<div class="relative" bind:this={container}>
  <button
    type="button"
    onclick={toggle}
    {disabled}
    class={cn(
      "flex h-7 items-center gap-1 rounded-2xl px-2 text-[11px] font-mono text-content-muted transition-colors",
      !disabled && "cursor-pointer hover:bg-hover-gray",
      "disabled:opacity-50",
      triggerClass,
    )}
  >
    {#if loading}
      <div class="h-3 w-3 rounded-full border border-content-dim border-t-transparent animate-spin"></div>
    {/if}
    <span class="truncate max-w-[120px]">{displayLabel}</span>
    {#if !disabled}
      <svg class="h-3 w-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    {/if}
  </button>

  {#if open}
    <div
      class={cn(
        "absolute z-50 w-[280px] rounded-lg border border-edge bg-raised shadow-lg py-1",
        openUp ? "bottom-full mb-1" : "top-full mt-1",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      <!-- svelte-ignore a11y_autofocus -->
      <input
        bind:value={search}
        placeholder="Search models…"
        autofocus
        class="mx-2 mb-1 w-[calc(100%-1rem)] rounded-md border border-edge bg-surface px-2 py-1 text-xs text-content placeholder:text-content-muted outline-none"
        onkeydown={(e) => { if (e.key === "Escape") open = false; }}
      />
      <ScrollArea class="max-h-[280px] overflow-hidden">
        <div class="px-1">
          {#if favorites.length > 0}
            <p class="px-2 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-muted">Favorites</p>
            {#each favorites as m (m.id)}
              {@render row(m)}
            {/each}
          {/if}

          {#if recents.length > 0}
            <p class="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-muted">Recent</p>
            {#each recents as m (m.id)}
              {@render row(m)}
            {/each}
          {/if}

          {#if filtered.length === 0 && !canAddCustom}
            <div class="px-3 py-2 text-xs text-content-muted italic">No models match</div>
          {:else}
            {#each groups as g (g.id)}
              {#if g.id === CUSTOM_PROVIDER_ID}
                <p class="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-muted">Custom</p>
              {:else if showGroupHeaders}
                <div class="flex min-w-0 items-center gap-1.5 px-2 pt-1.5 pb-0.5">
                  <ProviderIcon provider={g.id} size={11} />
                  <span class="truncate text-[10px] font-semibold uppercase tracking-wide text-content-muted">{g.label}</span>
                </div>
              {:else}
                <p class="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-muted">All models</p>
              {/if}
              {#each g.models as m (m.id)}
                {@render row(m)}
              {/each}
            {/each}
          {/if}

          {#if canAddCustom}
            <button
              type="button"
              onclick={addCustom}
              class="mt-1 flex w-full items-center gap-2 border-t border-edge px-3 py-2 text-left text-xs text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
            >
              <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span class="truncate">Use <span class="font-mono text-content">{trimmedSearch}</span> as model id</span>
            </button>
          {/if}
        </div>
      </ScrollArea>
    </div>
  {/if}
</div>

{#snippet row(m: FlatModel)}
  <div
    class={cn(
      "group flex items-center rounded-md transition-colors hover:bg-hover-gray",
      value === m.id && "bg-hover-gray",
    )}
  >
    <button
      type="button"
      onclick={() => choose(m.id)}
      class={cn(
        "min-w-0 flex-1 truncate px-2 py-1.5 text-left text-xs text-content-dim",
        value === m.id && "font-medium text-content",
      )}
      title={m.id}
    >
      {m.label}
    </button>
    {#if m.providerId === CUSTOM_PROVIDER_ID}
      <button
        type="button"
        onclick={(e) => { e.stopPropagation(); modelPrefs.removeCustomModel(m.id); }}
        class="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-content-muted opacity-0 transition-colors hover:text-error group-hover:opacity-100"
        title="Remove custom model"
        aria-label="Remove custom model"
      >
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>
    {/if}
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); modelPrefs.toggleFavorite(m.id); }}
      class={cn(
        "mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:text-content",
        modelPrefs.isFavorite(m.id) ? "text-amber-400" : "text-content-muted opacity-0 group-hover:opacity-100",
      )}
      title={modelPrefs.isFavorite(m.id) ? "Remove favorite" : "Add favorite"}
      aria-label="Toggle favorite"
    >
      <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill={modelPrefs.isFavorite(m.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    </button>
  </div>
{/snippet}

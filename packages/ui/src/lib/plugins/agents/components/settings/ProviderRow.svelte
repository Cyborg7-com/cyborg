<script lang="ts">
  import type { ProviderInfo } from "$lib/types.js";
  import StatusBadge from "./StatusBadge.svelte";
  import { cn } from "$lib/utils.js";

  let {
    provider,
    expanded = false,
    onToggle,
  }: {
    provider: ProviderInfo;
    expanded: boolean;
    onToggle: () => void;
  } = $props();

  const status = $derived(
    provider.available ? "available" as const : "not-installed" as const,
  );

  const modelCount = $derived(provider.models.length);
</script>

<button
  onclick={onToggle}
  class={cn(
    "flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
    expanded
      ? "border-btn-primary-bg/30 bg-raised"
      : "border-edge hover:bg-hover-gray",
  )}
>
  <div class="min-w-0 flex-1">
    <div class="flex items-center gap-2">
      <span class="text-sm font-medium text-content">{provider.label}</span>
      <StatusBadge {status} />
    </div>
    <span class="mt-0.5 block truncate text-[11px] text-content-dim">
      {provider.description}
    </span>
  </div>

  <div class="flex items-center gap-2 shrink-0">
    {#if modelCount > 0}
      <span class="rounded-full bg-surface-alt px-2 py-0.5 text-[10px] font-medium text-content-muted">
        {modelCount} model{modelCount !== 1 ? "s" : ""}
      </span>
    {/if}
    <svg
      class={cn("h-4 w-4 text-content-muted transition-transform", expanded && "rotate-90")}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  </div>
</button>

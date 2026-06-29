<script lang="ts">
  import type { ProviderInfo } from "$lib/types.js";
  import { cn } from "$lib/utils.js";

  let { provider }: { provider: ProviderInfo } = $props();
</script>

<div class="ml-4 border-l border-edge pl-4 pb-2 space-y-4">
  {#if !provider.available}
    <div class="rounded-md bg-error/10 border border-error/20 px-3 py-2 text-xs text-error">
      Provider CLI not found on PATH. Install it and restart the daemon.
    </div>
  {/if}

  {#if provider.models.length > 0}
    <div>
      <span class="block text-[10px] font-semibold uppercase tracking-wider text-content-muted mb-1.5">
        Models
      </span>
      <div class="space-y-0.5">
        {#each provider.models as model (model.id)}
          <div class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover-gray">
            <span class="font-mono text-content-dim truncate flex-1">{model.id}</span>
            {#if model.label && model.label !== model.id}
              <span class="text-content-muted truncate">{model.label}</span>
            {/if}
            {#if model.isDefault}
              <span class="rounded-full bg-online/15 px-1.5 py-0.5 text-[9px] font-medium text-online">
                default
              </span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if provider.modes.length > 0}
    <div>
      <span class="block text-[10px] font-semibold uppercase tracking-wider text-content-muted mb-1.5">
        Modes
      </span>
      <div class="space-y-0.5">
        {#each provider.modes as mode (mode.id)}
          <div class="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-hover-gray">
            <span class={cn("font-medium text-content", mode.id === provider.defaultModeId && "text-online")}>
              {mode.label}
            </span>
            <span class="text-content-muted truncate flex-1">{mode.description}</span>
            {#if mode.id === provider.defaultModeId}
              <span class="text-[9px] text-online">default</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if provider.available && provider.models.length === 0}
    <div class="text-xs text-content-muted px-2 py-1">
      No models discovered yet. Try refreshing.
    </div>
  {/if}
</div>

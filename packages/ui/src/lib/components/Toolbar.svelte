<script lang="ts">
  import { shellConfig } from "$lib/core/plugin.svelte.js";
  import { cn } from "$lib/utils.js";

  const items = $derived(shellConfig.toolbar);

  function variantClasses(v: string | undefined): string {
    switch (v) {
      case "success": return "bg-online/15 text-online border-online/30";
      case "warning": return "bg-warning/15 text-warning border-warning/30";
      case "error": return "bg-error/15 text-error border-error/30";
      default: return "bg-surface-alt text-content-dim border-edge";
    }
  }

  function dotColor(v: string | undefined): string {
    switch (v) {
      case "success": return "bg-online";
      case "warning": return "bg-warning";
      case "error": return "bg-error";
      default: return "bg-content-muted";
    }
  }

  // Status word for screen readers — the colored dot alone (color-only) doesn't
  // convey state to non-sighted users, so we add an sr-only label.
  function statusLabel(v: string | undefined): string {
    switch (v) {
      case "success": return "Status: ok";
      case "warning": return "Status: warning";
      case "error": return "Status: error";
      default: return "Status";
    }
  }
</script>

{#each items as item (item.id)}
  {#if item.onclick}
    <button
      onclick={item.onclick}
      title={item.tooltip ?? item.label}
      aria-label={`${item.tooltip ?? item.label} — ${statusLabel(item.variant)}`}
      class={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors hover:opacity-80 focus-ring",
        variantClasses(item.variant),
      )}
    >
      <span class={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor(item.variant))} aria-hidden="true"></span>
      <span class="sr-only" aria-hidden="true">{statusLabel(item.variant)}.</span>
      {item.label}
      {#if item.badge != null}
        <span class="ml-0.5 rounded-full bg-current/20 px-1 text-[9px] font-bold">{item.badge}</span>
      {/if}
    </button>
  {:else}
    <div
      title={item.tooltip ?? item.label}
      role="status"
      class={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
        variantClasses(item.variant),
      )}
    >
      <span class={cn("h-1.5 w-1.5 rounded-full shrink-0", dotColor(item.variant))} aria-hidden="true"></span>
      <span class="sr-only">{statusLabel(item.variant)}.</span>
      {item.label}
      {#if item.badge != null}
        <span class="ml-0.5 rounded-full bg-current/20 px-1 text-[9px] font-bold">{item.badge}</span>
      {/if}
    </div>
  {/if}
{/each}

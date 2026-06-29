<script lang="ts">
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import { cn } from "$lib/utils.js";

  type Theme = "dark" | "light" | "system";

  const options: { value: Theme; label: string }[] = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "system", label: "System" },
  ];

  const current = $derived(preferencesState.theme);
</script>

<div class="inline-flex rounded-lg border border-edge bg-surface-alt p-0.5">
  {#each options as opt (opt.value)}
    <button
      onclick={() => preferencesState.setTheme(opt.value)}
      class={cn(
        "rounded-md px-3 py-1 text-xs font-medium transition-colors",
        current === opt.value
          ? "bg-btn-primary-bg text-btn-primary-text"
          : "text-content-muted hover:text-content",
      )}
    >
      {opt.label}
    </button>
  {/each}
</div>

<script lang="ts">
  // S8: mobile-only Appearance sub-page — the General page's theme picker as an
  // iOS grouped page with three check-mark cells. Same theme-switch logic as
  // ThemeToggle (preferencesState.setTheme persists + applies [data-theme]).
  // A real sub-route so swipe-back / the header chevron pop to /settings via
  // the existing mapping; the 44pt "Appearance" bar comes from the settings
  // +layout. Desktop never links here; direct hits bounce to the settings root,
  // where General keeps the inline ThemeToggle.
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";

  type Theme = "dark" | "light" | "system";

  const options: { value: Theme; label: string }[] = [
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
    { value: "system", label: "System" },
  ];

  const current = $derived(preferencesState.theme);
  const basePath = $derived(`/workspace/${page.params.id}/settings`);

  $effect(() => {
    if (!viewportState.isMobile) void goto(basePath, { replaceState: true });
  });
</script>

<div class="px-4 pb-8 pt-2">
  <div class="overflow-hidden rounded-[14px] bg-surface-alt" role="radiogroup" aria-label="Theme">
    {#each options as opt, i (opt.value)}
      {#if i > 0}
        <!-- Hairline ONLY between cells inside the grouped card, inset 16px. -->
        <div class="ml-[16px]" style="height: 0.5px; background: var(--hairline);"></div>
      {/if}
      <button
        type="button"
        role="radio"
        aria-checked={current === opt.value}
        onclick={() => preferencesState.setTheme(opt.value)}
        class="pressable-row flex h-[48px] w-full items-center gap-3 px-[16px] text-left focus-ring"
      >
        <span class="min-w-0 flex-1 truncate text-[16px] text-content">{opt.label}</span>
        {#if current === opt.value}
          <svg class="shrink-0 text-accent" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
        {/if}
      </button>
    {/each}
  </div>
  <p class="px-[16px] pt-2 text-[13px] text-content-muted">
    System follows your device appearance.
  </p>
</div>

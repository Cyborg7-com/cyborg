<script lang="ts">
  // State-group glyph for the Tasks surfaces. Renders the lucide-style icon keyed
  // by the group's `iconKey` (constants.ts STATE_GROUPS) and tints it with the
  // state's color. Per-state color is user-editable, so callers pass `color`
  // (any CSS color value, e.g. `var(--some-token)` or a stored hex); when omitted
  // we fall back to the group's default seed token (--priority-*) from
  // constants.ts — never an inline literal here. The SVG draws in `currentColor`.
  import { cn } from "$lib/utils.js";
  import { STATE_GROUPS, type StateGroupKey } from "$lib/tasks/constants.js";

  let {
    group,
    color,
    size = 16,
    class: className = "",
  }: { group: StateGroupKey; color?: string; size?: number; class?: string } = $props();

  const meta = $derived(STATE_GROUPS.find((g) => g.key === group) ?? STATE_GROUPS[0]);
  const tint = $derived(color ?? `var(${meta.seedColor})`);
</script>

<span
  class={cn("inline-flex shrink-0", className)}
  style={`color:${tint}`}
  role="img"
  aria-label={meta.label}
  title={meta.label}
>
  {#if meta.iconKey === "circle-dashed"}
    <!-- backlog -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="3 3">
      <circle cx="12" cy="12" r="9" />
    </svg>
  {:else if meta.iconKey === "circle"}
    <!-- unstarted -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" />
    </svg>
  {:else if meta.iconKey === "circle-dot"}
    <!-- started -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  {:else if meta.iconKey === "circle-check"}
    <!-- completed -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </svg>
  {:else}
    <!-- cancelled (circle-x) -->
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </svg>
  {/if}
</span>

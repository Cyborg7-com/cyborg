<script module lang="ts">
  import type { TaskState } from "$lib/core/types.js";

  // One rail pill: a column's key, label, count and (data-driven) phase glyph.
  export interface RailItem {
    key: string;
    label: string;
    count: number;
    statePhase?: TaskState["group"];
    stateColor?: string;
  }
</script>

<script lang="ts">
  // WS2 — the board's jump-to-state RAIL. A horizontally-scrollable strip of
  // state pills (glyph + name + per-column count) pinned above the status pager;
  // tapping a pill scrolls the pager to that column, and the active column's pill
  // is accent-underlined. Token-only (`--c7-accent` via `text-accent` /
  // `border-accent`, `.material-bar` / `.hairline-b`), `whitespace-nowrap` labels
  // so a long state name never wraps.
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import { cn } from "$lib/utils.js";

  let {
    items,
    activeKey,
    onjump,
  }: {
    items: RailItem[];
    activeKey: string;
    onjump: (key: string) => void;
  } = $props();
</script>

<div class="material-bar hairline-b flex shrink-0 items-center gap-1 overflow-x-auto px-2 py-1.5">
  {#each items as item (item.key)}
    {@const active = item.key === activeKey}
    <button
      type="button"
      onclick={() => onjump(item.key)}
      aria-label={`${item.label}, ${item.count} work item${item.count === 1 ? "" : "s"}`}
      aria-current={active ? "true" : undefined}
      class={cn(
        "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-md)] border-b-2 px-2.5 py-1 text-[13px] transition-colors focus-ring",
        active
          ? "border-accent font-semibold text-content"
          : "border-transparent text-content-muted hover:bg-hover-gray hover:text-content",
      )}
    >
      {#if item.statePhase}
        <StateGroupIcon group={item.statePhase} color={item.stateColor} size={14} class="shrink-0" />
      {/if}
      <span>{item.label}</span>
      <span class="tabular-nums text-content-muted">{item.count}</span>
    </button>
  {/each}
</div>

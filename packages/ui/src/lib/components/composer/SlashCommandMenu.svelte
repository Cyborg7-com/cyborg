<script lang="ts">
  import type { ChannelSlashCommand } from "./slash-commands.js";
  import type { PromptTemplate } from "$lib/core/types.js";

  let {
    items,
    templates = [],
    selectedIndex,
    onSelect,
    onSelectTemplate,
    onHover,
  }: {
    items: ChannelSlashCommand[];
    // #602 — secondary "Templates" group (workspace prompt templates). Walked by
    // the SAME selectedIndex as the commands: indices [0, items.length) are
    // commands; [items.length, items.length + templates.length) are templates.
    templates?: PromptTemplate[];
    selectedIndex: number;
    onSelect: (item: ChannelSlashCommand) => void;
    onSelectTemplate?: (template: PromptTemplate) => void;
    onHover: (index: number) => void;
  } = $props();

  let listEl: HTMLDivElement | undefined = $state();

  // Keep the active row scrolled into view as the user arrows through.
  $effect(() => {
    const idx = selectedIndex;
    if (!listEl) return;
    const row = listEl.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });
</script>

<!-- Composer-anchored popup, same placement idiom as MentionAutocomplete but on
     shadcn theme tokens (solid bg-popover) instead of inline dropdown vars. -->
<div
  bind:this={listEl}
  class="absolute bottom-full left-0 mb-1 z-50 w-[var(--panel-wide)] max-h-[240px] overflow-y-auto rounded-lg border border-edge bg-popover text-popover-foreground py-1 shadow-md"
  role="listbox"
  aria-label="Slash commands"
>
  {#if items.length > 0}
    <div class="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
      Channel commands
    </div>
    {#each items as item, i (item.trigger)}
      <button
        type="button"
        data-idx={i}
        role="option"
        aria-selected={i === selectedIndex}
        onmousedown={(e) => { e.preventDefault(); onSelect(item); }}
        onmouseenter={() => onHover(i)}
        class:bg-dropdown-hover={i === selectedIndex}
        class="w-full flex items-baseline gap-2 px-3 py-1.5 text-left cursor-pointer transition-colors text-[13px]"
      >
        <span class="font-semibold shrink-0">/{item.trigger}</span>
        {#if item.hint}
          <span class="text-content-dim text-[12px] shrink-0">{item.hint}</span>
        {/if}
        <span class="text-content-muted text-[12px] truncate ml-auto">{item.description}</span>
      </button>
    {/each}
  {/if}

  {#if templates.length > 0}
    <!-- #602 — secondary group: workspace prompt templates. Selecting one
         inserts its body (expanded server-side on send). -->
    <div class="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
      Templates
    </div>
    {#each templates as template, t (template.id)}
      {@const idx = items.length + t}
      <button
        type="button"
        data-idx={idx}
        role="option"
        aria-selected={idx === selectedIndex}
        onmousedown={(e) => { e.preventDefault(); onSelectTemplate?.(template); }}
        onmouseenter={() => onHover(idx)}
        class:bg-dropdown-hover={idx === selectedIndex}
        class="w-full flex items-baseline gap-2 px-3 py-1.5 text-left cursor-pointer transition-colors text-[13px]"
      >
        <span class="font-semibold shrink-0 truncate max-w-[40%]">{template.name}</span>
        <span class="text-content-muted text-[12px] truncate ml-auto">{template.body}</span>
      </button>
    {/each}
  {/if}
</div>

<script lang="ts">
  import { authState, presenceState, workspaceUserStatusesState } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import Emoji from "$lib/components/Emoji.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";

  export interface MentionCandidate {
    id: string; // userId, cybo id, channel id, shortcode, or a group token
    label: string; // display name / `:code:` shown + inserted
    sublabel?: string; // email / role / hint
    kind: "human" | "agent" | "everyone" | "channel" | "emoji";
    emoji?: string; // glyph, for kind === "emoji"
  }

  let {
    items,
    selectedIndex,
    heading = "Members",
    onSelect,
    onHover,
  }: {
    items: MentionCandidate[];
    selectedIndex: number;
    heading?: string;
    onSelect: (item: MentionCandidate) => void;
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

<div
  bind:this={listEl}
  class="absolute bottom-full left-0 mb-1 z-50 w-[280px] max-h-[240px] overflow-y-auto rounded-lg py-1"
  style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"
  role="listbox"
>
  <div class="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
    {heading}
  </div>
  {#each items as item, i (item.id)}
    <button
      type="button"
      data-idx={i}
      role="option"
      aria-selected={i === selectedIndex}
      onmousedown={(e) => { e.preventDefault(); onSelect(item); }}
      onmouseenter={() => onHover(i)}
      class="w-full flex items-center gap-2.5 px-3 py-1.5 text-left cursor-pointer transition-colors text-[13px]"
      style={i === selectedIndex
        ? "background-color: var(--dropdown-hover); color: var(--dropdown-name);"
        : "color: var(--dropdown-name);"}
    >
      {#if item.kind === "emoji"}
        <Emoji emoji={item.emoji ?? ""} size={20} title={item.label} />
      {:else if item.kind === "everyone"}
        <span class="w-6 h-6 rounded flex items-center justify-center text-[13px] shrink-0" style="background-color: var(--mention-bg); color: var(--mention-text);">📢</span>
      {:else if item.kind === "channel"}
        <span class="w-6 h-6 rounded flex items-center justify-center text-[14px] shrink-0" style="background-color: var(--mention-bg); color: var(--mention-text);">#</span>
      {:else if item.kind === "agent"}
        {@const img = authState.getMemberImage(item.id)}
        {#if img}
          <img src={img} alt={item.label} class="w-6 h-6 rounded-full object-cover shrink-0" />
        {:else}
          <span class="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style="background-color: var(--mention-bg); color: var(--mention-text);"><CyborgIcon size={14} /></span>
        {/if}
      {:else}
        {@const img = authState.getMemberImage(item.id)}
        {#if img}
          <img src={img} alt={item.label} class="w-6 h-6 rounded-full object-cover shrink-0" />
        {:else}
          <span class="w-6 h-6 rounded-full bg-surface-raised flex items-center justify-center text-[11px] font-medium text-content-dim shrink-0">
            {item.label[0]?.toUpperCase() ?? "?"}
          </span>
        {/if}
      {/if}
      <span class="flex-1 min-w-0">
        <span class="flex items-center gap-1.5">
          <span class="truncate font-medium">{item.label}</span>
          {#if item.kind === "human"}
            {@const statusEmoji = workspaceUserStatusesState.emojiFor(item.id)}
            {@const status = workspaceUserStatusesState.get(item.id)}
            {#if statusEmoji}
              {@const statusTooltip = [status?.emoji, status?.text].filter(Boolean).join(" ")}
              <Emoji emoji={statusEmoji} size={14} title={statusTooltip || statusEmoji} />
            {/if}
            <!-- Active = online & not manually away. Everything else (manual
                 away OR offline) is one grey "Away" state. Mirrors ChannelSidebar. -->
            {@const isActive = presenceState.isOnline(item.id) && !presenceState.isAway(item.id)}
            <span
              class={cn("w-2 h-2 rounded-full shrink-0", isActive ? "bg-online" : "bg-content-dim")}
              title={isActive ? "Active" : "Away"}
            ></span>
          {/if}
        </span>
        {#if item.sublabel}
          <span class="block truncate text-[11px] text-content-muted">{item.sublabel}</span>
        {/if}
      </span>
    </button>
  {/each}
</div>

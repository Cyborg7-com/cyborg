<script lang="ts">
  import { goto } from "$app/navigation";
  import { workspaceState, fetchChannelMembers } from "$lib/state/app.svelte.js";
  import Toolbar from "$lib/components/Toolbar.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import ChannelDetailsDialog from "./ChannelDetailsDialog.svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack";
  import ChannelGlyph from "./ChannelGlyph.svelte";
  import type { Snippet } from "svelte";
  import type { ChannelMember } from "$lib/core/types.js";

  let {
    actions,
    ondeleted,
    onTogglePinned,
  }: { actions?: Snippet; ondeleted?: () => void; onTogglePinned?: () => void } = $props();

  // viewedChannel resolves the joined channel OR the previewed (non-member) one,
  // so the header renders a real title/glyph while previewing. Write-only actions
  // (members, pinned, channel settings) key off isPreviewing and hide in preview.
  const channel = $derived(workspaceState.viewedChannel);
  const isPreviewing = $derived(workspaceState.isPreviewing);

  let showDetails = $state(false);
  let memberCount = $state(0);

  // S5 (P5): on phones the 560px ChannelDetailsDialog overflows, so BOTH
  // details affordances (name tap + members button) push the full-screen
  // details route instead. Desktop keeps the dialog unchanged.
  function openDetails() {
    if (!channel) return;
    if (viewportState.isMobile) {
      void goto(`/workspace/${channel.workspaceId}/channel/${channel.id}/details`);
      return;
    }
    showDetails = true;
  }

  $effect(() => {
    if (!channel || isPreviewing) return;
    fetchChannelMembers(channel.id)
      .then((m) => {
        memberCount = m.length;
        return m;
      })
      .catch(() => {
        memberCount = 0;
      });
  });
</script>

<header class="flex items-center gap-3 border-b border-edge px-4 py-2.5">
  {#if viewportState.isMobile}
    <button type="button" onclick={goBackFromConversation} class="p-1.5 -ml-1.5 rounded-lg active:bg-raised shrink-0 touch-target focus-ring" aria-label="Back">
      <svg class="w-5 h-5 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
    </button>
  {/if}
  {#if channel}
    <ChannelGlyph
      kind={channel.isPrivate ? "private" : "public"}
      class={channel.isPrivate ? "w-4 h-4 text-icon-gray shrink-0" : "text-icon-gray text-lg"}
    />
    {#if isPreviewing}
      <!-- Preview (non-member, read-only): plain label, no details affordance. -->
      <span class="font-semibold text-content text-sm">{channel.name}</span>
    {:else}
      <!-- openDetails() routes mobile to the full-screen details route; desktop opens the dialog. -->
      <button
        type="button"
        class="font-semibold text-content text-sm hover:underline cursor-pointer border-0 bg-transparent p-0 focus-ring"
        onclick={openDetails}
        aria-label={`${channel.name} — open channel details`}
      >
        {channel.name}
      </button>
    {/if}
    {#if isPreviewing}
      <span class="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-content-muted">
        Preview
      </span>
    {/if}
    {#if channel.description}
      <span class="text-[13px] text-content-dim truncate ml-2">
        {channel.description}
      </span>
    {/if}
  {:else}
    <h2 class="text-sm text-content-muted">Select a channel</h2>
  {/if}
  <div class="ml-auto flex items-center gap-1.5">
    {#if channel && !isPreviewing}
      {#if onTogglePinned}
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-content-muted gap-1 touch-target" title="Pinned messages" aria-label="Pinned messages" onclick={onTogglePinned}>
          <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M5 2h6M6 2v4L4.5 9h7L10 6V2M8 9v5" />
          </svg>
        </Button>
      {/if}
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-content-muted gap-1 touch-target" title="Members" aria-label={memberCount > 0 ? `Members, ${memberCount}` : "Members"} onclick={openDetails}>
        <svg class="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="5.5" cy="6" r="2.5"/>
          <circle cx="10.5" cy="6" r="2.5"/>
          <path d="M1 13c0-2 2-3.5 4.5-3.5S10 11 10 13M6.5 13c0-2 2-3.5 4.5-3.5s4 1.5 4 3.5"/>
        </svg>
        {memberCount > 0 ? memberCount : ""}
      </Button>
    {/if}
    <Toolbar />
    {#if actions}
      {@render actions()}
    {/if}
  </div>
</header>

{#if channel && !isPreviewing}
  <ChannelDetailsDialog bind:open={showDetails} {channel} {ondeleted} />
{/if}

<script lang="ts">
  import { goto } from "$app/navigation";
  import { workspaceState, channelState, listChannels, joinChannel, selectChannelPreview } from "$lib/state/app.svelte.js";
  import type { Channel } from "$lib/core/types.js";
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog/index.js";
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import ChannelGlyph from "./ChannelGlyph.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  type BrowseChannel = Channel & { isMember: boolean; memberCount: number };

  function memberLabel(n: number): string {
    return `${n} ${n === 1 ? "member" : "members"}`;
  }

  let channels = $state<BrowseChannel[]>([]);
  let loading = $state(false);
  let joining = $state<Set<string>>(new Set());

  const wsId = $derived(workspaceState.current?.id ?? null);

  // Load the full channel list each time the modal opens. The backend
  // (cyborg:list_channels) returns every public channel plus the private
  // channels you belong to, each carrying an isMember flag.
  $effect(() => {
    if (!open || !wsId) return;
    loading = true;
    listChannels()
      .then((list) => {
        channels = list;
        return undefined;
      })
      .catch(() => { channels = []; })
      .finally(() => { loading = false; });
  });

  const available = $derived(channels.filter((c) => !c.isMember));
  const joined = $derived(channels.filter((c) => c.isMember));

  function navigateToChannel(channelId: string) {
    if (!wsId) return;
    channelState.activeId = channelId;
    open = false;
    goto(`/workspace/${wsId}/channel/${channelId}`);
  }

  // Peek at a public channel read-only without joining. Seed the preview state
  // BEFORE navigating so the channel route paints messages immediately (the
  // browse list is already warm) instead of flashing a skeleton, then carry the
  // intent in the URL (?preview=1) so a reload of that URL re-enters preview.
  function handlePreview(channel: BrowseChannel) {
    if (!wsId) return;
    selectChannelPreview(channel);
    open = false;
    goto(`/workspace/${wsId}/channel/${channel.id}?preview=1`);
  }

  async function handleJoin(channel: BrowseChannel) {
    if (!wsId || joining.has(channel.id)) return;
    joining = new Set(joining).add(channel.id);
    try {
      await joinChannel(channel);
      const target = channels.find((c) => c.id === channel.id);
      if (target) target.isMember = true;
      channels = channels.slice();
      // Jump to the channel after a successful join (Slack behavior).
      navigateToChannel(channel.id);
    } finally {
      const next = new Set(joining);
      next.delete(channel.id);
      joining = next;
    }
  }
</script>

{#snippet hashIcon()}
  <ChannelGlyph kind="hash" class="w-[15px] h-[15px] shrink-0 text-content-dim" />
{/snippet}

<Dialog bind:open>
  <DialogContent class="sm:max-w-[480px] p-0 gap-0" showCloseButton={true}>
    <DialogHeader class="px-5 py-4 border-b border-edge">
      <DialogTitle class="text-lg font-semibold text-white">Browse channels</DialogTitle>
    </DialogHeader>

    <ScrollArea class="max-h-[60vh]">
      <div class="px-2 py-2">
        {#if loading}
          <p class="text-content-dim text-sm text-center py-8">Loading…</p>
        {:else if channels.length === 0}
          <p class="text-content-dim text-sm text-center py-8">No channels in this workspace.</p>
        {:else}
          {#if available.length > 0}
            <div class="mb-3">
              <p class="text-xs text-content-muted font-semibold uppercase px-3 py-1">Available to join</p>
              {#each available as ch (ch.id)}
                <div class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-raised">
                  <div class="flex items-center gap-2 min-w-0">
                    {@render hashIcon()}
                    <div class="min-w-0">
                      <p class="text-sm text-white font-medium truncate">{ch.name}</p>
                      <p class="text-xs text-content-dim truncate">
                        {memberLabel(ch.memberCount)}{#if ch.description}&nbsp;·&nbsp;{ch.description}{/if}
                      </p>
                    </div>
                  </div>
                  <div class="shrink-0 ml-2 flex items-center gap-1.5">
                    <button
                      type="button"
                      onclick={() => handlePreview(ch)}
                      class="px-3 py-1 text-xs font-medium text-content-dim hover:text-white border border-edge rounded-md cursor-pointer"
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      onclick={() => handleJoin(ch)}
                      disabled={joining.has(ch.id)}
                      class="px-3 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-accent-foreground rounded-md cursor-pointer disabled:opacity-50"
                    >
                      {joining.has(ch.id) ? "Joining…" : "Join"}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

          {#if joined.length > 0}
            <div>
              <p class="text-xs text-content-muted font-semibold uppercase px-3 py-1">Joined</p>
              {#each joined as ch (ch.id)}
                <div class="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-raised">
                  <div class="flex items-center gap-2 min-w-0">
                    {@render hashIcon()}
                    <div class="min-w-0">
                      <p class="text-sm text-white font-medium truncate">{ch.name}</p>
                      <p class="text-xs text-content-dim truncate">
                        {memberLabel(ch.memberCount)}{#if ch.description}&nbsp;·&nbsp;{ch.description}{/if}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onclick={() => navigateToChannel(ch.id)}
                    class="shrink-0 ml-2 px-3 py-1 text-xs font-medium text-content-dim hover:text-white border border-edge rounded-md cursor-pointer"
                  >
                    Open
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
    </ScrollArea>
  </DialogContent>
</Dialog>

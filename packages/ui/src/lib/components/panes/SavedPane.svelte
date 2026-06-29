<script lang="ts">
  import { goto } from "$app/navigation";
  import {
    savedState,
    loadSavedMessages,
    saveMessage,
    workspaceState,
    messageFocusState,
  } from "$lib/state/app.svelte.js";
  import type { Message } from "$lib/types.js";
  import ChatMessage from "../message/ChatMessage.svelte";
  import EmptyState from "../EmptyState.svelte";

  const messages = $derived(savedState.list);
  const wsId = $derived(workspaceState.current?.id);

  // One-shot fetch on mount (and when the workspace changes), mirroring ThreadsPane.
  // savedState is cleared on workspace switch, so refetching here is correct.
  let fetchedFor = $state<string | null>(null);
  $effect(() => {
    if (wsId && fetchedFor !== wsId) {
      fetchedFor = wsId;
      void loadSavedMessages();
    }
  });

  function channelName(channelId: string | null): string | null {
    if (!channelId) return null;
    return workspaceState.channels.find((c) => c.id === channelId)?.name ?? null;
  }

  // Jump to a saved message in its channel and flash it (MessageList watches
  // messageFocusState). Saved messages span channels, so this is the affordance
  // that takes you to the original. DMs/system messages have no channel link.
  function open(message: Message): void {
    if (!wsId || !message.channelId) return;
    goto(`/workspace/${wsId}/channel/${message.channelId}`);
    messageFocusState.focus(message.id);
  }

  function unsave(message: Message): void {
    saveMessage(message, false);
  }
</script>

<div class="h-full overflow-y-auto" style="background-color: var(--bg-base);">
  <div class="mx-auto flex max-w-[var(--content-max)] flex-col gap-3 px-6 py-6">
    <header class="flex items-center justify-between">
      <h1 class="text-[20px] font-bold text-content">Saved</h1>
    </header>

    {#if savedState.loading && messages.length === 0}
      <p class="text-[13px] text-content-muted">Loading saved messages…</p>
    {:else if messages.length === 0}
      <div class="rounded-lg p-8 text-center" style="background-color: var(--surface-alt);">
        <p class="text-[14px] text-content-dim">No saved messages yet</p>
        <p class="mt-1 text-[12px] text-content-muted">
          Save a message from its menu — your bookmarks show up here, only for you.
        </p>
      </div>
    {:else}
      <div class="flex flex-col gap-2">
        {#each messages as msg (msg.id)}
          {@const chName = channelName(msg.channelId)}
          <!-- One cohesive card: a single surface owns the whole tile. The header
               (channel context + unsave) and the embedded message share the same
               px-3 inset, so the #channel link lines up with the message's avatar
               and the row no longer paints a second, mismatched inner box. -->
          <div class="rounded-lg bg-surface-alt px-3 py-2.5">
            <!-- Channel context + jump-to + unsave, above the reused message row. -->
            <div class="mb-1.5 flex items-center justify-between gap-2">
              <button
                type="button"
                onclick={() => open(msg)}
                class="truncate text-[12px] font-semibold text-link hover:underline focus-ring"
                title="Go to message"
              >
                {chName ? `#${chName}` : "Message"}
              </button>
              <button
                type="button"
                onclick={() => unsave(msg)}
                class="-my-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-warning hover:bg-edge focus-ring"
                title="Remove from saved"
                aria-label="Remove from saved"
              >
                <!-- Filled bookmark = saved; clicking unsaves. -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </button>
            </div>
            <ChatMessage message={msg} hideThread showHoverToolbar={false} timestampMode="always" embedded />
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

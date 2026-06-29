<script lang="ts">
  import { channelState } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import ChatMessage from "../message/ChatMessage.svelte";
  import EmptyState from "../EmptyState.svelte";
  import PanelHeader from "../PanelHeader.svelte";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { setNativeVisibility } from "$lib/mobile/nativeComposer.js";

  let { onClose }: { onClose: () => void } = $props();

  // Pinned messages currently loaded in the channel (pin/unpin is live).
  const pinned = $derived(
    channelState.messages
      .filter((m) => m.pinnedAt)
      .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
  );

  // iOS: this panel's mobile variant is a full-screen web sheet over the chat,
  // but the native composer pill is a window-anchored UIKit overlay ABOVE the
  // WebView, so it would bleed through on top of the sheet. The component is
  // mounted only while the panel is open (the parent toggles it), so hide the
  // pill on mount and restore it on destroy — gated on the mobile full-screen
  // variant. Pure visibility toggle (no ownership / first-responder / constraint
  // changes). No-op off iOS (web/desktop/Android untouched).
  $effect(() => {
    if (!isTauriIOS() || !viewportState.isMobile) return;
    void setNativeVisibility(false);
    return () => {
      void setNativeVisibility(true);
    };
  });
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onClose()} />

<div
  class={viewportState.isMobile
    ? "fixed inset-0 z-[var(--z-sheet)] flex flex-col"
    : "absolute right-2 top-2 z-40 flex max-h-[70%] w-[var(--panel-wider)] flex-col rounded-xl"}
  style={viewportState.isMobile
    ? "background-color: var(--bg-base); padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);"
    : "background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"}
>
  <PanelHeader title="Pinned messages" onClose={onClose} closeLabel="Close pinned messages" />
  <div class="flex-1 overflow-y-auto py-1">
    {#if pinned.length === 0}
      <EmptyState
        title="No pinned messages yet"
        description="Pin important messages and they'll show up here for everyone in the channel."
      >
        {#snippet icon()}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
          </svg>
        {/snippet}
      </EmptyState>
    {:else}
      {#each pinned as msg (msg.id)}
        <ChatMessage message={msg} hideThread showHoverToolbar={false} timestampMode="always" />
      {/each}
    {/if}
  </div>
</div>

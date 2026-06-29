<script lang="ts">
  // Sticky footer that REPLACES the composer while a non-member previews a public
  // channel read-only. "You're previewing #name" + a "Join Channel" CTA. Joining
  // is seamless: joinChannel() appends the channel to workspaceState.channels, so
  // activeChannel resolves, isPreviewing flips false, and the route swaps this
  // banner back to the composer — no reload. Archived public channels are
  // read-only with no Join CTA (mirrors the archived empty-state copy).
  import { fade } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { joinChannel } from "$lib/state/app.svelte.js";
  import type { Channel } from "$lib/core/types.js";

  let { channel, onClose }: { channel: Channel; onClose?: () => void } = $props();

  let joining = $state(false);
  const isArchived = $derived(channel.isArchived === true);

  async function handleJoin(): Promise<void> {
    if (joining) return;
    joining = true;
    try {
      await joinChannel(channel);
      // On success the route re-renders with the composer (activeChannel now
      // resolves). If it didn't (e.g. a transient error left us in preview), the
      // finally below re-enables the button so the user can retry.
    } catch (err) {
      console.error("Failed to join channel from preview:", err);
    } finally {
      joining = false;
    }
  }
</script>

<div
  in:fade={{ duration: 150, easing: cubicOut }}
  class="flex shrink-0 items-center justify-between gap-3 border-t border-edge bg-raised/80 px-4 py-3 backdrop-blur"
>
  <div class="flex min-w-0 items-center gap-3">
    <!-- Eye / preview glyph -->
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-content-muted">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </span>
    <div class="min-w-0">
      {#if isArchived}
        <p class="truncate text-sm font-medium text-content">
          You're viewing an archived channel
        </p>
        <p class="truncate text-xs text-content-dim">
          New messages can't be posted in #{channel.name}.
        </p>
      {:else}
        <p class="truncate text-sm font-medium text-content">
          You're previewing #{channel.name}
        </p>
        <p class="truncate text-xs text-content-dim">
          Join the channel to send messages and react.
        </p>
      {/if}
    </div>
  </div>

  <div class="flex shrink-0 items-center gap-2">
    {#if onClose}
      <button
        type="button"
        onclick={onClose}
        class="cursor-pointer rounded-md border border-edge px-3 py-1.5 text-sm font-medium text-content-dim transition-colors hover:text-content hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Close
      </button>
    {/if}
    {#if !isArchived}
      <button
        type="button"
        onclick={handleJoin}
        disabled={joining}
        class="inline-flex cursor-pointer items-center gap-2 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default disabled:opacity-70"
      >
        {#if joining}
          <span class="h-3 w-3 shrink-0 animate-spin rounded-full border border-accent-foreground border-t-transparent" aria-hidden="true"></span>
          Joining…
        {:else}
          Join Channel
        {/if}
      </button>
    {/if}
  </div>
</div>

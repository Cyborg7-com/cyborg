<script lang="ts">
  import type { Message } from "$lib/types.js";
  import { authState, openThread, pinMessage } from "$lib/state/app.svelte.js";
  import { buildMessageLink } from "$lib/message-link.js";
  import { toast } from "svelte-sonner";
  import Emoji from "$lib/components/Emoji.svelte";
  import BottomActionSheet from "./BottomActionSheet.svelte";
  import EmojiPicker from "../composer/EmojiPicker.svelte";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { setNativeVisibility } from "$lib/mobile/nativeComposer.js";

  // Mobile long-press action sheet — mirrors the V1 mobile
  // MessageActionsSheet (cyborg7-core/mobile MessageActionsSheet.svelte):
  // a quick-reaction emoji row + a "React…" entry that opens the full
  // EmojiPicker, then a vertical action list (Reply in thread, Copy,
  // Pin/Unpin, Edit, Delete). Every action reuses the SAME handlers as
  // the desktop hover toolbar (MessageActionBar) — onReaction, openThread,
  // pinMessage, onDelete, and an edit-request callback into ChatMessage's
  // inline editor.
  let {
    open = $bindable(false),
    message,
    onReaction,
    onDelete,
    onEditRequest,
    hideThread = false,
  }: {
    open?: boolean;
    message: Message | null;
    onReaction?: (messageId: string, emoji: string) => void;
    onDelete?: (messageId: string) => void;
    // Triggers ChatMessage's inline editor for this message (own message only).
    onEditRequest?: (messageId: string) => void;
    hideThread?: boolean;
  } = $props();

  // Top quick-reaction emojis (Slack mobile parity — same intent as the V1
  // sheet's QUICK row). Tapping reacts + closes; "React…" opens the picker.
  const QUICK = ["👍", "❤️", "✅", "😂", "🎉"];

  let showPicker = $state(false);

  // The native composer pill is a UIKit overlay ABOVE the WKWebView, so it bleeds
  // through this web sheet (it was rendering between "Pin" and "Delete", hiding
  // the Edit row). Hide it while the sheet is open; restore on close/unmount.
  $effect(() => {
    if (!isTauriIOS() || !open) return;
    setNativeVisibility(false);
    return () => setNativeVisibility(true);
  });

  const isOwn = $derived(!!message && message.fromId === authState.user?.id);
  const isPinned = $derived(!!message?.pinnedAt);
  // Permalink to this message — null on surfaces without a stable channel link
  // (e.g. DMs / system messages), so the row is hidden there.
  const messageLink = $derived(message ? buildMessageLink(message) : null);

  function close(): void {
    open = false;
    showPicker = false;
  }

  function react(emoji: string): void {
    if (message) onReaction?.(message.id, emoji);
    close();
  }

  function handleEmojiSelect(emoji: string): void {
    react(emoji);
  }

  function reply(): void {
    if (message) void openThread(message);
    close();
  }

  function copy(): void {
    if (message)
      navigator.clipboard?.writeText(message.text).catch((err) => {
        // Direct user action — a denied/failed clipboard write must surface,
        // not vanish into a no-op sheet dismiss.
        console.error("Failed to copy message:", err);
        toast.error("Couldn't copy message");
      });
    close();
  }

  function copyLink(): void {
    if (messageLink) {
      navigator.clipboard?.writeText(messageLink)
        .then(() => {
          toast.success("Link copied");
        })
        .catch((err) => {
          // The success path toasts; surface the failure too so a denied write
          // isn't mistaken for a copy that worked.
          console.error("Failed to copy link:", err);
          toast.error("Couldn't copy link");
        });
    }
    close();
  }

  function pin(): void {
    if (message) pinMessage(message.id, !message.pinnedAt);
    close();
  }

  function edit(): void {
    if (message) onEditRequest?.(message.id);
    close();
  }

  function del(): void {
    if (message) onDelete?.(message.id);
    close();
  }
</script>

{#if open && message}
  <BottomActionSheet ariaLabel="Message actions" onClose={close}>
        {#if showPicker}
          <!-- Full emoji picker (reuses the composer EmojiPicker). Selecting
               reacts + closes the whole sheet. -->
          <div class="flex justify-center pb-1">
            <EmojiPicker
              onSelect={handleEmojiSelect}
              onClose={() => (showPicker = false)}
              class="w-full"
            />
          </div>
        {:else}
          <!-- Quick-reaction row + a "React…" entry that opens the full picker.
               Circular 44pt targets, 32px emoji, staggered spring pop-in. -->
          {#if onReaction}
            <div class="mb-3 flex shrink-0 items-center justify-between">
              {#each QUICK as em, i (em)}
                <button
                  type="button"
                  onclick={() => react(em)}
                  class="quick-pop flex h-[44px] w-[44px] items-center justify-center rounded-full bg-surface-alt transition-transform active:scale-110"
                  style="animation-delay: {i * 30}ms"
                  title={em}
                >
                  <Emoji emoji={em} size={32} />
                </button>
              {/each}
              <button
                type="button"
                onclick={() => (showPicker = true)}
                aria-label="React with another emoji"
                class="quick-pop flex h-[44px] w-[44px] items-center justify-center rounded-full bg-surface-alt transition-colors active:bg-raised"
                style="animation-delay: {QUICK.length * 30}ms"
              >
                <svg class="h-[20px] w-[20px] text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                  <line x1="9" y1="9" x2="9.01" y2="9" />
                  <line x1="15" y1="9" x2="15.01" y2="9" />
                </svg>
              </button>
            </div>
          {/if}

          <!-- Vertical action list — one grouped inset card; hairlines between
               cells are allowed INSIDE grouped cards (trap-list rule 4). -->
          <div class="shrink-0 overflow-hidden rounded-[12px] bg-surface-alt">
            {#if !hideThread}
              <button
                type="button"
                onclick={reply}
                class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised"
              >
                <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M7 8H4a1 1 0 00-1 1v6a1 1 0 001 1h2v2l3-2h4a1 1 0 001-1v-2" />
                  <path d="M13 3H7a1 1 0 00-1 1v6a1 1 0 001 1h2v2l3-2h1a1 1 0 001-1V4a1 1 0 00-1-1z" />
                </svg>
                <span class="flex-1 text-left text-[16px] text-content">Reply in thread</span>
              </button>
              <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
            {/if}

            <button
              type="button"
              onclick={copy}
              class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised"
            >
              <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span class="flex-1 text-left text-[16px] text-content">Copy text</span>
            </button>

            {#if messageLink}
              <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
              <button
                type="button"
                onclick={copyLink}
                class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised"
              >
                <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <span class="flex-1 text-left text-[16px] text-content">Copy link</span>
              </button>
            {/if}

            <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
            <button
              type="button"
              onclick={pin}
              class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised"
            >
              <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 3v2l-1 1v5l3 3v2h-5v6h-2v-6H6v-2l3-3V6L8 5V3z" />
              </svg>
              <span class="flex-1 text-left text-[16px] text-content">{isPinned ? "Unpin message" : "Pin message"}</span>
            </button>

            {#if isOwn && onEditRequest}
              <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
              <button
                type="button"
                onclick={edit}
                class="flex min-h-[48px] w-full items-center gap-3 px-4 transition-colors active:bg-raised"
              >
                <svg class="h-[20px] w-[20px] shrink-0 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                <span class="flex-1 text-left text-[16px] text-content">Edit message</span>
              </button>
            {/if}

            {#if isOwn && onDelete}
              <div class="mx-4 h-px" style="background-color: var(--hairline);"></div>
              <button
                type="button"
                onclick={del}
                class="flex min-h-[48px] w-full items-center gap-3 px-4 text-error transition-colors active:bg-raised"
              >
                <svg class="h-[20px] w-[20px] shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                <span class="flex-1 text-left text-[16px]">Delete message</span>
              </button>
            {/if}
          </div>
        {/if}
  </BottomActionSheet>
{/if}

<style>
  /* Springy pop-in for the quick-reaction row (staggered via inline
     animation-delay; `backwards` keeps delayed circles invisible pre-start). */
  .quick-pop {
    animation: quick-pop 260ms var(--ease-spring) backwards;
  }
  @keyframes quick-pop {
    from {
      opacity: 0;
      transform: scale(0.4);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .quick-pop {
      animation: none;
    }
  }
</style>

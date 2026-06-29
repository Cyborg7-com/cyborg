<script lang="ts">
  import type { Message } from "$lib/types.js";
  import { authState } from "$lib/state/app.svelte.js";
  import { buildMessageLink } from "$lib/message-link.js";
  import { toast } from "svelte-sonner";
  import Emoji from "$lib/components/Emoji.svelte";
  import EmojiPicker from "../composer/EmojiPicker.svelte";
  import { clickOutside } from "$lib/actions/clickOutside.js";

  let {
    message,
    onReaction,
    onEdit,
    onStartEdit,
    onDelete,
    onPin,
    onSave,
    saved = false,
    onReplyInThread,
    onMenuOpenChange,
  }: {
    message: Message;
    onReaction?: (messageId: string, emoji: string) => void;
    onEdit?: (messageId: string, newText: string) => void;
    onStartEdit?: () => void;
    onDelete?: (messageId: string) => void;
    onPin?: () => void;
    // Personal save toggle (#609). `saved` reflects the current bookmark state so
    // the affordance reads "Save"/"Unsave" and the glyph fills when saved.
    onSave?: () => void;
    saved?: boolean;
    onReplyInThread?: () => void;
    // Notify the parent (ChatMessage) when a popover (more-menu / emoji picker) is
    // open, so it keeps the action bar visible even if the pointer leaves the
    // message row — otherwise reaching a menu that opened ABOVE the row lost the
    // hover and the bar (and its delete button) vanished mid-reach.
    onMenuOpenChange?: (open: boolean) => void;
  } = $props();

  const RECENT_KEY = "cyborg7_recent_reactions";
  const DEFAULT_REACTIONS = ["✅", "👀", "🙌"];

  let showEmojiPicker = $state(false);
  let showMoreMenu = $state(false);
  let menuAbove = $state(false);

  // Keep the parent's action bar pinned open while any popover is open.
  $effect(() => {
    onMenuOpenChange?.(showMoreMenu || showEmojiPicker);
  });
  let copied = $state(false);
  let linkCopied = $state(false);

  const isOwn = $derived(message.fromId === authState.user?.id);

  function getRecentReactions(): string[] {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (raw) {
        const list: string[] = JSON.parse(raw);
        return list.slice(0, 3);
      }
    } catch {
      // intentional: best-effort read of recent reactions; falls back to defaults.
    }
    return DEFAULT_REACTIONS;
  }

  function pushRecentReaction(emoji: string): void {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const list: string[] = raw ? JSON.parse(raw) : DEFAULT_REACTIONS;
      const updated = [emoji, ...list.filter((e) => e !== emoji)].slice(0, 20);
      localStorage.setItem(RECENT_KEY, JSON.stringify(updated));
    } catch {
      // intentional: best-effort persistence of recent reactions; not user-facing.
    }
  }

  function handleReaction(emoji: string): void {
    onReaction?.(message.id, emoji);
    pushRecentReaction(emoji);
  }

  function handleCopy(): void {
    navigator.clipboard.writeText(message.text).catch((err) => {
      // We optimistically flip `copied` below; a denied/failed clipboard write
      // must not masquerade as a successful copy. Surface it (same as copyLink).
      console.error("Failed to copy message:", err);
      toast.error("Couldn't copy message");
    });
    copied = true;
    showMoreMenu = false;
    setTimeout(() => { copied = false; }, 1500);
  }

  // Permalink to this message — null for surfaces without a stable channel link
  // (e.g. DMs / system messages), so the action is hidden there.
  const messageLink = $derived(buildMessageLink(message));

  function handleCopyLink(): void {
    if (!messageLink) return;
    showMoreMenu = false;
    if (!navigator.clipboard) return;
    navigator.clipboard.writeText(messageLink).then(() => {
      linkCopied = true;
      toast.success("Link copied");
      setTimeout(() => { linkCopied = false; }, 1500);
    }).catch((err) => {
      // The success path toasts; the failure path was silent. Surface it so a
      // denied clipboard write isn't mistaken for a copy that worked.
      console.error("Failed to copy message link:", err);
      toast.error("Couldn't copy link");
    });
  }

  function handleEdit(): void {
    // Inline edit is owned by ChatMessage (onStartEdit). Fall back to a prompt
    // only if no inline handler was provided.
    if (onStartEdit) onStartEdit();
    else {
      const newText = prompt("Edit message:", message.text);
      if (newText !== null && newText.trim() && newText !== message.text) {
        onEdit?.(message.id, newText.trim());
      }
    }
    showMoreMenu = false;
  }

  function handleDelete(): void {
    onDelete?.(message.id);
    showMoreMenu = false;
  }

  function handleEmojiSelect(emoji: string): void {
    handleReaction(emoji);
    showEmojiPicker = false;
  }

  function handlePin(): void {
    onPin?.();
    showMoreMenu = false;
  }

  function handleSave(): void {
    onSave?.();
    showMoreMenu = false;
  }

  function handleReply(): void {
    onReplyInThread?.();
  }

  function handleMoreClick(e: MouseEvent): void {
    e.stopPropagation();
    if (!showMoreMenu) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      // Flip the menu above when there isn't room below for the full menu
      // (~160px) plus the composer it would otherwise overlap/clip behind
      // (the menu lives inside the overflow-y-auto message list). 200px was too
      // small, so for messages near the composer the menu opened down and got
      // clipped / drawn under the input.
      menuAbove = window.innerHeight - rect.bottom < 300;
    }
    showMoreMenu = !showMoreMenu;
  }

  // Outside-click close is the shared `clickOutside` action (#510), applied
  // per-popover container below with `capture: true` to preserve the original
  // capture-phase behaviour (close the reaction popover before a click on
  // another row's bar can re-open one). Esc isn't wired here — the original
  // listener was click-only, no behaviour change.

  const recentReactions = $derived(getRecentReactions());
</script>

<div class="flex items-center">
  {#if onReaction}
    {#each recentReactions as em}
      <button
        type="button"
        onclick={(e) => { e.stopPropagation(); handleReaction(em); }}
        class="flex h-7 w-7 cursor-pointer items-center justify-center transition-transform first:rounded-l-md hover:bg-edge active:scale-125 focus-ring"
        title={em}
        aria-label={`React with ${em}`}
      >
        <Emoji emoji={em} size={16} />
      </button>
    {/each}
    <div class="mx-0.5 h-4 w-px bg-edge"></div>
  {/if}

  {#if onReaction}
    <div
      class="relative"
      use:clickOutside={{ enabled: showEmojiPicker, capture: true, escape: false, onClose: () => { showEmojiPicker = false; } }}
    >
      <button
        type="button"
        onclick={(e) => { e.stopPropagation(); showEmojiPicker = !showEmojiPicker; }}
        class="flex h-7 w-7 cursor-pointer items-center justify-center hover:bg-edge focus-ring"
        title="Add reaction"
        aria-label="Add reaction"
        aria-haspopup="dialog"
        aria-expanded={showEmojiPicker}
      >
        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: var(--content-dim, #9b9c9e);">
          <circle cx="12" cy="12" r="10"/>
          <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
          <line x1="9" y1="9" x2="9.01" y2="9"/>
          <line x1="15" y1="9" x2="15.01" y2="9"/>
        </svg>
      </button>
      {#if showEmojiPicker}
        <div class="absolute bottom-full right-0 z-50 mb-1">
          <EmojiPicker onSelect={handleEmojiSelect} onClose={() => { showEmojiPicker = false; }} />
        </div>
      {/if}
    </div>
  {/if}

  {#if onPin}
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); handlePin(); }}
      class="flex h-7 w-7 cursor-pointer items-center justify-center hover:bg-edge focus-ring"
      title={message.pinnedAt ? "Unpin message" : "Pin message"}
      aria-label={message.pinnedAt ? "Unpin message" : "Pin message"}
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: {message.pinnedAt ? 'var(--color-pinned)' : 'var(--content-dim, #9b9c9e)'};">
        <path d="M16 3v2l-1 1v5l3 3v2h-5v6h-2v-6H6v-2l3-3V6L8 5V3z" />
      </svg>
    </button>
  {/if}

  {#if onSave}
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); handleSave(); }}
      class="flex h-7 w-7 cursor-pointer items-center justify-center hover:bg-edge focus-ring"
      title={saved ? "Remove from saved" : "Save message"}
      aria-label={saved ? "Remove from saved" : "Save message"}
      aria-pressed={saved}
    >
      <!-- Bookmark: filled (warning tint) when saved, outline otherwise. -->
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: {saved ? 'var(--color-pinned)' : 'var(--content-dim, #9b9c9e)'};">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
    </button>
  {/if}

  <button
    type="button"
    onclick={(e) => { e.stopPropagation(); handleCopy(); }}
    class="flex h-7 w-7 cursor-pointer items-center justify-center hover:bg-edge focus-ring"
    title={copied ? "Copied!" : "Copy text"}
    aria-label={copied ? "Copied" : "Copy text"}
  >
    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color: {copied ? 'var(--color-online)' : 'var(--content-dim, #9b9c9e)'};">
      {#if copied}
        <polyline points="20 6 9 17 4 12"/>
      {:else}
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      {/if}
    </svg>
  </button>

  {#if messageLink}
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); handleCopyLink(); }}
      class="flex h-7 w-7 cursor-pointer items-center justify-center hover:bg-edge"
      title={linkCopied ? "Link copied!" : "Copy link"}
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color: {linkCopied ? 'var(--color-online)' : 'var(--content-dim, #9b9c9e)'};">
        {#if linkCopied}
          <polyline points="20 6 9 17 4 12"/>
        {:else}
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        {/if}
      </svg>
    </button>
  {/if}

  {#if onReplyInThread}
    <button
      type="button"
      onclick={(e) => { e.stopPropagation(); handleReply(); }}
      class="flex h-7 w-7 cursor-pointer items-center justify-center hover:bg-edge focus-ring"
      title="Reply in thread"
      aria-label="Reply in thread"
    >
      <svg class="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="color: var(--content-dim, #9b9c9e);">
        <path d="M7 8H4a1 1 0 00-1 1v6a1 1 0 001 1h2v2l3-2h4a1 1 0 001-1v-2" />
        <path d="M13 3H7a1 1 0 00-1 1v6a1 1 0 001 1h2v2l3-2h1a1 1 0 001-1V4a1 1 0 00-1-1z" />
      </svg>
    </button>
  {/if}

  <div
    class="relative"
    use:clickOutside={{ enabled: showMoreMenu, capture: true, escape: false, onClose: () => { showMoreMenu = false; } }}
  >
    <button
      type="button"
      onclick={handleMoreClick}
      class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-r-md hover:bg-edge focus-ring"
      title="More actions"
      aria-label="More actions"
      aria-haspopup="menu"
      aria-expanded={showMoreMenu}
    >
      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="color: var(--content-dim, #9b9c9e);">
        <circle cx="12" cy="5" r="1.5"/>
        <circle cx="12" cy="12" r="1.5"/>
        <circle cx="12" cy="19" r="1.5"/>
      </svg>
    </button>
    {#if showMoreMenu}
      <div
        role="menu"
        class="absolute right-0 z-50 w-[160px] rounded-lg border border-edge bg-surface-alt py-1 shadow-2xl"
        class:bottom-full={menuAbove}
        class:mb-1={menuAbove}
        class:top-full={!menuAbove}
        class:mt-1={!menuAbove}
      >
        <button
          type="button"
          role="menuitem"
          onclick={handleCopy}
          class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-content hover:bg-hover-gray focus-ring"
        >
          <Emoji emoji="📋" size={16} /> Copy text
        </button>
        {#if messageLink}
          <button
            type="button"
            onclick={handleCopyLink}
            class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-content hover:bg-hover-gray"
          >
            <Emoji emoji="🔗" size={16} /> {linkCopied ? "Link copied!" : "Copy link"}
          </button>
        {/if}
        {#if onPin}
          <button
            type="button"
            role="menuitem"
            onclick={handlePin}
            class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-content hover:bg-hover-gray focus-ring"
          >
            <Emoji emoji="📌" size={16} /> {message.pinnedAt ? "Unpin message" : "Pin message"}
          </button>
        {/if}
        {#if onSave}
          <button
            type="button"
            role="menuitem"
            onclick={handleSave}
            class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-content hover:bg-hover-gray focus-ring"
          >
            <Emoji emoji="🔖" size={16} /> {saved ? "Remove from saved" : "Save message"}
          </button>
        {/if}
        {#if isOwn && onEdit}
          <button
            type="button"
            role="menuitem"
            onclick={handleEdit}
            class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-content hover:bg-hover-gray focus-ring"
          >
            <Emoji emoji="✏️" size={16} /> Edit message
          </button>
        {/if}
        {#if isOwn && onDelete}
          <button
            type="button"
            role="menuitem"
            onclick={handleDelete}
            class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-content hover:bg-hover-gray focus-ring"
          >
            <Emoji emoji="🗑️" size={16} /> <span class="text-error">Delete message</span>
          </button>
        {/if}
      </div>
    {/if}
  </div>
</div>

<script lang="ts">
  import {
    threadState,
    threadsState,
    closeThread,
    sendThreadReply,
    toggleReaction,
    markThreadUnread,
    messageFocusState,
    authState,
    workspaceState,
  } from "$lib/state/app.svelte.js";
  import { formatDate, isSameDay } from "$lib/utils.js";
  import PanelHeader from "$lib/components/PanelHeader.svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import MessageInput from "./MessageInput.svelte";
  import UnreadDivider from "./UnreadDivider.svelte";
  import TypingIndicator from "./TypingIndicator.svelte";
  import { typingAuthorName } from "./message-author.js";
  import NewMessagesToast from "./NewMessagesToast.svelte";
  import { fly } from "svelte/transition";
  import { cubicOut } from "svelte/easing";
  import { onMount } from "svelte";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { subscribe as subscribeKeyboard } from "$lib/mobile/keyboard-state.js";
  import { isUnreadForDivider } from "$lib/unread-divider.js";
  import {
    pinToBottom,
    installIosKeyboardScrollPreserve,
  } from "$lib/mobile/chatScroll.js";

  // Drives the mobile sheet's bottom reservation (see the aside style). Same
  // signal the workspace layout uses to show/hide MobileNav.
  let keyboardOpen = $state(false);
  onMount(() => subscribeKeyboard((open) => (keyboardOpen = open)));

  // NOTE: the native composer pill is intentionally NOT hidden while the thread
  // sheet is open. The thread's own MessageInput (below) registers with the
  // native-composer LIFO stack and OWNS the pill while the thread is open, so
  // hiding it would leave the thread with no composer. The sheet is anchored by
  // top+height (not `inset-0`) so it shrinks with the keyboard, letting the
  // pill ride the keyboard at the bottom of the shrunken sheet.

  // Per-thread "New replies" divider (#7). Frozen cursor captured at thread-open
  // (threadsState.perThreadLastViewed[rootId]) — NOT the live server cursor — so
  // marking the thread read on open doesn't make the line vanish. The divider goes
  // above the first reply newer than the cursor that isn't the viewer's own message
  // — webhook/CI replies count as incoming (isUnreadForDivider), matching the
  // channel divider and the notify path's isAutomation handling.
  const unreadDividerIndex = $derived.by(() => {
    const rootId = threadState.parentId;
    if (!rootId) return -1;
    const cursor = threadsState.getPerThreadLastViewed(rootId);
    if (cursor == null) return -1;
    const me = authState.user?.id;
    if (!me) return -1;
    return threadState.replies.findIndex((r) => isUnreadForDivider(r, cursor, me));
  });

  // P4a mobile header subtitle: the channel this thread lives in, resolved from
  // the parent message's channelId. Purely presentational — null on DM threads
  // (parent.channelId is null there), in which case no subtitle renders.
  const threadChannelName = $derived.by(() => {
    const cid = threadState.parent?.channelId;
    if (!cid) return null;
    return workspaceState.channels.find((c) => c.id === cid)?.name ?? null;
  });

  // Typing names for the in-thread indicator, excluding self (server + handler
  // already filter, but guard here too).
  const threadTypingNames = $derived(
    threadState.typing
      .filter((t) => t.fromId !== authState.user?.id)
      .map(typingAuthorName),
  );

  // Jump to the root message in the channel timeline: flash it (MessageList
  // watches messageFocusState) and close the thread panel.
  function jumpToRoot(): void {
    const id = threadState.parentId;
    if (!id) return;
    messageFocusState.focus(id);
    closeThread();
  }

  // Resizable width (Mattermost RHS-style), clamped + persisted. Drag the left
  // edge; dragging left widens.
  const MIN_W = 320,
    MAX_W = 720;
  function loadWidth(): number {
    try {
      const v = Number(localStorage.getItem("cyborg7_thread_width"));
      if (v) return Math.min(MAX_W, Math.max(MIN_W, v));
    } catch {
      // intentional: best-effort read of persisted panel width; falls back to default.
    }
    return 420;
  }
  let width = $state(loadWidth());
  function startResize(e: PointerEvent): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      width = Math.min(MAX_W, Math.max(MIN_W, startW + (startX - ev.clientX)));
    };
    const onUp = () => {
      try {
        localStorage.setItem("cyborg7_thread_width", String(width));
      } catch {
        // intentional: best-effort persistence of panel width; not user-facing.
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // ─── Scroll management (mirrors MessageList / DM page, reuses chatScroll) ───
  // The thread was a "dumb list" with zero scroll management, so long threads
  // lost open-to-latest + keep-at-bottom. We bind the existing replies scroll
  // div and run the SAME caveats the channel/DM surfaces use: open-to-latest
  // (multi-pass pin), keep-at-bottom-unless-scrolled-up, own-message-always,
  // iOS keyboard preserve, and the "N new replies" jump toast. Threads load all
  // replies at once (no thread pagination), so there is intentionally NO
  // load-older / prepend-anchor here.
  let scrollContainer = $state<HTMLDivElement>();
  let wasAtBottom = $state(true);

  // Mattermost's BUFFER_TO_BE_CONSIDERED_BOTTOM = 100 — same constant MessageList
  // and the DM page use, so the three surfaces can't drift on "near the bottom".
  const AT_BOTTOM_BUFFER = 100;

  function handleScroll(): void {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    wasAtBottom = scrollHeight - scrollTop - clientHeight < AT_BOTTOM_BUFFER;
  }

  // ─── "N new replies" jump toast (full MessageList/DM parity) ───
  // Counter is LOCAL: incremented when a GENUINELY new (prevLen/prevTailId)
  // not-own, non-system tail reply arrives while the user is scrolled up
  // (!wasAtBottom). Reset once the user reaches the bottom or dismisses
  // (Esc / "x"). Reactions/edits to existing replies don't change the tail id,
  // so they don't trigger the toast or an autoscroll.
  let newCount = $state(0);
  let dismissed = $state(false);
  let prevTailId: string | undefined = $state();
  let prevLen = $state(0);

  // Reset all per-thread scroll bookkeeping when the open thread changes, so a
  // new thread starts pinned at the bottom with a clean toast counter.
  let lastOpenRootId = $state<string | null>(null);

  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track thread switch
    threadState.parentId;
    // Reset wasAtBottom too: a new thread opens pinned to the bottom, so without
    // this a thread you'd scrolled UP in carries !wasAtBottom into the next
    // thread and flashes a spurious "N new replies" pill before the open-effect
    // pins to the bottom.
    wasAtBottom = true;
    newCount = 0;
    dismissed = false;
    prevLen = 0;
    prevTailId = undefined;
  });

  // Detect a genuinely new tail reply (not a reaction/edit) and either bump the
  // toast (scrolled up, not own) or — for the user's OWN reply — force a scroll
  // to the bottom even when they were scrolled up (they just sent it).
  let ownReplyNonce = $state(0);
  $effect(() => {
    const replies = threadState.replies;
    const len = replies.length;
    const tail = replies[len - 1];
    const tailId = tail?.id;
    if (len > prevLen && tailId && tailId !== prevTailId) {
      const myId = authState.user?.id;
      if (tail.fromId === myId) {
        // Own message always scrolls to bottom, even if scrolled up.
        ownReplyNonce += 1;
      } else if (!wasAtBottom && tail.fromType !== "system") {
        newCount += 1;
        dismissed = false;
      }
    }
    prevLen = len;
    prevTailId = tailId;
  });

  $effect(() => {
    if (wasAtBottom) {
      newCount = 0;
      dismissed = false;
    }
  });

  const showNewMessagesToast = $derived(newCount > 0 && !wasAtBottom && !dismissed);

  function jumpToNewMessages(): void {
    if (!scrollContainer) return;
    const divider = scrollContainer.querySelector<HTMLElement>("[data-unread-divider]");
    if (divider) {
      divider.scrollIntoView({ block: "center", behavior: "smooth" });
    } else {
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
    }
    newCount = 0;
    dismissed = false;
  }

  // Esc dismisses the "N new replies" toast (Mattermost parity).
  $effect(() => {
    if (!showNewMessagesToast) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismissed = true;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Open-to-latest + keep-at-bottom. Keyed by the open thread's root id (track
  // replies so this re-runs as they arrive). On a FRESH open, multi-pass pin to
  // the bottom (async layout — avatars/markdown decoding after first paint —
  // can't strand us above the latest reply). On subsequent reply changes, only
  // bottom-anchor when the user was already at the bottom, so a scrolled-up user
  // reading older replies is NOT yanked down. Own replies are handled by the
  // ownReplyNonce effect below (always scroll). Mirrors MessageList's lastOpenKey.
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track reactive dependency for auto-scroll
    threadState.replies;
    const key = threadState.parentId ?? null;
    if (!scrollContainer) return;
    if (key !== lastOpenRootId) {
      // Fresh open of this thread. Don't scroll until replies have loaded.
      if (threadState.replies.length === 0) return;
      lastOpenRootId = key;
      // ALWAYS open to latest. The "New replies" divider renders inline — scroll
      // UP from the bottom to reach it. Multi-pass pin so async layout can't
      // strand us at the TOP. Single rAF lost this race on iOS.
      pinToBottom(scrollContainer);
      return;
    }
    if (wasAtBottom) {
      requestAnimationFrame(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
    }
  });

  // Own-message always scrolls to bottom — even when the user was scrolled up
  // (they just sent the reply). Keyed off ownReplyNonce (bumped only for a
  // genuinely new OWN tail reply), so it can't fire on reactions/edits or on
  // someone else's reply. Separate from the keep-at-bottom effect so it doesn't
  // get gated by wasAtBottom.
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- re-run on own reply
    ownReplyNonce;
    if (ownReplyNonce === 0) return;
    if (!scrollContainer) return;
    requestAnimationFrame(() => {
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      }
    });
  });

  // iOS keyboard scroll preservation — keep the latest reply above the software
  // keyboard. The thread has its own MessageInput composer, so this matters here
  // too. Shared with MessageList / the DM page via lib/mobile/chatScroll so the
  // surfaces can't drift. No-op off the iOS shell.
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    return installIosKeyboardScrollPreserve(el);
  });
</script>

{#if threadState.parentId}
  <aside
    transition:fly={{ x: viewportState.isMobile ? 0 : width, y: viewportState.isMobile ? 24 : 0, duration: 200, easing: cubicOut }}
    class={viewportState.isMobile
      ? "fixed inset-x-0 top-0 z-[var(--z-sheet)] flex flex-col"
      : "absolute right-0 top-0 z-30 flex h-full flex-col border-l border-edge shadow-[-10px_0_30px_-12px_rgba(0,0,0,0.35)]"}
    style={viewportState.isMobile
      ? keyboardOpen
        ? "height: var(--app-vh, 100dvh); background-color: var(--bg-base); padding-top: env(safe-area-inset-top); padding-bottom: var(--sab);"
        : "height: calc(var(--app-vh, 100dvh) - 56px - var(--sab)); background-color: var(--bg-base); padding-top: env(safe-area-inset-top);"
      : `width: ${width}px; background-color: var(--bg-base);`}
  >
    <!-- Resize handle (desktop only — mobile is a full-screen sheet) -->
    {#if !viewportState.isMobile}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="absolute left-0 top-0 z-40 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-link/40"
        onpointerdown={startResize}
      ></div>
    {/if}
    <!-- P4a mobile header: 17px semibold title + 13px muted channel name below;
         close is a chevron-down (sheet dismiss affordance, 44pt via
         touch-target). Desktop keeps the 15px title + X. Same closeThread
         wiring on both. -->
    <PanelHeader title="Thread" onClose={closeThread} closeLabel="Close thread">
      {#snippet subtitle()}
        {#if viewportState.isMobile && threadChannelName}
          <span class="truncate text-[13px] text-content-muted">#{threadChannelName}</span>
        {/if}
      {/snippet}
    </PanelHeader>

    <div
      bind:this={scrollContainer}
      onscroll={handleScroll}
      class="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2"
    >
      {#if showNewMessagesToast}
        <NewMessagesToast
          count={newCount}
          noun="reply"
          onJump={jumpToNewMessages}
          onDismiss={() => (dismissed = true)}
        />
      {/if}
      {#if threadState.parent}
        <ChatMessage message={threadState.parent} hideThread showHoverToolbar={false} />
        <!-- Jump-to-root link (matches v1 thread-reply routing to the parent). -->
        <button
          type="button"
          onclick={jumpToRoot}
          class="mt-1 inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-link hover:underline focus-ring"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17L17 7"/><path d="M7 7h10v10"/></svg>
          View in channel
        </button>
      {/if}

      <div class="my-2 flex items-center gap-2 text-[11px] font-medium text-content-muted">
        <span>{threadState.replies.length} {threadState.replies.length === 1 ? "reply" : "replies"}</span>
        <span class="h-px flex-1 bg-edge"></span>
      </div>

      {#if threadState.loading}
        <div class="py-2 text-[12px] text-content-muted">Loading replies…</div>
      {/if}

      {#each threadState.replies as reply, i (reply.id)}
        {@const prev = i > 0 ? threadState.replies[i - 1] : null}
        {#if i === unreadDividerIndex}
          <UnreadDivider />
        {/if}
        {#if prev && !isSameDay(prev.createdAt, reply.createdAt)}
          <div class="mt-2 mb-1 flex select-none items-center gap-2">
            <span class="text-[11px] font-semibold text-content-muted">{formatDate(reply.createdAt)}</span>
            <span class="h-px flex-1 bg-edge"></span>
          </div>
        {/if}
        <div class="group/threadreply relative">
          <ChatMessage message={reply} hideThread onReaction={toggleReaction} />
          <!-- Mark-unread affordance (#7): rewinds the read cursor to this reply,
               so the "New replies" line reappears above it on the next open. -->
          {#if threadState.parentId}
            <button
              type="button"
              onclick={() => markThreadUnread(threadState.parentId!, reply.createdAt)}
              class="absolute right-2 top-1 z-10 hidden rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-[10px] font-medium text-content-dim shadow-sm hover:text-content group-hover/threadreply:block"
              title="Mark unread from here"
            >
              Mark unread
            </button>
          {/if}
        </div>
      {/each}
    </div>

    {#if threadTypingNames.length > 0}
      <div class="shrink-0">
        <TypingIndicator names={threadTypingNames} verb="typing" />
      </div>
    {/if}

    <div class="shrink-0">
      <MessageInput
        placeholder="Reply…"
        onSend={sendThreadReply}
        alwaysEnabled
        draftKey={threadState.parentId ? `thread:${threadState.parentId}` : undefined}
        typingParentId={threadState.parentId ?? undefined}
      />
    </div>
  </aside>
{/if}
<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { authState, workspaceState, dmState, selectDm, sendDmMessage, retrySendDmMessage, loadMoreDmMessages, userStatusState, toggleReaction, editMessage, deleteMessage, messageFocusState, closeThread, presenceState } from "$lib/state/app.svelte.js";
  import Avatar from "$lib/components/Avatar.svelte";
  import ChatMessage from "$lib/components/message/ChatMessage.svelte";
  import { isGroupedWith, isNewDay } from "$lib/components/message/grouping.js";
  import UnreadDivider from "$lib/components/message/UnreadDivider.svelte";
  import MessageInput from "$lib/components/message/MessageInput.svelte";
  import TypingIndicator from "$lib/components/message/TypingIndicator.svelte";
  import ThreadPanel from "$lib/components/message/ThreadPanel.svelte";
  import NewMessagesToast from "$lib/components/message/NewMessagesToast.svelte";
  import ProfilePanel from "$lib/components/ProfilePanel.svelte";
  import { profilePanelState } from "$lib/profile-panel.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { goBackFromConversation } from "$lib/mobile/swipeBack";
  import {
    pinToBottom,
    withPrependAnchor,
    installIosKeyboardScrollPreserve,
  } from "$lib/mobile/chatScroll.js";
  import type { Attachment } from "$lib/core/types.js";
  import { formatDate } from "$lib/utils.js";

  const peerId = $derived(page.params.userId);
  const myId = $derived(authState.user?.id);
  const isSelf = $derived(peerId === myId);

  const peer = $derived(
    workspaceState.members.find((m) => m.userId === peerId),
  );
  const peerName = $derived(
    peer?.name ?? peer?.email?.split("@")[0] ?? "User",
  );
  const displayName = $derived(isSelf ? `${peerName} (you)` : peerName);

  // Peer presence for the DM header. Active = online & not manually away;
  // everything else (manual away OR offline/app-closed) collapses to one grey
  // "Away" state — matching ChannelSidebar's two-state treatment. Self: no dot.
  const peerActive = $derived(
    !isSelf && !!peerId && presenceState.isOnline(peerId) && !presenceState.isAway(peerId),
  );
  const peerStatus = $derived(isSelf ? null : peerActive ? "online" : "away");
  const peerStatusLabel = $derived(peerActive ? "Active" : "Away");

  const messages = $derived(dmState.messages);

  // Item 12: cursor-based "New messages" divider (replicated from MessageList,
  // since the DM view renders ChatMessage directly). Frozen `lastReadAt` (ms) is
  // captured at DM-open in selectDm. Divider sits above the first message the
  // peer sent after the cursor; own messages excluded; suppressed at index 0 when
  // older history is unloaded. Self-DMs never match (no peer-authored messages).
  const unreadDividerIndex = $derived.by(() => {
    const cursor = dmState.unreadCursor;
    if (cursor == null || messages.length === 0) return -1;
    const currentUserId = myId;
    if (!currentUserId) return -1;
    const idx = messages.findIndex((m) => m.fromId !== currentUserId && m.createdAt > cursor);
    if (idx < 0) return -1;
    if (idx === 0 && dmState.hasMore) return -1;
    return idx;
  });

  let scrollContainer: HTMLDivElement | undefined = $state();
  let wasAtBottom = $state(true);

  // ─── "N new messages" jump toast (Slack/Mattermost parity) ───
  // Mirrors MessageList's local counter: increment on a new not-own tail
  // message that arrives while scrolled up; reset on reaching bottom / dismiss.
  let newCount = $state(0);
  let dismissed = $state(false);
  let prevTailId: string | undefined = $state();
  let prevLen = $state(0);

  $effect(() => {
    const len = messages.length;
    const tail = messages[len - 1];
    const tailId = tail?.id;
    if (len > prevLen && tailId && tailId !== prevTailId) {
      if (!wasAtBottom && tail.fromId !== myId && tail.fromType !== "system") {
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

  // Reset the counter when switching to a different DM peer.
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track peer change
    peerId;
    newCount = 0;
    dismissed = false;
    prevLen = 0;
    prevTailId = undefined;
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

  $effect(() => {
    if (!showNewMessagesToast) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismissed = true;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  $effect(() => {
    // Depend on peerId AND the active workspace: on a fresh login the DM page can
    // mount before the workspace finishes restoring, so re-run selectDm once it's
    // set (else the first call bails and the DM stays empty). untrack the body so
    // the effect does NOT transitively track the reactive state selectDm writes
    // (messages/unreadCursor/…) — that re-froze the unread cursor each re-run and
    // hid the "New messages" divider. Mirrors the channel page fix.
    const ws = workspaceState.current?.id;
    if (peerId && ws) {
      untrack(() => {
        closeThread();
        profilePanelState.close();
        selectDm(peerId);
      });
    }
  });

  // Item 12: on a fresh DM open, scroll the unread divider near the top instead
  // of jumping to the bottom; otherwise (no divider / later messages) keep
  // bottom-scroll. Runs once per open, keyed by peerId.
  let lastOpenPeer = $state<string | null>(null);

  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- auto-scroll
    messages;
    const key = peerId ?? null;
    if (!scrollContainer) return;
    if (key !== lastOpenPeer) {
      if (messages.length === 0) return;
      lastOpenPeer = key;
      // v1 parity (commit 8c8010a7): ALWAYS open to latest. The "New messages"
      // divider renders inline — scroll UP from the bottom to reach it. Do NOT
      // scrollIntoView the divider on open (that stranded the user at the oldest
      // message). Deep-link to a specific message is handled by the messageFocus
      // effect, not here. Multi-pass pin so avatars/images decoding after first
      // paint can't strand us above the latest msg.
      // Skip pinToBottom when a jump-to-message is pending — the focus effect will
      // scroll to the target; pinning to the bottom first would override it and
      // then the +300ms pass would scroll away from the target message.
      if (!messageFocusState.id) pinToBottom(scrollContainer);
      return;
    }
    if (wasAtBottom) {
      requestAnimationFrame(() => {
        scrollContainer!.scrollTop = scrollContainer!.scrollHeight;
      });
    }
  });

  // Scroll-to + flash a focused message — used by the Profile panel's Shared
  // Files "jump" action. Mirrors MessageList's focus effect (the DM view
  // renders ChatMessage directly, so it needs its own handler). Retries
  // briefly because the target may still be loading when focus is requested.
  //
  // H2: if the element is not yet in the DOM the message may be older than the
  // loaded window (DMs load the latest 50). When that happens we page backwards
  // (bounded by FOCUS_MAX_PAGES × 50 messages) using the existing
  // loadMoreDmMessages path — the same withPrependAnchor-safe loader the
  // scroll-up pagination uses — until the element appears or we exhaust pages.
  // On bound-hit we land in the conversation (graceful) without spinning forever.
  const FOCUS_MAX_PAGES = 5; // bounded: at most 5 extra pages (250 older messages)
  const FOCUS_POLL_TRIES = 8; // retries per page-load (8 × 150ms = 1.2s grace)
  $effect(() => {
    const fid = messageFocusState.id;
    // oxlint-disable-next-line eslint/no-unused-expressions -- re-trigger on repeat focus
    messageFocusState.nonce;
    if (!fid) return;
    let tries = 0;
    let pagesLoaded = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const tryScroll = (): void => {
      const el = scrollContainer?.querySelector<HTMLElement>(`[data-msg-id="${fid}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("msg-flash");
        timeoutId = setTimeout(() => el.classList.remove("msg-flash"), 2200);
        messageFocusState.clear();
        return;
      }
      // Element not yet in the DOM.
      if (tries++ < FOCUS_POLL_TRIES) {
        // Poll: the message may still be rendering (e.g. fresh navigation fetch
        // just resolved). Use a short retry before escalating to pagination.
        timeoutId = setTimeout(tryScroll, 150);
        return;
      }
      // Exhausted fast-poll retries. Try loading an older page if there is one.
      if (pagesLoaded < FOCUS_MAX_PAGES && dmState.hasMore && !dmState.loading) {
        pagesLoaded += 1;
        tries = 0; // reset fast-poll for the new page
        // withPrependAnchor so prepending history doesn't jump the scroll
        // position — same path used by manual scroll-up pagination.
        withPrependAnchor(scrollContainer, loadMoreDmMessages);
        // Give the page time to load and render before retrying.
        timeoutId = setTimeout(tryScroll, 400);
        return;
      }
      // Bound hit (no more pages, or max pages reached): land gracefully in the
      // conversation at the current position. Don't loop further.
      messageFocusState.clear();
    };
    const rafId = requestAnimationFrame(tryScroll);
    // Stop the retry/flash loop if the user switches DMs before it settles.
    return () => { cancelAnimationFrame(rafId); clearTimeout(timeoutId); };
  });

  // iOS keyboard scroll preservation (v1 parity) — keep the latest message above
  // the software keyboard. Shared with the channel MessageList via
  // lib/mobile/chatScroll. This was MISSING on the DM surface, so the keyboard
  // covered the latest message instead of the list scrolling up. No-op off iOS.
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    return installIosKeyboardScrollPreserve(el);
  });

  function handleScroll(): void {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    // Mattermost BUFFER_TO_BE_CONSIDERED_BOTTOM = 100.
    wasAtBottom = scrollHeight - scrollTop - clientHeight < 100;

    if (scrollTop < 100 && dmState.hasMore && !dmState.loading) {
      // Anchor the prepend so loading older history doesn't jump/reposition the
      // user — same shared helper the channel MessageList uses.
      withPrependAnchor(scrollContainer, loadMoreDmMessages);
    }
  }

  function handleSend(text: string, _mentions?: string[], attachments?: Attachment[]): void {
    sendDmMessage(text, attachments);
  }

  function isGrouped(idx: number): boolean {
    return idx > 0 && isGroupedWith(messages[idx - 1], messages[idx]);
  }

  function shouldShowDate(idx: number): boolean {
    return idx === 0 || isNewDay(messages[idx - 1], messages[idx]);
  }

  function getStatusEmoji(userId: string): string | null {
    if (userId === myId) return userStatusState.emoji;
    return null;
  }

  function getStatusTooltip(userId: string): string | null {
    if (userId === myId) return userStatusState.tooltip || null;
    return null;
  }

  function openPeerProfile(): void {
    if (peerId) profilePanelState.open("human", peerId);
  }
</script>

<!-- P4a: dropped the redundant font-lato class — body already sets
     font-family: var(--font-lato) globally (and the iOS shell overrides both
     to the system stack), so this is a no-op visually; per-component
     font-family classes are banned by the redesign trap list (#6). -->
<div class="relative flex h-full flex-col overflow-hidden">
  <header class="flex items-center gap-3 border-b border-edge px-6 py-2.5 shrink-0">
    {#if viewportState.isMobile}
      <button type="button" onclick={goBackFromConversation} class="p-1.5 -ml-1.5 rounded-lg active:bg-raised shrink-0" aria-label="Back">
        <svg class="w-5 h-5 text-content-dim" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
      </button>
    {/if}
    <button type="button" class="cursor-pointer border-0 bg-transparent p-0" onclick={openPeerProfile} aria-label="View profile">
      <Avatar name={peerName} width={28} borderRadius={6} fontSize={12} fontWeight={700} image={peerId ? authState.getMemberImage(peerId) : null} status={peerStatus} />
    </button>
    <div class="min-w-0 flex flex-col leading-tight">
      <button type="button" class="cursor-pointer border-0 bg-transparent p-0 text-[15px] font-bold text-content hover:underline text-left" onclick={openPeerProfile}>
        {displayName}
      </button>
      {#if isSelf}
        <span class="text-[12px] text-content-muted">This is your space</span>
      {:else}
        <span class="text-[12px] {peerActive ? 'text-online' : 'text-content-muted'}">{peerStatusLabel}</span>
      {/if}
    </div>
  </header>

  <div
    bind:this={scrollContainer}
    onscroll={handleScroll}
    class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
  >
    {#if showNewMessagesToast}
      <NewMessagesToast
        count={newCount}
        onJump={jumpToNewMessages}
        onDismiss={() => (dismissed = true)}
      />
    {/if}
    <!-- P4a: gutters mirror the channel MessageList exactly (px-4 mobile /
         px-5 desktop, py-2) — channels = DMs visual parity. -->
    <div class={viewportState.isMobile ? "px-4 py-2" : "px-5 py-2"}>
      {#if dmState.loading && messages.length === 0}
        <!-- P4a: initial-load skeleton — IDENTICAL markup to MessageList's
             (channels = DMs parity; keep in sync). Same true-initial-load flag
             as the old spinner. -->
        <div class="py-2" aria-hidden="true">
          {#each [0, 1, 2, 3, 4, 5] as i (i)}
            <div class="mb-[22px] flex items-start gap-3" style="--stagger-delay: {i * 100}ms">
              <div class="skeleton h-[36px] w-[36px] shrink-0" style="border-radius: 50%;"></div>
              <div class="min-w-0 flex-1 pt-[2px]">
                <div class="skeleton h-[12px] w-[112px]"></div>
                <div class="skeleton mt-[8px] h-[12px]" style="width: {72 - i * 9}%;"></div>
              </div>
            </div>
          {/each}
        </div>
      {:else if messages.length === 0}
        <div class="flex flex-col items-center justify-center py-20 text-center">
          <Avatar name={peerName} width={72} borderRadius={16} fontSize={28} fontWeight={700} image={peerId ? authState.getMemberImage(peerId) : null} />
          <h2 class="mt-4 text-[18px] font-bold text-content">{displayName}</h2>
          {#if isSelf}
            <p class="mt-1 text-[14px] text-content-muted max-w-[360px]">
              This is your space. Draft messages, list your to-dos, or keep links and files handy.
            </p>
          {:else}
            <p class="mt-1 text-[14px] text-content-muted">
              This is the beginning of your direct message history with <strong class="text-content">{peerName}</strong>.
            </p>
            <button
              type="button"
              onclick={openPeerProfile}
              class="mt-4 cursor-pointer rounded-lg border border-edge px-3 py-1.5 text-[13px] font-medium text-content transition-colors hover:bg-raised"
            >
              View profile
            </button>
          {/if}
        </div>
      {:else}
        {#if dmState.hasMore}
          <div class="py-2 text-center">
            <button
              onclick={() => withPrependAnchor(scrollContainer, loadMoreDmMessages)}
              class="text-xs text-link hover:underline"
              disabled={dmState.loading}
            >
              {dmState.loading ? "Loading..." : "Load older messages"}
            </button>
          </div>
        {/if}
        {#each messages as msg, idx (msg.id)}
          {#if shouldShowDate(idx)}
            <!-- ponytail: DM divider omits the channel's jump-to-date menu; add if DMs need it.
                 Otherwise identical to MessageList's centered pill (bg-surface-alt/text-content-muted). -->
            <div class="my-4 flex select-none items-center justify-center">
              <span
                class="rounded-full bg-surface-alt px-3 py-1 text-[13px] font-medium text-content-muted shadow-sm"
              >
                {formatDate(msg.createdAt)}
              </span>
            </div>
          {/if}
          {#if idx === unreadDividerIndex}
            <UnreadDivider />
          {/if}
          <ChatMessage
            message={msg}
            grouped={isGrouped(idx) && idx !== unreadDividerIndex}
            statusEmoji={getStatusEmoji(msg.fromId)}
            statusTooltip={getStatusTooltip(msg.fromId)}
            onReaction={toggleReaction}
            onEdit={editMessage}
            onDelete={deleteMessage}
            onRetry={retrySendDmMessage}
          />
        {/each}
      {/if}
    </div>
  </div>

  <TypingIndicator names={dmState.typing.map((t) => t.fromName ?? "Someone")} verb="typing" />

  <MessageInput
    placeholder={isSelf ? "Jot something down" : `Message ${peerName}`}
    onSend={handleSend}
    alwaysEnabled
  />

  <ThreadPanel />

  {#if profilePanelState.target}
    {#if viewportState.isMobile}
      <ProfilePanel overlay />
    {:else}
      <div class="absolute right-0 top-0 z-30 h-full">
        <ProfilePanel />
      </div>
    {/if}
  {/if}
</div>

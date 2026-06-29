<script lang="ts">
  import type { Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import type { Message } from "$lib/types.js";
  import {
    authState,
    channelState,
    workspaceState,
    messageFocusState,
  } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/plugins/agents/state.svelte.js";
  import { loadMoreMessages } from "$lib/state/app.svelte.js";
  import { formatDate, isSameDay } from "$lib/utils.js";
  import ChatMessage from "./ChatMessage.svelte";
  import SystemMessage from "./SystemMessage.svelte";
  import MessageActionSheet from "./MessageActionSheet.svelte";
  import UnreadDivider from "./UnreadDivider.svelte";
  import TypingIndicator from "./TypingIndicator.svelte";
  import { typingAuthorName } from "./message-author.js";
  import { slashProgress } from "$lib/state/slash-progress.svelte.js";
  import { shouldClearSlashProgress } from "$lib/last-persisted-message.js";
  import { isUnreadForDivider } from "$lib/unread-divider.js";
  import NewMessagesToast from "./NewMessagesToast.svelte";
  import PullToRefresh from "../PullToRefresh.svelte";
  import { refreshActiveConversation } from "$lib/state/app.svelte.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { clickOutside } from "$lib/actions/clickOutside.js";
  import {
    pinToBottom,
    withPrependAnchor,
    installIosKeyboardScrollPreserve,
  } from "$lib/mobile/chatScroll.js";
  import { isTauriIOS } from "$lib/mobile/push";

  let {
    messages,
    loading = false,
    hasMore = false,
    typing,
    typingVerb = "typing",
    onLoadMore,
    groupingWindowMs = 300_000,
    timestampMode = "hover",
    showAvatars = true,
    showRoleBadges = true,
    getStatusEmoji,
    getStatusTooltip,
    messageActions,
    onReaction,
    onEdit,
    onDelete,
    onMentionClick,
    onChannelClick,
    emptyState,
    unreadCursor,
    onCatchup,
    readOnly = false,
    composerHeight,
    class: className = "",
  }: {
    messages?: Message[];
    loading?: boolean;
    hasMore?: boolean;
    typing?: { fromName?: string }[];
    // "typing" for channels/humans; "thinking" for agent 1:1 contexts (v1 parity).
    typingVerb?: "typing" | "thinking";
    onLoadMore?: () => void;
    groupingWindowMs?: number;
    timestampMode?: "hover" | "always" | "inline";
    showAvatars?: boolean;
    showRoleBadges?: boolean;
    getStatusEmoji?: (userId: string) => string | null;
    getStatusTooltip?: (userId: string) => string | null;
    messageActions?: Snippet;
    onReaction?: (messageId: string, emoji: string) => void;
    onEdit?: (messageId: string, newText: string) => void;
    onDelete?: (messageId: string) => void;
    // MESSAGE-RENDER P0: overrides for @mention / #channel clicks in message
    // bodies. When omitted, sensible defaults navigate to the member's DM /
    // agent page (mention) or the matching channel (channel mention).
    onMentionClick?: (name: string) => void;
    onChannelClick?: (name: string) => void;
    emptyState?: Snippet;
    // Item 12: frozen `lastReadAt` (ms) for the "New messages" divider. When
    // omitted, falls back to channelState.unreadCursor (the channel case).
    unreadCursor?: number | null;
    // When provided, the unread divider shows a "Summarize new messages" button
    // (/catchup, #597). Omitted in contexts without a catch-up (e.g. DMs).
    onCatchup?: () => void;
    // Channel preview: strip every write affordance (hover toolbar, reaction
    // pills, reply-in-thread, mobile long-press sheet) so a non-member viewing a
    // public channel read-only can't trigger an action that requires membership.
    readOnly?: boolean;
    // iOS-only: the live native composer height (lib/mobile/MessageInput exports it
    // as a bindable, floor 60). When it grows (keyboard opens → native format bar
    // expands) the bottom spacer grows in a LATER frame than the visualViewport
    // shrink, leaving the last message below the fold. Tracking it lets us re-pin to
    // bottom on that frame. Undefined off iOS / on desktop — the re-pin effect
    // early-returns there.
    composerHeight?: number;
    class?: string;
  } = $props();

  const resolvedMessages = $derived(messages ?? channelState.messages);
  const resolvedLoading = $derived(loading || channelState.loading);
  const resolvedHasMore = $derived(hasMore || channelState.hasMore);
  const resolvedTyping = $derived(typing ?? channelState.typing);

  // ─── Mobile long-press action sheet (V1 MessageBubble parity) ───
  // A ChatMessage row long-pressed on mobile opens this sheet; it reuses the
  // SAME handlers as the desktop hover toolbar (onReaction / onDelete, plus
  // openThread + pinMessage internally). Edit dispatches into the pressed row's
  // inline editor via an id + nonce bridge (ChatMessage owns the editor state).
  let actionSheetMessage = $state<Message | null>(null);
  let actionSheetOpen = $state(false);
  let editRequestId = $state<string | null>(null);
  let editRequestNonce = $state(0);

  function openActionSheet(id: string): void {
    const msg = resolvedMessages.find((m) => m.id === id);
    if (!msg) return;
    actionSheetMessage = msg;
    actionSheetOpen = true;
  }

  function requestInlineEdit(id: string): void {
    editRequestId = id;
    editRequestNonce += 1;
  }

  // (F) Slash-command "generating" indicator — only in the channel view (no
  // `messages` prop override), keyed by the active channel. Cleared as soon as
  // the reply (a non-human message newer than the dispatch) lands; a timeout in
  // slashProgress is the backstop.
  const slashProgressEntry = $derived(
    messages === undefined ? slashProgress.get(channelState.activeId) : undefined,
  );
  $effect(() => {
    const cid = channelState.activeId;
    const entry = slashProgressEntry;
    if (!cid || !entry) return;
    // Clear once a NEW non-human PERSISTED message (a different last id than at
    // dispatch) lands — the reply. Local seq:0 ephemera (slash warn notes, #210
    // alerts) sort pinned-last and are ignored, so a note can't mask the reply.
    if (shouldClearSlashProgress(resolvedMessages, entry.lastMessageId)) {
      slashProgress.clear(cid);
    }
  });

  let scrollContainer: HTMLDivElement | undefined = $state();
  let wasAtBottom = $state(true);

  // ─── "N new messages" jump toast (Slack/Mattermost ToastWrapper) ───
  // Counter is LOCAL: incremented when a new not-own tail message arrives while
  // the user is scrolled up (!wasAtBottom). Reset to 0 once the user reaches the
  // bottom or dismisses (Esc / "x"). Tracked here rather than in app.svelte.ts
  // so the incoming-message handlers stay untouched.
  let newCount = $state(0);
  let dismissed = $state(false);
  let prevTailId: string | undefined = $state();
  let prevLen = $state(0);

  $effect(() => {
    const msgs = resolvedMessages;
    const len = msgs.length;
    const tail = msgs[len - 1];
    const tailId = tail?.id;
    if (len > prevLen && tailId && tailId !== prevTailId) {
      const myId = authState.user?.id;
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

  function isGrouped(index: number): boolean {
    if (index === 0) return false;
    const prev = resolvedMessages[index - 1];
    const curr = resolvedMessages[index];
    if (prev.fromId !== curr.fromId) return false;
    if (prev.fromType !== curr.fromType) return false;
    return curr.createdAt - prev.createdAt < groupingWindowMs;
  }

  function shouldShowDate(index: number): boolean {
    if (index === 0) return true;
    const prev = resolvedMessages[index - 1];
    const curr = resolvedMessages[index];
    return !isSameDay(prev.createdAt, curr.createdAt);
  }

  // ─── Item 12: cursor-based unread divider ───
  // The divider freezes from a `lastReadAt` timestamp captured at conversation-
  // open (channelState.unreadCursor, or the `unreadCursor` prop for DMs). The
  // "New messages" line renders above the FIRST loaded message (ascending) that
  // the peer sent after that cursor. Own messages are excluded (the server cursor
  // excludes my sends) — EXCEPT webhook/CI cards, which carry the creator's user
  // id yet aren't the user's own typing, so they still trip the divider
  // (isUnreadForDivider, mirroring the notify path's isAutomation fix). Returns
  // -1 when there is no divider.
  const resolvedUnreadCursor = $derived(
    unreadCursor !== undefined ? unreadCursor : channelState.unreadCursor,
  );
  const unreadDividerIndex = $derived.by(() => {
    const cursor = resolvedUnreadCursor;
    if (cursor == null || resolvedMessages.length === 0) return -1;
    const myId = authState.user?.id;
    if (!myId) return -1;
    const idx = resolvedMessages.findIndex((m) => isUnreadForDivider(m, cursor, myId));
    if (idx < 0) return -1;
    // First unread is at the very top of the loaded window AND older history is
    // unloaded — the true boundary may be above, so suppress (don't show a wrong
    // line). If we've loaded the start of history, index 0 is the real boundary.
    if (idx === 0 && resolvedHasMore) return -1;
    return idx;
  });

  function defaultMentionClick(name: string): void {
    const wsId = workspaceState.current?.id;
    if (!wsId) return;
    const lower = name.toLowerCase();
    const cybo = cyboState.list.find((c) => c.name.toLowerCase() === lower);
    if (cybo) {
      goto(`/workspace/${wsId}/agent/${cybo.id}`);
      return;
    }
    const member = workspaceState.members.find(
      (m) => (m.name ?? m.email.split("@")[0]).toLowerCase() === lower,
    );
    if (member) goto(`/workspace/${wsId}/dm/${member.userId}`);
  }

  function defaultChannelClick(name: string): void {
    const wsId = workspaceState.current?.id;
    if (!wsId) return;
    const channel = workspaceState.channels.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (channel) goto(`/workspace/${wsId}/channel/${channel.id}`);
  }

  const resolvedMentionClick = $derived(onMentionClick ?? defaultMentionClick);
  const resolvedChannelClick = $derived(onChannelClick ?? defaultChannelClick);

  // CTA on the "no slash daemon configured" system alert → workspace AI settings.
  function goToAiSettings(): void {
    const wsId = workspaceState.current?.id;
    if (wsId) goto(`/workspace/${wsId}/settings/ai`);
  }

  // Mattermost's BUFFER_TO_BE_CONSIDERED_BOTTOM = 100 (post_list_virtualized).
  const AT_BOTTOM_BUFFER = 100;

  // Pagination-prepend scroll anchor. Prepending older history grows scrollHeight
  // above the viewport, which (without compensation) jumps the read position. We
  // snapshot scrollHeight BEFORE the fetch/prepend and, after the new messages
  // render, push scrollTop down by the height delta so the message the user was
  // looking at stays put. Deterministic + side-effect-only: it reads/writes
  // scrollContainer directly (no reactive state), so it can't fight the
  // bottom-anchor autoscroll (which only fires when wasAtBottom) or the
  // focusin/out scroll-preserve, and can't create an effect loop.
  function triggerLoadMore(): void {
    // Shared prepend-anchor (lib/mobile/chatScroll) — snapshot scrollHeight,
    // load older history, restore scroll so the user's message stays put. Same
    // helper the DM page uses, so the two surfaces can't drift.
    withPrependAnchor(scrollContainer, onLoadMore ?? loadMoreMessages);
  }

  function handleScroll(): void {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    wasAtBottom = scrollHeight - scrollTop - clientHeight < AT_BOTTOM_BUFFER;

    if (scrollTop < 100 && resolvedHasMore && !resolvedLoading) {
      triggerLoadMore();
    }
  }

  // Esc dismisses the "N new messages" toast (Mattermost parity).
  $effect(() => {
    if (!showNewMessagesToast) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismissed = true;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  // Item 12: on a fresh open, if there's an unread divider scroll IT near the
  // top of the viewport (Slack shows the line with a little context above)
  // instead of jumping to the bottom. Runs ONCE per conversation-open, keyed by
  // the active conversation id, so later incoming messages still bottom-scroll.
  let lastOpenKey = $state<string | null>(null);
  const openKey = $derived(channelState.activeId ?? null);

  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track reactive dependency for auto-scroll
    resolvedMessages;
    const key = openKey;
    if (!scrollContainer) return;
    if (key !== lastOpenKey) {
      // Fresh open of this conversation. Don't scroll until messages have loaded.
      if (resolvedMessages.length === 0) return;
      lastOpenKey = key;
      // v1 parity (commit 8c8010a7): ALWAYS open to latest. The "New messages"
      // divider renders inline — scroll UP from the bottom to reach it. Do NOT
      // scrollIntoView the divider on open (that stranded the user at the oldest
      // message). Deep-link to a specific message is handled by the messageFocus
      // effect, not here. Multi-pass pin so async layout (avatars/images/markdown
      // decoding after first paint) can't strand us at the TOP showing the
      // oldest messages. Single rAF lost this race on iOS.
      // Skip pinToBottom when a jump-to-message is pending — the focus effect will
      // scroll to the target; pinning to the bottom first would override it and
      // then the +300ms pass would scroll away from the target message.
      if (!messageFocusState.id) pinToBottom(scrollContainer);
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

  // iOS: re-pin to bottom when the native composer height changes. The bottom
  // spacer is sized to the native composer height, which grows (60 → ~100) when
  // the keyboard opens and the native format bar expands — and it grows in a
  // LATER frame than the visualViewport shrink the bottom-anchor autoscroll /
  // chatScroll compensate for. That later growth pushes the last message below the
  // fold with no scroll range. Tracking composerHeight here and re-pinning on the
  // next frame closes that gap. Only when the user was at/near bottom (don't yank
  // someone reading history). Off iOS / desktop this early-returns — no effect.
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track composer height
    composerHeight;
    if (!isTauriIOS()) return;
    if (!scrollContainer || !wasAtBottom) return;
    requestAnimationFrame(() => {
      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  });

  // iOS keyboard scroll preservation (v1 parity) — keep the latest message above
  // the software keyboard. Shared with the DM page via lib/mobile/chatScroll so
  // the two surfaces can't drift. No-op off the iOS shell.
  $effect(() => {
    const el = scrollContainer;
    if (!el) return;
    return installIosKeyboardScrollPreserve(el);
  });

  // Scroll-to + flash a focused message (e.g. opening a thread from the global
  // Threads view jumps the channel to its root). Retries briefly because the
  // target may still be loading when the focus is requested.
  //
  // H2: if the element is not yet in the DOM the message may be older than the
  // loaded window (channels load the latest 50). When that happens we page
  // backwards (bounded by FOCUS_MAX_PAGES × 50 messages) using the existing
  // onLoadMore / loadMoreMessages path — the same withPrependAnchor-safe loader
  // the scroll-up pagination uses — until the element appears or we exhaust
  // pages. On bound-hit we land in the conversation (graceful) without spinning.
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
      if (pagesLoaded < FOCUS_MAX_PAGES && resolvedHasMore && !resolvedLoading) {
        pagesLoaded += 1;
        tries = 0; // reset fast-poll for the new page
        // withPrependAnchor so prepending history doesn't jump the scroll
        // position — same path used by manual scroll-up pagination.
        withPrependAnchor(scrollContainer, onLoadMore ?? loadMoreMessages);
        // Give the page time to load and render before retrying.
        timeoutId = setTimeout(tryScroll, 400);
        return;
      }
      // Bound hit (no more pages, or max pages reached): land gracefully in the
      // conversation at the current position. Don't loop further.
      messageFocusState.clear();
    };
    const rafId = requestAnimationFrame(tryScroll);
    // Stop the retry/flash loop if the user switches channels before it settles.
    return () => { cancelAnimationFrame(rafId); clearTimeout(timeoutId); };
  });

  const typingNames = $derived(resolvedTyping.map(typingAuthorName));

  // ─── Jump-to-date dropdown on the date divider (v1 DateDivider.tsx) ───
  type DateJumpTarget = "recent" | "last_week" | "last_month" | "beginning";
  const jumpOptions: { label: string; target: DateJumpTarget }[] = [
    { label: "Most recent", target: "recent" },
    { label: "Last week", target: "last_week" },
    { label: "Last month", target: "last_month" },
    { label: "The very beginning", target: "beginning" },
  ];
  // Which divider's menu is open (keyed by message id), and where it sits.
  let openDividerId = $state<string | null>(null);

  function toggleDivider(id: string): void {
    openDividerId = openDividerId === id ? null : id;
  }

  // Jump within the currently loaded messages. The rewrite has no fetch-by-date
  // endpoint, so this scrolls to the nearest loaded message for the target
  // (degrades gracefully without a backend).
  function jumpTo(target: DateJumpTarget): void {
    openDividerId = null;
    if (!scrollContainer) return;
    if (target === "recent") {
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      return;
    }
    if (target === "beginning") {
      scrollContainer.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const now = Date.now();
    const cutoff = target === "last_week" ? now - 7 * 86_400_000 : now - 30 * 86_400_000;
    const msg = resolvedMessages.find((m) => m.createdAt >= cutoff);
    if (msg) {
      const el = scrollContainer.querySelector<HTMLElement>(`[data-msg-id="${msg.id}"]`);
      el?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }

  // Outside-click / Esc close for the date-jump menu is the shared `clickOutside`
  // action (#510), applied to the messages wrapper below. It uses `mousedown`
  // (not click) and `boundary: "[data-date-divider]"` so a press anywhere that
  // ISN'T inside a date divider closes the open menu — identical to the previous
  // hand-rolled `document.addEventListener("mousedown" / "keydown")` listeners.
</script>

<PullToRefresh
  bind:scrollEl={scrollContainer}
  onscroll={handleScroll}
  scrollClass={className || "min-h-0 flex-1 overflow-y-auto"}
  onRefresh={refreshActiveConversation}
>
  {#if showNewMessagesToast}
    <NewMessagesToast
      count={newCount}
      onJump={jumpToNewMessages}
      onDismiss={() => (dismissed = true)}
    />
  {/if}
  {#if resolvedLoading && resolvedMessages.length === 0}
    <!-- P4a: initial-load skeleton (6 placeholder rows: avatar circle + name/body
         bars) instead of bare text. Same true-initial-load flag as before.
         KEEP IN SYNC with the DM page's skeleton (channels = DMs parity). -->
    <div class={viewportState.isMobile ? "px-4 py-4" : "px-5 py-4"} aria-hidden="true">
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
  {:else if resolvedMessages.length === 0}
    {#if emptyState}
      {@render emptyState()}
    {:else}
      <div class="flex items-center justify-center h-full text-content-muted text-sm">
        No messages yet. Start the conversation.
      </div>
    {/if}
  {:else}
    {#if resolvedHasMore}
      <div class="py-2 text-center">
        <button
          onclick={triggerLoadMore}
          class="text-xs text-link hover:underline"
          disabled={resolvedLoading}
        >
          {resolvedLoading ? "Loading..." : "Load older messages"}
        </button>
      </div>
    {/if}

    <div
      class={viewportState.isMobile ? "px-4 py-2" : "px-5 py-2"}
      use:clickOutside={{
        enabled: openDividerId !== null,
        eventType: "mousedown",
        boundary: "[data-date-divider]",
        onClose: () => { openDividerId = null; },
      }}
    >
      {#each resolvedMessages as message, i (message.id)}
        {#if shouldShowDate(i)}
          <!-- P4a: centered floating date pill (no full-width lines). The
               jump-to-date dropdown below is wired exactly as before
               (toggleDivider + data-date-divider outside-click close). -->
          <div class="my-4 flex select-none items-center justify-center" data-date-divider>
            <div class="relative">
              <button
                type="button"
                onclick={() => toggleDivider(message.id)}
                class="flex cursor-pointer items-center gap-1 rounded-full bg-surface-alt px-3 py-1 text-[13px] font-medium text-content-muted shadow-sm transition-colors"
              >
                {formatDate(message.createdAt)}
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class={openDividerId === message.id ? "rotate-180 transition-transform" : "transition-transform"}>
                  <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              {#if openDividerId === message.id}
                <div
                  class="absolute left-1/2 z-[var(--z-dropdown)] mt-1 w-[160px] -translate-x-1/2 rounded-lg py-1"
                  style="background-color: var(--dropdown-bg); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"
                >
                  {#each jumpOptions as opt (opt.target)}
                    <button
                      type="button"
                      onclick={() => jumpTo(opt.target)}
                      class="w-full cursor-pointer px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-[var(--dropdown-hover)]"
                      style="color: var(--dropdown-name);"
                    >
                      {opt.label}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {/if}
        {#if i === unreadDividerIndex}
          <UnreadDivider {onCatchup} />
        {/if}
        {#if message.fromType === "system"}
          <SystemMessage {message} onAiSettings={goToAiSettings} />
        {:else}
          <ChatMessage
            {message}
            grouped={isGrouped(i) && i !== unreadDividerIndex && !shouldShowDate(i)}
            showAvatar={showAvatars}
            showRoleBadge={showRoleBadges}
            showHoverToolbar={!readOnly}
            {readOnly}
            hideThread={readOnly}
            statusEmoji={getStatusEmoji?.(message.fromId) ?? null}
            statusTooltip={getStatusTooltip?.(message.fromId) ?? null}
            {timestampMode}
            hoverActions={messageActions}
            {onReaction}
            {onEdit}
            {onDelete}
            onLongPress={readOnly ? undefined : openActionSheet}
            {editRequestId}
            {editRequestNonce}
            onMentionClick={resolvedMentionClick}
            onChannelClick={resolvedChannelClick}
          />
        {/if}
      {/each}
    </div>
  {/if}

  {#if typingNames.length > 0}
    <TypingIndicator names={typingNames} verb={typingVerb} />
  {/if}

  {#if slashProgressEntry}
    <!-- (F) Slash command is generating its reply. -->
    <TypingIndicator text={slashProgressEntry.label} />
  {/if}
</PullToRefresh>

<!-- MOBILE long-press action sheet. Mirrors the desktop hover toolbar's action
     set, reusing the same handlers. Edit routes back into the pressed row's
     inline editor; Delete calls onDelete (the page-level confirm dialog). -->
<MessageActionSheet
  bind:open={actionSheetOpen}
  message={actionSheetMessage}
  {onReaction}
  {onDelete}
  onEditRequest={onEdit ? requestInlineEdit : undefined}
  hideThread={false}
/>

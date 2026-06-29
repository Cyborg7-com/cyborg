<script lang="ts">
  import type { Snippet } from "svelte";
  import { agentStreamState, client } from "$lib/state/app.svelte.js";
  import type { StreamEntry } from "$lib/state/app.svelte.js";
  import { loadOlderAgentTimeline } from "$lib/plugins/agents/state.svelte.js";
  import ToolCallDetail from "./ToolCallDetail.svelte";
  import TurnErrorRemedy from "./TurnErrorRemedy.svelte";
  import TypingIndicator from "$lib/components/message/TypingIndicator.svelte";
  import MessageRenderer from "$lib/components/message/MessageRenderer.svelte";
  import Avatar from "$lib/components/Avatar.svelte";
  import ProviderIcon from "./ProviderIcon.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import ConfirmDialog from "$lib/components/ConfirmDialog.svelte";
  import { cn } from "$lib/utils.js";
  import { viewportState } from "$lib/state/viewport.svelte.js";
  import { profilePanelState } from "$lib/profile-panel.svelte.js";

  // Clicking an agent's avatar/name on a turn opens the slide-in Profile panel
  // (parity with human message avatars in ChatMessage). The panel is mounted by
  // the agent conversation page; here we just set the shared target.
  function openAgentProfile(): void {
    if (agentId) profilePanelState.open("agent", agentId);
  }

  let {
    agentId,
    agentName = "Agent",
    provider,
    providerLabel,
    daemonLabel,
    onRecheck,
    userName = "You",
    agentImage,
    agentEmoji,
    userImage,
    userStatusEmoji,
    userStatusTooltip,
    showThinkingContent = true,
    avatarWidth = 36,
    avatarFontSize = 14,
    isCybo = false,
    onRewind,
    isRewinding = false,
    emptyState,
    class: className = "",
  }: {
    agentId: string;
    agentName?: string;
    provider?: string;
    // Display label + daemon label + re-probe callback for the classified
    // turn-error remedy (TurnErrorRemedy). Optional — absent ones degrade to the
    // provider id / a generic daemon label / a no-op re-check.
    providerLabel?: string;
    daemonLabel?: string;
    onRecheck?: () => void;
    userName?: string;
    agentImage?: string | null;
    // Single-emoji cybo avatar (rendered as text, not an <img>).
    agentEmoji?: string | null;
    userImage?: string | null;
    userStatusEmoji?: string | null;
    userStatusTooltip?: string | null;
    showThinkingContent?: boolean;
    avatarWidth?: number;
    avatarFontSize?: number;
    isCybo?: boolean;
    // 'Rewind to here' (#649): invoked with the timeline user-message id when the
    // user confirms rolling this session back to before that turn. Absent → no
    // rewind affordance is shown (e.g. a read-only viewer surface).
    onRewind?: (messageId: string) => void;
    // True while a rewind is already in flight (the wrapper's in-flight guard).
    // Disables every per-row Rewind button so a second destructive rewind can't
    // be fired before the first resolves — alongside the existing mid-turn gate.
    isRewinding?: boolean;
    emptyState?: Snippet;
    class?: string;
  } = $props();

  let scrollContainer: HTMLDivElement | undefined = $state();
  let wasAtBottom = $state(true);
  // Toggle stores keyed by STABLE entry id (thinking) / callId (tools) — never the
  // array index, so expand/collapse state stays pinned to its entry while the
  // stream grows and the live text entry mutates in place.
  let expandedThinking: Set<string> = $state(new Set());
  let expandedTools: Set<string> = $state(new Set());

  // 'Rewind to here' (#649): the timeline messageId awaiting confirmation, or null
  // when the confirm dialog is closed. Rewind drops every turn after this one, so
  // it's gated behind a destructive confirm.
  let rewindConfirmMessageId: string | null = $state(null);

  function confirmRewind(): void {
    const messageId = rewindConfirmMessageId;
    rewindConfirmMessageId = null;
    if (messageId) onRewind?.(messageId);
  }

  // This component is reused (not remounted) when the route's agentId param
  // changes, so reset the per-stream local UI state on switch — otherwise stale
  // toggle ids accumulate and the scroll anchor (wasAtBottom) carries over to the
  // next agent. (Entry ids are globally unique, so a leftover id never matches
  // another agent's entry, but clearing on switch is the correct hygiene.)
  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track agentId to reset on switch
    agentId;
    expandedThinking = new Set();
    expandedTools = new Set();
    rewindConfirmMessageId = null;
    wasAtBottom = true;
  });

  const entries = $derived(agentStreamState.getEntries(agentId));
  const turnStatus = $derived(agentStreamState.getTurnStatus(agentId));
  const hasOlder = $derived(agentStreamState.hasOlder(agentId));
  const loadingOlder = $derived(agentStreamState.isLoadingOlder(agentId));

  // Scroll-up lazy-load of older history. When the user nears the top and older
  // entries remain, fetch + PREPEND them — then pin the viewport so it doesn't jump
  // (older content is inserted ABOVE the current scroll, growing scrollHeight).
  async function maybeLoadOlder(): Promise<void> {
    if (!scrollContainer || !hasOlder || loadingOlder) return;
    if (scrollContainer.scrollTop > 160) return;
    const prevHeight = scrollContainer.scrollHeight;
    const prevTop = scrollContainer.scrollTop;
    // Capture the agent this fetch is for: the component is REUSED (not remounted)
    // across agent switches, so if the user switches mid-flight the same
    // scrollContainer now shows a different agent. Re-pinning its scroll with this
    // agent's height delta would desync the other agent's view — bail instead.
    const forAgent = agentId;
    await loadOlderAgentTimeline(client, agentId);
    requestAnimationFrame(() => {
      if (!scrollContainer || agentId !== forAgent) return;
      scrollContainer.scrollTop = prevTop + (scrollContainer.scrollHeight - prevHeight);
    });
  }

  function handleScroll(): void {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    wasAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    void maybeLoadOlder();
  }

  $effect(() => {
    // oxlint-disable-next-line eslint/no-unused-expressions -- track entries changes for auto-scroll
    entries;
    if (wasAtBottom && scrollContainer) {
      const rafId = requestAnimationFrame(() => {
        // Re-check at rAF time, don't trust the decision made when the effect ran.
        // During rapid streaming a delta schedules this rAF while we were at the
        // bottom; if the user scrolls up in the gap before it fires, an
        // UNCONDITIONAL scroll yanks them back down (and the programmatic scroll
        // re-arms wasAtBottom=true via handleScroll), making it impossible to read
        // history — every delta re-yanks. Honoring the live wasAtBottom here stops
        // the yank the instant the user has scrolled away from the bottom.
        if (wasAtBottom && scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      });
      // Cancel a pending frame when the effect re-runs (next delta) or the
      // component unmounts, so rapid streaming coalesces to a single scroll per
      // frame instead of stacking redundant rAFs (layout thrash).
      return () => cancelAnimationFrame(rafId);
    }
  });

  function toggleThinking(id: string) {
    const next = new Set(expandedThinking);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expandedThinking = next;
  }

  function toggleTool(callId: string) {
    const next = new Set(expandedTools);
    if (next.has(callId)) next.delete(callId);
    else next.add(callId);
    expandedTools = next;
  }

  function toolStatusDot(status: string): string {
    if (status === "running") return "bg-online animate-pulse";
    if (status === "failed") return "bg-error";
    if (status === "canceled") return "bg-warning";
    return "bg-online";
  }

  function toolLabel(entry: StreamEntry & { kind: "tool_call" }): string {
    if (!entry.detail) return entry.name;
    switch (entry.detail.type) {
      case "shell":
        return entry.detail.command.length > 60
          ? entry.detail.command.slice(0, 60) + "..."
          : entry.detail.command;
      case "read":
        return entry.detail.filePath;
      case "edit":
        return entry.detail.filePath;
      case "write":
        return entry.detail.filePath;
      case "search":
        return entry.detail.query;
      case "fetch":
        return entry.detail.url;
      default:
        return entry.name;
    }
  }

  function isGroupedWithPrev(idx: number): boolean {
    if (idx === 0) return false;
    const curr = entries[idx];
    const prev = entries[idx - 1];
    if (curr.kind === "text" && prev.kind === "text") return true;
    if (curr.kind === "user_message" && prev.kind === "user_message") return true;
    return false;
  }

  // Tool-type glyph for the mobile tool cards (compound path data, stroked).
  // Keyed by the existing ToolCallDetail discriminant; falls back to a wrench.
  function toolIconPath(entry: StreamEntry & { kind: "tool_call" }): string {
    switch (entry.detail?.type) {
      case "shell":
        return "M4 17l6-6-6-6 M12 19h8";
      case "read":
        return "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6";
      case "edit":
        return "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z";
      case "write":
        return "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M12 18v-6 M9 15h6";
      case "search":
        return "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M21 21l-4.3-4.3";
      case "fetch":
        return "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M2 12h20 M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z";
      default:
        return "M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z";
    }
  }
</script>

<div
  bind:this={scrollContainer}
  onscroll={handleScroll}
  class={cn("flex-1 overflow-y-auto font-lato", className)}
>
  <div class={viewportState.isMobile ? "px-4 py-4" : "px-5 py-4"}>
    {#if loadingOlder}
      <div class="flex items-center justify-center gap-2 py-3 text-[12px] text-content-muted" aria-live="polite">
        <span
          class="h-3.5 w-3.5 animate-spin rounded-full border-2 border-content/25"
          style="border-top-color: var(--accent, #5BB5F0);"
        ></span>
        Loading earlier messages…
      </div>
    {:else if hasOlder && entries.length > 0}
      <div class="flex items-center justify-center py-2 text-[11px] text-content-muted/70">
        Scroll up for earlier messages
      </div>
    {/if}

    {#if entries.length === 0}
      {#if emptyState}
        {@render emptyState()}
      {:else}
        <div class="flex items-center justify-center py-20 text-sm text-content-muted">
          {#if turnStatus === "running"}
            <TypingIndicator names={[agentName]} verb="thinking" />
          {:else}
            <p>Send a prompt to get started</p>
          {/if}
        </div>
      {/if}
    {/if}

    {#each entries as entry, idx (entry.id)}
      {#if entry.kind === "user_message"}
        {@const grouped = isGroupedWithPrev(idx)}
        {#if viewportState.isMobile}
          <!-- Mobile (redesign): MY messages are RIGHT-aligned accent bubbles —
               solid accent fill + white text, 18px radius, 16px. This is the
               primary signal that differentiates the human's turns from the
               agent's left-aligned plain prose (the boss's "we're not
               differentiating my msgs from the bot" fix). Accent + white reads in
               BOTH themes (--color-accent = --c7-accent indigo, light & dark).
               max-w caps the bubble so a short prompt doesn't stretch full width;
               ml-auto pushes it to the trailing edge. Visual only. -->
          <div class={cn("flex justify-end", grouped ? "mt-1.5" : "mt-4")}>
            <div class="ml-auto min-w-0 max-w-[82%] rounded-[18px] bg-accent px-4 py-2.5 text-[16px] leading-[24px] text-accent-foreground">
              <MessageRenderer text={entry.content} />
            </div>
          </div>
        {:else}
        <div
          class={cn(
            "group relative flex gap-3 px-5 -mx-5 rounded hover:bg-surface-alt transition-colors py-0.5",
            grouped ? "" : "mt-2",
          )}
        >
          {#if grouped}
            <div class="shrink-0 flex items-start justify-center pt-0.5" style:width="{avatarWidth}px"></div>
          {:else}
            <div class="shrink-0 mt-0.5">
              <Avatar name={userName} width={avatarWidth} fontSize={avatarFontSize} image={userImage} />
            </div>
          {/if}
          <div class="flex-1 min-w-0">
            {#if !grouped}
              <div class="flex items-baseline gap-2">
                <span class="font-[900] text-white text-[15px]">{userName}</span>
                {#if userStatusEmoji}
                  <span class="text-[13px] leading-none cursor-default" title={userStatusTooltip || userStatusEmoji}>{userStatusEmoji}</span>
                {/if}
              </div>
            {/if}
            <div class="text-[15px] mt-0.5">
              <MessageRenderer text={entry.content} />
            </div>
          </div>
          <!-- 'Rewind to here' (#649): roll the session back to before this turn.
               Only when a rewind handler is wired AND the server gave this turn a
               timeline messageId (optimistic echoes have none yet). Hidden until
               row hover; disabled mid-turn (rewinding a live run would race it)
               AND while another rewind is already in flight (isRewinding) — a
               second destructive rewind must not fire before the first resolves. -->
          {#if onRewind && entry.messageId}
            {@const canRewind = turnStatus !== "running" && !isRewinding}
            <button
              type="button"
              disabled={!canRewind}
              onclick={() => { if (canRewind) rewindConfirmMessageId = entry.messageId ?? null; }}
              title={isRewinding
                ? "Rewinding…"
                : canRewind
                  ? "Rewind to here"
                  : "Can't rewind while the agent is running"}
              aria-label="Rewind to here"
              class={cn(
                "absolute right-3 top-1 z-10 hidden items-center gap-1 rounded border border-edge bg-surface-alt px-1.5 py-0.5 text-[11px] font-medium text-content-dim shadow-sm transition-colors group-hover:flex",
                canRewind ? "hover:text-content" : "cursor-not-allowed opacity-50",
              )}
            >
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              Rewind
            </button>
          {/if}
        </div>
        {/if}

      {:else if entry.kind === "text"}
        {@const grouped = isGroupedWithPrev(idx)}
        {#if viewportState.isMobile}
          <!-- Mobile (redesign): agent output is LEFT-aligned plain prose, 16px
               — the deliberate contrast to MY right-aligned accent bubbles. Once
               per turn (the first text block, !grouped) we show the agent avatar +
               name as a quiet label so a turn reads as "the agent is speaking"
               without wrapping the prose in a bubble (Claude-app pattern). Grouped
               continuation text aligns under the same left gutter. Visual only. -->
          {#if !grouped}
            <button
              type="button"
              class="mt-4 flex w-fit cursor-pointer items-center gap-2 rounded border-0 bg-transparent p-0 text-left transition-opacity hover:opacity-80"
              onclick={openAgentProfile}
              aria-label={`View ${agentName} profile`}
            >
              {#if agentImage}
                <Avatar name={agentName} width={22} fontSize={10} image={agentImage} />
              {:else if agentEmoji}
                <div class="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-surface-alt text-[13px] leading-none" aria-hidden="true">{agentEmoji}</div>
              {:else if isCybo}
                <Avatar name={agentName} width={22} fontSize={10} />
              {:else if provider}
                <div class="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-surface-alt">
                  <ProviderIcon {provider} size={13} class="text-content" />
                </div>
              {:else}
                <Avatar name={agentName} width={22} fontSize={10} />
              {/if}
              <span class="min-w-0 truncate text-[13px] font-semibold text-content-dim">{agentName}</span>
            </button>
          {/if}
          <div class={cn("text-[16px] leading-[24px] text-content", grouped ? "mt-2" : "mt-1.5")}>
            <MessageRenderer text={entry.content} />
          </div>
        {:else}
        <div
          class={cn(
            "group relative flex gap-3 px-5 -mx-5 rounded hover:bg-surface-alt transition-colors py-0.5",
            grouped ? "" : "mt-2",
          )}
        >
          {#if grouped}
            <div class="shrink-0 flex items-start justify-center pt-0.5" style:width="{avatarWidth}px"></div>
          {:else}
            <button
              type="button"
              class="mt-0.5 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0 transition-opacity hover:opacity-80"
              onclick={openAgentProfile}
              aria-label={`View ${agentName} profile`}
            >
              {#if agentImage}
                <Avatar name={agentName} width={avatarWidth} fontSize={avatarFontSize} image={agentImage} />
              {:else if agentEmoji}
                <div class="flex items-center justify-center rounded-md bg-surface-alt" style:width="{avatarWidth}px" style:height="{avatarWidth}px" style:font-size="{Math.round(avatarWidth * 0.55)}px">
                  <span aria-hidden="true">{agentEmoji}</span>
                </div>
              {:else if isCybo}
                <!-- Placeholder identity is the CYBO's (its name → initials),
                     never the Cyborg logo / generic bot (ghost-chat fix). -->
                <Avatar name={agentName} width={avatarWidth} fontSize={avatarFontSize} />
              {:else if provider}
                <div class="flex items-center justify-center rounded-md bg-surface-alt" style:width="{avatarWidth}px" style:height="{avatarWidth}px">
                  <ProviderIcon {provider} size={Math.round(avatarWidth * 0.55)} class="text-content" />
                </div>
              {:else}
                <Avatar name={agentName} width={avatarWidth} fontSize={avatarFontSize} />
              {/if}
            </button>
          {/if}
          <div class="flex-1 min-w-0">
            {#if !grouped}
              <div class="flex items-baseline gap-2">
                <span class="font-[900] text-white text-[15px]">{agentName}</span>
                <span class="role-badge">Agent</span>
              </div>
            {/if}
            <div class="text-[15px] mt-0.5">
              <MessageRenderer text={entry.content} />
            </div>
          </div>
        </div>
        {/if}

      {:else if entry.kind === "thinking"}
        {#if viewportState.isMobile}
          <!-- Mobile: collapsible italic muted block. Same stable-id toggle. -->
          <div class="mt-1">
            <button
              onclick={() => toggleThinking(entry.id)}
              class="-my-1 flex min-h-[44px] items-center gap-1.5 text-[13px] italic text-content-muted"
              aria-expanded={expandedThinking.has(entry.id)}
            >
              <svg
                class={cn("h-3.5 w-3.5 shrink-0 transition-transform", expandedThinking.has(entry.id) && "rotate-90")}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
              ><path d="M9 18l6-6-6-6"/></svg>
              Thinking
            </button>
            {#if showThinkingContent && expandedThinking.has(entry.id)}
              <div class="mb-1 ml-[6px] whitespace-pre-wrap border-l-2 border-edge pl-3 text-[14px] italic leading-[21px] text-content-muted">{entry.content}</div>
            {/if}
          </div>
        {:else}
        <div class="thinking-block border-l-2 border-content-muted/30 pl-3 py-1 my-1 ml-12">
          <button
            onclick={() => toggleThinking(entry.id)}
            class="flex items-center gap-1.5 text-xs text-content-dim hover:text-content-muted transition-colors"
          >
            <span class="font-mono text-content-muted/60 text-[10px]">~</span>
            <span class="text-[11px] italic">thinking</span>
            {#if showThinkingContent}
              <span class="text-[10px] text-content-muted">{expandedThinking.has(entry.id) ? "[-]" : "[+]"}</span>
            {/if}
          </button>
          {#if showThinkingContent && expandedThinking.has(entry.id)}
            <pre class="whitespace-pre-wrap text-xs text-content-dim font-mono leading-relaxed mt-2 opacity-70">{entry.content}</pre>
          {/if}
        </div>
        {/if}

      {:else if entry.kind === "tool_call"}
        {#if viewportState.isMobile}
          <!-- Mobile: collapsed tool card — type glyph · name · status dot ·
               args · disclosure. Same callId-keyed toggle. -->
          {@const label = toolLabel(entry)}
          <div class="mt-2">
            <div class="overflow-hidden rounded-[12px] bg-surface-alt">
              <button
                onclick={() => toggleTool(entry.callId)}
                class="flex min-h-[44px] w-full items-center gap-2.5 px-3.5 py-2 text-left"
                aria-expanded={expandedTools.has(entry.callId)}
              >
                <svg class="h-[15px] w-[15px] shrink-0 text-content-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d={toolIconPath(entry)} />
                </svg>
                <span class="shrink-0 text-[15px] font-semibold leading-[20px] text-content">{entry.name}</span>
                <span class={cn("h-[7px] w-[7px] shrink-0 rounded-full", toolStatusDot(entry.status))}></span>
                {#if label !== entry.name}
                  <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-content-muted">{label}</span>
                {:else}
                  <span class="min-w-0 flex-1"></span>
                {/if}
                {#if entry.status === "failed"}
                  <span class="shrink-0 text-[12px] font-medium text-error">failed</span>
                {:else if entry.status === "canceled"}
                  <span class="shrink-0 text-[12px] text-warning">canceled</span>
                {/if}
                {#if entry.detail}
                  <svg
                    class={cn("h-3.5 w-3.5 shrink-0 text-content-muted transition-transform", expandedTools.has(entry.callId) && "rotate-90")}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
                  ><path d="M9 18l6-6-6-6"/></svg>
                {/if}
              </button>
              {#if expandedTools.has(entry.callId) && entry.detail}
                <div class="px-3.5 pb-3">
                  <ToolCallDetail detail={entry.detail} error={entry.error} />
                </div>
              {/if}
            </div>
          </div>
        {:else}
        <div class="py-0.5 ml-12">
          <button
            onclick={() => toggleTool(entry.callId)}
            class="flex items-center gap-2 text-xs font-mono text-content-muted hover:text-content transition-colors w-full text-left"
          >
            <span class={cn("h-1.5 w-1.5 rounded-full shrink-0", toolStatusDot(entry.status))}></span>
            <span class="text-content-dim">{entry.name}</span>
            <span class="truncate flex-1 text-content-muted">{toolLabel(entry)}</span>
            {#if entry.status === "running"}
              <span class="text-content-dim">(running)</span>
            {:else if entry.status === "failed"}
              <span class="text-error">(failed)</span>
            {/if}
            {#if entry.detail}
              <span class="text-[10px] text-content-muted shrink-0">{expandedTools.has(entry.callId) ? "[-]" : "[+]"}</span>
            {/if}
          </button>
          {#if expandedTools.has(entry.callId) && entry.detail}
            <div class="mt-1 ml-4 border-l border-edge pl-3">
              <ToolCallDetail detail={entry.detail} error={entry.error} />
            </div>
          {/if}
        </div>
        {/if}

      {:else if entry.kind === "error"}
        <!-- A classified turn-time provider failure (usage-gate / auth / expired /
             rate-limit) renders the SAME polished remedy as the spawn path; an
             unclassified error falls back to the plain block inside the component. -->
        <TurnErrorRemedy
          content={entry.content}
          code={"code" in entry ? entry.code : undefined}
          reasonKind={"reasonKind" in entry ? entry.reasonKind : null}
          unavailableReason={"unavailableReason" in entry ? entry.unavailableReason : null}
          provider={("provider" in entry ? entry.provider : undefined) ?? provider}
          providerLabel={providerLabel ?? provider}
          {daemonLabel}
          {onRecheck}
        />

      {:else if entry.kind === "todo"}
        <div class={cn(
          "bg-surface-alt px-4 py-3",
          viewportState.isMobile ? "mt-2 rounded-[12px]" : "rounded-md border border-edge ml-12",
        )}>
          <div class={cn(
            "font-semibold text-content-muted mb-2 uppercase",
            viewportState.isMobile ? "text-[11px] tracking-[0.06em]" : "text-xs tracking-wider",
          )}>Todo</div>
          {#each entry.items as item}
            <div class={cn("flex items-start gap-2 text-content py-0.5", viewportState.isMobile ? "text-[15px] leading-[21px]" : "text-sm")}>
              <span class="font-mono text-content-muted shrink-0">{item.completed ? "[x]" : "[ ]"}</span>
              <span class={cn(item.completed && "line-through text-content-dim")}>{item.text}</span>
            </div>
          {/each}
        </div>

      {:else if entry.kind === "compaction"}
        <div class="flex items-center gap-2 py-2">
          <div class="flex-1 border-t border-edge/50"></div>
          <span class="text-[10px] text-content-muted">
            {entry.status === "loading" ? "Compressing context..." : "Context compressed"}
          </span>
          <div class="flex-1 border-t border-edge/50"></div>
        </div>

      {:else if entry.kind === "turn_boundary"}
        {#if viewportState.isMobile}
          <!-- Mobile (redesign): a subtle 11px CENTERED label between faint rules
               — marks a new exchange without the "stray hairline / empty-bubble"
               look the boss flagged (the old bare border-t read as a stray line
               wedged between two gray bubbles). Visual only. -->
          <div class="flex items-center gap-3 py-4">
            <div class="flex-1 border-t border-edge/30"></div>
            <span class="shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-content-muted">New turn</span>
            <div class="flex-1 border-t border-edge/30"></div>
          </div>
        {:else}
        <div class="flex items-center gap-2 py-3">
          <div class="flex-1 border-t border-edge/30"></div>
        </div>
        {/if}
      {/if}
    {/each}

    {#if turnStatus === "running" && entries.length > 0}
      <div class="py-2">
        <TypingIndicator names={[agentName]} verb="thinking" size="sm" />
      </div>
    {/if}
  </div>
</div>

<!-- 'Rewind to here' confirmation (#649). Destructive — rewinding discards every
     turn after the selected one and resets the provider session to that point. -->
<ConfirmDialog
  open={rewindConfirmMessageId !== null}
  title="Rewind to here?"
  message={`This rolls ${isCybo ? agentName : "the session"} back to before this turn — everything after it is discarded.`}
  confirmLabel="Rewind"
  cancelLabel="Cancel"
  destructive
  onconfirm={confirmRewind}
  oncancel={() => (rewindConfirmMessageId = null)}
/>

<script lang="ts">
  import { goto } from "$app/navigation";
  import { portal } from "$lib/actions/portal.js";
  import { workspaceState, searchMessages } from "$lib/state/app.svelte.js";
  import { getInitials, nameToColor, formatMessageTimestamp } from "$lib/utils.js";
  import { Avatar, AvatarImage, AvatarFallback } from "$lib/components/ui/avatar/index.js";
  import type { Message } from "$lib/core/types.js";
  import ChannelGlyph from "./channel/ChannelGlyph.svelte";

  // Bound from the layout via MobileTopBar — closing sets this to false which
  // removes the overlay from the DOM (toggled in MobileTopBar's parent).
  let { onclose }: { onclose: () => void } = $props();

  let query = $state("");
  let loading = $state(false);
  let results = $state<Message[]>([]);
  let inputEl = $state<HTMLInputElement | null>(null);
  let seq = 0;

  const wsId = $derived(workspaceState.current?.id ?? null);
  const channelName = $derived(
    new Map(workspaceState.channels.map((c) => [c.id, c.name])),
  );

  // Build a member image map for the 36px avatar on each result row.
  const memberImage = $derived(
    new Map(
      workspaceState.members.map((m) => [
        m.userId,
        (m as { imageUrl?: string | null }).imageUrl ?? (m as { image?: string | null }).image ?? null,
      ]),
    ),
  );

  async function run(): Promise<void> {
    const q = query.trim();
    if (q.length < 2) {
      results = [];
      loading = false;
      return;
    }
    const mine = ++seq;
    loading = true;
    try {
      const r = await searchMessages(q);
      if (mine !== seq) return;
      results = r;
    } catch {
      if (mine !== seq) return;
      results = [];
    } finally {
      if (mine === seq) loading = false;
    }
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;

  // Clear any pending debounce when the overlay is destroyed.
  $effect(() => () => { if (debounce) clearTimeout(debounce); });

  function onInput(): void {
    if (debounce) clearTimeout(debounce);
    if (query.trim().length < 2) {
      results = [];
      loading = false;
      return;
    }
    loading = true; // show skeletons immediately while debouncing
    debounce = setTimeout(() => void run(), 250);
  }

  function pick(m: Message): void {
    if (!wsId || !m.channelId) return;
    // Preserve exact same navigation as the desktop MessageSearch.pick():
    // navigate to the channel that owns this message. The channel's message
    // list will load/scroll to the message once the route settles.
    query = "";
    results = [];
    onclose();
    goto(`/workspace/${wsId}/channel/${m.channelId}`);
  }

  function clearQuery(): void {
    query = "";
    results = [];
    loading = false;
    inputEl?.focus();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      onclose();
    }
  }

  // Auto-focus the input when the overlay mounts.
  $effect(() => {
    if (inputEl) {
      // rAF defers until after the CSS transition starts, which prevents the
      // keyboard from glitching on older iOS WebKit versions.
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  // Split text into [before, match, after] around the first case-insensitive hit
  // so the matched run can be wrapped in a highlight <mark>.
  function highlightParts(text: string, q: string): [string, string, string] {
    if (!q || q.length < 2) return [text, "", ""];
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return [text, "", ""];
    return [text.slice(0, idx), text.slice(idx, idx + q.length), text.slice(idx + q.length)];
  }


  // Idle: show when there is no query and we have not started searching.
  const isIdle = $derived(query.trim().length < 2 && !loading);
  // Empty: query is long enough, not loading, and results came back empty.
  const isEmpty = $derived(query.trim().length >= 2 && !loading && results.length === 0);
  // Show skeletons while a search is in flight.
  const isLoading = $derived(loading && query.trim().length >= 2);
</script>

<!--
  Full-screen search overlay — mobile only. Absolutely positioned so it sits
  above the entire workspace shell (including MobileTopBar, main, MobileNav)
  without disturbing the flex column or the app-vh / keyboard machinery.
  z-[var(--z-sheet)] matches other full-screen mobile surfaces (ThreadPanel, PinnedPanel,
  MessageActionSheet). The material-sheet provides the iOS blur backdrop.
-->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  use:portal
  role="dialog"
  aria-modal="true"
  aria-label="Search messages"
  tabindex="-1"
  class="fixed inset-0 z-[var(--z-sheet)] flex flex-col material-sheet"
  onkeydown={onKeyDown}
  ontouchstart={(e) => e.stopPropagation()}
>
  <!-- ── Search bar row ─────────────────────────────────────────────────── -->
  <div
    class="flex shrink-0 items-center gap-2 px-3 hairline-b"
    style="padding-top: max(var(--sat, 0px), 0.5rem); padding-bottom: 0.5rem; min-height: calc(2.75rem + var(--sat, 0px));"
  >
    <!-- Rounded search field -->
    <div class="flex flex-1 min-w-0 items-center gap-2 rounded-[12px] bg-[var(--hover-gray)] px-3" style="height: 2.25rem;">
      <!-- Magnifier glyph -->
      <svg
        class="shrink-0 text-content-muted"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>

      <input
        bind:this={inputEl}
        type="search"
        bind:value={query}
        oninput={onInput}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck={false}
        maxlength={60}
        placeholder="Search messages"
        class="h-full w-full bg-transparent text-[16px] text-content outline-none placeholder:text-content-muted"
        style="font-size: 16px;"
      />

      {#if query}
        <button
          type="button"
          onclick={clearQuery}
          aria-label="Clear search"
          class="shrink-0 flex h-[20px] w-[20px] items-center justify-center rounded-full bg-content-muted/30 text-content-muted pressable"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      {/if}
    </div>

    <!-- Cancel button — 44pt tap target -->
    <button
      type="button"
      onclick={onclose}
      class="shrink-0 h-[44px] px-2 text-[16px] font-medium text-accent pressable"
      style="min-width: 44px;"
    >
      Cancel
    </button>
  </div>

  <!-- ── Results area ───────────────────────────────────────────────────── -->
  <div class="flex-1 overflow-y-auto overscroll-contain">

    {#if isIdle}
      <!-- ── Idle state: centered hint ─────────────────────────────────── -->
      <div class="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <svg
          class="text-content-muted"
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span class="text-[15px] text-content-muted">Search messages</span>
      </div>

    {:else if isLoading}
      <!-- ── Loading state: 3 skeleton rows ────────────────────────────── -->
      <div class="px-4 pt-2">
        {#each [0, 1, 2] as i (i)}
          <div class="flex items-start gap-3 py-3">
            <!-- Avatar skeleton -->
            <div
              class="mt-0.5 h-9 w-9 shrink-0 rounded-full"
              style="background-color: var(--hover-gray);"
            ></div>
            <div class="flex flex-1 flex-col gap-2">
              <!-- Author + channel row skeleton -->
              <div class="flex gap-2">
                <div
                  class="h-[14px] w-[80px] rounded-[4px]"
                  style="background-color: var(--hover-gray);"
                ></div>
                <div
                  class="h-[14px] w-[50px] rounded-[4px]"
                  style="background-color: var(--hover-gray);"
                ></div>
              </div>
              <!-- Snippet skeleton — two lines -->
              <div
                class="h-[13px] w-full rounded-[4px]"
                style="background-color: var(--hover-gray);"
              ></div>
              <div
                class="h-[13px] w-4/5 rounded-[4px]"
                style="background-color: var(--hover-gray);"
              ></div>
            </div>
          </div>
        {/each}
      </div>

    {:else if isEmpty}
      <!-- ── Empty state ──────────────────────────────────────────────── -->
      <div class="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <span class="text-[15px] text-content-muted">
          No results for &ldquo;{query.trim()}&rdquo;
        </span>
      </div>

    {:else}
      <!-- ── Results list ─────────────────────────────────────────────── -->
      <div class="px-4 pt-2 pb-[max(var(--sab,0px),1rem)]">
        {#each results as m (m.id)}
          {@const authorName = m.fromName ?? m.fromId}
          {@const avatarImg = memberImage.get(m.fromId) ?? null}
          {@const parts = highlightParts(
            typeof m.text === "string" ? m.text : "",
            query.trim(),
          )}
          {@const chName = channelName.get(m.channelId ?? "") ?? "channel"}

          <button
            type="button"
            onclick={() => pick(m)}
            class="pressable-row flex w-full items-start gap-3 rounded-[10px] px-2 py-3 text-left"
          >
            <!-- 36px avatar -->
            <div class="mt-0.5 shrink-0">
              <Avatar class="size-9 rounded-full">
                {#if avatarImg}
                  <AvatarImage src={avatarImg} alt={authorName} class="rounded-full object-cover" />
                {/if}
                <AvatarFallback
                  class="rounded-full text-[13px] font-bold text-accent-foreground"
                  style="background-color: {nameToColor(authorName)}; font-size: 13px;"
                >
                  {getInitials(authorName)}
                </AvatarFallback>
              </Avatar>
            </div>

            <!-- Text content -->
            <div class="min-w-0 flex-1">
              <!-- Author + channel + timestamp row -->
              <div class="mb-0.5 flex min-w-0 items-center gap-1.5">
                <span class="shrink-0 text-[15px] font-semibold text-content leading-none">
                  {authorName}
                </span>
                {#if m.fromType === "agent"}
                  <span
                    class="shrink-0 rounded bg-accent/15 px-1 text-[10px] font-medium text-accent leading-[1.4]"
                  >
                    Agent
                  </span>
                {/if}
                <span class="text-[13px] text-content-muted leading-none">·</span>
                <span class="flex min-w-0 shrink items-center gap-0.5 text-[13px] text-content-muted leading-none">
                  <!-- channel hash icon -->
                  <ChannelGlyph kind="hash" class="w-[11px] h-[11px] shrink-0" />
                  <span class="truncate">{chName}</span>
                </span>
                <span class="ml-auto shrink-0 text-[13px] text-content-muted leading-none">
                  {formatMessageTimestamp(m.createdAt)}
                </span>
              </div>

              <!-- Message snippet — 2-line clamp with highlight -->
              <div class="line-clamp-2 text-[15px] leading-snug text-content-muted">
                {parts[0]}{#if parts[1]}<mark
                    class="rounded-sm bg-warning/30 px-0.5 text-content"
                  >{parts[1]}</mark
                >{/if}{parts[2]}
              </div>
            </div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

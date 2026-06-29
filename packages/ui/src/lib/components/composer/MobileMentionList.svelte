<script lang="ts">
  /**
   * iOS-only autocomplete overlay for the native composer pill (Caveat #6).
   *
   * On the Tauri iOS shell the web composer chrome is collapsed to zero
   * footprint and a native UIKit pill rides the keyboard (see
   * `lib/mobile/nativeComposer.ts`). The web `@mention` / `#channel` / `:emoji`
   * dropdown (MentionAutocomplete) renders INSIDE that hidden chrome, so it's
   * invisible / untappable on iOS — yet detection + `selectMention()` still run.
   *
   * This component re-renders the same candidate rows in a VISIBLE, tappable
   * overlay positioned ABOVE the native pill. It reuses MentionAutocomplete's
   * row markup + classes verbatim (same dropdown tokens, same kinds) so it looks
   * identical to the web list. Selection routes straight back through the parent's
   * existing `selectMention()`, which pushes the chosen token into the native pill
   * via the bridge's `setText`.
   *
   * Positioning (Caveat #6 + #20): html/body are `position: fixed; inset: 0`
   * sized to `--app-vh` (= visualViewport.height), and on WKWebView the root's
   * fixed containing block traps a `position: fixed` descendant to that visible
   * box — so `bottom: 0` here anchors to the bottom of the VISIBLE viewport (the
   * keyboard's top edge when the keyboard is up), exactly where the native pill
   * sits. We offset upward by the pill's height (the native composer container is
   * 60pt) so the list floats just above the pill. When the keyboard is CLOSED the
   * pill rests above the web tab nav (bottomNavHeight ≈ 56pt + safe-area), so we
   * add that gap. The `keyboardOpen` flag (from the HMR-safe keyboard-state
   * module) selects between the two offsets.
   */
  import { onDestroy } from "svelte";
  import { subscribe as subscribeKeyboard } from "$lib/mobile/keyboard-state";
  import { authState, presenceState, workspaceUserStatusesState } from "$lib/state/app.svelte.js";
  import { cn } from "$lib/utils.js";
  import Emoji from "$lib/components/Emoji.svelte";
  import CyborgIcon from "$lib/components/CyborgIcon.svelte";
  import type { MentionCandidate } from "./MentionAutocomplete.svelte";

  let {
    items,
    selectedIndex,
    heading = "Members",
    onSelect,
    onHover,
    pillHeight = 60,
  }: {
    items: MentionCandidate[];
    selectedIndex: number;
    heading?: string;
    onSelect: (item: MentionCandidate) => void;
    onHover: (index: number) => void;
    // Live pill height from MessageInput (native composer:height). Floors at the
    // 60pt base; grows as the pill does so the list stays glued above it.
    pillHeight?: number;
  } = $props();

  let listEl: HTMLDivElement | undefined = $state();

  // Native pill geometry (must match CyborgPushPlugin.swift):
  //   composerBaseHeight = 60pt  — the pill container's height
  //   bottomNavHeight     = 56pt — where the pill rests above the web tab nav
  //                                 when the keyboard is closed.
  const PILL_HEIGHT = 60;
  const NAV_REST_HEIGHT = 56;
  // Floor at the 60pt base; the live `pillHeight` prop grows it as the native
  // composer expands (multi-line draft / attachments) so the list never hides
  // under the pill.
  const pill = $derived(Math.max(PILL_HEIGHT, Math.round(pillHeight)));

  // Track keyboard-open via the HMR-safe plain-module store (Caveat #8): when
  // the keyboard is up the pill is flush with the visible-viewport bottom; when
  // it's down the pill rests above the tab nav, so the list needs a taller gap.
  let keyboardOpen = $state(false);
  const stopKeyboard = subscribeKeyboard((v) => (keyboardOpen = v));
  onDestroy(stopKeyboard);

  // Distance from the bottom of the visible viewport up to the top of the pill.
  // Add the bottom safe-area inset so we clear the home indicator when the
  // keyboard is closed (when it's up the keyboard already covers that area).
  const bottomGap = $derived(
    keyboardOpen
      ? `calc(${pill}px + 6px)`
      : `calc(${pill + NAV_REST_HEIGHT}px + var(--sab, 0px) + 6px)`,
  );

  // Keep the active row scrolled into view as the user arrows through (parity
  // with MentionAutocomplete / SlashCommandMenu).
  $effect(() => {
    const idx = selectedIndex;
    if (!listEl) return;
    const row = listEl.querySelector<HTMLElement>(`[data-idx="${idx}"]`);
    row?.scrollIntoView({ block: "nearest" });
  });

  // Tap-vs-scroll discrimination (Caveat #6). Selecting on `pointerdown` made any
  // drag-to-scroll instantly pick a row, so the list felt unscrollable; and a
  // `preventDefault()` on pointerdown can itself block WKWebView overflow scroll.
  // Instead: track the pointer and select ONLY on a pointerup that didn't move (a
  // tap). A vertical drag scrolls the overflow container (touch-action: pan-y) and
  // never selects. One pointer at a time, so shared module-ish locals are fine.
  const TAP_SLOP_PX = 10;
  let downId = -1;
  let downX = 0;
  let downY = 0;
  let moved = false;
  function onRowDown(e: PointerEvent): void {
    downId = e.pointerId;
    downX = e.clientX;
    downY = e.clientY;
    moved = false;
  }
  function onRowMove(e: PointerEvent): void {
    if (e.pointerId !== downId || moved) return;
    if (Math.abs(e.clientX - downX) > TAP_SLOP_PX || Math.abs(e.clientY - downY) > TAP_SLOP_PX) {
      moved = true;
    }
  }
  function onRowUp(e: PointerEvent, item: MentionCandidate): void {
    if (e.pointerId !== downId) return;
    const wasTap = !moved;
    downId = -1;
    moved = false;
    if (wasTap) onSelect(item);
  }
  function resetRowPointer(): void {
    downId = -1;
    moved = false;
  }
</script>

<!-- Fixed overlay anchored to the bottom of the visible viewport (trapped to the
     `--app-vh` box by the root's fixed containing block on WKWebView), lifted
     above the native pill. Reuses the exact dropdown tokens + row markup from
     MentionAutocomplete so it's visually identical to the web list. -->
<div
  bind:this={listEl}
  class="hairline-t fixed left-3 right-3 z-[var(--z-dropdown)] overflow-y-auto rounded-[12px] py-1"
  style="bottom: {bottomGap}; max-height: calc(var(--app-vh, 100dvh) - {bottomGap} - var(--sat, 0px) - 8px); touch-action: pan-y; overscroll-behavior: contain; background-color: var(--bg-surface); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"
  role="listbox"
  aria-label={heading}
>
  <div class="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-content-muted">
    {heading}
  </div>
  {#each items as item, i (item.id)}
    <button
      type="button"
      data-idx={i}
      role="option"
      aria-selected={i === selectedIndex}
      onpointerdown={onRowDown}
      onpointermove={onRowMove}
      onpointerup={(e) => onRowUp(e, item)}
      onpointercancel={resetRowPointer}
      onmouseenter={() => onHover(i)}
      class="w-full flex min-h-[44px] items-center gap-2.5 px-3 py-2 text-left cursor-pointer transition-colors text-[16px]"
      style={i === selectedIndex
        ? "background-color: var(--dropdown-hover); color: var(--dropdown-name);"
        : "color: var(--dropdown-name);"}
    >
      {#if item.kind === "emoji"}
        <Emoji emoji={item.emoji ?? ""} size={20} title={item.label} />
      {:else if item.kind === "everyone"}
        <span class="w-6 h-6 rounded flex items-center justify-center text-[13px] shrink-0" style="background-color: var(--mention-bg); color: var(--mention-text);">📢</span>
      {:else if item.kind === "channel"}
        <span class="w-6 h-6 rounded flex items-center justify-center text-[14px] shrink-0" style="background-color: var(--mention-bg); color: var(--mention-text);">#</span>
      {:else if item.kind === "agent"}
        {@const img = authState.getMemberImage(item.id)}
        {#if img}
          <img src={img} alt={item.label} class="w-6 h-6 rounded-full object-cover shrink-0" />
        {:else}
          <span class="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style="background-color: var(--mention-bg); color: var(--mention-text);"><CyborgIcon size={14} /></span>
        {/if}
      {:else}
        {@const img = authState.getMemberImage(item.id)}
        {#if img}
          <img src={img} alt={item.label} class="w-6 h-6 rounded-full object-cover shrink-0" />
        {:else}
          <span class="w-6 h-6 rounded-full bg-surface-raised flex items-center justify-center text-[11px] font-medium text-content-dim shrink-0">
            {item.label[0]?.toUpperCase() ?? "?"}
          </span>
        {/if}
      {/if}
      <span class="flex-1 min-w-0">
        <span class="flex items-center gap-1.5">
          <span class="truncate font-medium">{item.label}</span>
          {#if item.kind === "human"}
            {@const statusEmoji = workspaceUserStatusesState.emojiFor(item.id)}
            {@const status = workspaceUserStatusesState.get(item.id)}
            {#if statusEmoji}
              {@const statusTooltip = [status?.emoji, status?.text].filter(Boolean).join(" ")}
              <Emoji emoji={statusEmoji} size={14} title={statusTooltip || statusEmoji} />
            {/if}
            {@const isActive = presenceState.isOnline(item.id) && !presenceState.isAway(item.id)}
            <span
              class={cn("w-2 h-2 rounded-full shrink-0", isActive ? "bg-online" : "bg-content-dim")}
              title={isActive ? "Active" : "Away"}
            ></span>
          {/if}
        </span>
        {#if item.sublabel}
          <span class="block truncate text-[12px] text-content-muted">{item.sublabel}</span>
        {/if}
      </span>
    </button>
  {/each}
</div>

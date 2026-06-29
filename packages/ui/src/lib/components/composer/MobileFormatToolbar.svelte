<script lang="ts">
  /**
   * iOS-only formatting-toolbar overlay for the native composer pill (#13 P1).
   *
   * On the Tauri iOS shell the web composer chrome is collapsed to zero
   * footprint and a native UIKit pill rides the keyboard (see
   * `lib/mobile/nativeComposer.ts`). The web formatting toolbar (ComposerToolbar)
   * renders INSIDE that hidden chrome, so it's invisible / untappable on iOS —
   * yet its handlers (bold/italic/strike/code/quote/list/link) are fully wired
   * and now operate on the native pill's selection (see MessageInput.svelte's
   * useNativeComposer() helpers).
   *
   * This component re-renders the SAME ComposerToolbar in a VISIBLE, tappable
   * `position:fixed` bar floated just ABOVE the native pill — the exact pattern
   * MobileMentionList uses for the @-mention dropdown. It's shown on demand: an
   * "Aa" affordance (also rendered here, in the same fixed coordinate space, so
   * the keyboard geometry lives in one place) toggles `open`, so the bar doesn't
   * permanently occupy the strip above the pill.
   *
   * Positioning (Caveat #6 + #20): html/body are `position: fixed; inset: 0`
   * sized to `--app-vh` (= visualViewport.height); on WKWebView the root's fixed
   * containing block traps a `position: fixed` descendant to that visible box —
   * so `bottom` here anchors to the bottom of the VISIBLE viewport (the keyboard
   * top edge when the keyboard is up), where the native pill sits. We offset
   * upward by the pill height; when the keyboard is CLOSED the pill rests above
   * the web tab nav, so we add that gap. Mirrors MobileMentionList's geometry so
   * the two overlays never bleed into the pill.
   *
   * Toolbar taps use `onmousedown`/`onpointerdown` + preventDefault (inherited
   * from ComposerToolbar) so tapping a button does NOT steal first-responder
   * from the native text view — the keyboard + pill selection stay put, which is
   * what every wrap-over-selection transform relies on.
   */
  import { onDestroy } from "svelte";
  import { subscribe as subscribeKeyboard } from "$lib/mobile/keyboard-state";
  import ComposerToolbar from "./ComposerToolbar.svelte";

  let {
    onToggleBold,
    onToggleItalic,
    onToggleStrike,
    onToggleOrderedList,
    onToggleBulletList,
    onToggleBlockquote,
    onToggleCode,
    onToggleCodeBlock,
    onLinkClick,
    pillHeight = 60,
  }: {
    onToggleBold: () => void;
    onToggleItalic: () => void;
    onToggleStrike: () => void;
    onToggleOrderedList: () => void;
    onToggleBulletList: () => void;
    onToggleBlockquote: () => void;
    onToggleCode: () => void;
    onToggleCodeBlock: () => void;
    onLinkClick: () => void;
    // Live pill height from MessageInput (native composer:height). Floors at the
    // 60pt base; grows as the pill does so this bar stays glued above it.
    pillHeight?: number;
  } = $props();

  // Native pill geometry — must match CyborgPushPlugin.swift + MobileMentionList:
  //   composerBaseHeight = 60pt  — the pill container's height
  //   bottomNavHeight     = 56pt — where the pill rests above the web tab nav
  //                                 when the keyboard is closed.
  // Floor for the pill height; the live `pillHeight` prop overrides it as the
  // native composer grows.
  const PILL_HEIGHT_BASE = 60;
  const NAV_REST_HEIGHT = 56;
  const pill = $derived(Math.max(PILL_HEIGHT_BASE, Math.round(pillHeight)));

  let keyboardOpen = $state(false);
  const stopKeyboard = subscribeKeyboard((v) => (keyboardOpen = v));
  onDestroy(stopKeyboard);

  // Distance from the bottom of the visible viewport up to the top of the pill.
  // Add the bottom safe-area inset to clear the home indicator when the keyboard
  // is closed (when it's up the keyboard already covers that area).
  const bottomGap = $derived(
    keyboardOpen
      ? `calc(${pill}px + 6px)`
      : `calc(${pill + NAV_REST_HEIGHT}px + var(--sab, 0px) + 6px)`,
  );
</script>

<!-- Slack-style inline formatting bar: shown ONLY while the keyboard is up,
     docked just above the native pill; hidden (clean input) when the keyboard is
     down. No floating "Aa" toggle anymore — the bar IS the affordance, always
     there while you're typing. Trapped to the `--app-vh` box by the root's fixed
     containing block on WKWebView. Reuses the exact ComposerToolbar so the iOS
     button set + icons match v2-web 1:1. onmousedown/pointerdown preventDefault
     (inherited from ComposerToolbar) keeps first-responder on the native text
     view, so tapping a button never dismisses the keyboard or drops the
     selection the wrap-over-selection transforms rely on. (#22) -->
{#if keyboardOpen}
  <div
    class="ios-format-bar hairline-t fixed left-3 right-3 z-[var(--z-dropdown)] rounded-[12px] overflow-x-auto"
    style="bottom: {bottomGap}; background-color: var(--bg-surface); border: 1px solid var(--dropdown-border); box-shadow: var(--dropdown-shadow);"
  >
    <ComposerToolbar
      {onToggleBold}
      {onToggleItalic}
      {onToggleStrike}
      {onToggleOrderedList}
      {onToggleBulletList}
      {onToggleBlockquote}
      {onToggleCode}
      {onToggleCodeBlock}
      {onLinkClick}
    />
  </div>
{/if}

<style>
  /* Touch sizing for the shared ComposerToolbar ONLY inside this iOS overlay:
     bump its compact desktop 28px buttons to 44pt targets with 16px glyphs.
     Scoped here (not in ComposerToolbar) so the desktop composer keeps its
     exact current look. min-width/height win over the w-7/h-7 utilities. */
  .ios-format-bar :global(button) {
    min-width: 44px;
    min-height: 44px;
    font-size: 16px;
  }
</style>

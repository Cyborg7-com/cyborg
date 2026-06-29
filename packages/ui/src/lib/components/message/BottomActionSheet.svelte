<script lang="ts">
  import type { Snippet } from "svelte";

  // Shared mobile bottom-sheet chrome for the long-press action sheets
  // (AttachmentActionSheet, MessageActionSheet). Extracts ONLY the structural
  // shell those two had hand-duplicated byte-for-byte: a tap-to-dismiss backdrop
  // (`fixed inset-0 z-[var(--z-sheet)] bg-black/50`), a `fixed inset-0` flex
  // column padded by the top safe area (`--sat`), a tap-to-dismiss spacer that
  // pushes the panel to the bottom, the translucent `.material-sheet` panel
  // (blur on its ::before — never the container, the WebKit descendant-paint
  // trap), a grab handle, and the inner scroll region padded by the bottom safe
  // area (`max(1rem, var(--sab))`). Consumers pass their row content as
  // `children`; everything below the handle lives in the scroll region.
  //
  // DELIBERATELY MINIMAL — this mirrors EXACTLY what the two sheets already did,
  // nothing more. It intentionally does NOT add a slide-up animation, ESC-to-
  // close, body scroll-lock, focus-trap, or swipe-to-dismiss (none of which the
  // two action sheets had). The richer iOS sheet — with all of those — already
  // exists as MobileSheet.svelte for consumers that want it; this is the bare
  // chrome the action sheets need, kept pixel- and behavior-identical.
  //
  // Backdrop / spacer taps call `onClose`. Per-action close + haptics + native-
  // pill handling stay in each consumer (they differ between the two sheets).
  let {
    ariaLabel,
    onClose,
    children,
  }: {
    /** Dialog accessible name (e.g. "Attachment actions" / "Message actions"). */
    ariaLabel: string;
    /** Tapping the backdrop or the spacer above the panel dismisses the sheet. */
    onClose: () => void;
    /** Row content rendered inside the scroll region, below the grab handle. */
    children: Snippet;
  } = $props();
</script>

<!-- Backdrop: tap to dismiss. -->
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="fixed inset-0 z-[var(--z-sheet)] bg-black/50" onclick={onClose}></div>

<div
  class="fixed inset-0 z-[var(--z-sheet)] flex flex-col"
  style="padding-top: var(--sat);"
  role="dialog"
  aria-modal="true"
  aria-label={ariaLabel}
>
  <!-- Spacer pushes the sheet to the bottom; tapping it closes. -->
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="flex-1" onclick={onClose}></div>

  <!-- iMessage-style sheet: translucent .material-sheet chrome (blur lives on
       its ::before — never on the container itself, WebKit trap), rounded top,
       flush with the screen bottom; the scroll region is an inner div so the
       material backdrop never scrolls away with long content. -->
  <div class="material-sheet flex max-h-[88vh] flex-col overflow-hidden rounded-t-[16px] shadow-2xl">
    <!-- Grab handle -->
    <div class="flex shrink-0 justify-center pb-2 pt-2.5">
      <div class="h-[5px] w-[36px] rounded-full bg-content-muted/40"></div>
    </div>

    <div class="flex min-h-0 flex-col overflow-y-auto px-4 pt-1" style="padding-bottom: max(1rem, var(--sab));">
      {@render children()}
    </div>
  </div>
</div>

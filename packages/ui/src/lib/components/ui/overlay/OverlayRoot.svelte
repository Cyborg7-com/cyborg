<script lang="ts">
  import type { Snippet } from "svelte";
  import { portal } from "$lib/actions/portal.js";
  import { isEditableTarget } from "$lib/actions/clickOutside.js";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { hasActiveComposer, setNativeVisibility } from "$lib/mobile/nativeComposer.js";
  import { cn } from "$lib/utils.js";

  // Shared overlay-shell primitive for the hand-rolled full-screen scrim
  // overlays. Owns the chrome those overlays each duplicated:
  //   • `use:portal` to <body> — so the `position:fixed` root escapes any
  //     transformed ancestor (PullToRefresh's resting translate, the iOS GPU
  //     root) that would otherwise become its containing block and clip it.
  //   • a single `fixed inset-0` scrim that IS the click-to-close dialog. The
  //     scrim background is a prop (`scrim`) so each consumer keeps its EXACT
  //     current backdrop; it defaults to the `--overlay-bg` theme token (never a
  //     literal). Tapping the scrim calls `onClose`.
  //   • opt-in Escape-to-close, body scroll-lock, and the mobile native-composer
  //     pill hide — each OFF by default so migrating an overlay onto this shell
  //     does not silently add a behavior it never had (a focus-trap / scroll-lock
  //     that wasn't there can change tab/escape/scroll semantics). A consumer
  //     turns on only what it already did.
  //
  // The consumer renders its content as `children` — directly inside the scrim
  // root — and is responsible for `stopPropagation` on any inner element that
  // must not dismiss the overlay (same as before the extraction).
  let {
    onClose,
    scrim = "var(--overlay-bg)",
    class: className = undefined,
    style: styleProp = undefined,
    ariaLabel,
    role = "dialog",
    closeOnEscape = false,
    lockScroll = false,
    hideComposer = false,
    children,
  }: {
    /** Called on scrim click, and on Escape when `closeOnEscape` is set. */
    onClose: () => void;
    /** Scrim background — any CSS color/value. Defaults to the `--overlay-bg`
     *  theme token. Pass the consumer's own value to preserve its exact look. */
    scrim?: string;
    /** Extra classes merged onto the `fixed inset-0` scrim root (layout the
     *  consumer needs — e.g. `flex items-center justify-center p-8`). */
    class?: string | undefined;
    /** Extra inline style appended after the scrim `background`. */
    style?: string | undefined;
    /** Accessible name for the dialog. */
    ariaLabel: string;
    /** ARIA role on the root. Defaults to `dialog`. */
    role?: string;
    /** Close on a window-level Escape keypress. OFF by default. */
    closeOnEscape?: boolean;
    /** Lock body scroll while open. OFF by default. */
    lockScroll?: boolean;
    /** Hide the iOS native composer pill while open (mobile overlays that cover
     *  a chat route). OFF by default so desktop overlays never touch it. */
    hideComposer?: boolean;
    children: Snippet;
  } = $props();

  // `role="presentation"`/`"none"` (e.g. QuickSwitcher, which keeps the dialog
  // role on its inner panel) is a non-semantic container: emitting `aria-modal`,
  // `aria-label`, or `tabindex` on it violates ARIA. Gate those three on the role
  // so a presentation scrim stays attribute-clean while a dialog keeps them.
  const isPresentation = $derived(role === "presentation" || role === "none");
  const isDialogRole = $derived(role === "dialog" || role === "alertdialog");

  function onWindowKeydown(e: KeyboardEvent): void {
    // Ignore Escape coming from an editable element (INPUT/TEXTAREA/SELECT or a
    // contenteditable host) so a window-level close never yanks focus / discards
    // input from under someone mid-typing.
    if (closeOnEscape && e.key === "Escape" && !isEditableTarget(e.target)) onClose();
  }

  // Body scroll-lock — opt-in. Restores the prior inline value on teardown.
  $effect(() => {
    if (!lockScroll) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  });

  // Native composer pill (a UIKit overlay ABOVE the WKWebView) bleeds through a
  // web overlay, so hide it while open and restore on close — opt-in, iOS only.
  // Restore CONDITIONALLY: only re-show the pill if a MessageInput still owns it
  // (a chat route), so the pill is never resurrected over a non-chat surface.
  $effect(() => {
    if (!hideComposer || !isTauriIOS()) return;
    setNativeVisibility(false);
    return () => setNativeVisibility(hasActiveComposer());
  });
</script>

<svelte:window onkeydown={closeOnEscape ? onWindowKeydown : undefined} />

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  use:portal
  {role}
  aria-modal={isDialogRole ? "true" : undefined}
  aria-label={isPresentation ? undefined : ariaLabel}
  tabindex={isPresentation ? undefined : -1}
  onclick={onClose}
  class={cn("fixed inset-0", className)}
  style="background: {scrim};{styleProp ? ` ${styleProp}` : ''}"
>
  {@render children()}
</div>

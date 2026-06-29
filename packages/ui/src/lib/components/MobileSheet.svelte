<script lang="ts">
  import type { Snippet } from "svelte";
  import { isTauriIOS } from "$lib/mobile/push.js";
  import { hasActiveComposer, setNativeVisibility } from "$lib/mobile/nativeComposer.js";
  import { subscribe as subscribeKeyboard } from "$lib/mobile/keyboard-state.js";

  // ── Reusable iOS bottom-sheet primitive ──────────────────────────────────
  // Generalizes the look nailed by MessageActionSheet.svelte: translucent
  // `.material-sheet` chrome (blur on its ::before, never the container — the
  // WebKit descendant-paint trap), rounded-t-[16px], a 36×5 grab handle, 48pt
  // rows from consumers, a springy entrance (--ease-spring/--duration-sheet),
  // safe-area bottom padding, swipe-down-to-dismiss on the grabber/header
  // region, ESC + focus-trap parity with the web dialogs it replaces, body
  // scroll lock, and the native-pill hide/restore effect (copied verbatim from
  // MessageActionSheet).
  //
  // RENDERS ONLY ON MOBILE. On desktop the consumer keeps its own presentation
  // and must NOT mount this — gate with `viewportState.isMobile` at the call
  // site (this component renders nothing when `open` is false, but it always
  // produces the mobile shell when open, so desktop must not open it).
  let {
    open = $bindable(false),
    title = undefined,
    ariaLabel = undefined,
    onclose = undefined,
    maxHeight = "88vh",
    children,
    // Optional header snippet rendered in the swipe/drag region (below the
    // grabber). When omitted, `title` (if any) is shown there instead.
    header = undefined,
  }: {
    open?: boolean;
    title?: string | undefined;
    ariaLabel?: string | undefined;
    onclose?: (() => void) | undefined;
    maxHeight?: string;
    children: Snippet;
    header?: Snippet | undefined;
  } = $props();

  let panelEl = $state<HTMLDivElement | null>(null);
  // Swipe-down-to-dismiss: a simple translate-follow on the panel while the
  // finger drags the grabber/header region, committing past a threshold.
  // Imperative DOM writes (Caveat #23): a reactive `style:` directive on the
  // 60fps transform would be clobbered by Svelte's reactive style rewrites, so
  // we write panelEl.style.transform directly and never bind it to state.
  let dragStartY = 0;
  let dragging = false;
  const DISMISS_THRESHOLD = 90; // px past which release dismisses

  // Keyboard-aware panel sizing. The sheet's `fixed inset-0` container resolves
  // against the `.h-screen` root (which has `transform: translateZ(0)`, so it is
  // the containing block for fixed descendants) — that root is sized to
  // `--app-vh` (= visualViewport.height) and ALREADY shrinks when the keyboard
  // opens, so the panel's bottom rises above the keyboard on its own. What does
  // NOT shrink is `max-height: {maxHeight}` when expressed in `vh`/`88vh`: `vh`
  // is the LAYOUT viewport (full screen), so an 88vh cap can exceed the
  // keyboard-shrunk container, letting the panel overflow the container top and
  // the focused input / lower buttons fall out of reach. While the keyboard is
  // open we therefore clamp the panel to a fraction of the LIVE visible height
  // (`--app-vh`) so it always fits above the keyboard and its inner scroll
  // region can bring the focused field + footer buttons into view.
  let keyboardOpen = $state(false);
  $effect(() => subscribeKeyboard((v) => (keyboardOpen = v)));

  function close(): void {
    open = false;
    onclose?.();
  }

  function onPointerDown(e: PointerEvent): void {
    if (!panelEl) return;
    dragging = true;
    dragStartY = e.clientY;
    panelEl.style.transition = "none";
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging || !panelEl) return;
    const dy = Math.max(0, e.clientY - dragStartY);
    panelEl.style.transform = `translateY(${dy}px)`;
  }

  function onPointerUp(e: PointerEvent): void {
    if (!dragging || !panelEl) return;
    dragging = false;
    const dy = Math.max(0, e.clientY - dragStartY);
    panelEl.style.transition = "";
    panelEl.style.transform = "";
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (dy > DISMISS_THRESHOLD) close();
  }

  // ESC closes (parity with the web dialogs this replaces). Focus-trap: keep
  // Tab cycling inside the panel so the sheet behaves like a modal.
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab" || !panelEl) return;
    const focusables = panelEl.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Body scroll lock while open — consistent with the full-screen overlay
  // convention (html+body are position:fixed on the mobile shell, but locking
  // overflow here defends against any scroll bleed-through under the backdrop).
  $effect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  });

  // Move focus into the panel when it opens (modal parity).
  $effect(() => {
    if (!open || !panelEl) return;
    const focusable = panelEl.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  });

  // Keyboard-aware max-height (Caveat #23 — written imperatively, NOT via a
  // reactive `style:` directive, so it can never collide with the swipe-dismiss
  // transform we also write to panelEl.style). While the keyboard is up, cap the
  // panel to ~92% of the LIVE visible height (`--app-vh`, which the root layout
  // keeps in sync with visualViewport.height) instead of the consumer's `vh`
  // cap — `vh` is the full-screen layout viewport and would let the panel
  // overflow the keyboard-shrunk container. When the keyboard closes we restore
  // the consumer's `maxHeight` cap on the same inline slot.
  $effect(() => {
    if (!open || !panelEl) return;
    if (keyboardOpen) {
      panelEl.style.maxHeight = "calc(var(--app-vh, 100dvh) * 0.92)";
      // Pull the focused field into the scroll region so the lower controls
      // (buttons / selects) stay reachable above the keyboard.
      const active = document.activeElement as HTMLElement | null;
      if (active && panelEl.contains(active)) {
        active.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    } else {
      // Restore the consumer's cap explicitly. We must NOT clear to "" here:
      // the static `style="max-height: {maxHeight}"` attribute and this
      // imperative write share the same inline `max-height` slot, so clearing it
      // would strip the cap entirely after the first keyboard open→close cycle.
      panelEl.style.maxHeight = maxHeight;
    }
  });

  // The native composer pill is a UIKit overlay ABOVE the WKWebView, so it
  // bleeds through this web sheet. Hide it while open; restore on close/unmount.
  // CONDITIONALLY restore — `setNativeVisibility(true)` unconditionally would
  // resurrect the pill on non-chat routes (settings, lists, profile menu,
  // confirm sheets) where the layout's route watcher had correctly hidden it,
  // leaving it stranded until the next navigation. `hasActiveComposer()` is true
  // only while a MessageInput owns the pill (chat routes), false everywhere
  // else, so we restore exactly the state Swift's URL-KVO expects — same as
  // ImageViewerModal.
  $effect(() => {
    if (!isTauriIOS() || !open) return;
    setNativeVisibility(false);
    return () => setNativeVisibility(hasActiveComposer());
  });
</script>

{#if open}
  <!-- Backdrop: tap to dismiss. Same convention as the message action sheet
       (fixed inset-0 z-[var(--z-menu)] bg-black/50). --z-menu clears the drawer
       (--z-drawer), the message sheet (--z-sheet) and the top bar; the status
       sub-editor (--z-modal) still wins over it. -->
  <button type="button" class="fixed inset-0 z-[var(--z-menu)] bg-black/50 sheet-backdrop" onclick={close} ontouchstart={(e) => e.stopPropagation()} aria-label="Close sheet"></button>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-[var(--z-menu)] flex flex-col"
    style="padding-top: var(--sat); pointer-events: none;"
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel ?? title ?? "Sheet"}
    onkeydown={onKeydown}
    ontouchstart={(e) => e.stopPropagation()}
    tabindex="-1"
  >
    <!-- Spacer pushes the sheet to the bottom; tapping it closes. -->
    <button type="button" class="flex-1" style="pointer-events: auto;" onclick={close} aria-label="Close sheet"></button>

    <!-- iMessage-style sheet: translucent .material-sheet chrome (blur on its
         ::before — never the container), rounded top, flush with the bottom;
         the scroll region is an inner div so the material backdrop never
         scrolls away with long content. -->
    <div
      bind:this={panelEl}
      class="material-sheet sheet-panel flex flex-col overflow-hidden rounded-t-[16px] shadow-2xl"
      style="max-height: {maxHeight}; pointer-events: auto;"
    >
      <!-- Grab handle + optional header: the drag region for swipe-to-dismiss. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="shrink-0 cursor-grab touch-none select-none"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <div class="flex justify-center pb-2 pt-2.5">
          <div class="h-[5px] w-[36px] rounded-full bg-content-muted/40"></div>
        </div>
        {#if header}
          {@render header()}
        {:else if title}
          <div class="px-4 pb-2 text-center text-[17px] font-semibold text-content">{title}</div>
        {/if}
      </div>

      <div class="flex min-h-0 flex-col overflow-y-auto px-4 pt-1" style="padding-bottom: max(1rem, var(--sab));">
        {@render children()}
      </div>
    </div>
  </div>
{/if}

<style>
  /* Springy entrance — the panel slides up from the bottom, the backdrop
     fades in. Mirrors the message sheet's native feel (--ease-spring /
     --duration-sheet are the app-wide sheet tokens). */
  .sheet-panel {
    animation: sheet-up var(--duration-sheet, 250ms) var(--ease-spring, cubic-bezier(0.32, 0.72, 0, 1));
  }
  @keyframes sheet-up {
    from {
      transform: translateY(100%);
    }
    to {
      transform: translateY(0);
    }
  }
  .sheet-backdrop {
    animation: sheet-fade 200ms ease-out;
  }
  @keyframes sheet-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet-panel,
    .sheet-backdrop {
      animation: none;
    }
  }
</style>

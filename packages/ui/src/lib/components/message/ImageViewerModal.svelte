<script lang="ts">
  // iOS Photos-grade full-screen image viewer. Replaces the old ImagePreviewModal
  // on mobile (isMobile gate). Desktop falls through to the original component.
  //
  // Full-screen strategy: `use:portal` appends to <body>. On iOS the root
  // container has `transform: translateZ(0)` (Caveat #23) which would trap
  // `position:fixed` descendants — portal escapes that by moving the node to
  // <body> which is `position:fixed;inset:0` on `html.tauri-ios`. So the viewer
  // sits in the correct stacking context and covers everything (MobileTopBar +
  // MobileNav are regular flow elements in the flex column; z-[var(--z-modal)] beats z-[var(--z-drawer)]
  // of the drawer). The native composer pill (UIKit overlay above WKWebView) is
  // hidden via setNativeVisibility, same as ImagePreviewModal and MessageActionSheet.
  //
  // Gestures:
  //   • Swipe-down to dismiss: translate-Y + fade, commit >100px or fast flick,
  //     spring back otherwise. Works at 1x; disabled when zoomed.
  //   • Double-tap to toggle 2.5x zoom toward tap point and back.
  //   • Single-tap toggles controls (scrim + buttons, 200ms fade).
  //   • One-finger pan while zoomed (clamped to image bounds).
  //   • Pinch-zoom: ships but flagged as "follow-up quality" — WKWebView's
  //     touch event handling can suppress multi-touch; if janky in testing, the
  //     double-tap path is the reliable fallback.
  import { portal } from "$lib/actions/portal.js";
  import { createImageActions } from "$lib/media/image-actions.svelte.js";
  import { haptic } from "$lib/mobile/haptics.js";
  import type { Action } from "svelte/action";

  let {
    image,
    onClose,
  }: {
    image: { url: string; name?: string; downloadUrl?: string; blurhash?: string | null; thumbnails?: { w360?: string; w720?: string; w1080?: string } } | null;
    onClose: () => void;
  } = $props();

  // Shared image-action layer (#537): save/copy/copy-link + state + the iOS
  // native-pill hide/restore, with the iOS+Android native-save gate in ONE place.
  // This viewer keeps only its gesture/zoom/layout below.
  const actions = createImageActions(() => image);

  // Viewer-only feedback: a single native haptic on copy result, iOS-gated via
  // the haptics.ts bridge (no-op on web/desktop). The shared layer owns the
  // clipboard write + toast; we just add the buzz based on its result.
  async function onCopyTap(): Promise<void> {
    const ok = await actions.copyImage();
    haptic(ok ? "success" : "error");
  }

  // ── Image loading ─────────────────────────────────────────────────────────────
  let imgLoaded = $state(false);
  let imgFailed = $state(false);
  // Reset per-image state when the image prop changes.
  $effect(() => {
    if (image) {
      imgLoaded = false;
      imgFailed = false;
    }
  });

  // ── Controls visibility (single-tap toggle) ──────────────────────────────────
  let controlsVisible = $state(true);
  let controlsTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(controlsTimer));

  function showControls(): void {
    controlsVisible = true;
    clearTimeout(controlsTimer);
  }

  function toggleControls(): void {
    controlsVisible = !controlsVisible;
  }

  // Auto-hide controls after 3s of no interaction when zoomed.
  function scheduleAutoHide(): void {
    clearTimeout(controlsTimer);
    if (scale > 1) {
      controlsTimer = setTimeout(() => (controlsVisible = false), 3000);
    }
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────────
  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") close();
  }

  function close(): void {
    resetGesture();
    onClose();
  }

  // ── Reduced-motion detection ──────────────────────────────────────────────────
  const reducedMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Transform state ───────────────────────────────────────────────────────────
  // Swipe-down dismiss: trackY + alpha.
  let dismissY = $state(0);
  let dismissAlpha = $state(1);

  // Zoom + pan.
  let scale = $state(1);
  let panX = $state(0);
  let panY = $state(0);

  // Derived CSS transform for the image.
  const imageTransform = $derived(
    `translate(${panX}px, ${panY}px) scale(${scale})`,
  );
  const backdropAlpha = $derived(dismissAlpha);

  // ── Touch state ───────────────────────────────────────────────────────────────
  type GestureMode = "idle" | "dismiss" | "pan" | "pinch";
  let gestureMode: GestureMode = "idle";

  // Dismiss gesture
  let dismissStartY = 0;
  let dismissStartTime = 0;
  let dismissVelocity = 0; // px/ms

  // Pan gesture (one-finger while zoomed)
  let panStartX = 0;
  let panStartY = 0;
  let panOriginX = 0;
  let panOriginY = 0;

  // Pinch gesture
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let pinchCenterX = 0;
  let pinchCenterY = 0;

  // Double-tap detection
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  // Clamp pan so the image can't be dragged off screen.
  function clampPan(s: number, px: number, py: number): { x: number; y: number } {
    if (s <= 1) return { x: 0, y: 0 };
    // The image container fills the viewport; when zoomed, the extra space
    // the image occupies (beyond 1x) is (s-1) * 50vw / 50vh in each direction.
    const vw = typeof window !== "undefined" ? window.innerWidth : 390;
    const vh = typeof window !== "undefined" ? window.innerHeight : 844;
    const maxX = ((s - 1) / 2) * vw;
    const maxY = ((s - 1) / 2) * vh;
    return {
      x: Math.max(-maxX, Math.min(maxX, px)),
      y: Math.max(-maxY, Math.min(maxY, py)),
    };
  }

  function dist(t1: Touch, t2: Touch): number {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function midpoint(t1: Touch, t2: Touch): { x: number; y: number } {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
  }

  function resetGesture(): void {
    gestureMode = "idle";
    dismissY = 0;
    dismissAlpha = 1;
  }

  // Spring the dismiss back (reduce-motion: instant).
  function springBackDismiss(): void {
    if (reducedMotion) {
      dismissY = 0;
      dismissAlpha = 1;
      gestureMode = "idle";
      return;
    }
    // CSS transition handles the spring; we just clear the values.
    gestureMode = "idle";
    dismissY = 0;
    dismissAlpha = 1;
  }

  function onTouchStart(e: TouchEvent): void {
    e.stopPropagation();
    showControls();
    if (e.touches.length === 2) {
      // Pinch start.
      gestureMode = "pinch";
      const d = dist(e.touches[0], e.touches[1]);
      pinchStartDist = d;
      pinchStartScale = scale;
      const mid = midpoint(e.touches[0], e.touches[1]);
      pinchCenterX = mid.x;
      pinchCenterY = mid.y;
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];

    // Double-tap detection.
    const now = Date.now();
    const TAP_THRESHOLD = 300; // ms
    const TAP_DIST = 30; // px
    if (
      now - lastTapTime < TAP_THRESHOLD &&
      Math.abs(t.clientX - lastTapX) < TAP_DIST &&
      Math.abs(t.clientY - lastTapY) < TAP_DIST
    ) {
      // Double tap: toggle zoom.
      lastTapTime = 0;
      e.preventDefault();
      handleDoubleTap(t.clientX, t.clientY);
      return;
    }
    lastTapTime = now;
    lastTapX = t.clientX;
    lastTapY = t.clientY;

    if (scale > 1) {
      // Panning while zoomed.
      gestureMode = "pan";
      panStartX = t.clientX;
      panStartY = t.clientY;
      panOriginX = panX;
      panOriginY = panY;
    } else {
      // Dismiss gesture starts.
      gestureMode = "dismiss";
      dismissStartY = t.clientY;
      dismissStartTime = now;
      dismissVelocity = 0;
    }
  }

  function onTouchMove(e: TouchEvent): void {
    e.stopPropagation();
    if (gestureMode === "pinch" && e.touches.length === 2) {
      e.preventDefault();
      const d = dist(e.touches[0], e.touches[1]);
      const newScale = Math.max(1, Math.min(4, pinchStartScale * (d / pinchStartDist)));
      scale = newScale;
      const clamped = clampPan(scale, panX, panY);
      panX = clamped.x;
      panY = clamped.y;
      return;
    }
    if (gestureMode === "pan" && e.touches.length === 1) {
      e.preventDefault();
      const t = e.touches[0];
      const newPanX = panOriginX + (t.clientX - panStartX);
      const newPanY = panOriginY + (t.clientY - panStartY);
      const clamped = clampPan(scale, newPanX, newPanY);
      panX = clamped.x;
      panY = clamped.y;
      return;
    }
    if (gestureMode === "dismiss" && e.touches.length === 1) {
      const t = e.touches[0];
      const dy = t.clientY - dismissStartY;
      if (dy < 0) {
        // Pulling up — cancel dismiss gesture, allow normal scroll.
        if (dy < -8) {
          gestureMode = "idle";
          dismissY = 0;
          dismissAlpha = 1;
        }
        return;
      }
      e.preventDefault();
      dismissY = dy;
      // Fade out the backdrop proportionally.
      dismissAlpha = Math.max(0.2, 1 - dy / 350);
      // Track velocity.
      const now = Date.now();
      const dt = now - dismissStartTime;
      if (dt > 0) dismissVelocity = dy / dt;
      dismissStartTime = now;
      dismissStartY = t.clientY;
    }
  }

  function onTouchEnd(e: TouchEvent): void {
    e.stopPropagation();
    if (gestureMode === "pinch") {
      gestureMode = "idle";
      if (scale <= 1) {
        scale = 1;
        panX = 0;
        panY = 0;
      }
      scheduleAutoHide();
      return;
    }
    if (gestureMode === "pan") {
      gestureMode = "idle";
      scheduleAutoHide();
      return;
    }
    if (gestureMode === "dismiss") {
      // Commit if dragged far enough OR fast enough.
      const COMMIT_DIST = 100;
      const COMMIT_VEL = 0.5; // px/ms
      if (dismissY > COMMIT_DIST || dismissVelocity > COMMIT_VEL) {
        // Animate out then close.
        if (!reducedMotion) {
          dismissY = window.innerHeight;
          dismissAlpha = 0;
          // Close after the CSS transition (200ms).
          setTimeout(() => close(), 220);
        } else {
          close();
        }
        return;
      }

      // Check if this was a tap (no meaningful movement) — if so, toggle
      // controls instead of just spring-backing. A "tap" is defined as:
      //   • total drag < 6px (distinguishes from a slow-drag release)
      //   • negligible velocity (< 0.15 px/ms)
      //   • not a double-tap (lastTapTime !== 0, i.e. not already consumed on touchstart)
      // Also guard: don't toggle if the finger lifted over a control button —
      // those fire their own click handlers via synthesized click after the
      // touch sequence, so toggling here would fight them.
      const TAP_DRAG_THRESHOLD = 6; // px
      const TAP_VEL_THRESHOLD = 0.15; // px/ms
      if (
        dismissY < TAP_DRAG_THRESHOLD &&
        dismissVelocity < TAP_VEL_THRESHOLD &&
        lastTapTime !== 0 &&
        e.changedTouches.length === 1 &&
        !(e.target as Element | null)?.closest(".viewer-scrim-top")
      ) {
        springBackDismiss();
        toggleControls();
        return;
      }

      springBackDismiss();
      return;
    }
    // Tap (no gesture committed at scale > 1 — pan mode was used): if the touch
    // didn't move much, toggle controls.
    if (e.changedTouches.length === 1) {
      const t = e.changedTouches[0];
      const dx = t.clientX - lastTapX;
      const dy = t.clientY - lastTapY;
      if (Math.sqrt(dx * dx + dy * dy) < 10) {
        // This was a real tap — single-tap toggles controls (double-tap was
        // already handled on touchstart and set lastTapTime=0).
        if (lastTapTime !== 0) {
          toggleControls();
        }
      }
    }
    gestureMode = "idle";
  }

  function handleDoubleTap(cx: number, cy: number): void {
    if (scale > 1) {
      // Zoom back to 1x.
      scale = 1;
      panX = 0;
      panY = 0;
    } else {
      // Zoom 2.5x toward the tap point.
      const targetScale = 2.5;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // Offset from center (positive = right/down of center).
      const offsetX = cx - vw / 2;
      const offsetY = cy - vh / 2;
      // When zooming in by targetScale, the point under the finger should
      // remain stationary: newPanX = -offsetX * (targetScale - 1).
      const newPanX = -offsetX * (targetScale - 1);
      const newPanY = -offsetY * (targetScale - 1);
      const clamped = clampPan(targetScale, newPanX, newPanY);
      scale = targetScale;
      panX = clamped.x;
      panY = clamped.y;
    }
    showControls();
    scheduleAutoHide();
  }

  // Top bar height: 2.75rem + safe-area-top. Use CSS variable.
  // The close button sits at safe-area-top + 12px from top (far left of scrim),
  // away from the profile avatar (which is on the right in MobileTopBar).

  // Non-passive touch action: registers touchstart/move/end with { passive: false }
  // so preventDefault() calls inside the handlers are honoured. Svelte's inline
  // ontouchXxx attributes are registered passively in some code paths; this action
  // bypasses that by going through addEventListener directly.
  const nonPassiveTouch: Action<HTMLElement> = (node) => {
    node.addEventListener("touchstart", onTouchStart, { passive: false });
    node.addEventListener("touchmove", onTouchMove, { passive: false });
    node.addEventListener("touchend", onTouchEnd, { passive: false });
    return {
      destroy() {
        node.removeEventListener("touchstart", onTouchStart);
        node.removeEventListener("touchmove", onTouchMove);
        node.removeEventListener("touchend", onTouchEnd);
      },
    };
  };
</script>

<svelte:window onkeydown={image ? onKeydown : undefined} />

{#if image}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    use:portal
    use:nonPassiveTouch
    role="dialog"
    aria-modal="true"
    aria-label="Image viewer"
    tabindex="-1"
    class="viewer-root"
    style="background: rgba(0,0,0,{backdropAlpha}); transform: translateY({dismissY}px);"
  >
    <!-- Top gradient scrim (controls housing) -->
    <div
      class="viewer-scrim-top"
      style="opacity: {controlsVisible ? 1 : 0}; pointer-events: {controlsVisible ? 'auto' : 'none'};"
    >
      <!-- Close button: top-LEFT, away from the avatar (which is top-right) -->
      <button
        type="button"
        class="viewer-btn"
        style="margin-left: 0;"
        onclick={(e) => { e.stopPropagation(); close(); }}
        aria-label="Close (Esc)"
        title="Close (Esc)"
      >
        <!-- X icon, white, 20px -->
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <!-- Centered filename -->
      {#if image.name}
        <span class="viewer-filename">{image.name}</span>
      {:else}
        <span class="viewer-filename-spacer"></span>
      {/if}

      <!-- Right: save result toast + download/save button -->
      <div class="viewer-right-controls">
        {#if actions.saveResult}
          <span
            class="viewer-save-toast"
            style="background-color: {actions.saveResult === 'saved' ? 'rgba(var(--color-success-rgb),0.9)' : 'rgba(var(--color-error-strong-rgb),0.9)'};"
          >{actions.saveResultLabel}</span>
        {/if}
        <!-- Copy image (44pt) — the only touch path to copy an image from the
             full-screen viewer; iOS native clipboard, web canvas→PNG clipboard. -->
        <button
          type="button"
          class="viewer-btn"
          disabled={actions.copying}
          onclick={(e) => { e.stopPropagation(); void onCopyTap(); }}
          aria-label="Copy image"
          title="Copy image"
        >
          {#if actions.copying}
            <span class="viewer-spinner"></span>
          {:else}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          {/if}
        </button>
        {#if image.name}
          <button
            type="button"
            class="viewer-btn"
            disabled={actions.saving}
            onclick={(e) => { e.stopPropagation(); void actions.save(); }}
            aria-label={actions.onNativeSave ? `Save ${image.name} to ${actions.saveNoun}` : `Download ${image.name}`}
            title={actions.onNativeSave ? `Save to ${actions.saveNoun}` : "Download"}
          >
            {#if actions.saving}
              <span class="viewer-spinner"></span>
            {:else}
              <!-- Download / save icon -->
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2v9M4 7l4 4 4-4M3 14h10" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            {/if}
          </button>
        {/if}
      </div>
    </div>

    <!-- Image container: full viewport, centered. Touch events bubble up to
         viewer-root. The transform (zoom+pan) is applied inline so CSS
         transitions animate it on double-tap. -->
    <div class="viewer-image-wrap">
      <!-- Blurhash/thumb placeholder shown until full-res loads -->
      {#if !imgLoaded && image.blurhash}
        <!-- Simplified blurhash: we don't render a canvas here (no blurhash decode
             in this component), but show a dark placeholder so the swap is graceful -->
        <div class="viewer-placeholder"></div>
      {/if}

      {#if !imgLoaded && !imgFailed}
        <!-- White spinner while loading -->
        <span class="viewer-spinner viewer-spinner--center" aria-label="Loading…"></span>
      {/if}

      <img
        src={image.url}
        alt={image.name ?? "Image"}
        class="viewer-img"
        style="opacity: {imgLoaded ? 1 : 0}; transform: {imageTransform};"
        draggable="false"
        onload={() => { imgLoaded = true; }}
        onerror={() => { imgFailed = true; }}
      />

      {#if imgFailed}
        <div class="viewer-error">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="3" y1="3" x2="21" y2="21" />
            <circle cx="8.5" cy="8.5" r="1.5" fill="white" stroke="none" />
          </svg>
          <span>Couldn't load image</span>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Full-screen viewer root — portaled to <body>, covers everything including
     MobileTopBar and MobileNav. z-[var(--z-modal)] beats the drawer (z-[var(--z-drawer)]) and action
     sheet (z-[var(--z-sheet)]). position:fixed works here because the portal escapes the
     GPU-root transform (Caveat #23): <body> is `position:fixed;inset:0` on iOS. */
  .viewer-root {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Dismiss spring transition — only translate and opacity */
    transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
                background 80ms linear;
    /* When dismiss commits (large Y), transition is overridden inline. */
    touch-action: none; /* we own all touch handling */
    overflow: hidden;
  }

  @media (prefers-reduced-motion: reduce) {
    .viewer-root {
      transition: none;
    }
  }

  /* Top gradient scrim — 96px tall black→transparent gradient.
     Fades controls in/out (200ms). Sits above the image (z-index via
     stacking context — children of a flex container stack naturally). */
  .viewer-scrim-top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    /* Height: safe-area-top + 96px of gradient room for buttons */
    height: calc(var(--sat, 0px) + 96px);
    background: linear-gradient(to bottom, rgba(0,0,0,0.75) 0%, transparent 100%);
    z-index: 10;
    display: flex;
    align-items: flex-end; /* buttons sit at the bottom of the gradient */
    padding: 0 12px;
    /* Safe-area padding: push button row below Dynamic Island / status bar */
    padding-top: var(--sat, 0px);
    padding-bottom: 8px;
    transition: opacity 200ms ease;
    pointer-events: auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .viewer-scrim-top {
      transition: none;
    }
  }

  /* 44pt buttons — white glyphs on a semi-transparent dark pill.
     Prominent enough against any image. */
  .viewer-btn {
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    border: none;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: white;
    /* No webkit-tap-highlight — we own touch events */
    -webkit-tap-highlight-color: transparent;
    transition: background 120ms;
  }

  .viewer-btn:active {
    background: rgba(0, 0, 0, 0.8);
  }

  .viewer-btn:disabled {
    opacity: 0.5;
  }

  /* Centered filename: grows to fill space between close and download,
     13px white/80%, single line with ellipsis. */
  .viewer-filename {
    flex: 1;
    text-align: center;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.8);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 8px;
    pointer-events: none;
  }

  .viewer-filename-spacer {
    flex: 1;
  }

  .viewer-right-controls {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .viewer-save-toast {
    border-radius: 20px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
    color: white;
    white-space: nowrap;
  }

  /* Full-viewport image container — takes all space, centers the image. */
  .viewer-image-wrap {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Don't steal pointer events from the root touch handler */
    pointer-events: none;
  }

  /* The actual image: object-contain, max 100% of viewport. Transform
     (zoom+pan) applied inline. Transition for double-tap zoom snap. */
  .viewer-img {
    max-width: 100vw;
    max-height: 100vh;
    width: auto;
    height: auto;
    object-fit: contain;
    display: block;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    /* Transition for double-tap zoom snap (not used during active pan/pinch —
       the inline transform is set imperatively there). */
    transition: transform 250ms cubic-bezier(0.34, 1.56, 0.64, 1),
                opacity 200ms ease;
    will-change: transform;
  }

  @media (prefers-reduced-motion: reduce) {
    .viewer-img {
      transition: opacity 200ms ease;
    }
  }

  .viewer-placeholder {
    position: absolute;
    inset: 0;
    background: #111;
  }

  /* White ring spinner */
  .viewer-spinner {
    display: inline-block;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: 2.5px solid rgba(255,255,255,0.2);
    border-top-color: white;
    animation: viewer-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  .viewer-spinner--center {
    position: absolute;
    z-index: 5;
  }

  @keyframes viewer-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .viewer-spinner {
      animation: none;
      border-top-color: rgba(255,255,255,0.5);
    }
  }

  .viewer-error {
    position: absolute;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: rgba(255,255,255,0.7);
    font-size: 13px;
    pointer-events: none;
  }
</style>

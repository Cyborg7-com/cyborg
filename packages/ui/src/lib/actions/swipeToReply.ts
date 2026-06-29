// Swipe-to-reply gesture for a message row (#523). Short rightward drag reveals
// a reply affordance; past the threshold it fires `onReply` (open the thread),
// below it springs back. Touch-only, mobile-only, reduced-motion-safe, and it
// must NOT hijack vertical scroll or break tap / long-press.
//
// Mirrors the codebase's existing gesture style (ImageViewerModal): raw Pointer
// events + a direct `transform`, with a slight-overshoot CSS transition for the
// spring-back (no svelte/motion dependency). `touch-action: pan-y` on the node
// lets the browser keep owning vertical scroll while we own horizontal — so the
// list still scrolls and we only ever translate on a clearly-horizontal drag.

import { haptic } from "$lib/mobile/haptics";

export interface SwipeToReplyOptions {
  // mobile && !reduced-motion && a reply target exists && not editing.
  enabled: boolean;
  onReply: () => void;
  // 0..1 reveal ratio (drag distance / threshold), clamped — drives the icon.
  onProgress?: (ratio: number) => void;
  threshold?: number; // px past which release fires reply (default 64)
  max?: number; // max drag translate (default 96)
}

// Spring-back uses Apple's NON-overshoot nav curve (the same `--ease-spring`
// token swipeBack.ts / pushTransition.ts use). The row must settle to rest with
// NO bounce past its resting position — the earlier `cubic-bezier(…, 1.56, …)`
// overshot past 1.0 and produced a visible rubber-band wobble on release.
const SNAP_BACK = "transform 200ms var(--ease-spring, cubic-bezier(0.32, 0.72, 0, 1))";
// Below this the move is treated as a tap (no translate, no scroll steal).
// Raised 8→12: a slightly longer commit distance lets a near-vertical scroll
// resolve as vertical (and bail) before we claim the gesture, without making the
// reply pull feel sluggish (threshold to FIRE is still 64).
const DIRECTION_LOCK_PX = 12;
// Left-edge dead-zone: a gesture STARTING this close to the screen's left edge
// belongs to the iOS edge-swipe-back gesture, not reply. Kept ≥ swipeBack's
// EDGE_PX (25) and mirrored here as a local const (NOT imported, to avoid
// coupling this per-row action to the global swipe-back module) — if swipeBack's
// EDGE_PX changes, bump this in step so the two bands stay coordinated. A reply
// swipe must BEGIN beyond this band.
const EDGE_DEAD_ZONE_PX = 28; // ≥ swipeBack.ts EDGE_PX (= 25)

export function swipeToReply(node: HTMLElement, options: SwipeToReplyOptions) {
  let opts = options;
  let startX = 0;
  let startY = 0;
  let active = false; // a touch pointer is down and not yet resolved
  let locked = false; // resolved as a horizontal swipe (we own the gesture)
  let pointerId: number | null = null;

  function setX(px: number): void {
    node.style.transition = "none";
    node.style.transform = px ? `translateX(${px}px)` : "";
    opts.onProgress?.(Math.min(1, Math.max(0, px) / (opts.threshold ?? 64)));
  }

  function springBack(): void {
    node.style.transition = SNAP_BACK;
    node.style.transform = "";
    opts.onProgress?.(0);
  }

  function addWindowListeners(): void {
    // Bound only for the duration of an active drag so we don't keep one set of
    // window listeners per message row mounted (hundreds in a long channel).
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerCancel);
  }

  function removeWindowListeners(): void {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerEnd);
    window.removeEventListener("pointercancel", onPointerCancel);
  }

  function onPointerDown(e: PointerEvent): void {
    if (!opts.enabled || e.pointerType !== "touch") return;
    // Don't arm reply inside the left-edge band — that zone is the edge-swipe-
    // back gesture's (swipeBack.ts). A rightward drag starting there must drive
    // route-pop / thread-dismiss, never a reply, so we bail before binding the
    // drag listeners and leave swipeBack to own it uncontested. Reply can only
    // BEGIN beyond the band; where it FIRES (threshold) is unchanged.
    if (e.clientX < EDGE_DEAD_ZONE_PX) return;
    startX = e.clientX;
    startY = e.clientY;
    active = true;
    locked = false;
    pointerId = e.pointerId;
    addWindowListeners();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!active || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!locked) {
      // Vertical intent → let the browser scroll; abandon this gesture.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > DIRECTION_LOCK_PX) {
        active = false;
        return;
      }
      // Horizontal intent → claim the gesture (pan-y already reserved horizontal
      // for us, so no preventDefault needed; capture so it survives leaving the row).
      if (Math.abs(dx) > DIRECTION_LOCK_PX) {
        locked = true;
        node.setPointerCapture?.(e.pointerId);
      } else {
        return;
      }
    }
    // Reply is a RIGHTWARD pull; clamp to [0, max] (left drags do nothing).
    setX(Math.max(0, Math.min(opts.max ?? 96, dx)));
  }

  function onPointerEnd(e: PointerEvent): void {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const committed = locked && dx >= (opts.threshold ?? 64);
    active = false;
    locked = false;
    pointerId = null;
    removeWindowListeners();
    springBack();
    if (committed) {
      haptic("light");
      opts.onReply();
    }
  }

  function onPointerCancel(e?: PointerEvent): void {
    // A second touch must not cancel the swipe owned by the captured pointer.
    if (e && e.pointerId !== pointerId) return;
    active = false;
    locked = false;
    pointerId = null;
    removeWindowListeners();
    springBack();
  }

  function apply(): void {
    // pan-y: browser keeps vertical scroll, JS owns horizontal. Cleared when
    // disabled so a non-swipe row behaves exactly as before.
    node.style.touchAction = opts.enabled ? "pan-y" : "";
  }

  // Only pointerdown stays bound to the node permanently; the window listeners
  // (which let a drag resolve after it leaves the row) are bound per-drag.
  node.addEventListener("pointerdown", onPointerDown);
  apply();

  return {
    update(next: SwipeToReplyOptions) {
      opts = next;
      apply();
      if (!opts.enabled && (active || locked)) onPointerCancel();
    },
    destroy() {
      node.removeEventListener("pointerdown", onPointerDown);
      removeWindowListeners();
      node.style.transform = "";
      node.style.transition = "";
      node.style.touchAction = "";
    },
  };
}

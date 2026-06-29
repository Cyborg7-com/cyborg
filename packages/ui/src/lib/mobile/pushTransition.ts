/**
 * iOS UINavigationController-style push/pop transition for SvelteKit
 * navigations (P2 — the boss's "sliding a otro channel" complaint).
 *
 * WHAT PLAYS WHEN
 *  - PUSH (list → detail, e.g. /chats → /channel/<id>): the OUTGOING page — a
 *    snapshot clone, reusing the EXACT machinery swipeBack captures on every
 *    history.pushState (Caveat #22) — sits as an underlay parallaxing
 *    0 → -30% translateX with a dim ramping 0 → 0.15, while the INCOMING live
 *    <main> slides translateX(100% → 0). Both run --duration-nav on
 *    --ease-spring (Apple's nav curve).
 *  - POP (detail → list via a back BUTTON, i.e. goBackFromConversation): the
 *    reverse. The snapshot captured at this pushState IS the outgoing detail
 *    page — it is mounted as an OVERLAY (above the live <main>) sliding
 *    0 → 100%, a dim layer between them fades 0.15 → 0, and the live <main>
 *    (now the list) parallaxes -30% → 0 underneath.
 *
 * WHAT NEVER PLAYS
 *  - Navs committed by the edge-swipe gesture (the swipe already animated —
 *    swipeBack marks them via markGestureNav; consumed here).
 *  - Tab-to-tab switches (both routes are list roots — iOS tabs switch
 *    instantly) and workspace switches (different <ws> segment).
 *  - Deep links / programmatic navs: a push only plays within
 *    GESTURE_RECENCY_MS of a real user touch/click, so a notification-tap
 *    goto() or a restore redirect lands instantly.
 *  - replaceState navigations (the swipeBack wrapper only notifies pushState).
 *  - prefers-reduced-motion, non-iOS shells, and the desktop/tablet layout.
 *
 * MECHANICS (Caveats #21/#22/#23 discipline, shared with swipeBack.ts)
 *  - The pushState notification fires synchronously AFTER the URL change but
 *    BEFORE SvelteKit swaps the page content inside the persistent <main>. We
 *    mount the layers + offset <main> in that window: the screen shows the
 *    snapshot (pixel-identical to the old page), the content swap happens
 *    off-screen / under cover, and a double-rAF later the spring animates via
 *    one-shot CSS transitions driven by IMPERATIVE inline-style writes — never
 *    reactive `style:` directives.
 *  - Layers are `position: absolute` inside the GPU-layered shell root (never
 *    fixed — WKWebView traps fixed descendants), positioned to the live
 *    <main>'s offset box, ID-stripped clones, pointer-events: none. Hardened
 *    by the `html.tauri-ios #push-*` rules in app.css (sibling rules to
 *    #swipe-peek-layer).
 *  - CLEANUP IS BULLETPROOF: at most one transition exists at a time; every
 *    new pushState, any touchstart, and any popstate finalizes the in-flight
 *    transition synchronously (jump to end state, remove layers, clear <main>
 *    inline styles). 20× rapid nav leaves zero orphan nodes, and a touch that
 *    begins an edge-swipe mid-transition gets a clean <main> before the swipe
 *    pins it (this module's listeners are registered first — the workspace
 *    layout mounts before the root layout's onMount installs swipeBack).
 *
 * INSTALL: `installPushTransition()` once from the workspace layout's onMount,
 * gated on isTauriIOS(); invoke the returned cleanup on destroy. No-op on SSR.
 */

import { viewportState } from "$lib/state/viewport.svelte";
import { isTauriIOS } from "./push";
import { getLastPageNode } from "./peekState";
import {
  consumeGestureNav,
  consumePopNav,
  findLiveMain,
  isDetailPath,
  mountSnapshotInLayer,
  positionLayerOverMain,
  setNavPushListener,
  setNavReplaceListener,
  SNAPSHOT_LAYER_ATTR,
} from "./swipeBack";

const UNDERLAY_ID = "push-underlay-layer";
const OVERLAY_ID = "push-overlay-layer";
const DIM_ID = "push-dim-layer";
// Every push/pop layer is stamped with its creation time so the lifetime
// watchdog can hard-remove one that outlived its transition no matter HOW it
// escaped cleanup. Scoped to this module's OWN layer ids — the swipe peek layer
// (owned by swipeBack, bounded by a possibly-long user gesture) is never touched.
const LAYER_BORN_ATTR = "data-push-layer-born";
const PUSH_LAYER_IDS = [UNDERLAY_ID, OVERLAY_ID, DIM_ID];
// Mirrors --duration-nav (350ms); the inline transitions reference the token
// (with this as fallback) so theme-level tuning stays possible, while the
// finalize timeout uses the constant + slack.
const NAV_MS = 350;
const SPRING_EASE = "var(--ease-spring, cubic-bezier(0.32, 0.72, 0, 1))";
const NAV_DURATION = `var(--duration-nav, ${NAV_MS}ms)`;
// Parallax + dim match the swipe-back gesture so push and pop read as the same
// physical stack of pages.
const PARALLAX_PCT = 30;
const DIM_OPACITY = 0.15;
// A push must follow a real user touch/click this closely — anything older is
// a deep link / programmatic nav and lands instantly. Generous enough to cover
// a load() awaited between the tap and pushState.
const GESTURE_RECENCY_MS = 2500;
// Hard cap on how long ANY push/pop layer may live. A transition self-finalizes
// at NAV_MS + 80; this is comfortably above that (covering a janked-out double
// rAF + the finalize timeout) yet far below human perception of a "stuck" page.
// A layer older than this had its finalize skipped by SOME path — kill it.
const LAYER_MAX_LIFETIME_MS = 1500;
// How often the watchdog scans for over-age layers. Cheap (a getElementById ×3
// guarded by an early return when no push layer exists).
const WATCHDOG_INTERVAL_MS = 1000;

export function installPushTransition(): () => void {
  if (typeof window === "undefined" || !isTauriIOS()) return () => {};

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let lastGestureAt = 0;
  // The single in-flight transition. `finalize` is idempotent and synchronous:
  // remove layers, clear <main> inline styles, null `active`.
  let active: { finalize: () => void } | null = null;

  const onUserGesture = (): void => {
    lastGestureAt = Date.now();
  };

  const onInterrupt = (): void => {
    active?.finalize();
  };

  // popstate = a navigation that BYPASSES the pushState wrap (history.back()
  // fallbacks, browser back) — finalize, then sweep on the next tick so the
  // arriving page never renders under a stale layer. touchstart keeps
  // finalize-only (see sweepOrphans note).
  const onPopState = (): void => {
    active?.finalize();
    window.setTimeout(sweepOrphans, 0);
  };

  /** Create one absolutely-positioned snapshot layer pinned to <main>'s box. */
  const makeLayer = (id: string, zIndex: string, main: HTMLElement): HTMLDivElement => {
    // A stale layer with this id (impossible unless a finalize was somehow
    // skipped) must never stack — remove defensively before re-creating.
    document.getElementById(id)?.remove();
    const layer = document.createElement("div");
    layer.id = id;
    layer.setAttribute(SNAPSHOT_LAYER_ATTR, "");
    // Birth stamp for the lifetime watchdog — a layer older than
    // LAYER_MAX_LIFETIME_MS gets force-removed however its finalize was skipped.
    layer.setAttribute(LAYER_BORN_ATTR, String(Date.now()));
    layer.style.cssText = [
      "position: absolute", // never fixed — Caveat #23 GPU-root trap
      `z-index: ${zIndex}`,
      "pointer-events: none",
      "overflow: hidden",
      // Anti-flash: painted with the app surface, like the swipe peek layer.
      "background-color: var(--bg-base, #1c1d21)",
    ].join("; ");
    positionLayerOverMain(layer, main);
    return layer;
  };

  /** Shared scaffolding: returns null unless a transition can mount safely. */
  const prepare = (): { main: HTMLElement; parent: HTMLElement; snapshot: HTMLElement } | null => {
    const snapshot = getLastPageNode();
    const main = findLiveMain();
    if (!snapshot || !main || !main.parentElement) return null;
    const parent = main.parentElement;
    // Same containing-block pinning the swipe gesture uses.
    parent.style.position = parent.style.position || "relative";
    return { main, parent, snapshot };
  };

  /**
   * Open a transition slot and register its finalize IMMEDIATELY — before any
   * layer enters the DOM. Returns a controller the play* fn uses to (a) track
   * every layer it mounts so finalize can remove it, and (b) kick off the spring.
   *
   * ROOT-CAUSE FIX (chat-content-mixing incident): the previous shape mounted
   * the layers FIRST and only registered `active.finalize` afterwards, in
   * `beginAnimation`. Anything that threw in between (a DOM op, a clone failure
   * in mountSnapshotInLayer) — or simply the gap itself — stranded those layers:
   * a z:20 pop OVERLAY carrying the OLD detail page composited over EVERYTHING,
   * and the NEXT navigation's `active?.finalize()` could not remove it (finalize
   * only knows the layers in its own closure, and `active` was still null/the
   * prior slot). That orphan overlay IS "I open chat B and see chat A on top."
   * Now `active.finalize` owns a MUTABLE layer list from the very first line, so
   * however the play* body exits — normal spring, supersede, popstate, timeout,
   * or a thrown exception caught below — every layer it created is torn down.
   */
  interface TransitionController {
    finalize: () => void;
    track: (layer: HTMLElement) => void;
    run: (fn: () => void) => void;
  }
  const beginTransition = (main: HTMLElement): TransitionController => {
    let done = false;
    const layers: HTMLElement[] = [];
    const finalize = (): void => {
      // Idempotent: callers are all guarded, but a double-finalize must never
      // clear inline styles a SUCCESSOR transition just wrote on <main>.
      if (done) return;
      done = true;
      if (active?.finalize === finalize) active = null;
      // Remove every layer this transition mounted (tracked as it mounted, so a
      // mid-mount throw still tears down whatever made it into the DOM).
      for (const layer of layers) layer.remove();
      main.style.transition = "";
      main.style.transform = "";
      main.style.willChange = "";
      main.style.zIndex = "";
      main.style.position = "";
    };
    // Register the slot SYNCHRONOUSLY, before the first layer mounts.
    active = { finalize };
    return {
      finalize,
      track: (layer: HTMLElement): void => {
        layers.push(layer);
      },
      run: (fn: () => void): void => {
        // Double rAF: the first frame lets SvelteKit finish swapping the
        // incoming page into <main> (it renders synchronously right after
        // pushState, but a paint must elapse so the start states are
        // committed); the second starts the transition from a fully-laid-out
        // start state.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!active || active.finalize !== finalize) return; // superseded
            fn();
            window.setTimeout(() => {
              if (active?.finalize === finalize) finalize();
            }, NAV_MS + 80);
          });
        });
      },
    };
  };

  const playPush = (): void => {
    const ctx = prepare();
    if (!ctx) return; // no snapshot/<main> → land instantly (never block nav)
    const { main, parent, snapshot } = ctx;

    // Register the finalize slot + layer-tracking BEFORE any DOM mutation, so a
    // throw anywhere below tears down whatever was mounted (see beginTransition).
    const t = beginTransition(main);
    try {
      // Underlay: the outgoing page snapshot, with its dim as a child so both
      // parallax together (the dim belongs to the receding page).
      const underlay = makeLayer(UNDERLAY_ID, "0", main);
      t.track(underlay);
      mountSnapshotInLayer(underlay, snapshot);
      const dim = document.createElement("div");
      dim.style.cssText =
        "position: absolute; inset: 0; z-index: 5; background: #000; opacity: 0; pointer-events: none;";
      underlay.appendChild(dim);
      parent.insertBefore(underlay, main);

      // Park the live <main> off-screen right BEFORE its content swaps to the
      // incoming page — the underlay shows the identical old page, so this
      // synchronous jump is invisible. Imperative writes only (Caveat #23).
      main.style.position = "relative";
      main.style.zIndex = "10";
      main.style.willChange = "transform";
      main.style.transition = "";
      main.style.transform = "translate3d(100%, 0, 0)";

      t.run(() => {
        main.style.transition = `transform ${NAV_DURATION} ${SPRING_EASE}`;
        underlay.style.transition = `transform ${NAV_DURATION} ${SPRING_EASE}`;
        dim.style.transition = `opacity ${NAV_DURATION} ${SPRING_EASE}`;
        // Flush so iOS WebKit commits the transitions before the end states
        // (same batching quirk the swipe release works around).
        void main.offsetWidth;
        main.style.transform = "translate3d(0, 0, 0)";
        underlay.style.transform = `translate3d(-${PARALLAX_PCT}%, 0, 0)`;
        dim.style.opacity = String(DIM_OPACITY);
      });
    } catch {
      // Never strand a half-mounted transition: tear down everything tracked so
      // far (incl. the z:0 underlay) and clear <main>. The nav itself already
      // happened — landing instantly is correct, a stuck snapshot layer is not.
      t.finalize();
    }
  };

  const playPop = (): void => {
    const ctx = prepare();
    if (!ctx) return;
    const { main, parent, snapshot } = ctx;

    // Register the finalize slot + layer-tracking BEFORE mounting the z:20
    // overlay — that overlay carries the OLD detail page over EVERYTHING, so a
    // strand here is the exact chat-mixing symptom. Tracked-first + try/catch
    // guarantees teardown on any failure path (see beginTransition).
    const t = beginTransition(main);
    try {
      // Overlay: the outgoing DETAIL page snapshot, above everything, sliding
      // off to the right. Dim sits between it and the incoming list.
      const overlay = makeLayer(OVERLAY_ID, "20", main);
      t.track(overlay);
      mountSnapshotInLayer(overlay, snapshot);
      const dimLayer = makeLayer(DIM_ID, "15", main);
      t.track(dimLayer);
      dimLayer.style.backgroundColor = "#000";
      dimLayer.style.opacity = String(DIM_OPACITY);
      parent.appendChild(dimLayer);
      parent.appendChild(overlay);

      // The live <main> (about to become the list) starts at the parallax rest
      // position; its current detail content is hidden under the overlay's
      // pixel-identical snapshot, so the swap + offset are invisible.
      main.style.position = "relative";
      main.style.zIndex = "10";
      main.style.willChange = "transform";
      main.style.transition = "";
      main.style.transform = `translate3d(-${PARALLAX_PCT}%, 0, 0)`;

      t.run(() => {
        main.style.transition = `transform ${NAV_DURATION} ${SPRING_EASE}`;
        overlay.style.transition = `transform ${NAV_DURATION} ${SPRING_EASE}`;
        dimLayer.style.transition = `opacity ${NAV_DURATION} ${SPRING_EASE}`;
        void main.offsetWidth;
        main.style.transform = "translate3d(0, 0, 0)";
        overlay.style.transform = "translate3d(100%, 0, 0)";
        dimLayer.style.opacity = "0";
      });
    } catch {
      // A stranded z:20 overlay shows chat A on top of chat B — the reported
      // bug. Tear it (and the dim) down immediately on any failure.
      t.finalize();
    }
  };

  /**
   * Defense-in-depth orphan sweep (chat-content-mixing incident): a snapshot
   * layer or a parked <main> that outlives its transition composites OLD page
   * content over/under the live page — the user literally sees chat A inside
   * chat B. Whatever the escape path (an exception between layer-mount and
   * `active` registration, a navigation flavor that skips a finalize, a code
   * path added later), this sweep guarantees the invariant: AFTER ANY
   * COMPLETED NAVIGATION, zero snapshot layers exist and <main> carries no
   * residual transform — unless a transition is actively running (it just
   * mounted its own layers AFTER this sweep in the same handler).
   * Deliberately NOT called from touchstart: a second finger mid-edge-swipe
   * must not rip the gesture's peek backdrop out from under it.
   */
  const sweepOrphans = (): void => {
    if (active) return;
    const layers = document.querySelectorAll(`[${SNAPSHOT_LAYER_ATTR}]`);
    for (const layer of layers) layer.remove();
    const main = findLiveMain();
    if (main && main.style.transform) {
      main.style.transition = "";
      main.style.transform = "";
      main.style.opacity = "";
      main.style.willChange = "";
      main.style.zIndex = "";
      main.style.position = "";
    }
  };

  /**
   * Hard lifetime cap (last line of defense). A push/pop layer self-finalizes at
   * NAV_MS + 80ms; one that's still in the DOM past LAYER_MAX_LIFETIME_MS had its
   * finalize skipped by SOME path we didn't foresee — remove it on a wall-clock
   * timer that needs NO navigation/touch/popstate to fire. This runs even while
   * `active` is set: an in-flight transition is bounded well under the cap, so a
   * layer over the cap is stale by definition — but the layer id check keeps us
   * strictly to THIS module's layers, never the swipe peek backdrop (which a slow
   * user gesture can legitimately hold for seconds). When the last push layer is
   * cleared and no transition is registered, also clear any residual <main>
   * transform so the live page can't stay parked off-screen.
   */
  const sweepStaleLayers = (): void => {
    const now = Date.now();
    let removedAny = false;
    for (const id of PUSH_LAYER_IDS) {
      const layer = document.getElementById(id);
      if (!layer) continue;
      const born = Number(layer.getAttribute(LAYER_BORN_ATTR) ?? "0");
      if (born > 0 && now - born > LAYER_MAX_LIFETIME_MS) {
        layer.remove();
        removedAny = true;
      }
    }
    if (!removedAny) return;
    // A layer this old means the transition that owned it is long dead; drop the
    // slot so the next nav doesn't think one is in flight, and un-park <main>.
    active = null;
    const main = findLiveMain();
    if (main && main.style.transform) {
      main.style.transition = "";
      main.style.transform = "";
      main.style.opacity = "";
      main.style.willChange = "";
      main.style.zIndex = "";
      main.style.position = "";
    }
  };

  // replaceState navigations never animate (redirects / param-cleanup), but they
  // DO change the page under any stranded layer and skip onNavPushed — so sweep
  // there too. Guard with `!active` via sweepOrphans so a replaceState fired
  // mid-transition (rare) doesn't rip a legitimately-running animation's layers.
  const onNavReplaced = (): void => {
    sweepOrphans();
  };

  const onNavPushed = (fromPath: string): void => {
    // Read-once flags FIRST so no pushState can leave them stale for a later
    // unrelated navigation.
    const gestureNav = consumeGestureNav();
    const popNav = consumePopNav();
    // Any new navigation immediately finalizes an in-flight transition —
    // rapid-fire taps can never stack layers or double-transform <main>.
    active?.finalize();
    // Then sweep anything a PREVIOUS transition/gesture left behind (runs
    // before play* mounts this navigation's own layers). On gesture-committed
    // navs the swipe already cleared <main> before goBack(), and its peek
    // layer's deferred unmount is null-safe — removing it here early is fine.
    sweepOrphans();
    if (gestureNav) return; // the swipe gesture already animated this nav
    if (reduceMotion.matches) return;
    if (!viewportState.isMobile) return; // tablet/desktop layout inside Tauri
    const toPath = window.location.pathname;
    if (fromPath === toPath) return; // shallow/query-only pushState
    const fromSegs = fromPath.split("/").filter(Boolean);
    const toSegs = toPath.split("/").filter(Boolean);
    // Only within the same workspace shell — workspace switches, login
    // bounces, etc. land instantly.
    if (fromSegs[0] !== "workspace" || toSegs[0] !== "workspace") return;
    if (!fromSegs[1] || fromSegs[1] !== toSegs[1]) return;
    const fromDetail = isDetailPath(fromPath);
    const toDetail = isDetailPath(toPath);
    if (popNav) {
      // Back-button pop (goBackFromConversation marks it) — reverse animation.
      if (fromDetail && !toDetail) playPop();
      return;
    }
    if (!fromDetail && toDetail) {
      // List → detail push, but ONLY when a user gesture drove it — deep
      // links / restores / programmatic redirects must land instantly.
      if (Date.now() - lastGestureAt > GESTURE_RECENCY_MS) return;
      playPush();
    }
    // Everything else (list→list = tab switch, detail→detail, detail→list
    // without a back button) is instant — iOS-correct for tabs, and pops are
    // only ever animated for the explicit back affordances.
  };

  setNavPushListener(onNavPushed);
  setNavReplaceListener(onNavReplaced);
  // Capture-phase so no stopPropagation in the app can hide a real gesture.
  window.addEventListener("click", onUserGesture, true);
  window.addEventListener("touchend", onUserGesture, { capture: true, passive: true });
  // Interrupts: a finger down mid-transition (incl. one starting an edge
  // swipe) or a history pop finalizes instantly — no stuck clone layers.
  window.addEventListener("touchstart", onInterrupt, { capture: true, passive: true });
  window.addEventListener("popstate", onPopState);
  // Wall-clock lifetime watchdog: removes any push/pop layer that outlived its
  // transition no matter what skipped its finalize (needs no nav/touch to fire).
  const watchdog = window.setInterval(sweepStaleLayers, WATCHDOG_INTERVAL_MS);

  return () => {
    setNavPushListener(null);
    setNavReplaceListener(null);
    window.removeEventListener("click", onUserGesture, true);
    window.removeEventListener("touchend", onUserGesture, { capture: true });
    window.removeEventListener("touchstart", onInterrupt, { capture: true });
    window.removeEventListener("popstate", onPopState);
    window.clearInterval(watchdog);
    active?.finalize();
  };
}

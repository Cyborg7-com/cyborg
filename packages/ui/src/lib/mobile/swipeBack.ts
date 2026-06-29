/**
 * iOS-style edge-swipe-back gesture with a previous-page peek backdrop
 * (Caveats #21, #22, #23). RE-APPLY-IN-UI port of v1's `mobile/+layout.svelte`
 * swipe-back section, remapped to the rewrite's route shapes.
 *
 * WHY this exists: WKWebView's native `allowsBackForwardNavigationGestures`
 * only triggers on real page navigations — SvelteKit's client-side router
 * doesn't get it for free, and even when it does the UX is a plain snap-and-pop.
 * We mirror Slack / WhatsApp / iMessage: as the user drags from the left edge,
 * the page content (`<main>`) translates right under their finger over a
 * dimmed clone of the previous page, and on release past the threshold it
 * glides the rest of the way out before navigating to the computed parent
 * route. Below threshold it springs back to zero.
 *
 * INSTALL: call `installSwipeBack()` once on mount (gated on `isTauriIOS()`)
 * and invoke the returned cleanup on destroy. It is a no-op on SSR.
 *
 * Three load-bearing caveats are encoded here:
 *  - #21: `history.back()` is unreliable (deep-link / replaceState / reload
 *    leave unrelated entries on the stack), so the parent route is computed
 *    explicitly per route shape via `computeBackTarget`.
 *  - #22: the peek snapshot is captured by wrapping `history.pushState` /
 *    `replaceState` (the only hook that reliably runs BEFORE the URL changes
 *    on iOS prod builds) and stashed in the standalone `peekState` module.
 *  - #23: the peek layer is `position: absolute` (NOT fixed) inside the
 *    root's GPU-layered container, and `<main>`'s transform is written
 *    imperatively (never via a reactive `style:` directive) so 60fps drag
 *    updates aren't clobbered by Svelte re-renders. Padding/layout that the
 *    page needs is toggled with a CLASS, not an inline `style:` write.
 */

import { goto } from "$app/navigation";
import { threadState, closeThread } from "$lib/state/app.svelte";
import { haptic } from "./haptics";
import { setNativeVisibility } from "./nativeComposer";
import { peekNavOrigin } from "./navOrigin";
import {
  bumpCaptureCount,
  getLastPageNode,
  setLastCaptureResult,
  setLastPageNode,
} from "./peekState";

// Gesture geometry (matches v1 tuning).
const EDGE_PX = 25; // left-edge band the drag must start inside
const TRIGGER_PX = 80; // min horizontal travel to commit on a flick
const MAX_VERT = 60; // max vertical drift for a flick to still count
const MAX_MS = 600; // flick time budget (distance path only — velocity supersedes)
const PEEK_ID = "swipe-peek-layer";

// Release physics (P2): a rightward flick faster than this at touch-lift
// commits the swipe even when the finger never crossed TRIGGER_PX — Apple's
// UIScreenEdgePanGestureRecognizer behaves the same. Velocity is measured over
// the trailing VELOCITY_WINDOW_MS of (x, t) samples so a drag-then-pause-then-
// release reads ~0 (cancel), while a true flick reads its instantaneous speed.
const VELOCITY_COMMIT = 0.5; // px/ms rightward at release
const VELOCITY_WINDOW_MS = 100; // trailing sample window for release velocity
const VELOCITY_MIN_DX = 8; // a flick still needs SOME horizontal travel
// Underlay parallax (P2): the peek backdrop starts shifted left by this much
// and approaches 0 proportionally with drag progress (iMessage/UIKit pop).
const PARALLAX_PCT = 30;
const PEEK_DIM_OPACITY = 0.85; // resting dim of the underlay (pre-existing value)
// Release animations use Apple's nav spring curve (P0 token, with fallback so
// the inline transition still animates if the token is ever absent).
const SPRING_EASE = "var(--ease-spring, cubic-bezier(0.32, 0.72, 0, 1))";

/**
 * Marker attribute carried by EVERY snapshot layer (the swipe peek backdrop and
 * pushTransition's underlay/overlay). `findLiveMain` skips any <main> inside a
 * marked layer, so a mounted snapshot clone can never be mistaken for the live
 * page (the v1 "swipe shows no movement" bug, generalized to all layers).
 */
export const SNAPSHOT_LAYER_ATTR = "data-page-snapshot-layer";

/**
 * The FIRST <main> in document order that is NOT inside a snapshot layer.
 * Module-level (shared with pushTransition.ts) — a naive
 * `document.querySelector('main')` would return a mounted clone once any
 * snapshot layer is in the DOM, and we'd animate the backdrop instead of the
 * live page.
 */
export function findLiveMain(): HTMLElement | null {
  const all = document.querySelectorAll("main");
  for (const el of all) {
    if (!el.closest(`[${SNAPSHOT_LAYER_ATTR}]`)) return el as HTMLElement;
  }
  return null;
}

/**
 * Pin a snapshot layer to exactly the live <main>'s offset box (see the long
 * geometry note in installSwipeBack's mountPeekBackdrop — the shell chrome
 * lives OUTSIDE <main>, so the layer must cover <main>'s box, not the shell).
 * Shared with pushTransition.ts.
 */
export function positionLayerOverMain(layer: HTMLElement, main: HTMLElement): void {
  layer.style.top = `${main.offsetTop}px`;
  layer.style.left = `${main.offsetLeft}px`;
  layer.style.width = `${main.offsetWidth}px`;
  layer.style.height = `${main.offsetHeight}px`;
  layer.style.right = "auto";
  layer.style.bottom = "auto";
}

/**
 * Mount a fresh clone of a captured page snapshot into a layer. Re-clones so
 * the cached peekState node stays reusable for later swipes/transitions, and
 * pins the clone `absolute; inset: 0` so its percentage-height descendants
 * resolve against a definite box (the detached-clone sidebar-collapse bug —
 * see the long note at the original call site). Shared with pushTransition.ts.
 */
export function mountSnapshotInLayer(layer: HTMLElement, node: HTMLElement): void {
  layer.innerHTML = "";
  const clone = node.cloneNode(true);
  if (clone instanceof HTMLElement) {
    // Strip any transient transform/opacity/etc. the source <main> may have
    // carried at capture time (a snapshot taken DURING a push transition clones
    // a <main> parked at translateX(100%)/opacity inline — capturePreviousPage
    // already strips these, but a replaceState re-capture or a future caller
    // might not). A clone that kept them would mount shifted off-screen or
    // invisible — the layer would be present but paint nothing, or paint in the
    // wrong place. Belt-and-suspenders so the snapshot ALWAYS overlays 1:1.
    clone.style.transition = "";
    clone.style.transform = "";
    clone.style.opacity = "";
    clone.style.willChange = "";
    clone.style.zIndex = "";
    clone.style.position = "absolute";
    clone.style.inset = "0";
  }
  layer.appendChild(clone);
}

// ── Push/pop-transition coordination (consumed by pushTransition.ts) ───────
// The push/pop nav transition must NOT replay an animation for a navigation the
// swipe gesture already animated, and must ONLY play a pop for back-BUTTON
// navigations. Both facts are known here, so they're recorded here and consumed
// (read-once, time-bounded so a failed goto can't leave a stale flag) by the
// pushTransition pushState listener. Plain module state — same singleton rule
// as peekState/navOrigin.
const NAV_MARK_TTL_MS = 5000;
let gestureNavMarkedAt = 0;
let popNavMarkedAt = 0;

function markGestureNav(): void {
  gestureNavMarkedAt = Date.now();
}
function markPopNav(): void {
  popNavMarkedAt = Date.now();
}

/** Read-once: was the navigation now being processed committed by the swipe gesture? */
export function consumeGestureNav(): boolean {
  const hit = gestureNavMarkedAt > 0 && Date.now() - gestureNavMarkedAt < NAV_MARK_TTL_MS;
  gestureNavMarkedAt = 0;
  return hit;
}

/** Read-once: was the navigation now being processed a back-button pop? */
export function consumePopNav(): boolean {
  const hit = popNavMarkedAt > 0 && Date.now() - popNavMarkedAt < NAV_MARK_TTL_MS;
  popNavMarkedAt = 0;
  return hit;
}

// Post-pushState notification hook. The wrapper installed by installSwipeBack
// (the ONE reliable pre-URL-change hook — Caveat #22) calls this after the URL
// has updated, passing the pre-navigation pathname. pushTransition.ts registers
// here instead of double-wrapping history.pushState.
type NavPushListener = (fromPath: string) => void;
let navPushListener: NavPushListener | null = null;
export function setNavPushListener(fn: NavPushListener | null): void {
  navPushListener = fn;
}

// Post-replaceState notification hook (defense-in-depth for the chat-mixing
// incident). replaceState navs DELIBERATELY never animate a push/pop (redirects,
// param-cleanup, the details→channel desktop bounce), so they don't go through
// navPushListener. But a replaceState still CHANGES the page under any snapshot
// layer that an earlier transition somehow stranded — and because it skips the
// push listener, nothing else would sweep it. pushTransition.ts registers here
// to run its orphan sweep on every replaceState too, closing that hole without
// ever triggering an animation.
type NavReplaceListener = () => void;
let navReplaceListener: NavReplaceListener | null = null;
export function setNavReplaceListener(fn: NavReplaceListener | null): void {
  navReplaceListener = fn;
}

/**
 * Where should the back gesture land? `history.back()` is unreliable for routes
 * reached via a notification deep-link, a `goto({ replaceState: true })`, or a
 * hard reload — the back-stack entry is then some unrelated screen. We compute
 * the parent route explicitly so the swipe always lands one level up in the
 * route hierarchy, never further back. The query string is preserved.
 *
 * Rewrite route shapes (A5/A6):
 *   /workspace/<ws>/channel/<id>      → channel list root  /workspace/<ws>
 *   /workspace/<ws>/channel/<id>/details → its conversation /workspace/<ws>/channel/<id>
 *   /workspace/<ws>/dm/<id>           → workspace root      /workspace/<ws>
 *   /workspace/<ws>/agent/<id>        → agents list         /workspace/<ws>/agents
 *   /workspace/<ws>/agent/new         → agents list         /workspace/<ws>/agents
 *   /workspace/<ws>/cybos/<id>        → cybos list          /workspace/<ws>/cybos
 *   /workspace/<ws>/daemons/<id>      → daemons list        /workspace/<ws>/daemons
 *   /workspace/<ws>/tasks/<id>        → tasks list          /workspace/<ws>/tasks
 *   /workspace/<ws>/terminal/<id>     → recorded origin, or workspace root /workspace/<ws>
 *   /workspace/<ws>/settings/<sub>    → settings root       /workspace/<ws>/settings
 *   (threads are an OVERLAY with no route — handled separately, see below)
 *
 * Returns "" when no parent can be inferred (caller falls back to history.back).
 */
export function computeBackTarget(pathname?: string, search?: string): string {
  const url = typeof window !== "undefined" ? new URL(window.location.href) : null;
  const path = pathname ?? url?.pathname ?? "";
  const qs = search ?? url?.search ?? "";
  const segs = path.split("/").filter(Boolean);

  // Everything lives under /workspace/<ws>/…
  if (segs[0] !== "workspace" || segs.length < 2) return "";
  const wsRoot = `/workspace/${segs[1]}`;

  // /workspace/<ws>  (already at the root) — nothing above it.
  if (segs.length === 2) return "";

  // segs[2] = section, segs.slice(3) = the segments after the section name.
  return sectionBackTarget(segs[2], segs.slice(3), wsRoot, qs);
}

// Origin-aware back target for a conversation detail page. The static parent
// (channel→/chats, dm→/dms, agent→/agents) is correct only when the user
// navigated there via the matching list — but a DM opened from the CHATS tab
// must return to /chats, not /dms. We prefer the recorded origin (the list the
// conversation was actually opened from) when it points inside this workspace,
// and fall back to the static parent otherwise (deep-link, reload, no origin).
// peekNavOrigin (a NON-consuming read) is used because this runs repeatedly
// during the drag — clearing it mid-gesture would break later frames.
function conversationBackTarget(staticParent: string, wsRoot: string): string {
  const origin = peekNavOrigin();
  if (origin && origin.startsWith(wsRoot)) return origin;
  return staticParent;
}

// Maps a workspace section (+ the path segments after it) to its swipe-back
// parent. `rest` = segments after the section name; "" = no inferable parent.
function sectionBackTarget(section: string, rest: string[], wsRoot: string, qs: string): string {
  switch (section) {
    // A channel conversation belongs to the Chats list (W2) and a human DM to
    // the DMs list (W3) — swipe-back returns to that list (or the recorded
    // origin when the conversation was opened from another tab). The list tab
    // itself is a ROOT pane with NO back target — terminal for the gesture
    // (matching v1), so the hierarchy stops at: channel → /chats (terminal).
    case "channel":
      // P5: the channel DETAILS page (/channel/<id>/details) pops to its own
      // conversation, NOT the chats list — one level up in the visual stack.
      // The recorded nav origin is deliberately not consulted here (it points
      // at the LIST the conversation was opened from; the conversation itself
      // is this page's parent). NOTE: pushTransition.ts classifies both routes
      // as detail paths, so channel→details (and the pop back) is detail→detail
      // = instant, by design — only the edge-swipe animates this pop.
      if (rest.length >= 2 && rest[1] === "details") {
        return `${wsRoot}/channel/${rest[0]}${qs}`;
      }
      return rest.length >= 1 ? conversationBackTarget(`${wsRoot}/chats${qs}`, wsRoot) : "";
    case "dm":
      return rest.length >= 1 ? conversationBackTarget(`${wsRoot}/dms${qs}`, wsRoot) : "";
    // Agent detail (or /agent/new) → the Agents list, or the recorded origin
    // when the agent conversation was opened from another list (e.g. Chats).
    case "agent":
      return rest.length >= 1 ? conversationBackTarget(`${wsRoot}/agents${qs}`, wsRoot) : "";
    // A terminal session is a full-screen detail route opened from a list (the
    // Terminals sidebar group, the agent launcher, or a DM). It has no dedicated
    // list tab, so it pops to the recorded origin (the list it was opened from)
    // when that points inside this workspace, falling back to the workspace root.
    case "terminal":
      return rest.length >= 1 ? conversationBackTarget(wsRoot + qs, wsRoot) : "";

    // NOTE: `chats` and `dms` are deliberately NOT special-cased. They are root
    // tabs (defined in MobileNav.svelte) and must be TERMINAL for the gesture —
    // giving them a parent (the workspace root) let the edge-swipe pop them to
    // /workspace/<ws>, which auto-redirects to the last channel and produced an
    // infinite chats ⇄ channel ping-pong (issue #2). They fall through to
    // `default`, which returns "" for a bare single-segment section
    // (rest.length === 0) — un-swipeable, exactly like v1.

    // List-with-detail sections (cybos/daemons/tasks, settings subpages, and any
    // future /<section>/<id> detail) → their own list root. `${wsRoot}/${section}`
    // is identical to an explicit per-section case. A bare single-level section
    // (/workspace/<ws>/activity, /home, …) is a top-level pane with no parent.
    default:
      return rest.length >= 1 ? `${wsRoot}/${section}${qs}` : "";
  }
}

/**
 * Imperative back-navigation for the conversation header's back button (mobile).
 * Uses the same origin-aware `computeBackTarget()` as the edge-swipe so the
 * button and the gesture always land in the same place; falls back to
 * `history.back()` only when no parent can be inferred.
 */
export function goBackFromConversation(): void {
  const target = computeBackTarget();
  if (target) {
    // Mark the upcoming pushState as a back-button POP so pushTransition.ts
    // plays the reverse (pop) animation for it. The history.back() fallback
    // navigates via popstate (no pushState), so it is never animated.
    markPopNav();
    void goto(target);
  } else if (typeof history !== "undefined") history.back();
}

/**
 * Is the current route a DETAIL page the edge-swipe is allowed to fire on?
 *
 * This is an explicit path-shape allow-list (mirroring v1's `isOnDetailPage`)
 * rather than `computeBackTarget() !== ""`. v1 kept these two checks INDEPENDENT
 * on purpose: deriving the swipe gate from the back-target map is exactly what
 * regressed in v2 — once `chats`/`dms` were (wrongly) given a back target, the
 * gate auto-unlocked the gesture on those ROOT tabs and produced issue #2's
 * infinite swipe-back. With a structural allow-list, no future back-target
 * entry can re-couple a root tab into being swipeable.
 *
 * A page qualifies only when it is an actual conversation/detail route under the
 * workspace — i.e. it carries a detail segment AFTER the section name:
 *   /workspace/<ws>/channel/<id>   (segs > 3)
 *   /workspace/<ws>/dm/<id>        (segs > 3)
 *   /workspace/<ws>/agent/<id|new> (segs > 3)
 *   /workspace/<ws>/cybos/<id>     (segs > 3)
 *   /workspace/<ws>/daemons/<id>   (segs > 3)
 *   /workspace/<ws>/tasks/<id>     (segs > 3)
 *   /workspace/<ws>/terminal/<id>  (segs > 3)
 *   /workspace/<ws>/settings/<sub> (segs > 3)
 * The bare list/tab roots (/workspace/<ws>, /workspace/<ws>/chats,
 * /workspace/<ws>/dms, /workspace/<ws>/home, /workspace/<ws>/activity, …) all
 * have segs === 3 (or 2) and therefore FAIL this test — the gesture is a no-op
 * on every root tab, exactly like v1. An open thread overlay also qualifies.
 */
const DETAIL_SECTIONS = new Set([
  "channel",
  "dm",
  "agent",
  "cybos",
  "daemons",
  "tasks",
  "terminal",
  "settings",
]);
/**
 * Structural detail-page test for an arbitrary pathname — the same allow-list
 * shape check the gesture gate uses, parameterized so pushTransition.ts can
 * classify its from/to routes with IDENTICAL semantics (one source of truth,
 * no re-derived route map). Must be /workspace/<ws>/<section>/<detail…> — a
 * detail segment after the section name is REQUIRED, so bare roots
 * (segs.length <= 3) never qualify.
 */
export function isDetailPath(path: string): boolean {
  const segs = path.split("/").filter(Boolean);
  if (segs[0] !== "workspace" || segs.length <= 3) return false;
  return DETAIL_SECTIONS.has(segs[2]);
}
function isOnDetailPage(): boolean {
  if (isThreadOpen()) return true;
  return isDetailPath(typeof window !== "undefined" ? window.location.pathname : "");
}

// ── Thread overlay (no route) ─────────────────────────────────────────────
// Threads are an absolutely-positioned <aside> overlay keyed by root id, not a
// SvelteKit route (A5). When the overlay is up the edge-swipe belongs to IT —
// committing should dismiss the thread, NOT route-pop the underlying channel/dm
// (which would skip the thread and feel broken).
//
// Detection + dismissal are driven by the shared thread STATE, not the DOM: a
// thread overlay is open iff `threadState.parentId != null`, and dismissing it
// is the exported `closeThread()` (which runs `threadState.close()` — the same
// onclose pipeline the panel's own close button invokes). This is the
// authoritative signal; an aria-label rename can no longer silently degrade
// thread-aware swipe into a route-pop. The DOM close button is kept ONLY as a
// last-ditch fallback in case the state import is unavailable (e.g. a build/
// bundling edge case), so the gesture never hard-fails.
function threadCloseButton(): HTMLButtonElement | null {
  return document.querySelector(
    'aside button[aria-label="Close thread"]',
  ) as HTMLButtonElement | null;
}
function isThreadOpen(): boolean {
  // Prefer the real state field; fall back to the DOM affordance only if the
  // state import didn't resolve.
  if (threadState != null) return threadState.parentId != null;
  return threadCloseButton() !== null;
}
function closeOpenThread(): boolean {
  // Drive the real close-thread function so its onclose pipeline fires (state
  // cleanup, cursor freeze, etc.) — identical to clicking the panel's own close
  // button, but decoupled from the DOM.
  if (typeof closeThread === "function") {
    closeThread();
    return true;
  }
  // Fallback: the state import was somehow unavailable — click the component's
  // own close button (its onclose pipeline still fires) rather than no-op.
  const btn = threadCloseButton();
  if (!btn) return false;
  btn.click();
  return true;
}

export function installSwipeBack(): () => void {
  if (typeof window === "undefined") return () => {};

  let edgeStartX = -1;
  let edgeStartY = 0;
  let edgeStartT = 0;
  let swipeActive = false;
  // True when the swipe began while the thread overlay was up: on commit we
  // dismiss the overlay instead of route-popping to the channel/dm.
  let swipeOwnedByThread = false;

  // Release-physics state (P2). `samples` is a small ring buffer of (x, t)
  // touch samples; `releaseVelocity` (px/ms, rightward-positive) is computed
  // from its trailing VELOCITY_WINDOW_MS at touchend. `lastDx` is the final
  // drag distance, feeding the remaining-distance/velocity duration scaling of
  // the release animations. `gestureWidth` caches window.innerWidth at
  // touchstart so the per-frame parallax never reads layout mid-drag.
  let samples: { x: number; t: number }[] = [];
  let lastDx = 0;
  let releaseVelocity = 0;
  let gestureWidth = 0;

  // The live <main> is pinned at touchstart (before the peek mounts a cloned
  // <main> earlier in DOM order) — see the module-level findLiveMain note.
  let liveMain: HTMLElement | null = null;
  const getMain = (): HTMLElement | null => liveMain ?? findLiveMain();

  const goBack = () => {
    // Tell pushTransition this navigation was committed by the gesture (the
    // swipe IS the animation — replaying a pop on top of it would double-move
    // the page). history.back() never reaches pushState, so only goto needs it.
    markGestureNav();
    const target = computeBackTarget();
    if (target) void goto(target);
    else history.back();
  };

  // ── Peek snapshot capture (Caveat #22) ──────────────────────────────────
  const capturePreviousPage = () => {
    bumpCaptureCount();
    const main = findLiveMain();
    setLastCaptureResult(main ? "found" : "null");
    if (!main) return;
    // Clone the whole <main> (classes + inline styles + children) so the
    // snapshot keeps its original layout.
    const cloned = main.cloneNode(true) as HTMLElement;
    // cloneNode duplicates `id`s — invalid once mounted alongside the live DOM.
    if (cloned.id) cloned.removeAttribute("id");
    for (const el of cloned.querySelectorAll("[id]")) el.removeAttribute("id");
    // Strip any transient swipe styling left on the source from a prior drag.
    cloned.style.transform = "";
    cloned.style.opacity = "";
    cloned.style.transition = "";
    cloned.style.position = "";
    cloned.style.zIndex = "";
    cloned.style.willChange = "";
    setLastPageNode(cloned);
  };

  // ── Peek layer mount / unmount (Caveat #23) ─────────────────────────────
  // The snapshot we clone is the live <main> ONLY — the page content. The
  // shell chrome (safe-area top bar + TrialBar above <main>, MobileNav below)
  // lives OUTSIDE <main> as sibling flex rows, so the live page content does
  // NOT start at the top of the screen: it begins below the status-bar-aware
  // top bar (`padding-top: var(--sat); height: calc(2.75rem + var(--sat))`).
  // If the peek layer is pinned to `top:0 … bottom:0` of the shell container it
  // fills the WHOLE shell (starting under the status bar), so the cloned page
  // content renders ~(top bar + safe-area + TrialBar) too HIGH — its header
  // collides with the status-bar clock and overlaps the live page (the bug).
  // Position the layer to exactly the live <main>'s box instead (module-level
  // positionLayerOverMain), so the clone overlays the live page 1:1 (top bars
  // coincide, no status-bar overlap). We read <main>'s offset geometry relative
  // to its offsetParent — which is `main.parentElement` once we pin it
  // `position: relative` below, the same containing block the absolute peek
  // layer resolves against — so this is correct regardless of top-bar height,
  // safe-area inset, TrialBar presence, or the `.drag-region` collapse.
  //
  // The mounted layer element is CACHED for the duration of the gesture so the
  // per-frame parallax write never pays a getElementById.
  let peekLayerEl: HTMLDivElement | null = null;

  const mountPeekBackdrop = () => {
    const node = getLastPageNode();
    if (!node) return;
    let layer = document.getElementById(PEEK_ID) as HTMLDivElement | null;
    const main = getMain();
    if (!layer) {
      layer = document.createElement("div");
      layer.id = PEEK_ID;
      layer.setAttribute(SNAPSHOT_LAYER_ATTR, "");
      // `position: absolute` (NOT `fixed`) intentionally — the iOS keyboard
      // fix puts the root container on its own GPU layer (a CSS transform /
      // `position: fixed; inset:0` containing block), which TRAPS any
      // descendant `position: fixed` on WKWebView so the peek renders behind
      // the live page but the compositor never exposes it during the swipe.
      // Absolute positioning inside the (viewport-sized, fixed) root fills the
      // same visual rect without fighting the GPU layer. top/left/width/height
      // are set per-mount to the live <main>'s box (positionLayerOverMain).
      layer.style.cssText = [
        "position: absolute",
        "top: 0",
        "left: 0",
        "z-index: 0",
        "pointer-events: none",
        "overflow: hidden",
        "background-color: var(--bg-base, #1c1d21)",
        "display: flex",
        "flex-direction: column",
      ].join("; ");
      if (main && main.parentElement) {
        // Sibling immediately before <main>, inside <main>'s parent. The parent
        // is a viewport-sized flex container under the fixed root. Pin it as the
        // containing block + lift <main> above the layer.
        main.parentElement.style.position = main.parentElement.style.position || "relative";
        main.parentElement.insertBefore(layer, main);
        main.style.position = "relative";
        main.style.zIndex = "10";
      } else {
        document.body.appendChild(layer);
      }
    }
    // Align the layer to the live <main>'s box EVERY mount — <main> must be
    // `position: relative` first so its offsetParent is the shell container the
    // absolute layer resolves against, and so the geometry reflects any chrome
    // change (e.g. TrialBar appearing) since the last swipe.
    if (main) {
      main.style.position = "relative";
      main.style.zIndex = "10";
      positionLayerOverMain(layer, main);
    }
    // Parallax rest state (P2): the underlay sits PARALLAX_PCT left of home and
    // slightly dimmed (the pre-existing 0.85 — iMessage), approaching 0 / 1 as
    // the drag progresses (applySwipe). Set per-mount so a reused layer never
    // inherits a committed gesture's end state, and clear any release
    // transition left from a prior animation.
    layer.style.transition = "";
    layer.style.transform = `translate3d(-${PARALLAX_PCT}%, 0, 0)`;
    layer.style.opacity = String(PEEK_DIM_OPACITY);
    // Re-clone so the cached node can be re-mounted on a later swipe. The clone
    // is pinned absolute/inset:0 inside the layer (mountSnapshotInLayer) so its
    // percentage-height descendants resolve against a definite box — without it
    // the cloned sidebar collapses to content height and its `mt-auto` footer
    // ("Invite Agents"/"Invite Humans") floats up under the DM list for the
    // whole swipe (#16 — visible ONLY during the gesture).
    mountSnapshotInLayer(layer, node);
    layer.style.display = "";
    peekLayerEl = layer;
  };

  const unmountPeekBackdrop = () => {
    const layer = document.getElementById(PEEK_ID);
    if (layer) layer.remove();
    peekLayerEl = null;
    const main = getMain();
    if (main) {
      main.style.zIndex = "";
      main.style.position = "";
    }
  };

  // ── Per-frame transform (imperative — Caveat #23) ───────────────────────
  const applySwipe = (dx: number) => {
    const main = getMain();
    if (!main) return;
    // `will-change: transform` promotes <main> to its own compositor layer for
    // the gesture so WebKit doesn't fight the parent's GPU layer.
    if (!main.style.willChange) main.style.willChange = "transform";
    main.style.transition = "";
    main.style.transform = `translate3d(${Math.max(0, dx)}px, 0, 0)`;
    // Subtle fade as the page slides — matches iMessage.
    const op = 1 - Math.min(dx / 600, 0.2);
    main.style.opacity = String(op);
    // Underlay parallax (P2): drive the peek backdrop from -PARALLAX_PCT% → 0
    // and its dim from 0.85 → 1 proportionally to drag progress. Same
    // imperative-write discipline as the <main> transform above — one inline
    // style write per touchmove frame, never a reactive `style:` directive.
    const layer = peekLayerEl;
    if (layer) {
      const p = Math.min(Math.max(dx, 0) / (gestureWidth || window.innerWidth), 1);
      layer.style.transform = `translate3d(${(-PARALLAX_PCT * (1 - p)).toFixed(2)}%, 0, 0)`;
      layer.style.opacity = (PEEK_DIM_OPACITY + (1 - PEEK_DIM_OPACITY) * p).toFixed(3);
    }
  };

  const resetSwipe = (animated: boolean) => {
    // Bring the native composer pill back — we hid it at swipe-begin while the
    // page was sliding under the finger. `resetSwipe` is the cancel / spring-
    // back path (the gesture did NOT commit, so the chat page is staying
    // mounted) — flip isHidden back on. The committed back navigation goes
    // through `finishSwipeOut`, which intentionally does NOT call this and
    // leaves the pill hidden so Swift's URL-KVO re-evaluates it after the route
    // change. Safe to call unconditionally: if the pill was never hidden (a
    // thread-owned swipe, where the underlying chat page never moved), this is
    // a no-op isHidden=false on an already-visible pill.
    void setNativeVisibility(true);
    const main = getMain();
    if (!main) return;
    // Spring the page home with Apple's nav curve; duration scales mildly with
    // how far the finger got so a barely-armed cancel snaps and a deep cancel
    // glides (P2 release physics).
    const dur = Math.round(Math.min(Math.max(lastDx * 0.55, 160), 300));
    const layer = peekLayerEl;
    main.style.transition = animated
      ? `transform ${dur}ms ${SPRING_EASE}, opacity ${dur}ms ${SPRING_EASE}`
      : "";
    if (layer) {
      layer.style.transition = animated
        ? `transform ${dur}ms ${SPRING_EASE}, opacity ${dur}ms ${SPRING_EASE}`
        : "";
    }
    // iOS WebKit needs a layout flush between the transition + transform writes
    // or the spring-back jumps without animating. Reading offsetWidth forces it.
    if (animated) void main.offsetWidth;
    main.style.transform = "";
    main.style.opacity = "";
    main.style.willChange = "";
    // Return the underlay to its parallax rest state in step with the page.
    if (layer) {
      layer.style.transform = `translate3d(-${PARALLAX_PCT}%, 0, 0)`;
      layer.style.opacity = String(PEEK_DIM_OPACITY);
    }
    // Drop the live-main pin synchronously — the spring-back animation already
    // captured `main` in this closure, so the next gesture can re-pin in
    // touchstart without racing a deferred clear.
    liveMain = null;
    if (animated) window.setTimeout(unmountPeekBackdrop, dur + 20);
    else unmountPeekBackdrop();
  };

  const finishSwipeOut = () => {
    // Single commit haptic (P2) — fires exactly once per committed gesture,
    // before either commit flavor (thread dismiss or route pop) proceeds.
    haptic("light");
    // If the thread overlay owned the swipe, dismiss it and skip the route-pop
    // + slide (the overlay is portaled on top; there's no underlying page to
    // slide out from under it).
    if (swipeOwnedByThread) {
      swipeOwnedByThread = false;
      resetSwipe(true);
      closeOpenThread();
      return;
    }
    const main = getMain();
    if (!main) {
      goBack();
      return;
    }
    const w = window.innerWidth;
    // Carry the finger's momentum into the slide-out (P2): duration = remaining
    // distance / release velocity, clamped so a slow midpoint commit still
    // completes briskly and a violent flick doesn't strobe. Floor the velocity
    // so the distance/midpoint commit paths (release velocity ~0) get a sane
    // base speed.
    const remaining = Math.max(40, w - lastDx);
    const v = Math.max(releaseVelocity, 0.55);
    const dur = Math.round(Math.min(Math.max(remaining / v, 120), 340));
    const layer = peekLayerEl;
    // Force a reflow between setting the transition and the new transform — iOS
    // WebKit can batch both writes in one synchronous block and skip the
    // animation (transform jumps straight to the end value). Reading
    // offsetWidth commits the transition first.
    main.style.transition = `transform ${dur}ms ${SPRING_EASE}, opacity ${dur}ms ${SPRING_EASE}`;
    if (layer) {
      layer.style.transition = `transform ${dur}ms ${SPRING_EASE}, opacity ${dur}ms ${SPRING_EASE}`;
    }
    void main.offsetWidth;
    main.style.transform = `translate3d(${w}px, 0, 0)`;
    main.style.opacity = "0";
    // The underlay finishes its parallax run to home position, fully lit.
    if (layer) {
      layer.style.transform = "translate3d(0, 0, 0)";
      layer.style.opacity = "1";
    }
    // Drop the live-main pin synchronously (slide-out owns `main` via closure
    // capture) so the next gesture can re-pin without racing this cleanup.
    liveMain = null;
    // Wait for the slide to finish, THEN navigate, THEN clear the inline styles
    // so the incoming page renders from the correct position. The snapshot
    // stays mounted through the nav so the real previous page can render over
    // it without a flash.
    window.setTimeout(() => {
      main.style.transition = "";
      main.style.transform = "";
      main.style.opacity = "";
      main.style.willChange = "";
      goBack();
      window.setTimeout(unmountPeekBackdrop, 60);
    }, dur);
  };

  // ── Capture hooks (Caveat #22) ──────────────────────────────────────────
  // Strongest hook: wrap `history.pushState`/`replaceState`. SvelteKit's router
  // calls pushState for every client-side navigation (including programmatic
  // `goto()`), guaranteeing the snapshot is taken BEFORE the URL updates —
  // unlike `beforeNavigate`/click handlers, which on iOS prod builds didn't
  // reach the capture in time (`captures=0`). Keep references to restore on
  // teardown so re-init (HMR) doesn't stack wrappers.
  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
    let fromPath = "";
    try {
      fromPath = window.location.pathname;
      capturePreviousPage();
    } catch {
      /* never let the snapshot break navigation */
    }
    const result = origPushState(...args);
    // Notify pushTransition AFTER the URL has changed (it reads the new
    // location itself and gets the pre-nav path as an argument). Errors in the
    // listener must never break navigation. replaceState deliberately does NOT
    // notify — redirects/param-cleanup must never animate.
    if (navPushListener) {
      try {
        navPushListener(fromPath);
      } catch {
        /* */
      }
    }
    return result;
  };
  history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
    try {
      capturePreviousPage();
    } catch {
      /* */
    }
    const result = origReplaceState(...args);
    // Notify pushTransition AFTER the URL changed so it can sweep any stranded
    // snapshot layer (defense-in-depth — replaceState never animates). Errors in
    // the listener must never break navigation.
    if (navReplaceListener) {
      try {
        navReplaceListener();
      } catch {
        /* */
      }
    }
    return result;
  };

  // Belt-and-suspenders: also snapshot on internal <a> clicks (capture phase).
  const onAnchorClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    const a = t?.closest("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (/^(https?:|mailto:|tel:)/i.test(href)) return;
    capturePreviousPage();
  };
  document.addEventListener("click", onAnchorClick, true);

  // ── Touch gesture ───────────────────────────────────────────────────────
  const onTouchStart = (e: TouchEvent) => {
    swipeActive = false;
    const t = e.touches[0];
    if (!isOnDetailPage()) {
      edgeStartX = -1;
      return;
    }
    if (!t || t.clientX > EDGE_PX) {
      edgeStartX = -1;
      return;
    }
    // If the thread overlay is up, the gesture belongs to it.
    swipeOwnedByThread = isThreadOpen();
    edgeStartX = t.clientX;
    edgeStartY = t.clientY;
    edgeStartT = Date.now();
    // Seed the velocity ring buffer + reset the release-physics state, and
    // cache the viewport width so the per-frame parallax never reads layout.
    samples = [{ x: t.clientX, t: edgeStartT }];
    lastDx = 0;
    releaseVelocity = 0;
    gestureWidth = window.innerWidth;
    // Pin the live <main> NOW, before the peek mounts a cloned <main> earlier
    // in DOM order.
    liveMain = findLiveMain();
  };

  const onTouchMove = (e: TouchEvent) => {
    if (edgeStartX < 0) return;
    const t = e.touches[0];
    if (!t) return;
    const dx = t.clientX - edgeStartX;
    const dy = Math.abs(t.clientY - edgeStartY);
    // Velocity ring buffer (P2): record (x, t) per move; capped small — only
    // the trailing VELOCITY_WINDOW_MS matters at release.
    samples.push({ x: t.clientX, t: Date.now() });
    if (samples.length > 12) samples.shift();
    lastDx = Math.max(0, dx);
    // Vertical drift past horizontal → the user is scrolling, not swiping.
    if (dy > Math.abs(dx) && dy > 8) {
      if (swipeActive) resetSwipe(true);
      edgeStartX = -1;
      swipeActive = false;
      return;
    }
    if (dx > 4) {
      // The thread overlay sits over the live page; don't mount a peek
      // backdrop for it (there's no underlying-page snapshot to show — and
      // the overlay itself stays visible as the page behind it).
      if (!swipeActive && !swipeOwnedByThread) {
        mountPeekBackdrop();
        // The native iOS composer pill is a window-anchored UIKit overlay
        // ABOVE the WebView — it is NOT inside the <main> we're translating
        // away, so without this hide it ghost-floats over the sliding page
        // (and the peek backdrop) for the duration of the drag. Re-shown in
        // `resetSwipe` if the gesture is cancelled; left hidden on commit
        // (`finishSwipeOut`) because the route is about to change and Swift's
        // URL-KVO re-evaluates: it re-shows the pill if the destination is a
        // chat route, or keeps it hidden otherwise. Only the route-pop swipe
        // hides it — a thread-owned swipe leaves the underlying chat mounted,
        // and the ThreadPanel's own open/close already owns the pill there.
        void setNativeVisibility(false);
      }
      swipeActive = true;
      if (!swipeOwnedByThread) applySwipe(dx);
    }
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (edgeStartX < 0) return;
    const t = e.changedTouches[0];
    if (!t) {
      if (swipeActive) resetSwipe(true);
      edgeStartX = -1;
      swipeActive = false;
      swipeOwnedByThread = false;
      return;
    }
    const dx = t.clientX - edgeStartX;
    const dy = Math.abs(t.clientY - edgeStartY);
    const dt = Date.now() - edgeStartT;
    lastDx = Math.max(0, dx);
    // Release velocity (P2): px/ms over the trailing VELOCITY_WINDOW_MS.
    // Walking back from the lift sample means a drag-then-pause release reads
    // ~0 (the stale early samples fall outside the window via their timestamps
    // — a paused finger emits no touchmoves, so the lift sample's dt is large).
    const now = Date.now();
    samples.push({ x: t.clientX, t: now });
    let ref = samples[samples.length - 1];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (now - samples[i].t > VELOCITY_WINDOW_MS) break;
      ref = samples[i];
    }
    const vdt = now - ref.t;
    releaseVelocity = vdt > 0 ? (t.clientX - ref.x) / vdt : 0;
    // Commit if EITHER (a) a fast flick past the trigger distance within the
    // time budget, OR (b) dragged past the halfway point regardless of speed
    // (a slow-but-deep swipe still means "go back" — without this, holding the
    // swipe most of the way then releasing bounces back and feels broken), OR
    // (c) the release velocity alone says "thrown" — a rightward flick faster
    // than VELOCITY_COMMIT commits even under the distance threshold and even
    // past the MAX_MS time budget (the velocity path supersedes it; the budget
    // still gates the distance path exactly as before).
    const triggered =
      (dx > TRIGGER_PX && dy < MAX_VERT && dt < MAX_MS) ||
      (dx > window.innerWidth / 2 && dy < MAX_VERT) ||
      (releaseVelocity > VELOCITY_COMMIT && dx > VELOCITY_MIN_DX && dy < MAX_VERT);
    edgeStartX = -1;
    if (swipeActive) {
      if (triggered) finishSwipeOut();
      else resetSwipe(true);
      swipeActive = false;
      return;
    }
    // Fallback for fast flicks that never registered as a swipe (fingers
    // covered <4px before lift).
    if (triggered) {
      haptic("light"); // commit haptic — this branch never reaches finishSwipeOut
      if (swipeOwnedByThread) {
        swipeOwnedByThread = false;
        closeOpenThread();
      } else {
        goBack();
      }
    } else {
      swipeOwnedByThread = false;
    }
  };

  window.addEventListener("touchstart", onTouchStart, { passive: true });
  window.addEventListener("touchmove", onTouchMove, { passive: true });
  window.addEventListener("touchend", onTouchEnd, { passive: true });

  // ── Teardown ─────────────────────────────────────────────────────────────
  return () => {
    window.removeEventListener("touchstart", onTouchStart);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("click", onAnchorClick, true);
    // Restore the original history methods so a re-init doesn't double-wrap.
    history.pushState = origPushState as History["pushState"];
    history.replaceState = origReplaceState as History["replaceState"];
    unmountPeekBackdrop();
    liveMain = null;
  };
}

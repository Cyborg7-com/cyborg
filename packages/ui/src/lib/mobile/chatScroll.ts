/**
 * Shared chat-scroll caveats for message lists (channels AND DMs).
 *
 * These three behaviors were hard-won in v1 and MUST be identical across every
 * message surface. Channels render via MessageList.svelte and DMs render
 * ChatMessage directly (different components), so the logic lives here as one
 * source of truth — both call into it, and DMs can't silently drift from the
 * channel behavior again.
 *
 *   1. pinToBottom            — race-proof initial scroll-to-latest.
 *   2. withPrependAnchor      — scroll-up pagination without the jump.
 *   3. installIosKeyboardScrollPreserve — keep the latest message above the
 *                               iOS software keyboard.
 */

import { isTauriIOS } from "./push.js";

/**
 * Multi-pass "hammer the bottom" scroll-to-latest.
 *
 * A single requestAnimationFrame loses the race on iOS WKWebView: the {#each}
 * may not have painted yet (scrollHeight still tiny → we land at the very top,
 * showing the OLDEST messages), and avatars / images / markdown decode AFTER
 * first paint and grow scrollHeight (leaving the user above the latest message).
 * v1 scheduled several passes — now, next frame, +100ms, +300ms — each re-reading
 * the live scrollHeight. Use this for a fresh conversation open.
 */
export function pinToBottom(el: HTMLElement | undefined | null): void {
  if (!el) return;
  const pin = (): void => {
    if (el.isConnected) el.scrollTop = el.scrollHeight;
  };
  pin();
  requestAnimationFrame(pin);
  setTimeout(pin, 100);
  setTimeout(pin, 300);
}

/**
 * Prepend-anchor for scroll-up pagination.
 *
 * Prepending older history grows scrollHeight above the viewport, which —
 * without compensation — jumps the read position. Snapshot scrollHeight BEFORE
 * loading, then after the prepend renders push scrollTop down by the height
 * delta so the message the user was looking at stays fixed (no jump / reposition
 * / momentum cancel). Side-effect-only (reads/writes scrollTop directly), so it
 * can't fight the bottom-anchor autoscroll or the keyboard preserve. `loadFn`
 * may be sync (void) or async (Promise); the anchor restores after it resolves.
 */
export function withPrependAnchor(
  el: HTMLElement | undefined | null,
  loadFn: () => void | Promise<unknown>,
): void {
  if (!el) return;
  const prevScrollHeight = el.scrollHeight;
  const restore = (): void => {
    // Two rAFs: the first lets the framework flush the prepended DOM, the second
    // lets layout settle so scrollHeight reflects the new content before we adjust.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!el.isConnected) return;
        const delta = el.scrollHeight - prevScrollHeight;
        if (delta > 0) el.scrollTop += delta;
      });
    });
  };
  const result = loadFn();
  if (result && typeof (result as Promise<unknown>).then === "function") {
    void (result as Promise<unknown>).then(restore, restore);
  } else {
    restore();
  }
}

/**
 * iOS software-keyboard scroll preservation. No-op off the Tauri iOS shell.
 *
 * WKWebView keeps the TOP anchor when the visualViewport (and thus this scroll
 * container's clientHeight) shrinks for the keyboard, so the latest message
 * slides UNDER the keyboard on open and the read position drifts on close. We
 * preserve the BOTTOM anchor instead:
 *   OPEN (shrink): a ResizeObserver bumps scrollTop by the height delta so the
 *     message at the bottom edge stays at the bottom edge above the keyboard.
 *   CLOSE (grow): the multi-callback grow animation accumulates drift, so we
 *     snapshot distance-from-bottom on composer focusin and RESTORE it on
 *     focusout once the keyboard has finished animating away (350ms).
 *
 * Mutates scrollTop directly only — never reactive state — so it can't fight the
 * autoscroll / pagination effects or create a loop. Returns a cleanup fn (call
 * it from an $effect teardown).
 */
export function installIosKeyboardScrollPreserve(el: HTMLElement): () => void {
  if (!isTauriIOS()) return () => {};

  let lastClientHeight = el.clientHeight;
  let savedDistanceFromBottom: number | null = null;
  let restoreTimer: ReturnType<typeof setTimeout> | null = null;

  const obs = new ResizeObserver(() => {
    const cur = el.clientHeight;
    const delta = lastClientHeight - cur;
    // Only react to SHRINK (keyboard opening). GROW is handled by the focusout
    // snapshot restore below, which is drift-free.
    if (delta > 1) el.scrollTop += delta;
    lastClientHeight = cur;
  });
  obs.observe(el);

  const onFocusIn = (): void => {
    // distance-from-bottom (not scrollTop) survives content growth during
    // keyboard-up, so it's the stable thing to restore on close.
    savedDistanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  };
  const onFocusOut = (): void => {
    if (savedDistanceFromBottom === null) return;
    const want = savedDistanceFromBottom;
    savedDistanceFromBottom = null;
    // Let the keyboard finish animating away — visualViewport.resize fires late
    // in the animation. 350ms covers the animation + the post-animation settle.
    if (restoreTimer) clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      el.scrollTop = el.scrollHeight - el.clientHeight - want;
    }, 350);
  };
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);

  return () => {
    obs.disconnect();
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    if (restoreTimer) clearTimeout(restoreTimer);
  };
}

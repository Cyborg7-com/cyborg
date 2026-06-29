/**
 * Pure platform detection for the native (Tauri) mobile shell.
 *
 * Split out of `push.ts` (Gemini #946) so non-push code — e.g. the terminal's
 * viewport/keyboard gating — can detect the native shell WITHOUT importing the
 * push-notification module. These are zero-dependency predicates (just
 * `window.__TAURI__` + the user agent), safe to call during SSR (they guard
 * `window`/`navigator`).
 */

interface TauriWindow {
  __TAURI_INTERNALS__?: unknown;
  __TAURI__?: unknown;
}

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as TauriWindow;
  return Boolean(w.__TAURI_INTERNALS__ ?? w.__TAURI__);
}

/**
 * True only inside the Tauri iOS shell. Gates the iOS-specific keyboard /
 * viewport / external-link behavior so web + desktop + Android are unaffected.
 */
export function isTauriIOS(): boolean {
  return (
    isTauri() && typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent)
  );
}

/**
 * True only inside the Tauri Android shell. Gates the Android keyboard-follow
 * viewport handling (#460) AND routes actions the Android System WebView can't
 * do natively — e.g. saving an image to the gallery, where the web
 * `<a download>` path is a no-op (#461) and the native MediaStore command must
 * be used instead.
 */
export function isTauriAndroid(): boolean {
  return isTauri() && typeof navigator !== "undefined" && /Android/.test(navigator.userAgent);
}

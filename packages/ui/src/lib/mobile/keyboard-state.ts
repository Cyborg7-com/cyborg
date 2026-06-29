/**
 * Global keyboard-open state (Tauri iOS shell).
 *
 * Caveat #8: this MUST be a plain `.ts` module — NOT `.svelte.ts`, and NOT a
 * `$state` rune living inside +layout.svelte. Svelte 5 runes / `.svelte.ts`
 * modules get re-instantiated by Vite on HMR (and, on iOS WKWebView prod, even
 * across chat-page navigations). The native side injects
 * `window.__cgKeyboardWillShow/Hide` hooks that call `setOpen()`; if the store
 * lived in a rune that Vite swapped out, those hooks would stay bound to the
 * orphaned old module and writes would never reach the rendered nav — the
 * "nav stuck hidden after opening a second chat" bug.
 *
 * A plain ESM module with module-level state is treated as stable by Vite, so
 * native code and Svelte always read/write the exact same value. Svelte
 * components consume it via `subscribe()` (Svelte store contract — auto-usable
 * with `$`-prefix in templates if imported as a store, or manually).
 */

let open = false;
const listeners = new Set<(open: boolean) => void>();

/**
 * Subscribe to keyboard-open changes. Fires immediately with the current value
 * (Svelte store contract). Returns an unsubscribe function.
 */
export function subscribe(fn: (open: boolean) => void): () => void {
  listeners.add(fn);
  fn(open);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Set the keyboard-open state. No-op if unchanged so listeners only fire on a
 * real transition. Called by the visualViewport handler and by the native
 * `window.__cgKeyboardWillShow/Hide` hooks.
 */
export function setOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const fn of listeners) fn(open);
}

/** Synchronous read of the current keyboard-open state. */
export function isOpen(): boolean {
  return open;
}

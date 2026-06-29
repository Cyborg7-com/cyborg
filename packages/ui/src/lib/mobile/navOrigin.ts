/**
 * Module-level record of which LIST a conversation was opened FROM, so that
 * going back — via the edge-swipe gesture AND the header back button — returns
 * to that exact list instead of a hard-coded parent.
 *
 * THE BUG this fixes: opening a DM from the Chats tab (/workspace/<ws>/chats)
 * then swiping back used to land on the DMs tab (/dms), because the back target
 * was a STATIC section→parent map (channel→/chats, dm→/dms, agent→/agents) with
 * no awareness of where the conversation was actually entered from. By recording
 * the origin path at every list→conversation entry point and preferring it in
 * computeBackTarget(), back navigation returns to the originating list.
 *
 * Like its siblings peekState.ts / keyboard-state.ts this is a PLAIN `.ts`
 * module (NOT `.svelte.ts`) on purpose: a true ESM singleton survives Svelte
 * component re-init / iOS WKWebView re-init / HMR, where a `let` inside a
 * component `<script>` would be re-created and the origin lost. No runes here.
 */

let origin: string | null = null;

export function setNavOrigin(path: string): void {
  origin = path;
}

export function peekNavOrigin(): string | null {
  return origin;
}

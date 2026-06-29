// Pure dismiss helpers for the mobile channel/daemon drawer — extracted from the
// rune store (viewport.svelte.ts) so they're unit-testable in the plain-node
// vitest config (no Svelte runes compiler). The layout wires these to the real
// keyboard/touch events; the store owns the open/close state.

// a11y: Escape (and the legacy "Esc") must dismiss an open overlay.
export function isDrawerDismissKey(key: string): boolean {
  return key === "Escape" || key === "Esc";
}

// Swipe-left-to-close: the drawer sits at the left edge, so a leftward,
// horizontally-dominant drag past the threshold dismisses it. Vertical-dominant
// gestures are ignored so scrolling the list inside the drawer isn't hijacked.
export const DRAWER_SWIPE_CLOSE_PX = 56;

export function shouldCloseDrawerOnSwipe(dx: number, dy: number): boolean {
  return dx < -DRAWER_SWIPE_CLOSE_PX && Math.abs(dx) > Math.abs(dy);
}

// Escape inside an editable field (the inline alias input, the create-channel
// form, any contenteditable) is "cancel/blur this field", NOT "close the
// drawer" — closing would unmount the form and lose what the user typed. The
// layout's Escape handler skips events whose target is editable.
export function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as { tagName?: string; isContentEditable?: boolean } | null;
  if (!node) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

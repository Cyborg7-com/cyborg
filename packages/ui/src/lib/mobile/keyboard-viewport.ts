// Keyboard-follow viewport math — pure, so the visualViewport handler in the
// root layout is testable without a DOM (issue #460, Android composer parity).
//
// Model (mirrors the iOS shell-shrink): the soft keyboard shrinks the VISUAL
// viewport (Chromium WebView default `interactive-widget=resizes-visual`), so
// `visualViewport.height` is the usable height above the keyboard. Sizing the
// app shell to that height makes the composer ride the keyboard instead of
// being covered. `keyboardInset` is the covered height (for callers that prefer
// an offset/translate). `baseline` is the no-keyboard height, re-based on
// rotation / a larger height.

export interface KeyboardViewport {
  // Live visual-viewport height → CSS `--app-vh` (the shell shrinks to this).
  appVh: number;
  // Height the keyboard covers (>= 0) → CSS `--cg-keyboard-inset`.
  keyboardInset: number;
  // Past the threshold, treat the keyboard as open (drives nav-hide parity).
  keyboardOpen: boolean;
}

export const KEYBOARD_OPEN_THRESHOLD = 150;

export function keyboardViewport(
  visualViewportHeight: number,
  baselineHeight: number,
  threshold: number = KEYBOARD_OPEN_THRESHOLD,
): KeyboardViewport {
  const inset = Math.max(0, baselineHeight - visualViewportHeight);
  return {
    appVh: visualViewportHeight,
    keyboardInset: inset,
    keyboardOpen: inset > threshold,
  };
}

// Re-base the "no keyboard" height: a wider viewport (rotation) or a height
// taller than the current baseline is a new no-keyboard maximum, not a keyboard
// closing. Returns the height to treat as the baseline going forward.
export function rebaselineHeight(
  current: { width: number; height: number },
  previous: { width: number; baseline: number },
): number {
  if (current.width !== previous.width || current.height > previous.baseline) {
    return current.height;
  }
  return previous.baseline;
}

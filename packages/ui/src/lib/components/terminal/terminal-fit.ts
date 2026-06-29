// Pure fit-sizing guards for TerminalView (keep-alive sizing bug, internal docs).
//
// A terminal in this shell lives in a KEEP-ALIVE pane (TerminalPaneHost): the
// active pane is shown, every other tracked pane is hidden with `display:none`
// so its xterm + daemon subscription survive a tab switch. A `display:none`
// element has NO layout box — `clientWidth`/`clientHeight` are 0 and
// `offsetParent` is null. xterm's FitAddon does NOT throw on a zero-size
// element; it silently computes a DEGENERATE geometry (e.g. 1×1 cols×rows) and,
// if we forward that, we push a garbage `resize` to the pty — so a pane that was
// fit while hidden comes back the wrong size, and the live output is cut off.
//
// The fix is a single guard: only run `fit()` when the container actually has a
// layout box. The ResizeObserver in TerminalView already fires when a pane flips
// `display:none → visible` (that's a size change from 0×0 to real), so gating on
// nonzero size means a hidden pane is skipped and the SAME observer re-fits it
// correctly the instant it becomes visible. Extracted here so the decision is
// unit-testable without the xterm/DOM runtime.

// The subset of an element we need to decide if it has a real layout box. Both
// HTMLElement and a test stub satisfy this — no DOM dependency.
export interface FitMeasurable {
  // null when the element (or an ancestor) is `display:none` — the definitive
  // "I am not laid out" signal. `position: fixed` elements report null too, but
  // the terminal container is never fixed, so this is a reliable hidden check.
  readonly offsetParent: Element | null;
  readonly clientWidth: number;
  readonly clientHeight: number;
}

// True only when the container has a real, nonzero layout box — i.e. it is
// visible and big enough that `fit()` will compute sane cols×rows. A hidden
// (display:none) pane reports offsetParent === null AND 0×0, so this is false
// and the caller must SKIP fit() to avoid pushing degenerate dimensions to the
// pty. When the pane becomes visible, the ResizeObserver fires and this flips
// true, so the re-fit lands correctly.
export function canFitContainer(el: FitMeasurable | null | undefined): boolean {
  if (!el) return false;
  if (el.offsetParent === null) return false;
  return el.clientWidth > 0 && el.clientHeight > 0;
}

// Whether to pin the terminal root's height to `visualViewport.height`. That pin
// is a MOBILE soft-keyboard workaround: when the on-screen keyboard opens it
// shrinks the visual viewport (without a window resize), and the full-screen
// mobile terminal must shrink to sit ABOVE the keyboard instead of being covered.
//
// On DESKTOP the terminal is NOT full-screen — it's a windowed sub-pane inside
// the app shell (rail, sidebar, header, the pane tab bar below it). There,
// `visualViewport.height` is the whole window's height, so pinning the pane to it
// makes the pane TALLER than its flex slot: it overflows past the bottom window
// edge and the last rows of the TUI (e.g. Claude Code's input/footer) get clipped
// off-screen. The flex `h-full` layout already sizes the pane correctly, so the
// pin must be skipped entirely off touch devices.
//
// Gate: pin only on a coarse-pointer (touch) device that is NEITHER the Electron
// desktop shell NOR the native (Tauri) mobile shell.
//   - `isDesktopApp` (Electron): the terminal is a windowed sub-pane, so the pin
//     would overflow the flex slot — desktop wins.
//   - `nativeShellManagesViewport` (Tauri iOS/Android): the app's ROOT layout
//     already tracks the soft keyboard by writing `--app-vh` (visualViewport.height)
//     to the document, and the terminal's ResizeObserver re-fits xterm to that flex
//     slot. If the terminal ALSO pinned its own root to visualViewport.height it
//     would double-count (the terminal sits below the top bar / trial bar), pushing
//     the accessory bar + last TUI rows off-screen — exactly the "can't see the
//     whole terminal / can't see the accessory bar" bug. So the native shell wins
//     too; only plain mobile WEB (no --app-vh writer) self-pins.
export function shouldPinViewportHeight(opts: {
  isDesktopApp: boolean;
  coarsePointer: boolean;
  nativeShellManagesViewport: boolean;
}): boolean {
  if (opts.isDesktopApp) return false;
  if (opts.nativeShellManagesViewport) return false;
  return opts.coarsePointer;
}

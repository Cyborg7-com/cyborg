// Keep-alive sizing bug (internal docs): a terminal pane that is `display:none`
// (an inactive keep-alive pane) must NOT be fit — its container is 0×0 with a
// null offsetParent, and xterm's FitAddon would compute a degenerate geometry
// and push a garbage resize to the pty, cutting off output when the pane returns.
// canFitContainer is the guard: fit only when the container has a real layout
// box; re-fit when it becomes visible (the ResizeObserver re-fires on 0×0 →
// real size, and the guard then passes).
//
// Two layers of proof:
//   1. UNIT — canFitContainer gates fitting on nonzero, visible size.
//   2. STRUCTURE — TerminalView wires the guard + a ResizeObserver so a hidden→
//      visible pane re-fits, and its container fills its parent.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canFitContainer, shouldPinViewportHeight, type FitMeasurable } from "./terminal-fit.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// A minimal element stub — only the fields canFitContainer reads.
function el(
  offsetParent: Element | null,
  clientWidth: number,
  clientHeight: number,
): FitMeasurable {
  return { offsetParent, clientWidth, clientHeight };
}

// A stand-in non-null offsetParent (we never inspect it beyond null-ness).
const PARENT = {} as Element;

describe("canFitContainer — fit only when the container has a real layout box", () => {
  it("a visible, sized container CAN be fit", () => {
    expect(canFitContainer(el(PARENT, 800, 600))).toBe(true);
  });

  it("a display:none container (null offsetParent, 0×0) is NOT fit", () => {
    // The keep-alive case: an inactive pane is display:none. Fitting it would
    // push a degenerate geometry to the pty.
    expect(canFitContainer(el(null, 0, 0))).toBe(false);
  });

  it("a hidden container that still reports a stale nonzero size is NOT fit", () => {
    // offsetParent === null is the definitive hidden signal even if cached
    // client dims linger — never fit a hidden pane.
    expect(canFitContainer(el(null, 800, 600))).toBe(false);
  });

  it("a zero-width or zero-height container is NOT fit", () => {
    expect(canFitContainer(el(PARENT, 0, 600))).toBe(false);
    expect(canFitContainer(el(PARENT, 800, 0))).toBe(false);
  });

  it("a missing container is NOT fit", () => {
    expect(canFitContainer(null)).toBe(false);
    expect(canFitContainer(undefined)).toBe(false);
  });

  it("becoming visible flips the decision (the re-fit-on-visible contract)", () => {
    // While hidden: skip. After it gains a box (display:none → visible, which the
    // ResizeObserver reports): fit. This is what makes a kept-alive pane fit
    // correctly the instant it is shown.
    const hidden = el(null, 0, 0);
    expect(canFitContainer(hidden)).toBe(false);
    const shown = el(PARENT, 1024, 768);
    expect(canFitContainer(shown)).toBe(true);
  });
});

// Soft-keyboard height pin: a MOBILE-only workaround. On desktop the terminal is
// a windowed sub-pane, so pinning it to the whole-window visualViewport.height
// overflowed the bottom edge and clipped the last TUI rows (e.g. Claude Code's
// footer rendered below the window). shouldPinViewportHeight gates the pin to
// touch devices that aren't the desktop shell.
describe("shouldPinViewportHeight — pin only on a mobile soft-keyboard device", () => {
  it("does NOT pin in the desktop app (windowed sub-pane, even with a touchscreen)", () => {
    expect(
      shouldPinViewportHeight({
        isDesktopApp: true,
        coarsePointer: true,
        nativeShellManagesViewport: false,
      }),
    ).toBe(false);
    expect(
      shouldPinViewportHeight({
        isDesktopApp: true,
        coarsePointer: false,
        nativeShellManagesViewport: false,
      }),
    ).toBe(false);
  });

  it("does NOT pin on a desktop browser (fine pointer, no soft keyboard)", () => {
    expect(
      shouldPinViewportHeight({
        isDesktopApp: false,
        coarsePointer: false,
        nativeShellManagesViewport: false,
      }),
    ).toBe(false);
  });

  it("DOES pin on plain mobile WEB (touch, no native shell that owns the viewport)", () => {
    expect(
      shouldPinViewportHeight({
        isDesktopApp: false,
        coarsePointer: true,
        nativeShellManagesViewport: false,
      }),
    ).toBe(true);
  });

  it("does NOT pin in the native (Tauri) mobile shell — its root layout owns --app-vh (#48 mobile terminal)", () => {
    // The native shell writes --app-vh and the terminal re-fits its flex slot via
    // the ResizeObserver; a second pin here double-counts and clips the accessory bar.
    expect(
      shouldPinViewportHeight({
        isDesktopApp: false,
        coarsePointer: true,
        nativeShellManagesViewport: true,
      }),
    ).toBe(false);
  });
});

describe("TerminalView wiring — soft-keyboard pin gating", () => {
  const source = readFileSync(resolve(HERE, "TerminalView.svelte"), "utf8");

  it("gates the visualViewport height pin behind shouldPinViewportHeight", () => {
    expect(source).toMatch(/shouldPinViewportHeight\(/);
    // The pin only runs when the soft-keyboard gate passes; otherwise the inline
    // height is cleared so the flex layout governs (no bottom-clipping).
    expect(source).toMatch(/rootEl\.style\.height = ""/);
  });

  it("only attaches visualViewport listeners where the pin applies", () => {
    expect(source).toMatch(/softKeyboardSizing\(\) \? window\.visualViewport : null/);
  });
});

describe("TerminalView wiring — fit-guard + ResizeObserver + fill-parent", () => {
  const source = readFileSync(resolve(HERE, "TerminalView.svelte"), "utf8");

  it("guards fit() with canFitContainer so a hidden (0×0) pane is never fit", () => {
    expect(source).toMatch(/canFitContainer\(containerEl\)/);
    // The guard returns before fit() so a degenerate geometry is never produced.
    expect(source).toMatch(/if\s*\(!canFitContainer\(containerEl\)\)\s*return/);
  });

  it("re-fits via a ResizeObserver (covers hidden→visible + window/container resize)", () => {
    expect(source).toMatch(/new ResizeObserver\(/);
    // The observer drives fitAndResize, which both fits and forwards the resize.
    expect(source).toMatch(/fitAndResize\(\)/);
  });

  it("after fit, the new cols×rows are forwarded to the daemon (pty matches viewport)", () => {
    expect(source).toMatch(/transport\.resize\(sessionId,\s*term\.cols,\s*term\.rows\)/);
  });

  it("the terminal container fills its parent (h-full + min-h-0, no fixed height)", () => {
    // The root flex column fills its host with a min-h-0 so it can shrink.
    expect(source).toMatch(/class="flex h-full min-h-0 w-full flex-col/);
    // The xterm container fills the surface.
    expect(source).toMatch(/bind:this=\{containerEl\} class="h-full w-full/);
  });
});

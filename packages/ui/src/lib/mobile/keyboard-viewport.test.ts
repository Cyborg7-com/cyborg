import { describe, it, expect } from "vitest";
import { keyboardViewport, rebaselineHeight, KEYBOARD_OPEN_THRESHOLD } from "./keyboard-viewport.js";

describe("keyboardViewport", () => {
  it("no keyboard: appVh = full height, inset 0, closed", () => {
    expect(keyboardViewport(800, 800)).toEqual({
      appVh: 800,
      keyboardInset: 0,
      keyboardOpen: false,
    });
  });

  it("keyboard open: appVh follows the visual viewport, inset = covered height", () => {
    const r = keyboardViewport(500, 800);
    expect(r.appVh).toBe(500); // shell shrinks to this → composer rides the keyboard
    expect(r.keyboardInset).toBe(300);
    expect(r.keyboardOpen).toBe(true);
  });

  it("a tiny shrink under the threshold is NOT the keyboard (accessory bar / URL chrome)", () => {
    const r = keyboardViewport(800 - (KEYBOARD_OPEN_THRESHOLD - 1), 800);
    expect(r.keyboardOpen).toBe(false);
    expect(r.keyboardInset).toBe(KEYBOARD_OPEN_THRESHOLD - 1);
  });

  it("never reports a negative inset when the viewport grows past baseline", () => {
    expect(keyboardViewport(900, 800).keyboardInset).toBe(0);
  });
});

describe("rebaselineHeight", () => {
  it("rotation (width change) re-bases the no-keyboard height", () => {
    expect(rebaselineHeight({ width: 800, height: 600 }, { width: 400, baseline: 800 })).toBe(600);
  });

  it("a height taller than baseline re-bases (new no-keyboard max)", () => {
    expect(rebaselineHeight({ width: 400, height: 820 }, { width: 400, baseline: 800 })).toBe(820);
  });

  it("a shorter height at the same width is the keyboard — baseline unchanged", () => {
    expect(rebaselineHeight({ width: 400, height: 500 }, { width: 400, baseline: 800 })).toBe(800);
  });
});

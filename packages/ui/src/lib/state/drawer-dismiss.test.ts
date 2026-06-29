import { describe, expect, it } from "vitest";
import {
  DRAWER_SWIPE_CLOSE_PX,
  isDrawerDismissKey,
  isEditableTarget,
  shouldCloseDrawerOnSwipe,
} from "./drawer-dismiss.js";

describe("isDrawerDismissKey (Escape closes the open drawer — a11y)", () => {
  it("Escape and legacy Esc dismiss", () => {
    expect(isDrawerDismissKey("Escape")).toBe(true);
    expect(isDrawerDismissKey("Esc")).toBe(true);
  });
  it("other keys do not", () => {
    for (const k of ["Enter", " ", "ArrowDown", "a", "Tab", "Backspace"]) {
      expect(isDrawerDismissKey(k)).toBe(false);
    }
  });
});

describe("shouldCloseDrawerOnSwipe (swipe-left-to-close)", () => {
  it("a clear leftward, horizontally-dominant swipe past the threshold closes", () => {
    expect(shouldCloseDrawerOnSwipe(-(DRAWER_SWIPE_CLOSE_PX + 1), 10)).toBe(true);
    expect(shouldCloseDrawerOnSwipe(-120, -20)).toBe(true);
  });
  it("a short leftward nudge does NOT close (threshold)", () => {
    expect(shouldCloseDrawerOnSwipe(-(DRAWER_SWIPE_CLOSE_PX - 1), 0)).toBe(false);
    expect(shouldCloseDrawerOnSwipe(-DRAWER_SWIPE_CLOSE_PX, 0)).toBe(false); // strictly past
  });
  it("rightward / vertical-dominant gestures are ignored (don't hijack scroll)", () => {
    expect(shouldCloseDrawerOnSwipe(120, 0)).toBe(false); // rightward
    expect(shouldCloseDrawerOnSwipe(-80, 200)).toBe(false); // vertical-dominant
  });
});

describe("isEditableTarget (Escape inside a field must not close the drawer)", () => {
  it("true for inputs/textarea/select and contenteditable", () => {
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });
  it("false for non-editable targets and null", () => {
    expect(isEditableTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

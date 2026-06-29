import { describe, it, expect } from "vitest";
import { isOutsideTarget, isEscapeKey, isEditableTarget } from "./clickOutside.js";

// Pure decision-logic tests for the shared click-outside action (#510). The ui
// vitest env is node (no DOM), so we exercise the extracted `isOutsideTarget` /
// `isEscapeKey` with tiny structural fakes rather than a real document. These
// cover the exact branches the three call sites relied on: ref-contains close,
// the capture/mousedown paths (same decision, different binding), and the
// boundary-selector close used by MessageList's per-divider menus.

/** A node fake exposing just `contains` (the `!ref.contains(target)` path). */
function makeNode(contained: ReadonlyArray<unknown>): { contains(o: Node | null): boolean } {
  return { contains: (o: Node | null) => contained.includes(o) };
}

// A target fake exposing `nodeType` (so it reads as a Node) + `closest`. Cast to
// EventTarget — `isOutsideTarget` only ever touches nodeType/closest, and the ui
// vitest env has no DOM EventTarget to construct a real one.
function makeTarget(closestMatch: unknown): EventTarget {
  return { nodeType: 1, closest: () => closestMatch } as unknown as EventTarget;
}

describe("isOutsideTarget — ref.contains mode (MessageInput / MessageActionBar)", () => {
  it("inside the node → NOT outside (popover stays open)", () => {
    const inside = makeTarget(null);
    const node = makeNode([inside]);
    expect(isOutsideTarget(node, inside)).toBe(false);
  });

  it("outside the node → outside (popover closes)", () => {
    const elsewhere = makeTarget(null);
    const node = makeNode([]); // contains nothing
    expect(isOutsideTarget(node, elsewhere)).toBe(true);
  });

  it("a node target that IS the node counts as inside", () => {
    const self = makeTarget(null);
    const node = makeNode([self]);
    expect(isOutsideTarget(node, self)).toBe(false);
  });

  it("null target → outside (matches old `!ref.contains(null)`)", () => {
    const node = makeNode([]);
    expect(isOutsideTarget(node, null)).toBe(true);
  });

  it("a non-node EventTarget (e.g. document/window) → outside", () => {
    const node = makeNode([]);
    // window-like target: no nodeType → treated as outside.
    const nonNode = { addEventListener() {} } as unknown as EventTarget;
    expect(isOutsideTarget(node, nonNode)).toBe(true);
  });
});

describe("isOutsideTarget — boundary mode (MessageList date-jump menus)", () => {
  const boundary = "[data-date-divider]";

  it("target inside ANY matching divider → inside (stays open)", () => {
    const divider = {}; // stand-in for the matched [data-date-divider] element
    const target = makeTarget(divider);
    // node here is irrelevant in boundary mode; closest() decides.
    expect(isOutsideTarget(makeNode([]), target, boundary)).toBe(false);
  });

  it("target with no matching ancestor → outside (closes)", () => {
    const target = makeTarget(null);
    expect(isOutsideTarget(makeNode([]), target, boundary)).toBe(true);
  });

  it("target lacking `closest` (e.g. document) → outside", () => {
    const docLike = { nodeType: 9 } as unknown as EventTarget; // no closest()
    expect(isOutsideTarget(makeNode([]), docLike, boundary)).toBe(true);
  });

  it("boundary takes precedence over node.contains", () => {
    const divider = {};
    const target = makeTarget(divider);
    // Even though the node does NOT contain the target, a boundary match keeps it open.
    expect(isOutsideTarget(makeNode([]), target, boundary)).toBe(false);
  });
});

describe("isEscapeKey", () => {
  it("Escape → true", () => {
    expect(isEscapeKey({ key: "Escape" } as KeyboardEvent)).toBe(true);
  });

  it("any other key → false", () => {
    for (const key of ["Enter", "Esc", "Tab", " ", "a", "ArrowDown"]) {
      expect(isEscapeKey({ key } as KeyboardEvent)).toBe(false);
    }
  });
});

describe("isEditableTarget — guard so Escape-while-typing doesn't dismiss", () => {
  // Structural fakes: a real element supplies tagName + isContentEditable; the
  // node vitest env has no HTMLElement, so we hand the function the same shape.
  const editable = (tagName: string, isContentEditable = false): EventTarget =>
    ({ tagName, isContentEditable }) as unknown as EventTarget;

  it("INPUT / TEXTAREA / SELECT targets → editable (Escape must NOT close)", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isEditableTarget(editable(tag))).toBe(true);
    }
  });

  it("a contenteditable host → editable", () => {
    // A non-form element (e.g. DIV) whose isContentEditable is true.
    expect(isEditableTarget(editable("DIV", true))).toBe(true);
  });

  it("a plain non-editable element → not editable (Escape closes)", () => {
    for (const tag of ["DIV", "BUTTON", "SPAN", "A"]) {
      expect(isEditableTarget(editable(tag))).toBe(false);
    }
  });

  it("null target (e.g. focus lost) → not editable", () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it("a non-element EventTarget (document/window) → not editable", () => {
    // No tagName / isContentEditable → treated as non-editable, Escape closes.
    const nonEl = { addEventListener() {} } as unknown as EventTarget;
    expect(isEditableTarget(nonEl)).toBe(false);
  });
});

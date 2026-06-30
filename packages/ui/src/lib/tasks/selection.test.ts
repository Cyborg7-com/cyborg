// Unit tests for the bulk-selection store (selection.svelte.ts). vitest is
// configured to compile `.svelte.ts` rune modules, so the module-level `$state`
// singleton runs here as plain reactive state. We reset the singleton before each
// test so cases don't leak selection into one another.
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearSelection,
  deselectMany,
  isSelected,
  rangeBetween,
  selectedCount,
  selectedIds,
  selectMany,
  selectRange,
  setSelected,
  taskSelection,
  toggleSelected,
} from "./selection.svelte.js";

beforeEach(() => clearSelection());

describe("rangeBetween (pure)", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("returns the inclusive forward range", () => {
    expect(rangeBetween(order, "b", "d")).toEqual(["b", "c", "d"]);
  });

  it("returns the same set for a reverse range (order-agnostic)", () => {
    expect(rangeBetween(order, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("falls back to [target] when the anchor is null", () => {
    expect(rangeBetween(order, null, "c")).toEqual(["c"]);
  });

  it("falls back to [target] when the anchor is missing from the list", () => {
    expect(rangeBetween(order, "zzz", "c")).toEqual(["c"]);
  });

  it("returns [] when the target is missing from the list", () => {
    expect(rangeBetween(order, "a", "zzz")).toEqual([]);
  });

  it("returns a single element when anchor === target", () => {
    expect(rangeBetween(order, "c", "c")).toEqual(["c"]);
  });
});

describe("selection store", () => {
  it("toggleSelected adds then removes an id", () => {
    expect(isSelected("a")).toBe(false);
    toggleSelected("a");
    expect(isSelected("a")).toBe(true);
    expect(selectedCount()).toBe(1);
    toggleSelected("a");
    expect(isSelected("a")).toBe(false);
    expect(selectedCount()).toBe(0);
  });

  it("toggleSelected sets the anchor to the toggled id", () => {
    toggleSelected("b");
    expect(taskSelection.anchorId).toBe("b");
  });

  it("selectMany adds every id; deselectMany removes them", () => {
    selectMany(["a", "b", "c"]);
    expect(selectedCount()).toBe(3);
    expect(selectedIds().sort()).toEqual(["a", "b", "c"]);
    deselectMany(["a", "c"]);
    expect(selectedIds()).toEqual(["b"]);
  });

  it("setSelected adds when on and removes when off", () => {
    setSelected("a", true);
    expect(isSelected("a")).toBe(true);
    setSelected("a", false);
    expect(isSelected("a")).toBe(false);
  });

  it("clearSelection empties ids and resets the anchor", () => {
    selectMany(["a", "b"]);
    toggleSelected("c");
    expect(selectedCount()).toBeGreaterThan(0);
    expect(taskSelection.anchorId).toBe("c");
    clearSelection();
    expect(selectedCount()).toBe(0);
    expect(selectedIds()).toEqual([]);
    expect(taskSelection.anchorId).toBe(null);
  });

  it("selectRange selects the inclusive span from the anchor and moves the anchor", () => {
    const order = ["a", "b", "c", "d", "e"];
    // Anchor at "b" via a single toggle, then shift-range to "d".
    toggleSelected("b");
    expect(taskSelection.anchorId).toBe("b");
    selectRange(order, "d");
    expect(selectedIds().sort()).toEqual(["b", "c", "d"]);
    expect(taskSelection.anchorId).toBe("d");
  });

  it("selectRange with no anchor selects just the target", () => {
    const order = ["a", "b", "c"];
    expect(taskSelection.anchorId).toBe(null);
    selectRange(order, "b");
    expect(selectedIds()).toEqual(["b"]);
    expect(taskSelection.anchorId).toBe("b");
  });
});

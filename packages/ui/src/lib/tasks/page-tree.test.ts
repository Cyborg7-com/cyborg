// Unit tests for the PURE page-tree helpers. No DOM — they only reshape a flat
// page list into a forest and answer descendant/guard queries, so they run in
// the node-env vitest pass.
import { describe, expect, it } from "vitest";
import type { Page } from "$lib/core/types.js";
import {
  buildPageTree,
  collectDescendantIds,
  canNestUnder,
  defaultPageCompare,
} from "./page-tree.js";

// Minimal Page factory — only id / parentId / sortOrder / title drive the tree;
// the rest are inert defaults so we exercise the real type.
function page(overrides: Partial<Page> & { id: string }): Page {
  return {
    projectId: "p1",
    workspaceId: "w1",
    title: "Untitled",
    content: "",
    visibility: "public",
    icon: null,
    ownedBy: null,
    archivedAt: null,
    parentId: null,
    sortOrder: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

// Flatten a forest to "id" arrays per level for easy assertions.
function ids(nodes: ReturnType<typeof buildPageTree>): string[] {
  return nodes.map((n) => n.page.id);
}

describe("buildPageTree", () => {
  it("nests children under their parent", () => {
    const tree = buildPageTree([
      page({ id: "root" }),
      page({ id: "child", parentId: "root" }),
      page({ id: "grandchild", parentId: "child" }),
    ]);
    expect(ids(tree)).toEqual(["root"]);
    expect(ids(tree[0].children)).toEqual(["child"]);
    expect(ids(tree[0].children[0].children)).toEqual(["grandchild"]);
  });

  it("orders siblings by sortOrder then title (the default comparator)", () => {
    const tree = buildPageTree([
      page({ id: "b", sortOrder: 2, title: "B" }),
      page({ id: "a", sortOrder: 1, title: "A" }),
      page({ id: "z", sortOrder: null, title: "Zebra" }),
      page({ id: "m", sortOrder: null, title: "Mango" }),
    ]);
    // sortOrder 1, 2 first (asc), then nulls last ordered by title.
    expect(ids(tree)).toEqual(["a", "b", "m", "z"]);
  });

  it("nests a freshly-created child (null sortOrder) under its parent, after ordered siblings", () => {
    // A new subpage is created with parentId set and NO sortOrder (null) — the
    // same convention a new root page uses. Under the default comparator it
    // nests beneath its parent and sorts AFTER any explicitly-ordered sibling.
    const tree = buildPageTree([
      page({ id: "parent" }),
      page({ id: "ordered", parentId: "parent", sortOrder: 1, title: "Ordered" }),
      page({ id: "fresh", parentId: "parent", sortOrder: null, title: "Untitled" }),
    ]);
    expect(ids(tree)).toEqual(["parent"]);
    expect(ids(tree[0].children)).toEqual(["ordered", "fresh"]);
  });

  it("promotes a child to root when its parent is absent (filtered out)", () => {
    const tree = buildPageTree([page({ id: "orphan", parentId: "missing" })]);
    expect(ids(tree)).toEqual(["orphan"]);
  });

  it("does not mutate the input array", () => {
    const input = [page({ id: "b", sortOrder: 2 }), page({ id: "a", sortOrder: 1 })];
    const snapshot = input.map((p) => p.id);
    buildPageTree(input);
    expect(input.map((p) => p.id)).toEqual(snapshot);
  });

  it("honors a custom sibling comparator", () => {
    const byTitleDesc = (a: Page, b: Page) => b.title.localeCompare(a.title);
    const tree = buildPageTree(
      [page({ id: "a", title: "A" }), page({ id: "c", title: "C" }), page({ id: "b", title: "B" })],
      byTitleDesc,
    );
    expect(ids(tree)).toEqual(["c", "b", "a"]);
  });
});

describe("defaultPageCompare", () => {
  it("places a page with sortOrder before one without", () => {
    expect(
      defaultPageCompare(page({ id: "x", sortOrder: 5 }), page({ id: "y", sortOrder: null })),
    ).toBeLessThan(0);
  });
});

describe("collectDescendantIds", () => {
  const pages = [
    page({ id: "root" }),
    page({ id: "a", parentId: "root" }),
    page({ id: "b", parentId: "root" }),
    page({ id: "a1", parentId: "a" }),
    page({ id: "a1x", parentId: "a1" }),
  ];

  it("returns the whole subtree, excluding the page itself", () => {
    expect([...collectDescendantIds(pages, "root")].sort()).toEqual(["a", "a1", "a1x", "b"]);
    expect([...collectDescendantIds(pages, "a")].sort()).toEqual(["a1", "a1x"]);
  });

  it("returns empty for a leaf", () => {
    expect(collectDescendantIds(pages, "a1x").size).toBe(0);
  });

  it("is cycle-safe", () => {
    const cyclic = [page({ id: "x", parentId: "y" }), page({ id: "y", parentId: "x" })];
    // Must terminate; x's descendants include y (and back to x, deduped out).
    expect([...collectDescendantIds(cyclic, "x")].sort()).toEqual(["x", "y"]);
  });
});

describe("canNestUnder", () => {
  const pages = [
    page({ id: "root" }),
    page({ id: "a", parentId: "root" }),
    page({ id: "a1", parentId: "a" }),
  ];

  it("allows dropping onto root (null target)", () => {
    expect(canNestUnder(pages, "a", null)).toBe(true);
  });

  it("forbids dropping a page onto itself", () => {
    expect(canNestUnder(pages, "a", "a")).toBe(false);
  });

  it("forbids dropping a page onto one of its descendants", () => {
    expect(canNestUnder(pages, "root", "a")).toBe(false);
    expect(canNestUnder(pages, "root", "a1")).toBe(false);
  });

  it("allows a legal re-parent", () => {
    expect(canNestUnder(pages, "a1", "root")).toBe(true);
  });
});

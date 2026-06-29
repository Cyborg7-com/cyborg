// Pure, DOM-free helpers that turn the FLAT page list (as returned by
// client.fetchPages) into the nested tree the Pages index renders, plus the
// descendant lookup the drag-to-nest guard needs. Kept pure + deterministic so
// the hierarchy is unit-testable without mounting the component, and so the list
// itself is just a render over the result.
//
// Nesting model (mirrors the backend contract): every page carries
// `parentId: string | null` (null = root) and `sortOrder: number | null`. A
// child whose parent is NOT present in the input set (filtered out by a tab or
// search, or a dangling id) is PROMOTED to a root so it never disappears — the
// same "keep everything visible" rule the board uses for unknown statuses.
import type { Page } from "$lib/core/types.js";

// One node in the rendered page tree: the page plus its ordered children.
export interface PageNode {
  page: Page;
  children: PageNode[];
}

// Sibling comparator. Default order (the backend contract): `sortOrder` ascending
// with nulls last, then title (case-insensitive). A surface may pass its own
// comparator (e.g. the list's "Date modified" / "Date created" / "Title" menu)
// to order siblings differently without changing the tree shape.
export type PageCompare = (a: Page, b: Page) => number;

export const defaultPageCompare: PageCompare = (a, b) => {
  const ao = a.sortOrder;
  const bo = b.sortOrder;
  if (ao != null && bo != null && ao !== bo) return ao - bo;
  if (ao != null && bo == null) return -1;
  if (ao == null && bo != null) return 1;
  return (a.title || "Untitled").localeCompare(b.title || "Untitled");
};

// Group a flat page list into a forest of PageNodes. Siblings (including the
// roots) are ordered by `compare`. Pure: never mutates the input array or its
// pages.
export function buildPageTree(
  pages: Page[],
  compare: PageCompare = defaultPageCompare,
): PageNode[] {
  const present = new Set(pages.map((p) => p.id));
  const nodeById = new Map<string, PageNode>();
  for (const page of pages) nodeById.set(page.id, { page, children: [] });

  const roots: PageNode[] = [];
  for (const page of pages) {
    const node = nodeById.get(page.id);
    if (!node) continue;
    const parentId = page.parentId;
    // Root when there is no parent, or the parent isn't in this (filtered) set.
    if (parentId != null && present.has(parentId)) {
      nodeById.get(parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortLevel = (nodes: PageNode[]): void => {
    nodes.sort((a, b) => compare(a.page, b.page));
    for (const n of nodes) sortLevel(n.children);
  };
  sortLevel(roots);
  return roots;
}

// The set of ids strictly BELOW `pageId` in the hierarchy (children, grandchildren,
// …) computed straight from the flat list. Used by the drag-to-nest guard so a
// page can't be dropped onto one of its own descendants (which would orphan a
// subtree). The id itself is NOT included. Cycle-safe.
export function collectDescendantIds(pages: Page[], pageId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const p of pages) {
    if (p.parentId == null) continue;
    const list = childrenByParent.get(p.parentId);
    if (list) list.push(p.id);
    else childrenByParent.set(p.parentId, [p.id]);
  }

  const out = new Set<string>();
  const stack = [...(childrenByParent.get(pageId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id == null || out.has(id)) continue;
    out.add(id);
    const kids = childrenByParent.get(id);
    if (kids) stack.push(...kids);
  }
  return out;
}

// Whether moving `pageId` under `targetParentId` is a legal re-parent. Illegal
// when the target is the page itself or one of its descendants (would create a
// cycle / orphan the subtree). A null target (drop on root) is always legal.
export function canNestUnder(
  pages: Page[],
  pageId: string,
  targetParentId: string | null,
): boolean {
  if (targetParentId == null) return true;
  if (targetParentId === pageId) return false;
  return !collectDescendantIds(pages, pageId).has(targetParentId);
}

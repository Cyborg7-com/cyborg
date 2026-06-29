// Page owner-visibility gate — shared by the relay (Postgres) + daemon (SQLite)
// page handlers so both apply ONE rule. A Tasks page is visible/writable to a user
// iff it is public, has no owner (legacy / null — treated as public per product
// decision), or is owned BY that user. A private page with a non-null owner is
// restricted to its owner alone (mirrors Plane's `Q(owned_by=user) | Q(access=0)`).
//
// Kept in a dependency-free module on purpose: relay-standalone.ts must never pull
// better-sqlite3 (storage.ts) into its startup graph, so this gate cannot live in
// storage.ts. It mirrors the SQL list filter used by getProjectPages
// (`visibility = 'public' OR owned_by IS NULL OR owned_by = userId`).

// The minimal owner/visibility fields the gate reads. PageShape (storage.ts) and
// the PG mapPageRow result both satisfy this structurally.
export interface PageOwnerFields {
  visibility: string;
  ownedBy: string | null;
}

// True when `page` is a non-public page owned by someone OTHER than `userId` —
// i.e. the caller must NOT see or mutate it. Public + legacy null-owner pages
// always return false (visible/writable to any project member). Gated on
// `visibility !== "public"` (the exact complement of the SQL list filter's
// `visibility = 'public'`), NOT `=== "private"`, so a future out-of-enum
// visibility value defaults to restricted rather than silently opening a gap.
export function isPageRestrictedFromUser(page: PageOwnerFields, userId: string): boolean {
  return page.visibility !== "public" && page.ownedBy !== null && page.ownedBy !== userId;
}

// ─── Page nesting (hierarchy) ─────────────────────────────────────────────
// Kept in this dependency-free module so BOTH the Postgres path (db/pg-sync.ts)
// and the SQLite path (storage.ts) cycle-guard re-parenting with ONE rule,
// without storage.ts ↔ pg-sync.ts importing each other (a circular dep — pg-sync
// already type-imports storage). Ports math-library's FolderService.isDescendant.

// Thrown when re-parenting a page would create a cycle (parent === self, or the
// proposed parent is a descendant of the page). A typed domain error so the
// relay/MCP layers can surface a clear "can't nest a page under itself" message
// rather than a generic FK/internal error.
export class PageCycleError extends Error {
  constructor(
    public readonly pageId: string,
    public readonly parentId: string,
  ) {
    super("Cannot nest a page under itself or one of its descendants");
    this.name = "PageCycleError";
  }
}

// Walk a flat [{ id, parentId }] page list and report whether `candidateId` sits
// anywhere in the subtree rooted at `pageId`. Pure + in-memory (the caller fetches
// the project's pages once — no per-row queries) — ports FolderService.isDescendant.
export function isPageDescendant(
  all: { id: string; parentId: string | null }[],
  pageId: string,
  candidateId: string,
): boolean {
  const children = all.filter((p) => p.parentId === pageId);
  return children.some((c) => c.id === candidateId || isPageDescendant(all, c.id, candidateId));
}

// The reduced page a `cyborg:pages_changed` broadcast carries for a non-public,
// owned page: its id + visibility ONLY — never the title/content/body, which are
// owner-only and must not fan out workspace-wide to non-owners (confidentiality
// leak). Mirrors the `deleted` op's id-only shape.
export interface PageBroadcastIdentity {
  id: string;
  visibility: string;
}

// Reduce a page to the SAFE payload for a `cyborg:pages_changed` created/updated
// broadcast. A restricted page (non-public + real owner — same predicate as
// isPageRestrictedFromUser, minus the per-recipient check) is stripped to
// id+visibility so its title/content never cross the wire to a non-owner; the
// stock UI ignores `payload.page` and refetches, so non-owners correctly see
// nothing and the owner refetches the real row. Public + legacy null-owner pages
// (visible to every member) are returned unchanged so their live refresh keeps
// the full row.
export function pageBroadcastPayload<T extends PageOwnerFields & { id: string }>(
  page: T,
): T | PageBroadcastIdentity {
  return page.visibility !== "public" && page.ownedBy !== null
    ? { id: page.id, visibility: page.visibility }
    : page;
}

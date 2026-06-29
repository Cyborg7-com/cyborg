// Pure archived-session pagination helpers. Dependency-free ON PURPOSE: the cloud
// relay (Postgres-only, no better-sqlite3) imports these to compute a GLOBAL
// next-cursor when it merges per-daemon archive pages, so they must NOT live in
// storage.ts — that file imports better-sqlite3 at its top, and a value import of
// it would drag the native module into the relay's startup graph and crash-loop
// the relay (ERR_MODULE_NOT_FOUND: better-sqlite3). Mirrors task-ordering.ts.

// The keyset tuple an archived-sessions page cursor encodes: the order key of the
// last row returned, so the next page resumes strictly AFTER it. The list order is
// (archived_at DESC, id DESC); archivedAt is epoch ms, id breaks ties so the
// keyset is total even when several sessions share a timestamp.
export interface ArchivedSessionCursor {
  archivedAt: number;
  id: string;
}

// Encode the last row of a page into an opaque base64url token. Callers treat it
// as opaque; the shape is private to these two helpers.
export function encodeArchivedSessionCursor(row: { archivedAt: number; id: string }): string {
  const cur: ArchivedSessionCursor = { archivedAt: row.archivedAt, id: row.id };
  return Buffer.from(JSON.stringify(cur), "utf8").toString("base64url");
}

// Decode an opaque cursor token. Returns undefined for missing/garbage input
// (treated as "first page") rather than throwing — a stale/forged cursor degrades
// to the start, never a 500.
export function decodeArchivedSessionCursor(token?: string): ArchivedSessionCursor | undefined {
  if (!token) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    // Validate it's a plain object (not null/array) with the right keyset fields —
    // `typeof null === "object"` and arrays also pass a bare object check, so a
    // crafted token can't slip a non-object through.
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      typeof (parsed as ArchivedSessionCursor).archivedAt !== "number" ||
      typeof (parsed as ArchivedSessionCursor).id !== "string"
    ) {
      return undefined;
    }
    return parsed as ArchivedSessionCursor;
  } catch {
    return undefined;
  }
}

// True when `row` sorts strictly AFTER `cursor` in (archived_at DESC, id DESC)
// order — i.e. it belongs on a later page. Used by the relay to cap a merged
// multi-daemon page and by any in-memory consumer that can't push the predicate
// into SQL.
export function isAfterArchivedSessionCursor(
  row: { archivedAt: number; id: string },
  cursor: ArchivedSessionCursor,
): boolean {
  if (row.archivedAt !== cursor.archivedAt) return row.archivedAt < cursor.archivedAt;
  return row.id < cursor.id;
}

// Finalize a relay's MERGED, already-sorted ((archived_at DESC, id DESC)) archived
// page: cap to `limit` and derive the global next-cursor. Pure so the relay's
// fan-out can be regression-tested without standing up the whole WS server.
//
// `daemonHasMore` MUST be the OR of every per-daemon `nextCursor != null`. It is
// load-bearing for the SINGLE-daemon case: each daemon already self-caps its
// response to `limit`, so the merged stream is ≤ limit and `sorted.length > limit`
// never fires — relying on that alone leaves the cursor permanently null and
// "Show more" dead. A daemon reports "more" only when it returned a full page, so
// this never fabricates a cursor for a genuinely-complete list. The cursor is the
// keyset of the last row actually returned, so the next page resumes strictly
// after it (no gap, no dup). No `limit` ⇒ full list + null cursor (legacy).
export function finalizeMergedArchivedPage<T extends { archivedAt: number; id: string }>(
  sorted: T[],
  opts: { limit?: number; daemonHasMore: boolean },
): { sessions: T[]; nextCursor: string | null } {
  const limit = opts.limit;
  if (limit === undefined || limit <= 0) return { sessions: sorted, nextCursor: null };
  const hasMore = sorted.length > limit || opts.daemonHasMore;
  const page = sorted.length > limit ? sorted.slice(0, limit) : sorted;
  if (!hasMore || page.length === 0) return { sessions: page, nextCursor: null };
  const last = page[page.length - 1];
  return {
    sessions: page,
    nextCursor: encodeArchivedSessionCursor({ archivedAt: last.archivedAt, id: last.id }),
  };
}

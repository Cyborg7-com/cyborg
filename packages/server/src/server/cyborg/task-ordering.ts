// Pure task ordering/pagination helpers. Dependency-free ON PURPOSE: the cloud
// relay (Postgres-only, no better-sqlite3) reaches these via db/pg-sync.ts, so
// they must NOT live in storage.ts — that file imports better-sqlite3 at its top,
// and a value import of it would drag the native module into the relay's startup
// graph and crash-loop the relay (ERR_MODULE_NOT_FOUND: better-sqlite3).

// The keyset tuple a tasks page cursor encodes: the order key of the last row
// returned, so the next page resumes strictly after it. sortOrder is nullable
// (NULLS LAST), createdAt is epoch ms, id breaks ties.
export interface TaskCursor {
  sortOrder: number | null;
  createdAt: number;
  id: string;
}

// Encode the last row of a page into an opaque base64url token. Callers treat it
// as opaque; the shape is private to these two helpers.
export function encodeTaskCursor(row: {
  sort_order?: number | null;
  created_at: number;
  id: string;
}): string {
  const cur: TaskCursor = {
    sortOrder: row.sort_order ?? null,
    createdAt: row.created_at,
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cur), "utf8").toString("base64url");
}

// Decode an opaque cursor token. Returns undefined for missing/garbage input
// (treated as "first page") rather than throwing — a stale/forged cursor degrades
// to the start, never a 500.
export function decodeTaskCursor(token?: string): TaskCursor | undefined {
  if (!token) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as TaskCursor;
    if (
      typeof parsed.createdAt !== "number" ||
      typeof parsed.id !== "string" ||
      !(parsed.sortOrder === null || typeof parsed.sortOrder === "number")
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

// Compute a sort_order strictly between two neighbours for a drag-reorder.
//   - both neighbours present → midpoint (fractional)
//   - only `after` (dropped at the TOP, above `after`) → afterSort - 1
//   - only `before` (dropped at the BOTTOM, below `before`) → beforeSort + 1
//   - neither (empty lane / unknown neighbours) → tailSort (append)
// `beforeSort`/`afterSort` are the neighbours' sort_order; a NULL neighbour sort
// is treated as absent (it has no stable slot to anchor against).
export function computeReorderSort(opts: {
  beforeSort: number | null;
  afterSort: number | null;
  tailSort: number;
}): number {
  const before = opts.beforeSort;
  const after = opts.afterSort;
  if (before !== null && after !== null) return (before + after) / 2;
  if (after !== null) return after - 1;
  if (before !== null) return before + 1;
  return opts.tailSort;
}

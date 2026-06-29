/**
 * Per-scope sync metadata (last-synced seq cursor + last-read cursor +
 * last-accessed for LRU eviction) and the singleton "which user is this cache
 * for" guard.
 *
 * `lastSyncedSeq` is bookkeeping for a future delta path; the wire-in here uses
 * stale-while-revalidate (full window refetch), but the cursor is kept so a
 * delta-sync revalidation can be added without a schema change.
 *
 * `lastAccessedAt` drives eviction: when total stored scopes exceed the cap,
 * oldest-accessed scopes get dropped first.
 *
 * Caveat #29: TTL/lastSynced is only ever stamped by callers on a fetch
 * SUCCESS, never on a miss/error — a transient failure must not pin stale
 * state. `setMeta` enforces monotonicity so an out-of-order stamp can't rewind.
 */

import { getDB, reqDone, txDone, STORES, INDEXES, type SyncMeta, type AppMeta } from "./idb.js";

export async function getMeta(scopeKey: string): Promise<SyncMeta | null> {
  const dbp = getDB();
  if (!dbp) return null;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.SYNC_META, "readonly");
    const row = await reqDone(tx.objectStore(STORES.SYNC_META).get(scopeKey));
    return (row as SyncMeta | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Upsert. `lastAccessedAt` always advances. `lastSyncedSeq` and `lastReadAt`
 * advance monotonically — passing an older value is a no-op (so re-fetching
 * older history can't rewind the cursors). Passing `lastReadAt: null`
 * explicitly clears it.
 */
export async function setMeta(
  scopeKey: string,
  patch: Partial<Pick<SyncMeta, "lastSyncedSeq" | "lastAccessedAt" | "lastReadAt">>,
): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.SYNC_META, "readwrite");
    const store = tx.objectStore(STORES.SYNC_META);
    const existing = (await reqDone(store.get(scopeKey))) as SyncMeta | undefined;
    const now = Date.now();

    let nextSeq = existing?.lastSyncedSeq ?? 0;
    if (typeof patch.lastSyncedSeq === "number" && patch.lastSyncedSeq > nextSeq) {
      nextSeq = patch.lastSyncedSeq;
    }

    let nextRead = existing?.lastReadAt ?? null;
    if (patch.lastReadAt === null) {
      nextRead = null;
    } else if (typeof patch.lastReadAt === "number") {
      if (nextRead === null || patch.lastReadAt > nextRead) nextRead = patch.lastReadAt;
    }

    store.put({
      scopeKey,
      lastSyncedSeq: nextSeq,
      lastReadAt: nextRead,
      lastAccessedAt: patch.lastAccessedAt ?? now,
      firstCachedAt: existing?.firstCachedAt ?? now,
    } satisfies SyncMeta);
    await txDone(tx);
  } catch {
    /* swallow — best-effort */
  }
}

/** Mark a scope just-accessed without changing sync state. */
export async function touchScope(scopeKey: string): Promise<void> {
  await setMeta(scopeKey, { lastAccessedAt: Date.now() });
}

/** All scopes ordered oldest-accessed first. Used by the eviction sweep. */
export async function listScopesByAccess(): Promise<SyncMeta[]> {
  const dbp = getDB();
  if (!dbp) return [];
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.SYNC_META, "readonly");
    const all = await reqDone(
      tx.objectStore(STORES.SYNC_META).index(INDEXES.ACCESSED).getAll(),
    );
    return (all as SyncMeta[]) ?? [];
  } catch {
    return [];
  }
}

export async function deleteMeta(scopeKey: string): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.SYNC_META, "readwrite");
    tx.objectStore(STORES.SYNC_META).delete(scopeKey);
    await txDone(tx);
  } catch {
    /* */
  }
}

// ── App-level singleton meta ────────────────────────────────────────────────

const APP_META_USER_ID = "currentUserId";

/** Read the user id this cache was last populated for (shared-WebView guard). */
export async function getCachedUserId(): Promise<string | null> {
  const dbp = getDB();
  if (!dbp) return null;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.APP_META, "readonly");
    const row = (await reqDone(tx.objectStore(STORES.APP_META).get(APP_META_USER_ID))) as
      | AppMeta
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setCachedUserId(userId: string): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.APP_META, "readwrite");
    tx.objectStore(STORES.APP_META).put({ key: APP_META_USER_ID, value: userId });
    await txDone(tx);
  } catch {
    /* */
  }
}

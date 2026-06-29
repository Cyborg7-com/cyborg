/**
 * L2 (IndexedDB) message operations. All writes are scope-keyed. Reads return
 * `CachedMessage` rows; callers hydrate them back to `Message` via
 * `transform.fromCached`.
 *
 * Quota handling: write methods catch `QuotaExceededError`, evict the oldest
 * scopes, and retry once. If the retry still fails the batch is dropped — the
 * cache is best-effort and the network path is the source of truth.
 *
 * Every operation is wrapped so a failure degrades to a no-op (or `[]` for
 * reads) instead of throwing into the caller — the cache must never break the
 * existing fetch path (additive/safe).
 */

import {
  getDB,
  reqDone,
  txDone,
  STORES,
  INDEXES,
  createdAtKey,
  type CachedMessage,
} from "./idb.js";
import { setMeta, listScopesByAccess, deleteMeta } from "./meta.js";

/** Total scope count above which the eviction sweep runs. */
const MAX_SCOPES = 50;
/** When evicting on demand, drop down to this floor before retrying. */
const TARGET_SCOPES_AFTER_EVICT = 30;

const LOW_KEY = createdAtKey(0);
const HIGH_KEY = "9".repeat(20);

// ── Read paths ──────────────────────────────────────────────────────────────

/**
 * Most-recent N top-level (non-thread, non-deleted) messages for a scope, in
 * chronological ASC order — the same order the rewrite state holds them in.
 * Opens a DESC cursor, takes N, reverses to ASC.
 */
export async function getRecent(scopeKey: string, limit = 50): Promise<CachedMessage[]> {
  const dbp = getDB();
  if (!dbp) return [];
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.MESSAGES, "readonly");
    const idx = tx.objectStore(STORES.MESSAGES).index(INDEXES.SCOPE_CREATED);
    const range = IDBKeyRange.bound([scopeKey, LOW_KEY], [scopeKey, HIGH_KEY]);
    const out: CachedMessage[] = [];
    const req = idx.openCursor(range, "prev");
    await new Promise<void>((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) {
          resolve();
          return;
        }
        const m = cursor.value as CachedMessage;
        if (!m.parentId && !m.deleted) out.push(m);
        cursor.continue();
      };
    });
    return out.reverse();
  } catch {
    return [];
  }
}

/** Resolve thread replies by parent id (id is unique, no scope needed). */
export async function getThreadReplies(parentId: string): Promise<CachedMessage[]> {
  const dbp = getDB();
  if (!dbp) return [];
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.MESSAGES, "readonly");
    const all = (await reqDone(
      tx.objectStore(STORES.MESSAGES).index(INDEXES.PARENT).getAll(parentId),
    )) as CachedMessage[];
    return all
      .filter((m) => !m.deleted)
      .sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq);
  } catch {
    return [];
  }
}

// ── Write paths ─────────────────────────────────────────────────────────────

/**
 * Bulk upsert in a single transaction. Quota-exceeded triggers an eviction
 * sweep + one retry. Touches each unique scope's `lastAccessedAt`.
 */
export async function putMany(messages: CachedMessage[]): Promise<void> {
  if (messages.length === 0) return;
  const dbp = getDB();
  if (!dbp) return;
  const writeOnce = async () => {
    const db = await dbp;
    const tx = db.transaction(STORES.MESSAGES, "readwrite");
    const store = tx.objectStore(STORES.MESSAGES);
    for (const m of messages) store.put(m);
    await txDone(tx);
  };
  try {
    await writeOnce();
  } catch (err) {
    if ((err as { name?: string })?.name === "QuotaExceededError") {
      await evictOldestScopes(MAX_SCOPES - TARGET_SCOPES_AFTER_EVICT);
      try {
        await writeOnce();
      } catch {
        /* second failure: drop the batch */
      }
    }
    // Other errors: swallow — cache is best-effort.
  }
  const scopes = new Set(messages.map((m) => m.scopeKey));
  await Promise.all([...scopes].map((s) => setMeta(s, { lastAccessedAt: Date.now() })));
}

export async function putOne(message: CachedMessage): Promise<void> {
  await putMany([message]);
}

/**
 * Replace an optimistic local-id row with its real-id equivalent (delete-old +
 * put-new in one tx). Used after a send echo swaps the local bubble.
 */
export async function swapId(localId: string, real: CachedMessage): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.MESSAGES, "readwrite");
    const store = tx.objectStore(STORES.MESSAGES);
    store.delete(localId);
    store.put(real);
    await txDone(tx);
  } catch {
    /* */
  }
}

/**
 * Soft-delete by id — mark `deleted` so reads filter it out but the row stays
 * for reconciliation. Also drops replies of a deleted root (server cascades).
 */
export async function markDeleted(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.MESSAGES, "readwrite");
    const store = tx.objectStore(STORES.MESSAGES);
    const now = Date.now();
    for (const id of ids) {
      const existing = (await reqDone(store.get(id))) as CachedMessage | undefined;
      if (existing) {
        store.put({ ...existing, deleted: true, text: "", reactions: [], updatedAt: now });
      }
    }
    // Cascade: tombstone children whose parentId is a deleted id.
    const childIdx = store.index(INDEXES.PARENT);
    for (const id of ids) {
      const children = (await reqDone(childIdx.getAll(id))) as CachedMessage[];
      for (const c of children) store.put({ ...c, deleted: true, updatedAt: now });
    }
    await txDone(tx);
  } catch {
    /* */
  }
}

/**
 * Reconcile a scope against the authoritative network response. Drops every
 * IDB top-level row in `[oldestCreatedAt, newestCreatedAt]` whose id is NOT in
 * `knownIds` — catches phantoms (orphan optimistic writes, stale rows, WS
 * events whose write landed but the server never persisted). Bounded by the
 * response window so older paginated history and newer live messages survive.
 */
export async function reconcileScope(
  scopeKey: string,
  knownIds: Set<string>,
  oldestCreatedAt: number,
  newestCreatedAt: number,
): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  if (!Number.isFinite(oldestCreatedAt) || !Number.isFinite(newestCreatedAt)) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.MESSAGES, "readwrite");
    const idx = tx.objectStore(STORES.MESSAGES).index(INDEXES.SCOPE_CREATED);
    const range = IDBKeyRange.bound(
      [scopeKey, createdAtKey(oldestCreatedAt)],
      [scopeKey, createdAtKey(newestCreatedAt)],
    );
    const req = idx.openCursor(range);
    await new Promise<void>((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        const m = cursor.value as CachedMessage;
        // Skip thread replies — not returned by the top-level fetch window.
        if (!m.parentId && !knownIds.has(m.id)) cursor.delete();
        cursor.continue();
      };
    });
    await txDone(tx);
  } catch {
    /* */
  }
}

/** Drop every message + sync meta for a scope. */
export async function dropScope(scopeKey: string): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.MESSAGES, "readwrite");
    const idx = tx.objectStore(STORES.MESSAGES).index(INDEXES.SCOPE_CREATED);
    const range = IDBKeyRange.bound([scopeKey, LOW_KEY], [scopeKey, HIGH_KEY]);
    const req = idx.openCursor(range);
    await new Promise<void>((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve();
          return;
        }
        cursor.delete();
        cursor.continue();
      };
    });
    await txDone(tx);
  } catch {
    /* */
  }
  await deleteMeta(scopeKey);
}

// ── Eviction ────────────────────────────────────────────────────────────────

/** Drop the N least-recently-accessed scopes (and their messages). */
export async function evictOldestScopes(count: number): Promise<void> {
  if (count <= 0) return;
  const scopes = await listScopesByAccess(); // ASC by lastAccessedAt
  for (let i = 0; i < Math.min(count, scopes.length); i++) {
    await dropScope(scopes[i].scopeKey);
  }
}

/** Run at init. No-op if under the cap. */
export async function evictIfOverCap(): Promise<void> {
  const scopes = await listScopesByAccess();
  if (scopes.length <= MAX_SCOPES) return;
  await evictOldestScopes(scopes.length - TARGET_SCOPES_AFTER_EVICT);
}

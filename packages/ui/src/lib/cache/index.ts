/**
 * Public API for the local message cache (L1 memory + L2 IndexedDB), a 3-tier
 * stale-while-revalidate store ported from v1. Used ONLY on the Tauri iOS shell
 * (callers gate on `isTauriIOS()`) to deliver an instant cold render with no
 * skeleton flash; everywhere else this module is never invoked.
 *
 * Everything here is best-effort and fire-and-forget: a miss or any error must
 * degrade to the existing network fetch path. No call here ever throws into the
 * caller.
 *
 * Caveat #28: the L1 Map lives in the plain `.ts` `memCacheStore.ts` singleton.
 * Caveat #29: sync/read cursors are stamped by callers ONLY on fetch success.
 */

import { closeDB, getDB, isAvailable, type CachedMessage } from "./idb.js";
import { getCachedUserId, setCachedUserId, setMeta } from "./meta.js";
import {
  evictIfOverCap,
  putMany,
  putOne,
  swapId,
  markDeleted,
  reconcileScope,
  dropScope,
} from "./messages.js";
import { memClear, memDrop, memUpdate } from "./memCache.js";
import { toCached } from "./transform.js";
import type { Message, Reaction, ReactionEvent } from "../core/types.js";

// ── Re-exports (single import namespace) ─────────────────────────────────────

export { channelScope, dmScope, parseScope, type ScopeKind } from "./scope.js";
export { memGet, memUpdate, memDrop, readCache, type MemCacheEntry } from "./memCache.js";
export { getRecent, getThreadReplies } from "./messages.js";
export { getMeta, setMeta, touchScope } from "./meta.js";
export { isAvailable, type CachedMessage } from "./idb.js";
export { toCached, fromCached } from "./transform.js";
// Persistent send outbox (#502). NOT iOS-gated — an undelivered send must
// survive reload on every surface. See ./outbox.ts.
export {
  putOutbox,
  deleteOutbox,
  getOutboxForUser,
  clearOutbox,
  recordToCommand,
  recordToOptimisticMessage,
  localIdFor,
  type OutboxRecord,
  type OutboxCommand,
} from "./outbox.js";

// ── Lifecycle ────────────────────────────────────────────────────────────────

let initPromise: Promise<void> | null = null;
let initForUserId: string | null = null;

/**
 * Open the DB and reconcile against the current session user. Wipes the cache
 * if a DIFFERENT user previously owned it (shared-device scenario) so user B
 * never sees user A's messages. Idempotent per user within a session.
 */
export function cacheInit(userId: string): Promise<void> {
  if (!isAvailable() || !userId) return Promise.resolve();
  if (initPromise && initForUserId === userId) return initPromise;
  initForUserId = userId;
  initPromise = (async () => {
    try {
      const cachedUserId = await getCachedUserId();
      if (cachedUserId && cachedUserId !== userId) {
        await cacheClear();
        initForUserId = userId;
      }
      await setCachedUserId(userId);
      await evictIfOverCap();
    } catch {
      /* best-effort */
    }
  })();
  return initPromise;
}

/** Wipe L1 + L2 (sign-out / user switch). */
export async function cacheClear(): Promise<void> {
  memClear();
  if (!isAvailable()) return;
  try {
    const dbp = getDB();
    if (!dbp) return;
    const db = await dbp;
    const tx = db.transaction(["messages", "syncMeta", "appMeta"], "readwrite");
    tx.objectStore("messages").clear();
    tx.objectStore("syncMeta").clear();
    tx.objectStore("appMeta").clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* */
  }
  initPromise = null;
  initForUserId = null;
}

/** Hard reset — close + delete the DB (corruption recovery; not normally used). */
export async function cacheDestroy(): Promise<void> {
  memClear();
  if (!isAvailable()) return;
  await closeDB();
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("cyborg7-cache");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    /* */
  }
  initPromise = null;
  initForUserId = null;
}

// ── High-level writeback helpers (what app.svelte.ts calls) ──────────────────

/**
 * Persist the authoritative window for a scope after a SUCCESSFUL network
 * fetch: writes the rows to L2, reconciles phantoms inside the response window,
 * refreshes L1, and stamps the sync + (optional) read cursors. Caveat #29 — the
 * caller only calls this on success, never on a miss/error.
 *
 * `messages` is the full in-memory list the UI is showing (top-level only is
 * fine — replies are written separately by the thread path). Fire-and-forget.
 */
export async function writeScopeMessages(
  scopeKey: string,
  memKey: string,
  messages: Message[],
  lastReadAt: number | null,
): Promise<void> {
  // Refresh L1 synchronously-ish (it's a sync Map op wrapped in async).
  memUpdate(memKey, messages, lastReadAt);
  try {
    const topLevel = messages.filter((m) => !m.parentId && !m.id.startsWith("local-"));
    const rows: CachedMessage[] = topLevel.map((m) => toCached(scopeKey, m));
    if (rows.length === 0) {
      await setMeta(scopeKey, { lastAccessedAt: Date.now(), lastReadAt: lastReadAt ?? undefined });
      return;
    }
    await putMany(rows);
    const ids = new Set(rows.map((r) => r.id));
    let oldest = rows[0].createdAt;
    let newest = rows[0].createdAt;
    let maxSeq = 0;
    for (const r of rows) {
      if (r.createdAt < oldest) oldest = r.createdAt;
      if (r.createdAt > newest) newest = r.createdAt;
      if (r.seq > maxSeq) maxSeq = r.seq;
    }
    await reconcileScope(scopeKey, ids, oldest, newest);
    await setMeta(scopeKey, {
      lastSyncedSeq: maxSeq,
      lastReadAt: lastReadAt ?? undefined,
      lastAccessedAt: Date.now(),
    });
  } catch {
    /* best-effort */
  }
}

/** Upsert a single live message (channel_message / dm). Fire-and-forget. */
export async function cacheUpsertMessage(scopeKey: string, msg: Message): Promise<void> {
  try {
    if (msg.id.startsWith("local-")) return; // don't persist optimistic rows
    await putOne(toCached(scopeKey, msg));
  } catch {
    /* */
  }
}

/** Swap an optimistic local row for its real-id echo. Fire-and-forget. */
export async function cacheSwapId(scopeKey: string, localId: string, real: Message): Promise<void> {
  try {
    await swapId(localId, toCached(scopeKey, real));
  } catch {
    /* */
  }
}

/** Edit a message's text in place. Fire-and-forget. */
export async function cacheEditMessage(messageId: string, text: string): Promise<void> {
  try {
    await patchById(messageId, (m) => ({ ...m, text, updatedAt: Date.now() }));
  } catch {
    /* */
  }
}

/** Tombstone a message (+ cascade replies). Fire-and-forget. */
export async function cacheDeleteMessage(messageId: string): Promise<void> {
  try {
    await markDeleted([messageId]);
  } catch {
    /* */
  }
}

/** Patch a message's pin state. Fire-and-forget. */
export async function cachePinMessage(
  messageId: string,
  pinnedAt: number | null,
  pinnedBy: string | null,
): Promise<void> {
  try {
    await patchById(messageId, (m) => ({ ...m, pinnedAt, pinnedBy }));
  } catch {
    /* */
  }
}

/** Patch unfurls onto a message. Fire-and-forget. */
export async function cacheUnfurlMessage(messageId: string, unfurls: unknown[]): Promise<void> {
  try {
    await patchById(messageId, (m) => ({ ...m, unfurls }));
  } catch {
    /* */
  }
}

/**
 * Apply a reaction event to the cached row, mirroring app.svelte.ts's in-memory
 * reaction reducer so the cache stays consistent. Fire-and-forget.
 */
export async function cacheApplyReaction(event: ReactionEvent): Promise<void> {
  try {
    await patchById(event.messageId, (m) => {
      const reactions: Reaction[] = [...(m.reactions ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === event.emoji);
      if (event.action === "removed") {
        if (idx >= 0) {
          const r = reactions[idx];
          if (r.count <= 1) reactions.splice(idx, 1);
          else
            reactions[idx] = {
              ...r,
              count: r.count - 1,
              reactorNames: r.reactorNames?.filter((n) => n !== event.fromName),
            };
        }
      } else if (idx >= 0) {
        reactions[idx] = {
          ...reactions[idx],
          count: reactions[idx].count + 1,
          reactorNames: [...(reactions[idx].reactorNames ?? []), event.fromName ?? "Unknown"],
        };
      } else {
        reactions.push({
          emoji: event.emoji,
          count: 1,
          reacted: false,
          reactorNames: [event.fromName ?? "Unknown"],
        });
      }
      return { ...m, reactions: reactions as CachedMessage["reactions"], updatedAt: Date.now() };
    });
  } catch {
    /* */
  }
}

/** Drop a scope entirely (channel deleted / left). Fire-and-forget. */
export async function cacheDropScope(memKey: string, scopeKey: string): Promise<void> {
  memDrop(memKey);
  try {
    await dropScope(scopeKey);
  } catch {
    /* */
  }
}

// Read-modify-write a single cached row by id (used by the live-patch helpers).
async function patchById(id: string, fn: (m: CachedMessage) => CachedMessage): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  const db = await dbp;
  const tx = db.transaction("messages", "readwrite");
  const store = tx.objectStore("messages");
  const existing = await new Promise<CachedMessage | undefined>((resolve, reject) => {
    const r = store.get(id);
    r.onsuccess = () => resolve(r.result as CachedMessage | undefined);
    r.onerror = () => reject(r.error);
  });
  if (existing) store.put(fn(existing));
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

/**
 * In-memory L1 LRU cache on top of IDB (L2). Provides SYNCHRONOUS reads so a
 * chat page can paint instantly on mount with no await and no skeleton.
 *
 * Layers:
 *   - L1 memory (this file + memCacheStore.ts) — synchronous, lost on close
 *   - L2 IDB (messages.ts)                      — async, survives restart
 *   - Network                                   — authoritative (SWR)
 *
 * Open flow (in app.svelte.ts selectChannel/selectDm, iOS-gated):
 *   1. memGet(key) — instant. Hit → render + loading=false.
 *   2. Else readCache(scopeKey, key) — async L2 read, hydrates L1.
 *   3. Network fetch in background → setMessages/mergeServer + writeback.
 *
 * The Map lives in the plain `.ts` sibling `memCacheStore.ts` (Caveat #28);
 * this module is intentionally a plain `.ts` too (no runes — just functions).
 */

import type { Message } from "../core/types.js";
import { getRecent } from "./messages.js";
import { getMeta } from "./meta.js";
import { fromCached } from "./transform.js";
import { sharedMemCache, type SharedMemCacheEntry } from "./memCacheStore.js";

export type MemCacheEntry = SharedMemCacheEntry;

const MAX_ENTRIES = 20;
const LRU_KEEP = 15;

const mem = sharedMemCache;

/** Synchronous L1 peek. Re-inserts on hit so the Map's insertion order = LRU. */
export function memGet(key: string): MemCacheEntry | null {
  const entry = mem.get(key);
  if (!entry) return null;
  mem.delete(key);
  entry.ts = Date.now();
  mem.set(key, entry);
  return entry;
}

export function memSet(key: string, messages: Message[], lastReadAt: number | null): void {
  mem.delete(key);
  mem.set(key, { messages, lastReadAt, ts: Date.now() });
  if (mem.size > MAX_ENTRIES) {
    const it = mem.keys();
    const evict = mem.size - LRU_KEEP;
    for (let i = 0; i < evict; i++) {
      const k = it.next().value;
      if (k !== undefined) mem.delete(k);
    }
  }
}

/**
 * Read L1 (sync) then L2 (async). Returns an entry if either tier hits; null
 * on a full miss. On an L2 hit it hydrates L1 so subsequent opens are sync.
 */
export async function readCache(scopeKey: string, memKey: string): Promise<MemCacheEntry | null> {
  const hit = memGet(memKey);
  if (hit) return hit;
  try {
    const [rows, meta] = await Promise.all([getRecent(scopeKey, 50), getMeta(scopeKey)]);
    if (rows.length === 0) return null;
    const messages = rows.map(fromCached);
    memSet(memKey, messages, meta?.lastReadAt ?? null);
    return mem.get(memKey) ?? null;
  } catch {
    return null;
  }
}

/** Update L1 with the authoritative message list (after a network fetch). */
export function memUpdate(memKey: string, messages: Message[], lastReadAt: number | null): void {
  memSet(memKey, messages, lastReadAt);
}

/** Drop one scope's L1 entry (e.g. on channel-leave). */
export function memDrop(memKey: string): void {
  mem.delete(memKey);
}

/** Wipe the whole L1 cache (e.g. on logout / user switch). */
export function memClear(): void {
  mem.clear();
}

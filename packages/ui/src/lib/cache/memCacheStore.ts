/**
 * Plain `.ts` (NO `.svelte.ts` suffix) container for the in-memory (L1) chat
 * cache Map — Caveat #28.
 *
 * v1 learned the hard way: a `.svelte.ts` module gets re-instantiated per
 * chat-page navigation on iOS WKWebView prod builds (Svelte 5's module-state
 * file handling + Vite chunk-split create per-import records). Stamping a
 * per-instance random id and watching `MEMINIT id=...` fire 3+ times with
 * different ids in a 10s window proved it. Even stashing the Map on
 * `globalThis` from within the `.svelte.ts` didn't survive — each
 * re-instantiation saw a fresh `globalThis` view.
 *
 * Keeping the Map in this plain `.ts` file (NOT touched by Svelte's compiler)
 * gives a true singleton: one ESM module record, one Map, shared across every
 * consumer. The cache logic in `memCache.ts` imports from here.
 */

import type { Message } from "../core/types.js";

export interface SharedMemCacheEntry {
  messages: Message[];
  lastReadAt: number | null;
  ts: number;
}

export const sharedMemCache = new Map<string, SharedMemCacheEntry>();

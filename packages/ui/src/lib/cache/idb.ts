/**
 * IndexedDB wrapper for the persistent (L2) message cache.
 *
 * Ported from v1 (`mobile/src/lib/cache/idb.ts`) but rewritten on the *raw*
 * IndexedDB API instead of the `idb` npm package, so the cache adds ZERO new
 * dependencies to packages/ui — it is fully self-contained under `lib/cache/`.
 *
 * Schema is intentionally generic: one `messages` store keyed by message id,
 * with composite indexes that let us:
 *   - read the N most recent messages for a scope (channel or DM) in
 *     `[scopeKey, createdAt]` order;
 *   - resolve a thread's replies via `parentId`.
 *
 * Scope keys are constructed in `scope.ts` (`wsId:ch:channelId`,
 * `wsId:dm:peerId`) so both message surfaces share a single store and a
 * single eviction policy. (v1 also had a `dma` agent-DM scope — the rewrite
 * routes agent conversations through `agentStreamState`, not selectDm, so
 * there is no agent-DM scope here.)
 *
 * The `syncMeta` store holds per-scope bookkeeping (last sync cursor, last
 * read cursor, last access time for LRU eviction). `appMeta` stores singleton
 * flags (currently the user id we cached for, so a different user opening the
 * same WebView triggers a wipe).
 *
 * SSR-safe + WebView-safe: every helper short-circuits when `indexedDB` is
 * unavailable (server, very old browser, Safari private mode for the first
 * session) and every operation is wrapped so a failure degrades to "no cache"
 * rather than throwing into the caller.
 */

export const DB_NAME = "cyborg7-cache";
// v2 (#502): adds the `outbox` store for messages whose send couldn't be
// delivered (socket down / unauthenticated). Persisting it means an offline send
// survives a reload instead of being lost with the in-memory replay queue.
export const DB_VERSION = 2;

/**
 * Stored message shape. `createdAt`/`updatedAt` are epoch-ms numbers to match
 * the rewrite's `Message` type (v1 stored ISO strings). The composite index is
 * keyed on the zero-padded createdAt STRING (`createdAtKey`) so a lexicographic
 * cursor scan == chronological order regardless of number width.
 *
 * `cachedAt` is local-clock epoch ms used purely for LRU/orphan eviction.
 */
export interface CachedMessage {
  id: string;
  scopeKey: string;
  workspaceId: string | null;
  channelId: string | null;
  fromId: string;
  fromType: "human" | "agent" | "system";
  fromName: string | null;
  toId: string | null;
  text: string;
  mentions: string[] | null;
  parentId: string | null;
  attachments: unknown[] | null;
  unfurls: unknown[] | null;
  reactions: CachedReaction[];
  pinnedAt: number | null;
  pinnedBy: string | null;
  replyCount: number;
  lastReplyAt: number | null;
  threadParticipants: { name: string; image?: string | null }[] | null;
  seq: number;
  createdAt: number;
  updatedAt: number | null;
  /** Zero-padded createdAt for lexicographic index ordering. */
  createdAtKey: string;
  cachedAt: number;
  deleted: boolean;
}

export interface CachedReaction {
  emoji: string;
  count: number;
  reacted: boolean;
  reactorNames?: string[];
}

export interface SyncMeta {
  scopeKey: string;
  /** Highest message `seq` we've cached for this scope (delta-sync cursor). */
  lastSyncedSeq: number;
  /** The user's read cursor (epoch ms) so a cold revisit can render the
   *  unread divider without waiting on the network. */
  lastReadAt: number | null;
  /** Epoch ms. Used for LRU eviction when total scope count is too high. */
  lastAccessedAt: number;
  /** Epoch ms. When we first cached this scope (telemetry / debugging). */
  firstCachedAt: number;
}

interface AppMeta {
  key: string;
  value: string;
}

/**
 * A queued send that couldn't be delivered (socket down or open-but-
 * unauthenticated). Persisted so an offline send survives a reload (#502) — the
 * in-memory replay queue is rebuilt from these on startup, and each row is
 * deleted once its broadcast echo reconciles the optimistic bubble.
 *
 * Keyed by `clientMsgId` (#501): the same id is stamped on the optimistic
 * bubble and echoed by the relay, so a delivered send is dequeued exactly and a
 * replay never duplicates. Everything stored is JSON-serializable — no closures.
 */
export interface OutboxRecord {
  /** Client-generated id; also the optimistic row's id (`local-<clientMsgId>`). */
  clientMsgId: string;
  /** Owning user — lets a shared-WebView wipe drop another user's queue. */
  userId: string;
  kind: "channel" | "dm";
  workspaceId: string;
  /** Channel id (channel send) or peer user id (DM send). */
  targetId: string;
  text: string;
  mentions: string[] | null;
  attachments: unknown[] | null;
  /** Thread root id when this is a threaded send; null for top-level. */
  parentId: string | null;
  /** Epoch ms the send was first attempted — preserves chronological replay. */
  createdAt: number;
}

const STORE_MESSAGES = "messages";
const STORE_SYNC_META = "syncMeta";
const STORE_APP_META = "appMeta";
const STORE_OUTBOX = "outbox";

const IDX_SCOPE_CREATED = "by-scope-created";
const IDX_PARENT = "by-parent";
const IDX_ACCESSED = "by-accessed";

/** 20-char zero-padded numeric string — fits any JS-safe epoch-ms integer. */
export function createdAtKey(createdAt: number): string {
  const n = Number.isFinite(createdAt) ? Math.max(0, Math.floor(createdAt)) : 0;
  return String(n).padStart(20, "0");
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** True when IDB is usable in the current runtime. */
export function isAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/**
 * Lazy DB open. Multiple callers share one connection. Schema upgrades go in
 * `onupgradeneeded` — bump `DB_VERSION` and add a branch for future changes.
 */
export function getDB(): Promise<IDBDatabase> | null {
  if (!isAvailable()) return null;
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
          const messages = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
          messages.createIndex(IDX_SCOPE_CREATED, ["scopeKey", "createdAtKey"]);
          messages.createIndex(IDX_PARENT, "parentId");
        }
        if (!db.objectStoreNames.contains(STORE_SYNC_META)) {
          const syncMeta = db.createObjectStore(STORE_SYNC_META, { keyPath: "scopeKey" });
          syncMeta.createIndex(IDX_ACCESSED, "lastAccessedAt");
        }
        if (!db.objectStoreNames.contains(STORE_APP_META)) {
          db.createObjectStore(STORE_APP_META, { keyPath: "key" });
        }
        // v2 (#502): persistent send outbox, keyed by clientMsgId.
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          db.createObjectStore(STORE_OUTBOX, { keyPath: "clientMsgId" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab/instance wants to upgrade → close so it can proceed.
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* */
          }
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        // An older connection is holding the DB; the open will resolve once it
        // closes. Nothing to surface — transient.
      };
    });
    // If the open ever rejects, drop the cached promise so the next call retries.
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

/** Promisify an IDBRequest. */
export function reqDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Promisify a transaction completing. */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const STORES = {
  MESSAGES: STORE_MESSAGES,
  SYNC_META: STORE_SYNC_META,
  APP_META: STORE_APP_META,
  OUTBOX: STORE_OUTBOX,
} as const;

export const INDEXES = {
  SCOPE_CREATED: IDX_SCOPE_CREATED,
  PARENT: IDX_PARENT,
  ACCESSED: IDX_ACCESSED,
} as const;

export type { AppMeta };

/** Force-close the connection so the next caller re-opens. */
export async function closeDB(): Promise<void> {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    db.close();
  } catch {
    /* */
  }
  dbPromise = null;
}

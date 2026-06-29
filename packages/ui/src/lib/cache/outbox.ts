/**
 * Persistent send outbox (#502).
 *
 * A message sent while the socket is down (relay deploying) or open-but-
 * unauthenticated (post-reconnect auth race) is queued for replay. Before this,
 * that queue was an in-memory array of closures (`app.svelte.ts`), so a reload
 * dropped any undelivered send — the optimistic bubble showed "Sending…" but the
 * replay was gone, and the bubble itself vanished (channel/DM state isn't
 * persisted on web). Here we persist a JSON-serializable description of each
 * queued send to IndexedDB so it survives a reload and replays after reconnect.
 *
 * Unlike the message *cache* (`index.ts`), the outbox is NOT iOS-gated: losing an
 * unsent message on reload is a correctness bug on every surface, so this runs
 * wherever IndexedDB exists. Like the rest of `lib/cache/`, it is best-effort and
 * self-contained (raw IndexedDB, zero new deps) and degrades to "no persistence"
 * — never throwing into the caller — when IndexedDB is unavailable.
 *
 * The idb helpers here are the only IndexedDB-touching code; the record↔command
 * and record↔optimistic-message mappings are pure functions so they can be
 * unit-tested in the node vitest env (where IndexedDB is absent and every idb
 * helper no-ops).
 */

import { getDB, reqDone, txDone, STORES, type OutboxRecord } from "./idb.js";
import type { Attachment, Message } from "../core/types.js";

export type { OutboxRecord };

/** The optimistic row id derived from a record's clientMsgId. */
export function localIdFor(clientMsgId: string): string {
  return `local-${clientMsgId}`;
}

/**
 * The argument tuple for `client.sendMessage` / `client.sendDm`. Pure — lets the
 * replay path stay a thin `kind`-switch and keeps the wire shape unit-testable.
 *
 * `channel`: (workspaceId, channelId, text, mentions, attachments, parentId, clientMsgId)
 * `dm`:      (workspaceId, toId, text, attachments, parentId, clientMsgId)
 */
export type OutboxCommand =
  | {
      kind: "channel";
      args: [
        workspaceId: string,
        channelId: string,
        text: string,
        mentions: string[] | undefined,
        attachments: Attachment[] | undefined,
        parentId: string | undefined,
        clientMsgId: string,
      ];
    }
  | {
      kind: "dm";
      args: [
        workspaceId: string,
        toId: string,
        text: string,
        attachments: Attachment[] | undefined,
        parentId: string | undefined,
        clientMsgId: string,
      ];
    };

/** Map a stored record to the client send-call it should replay. Pure. */
export function recordToCommand(rec: OutboxRecord): OutboxCommand {
  const attachments = (rec.attachments as Attachment[] | null) ?? undefined;
  const parentId = rec.parentId ?? undefined;
  if (rec.kind === "dm") {
    return {
      kind: "dm",
      args: [rec.workspaceId, rec.targetId, rec.text, attachments, parentId, rec.clientMsgId],
    };
  }
  const mentions = rec.mentions ?? undefined;
  return {
    kind: "channel",
    args: [
      rec.workspaceId,
      rec.targetId,
      rec.text,
      mentions,
      attachments,
      parentId,
      rec.clientMsgId,
    ],
  };
}

/**
 * Rebuild the optimistic bubble for a persisted record on cold start, so a
 * reload re-shows the queued send (as "pending") in its channel/DM. Carries the
 * SAME clientMsgId so the eventual broadcast echo reconciles this exact row
 * (#501) — no duplicate. Pure.
 */
export function recordToOptimisticMessage(rec: OutboxRecord, fromName: string): Message {
  return {
    id: localIdFor(rec.clientMsgId),
    workspaceId: rec.workspaceId,
    channelId: rec.kind === "channel" ? rec.targetId : null,
    fromId: rec.userId,
    fromType: "human",
    fromName,
    toId: rec.kind === "dm" ? rec.targetId : null,
    text: rec.text,
    mentions: rec.mentions ?? [],
    parentId: rec.parentId,
    attachments: (rec.attachments as Attachment[] | null) ?? null,
    sendStatus: "pending",
    clientMsgId: rec.clientMsgId,
    seq: 0,
    createdAt: rec.createdAt,
  };
}

// ── IndexedDB CRUD (best-effort; no-ops when IDB is unavailable) ──────────────

/** Persist (or overwrite) a queued send. */
export async function putOutbox(rec: OutboxRecord): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.OUTBOX, "readwrite");
    tx.objectStore(STORES.OUTBOX).put(rec);
    await txDone(tx);
  } catch {
    /* swallow — best-effort */
  }
}

/** Remove a queued send once its echo reconciled the optimistic bubble. */
export async function deleteOutbox(clientMsgId: string): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.OUTBOX, "readwrite");
    tx.objectStore(STORES.OUTBOX).delete(clientMsgId);
    await txDone(tx);
  } catch {
    /* swallow */
  }
}

/**
 * All queued sends for one user, oldest-first (chronological replay). Scoping by
 * userId means a shared-WebView never replays another account's queued sends.
 */
export async function getOutboxForUser(userId: string): Promise<OutboxRecord[]> {
  const dbp = getDB();
  if (!dbp) return [];
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.OUTBOX, "readonly");
    const all = ((await reqDone(tx.objectStore(STORES.OUTBOX).getAll())) as OutboxRecord[]) ?? [];
    return all.filter((r) => r.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

/** Drop the entire outbox (shared-device user switch / logout). */
export async function clearOutbox(): Promise<void> {
  const dbp = getDB();
  if (!dbp) return;
  try {
    const db = await dbp;
    const tx = db.transaction(STORES.OUTBOX, "readwrite");
    tx.objectStore(STORES.OUTBOX).clear();
    await txDone(tx);
  } catch {
    /* swallow */
  }
}

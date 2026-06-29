/**
 * Shape-conversion between the rewrite's `Message` (core/types.ts) and the
 * `CachedMessage` shape IDB stores.
 *
 * The rewrite uses one `Message` type everywhere (network fetch, WS broadcast,
 * optimistic state), so unlike v1 there is no API-vs-SSE divergence — a single
 * `toCached` / `fromCached` pair round-trips it. Defaults are filled here so a
 * cache row hydrates back into a fully-valid `Message`.
 */

import type { Message, Reaction } from "../core/types.js";
import { type CachedMessage, createdAtKey } from "./idb.js";

/** Convert a rewrite `Message` into a `CachedMessage` for one scope. */
export function toCached(scopeKey: string, m: Message): CachedMessage {
  const createdAt = typeof m.createdAt === "number" ? m.createdAt : Date.now();
  return {
    id: String(m.id),
    scopeKey,
    workspaceId: m.workspaceId ?? null,
    channelId: m.channelId ?? null,
    fromId: m.fromId,
    fromType: m.fromType,
    fromName: m.fromName ?? null,
    toId: m.toId ?? null,
    text: m.text ?? "",
    mentions: m.mentions ?? null,
    parentId: m.parentId ?? null,
    attachments: (m.attachments as unknown[] | null) ?? null,
    unfurls: (m.unfurls as unknown[] | null) ?? null,
    reactions: (m.reactions ?? []) as CachedMessage["reactions"],
    pinnedAt: m.pinnedAt ?? null,
    pinnedBy: m.pinnedBy ?? null,
    replyCount: m.replyCount ?? 0,
    lastReplyAt: m.lastReplyAt ?? null,
    threadParticipants: m.threadParticipants ?? null,
    seq: typeof m.seq === "number" ? m.seq : 0,
    createdAt,
    updatedAt: m.updatedAt ?? null,
    createdAtKey: createdAtKey(createdAt),
    cachedAt: Date.now(),
    deleted: m.deleted === true,
  };
}

/** Rebuild a rewrite `Message` from a cached row (for cold render). */
export function fromCached(m: CachedMessage): Message {
  return {
    id: m.id,
    workspaceId: m.workspaceId ?? undefined,
    channelId: m.channelId,
    fromId: m.fromId,
    fromType: m.fromType,
    fromName: m.fromName ?? undefined,
    toId: m.toId,
    text: m.text,
    mentions: m.mentions,
    parentId: m.parentId,
    attachments: (m.attachments as Message["attachments"]) ?? null,
    unfurls: (m.unfurls as Message["unfurls"]) ?? null,
    reactions: m.reactions as Reaction[],
    pinnedAt: m.pinnedAt,
    pinnedBy: m.pinnedBy,
    replyCount: m.replyCount,
    lastReplyAt: m.lastReplyAt,
    threadParticipants: m.threadParticipants,
    updatedAt: m.updatedAt,
    deleted: m.deleted || undefined,
    seq: m.seq,
    createdAt: m.createdAt,
  };
}

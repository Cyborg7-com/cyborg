import { createHash } from "node:crypto";

// Deterministic id for a 'mention' activity_events row, derived from its NATURAL
// KEY (recipient userId + source message id + eventType).
//
// In the connected-daemon topology a single agent @mention is persisted to ONE
// shared Postgres by TWO writers: the daemon's MessageRouter fan-out (DualStorage
// then PG) and the relay's emitAgentMentionActivity (the cloud mirror, for PG-less
// daemons). activity_events has only a PK on `id` -- there is no unique index on
// the natural key and we add no migration -- so the two writers MUST mint the SAME
// id for the existing INSERT ... ON CONFLICT DO NOTHING (keyed on the PK) to dedup
// them. A per-writer random id produced TWO rows, double-badging/double-notifying
// the mentioned human for one post. Sharing this deterministic id collapses them
// to exactly one row regardless of which writer lands first (or if only one does).
export function mentionActivityId(userId: string, sourceId: string, eventType: string): string {
  // Space-delimited: generated ids (UUIDs, `u_*`, `msg_*`) never contain a space,
  // so the joined natural key maps injectively into the hash input.
  const digest = createHash("sha256").update([userId, sourceId, eventType].join(" ")).digest("hex");
  return `act_${digest.slice(0, 32)}`;
}

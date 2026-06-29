import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import type { PgSync } from "./db/pg-sync.js";
import {
  buildEventPayload,
  isEventEnabled,
  type WebhookEventType,
  type WebhookMessagePayloadInput,
} from "./outgoing-webhook-delivery.js";

// Shared enqueue path for outgoing-webhook events (#598). Called from BOTH the
// cloud relay (relay-standalone.ts) and the local daemon (dispatcher.ts) when a
// message is created / edited / deleted in a channel. It looks up the channel's
// ACTIVE outgoing webhooks, filters to those subscribed to this event type, and
// writes one durable webhook_outbox row per match. The WebhookDeliveryRunner
// tick claims + delivers those rows out of band.
//
// Fire-and-forget by design: a webhook miss must never block or fail the message
// path, so callers `void enqueueWebhookEvent(...)` and we swallow/log errors.
// Idempotent: the outbox unique index (event_id, webhook_id) makes a re-enqueue
// of the same (message, webhook) a no-op, so a double-call (e.g. a retried RPC)
// can't double-deliver.

export interface EnqueueWebhookEventInput {
  pg: PgSync;
  logger?: Pick<Logger, "warn"> | null;
  eventType: WebhookEventType;
  workspaceId: string;
  // The channel the event happened in. DMs (no channel) have no webhook scope and
  // are never enqueued — callers pass a non-null channel id.
  channelId: string;
  messageId: string;
  // Payload fields (omitted for deletes, which carry only ids). See
  // buildEventPayload for the wire shape.
  text?: string | null;
  fromId?: string | null;
  fromName?: string | null;
  createdAt?: number | null;
  firedAt?: number;
}

export async function enqueueWebhookEvent(input: EnqueueWebhookEventInput): Promise<number> {
  const { pg } = input;
  try {
    const hooks = await pg.getActiveOutgoingWebhooksForChannel(input.channelId);
    if (hooks.length === 0) return 0;

    // Build the event body ONCE so every subscribed webhook stores (and signs
    // over) identical bytes for this event.
    const payloadInput: WebhookMessagePayloadInput = {
      eventType: input.eventType,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      messageId: input.messageId,
      text: input.text,
      fromId: input.fromId,
      fromName: input.fromName,
      createdAt: input.createdAt,
      firedAt: input.firedAt,
    };
    const eventData = buildEventPayload(payloadInput);

    // Idempotency anchor: the unique index is (event_id, webhook_id). The SAME
    // message fires create, then update(s), then delete — all distinct events —
    // so the anchor must be per-event-TYPE, not just the message id (otherwise a
    // delete after a create would be dropped as a "duplicate"). An edit can fire
    // repeatedly, but each genuine re-edit re-POSTs (acceptable, and the consumer
    // dedupes on the delivery id if it cares); the composite key only collapses an
    // exact retry of the SAME enqueue call within one event.
    const eventId = `${input.eventType}:${input.messageId}`;

    // Build one outbox row per subscribed webhook, then insert them all in a
    // SINGLE batched statement (vs a round-trip per webhook). The per-row event_id
    // anchor + onConflictDoNothing in enqueueWebhookOutboxBatch keep each (event,
    // webhook) idempotent.
    const rows = hooks
      .filter((hook) => isEventEnabled(hook.events, input.eventType))
      .map((hook) => ({
        id: `whoutbox_${randomUUID()}`,
        webhookId: hook.id,
        workspaceId: input.workspaceId,
        eventId,
        eventType: input.eventType,
        eventData,
      }));
    if (rows.length === 0) return 0;
    return pg.enqueueWebhookOutboxBatch(rows);
  } catch (err) {
    // Never let a webhook enqueue failure surface to the message path.
    input.logger?.warn?.({ err, channelId: input.channelId }, "[webhook-enqueue] failed");
    return 0;
  }
}

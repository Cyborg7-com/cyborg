import { describe, expect, it, vi } from "vitest";

import type { PgSync } from "./db/pg-sync.js";
import { enqueueWebhookEvent } from "./webhook-enqueue.js";

// A minimal PgSync stub exposing only the two methods enqueueWebhookEvent calls.
// enqueueWebhookEvent now writes one BATCHED insert, so the stub mocks
// enqueueWebhookOutboxBatch and filters out rows whose (event_id, webhook_id)
// already exists (mirroring onConflictDoNothing), returning the inserted count.
function fakePg(opts: {
  hooks: Array<{ id: string; events: Record<string, boolean> }>;
  // Outbox keys that already exist → onConflictDoNothing skips them (no insert).
  existing?: Set<string>;
}): {
  pg: PgSync;
  inserts: Array<{ webhookId: string; eventId: string; eventType: string }>;
} {
  const inserts: Array<{ webhookId: string; eventId: string; eventType: string }> = [];
  const pg = {
    getActiveOutgoingWebhooksForChannel: vi.fn(async () => opts.hooks),
    enqueueWebhookOutboxBatch: vi.fn(
      async (rows: Array<{ webhookId: string; eventId: string; eventType: string }>) => {
        let inserted = 0;
        for (const row of rows) {
          const key = `${row.eventId}:${row.webhookId}`;
          if (opts.existing?.has(key)) continue;
          inserts.push({
            webhookId: row.webhookId,
            eventId: row.eventId,
            eventType: row.eventType,
          });
          inserted++;
        }
        return inserted;
      },
    ),
  } as unknown as PgSync;
  return { pg, inserts };
}

describe("enqueueWebhookEvent", () => {
  it("enqueues one row per webhook SUBSCRIBED to the event type", async () => {
    const { pg, inserts } = fakePg({
      hooks: [
        { id: "wh_a", events: { "message.created": true } },
        { id: "wh_b", events: { "message.created": true, "message.updated": true } },
        { id: "wh_c", events: { "message.updated": true } }, // not subscribed to created
      ],
    });
    const n = await enqueueWebhookEvent({
      pg,
      eventType: "message.created",
      workspaceId: "ws1",
      channelId: "ch1",
      messageId: "m1",
      text: "hi",
    });
    expect(n).toBe(2);
    expect(inserts.map((i) => i.webhookId).sort()).toEqual(["wh_a", "wh_b"]);
  });

  it("does nothing when the channel has no active webhooks", async () => {
    const { pg, inserts } = fakePg({ hooks: [] });
    const n = await enqueueWebhookEvent({
      pg,
      eventType: "message.created",
      workspaceId: "ws1",
      channelId: "ch1",
      messageId: "m1",
    });
    expect(n).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it("uses a per-event-TYPE idempotency anchor (create vs delete don't collide)", async () => {
    const { pg } = fakePg({ hooks: [{ id: "wh_a", events: { "message.created": true } }] });
    await enqueueWebhookEvent({
      pg,
      eventType: "message.created",
      workspaceId: "ws1",
      channelId: "ch1",
      messageId: "m1",
    });
    const enqueueSpy = pg.enqueueWebhookOutboxBatch as ReturnType<typeof vi.fn>;
    // One batched call; its rows array carries the per-event-TYPE anchor.
    expect(enqueueSpy.mock.calls[0][0][0].eventId).toBe("message.created:m1");
  });

  it("a duplicate enqueue (onConflictDoNothing → false) is not counted", async () => {
    const { pg } = fakePg({
      hooks: [{ id: "wh_a", events: { "message.created": true } }],
      existing: new Set(["message.created:m1:wh_a"]),
    });
    const n = await enqueueWebhookEvent({
      pg,
      eventType: "message.created",
      workspaceId: "ws1",
      channelId: "ch1",
      messageId: "m1",
    });
    expect(n).toBe(0);
  });

  it("never throws — a PG failure is swallowed and logged", async () => {
    const pg = {
      getActiveOutgoingWebhooksForChannel: vi.fn(async () => {
        throw new Error("pg down");
      }),
    } as unknown as PgSync;
    const warn = vi.fn();
    const n = await enqueueWebhookEvent({
      pg,
      logger: { warn },
      eventType: "message.created",
      workspaceId: "ws1",
      channelId: "ch1",
      messageId: "m1",
    });
    expect(n).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

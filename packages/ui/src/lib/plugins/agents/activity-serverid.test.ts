import { describe, expect, it } from "vitest";
import { ActivityState } from "./state.svelte.js";
import type { ServerActivityItem } from "./state.svelte.js";

// Regression: the "badge stuck at N" bug. Scope-less activity rows
// (daemon_access_request_resolved etc.) are persisted server-side with a UUID
// `id`, but the client renders them under a SYNTHETIC id (`activity:<uuid>`).
// The per-row read endpoint clears `WHERE id = ?`, so ActivityPane must send the
// RAW server id — exposed here as `serverId` — not the synthetic `id`, otherwise
// the UPDATE matches 0 rows and the next seedFromServer resurrects the badge
// (only "Mark all read", which is id-independent, ever cleared it).

function makeResolvedRow(id: string): ServerActivityItem {
  return {
    id,
    event_type: "daemon_access_request_resolved",
    source_id: null,
    channel_id: null,
    dm_peer_id: null,
    preview_text: "Your request for access to Box was approved",
    actor_id: null,
    actor_name: "System",
    is_read: 0,
    created_at: Date.now(),
  };
}

describe("ActivityState — serverId passthrough", () => {
  it("carries the raw PG row id as serverId, distinct from the synthetic id", () => {
    const s = new ActivityState();
    s.seedFromServer([makeResolvedRow("uuid-123")], 1);

    const item = s.items[0];
    expect(item.serverId).toBe("uuid-123");
    // The synthetic dedupe key prefixes the raw id — sending it to the per-row
    // clear is exactly the no-op that left the badge stuck.
    expect(item.id).toBe("activity:uuid-123");
    expect(item.id).not.toBe(item.serverId);
  });
});

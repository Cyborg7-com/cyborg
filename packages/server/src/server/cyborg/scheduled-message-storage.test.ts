import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CyborgStorage } from "./storage.js";

// SQLite storage tests for user "send later" (#607). Uses a throwaway in-memory
// CyborgStorage (no DATABASE_URL needed — SQLite is authoritative for the solo
// daemon's scheduled-message rows). Each test builds + closes its own db, so there
// is no shared-DB cleanup concern. These assert the persistence + idempotency
// contract the runner relies on: due-row filtering, the claim guard, terminal
// error stamping, cancel-while-pending, and per-author listing.

describe("CyborgStorage scheduled messages (#607)", () => {
  let storage: CyborgStorage;
  const WS = "ws_smt";
  const FROM = "user_from";
  const CH = "ch_smt";

  beforeEach(() => {
    storage = new CyborgStorage(":memory:");
  });

  afterEach(() => {
    storage.close();
  });

  it("create then get round-trips all fields including mentions JSON", () => {
    const created = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "hello later",
      sendAt: 1_700_000_000_000,
      channelId: CH,
      mentions: ["user_a", "user_b"],
    });

    const fetched = storage.getScheduledMessage(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.workspace_id).toBe(WS);
    expect(fetched!.from_id).toBe(FROM);
    expect(fetched!.channel_id).toBe(CH);
    expect(fetched!.to_id).toBeNull();
    expect(fetched!.text).toBe("hello later");
    expect(fetched!.send_at).toBe(1_700_000_000_000);
    expect(fetched!.processed_at).toBeNull();
    expect(fetched!.error_code).toBeNull();
    // mentions are stored as a JSON string and decode back to the original array.
    expect(fetched!.mentions).not.toBeNull();
    expect(JSON.parse(fetched!.mentions!)).toEqual(["user_a", "user_b"]);
  });

  it("a DM row stores to_id and a null channel_id; empty mentions persist as null", () => {
    const created = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "dm later",
      sendAt: 123,
      toId: "user_peer",
      mentions: [],
    });
    const fetched = storage.getScheduledMessage(created.id)!;
    expect(fetched.to_id).toBe("user_peer");
    expect(fetched.channel_id).toBeNull();
    expect(fetched.mentions).toBeNull();
  });

  it("getDueScheduledMessages returns only unprocessed rows with send_at <= now", () => {
    const NOW = 5_000;
    const pastUnprocessed = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "due",
      sendAt: NOW - 1_000,
      channelId: CH,
    });
    storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "future",
      sendAt: NOW + 1_000,
      channelId: CH,
    });
    const pastProcessed = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "already sent",
      sendAt: NOW - 2_000,
      channelId: CH,
    });
    // Mark the third one processed so it is no longer due.
    storage.markScheduledMessageProcessed(pastProcessed.id, NOW - 1_500, null);

    const due = storage.getDueScheduledMessages(NOW);
    expect(due.map((r) => r.id)).toEqual([pastUnprocessed.id]);
  });

  it("markScheduledMessageProcessed is the idempotency guard: claims exactly once", () => {
    const row = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "claim me",
      sendAt: 0,
      channelId: CH,
    });
    // First claim wins (processed_at was NULL) …
    expect(storage.markScheduledMessageProcessed(row.id, 10, null)).toBe(true);
    // … a second claim on the same id loses (already processed → no double-send).
    expect(storage.markScheduledMessageProcessed(row.id, 20, null)).toBe(false);
    // The processed_at reflects the FIRST claim, not the second.
    expect(storage.getScheduledMessage(row.id)!.processed_at).toBe(10);
  });

  it("setScheduledMessageError stamps a reason on an already-claimed row", () => {
    const row = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "will fail",
      sendAt: 0,
      channelId: CH,
    });
    // Claim it (success-shaped), then the post-claim send "failed" → record reason.
    expect(storage.markScheduledMessageProcessed(row.id, 10, null)).toBe(true);
    storage.setScheduledMessageError(row.id, "unknown_error");

    const after = storage.getScheduledMessage(row.id)!;
    expect(after.error_code).toBe("unknown_error");
    // It stays "processed" — a failed send is shown, not resurrected/retried.
    expect(after.processed_at).toBe(10);
  });

  it("deleteScheduledMessage removes a pending row but refuses an already-processed one", () => {
    const pending = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "cancel me",
      sendAt: 999,
      channelId: CH,
    });
    expect(storage.deleteScheduledMessage(pending.id)).toBe(true);
    expect(storage.getScheduledMessage(pending.id)).toBeUndefined();

    const fired = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "too late",
      sendAt: 0,
      channelId: CH,
    });
    storage.markScheduledMessageProcessed(fired.id, 1, null);
    // A processed row already fired/failed — it can't be canceled.
    expect(storage.deleteScheduledMessage(fired.id)).toBe(false);
    expect(storage.getScheduledMessage(fired.id)).toBeDefined();
  });

  it("listScheduledMessages returns only the requested author's rows, newest send_at first", () => {
    const mineOld = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "mine-old",
      sendAt: 100,
      channelId: CH,
    });
    const mineNew = storage.createScheduledMessage({
      workspaceId: WS,
      fromId: FROM,
      text: "mine-new",
      sendAt: 200,
      channelId: CH,
    });
    // A different author's row in the same workspace must NOT leak into the list.
    storage.createScheduledMessage({
      workspaceId: WS,
      fromId: "user_other",
      text: "theirs",
      sendAt: 300,
      channelId: CH,
    });

    const list = storage.listScheduledMessages(WS, FROM);
    expect(list.map((r) => r.id)).toEqual([mineNew.id, mineOld.id]);
  });
});

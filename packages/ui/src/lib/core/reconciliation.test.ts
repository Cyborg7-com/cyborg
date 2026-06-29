import { describe, it, expect, beforeAll } from "vitest";
import { SlackClient } from "./client.js";
import { findOptimisticIndex } from "./message-reconcile.js";
import type { Message } from "./types.js";

// Cluster #499 + #500 + #501 — reconnect reconciliation. These cover the two pure
// cores: clientMsgId-first optimistic matching (#501) and per-workspace broadcast
// seq-gap detection on an OPEN socket (#499). The DM seq-drain (#500) is exercised
// end-to-end via the relay RPC; its client/relay seam is type-checked.

const OPEN = 1;
beforeAll(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = { OPEN };
});

function msg(over: Partial<Message>): Message {
  return {
    id: "srv-1",
    channelId: "c1",
    fromId: "u1",
    fromType: "human",
    text: "hi",
    seq: 1,
    createdAt: 1,
    ...over,
  };
}

describe("findOptimisticIndex — clientMsgId-first reconciliation (#501)", () => {
  it("matches the optimistic row by clientMsgId exactly", () => {
    const rows = [
      msg({ id: "local-a", clientMsgId: "a", text: "ok", seq: 0 }),
      msg({ id: "local-b", clientMsgId: "b", text: "ok", seq: 0 }),
    ];
    // Server echo for the SECOND send (same text "ok") must settle bubble b, not a.
    const idx = findOptimisticIndex(rows, msg({ id: "srv", clientMsgId: "b", text: "ok" }));
    expect(idx).toBe(1);
  });

  it("two identical consecutive sends each reconcile to their own bubble", () => {
    const rows = [
      msg({ id: "local-a", clientMsgId: "a", text: "ok", seq: 0 }),
      msg({ id: "local-b", clientMsgId: "b", text: "ok", seq: 0 }),
    ];
    expect(findOptimisticIndex(rows, msg({ id: "s1", clientMsgId: "a", text: "ok" }))).toBe(0);
    expect(findOptimisticIndex(rows, msg({ id: "s2", clientMsgId: "b", text: "ok" }))).toBe(1);
  });

  it("does NOT steal a DIFFERENT tagged send's bubble when its id is absent", () => {
    // Server echoed clientMsgId "z" but only a tagged "a" bubble exists → no match
    // (must not collapse the unrelated tagged row by content).
    const rows = [msg({ id: "local-a", clientMsgId: "a", text: "ok", seq: 0 })];
    expect(findOptimisticIndex(rows, msg({ id: "srv", clientMsgId: "z", text: "ok" }))).toBe(-1);
  });

  it("falls back to fromId+text for older relays that omit clientMsgId", () => {
    const rows = [msg({ id: "local-a", text: "ok", seq: 0 })];
    expect(findOptimisticIndex(rows, msg({ id: "srv", text: "ok" }))).toBe(0);
  });

  it("returns -1 for a server message that is itself a local row", () => {
    const rows = [msg({ id: "local-a", clientMsgId: "a", text: "ok", seq: 0 })];
    expect(findOptimisticIndex(rows, msg({ id: "local-a", clientMsgId: "a", text: "ok" }))).toBe(
      -1,
    );
  });
});

class GapClient extends SlackClient {
  feed(type: string, payload: Record<string, unknown>): void {
    (this as unknown as { handleMessage: (raw: string) => void }).handleMessage(
      JSON.stringify({ type: "session", message: { type, payload } }),
    );
  }
}

function gapEvents(): { client: GapClient; gaps: { workspaceId: string; fromSeq: number }[] } {
  const client = new GapClient();
  const gaps: { workspaceId: string; fromSeq: number }[] = [];
  client.on(
    "seq_gap" as never,
    ((e: { workspaceId: string; fromSeq: number }) => gaps.push(e)) as never,
  );
  return { client, gaps };
}

describe("SlackClient seq-gap detection (#499)", () => {
  const W = "cyborg:channel_message_broadcast";

  it("emits seq_gap on a forward jump, with the prior seq as the catch-up cursor", () => {
    const { client, gaps } = gapEvents();
    client.feed(W, { workspaceId: "w1", seq: 5, id: "m5" }); // seed, no gap
    client.feed(W, { workspaceId: "w1", seq: 6, id: "m6" }); // contiguous, no gap
    client.feed(W, { workspaceId: "w1", seq: 9, id: "m9" }); // hole (7,8 missing)
    expect(gaps).toEqual([{ workspaceId: "w1", fromSeq: 6 }]);
  });

  it("does not emit on contiguous or duplicate/stale seqs", () => {
    const { client, gaps } = gapEvents();
    client.feed(W, { workspaceId: "w1", seq: 10, id: "a" });
    client.feed(W, { workspaceId: "w1", seq: 11, id: "b" });
    client.feed(W, { workspaceId: "w1", seq: 11, id: "b" }); // duplicate
    client.feed(W, { workspaceId: "w1", seq: 9, id: "old" }); // stale/out-of-order
    expect(gaps).toEqual([]);
  });

  it("tracks gaps per workspace independently", () => {
    const { client, gaps } = gapEvents();
    client.feed(W, { workspaceId: "w1", seq: 1, id: "x" });
    client.feed(W, { workspaceId: "w2", seq: 1, id: "y" }); // separate baseline
    client.feed(W, { workspaceId: "w1", seq: 2, id: "x2" }); // contiguous in w1
    client.feed(W, { workspaceId: "w2", seq: 5, id: "y5" }); // hole in w2 only
    expect(gaps).toEqual([{ workspaceId: "w2", fromSeq: 1 }]);
  });

  it("is backward-compatible: a broadcast with no seq never triggers a gap", () => {
    const { client, gaps } = gapEvents();
    client.feed(W, { workspaceId: "w1", id: "no-seq-1" });
    client.feed(W, { workspaceId: "w1", id: "no-seq-2" });
    expect(gaps).toEqual([]);
  });
});

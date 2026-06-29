import { describe, expect, it } from "vitest";
import {
  recordToCommand,
  recordToOptimisticMessage,
  localIdFor,
  putOutbox,
  getOutboxForUser,
  deleteOutbox,
  clearOutbox,
  type OutboxRecord,
} from "./outbox.js";
import { findOptimisticIndex } from "../core/message-reconcile.js";
import type { Message } from "../core/types.js";

function channelRecord(over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    clientMsgId: "cid-1",
    userId: "me",
    kind: "channel",
    workspaceId: "ws1",
    targetId: "chan1",
    text: "hello channel",
    mentions: ["u2"],
    attachments: null,
    parentId: null,
    createdAt: 1000,
    ...over,
  };
}

function dmRecord(over: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    clientMsgId: "cid-2",
    userId: "me",
    kind: "dm",
    workspaceId: "ws1",
    targetId: "peer1",
    text: "hello dm",
    mentions: null,
    attachments: null,
    parentId: null,
    createdAt: 2000,
    ...over,
  };
}

// ── recordToCommand: the replay maps to the right client call + arg order ─────

describe("recordToCommand", () => {
  it("maps a channel record to client.sendMessage args (ws, chan, text, mentions, attachments, parentId, clientMsgId)", () => {
    const cmd = recordToCommand(channelRecord());
    expect(cmd.kind).toBe("channel");
    // parentId is `undefined` (top-level) — the position BEFORE clientMsgId must be preserved.
    expect(cmd.args).toEqual([
      "ws1",
      "chan1",
      "hello channel",
      ["u2"],
      undefined,
      undefined,
      "cid-1",
    ]);
  });

  it("maps a DM record to client.sendDm args (ws, toId, text, attachments, parentId, clientMsgId)", () => {
    const cmd = recordToCommand(dmRecord());
    expect(cmd.kind).toBe("dm");
    expect(cmd.args).toEqual(["ws1", "peer1", "hello dm", undefined, undefined, "cid-2"]);
  });

  it("threads a parentId through when present", () => {
    const cmd = recordToCommand(channelRecord({ parentId: "root-9" }));
    // parentId sits second-to-last (before clientMsgId).
    expect(cmd.args[5]).toBe("root-9");
    expect(cmd.args[6]).toBe("cid-1");
  });

  it("forwards attachments and a null mentions as undefined", () => {
    const att = [{ id: "a1" }];
    const cmd = recordToCommand(channelRecord({ mentions: null, attachments: att }));
    expect(cmd.args[3]).toBeUndefined(); // mentions
    expect(cmd.args[4]).toBe(att); // attachments
  });
});

// ── recordToOptimisticMessage: rebuilds the bubble on reload ──────────────────

describe("recordToOptimisticMessage", () => {
  it("rebuilds a pending CHANNEL bubble with the right surface fields + preserved clientMsgId", () => {
    const msg = recordToOptimisticMessage(channelRecord(), "Me");
    expect(msg.id).toBe("local-cid-1");
    expect(msg.channelId).toBe("chan1");
    expect(msg.toId).toBeNull();
    expect(msg.fromId).toBe("me");
    expect(msg.fromType).toBe("human");
    expect(msg.fromName).toBe("Me");
    expect(msg.sendStatus).toBe("pending");
    expect(msg.clientMsgId).toBe("cid-1");
    expect(msg.seq).toBe(0);
    expect(msg.createdAt).toBe(1000);
  });

  it("rebuilds a pending DM bubble routed to the peer (channelId null, toId = peer)", () => {
    const msg = recordToOptimisticMessage(dmRecord(), "Me");
    expect(msg.id).toBe("local-cid-2");
    expect(msg.channelId).toBeNull();
    expect(msg.toId).toBe("peer1");
    expect(msg.sendStatus).toBe("pending");
    expect(msg.clientMsgId).toBe("cid-2");
  });
});

// ── localIdFor ────────────────────────────────────────────────────────────────

describe("localIdFor", () => {
  it("derives the optimistic row id from the clientMsgId", () => {
    expect(localIdFor("abc")).toBe("local-abc");
  });
});

// ── persist → reload → deliver: the echo reconciles the rebuilt bubble ────────

describe("rehydrated bubble reconciliation (#501/#502)", () => {
  it("a server echo carrying the same clientMsgId settles the rebuilt optimistic row", () => {
    const rebuilt = recordToOptimisticMessage(channelRecord(), "Me");
    // The relay echo: a real server id but the SAME clientMsgId (echoed back).
    const echo: Message = {
      id: "srv-77",
      channelId: "chan1",
      fromId: "me",
      fromType: "human",
      text: "hello channel",
      clientMsgId: "cid-1",
      seq: 42,
      createdAt: 1001,
    };
    expect(findOptimisticIndex([rebuilt], echo)).toBe(0);
  });

  it("an echo with a DIFFERENT clientMsgId does NOT settle the rebuilt row", () => {
    const rebuilt = recordToOptimisticMessage(channelRecord(), "Me");
    const otherEcho: Message = {
      id: "srv-78",
      channelId: "chan1",
      fromId: "me",
      fromType: "human",
      text: "hello channel", // same text, but a tagged echo must match by id, not content
      clientMsgId: "cid-OTHER",
      seq: 43,
      createdAt: 1002,
    };
    expect(findOptimisticIndex([rebuilt], otherEcho)).toBe(-1);
  });

  it("falls back to (fromId,text) for a legacy echo with no clientMsgId", () => {
    // A rebuilt bubble whose record predates #501 (no clientMsgId on the echo).
    const rebuilt: Message = {
      ...recordToOptimisticMessage(channelRecord(), "Me"),
      clientMsgId: null,
    };
    const legacyEcho: Message = {
      id: "srv-79",
      channelId: "chan1",
      fromId: "me",
      fromType: "human",
      text: "hello channel",
      seq: 44,
      createdAt: 1003,
    };
    expect(findOptimisticIndex([rebuilt], legacyEcho)).toBe(0);
  });
});

// ── idb CRUD degrades to no-op without IndexedDB (node env) ───────────────────
//
// The node vitest env has no `indexedDB`, so every helper must short-circuit
// and never throw — this is the SSR / Safari-private-mode / old-WebView safety
// contract the rest of lib/cache relies on. (A full persist→replay round-trip is
// exercised by the browser e2e plan; node can't open a real IndexedDB.)

describe("idb CRUD is best-effort without IndexedDB", () => {
  it("getOutboxForUser resolves to [] (no throw) when IDB is unavailable", async () => {
    expect(typeof indexedDB).toBe("undefined");
    await expect(getOutboxForUser("me")).resolves.toEqual([]);
  });

  it("putOutbox / deleteOutbox / clearOutbox resolve without throwing", async () => {
    await expect(putOutbox(channelRecord())).resolves.toBeUndefined();
    await expect(deleteOutbox("cid-1")).resolves.toBeUndefined();
    await expect(clearOutbox()).resolves.toBeUndefined();
  });
});

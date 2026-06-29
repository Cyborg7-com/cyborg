import { describe, expect, it } from "vitest";
import { ActivityState } from "./state.svelte.js";
import type { ServerActivityItem } from "./state.svelte.js";

// Bug A regression: opening a DM from the Activity tab must clear ALL of that
// peer's unread activity rows (not just the clicked one), and the read-state must
// survive a reload. The live multi-DM symptom is fixed by handleClick calling
// markReadByDmPeer(peerId) (ActivityPane.svelte) instead of markRead(item.id);
// these tests pin the store behavior that path relies on.

function makeServerDm(id: string, peer: string, isRead = false): ServerActivityItem {
  return {
    id,
    event_type: "dm_received",
    source_id: null,
    channel_id: null,
    dm_peer_id: peer,
    preview_text: `dm ${id}`,
    actor_id: peer,
    actor_name: peer,
    is_read: isRead ? 1 : 0,
    created_at: Date.now(),
  };
}

describe("ActivityState — DM clear (Bug A)", () => {
  it("markReadByDmPeer clears ALL of a peer's items (multi-DM)", () => {
    const s = new ActivityState();
    // Seed an authoritative baseline so unreadCount tracks _serverUnread.
    s.seedFromServer([], 5);
    expect(s.unreadCount).toBe(5);

    s.push("dm_received", "Alice", "alice", "human", "hi 1");
    s.push("dm_received", "Alice", "alice", "human", "hi 2");
    s.push("dm_received", "Alice", "alice", "human", "hi 3");

    const aliceItems = s.items.filter((i) => i.actorId === "alice");
    expect(aliceItems).toHaveLength(3);
    expect(aliceItems.every((i) => !i.isRead)).toBe(true);
    // 5 baseline + 3 live unread DMs.
    expect(s.unreadCount).toBe(8);

    s.markReadByDmPeer("alice");

    const aliceAfter = s.items.filter((i) => i.actorId === "alice");
    expect(aliceAfter.every((i) => i.isRead)).toBe(true);
    // Dropped by the 3 cleared rows, back to the baseline.
    expect(s.unreadCount).toBe(5);
  });

  it("only clears the targeted peer, leaving other peers' DMs unread", () => {
    const s = new ActivityState();
    s.seedFromServer([], 0);
    s.push("dm_received", "Alice", "alice", "human", "hi");
    s.push("dm_received", "Bob", "bob", "human", "yo");

    s.markReadByDmPeer("alice");

    expect(s.items.find((i) => i.actorId === "alice")?.isRead).toBe(true);
    expect(s.items.find((i) => i.actorId === "bob")?.isRead).toBe(false);
  });

  it("push() stamps DM items with a stable dm:<peer> sourceId (Change B)", () => {
    const s = new ActivityState();
    s.push("dm_received", "Alice", "alice", "human", "hi");
    expect(s.items.at(-1)?.sourceId).toBe("dm:alice");
  });

  it("non-DM pushes carry no sourceId", () => {
    const s = new ActivityState();
    s.push("permission_request", "Bot", "bot", "agent", "needs perms");
    expect(s.items.at(-1)?.sourceId).toBeUndefined();
  });

  it("serverItemToActivity seeds DM rows with the matching dm:<peer> sourceId (Change C)", () => {
    const s = new ActivityState();
    // Seed two server DM rows for Alice — both should carry sourceId dm:alice so a
    // later seedReadFromServer reconciles them by peer.
    s.seedFromServer([makeServerDm("e1", "alice"), makeServerDm("e2", "alice")], 2);
    const seeded = s.items.filter((i) => i.actorId === "alice");
    expect(seeded).toHaveLength(2);
    expect(seeded.every((i) => i.sourceId === "dm:alice")).toBe(true);
  });

  it("cross-device seed reconcile clears all of a peer's items by dm:<peer> sourceId", () => {
    const s = new ActivityState();
    s.seedFromServer([], 2);
    s.push("dm_received", "Alice", "alice", "human", "hi 1");
    s.push("dm_received", "Alice", "alice", "human", "hi 2");
    expect(s.unreadCount).toBe(4);

    // Another device read this DM; the server reports the peer key as read.
    s.seedReadFromServer([{ sourceId: "dm:alice", isRead: true }]);

    expect(s.items.filter((i) => i.actorId === "alice").every((i) => i.isRead)).toBe(true);
    expect(s.unreadCount).toBe(2);
  });

  it("markReadByDmPeer is idempotent (no double-decrement)", () => {
    const s = new ActivityState();
    s.seedFromServer([], 3);
    s.push("dm_received", "Alice", "alice", "human", "hi");
    expect(s.unreadCount).toBe(4);

    s.markReadByDmPeer("alice");
    expect(s.unreadCount).toBe(3);
    // Second call clears nothing new — count must not drop again.
    s.markReadByDmPeer("alice");
    expect(s.unreadCount).toBe(3);
  });
});

// Bug A (channel parity): opening an ALREADY-ACTIVE channel from the Activity tab
// must clear ALL of that channel's unread mentions, not just the clicked row.
// selectChannel's markReadByChannel doesn't re-run when the channel is already
// open, so handleClick now calls markReadByChannel(item.channelId) (mirroring the
// DM branch) instead of markRead(item.id). These tests pin the store behavior
// that path relies on.

describe("ActivityState — channel clear (Bug A, channel parity)", () => {
  it("markReadByChannel clears ALL of a channel's items (multi-mention)", () => {
    const s = new ActivityState();
    // Authoritative baseline so unreadCount tracks _serverUnread.
    s.seedFromServer([], 5);
    expect(s.unreadCount).toBe(5);

    s.push("mention", "Alice", "alice", "human", "hi 1", "chan-general", "general");
    s.push("mention", "Bob", "bob", "human", "hi 2", "chan-general", "general");
    s.push("thread_reply", "Carol", "carol", "human", "hi 3", "chan-general", "general");

    const genItems = s.items.filter((i) => i.channelId === "chan-general");
    expect(genItems).toHaveLength(3);
    expect(genItems.every((i) => !i.isRead)).toBe(true);
    // 5 baseline + 3 live unread channel mentions.
    expect(s.unreadCount).toBe(8);

    s.markReadByChannel("chan-general");

    const genAfter = s.items.filter((i) => i.channelId === "chan-general");
    expect(genAfter.every((i) => i.isRead)).toBe(true);
    // Dropped by the 3 cleared rows, back to the baseline.
    expect(s.unreadCount).toBe(5);
  });

  it("only clears the targeted channel, leaving other channels' mentions unread", () => {
    const s = new ActivityState();
    s.seedFromServer([], 0);
    s.push("mention", "Alice", "alice", "human", "hi", "chan-general", "general");
    s.push("mention", "Bob", "bob", "human", "yo", "chan-random", "random");

    s.markReadByChannel("chan-general");

    expect(s.items.find((i) => i.channelId === "chan-general")?.isRead).toBe(true);
    expect(s.items.find((i) => i.channelId === "chan-random")?.isRead).toBe(false);
  });

  it("markReadByChannel is idempotent (no double-decrement)", () => {
    const s = new ActivityState();
    s.seedFromServer([], 3);
    s.push("mention", "Alice", "alice", "human", "hi", "chan-general", "general");
    expect(s.unreadCount).toBe(4);

    s.markReadByChannel("chan-general");
    expect(s.unreadCount).toBe(3);
    // Second call clears nothing new — count must not drop again.
    s.markReadByChannel("chan-general");
    expect(s.unreadCount).toBe(3);
  });
});

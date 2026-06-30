/* eslint-disable @typescript-eslint/no-explicit-any */
// Item 2 (defense in depth): the relay must NEVER persist/broadcast a DM-origin agent
// reply into a CHANNEL — even if the owning (or a peer) daemon's in-process DM guard
// is stale/absent and the stream is tagged with a channelId. A PRIVATE 1:1 turn is
// identified structurally by the stream's `privateToEmail`; its presence forces the
// flushed reply to a DM (channelId nulled, broadcast via privateToEmail). This proves
// the relay-side enforcement is independent of the daemon's guard.
import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceRelay } from "./workspace-relay.js";

// Minimal PgSync stub — only the methods the agent-reply flush path touches. Casting
// a stub (not standing up a real Postgres) keeps the test deterministic + offline; it
// exercises the relay's scope logic, which is the unit under test.
function makePgStub(opts: { byEmail: Record<string, { id: string }> }) {
  const inserted: Array<Record<string, unknown>> = [];
  const pg = {
    inserted,
    async insertMessage(record: Record<string, unknown>) {
      inserted.push(record);
    },
    async getUserByEmail(email: string) {
      return opts.byEmail[email] ?? null;
    },
    async getChannelMembers() {
      return [];
    },
    async insertActivityEvent() {
      /* no-op */
    },
  };
  return pg;
}

describe("WorkspaceRelay — DM-origin agent reply cannot land in a channel", () => {
  const workspaceId = "ws-1";
  const channelId = "chan-general";
  const agentId = "agent-rick";
  const recipientEmail = "alice@test.dev";
  const recipientId = "user-alice";

  let relay: WorkspaceRelay;
  let broadcasts: Array<{ type: string; payload: any }>;
  let pg: ReturnType<typeof makePgStub>;

  beforeEach(() => {
    broadcasts = [];
    pg = makePgStub({ byEmail: { [recipientEmail]: { id: recipientId } } });
    relay = new WorkspaceRelay({
      pg: pg as any,
      onBroadcast: (_wsId, message) => {
        broadcasts.push(message as any);
      },
    });
  });

  // The leak scenario: a channel-bound cybo answers a DM. Even if a buggy/stale daemon
  // tags the stream with channelId = #general, the privateToEmail marks it private, so
  // the relay must flush a DM — not a channel post.
  it("forces a DM when privateToEmail is set, even with a channelId on the stream", async () => {
    // 1) timeline delta — carries the reply text + the PRIVATE scope (privateToEmail)
    //    AND a (wrongly) channel-tagged channelId. The relay must trust privateToEmail.
    await (relay as any).persistMessage(workspaceId, 1, {
      type: "cyborg:agent_stream",
      payload: {
        agentId,
        workspaceId,
        channelId, // a stale/buggy daemon left the bound channel on the stream
        privateToEmail: recipientEmail,
        cyboId: "cybo-rick",
        cyboName: "Rick",
        event: {
          type: "timeline",
          item: { type: "assistant_message", text: "secret reply", messageId: "m1" },
        },
      },
    });
    // 2) turn end — flush. The trigger payload deliberately OMITS privateToEmail (an
    //    agent_status-shaped flush) to prove the captured DM scope survives the flush.
    await (relay as any).persistMessage(workspaceId, 2, {
      type: "cyborg:agent_stream",
      payload: { agentId, workspaceId, event: { type: "turn_completed" } },
    });

    // Persisted with channelId nulled (DM), never the channel.
    expect(pg.inserted.length).toBe(1);
    expect(pg.inserted[0].channelId).toBeNull();
    expect(pg.inserted[0].text).toBe("secret reply");

    // Broadcast as a DM addressed to the recipient — NOT a channel post.
    expect(broadcasts.map((b) => b.type)).not.toContain("cyborg:channel_message_broadcast");
    const dm = broadcasts.find((b) => b.type === "cyborg:dm_broadcast");
    expect(dm).toBeDefined();
    expect(dm!.payload.toId).toBe(recipientId);
    expect(dm!.payload.channelId).toBeNull();
  });

  // An AUTONOMOUS (cron/scheduled) turn's narration must NEVER auto-persist into the
  // bound channel — the live repro where Apex, told to reply privately, posted "I'll
  // send you a private DM…" into #general. The daemon tags the stream `autonomous`;
  // the relay must DROP the accumulated prose (no PG row, no broadcast). The cybo
  // reaches a channel/DM only via an explicit cyborg7_send_message (a separate path).
  it("DROPS an autonomous turn's narration — no channel post, no orphan DM row", async () => {
    await (relay as any).persistMessage(workspaceId, 1, {
      type: "cyborg:agent_stream",
      payload: {
        agentId,
        workspaceId,
        channelId, // its bound channel — must NOT receive the narration
        autonomous: true,
        cyboId: "cybo-rick",
        cyboName: "Rick",
        event: {
          type: "timeline",
          item: {
            type: "assistant_message",
            text: "I'll send you a private DM. Let me load the messaging tool first.",
            messageId: "m3",
          },
        },
      },
    });
    await (relay as any).persistMessage(workspaceId, 2, {
      type: "cyborg:agent_stream",
      payload: { agentId, workspaceId, autonomous: true, event: { type: "turn_completed" } },
    });

    // Nothing persisted — not into the channel, and not as an orphan (channelId+toId
    // null) row that getDmMessages would surface in the user's DM-with-cybo view.
    expect(pg.inserted.length).toBe(0);
    // Nothing broadcast either.
    expect(broadcasts.length).toBe(0);
  });

  // Control: a genuine channel turn (no privateToEmail) still persists + broadcasts to
  // the channel — the fix must not break normal channel/mention replies.
  it("a genuine channel turn (no privateToEmail) still posts to the channel", async () => {
    await (relay as any).persistMessage(workspaceId, 1, {
      type: "cyborg:agent_stream",
      payload: {
        agentId,
        workspaceId,
        channelId,
        cyboId: "cybo-rick",
        cyboName: "Rick",
        event: {
          type: "timeline",
          item: { type: "assistant_message", text: "daily standup", messageId: "m2" },
        },
      },
    });
    await (relay as any).persistMessage(workspaceId, 2, {
      type: "cyborg:agent_stream",
      payload: { agentId, workspaceId, event: { type: "turn_completed" } },
    });

    expect(pg.inserted.length).toBe(1);
    expect(pg.inserted[0].channelId).toBe(channelId);
    const post = broadcasts.find((b) => b.type === "cyborg:channel_message_broadcast");
    expect(post).toBeDefined();
    expect(post!.payload.channelId).toBe(channelId);
    expect(broadcasts.map((b) => b.type)).not.toContain("cyborg:dm_broadcast");
  });
});

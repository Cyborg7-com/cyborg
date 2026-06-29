/* eslint-disable @typescript-eslint/no-explicit-any */
// Launch-critical: a cybo's streamed channel reply is persisted by the RELAY, and
// it used to hardcode fromName: null + fromId: agentId, so the client rendered the
// raw agent UUID (e.g. "27bf4e9a") instead of the cybo name (e.g. "Rick"). The
// daemon now carries cyboName/cyboId on the agent_stream payload; the relay's
// accumulate→flush must surface them on the persisted message record.
import { describe, it, expect } from "vitest";
import { WorkspaceRelay } from "./workspace-relay.js";

function streamPayload(over: Record<string, unknown>): Record<string, unknown> {
  return {
    agentId: "agent-uuid-27bf4e9a",
    channelId: "chan-general",
    cyboName: "Rick",
    cyboId: "cybo-rick",
    event: {
      type: "timeline",
      item: { type: "assistant_message", text: "hello from Rick", messageId: "m1" },
    },
    ...over,
  };
}

describe("WorkspaceRelay: flushed agent reply carries the cybo name + id", () => {
  it("uses cyboName for fromName and cyboId for fromId (not the raw agent UUID)", async () => {
    const relay = new WorkspaceRelay();
    (relay as any).accumulateAgentStreamText("ws-1", 7, streamPayload({}));
    const record = await (relay as any).flushPendingAgentMessage(streamPayload({}));

    expect(record).not.toBeNull();
    expect(record.fromName).toBe("Rick");
    expect(record.fromId).toBe("cybo-rick");
    expect(record.channelId).toBe("chan-general");
    expect(record.text).toBe("hello from Rick");
  });

  it("falls back to agentId + null name when the stream carried no cybo identity", async () => {
    const relay = new WorkspaceRelay();
    const noCybo = streamPayload({ cyboName: undefined, cyboId: undefined });
    (relay as any).accumulateAgentStreamText("ws-1", 7, noCybo);
    const record = await (relay as any).flushPendingAgentMessage(noCybo);

    expect(record.fromId).toBe("agent-uuid-27bf4e9a");
    expect(record.fromName).toBeNull();
  });
});

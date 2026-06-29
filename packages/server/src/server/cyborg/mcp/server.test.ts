import { describe, it, expect } from "vitest";
import { buildChannelMessage, type McpAuthContext } from "./server.js";

function ctx(overrides: Partial<McpAuthContext> = {}): McpAuthContext {
  return {
    tokenId: "mcp_t",
    workspaceId: "ws_1",
    identityType: "cybo",
    identityId: "cybo_1",
    displayName: "Researcher",
    scopes: ["read", "write"],
    ...overrides,
  };
}

describe("buildChannelMessage", () => {
  it("a cybo identity posts as an agent", () => {
    const msg = buildChannelMessage(ctx(), {
      id: "m1",
      channelId: "ch_1",
      text: "hello",
      parentId: null,
    });
    expect(msg.type).toBe("cyborg:channel_message_broadcast");
    expect(msg.payload.fromType).toBe("agent");
    expect(msg.payload.fromId).toBe("cybo_1");
    expect(msg.payload.fromName).toBe("Researcher");
    expect(msg.payload.workspaceId).toBe("ws_1");
    expect(msg.payload.channelId).toBe("ch_1");
    expect(msg.payload.parentId).toBeNull();
  });

  it("a user identity posts as a human", () => {
    const msg = buildChannelMessage(ctx({ identityType: "user", identityId: "u_1" }), {
      id: "m2",
      channelId: "ch_1",
      text: "hi",
      parentId: null,
    });
    expect(msg.payload.fromType).toBe("human");
    expect(msg.payload.fromId).toBe("u_1");
  });

  it("carries the parent id for thread replies", () => {
    const msg = buildChannelMessage(ctx(), {
      id: "m3",
      channelId: "ch_1",
      text: "re",
      parentId: "root_1",
    });
    expect(msg.payload.parentId).toBe("root_1");
  });
});

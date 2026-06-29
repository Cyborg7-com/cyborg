import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildWorkspaceMcpServer, type McpAuthContext, type McpDeps } from "./server.js";
import { handleMcpRequest } from "./http.js";
import { hashMcpToken } from "./token.js";
import type { PgSync } from "../db/pg-sync.js";
import { RateLimiter } from "../rate-limiter.js";

// End-to-end exercise of the MCP write plane through a real MCP client over an
// in-memory transport, with typed fakes for the pg/relay boundary (deterministic,
// no live PG). Covers: a `write`-scoped PAT can post and it reaches the relay +
// audit; a read-only PAT can't even see the write tools; and request-time
// membership re-check rejects a revoked identity before any tool runs.

interface Captured {
  injected: Array<{ workspaceId: string; message: Record<string, unknown>; fromId?: string }>;
  audits: Array<Record<string, unknown>>;
  threadReplies: Array<Record<string, unknown>>;
}

function ctx(scopes: string[], overrides: Partial<McpAuthContext> = {}): McpAuthContext {
  return {
    tokenId: "mcp_t",
    workspaceId: "ws_1",
    identityType: "cybo",
    identityId: "cybo_1",
    displayName: "Researcher",
    scopes,
    ...overrides,
  };
}

function makeDeps(pgOverrides: Record<string, unknown> = {}): { deps: McpDeps; cap: Captured } {
  const cap: Captured = { injected: [], audits: [], threadReplies: [] };
  const relay = {
    injectMessage(workspaceId: string, message: Record<string, unknown>, fromId?: string): number {
      cap.injected.push({ workspaceId, message, fromId });
      return cap.injected.length;
    },
  };
  const pg = {
    async getChannel(id: string) {
      return { id, workspace_id: "ws_1", name: "general", is_private: 0, created_by: "u" };
    },
    async getChannelMemberRole() {
      return "member";
    },
    async getMemberRole() {
      return "member";
    },
    async getMessageById(id: string) {
      return { id, fromId: "someone", workspaceId: "ws_1", channelId: "ch_1" };
    },
    async maintainThreadOnReply(opts: Record<string, unknown>) {
      cap.threadReplies.push(opts);
      return { followers: [] };
    },
    async audit(opts: Record<string, unknown>) {
      cap.audits.push(opts);
    },
    ...pgOverrides,
  } as unknown as PgSync;
  return { deps: { pg, relay }, cap };
}

async function connectClient(
  deps: McpDeps,
  scopes: string[],
  ctxOverrides: Partial<McpAuthContext> = {},
): Promise<Client> {
  const server = buildWorkspaceMcpServer(ctx(scopes, ctxOverrides), deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return result.content?.map((c) => c.text ?? "").join("") ?? "";
}

describe("mcp write plane (integration)", () => {
  it("a write-scoped PAT posts a message that reaches the relay + audit log", async () => {
    const { deps, cap } = makeDeps();
    const client = await connectClient(deps, ["read", "write"]);

    const result = (await client.callTool({
      name: "post_message",
      arguments: { channelId: "ch_1", text: "hello from the agent" },
    })) as { content: Array<{ type: string; text?: string }> };

    const body = JSON.parse(textOf(result));
    expect(body.ok).toBe(true);

    // Reached the relay (persist + broadcast), attributed to the cybo as an agent.
    expect(cap.injected).toHaveLength(1);
    const payload = cap.injected[0].message.payload as Record<string, unknown>;
    expect(cap.injected[0].message.type).toBe("cyborg:channel_message_broadcast");
    expect(payload.channelId).toBe("ch_1");
    expect(payload.text).toBe("hello from the agent");
    expect(payload.fromType).toBe("agent");
    expect(payload.fromId).toBe("cybo_1");
    expect(payload.id).toBe(body.messageId);
    // Regression: MCP posts must carry the origin marker so persistence and
    // the UI badge can distinguish automations from organic messages.
    expect(payload.source).toBe("mcp");

    // Recorded in the audit log.
    expect(cap.audits).toHaveLength(1);
    expect(cap.audits[0].action).toBe("post_message");
    expect(cap.audits[0].actorId).toBe("cybo_1");
    expect((cap.audits[0].details as Record<string, unknown>).via).toBe("mcp");

    await client.close();
  });

  it("reply_in_thread keeps thread aggregates in sync via maintainThreadOnReply", async () => {
    const { deps, cap } = makeDeps();
    const client = await connectClient(deps, ["read", "write"]);

    const result = (await client.callTool({
      name: "reply_in_thread",
      arguments: { channelId: "ch_1", parentId: "root_1", text: "a reply" },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(JSON.parse(textOf(result)).ok).toBe(true);

    expect(cap.injected).toHaveLength(1);
    expect((cap.injected[0].message.payload as Record<string, unknown>).parentId).toBe("root_1");
    // Thread metadata maintained exactly like the human reply path.
    expect(cap.threadReplies).toHaveLength(1);
    expect(cap.threadReplies[0].rootId).toBe("root_1");
    expect(cap.threadReplies[0].channelId).toBe("ch_1");

    await client.close();
  });

  it("rejects a reply whose parent lives in a different channel", async () => {
    // Parent message resolves to ch_OTHER, but the caller passes ch_1.
    const { deps, cap } = makeDeps({
      async getMessageById(id: string) {
        return { id, fromId: "x", workspaceId: "ws_1", channelId: "ch_OTHER" };
      },
    });
    const client = await connectClient(deps, ["read", "write"]);

    const result = (await client.callTool({
      name: "reply_in_thread",
      arguments: { channelId: "ch_1", parentId: "root_x", text: "sneaky" },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(JSON.parse(textOf(result)).error).toMatch(/not in this channel/);
    expect(cap.injected).toHaveLength(0);
    expect(cap.threadReplies).toHaveLength(0);

    await client.close();
  });

  it("rejects a user-identity token whose member role is viewer", async () => {
    const { deps, cap } = makeDeps({
      async getMemberRole() {
        return "viewer";
      },
    });
    const client = await connectClient(deps, ["read", "write"], {
      identityType: "user",
      identityId: "user_1",
    });

    const result = (await client.callTool({
      name: "post_message",
      arguments: { channelId: "ch_1", text: "should be blocked" },
    })) as { content: Array<{ type: string; text?: string }> };
    expect(JSON.parse(textOf(result)).error).toMatch(/cannot post/);
    expect(cap.injected).toHaveLength(0);

    await client.close();
  });

  it("a read-only PAT cannot see or call the write tools", async () => {
    const { deps, cap } = makeDeps();
    const client = await connectClient(deps, ["read"]);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("read_channel");
    expect(names).not.toContain("post_message");
    expect(names).not.toContain("reply_in_thread");

    // Calling the unregistered tool is rejected (isError); nothing is posted or
    // audited.
    const denied = (await client.callTool({
      name: "post_message",
      arguments: { channelId: "ch_1", text: "x" },
    })) as { isError?: boolean };
    expect(denied.isError).toBe(true);
    expect(cap.injected).toHaveLength(0);
    expect(cap.audits).toHaveLength(0);

    await client.close();
  });
});

// Minimal IncomingMessage/ServerResponse fakes for the 403 path, which returns
// before any body is read or transport is created.
function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { method: "POST", headers } as unknown as IncomingMessage;
}

function fakeRes(): { res: ServerResponse; status: () => number | null } {
  let statusCode: number | null = null;
  const res = {
    destroyed: false,
    headersSent: false,
    setHeader() {
      return this;
    },
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end() {
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, status: () => statusCode };
}

describe("mcp membership re-check (request-time)", () => {
  it("rejects a token whose cybo no longer exists in the workspace", async () => {
    const raw = "cybo_mcp_ws_1_secret";
    const pg = {
      async getMcpTokenByHash(hash: string) {
        return hash === hashMcpToken(raw)
          ? {
              id: "mcp_t",
              name: "t",
              workspaceId: "ws_1",
              ownerId: "owner",
              identityType: "cybo" as const,
              identityId: "cybo_gone",
              scopes: ["write"],
            }
          : null;
      },
      // MCP is enabled for the workspace, so the request reaches the identity
      // re-check (the subject of this test) rather than the master-switch gate.
      async getMcpEnabled() {
        return true;
      },
      // The cybo was deleted: it's no longer in the workspace's cybo list.
      async getCybos() {
        return [];
      },
    } as unknown as PgSync;

    const relay = { injectMessage: () => 1 };
    const { res, status } = fakeRes();
    await handleMcpRequest(fakeReq({ authorization: `Bearer ${raw}` }), res, {
      pg,
      relay,
      rateLimiter: new RateLimiter(),
    } as unknown as Parameters<typeof handleMcpRequest>[2]);
    expect(status()).toBe(403);
  });

  it("refuses every token while MCP is disabled for the workspace", async () => {
    const raw = "cybo_mcp_ws_1_secret";
    const pg = {
      async getMcpTokenByHash(hash: string) {
        return hash === hashMcpToken(raw)
          ? {
              id: "mcp_t",
              name: "t",
              workspaceId: "ws_1",
              ownerId: "owner",
              identityType: "cybo" as const,
              identityId: "cybo_1",
              scopes: ["read"],
            }
          : null;
      },
      // Master switch off — should refuse before any identity/membership work.
      async getMcpEnabled() {
        return false;
      },
    } as unknown as PgSync;

    const relay = { injectMessage: () => 1 };
    const { res, status } = fakeRes();
    await handleMcpRequest(fakeReq({ authorization: `Bearer ${raw}` }), res, {
      pg,
      relay,
      rateLimiter: new RateLimiter(),
    } as unknown as Parameters<typeof handleMcpRequest>[2]);
    expect(status()).toBe(403);
  });

  it("returns 429 once a token exceeds its per-minute MCP request budget", async () => {
    const raw = "cybo_mcp_ws_1_secret";
    const pg = {
      async getMcpTokenByHash(hash: string) {
        return hash === hashMcpToken(raw)
          ? {
              id: "mcp_t",
              name: "t",
              workspaceId: "ws_1",
              ownerId: "owner",
              identityType: "cybo" as const,
              identityId: "cybo_1",
              scopes: ["read"],
            }
          : null;
      },
    } as unknown as PgSync;

    const relay = { injectMessage: () => 1 };
    const rateLimiter = new RateLimiter();
    // Exhaust the token's budget (default mcp limit) so the next request trips it.
    // The gate runs right after token resolution, before any workspace/identity
    // PG lookups — so a flooded token is rejected without touching the DB.
    for (let i = 0; i < 120; i++) rateLimiter.check("mcp_t", "mcp");

    const { res, status } = fakeRes();
    await handleMcpRequest(fakeReq({ authorization: `Bearer ${raw}` }), res, {
      pg,
      relay,
      rateLimiter,
    } as unknown as Parameters<typeof handleMcpRequest>[2]);
    expect(status()).toBe(429);
  });
});

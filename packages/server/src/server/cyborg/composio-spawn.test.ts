import { describe, expect, it } from "vitest";
import { InMemoryComposioConnectionStore } from "./composio-connection-store.js";
import { FakeComposioClient } from "./composio-fake.js";
import { composioMcpForSpawn, parseCyboToolGrants } from "./composio-spawn.js";

describe("parseCyboToolGrants", () => {
  it("returns empty for null/blank/garbled input (never throws)", () => {
    expect(parseCyboToolGrants(null)).toEqual({ composio: [] });
    expect(parseCyboToolGrants(undefined)).toEqual({ composio: [] });
    expect(parseCyboToolGrants("")).toEqual({ composio: [] });
    expect(parseCyboToolGrants("{not json")).toEqual({ composio: [] });
    expect(parseCyboToolGrants('{"composio":"wrong-type"}')).toEqual({ composio: [] });
  });

  it("parses + defaults a valid grant blob", () => {
    const raw = JSON.stringify({
      composio: [{ toolkit: "gmail", allowedActions: ["GMAIL_FETCH"] }],
    });
    const parsed = parseCyboToolGrants(raw);
    expect(parsed.composio[0]).toMatchObject({
      toolkit: "gmail",
      binding: "caller", // default applied
      allowedActions: ["GMAIL_FETCH"],
      requireApproval: [],
    });
  });
});

describe("composioMcpForSpawn", () => {
  it("is a strict no-op when the cybo has no grants", async () => {
    const res = await composioMcpForSpawn({
      toolGrantsRaw: null,
      connections: new InMemoryComposioConnectionStore(),
      client: new FakeComposioClient(),
      workspaceId: "ws1",
      cyboId: "c1",
      invokerUserId: "alice",
    });
    expect(res).toEqual({ servers: {}, failures: [], approvalActions: [] });
  });

  it("mints the invoker's scoped MCP for a caller toolkit they connected", async () => {
    const connections = new InMemoryComposioConnectionStore();
    await connections.upsert({
      workspaceId: "ws1",
      ownerKind: "user",
      ownerId: "alice",
      toolkit: "gmail",
      connectedAccountId: "ca1",
      status: "active",
      createdAt: 1,
    });
    const res = await composioMcpForSpawn({
      toolGrantsRaw: JSON.stringify({
        composio: [{ toolkit: "gmail", binding: "caller", allowedActions: ["GMAIL_FETCH"] }],
      }),
      connections,
      client: new FakeComposioClient(),
      workspaceId: "ws1",
      cyboId: "c1",
      invokerUserId: "alice",
    });
    expect(Object.keys(res.servers)).toEqual(["composio:gmail"]);
    expect(res.servers["composio:gmail"]).toMatchObject({ type: "http" });
  });

  it("autonomous run (invokerUserId null) drops caller toolkits, keeps service", async () => {
    const connections = new InMemoryComposioConnectionStore();
    await connections.upsert({
      workspaceId: "ws1",
      ownerKind: "service",
      ownerId: "ws1",
      toolkit: "slack",
      connectedAccountId: "ca_svc",
      status: "active",
      createdAt: 1,
    });
    const res = await composioMcpForSpawn({
      toolGrantsRaw: JSON.stringify({
        composio: [
          { toolkit: "gmail", binding: "caller", allowedActions: ["GMAIL_FETCH"] },
          { toolkit: "slack", binding: "service", allowedActions: ["SLACK_POST"] },
        ],
      }),
      connections,
      client: new FakeComposioClient(),
      workspaceId: "ws1",
      cyboId: "c1",
      invokerUserId: null,
    });
    expect(Object.keys(res.servers)).toEqual(["composio:slack"]);
  });
});

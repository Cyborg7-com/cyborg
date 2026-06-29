import { describe, expect, it } from "vitest";
import type { ComposioConnection } from "./composio-types.js";
import { InMemoryComposioConnectionStore } from "./composio-connection-store.js";

function makeConnection(overrides: Partial<ComposioConnection> = {}): ComposioConnection {
  return {
    workspaceId: "ws1",
    ownerKind: "user",
    ownerId: "user1",
    toolkit: "gmail",
    connectedAccountId: "ca_abc",
    status: "active",
    createdAt: 1000,
    ...overrides,
  };
}

describe("InMemoryComposioConnectionStore", () => {
  it("round-trips an upserted connection via get", async () => {
    const store = new InMemoryComposioConnectionStore();
    const conn = makeConnection();
    await store.upsert(conn);

    const got = await store.get({
      workspaceId: "ws1",
      ownerKind: "user",
      ownerId: "user1",
      toolkit: "gmail",
    });
    expect(got).toEqual(conn);
  });

  it("returns null for a missing connection", async () => {
    const store = new InMemoryComposioConnectionStore();
    const got = await store.get({
      workspaceId: "ws1",
      ownerKind: "user",
      ownerId: "nobody",
      toolkit: "gmail",
    });
    expect(got).toBeNull();
  });

  it("replaces on upsert for the same (owner, toolkit) — one connection per key", async () => {
    const store = new InMemoryComposioConnectionStore();
    await store.upsert(makeConnection({ connectedAccountId: "ca_first", status: "pending" }));
    await store.upsert(makeConnection({ connectedAccountId: "ca_second", status: "active" }));

    const query = {
      workspaceId: "ws1",
      ownerKind: "user" as const,
      ownerId: "user1",
      toolkit: "gmail",
    };
    const got = await store.get(query);
    expect(got?.connectedAccountId).toBe("ca_second");
    expect(got?.status).toBe("active");

    const all = await store.list({ workspaceId: "ws1" });
    expect(all).toHaveLength(1);
  });

  it("keeps distinct toolkits and owners as separate connections", async () => {
    const store = new InMemoryComposioConnectionStore();
    await store.upsert(makeConnection({ toolkit: "gmail" }));
    await store.upsert(makeConnection({ toolkit: "slack" }));
    await store.upsert(makeConnection({ ownerKind: "service", ownerId: "ws1", toolkit: "gmail" }));

    const all = await store.list({ workspaceId: "ws1" });
    expect(all).toHaveLength(3);
  });

  it("lists filtered by ownerKind and ownerId", async () => {
    const store = new InMemoryComposioConnectionStore();
    await store.upsert(makeConnection({ ownerKind: "user", ownerId: "user1", toolkit: "gmail" }));
    await store.upsert(makeConnection({ ownerKind: "user", ownerId: "user2", toolkit: "gmail" }));
    await store.upsert(makeConnection({ ownerKind: "service", ownerId: "ws1", toolkit: "github" }));

    const users = await store.list({ workspaceId: "ws1", ownerKind: "user" });
    expect(users).toHaveLength(2);

    const services = await store.list({ workspaceId: "ws1", ownerKind: "service" });
    expect(services).toHaveLength(1);
    expect(services[0].ownerId).toBe("ws1");

    const user1 = await store.list({ workspaceId: "ws1", ownerKind: "user", ownerId: "user1" });
    expect(user1).toHaveLength(1);
    expect(user1[0].ownerId).toBe("user1");
  });

  it("does not leak connections across workspaces in list", async () => {
    const store = new InMemoryComposioConnectionStore();
    await store.upsert(makeConnection({ workspaceId: "ws1" }));
    await store.upsert(makeConnection({ workspaceId: "ws2" }));

    const ws1 = await store.list({ workspaceId: "ws1" });
    expect(ws1).toHaveLength(1);
    expect(ws1[0].workspaceId).toBe("ws1");
  });

  it("removes a connection", async () => {
    const store = new InMemoryComposioConnectionStore();
    const query = {
      workspaceId: "ws1",
      ownerKind: "user" as const,
      ownerId: "user1",
      toolkit: "gmail",
    };
    await store.upsert(makeConnection());
    await store.remove(query);

    expect(await store.get(query)).toBeNull();
    expect(await store.list({ workspaceId: "ws1" })).toHaveLength(0);
  });

  it("remove is a no-op for an absent connection", async () => {
    const store = new InMemoryComposioConnectionStore();
    await expect(
      store.remove({
        workspaceId: "ws1",
        ownerKind: "user",
        ownerId: "ghost",
        toolkit: "gmail",
      }),
    ).resolves.toBeUndefined();
  });

  it("hasActive is true only for status 'active'", async () => {
    const store = new InMemoryComposioConnectionStore();
    const query = {
      workspaceId: "ws1",
      ownerKind: "user" as const,
      ownerId: "user1",
      toolkit: "gmail",
    };

    // Missing → false.
    expect(await store.hasActive(query)).toBe(false);

    await store.upsert(makeConnection({ status: "pending" }));
    expect(await store.hasActive(query)).toBe(false);

    await store.upsert(makeConnection({ status: "expired" }));
    expect(await store.hasActive(query)).toBe(false);

    await store.upsert(makeConnection({ status: "active" }));
    expect(await store.hasActive(query)).toBe(true);
  });
});

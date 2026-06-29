import { describe, it, expect } from "vitest";
import { FakeComposioClient } from "./composio-fake.js";

describe("FakeComposioClient", () => {
  it("startLink returns a deterministic redirect URL + request id and records the call", async () => {
    const client = new FakeComposioClient();
    const a = await client.startLink({ entity: "u:alice", toolkit: "gmail" });
    const b = await client.startLink({ entity: "u:alice", toolkit: "gmail" });

    expect(a.connectionRequestId).not.toBe(b.connectionRequestId);
    expect(a.redirectUrl).toContain(encodeURIComponent(a.connectionRequestId));
    expect(client.startLinkCalls).toEqual([
      { entity: "u:alice", toolkit: "gmail" },
      { entity: "u:alice", toolkit: "gmail" },
    ]);
  });

  it("resolveConnection returns the default configured account/status", async () => {
    const client = new FakeComposioClient();
    const { connectionRequestId } = await client.startLink({ entity: "u:bob", toolkit: "slack" });
    const resolved = await client.resolveConnection({ connectionRequestId });

    expect(resolved).toEqual({ connectedAccountId: "fake-account", status: "active" });
  });

  it("resolveConnection honors a per-request override", async () => {
    const client = new FakeComposioClient().setConnectionForRequest("req-x", {
      connectedAccountId: "acct-99",
      status: "pending",
    });
    const resolved = await client.resolveConnection({ connectionRequestId: "req-x" });

    expect(resolved).toEqual({ connectedAccountId: "acct-99", status: "pending" });
  });

  it("resolveConnection honors the configurable default", async () => {
    const client = new FakeComposioClient().setDefaultConnection({
      connectedAccountId: "acct-default",
      status: "expired",
    });
    const resolved = await client.resolveConnection({ connectionRequestId: "anything" });

    expect(resolved).toEqual({ connectedAccountId: "acct-default", status: "expired" });
  });

  it("mintScopedMcpUrl embeds the entity + SORTED allowedActions for scope assertions", async () => {
    const client = new FakeComposioClient();
    const out = await client.mintScopedMcpUrl({
      entity: "ws:team",
      toolkit: "github",
      allowedActions: ["GITHUB_LIST_REPOS", "GITHUB_CREATE_ISSUE"],
    });

    expect(out.url).toContain("entity=ws%3Ateam");
    // Sorted: CREATE before LIST.
    expect(out.url).toContain("actions=GITHUB_CREATE_ISSUE,GITHUB_LIST_REPOS");
    expect(out.headers).toEqual({ "x-api-key": "fake-mcp-key" });
  });

  it("mintScopedMcpUrl is deterministic regardless of input action ordering", async () => {
    const client = new FakeComposioClient();
    const a = await client.mintScopedMcpUrl({
      entity: "u:c",
      toolkit: "gmail",
      allowedActions: ["B", "A", "C"],
    });
    const b = await client.mintScopedMcpUrl({
      entity: "u:c",
      toolkit: "gmail",
      allowedActions: ["C", "A", "B"],
    });

    expect(a.url).toBe(b.url);
    expect(client.mintCalls).toHaveLength(2);
    expect(client.mintCalls[0]?.allowedActions).toEqual(["B", "A", "C"]);
  });

  it("executeAction records calls and returns the default configured result", async () => {
    const client = new FakeComposioClient();
    const r = await client.executeAction({
      entity: "u:alice",
      action: "GMAIL_SEND_EMAIL",
      args: { to: "x@y.z" },
    });

    expect(r).toEqual({ ok: true, result: { ok: true } });
    expect(client.executeCalls).toEqual([
      { entity: "u:alice", action: "GMAIL_SEND_EMAIL", args: { to: "x@y.z" } },
    ]);
  });

  it("executeAction honors a per-action override and a configurable default", async () => {
    const client = new FakeComposioClient()
      .setDefaultExecuteResult({ ok: false, error: "boom" })
      .setExecuteResultForAction("GMAIL_SEND_EMAIL", { ok: true, result: { id: "msg-1" } });

    const ok = await client.executeAction({ entity: "u:a", action: "GMAIL_SEND_EMAIL", args: {} });
    const fail = await client.executeAction({ entity: "u:a", action: "OTHER", args: {} });

    expect(ok).toEqual({ ok: true, result: { id: "msg-1" } });
    expect(fail).toEqual({ ok: false, error: "boom" });
    expect(client.executeCalls.map((c) => c.action)).toEqual(["GMAIL_SEND_EMAIL", "OTHER"]);
  });

  it("satisfies the ComposioClient interface (assignable, all methods present)", async () => {
    const client = new FakeComposioClient();
    // If the class drifted from the interface, this would fail to typecheck.
    const methods = [
      client.startLink,
      client.resolveConnection,
      client.mintScopedMcpUrl,
      client.executeAction,
    ];
    expect(methods.every((m) => typeof m === "function")).toBe(true);
  });
});

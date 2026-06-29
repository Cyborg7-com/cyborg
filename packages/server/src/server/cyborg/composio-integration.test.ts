// End-to-end test of the cybo↔Composio ownership model, composing the REAL modules
// (connection store + binding resolver + MCP injection) against the fake Composio
// client. This is the capstone proof that "a workspace-shared cybo binds personal
// auth per-invoker, shared auth per-workspace" holds across the whole pipeline — not
// just in the pure resolver.

import { beforeEach, describe, expect, it } from "vitest";
import { resolveComposioTools } from "./composio-binding.js";
import { InMemoryComposioConnectionStore } from "./composio-connection-store.js";
import { FakeComposioClient } from "./composio-fake.js";
import { buildComposioMcpServers, composioApprovalActions } from "./composio-mcp.js";
import type { ComposioRunContext, ComposioToolGrant } from "./composio-types.js";

const WS = "ws1";

// A cybo (workspace entity) granted: Gmail acting as the INVOKER (read freely, send
// needs approval), and Slack acting as a SHARED workspace account.
const GRANTS: ComposioToolGrant[] = [
  {
    toolkit: "gmail",
    binding: "caller",
    allowedActions: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
    requireApproval: ["GMAIL_SEND_EMAIL"],
  },
  {
    toolkit: "slack",
    binding: "service",
    allowedActions: ["SLACK_POST_MESSAGE"],
    requireApproval: [],
  },
];

let store: InMemoryComposioConnectionStore;

beforeEach(async () => {
  store = new InMemoryComposioConnectionStore();
  // Alice connected HER personal Gmail. The workspace has a shared Slack account.
  await store.upsert({
    workspaceId: WS,
    ownerKind: "user",
    ownerId: "alice",
    toolkit: "gmail",
    connectedAccountId: "ca_alice_gmail",
    status: "active",
    createdAt: 1,
  });
  await store.upsert({
    workspaceId: WS,
    ownerKind: "service",
    ownerId: WS,
    toolkit: "slack",
    connectedAccountId: "ca_ws_slack",
    status: "active",
    createdAt: 1,
  });
});

// Build a run context the way the live spawn path would: read the workspace's
// connections ONCE (async), then expose a synchronous membership check to the pure
// resolver.
async function runContextFor(invokerUserId: string | null): Promise<ComposioRunContext> {
  const conns = await store.list({ workspaceId: WS });
  const active = new Set(
    conns
      .filter((c) => c.status === "active")
      .map((c) => `${c.ownerKind}:${c.ownerId}:${c.toolkit}`),
  );
  return {
    workspaceId: WS,
    cyboId: "cybo1",
    invokerUserId,
    hasConnection: (q) => active.has(`${q.ownerKind}:${q.ownerId}:${q.toolkit}`),
  };
}

describe("cybo↔Composio spawn pipeline (end to end)", () => {
  it("Alice (the connector) gets Gmail as herself + the shared Slack", async () => {
    const ctx = await runContextFor("alice");
    const resolution = resolveComposioTools(GRANTS, ctx);
    const client = new FakeComposioClient();
    const { servers, failures } = await buildComposioMcpServers(resolution, client);

    expect(failures).toEqual([]);
    expect(Object.keys(servers).sort()).toEqual(["composio:gmail", "composio:slack"]);

    // Gmail is minted for ALICE'S entity, scoped to the read action only — the
    // approval-gated SEND is deliberately withheld from the MCP URL.
    const gmailMint = client.mintCalls.find((m) => m.toolkit === "gmail");
    expect(gmailMint).toMatchObject({
      entity: "u:ws1:alice",
      allowedActions: ["GMAIL_FETCH_EMAILS"],
    });
    expect(gmailMint?.allowedActions).not.toContain("GMAIL_SEND_EMAIL");

    // Slack is minted for the WORKSPACE entity.
    const slackMint = client.mintCalls.find((m) => m.toolkit === "slack");
    expect(slackMint).toMatchObject({ entity: "ws:ws1", allowedActions: ["SLACK_POST_MESSAGE"] });

    // The send action is offered ONLY through the Tier-2 approval path, as Alice.
    expect(composioApprovalActions(resolution)).toEqual([
      { toolkit: "gmail", entity: "u:ws1:alice", action: "GMAIL_SEND_EMAIL" },
    ]);
  });

  it("Bob (no Gmail connection) does NOT inherit Alice's account — only the shared Slack", async () => {
    const ctx = await runContextFor("bob");
    const resolution = resolveComposioTools(GRANTS, ctx);
    const client = new FakeComposioClient();
    const { servers } = await buildComposioMcpServers(resolution, client);

    // Gmail is blocked for Bob; he never gets Alice's entity. Slack (shared) still works.
    expect(Object.keys(servers)).toEqual(["composio:slack"]);
    expect(client.mintCalls.some((m) => m.toolkit === "gmail")).toBe(false);
    expect(resolution.blocked).toEqual([
      expect.objectContaining({ toolkit: "gmail", reason: "no-connection" }),
    ]);
  });

  it("an autonomous run (no invoker) gets ONLY the shared service tools", async () => {
    const ctx = await runContextFor(null);
    const resolution = resolveComposioTools(GRANTS, ctx);
    const client = new FakeComposioClient();
    const { servers } = await buildComposioMcpServers(resolution, client);

    expect(Object.keys(servers)).toEqual(["composio:slack"]);
    expect(resolution.blocked).toEqual([
      expect.objectContaining({ toolkit: "gmail", reason: "autonomous-caller" }),
    ]);
  });

  it("once Bob connects his OWN Gmail, he acts as himself — never Alice", async () => {
    await store.upsert({
      workspaceId: WS,
      ownerKind: "user",
      ownerId: "bob",
      toolkit: "gmail",
      connectedAccountId: "ca_bob_gmail",
      status: "active",
      createdAt: 2,
    });
    const ctx = await runContextFor("bob");
    const resolution = resolveComposioTools(GRANTS, ctx);
    const client = new FakeComposioClient();
    await buildComposioMcpServers(resolution, client);

    const gmailMint = client.mintCalls.find((m) => m.toolkit === "gmail");
    expect(gmailMint?.entity).toBe("u:ws1:bob");
  });
});

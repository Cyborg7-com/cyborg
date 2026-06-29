import { describe, expect, it } from "vitest";
import { resolveComposioTools } from "./composio-binding.js";
import { buildComposioMcpServers, composioApprovalActions } from "./composio-mcp.js";
import {
  type ComposioClient,
  type ComposioRunContext,
  type ComposioToolGrant,
  type ConnectionOwnerKind,
} from "./composio-types.js";

// A run context whose connection set is a literal list of owned connections.
function ctx(input: {
  invokerUserId?: string | null;
  connections?: { ownerKind: ConnectionOwnerKind; ownerId: string; toolkit: string }[];
}): ComposioRunContext {
  const conns = input.connections ?? [];
  return {
    workspaceId: "ws1",
    cyboId: "cybo1",
    invokerUserId: input.invokerUserId === undefined ? "alice" : input.invokerUserId,
    hasConnection: (q) =>
      conns.some(
        (c) => c.ownerKind === q.ownerKind && c.ownerId === q.ownerId && c.toolkit === q.toolkit,
      ),
  };
}

const grant = (over: Partial<ComposioToolGrant> = {}): ComposioToolGrant => ({
  toolkit: "gmail",
  binding: "caller",
  allowedActions: ["GMAIL_FETCH_EMAILS"],
  requireApproval: [],
  ...over,
});

// A minimal fake ComposioClient — only mintScopedMcpUrl is exercised here. Each mint
// echoes its inputs into a deterministic URL so tests can assert what got minted.
// `failOn` forces a throw for a named toolkit (to exercise the failure path).
function fakeClient(opts: { failOn?: string } = {}): ComposioClient {
  return {
    async startLink() {
      throw new Error("not used");
    },
    async resolveConnection() {
      throw new Error("not used");
    },
    async mintScopedMcpUrl(input) {
      if (opts.failOn && input.toolkit === opts.failOn) {
        throw new Error(`mint failed for ${input.toolkit}`);
      }
      return {
        url: `https://mcp.composio.test/${input.entity}/${input.toolkit}?actions=${input.allowedActions.join(",")}`,
        headers: { "x-entity": input.entity },
      };
    },
    async executeAction() {
      throw new Error("not used");
    },
  };
}

describe("buildComposioMcpServers", () => {
  it("yields one http MCP entry per available toolkit, scoped to its direct actions", async () => {
    const grants = [
      grant({ toolkit: "gmail", allowedActions: ["GMAIL_FETCH_EMAILS"] }),
      grant({ toolkit: "slack", allowedActions: ["SLACK_SEND_MESSAGE"] }),
    ];
    const resolution = resolveComposioTools(
      grants,
      ctx({
        invokerUserId: "alice",
        connections: [
          { ownerKind: "user", ownerId: "alice", toolkit: "gmail" },
          { ownerKind: "user", ownerId: "alice", toolkit: "slack" },
        ],
      }),
    );

    const { servers, failures } = await buildComposioMcpServers(resolution, fakeClient());

    expect(failures).toEqual([]);
    expect(Object.keys(servers).sort()).toEqual(["composio:gmail", "composio:slack"]);
    expect(servers["composio:gmail"]).toEqual({
      type: "http",
      url: "https://mcp.composio.test/u:ws1:alice/gmail?actions=GMAIL_FETCH_EMAILS",
      headers: { "x-entity": "u:ws1:alice" },
    });
    expect(servers["composio:slack"]).toMatchObject({
      type: "http",
      url: "https://mcp.composio.test/u:ws1:alice/slack?actions=SLACK_SEND_MESSAGE",
    });
  });

  it("omits a toolkit whose every action requires approval (no direct actions)", async () => {
    // gmail: 1 action, all approval-gated → no direct actions → no MCP entry.
    const grants = [
      grant({
        toolkit: "gmail",
        allowedActions: ["GMAIL_SEND_EMAIL"],
        requireApproval: ["GMAIL_SEND_EMAIL"],
      }),
    ];
    const resolution = resolveComposioTools(
      grants,
      ctx({
        invokerUserId: "alice",
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );

    const { servers, failures } = await buildComposioMcpServers(resolution, fakeClient());

    expect(servers).toEqual({});
    expect(failures).toEqual([]);
  });

  it("only direct actions reach the MCP — approval actions are withheld from the URL", async () => {
    const grants = [
      grant({
        toolkit: "gmail",
        allowedActions: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
        requireApproval: ["GMAIL_SEND_EMAIL"],
      }),
    ];
    const resolution = resolveComposioTools(
      grants,
      ctx({
        invokerUserId: "alice",
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );

    const { servers } = await buildComposioMcpServers(resolution, fakeClient());
    const entry = servers["composio:gmail"];
    expect(entry.type).toBe("http");
    if (entry.type === "http") {
      expect(entry.url).toContain("GMAIL_FETCH_EMAILS");
      expect(entry.url).not.toContain("GMAIL_SEND_EMAIL");
    }
  });

  it("collects a single mint failure without throwing, keeping the other toolkit", async () => {
    const grants = [
      grant({ toolkit: "gmail", allowedActions: ["GMAIL_FETCH_EMAILS"] }),
      grant({ toolkit: "slack", allowedActions: ["SLACK_SEND_MESSAGE"] }),
    ];
    const resolution = resolveComposioTools(
      grants,
      ctx({
        invokerUserId: "alice",
        connections: [
          { ownerKind: "user", ownerId: "alice", toolkit: "gmail" },
          { ownerKind: "user", ownerId: "alice", toolkit: "slack" },
        ],
      }),
    );

    const { servers, failures } = await buildComposioMcpServers(
      resolution,
      fakeClient({ failOn: "slack" }),
    );

    expect(Object.keys(servers)).toEqual(["composio:gmail"]);
    expect(failures).toEqual([{ toolkit: "slack", error: "mint failed for slack" }]);
  });

  it("returns empty servers + no failures for an empty resolution", async () => {
    const resolution = resolveComposioTools([], ctx({}));
    const { servers, failures } = await buildComposioMcpServers(resolution, fakeClient());
    expect(servers).toEqual({});
    expect(failures).toEqual([]);
  });
});

describe("composioApprovalActions", () => {
  it("flattens the Tier-2 approval actions across all available toolkits", () => {
    const grants = [
      grant({
        toolkit: "gmail",
        allowedActions: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
        requireApproval: ["GMAIL_SEND_EMAIL"],
      }),
      grant({
        toolkit: "slack",
        allowedActions: ["SLACK_SEND_MESSAGE", "SLACK_DELETE_MESSAGE"],
        requireApproval: ["SLACK_DELETE_MESSAGE"],
      }),
    ];
    const resolution = resolveComposioTools(
      grants,
      ctx({
        invokerUserId: "alice",
        connections: [
          { ownerKind: "user", ownerId: "alice", toolkit: "gmail" },
          { ownerKind: "user", ownerId: "alice", toolkit: "slack" },
        ],
      }),
    );

    expect(composioApprovalActions(resolution)).toEqual([
      { toolkit: "gmail", entity: "u:ws1:alice", action: "GMAIL_SEND_EMAIL" },
      { toolkit: "slack", entity: "u:ws1:alice", action: "SLACK_DELETE_MESSAGE" },
    ]);
  });

  it("returns an empty list when no toolkit has approval-gated actions", () => {
    const resolution = resolveComposioTools(
      [grant({ toolkit: "gmail", allowedActions: ["GMAIL_FETCH_EMAILS"] })],
      ctx({
        invokerUserId: "alice",
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );
    expect(composioApprovalActions(resolution)).toEqual([]);
  });
});

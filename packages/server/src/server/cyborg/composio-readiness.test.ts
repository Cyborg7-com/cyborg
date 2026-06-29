import { describe, expect, it } from "vitest";
import { composioConnectionStatus, cyboNeedsConnection } from "./composio-readiness.js";
import {
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

describe("composioConnectionStatus", () => {
  it("maps a connected toolkit to connected:true with no reason/remedy", () => {
    const statuses = composioConnectionStatus(
      [grant()],
      ctx({
        invokerUserId: "alice",
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );
    expect(statuses).toEqual([{ toolkit: "gmail", binding: "caller", connected: true }]);
  });

  it("surfaces the no-connection remedy for a toolkit the viewer hasn't connected", () => {
    const statuses = composioConnectionStatus(
      [grant()],
      ctx({ invokerUserId: "alice", connections: [] }),
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      toolkit: "gmail",
      binding: "caller",
      connected: false,
      blockedReason: "no-connection",
    });
    expect(statuses[0].remedy).toContain("Connect your gmail account");
  });

  it("reports connected and blocked toolkits side by side", () => {
    const statuses = composioConnectionStatus(
      [
        grant({ toolkit: "gmail", allowedActions: ["GMAIL_FETCH_EMAILS"] }),
        grant({ toolkit: "slack", allowedActions: ["SLACK_SEND_MESSAGE"] }),
      ],
      ctx({
        invokerUserId: "alice",
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );
    const byToolkit = Object.fromEntries(statuses.map((s) => [s.toolkit, s]));
    expect(byToolkit.gmail.connected).toBe(true);
    expect(byToolkit.slack.connected).toBe(false);
    expect(byToolkit.slack.blockedReason).toBe("no-connection");
  });
});

describe("cyboNeedsConnection", () => {
  it("is true when a grant is blocked on no-connection", () => {
    expect(cyboNeedsConnection([grant()], ctx({ invokerUserId: "alice", connections: [] }))).toBe(
      true,
    );
  });

  it("is false when every grant is connected", () => {
    expect(
      cyboNeedsConnection(
        [grant()],
        ctx({
          invokerUserId: "alice",
          connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
        }),
      ),
    ).toBe(false);
  });

  it("is false when the only block is non-connection (e.g. no-actions)", () => {
    // empty allow-list → blocked as "no-actions", NOT "no-connection".
    expect(
      cyboNeedsConnection([grant({ allowedActions: [] })], ctx({ invokerUserId: "alice" })),
    ).toBe(false);
  });
});

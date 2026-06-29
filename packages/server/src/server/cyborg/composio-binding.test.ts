import { describe, expect, it } from "vitest";
import {
  canConfigureToolGrants,
  canConnectAccount,
  resolveComposioTools,
} from "./composio-binding.js";
import {
  type ComposioRunContext,
  type ComposioToolGrant,
  type ConnectionOwnerKind,
} from "./composio-types.js";

// A run context whose connection set is a literal list of owned connections.
function ctx(input: {
  invokerUserId?: string | null;
  connections?: { ownerKind: ConnectionOwnerKind; ownerId: string; toolkit: string }[];
  workspaceId?: string;
  cyboId?: string;
}): ComposioRunContext {
  const conns = input.connections ?? [];
  return {
    workspaceId: input.workspaceId ?? "ws1",
    cyboId: input.cyboId ?? "cybo1",
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

describe("resolveComposioTools — caller binding (personal accounts)", () => {
  it("the invoker WITH a connection gets the toolkit, acting as their own entity", () => {
    const res = resolveComposioTools(
      [grant()],
      ctx({
        invokerUserId: "alice",
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );
    expect(res.blocked).toEqual([]);
    expect(res.available).toHaveLength(1);
    expect(res.available[0]).toMatchObject({
      toolkit: "gmail",
      binding: "caller",
      ownerKind: "user",
      ownerId: "alice",
      entity: "u:ws1:alice",
      directActions: ["GMAIL_FETCH_EMAILS"],
      approvalActions: [],
    });
  });

  it("the invoker WITHOUT a connection is blocked (no silent disappearance)", () => {
    const res = resolveComposioTools([grant()], ctx({ invokerUserId: "alice", connections: [] }));
    expect(res.available).toEqual([]);
    expect(res.blocked[0]).toMatchObject({ toolkit: "gmail", reason: "no-connection" });
    expect(res.blocked[0].remedy).toContain("Connect your gmail");
  });

  // THE CORE TENSION: a workspace-shared cybo must NOT let user B act as user A's
  // personal Gmail. Same cybo, same grant — bound to whoever invokes.
  it("does NOT leak one user's personal account to another user", () => {
    const grants = [grant()];
    const connections = [{ ownerKind: "user" as const, ownerId: "alice", toolkit: "gmail" }];

    // Alice invokes → acts as alice.
    const forAlice = resolveComposioTools(grants, ctx({ invokerUserId: "alice", connections }));
    expect(forAlice.available[0]).toMatchObject({ ownerId: "alice", entity: "u:ws1:alice" });

    // Bob invokes the SAME cybo → he does NOT inherit alice's Gmail; he's blocked
    // until he connects his own. The entity is never alice's for bob.
    const forBob = resolveComposioTools(grants, ctx({ invokerUserId: "bob", connections }));
    expect(forBob.available).toEqual([]);
    expect(forBob.blocked[0]).toMatchObject({ toolkit: "gmail", reason: "no-connection" });

    // And once Bob connects his OWN, he acts as bob — never alice.
    const forBobConnected = resolveComposioTools(
      grants,
      ctx({
        invokerUserId: "bob",
        connections: [...connections, { ownerKind: "user", ownerId: "bob", toolkit: "gmail" }],
      }),
    );
    expect(forBobConnected.available[0]).toMatchObject({ ownerId: "bob", entity: "u:ws1:bob" });
  });

  it("an AUTONOMOUS run (no invoker) blocks a caller toolkit with a clear remedy", () => {
    const res = resolveComposioTools(
      [grant()],
      ctx({
        invokerUserId: null,
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );
    expect(res.available).toEqual([]);
    expect(res.blocked[0]).toMatchObject({ reason: "autonomous-caller" });
    expect(res.blocked[0].remedy).toContain("service account");
  });
});

describe("resolveComposioTools — service binding (shared accounts)", () => {
  const svc = grant({ binding: "service" });

  it("uses the workspace-owned account regardless of who invokes", () => {
    const connections = [{ ownerKind: "service" as const, ownerId: "ws1", toolkit: "gmail" }];
    for (const invoker of ["alice", "bob", null]) {
      const res = resolveComposioTools([svc], ctx({ invokerUserId: invoker, connections }));
      expect(res.available[0]).toMatchObject({
        binding: "service",
        ownerKind: "service",
        ownerId: "ws1",
        entity: "ws:ws1",
      });
    }
  });

  it("is blocked (needs an admin connection) when the workspace account is missing", () => {
    const res = resolveComposioTools([svc], ctx({ connections: [] }));
    expect(res.available).toEqual([]);
    expect(res.blocked[0]).toMatchObject({ reason: "no-connection" });
    expect(res.blocked[0].remedy).toContain("admin");
  });

  it("works for an autonomous run (service is the only autonomous-capable binding)", () => {
    const res = resolveComposioTools(
      [svc],
      ctx({
        invokerUserId: null,
        connections: [{ ownerKind: "service", ownerId: "ws1", toolkit: "gmail" }],
      }),
    );
    expect(res.available).toHaveLength(1);
    expect(res.blocked).toEqual([]);
  });
});

describe("resolveComposioTools — action split + edge cases", () => {
  it("splits direct vs approval actions (approval ones stay out of the MCP)", () => {
    const res = resolveComposioTools(
      [
        grant({
          allowedActions: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
          requireApproval: ["GMAIL_SEND_EMAIL"],
        }),
      ],
      ctx({ connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }] }),
    );
    expect(res.available[0].directActions).toEqual(["GMAIL_FETCH_EMAILS"]);
    expect(res.available[0].approvalActions).toEqual(["GMAIL_SEND_EMAIL"]);
  });

  it("ignores a requireApproval entry that isn't actually allowed", () => {
    const res = resolveComposioTools(
      [grant({ allowedActions: ["GMAIL_FETCH_EMAILS"], requireApproval: ["GMAIL_SEND_EMAIL"] })],
      ctx({ connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }] }),
    );
    expect(res.available[0].directActions).toEqual(["GMAIL_FETCH_EMAILS"]);
    expect(res.available[0].approvalActions).toEqual([]);
  });

  it("blocks a grant with no actions enabled", () => {
    const res = resolveComposioTools([grant({ allowedActions: [] })], ctx({}));
    expect(res.blocked[0]).toMatchObject({ reason: "no-actions" });
  });

  it("resolves multiple grants independently (one available, one blocked)", () => {
    const res = resolveComposioTools(
      [grant({ toolkit: "gmail" }), grant({ toolkit: "slack", allowedActions: ["SLACK_POST"] })],
      ctx({
        invokerUserId: "alice",
        connections: [{ ownerKind: "user", ownerId: "alice", toolkit: "gmail" }],
      }),
    );
    expect(res.available.map((a) => a.toolkit)).toEqual(["gmail"]);
    expect(res.blocked.map((b) => b.toolkit)).toEqual(["slack"]);
  });
});

describe("permission matrix", () => {
  it("only admin/owner may configure tool grants", () => {
    expect(canConfigureToolGrants("owner")).toBe(true);
    expect(canConfigureToolGrants("admin")).toBe(true);
    expect(canConfigureToolGrants("member")).toBe(false);
    expect(canConfigureToolGrants("viewer")).toBe(false);
    expect(canConfigureToolGrants(null)).toBe(false);
  });

  it("a caller account can only be connected by its own user", () => {
    expect(canConnectAccount({ binding: "caller", role: "member", isSelf: true }).allowed).toBe(
      true,
    );
    expect(canConnectAccount({ binding: "caller", role: "member", isSelf: false }).allowed).toBe(
      false,
    );
    expect(canConnectAccount({ binding: "caller", role: "viewer", isSelf: true }).allowed).toBe(
      false,
    );
  });

  it("a service account can only be connected by an admin/owner", () => {
    expect(canConnectAccount({ binding: "service", role: "admin", isSelf: false }).allowed).toBe(
      true,
    );
    expect(canConnectAccount({ binding: "service", role: "owner", isSelf: false }).allowed).toBe(
      true,
    );
    expect(canConnectAccount({ binding: "service", role: "member", isSelf: true }).allowed).toBe(
      false,
    );
  });

  it("non-members cannot connect anything", () => {
    expect(canConnectAccount({ binding: "caller", role: null, isSelf: true }).allowed).toBe(false);
    expect(canConnectAccount({ binding: "service", role: null, isSelf: false }).allowed).toBe(
      false,
    );
  });
});

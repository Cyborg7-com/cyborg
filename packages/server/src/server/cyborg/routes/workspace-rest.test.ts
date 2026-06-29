import { describe, it, expect } from "vitest";
import type { Context, Next } from "hono";
import { createWorkspaceRestRoutes } from "./workspace-rest.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RelayEnv } from "./types.js";

// A disabled workspace must be unreadable over REST, not just unsubscribable
// over WS (an adversarial-review finding: the WS `subscribe_workspace` gate alone
// let a member still read channels/messages/members/daemons/cybos via HTTP). The
// `denyWorkspaceRead` guard checks membership FIRST (no info leak to non-members)
// then disabled state. These tests drive the REAL Hono app via
// createWorkspaceRestRoutes with a typed-fake pg + a stub requireAuth.

interface FakeOpts {
  callerId: string;
  // workspaceId -> Set of member userIds.
  members?: Record<string, Set<string>>;
  // workspaceIds that are disabled.
  disabled?: Set<string>;
}

function makeApp(opts: FakeOpts) {
  const requireAuth = async (c: Context<RelayEnv>, next: Next) => {
    c.set("userId", opts.callerId);
    c.set("userEmail", `${opts.callerId}@e2e.dev`);
    await next();
  };

  const pg = {
    async isMember(workspaceId: string, userId: string) {
      return opts.members?.[workspaceId]?.has(userId) ?? false;
    },
    async isWorkspaceDisabled(workspaceId: string) {
      return opts.disabled?.has(workspaceId) ?? false;
    },
    // Read getters — only reached when the guard allows access.
    async getChannels() {
      return [{ id: "c1" }];
    },
    async getMembers() {
      return [{ userId: "u1" }];
    },
    async getDaemonsForWorkspace() {
      return [{ id: "d1" }];
    },
    async getCybos() {
      return [{ id: "cy1" }];
    },
    async getMessages() {
      return [{ id: "m1" }];
    },
  } as unknown as PgSync;

  return createWorkspaceRestRoutes({ pg, requireAuth });
}

const WS = "ws_1";
const USER = "u_member";

describe("workspace REST disabled-workspace guard", () => {
  const readPaths = [
    `/api/workspaces/${WS}/channels`,
    `/api/workspaces/${WS}/members`,
    `/api/workspaces/${WS}/daemons`,
    `/api/workspaces/${WS}/cybos`,
    `/api/workspaces/${WS}/messages?channelId=c1`,
  ];

  it("allows a member to read an active (non-disabled) workspace", async () => {
    const app = makeApp({ callerId: USER, members: { [WS]: new Set([USER]) } });
    for (const path of readPaths) {
      const res = await app.request(path);
      expect(res.status, path).toBe(200);
    }
  });

  it("blocks a member from reading a DISABLED workspace (403) on every read endpoint", async () => {
    const app = makeApp({
      callerId: USER,
      members: { [WS]: new Set([USER]) },
      disabled: new Set([WS]),
    });
    for (const path of readPaths) {
      const res = await app.request(path);
      expect(res.status, path).toBe(403);
      expect((await res.json()).error).toMatch(/disabled/i);
    }
  });

  it("rejects a non-member as 'not a member' (membership checked first — no disabled-state leak)", async () => {
    const app = makeApp({
      callerId: "u_outsider",
      members: { [WS]: new Set([USER]) },
      disabled: new Set([WS]),
    });
    const res = await app.request(`/api/workspaces/${WS}/channels`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not a member");
  });
});

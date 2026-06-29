// Hardening of the autonomy/invocation surface on the daemon-LOCAL path
// (message-router), with NO real PG (a fake pg is injected into DualStorage) so
// the suite is deterministic in CI:
//
//   1. FIREWALL (code-enforced anti-loop): a NON-human-authored post must NOT
//      invoke a mentioned cybo (invokeMentionedCybos) nor wake the watcher
//      (invokeChannelWatchers). Previously the guard was purely topological
//      (only the human path called these) + a FALSE "we also defend with an
//      explicit human-author check" comment. The guard is now real — proven by
//      flipping authorType and asserting zero spawns, while the human case spawns.
//
//   2. RATE-LIMIT + FAN-OUT CAP: the @-mention spawn path was unthrottled — one
//      message mentioning N cybos fired N concurrent spawns; rapid posting was
//      unbounded. A per-message fan-out cap (MAX_MENTION_FANOUT) + a per-workspace
//      agent_spawn rate-limit now bound it.
//
// The spawn seam (spawnCybo) is module-mocked so a "spawn" is observable without
// a real agent/provider; routeToAgent is stubbed so no turn streams.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const { spawnCyboMock } = vi.hoisted(() => ({ spawnCyboMock: vi.fn() }));
vi.mock("./cybo-manager.js", () => ({ spawnCybo: spawnCyboMock }));

import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import { MAX_MENTION_FANOUT } from "./cybo-mention-invoke.js";
import type { CyborgAuthContext } from "./auth.js";
import type { CyborgChannelMessage } from "./cyborg-messages.js";

interface Notice {
  type: string;
  payload: { text: string; channelId: string };
}

interface Harness {
  storage: DualStorage;
  router: MessageRouter;
  notices: Notice[];
  userId: string;
  wsId: string;
  channelId: string;
  channelName: string;
}

// Build a real-SQLite + fake-PG MessageRouter. The fake pg implements only the
// reads the mention/watcher paths touch; everything else (workspace/channel/cybo
// roster) is real SQLite. mentionMembers feeds getChannelCyboMembers.
function makeHarness(opts: { cyboCount: number }): Harness {
  const sqlite = new CyborgStorage(":memory:");
  const user = sqlite.upsertUser(`fw-${randomUUID()}@e2e.dev`, "Owner");
  const ws = sqlite.createWorkspace("FW WS", user.id);
  const channel = sqlite.createChannel(ws.id, "general", user.id);

  const cyboIds: string[] = [];
  for (let i = 0; i < opts.cyboCount; i++) {
    const c = sqlite.createCybo({
      workspaceId: ws.id,
      slug: `cybo${i}`,
      name: `Cybo ${i}`,
      soul: "soul",
      provider: "pi",
      createdBy: user.id,
    });
    cyboIds.push(c.id);
  }

  // Fake PG: the mention + watcher async reads. getChannelCyboMembers returns
  // every cybo as a channel member so resolveMentionedCybos resolves them.
  const fakePg = {
    getChannelCyboMembers: async () => cyboIds,
    getChannelMembers: async () => [],
    getMessages: async () => [],
    getTasks: async () => [],
    getWorkspaceAutonomyEnabled: async () => true,
    getChannelAutoTasksEnabled: async () => true,
  };

  const storage = new DualStorage(sqlite, fakePg as never);
  const workspaceManager = new WorkspaceManager(storage);
  const notices: Notice[] = [];
  const broadcast: BroadcastFn = {
    toWorkspace() {},
    toUser(_userId: string, msg: unknown) {
      notices.push(msg as Notice);
    },
  };
  const router = new MessageRouter(storage, workspaceManager, broadcast);
  router.setAgentManager({ getAgent: () => undefined, subscribe: () => () => {} } as never);

  // Post-spawn seam: stub so no real turn streams.
  vi.spyOn(MessageRouter.prototype, "routeToAgent").mockResolvedValue(undefined as never);

  // Each spawn yields a distinct agent id.
  spawnCyboMock.mockImplementation(async () => ({ agentId: `ag_${randomUUID()}` }));

  return {
    storage,
    router,
    notices,
    userId: user.id,
    wsId: ws.id,
    channelId: channel.id,
    channelName: channel.name,
  };
}

function authOf(h: Harness): CyborgAuthContext {
  return { user: { id: h.userId, email: "owner@e2e.dev", name: "Owner" } } as CyborgAuthContext;
}

function channelOf(h: Harness) {
  return { id: h.channelId, name: h.channelName, workspace_id: h.wsId };
}

// Direct access to the two private invokers (the daemon-LOCAL invocation seam).
function invokeMention(
  h: Harness,
  opts: { mentions: string[]; messageId: string; authorType: string; text?: string },
): Promise<void> {
  const msg = {
    type: "cyborg:channel_message",
    workspaceId: h.wsId,
    channelId: h.channelId,
    text: opts.text ?? "@cybo0 hola",
    mentions: opts.mentions,
  } as unknown as CyborgChannelMessage;
  return (
    h.router as unknown as {
      invokeMentionedCybos: (
        c: ReturnType<typeof channelOf>,
        a: CyborgAuthContext,
        m: CyborgChannelMessage,
        id: string | undefined,
        text: string,
        authorType: string,
      ) => Promise<void>;
    }
  ).invokeMentionedCybos(channelOf(h), authOf(h), msg, opts.messageId, msg.text, opts.authorType);
}

function invokeWatcher(
  h: Harness,
  opts: { messageId: string; authorType: string; text?: string },
): Promise<void> {
  const msg = { mentions: [] } as unknown as CyborgChannelMessage;
  return (
    h.router as unknown as {
      invokeChannelWatchers: (
        c: ReturnType<typeof channelOf>,
        a: CyborgAuthContext,
        m: CyborgChannelMessage,
        id: string | undefined,
        text: string,
        authorType: string,
      ) => Promise<void>;
    }
  ).invokeChannelWatchers(
    channelOf(h),
    authOf(h),
    msg,
    opts.messageId,
    opts.text ?? "please deploy the relay now",
    opts.authorType,
  );
}

beforeEach(() => {
  spawnCyboMock.mockReset();
  vi.restoreAllMocks();
});

describe("daemon firewall — explicit human-author guard (code-enforced anti-loop)", () => {
  it("an AGENT-authored post does NOT invoke a mentioned cybo", async () => {
    const h = makeHarness({ cyboCount: 1 });
    await invokeMention(h, {
      mentions: [`cybo:${(await h.storage.pg!.getChannelCyboMembers("x"))[0]}`],
      messageId: randomUUID(),
      authorType: "agent",
    });
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("a HUMAN-authored post DOES invoke the mentioned cybo (proves the guard, not some other gate, blocks it)", async () => {
    const h = makeHarness({ cyboCount: 1 });
    const memberId = (await h.storage.pg!.getChannelCyboMembers("x"))[0];
    await invokeMention(h, {
      mentions: [`cybo:${memberId}`],
      messageId: randomUUID(),
      authorType: "human",
    });
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
  });

  it("an AGENT-authored post does NOT wake the channel watcher", async () => {
    const h = makeHarness({ cyboCount: 1 });
    await invokeWatcher(h, { messageId: randomUUID(), authorType: "agent" });
    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  it("a HUMAN-authored post DOES wake the channel watcher (control)", async () => {
    const h = makeHarness({ cyboCount: 1 });
    await invokeWatcher(h, { messageId: randomUUID(), authorType: "human" });
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
  });
});

describe("@-mention spawn — fan-out cap + per-workspace rate-limit", () => {
  it("one message mentioning more cybos than the cap spawns at most MAX_MENTION_FANOUT and notices the author", async () => {
    const count = MAX_MENTION_FANOUT + 2;
    const h = makeHarness({ cyboCount: count });
    const members = await h.storage.pg!.getChannelCyboMembers("x");
    await invokeMention(h, {
      mentions: members.map((id) => `cybo:${id}`),
      messageId: randomUUID(),
      authorType: "human",
    });
    expect(spawnCyboMock).toHaveBeenCalledTimes(MAX_MENTION_FANOUT);
    expect(h.notices.some((n) => n.payload.text.includes("first"))).toBe(true);
  });

  it("rapid posting is bounded by the agent_spawn budget (10/hr) — spawns stop and the author is throttled", async () => {
    // 18 distinct cybo members across 6 messages × 3 mentions each = 18 spawn
    // attempts, all distinct (messageId, cyboId) so the dedup guard never fires.
    // The agent_spawn bucket (10/hr) is the ONLY thing that can cap them.
    const h = makeHarness({ cyboCount: 18 });
    const members = await h.storage.pg!.getChannelCyboMembers("x");
    for (let m = 0; m < 6; m++) {
      const slice = members.slice(m * 3, m * 3 + 3);
      await invokeMention(h, {
        mentions: slice.map((id) => `cybo:${id}`),
        messageId: `msg-${m}`,
        authorType: "human",
      });
    }
    expect(spawnCyboMock).toHaveBeenCalledTimes(10); // agent_spawn maxRequests
    expect(h.notices.some((n) => n.payload.text.includes("too often"))).toBe(true);
  });
});

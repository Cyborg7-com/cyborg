import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCyborg7McpServer, type Cyborg7McpDeps } from "./cyborg7-mcp-tools.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { SqliteAgentTimelineStore } from "./sqlite-timeline-store.js";
import { CyboSessionContext } from "./cybo-session-context.js";

// Platform-permission enforcement: createCyborg7McpServer only registers the
// write tools the spawning cybo is granted. listTools never invokes the tool
// handlers, so empty deps are fine here (handlers reference storage lazily).
const emptyDeps = {} as unknown as Cyborg7McpDeps;

async function toolNames(
  platformPermissions?: string[],
  strictPermissions?: boolean,
): Promise<string[]> {
  const server = createCyborg7McpServer(emptyDeps, {
    workspaceId: "ws_1",
    agentId: "ag_1",
    platformPermissions,
    strictPermissions,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describe("cyborg7 mcp platform-permission enforcement", () => {
  it("an empty/unrestricted permission set exposes every tool", async () => {
    const names = await toolNames([]);
    expect(names).toContain("cyborg7_send_message");
    expect(names).toContain("cyborg7_create_task");
    expect(names).toContain("cyborg7_update_task");
    expect(names).toContain("cyborg7_list_channels");
  });

  it("a create_task grant withholds send_message but keeps the task + read tools", async () => {
    const names = await toolNames(["create_task"]);
    expect(names).not.toContain("cyborg7_send_message");
    expect(names).toContain("cyborg7_create_task");
    expect(names).toContain("cyborg7_update_task");
    // Read tools are always available regardless of permissions.
    expect(names).toContain("cyborg7_get_channel_history");
    expect(names).toContain("cyborg7_list_tasks");
    expect(names).toContain("cyborg7_list_channels");
    expect(names).toContain("cyborg7_get_workspace_roster");
  });

  it("a send_message grant exposes messaging but withholds the task tools", async () => {
    const names = await toolNames(["send_message"]);
    expect(names).toContain("cyborg7_send_message");
    expect(names).not.toContain("cyborg7_create_task");
    expect(names).not.toContain("cyborg7_update_task");
  });

  // #204: scheduling a cybo is a recurring agent spawn (code execution), so the
  // whole schedule surface is gated on spawn_agents — a restricted cybo without
  // that grant must not be able to schedule (or delete/list) recurring runs.
  const SCHEDULE_TOOLS = [
    "cyborg7_schedule_create",
    "cyborg7_schedule_list",
    "cyborg7_schedule_delete",
  ];

  it("an unrestricted permission set exposes the schedule tools", async () => {
    const names = await toolNames([]);
    for (const tool of SCHEDULE_TOOLS) expect(names).toContain(tool);
  });

  it("the spawn_agents grant exposes the schedule tools", async () => {
    const names = await toolNames(["spawn_agents"]);
    for (const tool of SCHEDULE_TOOLS) expect(names).toContain(tool);
  });

  it("a restricted set WITHOUT spawn_agents withholds every schedule tool (#204)", async () => {
    const names = await toolNames(["send_message"]);
    for (const tool of SCHEDULE_TOOLS) expect(names).not.toContain(tool);
  });

  // #206: empty/undefined permissions are fail-open by default, but strict mode
  // (CYBORG7_STRICT_TOOL_PERMISSIONS / ctx.strictPermissions) flips them to deny.
  it("strict mode denies ALL write tools when no permissions are granted (#206)", async () => {
    const names = await toolNames([], true);
    expect(names).not.toContain("cyborg7_send_message");
    expect(names).not.toContain("cyborg7_create_task");
    expect(names).not.toContain("cyborg7_update_task");
    for (const tool of SCHEDULE_TOOLS) expect(names).not.toContain(tool);
    // Read tools stay available even in strict mode.
    expect(names).toContain("cyborg7_list_channels");
    expect(names).toContain("cyborg7_get_workspace_roster");
  });

  it("strict mode still honors an explicit grant", async () => {
    const names = await toolNames(["create_task"], true);
    expect(names).toContain("cyborg7_create_task");
    expect(names).not.toContain("cyborg7_send_message");
  });

  // Channel read/interact tools — Phase 2 (#270): always EXPOSED; channel
  // MEMBERSHIP (not these platform permissions) gates them at execution time.
  const CHANNEL_TOOLS = ["cyborg7_read_channel", "cyborg7_react", "cyborg7_search"];

  it("an unrestricted permission set exposes the channel read/interact tools", async () => {
    const names = await toolNames([]);
    for (const tool of CHANNEL_TOOLS) expect(names).toContain(tool);
  });

  it("the channel tools are always exposed regardless of platform grants (membership gates them)", async () => {
    // A grant unrelated to the channel tools still exposes all three — the old
    // per-tool read_messages/react/search exposure gate is gone.
    for (const grants of [["send_message"], ["create_task"], ["spawn_agents"]]) {
      const names = await toolNames(grants);
      for (const tool of CHANNEL_TOOLS) expect(names).toContain(tool);
    }
  });

  it("strict mode with no grants still exposes the channel tools (they aren't permission-gated)", async () => {
    const names = await toolNames([], true);
    for (const tool of CHANNEL_TOOLS) expect(names).toContain(tool);
  });
});

// #206: cyborg7_schedule_create must not reference a cybo from another workspace.
describe("cyborg7_schedule_create workspace scoping (#206)", () => {
  interface FakeCybo {
    id: string;
    workspace_id: string;
    name: string;
    // The human who owns the cybo — the schedule's authorizing identity.
    created_by?: string;
  }
  interface FakeChannel {
    id: string;
    name: string;
  }

  function depsWith(
    cybos: FakeCybo[],
    channels: FakeChannel[] = [],
    // The HUMAN who invoked the cybo agent (ag_1) — its binding.initiated_by. When
    // set, the schedule should be attributed to THEM (the requester), not the cybo
    // owner. Omitted ⇒ no resolvable invoker (falls back to owner), as before.
    initiatedBy?: string,
  ): { deps: Cyborg7McpDeps; created: Record<string, unknown>[] } {
    const created: Record<string, unknown>[] = [];
    const storage = {
      // Global by-id lookup (the leak the fix guards against).
      getCybo: (id: string) => cybos.find((c) => c.id === id),
      // Workspace-scoped slug lookup.
      getCyboBySlug: (workspaceId: string, slug: string) =>
        cybos.find((c) => c.workspace_id === workspaceId && c.name === slug),
      // Workspace-scoped channel catalog (solo-mode read path — no cyboRead/pg).
      getChannels: () => channels,
      // The invoking agent's binding — its initiated_by is the requesting human.
      getAgentBinding: (agentId: string) =>
        agentId === "ag_1" && initiatedBy ? { initiated_by: initiatedBy } : undefined,
      createSchedule: (s: Record<string, unknown>) => {
        created.push(s);
        return { id: "sch_1", ...s };
      },
    };
    return { deps: { storage } as unknown as Cyborg7McpDeps, created };
  }

  async function callScheduleCreate(
    testDeps: Cyborg7McpDeps,
    args: Record<string, unknown>,
  ): Promise<string> {
    const server = createCyborg7McpServer(testDeps, {
      workspaceId: "ws_A",
      agentId: "ag_1",
      platformPermissions: ["spawn_agents"],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name: "cyborg7_schedule_create", arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  it("refuses a cybo id belonging to another workspace (no schedule created)", async () => {
    const { deps: testDeps, created } = depsWith([
      { id: "cybo_foreign", workspace_id: "ws_B", name: "Foreign" },
    ]);
    const text = await callScheduleCreate(testDeps, {
      cybo: "cybo_foreign",
      cron: "0 9 * * *",
      prompt: "summarize",
    });
    expect(text).toContain("No cybo found");
    expect(created).toHaveLength(0);
  });

  it("creates a schedule for a cybo in the caller's workspace", async () => {
    const { deps: testDeps, created } = depsWith([
      { id: "cybo_local", workspace_id: "ws_A", name: "Local" },
    ]);
    const text = await callScheduleCreate(testDeps, {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
    });
    expect(text).toContain("Schedule created");
    expect(created).toHaveLength(1);
  });

  // Gemini review: a FOREIGN cybo id must not shadow a LOCAL cybo whose slug
  // equals that id — the global by-id hit is ignored, the slug lookup wins.
  it("a foreign id matching a local slug resolves to the local cybo", async () => {
    const { deps: testDeps, created } = depsWith([
      { id: "shared", workspace_id: "ws_B", name: "Foreign" }, // global id == the arg
      { id: "cybo_local", workspace_id: "ws_A", name: "shared" }, // local slug == the arg
    ]);
    const text = await callScheduleCreate(testDeps, {
      cybo: "shared",
      cron: "0 9 * * *",
      prompt: "summarize",
    });
    expect(text).toContain("Schedule created");
    expect(created).toHaveLength(1);
    expect((created[0] as { cyboId: string }).cyboId).toBe("cybo_local");
  });

  // BUG 1: the schedule runs under its created_by identity, which the runner
  // requires to be a live workspace MEMBER (isCreatorStillAuthorized). The
  // ephemeral agent UUID is NOT a member, so attributing the schedule to it gets
  // it disabled before it ever fires. Attribute it to the cybo's OWNER instead —
  // an authorized human — so isCreatorStillAuthorized passes.
  it("attributes createdBy to the cybo's owner, not the ephemeral agent UUID", async () => {
    const { deps: testDeps, created } = depsWith([
      { id: "cybo_local", workspace_id: "ws_A", name: "Local", created_by: "user_owner" },
    ]);
    const text = await callScheduleCreate(testDeps, {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
    });
    expect(text).toContain("Schedule created");
    expect(created).toHaveLength(1);
    // NOT the agent UUID ("ag_1") the transport ctx carries.
    expect(created[0].createdBy).toBe("user_owner");
  });

  // A SHARED cybo (owned by user_owner) that ANOTHER member (user_requester) asks to
  // schedule must be attributed to the REQUESTER — else the fired run surfaces in the
  // owner's sessions as if they scheduled it ("a Rick session I never created").
  it("attributes createdBy to the invoking human, not the cybo owner, for a shared cybo", async () => {
    const { deps: testDeps, created } = depsWith(
      [{ id: "cybo_local", workspace_id: "ws_A", name: "Local", created_by: "user_owner" }],
      [],
      "user_requester", // the human who invoked the cybo (binding.initiated_by)
    );
    await callScheduleCreate(testDeps, {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
    });
    expect(created[0].createdBy).toBe("user_requester");
  });

  it("falls back to the agent id when the cybo has no owner", async () => {
    const { deps: testDeps, created } = depsWith([
      { id: "cybo_local", workspace_id: "ws_A", name: "Local" }, // no created_by
    ]);
    await callScheduleCreate(testDeps, {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
    });
    expect(created[0].createdBy).toBe("ag_1");
  });

  // BUG 2: a cybo passes the channel NAME ("tasks-test") where the canonical id
  // ("ch_tasks_test") is expected. schedules.channel_id has a PG FK, so the name
  // crashes the mirror insert. Resolve name -> id before persisting.
  it("normalizes a channel NAME to its canonical id", async () => {
    const { deps: testDeps, created } = depsWith(
      [{ id: "cybo_local", workspace_id: "ws_A", name: "Local", created_by: "user_owner" }],
      [{ id: "ch_tasks_test", name: "tasks-test" }],
    );
    await callScheduleCreate(testDeps, {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
      channelId: "tasks-test", // the NAME, not the id
    });
    expect(created[0].channelId).toBe("ch_tasks_test");
  });

  it("passes a valid channel id through unchanged", async () => {
    const { deps: testDeps, created } = depsWith(
      [{ id: "cybo_local", workspace_id: "ws_A", name: "Local", created_by: "user_owner" }],
      [{ id: "ch_tasks_test", name: "tasks-test" }],
    );
    await callScheduleCreate(testDeps, {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
      channelId: "ch_tasks_test",
    });
    expect(created[0].channelId).toBe("ch_tasks_test");
  });

  it("stores null for a channel that resolves to nothing (no FK-breaking value)", async () => {
    const { deps: testDeps, created } = depsWith(
      [{ id: "cybo_local", workspace_id: "ws_A", name: "Local", created_by: "user_owner" }],
      [{ id: "ch_tasks_test", name: "tasks-test" }],
    );
    await callScheduleCreate(testDeps, {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
      channelId: "does-not-exist",
    });
    expect(created[0].channelId).toBeNull();
  });
});

// BUG 2 (tasks): cyborg7_create_task must store the canonical channel id, not the
// channel NAME. tasks.channel_id has no FK so a name slips in silently and breaks
// every channel-scoped task filter. Exercise the LOCAL write path (no cyboWrite /
// no ctx.cyboId → storage.createTask), where the value lands directly in storage.
describe("cyborg7_create_task channel normalization", () => {
  interface FakeChannel {
    id: string;
    name: string;
  }

  function depsWith(channels: FakeChannel[]): {
    deps: Cyborg7McpDeps;
    created: Record<string, unknown>[];
  } {
    const created: Record<string, unknown>[] = [];
    const storage = {
      getChannels: () => channels,
      createTask: (t: Record<string, unknown>) => {
        created.push(t);
        return { id: "task_1", title: t.title };
      },
    };
    return { deps: { storage } as unknown as Cyborg7McpDeps, created };
  }

  async function callCreateTask(
    testDeps: Cyborg7McpDeps,
    args: Record<string, unknown>,
  ): Promise<string> {
    // No ctx.cyboId → the relay write path is skipped, so the local
    // storage.createTask write runs and we can inspect the persisted channelId.
    const server = createCyborg7McpServer(testDeps, {
      workspaceId: "ws_A",
      agentId: "ag_1",
      platformPermissions: ["create_task"],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name: "cyborg7_create_task", arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  it("normalizes a channel NAME to its canonical id", async () => {
    const { deps: testDeps, created } = depsWith([{ id: "ch_tasks_test", name: "tasks-test" }]);
    const text = await callCreateTask(testDeps, { title: "do it", channelId: "tasks-test" });
    expect(text).toContain("Task created");
    expect(created[0].channelId).toBe("ch_tasks_test");
  });

  it("passes a valid channel id through unchanged", async () => {
    const { deps: testDeps, created } = depsWith([{ id: "ch_tasks_test", name: "tasks-test" }]);
    await callCreateTask(testDeps, { title: "do it", channelId: "ch_tasks_test" });
    expect(created[0].channelId).toBe("ch_tasks_test");
  });

  it("stores null for a channel that resolves to nothing", async () => {
    const { deps: testDeps, created } = depsWith([{ id: "ch_tasks_test", name: "tasks-test" }]);
    await callCreateTask(testDeps, { title: "do it", channelId: "nope" });
    expect(created[0].channelId).toBeNull();
  });

  it("stores null when no channel is given", async () => {
    const { deps: testDeps, created } = depsWith([{ id: "ch_tasks_test", name: "tasks-test" }]);
    await callCreateTask(testDeps, { title: "do it" });
    expect(created[0].channelId).toBeNull();
  });
});

describe("cyborg7 channel tools behavior", () => {
  function makeDeps() {
    const reactions: Array<{ agentId: string; messageId: string; emoji: string }> = [];
    const storage = {
      getChannels: () => [{ id: "ch_1", name: "general" }],
      // newest-first, like the real store
      getMessages: ({ channelId }: { channelId: string; limit?: number }) =>
        channelId === "ch_1"
          ? [
              { id: "m2", from_name: "Bob", from_id: "u2", text: "second", channel_id: "ch_1" },
              { id: "m1", from_name: "Alice", from_id: "u1", text: "first", channel_id: "ch_1" },
            ]
          : [],
      getMessageById: (id: string) =>
        ({
          m9: { id: "m9", workspace_id: "ws_1", channel_id: "ch_1", text: "hi" },
          m_foreign: { id: "m_foreign", workspace_id: "ws_other", channel_id: "ch_z", text: "hi" },
        })[id],
      searchMessages: (_ws: string, query: string, _limit?: number, channelId?: string) => {
        if (query !== "hello") return [];
        const rows = [
          { id: "m9", from_name: "Carol", from_id: "u3", text: "hello world", channel_id: "ch_1" },
          { id: "mx", from_name: "Dan", from_id: "u4", text: "hello there", channel_id: "ch_2" },
        ];
        // Mirror the SQL: filter by channel in the query, not in-memory after.
        return channelId ? rows.filter((r) => r.channel_id === channelId) : rows;
      },
    };
    const messageRouter = {
      handleAgentReaction: (agentId: string, _ws: string, messageId: string, emoji: string) =>
        reactions.push({ agentId, messageId, emoji }),
    };
    return { deps: { storage, messageRouter } as unknown as Cyborg7McpDeps, reactions };
  }

  async function call(
    testDeps: Cyborg7McpDeps,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const server = createCyborg7McpServer(testDeps, {
      workspaceId: "ws_1",
      agentId: "ag_1",
      platformPermissions: ["read_messages", "react", "search"],
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  it("read_channel returns a chronological transcript with message IDs", async () => {
    const { deps: testDeps } = makeDeps();
    const text = await call(testDeps, "cyborg7_read_channel", { channel: "general" });
    expect(text).toBe("[m1] Alice: first\n[m2] Bob: second");
  });

  it("read_channel errors on an unknown channel", async () => {
    const { deps: testDeps } = makeDeps();
    const text = await call(testDeps, "cyborg7_read_channel", { channel: "nope" });
    expect(text).toContain("not found");
  });

  it("react routes to handleAgentReaction with the cybo's agentId", async () => {
    const { deps: testDeps, reactions } = makeDeps();
    const text = await call(testDeps, "cyborg7_react", { messageId: "m9", emoji: "👍" });
    expect(text).toContain("Reacted");
    expect(reactions).toEqual([{ agentId: "ag_1", messageId: "m9", emoji: "👍" }]);
  });

  it("react refuses a message from another workspace (no broadcast)", async () => {
    const { deps: testDeps, reactions } = makeDeps();
    const text = await call(testDeps, "cyborg7_react", { messageId: "m_foreign", emoji: "👍" });
    expect(text).toContain("not found in this workspace");
    expect(reactions).toHaveLength(0);
  });

  it("react refuses an unknown message id (no broadcast)", async () => {
    const { deps: testDeps, reactions } = makeDeps();
    const text = await call(testDeps, "cyborg7_react", { messageId: "nope", emoji: "👍" });
    expect(text).toContain("not found");
    expect(reactions).toHaveLength(0);
  });

  it("search returns matches, scoped to a channel when given", async () => {
    const { deps: testDeps } = makeDeps();
    const all = await call(testDeps, "cyborg7_search", { query: "hello" });
    expect(all).toContain("[m9]");
    expect(all).toContain("[mx]");
    const scoped = await call(testDeps, "cyborg7_search", { query: "hello", channel: "general" });
    expect(scoped).toContain("[m9]");
    expect(scoped).not.toContain("[mx]"); // mx is in ch_2
  });
});

// Phase 2 (#270): when the agent IS a cybo (ctx.cyboId set), the channel tools are
// gated by CHANNEL MEMBERSHIP at execution — a cybo may read/react/search/send only
// in channels it has joined (channel_members.member_type='cybo'), looked up in PG.
describe("cyborg7 channel tools — membership gating for cybos", () => {
  function makeDeps(memberChannelIds: string[]) {
    const sent: Array<{ channelId: string | null; text: string }> = [];
    const reactions: Array<{ messageId: string; emoji: string }> = [];
    const membershipChecks: Array<{ channelId: string; cyboId: string }> = [];
    const storage = {
      getChannels: () => [
        { id: "ch_member", name: "joined" },
        { id: "ch_other", name: "stranger" },
      ],
      getMessages: ({ channelId }: { channelId: string; limit?: number }) =>
        channelId === "ch_member"
          ? [{ id: "m1", from_name: "Alice", from_id: "u1", text: "hi", channel_id: "ch_member" }]
          : [],
      getMessageById: (id: string) =>
        ({
          m_member: { id: "m_member", workspace_id: "ws_1", channel_id: "ch_member", text: "hi" },
          m_other: { id: "m_other", workspace_id: "ws_1", channel_id: "ch_other", text: "hi" },
        })[id],
      searchMessages: (_ws: string, _q: string, _l?: number, channelId?: string) =>
        channelId === "ch_member"
          ? [{ id: "m1", from_name: "Alice", from_id: "u1", text: "hit", channel_id: "ch_member" }]
          : [],
      // DualStorage.pg getter — present here (connected mode). In connected mode the
      // cybo's channel + message reads come from PG (the daemon's SQLite never holds
      // a cloud workspace's data), so the fixtures live here, mirroring SQLite.
      pg: {
        isCyboChannelMember: async (channelId: string, cyboId: string) => {
          membershipChecks.push({ channelId, cyboId });
          return memberChannelIds.includes(channelId);
        },
        getChannels: async () => [
          { id: "ch_member", name: "joined" },
          { id: "ch_other", name: "stranger" },
        ],
        getMessages: async ({ channelId }: { channelId: string; limit?: number }) =>
          channelId === "ch_member"
            ? [{ id: "m1", from_name: "Alice", from_id: "u1", text: "hi", channel_id: "ch_member" }]
            : [],
      },
    };
    const messageRouter = {
      handleAgentMessage: (
        _agentId: string,
        _ws: string,
        channelId: string | null,
        _to: string | null,
        text: string,
      ) => sent.push({ channelId, text }),
      handleAgentReaction: (_agentId: string, _ws: string, messageId: string, emoji: string) =>
        reactions.push({ messageId, emoji }),
    };
    return {
      deps: { storage, messageRouter } as unknown as Cyborg7McpDeps,
      sent,
      reactions,
      membershipChecks,
    };
  }

  async function callAsCybo(
    testDeps: Cyborg7McpDeps,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const server = createCyborg7McpServer(testDeps, {
      workspaceId: "ws_1",
      agentId: "ag_1",
      cyboId: "cybo_1",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  it("read_channel allows a member channel and denies a non-member channel", async () => {
    const { deps: testDeps } = makeDeps(["ch_member"]);
    expect(await callAsCybo(testDeps, "cyborg7_read_channel", { channel: "joined" })).toContain(
      "[m1] Alice: hi",
    );
    expect(await callAsCybo(testDeps, "cyborg7_read_channel", { channel: "stranger" })).toContain(
      "not a member",
    );
  });

  it("send_message posts to a member channel and refuses a non-member channel", async () => {
    const { deps: testDeps, sent } = makeDeps(["ch_member"]);
    expect(
      await callAsCybo(testDeps, "cyborg7_send_message", { channel: "joined", text: "yo" }),
    ).toBe("Message sent");
    expect(
      await callAsCybo(testDeps, "cyborg7_send_message", { channel: "stranger", text: "yo" }),
    ).toContain("not a member");
    expect(sent).toEqual([{ channelId: "ch_member", text: "yo" }]);
  });

  it("react allows a message in a member channel and refuses one in a non-member channel", async () => {
    const { deps: testDeps, reactions } = makeDeps(["ch_member"]);
    expect(
      await callAsCybo(testDeps, "cyborg7_react", { messageId: "m_member", emoji: "👍" }),
    ).toContain("Reacted");
    expect(
      await callAsCybo(testDeps, "cyborg7_react", { messageId: "m_other", emoji: "👍" }),
    ).toContain("not a member");
    expect(reactions).toEqual([{ messageId: "m_member", emoji: "👍" }]);
  });

  it("search requires a member channel scope (no workspace-wide search for cybos)", async () => {
    const { deps: testDeps } = makeDeps(["ch_member"]);
    expect(await callAsCybo(testDeps, "cyborg7_search", { query: "hi" })).toContain(
      "specify a 'channel'",
    );
    expect(
      await callAsCybo(testDeps, "cyborg7_search", { query: "hi", channel: "joined" }),
    ).toContain("[m1]");
    expect(
      await callAsCybo(testDeps, "cyborg7_search", { query: "hi", channel: "stranger" }),
    ).toContain("not a member");
  });

  it("denies the channel tools when membership can't be verified (no PG)", async () => {
    const { deps: testDeps } = makeDeps(["ch_member"]);
    // Drop the pg handle to simulate a solo daemon (no shared membership store).
    (testDeps.storage as unknown as { pg: unknown }).pg = null;
    expect(await callAsCybo(testDeps, "cyborg7_read_channel", { channel: "joined" })).toContain(
      "membership is unavailable",
    );
  });
});

describe("cyborg7 tools — relay-backed reads (cloud daemon, no PG handle)", () => {
  function makeRelayDeps() {
    const sent: Array<{ channelId: string | null; text: string }> = [];
    const reads: Array<Record<string, unknown>> = [];
    const storage = {
      // Cloud daemon: local SQLite has NO channels for this workspace, and no PG.
      getChannels: () => [],
      getMessages: () => [],
      pg: null,
    };
    const messageRouter = {
      handleAgentMessage: (
        _a: string,
        _w: string,
        channelId: string | null,
        _t: string | null,
        text: string,
      ) => sent.push({ channelId, text }),
    };
    const cyboRead = async (req: Record<string, unknown>) => {
      reads.push(req);
      if (req.kind === "channels") {
        return {
          ok: true,
          channels: [
            { id: "ch_member", name: "joined", isMember: true },
            { id: "ch_other", name: "stranger", isMember: false },
          ],
        };
      }
      if (req.channelId === "ch_member") {
        return {
          ok: true,
          messages: [{ id: "m1", from_id: "u1", from_name: "Alice", text: "hi from pg" }],
        };
      }
      return { ok: false, error: "not a member of this channel" };
    };
    return {
      deps: { storage, messageRouter, cyboRead } as unknown as Cyborg7McpDeps,
      sent,
      reads,
    };
  }

  it("list_channels reads from the relay and shows membership", async () => {
    const { deps, reads } = makeRelayDeps();
    const text = await callToolAsCybo(deps, "cyborg7_list_channels", {});
    expect(text).toContain("#joined (member)");
    expect(text).toContain("#stranger");
    expect(reads[0]).toMatchObject({ kind: "channels", cyboId: "cybo_1" });
  });

  it("read_channel returns relay-sourced history for a member channel", async () => {
    const { deps } = makeRelayDeps();
    const text = await callToolAsCybo(deps, "cyborg7_read_channel", { channel: "joined" });
    expect(text).toContain("hi from pg");
  });

  it("send_message honors the relay membership flag (refuses non-member channel)", async () => {
    const { deps, sent } = makeRelayDeps();
    const refused = await callToolAsCybo(deps, "cyborg7_send_message", {
      channel: "stranger",
      text: "nope",
    });
    expect(refused).toContain("not a member");
    expect(sent).toHaveLength(0);
    const okText = await callToolAsCybo(deps, "cyborg7_send_message", {
      channel: "joined",
      text: "hola",
    });
    expect(okText).toContain("Message sent");
    expect(sent).toEqual([{ channelId: "ch_member", text: "hola" }]);
  });

  it("surfaces a relay read error instead of a silent empty list", async () => {
    const deps = {
      storage: { getChannels: () => [], getMessages: () => [], pg: null },
      messageRouter: {},
      cyboRead: async () => ({ ok: false, error: "relay PG down" }),
    } as unknown as Cyborg7McpDeps;
    const text = await callToolAsCybo(deps, "cyborg7_list_channels", {});
    expect(text).toContain("relay PG down");
  });
});

async function callToolAsCybo(
  testDeps: Cyborg7McpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = createCyborg7McpServer(testDeps, {
    workspaceId: "ws_1",
    agentId: "ag_1",
    cyboId: "cybo_1",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return res.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
    await server.close();
  }
}

// react + search reconciliation (audit follow-ups; same relay-aware pattern
// as the #421 reads above): the message row IS synced locally, but the channel
// catalog + membership live in the relay's PG on cloud daemons.
describe("cyborg7_react + cyborg7_search — relay-aware (cloud daemon, no PG handle)", () => {
  function makeDeps() {
    const reads: Array<Record<string, unknown>> = [];
    const reactions: Array<{ messageId: string; emoji: string }> = [];
    const localSearches: Array<unknown[]> = [];
    const storage = {
      getChannels: () => [], // cloud: local catalog is EMPTY (the old react bug)
      getMessages: () => [],
      getMessageById: (id: string) => {
        if (id === "m_in_member")
          return { id, workspace_id: "ws_1", channel_id: "ch_member", text: "hello" };
        if (id === "m_in_other")
          return { id, workspace_id: "ws_1", channel_id: "ch_other", text: "psst" };
        return undefined;
      },
      searchMessages: (...args: unknown[]) => {
        localSearches.push(args);
        return [{ id: "loc1", from_id: "u9", from_name: null, text: "local hit" }];
      },
      pg: null,
    };
    const messageRouter = {
      handleAgentReaction: (_a: string, _w: string, messageId: string, emoji: string) =>
        reactions.push({ messageId, emoji }),
    };
    let relayUp = true;
    const cyboRead = async (req: Record<string, unknown>) => {
      if (!relayUp) return null;
      reads.push(req);
      if (req.kind === "channels") {
        return {
          ok: true,
          channels: [
            { id: "ch_member", name: "joined", isMember: true },
            { id: "ch_other", name: "stranger", isMember: false },
          ],
        };
      }
      if (req.kind === "search") {
        if (req.channelId !== "ch_member")
          return { ok: false, error: "not a member of this channel" };
        return {
          ok: true,
          messages: [
            { id: "pg1", from_id: "u1", from_name: "Alice", text: "hit from shared store" },
          ],
        };
      }
      return { ok: false, error: "unexpected kind" };
    };
    return {
      mcpDeps: { storage, messageRouter, cyboRead } as unknown as Cyborg7McpDeps,
      reads,
      reactions,
      localSearches,
      setRelayUp: (v: boolean) => {
        relayUp = v;
      },
    };
  }

  it("react resolves the channel via the RELAY (empty local catalog) and reacts in a member channel", async () => {
    const { mcpDeps, reads, reactions } = makeDeps();
    const text = await callToolAsCybo(mcpDeps, "cyborg7_react", {
      messageId: "m_in_member",
      emoji: "👍",
    });
    expect(text).toContain("Reacted");
    expect(reactions).toEqual([{ messageId: "m_in_member", emoji: "👍" }]);
    // The channel lookup went through the relay read, not storage.getChannels.
    expect(reads.some((r) => r.kind === "channels")).toBe(true);
  });

  it("react refuses a message in a channel the cybo is NOT a member of", async () => {
    const { mcpDeps, reactions } = makeDeps();
    const text = await callToolAsCybo(mcpDeps, "cyborg7_react", {
      messageId: "m_in_other",
      emoji: "🔥",
    });
    expect(text).toContain("not a member");
    expect(reactions).toHaveLength(0);
  });

  it("search (channel-scoped) goes to the SHARED store via cybo_read kind:'search'", async () => {
    const { mcpDeps, reads, localSearches } = makeDeps();
    const text = await callToolAsCybo(mcpDeps, "cyborg7_search", {
      query: "hit",
      channel: "joined",
    });
    expect(text).toContain("hit from shared store");
    const search = reads.find((r) => r.kind === "search");
    expect(search).toMatchObject({
      kind: "search",
      channelId: "ch_member",
      query: "hit",
      cyboId: "cybo_1",
    });
    expect(localSearches).toHaveLength(0); // never touched the local index
  });

  it("relay down + empty local catalog → honest channel-not-found (no silent local scan)", async () => {
    const { mcpDeps, localSearches, setRelayUp } = makeDeps();
    setRelayUp(false);
    // Relay unreachable → readChannels falls through to the (empty) local
    // catalog → the channel can't be resolved. The honest answer is
    // "not found" — NOT a silent scan of the local index (the local-search
    // fallback only applies where the channel resolves locally, i.e. solo).
    const text = await callToolAsCybo(mcpDeps, "cyborg7_search", { query: "x", channel: "joined" });
    expect(text).toContain("not found");
    expect(localSearches).toHaveLength(0);
  });
});

// ─── Relay-backed TASK tools (cloud daemon, no PG handle) — #421 extension ───
//
// The task tools used to hit the daemon's local SQLite only: tasks a cybo
// created never reached the shared PG (invisible to the UI) and the cybo never
// saw the UI's tasks (two truths). Reads go through cybo_read kind:"tasks";
// writes through the new cybo_write round-trip. null (old relay without the
// handler / disconnected) falls back to the local write — today's behavior.
describe("cyborg7 task tools — relay-backed (cloud daemon)", () => {
  function makeTaskRelayDeps() {
    const localCreated: Record<string, unknown>[] = [];
    const reads: Array<Record<string, unknown>> = [];
    const writes: Array<Record<string, unknown>> = [];
    const storage = {
      getChannels: () => [],
      getMessages: () => [],
      getTasks: () => [],
      createTask: (opts: Record<string, unknown>) => {
        localCreated.push(opts);
        return { id: "local_1", title: opts.title, status: "pending" };
      },
      updateTask: () => null,
      pg: null,
    };
    const cyboRead = async (req: Record<string, unknown>) => {
      reads.push(req);
      if (req.kind === "tasks") {
        return {
          ok: true,
          tasks: [
            { id: "t1", title: "Ship the relay", status: "pending", assignee_id: null },
            { id: "t2", title: "Cut the DMG", status: "done", assignee_id: "u9" },
          ],
        };
      }
      // create_task now normalizes its channelId against the workspace channel
      // catalog (BUG 2): a valid id must resolve to itself, a name to its id.
      if (req.kind === "channels") {
        return {
          ok: true,
          channels: [{ id: "ch_watch", name: "watch", isMember: true }],
        };
      }
      return { ok: false, error: "unexpected read" };
    };
    const cyboWrite = async (req: Record<string, unknown>) => {
      writes.push(req);
      if (req.kind === "create_task") {
        return { ok: true, task: { id: "task_pg1", title: req.title, status: "pending" } };
      }
      if (req.taskId === "t1") {
        return { ok: true, task: { id: "t1", title: "Ship the relay", status: req.status } };
      }
      return { ok: false, error: "task not found in this workspace" };
    };
    return {
      deps: { storage, messageRouter: {}, cyboRead, cyboWrite } as unknown as Cyborg7McpDeps,
      localCreated,
      reads,
      writes,
    };
  }

  it("list_tasks reads the SHARED tasks via the relay (same rows the UI sees)", async () => {
    const { deps, reads } = makeTaskRelayDeps();
    const text = await callToolAsCybo(deps, "cyborg7_list_tasks", {});
    expect(text).toContain("[pending] t1: Ship the relay");
    expect(text).toContain("[done] t2: Cut the DMG (-> u9)");
    expect(reads[0]).toMatchObject({ kind: "tasks", cyboId: "cybo_1", workspaceId: "ws_1" });
  });

  it("create_task writes through the relay into PG — never the local SQLite", async () => {
    const { deps, writes, localCreated } = makeTaskRelayDeps();
    const text = await callToolAsCybo(deps, "cyborg7_create_task", { title: "Do it" });
    expect(text).toContain("Task created: task_pg1 — Do it");
    expect(writes[0]).toMatchObject({
      kind: "create_task",
      cyboId: "cybo_1",
      agentId: "ag_1",
      title: "Do it",
    });
    expect(localCreated).toHaveLength(0); // the two-truths bug: local write skipped
  });

  it("update_task goes through the relay and surfaces its validated errors", async () => {
    const { deps, writes } = makeTaskRelayDeps();
    const ok = await callToolAsCybo(deps, "cyborg7_update_task", { taskId: "t1", status: "done" });
    expect(ok).toContain("Task updated: [done] Ship the relay");
    const missing = await callToolAsCybo(deps, "cyborg7_update_task", {
      taskId: "nope",
      status: "done",
    });
    expect(missing).toContain("task not found in this workspace");
    expect(writes).toHaveLength(2);
  });

  it("a relay-validated create failure is surfaced (permission denied), not silently local", async () => {
    const { deps, localCreated } = makeTaskRelayDeps();
    (deps as unknown as { cyboWrite: unknown }).cyboWrite = async () => ({
      ok: false,
      error: "this cybo doesn't have the create_task permission",
    });
    const text = await callToolAsCybo(deps, "cyborg7_create_task", { title: "Nope" });
    expect(text).toContain("doesn't have the create_task permission");
    expect(localCreated).toHaveLength(0);
  });

  it("BACKWARD COMPAT: an old relay (null = no handler/timeout) falls back to the local write", async () => {
    const { deps, localCreated } = makeTaskRelayDeps();
    (deps as unknown as { cyboWrite: unknown }).cyboWrite = async () => null;
    const text = await callToolAsCybo(deps, "cyborg7_create_task", { title: "Legacy path" });
    expect(text).toContain("Task created: local_1 — Legacy path");
    expect(localCreated).toHaveLength(1);
  });

  it("BACKWARD COMPAT: list_tasks falls back to local stores when the relay never answers", async () => {
    const { deps } = makeTaskRelayDeps();
    (deps as unknown as { cyboRead: unknown }).cyboRead = async () => null;
    (deps as unknown as { storage: { getTasks: () => unknown[] } }).storage.getTasks = () => [
      { id: "sl1", title: "Local-only", status: "pending", assignee_id: null },
    ];
    const text = await callToolAsCybo(deps, "cyborg7_list_tasks", {});
    expect(text).toContain("[pending] sl1: Local-only");
  });

  // Tasks Phase 2 (watcher): the watcher scopes a created task to the channel it
  // is watching (channelId) and may set a board priority; both flow through the
  // relay write. update_task can (re)assign a task to a human or a cybo.
  it("create_task forwards channelId + priority through the relay write", async () => {
    const { deps: taskDeps, writes } = makeTaskRelayDeps();
    const text = await callToolAsCybo(taskDeps, "cyborg7_create_task", {
      title: "Watch this",
      channelId: "ch_watch",
      priority: "high",
    });
    expect(text).toContain("Task created: task_pg1 — Watch this");
    expect(writes[0]).toMatchObject({
      kind: "create_task",
      cyboId: "cybo_1",
      title: "Watch this",
      channelId: "ch_watch",
      priority: "high",
    });
  });

  it("create_task forwards channelId + priority on the LOCAL fallback write", async () => {
    const { deps: taskDeps, localCreated } = makeTaskRelayDeps();
    (taskDeps as unknown as { cyboWrite: unknown }).cyboWrite = async () => null;
    const text = await callToolAsCybo(taskDeps, "cyborg7_create_task", {
      title: "Local watch",
      channelId: "ch_watch",
      priority: "low",
    });
    expect(text).toContain("Task created: local_1 — Local watch");
    expect(localCreated[0]).toMatchObject({
      title: "Local watch",
      channelId: "ch_watch",
      priority: "low",
    });
  });

  it("update_task forwards an assignee through the relay write", async () => {
    const { deps: taskDeps, writes } = makeTaskRelayDeps();
    const text = await callToolAsCybo(taskDeps, "cyborg7_update_task", {
      taskId: "t1",
      status: "in_progress",
      assignee: "u42",
    });
    expect(text).toContain("Task updated");
    expect(writes[0]).toMatchObject({
      kind: "update_task",
      taskId: "t1",
      status: "in_progress",
      assigneeId: "u42",
    });
  });

  it("update_task forwards status + assignee on the LOCAL fallback write", async () => {
    const updates: Array<Record<string, unknown>> = [];
    const { deps: taskDeps } = makeTaskRelayDeps();
    (taskDeps as unknown as { cyboWrite: unknown }).cyboWrite = async () => null;
    (taskDeps as unknown as { storage: { updateTask: unknown } }).storage.updateTask = (
      taskId: string,
      u: Record<string, unknown>,
    ) => {
      updates.push({ taskId, ...u });
      return { id: taskId, title: "Ship the relay", status: u.status };
    };
    const text = await callToolAsCybo(taskDeps, "cyborg7_update_task", {
      taskId: "t1",
      status: "pending_review",
      assignee: "cybo_9",
    });
    expect(text).toContain("Task updated: [pending_review] Ship the relay");
    expect(updates[0]).toMatchObject({
      taskId: "t1",
      status: "pending_review",
      assigneeId: "cybo_9",
    });
  });
});

// A NON-cybo agent (plain Claude/Codex session) gets the cyborg7 tools too, and
// its task/schedule writes are owned by its SPAWNING USER (ctx.initiatedByUserId),
// never the ephemeral agent UUID — so a schedule's created_by is a real workspace
// member and ScheduleRunner.isCreatorStillAuthorized passes. cyboId is absent.
describe("cyborg7 non-cybo agent — spawning-user ownership", () => {
  const NON_CYBO_CTX = {
    workspaceId: "ws_A",
    agentId: "ag_1",
    initiatedByUserId: "user_spawn",
  } as const;

  async function listToolsNonCybo(): Promise<string[]> {
    const server = createCyborg7McpServer({} as unknown as Cyborg7McpDeps, NON_CYBO_CTX);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      return tools.map((t) => t.name);
    } finally {
      await client.close();
    }
  }

  async function callNonCybo(
    testDeps: Cyborg7McpDeps,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const server = createCyborg7McpServer(testDeps, NON_CYBO_CTX);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  it("exposes the task + schedule tools to a non-cybo agent (no grants = unrestricted)", async () => {
    const names = await listToolsNonCybo();
    expect(names).toContain("cyborg7_create_task");
    expect(names).toContain("cyborg7_update_task");
    expect(names).toContain("cyborg7_list_tasks");
    expect(names).toContain("cyborg7_schedule_create");
    expect(names).toContain("cyborg7_schedule_list");
    expect(names).toContain("cyborg7_schedule_delete");
  });

  it("create_task (local path) attributes createdBy to the spawning user, not the agent UUID", async () => {
    const created: Record<string, unknown>[] = [];
    const testDeps = {
      storage: {
        getChannels: () => [],
        createTask: (t: Record<string, unknown>) => {
          created.push(t);
          return { id: "task_1", title: t.title };
        },
      },
    } as unknown as Cyborg7McpDeps;
    const text = await callNonCybo(testDeps, "cyborg7_create_task", { title: "ship it" });
    expect(text).toContain("Task created");
    expect(created[0].createdBy).toBe("user_spawn"); // NOT "ag_1"
  });

  it("create_task (cloud relay path) fires for a non-cybo agent and threads createdBy=user", async () => {
    const writes: Record<string, unknown>[] = [];
    const localCreated: Record<string, unknown>[] = [];
    const testDeps = {
      storage: {
        getChannels: () => [],
        createTask: (t: Record<string, unknown>) => {
          localCreated.push(t);
          return { id: "local_1", title: t.title };
        },
      },
      cyboWrite: async (req: Record<string, unknown>) => {
        writes.push(req);
        return { ok: true, task: { id: "task_pg1", title: req.title, status: "pending" } };
      },
    } as unknown as Cyborg7McpDeps;
    const text = await callNonCybo(testDeps, "cyborg7_create_task", { title: "cloud task" });
    expect(text).toContain("Task created: task_pg1 — cloud task");
    expect(writes[0]).toMatchObject({
      kind: "create_task",
      createdBy: "user_spawn",
      title: "cloud task",
    });
    // cyboId is absent for a non-cybo agent — the relay validates the user instead.
    expect(writes[0].cyboId).toBeUndefined();
    expect(localCreated).toHaveLength(0); // relay path took it, not the local write
  });

  it("update_task (cloud relay path) fires for a non-cybo agent and threads createdBy=user", async () => {
    const writes: Record<string, unknown>[] = [];
    const localUpdates: Record<string, unknown>[] = [];
    const testDeps = {
      storage: {
        getChannels: () => [],
        updateTask: (taskId: string, u: Record<string, unknown>) => {
          localUpdates.push({ taskId, ...u });
          return { id: taskId, title: "Local", status: u.status };
        },
      },
      cyboWrite: async (req: Record<string, unknown>) => {
        writes.push(req);
        return { ok: true, task: { id: req.taskId, title: "Cloud task", status: req.status } };
      },
    } as unknown as Cyborg7McpDeps;
    const text = await callNonCybo(testDeps, "cyborg7_update_task", {
      taskId: "task_pg1",
      status: "done",
    });
    expect(text).toContain("Task updated: [done] Cloud task");
    expect(writes[0]).toMatchObject({
      kind: "update_task",
      taskId: "task_pg1",
      status: "done",
      createdBy: "user_spawn",
    });
    // cyboId is absent for a non-cybo agent — the relay validates the user instead.
    expect(writes[0].cyboId).toBeUndefined();
    expect(localUpdates).toHaveLength(0); // relay path took it, not the local update
  });

  it("bulk_update (cloud) fans the writes out in bounded chunks and reports every id applied", async () => {
    const writes: Record<string, unknown>[] = [];
    const testDeps = {
      storage: { getChannels: () => [] },
      cyboWrite: async (req: Record<string, unknown>) => {
        writes.push(req);
        return { ok: true, task: { id: req.taskId, title: "x", status: req.status } };
      },
    } as unknown as Cyborg7McpDeps;
    // 7 ids spans two chunks (5 + 2) — proves the chunked Promise.all still applies
    // every id and accounts the count correctly.
    const ids = Array.from({ length: 7 }, (_, i) => `task_${i}`);
    const text = await callNonCybo(testDeps, "cyborg7_bulk_update_tasks", {
      taskIds: ids,
      status: "done",
    });
    expect(text).toContain("7/7");
    expect(writes).toHaveLength(7);
    expect(writes.every((w) => w.kind === "update_task")).toBe(true);
  });

  it("bulk_update (cloud) abandons the cloud path and falls back to local when the relay drops mid-op", async () => {
    let calls = 0;
    const localBulk: { ids: string[] }[] = [];
    const testDeps = {
      storage: {
        getChannels: () => [],
        getTaskById: (id: string) => ({ id, workspace_id: "ws_A" }),
        bulkUpdateTasks: (bulkIds: string[]) => {
          localBulk.push({ ids: bulkIds });
          return bulkIds.map((id) => ({ id }));
        },
        pg: null,
      },
      cyboWrite: async (req: Record<string, unknown>) => {
        calls++;
        // First chunk (5) all answer; the relay then goes away mid-op (null).
        return calls > 5 ? null : { ok: true, task: { id: req.taskId } };
      },
    } as unknown as Cyborg7McpDeps;
    const ids = Array.from({ length: 7 }, (_, i) => `task_${i}`);
    const text = await callNonCybo(testDeps, "cyborg7_bulk_update_tasks", {
      taskIds: ids,
      status: "done",
    });
    // The relay vanished after a partial success → the cloud path is abandoned
    // ENTIRELY and the local fallback re-applies to EVERY id (never a partial "5/7").
    expect(localBulk).toHaveLength(1);
    expect(localBulk[0].ids).toHaveLength(7);
    expect(text).toContain("7/7");
  });

  it("schedule_create attributes createdBy to the spawning user, overriding the cybo owner", async () => {
    const created: Record<string, unknown>[] = [];
    const testDeps = {
      storage: {
        getCybo: (id: string) =>
          id === "cybo_local"
            ? { id: "cybo_local", workspace_id: "ws_A", name: "Local", created_by: "cybo_owner" }
            : undefined,
        getCyboBySlug: (workspaceId: string, slug: string) =>
          workspaceId === "ws_A" && slug === "cybo_local"
            ? { id: "cybo_local", workspace_id: "ws_A", name: "Local", created_by: "cybo_owner" }
            : undefined,
        getChannels: () => [],
        createSchedule: (s: Record<string, unknown>) => {
          created.push(s);
          return { id: "sch_1", ...s };
        },
      },
    } as unknown as Cyborg7McpDeps;
    const text = await callNonCybo(testDeps, "cyborg7_schedule_create", {
      cybo: "cybo_local",
      cron: "0 9 * * *",
      prompt: "summarize",
    });
    expect(text).toContain("Schedule created");
    // The SPAWNING USER wins over the cybo's owner and over the agent UUID — so the
    // schedule's creator is a live workspace member and survives the runner's gate.
    expect(created[0].createdBy).toBe("user_spawn");
  });
});

describe("cyborg7 cross-session recall tools — owner-scoped (cybo)", () => {
  // Real SQLite storage + durable timeline store, so the recall tools run against
  // the same data layer they use in production. No PG needed.
  function makeSessionDeps(): {
    deps: Cyborg7McpDeps;
    storage: DualStorage;
    cleanup: () => Promise<void>;
  } {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "mcp-sc-"));
    const sqlite = new CyborgStorage(path.join(tmpDir, "cache.db"));
    const storage = new DualStorage(sqlite, null);
    const timeline = new SqliteAgentTimelineStore(path.join(tmpDir, "timeline.db"));
    sqlite.ensureUser("u_owner");
    sqlite.ensureUser("u_other");
    sqlite.createWorkspaceWithId("ws_1", "WS", "u_owner");
    const deps = {
      storage,
      sessionContext: new CyboSessionContext(storage, timeline),
    } as unknown as Cyborg7McpDeps;
    return {
      deps,
      storage,
      cleanup: async () => {
        try {
          await storage.close();
        } finally {
          rmSync(tmpDir, { recursive: true, force: true });
        }
      },
    };
  }

  async function callRecall(
    deps: Cyborg7McpDeps,
    name: string,
    args: Record<string, unknown>,
    ctxExtra?: { agentId?: string; cyboId?: string },
  ): Promise<string> {
    const server = createCyborg7McpServer(deps, {
      workspaceId: "ws_1",
      agentId: ctxExtra?.agentId ?? "cur",
      cyboId: ctxExtra?.cyboId ?? "cybo_1",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const res = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      };
      return res.content.map((c) => c.text).join("\n");
    } finally {
      await client.close();
    }
  }

  function seed(storage: DualStorage, agentId: string, initiatedBy: string): void {
    storage.createAgentBinding({
      agentId,
      workspaceId: "ws_1",
      provider: "claude",
      cyboId: "cybo_1",
      initiatedBy,
      ephemeral: true,
    });
  }

  it("registers the recall tools only for a cybo with a sessionContext dep", async () => {
    // No sessionContext → tools absent.
    const noSc = createCyborg7McpServer({} as unknown as Cyborg7McpDeps, {
      workspaceId: "ws_1",
      agentId: "ag",
      cyboId: "cybo_1",
    });
    const [ct1, st1] = InMemoryTransport.createLinkedPair();
    await noSc.connect(st1);
    const c1 = new Client({ name: "t", version: "1.0.0" });
    await c1.connect(ct1);
    const namesNoSc = (await c1.listTools()).tools.map((t) => t.name);
    await c1.close();
    expect(namesNoSc).not.toContain("cyborg7_list_my_sessions");

    // With sessionContext but NO cyboId (non-cybo agent) → tools absent.
    const { deps, cleanup } = makeSessionDeps();
    const noCybo = createCyborg7McpServer(deps, { workspaceId: "ws_1", agentId: "ag" });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await noCybo.connect(st2);
    const c2 = new Client({ name: "t", version: "1.0.0" });
    await c2.connect(ct2);
    const namesNoCybo = (await c2.listTools()).tools.map((t) => t.name);
    await c2.close();
    expect(namesNoCybo).not.toContain("cyborg7_list_my_sessions");

    // Cybo + sessionContext → all three recall tools present (always-on read tools).
    const withSc = createCyborg7McpServer(deps, {
      workspaceId: "ws_1",
      agentId: "ag",
      cyboId: "cybo_1",
    });
    const [ct3, st3] = InMemoryTransport.createLinkedPair();
    await withSc.connect(st3);
    const c3 = new Client({ name: "t", version: "1.0.0" });
    await c3.connect(ct3);
    const names = (await c3.listTools()).tools.map((t) => t.name);
    await c3.close();
    expect(names).toContain("cyborg7_list_my_sessions");
    expect(names).toContain("cyborg7_read_session");
    expect(names).toContain("cyborg7_search_sessions");
    await cleanup();
  });

  it("list_my_sessions returns the owner's sessions and never another user's", async () => {
    const { deps, storage, cleanup } = makeSessionDeps();
    seed(storage, "s_mine", "u_owner");
    seed(storage, "s_theirs", "u_other");
    // Current session owned by u_owner so resolveOwnerLocalId picks u_owner.
    seed(storage, "cur", "u_owner");

    const out = await callRecall(deps, "cyborg7_list_my_sessions", {});
    const ids = (JSON.parse(out) as { sessionId: string }[]).map((s) => s.sessionId);
    expect(ids).toContain("s_mine");
    expect(ids).not.toContain("s_theirs"); // owner ACL enforced at the data layer
    await cleanup();
  });

  it("read_session refuses a session owned by another user", async () => {
    const { deps, storage, cleanup } = makeSessionDeps();
    seed(storage, "s_theirs", "u_other");
    seed(storage, "cur", "u_owner");
    const out = await callRecall(deps, "cyborg7_read_session", { sessionId: "s_theirs" });
    expect(out).toMatch(/not found/i);
    await cleanup();
  });
});

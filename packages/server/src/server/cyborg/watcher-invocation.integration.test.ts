// Tasks Phase 2 — channel-WATCHER behavioral integration tests (internal docs
// scenarios 1-8). These drive the REAL invocation paths, never a re-implementation:
//
//   • LOCAL/connected-daemon path: the real MessageRouter.handleChannelMessage →
//     invokeChannelWatchers, against a real DualStorage on the test Postgres. The
//     agent spawn is the seam: spawnCybo (./cybo-manager) is module-mocked so no
//     real agent runs, and MessageRouter.routeToAgent is spied so we capture the
//     prompt + spawn decision WITHOUT streaming a real turn. This covers the gates
//     that live in the daemon path: auto_tasks_enabled, the agent_watch rate limit,
//     the watch:<messageId> dedup guard, the pre-filter, and human-vs-agent author.
//
//   • RELAY orchestration path: the real invokeChannelWatchersViaRelay, with its
//     I/O injected (the function's documented test seam). This is the path that
//     owns the online/offline failover CHAIN decision via the real pickMentionDaemon
//     + forwardInvoke — the local daemon path spawns locally and cannot express
//     "daemon A offline → B handles it", so the chain-failover scenario (3/4) is
//     asserted on the path that actually makes that decision in production.
//
// No real LLM, no real agent, no sockets. spawn decisions are asserted concretely
// (count, which cybo, prompt shape), per the doctrine "prove behavior, not no-throw".

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { CyborgAuthContext } from "./auth.js";
import type { CyborgChannelMessage } from "./cyborg-messages.js";
import { getDb, closePool } from "./db/connection.js";
import * as schema from "./db/schema.js";
import { buildWatcherPrompt, watchInvocationGuard } from "./cybo-mention-invoke.js";

const hasPg = !!process.env.DATABASE_URL;

// The spawn seam: spawnCybo is the module function invokeMentionedCybos /
// invokeChannelWatchers call to summon a cybo. Mock it so a "spawn" is observable
// but no real agent process / provider session is created.
const { spawnCyboMock } = vi.hoisted(() => ({ spawnCyboMock: vi.fn() }));
vi.mock("./cybo-manager.js", () => ({ spawnCybo: spawnCyboMock }));

import { MessageRouter } from "./message-router.js";

// ─── LOCAL path: real handleChannelMessage / invokeChannelWatchers on real PG ──

interface LocalHarness {
  storage: DualStorage;
  sqlite: CyborgStorage;
  router: MessageRouter;
  routeSpy: ReturnType<typeof vi.spyOn>;
  userId: string;
  userEmail: string;
  wsId: string;
}

let db: ReturnType<typeof getDb>;

// Seed a workspace+channel+human owner in SQLite (the local path's synchronous
// reads: getWorkspace/getChannel/getMembership/getCybos), then mirror the EXACT
// ids into PG (the watcher's async reads: auto-tasks switch, cybo chain, channel
// members, tasks, messages). Returns ids so each test wires its own chain/tasks.
async function makeLocalHarness(): Promise<LocalHarness> {
  const sqlite = new CyborgStorage(":memory:");
  const user = sqlite.upsertUser(`watch-${randomUUID()}@e2e.dev`, "Watcher Owner");
  const ws = sqlite.createWorkspace("Watch WS", user.id);

  // Build the REAL DualStorage in connected mode by handing it the real PgSync.
  const { PgSync } = await import("./db/pg-sync.js");
  const pg = new PgSync();
  const connected = new DualStorage(sqlite, pg);

  // Mirror user + workspace into PG (FKs for channels/cybos/tasks/members).
  await pg.upsertUser(user.id, user.email, user.name ?? null);
  await pg.createWorkspace(ws.id, ws.name, user.id);
  await pg.addMember(ws.id, user.id, "owner");

  const workspaceManager = new WorkspaceManager(connected);
  const broadcast = { toWorkspace: vi.fn(), toUser: vi.fn() };
  const router = new MessageRouter(connected, workspaceManager, broadcast);

  // Minimal AgentManager — the real spawn is mocked and routeToAgent is spied, so
  // the manager is only needed to clear the `if (!this.agentManager) return` gate.
  const agentManager = {
    getAgent: vi.fn(() => undefined),
    subscribe: vi.fn(() => () => {}),
  } as unknown as AgentManager;
  router.setAgentManager(agentManager);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  router.setAgentStorage({} as never, logger);

  // routeToAgent is the post-spawn seam: stub it so no real turn streams, but we
  // still see (agentId, prompt) — i.e. "the watcher decided to run cybo X with
  // prompt P". Resolves immediately.
  const routeSpy = vi
    .spyOn(MessageRouter.prototype, "routeToAgent")
    .mockResolvedValue(undefined as never);

  return {
    storage: connected,
    sqlite,
    router,
    routeSpy,
    userId: user.id,
    userEmail: user.email,
    wsId: ws.id,
  };
}

// Create a channel in BOTH stores under the same id, set its auto-tasks switch,
// and add the human owner as a PG channel member (roster + permission to post).
async function seedChannel(
  h: LocalHarness,
  opts: { autoTasks: boolean; name?: string },
): Promise<{ id: string; name: string }> {
  const name = opts.name ?? `watch-${randomUUID().slice(0, 8)}`;
  const ch = h.sqlite.createChannel(h.wsId, name, h.userId);
  await db.insert(schema.channels).values({
    id: ch.id,
    workspaceId: h.wsId,
    name,
    createdBy: h.userId,
    autoTasksEnabled: opts.autoTasks,
  });
  await db
    .insert(schema.channelMembers)
    .values({ channelId: ch.id, userId: h.userId, role: "admin" })
    .onConflictDoNothing();
  return { id: ch.id, name };
}

// Add a cybo to the workspace (SQLite for getCybos, PG for the roster/FK) and to
// the channel's watcher chain (PG channel_members, member_type='cybo'). joinedAt
// ascending = chain order, so the first added cybo is first in the chain.
async function addChainCybo(
  h: LocalHarness,
  channelId: string,
  opts: { slug: string; provider?: string },
): Promise<string> {
  const cybo = h.sqlite.createCybo({
    workspaceId: h.wsId,
    slug: opts.slug,
    name: opts.slug,
    soul: "soul",
    provider: opts.provider ?? "claude",
    createdBy: h.userId,
  });
  await db.insert(schema.cybos).values({
    id: cybo.id,
    workspaceId: h.wsId,
    slug: opts.slug,
    name: opts.slug,
    soul: "soul",
    provider: opts.provider ?? "claude",
    createdBy: h.userId,
  });
  await h.storage.pg!.addCyboToChannel(channelId, cybo.id);
  return cybo.id;
}

async function postHuman(h: LocalHarness, channelId: string, text: string): Promise<void> {
  const auth: CyborgAuthContext = {
    user: { id: h.userId, email: h.userEmail, name: "Watcher Owner" },
  } as CyborgAuthContext;
  const msg: CyborgChannelMessage = {
    type: "cyborg:channel_message",
    workspaceId: h.wsId,
    channelId,
    text,
    mentions: [],
  } as unknown as CyborgChannelMessage;
  h.router.handleChannelMessage(auth, msg);
}

// handleChannelMessage fires invokeChannelWatchers fire-and-forget (an async chain
// of awaited PG reads). Poll until the spawn decision settles instead of guessing
// a fixed delay — deterministic and fast.
async function waitForSpawnSettle(): Promise<void> {
  // The watcher path awaits ~6 sequential PG round-trips before spawnCybo. Give the
  // microtask + IO queue room to drain; poll on a short budget.
  const deadline = Date.now() + 4000;
  let stable = 0;
  let last = -1;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    const n = spawnCyboMock.mock.calls.length;
    if (n === last) {
      stable += 1;
      if (stable >= 4) return; // count unchanged across several polls → settled
    } else {
      stable = 0;
      last = n;
    }
  }
}

describe.skipIf(!hasPg)("channel watcher — LOCAL handleChannelMessage path (real PG)", () => {
  beforeAll(() => {
    db = getDb();
  });

  afterAll(async () => {
    await closePool();
  });

  beforeEach(() => {
    spawnCyboMock.mockReset();
    spawnCyboMock.mockResolvedValue({
      agentId: `ag_${randomUUID()}`,
      cyboId: "cybo_x",
      cyboSlug: "c",
      provider: "claude",
      model: null,
      systemPrompt: "",
    });
    // The watch dedup + rate-limit guards are process-wide singletons; clear so
    // each test starts clean (a real fresh daemon would have an empty window).
    (watchInvocationGuard as unknown as { reset?: () => void }).reset?.();
  });

  // SCENARIO 1 — auto_tasks ON + human actionable message + a chain → EXACTLY ONE
  // spawn of the first chain cybo, prompt is the watcher prompt with open tasks.
  it("auto_tasks ON + actionable human msg → spawns exactly one cybo (first chain member) with the watcher prompt", async () => {
    const h = await makeLocalHarness();
    const ch = await seedChannel(h, { autoTasks: true });
    const first = await addChainCybo(h, ch.id, { slug: "apex" });
    await addChainCybo(h, ch.id, { slug: "nova" }); // second in chain, must NOT spawn

    // An open, channel-bound task so we can assert it lands in the prompt.
    const taskId = randomUUID();
    await h.storage.pg!.createTask({
      id: taskId,
      workspaceId: h.wsId,
      title: "Deploy the relay",
      createdBy: h.userId,
      channelId: ch.id,
    });

    await postHuman(h, ch.id, "please deploy the relay when you can");
    await waitForSpawnSettle();

    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(spawnCyboMock.mock.calls[0][0]).toMatchObject({
      cyboIdOrSlug: first, // first chain member
      ephemeral: true,
      context: { channelId: ch.id },
    });
    // routeToAgent received the WATCHER prompt (not the mention prompt) with the
    // open task injected — the create-vs-update idempotency lever.
    expect(h.routeSpy).toHaveBeenCalledTimes(1);
    const prompt = h.routeSpy.mock.calls[0][1] as string;
    expect(prompt).toContain("you are the channel's task watcher");
    expect(prompt).toContain("Current OPEN TASKS");
    expect(prompt).toContain("Deploy the relay");
    expect(prompt).toContain(taskId);
  });

  // SCENARIO 2 — loop-safety. An AGENT-authored post never reaches the watcher
  // (handleAgentMessage, not handleChannelMessage), so a watcher's own resulting
  // post can't re-trigger the watcher.
  it("agent-authored post does NOT trigger the watcher (handleAgentMessage path) → zero spawns", async () => {
    const h = await makeLocalHarness();
    const ch = await seedChannel(h, { autoTasks: true });
    const cyboId = await addChainCybo(h, ch.id, { slug: "apex" });

    // The watcher's own output flows through handleAgentMessage — the agent post
    // path. It must NOT invoke the watcher.
    h.router.handleAgentMessage(
      `ag_${randomUUID()}`,
      h.wsId,
      ch.id,
      null,
      "Created a task: please deploy the relay now, it is blocked",
    );
    await waitForSpawnSettle();

    expect(spawnCyboMock).not.toHaveBeenCalled();
    expect(cyboId).toBeTruthy();
  });

  // SCENARIO 5 — dedup, ISOLATED from the rate limiter. The watch:<messageId>
  // guard is keyed by messageId ALONE, so the same messageId delivered to TWO
  // DIFFERENT channels must still spawn exactly once. Using two channels makes
  // the per-channel agent_watch rate-limit keys DIFFERENT (both admit), so the
  // messageId dedup is the ONLY thing that can suppress the second spawn —
  // disabling watchInvocationGuard makes this assert 2 and fail (mutation-proven).
  it("same messageId across two channels → exactly one watcher spawn (dedup, not rate-limit)", async () => {
    const h = await makeLocalHarness();
    const chA = await seedChannel(h, { autoTasks: true });
    const first = await addChainCybo(h, chA.id, { slug: "apex" });
    const chB = await seedChannel(h, { autoTasks: true });
    await addChainCybo(h, chB.id, { slug: "nova" });

    const auth: CyborgAuthContext = {
      user: { id: h.userId, email: h.userEmail, name: "Watcher Owner" },
    } as CyborgAuthContext;
    const msg = { mentions: [] } as unknown as CyborgChannelMessage;
    const sharedMessageId = randomUUID();
    const invoke = (
      h.router as unknown as {
        invokeChannelWatchers: (
          c: { id: string; name: string; workspace_id: string },
          a: CyborgAuthContext,
          m: CyborgChannelMessage,
          id: string | undefined,
          text: string,
          authorType: string,
        ) => Promise<void>;
      }
    ).invokeChannelWatchers.bind(h.router);

    // Distinct channels (rate-limit keys differ) but the SAME messageId →
    // only the watch:<messageId> dedup can stop the second.
    await invoke(
      { id: chA.id, name: chA.name, workspace_id: h.wsId },
      auth,
      msg,
      sharedMessageId,
      "please deploy the relay now",
      "human",
    );
    await invoke(
      { id: chB.id, name: chB.name, workspace_id: h.wsId },
      auth,
      msg,
      sharedMessageId,
      "please deploy the relay now",
      "human",
    );
    await waitForSpawnSettle();

    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(spawnCyboMock.mock.calls[0][0]).toMatchObject({ cyboIdOrSlug: first });
  });

  // SCENARIO 6 — rate limit. A burst of human messages <20s in ONE channel yields
  // ≤1 watcher spawn (agent_watch bucket); a DIFFERENT channel is unaffected.
  it("burst in one channel → ≤1 spawn (agent_watch); a different channel still spawns", async () => {
    const h = await makeLocalHarness();
    const chA = await seedChannel(h, { autoTasks: true, name: "alpha" });
    await addChainCybo(h, chA.id, { slug: "apex" });
    const chB = await seedChannel(h, { autoTasks: true, name: "bravo" });
    await addChainCybo(h, chB.id, { slug: "nova" });

    // Five rapid human posts in channel A — each distinct messageId so the watch
    // dedup guard never short-circuits; only the rate limit should cap them.
    for (let i = 0; i < 5; i++) {
      await postHuman(h, chA.id, `please review and deploy item number ${i}`);
    }
    await waitForSpawnSettle();
    const afterA = spawnCyboMock.mock.calls.length;

    // A different channel is a different rate-limit key → still allowed.
    await postHuman(h, chB.id, "please review and deploy the other thing");
    await waitForSpawnSettle();
    const afterB = spawnCyboMock.mock.calls.length;

    expect(afterA).toBe(1); // burst in A debounced to one
    expect(afterB).toBe(2); // B independent → one more
  });

  // SCENARIO 7 — auto_tasks OFF → zero spawns, even for an actionable message with
  // a chain present.
  it("auto_tasks OFF → zero watcher spawns", async () => {
    const h = await makeLocalHarness();
    const ch = await seedChannel(h, { autoTasks: false });
    await addChainCybo(h, ch.id, { slug: "apex" });

    await postHuman(h, ch.id, "please deploy the relay right now, it is urgent");
    await waitForSpawnSettle();

    expect(spawnCyboMock).not.toHaveBeenCalled();
  });

  // SCENARIO 8 — pre-filter. Trivial chatter with NO open tasks is shed (zero
  // spawns); the SAME trivial chatter WITH an open task short-circuits through
  // (the open-tasks lever) and spawns.
  it("trivial chatter: no open task → zero spawns; one open task → spawns (open-tasks short-circuit)", async () => {
    // (a) no open tasks → "ok" is below the actionable bar → shed.
    const h1 = await makeLocalHarness();
    const ch1 = await seedChannel(h1, { autoTasks: true });
    await addChainCybo(h1, ch1.id, { slug: "apex" });
    await postHuman(h1, ch1.id, "ok");
    await postHuman(h1, ch1.id, "jaja");
    await waitForSpawnSettle();
    expect(spawnCyboMock).not.toHaveBeenCalled();

    // (b) an open channel-bound task → hasOpenTasks short-circuits the prefilter →
    // even trivial chatter is considered → spawn. Fresh channel to dodge A's rate
    // limit.
    const ch2 = await seedChannel(h1, { autoTasks: true, name: "withtask" });
    await addChainCybo(h1, ch2.id, { slug: "nova" });
    await h1.storage.pg!.createTask({
      id: randomUUID(),
      workspaceId: h1.wsId,
      title: "Open thing to track",
      createdBy: h1.userId,
      channelId: ch2.id,
    });
    await postHuman(h1, ch2.id, "ok");
    await waitForSpawnSettle();
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
  });

  // SCENARIO 4 (manual-create half) — with the chain present but unreachable the
  // watcher is a no-op, yet a MANUAL createTask still works (board unaffected).
  // The all-offline failover half is asserted on the relay path below.
  it("manual createTask still works while the watcher is a no-op (auto_tasks OFF channel)", async () => {
    const h = await makeLocalHarness();
    const ch = await seedChannel(h, { autoTasks: false });
    await addChainCybo(h, ch.id, { slug: "apex" });
    await postHuman(h, ch.id, "please deploy the relay now");
    await waitForSpawnSettle();
    expect(spawnCyboMock).not.toHaveBeenCalled();

    const taskId = randomUUID();
    await h.storage.pg!.createTask({
      id: taskId,
      workspaceId: h.wsId,
      title: "Manually filed task",
      createdBy: h.userId,
      channelId: ch.id,
    });
    const tasks = await h.storage.pg!.getTasks(h.wsId);
    expect(tasks.map((t) => t.id)).toContain(taskId);
  });

  // EPHEMERAL PI WATCHER TURN (end-to-end). The race this fix kills: the watcher
  // spawns a fresh ephemeral pi cybo (persistSession:false) and immediately routes
  // ONE prompt; a legacy-history "capture" prompt collides with that route and the
  // turn surfaces "Agent is already processing" (pi) — the cybo never runs and no
  // task is created. With historyPrimed:true on the ephemeral spawn the capture is
  // skipped, and the route's .catch() guard means a route rejection can never
  // become an unhandledRejection that crashes the fixture. Here we drive the real
  // human-post → watcher → ephemeral pi spawn path, stand in for the cybo's turn
  // inside the route seam (it calls a STUBBED cyborg7_create_task, the same write
  // the MCP tool performs), and assert (a) the fixture stays up — no
  // unhandledRejection / no crash — and (b) create_task was invoked exactly once.
  it("ephemeral pi watcher turn: routes once, invokes stubbed create_task, no unhandledRejection", async () => {
    const h = await makeLocalHarness();
    const ch = await seedChannel(h, { autoTasks: true });
    // Ephemeral PI cybo — the harness that exhibited "Agent is already processing".
    const cyboId = await addChainCybo(h, ch.id, { slug: "apex", provider: "pi" });

    // The spawn returns a pi cybo; assert below that it was spawned EPHEMERAL.
    spawnCyboMock.mockResolvedValueOnce({
      agentId: `ag_${randomUUID()}`,
      cyboId,
      cyboSlug: "apex",
      provider: "pi",
      model: null,
      systemPrompt: "",
    });

    // Stand in for the cybo's turn: when the watcher routes the prompt, the cybo
    // would call cyborg7_create_task. Stub that tool with the SAME local write the
    // real MCP handler performs (storage.createTask) so the board reflects it.
    const createTaskStub = vi.fn(async (title: string) => {
      await h.storage.pg!.createTask({
        id: randomUUID(),
        workspaceId: h.wsId,
        title,
        createdBy: cyboId,
        channelId: ch.id,
      });
    });
    h.routeSpy.mockImplementation(async () => {
      await createTaskStub("Deploy the relay (filed by watcher)");
      return undefined as never;
    });

    // Any route rejection on the fire-and-forget watcher path must be swallowed by
    // the .catch() guard, never escape as an unhandledRejection that tears down the
    // worker. Capture them for the duration of this turn.
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await postHuman(h, ch.id, "please deploy the relay when you can");
      await waitForSpawnSettle();
      // Let any rejected fire-and-forget settle into the unhandledRejection queue.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // (a) fixture stayed up — no unhandledRejection escaped the watcher path.
    expect(unhandled).toHaveLength(0);
    // The watcher spawned the pi cybo EPHEMERAL (the historyPrimed path) and routed
    // the prompt exactly once.
    expect(spawnCyboMock).toHaveBeenCalledTimes(1);
    expect(spawnCyboMock.mock.calls[0][0]).toMatchObject({
      cyboIdOrSlug: cyboId,
      ephemeral: true,
      context: { channelId: ch.id },
    });
    expect(h.routeSpy).toHaveBeenCalledTimes(1);
    // (b) the stubbed cyborg7_create_task fired and the task landed on the board.
    expect(createTaskStub).toHaveBeenCalledTimes(1);
    const tasks = await h.storage.pg!.getTasks(h.wsId);
    expect(tasks.map((t) => t.title)).toContain("Deploy the relay (filed by watcher)");
  });
});

// ─── RELAY path: real invokeChannelWatchersViaRelay (injected I/O) ─────────────
// This is the path that owns the online/offline failover CHAIN decision (the local
// daemon spawns locally and cannot model a peer daemon being offline). The deps
// object is the function's documented test seam; forwardInvoke is the spy that
// proves "the watcher decided to hand the message to cybo X (exactly once)".

import { invokeChannelWatchersViaRelay } from "./cybo-mention-invoke.js";
import type {
  ChannelWatchDeps,
  ChannelWatchInvoke,
  ChannelWatchMessage,
} from "./cybo-mention-invoke.js";

interface RelayFixture {
  deps: ChannelWatchDeps;
  forwarded: Array<{ daemonId: string; invoke: ChannelWatchInvoke }>;
  online: Set<string>;
}

// Three cybos A,B,C, each owned by a distinct creator that owns a distinct daemon
// (dA,dB,dC). With no slash config and no provider reporting, pickMentionDaemon's
// blind path routes each cybo to its creator-home daemon iff online — giving clean
// per-cybo online/offline control to model the failover chain.
function makeRelayFixture(opts: {
  chain: string[];
  cybos: Array<{ id: string; created_by: string }>;
  daemons: Array<{ id: string; ownerId: string }>;
  onlineDaemonIds: string[];
  openTasks?: Array<{ id: string; title: string; status: string; channel_id?: string | null }>;
}): RelayFixture {
  const forwarded: Array<{ daemonId: string; invoke: ChannelWatchInvoke }> = [];
  const online = new Set(opts.onlineDaemonIds);
  const cyboRows = opts.cybos.map((c) => ({
    id: c.id,
    slug: c.id,
    name: c.id,
    created_by: c.created_by,
    provider: "claude",
    model: null as string | null,
  }));
  const deps: ChannelWatchDeps = {
    pg: {
      getChannelCyboMembers: async () => opts.chain,
      getCybos: async () => cyboRows,
      getMessages: async () => [],
      getTasks: async () =>
        (opts.openTasks ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          assignee_id: null,
          channel_id: t.channel_id ?? null,
        })),
      getChannelMembers: async () => [],
      getWorkspaceSlashConfig: async () => ({ defaultSlashDaemonId: null, fallbackDaemons: [] }),
      getDaemonsForWorkspace: async () =>
        opts.daemons.map((d) => ({ id: d.id, ownerId: d.ownerId })),
    },
    getOnlineDaemonIds: () => [...online],
    getDaemonProviders: () => undefined, // no reporting → blind (creator-home) pick
    forwardInvoke: (daemonId, invoke) => {
      if (!online.has(daemonId)) return false; // daemon vanished → caller advances
      forwarded.push({ daemonId, invoke });
      return true;
    },
    log: () => {},
  };
  return { deps, forwarded, online };
}

function relayMsg(over: Partial<ChannelWatchMessage> = {}): ChannelWatchMessage {
  return {
    workspaceId: "ws_1",
    channelId: "ch_1",
    channelName: "general",
    messageId: randomUUID(),
    text: "please deploy the relay now",
    authorId: "user_1",
    authorName: "Alice",
    authorType: "human",
    ...over,
  };
}

describe("channel watcher — RELAY failover chain (real invokeChannelWatchersViaRelay)", () => {
  // SCENARIO 3 — chain [A,B,C], A's daemon offline, B online → B handles it, C is
  // NOT invoked (exactly one). Then A online + B offline → A handles it.
  it("A offline, B online → B spawned exactly once, C untouched", async () => {
    const fx = makeRelayFixture({
      chain: ["A", "B", "C"],
      cybos: [
        { id: "A", created_by: "ownerA" },
        { id: "B", created_by: "ownerB" },
        { id: "C", created_by: "ownerC" },
      ],
      daemons: [
        { id: "dA", ownerId: "ownerA" },
        { id: "dB", ownerId: "ownerB" },
        { id: "dC", ownerId: "ownerC" },
      ],
      onlineDaemonIds: ["dB", "dC"], // A offline; B and C online
    });

    await invokeChannelWatchersViaRelay(fx.deps, relayMsg());

    expect(fx.forwarded).toHaveLength(1);
    expect(fx.forwarded[0].invoke.cyboId).toBe("B"); // first ONLINE chain member
    expect(fx.forwarded[0].daemonId).toBe("dB");
  });

  it("A online, B offline → A handles it (next-online wins, exactly one)", async () => {
    const fx = makeRelayFixture({
      chain: ["A", "B", "C"],
      cybos: [
        { id: "A", created_by: "ownerA" },
        { id: "B", created_by: "ownerB" },
        { id: "C", created_by: "ownerC" },
      ],
      daemons: [
        { id: "dA", ownerId: "ownerA" },
        { id: "dB", ownerId: "ownerB" },
        { id: "dC", ownerId: "ownerC" },
      ],
      onlineDaemonIds: ["dA", "dC"], // A online; B offline
    });

    await invokeChannelWatchersViaRelay(fx.deps, relayMsg());

    expect(fx.forwarded).toHaveLength(1);
    expect(fx.forwarded[0].invoke.cyboId).toBe("A");
  });

  // Forward FAILS mid-flight on B (daemon vanished after the pick) → the chain
  // advances to C. Still exactly one successful hand-off.
  it("forward to B fails mid-flight → advances to C (exactly one successful hand-off)", async () => {
    const fx = makeRelayFixture({
      chain: ["A", "B", "C"],
      cybos: [
        { id: "A", created_by: "ownerA" },
        { id: "B", created_by: "ownerB" },
        { id: "C", created_by: "ownerC" },
      ],
      daemons: [
        { id: "dA", ownerId: "ownerA" },
        { id: "dB", ownerId: "ownerB" },
        { id: "dC", ownerId: "ownerC" },
      ],
      onlineDaemonIds: ["dB", "dC"],
    });
    // pickMentionDaemon will choose dB for B; make the forward itself fail so the
    // loop falls through to C.
    const realForward = fx.deps.forwardInvoke;
    fx.deps.forwardInvoke = (daemonId, invoke) => {
      if (daemonId === "dB") return false; // B's send fails
      return realForward(daemonId, invoke);
    };

    await invokeChannelWatchersViaRelay(fx.deps, relayMsg());

    expect(fx.forwarded).toHaveLength(1);
    expect(fx.forwarded[0].invoke.cyboId).toBe("C");
  });

  // SCENARIO 4 — every chain daemon offline → ZERO forwards (no-op, stays silent).
  it("all chain daemons offline → zero spawns (no-op)", async () => {
    const fx = makeRelayFixture({
      chain: ["A", "B", "C"],
      cybos: [
        { id: "A", created_by: "ownerA" },
        { id: "B", created_by: "ownerB" },
        { id: "C", created_by: "ownerC" },
      ],
      daemons: [
        { id: "dA", ownerId: "ownerA" },
        { id: "dB", ownerId: "ownerB" },
        { id: "dC", ownerId: "ownerC" },
      ],
      onlineDaemonIds: [], // every daemon offline
    });

    await invokeChannelWatchersViaRelay(fx.deps, relayMsg());

    expect(fx.forwarded).toHaveLength(0);
  });

  // Loop-safety on the relay path: an agent-authored message is rejected before any
  // chain resolution (zero forwards).
  it("agent-authored message → zero forwards (anti-cascade)", async () => {
    const fx = makeRelayFixture({
      chain: ["A"],
      cybos: [{ id: "A", created_by: "ownerA" }],
      daemons: [{ id: "dA", ownerId: "ownerA" }],
      onlineDaemonIds: ["dA"],
    });

    await invokeChannelWatchersViaRelay(fx.deps, relayMsg({ authorType: "agent" }));

    expect(fx.forwarded).toHaveLength(0);
  });

  // The forwarded prompt is the WATCHER prompt with the channel's open tasks
  // injected — the same shape the local path produces (one builder, both modes).
  it("forwards the watcher prompt with open tasks injected", async () => {
    const taskId = randomUUID();
    const fx = makeRelayFixture({
      chain: ["A"],
      cybos: [{ id: "A", created_by: "ownerA" }],
      daemons: [{ id: "dA", ownerId: "ownerA" }],
      onlineDaemonIds: ["dA"],
      openTasks: [{ id: taskId, title: "Ship the watcher", status: "pending", channel_id: "ch_1" }],
    });

    await invokeChannelWatchersViaRelay(fx.deps, relayMsg({ text: "is the watcher done yet?" }));

    expect(fx.forwarded).toHaveLength(1);
    const prompt = fx.forwarded[0].invoke.prompt;
    const expected = buildWatcherPrompt({
      channelName: "general",
      transcript: "",
      author: "Alice",
      text: "is the watcher done yet?",
      openTasks: [{ id: taskId, title: "Ship the watcher", status: "pending", assignee: null }],
      roster: ["A (cybo, id A)"],
    });
    expect(prompt).toBe(expected);
    expect(prompt).toContain("you are the channel's task watcher");
    expect(prompt).toContain(taskId);
  });

  // CHANGE 1: a recurring / future-time ask must steer the watcher to a real
  // SCHEDULE (cyborg7_schedule_create), not just a one-off task. The guidance is
  // additive to the existing create/update task instructions.
  it("the watcher prompt instructs creating a real schedule for recurring asks", () => {
    const prompt = buildWatcherPrompt({
      channelName: "general",
      transcript: "",
      author: "Alice",
      text: "remind us every Monday at 9am to do standup",
      openTasks: [],
      roster: ["apex (cybo, id A)"],
    });
    expect(prompt).toContain("SCHEDULING");
    expect(prompt).toContain("cyborg7_schedule_create");
    expect(prompt).toContain("RECURRING");
    // The existing task guidance stays intact (additive change).
    expect(prompt).toContain("create_task / update_task / list_tasks");
  });
});

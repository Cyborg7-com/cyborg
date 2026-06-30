// Per-backend spawn guard (the "doomed chat" fix): a cybo pinned to a backend
// the daemon's runtime has NOT configured must be refused BEFORE a chat opens —
// not die on the first turn with the runtime's raw "No API key found".
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { CyborgAuth } from "./auth.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter } from "./message-router.js";
import { CyborgDispatcher } from "./dispatcher.js";
import {
  backendDisplayName,
  cyboRequiredBackend,
  findBackendGap,
  spawnBackendGapMessage,
} from "./cybo-runtime-profile.js";
import type { AgentManager } from "../agent/agent-manager.js";

describe("cyboRequiredBackend (mirrors resolvePiModelRef)", () => {
  it("new-cybo shape: provider='pi' + full ref names the backend", () => {
    expect(cyboRequiredBackend("pi", "anthropic/claude-opus-4-x")).toBe("anthropic");
    expect(cyboRequiredBackend("pi", "pi/opencode-go/glm-5.1")).toBe("opencode-go");
  });
  it("standalone shape: provider IS the backend", () => {
    expect(cyboRequiredBackend("opencode-go", "glm-5.1")).toBe("opencode-go");
    expect(cyboRequiredBackend("anthropic", "claude-haiku-4-5")).toBe("anthropic");
  });
  it("no pinned model → null (runtime default, binary capability)", () => {
    expect(cyboRequiredBackend("pi", null)).toBeNull();
  });
});

describe("findBackendGap", () => {
  const OPENCODE_ONLY = ["opencode-go/glm-5.1", "opencode-go/glm-5.1-air"];

  it("REJECTS the repro shape: anthropic cybo on an opencode-go-only runtime", () => {
    expect(findBackendGap(OPENCODE_ONLY, "anthropic")).toBe("anthropic");
  });
  it("accepts a backend the runtime has configured", () => {
    expect(findBackendGap(OPENCODE_ONLY, "opencode-go")).toBeNull();
  });
  it("backward compat: ids without backend prefixes → allow (binary verdict already passed)", () => {
    expect(findBackendGap(["glm-5.1", "some-model"], "anthropic")).toBeNull();
  });
  it("no derivable backend (no pinned model) → allow", () => {
    expect(findBackendGap(OPENCODE_ONLY, null)).toBeNull();
  });

  it("gap message is branded (names the cybo + backend, never the runtime's internal name)", () => {
    const msg = spawnBackendGapMessage("Apex", "anthropic");
    expect(msg).toContain("Apex needs Anthropic");
    expect(msg).toContain("Set up Cybo on this daemon");
    expect(msg).not.toMatch(/(^|[^a-z])pi([^a-z]|$)/i);
    expect(backendDisplayName("opencode-go")).toBe("opencode-go");
  });
});

// ─── Dispatcher integration: the refusal happens BEFORE the spawn ────────────

function snapshotStub(modelIds: string[]) {
  return {
    async listProviders() {
      return [{ provider: "pi", status: "ready", models: modelIds.map((id) => ({ id })) }];
    },
    async refreshSnapshotForCwd() {},
  } as never;
}

describe("handleSpawnCybo per-backend gate (blocks before opening)", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let dispatcher: CyborgDispatcher;
  let createdAgents: unknown[];
  let owner: NonNullable<ReturnType<CyborgAuth["validateToken"]>>;
  let workspaceId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "spawn-guard-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "t.db")), null);
    const auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const router = new MessageRouter(storage, workspaceManager, {
      toWorkspace() {},
      toUser() {},
    });
    dispatcher = new CyborgDispatcher(router, workspaceManager, storage);

    createdAgents = [];
    dispatcher.setAgentManager({
      // The proof of "blocked BEFORE the spawn": this records every attempt.
      createAgent: async (config: unknown, agentId?: string) => {
        createdAgents.push(config);
        return {
          id: agentId ?? "agent-x",
          provider: "pi",
          lifecycle: "idle",
          cwd: "/tmp",
          labels: {},
        };
      },
    } as unknown as AgentManager);

    owner = auth.validateToken(auth.createToken("o@test.com", "Owner"))!;
    const ws: unknown[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "WS", requestId: "w1" } as never,
      owner,
      (m) => ws.push(m),
    );
    workspaceId = (ws[0] as { payload: { workspace: { id: string } } }).payload.workspace.id;
  });

  afterEach(() => {
    try {
      storage.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeCybo(model: string): string {
    return storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "Be sharp.",
      provider: "pi",
      model,
      createdBy: owner.user.id,
    }).id;
  }

  async function spawn(cyboId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    await dispatcher.dispatch(
      {
        type: "cyborg:spawn_cybo",
        requestId: "s1",
        workspaceId,
        cyboIdOrSlug: cyboId,
      } as never,
      owner,
      (m) => out.push(m),
    );
    return out;
  }

  it("REFUSES the repro: Anthropic cybo, opencode-go-only runtime — error BEFORE any spawn", async () => {
    dispatcher.setProviderSnapshotManager(snapshotStub(["opencode-go/glm-5.1"]));
    const cyboId = makeCybo("anthropic/claude-opus-4-x");

    const out = await spawn(cyboId);

    const err = out[0] as { type: string; payload: { code: string; message: string } };
    expect(err.type).toBe("cyborg:error");
    expect(err.payload.code).toBe("unavailable");
    expect(err.payload.message).toContain("Apex needs Anthropic");
    // THE artifact: the chat never opened — no agent was created.
    expect(createdAgents).toHaveLength(0);
  });

  it("ALLOWS the configured backend: opencode-go cybo on the same runtime spawns", async () => {
    dispatcher.setProviderSnapshotManager(snapshotStub(["opencode-go/glm-5.1"]));
    const cyboId = makeCybo("opencode-go/glm-5.1");

    const out = await spawn(cyboId);

    expect(createdAgents).toHaveLength(1);
    const resp = out.find((m) => (m as { type: string }).type === "cyborg:spawn_cybo_response") as {
      payload: { cyboSlug: string };
    };
    expect(resp.payload.cyboSlug).toBe("apex");
  });

  it("backward compat: runtime without backend-prefixed ids spawns like today", async () => {
    dispatcher.setProviderSnapshotManager(snapshotStub(["glm-5.1"]));
    const cyboId = makeCybo("anthropic/claude-opus-4-x");

    await spawn(cyboId);

    expect(createdAgents).toHaveLength(1); // binary verdict only — no new blocking
  });
});

// ─── internal docs: NATIVE harness gate (provider IS the harness) ─────────────

function nativeSnapshotStub(available: Record<string, boolean>) {
  return {
    async listProviders(opts?: { providers?: string[] }) {
      const all = Object.entries(available).map(([provider, ok]) => ({
        provider,
        status: ok ? "ready" : "unavailable",
        models: [],
      }));
      return opts?.providers ? all.filter((p) => opts.providers!.includes(p.provider)) : all;
    },
    async refreshSnapshotForCwd() {},
  } as never;
}

describe("handleSpawnCybo native-harness gate (internal docs)", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let dispatcher: CyborgDispatcher;
  let createdAgents: unknown[];
  let owner: NonNullable<ReturnType<CyborgAuth["validateToken"]>>;
  let workspaceId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "native-gate-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "t.db")), null);
    const auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const router = new MessageRouter(storage, workspaceManager, {
      toWorkspace() {},
      toUser() {},
    });
    dispatcher = new CyborgDispatcher(router, workspaceManager, storage);
    createdAgents = [];
    dispatcher.setAgentManager({
      createAgent: async (config: unknown, agentId?: string) => {
        createdAgents.push(config);
        return {
          id: agentId ?? "agent-n",
          provider: (config as { provider: string }).provider,
          lifecycle: "idle",
          cwd: "/tmp",
          labels: {},
        };
      },
    } as unknown as AgentManager);
    owner = auth.validateToken(auth.createToken("n@test.com", "N"))!;
    const ws: unknown[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "WS", requestId: "w1" } as never,
      owner,
      (m) => ws.push(m),
    );
    workspaceId = (ws[0] as { payload: { workspace: { id: string } } }).payload.workspace.id;
  });

  afterEach(() => {
    try {
      storage.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeClaudeCybo(): string {
    return storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "Be sharp.",
      provider: "claude",
      model: "claude-haiku-4-5",
      createdBy: owner.user.id,
    }).id;
  }

  async function spawn(cyboId: string): Promise<unknown[]> {
    const out: unknown[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:spawn_cybo", requestId: "s1", workspaceId, cyboIdOrSlug: cyboId } as never,
      owner,
      (m) => out.push(m),
    );
    return out;
  }

  it("ARTIFACT (3): provider=claude on a daemon WITHOUT claude → clear error BEFORE any spawn", async () => {
    dispatcher.setProviderSnapshotManager(nativeSnapshotStub({ claude: false, pi: true }));
    const out = await spawn(makeClaudeCybo());
    const err = out[0] as { type: string; payload: { code: string; message: string } };
    expect(err.type).toBe("cyborg:error");
    expect(err.payload.code).toBe("unavailable");
    // Actionable native-harness gap (internal docs PART 1): names the cybo, the
    // missing Claude login, and the concrete `claude login` fix.
    expect(err.payload.message).toContain("Apex");
    expect(err.payload.message).toContain("Claude");
    expect(err.payload.message).toContain("claude login");
    expect(createdAgents).toHaveLength(0); // never spawned, never opened
  });

  it("provider=claude on a daemon WITH claude → spawns NATIVELY (provider claude, not pi)", async () => {
    dispatcher.setProviderSnapshotManager(nativeSnapshotStub({ claude: true }));
    const out = await spawn(makeClaudeCybo());
    expect(createdAgents).toHaveLength(1);
    expect((createdAgents[0] as { provider: string }).provider).toBe("claude");
    expect((createdAgents[0] as { model?: string }).model).toBe("claude-haiku-4-5");
    const resp = out.find((m) => (m as { type: string }).type === "cyborg:spawn_cybo_response") as {
      payload: { provider: string };
    };
    expect(resp.payload.provider).toBe("claude");
  });

  it("native gate does NOT consult the runtime: claude cybo spawns even with pi unavailable", async () => {
    dispatcher.setProviderSnapshotManager(nativeSnapshotStub({ claude: true, pi: false }));
    await spawn(makeClaudeCybo());
    expect(createdAgents).toHaveLength(1);
  });
});

// ─── Session singleton (dedup): interactive spawn reuses a live (cybo,channel) ──

describe("handleSpawnCybo dedup: reuses the live (cybo, channel) session", () => {
  let tmpDir: string;
  let storage: DualStorage;
  let dispatcher: CyborgDispatcher;
  let createdIds: string[];
  let liveIds: Set<string>;
  let nextAgentId: number;
  let owner: NonNullable<ReturnType<CyborgAuth["validateToken"]>>;
  let workspaceId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "dedup-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "t.db")), null);
    const auth = new CyborgAuth(storage);
    const workspaceManager = new WorkspaceManager(storage);
    const router = new MessageRouter(storage, workspaceManager, { toWorkspace() {}, toUser() {} });
    dispatcher = new CyborgDispatcher(router, workspaceManager, storage);
    createdIds = [];
    liveIds = new Set();
    nextAgentId = 0;
    dispatcher.setAgentManager({
      createAgent: async (config: unknown, agentId?: string) => {
        const id = agentId ?? `agent-${nextAgentId++}`;
        createdIds.push(id);
        liveIds.add(id); // the agent is now loaded/live in this process
        return {
          id,
          provider: (config as { provider: string }).provider,
          lifecycle: "idle",
          cwd: "/tmp",
          labels: {},
        };
      },
      // Liveness probe used by the dedup reuse-check (and getLiveCyboBinding caller).
      getAgent: (id: string) => (liveIds.has(id) ? { id } : undefined),
    } as unknown as AgentManager);
    dispatcher.setProviderSnapshotManager(nativeSnapshotStub({ claude: true }));
    owner = auth.validateToken(auth.createToken("d@test.com", "D"))!;
    const ws: unknown[] = [];
    await dispatcher.dispatch(
      { type: "cyborg:create_workspace", name: "WS", requestId: "w1" } as never,
      owner,
      (m) => ws.push(m),
    );
    workspaceId = (ws[0] as { payload: { workspace: { id: string } } }).payload.workspace.id;
  });

  afterEach(() => {
    try {
      storage.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeCybo(): string {
    return storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "Be sharp.",
      provider: "claude",
      model: "claude-haiku-4-5",
      createdBy: owner.user.id,
    }).id;
  }

  async function spawn(cyboId: string, channelId: string | null): Promise<string> {
    const out: unknown[] = [];
    await dispatcher.dispatch(
      {
        type: "cyborg:spawn_cybo",
        requestId: "s",
        workspaceId,
        cyboIdOrSlug: cyboId,
        channelId: channelId ?? undefined,
      } as never,
      owner,
      (m) => out.push(m),
    );
    const resp = out.find((m) => (m as { type: string }).type === "cyborg:spawn_cybo_response") as {
      payload: { agentId: string };
    };
    expect(resp).toBeDefined();
    return resp.payload.agentId;
  }

  it("spawning the same (cybo, channel) twice while live REUSES the same agentId", async () => {
    const cyboId = makeCybo();
    const first = await spawn(cyboId, "chan-1");
    const second = await spawn(cyboId, "chan-1");
    expect(second).toBe(first);
    expect(createdIds).toHaveLength(1); // no second binding/agent was created
  });

  it("after the agent is gone, a NEW session is created", async () => {
    const cyboId = makeCybo();
    const first = await spawn(cyboId, "chan-1");
    liveIds.delete(first); // agent torn down — binding is now stale
    const second = await spawn(cyboId, "chan-1");
    expect(second).not.toBe(first);
    expect(createdIds).toHaveLength(2);
  });

  it("a DIFFERENT channel spawns its own session (channel-scoped)", async () => {
    const cyboId = makeCybo();
    const inChan1 = await spawn(cyboId, "chan-1");
    const inChan2 = await spawn(cyboId, "chan-2");
    expect(inChan2).not.toBe(inChan1);
    expect(createdIds).toHaveLength(2);
  });
});

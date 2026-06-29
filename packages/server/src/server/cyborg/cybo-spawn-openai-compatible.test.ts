// Phase 3 (internal docs) e2e/integration — spawnCybo through the openai-compatible
// path. Spawns a cybo configured for OpenRouter and asserts the LAUNCH CONFIG
// carries the right model ref + the API KEY reaches the child env, and that the
// per-cybo models.json (baseURL/model) is written. The actual HTTP is NOT made —
// we assert the WIRING, never a live completion (no real paid API call).
//
// The companion no-regression assertion lives here too: a stock `claude` cybo
// spawned through the SAME path gets NO env (byte-identical to pre-P3).

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CyboCredentialStore } from "./cybo-credentials.js";
import { CyboCredentialMissingError, spawnCybo } from "./cybo-manager.js";
import { CyborgAuth } from "./auth.js";
import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CapturedCreate {
  config: any;
  agentId: string;
  options: any;
}

function createMockAgentManager() {
  const createdConfigs: CapturedCreate[] = [];
  return {
    createdConfigs,
    async createAgent(config: any, agentId?: string, options?: any) {
      const id = agentId ?? `agent-${Date.now()}`;
      createdConfigs.push({ config, agentId: id, options });
      return {
        id,
        provider: config.provider,
        lifecycle: "idle" as const,
        cwd: config.cwd ?? "/tmp",
        labels: options?.labels ?? {},
        config,
      };
    },
  };
}

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("spawnCybo e2e — openai-compatible (OpenRouter) wiring", () => {
  let storage: DualStorage;
  let workspaceManager: WorkspaceManager;
  let credentialStore: CyboCredentialStore;
  let manager: ReturnType<typeof createMockAgentManager>;
  let tmp: string;
  let credDir: string;
  let workspaceId: string;
  let userId: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "p3-spawn-"));
    credDir = mkdtempSync(join(tmpdir(), "p3-cred-"));
    storage = new DualStorage(new CyborgStorage(join(tmp, "t.db")), null);
    const auth = new CyborgAuth(storage);
    workspaceManager = new WorkspaceManager(storage);
    manager = createMockAgentManager();
    credentialStore = new CyboCredentialStore({ baseDir: credDir, masterKeyBase64: MASTER_KEY });
    const ctx = auth.validateToken(auth.createToken("e2e@test.com", "E2E"))!;
    userId = ctx.user.id;
    workspaceId = workspaceManager.createWorkspace("E2EWS", userId).id;
  });

  afterEach(() => {
    storage.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(credDir, { recursive: true, force: true });
  });

  it("carries the model ref + injects the OpenRouter key into the child env + writes models.json", async () => {
    await credentialStore.setCredential("openrouter", { type: "api", key: "sk-or-e2e-xyz" });
    const cybo = storage.createCybo({
      workspaceId,
      slug: "router",
      name: "Router",
      soul: "Route well.",
      provider: "openrouter",
      model: "openrouter/anthropic/claude-sonnet-4.5",
      llmAuthMode: "api-key",
      createdBy: userId,
    });

    const result = await spawnCybo({
      storage,
      agentManager: manager as any,
      workspaceId,
      cyboIdOrSlug: cybo.id,
      userId,
      credentialStore,
    });

    expect(result.agentId).toBeTruthy();
    const created = manager.createdConfigs[0];
    // Resolves onto the PI runtime with the openrouter/<slug> model ref.
    expect(created.config.provider).toBe("pi");
    expect(created.config.model).toBe("openrouter/anthropic/claude-sonnet-4.5");
    // The API key reached the child env via the existing createAgent({ env }) seam.
    expect(created.options.env.OPENROUTER_API_KEY).toBe("sk-or-e2e-xyz");
    // PI is pointed at the per-cybo agent dir holding the custom provider manifest.
    const piDir = created.options.env.PI_CODING_AGENT_DIR as string;
    expect(piDir).toBeTruthy();
    expect(existsSync(join(piDir, "models.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8"));
    expect(manifest.providers.openrouter.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(manifest.providers.openrouter.api).toBe("openai-completions");
    // The secret is in the env only — never written into the manifest on disk.
    expect(manifest.providers.openrouter.apiKey).toBe("$OPENROUTER_API_KEY");
    expect(readFileSync(join(piDir, "models.json"), "utf8")).not.toContain("sk-or-e2e-xyz");
  });

  it("NO-REGRESSION: a stock claude cybo spawned via the SAME path gets NO env", async () => {
    const cybo = storage.createCybo({
      workspaceId,
      slug: "apex",
      name: "Apex",
      soul: "Sharp.",
      provider: "claude",
      model: "claude-haiku-4-5",
      createdBy: userId,
    });

    await spawnCybo({
      storage,
      agentManager: manager as any,
      workspaceId,
      cyboIdOrSlug: cybo.id,
      userId,
      credentialStore,
    });

    const created = manager.createdConfigs[0];
    expect(created.config.provider).toBe("claude");
    expect(created.config.model).toBe("claude-haiku-4-5");
    // The injection seam is absent entirely (no `env` key) — identical to pre-P3.
    expect(created.options.env).toBeUndefined();
  });

  it("REFUSES pre-spawn (no agent created) when the OpenRouter credential is missing", async () => {
    const cybo = storage.createCybo({
      workspaceId,
      slug: "norouter",
      name: "NoRouter",
      soul: "x",
      provider: "openrouter",
      model: "openrouter/openai/gpt-5.1",
      llmAuthMode: "api-key",
      createdBy: userId,
    });

    await expect(
      spawnCybo({
        storage,
        agentManager: manager as any,
        workspaceId,
        cyboIdOrSlug: cybo.id,
        userId,
        credentialStore,
      }),
    ).rejects.toBeInstanceOf(CyboCredentialMissingError);
    // PRE-spawn: no agent was ever created.
    expect(manager.createdConfigs).toHaveLength(0);
  });
});

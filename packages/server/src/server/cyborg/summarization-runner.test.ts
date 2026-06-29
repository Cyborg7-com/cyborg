import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";

import type { AgentManager } from "../agent/agent-manager.js";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { StructuredGenerationProvider } from "../agent/agent-response-loop.js";
import type { AgentProvider } from "../agent/agent-sdk-types.js";
import {
  createAgentSummaryCompleter,
  generateAgentText,
  AI_BACKEND_BUSY_MESSAGE,
} from "./summarization-runner.js";

// A snapshot manager that advertises an enabled provider with a "haiku" model —
// resolveStructuredGenerationProviders matches it via DEFAULT_STRUCTURED_GENERATION_PROVIDERS.
function fakeSnapshotManager(entries: ProviderSnapshotEntry[]) {
  return { listProviders: async () => entries };
}

const haikuEntry: ProviderSnapshotEntry = {
  provider: "claude",
  status: "ready" as ProviderSnapshotEntry["status"],
  enabled: true,
  models: [{ provider: "claude", id: "claude-haiku-4-5", label: "Claude Haiku 4.5" }],
};

describe("createAgentSummaryCompleter", () => {
  it("resolves REAL providers from the snapshot and passes them to the runner", async () => {
    let captured: readonly StructuredGenerationProvider[] | undefined;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      runText: async (opts) => {
        captured = opts.providers;
        return { text: "ok", provider: "claude", model: "claude-haiku-4-5" };
      },
    });

    const out = await completer("system", "user");

    // The completer returns the RAW agent text, verbatim (trimmed) — no schema.
    expect(out).toBe("ok");
    // The bug was an EMPTY providers array. It must be non-empty + include haiku.
    expect(captured && captured.length).toBeGreaterThan(0);
    expect(captured?.some((p) => p.model === "claude-haiku-4-5")).toBe(true);
    // Attribution: records the provider/model that actually ran.
    expect(completer.used.provider).toBe("claude");
    expect(completer.used.model).toBe("claude-haiku-4-5");
  });

  it("generates in a NEUTRAL cwd, not the passed project/channel cwd", async () => {
    // pi auto-loads project extensions/MCP from the agent's launch cwd, which let a
    // "Design Studio" extension pollute the summary. The internal gen must run in a
    // neutral empty dir under tmpdir — never the project cwd.
    const projectCwd = "/Users/me/projects/design-studio";
    let genCwd: string | undefined;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: projectCwd,
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      runText: async (opts) => {
        genCwd = opts.cwd;
        return { text: "clean summary", provider: "claude", model: "claude-haiku-4-5" };
      },
    });
    expect(await completer("s", "u")).toBe("clean summary");
    expect(genCwd).toBeDefined();
    expect(genCwd).not.toBe(projectCwd);
    expect(genCwd?.startsWith(tmpdir())).toBe(true);
  });

  it("returns the raw agent text trimmed", async () => {
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      runText: async () => ({
        text: "\n## Summary\n- point one\n- point two\n  ",
        provider: "claude",
        model: "claude-haiku-4-5",
      }),
    });
    expect(await completer("s", "u")).toBe("## Summary\n- point one\n- point two");
  });

  it("passes [] when no snapshot manager is available (solo fallback path)", async () => {
    let captured: readonly StructuredGenerationProvider[] | undefined;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: null,
      runText: async (opts) => {
        captured = opts.providers;
        return { text: "x", provider: "", model: null };
      },
    });

    await completer("s", "u");
    expect(captured).toEqual([]);
  });

  // Bug E: an EXPLICIT model choice must win and must NOT silently fall back to
  // Claude/haiku. The completer passes ONLY the chosen provider to the runner.
  it("honors an explicit selection and passes ONLY it (no auto fallback)", async () => {
    const opencodeEntry: ProviderSnapshotEntry = {
      provider: "opencode" as ProviderSnapshotEntry["provider"],
      status: "ready" as ProviderSnapshotEntry["status"],
      enabled: true,
      models: [{ provider: "opencode", id: "glm-5.1", label: "GLM 5.1" } as never],
    };
    let captured: readonly StructuredGenerationProvider[] | undefined;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      // Both opencode AND claude are available — but the explicit choice must win.
      providerSnapshotManager: fakeSnapshotManager([opencodeEntry, haikuEntry]),
      currentSelection: { provider: "opencode", model: "glm-5.1" },
      runText: async (opts) => {
        captured = opts.providers;
        return { text: "ok", provider: "opencode", model: "glm-5.1" };
      },
    });

    await completer("s", "u");
    expect(captured).toEqual([{ provider: "opencode", model: "glm-5.1" }]);
    expect(captured?.some((p) => p.provider === "claude")).toBe(false);
    expect(completer.used.provider).toBe("opencode");
  });

  // Bug E: if the chosen provider isn't available on the daemon, FAIL CLEARLY
  // instead of switching to Claude.
  it("throws a clear error when the explicit provider is unavailable (no silent switch)", async () => {
    let ran = false;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]), // only claude available
      currentSelection: { provider: "opencode", model: "glm-5.1" },
      runText: async () => {
        ran = true;
        return { text: "should-not-run", provider: "opencode", model: "glm-5.1" };
      },
    });

    await expect(completer("s", "u")).rejects.toThrow(/available on this daemon/i);
    expect(ran).toBe(false); // never fell through to a model
  });

  // ── Pi "Agent is already processing" contention (#286 follow-up) ──
  // With a live Pi session on the same daemon, the ephemeral completer can still
  // hit Pi's busy error at the shared model backend. It's transient — the completer
  // must wait for the busy turn to free and retry, so /summarize always lands.
  const PI_BUSY = new Error(
    "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
  );

  it("retries past a transient Pi 'already processing' contention and succeeds", async () => {
    let calls = 0;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      retryBudgetMs: 100_000, // plenty of budget
      busyRetryDelayMs: 0,
      sleep: async () => {}, // no real wait in tests
      runText: async () => {
        calls += 1;
        if (calls <= 2) throw PI_BUSY; // a live session holds the backend for 2 tries
        return { text: "summarized", provider: "claude", model: "claude-haiku-4-5" };
      },
    });

    // The completer must NOT propagate "already processing" — it waits + retries.
    await expect(completer("s", "u")).resolves.toBe("summarized");
    expect(calls).toBe(3);
  });

  it("respects the retry budget — fails CLEAN with a busy message, not a raw timeout", async () => {
    let calls = 0;
    let clock = 0;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      retryBudgetMs: 2500,
      busyRetryDelayMs: 1000,
      maxBusyDelayMs: 8000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms; // a "wait" advances the (virtual) wall clock
      },
      runText: async () => {
        calls += 1;
        throw PI_BUSY; // backend never frees
      },
    });

    // deadline = 0 + 2500. try0 → delay 1000 (0+1000<2500) → sleep, clock=1000.
    // try1 → delay 2000 (1000+2000=3000 ≥ 2500) → give up CLEAN before the budget.
    await expect(completer("s", "u")).rejects.toThrow(AI_BACKEND_BUSY_MESSAGE);
    expect(calls).toBe(2); // bounded by the budget, not a fixed attempt count
  });

  it("never retries longer than the budget even when delays are tiny", async () => {
    let calls = 0;
    let clock = 0;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      retryBudgetMs: 50,
      busyRetryDelayMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      runText: async () => {
        calls += 1;
        throw PI_BUSY;
      },
    });
    // delay 1000 already exceeds the 50ms budget → give up clean on the first miss.
    await expect(completer("s", "u")).rejects.toThrow(AI_BACKEND_BUSY_MESSAGE);
    expect(calls).toBe(1);
  });

  it("surfaces a non-busy generation error immediately (no retry)", async () => {
    let calls = 0;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      retryBudgetMs: 100_000,
      sleep: async () => {},
      runText: async () => {
        calls += 1;
        throw new Error("model timed out");
      },
    });

    await expect(completer("s", "u")).rejects.toThrow(/model timed out/i);
    expect(calls).toBe(1); // a real error is not retried
  });

  it("does not wait on the happy path (no contention)", async () => {
    let calls = 0;
    let slept = false;
    const completer = createAgentSummaryCompleter({
      manager: {} as AgentManager,
      cwd: "/tmp",
      providerSnapshotManager: fakeSnapshotManager([haikuEntry]),
      sleep: async () => {
        slept = true;
      },
      runText: async () => {
        calls += 1;
        return { text: "fast", provider: "claude", model: "claude-haiku-4-5" };
      },
    });

    await expect(completer("s", "u")).resolves.toBe("fast");
    expect(calls).toBe(1);
    expect(slept).toBe(false); // a fast /summarize never enters the retry/wait path
  });
});

describe("generateAgentText (raw-text runner)", () => {
  function scriptedManager(opts: {
    availability?: { provider: string; available: boolean; error: string | null }[];
    outputs: Record<string, { text?: string; throw?: Error }>;
  }) {
    const created: string[] = [];
    const closed: string[] = [];
    let lastProvider = "";
    let seq = 0;
    const manager = {
      listProviderAvailability: async () => opts.availability ?? [],
      createAgent: async (config: { provider: string }) => {
        lastProvider = config.provider;
        created.push(config.provider);
        return { id: `a${(seq += 1)}` };
      },
      runAgent: async () => {
        const o = opts.outputs[lastProvider];
        if (o?.throw) throw o.throw;
        return { sessionId: "s", finalText: o?.text ?? "", timeline: [], usage: undefined };
      },
      closeAgent: async (id: string) => {
        closed.push(id);
      },
    } as unknown as AgentManager;
    return { manager, created, closed };
  }

  const p = (provider: string, model?: string) => ({ provider: provider as AgentProvider, model });

  it("returns the first available provider's raw finalText + tears the agent down", async () => {
    const { manager, closed } = scriptedManager({
      availability: [{ provider: "claude", available: true, error: null }],
      outputs: { claude: { text: "hello world" } },
    });
    const r = await generateAgentText({
      manager,
      cwd: "/tmp",
      prompt: "go",
      providers: [p("claude", "claude-haiku-4-5")],
    });
    expect(r).toEqual({ text: "hello world", provider: "claude", model: "claude-haiku-4-5" });
    expect(closed).toHaveLength(1); // ephemeral session torn down
  });

  it("skips an unavailable provider and an empty response, then succeeds on the next", async () => {
    const { manager, created } = scriptedManager({
      availability: [
        { provider: "opencode", available: false, error: "not enabled" },
        { provider: "codex", available: true, error: null },
        { provider: "claude", available: true, error: null },
      ],
      outputs: { codex: { text: "   " }, claude: { text: "recovered" } },
    });
    const r = await generateAgentText({
      manager,
      cwd: "/tmp",
      prompt: "go",
      providers: [p("opencode"), p("codex"), p("claude")],
    });
    expect(r.text).toBe("recovered");
    expect(r.provider).toBe("claude");
    expect(created).toEqual(["codex", "claude"]); // opencode skipped (unavailable)
  });

  it("propagates a busy error immediately (so the caller can budget-retry)", async () => {
    const busy = new Error("Agent is already processing. Specify streamingBehavior.");
    const { manager } = scriptedManager({
      availability: [{ provider: "claude", available: true, error: null }],
      outputs: { claude: { throw: busy } },
    });
    await expect(
      generateAgentText({ manager, cwd: "/tmp", prompt: "go", providers: [p("claude")] }),
    ).rejects.toThrow(/already processing/i);
  });

  it("throws when every provider fails", async () => {
    const { manager } = scriptedManager({
      availability: [{ provider: "claude", available: true, error: null }],
      outputs: { claude: { throw: new Error("boom") } },
    });
    await expect(
      generateAgentText({ manager, cwd: "/tmp", prompt: "go", providers: [p("claude")] }),
    ).rejects.toThrow(/AI generation failed for all providers/i);
  });
});

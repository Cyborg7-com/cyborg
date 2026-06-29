// Wires the pure summarization service to real LLM inference on the daemon.
//
// The five slash AI commands (summarize / action-items / standup / translate /
// ask) all produce plain text / markdown, so this captures the agent's RAW text
// response (the Paseo path: manager.runAgent → finalText) instead of forcing
// structured JSON. The earlier { summary: string } schema added nothing and made
// weak models (e.g. glm-5.1, which answers in prose) fail the JSON-schema check.
//
// Each completion runs in a fresh ephemeral, internal (tools-off,
// persistSession:false → --no-session) agent session and is torn down afterward,
// so independent MAP chunks get clean context and never re-prompt a streaming
// session (the #286/#327 contention fix). Provider resolution + cheap-model-first
// fallback (claude/haiku → codex → opencode) are unchanged.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { StructuredGenerationProvider } from "../agent/agent-response-loop.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type {
  AgentProvider,
  AgentRunResult,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "../agent/structured-generation-providers.js";
import type { Completer } from "./summarization.js";
import { ensureInternalCodexHome } from "./codex-internal-home.js";

export interface AgentSummaryCompleterOptions {
  manager: AgentManager;
  cwd: string;
  // Resolving real providers from the live catalog is REQUIRED for the AI
  // commands to run: without it `providers` was [], so generation had zero
  // candidates and failed every time. The dispatcher threads the daemon's
  // snapshot manager through here. Left optional only so a caller with no daemon
  // (tests) can still construct a completer.
  providerSnapshotManager?: Pick<ProviderSnapshotManager, "listProviders"> | null;
  // Daemon's configured metadata-generation providers (cheap-model-first). Optional
  // — without it the built-in defaults (haiku → gpt-5.4-mini → …) still resolve.
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  // The user's EXPLICIT model choice (from the slash-command model selector). When
  // set it wins over the auto-resolved defaults; when absent we auto-resolve.
  currentSelection?: {
    provider?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  } | null;
  // Daemon logger so provider-resolution errors reach daemon.log (#736) instead of
  // the supervisor's /dev/null. Optional — a test caller may omit it.
  logger?: Logger | null;
  // Injectable text generator (tests). Defaults to the real ephemeral-agent runner.
  runText?: (opts: RunTextOptions) => Promise<RunTextResult>;
  // Pi (and other RPC agent backends) reject a prompt sent while a session on the
  // same daemon is mid-turn: "Agent is already processing. Specify
  // streamingBehavior…". The completer runs an ephemeral session (--no-session,
  // #286) but can still contend at the shared model backend when the user has a
  // live Pi session. That contention is TRANSIENT — the user's turn ends shortly —
  // so the busy error is retryable: wait for the backend to free and try again.
  //
  // The retry is bounded by a WALL-CLOCK budget (retryBudgetMs), NOT a fixed
  // attempt count, so it stays inside the slash command's overall timeout — the
  // dispatcher derives this from the same constant it uses for the hard timeout,
  // so the two can't drift. When the budget runs out while still contended, the
  // completer fails CLEAN with AI_BACKEND_BUSY_MESSAGE instead of letting the
  // command hit a raw "timed out" error.
  retryBudgetMs?: number; // total wall-clock for contention waits (default 110_000)
  busyRetryDelayMs?: number; // base delay, linear backoff (default 1000ms)
  maxBusyDelayMs?: number; // delay cap (default 8000ms)
  sleep?: (ms: number) => Promise<void>; // injectable (tests)
  now?: () => number; // injectable clock (tests)
}

// Monotonic id for correlating ephemeral-completion log lines (in-flight overlap).
let completionLogSeq = 0;

// Surfaced (instead of a raw timeout) when the shared model backend stays busy
// for the whole retry budget — tells the user it's transient and to retry.
export const AI_BACKEND_BUSY_MESSAGE =
  "The AI backend is busy with another session — try again in a moment.";

// Pi's RPC server rejects a prompt to an agent that is mid-turn with the message
// below; the wording ("streamingBehavior") is Pi-specific. Used to detect the
// transient cross-session contention (vs a real generation failure, which must
// surface immediately rather than being masked behind retries).
const AGENT_BUSY_RE = /already processing|streamingBehavior/i;
export function isAgentBusyError(err: unknown): boolean {
  return err instanceof Error && AGENT_BUSY_RE.test(err.message);
}

// Neutral, project-free working directory for the INTERNAL summarizer agent.
// Pi auto-loads project extensions AND MCP adapters from its LAUNCH CWD (pi/agent
// createSession: prepareMcpConfig(cwd) + always-injected extensions). Running the
// summarizer in the project/channel cwd (or even HOME — it can hold a global pi
// config) let a project extension (e.g. "Design Studio" / Style Dictionary) inject
// {"continue":true,"systemMessage":"…detected project context…"} into the output.
// An EMPTY dedicated dir under tmpdir has no project config, so pi auto-loads
// nothing — the summary is the model's clean text only. Created once, reused (the
// session is --no-session, so concurrent map chunks sharing this cwd is fine).
let internalGenCwdCache: string | undefined;
function internalGenCwd(): string {
  if (internalGenCwdCache) return internalGenCwdCache;
  const dir = join(tmpdir(), "cyborg7-internal-gen");
  mkdirSync(dir, { recursive: true });
  internalGenCwdCache = dir;
  return dir;
}

// Env overlay isolating the internal generation from the user's GLOBAL provider
// config. CODEX_HOME → an isolated Codex home (auth mirrored, no config.toml /
// instructions / mcp_servers) so a Codex summarizer comes out clean; harmless for
// non-Codex providers. (Pi's global-extension isolation is handled provider-side via
// #345's --no-extensions; Claude remains a documented follow-up.) Resolved once per
// process; the Codex key is omitted when isolation can't be set up.
let internalCodexHomeResolved: string | null | undefined;
function internalProviderEnv(): Record<string, string> | undefined {
  if (internalCodexHomeResolved === undefined) {
    internalCodexHomeResolved = ensureInternalCodexHome({});
  }
  return internalCodexHomeResolved ? { CODEX_HOME: internalCodexHomeResolved } : undefined;
}

// ─── Raw-text generation (no schema) ───────────────────────────────

export interface RunTextOptions {
  manager: AgentManager;
  cwd: string;
  prompt: string;
  providers: readonly StructuredGenerationProvider[];
  agentConfigOverrides?: { title?: string | null; internal?: boolean };
  persistSession?: boolean;
  // Env overlay for the ephemeral agent process. Used to set CODEX_HOME to the
  // isolated Codex home so the internal Codex loads NO global config.toml
  // (mcp_servers/instructions) while keeping the user's auth. Pi isolation is handled
  // provider-side (#345 --no-extensions). No-op for providers that ignore CODEX_HOME.
  env?: Record<string, string>;
}

export interface RunTextResult {
  text: string;
  provider: string;
  model: string | null;
}

function describeCandidate(c: StructuredGenerationProvider): string {
  return c.model ? `${c.provider} (${c.model})` : c.provider;
}

function extractAgentText(result: AgentRunResult): string {
  if (typeof result.finalText === "string" && result.finalText.trim().length > 0) {
    return result.finalText.trim();
  }
  // Fallback for providers that don't populate finalText consistently.
  const lastAssistant = result.timeline.findLast((item) => item.type === "assistant_message");
  return (lastAssistant?.text ?? "").trim();
}

// Run the prompt on the first available provider that returns text, in a fresh
// ephemeral session per candidate (created → ONE runAgent → closed; never a
// re-prompt of a live session). Returns the raw text + which provider produced it.
// A "busy" contention error propagates immediately so the caller's wall-clock
// budget can retry from the top rather than burning the remaining providers on it.
export async function generateAgentText(opts: RunTextOptions): Promise<RunTextResult> {
  const { manager, cwd, prompt, providers, agentConfigOverrides, persistSession, env } = opts;
  const availability = await manager.listProviderAvailability();
  const availabilityByProvider = new Map(availability.map((entry) => [entry.provider, entry]));
  const failures: string[] = [];

  for (const candidate of providers) {
    const entry = availabilityByProvider.get(candidate.provider);
    if (entry && !entry.available) {
      failures.push(
        `${describeCandidate(candidate)}: unavailable${entry.error ? ` (${entry.error})` : ""}`,
      );
      continue;
    }

    let agentId: string | undefined;
    try {
      const config: AgentSessionConfig = {
        ...agentConfigOverrides,
        provider: candidate.provider,
        cwd,
        ...(candidate.model ? { model: candidate.model } : {}),
        ...(candidate.thinkingOptionId ? { thinkingOptionId: candidate.thinkingOptionId } : {}),
      };
      const agent = await manager.createAgent(config, undefined, {
        persistSession: persistSession ?? false,
        ...(env ? { env } : {}),
      });
      agentId = agent.id;
      const result = await manager.runAgent(agent.id, prompt);
      const text = extractAgentText(result);
      if (text.length > 0) {
        return { text, provider: candidate.provider, model: candidate.model ?? null };
      }
      failures.push(`${describeCandidate(candidate)}: empty response`);
    } catch (err) {
      if (isAgentBusyError(err)) throw err; // transient — let the caller budget-retry
      failures.push(
        `${describeCandidate(candidate)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // A failed close doesn't change the generation outcome already decided above.
      // intentional: best-effort cleanup of the ephemeral summarization agent.
      if (agentId) await manager.closeAgent(agentId).catch(() => {});
    }
  }

  throw new Error(
    failures.length > 0
      ? `AI generation failed for all providers: ${failures.join("; ")}`
      : "AI generation failed: no provider available on this daemon",
  );
}

// What the completer resolved + ran. Updated to the provider/model that actually
// produced the text; pre-seeded with the resolved primary candidate so attribution
// exists even if generation then fails. Used to attribute the posted result to the
// real provider/model instead of "Assistant".
export interface CompleterUsed {
  provider?: string;
  model?: string | null;
}

// Resolve the provider candidates the completer will run, honoring an EXPLICIT
// user choice (#bug E). Extracted from the completer to keep its complexity down.
async function resolveCompleterProviders(opts: {
  cwd: string;
  providerSnapshotManager?: Pick<ProviderSnapshotManager, "listProviders"> | null;
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  currentSelection?: {
    provider?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  } | null;
  logger?: Logger | null;
}): Promise<StructuredGenerationProvider[]> {
  const { cwd, providerSnapshotManager, daemonConfig, currentSelection, logger } = opts;
  const explicitProvider = currentSelection?.provider ?? null;

  if (explicitProvider) {
    // EXPLICIT choice MUST win and must NOT silently fall back to Claude/haiku
    // if it can't run. Verify it's enabled on THIS daemon, then pass ONLY it (a
    // single-candidate list) so a failure surfaces as a clear error.
    if (providerSnapshotManager) {
      const entries = await providerSnapshotManager.listProviders({ cwd, wait: true });
      const wanted = explicitProvider.toLowerCase();
      if (!entries.some((e) => e.enabled && e.provider.toLowerCase() === wanted)) {
        logger?.error(
          { provider: explicitProvider },
          "[slash] selected provider not available/enabled on this daemon — refusing to fall back",
        );
        throw new Error(
          `The selected model's provider "${explicitProvider}" isn't available on this daemon. ` +
            `Pick an available model, or clear the override to auto-select.`,
        );
      }
    }
    console.log(
      `[slash] honoring explicit model ${explicitProvider}/${currentSelection?.model ?? "(default)"} — no fallback`,
    );
    return [
      {
        provider: explicitProvider as AgentProvider,
        ...(currentSelection?.model ? { model: currentSelection.model } : {}),
        ...(currentSelection?.thinkingOptionId
          ? { thinkingOptionId: currentSelection.thinkingOptionId }
          : {}),
      },
    ];
  }

  // No explicit choice → auto-resolve (cheap-model-first: haiku → … → fallbacks).
  const providers = providerSnapshotManager
    ? await resolveStructuredGenerationProviders({
        cwd,
        providerSnapshotManager,
        daemonConfig: daemonConfig ?? undefined,
      })
    : [];
  console.log(
    `[slash] auto-resolving model; primary=${providers[0]?.provider ?? "(agent default)"}/${providers[0]?.model ?? ""}`,
  );
  return providers;
}

// Build a Completer backed by ephemeral internal agent sessions. The returned
// function carries a mutable `used` ref, populated when it runs.
export function createAgentSummaryCompleter(
  options: AgentSummaryCompleterOptions,
): Completer & { used: CompleterUsed } {
  const { manager, cwd, providerSnapshotManager, daemonConfig, currentSelection, logger } = options;
  const runText = options.runText ?? generateAgentText;
  const retryBudgetMs = options.retryBudgetMs ?? 110_000;
  const baseDelayMs = options.busyRetryDelayMs ?? 1000;
  const maxDelayMs = options.maxBusyDelayMs ?? 8000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const used: CompleterUsed = {};
  // In-flight ephemeral completions for THIS completer (one /summarize). MAP chunks
  // share this completer, so this counts concurrent chunk-agents — logged so the
  // next repro shows whether completions overlap (in-flight>1) or run sequentially.
  let inFlight = 0;
  // Contention deadline, anchored NOW (at completer creation) and SHARED across
  // chunks, so a map-reduce summary's total contention waits stay inside the one
  // budget (the slash command's timeout) instead of each chunk getting a fresh
  // budget. Anchoring here — not on the first completion — means time spent in the
  // async provider resolution still counts against the budget; setting it later
  // could push the deadline PAST the dispatcher's hard timeout (slow resolution >
  // margin) and surface a raw timeout instead of the clean busy message.
  const deadlineAt = now() + retryBudgetMs;
  const complete: Completer = async (system, user) => {
    const providers = await resolveCompleterProviders({
      cwd,
      providerSnapshotManager,
      daemonConfig,
      currentSelection,
      logger,
    });

    // Record the resolved primary candidate for attribution (before generation, so
    // it's set even if generation then fails).
    const primary = providers[0] ?? null;
    if (primary) {
      used.provider = primary.provider;
      used.model = primary.model ?? null;
    }

    // Retry policy:
    //  - transient "agent is already processing" contention → wait (budget-bounded).
    //  - any other failure surfaces immediately (retries must not mask real errors).
    // The happy path (no contention) returns on the first attempt and never waits.
    let busyAttempt = 0;
    for (;;) {
      const callId = (completionLogSeq += 1);
      inFlight += 1;
      // Log only on the real daemon path (no injected runText) to keep tests quiet.
      if (!options.runText) {
        console.log(
          `[slash] summarizer completion #${callId} start (in-flight=${inFlight}, provider=${used.provider ?? "?"}/${used.model ?? "?"})`,
        );
      }
      try {
        const result = await runText({
          manager,
          // Generate in a NEUTRAL empty cwd (NOT the project/channel/HOME cwd) so
          // pi can't auto-load project extensions/MCP into the summary. `cwd` (the
          // option) is still used for provider RESOLUTION above (host catalog).
          cwd: internalGenCwd(),
          prompt: `${system}\n\n${user}`,
          providers,
          persistSession: false,
          // Isolate the internal Codex from the user's GLOBAL config.toml
          // (mcp_servers/instructions) by pointing CODEX_HOME at a mirror home with
          // no config. Auth stays (mirrored). Real daemon path only — skipped under an
          // injected runText so tests stay pure. No-op for non-Codex providers.
          ...(options.runText ? {} : { env: internalProviderEnv() }),
          // No mcpServers here → the internal gen never inherits the cybo/project
          // MCP servers; combined with the empty cwd, pi's prepareMcpConfig finds
          // no adapter and attaches nothing.
          agentConfigOverrides: { title: "Summarizer", internal: true },
        });
        // Attribute to the provider that actually produced the text (the resolved
        // primary is only a best guess until generation runs).
        if (result.provider) {
          used.provider = result.provider;
          used.model = result.model;
        }
        return result.text.trim();
      } catch (err) {
        if (isAgentBusyError(err)) {
          const delay = Math.min(baseDelayMs * (busyAttempt + 1), maxDelayMs);
          // Out of budget: fail CLEAN now rather than waiting into the hard timeout.
          if (now() + delay >= deadlineAt) throw new Error(AI_BACKEND_BUSY_MESSAGE, { cause: err });
          await sleep(delay);
          busyAttempt += 1;
          continue;
        }
        throw err;
      } finally {
        inFlight -= 1;
      }
    }
  };
  return Object.assign(complete, { used });
}

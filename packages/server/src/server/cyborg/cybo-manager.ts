import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DualStorage } from "./dual-storage.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig, McpServerConfig } from "../agent/agent-sdk-types.js";
import { CYBO_CODEX_APPROVAL_POLICY } from "./cybo-types.js";
import type { StoredCybo } from "./cybo-types.js";
import type { AuditSink } from "./audit-sink.js";
import { getNav } from "./docs-index.js";
import { hasSourceAccess } from "./source-index.js";

// The context/tool snapshot the spawn audit captures (#995) — the ONE new emit.
// Computed from the values spawnCybo already built (the systemPrompt + mcpServers
// it injects), with secrets redacted DOWNSTREAM by the audit formatter. Factored
// out so spawnCybo's cyclomatic complexity stays in budget.
// Assemble the cybo's MCP server map: its own `mcp_servers` (if any) + the
// injected `cyborg7` base url (scoped to this workspace/agent). Extracted from
// spawnCybo to keep its cyclomatic complexity in budget.
function buildCyboMcpServers(
  cybo: StoredCybo,
  cyborg7McpBaseUrl: string | undefined,
  workspaceId: string,
  agentId: string,
): Record<string, McpServerConfig> {
  const mcpServers: Record<string, McpServerConfig> = cybo.mcp_servers
    ? JSON.parse(cybo.mcp_servers)
    : {};
  if (cyborg7McpBaseUrl) {
    const url = `${cyborg7McpBaseUrl}?workspaceId=${encodeURIComponent(workspaceId)}&agentId=${encodeURIComponent(agentId)}`;
    mcpServers.cyborg7 = { type: "http" as const, url };
  }
  return mcpServers;
}

// Assemble the AgentSessionConfig for a cybo spawn. Extracted from spawnCybo so
// the several provider-conditional spreads (bypassPermissions for unattended
// claude, model, mcpServers, internal-for-ephemeral) don't inflate spawnCybo's
// cyclomatic complexity. Behavior is byte-identical to the prior inline object.
function buildCyboAgentConfig(opts: {
  harness: CyboHarness;
  cwd: string;
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
  ephemeral: boolean | undefined;
  unattended: boolean | undefined;
}): AgentSessionConfig {
  const { harness, cwd, systemPrompt, mcpServers, ephemeral, unattended } = opts;
  return {
    provider: harness.provider,
    cwd,
    systemPrompt,
    // Valid Codex variant (NOT the legacy "auto", which codex-app-server rejects
    // on turn 1). Claude/Pi providers ignore this field.
    approvalPolicy: CYBO_CODEX_APPROVAL_POLICY,
    // Claude analogue: an EPHEMERAL or UNATTENDED claude cybo runs with no human to
    // answer canUseTool, so it must bypass permissions or its tool calls hang
    // forever (the watcher/scheduled-run "did not settle cleanly" path). Only the
    // Claude provider reads modeId; codex uses approvalPolicy and pi ignores it.
    ...((ephemeral || unattended) && harness.provider === "claude"
      ? { modeId: "bypassPermissions" }
      : {}),
    ...(harness.model ? { model: harness.model } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    // Ephemeral summons (slash commands, @-mentions) are INTERNAL agents (hidden
    // from listAgents, skipped in replay, never archived) — the reply still reaches
    // the channel via the cyborg7 MCP tools, so nothing user-visible is lost.
    ...(ephemeral ? { internal: true } : {}),
  };
}

const PROMPT_PREVIEW_CHARS = 280;
function emitSpawnAudit(opts: {
  auditSink: AuditSink | undefined;
  systemPrompt: string;
  mcpServers: Record<string, McpServerConfig>;
  cyborg7McpBaseUrl: string | undefined;
  cybo: StoredCybo;
  agentId: string;
  workspaceId: string;
  channelId: string | null;
  userId: string;
}): void {
  const { auditSink, systemPrompt, mcpServers, cybo, agentId, workspaceId, channelId, userId } =
    opts;
  // No-op when no sink is wired (existing callers/tests stay byte-identical). The
  // guard lives here so spawnCybo stays a straight-line call (complexity budget).
  if (!auditSink) return;
  const ids = { agentId, cyboId: cybo.id, workspaceId, channelId, userId } as const;
  // Context: prompt preview + length + hash prefix — NEVER the full prompt.
  auditSink.emit({
    kind: "spawn.context",
    category: "context_injection",
    level: "info",
    ...ids,
    message: `Context injected for ${cybo.name}`,
    payload: {
      promptPreview: systemPrompt.slice(0, PROMPT_PREVIEW_CHARS),
      promptLength: systemPrompt.length,
      promptSha256: createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12),
      provider: cybo.provider,
      model: cybo.model,
      soulSource: cybo.id.startsWith("local:") ? "local-disk" : "workspace",
    },
  });
  // Tools: the injected MCP server names + the cyborg7 base url (host+path only —
  // the formatter strips the `?...` query where the scoped agentId/token rides).
  auditSink.emit({
    kind: "spawn.tools",
    category: "tool_injection",
    level: "info",
    ...ids,
    message: `Tools injected for ${cybo.name}`,
    payload: {
      mcpServers: Object.keys(mcpServers),
      ...(opts.cyborg7McpBaseUrl ? { cyborg7Url: opts.cyborg7McpBaseUrl } : {}),
    },
  });
}

const LOCAL_AGENTS_DIR = join(homedir(), ".cybo", "agents");

export interface SpawnCyboResult {
  agentId: string;
  cyboId: string;
  cyboSlug: string;
  provider: string;
  model: string | null;
  systemPrompt: string;
}

export interface SpawnCyboContext {
  workspaceName?: string;
  channelName?: string;
  channelId?: string;
  cwd?: string;
}

// Always-on docs-awareness contribution (mirrors OpenClaw's "read local docs
// first" system-prompt section). Tells every cybo the product documentation is
// reachable at runtime via the `cyborg7_read_docs` MCP tool and that it should
// consult it BEFORE answering "how do I…?" from memory. The section labels are
// embedded (fail-soft) so the cybo can jump straight to a relevant area; when the
// corpus can't be resolved the labels line is simply omitted. The tool itself is
// always registered, so the guidance is safe to include unconditionally.
export function buildDocsAwarenessSection(): string {
  const lines = [
    "## Product documentation",
    "The Cyborg7 product documentation is available to you at runtime through the " +
      "`cyborg7_read_docs` MCP tool (the same guides published at docs.cyborg7.com).",
    'When the user asks "how do I…?" — or anything about using Cyborg7 (tasks, mentions, ' +
      "channels, scheduling, cybos, connecting an integration, sign-up) — call " +
      "`cyborg7_read_docs` FIRST (mode 'nav' or 'search' to find the guide, then 'get' its " +
      "slug) and answer from the guide's steps before relying on memory.",
  ];

  // Embed the section labels so the cybo can browse straight to an area. Fail-soft:
  // getNav() returns [] when the corpus can't be resolved.
  const sections = getNav()
    .map((s) => s.label)
    .filter(Boolean);
  if (sections.length > 0) {
    lines.push(`Doc sections: ${sections.join(", ")}.`);
  }
  lines.push(
    "To connect an integration (Composio, Slack, Google/Gmail, Jira, ClickUp), read its " +
      "connect guide: mode 'get' with slug 'integration:<id>' (e.g. 'integration:gmail').",
  );

  // Self-source access is only offered when the daemon runs from a git checkout.
  if (hasSourceAccess()) {
    lines.push(
      "For deep questions about Cyborg7's own implementation that the docs don't cover, the " +
        "`cyborg7_read_source` tool can read repository files (read-only).",
    );
  }
  return lines.join("\n");
}

export function buildCyboPrompt(cybo: StoredCybo, context?: SpawnCyboContext): string {
  const parts: string[] = [];

  if (cybo.role) {
    parts.push(`You are ${cybo.name}, a ${cybo.role}.`);
  } else {
    parts.push(`You are ${cybo.name}.`);
  }

  if (cybo.description) parts.push(cybo.description);
  parts.push("");
  parts.push(cybo.soul);

  if (context?.workspaceName) {
    parts.push(`\nYou are in workspace "${context.workspaceName}".`);
  }
  if (context?.channelName) {
    // Medium context (Bug T1): state WHERE the cybo is speaking so its reply lands
    // in the same place it was invoked. A channel is public to all members — reply
    // here, never silently redirect to a different channel or a DM. (A private 1:1
    // DM turn reuses a channel-bound session, so its medium is injected per-turn in
    // MessageRouter.handleDm instead of baked into this spawn-time system prompt.)
    parts.push(`Current channel: ${context.channelName}.`);
    parts.push(
      `You are speaking in the group channel "${context.channelName}" — your reply is ` +
        `posted to that channel, visible to everyone in it. Reply in this channel; do ` +
        `not post to another channel or DM unless explicitly asked.`,
    );
  }

  // Always-on: point the cybo at the product docs (and, in a checkout, its source)
  // so it consults them proactively. Kept LAST so it never shifts the identity/
  // soul/context ordering the spawn contract (and tests) depend on.
  parts.push("");
  parts.push(buildDocsAwarenessSection());

  return parts.join("\n");
}

// Serialize the assembled MCP server map into the capture shape — the "tools
// made available" to an ephemeral session (#994). We persist the server CONFIGS
// (name, type, scoped url, toolkit restriction), NOT the provider's runtime-
// resolved tool enumeration (not knowable at spawn). Secret redaction happens at
// READ time in the dispatcher, not here, so the raw capture stays faithful.
export function serializeMcpServersForCapture(mcpServers: Record<string, McpServerConfig>): string {
  const entries = Object.entries(mcpServers).map(([name, cfg]) => {
    const c = cfg as unknown as Record<string, unknown>;
    const entry: { name: string; type: string; url?: string; toolkit?: string } = {
      name,
      type: typeof c.type === "string" ? c.type : "unknown",
    };
    if (typeof c.url === "string") entry.url = c.url;
    if (typeof c.toolkit === "string") entry.toolkit = c.toolkit;
    return entry;
  });
  return JSON.stringify(entries);
}

// Persist an ephemeral session's injected context at spawn (#994). The routed/
// raw prompt is threaded in later (message-router.routeToAgent); this captures
// the system prompt + the tools MADE AVAILABLE. No-op when not ephemeral so the
// caller stays branch-free (keeps spawnCybo's cyclomatic complexity in budget).
function captureEphemeralSpawnContext(
  storage: DualStorage,
  ephemeral: boolean | undefined,
  row: {
    agentId: string;
    workspaceId: string;
    channelId: string | null;
    cyboId: string | null;
    systemPrompt: string;
    mcpServers: Record<string, McpServerConfig>;
  },
): void {
  if (!ephemeral) return;
  storage.saveEphemeralSessionContext({
    agentId: row.agentId,
    workspaceId: row.workspaceId,
    channelId: row.channelId,
    cyboId: row.cyboId,
    systemPrompt: row.systemPrompt,
    mcpServersJson: serializeMcpServersForCapture(row.mcpServers),
  });
}

export async function resolveCybo(
  storage: DualStorage,
  workspaceId: string,
  idOrSlug: string,
): Promise<StoredCybo | undefined> {
  const byId = storage.getCybo(idOrSlug);
  if (byId) return byId;
  const bySlug = storage.getCyboBySlug(workspaceId, idOrSlug);
  if (bySlug) return bySlug;
  return resolveLocalCybo(idOrSlug);
}

// Each cybo runs in its OWN sandboxed working dir under ~/.cybo/agents/<cyboId>
// — NOT the user's HOME — both for isolation/security and to keep the agent from
// loading the whole home tree into context. A literal "~" from the client counts
// as "unspecified": node's child spawn does NOT expand ~, so cwd:"~" used to
// ENOENT and the spawn failed silently ("Start chat does nothing"). An explicit
// real path is still honored (resolved).
function resolveCyboCwd(cyboId: string, requested: string | undefined): string {
  if (requested && requested !== "~" && requested !== "~/") return resolve(requested);
  return join(LOCAL_AGENTS_DIR, cyboId);
}

// ─── Provider IS the harness (internal docs) ─────────────────────────────────
// The harness resolution moved to ./cybo-harness.ts (a zero-dep pure module) so
// the relay's mention orchestrator can import it without dragging cybo-manager's
// daemon-side surface (#697). Re-exported here so this stays the canonical home
// and existing importers are unaffected. The soul travels identically on every
// route: buildCyboPrompt → AgentSessionConfig.systemPrompt, which the Claude
// provider APPENDS to its claude_code preset and the runtime passes through —
// the cybo introduces itself as the cybo, never as the harness.
export { NATIVE_CYBO_HARNESSES, resolveCyboHarness, type CyboHarness } from "./cybo-harness.js";
import { resolveCyboHarness, type CyboHarness } from "./cybo-harness.js";
import type { CyboCredentialStore } from "./cybo-credentials.js";
import { resolveCyboCredentialPlan } from "./cybo-openai-compatible.js";
import { composioMcpForSpawn, parseCyboToolGrants } from "./composio-spawn.js";
import { buildComposioRouterMcpServer } from "./composio-mcp.js";
import type { ComposioDeps } from "./composio-deps.js";
import type { Logger } from "pino";

// Re-exported so the spawn-failure paths (dispatcher / message-router) can
// recognize the pre-spawn credential refusal and surface it to the author.
export { CyboCredentialMissingError } from "./cybo-openai-compatible.js";

// Phase 3 (internal docs): resolve the env the spawn injects via createAgent({
// env }). Returns `undefined` (omit the key) for every non-openai-compatible
// cybo, so native/stock-PI spawns are byte-identical to pre-P3. Throws
// CyboCredentialMissingError for an openai-compatible + api cybo with no key.
// Factored out of spawnCybo to keep its cyclomatic complexity in budget.
async function resolveSpawnCredentialEnv(args: {
  cybo: StoredCybo;
  harness: CyboHarness;
  cwd: string;
  credentialStore: CyboCredentialStore | undefined;
  logger: Pick<Logger, "info" | "warn"> | undefined;
}): Promise<Record<string, string> | undefined> {
  const plan = await resolveCyboCredentialPlan(args);
  return Object.keys(plan.env).length > 0 ? plan.env : undefined;
}

// Resolve + merge a cybo's Composio MCP servers into `mcpServers` at spawn. Pulled
// out of spawnCybo to keep its complexity bounded. Strict no-op when the cybo has no
// tool_grants or no composio dep is wired — the binding resolves which toolkits this
// run may use and AS WHOM (the invoker's own account for `caller`, the workspace's for
// `service`); approval-gated (Tier-2) actions are deliberately NOT mounted here. A
// per-toolkit mint failure is logged, never fatal.
async function injectComposioMcpServers(opts: {
  cybo: StoredCybo;
  composio?: ComposioDeps;
  autonomous?: boolean;
  workspaceId: string;
  userId: string;
  mcpServers: Record<string, McpServerConfig>;
  logger?: Pick<Logger, "info" | "warn">;
}): Promise<void> {
  if (!opts.composio || !opts.cybo.tool_grants) return;
  // A cybo opts into Composio by carrying composio tool_grants; an empty/garbled
  // grant set is a strict no-op regardless of transport.
  if (parseCyboToolGrants(opts.cybo.tool_grants).composio.length === 0) return;

  // Transport B (consumer router / ck_, the decided v1 path): inject the router as a
  // single MCP server. Composio restricts to connected toolkits (toolkit-level) — no
  // per-action minting, no connection store, no daemon-side gateway. Preferred when a
  // router key is wired.
  if (opts.composio.router) {
    Object.assign(opts.mcpServers, buildComposioRouterMcpServer(opts.composio.router));
    return;
  }

  // Transport A (Platform API): mint per-action-scoped MCP URLs per toolkit. Requires
  // a client + connection store; absent ⇒ skip (Composio simply doesn't mount).
  if (!opts.composio.client || !opts.composio.connections) return;
  const { servers, failures } = await composioMcpForSpawn({
    toolGrantsRaw: opts.cybo.tool_grants,
    connections: opts.composio.connections,
    client: opts.composio.client,
    workspaceId: opts.workspaceId,
    cyboId: opts.cybo.id,
    invokerUserId: opts.autonomous ? null : opts.userId,
  });
  Object.assign(opts.mcpServers, servers);
  if (failures.length > 0) {
    opts.logger?.warn({ failures }, "composio: some tools failed to mount; spawning without them");
  }
}

// oxlint-disable-next-line eslint/complexity -- pre-existing over-budget spawn assembler; #994 only adds a single branch-free capture call (extracted to captureEphemeralSpawnContext)
export async function spawnCybo(opts: {
  storage: DualStorage;
  agentManager: AgentManager;
  workspaceId: string;
  cyboIdOrSlug: string;
  userId: string;
  // The human initiator's REAL (canonical cloud) email, threaded from the
  // spawning caller's auth. Stored on the (non-ephemeral) binding's PG mirror so
  // the offline visibility filter attributes the cybo session to its initiator —
  // the daemon's local <id>@remote.local placeholder never matches (#810). Absent
  // for autonomous/scheduled spawns (no human at the keyboard); those rows fall
  // back to the GLOBAL-id match in the filter.
  initiatedByEmail?: string | null;
  serverId?: string;
  cyborg7McpBaseUrl?: string;
  context?: SpawnCyboContext;
  // When true, the binding is marked ephemeral: the agent runs one turn for a
  // slash command and is torn down on turn completion (see message-router).
  ephemeral?: boolean;
  // When true, the cybo runs UNATTENDED (no human at the keyboard to answer a
  // permission prompt) but stays a VISIBLE agent session — e.g. a scheduled run.
  // Like ephemeral, a claude cybo gets modeId:bypassPermissions so its tool calls
  // (post the reminder, etc.) execute immediately instead of blocking forever on
  // canUseTool. Unlike ephemeral it is NOT internal, so it still shows in the
  // Agents sidebar / listAgents.
  unattended?: boolean;
  // Relay-enriched cybo (cloud): used as-is so a daemon whose local SQLite lacks
  // the cybo can still spawn it (the relay resolved it from PG). Falls back to a
  // local lookup when absent (solo / direct-daemon mode).
  resolvedCybo?: StoredCybo;
  // Phase 3 (internal docs): the per-daemon credential store. Consulted ONLY for
  // an `openai-compatible` + `api` cybo (MiniMax/OpenRouter) — every other cybo
  // ignores it entirely (the store is never read), so native/stock-PI spawns are
  // byte-identical with or without this param. When absent, an openai-compatible
  // api cybo refuses pre-spawn (CyboCredentialMissingError).
  credentialStore?: CyboCredentialStore;
  // Composio third-party tools (knowledge: composio-ownership-and-permissions).
  // Consulted ONLY for a cybo carrying `tool_grants` — every other spawn ignores it
  // entirely (byte-identical). Absent ⇒ Composio tools are skipped.
  composio?: ComposioDeps;
  // An autonomous run (scheduled / webhook) has no human invoker, so caller-bound
  // Composio toolkits are dropped (only `service` bindings run unattended).
  autonomous?: boolean;
  logger?: Pick<Logger, "info" | "warn">;
  // #995: the audit re-route seam. When provided, spawnCybo emits a redacted
  // context_injection + tool_injection event after createAgent. `undefined` ⇒
  // no-op, so existing callers/tests are byte-identical.
  auditSink?: AuditSink;
}): Promise<SpawnCyboResult> {
  const {
    storage,
    agentManager,
    workspaceId,
    cyboIdOrSlug,
    userId,
    initiatedByEmail,
    serverId,
    cyborg7McpBaseUrl,
    context,
    ephemeral,
    unattended,
    resolvedCybo,
    credentialStore,
    composio,
    autonomous,
    logger,
    auditSink,
  } = opts;

  const cybo = resolvedCybo ?? (await resolveCybo(storage, workspaceId, cyboIdOrSlug));
  if (!cybo) {
    throw new CyboNotFoundError(cyboIdOrSlug);
  }

  // Denormalize the cybo into local SQLite so getCybo resolves its display name +
  // avatar for the messages it posts (otherwise a cloud @-mention reply renders as
  // the raw agent UUID, not "Apex" with its photo). persistCybo is best-effort: it
  // is idempotent and reconciles a stale same-slug row, but guard defensively so
  // any unforeseen SQLite error can NEVER abort the spawn — a throw here previously
  // surfaced as "@x couldn't start" and the cybo never answered.
  try {
    storage.persistCybo(cybo);
  } catch (err) {
    logger?.warn(
      { err, cyboId: cybo.id, slug: cybo.slug },
      "persistCybo failed; spawning without local cybo denormalization",
    );
  }

  const isLocal = cybo.id.startsWith("local:");
  if (!isLocal && cybo.workspace_id !== workspaceId) {
    throw new CyboNotFoundError(cyboIdOrSlug);
  }

  const workspace = storage.getWorkspace(workspaceId);
  const enrichedContext: SpawnCyboContext = {
    workspaceName: workspace?.name,
    ...context,
  };

  const systemPrompt = buildCyboPrompt(cybo, enrichedContext);

  const agentId = randomUUID();

  const mcpServers = buildCyboMcpServers(cybo, cyborg7McpBaseUrl, workspaceId, agentId);

  // Composio third-party tools — strict no-op unless the cybo has tool_grants AND the
  // composio dep is wired. Extracted (below) so spawnCybo's branch count is unchanged.
  await injectComposioMcpServers({
    cybo,
    composio,
    autonomous,
    workspaceId,
    userId,
    mcpServers,
    logger,
  });

  // Provider IS the harness (internal docs): native claude/codex spawn on the
  // daemon's own provider (host login, zero extra auth); everything else routes
  // through the Cybo runtime as before.
  const harness = resolveCyboHarness(cybo.provider, cybo.model);

  const cwd = resolveCyboCwd(cybo.id, context?.cwd);
  await fs.mkdir(cwd, { recursive: true });

  // Phase 3 (internal docs): resolve the credential env. `undefined` for every
  // native / stock-PI cybo (store never touched — zero regression); only an
  // `openai-compatible` + `api` cybo (MiniMax/OpenRouter) gets a populated env
  // (key + PI_CODING_AGENT_DIR) and a per-cybo models.json. A missing credential
  // throws CyboCredentialMissingError here, BEFORE any agent spawns.
  const credentialEnv = await resolveSpawnCredentialEnv({
    cybo,
    harness,
    cwd,
    credentialStore,
    logger,
  });

  const config = buildCyboAgentConfig({
    harness,
    cwd,
    systemPrompt,
    mcpServers,
    ephemeral,
    unattended,
  });

  const agent = await agentManager.createAgent(config, agentId, {
    workspaceId,
    // Name the session after the CYBO, not the provider — without this the
    // sidebar and chat header read "opencode-go" for a cybo the user named.
    initialTitle: cybo.name,
    // One turn, then torn down (message-router) — never persist the provider
    // session, or every mention leaves a resumable session file behind.
    // historyPrimed:true makes agent-manager early-return from
    // hydrateTimelineFromLegacyProviderHistory, so the legacy-history "capture"
    // prompt never fires on this fresh ephemeral agent. Without it that capture
    // prompt collides with the watcher's own routed prompt ("Agent is already
    // processing" on pi / "ProcessTransport is not ready for writing" on claude),
    // the cybo never runs, and no task gets created. Ephemeral-only: a persistent
    // cybo still hydrates its real provider history as before.
    ...(ephemeral ? { persistSession: false, historyPrimed: true } : {}),
    // Phase 3: inject the resolved api-key env (+ PI_CODING_AGENT_DIR) ONLY for
    // openai-compatible api cybos. `undefined` for every other cybo, so the `env`
    // key carries nothing and the call is identical to pre-P3 (no-regression).
    env: credentialEnv,
    labels: {
      surface: "cyborg7",
      workspaceId,
      cyboId: cybo.id,
      cyboSlug: cybo.slug,
      ...(context?.channelId ? { channelId: context.channelId } : {}),
    },
  });

  // Computed once + reused below (also keeps spawnCybo's cyclomatic complexity
  // flat — the ?? fallbacks count as branches, so don't duplicate them).
  const sessionChannelId = context?.channelId ?? null;
  // Fall back to the requested cwd (config.cwd is always set above) — the Paseo
  // agent object doesn't always surface .cwd, and without this fallback cybo
  // sessions persisted a null cwd, so the folder badge never showed.
  const sessionCwd = agent.cwd ?? config.cwd ?? null;
  storage.createAgentBinding({
    agentId: agent.id,
    workspaceId,
    channelId: sessionChannelId,
    provider: cybo.provider,
    model: cybo.model,
    systemPrompt,
    daemonId: serverId ?? null,
    cyboId: cybo.id,
    initiatedBy: userId,
    // Real initiator email (when the spawn has a human caller) so a non-ephemeral
    // cybo session attributes to its owner in the offline visibility filter (#810).
    initiatedByEmail: initiatedByEmail ?? null,
    cwd: sessionCwd,
    ephemeral,
    // Persist the autonomous marker so BOTH the live (handleListAgents) and offline
    // (offlineBindingVisible) lists OWNER-SCOPE a cron/scheduled session instead of
    // leaking it to every channel member via the shared-channel short-circuit. A
    // human-spawned interactive channel agent (autonomous undefined/false) stays
    // shared. Message delivery is unaffected — this is sidebar SESSION visibility.
    autonomous,
  });
  // Capture the EPHEMERAL session's injected context durably (#994) — the system
  // prompt AND the assembled mcpServers map only co-exist here before
  // teardownEphemeralAgent destroys the binding. No-op for non-ephemeral spawns.
  captureEphemeralSpawnContext(storage, ephemeral, {
    agentId: agent.id,
    workspaceId,
    channelId: sessionChannelId,
    cyboId: cybo.id,
    systemPrompt,
    mcpServers,
  });
  // Session-history row for the Home stats (best-effort, PG-only).
  storage.recordAgentSessionStart({
    agentId: agent.id,
    workspaceId,
    channelId: sessionChannelId,
    userId,
    provider: cybo.provider,
    cyboId: cybo.id,
    sessionType: "cybo",
    cwd: sessionCwd,
  });

  // #995: the ONE new instrumentation — surface the exact context + tools this
  // session got (redacted) onto the Logs-tab audit stream. No-op without a sink
  // (the guard lives inside emitSpawnAudit to keep spawnCybo's complexity flat).
  emitSpawnAudit({
    auditSink,
    systemPrompt,
    mcpServers,
    cyborg7McpBaseUrl,
    cybo,
    agentId: agent.id,
    workspaceId,
    channelId: sessionChannelId,
    userId,
  });

  return {
    agentId: agent.id,
    cyboId: cybo.id,
    cyboSlug: cybo.slug,
    provider: cybo.provider,
    model: cybo.model,
    systemPrompt,
  };
}

// ─── Local cybo registry (~/.cybo/agents/) ──────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) {
      const target = await fs.readlink(p);
      const resolved = resolve(LOCAL_AGENTS_DIR, target);
      return (await pathExists(resolved)) ? resolved : null;
    }
    return p;
  } catch {
    return null;
  }
}

async function readSoul(dir: string, soulField: string): Promise<string> {
  if (soulField.endsWith(".md")) {
    try {
      return await fs.readFile(join(dir, soulField), "utf-8");
    } catch {
      // Missing soul file → fall back to treating the field as inline text.
    }
  }
  return soulField;
}

async function loadLocalCybo(slug: string, dir: string): Promise<StoredCybo | null> {
  const manifestPath = join(dir, "cybo.json");
  let rawText: string;
  try {
    rawText = await fs.readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }

  try {
    const raw = JSON.parse(rawText) as Record<string, unknown>;
    if (!raw.slug || !raw.name || !raw.provider || !raw.soul) return null;

    const soul = await readSoul(dir, raw.soul as string);

    return {
      id: `local:${slug}`,
      workspace_id: "",
      slug: raw.slug as string,
      name: raw.name as string,
      description: (raw.description as string) ?? null,
      avatar: (raw.avatar as string) ?? null,
      role: (raw.role as string) ?? null,
      soul,
      provider: raw.provider as string,
      model: (raw.model as string) ?? null,
      // Specialized tools from cybo.json — carried into the spawn's agent config.
      mcp_servers:
        raw.mcpServers && typeof raw.mcpServers === "object"
          ? JSON.stringify(raw.mcpServers)
          : null,
      llm_auth_mode: typeof raw.llmAuthMode === "string" ? raw.llmAuthMode : "cli",
      behavior_mode: typeof raw.behaviorMode === "string" ? raw.behaviorMode : "responsive",
      // A disk (local) cybo has no explicit home daemon — it lives only on the
      // daemon hosting its cybo.json file.
      home_daemon_id: null,
      autonomy_level: typeof raw.autonomyLevel === "string" ? raw.autonomyLevel : null,
      monthly_spend_cap: typeof raw.monthlySpendCap === "number" ? raw.monthlySpendCap : null,
      platform_permissions: Array.isArray(raw.platformPermissions)
        ? JSON.stringify(raw.platformPermissions)
        : "[]",
      is_default: raw.isDefault ? 1 : 0,
      created_by: "local",
      created_at: 0,
      updated_at: 0,
    };
  } catch {
    return null;
  }
}

export async function scanLocalCybos(): Promise<StoredCybo[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(LOCAL_AGENTS_DIR)).filter((n) => !n.startsWith("."));
  } catch {
    // Dir absent (no local cybos) — not an error.
    return [];
  }

  // Resolve each entry concurrently; sync disk I/O here used to block the event
  // loop on every fetch_cybos / cybo-spawn request.
  const loaded = await Promise.all(
    entries.map(async (entry) => {
      const realPath = await safeRealpath(join(LOCAL_AGENTS_DIR, entry));
      if (!realPath) return null;
      return loadLocalCybo(entry, realPath);
    }),
  );
  return loaded.filter((c): c is StoredCybo => c !== null);
}

export async function resolveLocalCybo(idOrSlug: string): Promise<StoredCybo | undefined> {
  const slug = idOrSlug.startsWith("local:") ? idOrSlug.slice(6) : idOrSlug;
  const candidate = join(LOCAL_AGENTS_DIR, slug);
  const realPath = await safeRealpath(candidate);
  if (!realPath) return undefined;
  return (await loadLocalCybo(slug, realPath)) ?? undefined;
}

export class CyboNotFoundError extends Error {
  constructor(idOrSlug: string) {
    super(`Cybo not found: ${idOrSlug}`);
    this.name = "CyboNotFoundError";
  }
}

// User-facing message for a spawn that couldn't resolve its cybo. The raw
// "Cybo not found: X" hid the real cause: in cloud mode the relay enriches the
// spawn with the PG cybo, so reaching resolve EMPTY-handed means the cybo isn't
// in the workspace's shared roster — it's someone's local (disk) cybo, which
// only its home machine can start. Say that, instead of a bare not-found.
export function describeSpawnCyboNotFound(
  idOrSlug: string,
  opts: { enriched: boolean; daemonId?: string | null },
): string {
  if (opts.enriched) {
    // The relay DID resolve it but the daemon-side workspace check rejected it —
    // a stale roster pointing at another workspace's cybo.
    return `Cybo not found: "${idOrSlug}" belongs to a different workspace. Refresh and try again.`;
  }
  const where = opts.daemonId ? `this daemon's disk (${opts.daemonId})` : "this daemon's disk";
  return (
    `Cybo not found: "${idOrSlug}" isn't in this workspace's shared cybos and isn't on ${where}. ` +
    `Local (disk) cybos can only start on the machine that has them — start it from its home daemon, ` +
    `or import it into the workspace so any daemon can run it.`
  );
}

import express from "express";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { open } from "fs/promises";
import { randomUUID } from "node:crypto";
import {
  hostname as getHostname,
  platform as osPlatform,
  arch as osArch,
  homedir as osHomedir,
} from "node:os";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";
import { isCommandAvailable } from "../utils/executable.js";
import {
  createDualStorage,
  CyborgAuth,
  WorkspaceManager,
  MessageRouter,
  CyborgDispatcher,
  DaemonRelayClient,
  SqliteAgentTimelineStore,
  createCyborg7McpServer,
  CyboSessionContext,
} from "./cyborg/index.js";
import { ScheduleRunner } from "./cyborg/schedule-runner.js";
import { catchUpOwnedTasks } from "./cyborg/task-dispatch.js";
import { ScheduledMessageRunner } from "./cyborg/scheduled-message-runner.js";
import { WebhookDeliveryRunner } from "./cyborg/webhook-delivery-runner.js";
import {
  buildAgentPrompt,
  promptInputToText,
  type PromptAttachment,
} from "./cyborg/agent-attachments.js";
import type { AgentPromptInput } from "./agent/agent-sdk-types.js";
import { buildCyboRuntimeProfile, type CyboRuntimeProfile } from "./cyborg/cybo-runtime-profile.js";
import {
  computeLoggedOutNativeProviders,
  honestHelloProviders,
} from "./cyborg/hello-provider-list.js";
import { runMigrations } from "./cyborg/db/migrate.js";
import { resolveDaemonEdition } from "./cyborg/daemon-edition.js";
import { countActiveSessions } from "./cyborg/daemon-usage.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const [host, portStr] = listen.split(":");
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    return { type: "tcp", host: host || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { createGitHubService } from "../services/github-service.js";
import { createPaseoWorktree as createRegisteredPaseoWorktree } from "./paseo-worktree-service.js";
import { createPaseoWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { installSessionSafety } from "./cyborg/session-safety.js";
import { augmentDaemonPath } from "./cyborg/fix-daemon-path.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { buildProviderRegistry } from "./agent/provider-registry.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import { FileBackedProjectRegistry, FileBackedWorkspaceRegistry } from "./workspace-registry.js";
import { FileBackedChatService } from "./chat/chat-service.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { LoopService } from "./loop-service.js";
import { ScheduleService } from "./schedule/service.js";
import { DaemonConfigStore } from "./daemon-config-store.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { archivePersistedWorkspaceRecord } from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import {
  createConfiguredTerminalManager,
  isPtyHostEnabled,
} from "../terminal/terminal-manager-factory.js";
import { launchPtyHostTerminalManager } from "./cyborg/pty-host-launcher.js";
import { killOwnAgentBackends, reapOrphanedAgentBackends } from "./cyborg/agent-backend-reaper.js";
import { createConnectionOfferV2, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { startRelayTransport, type RelayTransportController } from "./relay-transport.js";
import type { PushNotificationSender } from "./push/notifications.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import type { PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import { createRequireBearerMiddleware, type DaemonAuthConfig } from "./auth.js";

type AgentMcpTransportMap = Map<string, StreamableHTTPServerTransport>;

const MAX_MCP_DEBUG_BATCH_ITEMS = 10;
const REDACTED_LOG_VALUE = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createCyborg7McpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  return new URL(
    "/mcp/cyborg7",
    `http://${formatHostForHttpUrl(listenTarget.host)}:${listenTarget.port}`,
  ).toString();
}

function summarizeAgentMcpDebugMessage(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      type: body === null ? "null" : typeof body,
    };
  }

  const record = body as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : undefined;
  return {
    type: "object",
    ...(typeof record.jsonrpc === "string" ? { jsonrpc: record.jsonrpc } : {}),
    ...(method ? { method } : {}),
    hasId: Object.prototype.hasOwnProperty.call(record, "id"),
    hasParams: Object.prototype.hasOwnProperty.call(record, "params"),
  };
}

function summarizeAgentMcpDebugBody(body: unknown): Record<string, unknown> {
  if (!Array.isArray(body)) {
    return summarizeAgentMcpDebugMessage(body);
  }

  const messages = body.slice(0, MAX_MCP_DEBUG_BATCH_ITEMS).map(summarizeAgentMcpDebugMessage);
  return {
    type: "batch",
    count: body.length,
    messages,
    ...(body.length > messages.length ? { omitted: body.length - messages.length } : {}),
  };
}

export type PaseoOpenAIConfig = OpenAiSpeechProviderConfig;
export type PaseoLocalSpeechConfig = LocalSpeechProviderConfig;

export interface PaseoSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface PaseoSpeechConfig {
  providers: RequestedSpeechProviders;
  sttLanguages?: PaseoSpeechSttLanguages;
  local?: PaseoLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason?: string;
    };

// ─── Deterministic relay resolution (#664) ───────────────────────────
//
// The daemon must resolve its relay ONLY from explicit configuration and NEVER
// fall back to relay.paseo.sh — a hand-run daemon used to silently join Paseo's
// upstream relay even though ~/.paseo/cyborg-relay-url pointed at the Cyborg7
// relay. Precedence: CYBORG_RELAY_URL env → cyborg-relay-url file (written by
// `cyborg daemon claim`) → config.relayEndpoint. No default; the caller fails
// loud when nothing is configured.

export interface ResolvedRelay {
  /** Full ws(s):// URL — for the Cyborg7 DaemonRelayClient. */
  wsUrl: string;
  /** host:port — for the Paseo relay transport. */
  endpoint: string;
  useTls: boolean;
  source: "env" | "file" | "config";
}

// Parse one relay reference into both shapes the daemon needs. Accepts a
// ws(s):// URL (the cyborg-relay-url file shape, may carry a path) or a bare
// host:port (the config.relayEndpoint shape).
function parseRelayRef(raw: string, configUseTls?: boolean | null): Omit<ResolvedRelay, "source"> {
  if (/^wss?:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      // A corrupt/hand-edited relay URL must fail loud with a CLEAR message, not
      // a cryptic "Invalid URL" TypeError mid-boot.
      throw new Error(`Invalid relay URL "${raw}" — expected ws(s)://host[:port][/path] (#664)`);
    }
    if (!u.hostname) {
      throw new Error(`Invalid relay URL "${raw}" — missing host (#664)`);
    }
    const useTls = u.protocol === "wss:";
    const port = u.port || (useTls ? "443" : "80");
    return { wsUrl: raw, endpoint: `${u.hostname}:${port}`, useTls };
  }
  // Bare host:port. useTls: explicit config wins, else infer from a :443 suffix.
  const lastColon = raw.lastIndexOf(":");
  const port = lastColon >= 0 ? raw.slice(lastColon + 1) : "";
  const useTls = configUseTls ?? port === "443";
  return { wsUrl: `${useTls ? "wss" : "ws"}://${raw}`, endpoint: raw, useTls };
}

export function resolveDaemonRelay(opts: {
  envUrl?: string | null;
  relayUrlFileContent?: string | null;
  configEndpoint?: string | null;
  configUseTls?: boolean | null;
}): ResolvedRelay | null {
  const env = opts.envUrl?.trim();
  if (env) return { ...parseRelayRef(env, opts.configUseTls), source: "env" };
  const file = opts.relayUrlFileContent?.trim();
  if (file) return { ...parseRelayRef(file, opts.configUseTls), source: "file" };
  const cfg = opts.configEndpoint?.trim();
  if (cfg) return { ...parseRelayRef(cfg, opts.configUseTls), source: "config" };
  return null;
}

// host:port + TLS for the Paseo relay transport (#664). FAILS LOUD when the relay
// is enabled but unconfigured, instead of defaulting to relay.paseo.sh.
function relayTransportConfig(opts: {
  relayEnabled: boolean;
  resolvedRelay: ResolvedRelay | null;
  relayUrlFilePath: string;
  logger: Logger;
}): { endpoint: string; useTls: boolean } {
  const { relayEnabled, resolvedRelay, relayUrlFilePath, logger } = opts;
  if (relayEnabled && !resolvedRelay) {
    throw new Error(
      "Relay is enabled but no relay URL is configured. Set CYBORG_RELAY_URL, write " +
        `${relayUrlFilePath} (run 'cyborg daemon claim'), set relayEndpoint in config, ` +
        "or start with --no-relay. Refusing to fall back to relay.paseo.sh (#664).",
    );
  }
  const endpoint = resolvedRelay?.endpoint ?? "";
  const useTls = resolvedRelay?.useTls ?? false;
  if (relayEnabled) {
    logger.info(
      { endpoint, useTls, source: resolvedRelay?.source },
      `Daemon relay transport → ${endpoint}${useTls ? " (TLS)" : ""}`,
    );
  }
  return { endpoint, useTls };
}

// Cyborg7: the Paseo relay transport speaks Paseo's vestigial `/ws` control/data
// socket, but the Cyborg7 relay only routes `/relay` (daemon) + `/api/ws` (UI)
// and destroys everything else. Pointing this transport at the Cyborg7 relay
// (resolved from CYBORG_RELAY_URL env — which the desktop always sets, see
// daemon-manager.ts — or the `cyborg daemon claim` file) produces an endless
// code-1006 reconnect storm that floods the logs and STARVES the real
// DaemonRelayClient (→ `/relay`, the actual registration channel) → the daemon
// never registers → the UI waits on /api/ws forever ("Connecting…"). So start
// the Paseo transport ONLY for pure-Paseo daemons whose relay came from
// config.relayEndpoint (relay.paseo.sh, which DOES serve `/ws`); skip it for any
// cyborg-resolved relay (env/file). Automates the proven `daemon.relay.enabled=
// false` fix (transport off, DaemonRelayClient on). Returns the controller, or
// null when skipped so the caller's shutdown stays a no-op.
function startPaseoRelayTransportUnlessCyborg(opts: {
  resolvedRelay: ResolvedRelay | null;
  options: Parameters<typeof startRelayTransport>[0];
  logger: Logger;
}): RelayTransportController | null {
  const { resolvedRelay, options, logger } = opts;
  if (resolvedRelay?.source === "env" || resolvedRelay?.source === "file") {
    logger.info(
      { relay: resolvedRelay.wsUrl, source: resolvedRelay.source },
      "Cyborg7 relay detected — skipping the Paseo relay transport " +
        "(no /ws endpoint); the DaemonRelayClient handles registration",
    );
    return null;
  }
  return startRelayTransport(options);
}

export interface PaseoDaemonConfig {
  listen: string;
  paseoHome: string;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  autoArchiveAfterMerge?: boolean;
  appendSystemPrompt?: string;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  relayEnabled?: boolean;
  relayEndpoint?: string;
  relayPublicEndpoint?: string;
  relayUseTls?: boolean;
  relayPublicUseTls?: boolean;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: PaseoOpenAIConfig;
  speech?: PaseoSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
}

export interface PaseoDaemon {
  config: PaseoDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): ListenTarget | null;
}

// Pre-existing: this fork's boot function exceeds the complexity threshold
// (26 > 20) before this change; the session-safety hook below adds no branching,
// and refactoring Paseo's boot is out of scope here.
// oxlint-disable-next-line eslint/complexity
export async function createPaseoDaemon(
  config: PaseoDaemonConfig,
  rootLogger: Logger,
): Promise<PaseoDaemon> {
  const logger = rootLogger.child({ module: "bootstrap" });
  // Cyborg7: a GUI-launched macOS daemon inherits the minimal PATH and can't find
  // Homebrew/npm-global CLIs (cybo/pi/npm). Augment PATH once, before any provider
  // detection or agent spawn reads it. Idempotent; no-op for terminal-launched daemons.
  await augmentDaemonPath(logger);
  // Cyborg7: reap agent-backend processes (opencode serve, codex app-server) left
  // orphaned (PPID 1) by a PRIOR daemon death, before this daemon spawns its own.
  // A day of daemon crashes on the owner's Mac stacked ~375 orphaned `opencode
  // serve` (~5 GB); a fresh start must not sit on top of yesterday's zombies. Only
  // reaps PPID-1 backends matching a known marker — never the pty-host (which is
  // detached on purpose so live terminals survive). See agent-backend-reaper.ts.
  await reapOrphanedAgentBackends(logger).catch((err) => {
    logger.warn({ err }, "Orphaned agent-backend reap failed during bootstrap");
    return [];
  });
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = resolveDaemonVersion(import.meta.url);
  const daemonConfigStore = new DaemonConfigStore(
    config.paseoHome,
    {
      mcp: { injectIntoAgents: config.mcpInjectIntoAgents ?? true },
      providers: Object.fromEntries(
        Object.entries(config.providerOverrides ?? {}).map(([providerId, override]) => [
          providerId,
          {
            ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
            ...(override.additionalModels ? { additionalModels: override.additionalModels } : {}),
          },
        ]),
      ),
      metadataGeneration: {
        providers: config.metadataGeneration?.providers ?? [],
      },
      autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
      appendSystemPrompt: config.appendSystemPrompt ?? "",
    },
    logger,
  );

  const serverId = getOrCreateServerId(config.paseoHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.paseoHome, logger);
  let relayTransport: RelayTransportController | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  const listenTarget = parseListenString(config.listen);

  const app = express();
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const configuredHostnames = config.hostnames ?? config.allowedHosts;
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listActiveSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const allowedOrigins = new Set([
    ...config.corsAllowedOrigins,
    // Packaged desktop renderers use the custom paseo:// protocol scheme.
    "paseo://app",
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
    // Cyborg7 UI dev server
    ...(config.isDev
      ? ["http://localhost:5173", "http://localhost:5174", "http://localhost:5175"]
      : []),
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowedOrigins.has("*") || allowedOrigins.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(
    createRequireBearerMiddleware(config.auth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Middleware
  app.use(express.json());

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostname(),
      version: daemonVersion,
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      const safeFileName = entry.fileName.replace(/["\r\n]/g, "_");
      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  // Cyborg7: rotating backup + corrupt-JSON quarantine for agent session records.
  // Wraps AgentStorage's writes and runs a recovery sweep before initialize()
  // loads them — without modifying Paseo's agent-storage.ts.
  await installSessionSafety({ agentStorage, baseDir: config.agentStoragePath, logger });
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.paseoHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.paseoHome, "projects", "workspaces.json"),
    logger,
  );
  const chatService = new FileBackedChatService({
    paseoHome: config.paseoHome,
    logger,
  });
  // PtyHost mode (internal docs PART A, flag CYBORG7_PTY_HOST, DEFAULT ON — opt out
  // with CYBORG7_PTY_HOST=0): connect to (or spawn) a detached, long-lived host so
  // a LIVE pty survives a daemon restart and the daemon re-attaches to it. When the
  // flag is opted out this is the unchanged Paseo worker manager.
  //
  // FAIL SOFT (internal docs design intent — "fall back to the inherited Paseo
  // worker if the host misbehaves"): launching the detached host can throw (e.g.
  // "pty-host did not become ready before the deadline" on a loaded machine). A
  // throw here would crash the daemon worker (exit 1) and the supervisor would
  // restart it forever, so the daemon never comes online. Catch ANY launch error
  // and degrade to the in-process worker terminal manager instead — the same
  // fallback used when CYBORG7_PTY_HOST is off.
  let terminalManager: TerminalManager;
  if (isPtyHostEnabled()) {
    try {
      terminalManager = await launchPtyHostTerminalManager({ baseDir: config.paseoHome, logger });
    } catch (err) {
      logger.warn(
        { err },
        "PtyHost launch failed — falling back to the in-process terminal worker. " +
          "Live terminals will NOT persist across daemon restarts. " +
          "Set CYBORG7_PTY_HOST=0 to disable the PtyHost launch attempt.",
      );
      terminalManager = createConfiguredTerminalManager();
    }
  } else {
    terminalManager = createConfiguredTerminalManager();
  }
  const github = createGitHubService();
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      github,
    },
  });
  const providerSnapshotLogger = logger.child({ module: "provider-snapshot-manager" });
  const providerSnapshotManager = new ProviderSnapshotManager({
    logger: providerSnapshotLogger,
    runtimeSettings: config.agentProviderSettings,
    providerOverrides: config.providerOverrides,
    workspaceGitService,
    isDev: config.isDev === true,
    extraClients: config.agentClients,
  });
  const durableTimelineStore = new SqliteAgentTimelineStore(
    path.join(config.paseoHome, "cyborg7.db"),
  );
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  const agentManager = new AgentManager({
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    durableTimelineStore,
    appendSystemPrompt: config.appendSystemPrompt,
    logger,
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  await bootstrapWorkspaceRegistries({
    paseoHome: config.paseoHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const workspaceReconciliation = new WorkspaceReconciliationService({
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
  });
  void (async () => {
    try {
      const result = await workspaceReconciliation.runOnce();
      logger.info(
        {
          elapsed: elapsed(),
          changeCount: result.changesApplied.length,
        },
        "Workspace registries reconciled",
      );
    } catch (error) {
      logger.error({ err: error }, "Background workspace reconciliation failed");
    }
  })();
  await chatService.initialize();
  logger.info({ elapsed: elapsed() }, "Chat service initialized");
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    paseoHome: config.paseoHome,
    workspaceGitService,
  });
  const loopService = new LoopService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    providerSnapshotManager,
  });
  await loopService.initialize();
  logger.info({ elapsed: elapsed() }, "Loop service initialized");
  const scheduleService = new ScheduleService({
    paseoHome: config.paseoHome,
    logger,
    agentManager,
    agentStorage,
    providerSnapshotManager,
  });
  await scheduleService.start();
  agentManager.setAgentArchivedCallback(async (agentId) => {
    try {
      await scheduleService.deleteForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to delete schedules for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");

  // Cyborg7: daemon owner persistence
  const daemonOwnerPath = path.join(config.paseoHome, "daemon-owner");
  let daemonOwnerId: string | null = null;
  if (existsSync(daemonOwnerPath)) {
    try {
      daemonOwnerId = readFileSync(daemonOwnerPath, "utf8").trim() || null;
    } catch (err) {
      logger.warn({ err, daemonOwnerPath }, "Failed to read daemon-owner file");
    }
  }
  function claimDaemonOwner(userId: string): void {
    if (daemonOwnerId) return;
    daemonOwnerId = userId;
    try {
      writeFileSync(daemonOwnerPath, userId + "\n", { mode: 0o600 });
    } catch (err) {
      logger.warn({ err, daemonOwnerPath, ownerId: userId }, "Failed to persist daemon-owner file");
    }
    logger.info({ serverId, ownerId: userId }, "Daemon claimed by user");
  }

  // Cyborg7: collaborative workspace layer
  const cyborgStorage = createDualStorage(config.paseoHome, logger);
  logger.info({ mode: cyborgStorage.mode }, "Cyborg7 storage initialized");
  // Connected mode shares a PostgreSQL — bring its schema up to date via Drizzle
  // migrations (the single source of truth) before anything reads or writes it.
  // A no-op once the DB is current. Solo mode (SQLite only) has no PG to migrate.
  if (cyborgStorage.mode === "connected") {
    try {
      await runMigrations();
      logger.info("Cyborg7 PostgreSQL migrations applied");
    } catch (err) {
      logger.error({ err }, "Cyborg7 PostgreSQL migration failed — aborting boot");
      throw err;
    }
  }
  const cyborgAuth = new CyborgAuth(cyborgStorage, process.env.CYBORG7_JWT_SECRET);
  const cyborgWorkspaceManager = new WorkspaceManager(cyborgStorage);
  let cyborgRelayClient: DaemonRelayClient | null = null;
  const cyborgBroadcast = {
    toWorkspace(workspaceId: string, msg: unknown) {
      wsServer?.broadcastCyborgMessageToWorkspace(workspaceId, msg);
      cyborgRelayClient?.forward(workspaceId, msg as Record<string, unknown>);
    },
    toUser(userId: string, msg: unknown) {
      wsServer?.broadcastCyborgMessageToUser(userId, msg);
    },
  };
  const cyborgMessageRouter = new MessageRouter(
    cyborgStorage,
    cyborgWorkspaceManager,
    cyborgBroadcast,
  );
  cyborgMessageRouter.setAgentManager(agentManager);
  cyborgMessageRouter.setAgentStorage(agentStorage, logger);
  cyborgMessageRouter.setServerId(serverId);
  // #845 inline-render: lets the router rewrite a persisted local image token to
  // its uploaded S3 URL so a reload/lazy-load serves the reachable URL.
  cyborgMessageRouter.setTimelineStore(durableTimelineStore);
  const cyborgDispatcher = new CyborgDispatcher(
    cyborgMessageRouter,
    cyborgWorkspaceManager,
    cyborgStorage,
  );
  cyborgDispatcher.setAgentManager(agentManager);
  cyborgDispatcher.setAgentStorage(agentStorage, logger);
  cyborgDispatcher.setDurableTimelineStore(durableTimelineStore);
  // Channel AI commands (/summarize etc.) resolve real structured-generation
  // providers from the live catalog — without this the completer ran with [] and
  // failed with "Structured generation failed for all providers".
  cyborgDispatcher.setProviderSnapshotManager(providerSnapshotManager);
  cyborgDispatcher.setDaemonConfigStore(daemonConfigStore);
  // Upstream moved provider construction into ProviderSnapshotManager (which holds
  // the registry privately). Rebuild the same registry here — with the identical
  // inputs the snapshot manager was constructed with — to feed the cyborg
  // dispatcher's provider catalog (cyborg:list_providers).
  const cyborgProviderRegistry = buildProviderRegistry(logger, {
    runtimeSettings: config.agentProviderSettings,
    providerOverrides: config.providerOverrides,
    workspaceGitService,
    isDev: config.isDev === true,
  });
  cyborgDispatcher.setProviderRegistry(cyborgProviderRegistry);
  cyborgDispatcher.setCyborgAuth(cyborgAuth);
  cyborgDispatcher.setServerId(serverId);
  cyborgDispatcher.setDaemonOwnerId(daemonOwnerId);
  // Terminal sessions over the cloud relay (#654) — reuse the same TerminalManager
  // Paseo uses; new terminals default to the user's home when no cwd is pinned.
  cyborgDispatcher.setTerminalManager(terminalManager, osHomedir());

  // Cybo schedule runner: per-daemon cron tick that fires recurring cybo runs
  // (cyborg7_schedule_*). Spawns on this daemon's workspaces only (local SQLite).
  const cyborgScheduleRunner = new ScheduleRunner({
    storage: cyborgStorage,
    agentManager,
    logger,
    serverId,
  });
  // User "send later" runner (#607): fires due scheduled_messages through the
  // normal message path. It owns NO timer — it's pumped on the cybo runner's
  // existing tick (a single daemon scheduler timer). A connected daemon defers to
  // the cloud relay's PG tick; a solo daemon fires from its own SQLite.
  const cyborgScheduledMessageRunner = new ScheduledMessageRunner({
    storage: cyborgStorage,
    workspaceManager: cyborgWorkspaceManager,
    messageRouter: cyborgMessageRouter,
    broadcast: cyborgBroadcast,
    logger,
  });
  cyborgScheduleRunner.setAdditionalTick(() => cyborgScheduledMessageRunner.tick());
  // Surface due-tick / scheduled task dispatches in the Logs tab too (same path
  // as the immediate on-assign dispatch), so scheduled processing is observable.
  cyborgScheduleRunner.setOnTaskEvent((ev) => cyborgMessageRouter.broadcastTaskEvent(ev));
  cyborgScheduleRunner.start();
  // Tasks Phase 3 (internal docs): mutable holder for the cyborg7 MCP base URL,
  // resolved after the HTTP server binds (see below). The reconnect catch-up sweep
  // reads it lazily so a sweep firing before the URL is set just spawns without the
  // MCP tools (degraded, not broken), and picks up the real URL on later sweeps.
  let cyborgTaskMcpUrl: string | undefined;
  // The run_once RPC ("Run now") delegates to the runner so the fire logic
  // stays in one place.
  cyborgDispatcher.setScheduleRunner(cyborgScheduleRunner);
  cyborgDispatcher.setOnClaimDaemon((userId) => {
    claimDaemonOwner(userId);
    cyborgDispatcher.setDaemonOwnerId(daemonOwnerId);
  });

  // Outgoing-webhook delivery (#598). PG-only: the runner claims due
  // webhook_outbox rows (FOR UPDATE SKIP LOCKED — safe alongside the cloud
  // relay's own tick), signs + POSTs them via secureFetch, and dead-letters /
  // deactivates a webhook after repeated failures (DMing the owner). A SOLO
  // daemon (no DATABASE_URL → cyborgStorage.pg is null) has no outbox, so we only
  // spin the tick when PG is connected. On the host, the cloud relay is the
  // primary deliverer; a connected daemon ticking too just shares the load (the
  // SKIP-LOCKED claim guarantees each row is attempted once).
  let cyborgWebhookDeliverySweep: NodeJS.Timeout | undefined;
  const cyborgWebhookPg = cyborgStorage.pg;
  if (cyborgWebhookPg) {
    const webhookDeliveryRunner = new WebhookDeliveryRunner({
      pg: cyborgWebhookPg,
      logger,
      notifyOwner: ({ workspaceId: wid, userId, webhookName, url }) => {
        // Best-effort system DM to the owner. Name the host (never the full URL,
        // which can carry a path token; never the signing secret).
        let host = "the configured endpoint";
        try {
          host = new URL(url).host;
        } catch {
          /* keep the generic label */
        }
        cyborgBroadcast.toUser(userId, {
          type: "cyborg:dm_broadcast" as const,
          payload: {
            id: randomUUID(),
            workspaceId: wid,
            channelId: null,
            fromId: "system",
            fromType: "system" as const,
            fromName: null,
            toId: userId,
            text: `Your outgoing webhook "${webhookName}" (${host}) was disabled after repeated delivery failures. Re-enable it once the endpoint is healthy.`,
            mentions: null,
            parentId: null,
            attachments: null,
            createdAt: Date.now(),
          },
        });
      },
    });
    cyborgWebhookDeliverySweep = setInterval(() => {
      void webhookDeliveryRunner
        .tick()
        .catch((err) => logger.warn({ err }, "[webhook-delivery] tick failed"));
    }, 60_000);
    cyborgWebhookDeliverySweep.unref();
  }

  // Cyborg7: generate daemon token for relay auth
  const cyborgDaemonToken =
    process.env.CYBORG_RELAY_TOKEN ??
    cyborgAuth.createDaemonToken(serverId, daemonOwnerId ?? "unclaimed");

  // A PRIVATE agent session may only be prompted by the user who started it. A
  // session is private unless it is a SHARED channel agent (channel-bound AND
  // non-ephemeral). DM agents (no channel) and EPHEMERAL channel summons
  // (@-mentions / slash commands) are owner-scoped, so a non-initiator must not be
  // able to drive someone else's mention session over the relay forward. The
  // daemon's local SQLite and the cloud PG assign DIFFERENT user ids to the same
  // account, so binding.initiated_by (local id) can't be compared to a forwarded
  // cloud id directly — bridge by email.
  const isPromptFromInitiator = (
    binding: { channel_id?: string | null; initiated_by?: string | null; ephemeral?: number },
    fwd: { fromUserId?: string; fromEmail?: string | null },
  ): boolean => {
    const isSharedChannelAgent = !!binding.channel_id && binding.ephemeral !== 1;
    if (isSharedChannelAgent || !binding.initiated_by || !fwd.fromUserId) return true;
    if (binding.initiated_by === fwd.fromUserId) return true;
    const initiator = cyborgStorage?.getUserById(binding.initiated_by);
    return !!initiator?.email && !!fwd.fromEmail && initiator.email === fwd.fromEmail;
  };

  // Cyborg7: resolve the relay deterministically (#664) — env → cyborg-relay-url
  // file → config.relayEndpoint, NEVER relay.paseo.sh. Resolved ONCE here and
  // reused by the Paseo relay transport below (which previously defaulted to
  // paseo.sh). Logged so it's always clear which relay this daemon talks to.
  const relayUrlFilePath = path.join(config.paseoHome, "cyborg-relay-url");
  let relayUrlFileContent: string | null = null;
  try {
    if (existsSync(relayUrlFilePath)) relayUrlFileContent = readFileSync(relayUrlFilePath, "utf8");
  } catch (err) {
    logger.warn({ err, path: relayUrlFilePath }, "Failed to read cyborg-relay-url file");
  }
  const resolvedRelay = resolveDaemonRelay({
    envUrl: process.env.CYBORG_RELAY_URL,
    relayUrlFileContent,
    configEndpoint: config.relayEndpoint,
    configUseTls: config.relayUseTls,
  });
  if (resolvedRelay) {
    logger.info(
      {
        relay: resolvedRelay.wsUrl,
        endpoint: resolvedRelay.endpoint,
        source: resolvedRelay.source,
      },
      `Daemon relay resolved → ${resolvedRelay.wsUrl} (from ${resolvedRelay.source})`,
    );
  } else {
    logger.warn(
      "No relay configured (CYBORG_RELAY_URL / cyborg-relay-url / config.relayEndpoint all empty) — " +
        "the daemon will NOT connect to any relay. Run 'cyborg daemon claim' or set CYBORG_RELAY_URL.",
    );
  }

  // Cyborg7: connect to workspace relay if configured
  if (resolvedRelay) {
    const cyborgRelayUrl = resolvedRelay.wsUrl;
    const workspaceIds = cyborgStorage.getAllWorkspaceIds();
    // Deployment edition resolved ONCE at boot (usage-metrics round 1), explicit
    // beats inferred. Published on hello + every heartbeat via setEditionFn below.
    //   1. CYBORG_EDITION env, if one of the three known values → verbatim.
    //   2. else infer from relay host + storage mode: the canonical SaaS relay on
    //      a connected (cloud) storage → 'saas'; any other configured relay (a
    //      custom/self-hosted relay) → 'selfhost'; solo storage → 'opensource'.
    // resolvedRelay is non-null in this branch, so a relay IS configured here; a
    // truly relay-less daemon never reaches this code → edition stays unreported.
    // endpoint is "host:port"; strip the port (lastIndexOf is IPv6-safe).
    const lastColon = resolvedRelay.endpoint.lastIndexOf(":");
    const relayHost =
      lastColon >= 0 ? resolvedRelay.endpoint.slice(0, lastColon) : resolvedRelay.endpoint;
    const daemonEdition = resolveDaemonEdition({
      envEdition: process.env.CYBORG_EDITION,
      relayHost,
      storageMode: cyborgStorage.mode,
    });
    // Detect the cybo/PI CLI once at boot (a capability flag, not per-request).
    // `cybo` is the persona wrapper; `pi` is the underlying runtime — either
    // means this daemon can spawn cybos. Failures degrade to `false`.
    const cyboInstalled = await Promise.all([
      isCommandAvailable("cybo").catch(() => false),
      isCommandAvailable("pi").catch(() => false),
    ]).then(([cybo, pi]) => cybo || pi);
    cyborgRelayClient = new DaemonRelayClient({
      relayUrl: cyborgRelayUrl,
      daemonId: serverId,
      token: cyborgDaemonToken,
      workspaceIds,
      label: getHostname(),
      storage: cyborgStorage,
      logger,
      staticMeta: {
        host: getHostname(),
        platform: osPlatform(),
        arch: osArch(),
        cyboInstalled,
      },
      onMessage: (workspaceId, _fromDaemonId, msg) => {
        const msgType = (msg as Record<string, unknown>).type;
        if (msgType === "cyborg:relay_rpc") {
          const rpc = msg as {
            token: string;
            workspaceId: string;
            guestId: string;
            role?: string;
            inner: Record<string, unknown>;
          };
          // A forwarded relay RPC is untrusted input from the network. Any throw
          // here used to bubble up as an uncaught exception and kill the daemon
          // worker — the supervisor then relaunched it, it reconnected, received
          // the same RPC, and crashed again (a once-per-second reconnect storm
          // that made the daemon's agents flicker in/out of every workspace).
          // NOTHING a single forwarded message does may crash the process.
          try {
            // Inbound diagnostic (#694): the daemon never logged receiving a
            // relay_rpc, so a forward the relay reported as "invoked" but that
            // landed on a stale relay socket was indistinguishable from one that
            // arrived. Defensive read (untrusted JSON: inner may be absent/non-
            // object) and INSIDE the try so it can never crash the worker.
            const inner = rpc.inner as Record<string, unknown> | null | undefined;
            const innerType =
              inner && typeof inner === "object" && typeof inner.type === "string"
                ? inner.type
                : undefined;
            logger.info(
              { workspaceId, innerType, guestId: rpc.guestId },
              "Daemon received relay_rpc forward",
            );
            const authCtx = cyborgAuth.validateToken(rpc.token);
            if (!authCtx) return;
            // Attribute forwarded ops to the relay's CLOUD user id (guestId), not the
            // daemon's token-decoded id. The relay inserts normal channel messages
            // with fromId = guest.userId, and the client resolves avatars by that id
            // (authState.user.id). The daemon's validateToken can yield a different
            // id, so a server-posted echo (e.g. the slash command echo, fromId =
            // auth.user.id) would diverge from a normal message and the author's
            // photo wouldn't resolve (placeholder). Aligning the id here keeps the
            // echo on the exact same author→avatar path as any other message.
            if (rpc.guestId) authCtx.user.id = rpc.guestId;
            // RESOLVE THE CANONICAL CLOUD EMAIL ON THE FORWARD PATH (#876 cloud
            // follow-up). The email-keyed terminal owner-lock re-admits the SAME human
            // across the per-store id divergence (the relay overrides user.id to the PG
            // guestId here, while the daemon's SQLite uses canonicalUserId(email) — two
            // different ids for one human), so it relies on authCtx.user.email being the
            // user's CANONICAL cloud email AND identical on the terminal CREATE rpc and
            // the SUBSCRIBE rpc. validateToken(rpc.token) derives the email from the
            // JWT's SQLite upsert, which can diverge in casing from PG (and is wrong for
            // an impersonation token, whose JWT email is the impersonatee but whose
            // guestId is the real account). guestId is the authoritative PG account id,
            // so the canonical email is looked up from PG by guestId and stamped below
            // (async, just before dispatch) — falling back to the JWT-derived email when
            // PG is unavailable. Without this the owner-lock email-match never fires in
            // cloud mode and the re-attach dead-ends to attachDead → terminal death.
            const resolveCanonicalEmail = async (): Promise<void> => {
              if (!rpc.guestId) return;
              const pg = cyborgStorage?.pg;
              if (!pg) return;
              try {
                const cloudUser = await pg.getUserById(rpc.guestId);
                if (cloudUser?.email) authCtx.user.email = cloudUser.email;
              } catch (err) {
                logger.warn(
                  { err, guestId: rpc.guestId },
                  "Failed to resolve cloud email for forwarded RPC — using token email",
                );
              }
            };
            // Use the REAL role the relay resolved from PG (the daemon can't see
            // cloud memberships locally). Previously this fabricated `owner` for any
            // token holder, letting a member/viewer perform owner-only agent ops.
            const relayRole = rpc.role ?? "member";
            const existingWs = authCtx.workspaces.find((w) => w.id === rpc.workspaceId);
            if (existingWs) {
              existingWs.role = relayRole;
            } else {
              authCtx.workspaces.push({ id: rpc.workspaceId, name: "Remote", role: relayRole });
            }
            cyborgStorage.ensureMembership(rpc.workspaceId, authCtx.user.id, relayRole);
            const relayEmit = (response: unknown) => {
              cyborgRelayClient?.forward(rpc.workspaceId, response as Record<string, unknown>);
            };
            // dispatch is fire-and-forget (Promise<void>): the outer try/catch only
            // guards the SYNCHRONOUS work above (validateToken, ensureMembership). An
            // async rejection deeper in dispatch (e.g. a DB query failure) would
            // escape it and hit the global unhandledRejection handler, which crashes
            // the daemon — the exact invariant this handler exists to prevent. Wrap
            // the await in its own IIFE+try/catch (mirrors agent_prompt_forward below;
            // an async IIFE avoids .catch() to satisfy promise/always-return).
            void (async () => {
              try {
                // Stamp the canonical cloud email BEFORE dispatch so the terminal
                // owner-lock (create + subscribe) matches the same human in cloud mode.
                await resolveCanonicalEmail();
                await cyborgDispatcher.dispatch(
                  rpc.inner as Parameters<typeof cyborgDispatcher.dispatch>[0],
                  authCtx,
                  relayEmit,
                );
              } catch (err) {
                logger.error(
                  { err, workspaceId: rpc.workspaceId },
                  "Forwarded relay RPC dispatch rejected — returning error to client",
                );
                // Send an error response back so the client's request REJECTS instead
                // of HANGING forever. Without this, any forwarded RPC whose handler
                // throws (e.g. a restore_session that can't resume — "persistence
                // handle has no sessionId") leaves the client's pending request
                // unanswered: the UI spinner sticks and no toast ever fires ("I click
                // and nothing happens"). Carry the inner requestId so the client
                // correlates it to the pending request and surfaces the message.
                const innerReqId = (rpc.inner as { requestId?: string } | undefined)?.requestId;
                if (innerReqId) {
                  relayEmit({
                    type: "cyborg:error",
                    payload: {
                      requestId: innerReqId,
                      code: "dispatch_failed",
                      message:
                        err instanceof Error ? err.message : "request failed on the owning daemon",
                    },
                  });
                }
              }
            })();
          } catch (err) {
            logger.error(
              { err, workspaceId: rpc.workspaceId },
              "Failed to handle forwarded relay RPC — dropping (daemon stays up)",
            );
          }
        } else if (msgType === "cyborg:agent_prompt_forward") {
          const fwd = msg as {
            agentId: string;
            // #579: a forwarded prompt may carry structured content blocks
            // (text + image vision blocks) when a peer daemon already built
            // them; OR a plain string + separate `attachments` from the relay
            // (cloud path), which THIS daemon folds into the prompt below since
            // only it knows the agent's provider.
            prompt: AgentPromptInput;
            attachments?: PromptAttachment[];
            fromUserId?: string;
            fromEmail?: string | null;
          };
          void (async () => {
            const binding = cyborgStorage?.getAgentBinding(fwd.agentId);
            if (binding && !isPromptFromInitiator(binding, fwd)) {
              logger.info(
                { agentId: fwd.agentId, initiatedBy: binding.initiated_by },
                "DM agent prompt rejected — not the initiating user",
              );
              // Tell the sender — their message is already persisted in the
              // chat, so a silent drop looks like the agent ignoring them.
              if (fwd.fromUserId) {
                cyborgBroadcast.toUser(fwd.fromUserId, {
                  type: "cyborg:agent_stream",
                  payload: {
                    agentId: fwd.agentId,
                    workspaceId,
                    event: {
                      type: "turn_failed",
                      provider: binding.provider ?? "unknown",
                      error: "Only the user who started this agent session can prompt it.",
                    },
                  },
                });
              }
              return;
            }
            const fwdTargetDaemon = binding?.daemon_id ?? serverId;
            if (fwd.fromUserId && fwdTargetDaemon) {
              const pg = cyborgStorage?.pg;
              if (pg) {
                const canAccess = await pg.canUserAccessDaemon(
                  workspaceId,
                  fwdTargetDaemon,
                  fwd.fromUserId,
                );
                if (!canAccess) {
                  logger.info(
                    { agentId: fwd.agentId, userId: fwd.fromUserId, daemonId: fwdTargetDaemon },
                    "Daemon access denied for agent prompt forward",
                  );
                  cyborgBroadcast.toUser(fwd.fromUserId, {
                    type: "cyborg:agent_stream",
                    payload: {
                      agentId: fwd.agentId,
                      workspaceId,
                      event: {
                        type: "turn_failed",
                        provider: binding?.provider ?? "unknown",
                        error:
                          "You don't have access to agents on this daemon. Ask the daemon owner to grant you access in Settings > Daemon.",
                      },
                    },
                  });
                  return;
                }
              }
            }
            // Cloud path: fwd.prompt is a plain string + separate attachments →
            // build the vision/excerpt prompt here (this daemon knows the
            // provider). Peer-daemon path: fwd.prompt is already the built
            // AgentPromptInput and attachments is absent → pass through.
            const routedPrompt =
              fwd.attachments && fwd.attachments.length > 0 && typeof fwd.prompt === "string"
                ? await buildAgentPrompt({
                    text: fwd.prompt,
                    attachments: fwd.attachments,
                    supportsImageBlocks: binding?.provider === "claude",
                  })
                : fwd.prompt;
            void cyborgMessageRouter.routeToAgent(fwd.agentId, routedPrompt, {
              rawPrompt: promptInputToText(routedPrompt),
            });
          })();
        } else if (msgType === "cyborg:permission_response_forward") {
          const fwd = msg as { agentId: string; permissionRequestId: string; response: unknown };
          cyborgMessageRouter.respondToPermission(
            fwd.agentId,
            fwd.permissionRequestId,
            fwd.response,
          );
        } else if (msgType === "cyborg:cancel_agent_forward") {
          const fwd = msg as { agentId: string };
          cyborgMessageRouter.cancelAgent(fwd.agentId);
        } else if (msgType === "cyborg:clear_attention_forward") {
          // #591: the relay (or a peer daemon) forwarded a viewed→clear for an
          // agent this daemon owns — clear its derived attention flag so the
          // finished/error badge doesn't resurrect from the next list snapshot.
          const fwd = msg as { agentId: string };
          void agentManager.clearAgentAttention(fwd.agentId).catch(() => undefined);
        } else {
          wsServer?.broadcastCyborgMessageToWorkspace(workspaceId, msg);
        }
      },
    });
    cyborgRelayClient.setAgentCountFn(() => agentManager.listAgents().length);
    const computeActiveCybos = (): Array<{ cyboId: string; agentId: string }> => {
      const runningIds = new Set(agentManager.listAgents().map((a) => a.id));
      const result: Array<{ cyboId: string; agentId: string }> = [];
      for (const wsId of workspaceIds) {
        for (const binding of cyborgStorage.getCyboBindingsByWorkspace(wsId)) {
          if (binding.cybo_id && runningIds.has(binding.agent_id)) {
            result.push({ cyboId: binding.cybo_id, agentId: binding.agent_id });
          }
        }
      }
      return result;
    };
    cyborgRelayClient.setActiveCybosFn(computeActiveCybos);
    // Usage-metrics (round 1) — recomputed snapshots published each heartbeat
    // (and on hello). activeSessionCount = NON-ephemeral agent bindings whose
    // agent is currently live in the agent manager, summed over this daemon's
    // workspaces (reuses getAgentsByWorkspace — the same accessor list_agents
    // reads). A storage hiccup degrades to 0 rather than throwing into the
    // heartbeat path.
    cyborgRelayClient.setActiveSessionCountFn(() => {
      try {
        return countActiveSessions(
          workspaceIds,
          (wsId) => cyborgStorage.getAgentsByWorkspace(wsId),
          new Set(agentManager.listAgents().map((a) => a.id)),
        );
      } catch {
        return 0;
      }
    });
    // activeCyboCount = distinct cyboId among the active cybos already computed
    // for setActiveCybosFn (reuses the exact same snapshot logic).
    cyborgRelayClient.setActiveCyboCountFn(() => {
      try {
        return new Set(computeActiveCybos().map((c) => c.cyboId)).size;
      } catch {
        return 0;
      }
    });
    // Deployment edition resolved ONCE at boot — explicit env beats inferred.
    cyborgRelayClient.setEditionFn(() => daemonEdition);
    cyborgMessageRouter.setRelayClient(cyborgRelayClient);

    // Cybo runtime capability profile (internal docs auth-UX item 3): publish the
    // AUTHENTICATED dimension (per-backend model counts) with the daemon meta.
    // Computed from the provider snapshot's CACHED pi entry (a plain cache read —
    // never a probe) and refreshed on a timer so `cybo login` while the daemon
    // runs reaches the relay within a heartbeat or two.
    let cyboRuntimeProfile: CyboRuntimeProfile | null = null;
    const refreshCyboRuntimeProfile = (): void => {
      void buildCyboRuntimeProfile(providerSnapshotManager).then((profile) => {
        if (profile) cyboRuntimeProfile = profile;
        return undefined;
      });
    };
    // FIX 2 (internal docs): the snapshot's "ready" for a NATIVE harness is
    // binary-only (no host-login check), so a SIGNED-OUT daemon would advertise
    // "claude"/"codex" and the relay would route a native cybo to it (silent
    // auth-fail). Keep a cached set of native ids that probe logged_out, refreshed
    // on the same timer, and post-filter the hello list against it so the
    // advertised capability is HONEST. Read-only + 10s-cached probe — cheap.
    let loggedOutNativeProviders = new Set<string>();
    const readyProviderIds = (): string[] =>
      providerSnapshotManager
        .getSnapshot()
        .filter((e) => e.status === "ready")
        .map((e) => e.provider);
    const refreshLoggedOutNativeProviders = (): Promise<void> =>
      computeLoggedOutNativeProviders(readyProviderIds()).then((set) => {
        loggedOutNativeProviders = set;
        return undefined;
      });
    refreshCyboRuntimeProfile();
    // Initial logged-out-native refresh is AWAITED below (before connect) so the
    // FIRST daemon_hello is honest (internal docs #3); the 60s timer keeps it fresh.
    const cyboRuntimeProfileTimer = setInterval(() => {
      refreshCyboRuntimeProfile();
      void refreshLoggedOutNativeProviders();
    }, 60_000);
    cyboRuntimeProfileTimer.unref?.();
    cyborgRelayClient.setRuntimeProfileFn(() => cyboRuntimeProfile);
    // Report this daemon's READY provider ids in daemon_hello (#697) so the relay
    // routes a cybo mention to a daemon that can run the cybo's harness. Same
    // source cyborg:list_providers reads (the provider snapshot); a signed-out
    // native harness is filtered out (FIX 2) so routing skips it. Sync getter.
    cyborgRelayClient.setProvidersFn(() =>
      honestHelloProviders(readyProviderIds(), loggedOutNativeProviders),
    );
    // Warm the provider snapshot BEFORE connecting so the first daemon_hello
    // reports real providers (#697) — a cold snapshot (the warmUp is async) would
    // omit them and the relay would route mentions capability-blind until a
    // reconnect. Bounded by the snapshot manager's refresh timeout; the hello
    // re-publishes on every reconnect, and a failure here degrades to the blind
    // pick (no regression).
    await providerSnapshotManager.listProviders({ wait: true }).catch(() => []);
    // FIX-2 startup race (internal docs #3): also await the logged-out-native probe
    // BEFORE the first connect/hello. computeLoggedOutNativeProviders reads the now-
    // warm snapshot; without this await the first daemon_hello of a SIGNED-OUT
    // daemon advertises claude/codex as available (loggedOutNativeProviders is still
    // the empty boot set), so the relay routes a native cybo to it / shows ready.
    // Bounded (read-only, cached probe); a failure degrades to the boot empty set
    // (same as before), i.e. no regression vs the prior fire-and-forget.
    await refreshLoggedOutNativeProviders().catch((err) => {
      logger.warn({ err }, "logged-out native provider probe failed at boot");
    });
    // Tasks Phase 3 (internal docs): on every (re)connect, sweep this daemon's
    // OWN overdue/undispatched tasks per workspace and re-dispatch them — once each
    // (the atomic claim inside dispatchTaskToAgent makes a reconnect storm safe).
    // Ownership is sticky: only this daemon's local cybos are passed as assignees,
    // so a task is never reassigned to another daemon. Fire-and-forget per workspace;
    // errors are isolated and never abort the connect path.
    cyborgRelayClient.setOnSubscribed((subscribedWorkspaceIds) => {
      for (const wsId of subscribedWorkspaceIds) {
        const assigneeIds = cyborgStorage.getCybos(wsId).map((c) => c.id);
        if (assigneeIds.length === 0) continue;
        void catchUpOwnedTasks({
          storage: cyborgStorage,
          agentManager,
          workspaceId: wsId,
          assigneeIds,
          serverId,
          cyborg7McpBaseUrl: cyborgTaskMcpUrl,
          logger,
        }).catch((err) =>
          logger.warn({ err, workspaceId: wsId }, "[tasks] reconnect catch-up sweep failed"),
        );
      }
    });
    cyborgRelayClient.connect();
    // connect() is async (the WS hasn't opened, let alone registered, yet). The
    // truthful "connected (registered with relay)" log now fires from inside the
    // client at relay_subscribed; here we only record that we're dialing.
    logger.info(
      { relayUrl: cyborgRelayUrl, workspaces: workspaceIds.length },
      "Cyborg7 relay client connecting",
    );
  }

  if (config.isDev) {
    app.post("/api/cyborg/dev-token", (req, res) => {
      const { email, name } = req.body as { email?: string; name?: string };
      if (!email) {
        res.status(400).json({ error: "email is required" });
        return;
      }
      const token = cyborgAuth.createToken(email, name || email.split("@")[0]);
      const ctx = cyborgAuth.validateToken(token);
      res.json({ token, user: ctx?.user, workspaces: ctx?.workspaces });
    });
    logger.info("Cyborg7 dev token endpoint enabled: POST /api/cyborg/dev-token");
  }

  logger.info({ elapsed: elapsed() }, "Cyborg7 workspace + agent layer initialized");

  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const archiveWorkspaceRecordExternal = async (workspaceId: string) => {
    const sessions = wsServer?.listActiveSessions() ?? [];
    if (sessions.length > 0) {
      await Promise.all(
        sessions.map((session) => session.archiveWorkspaceRecordForExternalMutation(workspaceId)),
      );
      return;
    }

    await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
      projectRegistry,
    });
  };
  const markWorkspaceArchivingExternal = (workspaceIds: Iterable<string>, archivingAt: string) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listActiveSessions() ?? []) {
      session.markWorkspaceArchivingForExternalMutation(workspaceIdList, archivingAt);
    }
  };
  const clearWorkspaceArchivingExternal = (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    for (const session of wsServer?.listActiveSessions() ?? []) {
      session.clearWorkspaceArchivingForExternalMutation(workspaceIdList);
    }
  };
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    const workspaceIdList = Array.from(workspaceIds);
    await Promise.all(
      (wsServer?.listActiveSessions() ?? []).map((session) =>
        session.emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIdList),
      ),
    );
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };

  setupAutoArchiveOnMerge({
    paseoHome: config.paseoHome,
    worktreesRoot: config.worktreesRoot,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving: markWorkspaceArchivingExternal,
    clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  if (mcpEnabled) {
    const agentMcpRoute = "/mcp/agents";
    const agentMcpTransports: AgentMcpTransportMap = new Map();

    const createAgentMcpTransport = async (callerAgentId?: string) => {
      const agentMcpServer = await createAgentMcpServer({
        agentManager,
        agentStorage,
        terminalManager,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        scheduleService,
        providerSnapshotManager,
        github,
        workspaceGitService,
        archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving: markWorkspaceArchivingExternal,
        clearWorkspaceArchiving: clearWorkspaceArchivingExternal,
        createPaseoWorktree: async (input, serviceOptions) => {
          return createPaseoWorktreeWorkflow(
            {
              paseoHome: config.paseoHome,
              worktreesRoot: config.worktreesRoot,
              createPaseoWorktree: async (workflowInput, workflowOptions) => {
                return createRegisteredPaseoWorktree(workflowInput, {
                  github,
                  ...(workflowOptions?.resolveDefaultBranch
                    ? {
                        resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                      }
                    : {}),
                  projectRegistry,
                  workspaceRegistry,
                  workspaceGitService,
                });
              },
              warmWorkspaceGitData: async (workspace) => {
                await Promise.all(
                  wsServer
                    ?.listActiveSessions()
                    .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
                );
              },
              emitWorkspaceUpdateForCwd: async (cwd, emitOptions) => {
                await Promise.all(
                  wsServer
                    ?.listActiveSessions()
                    .map((session) => session.emitWorkspaceUpdatesForExternalCwds([cwd])) ?? [],
                );
                void emitOptions;
              },
              cacheWorkspaceSetupSnapshot: () => {},
              emit: emitExternalSessionMessage,
              sessionLogger: logger,
              terminalManager,
              archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
              serviceProxy,
              scriptRuntimeStore,
              getDaemonTcpPort: () =>
                boundListenTarget?.type === "tcp" ? boundListenTarget.port : null,
              getDaemonTcpHost: () =>
                boundListenTarget?.type === "tcp" ? boundListenTarget.host : null,
              serviceProxyPublicBaseUrl,
              onScriptsChanged: null,
            },
            input,
            serviceOptions,
          );
        },
        paseoHome: config.paseoHome,
        worktreesRoot: config.worktreesRoot,
        callerAgentId,
        enableVoiceTools: false,
        resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
        resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
        logger,
      });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          agentMcpTransports.set(sessionId, transport);
          logger.debug({ sessionId }, "Agent MCP session initialized");
        },
        onsessionclosed: (sessionId) => {
          agentMcpTransports.delete(sessionId);
          logger.debug({ sessionId }, "Agent MCP session closed");
        },
        // NOTE: We enforce a Vite-like host allowlist at the app/websocket layer.
        // StreamableHTTPServerTransport's built-in check requires exact Host header matches.
        enableDnsRebindingProtection: false,
      });

      Object.assign(transport, {
        onclose: () => {
          if (transport.sessionId) {
            agentMcpTransports.delete(transport.sessionId);
          }
        },
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });

      await agentMcpServer.connect(transport);
      return transport;
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? REDACTED_LOG_VALUE : undefined,
            body: summarizeAgentMcpDebugBody(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        const sessionId = req.header("mcp-session-id");
        let transport = sessionId ? agentMcpTransports.get(sessionId) : undefined;

        if (!transport) {
          if (req.method !== "POST") {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Missing or invalid MCP session",
              },
              id: null,
            });
            return;
          }
          if (!isInitializeRequest(req.body)) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Initialization request expected",
              },
              id: null,
            });
            return;
          }
          const callerAgentIdRaw = req.query.callerAgentId;
          let callerAgentId: string | undefined;
          if (typeof callerAgentIdRaw === "string") {
            callerAgentId = callerAgentIdRaw;
          } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
            callerAgentId = callerAgentIdRaw[0];
          }
          transport = await createAgentMcpTransport(callerAgentId);
        }

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute }, "Agent MCP server mounted on main app");

    // Cyborg7 MCP endpoint — workspace tools (send_message, tasks, channels, roster)
    const cyborg7McpRoute = "/mcp/cyborg7";
    type Cyborg7McpTransportMap = Map<string, InstanceType<typeof StreamableHTTPServerTransport>>;
    const cyborg7McpTransports: Cyborg7McpTransportMap = new Map();

    const createCyborg7McpTransport = async (workspaceId: string, agentId: string) => {
      // Real enforcement of the cybo's platform_permissions: resolve the agent's
      // cybo and only expose the cyborg7_* tools it's been granted. A non-cybo
      // agent (no binding/cybo) stays unrestricted.
      let platformPermissions: string[] | undefined;
      const binding = cyborgStorage.getAgentBinding(agentId);
      if (binding?.cybo_id) {
        const cybo = cyborgStorage.getCybo(binding.cybo_id);
        if (cybo?.platform_permissions) {
          try {
            const parsed: unknown = JSON.parse(cybo.platform_permissions);
            platformPermissions = Array.isArray(parsed)
              ? parsed.filter((p): p is string => typeof p === "string")
              : [];
          } catch {
            // Malformed permissions JSON — leave unrestricted (empty list) rather
            // than break the cybo over bad data; consistent with empty=unrestricted.
            platformPermissions = [];
          }
        }
      }
      const mcpServer = createCyborg7McpServer(
        {
          storage: cyborgStorage,
          messageRouter: cyborgMessageRouter,
          workspaceManager: cyborgWorkspaceManager,
          // Cloud-workspace reads (channels/membership/history) live in the
          // relay's PG, not this daemon's SQLite — give the tools the relay
          // round-trip the UI itself uses. Null in solo mode (SQLite serves).
          cyboRead: cyborgRelayClient ? (req) => cyborgRelayClient!.cyboRead(req) : undefined,
          // Task writes take the same relay round-trip, so cybo-created tasks
          // land in the SHARED tasks table the UI reads (not just local SQLite).
          cyboWrite: cyborgRelayClient ? (req) => cyborgRelayClient!.cyboWrite(req) : undefined,
          // Cross-session recall (OWNER-SCOPED): sessions + their timelines live in
          // THIS daemon's local SQLite (agent_bindings + agent_timeline_rows; not the
          // relay's PG), so the recall tools resolve daemon-locally. Owner scoping is
          // enforced inside CyboSessionContext at the data layer (the binding set).
          sessionContext: new CyboSessionContext(cyborgStorage, durableTimelineStore),
        },
        {
          workspaceId,
          agentId,
          cyboId: binding?.cybo_id ?? undefined,
          platformPermissions,
          // A NON-cybo agent (no cybo binding) acts with its SPAWNING USER's
          // authority: its task/schedule writes are owned by that user (the
          // binding's initiated_by), not the ephemeral agent UUID — so a schedule's
          // created_by is a real workspace member and the runner's
          // isCreatorStillAuthorized passes. A cybo keeps its own owner attribution
          // (the cybo's owner), so this stays undefined for cybos.
          initiatedByUserId: binding?.cybo_id ? undefined : (binding?.initiated_by ?? undefined),
          // The channel this agent is bound to, so create_task can auto-resolve the
          // channel's Tasks-project when the cybo doesn't pass an explicit channelId.
          channelId: binding?.channel_id ?? undefined,
        },
      );

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          cyborg7McpTransports.set(sessionId, transport);
          logger.debug({ sessionId, workspaceId, agentId }, "Cyborg7 MCP session initialized");
        },
        onsessionclosed: (sessionId) => {
          cyborg7McpTransports.delete(sessionId);
          logger.debug({ sessionId }, "Cyborg7 MCP session closed");
        },
        enableDnsRebindingProtection: false,
      });

      Object.assign(transport, {
        onclose: () => {
          if (transport.sessionId) {
            cyborg7McpTransports.delete(transport.sessionId);
          }
        },
        onerror: (err: Error) => {
          logger.error({ err }, "Cyborg7 MCP transport error");
        },
      });

      await mcpServer.connect(transport);
      return transport;
    };

    const runCyborg7McpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      try {
        const sessionId = req.header("mcp-session-id");
        let transport = sessionId ? cyborg7McpTransports.get(sessionId) : undefined;

        if (!transport) {
          if (req.method !== "POST") {
            res.status(400).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Missing or invalid MCP session" },
              id: null,
            });
            return;
          }
          if (!isInitializeRequest(req.body)) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: "Initialization request expected" },
              id: null,
            });
            return;
          }

          const workspaceId =
            typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
          const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;

          if (!workspaceId || !agentId) {
            res.status(400).json({
              jsonrpc: "2.0",
              error: { code: -32000, message: "workspaceId and agentId query params required" },
              id: null,
            });
            return;
          }

          transport = await createCyborg7McpTransport(workspaceId, agentId);
        }

        await transport.handleRequest(
          req as unknown as IncomingMessage,
          res as unknown as ServerResponse,
          req.body,
        );
      } catch (err) {
        logger.error({ err }, "Failed to handle Cyborg7 MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal MCP server error" },
            id: null,
          });
        }
      }
    };

    const handleCyborg7McpRequest: express.RequestHandler = (req, res) => {
      void runCyborg7McpRequest(req, res);
    };

    app.post(cyborg7McpRoute, handleCyborg7McpRequest);
    app.get(cyborg7McpRoute, handleCyborg7McpRequest);
    app.delete(cyborg7McpRoute, handleCyborg7McpRequest);
    logger.info({ route: cyborg7McpRoute }, "Cyborg7 MCP server mounted on main app");
  } else {
    logger.info("Agent MCP HTTP endpoint disabled");
  }

  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  logger.info({ elapsed: elapsed() }, "Speech service created");

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            const mcpBaseUrl = mcpEnabled ? createAgentMcpBaseUrl(boundListenTarget) : null;
            agentMcpBaseUrl = config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            // Cyborg7: expose the cyborg MCP base URL to the dispatcher.
            const cyborg7McpUrl = mcpEnabled ? createCyborg7McpBaseUrl(boundListenTarget) : null;
            cyborgDispatcher.setCyborg7McpBaseUrl(cyborg7McpUrl);
            // Inject the cyborg7 MCP server into NON-cybo workspace agents too, so a
            // plain Claude/Codex session can create its own tasks/schedules (a cybo
            // already gets its own via spawnCybo — see AgentManager.injectMcpServers).
            agentManager.setCyborg7McpBaseUrl(cyborg7McpUrl);
            cyborgMessageRouter.setCyborg7McpBaseUrl(cyborg7McpUrl);
            cyborgScheduleRunner.setCyborg7McpBaseUrl(cyborg7McpUrl ?? undefined);
            cyborgTaskMcpUrl = cyborg7McpUrl ?? undefined;
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(value ? mcpBaseUrl : null);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            const relayEnabled = config.relayEnabled ?? true;
            // Deterministic relay endpoint (#664): the relay resolved above
            // (env → cyborg-relay-url file → config), NEVER relay.paseo.sh —
            // fails loud when enabled-but-unconfigured. See relayTransportConfig.
            const { endpoint: relayEndpoint, useTls: relayUseTls } = relayTransportConfig({
              relayEnabled,
              resolvedRelay,
              relayUrlFilePath,
              logger,
            });
            const relayPublicEndpoint = config.relayPublicEndpoint ?? relayEndpoint;
            const relayPublicUseTls = config.relayPublicUseTls ?? relayUseTls;
            const appBaseUrl = config.appBaseUrl ?? "https://app.paseo.sh";

            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.paseoHome,
              daemonConfigStore,
              mcpBaseUrl,
              { allowedOrigins, hostnames: configuredHostnames },
              config.auth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              chatService,
              loopService,
              scheduleService,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                relay: {
                  enabled: relayEnabled,
                  endpoint: relayEndpoint,
                  publicEndpoint: relayPublicEndpoint,
                  useTls: relayUseTls,
                  publicUseTls: relayPublicUseTls,
                },
              },
              serviceProxyPublicBaseUrl,
            );

            // Cyborg7: wire the dispatcher + daemon storage mode into the WS server.
            wsServer.setCyborgDispatcher(cyborgDispatcher);
            wsServer.setCyborgDaemonMode(cyborgStorage.mode);

            if (relayEnabled) {
              const offer = await createConnectionOfferV2({
                serverId,
                daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
                relay: {
                  endpoint: relayPublicEndpoint,
                  useTls: relayPublicUseTls,
                },
              });

              encodeOfferToFragmentUrl({ offer, appBaseUrl });
              // Cyborg7: hand the pairing offer to the WS server + dispatcher.
              wsServer.setCyborgPairingOffer(offer);
              cyborgDispatcher.setPairingOffer(offer);

              // Cyborg7: start the Paseo relay transport ONLY for pure-Paseo
              // daemons; skip it for any cyborg-resolved relay (it has no /ws and
              // would storm — see startPaseoRelayTransportUnlessCyborg).
              relayTransport?.stop().catch(() => undefined);
              relayTransport = startPaseoRelayTransportUnlessCyborg({
                resolvedRelay,
                logger,
                options: {
                  logger,
                  attachSocket: (ws, metadata) => {
                    if (!wsServer) {
                      throw new Error("WebSocket server not initialized");
                    }
                    return wsServer.attachExternalSocket(ws, metadata);
                  },
                  relayEndpoint,
                  relayUseTls,
                  serverId,
                  daemonKeyPair: daemonKeyPair.keyPair,
                },
              });
            }
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      await serviceProxy.stopStandalone().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async () => {
    scriptHealthMonitor.stop();
    await closeAllAgents(logger, agentManager);
    // Cyborg7: closeAllAgents() releases the providers' refs, but the OpenCode
    // server (`opencode serve`) + Codex app-server (`codex app-server`) backends
    // are spawned `detached: true` (their own process group), so the desktop's
    // supervisor-group SIGKILL (#851) never reaches them and a hard daemon death
    // skips the providers' exit handlers — they orphan to PPID 1. Tree-kill THIS
    // daemon's own agent-backend descendants here, before the process exits, so
    // they can't accumulate. The pty-host (and its ptys) are excluded so terminal
    // persistence holds. See agent-backend-reaper.ts.
    await killOwnAgentBackends(logger).catch((err) => {
      logger.warn({ err }, "Agent-backend kill failed during shutdown");
      return [];
    });
    await agentManager.flush().catch(() => undefined);
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    await providerSnapshotManager.shutdown();
    cyborgDispatcher.disposeTerminals();
    // PtyHost mode (internal docs): disposeTerminals() already DETACHED the
    // daemon-side wrappers and tore down the host link, leaving every pty ALIVE in
    // the detached host so the next daemon re-attaches. Calling killAll() here is
    // the WORKER path's destructive teardown — skip it so survival holds. (The
    // PtyHost manager's killAll is a no-op detach anyway, but make intent explicit.)
    if (!isPtyHostEnabled()) {
      terminalManager.killAll();
    }
    speechService.stop();
    await scheduleService.stop().catch(() => undefined);
    cyborgScheduleRunner.stop();
    if (cyborgWebhookDeliverySweep) clearInterval(cyborgWebhookDeliverySweep);
    cyborgRelayClient?.close();
    await relayTransport?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    await serviceProxy.stopStandalone();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
  };
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await agentManager.closeAgent(agent.id);
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}

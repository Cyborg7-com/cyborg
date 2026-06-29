import { WebSocket } from "ws";
import { createRequire } from "node:module";
import type { Logger } from "pino";
import type { DualStorage } from "./dual-storage.js";
import type { CyboRuntimeProfile } from "./cybo-runtime-profile.js";
import type {
  RelaySubscribed,
  RelayMessage,
  RelaySyncResponse,
  RelayError,
  CyboReadRequest,
  CyboReadResponse,
  CyboWriteRequest,
  CyboWriteResponse,
  UploadImageRequest,
  UploadImageResponse,
} from "./relay-protocol.js";
import type { DaemonTelemetryEvent, DaemonTelemetryFrame } from "./daemon-telemetry.js";

type RelayInbound =
  | RelaySubscribed
  | RelayMessage
  | RelaySyncResponse
  | RelayError
  | CyboReadResponse
  | CyboWriteResponse
  | UploadImageResponse;

// Static machine/capability metadata reported to the relay at connect and on
// every heartbeat: location (host/OS) + cybo capability flag.
// The daemon's own package version, read once and cached. Published in the
// heartbeat meta so the UI can detect outdated daemons (#663). Best-effort —
// returns null if the package.json can't be resolved (never throws into the
// heartbeat path).
let cachedDaemonVersion: string | null | undefined;
function readDaemonVersion(): string | null {
  if (cachedDaemonVersion !== undefined) return cachedDaemonVersion;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../../package.json") as { version?: string };
    cachedDaemonVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    cachedDaemonVersion = null;
  }
  return cachedDaemonVersion;
}

export interface DaemonStaticMeta {
  host?: string;
  platform?: string;
  arch?: string;
  cyboInstalled?: boolean;
  // Running daemon CLI version, published so the UI can flag outdated daemons
  // and surface the "N daemons outdated → Update" aggregate (#663). Optional /
  // back-compat: older daemons omit it; populated by metaWithRuntime below so it
  // doesn't depend on the bootstrap caller passing it.
  version?: string;
}

export interface DaemonRelayClientOpts {
  relayUrl: string;
  daemonId: string;
  token: string;
  workspaceIds: string[];
  label?: string;
  storage: DualStorage;
  staticMeta?: DaemonStaticMeta;
  onMessage?: (workspaceId: string, fromDaemonId: string, message: Record<string, unknown>) => void;
  reconnectMs?: number;
  // Pino logger so the relay-client lifecycle (real registration success, errors,
  // and auth-rejection closes) lands in $PASEO_HOME/daemon.log instead of only on
  // stderr via console.error. Optional: standalone callers (cybo-runner) may omit
  // it and fall back to console.
  logger?: Logger;
  // WebSocket factory — defaults to `new WebSocket(url)`. Injectable so the
  // half-open / keepalive behavior can be unit-tested without a real socket.
  createWebSocket?: (url: string) => WebSocket;
}

// WS-level keepalive tuning. We send a protocol ping on an interval purely to
// keep the daemon↔relay link warm so a proxy/ALB doesn't drop it for idle.
//
// We deliberately do NOT terminate the socket based on a missed-pong "stale"
// window (the #801 approach, internal docs P0a). The daemon↔relay link runs
// through an ALB (relay.cyborg7.com) that DROPS WebSocket ping/pong control
// frames, so the `on("pong")` liveness bump never fires; combined with idle
// gaps, a perfectly healthy socket would go "stale" and be terminated every
// stale-window (observed: terminate→reconnect EXACTLY every 30s, dropping the
// in-flight terminal output and cybo replies of each reconnect). The relay
// already owns dead-daemon detection from its side — workspace-relay.ts pings
// every 20s and sweepDeadDaemons terminates after 90s of no INBOUND frames
// (which DO traverse the ALB). So a daemon-side pong-stale terminate is both
// redundant and broken behind the ALB. Real socket closes/errors still trigger
// reconnect via the existing on("close")/on("error") handlers.
const WS_PING_INTERVAL_MS = 10_000;

export class DaemonRelayClient {
  private ws: WebSocket | null = null;
  private readonly relayUrl: string;
  private readonly daemonId: string;
  private readonly token: string;
  private readonly workspaceIds: string[];
  private readonly label: string | undefined;
  private readonly storage: DualStorage;
  private readonly staticMeta: DaemonStaticMeta;
  private readonly onMessage: DaemonRelayClientOpts["onMessage"];
  private readonly reconnectMs: number;
  private readonly logger: Logger | null;
  private readonly createWebSocket: (url: string) => WebSocket;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // WS-level keepalive: a ping interval to keep the link warm. No pong/stale
  // tracking — pong is unreliable through the ALB, so we never terminate based
  // on it (see WS_PING_INTERVAL_MS comment).
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeqs = new Map<string, number>();
  private connected = false;
  private closed = false;
  private agentCountFn: (() => number) | null = null;
  // Installed/ready provider ids, republished on every (re)connect so the relay
  // can route cybo mentions to a capable daemon (#697). A getter, not static: a
  // provider can become available after boot (login, install).
  private providersFn: (() => string[]) | null = null;
  private activeCybosFn: (() => Array<{ cyboId: string; agentId: string }>) | null = null;
  // Usage-metrics heartbeat (round 1): live snapshot counts recomputed each
  // heartbeat (NOT event-driven) + the deployment edition resolved once at boot.
  // Getters, not static meta, so each (re)connect/heartbeat republishes the
  // current value. Guarded in metaWithRuntime: a count defaults to 0 and edition
  // is omitted when its source isn't wired — never throw into the heartbeat path.
  private activeSessionCountFn: (() => number) | null = null;
  private activeCyboCountFn: (() => number) | null = null;
  private editionFn: (() => "saas" | "selfhost" | "opensource" | undefined) | null = null;
  // Live cybo-runtime capability (authenticated backends + model counts). A
  // getter, not static meta: auth changes while the daemon runs (cybo login),
  // and each heartbeat republishes the latest value.
  private runtimeProfileFn: (() => CyboRuntimeProfile | null) | null = null;
  // Tasks Phase 3 (internal docs): daemon-side reconnect hook. Fired on every
  // relay_subscribed (initial connect + each reconnect) so the daemon can sweep its
  // OWN overdue/undispatched tasks and re-dispatch them — once each, idempotent via
  // the atomic dispatch claim. Runs on the DAEMON (it owns the cybos + agentManager;
  // the relay runs no agents). Ownership is sticky: only this daemon's tasks.
  private onSubscribedFn: ((workspaceIds: readonly string[]) => void) | null = null;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_MS = 60_000;

  constructor(opts: DaemonRelayClientOpts) {
    this.relayUrl = opts.relayUrl;
    this.daemonId = opts.daemonId;
    this.token = opts.token;
    this.workspaceIds = opts.workspaceIds;
    this.label = opts.label;
    this.storage = opts.storage;
    this.staticMeta = opts.staticMeta ?? {};
    this.onMessage = opts.onMessage;
    this.reconnectMs = opts.reconnectMs ?? 3000;
    this.logger = opts.logger ?? null;
    this.createWebSocket = opts.createWebSocket ?? ((url) => new WebSocket(url));

    for (const wsId of this.workspaceIds) {
      this.lastSeqs.set(wsId, 0);
    }
  }

  connect(): void {
    if (this.closed) return;

    if (this.ws) {
      // removeAllListeners means the old socket's close handler won't fire, so
      // its keepalive timer must be torn down here to avoid a leaked interval.
      this.stopKeepalive();
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, "reconnecting");
      }
      this.ws = null;
    }

    const socket = this.createWebSocket(this.relayUrl);
    this.ws = socket;

    this.ws.on("open", () => {
      this.startKeepalive(socket);
      const providers = this.providersFn?.();
      this.ws!.send(
        JSON.stringify({
          type: "daemon_hello",
          daemonId: this.daemonId,
          token: this.token,
          workspaceIds: this.workspaceIds,
          label: this.label,
          meta: this.metaWithRuntime(),
          // Omit when empty/unknown so the frame stays identical for callers that
          // don't wire providersFn (the relay then degrades to the blind pick).
          ...(providers && providers.length > 0 ? { providers } : {}),
        }),
      );
    });

    this.ws.on("message", (data) => {
      let msg: RelayInbound;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handleInbound(msg);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      this.stopKeepalive();
      // Auth-rejection close codes (relay rejected daemon_hello — e.g. a stale or
      // wrong daemon token, see relay-standalone 4001/4002/4003): a 1006/1000
      // close is a normal network blip, but a 400x close means registration will
      // keep failing until the token is fixed, so make it diagnosable in
      // daemon.log instead of an unexplained reconnect loop.
      if (code === 4001 || code === 4002 || code === 4003) {
        this.logger?.error(
          { code, reason: reason?.toString() || undefined, relayUrl: this.relayUrl },
          "Cyborg7 relay rejected daemon registration — check the daemon token (re-run 'cyborg daemon claim')",
        );
      } else if (wasConnected) {
        this.logger?.warn(
          { code, reason: reason?.toString() || undefined },
          "Cyborg7 relay connection closed — reconnecting",
        );
      }
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      if (this.logger) {
        this.logger.error({ err, relayUrl: this.relayUrl }, "Cyborg7 relay client socket error");
      } else {
        console.error(`[DaemonRelayClient] error: ${err.message}`);
      }
      this.connected = false;
      this.stopHeartbeat();
      this.stopKeepalive();
      this.scheduleReconnect();
    });
  }

  // WS-level keepalive. Sends a protocol ping every interval purely to keep the
  // link warm against idle proxy/ALB timeouts. It does NOT terminate on a missed
  // pong — pong frames are dropped by the ALB, so a stale-window terminate would
  // kill healthy connections every window (the #801 regression). Dead-daemon
  // detection is owned by the relay (workspace-relay.ts sweepDeadDaemons, 90s of
  // no inbound frames). Genuine local socket failures still reconnect: a ping()
  // that throws means the underlying socket is already broken, so we terminate to
  // emit "close" and let the existing exp-backoff reconnect path fire.
  private startKeepalive(socket: WebSocket): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.closed) return;
      if (this.ws !== socket) return;
      if (socket.readyState !== WebSocket.OPEN) return;

      try {
        socket.ping();
      } catch (err) {
        this.logger?.warn({ err, relayUrl: this.relayUrl }, "Cyborg7 relay ping send failed");
        try {
          socket.terminate();
        } catch (terminateErr) {
          this.logger?.warn({ err: terminateErr }, "Cyborg7 relay socket terminate failed");
        }
      }
    }, WS_PING_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private handleInbound(msg: RelayInbound): void {
    switch (msg.type) {
      case "relay_subscribed":
        this.connected = true;
        this.reconnectAttempts = 0;
        // The REAL "daemon online" moment: the relay accepted daemon_hello and
        // subscribed us. Logging here (not at connect() call time, before the
        // socket has even opened) makes "daemon online" truthful in daemon.log.
        this.logger?.info(
          { relayUrl: this.relayUrl, workspaces: this.workspaceIds.length },
          "Cyborg7 relay client connected (registered with relay)",
        );
        this.startHeartbeat();
        this.requestSync();
        // Tasks Phase 3: sweep this daemon's owned overdue/undispatched tasks now
        // that it's online again. Isolated — a sweep failure must never abort the
        // connect path or crash the worker.
        if (this.onSubscribedFn) {
          try {
            this.onSubscribedFn(this.workspaceIds);
          } catch (err) {
            this.logger?.warn({ err }, "[tasks] reconnect catch-up hook failed");
          }
        }
        break;

      case "relay_message":
        this.handleRelayMessage(msg);
        break;

      case "relay_sync_response":
        this.handleSyncResponse(msg);
        break;

      case "relay_error":
        if (this.logger) {
          this.logger.error({ error: msg.error }, "Cyborg7 relay returned an error");
        } else {
          console.error(`[DaemonRelayClient] relay error: ${msg.error}`);
        }
        break;

      case "cybo_read_response": {
        const pending = this.pendingCyboReads.get(msg.requestId);
        if (pending) {
          this.pendingCyboReads.delete(msg.requestId);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
        break;
      }

      case "cybo_write_response": {
        const pending = this.pendingCyboWrites.get(msg.requestId);
        if (pending) {
          this.pendingCyboWrites.delete(msg.requestId);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
        break;
      }

      case "upload_image_response": {
        const pending = this.pendingImageUploads.get(msg.requestId);
        if (pending) {
          this.pendingImageUploads.delete(msg.requestId);
          clearTimeout(pending.timer);
          pending.resolve(msg);
        }
        break;
      }
    }
  }

  // ── Cybo data reads over the relay ──────────────────────────────
  // The cybo's MCP tools run on this daemon, but a CLOUD workspace's channels /
  // membership / history live only in the relay's PG. Ask the relay (the same
  // source the UI uses) and resolve with its response; null on timeout or when
  // disconnected — the caller falls back to local SQLite (solo mode) or reports
  // the data as unavailable rather than silently empty.
  private pendingCyboReads = new Map<
    string,
    { resolve: (r: CyboReadResponse | null) => void; timer: ReturnType<typeof setTimeout> }
  >();

  // Resolve true once the relay socket is subscribed + OPEN, polling up to maxMs.
  // Used by cyboRead so a read fired during a reconnect window waits for the
  // socket instead of immediately degrading to the local fallback. Returns the
  // live state (false) if it never comes up — the caller still falls back then.
  private async waitForConnection(maxMs: number): Promise<boolean> {
    const isUp = () => !this.closed && this.connected && this.ws?.readyState === WebSocket.OPEN;
    if (isUp()) return true;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (this.closed) return false; // shut down mid-wait — abort, don't poll the full window
      await new Promise((r) => setTimeout(r, 150));
      if (isUp()) return true;
    }
    return isUp();
  }

  async cyboRead(
    req: Omit<CyboReadRequest, "type" | "requestId">,
  ): Promise<CyboReadResponse | null> {
    // A cron-fired cybo read runs off a local setInterval (schedule-runner), fully
    // decoupled from relay connectivity — so the socket can be mid-reconnect at
    // read time even on a healthy daemon. Returning null here makes the roster /
    // members tools silently fall back to local SQLite, which on a PG-less cloud
    // daemon holds only placeholder rows (<uuid>@remote.local, null names) — the
    // cybo then can't identify half the workspace. Wait briefly for the socket
    // (the reconnect loop runs every reconnectMs, default 3s) before giving up, so
    // a transient blip resolves to real cloud-PG data instead of garbage.
    if (!(await this.waitForConnection(5000))) return null;
    const requestId = `cr_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    return await new Promise<CyboReadResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCyboReads.delete(requestId);
        resolve(null);
      }, 8000);
      this.pendingCyboReads.set(requestId, { resolve, timer });
      this.send({ type: "cybo_read_request", requestId, ...req } satisfies CyboReadRequest);
    });
  }

  // ── Cybo task writes over the relay ─────────────────────────────
  // Same shape as cyboRead, for MUTATIONS: the relay validates and writes the
  // SHARED tasks table (the rows the UI sees). null on timeout/disconnect — and
  // crucially on an OLD relay that doesn't know cybo_write_request (it ignores
  // the frame and never answers) — so the caller falls back to the local write,
  // which is exactly today's behavior.
  private pendingCyboWrites = new Map<
    string,
    { resolve: (r: CyboWriteResponse | null) => void; timer: ReturnType<typeof setTimeout> }
  >();

  async cyboWrite(
    req: Omit<CyboWriteRequest, "type" | "requestId">,
  ): Promise<CyboWriteResponse | null> {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return null;
    const requestId = `cw_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    return await new Promise<CyboWriteResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCyboWrites.delete(requestId);
        resolve(null);
      }, 8000);
      this.pendingCyboWrites.set(requestId, { resolve, timer });
      this.send({ type: "cybo_write_request", requestId, ...req } satisfies CyboWriteRequest);
    });
  }

  // ── Agent image upload over the relay ───────────────────────────
  // Only the relay holds S3 credentials. The daemon ships an agent-generated
  // image's bytes inline; the relay PUTs them to S3 and returns the public URL.
  // null on timeout/disconnect/old-relay — the caller leaves the local markdown
  // token as-is (renders as a safe link, not embedded). 20s: an image PUT to S3
  // is slower than a PG read.
  private pendingImageUploads = new Map<
    string,
    { resolve: (r: UploadImageResponse | null) => void; timer: ReturnType<typeof setTimeout> }
  >();

  async uploadImage(
    req: Omit<UploadImageRequest, "type" | "requestId">,
  ): Promise<UploadImageResponse | null> {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return null;
    const requestId = `ui_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    return await new Promise<UploadImageResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingImageUploads.delete(requestId);
        resolve(null);
      }, 20000);
      this.pendingImageUploads.set(requestId, { resolve, timer });
      this.send({ type: "upload_image_request", requestId, ...req } satisfies UploadImageRequest);
    });
  }

  private handleRelayMessage(msg: RelayMessage): void {
    const { workspaceId, fromDaemonId, seq, message } = msg;

    const lastSeq = this.lastSeqs.get(workspaceId) ?? 0;
    if (seq > lastSeq) {
      this.lastSeqs.set(workspaceId, seq);
    }

    if (fromDaemonId === this.daemonId) return;

    try {
      this.ingestMessage(workspaceId, message);
    } catch (err) {
      this.logger?.error({ err }, "[DaemonRelayClient] failed to ingest live message");
    }
    this.onMessage?.(workspaceId, fromDaemonId, message);
  }

  private handleSyncResponse(msg: RelaySyncResponse): void {
    for (const rawMsg of msg.messages) {
      // Never let a single bad message in a relay sync batch crash the daemon.
      // insertMessageRaw is now idempotent (INSERT OR IGNORE), but defend
      // against any other ingest error bubbling up as an uncaught exception.
      try {
        this.ingestMessage(msg.workspaceId, rawMsg as Record<string, unknown>);
      } catch (err) {
        this.logger?.error({ err }, "[DaemonRelayClient] failed to ingest synced message");
      }

      const payload = (rawMsg as Record<string, unknown>).payload as
        | Record<string, unknown>
        | undefined;
      if (payload && typeof payload.seq === "number") {
        const lastSeq = this.lastSeqs.get(msg.workspaceId) ?? 0;
        if (payload.seq > lastSeq) {
          this.lastSeqs.set(msg.workspaceId, payload.seq);
        }
      }
    }
  }

  private ingestMessage(workspaceId: string, message: Record<string, unknown>): void {
    const isChannel = message.type === "cyborg:channel_message_broadcast";
    const isDm = message.type === "cyborg:dm_broadcast";
    // DMs were previously dropped here (only channel messages were ingested), so a
    // DM sent on another daemon was never persisted to this daemon's SQLite.
    if (!isChannel && !isDm) return;
    if (typeof message.payload !== "object" || message.payload === null) return;
    const p = message.payload as Record<string, unknown>;
    if (!p.id) return;

    // No racy limit:1 dedup — insertMessageRaw is INSERT OR IGNORE (idempotent by
    // primary key id), so a replayed message is a no-op regardless of order.
    this.storage.sqlite.insertMessageRaw({
      id: p.id as string,
      workspaceId,
      channelId: isChannel ? ((p.channelId as string) ?? null) : null,
      fromId: p.fromId as string,
      fromType: (p.fromType as "human" | "agent") ?? "human",
      fromName: (p.fromName as string) ?? null,
      toId: (p.toId as string) ?? null,
      text: p.text as string,
      mentions: (p.mentions as string[] | null) ?? null,
      parentId: (p.parentId as string) ?? null,
      attachments: (p.attachments as unknown[] | null) ?? null,
      seq: (p.seq as number) ?? 0,
      createdAt: (p.createdAt as number) ?? Date.now(),
    });
  }

  private requestSync(): void {
    for (const wsId of this.workspaceIds) {
      const lastSeq = this.lastSeqs.get(wsId) ?? 0;
      if (lastSeq > 0) {
        this.send({
          type: "relay_sync_request",
          workspaceId: wsId,
          sinceSeq: lastSeq,
        });
      }
    }
  }

  forward(workspaceId: string, message: Record<string, unknown>): void {
    this.send({
      type: "relay_forward",
      workspaceId,
      message,
    });
  }

  // Best-effort central telemetry: emit a structured daemon-side failure over the
  // already-open relay WS so it lands in the relay's /cyborg7/relay log group.
  // Fire-and-forget (drops silently while disconnected, like every other send) —
  // telemetry must never throw into a failure-handling path.
  sendTelemetry(event: DaemonTelemetryEvent): void {
    this.send({ type: "cyborg:telemetry", event } satisfies DaemonTelemetryFrame);
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectAttempts++;
    // Retry FOREVER with capped backoff. A daemon must survive transient network
    // loss (laptop sleep, wifi drop) and reconnect whenever the relay is reachable
    // again. The old 20-attempt cap left the daemon permanently offline after an
    // overnight sleep even though the relay was up the whole time. The exponent is
    // clamped so the backoff just settles at MAX_RECONNECT_MS and never overflows.
    const delay = Math.min(
      this.reconnectMs * Math.pow(1.5, Math.min(this.reconnectAttempts - 1, 12)),
      DaemonRelayClient.MAX_RECONNECT_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastSeq(workspaceId: string): number {
    return this.lastSeqs.get(workspaceId) ?? 0;
  }

  setProvidersFn(fn: () => string[]): void {
    this.providersFn = fn;
  }

  setAgentCountFn(fn: () => number): void {
    this.agentCountFn = fn;
  }

  setActiveCybosFn(fn: () => Array<{ cyboId: string; agentId: string }>): void {
    this.activeCybosFn = fn;
  }

  setActiveSessionCountFn(fn: () => number): void {
    this.activeSessionCountFn = fn;
  }

  setActiveCyboCountFn(fn: () => number): void {
    this.activeCyboCountFn = fn;
  }

  setEditionFn(fn: () => "saas" | "selfhost" | "opensource" | undefined): void {
    this.editionFn = fn;
  }

  setRuntimeProfileFn(fn: () => CyboRuntimeProfile | null): void {
    this.runtimeProfileFn = fn;
  }

  // Tasks Phase 3: register the reconnect catch-up sweep (fired on relay_subscribed).
  setOnSubscribed(fn: (workspaceIds: readonly string[]) => void): void {
    this.onSubscribedFn = fn;
  }

  // staticMeta + the live runtime profile (omitted while unknown, so the relay
  // never persists a false "unauthenticated" before the first snapshot settles).
  // Also stamps the daemon's running `version` (for the #663 outdated detection)
  // here rather than in the bootstrap caller, so it's published without the
  // caller having to thread it through staticMeta.
  private metaWithRuntime(): Record<string, unknown> {
    const profile = this.runtimeProfileFn?.() ?? null;
    const version = this.staticMeta.version ?? readDaemonVersion() ?? undefined;
    // Usage-metrics (round 1): a recomputed snapshot of live counts + the
    // edition, emitted on BOTH the hello (this is the hello meta) and every
    // heartbeat (the heartbeat spreads this). A missing source defaults a count
    // to 0; edition is omitted when unknown so the relay keeps its last value.
    const edition = this.editionFn?.();
    return {
      ...this.staticMeta,
      ...(version ? { version } : {}),
      ...(profile ? { cyboRuntime: profile } : {}),
      // DualStorage mode ('solo' | 'connected') — the relay persists this to
      // daemons.deployment_mode for the superadmin overview. Read from the live
      // storage so it's always accurate (no caller threading required).
      deploymentMode: this.storage.mode,
      activeSessionCount: this.activeSessionCountFn?.() ?? 0,
      activeCyboCount: this.activeCyboCountFn?.() ?? 0,
      ...(edition ? { edition } : {}),
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // Re-publish current providers every heartbeat (internal docs #2). The
      // daemon recomputes loggedOutNativeProviders on its own 60s cadence; the
      // hello only carries that at (re)connect, so on a long-held connection a
      // `claude login`/logout would otherwise never reach the relay's
      // conn.providers (readiness + mention routing stay stale until reconnect).
      // Same source as the hello (providersFn); omit when empty/unknown so the
      // frame stays compatible and the relay keeps its last known value.
      const providers = this.providersFn?.();
      this.send({
        type: "relay_heartbeat",
        daemonId: this.daemonId,
        status: "online",
        meta: {
          ...this.metaWithRuntime(),
          agents: this.agentCountFn?.() ?? 0,
          cybos: this.activeCybosFn?.() ?? [],
        },
        ...(providers && providers.length > 0 ? { providers } : {}),
      });
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.stopKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "daemon closing");
      this.ws = null;
    }
  }
}

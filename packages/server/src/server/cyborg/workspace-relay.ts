import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AgentImageAttachment, UploadedAgentImage } from "./codex-image-attachment.js";
import {
  DaemonHelloSchema,
  RelayForwardSchema,
  RelaySyncRequestSchema,
  RelayHeartbeatSchema,
  CyboReadRequestSchema,
  CyboWriteRequestSchema,
  UploadImageRequestSchema,
  type CyboReadResponse,
  type CyboWriteRequest,
  type CyboWriteResponse,
  type UploadImageRequest,
  type UploadImageResponse,
  type DaemonMeta,
  type RelaySubscribed,
  type RelayMessage,
  type RelaySyncResponse,
  type RelayError,
} from "./relay-protocol.js";
import { PgSync } from "./db/pg-sync.js";
import type { RelayRedis } from "./relay-redis.js";
import { DaemonTelemetryFrameSchema, type DaemonTelemetryEvent } from "./daemon-telemetry.js";
import { mentionActivityId } from "./activity-id.js";
import type { Logger } from "pino";

interface DaemonConnection {
  ws: WebSocket;
  daemonId: string;
  ownerId: string | null;
  workspaceIds: Set<string>;
  // READY provider ids the daemon reported in daemon_hello (#697). undefined when
  // the daemon predates the field → the mention pick degrades to capability-blind.
  providers?: string[];
  // Liveness for the presence sweep: refreshed on every inbound frame (the daemon
  // heartbeats every 30s). Staleness alone decides death — NO WS ping/pong (a
  // healthy daemon whose pong is delayed/dropped must not be killed).
  lastSeen: number;
}

// Presence sweep cadence. The daemon sends an app-level heartbeat every 30s, so a
// connection silent for 3 missed beats is treated as gone even if its TCP socket
// never sent a clean close (Mac sleep, Wi-Fi drop, VPN cut). Matches the 90s Redis
// daemon-online TTL.
const PRESENCE_SWEEP_MS = 30_000;
const HEARTBEAT_STALE_MS = 90_000;
// Keepalive ping cadence for the DAEMON CONTROL connections (#692). The guest
// keepalive (#503) only pings guest sockets; the daemon's role=server control
// connection got no traffic between its 30s app heartbeats, so the proxy/ALB in
// front of the relay dropped it on ~30s idle — and the forwarded relay_rpc
// (cybo-mention invoke, agent prompts) never reached the daemon. We ping BELOW
// that idle window so the link stays warm; the daemon's ws stack auto-pongs,
// warming both directions. Deliberately NO kill-on-missed-pong (the #277
// regression): death stays governed by heartbeat staleness in sweepDeadDaemons.
const DAEMON_KEEPALIVE_PING_MS = 20_000;

interface WorkspaceSeq {
  current: number;
}

interface PendingAgentMessage {
  workspaceId: string;
  agentId: string;
  messageId: string;
  channelId: string | null;
  // The cybo identity carried on the stream payload by the daemon's
  // emitAgentStream, so the flushed reply persists with the cybo NAME + cybo id
  // instead of the raw agent UUID (which rendered as "27bf4e9a" in the client).
  cyboName: string | null;
  cyboId: string | null;
  text: string;
  seq: number;
  // #845: images the daemon captured from agent output and shipped inline; the
  // relay uploads them to S3 at flush and stores them as message attachments.
  imageAttachments?: AgentImageAttachment[];
  // Item 2 (defense in depth): the DM recipient's email when this turn is a PRIVATE
  // 1:1 (the daemon's emitAgentStream sets privateToEmail). Captured at accumulate
  // time from the timeline stream (the flush trigger may be an agent_status payload
  // that no longer carries it), and forces the reply to broadcast as a DM — so a
  // DM-origin reply is STRUCTURALLY unable to land in a channel even if the owning
  // (or a peer) daemon's in-process guard is stale/absent. null = channel-scoped.
  dmRecipientEmail?: string | null;
}

export class WorkspaceRelay {
  private wss: WebSocketServer | null = null;
  private daemons = new Map<WebSocket, DaemonConnection>();
  private workspaceSubscribers = new Map<string, Set<WebSocket>>();
  private workspaceSeqs = new Map<string, WorkspaceSeq>();
  private pendingAgentMessages = new Map<string, PendingAgentMessage>();
  // Item 2: the DM recipient email captured for the message just flushed (keyed by
  // agentId), so broadcastAgentReply addresses the DM even when the flush trigger is
  // an agent_status payload that no longer carries privateToEmail. Set in
  // flushPendingAgentMessage, read+cleared in broadcastAgentReply.
  private lastFlushedDmEmail = new Map<string, string>();
  private bufferFlushTimer: ReturnType<typeof setInterval> | null = null;
  private presenceSweepTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private pg: PgSync | null;
  private uploadAgentImage:
    | ((img: AgentImageAttachment) => Promise<UploadedAgentImage | null>)
    | null = null;
  private redis: RelayRedis | null;
  private validateToken: ((token: string) => { daemonId: string; ownerId: string } | null) | null;
  private onBroadcast:
    | ((
        workspaceId: string,
        message: Record<string, unknown>,
        fromDaemonId: string,
        seq: number,
      ) => void)
    | null;
  private onHeartbeat: ((daemonId: string, meta?: Record<string, unknown>) => void) | null;
  private onDaemonConnect: ((daemonId: string, workspaceIds: string[]) => void) | null;
  private onDaemonDisconnect: ((daemonId: string, workspaceIds: string[]) => void) | null;
  // Central observability sink for daemon-side failures (#745). daemonId is null
  // only if the frame arrives before the connection is registered.
  private onTelemetry: ((daemonId: string | null, event: DaemonTelemetryEvent) => void) | null;
  // Daemon-context errors must reach daemon.log: this runs in the relay process
  // whose stray console.* output isn't the swallowed sink, but routing through
  // pino keeps it structured + redacted in one place (#736). Null when the caller
  // omits it (tests) → those errors drop, matching the message-router pattern.
  private logger: Logger | null;

  // oxlint-disable-next-line eslint/complexity -- flat field assignments, the count is just `??` fallbacks
  constructor(opts?: {
    pg?: PgSync | null;
    redis?: RelayRedis | null;
    logger?: Logger;
    validateToken?: (token: string) => { daemonId: string; ownerId: string } | null;
    onBroadcast?: (
      workspaceId: string,
      message: Record<string, unknown>,
      fromDaemonId: string,
      seq: number,
    ) => void;
    onHeartbeat?: (daemonId: string, meta?: Record<string, unknown>) => void;
    onDaemonConnect?: (daemonId: string, workspaceIds: string[]) => void;
    onDaemonDisconnect?: (daemonId: string, workspaceIds: string[]) => void;
    onTelemetry?: (daemonId: string | null, event: DaemonTelemetryEvent) => void;
    uploadAgentImage?: (img: AgentImageAttachment) => Promise<UploadedAgentImage | null>;
  }) {
    this.pg = opts?.pg ?? null;
    this.uploadAgentImage = opts?.uploadAgentImage ?? null;
    this.redis = opts?.redis ?? null;
    this.logger = opts?.logger ?? null;
    this.validateToken = opts?.validateToken ?? null;
    this.onBroadcast = opts?.onBroadcast ?? null;
    this.onHeartbeat = opts?.onHeartbeat ?? null;
    this.onDaemonConnect = opts?.onDaemonConnect ?? null;
    this.onDaemonDisconnect = opts?.onDaemonDisconnect ?? null;
    this.onTelemetry = opts?.onTelemetry ?? null;
  }

  // Re-seed the in-memory per-workspace seq counters from the highest persisted
  // seq so they stay monotonic across restarts. Without this, after a restart
  // new messages get seq 1,2,3… (below older messages) and sync deltas break.
  async seedSequencesFromDb(): Promise<void> {
    if (!this.pg) return;
    try {
      const rows = await this.pg.getMaxSeqByWorkspace();
      for (const { workspaceId, maxSeq } of rows) {
        const existing = this.workspaceSeqs.get(workspaceId)?.current ?? 0;
        if (maxSeq > existing) this.workspaceSeqs.set(workspaceId, { current: maxSeq });
      }
    } catch (err) {
      this.logger?.error({ err }, "[WorkspaceRelay] seq seed failed");
    }
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port, host });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
      this.wss.on("listening", () => {
        const addr = this.wss!.address();
        const boundPort = typeof addr === "object" && addr !== null ? addr.port : port;
        this.startBufferFlush();
        this.startPresenceSweep();
        resolve(boundPort);
      });
    });
  }

  attachToServer(server: HttpServer, path = "/relay"): void {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.startBufferFlush();
    this.startPresenceSweep();
  }

  attachToWss(wss: WebSocketServer): void {
    this.wss = wss;
    wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.startBufferFlush();
  }

  private startBufferFlush(): void {
    if (!this.pg || !this.redis || this.bufferFlushTimer) return;
    this.bufferFlushTimer = setInterval(() => {
      void this.flushBufferedMessages();
    }, 30_000);
  }

  // Detect daemons whose socket died WITHOUT a clean close (Mac sleep, network
  // drop, VPN cut) or that stopped heartbeating. Without this, such a daemon stays
  // in the in-memory connected set forever, so `list_daemons` and the live
  // `daemon_status` broadcast keep reporting it "online" while its agents have
  // silently vanished from the fan-out — exactly the stale-online bug.
  private startPresenceSweep(): void {
    if (this.presenceSweepTimer) return;
    this.presenceSweepTimer = setInterval(() => this.sweepDeadDaemons(), PRESENCE_SWEEP_MS);
    // Don't keep the process alive just for the sweep.
    this.presenceSweepTimer.unref?.();
    this.startKeepalive();
  }

  // Ping every daemon control connection on a sub-idle cadence (#692) so the
  // proxy/ALB never drops it for inactivity between heartbeats. Pure keepalive:
  // no pong tracking, no termination — sweepDeadDaemons (staleness) still owns
  // death, so a delayed/dropped pong on a healthy daemon can't flap it (#277).
  private startKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => this.pingDaemons(), DAEMON_KEEPALIVE_PING_MS);
    this.keepaliveTimer.unref?.();
  }

  private pingDaemons(): void {
    for (const [ws] of this.daemons) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.ping();
      } catch {
        // A throw means the socket is already broken; never kill on a ping
        // failure — the staleness sweep terminates it on the heartbeat timeline.
      }
    }
  }

  private sweepDeadDaemons(): void {
    const now = Date.now();
    for (const [ws, conn] of this.daemons) {
      // Terminate ONLY when the daemon has gone silent past 3 missed 30s heartbeats
      // (90s). Any inbound frame (heartbeat, forward, sync) refreshes lastSeen, so a
      // live daemon never trips this. We deliberately do NOT use WS ping/pong: an
      // earlier version killed connections that missed a single pong even while
      // heartbeating fine, flapping them online/offline (the #277 regression).
      // terminate() fires 'close' → handleDisconnect → setDaemonOffline + offline
      // broadcast; the catch funnels the rare throw through the same idempotent path.
      if (now - conn.lastSeen > HEARTBEAT_STALE_MS) {
        try {
          ws.terminate();
        } catch {
          this.handleDisconnect(ws);
        }
      }
    }
  }

  private async flushBufferedMessages(): Promise<void> {
    if (!this.pg || !this.redis) return;
    try {
      const workspaceIds = await this.redis.getBufferedWorkspaces();
      for (const wsId of workspaceIds) {
        const messages = await this.redis.drainBufferedMessages(wsId);
        await this.persistBufferedMessages(wsId, messages);
      }
    } catch (err) {
      this.logger?.error({ err }, "[WorkspaceRelay] buffer flush error");
    }
  }

  private async persistBufferedMessages(
    wsId: string,
    messages: Record<string, unknown>[],
  ): Promise<void> {
    for (const msg of messages) {
      const seq = (msg._seq as number) ?? 0;
      const clean = { ...msg };
      delete clean._seq;
      delete clean._workspaceId;
      try {
        const extracted = await this.extractPersistableMessage(wsId, seq, clean);
        if (extracted) await this.pg!.insertMessage(extracted);
      } catch (err) {
        this.logger?.error({ err }, "[WorkspaceRelay] buffer flush failed for message");
      }
    }
  }

  private handleConnection(ws: WebSocket, _req: IncomingMessage): void {
    let authenticated = false;

    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        this.send(ws, { type: "relay_error", error: "auth timeout" });
        ws.close(4001, "auth timeout");
      }
    }, 5000);

    ws.on("message", (data) => {
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!authenticated) {
        this.handleHello(ws, msg, () => {
          authenticated = true;
          clearTimeout(authTimeout);
        });
        return;
      }

      this.handleMessage(ws, msg);
    });

    ws.on("close", () => {
      clearTimeout(authTimeout);
      this.handleDisconnect(ws);
    });

    ws.on("error", () => {
      clearTimeout(authTimeout);
      this.handleDisconnect(ws);
    });
  }

  private handleHello(ws: WebSocket, msg: unknown, onAuth: () => void): void {
    const parsed = DaemonHelloSchema.safeParse(msg);
    if (!parsed.success) {
      this.send(ws, { type: "relay_error", error: "invalid daemon_hello" });
      ws.close(4002, "invalid hello");
      return;
    }

    const { daemonId, token, workspaceIds, label, meta, providers } = parsed.data;

    let ownerId: string | null = null;
    if (this.validateToken) {
      const result = this.validateToken(token);
      if (!result) {
        this.send(ws, { type: "relay_error", error: "unauthorized" });
        ws.close(4003, "unauthorized");
        return;
      }
      ownerId = result.ownerId;
      if (this.pg) {
        this.syncDaemonToPg(
          result.daemonId,
          result.ownerId,
          label ?? daemonId,
          workspaceIds,
          meta,
        ).catch((err) => {
          this.logger?.error({ err }, "[WorkspaceRelay] daemon PG sync failed");
        });
      }
    }

    // Evict any prior connection for the SAME daemon before registering this one
    // (#694). `this.daemons` is keyed by socket, so a reconnect used to LEAVE the
    // old socket registered. If that old socket lingered OPEN (a zombie whose
    // close never reached the relay), sendToDaemonInWorkspace picked it FIRST
    // (Map insertion order), and ws.send() to a half-open socket "succeeds" — so
    // relay_rpc forwards (cybo-mention invokes) were delivered into the void: the
    // relay logged 'invoked' while the LIVE daemon never received them. One live
    // connection per daemon makes the forward deterministically reach the current
    // socket; the heartbeat-staleness sweep remains the backstop.
    this.evictDaemonConnections(daemonId, ws);

    const conn: DaemonConnection = {
      ws,
      daemonId,
      ownerId,
      workspaceIds: new Set(workspaceIds),
      lastSeen: Date.now(),
      ...(providers ? { providers } : {}),
    };
    this.daemons.set(ws, conn);

    for (const wsId of workspaceIds) {
      if (!this.workspaceSubscribers.has(wsId)) {
        this.workspaceSubscribers.set(wsId, new Set());
      }
      this.workspaceSubscribers.get(wsId)!.add(ws);

      if (!this.workspaceSeqs.has(wsId)) {
        this.workspaceSeqs.set(wsId, { current: 0 });
      }
    }

    // Subscribe the daemon to the workspaces its OWNER belongs to in PG MINUS the
    // ones the owner disabled for this daemon (workspace_daemons.enabled=false).
    // This is the authoritative routing set: we drop any stale/reported workspace
    // that isn't an enabled owner workspace, and add every enabled one (covers
    // invited workspaces the daemon didn't report locally). Until PG resolves, the
    // reported set seeds routing (sub-second window).
    if (ownerId && this.pg) {
      void this.pg
        .getEnabledWorkspaceIdsForDaemon(ownerId, daemonId)
        .then((enabledIds) => {
          const enabled = new Set(enabledIds);
          // Snapshot before mutating conn.workspaceIds inside the loop.
          const current = Array.from(conn.workspaceIds);
          for (const wsId of current) {
            if (!enabled.has(wsId)) this.unsubscribeDaemonConn(ws, conn, wsId);
          }
          for (const wsId of enabled) this.subscribeDaemonConn(ws, conn, wsId);
          return enabledIds;
        })
        .catch((err) =>
          this.logger?.error(
            { err, daemonId },
            "[WorkspaceRelay] daemon routing reconcile failed (keeping reported set)",
          ),
        );
    }

    const reply: RelaySubscribed = {
      type: "relay_subscribed",
      workspaceIds,
      daemonId,
    };
    this.send(ws, reply);
    onAuth();
    this.onDaemonConnect?.(daemonId, workspaceIds);
  }

  private handleMessage(ws: WebSocket, msg: unknown): void {
    // Any authenticated frame (heartbeat, forward, sync) proves the daemon is alive.
    const liveConn = this.daemons.get(ws);
    if (liveConn) liveConn.lastSeen = Date.now();

    const forwardParsed = RelayForwardSchema.safeParse(msg);
    if (forwardParsed.success) {
      this.handleForward(ws, forwardParsed.data);
      return;
    }

    const syncParsed = RelaySyncRequestSchema.safeParse(msg);
    if (syncParsed.success) {
      this.handleSyncRequest(ws, syncParsed.data);
      return;
    }

    const cyboReadParsed = CyboReadRequestSchema.safeParse(msg);
    if (cyboReadParsed.success) {
      this.handleCyboRead(ws, cyboReadParsed.data);
      return;
    }

    const cyboWriteParsed = CyboWriteRequestSchema.safeParse(msg);
    if (cyboWriteParsed.success) {
      void this.handleCyboWrite(ws, cyboWriteParsed.data);
      return;
    }

    const uploadImageParsed = UploadImageRequestSchema.safeParse(msg);
    if (uploadImageParsed.success) {
      void this.handleUploadImage(ws, uploadImageParsed.data);
      return;
    }

    const telemetryParsed = DaemonTelemetryFrameSchema.safeParse(msg);
    if (telemetryParsed.success) {
      // Terminates here — telemetry is logged centrally by the relay, never
      // forwarded to clients. The owning daemon labels the event.
      const conn = this.daemons.get(ws);
      this.onTelemetry?.(conn?.daemonId ?? null, telemetryParsed.data.event);
      return;
    }

    const heartbeatParsed = RelayHeartbeatSchema.safeParse(msg);
    if (heartbeatParsed.success) {
      const hb = heartbeatParsed.data;
      // Keep the relay's per-daemon provider view live across host login/logout
      // on a long-held connection (internal docs #2). daemon_hello only carries
      // providers at (re)connect; the heartbeat re-publishes them every 30s, so
      // a `claude login`/logout propagates to readiness + mention routing WITHOUT
      // a reconnect. Older daemons omit `providers` → keep the last hello value.
      if (hb.providers && liveConn) {
        liveConn.providers = hb.providers;
      }
      if (this.pg) {
        this.pg.updateDaemonHeartbeat(hb.daemonId, hb.meta).catch((err) => {
          this.logger?.error({ err }, "[WorkspaceRelay] heartbeat update failed");
        });
      }
      this.onHeartbeat?.(hb.daemonId, hb.meta as Record<string, unknown> | undefined);
      return;
    }
  }

  private handleForward(
    ws: WebSocket,
    msg: { workspaceId: string; message: Record<string, unknown> },
  ): void {
    const sender = this.daemons.get(ws);
    if (!sender) return;

    if (!this.workspaceSeqs.has(msg.workspaceId)) {
      this.workspaceSeqs.set(msg.workspaceId, { current: 0 });
    }
    const seqState = this.workspaceSeqs.get(msg.workspaceId)!;

    seqState.current++;
    const seq = seqState.current;

    // #845: agent_stream may carry inline image bytes (base64) ONLY so the relay
    // can upload them to S3 on persist. Live subscribers (peer daemons + guest
    // fan-out) don't use them — the stored message carries the S3 URL — so strip
    // the bytes from the live copy to avoid pushing megabytes to every client.
    // persistMessage below still gets the original (with bytes).
    const liveMessage = this.stripInlineImageBytes(msg.message);

    const relayMsg: RelayMessage = {
      type: "relay_message",
      workspaceId: msg.workspaceId,
      fromDaemonId: sender.daemonId,
      seq,
      message: liveMessage,
    };

    const subscribers = this.workspaceSubscribers.get(msg.workspaceId);
    if (subscribers) {
      for (const subscriberWs of subscribers) {
        if (subscriberWs !== ws && subscriberWs.readyState === WebSocket.OPEN) {
          this.send(subscriberWs, relayMsg);
        }
      }
    }

    if (sender.workspaceIds.has(msg.workspaceId)) {
      this.send(ws, relayMsg);
    }

    this.onBroadcast?.(msg.workspaceId, liveMessage, sender.daemonId, seq);

    if (this.pg) {
      // Persist gets the ORIGINAL message (with the inline bytes) so the S3
      // upload + attachment happen; the live fan-out above used the stripped copy.
      void this.persistMessage(msg.workspaceId, seq, msg.message);
    }
  }

  // Return a copy of an agent_stream message with the heavy inline image bytes
  // (#845) removed, for live fan-out. Any other message is returned unchanged.
  private stripInlineImageBytes(message: Record<string, unknown>): Record<string, unknown> {
    if (message.type !== "cyborg:agent_stream") return message;
    const payload = message.payload as Record<string, unknown> | undefined;
    if (!payload || !payload.imageAttachments) return message;
    const { imageAttachments: _drop, ...restPayload } = payload;
    return { ...message, payload: restPayload };
  }

  private async persistMessage(
    workspaceId: string,
    seq: number,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (!this.pg) return;

    try {
      const extracted = await this.extractPersistableMessage(workspaceId, seq, message);
      if (extracted) {
        await this.pg.insertMessage(extracted);
        // Cloud parity for an AGENT @mention (cyborg7_send_message `mentions`): a
        // cloud daemon has no PG, so its local activity write never reaches the
        // shared store — the relay fans out the 'mention' activity rows here so a
        // human mentioned by a cybo gets the same unread badge + notification a
        // human-author mention gives. Humans-only + channel-member-gated; the live
        // badge already rides the re-broadcast payload's real `mentions` array.
        await this.emitAgentMentionActivity(workspaceId, extracted);
        // An agent reply arrives as an agent_stream/agent_status flush, which the
        // human notification pipeline (badges + banners) never sees. Re-broadcast
        // the flushed reply as a normal channel/DM message so agent chats badge
        // and notify exactly like human ones (Paseo-parity). The MCP-tool send
        // path already broadcasts, so this only fires for the stream-flush path.
        if (
          extracted.fromType === "agent" &&
          (message.type === "cyborg:agent_stream" || message.type === "cyborg:agent_status")
        ) {
          const payload =
            typeof message.payload === "object" && message.payload !== null
              ? (message.payload as Record<string, unknown>)
              : {};
          await this.broadcastAgentReply(workspaceId, seq, extracted, payload);
        }
      }
    } catch (err) {
      this.logger?.error({ err }, "[WorkspaceRelay] PG write failed");
      if (this.redis) {
        await this.redis
          .bufferMessage(workspaceId, { ...message, _seq: seq, _workspaceId: workspaceId })
          .catch((bufErr) =>
            this.logger?.error(
              { err: bufErr, workspaceId, seq },
              "[WorkspaceRelay] redis buffer fallback failed after PG write — message dropped",
            ),
          );
      }
    }
  }

  // Fan out a 'mention' activity row per HUMAN that an AGENT explicitly mentioned
  // in a channel post (cyborg7_send_message `mentions`). This is the cloud mirror
  // of the daemon-side handleAgentMessage fan-out: a cloud daemon has no PG, so its
  // local emitActivity never reaches the shared store; without this, a cybo's human
  // @mention would persist on the message but light up no badge/notification.
  //
  // GUARD (humans-only, P1): only ids that are HUMAN members of the channel get a
  // row — getChannelMembers innerJoins users, so a cybo id or an unknown id is
  // dropped (an agent mention NEVER notifies-as-invokes a cybo, and a foreign id
  // can't enumerate users). Best-effort: a feed-write failure must not fail persist.
  private async emitAgentMentionActivity(
    workspaceId: string,
    record: Parameters<PgSync["insertMessage"]>[0],
  ): Promise<void> {
    if (!this.pg) return;
    if (record.fromType !== "agent" || !record.channelId) return;
    const mentions = record.mentions;
    if (!mentions || mentions.length === 0) return;
    try {
      const memberIds = new Set(
        (await this.pg.getChannelMembers(record.channelId)).map((m) => m.userId),
      );
      const preview = record.text.slice(0, 140);
      // Fan the per-recipient rows out concurrently: collect each insert's promise
      // in the loop and await them once, rather than a serial round-trip per mention.
      // The dedup id, skip conditions and `new Set(mentions)` de-dup are unchanged —
      // only the awaiting is now batched.
      const writes: Promise<unknown>[] = [];
      for (const mid of new Set(mentions)) {
        if (mid === record.fromId || !memberIds.has(mid)) continue;
        writes.push(
          this.pg.insertActivityEvent({
            // Deterministic id keyed on (recipient, message, "mention"): a connected
            // daemon that already fanned out this same activity to this same PG (via
            // DualStorage) minted the IDENTICAL id, so insertActivityEvent's
            // onConflictDoNothing collapses the two writes to ONE row — the mentioned
            // human is badged/notified once, not twice. (For a PG-less cloud daemon
            // this is the only writer, so it simply persists the single row.)
            id: mentionActivityId(mid, record.id, "mention"),
            workspaceId,
            userId: mid,
            eventType: "mention",
            sourceType: "message",
            sourceId: record.id,
            channelId: record.channelId,
            previewText: preview,
            actorId: record.fromId,
            actorName: record.fromName ?? null,
            createdAt: record.createdAt,
          }),
        );
      }
      await Promise.all(writes);
    } catch (err) {
      this.logger?.error(
        { err, messageId: record.id },
        "[WorkspaceRelay] agent mention activity fan-out failed",
      );
    }
  }

  // Re-broadcast a flushed agent reply through the human message pipeline so it
  // fires unread badges + OS notifications like a normal message. Channel agents
  // fan out workspace-wide; DM agents resolve the initiator from the stream's
  // privateToEmail tag and address the DM there (relay scoping keys dm_broadcast
  // by from/to, so only the initiator is badged — no workspace-wide leak).
  private async broadcastAgentReply(
    workspaceId: string,
    seq: number,
    record: Parameters<PgSync["insertMessage"]>[0],
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.onBroadcast) return;
    const base = {
      id: record.id,
      workspaceId,
      fromId: record.fromId,
      fromType: "agent" as const,
      fromName: record.fromName ?? null,
      text: record.text,
      seq,
      createdAt: record.createdAt,
    };

    // Item 2 (defense in depth): a captured DM scope (from the flushed pending
    // message) is AUTHORITATIVE — a private 1:1 reply must broadcast as a DM, never
    // to a channel, even if some channelId survived. Prefer the captured email over
    // the trigger payload's (which may be an agent_status without privateToEmail).
    const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
    const capturedDmEmail = agentId ? this.lastFlushedDmEmail.get(agentId) : undefined;
    if (agentId) this.lastFlushedDmEmail.delete(agentId);

    if (record.channelId && !capturedDmEmail) {
      this.onBroadcast(
        workspaceId,
        {
          type: "cyborg:channel_message_broadcast",
          payload: { ...base, channelId: record.channelId, mentions: [], parentId: null },
        },
        "guest",
        seq,
      );
      return;
    }

    const privateToEmail =
      capturedDmEmail ??
      (typeof payload.privateToEmail === "string" ? payload.privateToEmail : null);
    if (!privateToEmail || !this.pg) return;
    const user = await this.pg.getUserByEmail(privateToEmail);
    if (!user) return;
    this.onBroadcast(
      workspaceId,
      {
        type: "cyborg:dm_broadcast",
        payload: { ...base, channelId: null, toId: user.id },
      },
      "guest",
      seq,
    );
  }

  private async extractPersistableMessage(
    workspaceId: string,
    seq: number,
    message: Record<string, unknown>,
  ): Promise<Parameters<PgSync["insertMessage"]>[0] | null> {
    const payload =
      typeof message.payload === "object" && message.payload !== null
        ? (message.payload as Record<string, unknown>)
        : null;
    if (!payload) return null;

    if (message.type === "cyborg:channel_message_broadcast") {
      return this.buildMessageRecord(workspaceId, seq, payload, {
        id: payload.id as string,
        channelId: (payload.channelId as string) ?? null,
        // Defense in depth (the daemon already pre-filters): re-gate an AGENT post's
        // stored mentions to the channel's HUMAN members so the persisted array can
        // never carry a cybo/unknown id, regardless of what the daemon forwarded.
        mentions: await this.filterStoredAgentMentions(payload),
      });
    }

    if (message.type === "cyborg:dm_broadcast") {
      return this.buildMessageRecord(workspaceId, seq, payload, {
        id: (payload.id as string) ?? randomUUID(),
        channelId: null,
        mentions: null,
      });
    }

    if (message.type === "cyborg:agent_stream") {
      const ev = payload.event as { type?: string } | undefined;
      if (ev?.type === "timeline") {
        this.accumulateAgentStreamText(workspaceId, seq, payload);
        return null;
      }
      // Commit the accumulated reply at the turn boundary. agent_status idle is
      // the usual trigger, but a turn can end without that lifecycle transition
      // (e.g. replace-run keeps it "running"), so also flush on the terminal
      // agent_stream turn events — otherwise the reply is never persisted.
      if (
        ev?.type === "turn_completed" ||
        ev?.type === "turn_failed" ||
        ev?.type === "turn_canceled"
      ) {
        return await this.flushPendingAgentMessage(payload);
      }
      return null;
    }

    if (message.type === "cyborg:agent_status") {
      // Only flush at the turn boundary. agent_status is broadcast on every
      // lifecycle change (running/idle/error); flushing on a mid-turn "running"
      // blip persisted a partial fragment and reset the accumulator, which is
      // exactly how one response ended up split across many message rows.
      // Keep accumulating while running; commit one message when the turn ends.
      // (flush is idempotent — deletes pending — so a double trigger with the
      // turn_completed event above is harmless.)
      if (payload.status === "running") return null;
      return await this.flushPendingAgentMessage(payload);
    }

    return null;
  }

  private buildMessageRecord(
    workspaceId: string,
    seq: number,
    p: Record<string, unknown>,
    overrides: { id: string; channelId: string | null; mentions: string[] | null },
  ): Parameters<PgSync["insertMessage"]>[0] {
    return {
      id: overrides.id,
      workspaceId,
      channelId: overrides.channelId,
      fromId: p.fromId as string,
      fromType: (p.fromType as "human" | "agent" | "system") ?? "human",
      fromName: (p.fromName as string) ?? null,
      toId: (p.toId as string) ?? null,
      text: p.text as string,
      mentions: overrides.mentions,
      parentId: (p.parentId as string) ?? null,
      attachments: Array.isArray(p.attachments) ? (p.attachments as unknown[]) : null,
      // Origin marker carried in the broadcast payload (e.g. "mcp" from the
      // MCP write tools) — persisted so fetches can distinguish automations.
      source: typeof p.source === "string" ? p.source : null,
      // Structured rich card (e.g. a release card from a webhook), carried in the
      // broadcast payload and persisted so historical fetches render it too.
      card:
        typeof p.card === "object" && p.card !== null
          ? (p.card as Parameters<PgSync["insertMessage"]>[0]["card"])
          : null,
      seq,
      createdAt: (p.createdAt as number) ?? Date.now(),
    };
  }

  // Defense in depth for an AGENT @mention persisted via the relay: the daemon
  // (handleAgentMessage) already pre-filters a cybo's mentions to HUMAN members
  // before forwarding, but the relay must NOT trust that — a buggy or forged daemon
  // frame could carry cybo/unknown ids onto the stored message. Filter a channel
  // post's stored mentions to the channel's HUMAN members (getChannelMembers
  // innerJoins users, so a cybo id or an unknown id is dropped), matching the
  // humans-only invariant the mention-activity fan-out (emitAgentMentionActivity)
  // already enforces. A HUMAN-authored post passes through untouched (a human may
  // @mention a cybo to invoke it). Returns null when nothing survives — the daemon's
  // empty-set shape.
  private async filterStoredAgentMentions(
    payload: Record<string, unknown>,
  ): Promise<string[] | null> {
    const channelId = (payload.channelId as string) ?? null;
    const mentions = (payload.mentions as string[]) ?? null;
    if (
      payload.fromType !== "agent" ||
      !channelId ||
      !Array.isArray(mentions) ||
      mentions.length === 0
    ) {
      return mentions;
    }
    if (!this.pg) return mentions;
    const memberIds = new Set((await this.pg.getChannelMembers(channelId)).map((m) => m.userId));
    const filtered = [...new Set(mentions)].filter((id) => memberIds.has(id));
    return filtered.length > 0 ? filtered : null;
  }

  private accumulateAgentStreamText(
    workspaceId: string,
    seq: number,
    payload: Record<string, unknown>,
  ): void {
    const event = payload.event as Record<string, unknown> | undefined;
    if (event?.type !== "timeline") return;
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type !== "assistant_message" || typeof item.text !== "string") return;

    const agentId = payload.agentId as string;
    // #845: images the daemon captured from THIS event (inline base64), to be
    // uploaded to S3 + attached when the turn flushes.
    const images = Array.isArray(payload.imageAttachments)
      ? (payload.imageAttachments as AgentImageAttachment[])
      : [];
    const cyboName = typeof payload.cyboName === "string" ? payload.cyboName : null;
    const cyboId = typeof payload.cyboId === "string" ? payload.cyboId : null;
    // Item 2 (defense in depth): a PRIVATE 1:1 turn carries privateToEmail. Treat its
    // presence as authoritative DM scope — a private reply must NEVER persist into a
    // channel, regardless of what channelId the daemon tagged (a stale/absent
    // in-process guard, or a cross-daemon turn). When set, force channelId null.
    const dmRecipientEmail =
      typeof payload.privateToEmail === "string" ? payload.privateToEmail : null;
    const channelId = dmRecipientEmail ? null : ((payload.channelId as string | null) ?? null);
    const existing = this.pendingAgentMessages.get(agentId);
    if (existing) {
      this.mergeAgentStreamDelta(existing, {
        seq,
        text: item.text,
        cyboName,
        cyboId,
        dmRecipientEmail,
        images,
      });
    } else {
      this.pendingAgentMessages.set(agentId, {
        workspaceId,
        agentId,
        messageId: (item.messageId as string) ?? randomUUID(),
        // The agent's binding channel (null for DM/private turns) — carried on the
        // payload by message-router so the persisted reply lands in the right
        // channel and is findable on reload. Forced null for a private turn (above).
        channelId,
        cyboName,
        cyboId,
        text: item.text,
        seq,
        imageAttachments: images.length > 0 ? images : undefined,
        dmRecipientEmail,
      });
    }
  }

  // Merge a later split-across-deltas timeline delta into the pending reply. Extracted
  // from accumulateAgentStreamText to keep that method under the complexity budget.
  private mergeAgentStreamDelta(
    existing: PendingAgentMessage,
    delta: {
      seq: number;
      text: string;
      cyboName: string | null;
      cyboId: string | null;
      dmRecipientEmail: string | null;
      images: AgentImageAttachment[];
    },
  ): void {
    existing.text += delta.text;
    existing.seq = delta.seq;
    // A split delta may carry the cybo identity later; set it once, never clobber.
    if (delta.cyboName && !existing.cyboName) existing.cyboName = delta.cyboName;
    if (delta.cyboId && !existing.cyboId) existing.cyboId = delta.cyboId;
    // The DM scope may arrive on a later delta — sticky: once a delta marks this turn
    // private, it STAYS private (null channel) for the whole reply.
    if (delta.dmRecipientEmail) {
      existing.dmRecipientEmail = delta.dmRecipientEmail;
      existing.channelId = null;
    }
    if (delta.images.length > 0) {
      existing.imageAttachments = [...(existing.imageAttachments ?? []), ...delta.images];
    }
  }

  private async flushPendingAgentMessage(
    payload: Record<string, unknown>,
  ): Promise<Parameters<PgSync["insertMessage"]>[0] | null> {
    const agentId = payload.agentId as string;
    if (!agentId) return null;

    const pending = this.pendingAgentMessages.get(agentId);
    // Flush when there's reply text OR a captured image (an image-only reply has
    // empty text after the markdown token is stripped — it must still persist).
    if (!pending || (!pending.text && !(pending.imageAttachments?.length ?? 0))) {
      this.pendingAgentMessages.delete(agentId);
      return null;
    }

    this.pendingAgentMessages.delete(agentId);

    // #845: upload any captured images to S3 and persist them as attachments.
    // Best-effort: a failed upload just omits that image (text still posts).
    let attachments: UploadedAgentImage[] | null = null;
    if (pending.imageAttachments?.length && this.uploadAgentImage) {
      const upload = this.uploadAgentImage;
      // Upload images concurrently; each is independently best-effort so one
      // failure (or S3 off) just omits that image, never the whole message.
      const results = await Promise.allSettled(pending.imageAttachments.map((img) => upload(img)));
      const uploaded: UploadedAgentImage[] = [];
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) uploaded.push(r.value);
        else if (r.status === "rejected") {
          this.logger?.warn(
            { err: r.reason, agentId },
            "agent image upload failed — omitting from message",
          );
        }
      }
      if (uploaded.length > 0) attachments = uploaded;
    }

    // Item 2: hand the captured DM scope to broadcastAgentReply (the flush trigger
    // payload may be an agent_status without privateToEmail). Cleared after read.
    if (pending.dmRecipientEmail) {
      this.lastFlushedDmEmail.set(agentId, pending.dmRecipientEmail);
    } else {
      this.lastFlushedDmEmail.delete(agentId);
    }

    return {
      id: pending.messageId,
      workspaceId: pending.workspaceId,
      // Persist into the agent's channel so a channel-mentioned agent's reply is
      // findable on reload. DM agents keep channelId null (getDmMessages matches
      // the agent's reply via its `toId IS NULL` clause).
      channelId: pending.channelId,
      // Persist the cybo identity so the client renders the cybo NAME (e.g. "Rick")
      // instead of the raw agent UUID. Falls back to agentId when the stream carried
      // no cybo (a non-cybo session reply).
      fromId: pending.cyboId ?? agentId,
      fromType: "agent",
      fromName: pending.cyboName ?? null,
      toId: null,
      text: pending.text,
      mentions: null,
      parentId: null,
      attachments,
      seq: pending.seq,
      createdAt: Date.now(),
    };
  }

  // Cybo data read (daemon → relay → PG): the cybo's MCP tools run on a daemon
  // that has no PG handle — channels/membership for a CLOUD workspace exist only
  // here. Mirrors what the UI's fetch_channels does, scoped to the cybo:
  // channels come with the cybo's membership flag; history requires membership
  // (same fail-safe as the daemon-side requireChannelMembership gate).
  private async handleCyboRead(
    ws: WebSocket,
    msg: {
      requestId: string;
      workspaceId: string;
      cyboId: string;
      kind:
        | "channels"
        | "history"
        | "search"
        | "tasks"
        | "members"
        | "roster"
        | "projects"
        | "pages"
        | "page";
      channelId?: string;
      limit?: number;
      // kind:"page" — the page id to read.
      pageId?: string;
      query?: string;
      status?: string;
      assigneeId?: string;
      // Tasks Redesign (Plane-style) task-list filters forwarded from the cybo's
      // cyborg7_list_tasks. status/assigneeId map to the shared getTasks filter;
      // projectId/state/priority/label are applied in-memory over the rich rows.
      projectId?: string;
      state?: string;
      priority?: string;
      label?: string;
    },
  ): Promise<void> {
    const fail = (error: string): void => {
      const reply: CyboReadResponse = {
        type: "cybo_read_response",
        requestId: msg.requestId,
        ok: false,
        error,
      };
      this.send(ws, reply);
    };
    if (!this.pg) {
      fail("cybo reads need the shared workspace store (relay has no PG)");
      return;
    }
    try {
      if (msg.kind === "channels") {
        const channels = await this.pg.getChannels(msg.workspaceId);
        const withMembership = await Promise.all(
          channels.map(async (c) => ({
            id: c.id,
            name: c.name,
            isMember: await this.pg!.isCyboChannelMember(c.id, msg.cyboId).catch(() => false),
          })),
        );
        const reply: CyboReadResponse = {
          type: "cybo_read_response",
          requestId: msg.requestId,
          ok: true,
          channels: withMembership,
        };
        this.send(ws, reply);
        return;
      }
      if (msg.kind === "roster") {
        // Workspace-wide roster (humans + cybos) from the SHARED PG — the same
        // members the UI sees. Not channel-gated: any cybo in the workspace can see
        // who is in it (mirrors the workspace-wide cyborg7_list_tasks read). This is
        // why cyborg7_get_workspace_roster on a cloud daemon (no PG handle) must
        // round-trip here instead of reading its near-empty local SQLite cache.
        const [humans, cybos] = await Promise.all([
          this.pg.getMembers(msg.workspaceId),
          this.pg.getCybos(msg.workspaceId),
        ]);
        const reply: CyboReadResponse = {
          type: "cybo_read_response",
          requestId: msg.requestId,
          ok: true,
          members: [
            ...humans.map((h) => ({
              id: h.userId,
              name: h.name,
              role: h.role,
              memberType: "user" as const,
            })),
            ...cybos.map((c) => ({
              id: c.id,
              name: c.name,
              role: c.role ?? null,
              memberType: "cybo" as const,
            })),
          ],
        };
        this.send(ws, reply);
        return;
      }
      if (msg.kind === "projects") {
        // Workspace-wide Tasks-projects from the SHARED PG — the same projects the
        // UI/board see. Not channel-gated: any cybo in the workspace can list them
        // (mirrors the workspace-wide tasks/roster reads). This is why
        // cyborg7_list_projects on a cloud daemon (no PG handle) must round-trip here
        // instead of reading its near-empty local SQLite cache.
        const projects = await this.pg.getTasksProjects(msg.workspaceId);
        const reply: CyboReadResponse = {
          type: "cybo_read_response",
          requestId: msg.requestId,
          ok: true,
          projects,
        };
        this.send(ws, reply);
        return;
      }
      if (msg.kind === "pages" || msg.kind === "page") {
        // Documented Pages read — owner-ACL gated. Extracted to keep handleCyboRead
        // under the complexity cap.
        await this.handleCyboPagesRead(ws, msg, fail);
        return;
      }
      if (msg.kind === "members") {
        // channel-scoped + membership-gated; extracted to keep handleCyboRead under
        // the complexity cap (behavior unchanged).
        await this.handleCyboMembersRead(ws, msg, fail);
        return;
      }
      if (msg.kind === "tasks") {
        // SECURITY (owner ACL): a cybo inherits its OWNER's task visibility — it
        // must never see a project-restricted task the owning user can't see. The
        // owner is the cybo's creator (cybos.created_by). We resolve it and scope
        // the read with `userId: ownerId`, so getTasks → getTasksPage applies
        // taskVisibilityCondition (project_id IS NULL, OR a project the owner may
        // see) — the SAME gate the UI's cyborg:fetch_tasks path applies for its
        // guest user. Without this the read ran UNSCOPED and leaked every workspace
        // task, including project-restricted ones the owner can't see.
        const ownerId = (await this.pg.getCybos(msg.workspaceId)).find(
          (c) => c.id === msg.cyboId,
        )?.created_by;
        if (!ownerId) {
          fail("cybo not found in this workspace");
          return;
        }
        // Defense in depth: if the owner was REMOVED from the workspace, deny — a
        // cybo must not outlive its owner's access. Otherwise the owner-scoped read
        // would still surface project-less tasks (taskVisibilityCondition admits
        // project_id IS NULL for any userId), and a removed owner can see nothing.
        if (!(await this.pg.isMember(msg.workspaceId, ownerId))) {
          fail("cybo owner is no longer a member of this workspace");
          return;
        }
        // status/assigneeId are the only filters the shared getTasks read applies
        // (same as the UI's cyborg:fetch_tasks path). The Tasks Redesign filters
        // (projectId/state/priority/label) are not part of the getTasks API, so we
        // apply them in-memory over the rich rows getTasks already returns —
        // matching the id-bearing fields each StoredTask carries (project_id,
        // state_id, priority, label_ids). Without this the cloud read ignored these
        // filters entirely and dropped the rich fields the UI sees via mapTask.
        const tasks = await this.pg.getTasks(msg.workspaceId, {
          status: msg.status,
          assigneeId: msg.assigneeId,
          userId: ownerId,
        });
        const filtered = tasks.filter((t) => {
          if (msg.projectId && t.project_id !== msg.projectId) return false;
          if (msg.priority && t.priority !== msg.priority) return false;
          if (msg.state && t.state_id !== msg.state) return false;
          if (msg.label && !(t.label_ids ?? []).includes(msg.label)) return false;
          return true;
        });
        const reply: CyboReadResponse = {
          type: "cybo_read_response",
          requestId: msg.requestId,
          ok: true,
          // Mirror the relay's mapTask snake_case readback so the cybo's list_tasks
          // surfaces the same rich shape the UI gets.
          tasks: filtered.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            assignee_id: t.assignee_id ?? null,
            description: t.description ?? null,
            due_at: t.due_at ?? null,
            created_at: t.created_at,
            sequence_id: t.sequence_id ?? null,
            state_id: t.state_id ?? null,
            priority: t.priority ?? null,
            project_id: t.project_id ?? null,
            label_ids: t.label_ids ?? [],
            module_ids: t.module_ids ?? [],
          })),
        };
        this.send(ws, reply);
        return;
      }
      // kind === "history" | "search" — both are channel-scoped and
      // membership-gated (same fail-safe as the daemon-side gate).
      if (!msg.channelId) {
        fail("channelId required");
        return;
      }
      const isMember = await this.pg.isCyboChannelMember(msg.channelId, msg.cyboId);
      if (!isMember) {
        fail("not a member of this channel — ask a workspace admin to add this cybo");
        return;
      }
      const rows =
        msg.kind === "search"
          ? await this.pg.searchChannelMessages(
              msg.channelId,
              msg.query ?? "",
              Math.min(Math.max(1, msg.limit ?? 20), 100),
            )
          : await this.pg.getMessages({
              channelId: msg.channelId,
              limit: Math.min(Math.max(1, msg.limit ?? 30), 200),
            });
      const reply: CyboReadResponse = {
        type: "cybo_read_response",
        requestId: msg.requestId,
        ok: true,
        messages: rows.map((r) => ({
          id: r.id,
          from_id: r.from_id,
          from_name: r.from_name ?? null,
          text: r.text,
          created_at: r.created_at,
        })),
      };
      this.send(ws, reply);
    } catch (err) {
      fail(`cybo read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Channel members read over the relay (kind:"members"). Channel-scoped +
  // membership-gated (same fail-safe as history/search): a cybo can only list the
  // members of a channel it has joined. Extracted verbatim from handleCyboRead.
  private async handleCyboMembersRead(
    ws: WebSocket,
    msg: { requestId: string; workspaceId: string; cyboId: string; channelId?: string },
    fail: (error: string) => void,
  ): Promise<void> {
    if (!this.pg) {
      fail("cybo reads need the shared workspace store (relay has no PG)");
      return;
    }
    if (!msg.channelId) {
      fail("channelId required");
      return;
    }
    const isMember = await this.pg.isCyboChannelMember(msg.channelId, msg.cyboId);
    if (!isMember) {
      fail("not a member of this channel — ask a workspace admin to add this cybo");
      return;
    }
    // Humans come from getChannelMembers (innerJoins users — cybo rows are DROPPED
    // there), so cybos MUST be unioned in separately from getChannelCyboMembers and
    // resolved to their display name/role via the workspace cybo roster.
    const [humans, cyboIds, cybos] = await Promise.all([
      this.pg.getChannelMembers(msg.channelId),
      this.pg.getChannelCyboMembers(msg.channelId),
      this.pg.getCybos(msg.workspaceId),
    ]);
    const cyboById = new Map(cybos.map((c) => [c.id, c]));
    this.send(ws, {
      type: "cybo_read_response",
      requestId: msg.requestId,
      ok: true,
      members: [
        ...humans.map((h) => ({
          id: h.userId,
          name: h.name,
          role: h.role,
          memberType: "user" as const,
        })),
        ...cyboIds.map((id) => ({
          id,
          name: cyboById.get(id)?.name ?? null,
          role: cyboById.get(id)?.role ?? null,
          memberType: "cybo" as const,
        })),
      ],
    } satisfies CyboReadResponse);
  }

  // Documented Pages read over the relay (kind:"pages" = list a project's pages;
  // kind:"page" = read one page WITH its body). SECURITY (owner ACL): a cybo
  // inherits its OWNER's page visibility — it must never see a project/page the
  // owning user can't. Resolve the owner (cybos.created_by), confirm the owner is
  // still a member (a cybo must not outlive its owner's access), then scope every
  // read with the owner's id so getProjectPages applies its public/null-owner/
  // own-owner filter — the SAME gate the UI's page reads apply for the human.
  private async handleCyboPagesRead(
    ws: WebSocket,
    msg: {
      requestId: string;
      workspaceId: string;
      cyboId: string;
      projectId?: string;
      pageId?: string;
      // Only "pages"/"page" reach here; typed broad so the caller's narrowed union
      // assigns without a cast.
      kind: string;
    },
    fail: (error: string) => void,
  ): Promise<void> {
    if (!this.pg) {
      fail("cybo reads need the shared workspace store (relay has no PG)");
      return;
    }
    const ownerId = (await this.pg.getCybos(msg.workspaceId)).find(
      (c) => c.id === msg.cyboId,
    )?.created_by;
    if (!ownerId) {
      fail("cybo not found in this workspace");
      return;
    }
    if (!(await this.pg.isMember(msg.workspaceId, ownerId))) {
      fail("cybo owner is no longer a member of this workspace");
      return;
    }
    if (msg.kind === "pages") {
      if (!msg.projectId) {
        fail("projectId required");
        return;
      }
      // Project-level gate first (the owner must be able to SEE the project), then
      // the page-level owner filter inside getProjectPages.
      if (!(await this.pg.assertProjectVisible(msg.projectId, ownerId))) {
        fail("project not found");
        return;
      }
      const pages = await this.pg.getProjectPages(msg.projectId, ownerId);
      this.send(ws, {
        type: "cybo_read_response",
        requestId: msg.requestId,
        ok: true,
        pages: pages.map((p) => ({ id: p.id, title: p.title, parentId: p.parentId, icon: p.icon })),
      } satisfies CyboReadResponse);
      return;
    }
    // kind === "page": read one page by id, gated by the SAME owner visibility.
    if (!msg.pageId) {
      fail("pageId required");
      return;
    }
    const projectId = await this.pg.getPageProjectId(msg.pageId);
    if (!projectId || !(await this.pg.assertProjectVisible(projectId, ownerId))) {
      fail("page not found in this workspace");
      return;
    }
    // getPageById applies NO page-level visibility filter, so resolve the page out of
    // the OWNER-VISIBLE set (one query, no N+1) — a private page owned by another
    // member is absent here and never leaks to the cybo.
    const found = (await this.pg.getProjectPages(projectId, ownerId)).find(
      (p) => p.id === msg.pageId,
    );
    if (!found) {
      fail("page not found in this workspace");
      return;
    }
    this.send(ws, {
      type: "cybo_read_response",
      requestId: msg.requestId,
      ok: true,
      page: {
        id: found.id,
        title: found.title,
        content: found.content,
        parentId: found.parentId,
        icon: found.icon,
      },
    } satisfies CyboReadResponse);
  }

  // Resolve the WRITER identity, its task-creator attribution, and its project-
  // visibility gate for a cybo write. Two shapes:
  //  - CYBO write (msg.cyboId): validate the cybo belongs to the workspace and
  //    honor its create_task grant; attribute to the agent/cybo and gate projects
  //    with the cybo-scoped visibility check (unchanged behavior).
  //  - NON-cybo, USER-owned write (msg.createdBy, no cyboId): validate the user is
  //    a non-viewer member of the workspace and attribute to that user, gating
  //    projects with the human visibility check — the same authority the human
  //    relay create path applies. This is how a plain (non-cybo) agent's task
  //    reaches the shared store owned by its spawning user.
  // Returns the resolved identity, or an error string for the caller to fail with.
  private async resolveCyboWriteActor(
    pg: PgSync,
    msg: CyboWriteRequest,
  ): Promise<
    | {
        ok: true;
        actorId: string;
        createdBy: string;
        assertProjectVisible: (projectId: string) => Promise<boolean>;
      }
    | { ok: false; error: string }
  > {
    if (msg.cyboId) {
      const cyboId = msg.cyboId;
      const cybo = (await pg.getCybos(msg.workspaceId)).find((c) => c.id === cyboId);
      if (!cybo) {
        return { ok: false, error: "cybo not found in this workspace" };
      }
      let grants: string[] = [];
      try {
        grants = cybo.platform_permissions ? JSON.parse(cybo.platform_permissions) : [];
      } catch {
        grants = [];
      }
      if (grants.length > 0 && !grants.includes("create_task")) {
        return { ok: false, error: "this cybo doesn't have the create_task permission" };
      }
      return {
        ok: true,
        actorId: cyboId,
        createdBy: msg.agentId ?? cyboId,
        assertProjectVisible: (projectId) => pg.assertProjectVisibleForCybo(projectId, cyboId),
      };
    }
    if (msg.createdBy) {
      const userId = msg.createdBy;
      const role = await pg.getMemberRole(msg.workspaceId, userId);
      if (!role || role === "viewer") {
        return { ok: false, error: "you can't create tasks in this workspace" };
      }
      return {
        ok: true,
        actorId: userId,
        createdBy: userId,
        assertProjectVisible: (projectId) => pg.assertProjectVisible(projectId, userId),
      };
    }
    return { ok: false, error: "cyboId or createdBy required" };
  }

  // Cybo task WRITES (daemon → relay → PG). Validates the writer (see
  // resolveCyboWriteActor), then mutates the SHARED tasks table — so a cybo- or
  // user-attributed task is the same row the UI sees.
  // oxlint-disable-next-line eslint/complexity -- pre-existing over-budget cybo-write switch (40); this change only adds a single delegating branch for update_self (extracted to handleCyboUpdateSelf)
  private async handleCyboWrite(ws: WebSocket, msg: CyboWriteRequest): Promise<void> {
    const fail = (error: string): void => {
      const reply: CyboWriteResponse = {
        type: "cybo_write_response",
        requestId: msg.requestId,
        ok: false,
        error,
      };
      this.send(ws, reply);
    };
    if (!this.pg) {
      fail("cybo writes need the shared workspace store (relay has no PG)");
      return;
    }
    // update_self (a cybo edits its OWN soul) rides this path too — extracted to
    // its own method to keep handleCyboWrite's branch count down.
    if (msg.kind === "update_self") {
      await this.handleCyboUpdateSelf(ws, msg, fail);
      return;
    }

    try {
      const resolved = await this.resolveCyboWriteActor(this.pg, msg);
      if (!resolved.ok) {
        fail(resolved.error);
        return;
      }
      const { actorId, createdBy: taskCreatedBy, assertProjectVisible } = resolved;

      if (msg.kind === "create_task") {
        if (!msg.title) {
          fail("title required");
          return;
        }
        // Tasks Redesign GATE (fail-closed, project-scoped) — when the cybo targets
        // an explicit Tasks-project the task must land in a project the cybo can see
        // (it is a channel member of a channel tagged to that project), mirroring the
        // human assertProjectVisible gate on the relay create path. The
        // channel-derived/Inbox defaults below are inherently visible, so only an
        // explicit projectId is gated here.
        if (msg.projectId && !(await assertProjectVisible(msg.projectId))) {
          fail("project not found");
          return;
        }
        const id = `task_${randomUUID()}`;
        await this.pg.createTask({
          id,
          workspaceId: msg.workspaceId,
          title: msg.title,
          createdBy: taskCreatedBy,
          description: msg.description,
          assigneeId: msg.assigneeId,
          dueAt: msg.dueAt,
          // Tasks Phase 2 (watcher): forward the channel binding + priority the
          // cybo set via cyborg7_create_task, instead of dropping them here.
          channelId: msg.channelId,
          priority: msg.priority,
          // Tasks Redesign — Plane-style fields, forwarded so a cybo create carries
          // the same shape as the human relay path. createTask resolves projectId
          // (else the channel's tasks_project, else the workspace Inbox), the
          // workflow state (else the project default), the sub-task parent, planned
          // start, and the single cycle. `labels` are NAMES — createTask resolves /
          // get-or-creates them against the task's FINAL project; `moduleIds` are ids.
          projectId: msg.projectId,
          parentId: msg.parentId,
          stateId: msg.stateId,
          startDate: msg.startDate,
          cycleId: msg.cycleId,
          labelNames: msg.labels,
          moduleIds: msg.moduleIds,
        });
        // Tasks Redesign — append a 'created' row to the work-item Activity feed so
        // an agent-filed task (the watcher's auto-create lands here) shows in the
        // task's history with the cybo as the actor. Best-effort: a feed-write
        // failure must not fail the create the cybo already committed.
        try {
          await this.pg.recordTaskActivity({
            taskId: id,
            workspaceId: msg.workspaceId,
            actorId,
            verb: "created",
          });
        } catch (err) {
          this.logger?.warn(
            { err, taskId: id },
            "[WorkspaceRelay] cybo task_activity created-row failed",
          );
        }
        // Live-update open task boards (mirrors the human create path).
        await this.broadcastCyboTaskChange(msg.workspaceId, "created", id);
        const reply: CyboWriteResponse = {
          type: "cybo_write_response",
          requestId: msg.requestId,
          ok: true,
          task: { id, title: msg.title, status: "pending" },
        };
        this.send(ws, reply);
        return;
      }

      if (msg.kind === "delete_task") {
        // Extracted to its own method to keep handleCyboWrite's branch count down.
        await this.handleCyboDeleteTask(ws, msg, assertProjectVisible);
        return;
      }

      // kind === "update_task"
      if (!msg.taskId) {
        fail("taskId required");
        return;
      }
      // Scope to THIS workspace's tasks — a daemon must not update across workspaces.
      const existing = (await this.pg.getTasks(msg.workspaceId)).find((t) => t.id === msg.taskId);
      if (!existing) {
        fail("task not found in this workspace");
        return;
      }
      // Tasks Redesign GATE (fail-closed, project-scoped), mirroring the human relay
      // update path: the cybo must be able to see the task's CURRENT project before
      // editing it, and — when the update RE-PARENTS it to a different project — the
      // DESTINATION project too. A task with no project_id (legacy/unassigned) carries
      // no project gate.
      if (existing.project_id && !(await assertProjectVisible(existing.project_id))) {
        fail("task not found in this workspace");
        return;
      }
      if (msg.projectId && !(await assertProjectVisible(msg.projectId))) {
        fail("project not found");
        return;
      }
      // labels[] are NAMES on the cybo write path (the MCP layer has no name→id
      // resolver). Resolve them (get-or-create) to label ids against the task's
      // EFFECTIVE project — the destination project when this update re-parents, else
      // the current one — exactly as the human relay update path does. A task with no
      // project has no label catalog, so labels are skipped there. undefined (field
      // absent) leaves the existing set; an explicit [] clears it.
      let labelIds: string[] | undefined;
      if (msg.labels) {
        const labelProjectId = msg.projectId ?? existing.project_id ?? null;
        labelIds = labelProjectId ? await this.pg.resolveLabels(labelProjectId, msg.labels) : [];
      }
      await this.pg.updateTask(msg.taskId, {
        status: msg.status,
        result: msg.result,
        // (Re)assignment, forwarded so a cybo reassign actually PERSISTS — matching
        // the solo/MCP path. updateTask only writes assigneeId when it is !==
        // undefined, so an absent field leaves the assignee unchanged; a value moves
        // it. Without this, the "assignee" activity row below was emitted but the
        // column never changed (the feed lied).
        assigneeId: msg.assigneeId,
        // Tasks Redesign — Plane-style scalar/set fields, forwarded so a cybo update
        // carries the same shape as the human relay path instead of only status/result.
        // Pass through as-is: null clears a scalar (project/parent/state/cycle/start),
        // moduleIds replaces the task's module set, and labelIds (resolved above from
        // names) replaces the label set.
        priority: msg.priority,
        dueAt: msg.dueAt,
        projectId: msg.projectId,
        parentId: msg.parentId,
        stateId: msg.stateId,
        startDate: msg.startDate,
        cycleId: msg.cycleId,
        labelIds,
        moduleIds: msg.moduleIds,
        // Soft-archive toggle (cyborg7_archive_task rides update_task): epoch ms to
        // archive, null to restore, undefined (absent) leaves it unchanged.
        archivedAt: msg.archivedAt,
      });
      // Tasks Redesign — append 'updated' rows to the work-item Activity feed for
      // the fields the cybo actually changed, so an agent edit shows in the task's
      // history with the cybo as the actor. We compare the forwarded fields against
      // the pre-edit snapshot and emit one row per moved attribute (state/status,
      // assignee, priority). undefined fields were not part of this update and are
      // skipped. Best-effort: a feed-write failure must not fail the committed edit.
      try {
        const acts: Array<{
          field: string;
          oldValue: string | null;
          newValue: string | null;
        }> = [];
        // State move: prefer the explicit stateId; otherwise the legacy status the
        // cybo set. existing.state_id / .status are the pre-edit values.
        if (msg.stateId !== undefined && msg.stateId !== existing.state_id) {
          acts.push({ field: "state", oldValue: existing.state_id ?? null, newValue: msg.stateId });
        } else if (msg.status !== undefined && msg.status !== existing.status) {
          acts.push({ field: "status", oldValue: existing.status ?? null, newValue: msg.status });
        }
        if (msg.assigneeId !== undefined && msg.assigneeId !== existing.assignee_id) {
          acts.push({
            field: "assignee",
            oldValue: existing.assignee_id ?? null,
            newValue: msg.assigneeId ?? null,
          });
        }
        if (msg.priority !== undefined && msg.priority !== existing.priority) {
          acts.push({
            field: "priority",
            oldValue: existing.priority ?? null,
            newValue: msg.priority ?? null,
          });
        }
        for (const a of acts) {
          await this.pg.recordTaskActivity({
            taskId: msg.taskId,
            workspaceId: msg.workspaceId,
            actorId,
            verb: "updated",
            field: a.field,
            oldValue: a.oldValue,
            newValue: a.newValue,
          });
        }
      } catch (err) {
        this.logger?.warn(
          { err, taskId: msg.taskId },
          "[WorkspaceRelay] cybo task_activity updated-row failed",
        );
      }
      // Live-update open task boards (mirrors the human update/archive path; an
      // archive rides this update_task branch with archivedAt, so it broadcasts here
      // as "updated" exactly like the human archive path does).
      await this.broadcastCyboTaskChange(msg.workspaceId, "updated", msg.taskId);
      const reply: CyboWriteResponse = {
        type: "cybo_write_response",
        requestId: msg.requestId,
        ok: true,
        task: {
          id: existing.id,
          title: existing.title,
          status: msg.status ?? existing.status,
        },
      };
      this.send(ws, reply);
    } catch (err) {
      fail(`cybo write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Hard-delete a task on the cybo write path (kind:"delete_task"). Split out of
  // handleCyboWrite so that method's branch count doesn't grow. IDOR guard (#920):
  // anchor to THIS workspace's tasks before deleting — a daemon must never delete
  // across workspaces — with the same project-visibility gate as the update path.
  // STRICT self-scope: the write targets msg.cyboId and NOTHING else — there is no
  // taskId/assignee surface to redirect it at another cybo. We still verify the
  // cybo belongs to THIS workspace (IDOR guard, like the task path) and gate on the
  // cybo's own `manage_self` grant before persisting + replying. Extracted from
  // handleCyboWrite to keep that method's branch count down.
  private async handleCyboUpdateSelf(
    ws: WebSocket,
    msg: CyboWriteRequest,
    fail: (error: string) => void,
  ): Promise<void> {
    if (!this.pg) {
      fail("cybo writes need the shared workspace store (relay has no PG)");
      return;
    }
    const cyboId = msg.cyboId;
    if (!cyboId) {
      fail("update_self requires cyboId");
      return;
    }
    if (typeof msg.soul !== "string" || msg.soul.trim().length === 0) {
      fail("update_self requires a non-empty soul");
      return;
    }
    const cybo = (await this.pg.getCybos(msg.workspaceId)).find((c) => c.id === cyboId);
    if (!cybo) {
      fail("cybo not found in this workspace");
      return;
    }
    let grants: string[] = [];
    try {
      grants = cybo.platform_permissions ? JSON.parse(cybo.platform_permissions) : [];
    } catch {
      grants = [];
    }
    // Same gating semantics as the MCP `allows()` check: a non-empty grant list
    // must include manage_self; an empty list stays fail-open (legacy default).
    if (grants.length > 0 && !grants.includes("manage_self")) {
      fail("this cybo doesn't have the manage_self permission");
      return;
    }
    await this.pg.updateCybo(cyboId, { soul: msg.soul });
    const reply: CyboWriteResponse = {
      type: "cybo_write_response",
      requestId: msg.requestId,
      ok: true,
      cybo: { id: cybo.id, slug: cybo.slug, soul: msg.soul },
    };
    this.send(ws, reply);
  }

  private async handleCyboDeleteTask(
    ws: WebSocket,
    msg: CyboWriteRequest,
    assertProjectVisible: (projectId: string) => Promise<boolean>,
  ): Promise<void> {
    const fail = (error: string): void => {
      this.send(ws, { type: "cybo_write_response", requestId: msg.requestId, ok: false, error });
    };
    if (!this.pg) {
      fail("cybo writes need the shared workspace store (relay has no PG)");
      return;
    }
    if (!msg.taskId) {
      fail("taskId required");
      return;
    }
    const target = (await this.pg.getTasks(msg.workspaceId)).find((t) => t.id === msg.taskId);
    if (!target) {
      fail("task not found in this workspace");
      return;
    }
    if (target.project_id && !(await assertProjectVisible(target.project_id))) {
      fail("task not found in this workspace");
      return;
    }
    await this.pg.deleteTask(msg.taskId);
    this.send(ws, {
      type: "cybo_write_response",
      requestId: msg.requestId,
      ok: true,
      task: { id: target.id, title: target.title, status: target.status },
    });
    // Live-update open task boards: mirror the human delete path's tasks_changed
    // fan-out so an agent/watcher delete drops the row without a refetch. A "deleted"
    // op carries only the id (matching relay-standalone's human delete broadcast).
    this.emitTasksChanged(msg.workspaceId, "deleted", { id: target.id });
  }

  // Re-read a freshly written cybo task and fan it out as cyborg:tasks_changed so an
  // open board live-updates — the cybo/agent write path historically never did this,
  // so an agent- or watcher-filed task only appeared on refetch/reconnect (the human
  // path in relay-standalone broadcasts on every op). Re-reads the POST-write row so
  // the broadcast carries the same full shape the human create/update broadcast does.
  // Best-effort: a fan-out failure must never fail the write the cybo already committed.
  private async broadcastCyboTaskChange(
    workspaceId: string,
    op: "created" | "updated",
    taskId: string,
  ): Promise<void> {
    if (!this.onBroadcast || !this.pg) return;
    try {
      const row = (await this.pg.getTasks(workspaceId)).find((t) => t.id === taskId);
      if (!row) return;
      this.emitTasksChanged(workspaceId, op, this.mapTaskForBroadcast(row));
    } catch (err) {
      this.logger?.warn({ err, taskId }, "[WorkspaceRelay] cybo tasks_changed fan-out failed");
    }
  }

  // Fan a cyborg:tasks_changed broadcast out to workspace guests through the EXISTING
  // onBroadcast → relay-standalone broadcastToGuests seam (the same one the human
  // task path and broadcastAgentReply use; fromDaemonId "guest"). seq is meaningless
  // for a task event (it is not an ordered relay_message), so 0 satisfies the seam's
  // number contract — the client's tasks_changed handler reads only { op, task }.
  private emitTasksChanged(
    workspaceId: string,
    op: "created" | "updated" | "deleted",
    task: Record<string, unknown>,
  ): void {
    this.onBroadcast?.(
      workspaceId,
      { type: "cyborg:tasks_changed", payload: { workspaceId, op, task } },
      "guest",
      0,
    );
  }

  // Map a stored task row to the SAME wire shape the human tasks_changed broadcast
  // uses (relay-standalone's mapTask): camelCase core fields + snake_case Plane
  // fields, which the client's mapRawTask consumes. `schedule` is deliberately
  // OMITTED (not null) so the client merge preserves an existing cadence chip on an
  // updated row — the cybo write path never edits a task's bound schedule.
  private mapTaskForBroadcast(
    t: Awaited<ReturnType<PgSync["getTasks"]>>[number],
  ): Record<string, unknown> {
    return {
      id: t.id,
      workspaceId: t.workspace_id,
      title: t.title,
      description: t.description ?? null,
      status: t.status,
      assigneeId: t.assignee_id ?? null,
      createdBy: t.created_by,
      dueAt: t.due_at ?? null,
      result: t.result ?? null,
      channelId: t.channel_id ?? null,
      priority: t.priority ?? null,
      sortOrder: t.sort_order ?? null,
      startDate: t.start_date ?? null,
      archivedAt: t.archived_at ?? null,
      isDraft: (t.is_draft ?? 0) === 1,
      project_id: t.project_id ?? null,
      parent_id: t.parent_id ?? null,
      state_id: t.state_id ?? null,
      sequence_id: t.sequence_id ?? null,
      cycle_id: t.cycle_id ?? null,
      label_ids: t.label_ids ?? [],
      module_ids: t.module_ids ?? [],
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    };
  }

  // Agent image upload (daemon → relay → S3). The daemon ships an agent-generated
  // image's bytes inline; the relay PUTs them to S3 (the only side with creds) and
  // returns the public URL so the daemon can rewrite the timeline item's markdown
  // token to a reachable URL the renderer embeds inline. Reuses the same
  // uploadAgentImage path as the per-message attachment flush (#845).
  private async handleUploadImage(ws: WebSocket, msg: UploadImageRequest): Promise<void> {
    const reply = (extra: Partial<{ url: string; key: string; error: string }>, ok: boolean) =>
      this.send(ws, { type: "upload_image_response", requestId: msg.requestId, ok, ...extra });
    if (!this.uploadAgentImage) {
      reply({ error: "image upload not available (S3 not configured)" }, false);
      return;
    }
    try {
      const uploaded = await this.uploadAgentImage({
        dataBase64: msg.dataBase64,
        mimeType: msg.mimeType,
        filename: msg.filename,
        size: Buffer.byteLength(msg.dataBase64, "base64"),
        alt: "",
      });
      if (!uploaded) {
        reply({ error: "upload returned no result" }, false);
        return;
      }
      reply({ url: uploaded.url, key: uploaded.key }, true);
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) }, false);
    }
  }

  private async handleSyncRequest(
    ws: WebSocket,
    msg: { workspaceId: string; sinceSeq: number },
  ): Promise<void> {
    if (!this.pg) {
      const reply: RelaySyncResponse = {
        type: "relay_sync_response",
        workspaceId: msg.workspaceId,
        messages: [],
      };
      this.send(ws, reply);
      return;
    }

    try {
      const rows = await this.pg.getMessagesSince(msg.workspaceId, msg.sinceSeq, 500);
      const reply: RelaySyncResponse = {
        type: "relay_sync_response",
        workspaceId: msg.workspaceId,
        messages: rows.map((r) => ({
          type: "cyborg:channel_message_broadcast",
          payload: {
            id: r.id,
            workspaceId: r.workspace_id,
            channelId: r.channel_id,
            fromId: r.from_id,
            fromType: r.from_type,
            text: r.text,
            mentions: r.mentions ? JSON.parse(r.mentions) : null,
            parentId: r.parent_id,
            seq: r.seq,
            createdAt: r.created_at,
          },
        })),
      };
      this.send(ws, reply);
    } catch (err) {
      this.logger?.error({ err }, "[WorkspaceRelay] sync query failed");
      this.send(ws, {
        type: "relay_sync_response",
        workspaceId: msg.workspaceId,
        messages: [],
      });
    }
  }

  private async syncDaemonToPg(
    authDaemonId: string,
    ownerId: string,
    label: string,
    _reportedWorkspaceIds: string[],
    meta?: DaemonMeta,
  ): Promise<void> {
    if (!this.pg) return;
    await this.pg.ensureUser(ownerId, `${ownerId}@daemon.local`, ownerId);
    await this.pg.upsertDaemon(authDaemonId, ownerId, label, meta);
    // Link the daemon ONLY to workspaces its owner is actually a member of in PG —
    // the source of truth. We deliberately ignore the daemon's reported LOCAL
    // workspaceIds: those can be stale/orphan rows accumulated from old testing
    // and re-link clutter into workspace_daemons on every reconnect. A fresh
    // daemon with an empty local DB still links correctly (membership covers it).
    const ownerWorkspaces = await this.pg.getWorkspacesForUser(ownerId).catch((err) => {
      this.logger?.error(
        { err, authDaemonId },
        "[WorkspaceRelay] getWorkspacesForUser failed — daemon links to 0 workspaces this sync",
      );
      return [];
    });
    // Link to each workspace concurrently — these are independent idempotent
    // upserts that previously ran as a per-workspace sequential await (an N+1 on
    // every daemon (re)connect, #55).
    const pg = this.pg;
    await Promise.all(ownerWorkspaces.map((w) => pg.ensureWorkspaceDaemon(w.id, authDaemonId)));
    console.log(
      `[WorkspaceRelay] PG sync complete: daemon=${authDaemonId}, workspaces=${ownerWorkspaces.length}`,
    );
  }

  // Link every currently-connected daemon owned by `ownerId` to `workspaceId`:
  // subscribe it for traffic + persist the association + announce it online. Used
  // when a workspace is created AFTER the owner's daemon already connected (the
  // fresh-install case) — without this the new workspace shows "0 daemons" until
  // the daemon reconnects.
  async linkOwnerDaemonsToWorkspace(workspaceId: string, ownerId: string): Promise<void> {
    for (const conn of this.daemons.values()) {
      if (conn.ownerId !== ownerId || conn.workspaceIds.has(workspaceId)) continue;
      this.subscribeDaemonConn(conn.ws, conn, workspaceId);
      if (this.pg) {
        await this.pg
          .ensureWorkspaceDaemon(workspaceId, conn.daemonId)
          .catch((err) =>
            this.logger?.error(
              { err, workspaceId },
              "[WorkspaceRelay] ensureWorkspaceDaemon failed — workspace may show 0 daemons until reconnect",
            ),
          );
      }
      this.onDaemonConnect?.(conn.daemonId, [workspaceId]);
    }
  }

  injectMessage(workspaceId: string, message: Record<string, unknown>, fromId = "relay"): number {
    const seqState = this.workspaceSeqs.get(workspaceId);
    if (!seqState) {
      this.workspaceSeqs.set(workspaceId, { current: 0 });
    }
    const seq = (this.workspaceSeqs.get(workspaceId)!.current += 1);

    const relayMsg: RelayMessage = {
      type: "relay_message",
      workspaceId,
      fromDaemonId: fromId,
      seq,
      message,
    };

    const subscribers = this.workspaceSubscribers.get(workspaceId);
    if (subscribers) {
      for (const subscriberWs of subscribers) {
        if (subscriberWs.readyState === WebSocket.OPEN) {
          this.send(subscriberWs, relayMsg);
        }
      }
    }

    this.onBroadcast?.(workspaceId, message, fromId, seq);

    if (this.pg) {
      void this.persistMessage(workspaceId, seq, message);
    }

    return seq;
  }

  private handleDisconnect(ws: WebSocket): void {
    const conn = this.daemons.get(ws);
    if (!conn) return;

    if (this.pg) {
      this.pg.setDaemonOffline(conn.daemonId).catch((err) => {
        this.logger?.error({ err }, "[WorkspaceRelay] offline update failed");
      });
    }
    this.onDaemonDisconnect?.(conn.daemonId, [...conn.workspaceIds]);

    for (const wsId of conn.workspaceIds) {
      const subs = this.workspaceSubscribers.get(wsId);
      if (subs) {
        subs.delete(ws);
        if (subs.size === 0) {
          this.workspaceSubscribers.delete(wsId);
        }
      }
    }
    this.daemons.delete(ws);
  }

  private send(
    ws: WebSocket,
    msg:
      | RelaySubscribed
      | RelayMessage
      | RelaySyncResponse
      | RelayError
      | CyboReadResponse
      | CyboWriteResponse
      | UploadImageResponse,
  ): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  getSubscriberCount(workspaceId: string): number {
    return this.workspaceSubscribers.get(workspaceId)?.size ?? 0;
  }

  getConnectedDaemons(): string[] {
    return Array.from(this.daemons.values()).map((c) => c.daemonId);
  }

  // READY provider ids a daemon reported in daemon_hello (#697), or undefined if
  // it never reported (old daemon) — the caller then degrades to a blind pick.
  // Reads the FIRST live connection for the id (eviction keeps it to one, #694).
  getDaemonProviders(daemonId: string): string[] | undefined {
    for (const conn of this.daemons.values()) {
      if (conn.daemonId === daemonId) return conn.providers;
    }
    return undefined;
  }

  // Subscribe a daemon connection to a workspace for ROUTING (in-memory) — so
  // workspace broadcasts (prompts, etc.) reach it. Idempotent.
  private subscribeDaemonConn(ws: WebSocket, conn: DaemonConnection, workspaceId: string): void {
    conn.workspaceIds.add(workspaceId);
    if (!this.workspaceSubscribers.has(workspaceId)) {
      this.workspaceSubscribers.set(workspaceId, new Set());
    }
    this.workspaceSubscribers.get(workspaceId)!.add(ws);
    if (!this.workspaceSeqs.has(workspaceId)) {
      this.workspaceSeqs.set(workspaceId, { current: 0 });
    }
  }

  // Stop routing a workspace's traffic to this daemon connection. Idempotent.
  private unsubscribeDaemonConn(ws: WebSocket, conn: DaemonConnection, workspaceId: string): void {
    conn.workspaceIds.delete(workspaceId);
    const subs = this.workspaceSubscribers.get(workspaceId);
    if (subs) {
      subs.delete(ws);
      if (subs.size === 0) this.workspaceSubscribers.delete(workspaceId);
    }
  }

  // Live-apply an owner's workspace-serving toggle to any connected instance of
  // the daemon, so it takes effect without a reconnect. Returns true if a live
  // connection was updated. PG persistence is the caller's responsibility.
  setDaemonWorkspaceServing(daemonId: string, workspaceId: string, enabled: boolean): boolean {
    let updated = false;
    for (const [ws, conn] of this.daemons) {
      if (conn.daemonId !== daemonId) continue;
      if (enabled) this.subscribeDaemonConn(ws, conn, workspaceId);
      else this.unsubscribeDaemonConn(ws, conn, workspaceId);
      updated = true;
    }
    return updated;
  }

  // Close + drop every OTHER connection registered for `daemonId` (#694). Called
  // on a fresh daemon_hello so a reconnect can't leave a stale/zombie socket that
  // sendToDaemonInWorkspace would target first. Best-effort close; the routing
  // removal (unsubscribe + map delete) is what actually fixes delivery.
  private evictDaemonConnections(daemonId: string, exceptWs: WebSocket): void {
    for (const [ws, conn] of this.daemons) {
      if (ws === exceptWs || conn.daemonId !== daemonId) continue;
      // Snapshot: unsubscribeDaemonConn deletes from conn.workspaceIds as we go
      // (same pattern as the PG-reconcile loop above).
      for (const wsId of Array.from(conn.workspaceIds)) this.unsubscribeDaemonConn(ws, conn, wsId);
      this.daemons.delete(ws);
      try {
        ws.close(1012, "superseded by a newer daemon connection");
      } catch {
        // Best-effort: a zombie socket may already be unwritable.
      }
    }
  }

  sendToDaemonInWorkspace(
    workspaceId: string,
    message: Record<string, unknown>,
    targetDaemonId?: string,
  ): boolean {
    if (targetDaemonId) {
      for (const [ws, conn] of this.daemons) {
        if (conn.daemonId === targetDaemonId && ws.readyState === WebSocket.OPEN) {
          // A daemon can be targeted (e.g. create_agent) for a workspace it didn't
          // report at connect; subscribe it so later prompts (broadcast to
          // subscribers) actually reach it and the agent responds.
          this.subscribeDaemonConn(ws, conn, workspaceId);
          // Use the REAL send result (#692): an OPEN socket can still fail the
          // write (it closed between the readyState check and the send, or the
          // transport errored), so don't report success blindly. On a failed
          // send, keep scanning — a reconnect overlap can leave a second OPEN
          // connection for the same daemon. Only report failure after exhausting
          // them, so the caller surfaces "no daemon" instead of dropping silently.
          if (this.sendRelayMessage(ws, workspaceId, message)) return true;
        }
      }
      return false;
    }
    const subscribers = this.workspaceSubscribers.get(workspaceId);
    if (subscribers) {
      // Snapshot the set: a synchronous unsubscribe during send would otherwise
      // mutate it mid-iteration. Try each OPEN subscriber — a failed send on the
      // first (CLOSING race) falls through to the next daemon serving this
      // workspace rather than reporting failure while a healthy one exists (#692).
      for (const ws of Array.from(subscribers)) {
        const conn = this.daemons.get(ws);
        if (
          conn &&
          ws.readyState === WebSocket.OPEN &&
          this.sendRelayMessage(ws, workspaceId, message)
        ) {
          return true;
        }
      }
    }
    // No blind fallback: previously this forwarded the workspace RPC (carrying the
    // guest token + guestId) to the first connected daemon of ANY workspace when
    // none was subscribed to THIS workspace — a cross-tenant leak that also made
    // the caller think delivery succeeded. If no daemon serves this workspace,
    // report failure so the guest gets a proper "no daemon connected" error.
    return false;
  }

  // Fan-out a workspace RPC to EVERY connected daemon subscribed to the workspace
  // and return the ids of the daemons it actually reached. Used for list_agents:
  // a workspace can have multiple daemons (e.g. an invited member's own daemon),
  // and each only knows its OWN agents, so listing requires aggregating across all.
  sendToAllDaemonsInWorkspace(workspaceId: string, message: Record<string, unknown>): string[] {
    const reached: string[] = [];
    const subscribers = this.workspaceSubscribers.get(workspaceId);
    if (!subscribers) return reached;
    for (const ws of subscribers) {
      const conn = this.daemons.get(ws);
      if (
        conn &&
        ws.readyState === WebSocket.OPEN &&
        this.sendRelayMessage(ws, workspaceId, message)
      ) {
        reached.push(conn.daemonId);
      }
    }
    return reached;
  }

  // Returns true only if the frame was actually handed to the socket. A send on
  // an OPEN-but-broken socket throws synchronously ("WebSocket is not open" on a
  // CLOSING race, or a serialization error) — catch it so a failed delivery is
  // reported as such (#692) instead of bubbling up and crashing the caller.
  private sendRelayMessage(
    ws: WebSocket,
    workspaceId: string,
    message: Record<string, unknown>,
  ): boolean {
    const relayMsg: RelayMessage = {
      type: "relay_message",
      workspaceId,
      fromDaemonId: "relay",
      seq: 0,
      message,
    };
    try {
      ws.send(JSON.stringify(relayMsg));
      return true;
    } catch (err) {
      this.logger?.error({ err }, "[WorkspaceRelay] relay_message send failed");
      return false;
    }
  }

  getCurrentSeq(workspaceId: string): number {
    return this.workspaceSeqs.get(workspaceId)?.current ?? 0;
  }

  async close(): Promise<void> {
    if (this.bufferFlushTimer) {
      clearInterval(this.bufferFlushTimer);
      this.bufferFlushTimer = null;
    }
    if (this.presenceSweepTimer) {
      clearInterval(this.presenceSweepTimer);
      this.presenceSweepTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    await this.flushBufferedMessages();

    for (const [ws] of this.daemons) {
      ws.close(1001, "relay shutting down");
    }
    this.daemons.clear();
    this.workspaceSubscribers.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
      this.wss = null;
    }
  }
}

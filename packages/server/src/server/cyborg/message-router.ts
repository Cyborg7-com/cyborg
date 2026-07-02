import type { DualStorage } from "./dual-storage.js";
import type { StoredMessage, StoredAgentBinding, StoredActivityEvent } from "./storage.js";
import type { WorkspaceManager } from "./workspace-manager.js";
import type { CyborgAuthContext } from "./auth.js";
import type {
  CyborgChannelMessage,
  CyborgDm,
  CyborgFetchMessagesRequest,
  CyborgFetchThreadRequest,
  CyborgPinMessage,
  CyborgEditMessage,
  CyborgDeleteMessage,
  CyborgMarkRead,
  CyborgMarkChannelUnread,
  CyborgFetchUnread,
  CyborgFetchActivity,
  CyborgMarkActivityRead,
  CyborgSearch,
  CyborgSetNotificationPref,
  CyborgFetchNotificationPrefs,
  CyborgDraftSet,
  CyborgDraftClear,
  CyborgFetchDrafts,
  CyborgSyncRequest,
  CyborgTerminalDirEntry,
} from "./cyborg-messages.js";
import { spawnCybo } from "./cybo-manager.js";
import { runFallbackChain } from "./chain-router.js";
import { CyboCredentialStore } from "./cybo-credentials.js";
import { type ComposioDeps, createComposioDeps } from "./composio-deps.js";
import { nativeHarnessGapMessage } from "./cybo-runtime-profile.js";
import { isNativeHarnessProvider } from "./native-harness-login.js";
import { enqueueWebhookEvent } from "./webhook-enqueue.js";
import type { WebhookEventType } from "./outgoing-webhook-delivery.js";
import { classifyProviderError } from "./provider-error-classify.js";
import { prepareAgentImageUploads } from "./codex-image-attachment.js";
import { recordAgentImageUrl } from "./agent-image-url-map.js";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename } from "node:path";
import { expandPromptTemplate, formatTemplateDate } from "./prompt-template-expand.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStreamEvent, AgentPromptInput } from "../agent/agent-sdk-types.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { MessageCard } from "./webhook-card.js";
import type { DaemonRelayClient } from "./daemon-relay-client.js";
import { buildCyboSpawnFailureOutcome } from "./daemon-telemetry.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { Logger } from "pino";

export interface BroadcastFn {
  toWorkspace(workspaceId: string, message: unknown): void;
  toUser(userId: string, message: unknown): void;
}

// Upper bound on an ephemeral channel summon's single turn (@-mention / /ask).
// These turns have no completion path other than the drain loop in routeToAgent
// seeing a terminal stream event, so a stalled provider turn (e.g. a wedged
// cyborg7 MCP tool round-trip) would otherwise hang forever — no reply, no
// teardown. The bound is generous (mention replies routinely take tens of
// seconds with tool use) but finite; tunable via CYBORG7_EPHEMERAL_TURN_TIMEOUT_MS.
const EPHEMERAL_TURN_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CYBORG7_EPHEMERAL_TURN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
})();

// The mention→cybo resolver moved to cybo-mention-invoke.ts (ONE source of
// truth shared with the relay's cloud-mention invocation); re-exported so the
// existing local-mode consumers/tests keep their import path.
export { resolveMentionedCyboIds } from "./cybo-mention-invoke.js";
import {
  buildMentionPrompt,
  buildMentionRosterContext,
  buildWatcherPrompt,
  formatMentionTranscript,
  MAX_MENTION_FANOUT,
  mentionClaimKey,
  mentionInvocationGuard,
  resolveMentionedCybos,
  watchClaimKey,
  watchInvocationGuard,
  type WatcherOpenTask,
} from "./cybo-mention-invoke.js";
import { shouldConsiderWatch } from "./watcher-prefilter.js";
import { RateLimiter } from "./rate-limiter.js";
import { type TaskLogEvent, taskEventBroadcast } from "./task-event-log.js";
import { type AuditEvent, auditEventBroadcast } from "./audit-event-log.js";
import { type AuditSink, createAuditSink } from "./audit-sink.js";
import { mentionActivityId } from "./activity-id.js";

// Enrich a turn-time `turn_failed` stream event with the SAME classified reason
// the spawn-gate already surfaces (reasonKind + unavailableReason), so the UI can
// render the polished provider remedy ("Add usage" / "Reconnect with an API key")
// instead of the raw `400 {…}` blob. Closes the documented gap where the
// usage-gate only appears at INFERENCE time (a turn failure), not at spawn.
//
// Additive + backward-compatible: returns the event UNCHANGED for any non-
// turn_failed event, and for a turn_failed it only ATTACHES the two optional
// fields when the error classifies to a KNOWN kind — an "unknown" classification
// leaves the event untouched so the UI still shows the raw error verbatim. We
// classify the provider `error` text first (where the usage-gate 400 lives) and
// fall back to the provider `diagnostic` when the error itself doesn't classify.
export function enrichTurnFailedEvent(event: unknown): unknown {
  // Guard the param first: a malformed/absent event must pass through untouched,
  // never throw on a property read.
  if (!event || typeof event !== "object") return event;
  const evt = event as Record<string, unknown>;
  if (evt.type !== "turn_failed") return event;
  // Already enriched (e.g. re-broadcast) — never clobber.
  if (evt.reasonKind != null || evt.unavailableReason != null) return event;
  const errorText = typeof evt.error === "string" ? evt.error : "";
  const diagnostic = typeof evt.diagnostic === "string" ? evt.diagnostic : "";
  let classified = classifyProviderError(errorText);
  if (classified.kind === "unknown" && diagnostic) {
    classified = classifyProviderError(diagnostic);
  }
  if (classified.kind === "unknown") return event;
  return { ...evt, reasonKind: classified.kind, unavailableReason: classified.reason };
}

// Flatten a routed prompt (string OR structured content blocks) into the text
// form persisted in the ephemeral session-context capture (#994). Text blocks
// join verbatim; non-text blocks (vision images, attachments) collapse to a
// short placeholder so the captured framed prompt stays readable in the viewer.
export function stringifyPromptForCapture(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[image:${block.mimeType}]`;
      return "[attachment]";
    })
    .join("\n");
}

// internal docs FIX 5 — the ephemeral mention drain used to SWALLOW a failed/empty
// cybo turn (turn_failed, auth error, immediate exit, timeout): no text posted,
// no error surfaced — the silent black hole. This classifies that failure into a
// SHORT, channel-safe notice so every @-mention gets a visible answer or a clear
// reason it didn't. Pure + exported for the drain test.
//
// Inputs are the (possibly absent) terminal turn_failed event the drain captured,
// plus whether the watchdog fired (timedOut) and whether the stream threw/the
// daemon dropped mid-turn (interrupted). NEVER leaks a stack trace or secret —
// only the classifier's short reason (already redacted to probe-safe text).
export function classifyEphemeralFailureNotice(input: {
  cyboName: string;
  provider: string | null;
  failedEvent: Record<string, unknown> | null;
  timedOut: boolean;
  interrupted: boolean;
}): string | null {
  const name = input.cyboName.trim() || "The cybo";
  // Daemon went offline / the agent stream dropped mid-turn with no terminal
  // failure event — the turn never reached a verdict.
  if (input.interrupted && !input.failedEvent) {
    return `**${name}**'s daemon went offline before replying.`;
  }
  // Watchdog timeout, or any terminal end that produced nothing deliverable.
  if (input.timedOut && !input.failedEvent) {
    return `**${name}** didn't return a reply (timed out or was interrupted). Try again.`;
  }
  if (input.failedEvent) {
    const errorText = typeof input.failedEvent.error === "string" ? input.failedEvent.error : "";
    const diagnostic =
      typeof input.failedEvent.diagnostic === "string" ? input.failedEvent.diagnostic : "";
    let classified = classifyProviderError(errorText);
    if (classified.kind === "unknown" && diagnostic) {
      classified = classifyProviderError(diagnostic);
    }
    // Auth / login failure → the actionable login remedy (PART 1) for a native
    // harness (the daemon is signed out / the token expired mid-turn), else the
    // classified short reason.
    const isAuthGap =
      classified.kind === "auth_invalid" ||
      classified.kind === "expired" ||
      classified.kind === "not_configured";
    if (isAuthGap && input.provider && isNativeHarnessProvider(input.provider)) {
      return nativeHarnessGapMessage(name, input.provider);
    }
    // Any other turn / provider error — short classified reason, never the raw blob.
    return `**${name}** hit an error: ${classified.reason}`;
  }
  // No event, no timeout, no interruption, but the turn produced nothing
  // deliverable (immediate exit) — still surface a notice rather than silence.
  return `**${name}** didn't return a reply (timed out or was interrupted). Try again.`;
}

export class MessageRouter {
  private agentManager: AgentManager | null = null;
  private agentStorage: AgentStorage | null = null;
  // Ephemeral channel summons (mentions) whose cybo delivered its reply via the
  // cyborg7_send_message tool (claude/codex). The drain-loop bridge in
  // routeToAgent consults this so it doesn't double-post the assistant text for
  // those, while still posting for harnesses that can't call the tool (opencode/pi).
  private ephemeralPostedViaTool = new Set<string>();
  // Turn-scoped DM guard: agentId → Map of human user id → that user's EMAIL,
  // for the 1:1 DMs this cybo is currently answering. Added when a DM turn starts
  // (handleDm), removed when it ends. While non-empty, BOTH paths a DM reply can
  // take are redirected to the DM: a cyborg7_send_message({channel}) call from this
  // cybo is rewritten to the DM recipient in handleAgentMessage, AND the relay
  // flush path is steered by emitAgentStream (channelId:null + privateToEmail =
  // the recipient's email). Otherwise a scheduled cybo's persistent, channel-bound
  // session leaks its private DM reply into its bound channel. We carry the EMAIL
  // (not just the id) because the relay's DM routing keys on privateToEmail. A Map
  // (not a single id) so a second concurrent DM whose routeToAgent rejects ("agent
  // busy") can't clear the guard out from under the first, still-running turn.
  // Untouched for @-mention/scheduled turns (not in this map).
  //
  // ponytail: this guard is keyed per-AGENT, not per-TURN. A reused/persistent cybo
  // (schedule-runner's reuseLiveCyboBinding) shares ONE agentId across its channel
  // session AND its DMs, so in principle interleaved channel+DM turns could clobber
  // each other's scope. In practice routeToAgent serializes turns per agent (a second
  // run rejects with "agent busy" before its events stream), so only one turn's events
  // are ever in flight while the guard is armed — the per-agent key is correct for the
  // serialized case. A fully turn-scoped delivery target (carry channel-vs-DM on the
  // stream event itself) would require threading a turn id through Paseo's
  // AgentManager stream events (upstream-owned, agent/), which is out of scope here.
  private dmTurnRecipient = new Map<string, Map<string, string>>();
  private logger: Logger | null = null;
  private relayClient: DaemonRelayClient | null = null;
  // Durable timeline store, for rewriting a persisted local image token to its
  // uploaded S3 URL (agent-image inline render). Minimal surface — only the
  // rewrite method, so MessageRouter doesn't depend on the full store type.
  private timelineStore: {
    rewriteImageUrl(agentId: string, from: string, to: string): number;
  } | null = null;
  private serverId: string | null = null;
  // Base URL the spawned cybo connects to for the cyborg7 MCP tools (so an
  // @-mention-invoked cybo can read/react/respond in the channel). Plumbed from
  // bootstrap, mirroring the dispatcher.
  private cyborg7McpBaseUrl: string | null = null;
  private unsubscribeAgentEvents: (() => void) | null = null;
  // Ephemeral agents currently being torn down — guards against a second
  // terminal stream event racing the async close.
  private tearingDown = new Set<string>();
  // Cache: agentId -> initiator email for private (DM) agents, so we can tag
  // their stream/status broadcasts without a per-chunk lookup.
  private readonly privateEmailCache = new Map<string, string | null>();
  private readonly privateEmailResolving = new Set<string>();
  // Phase 3 (internal docs): per-daemon credential store, lazily built (mirrors
  // the dispatcher). Consulted by spawnCybo ONLY for openai-compatible api cybos;
  // every other mention spawn ignores it, so this is free for daemons that never
  // run a raw-API cybo (it picks up $PASEO_HOME at first use).
  private credentialStoreInstance: CyboCredentialStore | null = null;
  // Tasks Phase 2 — per-channel watcher debounce (agent_watch bucket, ≤1/20s).
  // Local to the router (the dispatcher owns its own for guest ops); the relay
  // path applies its own limiter. Keyed by channel id.
  private readonly watcherRateLimiter = new RateLimiter();
  // @-mention spawn throttle (agent_spawn bucket, keyed by workspace). The local
  // mention path was previously UNTHROTTLED — one message mentioning N cybos fired
  // N concurrent spawns, and rapid posting was unbounded. Shares the slash path's
  // agent_spawn config so a workspace's mention + slash invocations are governed
  // by the same per-workspace budget.
  private readonly mentionRateLimiter = new RateLimiter();

  private get credentialStore(): CyboCredentialStore {
    if (!this.credentialStoreInstance) {
      this.credentialStoreInstance = new CyboCredentialStore({
        logger: this.logger ?? undefined,
      });
    }
    return this.credentialStoreInstance;
  }

  // Composio third-party tools — built once from COMPOSIO_API_KEY (knowledge:
  // composio-ownership-and-permissions). `undefined` when unset, so an @-mention
  // spawn's injectComposioMcpServers is a strict no-op. SHIPS DARK by default.
  private composioDepsResolved = false;
  private composioDepsInstance: ComposioDeps | undefined;

  private get composio(): ComposioDeps | undefined {
    if (!this.composioDepsResolved) {
      this.composioDepsInstance = createComposioDeps(this.storage);
      this.composioDepsResolved = true;
    }
    return this.composioDepsInstance;
  }

  // For a private agent (DM, no channel) return the initiator's email so the
  // relay can scope its stream/status to that user instead of the whole
  // workspace. Returns null for channel agents (visible to all members).
  // Resolve a binding's local initiator id to an email for the relay's
  // agent_sessions writer (it maps email → global PG account id). Extracted from
  // the agent_state callback to keep that hot path under the complexity budget.
  // The initiator email the relay resolves to agent_sessions.user_id. PREFER the
  // binding's stored initiated_by_email — the REAL canonical cloud email threaded
  // from the opener's auth at spawn (spawnCybo). initiated_by is a daemon-LOCAL id
  // that, for a cloud opener, only maps to a synthetic `<id>@remote.local`
  // placeholder in local SQLite, so getUserById(initiated_by).email yields that
  // placeholder, the relay's getUserByEmail can't resolve it, and user_id lands
  // NULL — making even an INTERACTIVE cybo open owner-less (privacy incident
  // 2026-06-30). initiated_by_email is populated for every human-initiated spawn
  // (schedule, task, AND interactive open/DM); NULL only for a truly autonomous
  // run, where the local lookup is the right fallback.
  private initiatorEmail(binding: {
    initiated_by: string | null;
    initiated_by_email: string | null;
  }): string | null {
    const stored = binding.initiated_by_email;
    if (stored && !stored.endsWith("@remote.local")) return stored;
    if (!binding.initiated_by) return null;
    return this.storage.getUserById(binding.initiated_by)?.email ?? null;
  }

  // Best-effort capture of the provider resume id once the agent reveals it (it's
  // null at create, assigned after the first turn). Persisted on the binding and
  // mirrored to PG so the durable offline session row carries it too. Paseo's
  // on-disk JSON stays the authoritative resume source — this is bookkeeping only,
  // so a no-op (unchanged/missing id) or a failed write never affects the turn.
  private captureProviderSessionId(
    agentId: string,
    persistence: { sessionId?: string | null } | null | undefined,
    binding: StoredAgentBinding,
  ): void {
    const providerSessionId = persistence?.sessionId;
    if (!providerSessionId) return;
    if (providerSessionId === binding.provider_session_id) return;
    this.storage.updateAgentBindingSession(agentId, providerSessionId);
  }

  private privateAgentEmail(binding: {
    agent_id: string;
    channel_id: string | null;
    initiated_by: string | null;
  }): string | null {
    if (binding.channel_id || !binding.initiated_by) return null;
    const agentId = binding.agent_id;
    const cached = this.privateEmailCache.get(agentId);
    if (cached !== undefined) return cached;

    // Local lookup first (initiated_by may be a local SQLite id). Skip the
    // synthetic `<id>@remote.local` placeholder rows that ensureUser creates for
    // cloud guests (memberships-FK fix): tagging the stream with that placeholder
    // makes the relay's email gate drop the initiator's OWN live events (their
    // real guest email never matches), so the chat only updates on reload. Fall
    // through to the PG lookup, which has the real email.
    const local = this.storage.getUserById(binding.initiated_by)?.email ?? null;
    if (local && !local.endsWith("@remote.local")) {
      this.privateEmailCache.set(agentId, local);
      return local;
    }
    // initiated_by is likely a CLOUD id (relay-created agent) that doesn't exist
    // in local SQLite — resolve it via PG asynchronously and cache. Until it
    // resolves we return null (fail-open for the first events); once cached, the
    // stream is correctly scoped to the initiator. Without this, cross-daemon DM
    // agents leaked their stream to the whole workspace.
    const pg = this.storage.pg;
    if (pg && !this.privateEmailResolving.has(agentId)) {
      this.privateEmailResolving.add(agentId);
      void pg
        .getUserById(binding.initiated_by)
        .then((u) => {
          this.privateEmailCache.set(agentId, u?.email ?? null);
          return u;
        })
        .catch((err) => {
          this.logger?.warn(
            { err, agentId, initiatedBy: binding.initiated_by },
            "message-router: private-email resolution failed (stream stays workspace-scoped)",
          );
        })
        .finally(() => {
          this.privateEmailResolving.delete(agentId);
        });
    }
    return null;
  }

  constructor(
    private storage: DualStorage,
    private workspaceManager: WorkspaceManager,
    private broadcast: BroadcastFn,
  ) {}

  // Re-render a card after a signed action resolved it (#600): clients replace
  // the message's card with the settled version (resolution set, buttons gone).
  // Channel scope is read from the message row so the broadcast lands where the
  // card lives.
  broadcastMessageCardUpdated(
    workspaceId: string,
    messageId: string,
    card: MessageCard | null,
  ): void {
    const msg = this.storage.getMessageById(messageId);
    this.broadcast.toWorkspace(workspaceId, {
      type: "cyborg:message_card_updated",
      payload: { workspaceId, channelId: msg?.channel_id ?? null, messageId, card },
    });
  }

  setAgentManager(agentManager: AgentManager): void {
    this.agentManager = agentManager;
    this.subscribeToAgentEvents(agentManager);
  }

  private subscribeToAgentEvents(agentManager: AgentManager): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
    }

    this.unsubscribeAgentEvents = agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          const binding = this.storage.getAgentBinding(event.agent.id);
          if (!binding) return;

          // Ephemeral summons (mentions, slash commands) are invisible sessions:
          // never announce them to the workspace. The agent_status broadcast is
          // also what the relay uses to register daemon_agents rows in PG — an
          // ephemeral that emits it shows up in every member's sidebar (the
          // 2026-06-12 ghost-session incident) and leaves a stale PG row behind.
          if (binding.ephemeral) {
            // Local guarantee for the turn_failed invariant (#446): teardown is
            // normally driven by turn_completed/turn_failed stream events, and
            // today every error path emits turn_failed — but only by convention
            // across call sites. An ephemeral whose agent reaches the error
            // lifecycle is torn down HERE too, so an error path that forgets to
            // emit turn_failed can't leave a ghost session alive (idempotent
            // with the stream-event teardown).
            if (event.agent.lifecycle === "error") {
              void this.teardownEphemeralAgent(event.agent.id);
            }
            return;
          }

          // Best-effort: stamp the provider resume id onto the binding once the
          // agent reveals it (extracted to keep this hot subscriber under the
          // complexity budget — see captureProviderSessionId).
          this.captureProviderSessionId(event.agent.id, event.agent.persistence, binding);

          // Build + broadcast the agent_status (extracted to keep this hot subscriber
          // under the complexity budget — see emitAgentStatus).
          this.emitAgentStatus(binding, event.agent);
          return;
        }

        if (event.type === "agent_stream") {
          const binding = this.storage.getAgentBinding(event.agentId);
          if (!binding) return;

          // Classify a turn-time provider failure here (the single funnel for
          // real inference-time stream events) so a usage-gated / auth / expired
          // turn carries the remedy reason to the UI.
          const enrichedEvent = enrichTurnFailedEvent(
            event.event as Record<string, unknown>,
          ) as Record<string, unknown>;
          // #845: an agent (e.g. Codex / the imagegen skill) emits a generated
          // image as a markdown token pointing at a LOCAL daemon tmp file the
          // browser can't read. The owning daemon (here) reads the bytes, uploads
          // them to S3 via the relay, and REWRITES the token in place to the S3
          // URL so it renders inline in the session transcript AND any channel
          // message. broadcastAgentStream takes the sync fast-path for every
          // non-image event (no delay) and only awaits the upload when an image
          // is present. Best-effort — on any failure the token is left as-is.
          this.broadcastAgentStream(event.agentId, binding, enrichedEvent);

          // Ephemeral summons (slash commands) live for exactly one turn: tear
          // them down once the turn ends. The reply was already delivered — by a
          // cyborg7_send_message tool call (claude/codex) or by the drain-loop
          // bridge in routeToAgent (harnesses that can't call the tool).
          const streamType = (event.event as { type?: string })?.type;
          // At turn end retry any durable image rewrites that raced the row write,
          // and drop the per-turn accumulated assistant text (#845 inline render).
          if (streamType === "turn_completed" || streamType === "turn_failed") {
            this.finalizeTurnImages();
          }
          // Persist this session's cumulative token usage at each turn end (Home
          // stats). lastUsage is cumulative, so we overwrite — best-effort/PG-only.
          if (streamType === "turn_completed") {
            const usage = (
              event.event as {
                usage?: {
                  inputTokens?: number;
                  outputTokens?: number;
                  cachedInputTokens?: number;
                  totalCostUsd?: number;
                };
              }
            ).usage;
            if (usage) this.storage.recordAgentSessionUsage(event.agentId, usage);
          }
          if (
            binding.ephemeral &&
            (streamType === "turn_completed" || streamType === "turn_failed")
          ) {
            void this.teardownEphemeralAgent(event.agentId);
          }
        }
      },
      { replayState: false },
    );
  }

  dispose(): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }
  }

  private readonly imageUploadOpts = {
    readFile: readFileSync,
    basename,
    // Cap an inlined image so a huge file can't bloat the upload. Codex raster
    // output is small; anything larger is left as-is (token untouched).
    maxBytes: 10 * 1024 * 1024,
    // Codex's NATIVE image output lands in os.tmpdir()/paseo-attachments, but
    // skill-generated images write to OTHER temp subdirs — allow the whole OS
    // temp dir: still traversal-proof (`..` can't escape tmpdir), and the agent
    // can already write anywhere in tmp, so reading an image it placed there is
    // no new exposure.
    allowedDir: tmpdir(),
  };
  // Accumulated assistant text per messageId, so an image token SPLIT across
  // stream deltas (e.g. "![" then "live-reload](/tmp/x.png)") is still detected —
  // detection needs the COMPLETE token, which only the accumulation has. Cleared
  // per turn.
  private assistantTextAccum = new Map<string, string>();
  // Local paths already uploaded this session (dedup: detection re-fires on every
  // delta as the accumulation grows).
  private uploadedImagePaths = new Set<string>();
  // Durable rewrites whose row wasn't committed yet when the upload finished
  // (the upload races the AgentManager timeline write) — retried at turn end.
  private pendingDurableRewrites: Array<{ agentId: string; path: string; url: string }> = [];
  // Per-agent FIFO so broadcasts stay IN ORDER: an image event awaits its S3
  // upload before emitting, which (via this chain) delays the next event's emit
  // too — otherwise a later text delta / turn_completed would overtake the
  // in-flight image event and scramble the transcript. Holds one (latest) promise
  // per agent; replaced on each event, so retention is bounded by agent count.
  private broadcastChains = new Map<string, Promise<void>>();

  // Broadcast an agent_stream event to the workspace, replacing any local-path
  // image token in an assistant_message with its uploaded S3 URL (#845 inline
  // render). Serialized per agent (see broadcastChains) so emit order is preserved.
  private broadcastAgentStream(
    agentId: string,
    binding: StoredAgentBinding,
    streamEvent: Record<string, unknown>,
  ): void {
    const prev = this.broadcastChains.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(() => this.processAndEmitAgentStream(agentId, binding, streamEvent))
      .catch((err) => this.logger?.warn({ err, agentId }, "agent_stream broadcast failed"));
    this.broadcastChains.set(agentId, next);
  }

  // A token fully inside THIS delta is uploaded + rewritten + emitted (renders
  // live); a token SPLIT across deltas is detected on the accumulated text and
  // uploaded in the BACKGROUND after the delta emits (renders on the next fetch —
  // reload/reopen — via the durable rewrite + the dispatcher's serve-rewrite map).
  private async processAndEmitAgentStream(
    agentId: string,
    binding: StoredAgentBinding,
    streamEvent: Record<string, unknown>,
  ): Promise<void> {
    const ev = streamEvent as {
      type?: string;
      item?: { type?: string; text?: string; messageId?: string };
    };
    // Capture needs the relay (only it has S3 creds). Without it, or for any
    // non-assistant-message event, broadcast unchanged (solo mode leaves the
    // markdown token as-is — a safe link, never a broken embed).
    const assistantText =
      this.relayClient && ev?.type === "timeline" && ev.item?.type === "assistant_message"
        ? ev.item.text
        : undefined;
    if (typeof assistantText !== "string") {
      this.emitAgentStream(agentId, binding, streamEvent);
      return;
    }

    // A token fully inside THIS delta → upload + rewrite + emit (live render). The
    // await here delays the NEXT chained event, preserving order.
    const inDelta = prepareAgentImageUploads(assistantText, {
      ...this.imageUploadOpts,
      onError: (p, err) => this.logImageReadError(p, err),
    }).filter((u) => !this.uploadedImagePaths.has(u.path));
    if (inDelta.length > 0) {
      for (const u of inDelta) this.uploadedImagePaths.add(u.path);
      await this.uploadAndEmitImages(agentId, binding, streamEvent, assistantText, inDelta);
      return;
    }

    // Emit this delta immediately (in order), then detect tokens SPLIT across
    // deltas on the accumulated text and upload them in the BACKGROUND — the delta
    // already went out; the fetch-time rewrite covers the eventual render.
    this.emitAgentStream(agentId, binding, streamEvent);
    const msgId = ev.item?.messageId;
    if (!msgId) return;
    const accumulated = (this.assistantTextAccum.get(msgId) ?? "") + assistantText;
    this.assistantTextAccum.set(msgId, accumulated);
    const split = prepareAgentImageUploads(accumulated, {
      ...this.imageUploadOpts,
      onError: (p, err) => this.logImageReadError(p, err),
    }).filter((u) => !this.uploadedImagePaths.has(u.path));
    if (split.length === 0) return;
    for (const u of split) this.uploadedImagePaths.add(u.path);
    void this.uploadSplitImages(agentId, split);
  }

  private logImageReadError(p: string, err: unknown): void {
    this.logger?.warn(
      { err: err instanceof Error ? err.message : err, path: p },
      "Failed to read agent-generated image file — leaving markdown token as-is",
    );
  }

  // Upload one image to S3 via the relay; record the local→S3 map and rewrite the
  // durable row. Returns the S3 URL (or null on failure). A durable rewrite that
  // touches 0 rows means the timeline row isn't committed yet — queued for a retry
  // at turn end.
  private async uploadImageToS3(
    agentId: string,
    u: ReturnType<typeof prepareAgentImageUploads>[number],
  ): Promise<string | null> {
    try {
      const resp = await this.relayClient?.uploadImage({
        dataBase64: u.dataBase64,
        mimeType: u.mimeType,
        filename: u.filename,
      });
      if (!resp?.ok || !resp.url) return null;
      recordAgentImageUrl(u.path, resp.url);
      try {
        const changed = this.timelineStore?.rewriteImageUrl(agentId, u.path, resp.url) ?? 0;
        if (changed === 0)
          this.pendingDurableRewrites.push({ agentId, path: u.path, url: resp.url });
      } catch (err) {
        this.logger?.warn({ err, agentId }, "Failed to rewrite durable image token");
      }
      return resp.url;
    } catch (err) {
      this.logger?.warn({ err, agentId }, "Agent image upload failed — leaving token as-is");
      this.uploadedImagePaths.delete(u.path); // allow a retry on a later delta/turn
      return null;
    }
  }

  private async uploadAndEmitImages(
    agentId: string,
    binding: StoredAgentBinding,
    streamEvent: Record<string, unknown>,
    originalText: string,
    uploads: ReturnType<typeof prepareAgentImageUploads>,
  ): Promise<void> {
    let text = originalText;
    for (const u of uploads) {
      const url = await this.uploadImageToS3(agentId, u);
      // Swap the local PATH for the S3 URL inside the markdown token, keeping the
      // `![alt](...)` wrapper so the renderer embeds it inline.
      if (url) text = text.split(u.token).join(`![${u.alt}](${url})`);
    }
    const ev = streamEvent as { item?: Record<string, unknown> };
    const rewritten = { ...streamEvent, item: { ...ev.item, text } };
    this.emitAgentStream(agentId, binding, rewritten);
  }

  private async uploadSplitImages(
    agentId: string,
    uploads: ReturnType<typeof prepareAgentImageUploads>,
  ): Promise<void> {
    for (const u of uploads) await this.uploadImageToS3(agentId, u);
  }

  // At turn end the AgentManager timeline rows are committed, so retry any durable
  // rewrites that found 0 rows mid-stream (the upload raced the row write). Also
  // drop this turn's accumulated assistant text.
  private finalizeTurnImages(): void {
    const pending = this.pendingDurableRewrites;
    this.pendingDurableRewrites = [];
    for (const r of pending) {
      try {
        this.timelineStore?.rewriteImageUrl(r.agentId, r.path, r.url);
      } catch (err) {
        this.logger?.warn({ err, agentId: r.agentId }, "Durable image rewrite retry failed");
      }
    }
    this.assistantTextAccum.clear();
  }

  // Build + broadcast the cyborg:agent_status for an agent lifecycle change. Extracted
  // from the agent-event subscriber to keep that hot callback under the complexity
  // budget. Scopes the status the SAME way emitAgentStream scopes the stream: a DM
  // turn's progress/error reaches ONLY the DM recipient (channelId null + their email),
  // and an AUTONOMOUS turn never broadcasts into its bound channel — without consulting
  // the DM-turn guard here, a private DM's "running"/error blip leaked to the channel.
  private emitAgentStatus(
    binding: StoredAgentBinding,
    agent: {
      id: string;
      lifecycle: "running" | "idle" | "error" | string;
      lastError?: string | null;
    },
  ): void {
    let status: "idle" | "running" | "error" = "idle";
    if (agent.lifecycle === "running") status = "running";
    else if (agent.lifecycle === "error") status = "error";

    const dmEmail = this.dmTurnRecipientEmail(agent.id);
    const autonomous = binding.autonomous === 1;
    this.broadcast.toWorkspace(binding.workspace_id, {
      type: "cyborg:agent_status",
      payload: {
        agentId: agent.id,
        workspaceId: binding.workspace_id,
        channelId: dmEmail || autonomous ? null : binding.channel_id,
        status,
        // Session-history identity for the Home "This week" stats. The relay
        // is the only PG-connected component (solo daemons have no RDS
        // access), so it records agent_sessions off this forwarded status —
        // these fields are what it needs to build the row. Daemon-side
        // recordAgentSessionStart stays for the connected-daemon case.
        provider: binding.provider,
        cyboId: binding.cybo_id,
        cwd: binding.cwd,
        userId: binding.initiated_by,
        // Carry the initiator's email so the relay can resolve the
        // daemon-local userId to the global PG account id before writing.
        userEmail: this.initiatorEmail(binding),
        sessionType: binding.cybo_id ? "cybo" : "session",
        // Surface WHAT failed alongside the error status — without it the
        // client can only show a bare red badge.
        ...(status === "error" && agent.lastError ? { error: agent.lastError } : {}),
        privateToEmail: dmEmail ?? this.privateAgentEmail(binding),
        autonomous,
      },
    });
  }

  private emitAgentStream(
    agentId: string,
    binding: StoredAgentBinding,
    streamEvent: Record<string, unknown>,
  ): void {
    // Carry the cybo identity so the relay's flush persists the reply with the
    // cybo NAME (not the raw agent UUID) — see flushPendingAgentMessage.
    const cyboId = binding.cybo_id ?? null;
    const cyboName = cyboId ? (this.storage.getCybo(cyboId)?.name ?? null) : null;
    // DM-turn override: while this cybo is mid-DM-turn its binding may be a
    // persistent CHANNEL binding (a scheduled cybo lives in #general), so the
    // stream would otherwise tell the relay to flush the reply into that channel.
    // Steer the relay's flush to the DM instead — channelId:null routes
    // broadcastAgentReply down its privateToEmail (dm_broadcast) path. Falls back
    // to the binding's private email for a genuine DM agent / non-DM turn.
    const dmEmail = this.dmTurnRecipientEmail(agentId);
    // An AUTONOMOUS (cron/scheduled) turn must NOT auto-flush its narration into the
    // bound channel. Its running commentary ("I'll send you a private DM. Let me load
    // the messaging tool first.") would otherwise become a channel post even when the
    // prompt said to reply privately. Null the channel (like the DM guard) and tag the
    // payload `autonomous` so the relay accumulator DROPS the prose instead of
    // persisting it — an autonomous cybo reaches a channel/DM ONLY via an explicit
    // cyborg7_send_message tool call (which routes through handleAgentMessage, not this
    // accumulator). A DM turn already nulls the channel via dmEmail.
    const autonomous = binding.autonomous === 1;
    this.broadcast.toWorkspace(binding.workspace_id, {
      type: "cyborg:agent_stream",
      payload: {
        agentId,
        workspaceId: binding.workspace_id,
        channelId: dmEmail || autonomous ? null : binding.channel_id,
        cyboId,
        cyboName,
        event: streamEvent,
        privateToEmail: dmEmail ?? this.privateAgentEmail(binding),
        autonomous,
      },
    });
  }

  // Record the routed (framed) + raw prompt on the ephemeral session-context
  // capture (#994). Extracted from routeToAgent to keep its complexity in budget.
  // No-op for non-ephemeral agents (they never get a capture row); best-effort.
  private captureRoutedPrompt(
    binding: StoredAgentBinding,
    agentId: string,
    prompt: AgentPromptInput,
    rawPrompt: string | undefined,
  ): void {
    if (!binding.ephemeral) return;
    try {
      this.storage.updateEphemeralSessionContextPrompts(
        agentId,
        stringifyPromptForCapture(prompt),
        rawPrompt ?? null,
      );
    } catch {
      // Non-fatal — the viewer just won't show the routed prompt.
    }
  }

  // Close an ephemeral summon's underlying agent and drop its workspace binding
  // so it no longer appears as an available agent. Best-effort and idempotent.
  private async teardownEphemeralAgent(agentId: string): Promise<void> {
    if (this.tearingDown.has(agentId)) return;
    this.tearingDown.add(agentId);
    try {
      if (this.agentManager?.getAgent(agentId)) {
        await this.agentManager.closeAgent(agentId);
      }
    } catch (err) {
      this.logger?.warn(
        { agentId, err: err instanceof Error ? err.message : err },
        "Failed to close ephemeral agent",
      );
    } finally {
      this.storage.archiveAgentSessionRow(agentId);
      this.storage.deleteAgentBinding(agentId);
      // NOTE (#994): we deliberately do NOT delete ephemeral_session_context here.
      // That capture row is the only post-teardown record of the injected context
      // (system prompt + tools + routed prompt) for the read-only viewer; it's
      // bounded by the TTL/GC sweep instead. Dropping the binding is enough to
      // hide the session from the live agent list.
      this.tearingDown.delete(agentId);
    }
  }

  setAgentStorage(agentStorage: AgentStorage, logger: Logger): void {
    this.agentStorage = agentStorage;
    this.logger = logger;
  }

  setRelayClient(client: DaemonRelayClient | null): void {
    this.relayClient = client;
  }

  setTimelineStore(
    store: { rewriteImageUrl(agentId: string, from: string, to: string): number } | null,
  ): void {
    this.timelineStore = store;
  }

  setServerId(id: string): void {
    this.serverId = id;
  }

  setCyborg7McpBaseUrl(url: string | null): void {
    this.cyborg7McpBaseUrl = url;
  }

  // @-mention → invoke a cybo MEMBER. When a HUMAN posts a message that mentions
  // a cybo which is a member of the channel, spawn that cybo (ephemeral, bound to
  // the channel) and route the mentioning message + brief recent context to it;
  // it responds in-channel (and can use the cyborg7 read/react/search tools).
  //
  // LOOP PREVENTION: this is topologically called only from the HUMAN post path
  // (handleChannelMessage); cybo/agent posts go through handleAgentMessage and
  // never reach here, so a cybo can't trigger another cybo. We ALSO code-enforce
  // it with the explicit human-author guard below (authorType !== "human" →
  // return), mirroring the relay path (cybo-mention-invoke.ts) — so the anti-loop
  // invariant survives a future caller that isn't the human path, instead of
  // resting on a topological accident.
  // One invocation per (messageId, cyboId), exactly once ACROSS DAEMONS: the
  // in-process guard is a cheap first-line; the shared atomic claim (#16, twin of
  // the cron claimScheduleDispatch) is the cross-daemon authority — it survives a
  // relay reconnect/replay or a worker restart that cleared the in-process Set. No
  // messageId (legacy sender) can't be deduped → allow the invoke.
  private async claimMentionInvocationSlot(
    messageId: string | undefined,
    cyboId: string,
  ): Promise<boolean> {
    if (!mentionInvocationGuard.shouldInvoke(messageId, cyboId)) return false;
    if (
      messageId &&
      !(await this.storage.claimInvocationDispatch(
        mentionClaimKey(messageId, cyboId),
        this.serverId,
      ))
    ) {
      return false;
    }
    return true;
  }

  private async invokeMentionedCybos(
    channel: { id: string; name: string; workspace_id: string },
    auth: CyborgAuthContext,
    msg: CyborgChannelMessage,
    currentMessageId: string | undefined,
    // The FINAL post text (#602: a template send is expanded before persist; an
    // ordinary send passes msg.text). Used for the cybo prompt so the agent sees
    // exactly what landed in the channel, not the un-expanded "{channel}" body.
    expandedText: string,
    // The persisted author type ("human" | "agent") of the post that triggered
    // this. Only a HUMAN post may invoke a cybo — see the firewall guard below.
    authorType: string,
  ): Promise<void> {
    // Firewall (code-enforced anti-loop invariant): a non-human post NEVER
    // invokes a mentioned cybo. Without this the guard is purely topological.
    if (authorType !== "human") return;
    if (!msg.mentions || msg.mentions.length === 0) return;
    if (!this.agentManager) return;
    const pg = this.storage.pg;
    if (!pg) return; // cybo channel membership lives in shared PG

    let cyboMemberIds: string[];
    try {
      cyboMemberIds = await pg.getChannelCyboMembers(channel.id);
    } catch {
      return;
    }
    if (cyboMemberIds.length === 0) return;

    const cybos = this.storage.getCybos(channel.workspace_id);
    const { invoke: toInvoke, unresolvableMembers } = resolveMentionedCybos(
      msg.mentions,
      cyboMemberIds,
      cybos,
    );
    // #637: a channel member absent from THIS workspace's roster is a
    // cross-workspace cybo — its owner daemon is in another workspace, so it
    // can't run here. Previously this fell through silently (no notice, no
    // invoke). Surface an author-only ephemeral notice instead, mirroring the
    // relay path's cyborg:cybo_mention_notice. The notice is generic (it doesn't
    // name a specific cybo), so mentioning several cross-workspace cybos in one
    // message posts exactly ONE notice, not N identical copies.
    if (unresolvableMembers.length > 0) {
      this.broadcast.toUser(auth.user.id, {
        type: "cyborg:cybo_mention_notice",
        payload: {
          toUserId: auth.user.id,
          workspaceId: channel.workspace_id,
          channelId: channel.id,
          text:
            `That cybo belongs to another workspace and can't run in #${channel.name}. ` +
            `Create or add a cybo that lives in this workspace to invoke it here.`,
        },
      });
    }
    if (toInvoke.length === 0) return;

    // Context enrichment (best-effort, mirrors the relay path — ONE prompt
    // builder for both modes): workspace name, channel topic, participant
    // roster, and a transcript whose names resolve against the roster when a
    // legacy row lacks from_name.
    const workspaceName = this.storage.getWorkspace(channel.workspace_id)?.name ?? null;
    const channelDescription = this.storage.getChannel(channel.id)?.description ?? null;
    const humanMembers = await pg.getChannelMembers(channel.id).catch((err) => {
      this.logger?.warn(
        { err, channelId: channel.id },
        "message-router: getChannelMembers failed — cybo prompt roster will be incomplete",
      );
      return [];
    });
    const author = auth.user.name ?? auth.user.email;
    const { namesById, participants } = buildMentionRosterContext({
      cybos,
      cyboMemberIds,
      humanMembers,
      author: { id: auth.user.id, name: author },
    });

    const recent = await pg.getMessages({ channelId: channel.id, limit: 15 }).catch((err) => {
      this.logger?.warn(
        { err, channelId: channel.id },
        "message-router: getMessages failed — cybo prompt transcript will be empty",
      );
      return [];
    });
    // The mentioning message is already persisted — exclude it so it isn't
    // duplicated (it's appended explicitly as the prompt below).
    const transcript = formatMentionTranscript(recent, {
      excludeMessageId: currentMessageId,
      namesById,
    });
    const prompt = buildMentionPrompt({
      channelName: channel.name,
      channelDescription,
      workspaceName,
      participants,
      transcript,
      author,
      text: expandedText,
    });

    // Fan-out cap: a single message may summon at most MAX_MENTION_FANOUT cybos
    // (mirrors the relay path). Beyond that we spawn the first N and tell the
    // author, instead of firing an unbounded set of concurrent spawns.
    const capped = toInvoke.slice(0, MAX_MENTION_FANOUT);
    if (toInvoke.length > capped.length) {
      this.notifyMentionThrottled(
        channel,
        auth.user.id,
        `Only the first ${MAX_MENTION_FANOUT} mentioned cybos were invoked in #${channel.name} — mention fewer at once.`,
      );
    }

    for (const cyboId of capped) {
      // One invocation per (messageId, cyboId), exactly once across the fleet:
      // in-process guard (cheap) + shared atomic DB claim (#16). Extracted to a
      // helper so this loop stays under the lint complexity cap.
      if (!(await this.claimMentionInvocationSlot(currentMessageId, cyboId))) continue;
      // Per-workspace spawn rate-limit (agent_spawn bucket): a mention storm
      // can't outrun the workspace's spawn budget. Over budget → notice + stop.
      if (!this.mentionRateLimiter.check(channel.workspace_id, "agent_spawn").allowed) {
        this.notifyMentionThrottled(
          channel,
          auth.user.id,
          `Cybos are being summoned too often in #${channel.name} right now — wait a moment and try again.`,
        );
        break;
      }
      await this.spawnMentionedCybo({ cyboId, channel, auth, prompt, expandedText });
    }
  }

  // Per-cybo mention spawn: ephemeral, channel-bound, prompt routed. Extracted
  // from invokeMentionedCybos so the cap/rate-limit loop stays simple (oxlint
  // complexity) and the spawn shape mirrors runWatcherFailover.
  private async spawnMentionedCybo(opts: {
    cyboId: string;
    channel: { id: string; name: string; workspace_id: string };
    auth: CyborgAuthContext;
    prompt: string;
    expandedText: string;
  }): Promise<void> {
    const { cyboId, channel, auth, prompt, expandedText } = opts;
    if (!this.agentManager) return;
    try {
      // cyboId is already a workspace-scoped member id (resolved against this
      // channel's cybo members), so pass it directly — no slug ambiguity.
      const result = await spawnCybo({
        storage: this.storage,
        agentManager: this.agentManager,
        workspaceId: channel.workspace_id,
        cyboIdOrSlug: cyboId,
        userId: auth.user.id,
        serverId: this.serverId ?? undefined,
        cyborg7McpBaseUrl: this.cyborg7McpBaseUrl ?? undefined,
        ephemeral: true,
        context: { channelId: channel.id, channelName: channel.name },
        credentialStore: this.credentialStore,
        composio: this.composio,
        logger: this.logger ?? undefined,
        auditSink: this.auditSink,
      });
      void this.routeToAgent(result.agentId, prompt, { rawPrompt: expandedText });
    } catch (err) {
      this.reportCyboSpawnFailure(cyboId, err, channel, auth.user.id);
    }
  }

  // Author-only ephemeral notice when the mention spawn is capped or throttled
  // (same channel/payload shape as the cross-workspace notice above).
  private notifyMentionThrottled(
    channel: { id: string; name: string; workspace_id: string },
    userId: string,
    text: string,
  ): void {
    this.broadcast.toUser(userId, {
      type: "cyborg:cybo_mention_notice",
      payload: { toUserId: userId, workspaceId: channel.workspace_id, channelId: channel.id, text },
    });
  }

  // Tasks Phase 2 — channel watcher (local/connected-daemon path). Sibling of
  // invokeMentionedCybos: when a HUMAN posts an UN-mentioned message in a channel
  // with auto_tasks_enabled, hand the message + recent transcript + open tasks +
  // roster to the FIRST cybo in the channel's watcher fallback chain so it can
  // create / assign / UPDATE a task (or stay silent). Mirrors the mention path's
  // spawn(ephemeral) + routeToAgent + teardown shape; the gates and the prompt
  // differ.
  //
  // LOOP PREVENTION (same as invokeMentionedCybos): topologically called only
  // from the HUMAN post path (handleChannelMessage). Cybo/agent posts go through
  // handleAgentMessage and never reach here, so the watcher's own create_task /
  // update_task / reply can't re-trigger the watcher. We ALSO code-enforce it
  // with the explicit human-author guard below (authorType !== "human" → return),
  // mirroring the relay path — so watch→act→watch can't re-open even if a future
  // caller isn't the human path. FAILOVER not fan-out: exactly ONE cybo (the
  // first in the chain that spawns) handles the message.
  //
  // Gate order is cheap → expensive (the costly chain/task reads run only if the
  // cheap gates pass): human author → auto_tasks_enabled → per-channel rate limit
  // → chain non-empty → prefilter → pick/failover.
  private async invokeChannelWatchers(
    channel: { id: string; name: string; workspace_id: string },
    auth: CyborgAuthContext,
    _msg: CyborgChannelMessage,
    currentMessageId: string | undefined,
    text: string,
    // The persisted author type ("human" | "agent") of the post that triggered
    // this. Only a HUMAN post may wake the watcher — see the firewall guard below.
    authorType: string,
  ): Promise<void> {
    // Firewall (code-enforced anti-cascade invariant): a non-human post NEVER
    // wakes the watcher. Without this the guard is purely topological.
    if (authorType !== "human") return;
    if (!this.agentManager) return;
    const pg = this.storage.pg;
    if (!pg) return; // watcher channel membership + auto-tasks switch live in PG

    // Cheapest gate FIRST: the per-workspace autonomy master switch (DEFAULT ON).
    // When a workspace turns autonomy OFF, no UN-mentioned channel watcher fires.
    // @-mentions are UNAFFECTED — this gate is only on the watcher path, never on
    // invokeMentionedCybos. Read LIVE from PG; a read failure fails closed (return).
    let autonomyOn: boolean;
    try {
      autonomyOn = await pg.getWorkspaceAutonomyEnabled(channel.workspace_id);
    } catch {
      return;
    }
    if (!autonomyOn) return;

    // Self-guard / anti-cascade: HUMAN-only is now enforced by the authorType
    // firewall at the top of this method (return on non-human), matching the
    // relay path's explicit authorType === "human" check. The topological fact
    // (only handleChannelMessage calls this; the watcher's own task ops flow
    // through handleAgentMessage) is the second layer, not the only one.

    // Cheap gate 1: opt-in switch. Read SQLite mirror first (sync, local); the
    // relay path reads PG. NULL/0 → OFF.
    let autoTasks: boolean;
    try {
      autoTasks = await pg.getChannelAutoTasksEnabled(channel.id);
    } catch {
      return;
    }
    // auto-tasks-off is the steady state for most channels and would log on every
    // post — intentionally NOT surfaced (would flood the Logs pane). The remaining
    // skip reasons below are bounded (rate-limit ≤1/20s, or only reached for
    // auto-tasks-ON channels) so they're safe to broadcast.
    if (!autoTasks) return;

    // Cheap gate 2: per-channel watcher debounce (≤1 watch turn / 20s / channel).
    if (!this.watcherRateLimiter.check(channel.id, "agent_watch").allowed) {
      this.broadcastTaskEvent({
        kind: "watcher_skipped",
        workspaceId: channel.workspace_id,
        channelId: channel.id,
        channelName: channel.name,
        reason: "rate_limited",
      });
      return;
    }

    // One watcher spawn per message — namespace "watch:<messageId>", DISTINCT
    // from the mention guard, shared with the dispatcher's relay-forwarded path.
    if (!watchInvocationGuard.shouldWatch(currentMessageId)) return;
    // Cross-daemon exactly-once (#16): shared atomic claim so the same message can't
    // spawn the watcher on two daemons — or across a reconnect/restart that cleared
    // the in-process Set. No messageId (legacy sender) → can't claim, fall through.
    if (
      currentMessageId &&
      !(await this.storage.claimInvocationDispatch(watchClaimKey(currentMessageId), this.serverId))
    ) {
      return;
    }

    // Watcher is past the cheap gates and is now actually evaluating this post.
    this.broadcastTaskEvent({
      kind: "watcher_fired",
      workspaceId: channel.workspace_id,
      channelId: channel.id,
      channelName: channel.name,
      author: auth.user.name ?? auth.user.email,
    });

    let chain: string[];
    try {
      chain = await pg.getChannelCyboMembers(channel.id);
    } catch {
      this.broadcastTaskEvent({
        kind: "watcher_skipped",
        workspaceId: channel.workspace_id,
        channelId: channel.id,
        channelName: channel.name,
        reason: "lookup_failed",
      });
      return;
    }
    if (chain.length === 0) {
      this.broadcastTaskEvent({
        kind: "watcher_skipped",
        workspaceId: channel.workspace_id,
        channelId: channel.id,
        channelName: channel.name,
        reason: "no_cybo_members",
      });
      return;
    }

    // Open tasks for this workspace (the create-vs-update idempotency lever) — also
    // feeds the prefilter's hasOpenTasks short-circuit.
    let openTasksRaw: Array<{
      id: string;
      title: string;
      status: string;
      assignee_id: string | null;
      channel_id?: string | null;
    }>;
    try {
      openTasksRaw = await pg.getTasks(channel.workspace_id);
    } catch {
      openTasksRaw = [];
    }
    const channelOpenTasks = openTasksRaw.filter(
      (t) =>
        t.status !== "done" &&
        t.status !== "cancelled" &&
        (!t.channel_id || t.channel_id === channel.id),
    );

    // Prefilter: shed obviously-nothing chatter before the spawn. hasOpenTasks
    // short-circuits true (a "done"/"blocked" could be about any of them).
    if (!shouldConsiderWatch({ text, hasOpenTasks: channelOpenTasks.length > 0 })) {
      this.broadcastTaskEvent({
        kind: "watcher_skipped",
        workspaceId: channel.workspace_id,
        channelId: channel.id,
        channelName: channel.name,
        reason: "nothing_actionable",
      });
      return;
    }

    const cybos = this.storage.getCybos(channel.workspace_id);
    const cyboById = new Map(cybos.map((c) => [c.id, c]));

    // Context enrichment (best-effort, mirrors invokeMentionedCybos).
    const humanMembers = await pg.getChannelMembers(channel.id).catch((err) => {
      this.logger?.debug(
        { err, channelId: channel.id },
        "[channel-watch] member context fetch failed",
      );
      return [];
    });
    const author = auth.user.name ?? auth.user.email;
    // Only the name map is needed here (transcript + assignee resolution); the
    // watcher prompt uses `roster` (which carries ids), not the participant list.
    const { namesById } = buildMentionRosterContext({
      cybos,
      cyboMemberIds: chain,
      humanMembers,
      author: { id: auth.user.id, name: author },
    });
    const recent = await pg.getMessages({ channelId: channel.id, limit: 15 }).catch((err) => {
      this.logger?.debug({ err, channelId: channel.id }, "[channel-watch] transcript fetch failed");
      return [];
    });
    const transcript = formatMentionTranscript(recent, {
      excludeMessageId: currentMessageId,
      namesById,
    });
    const cyboNameById = new Map(cybos.map((c) => [c.id, c.name]));
    const roster: string[] = [
      ...humanMembers.map((h) => `${h.name ?? h.email} (human, id ${h.userId})`),
      ...chain
        .map((id) => {
          const name = cyboNameById.get(id);
          return name ? `${name} (cybo, id ${id})` : null;
        })
        .filter((r): r is string => r !== null),
    ];
    const openTasks: WatcherOpenTask[] = channelOpenTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignee: t.assignee_id ? (namesById.get(t.assignee_id) ?? t.assignee_id) : null,
    }));
    const prompt = buildWatcherPrompt({
      channelName: channel.name,
      transcript,
      author,
      text,
      openTasks,
      roster,
    });

    await this.runWatcherFailover({ channel, auth, chain, cyboById, prompt, text });
  }

  // FAILOVER not fan-out: spawn the FIRST chain cybo this daemon can run, route the
  // watcher prompt to it, and stop. A cybo absent from this daemon's roster is
  // skipped; a spawn failure advances to the next chain cybo. Each outcome emits a
  // structured task_event (selected / spawn-failed) for the Logs tab. Extracted
  // from invokeChannelWatchers to keep that method's branch complexity in check.
  private async runWatcherFailover(opts: {
    channel: { id: string; name: string; workspace_id: string };
    auth: CyborgAuthContext;
    chain: string[];
    cyboById: Map<string, { name: string }>;
    prompt: string;
    text: string;
  }): Promise<void> {
    const { channel, auth, chain, cyboById, prompt, text } = opts;
    const agentManager = this.agentManager;
    if (!agentManager) return;
    // Ordered first-viable failover (see chain-router.ts): spawn the first chain
    // cybo this daemon can run and stop. A cybo absent from this daemon's roster
    // is a SKIP (silent); a spawn failure is a FAIL (logged + task_event), both
    // advancing. The first successful spawn routes the prompt and ends the walk.
    await runFallbackChain<string, void>(chain, async (cyboId, i) => {
      const cybo = cyboById.get(cyboId);
      if (!cybo) return { outcome: "skip" };
      const cyboName = cybo.name;
      try {
        const result = await spawnCybo({
          storage: this.storage,
          agentManager,
          workspaceId: channel.workspace_id,
          cyboIdOrSlug: cyboId,
          userId: auth.user.id,
          serverId: this.serverId ?? undefined,
          cyborg7McpBaseUrl: this.cyborg7McpBaseUrl ?? undefined,
          ephemeral: true,
          context: { channelId: channel.id, channelName: channel.name },
          credentialStore: this.credentialStore,
          composio: this.composio,
          logger: this.logger ?? undefined,
        });
        this.broadcastTaskEvent({
          kind: "watcher_selected",
          workspaceId: channel.workspace_id,
          channelId: channel.id,
          cyboId,
          channelName: channel.name,
          cyboName,
          chainPosition: i + 1,
          chainLength: chain.length,
        });
        void this.routeToAgent(result.agentId, prompt, { rawPrompt: text }).catch((err) =>
          this.logger?.warn({ err, channelId: channel.id }, "[channel-watch] route to cybo failed"),
        );
        return { outcome: "success", result: undefined }; // handled — failover stops at the first successful spawn
      } catch (err) {
        this.logger?.warn(
          { err, cyboId, channelId: channel.id },
          "[channel-watch] spawn failed — advancing to next chain cybo",
        );
        this.broadcastTaskEvent({
          kind: "watcher_spawn_failed",
          workspaceId: channel.workspace_id,
          channelId: channel.id,
          cyboId,
          channelName: channel.name,
          cyboName,
          detail: err instanceof Error ? err.message : String(err),
        });
        return { outcome: "fail" }; // try the next cybo in the chain
      }
    });
  }

  // #745: a cybo spawn failure used to be LOCAL-only (logger.warn → daemon.log on
  // the user's machine, invisible centrally) AND silent to the author (the cybo
  // just never replied). Now we ALSO: (a) emit central telemetry over the relay WS
  // (→ /cyborg7/relay), and (b) tell the author in the channel why it didn't run.
  private reportCyboSpawnFailure(
    cyboId: string,
    err: unknown,
    channel: { id: string; workspace_id: string },
    authorUserId: string,
  ): void {
    this.logger?.warn({ err, cyboId }, "Failed to invoke @-mentioned cybo");
    // This runs FROM the spawn catch, so it must never throw itself — a failure to
    // read the cybo / send telemetry / broadcast the notice must not escalate past
    // the already-failed spawn. Best-effort, fully guarded.
    try {
      const cybo = this.storage.getCybo(cyboId);
      const outcome = buildCyboSpawnFailureOutcome({
        err,
        cyboId,
        cyboSlug: cybo?.slug ?? null,
        provider: cybo?.provider ?? null,
        channelId: channel.id,
        workspaceId: channel.workspace_id,
        authorUserId,
        at: Date.now(),
      });
      this.relayClient?.sendTelemetry(outcome.telemetry);
      this.broadcast.toUser(authorUserId, outcome.notice);
    } catch (reportErr) {
      this.logger?.warn({ err: reportErr, cyboId }, "cybo spawn-failure reporting failed");
    }
  }

  // ─── Agent routing ────────────────────────────────────────────────

  // oxlint-disable-next-line eslint/complexity -- multi-step routing with lazy-restore + relay fallback
  async routeToAgent(
    agentId: string,
    // #579: a prompt may be a plain string OR structured content blocks (text +
    // image vision blocks). streamAgent already accepts AgentPromptInput; the
    // relay-forward branch serializes the blocks as JSON to the owning daemon.
    prompt: AgentPromptInput,
    opts?: { rawPrompt?: string },
  ): Promise<void> {
    if (!this.agentManager) {
      const binding = this.storage.getAgentBinding(agentId);
      if (binding) {
        this.forwardStreamEvent(agentId, binding, {
          type: "turn_failed",
          provider: "unknown",
          error: "Agent manager not initialized",
        });
      }
      return;
    }

    const binding = this.storage.getAgentBinding(agentId);
    if (!binding) return;

    let localAgent = this.agentManager.getAgent(agentId);

    if (!localAgent && this.agentStorage && this.logger) {
      const isLocalBinding = !binding.daemon_id || binding.daemon_id === this.serverId;
      if (isLocalBinding) {
        try {
          const { ensureAgentLoaded } = await import("../agent/agent-loading.js");
          const restored = await ensureAgentLoaded(agentId, {
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.logger,
          });
          localAgent = restored;
          this.logger.info(
            { agentId, provider: restored.provider },
            "Cyborg agent lazy-restored from persistence",
          );
        } catch (err) {
          this.logger.warn(
            { agentId, err: err instanceof Error ? err.message : err },
            "Failed to lazy-restore agent",
          );
          this.forwardStreamEvent(agentId, binding, {
            type: "turn_failed",
            provider: binding.provider ?? "unknown",
            error: `Failed to restore agent: ${err instanceof Error ? err.message : "unknown error"}`,
          });
          return;
        }
      }
    }

    if (localAgent) {
      if (opts?.rawPrompt) {
        try {
          await this.agentManager.appendTimelineItem(agentId, {
            type: "user_message",
            text: opts.rawPrompt,
          });
        } catch {
          // Non-fatal — user message won't appear in timeline on reload
        }
      }
      // Thread the routed (framed) + raw prompt into the ephemeral context
      // capture (#994). No-op for non-ephemeral agents (no capture row).
      this.captureRoutedPrompt(binding, agentId, prompt, opts?.rawPrompt);
      let events: AsyncGenerator<AgentStreamEvent>;
      try {
        events = this.agentManager.streamAgent(agentId, prompt);
      } catch (err) {
        // streamAgent rejects synchronously (e.g. "already has an active run")
        // BEFORE any turn exists, so AgentManager never dispatches turn_failed
        // for it — without feedback here the prompt vanishes silently while the
        // user's message is already persisted in the chat. Surface it.
        const message = err instanceof Error ? err.message : "Failed to start agent run";
        this.logger?.warn({ agentId, err: message }, "Agent run rejected before turn start");
        this.forwardStreamEvent(agentId, binding, {
          type: "turn_failed",
          provider: binding.provider ?? "unknown",
          error: message.includes("already has an active run")
            ? "Agent is busy with another run — stop the current run or wait for it to finish."
            : message,
        });
        return;
      }
      // Ephemeral CHANNEL summons (@-mention) are invisible sessions: their stream
      // is never broadcast, and their harness (opencode/pi) may not load the
      // cyborg7_send_message tool — so the cybo would "answer" into the void. This
      // drain is the one place that reliably sees the turn's assistant text (the
      // agent-event subscriber does NOT fire for these), so accumulate it and post
      // it to the channel below — unless the cybo already delivered via the tool.
      const ephemeralBridge = Boolean(binding.ephemeral && binding.channel_id);
      // While an @-mentioned cybo's turn runs, show a channel "typing" indicator
      // (e.g. "Apex is typing…") so the mention doesn't look unanswered. Driven by
      // the turn's own stream events (turn_started/timeline), so it's
      // PROVIDER-AGNOSTIC — claude, codex and opencode/pi all emit them. Re-emitted
      // (throttled) to outlast the client's typing TTL; cleared when the reply
      // posts (clients drop typing on a message from that sender) or by TTL.
      const cyboId = ephemeralBridge ? (binding.cybo_id ?? null) : null;
      const cyboName = cyboId ? (this.storage.getCybo(cyboId)?.name ?? null) : null;
      const emitThinking = (): void => {
        if (!cyboId || !cyboName || !binding.channel_id) return;
        this.broadcast.toWorkspace(binding.workspace_id, {
          type: "cyborg:typing_broadcast",
          payload: {
            workspaceId: binding.workspace_id,
            channelId: binding.channel_id,
            fromId: cyboId,
            fromName: cyboName,
          },
        });
      };
      let lastThinkAt = 0;
      let ephemeralReply = "";
      // Watchdog: an ephemeral channel summon (@-mention / /ask) has NO other
      // completion path — both the reply post and the agent teardown below hinge
      // on this drain seeing a terminal event (turn_completed/failed/canceled).
      // If the provider turn STALLS — e.g. the cybo's `cyborg7_send_message` MCP
      // round-trip never resolves, an auth refresh wedges, or the model hangs —
      // the `for await` blocks FOREVER: no reply reaches the channel, no error
      // surfaces, and the agent + its subprocess leak (the 10+ min "mention never
      // answers" hang). Cancel the run after a bound so a terminal event fires and
      // the drain unwinds — accumulated text (if any) still posts, then teardown.
      // Non-ephemeral turns (interactive chat) are unbounded as before.
      let timedOut = false;
      // internal docs FIX 5: capture a terminal turn_failed so the drain can post a
      // classified channel notice instead of swallowing the failure. `interrupted`
      // marks the stream throwing / the daemon dropping mid-turn with no verdict.
      let failedEvent: Record<string, unknown> | null = null;
      let interrupted = false;
      // A clean turn_completed with no deliverable text means the cybo CHOSE not to
      // post (e.g. it only reacted) — that is NOT a failure, so suppress the notice.
      let completedCleanly = false;
      const watchdog =
        ephemeralBridge && binding.ephemeral
          ? setTimeout(() => {
              timedOut = true;
              this.logger?.warn(
                { agentId, ms: EPHEMERAL_TURN_TIMEOUT_MS },
                "Ephemeral mention turn exceeded timeout — canceling to unwind drain",
              );
              // intentional: best-effort fire-and-forget cancel on watchdog timeout (turn already unwinding).
              void this.agentManager?.cancelAgentRun(agentId).catch(() => {});
            }, EPHEMERAL_TURN_TIMEOUT_MS)
          : null;
      try {
        for await (const _event of events) {
          const evType = (_event as { type?: string }).type;
          const isTurnEvent = evType === "turn_started" || evType === "timeline";
          if (cyboName && isTurnEvent && Date.now() - lastThinkAt > 3000) {
            emitThinking();
            lastThinkAt = Date.now();
          }
          if (
            ephemeralBridge &&
            evType === "timeline" &&
            (_event as { item?: { type?: string; text?: string } }).item?.type ===
              "assistant_message" &&
            typeof (_event as { item?: { text?: string } }).item?.text === "string"
          ) {
            ephemeralReply += (_event as { item: { text: string } }).item.text;
          }
          // Capture the terminal failure so the post-loop can classify it (FIX 5).
          // The LAST turn_failed wins (a turn emits at most one).
          if (ephemeralBridge && evType === "turn_failed") {
            failedEvent = _event as Record<string, unknown>;
          }
          if (ephemeralBridge && evType === "turn_completed") {
            completedCleanly = true;
          }
        }
      } catch (err) {
        // AgentManager dispatches turn_failed through its subscriber system,
        // which the session already forwards to the client. Only log here
        // to avoid sending a duplicate error event via broadcast. The stream
        // throwing (vs ending with turn_failed) means the turn was cut off with
        // no verdict — e.g. the daemon dropped mid-turn; mark it so the drain can
        // post a "daemon went offline" notice instead of silence (FIX 5).
        interrupted = true;
        this.logger?.warn(
          { agentId, err: err instanceof Error ? err.message : err },
          "Agent stream threw during message-router routing",
        );
      } finally {
        if (watchdog) clearTimeout(watchdog);
      }
      // A genuine reply (assistant text) was produced and not already posted via
      // the cyborg7_send_message tool — post it. Unaffected by FIX 5.
      const deliveredReply = Boolean(
        ephemeralBridge &&
        ephemeralReply.trim() &&
        !this.ephemeralPostedViaTool.has(agentId) &&
        binding.channel_id,
      );
      // The cybo delivered via the tool (claude/codex) — a real reply landed, so
      // no failure notice even if the turn later errored.
      const deliveredViaTool = this.ephemeralPostedViaTool.has(agentId);
      if (deliveredReply && binding.channel_id) {
        this.handleAgentMessage(
          agentId,
          binding.workspace_id,
          binding.channel_id,
          null,
          ephemeralReply.trim(),
        );
      } else if (
        ephemeralBridge &&
        !deliveredViaTool &&
        // A clean completion with no text and no failure signal = the cybo chose
        // not to reply — stay silent. Only surface a notice on an actual failure
        // (turn_failed / timeout / interruption) or an immediate empty exit.
        !(completedCleanly && !failedEvent && !timedOut && !interrupted) &&
        binding.channel_id
      ) {
        // internal docs FIX 5: the turn produced nothing deliverable (turn_failed,
        // auth error, immediate exit, timeout, or the daemon dropped mid-turn).
        // Classify it and post ONE concise, secret-free notice so the @-mention is
        // never a silent black hole. Same post path as a normal reply (attributed
        // to the cybo). One notice per mention — this branch runs once.
        const notice = classifyEphemeralFailureNotice({
          cyboName: cyboName ?? "",
          provider: binding.provider ?? null,
          failedEvent,
          timedOut,
          interrupted,
        });
        if (notice) {
          this.handleAgentMessage(agentId, binding.workspace_id, binding.channel_id, null, notice);
        }
      }
      this.ephemeralPostedViaTool.delete(agentId);
      // The agent-event subscriber that normally tears an ephemeral summon down on
      // turn end does NOT fire for these mention turns (the turn's events reach
      // only this drain), so the ephemeral agent AND its provider process (e.g.
      // `opencode serve`) leaked — one per mention. Tear it down here; the
      // `tearingDown` guard makes this idempotent with the subscriber path.
      if (binding.ephemeral) void this.teardownEphemeralAgent(agentId);
      return;
    }

    if (this.relayClient && binding.daemon_id && binding.daemon_id !== this.serverId) {
      this.relayClient.forward(binding.workspace_id, {
        type: "cyborg:agent_prompt_forward",
        agentId,
        workspaceId: binding.workspace_id,
        prompt,
        fromDaemonId: this.serverId ?? "unknown",
      });
      return;
    }

    this.broadcast.toWorkspace(binding.workspace_id, {
      type: "cyborg:agent_stream",
      payload: {
        agentId,
        workspaceId: binding.workspace_id,
        event: {
          type: "turn_failed",
          provider: binding.provider ?? "unknown",
          error: "Agent is not available on this daemon and no relay connection exists",
        },
      },
    });
  }

  private forwardStreamEvent(
    agentId: string,
    binding: StoredAgentBinding,
    event: AgentStreamEvent,
  ): void {
    // Scope these daemon-side error events the SAME way emitAgentStream scopes the
    // live stream: a DM turn's failure must surface only to the DM recipient, and an
    // AUTONOMOUS turn's error must not flush into its bound channel. The main
    // subscriber path consulted the DM-turn guard; this forwarded-error path omitted
    // it, so a private/scheduled turn's error leaked to the whole workspace channel.
    const dmEmail = this.dmTurnRecipientEmail(agentId);
    const autonomous = binding.autonomous === 1;
    this.broadcast.toWorkspace(binding.workspace_id, {
      type: "cyborg:agent_stream",
      payload: {
        agentId,
        workspaceId: binding.workspace_id,
        channelId: dmEmail || autonomous ? null : binding.channel_id,
        // Mirror the main subscriber funnel: classify a turn_failed so the UI can
        // show the remedy. No-op for the hardcoded daemon-side errors here.
        event: enrichTurnFailedEvent(event as unknown as Record<string, unknown>),
        // Scope DM-agent events to the initiator, matching the main
        // subscriber path — otherwise errors for private agents leak to
        // the whole workspace.
        privateToEmail: dmEmail ?? this.privateAgentEmail(binding),
        autonomous,
      },
    });
  }

  respondToPermission(agentId: string, requestId: string, response: unknown): void {
    if (!this.agentManager) return;

    const localAgent = this.agentManager.getAgent(agentId);
    if (localAgent) {
      // Fire-and-forget, but a rejection must NEVER escape as an unhandled promise
      // rejection: this runs inside the relay inbound handler, so a throw here — e.g.
      // a stale/duplicate permission reply after a relay reconnect/replay — crashed
      // the whole daemon worker, wiping in-process session-reuse + the @mention/watch
      // dedup Sets → duplicate cybo sessions. Swallow-and-log instead of `void`.
      this.agentManager
        .respondToPermission(
          agentId,
          requestId,
          response as import("../agent/agent-sdk-types.js").AgentPermissionResponse,
        )
        .catch((err) => {
          this.logger?.warn({ err, agentId, requestId }, "respondToPermission failed — ignoring");
        });
      return;
    }

    const binding = this.storage.getAgentBinding(agentId);
    if (binding && this.relayClient && binding.daemon_id && binding.daemon_id !== this.serverId) {
      this.relayClient.forward(binding.workspace_id, {
        type: "cyborg:permission_response_forward",
        agentId,
        workspaceId: binding.workspace_id,
        permissionRequestId: requestId,
        response: response as Record<string, unknown>,
        fromDaemonId: this.serverId ?? "unknown",
      });
    }
  }

  cancelAgent(agentId: string): void {
    if (!this.agentManager) return;

    const localAgent = this.agentManager.getAgent(agentId);
    if (localAgent) {
      void this.agentManager.cancelAgentRun(agentId);
      return;
    }

    const binding = this.storage.getAgentBinding(agentId);
    if (binding && this.relayClient && binding.daemon_id && binding.daemon_id !== this.serverId) {
      this.relayClient.forward(binding.workspace_id, {
        type: "cyborg:cancel_agent_forward",
        agentId,
        workspaceId: binding.workspace_id,
        fromDaemonId: this.serverId ?? "unknown",
      });
    }
  }

  // #591: clear an agent's derived "needs attention" flag on whichever daemon
  // owns it. Local agent → clear directly on the AgentManager (authoritative
  // store); a peer daemon's agent → forward so the owner clears + re-broadcasts.
  // Mirrors cancelAgent's local/peer split.
  clearAgentAttention(agentId: string): void {
    if (!this.agentManager) return;

    const localAgent = this.agentManager.getAgent(agentId);
    if (localAgent) {
      this.agentManager.clearAgentAttention(agentId).catch((err) => {
        this.logger?.warn(
          { err, agentId },
          "message-router: clearAgentAttention failed (badge stays until next snapshot reconciles)",
        );
      });
      return;
    }

    const binding = this.storage.getAgentBinding(agentId);
    if (binding && this.relayClient && binding.daemon_id && binding.daemon_id !== this.serverId) {
      this.relayClient.forward(binding.workspace_id, {
        type: "cyborg:clear_attention_forward",
        agentId,
        workspaceId: binding.workspace_id,
        fromDaemonId: this.serverId ?? "unknown",
      });
    }
  }

  // ─── Channel messages ─────────────────────────────────────────────

  // #602 — resolve the FINAL post text. A template-flagged send is expanded
  // ({channel}/{user}/{date} → HTML-escaped context); any other send returns
  // msg.text untouched. Extracted so handleChannelMessage stays under the
  // per-method complexity budget.
  private expandTemplateText(
    msg: CyborgChannelMessage,
    channelName: string,
    auth: CyborgAuthContext,
  ): string {
    if (!msg.expandTemplate) return msg.text;
    return expandPromptTemplate(msg.text, {
      channel: channelName,
      user: auth.user.name ?? auth.user.email,
      date: formatTemplateDate(new Date()),
    });
  }

  handleChannelMessage(auth: CyborgAuthContext, msg: CyborgChannelMessage): void {
    const { allowed } = this.workspaceManager.checkPermission(
      msg.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) return;

    const channel = this.workspaceManager.getChannel(msg.channelId);
    if (!channel || channel.workspace_id !== msg.workspaceId) return;

    // #602 — composer prompt template: when the client flags the send as
    // template-sourced, expand {channel}/{user}/{date} with the FINAL context
    // (the channel it's actually posting to, the sender, today's date) before
    // persisting/broadcasting. Only template sends carry the flag, so an ordinary
    // message with literal braces is left byte-identical.
    const text = this.expandTemplateText(msg, channel.name, auth);

    const saved = this.storage.insertMessage({
      workspaceId: msg.workspaceId,
      channelId: msg.channelId,
      fromId: auth.user.id,
      fromType: "human",
      fromName: auth.user.name ?? auth.user.email,
      text,
      mentions: msg.mentions,
      parentId: msg.parentId,
      attachments: msg.attachments,
    });

    this.broadcast.toWorkspace(msg.workspaceId, {
      type: "cyborg:channel_message_broadcast" as const,
      payload: {
        id: saved.id,
        workspaceId: saved.workspace_id,
        channelId: saved.channel_id!,
        fromId: saved.from_id,
        fromType: saved.from_type as "human" | "agent",
        fromName: auth.user.name ?? auth.user.email,
        text: saved.text,
        mentions: msg.mentions ?? [],
        parentId: saved.parent_id,
        attachments: msg.attachments ?? null,
        seq: saved.seq,
        createdAt: saved.created_at,
      },
    });

    const actorName = auth.user.name ?? auth.user.email;
    const preview = text.slice(0, 140);

    if (msg.mentions && msg.mentions.length > 0) {
      // Batch-resolve the workspace's agent bindings + member roles ONCE into
      // maps, instead of a getAgentBinding + getMemberRole lookup per mention
      // (N lookups per posted message). Both are local indexed reads scoped to
      // this workspace; the binding map is keyed by agent_id (what mentions
      // carry) so cross-workspace ids simply miss.
      const bindings = new Map(
        this.storage.getAgentsByWorkspace(msg.workspaceId).map((b) => [b.agent_id, b]),
      );
      const memberRoles = new Map(
        this.storage.getMembers(msg.workspaceId).map((m) => [m.user_id, m.role]),
      );
      for (const mentionedId of msg.mentions) {
        if (bindings.has(mentionedId)) {
          const prompt = `[#${channel.name}] ${actorName}: ${text}`;
          void this.routeToAgent(mentionedId, prompt).catch((err) =>
            this.logger?.warn({ err, mentionedId }, "[mention] route to agent failed"),
          );
        } else if (mentionedId !== auth.user.id && memberRoles.has(mentionedId)) {
          // Human mention → activity-feed entry for the recipient, but only if
          // they're actually a member of this workspace (no cross-workspace
          // spam / user enumeration via a crafted mention id).
          this.emitActivity(mentionedId, {
            workspaceId: msg.workspaceId,
            eventType: "mention",
            sourceId: saved.id,
            channelId: msg.channelId,
            previewText: preview,
            actorId: auth.user.id,
            actorName,
          });
        }
      }

      // @-mention a cybo MEMBER → invoke it (fire-and-forget; the membership
      // lookup + spawn are async). Only on this human-author path — cybo posts
      // never reach here, so cybo↔cybo loops can't form.
      void this.invokeMentionedCybos(channel, auth, msg, saved.id, text, saved.from_type);
    }

    // Tasks Phase 2 — channel watcher. Fires on EVERY human post (mentioned or
    // not — it lives OUTSIDE the mentions block), gated on auto_tasks_enabled +
    // the agent_watch rate limit + the prefilter inside. Fire-and-forget; only
    // this HUMAN post path calls it, so the watcher's own task ops can't re-trigger
    // it. The "watch:<messageId>" dedup namespace is DISTINCT from the mention
    // guard, so a mentioned message can be both answered and watched (once each).
    void this.invokeChannelWatchers(channel, auth, msg, saved.id, text, saved.from_type).catch(
      (err) =>
        this.logger?.warn(
          { err, channelId: channel.id },
          "[channel-watch] invokeChannelWatchers failed",
        ),
    );

    // Thread reply → notify the parent author (unless they wrote the reply).
    if (msg.parentId) {
      const parent = this.storage.getMessageById(msg.parentId);
      if (parent && parent.from_type === "human" && parent.from_id !== auth.user.id) {
        this.emitActivity(parent.from_id, {
          workspaceId: msg.workspaceId,
          eventType: "thread_reply",
          sourceId: saved.id,
          channelId: msg.channelId,
          previewText: preview,
          actorId: auth.user.id,
          actorName,
        });
      }
    }

    this.storage.audit({
      workspaceId: msg.workspaceId,
      actorId: auth.user.id,
      actorType: "human",
      action: "message.sent",
      targetType: "channel",
      targetId: msg.channelId,
    });

    // Outgoing webhooks: a channel post → message.created event for subscribers.
    this.enqueueWebhook({
      eventType: "message.created",
      workspaceId: msg.workspaceId,
      channelId: msg.channelId,
      messageId: saved.id,
      text: saved.text,
      fromId: saved.from_id,
      fromName: actorName,
      createdAt: saved.created_at,
    });
  }

  // Insert an activity-feed row for a recipient + push it to their connections.
  // Mentions/thread replies are "message"-sourced; emitTaskActivity reuses this
  // same insert + cyborg:activity_new broadcast for task-sourced rows.
  private emitActivityRow(
    recipientUserId: string,
    sourceType: string,
    e: {
      // Optional deterministic id (mention dedup across the daemon + relay writers
      // in the connected-daemon topology). Minted by the store when absent.
      id?: string;
      workspaceId: string;
      eventType: string;
      sourceId: string;
      channelId?: string | null;
      previewText?: string | null;
      actorId?: string | null;
      actorName?: string | null;
    },
  ): void {
    const stored = this.storage.insertActivityEvent({
      ...e,
      userId: recipientUserId,
      sourceType,
    });
    this.broadcast.toUser(recipientUserId, {
      type: "cyborg:activity_new",
      payload: {
        id: stored.id,
        workspaceId: stored.workspace_id,
        eventType: stored.event_type,
        sourceType: stored.source_type,
        sourceId: stored.source_id,
        channelId: stored.channel_id,
        previewText: stored.preview_text,
        actorId: stored.actor_id,
        actorName: stored.actor_name,
        createdAt: stored.created_at,
      },
    });
  }

  private emitActivity(
    recipientUserId: string,
    e: {
      // Optional deterministic id (see emitActivityRow): the agent-mention fan-out
      // passes one so the daemon + relay writes collapse to a single PG row.
      id?: string;
      workspaceId: string;
      eventType: string;
      sourceId: string;
      channelId?: string | null;
      previewText?: string | null;
      actorId?: string | null;
      actorName?: string | null;
    },
  ): void {
    this.emitActivityRow(recipientUserId, "message", e);
  }

  // Public task-activity entry for the dispatcher (which owns task CRUD but has no
  // direct BroadcastFn). Writes a task-sourced activity row and pushes it to the
  // recipient — the same path mentions use.
  emitTaskActivity(
    recipientUserId: string,
    e: {
      workspaceId: string;
      eventType: string;
      sourceId: string;
      previewText?: string | null;
      actorId?: string | null;
      actorName?: string | null;
    },
  ): void {
    this.emitActivityRow(recipientUserId, "task", e);
  }

  // Public daemon-activity entry for the dispatcher (local-daemon-mode mirror of
  // the relay's emitActivityEvent for daemon-access-request notifications). Writes
  // a "daemon"-sourced activity row and pushes a cyborg:activity_new to the
  // recipient — the same path mentions/tasks use, so the badge increments.
  emitDaemonActivity(
    recipientUserId: string,
    e: {
      workspaceId: string;
      eventType: string;
      sourceId: string;
      previewText?: string | null;
      actorId?: string | null;
      actorName?: string | null;
    },
  ): void {
    this.emitActivityRow(recipientUserId, "daemon", e);
  }

  // Public single-user live push for the dispatcher (which owns daemon-access CRUD
  // but has no direct BroadcastFn). Mirrors the relay's notifyUserGuests for the
  // cyborg:daemon_access_request_changed + set_daemon_access_response pushes.
  pushToUser(recipientUserId: string, message: unknown): void {
    this.broadcast.toUser(recipientUserId, message);
  }

  // Broadcast a task create/update to all workspace guests so open task views
  // refresh live. Mirrors the relay's cyborg:tasks_changed.
  broadcastTasksChanged(opts: {
    workspaceId: string;
    op: "created" | "updated";
    task: unknown;
  }): void {
    this.broadcast.toWorkspace(opts.workspaceId, {
      type: "cyborg:tasks_changed" as const,
      payload: {
        workspaceId: opts.workspaceId,
        op: opts.op,
        task: opts.task,
      },
    });
  }

  // Broadcast a page create/update/archive/delete to all workspace guests so open
  // pages views refresh live. Mirrors the relay's cyborg:pages_changed.
  broadcastPagesChanged(opts: {
    workspaceId: string;
    projectId: string;
    op: "created" | "updated" | "deleted";
    page: unknown;
  }): void {
    this.broadcast.toWorkspace(opts.workspaceId, {
      type: "cyborg:pages_changed" as const,
      payload: {
        workspaceId: opts.workspaceId,
        projectId: opts.projectId,
        op: opts.op,
        page: opts.page,
      },
    });
  }

  // Broadcast a recipe install/teardown to all workspace guests so open
  // integrations views refresh live (Built-in integrations). Mirrors the relay's
  // cyborg:recipes_changed. The payload carries only the workspaceId — clients
  // re-fetch list_recipes on receipt (the install set is small and PG-direct).
  broadcastRecipesChanged(opts: { workspaceId: string }): void {
    this.broadcast.toWorkspace(opts.workspaceId, {
      type: "cyborg:recipes_changed" as const,
      payload: {
        workspaceId: opts.workspaceId,
      },
    });
  }

  // Task-processing observability (#Logs tab): fan a structured, human-readable
  // task/watcher pipeline event out to the workspace as `cyborg:task_event`. The
  // client transport pushes its payload straight into logState, so it appears in
  // the Logs pane under the "Task" filter. Best-effort — never throws into the
  // caller (the watcher/dispatch path must not fail because telemetry did).
  broadcastTaskEvent(event: TaskLogEvent): void {
    try {
      this.broadcast.toWorkspace(event.workspaceId, taskEventBroadcast(event));
    } catch {
      // intentional: observability fan-out is best-effort; a broadcast failure
      // must not poison the watcher/dispatch path it rides on.
    }
  }

  // Audit-trace observability (#995, Logs tab): fan a structured AuditEvent out to
  // its workspace as `cyborg:audit_event`, the sibling of broadcastTaskEvent. The
  // relay's default daemon→guest forward delivers it to cloud guests just like
  // task events. Best-effort — never throws into the caller (the spawn / reaper /
  // credential path must not fail because telemetry did).
  broadcastAuditEvent(event: AuditEvent): void {
    try {
      this.broadcast.toWorkspace(event.workspaceId, auditEventBroadcast(event));
    } catch {
      // intentional: best-effort; an audit broadcast failure must not poison the
      // operation it rides on.
    }
  }

  // The re-route seam handed to spawn / mention sites so an existing pino call can
  // ALSO emit a structured audit event. Lazily built (the broadcast fn is stable)
  // and `debug`-gated behind CYBORG7_AUDIT_VERBOSE inside createAuditSink.
  private _auditSink: AuditSink | null = null;
  get auditSink(): AuditSink {
    if (!this._auditSink) {
      this._auditSink = createAuditSink((event) => this.broadcastAuditEvent(event));
    }
    return this._auditSink;
  }

  // Outgoing-webhook enqueue (#598). Fire-and-forget: a channel with an active
  // webhook subscribed to this event type gets one durable outbox row, delivered
  // out of band by the WebhookDeliveryRunner. PG-only (the runner reads PG); a
  // solo daemon (no pg) no-ops. Never blocks or fails the message path.
  private enqueueWebhook(opts: {
    eventType: WebhookEventType;
    workspaceId: string;
    channelId: string;
    messageId: string;
    text?: string | null;
    fromId?: string | null;
    fromName?: string | null;
    createdAt?: number | null;
  }): void {
    const pg = this.storage.pg;
    if (!pg) return;
    void enqueueWebhookEvent({
      pg,
      logger: this.logger,
      eventType: opts.eventType,
      workspaceId: opts.workspaceId,
      channelId: opts.channelId,
      messageId: opts.messageId,
      text: opts.text,
      fromId: opts.fromId,
      fromName: opts.fromName,
      createdAt: opts.createdAt,
    });
  }

  // Post a service-generated message (e.g. a /summarize result) to a channel as
  // a persistent, all-members-visible message. Attributed as an agent-typed
  // sender (the broadcast schema only allows human|agent) with a display name.
  postServiceMessage(opts: {
    workspaceId: string;
    channelId: string;
    fromId: string;
    fromName: string;
    text: string;
    // The daemon that executed this (e.g. a slash AI result), surfaced in the
    // result's profile sheet so users can see which daemon ran the command.
    daemonId?: string | null;
  }): void {
    const saved = this.storage.insertMessage({
      workspaceId: opts.workspaceId,
      channelId: opts.channelId,
      fromId: opts.fromId,
      fromType: "agent",
      fromName: opts.fromName,
      text: opts.text,
    });
    this.broadcast.toWorkspace(opts.workspaceId, {
      type: "cyborg:channel_message_broadcast",
      payload: {
        id: saved.id,
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        fromId: opts.fromId,
        fromType: "agent",
        fromName: opts.fromName,
        text: saved.text,
        mentions: [],
        parentId: null,
        attachments: null,
        daemonId: opts.daemonId ?? null,
        seq: saved.seq,
        createdAt: saved.created_at,
      },
    });
  }

  // Echo a user's slash command into the channel as a visible HUMAN message, so
  // everyone sees who ran what BEFORE the AI result posts (transparency). Mirrors
  // the channel_message broadcast shape with fromType "human".
  postUserCommandEcho(opts: {
    workspaceId: string;
    channelId: string;
    userId: string;
    userName: string;
    text: string;
  }): void {
    const saved = this.storage.insertMessage({
      workspaceId: opts.workspaceId,
      channelId: opts.channelId,
      fromId: opts.userId,
      fromType: "human",
      fromName: opts.userName,
      text: opts.text,
    });
    this.broadcast.toWorkspace(opts.workspaceId, {
      type: "cyborg:channel_message_broadcast" as const,
      payload: {
        id: saved.id,
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        fromId: opts.userId,
        fromType: "human" as const,
        fromName: opts.userName,
        text: saved.text,
        mentions: [],
        parentId: null,
        attachments: null,
        seq: saved.seq,
        createdAt: saved.created_at,
      },
    });
  }

  // Transient progress signal for an AI slash command so the UI can show loading
  // in the channel. Not persisted — the result posts separately as a message.
  // Push the workspace terminal DIRECTORY snapshot to its owner. Owner-scoped
  // (toUser, plus payload.toUserId so the relay's re-broadcast also narrows): a
  // terminal is private to whoever opened it. Lets a client refresh its sidebar
  // when a session is started/killed out-of-band (CLI, another tab).
  broadcastTerminalsChanged(opts: {
    workspaceId: string;
    ownerUserId: string;
    terminals: CyborgTerminalDirEntry[];
  }): void {
    this.broadcast.toUser(opts.ownerUserId, {
      type: "cyborg:terminals_changed" as const,
      payload: {
        workspaceId: opts.workspaceId,
        terminals: opts.terminals,
        toUserId: opts.ownerUserId,
      },
    });
  }

  // A terminal alias is per-user (a terminal is private to its owner), so a
  // rename fans out only to that user's other clients — owner-scoped like the
  // directory feed above. An empty `alias` means it was cleared (back to the
  // pty title). Lets a rename on one device show live on the rest, no reload.
  broadcastTerminalAliasChanged(opts: {
    ownerUserId: string;
    terminalId: string;
    alias: string;
  }): void {
    this.broadcast.toUser(opts.ownerUserId, {
      type: "cyborg:terminal_alias_changed" as const,
      payload: {
        terminalId: opts.terminalId,
        alias: opts.alias,
        toUserId: opts.ownerUserId,
      },
    });
  }

  broadcastSlashProgress(opts: {
    workspaceId: string;
    channelId: string;
    trigger: string;
    phase: "generating" | "done" | "error";
    requestId?: string;
  }): void {
    this.broadcast.toWorkspace(opts.workspaceId, {
      type: "cyborg:slash_command_progress" as const,
      payload: {
        workspaceId: opts.workspaceId,
        channelId: opts.channelId,
        trigger: opts.trigger,
        phase: opts.phase,
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      },
    });
  }

  handleDm(auth: CyborgAuthContext, msg: CyborgDm): void {
    const { allowed } = this.workspaceManager.checkPermission(
      msg.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) return;

    const saved = this.storage.insertMessage({
      workspaceId: msg.workspaceId,
      fromId: auth.user.id,
      fromType: "human",
      fromName: auth.user.name ?? auth.user.email,
      toId: msg.toId,
      text: msg.text,
      attachments: msg.attachments,
    });

    const dmBroadcast = {
      type: "cyborg:dm_broadcast" as const,
      payload: {
        id: saved.id,
        workspaceId: saved.workspace_id,
        fromId: saved.from_id,
        fromType: saved.from_type as "human" | "agent",
        fromName: auth.user.name ?? auth.user.email,
        toId: msg.toId,
        text: saved.text,
        attachments: msg.attachments ?? null,
        seq: saved.seq,
        createdAt: saved.created_at,
      },
    };

    this.broadcast.toUser(auth.user.id, dmBroadcast);
    if (msg.toId !== auth.user.id) {
      this.broadcast.toUser(msg.toId, dmBroadcast);
    }

    const binding = this.storage.getAgentBinding(msg.toId);
    if (binding && binding.workspace_id === msg.workspaceId) {
      // Route through the single armed DM path so a DM-to-cybo reply can never leak
      // into the cybo's persistent channel-bound session — see routeDmTurn. The
      // Layer-A framed prompt is built here (the cloud path frames its own in
      // bootstrap, folding in any attachments).
      const prompt = this.buildDmPrompt({
        userId: auth.user.id,
        name: auth.user.name ?? auth.user.email,
        text: msg.text,
      });
      void this.routeDmTurn(msg.toId, { userId: auth.user.id, email: auth.user.email }, prompt, {
        rawPrompt: msg.text,
      });
    }
  }

  // Build the Layer-A (prompt scoping) framing for a 1:1 DM turn: tell the cybo this
  // is a PRIVATE direct message and it must reply by DMing the user back, never to a
  // channel. A scheduled cybo's session still has "Current channel: …" baked into its
  // system prompt, so be explicit. Shared by the local + cloud DM entry points so both
  // frame identically.
  //
  // PRIVACY (must stay): the framing is wrapped in the <paseo-system>…</paseo-system>
  // envelope (formatSystemNotificationPrompt). This is ONLY the model's turn INPUT —
  // every provider (claude/pi/acp/opencode) echoes its turn input back as a live
  // `user_message` timeline event, and AgentManager.onStreamTimelineEvent /
  // hydrateTimelineFromLegacyProviderHistory SUPPRESS a `user_message` *only* when its
  // text is a <paseo-system> envelope (isSystemInjectedEnvelope). Without the envelope
  // the echo is recorded + broadcast as a visible "You" message — leaking the private
  // framing into the agent-session transcript. The raw user text shown to humans comes
  // from the separate appendTimelineItem({ user_message, text: rawPrompt }) in
  // routeToAgent; this wrapper keeps the framing out of that visible transcript while
  // the model still receives the full DM guard (same mechanism chat mentions use).
  //
  // SECURITY: recipient.text is UNTRUSTED user input. A user who types a literal
  // </paseo-system> tag could break out of the envelope and forge a system block.
  // formatSystemNotificationPrompt strips any paseo-system tags from the body before
  // wrapping (centralized chokepoint), so the breakout is neutralized for this and every
  // other envelope caller — no per-callsite sanitization needed here.
  buildDmPrompt(recipient: { userId: string; name: string; text: string }): string {
    return formatSystemNotificationPrompt(
      `[PRIVATE DM from ${recipient.name} (user id: ${recipient.userId})]: ${recipient.text}\n\n` +
        `This is a private 1:1 direct message. Reply ONLY by DMing the user back ` +
        `(cyborg7_send_message with to: "${recipient.userId}"). Do NOT post to any channel for this turn.`,
    );
  }

  // The ONE armed DM path: mark the agent as mid-DM-turn (dmTurnRecipient), route the
  // (caller-framed) turn, and clear the guard on completion. Used by BOTH the local
  // handleDm and the CLOUD agent_prompt_forward path (bootstrap), so a DM-to-cybo reply
  // can never leak into the cybo's persistent channel-bound session regardless of which
  // entry point delivered the prompt. The guard is a Map (per recipient id) so a second
  // concurrent DM whose routeToAgent rejects ("agent busy") only clears its OWN entry,
  // never the still-running turn's; the key is dropped when the last DM turn for this
  // agent ends. While it's armed, emitAgentStream nulls the channel + sets
  // privateToEmail, and handleAgentMessage redirects any channel post to the DM.
  routeDmTurn(
    agentId: string,
    recipient: { userId: string; email: string },
    prompt: AgentPromptInput,
    opts?: { rawPrompt?: string },
  ): Promise<void> {
    let recipients = this.dmTurnRecipient.get(agentId);
    if (!recipients) {
      recipients = new Map<string, string>();
      this.dmTurnRecipient.set(agentId, recipients);
    }
    recipients.set(recipient.userId, recipient.email);
    return this.routeToAgent(agentId, prompt, opts).finally(() => {
      const set = this.dmTurnRecipient.get(agentId);
      if (set) {
        set.delete(recipient.userId);
        if (set.size === 0) this.dmTurnRecipient.delete(agentId);
      }
    });
  }

  // If this agent is mid-DM-turn, a channel post must be redirected to the DM
  // recipient (the first active one). Returns that user id, or null to post as-is.
  private dmRedirectTarget(agentId: string, channelId: string | null): string | null {
    if (!channelId) return null;
    const map = this.dmTurnRecipient.get(agentId);
    return map?.keys().next().value ?? null;
  }

  // The EMAIL of the first active DM recipient for a mid-DM-turn agent, or null.
  // Used by emitAgentStream to steer the relay's flush to the DM (privateToEmail).
  private dmTurnRecipientEmail(agentId: string): string | null {
    const map = this.dmTurnRecipient.get(agentId);
    return map?.values().next().value ?? null;
  }

  handleAgentMessage(
    agentId: string,
    workspaceId: string,
    channelId: string | null,
    toId: string | null,
    text: string,
    // Explicit USER ids the agent is notifying (cyborg7_send_message `mentions`).
    // EXPLICIT ids only — never parsed from text. Filtered to HUMAN workspace
    // members below: a cybo/unknown id is dropped, and an agent mention NEVER
    // invokes a cybo (no routeToAgent on this path). Channel posts only; a DM
    // (toId) carries no mentions.
    mentions?: string[] | null,
  ): void {
    // Hard guard (Layer B): while this cybo is answering a 1:1 DM, a channel post is
    // REDIRECTED to the DM recipient — a DM must never leak into a channel even if
    // the cybo's (scheduled, channel-bound) session prompt tells it to post there.
    // @-mention/scheduled turns are not in dmTurnRecipient, so they post normally.
    const dmRecipient = this.dmRedirectTarget(agentId, channelId);
    if (dmRecipient) {
      channelId = null;
      toId = dmRecipient;
      mentions = null;
    }
    const binding = this.storage.getAgentBinding(agentId);
    // Record that this ephemeral cybo delivered via the tool, so the turn-end
    // assistant-text bridge (see the agent_stream subscriber) doesn't double-post.
    if (binding?.ephemeral) this.ephemeralPostedViaTool.add(agentId);
    // Attribute a cybo's CHANNEL post to the cybo identity (fromId = cybo id) so
    // the client resolves its name + avatar from the workspace cybo roster instead
    // of rendering the raw ephemeral-agent UUID with no photo. getCybo resolves the
    // name now that spawnCybo persists the relay-resolved cybo locally. DMs keep
    // the agent id (their path already renders the name).
    const cyboId = binding?.cybo_id ?? null;
    const agentName = cyboId ? (this.storage.getCybo(cyboId)?.name ?? agentId) : agentId;
    const fromId = channelId && cyboId ? cyboId : agentId;
    // GUARD (humans-only, P1): keep only mention ids that are HUMAN members of this
    // workspace. getMembers returns users (humans); a cybo id or an unknown id is
    // not a member, so it is dropped here — the agent can never notify-as-invoke a
    // cybo, and a crafted/foreign id can't enumerate users. Channel posts only.
    const humanMentions =
      channelId && mentions && mentions.length > 0
        ? (() => {
            const memberIds = new Set(this.storage.getMembers(workspaceId).map((m) => m.user_id));
            return [...new Set(mentions)].filter((id) => id !== fromId && memberIds.has(id));
          })()
        : [];
    const saved = this.storage.insertMessage({
      workspaceId,
      channelId,
      fromId,
      fromType: "agent",
      fromName: agentName,
      toId,
      text,
      // Persist the resolved (human) mentions so a reload + cross-device read-state
      // see the same recipients the live broadcast + activity rows carry.
      mentions: humanMentions.length > 0 ? humanMentions : null,
    });

    if (channelId) {
      this.broadcast.toWorkspace(workspaceId, {
        type: "cyborg:channel_message_broadcast",
        payload: {
          id: saved.id,
          workspaceId,
          channelId,
          fromId,
          fromType: "agent",
          // Carry the resolved cybo/agent display name in the live broadcast so
          // the client shows the real name (e.g. "Apex") instead of falling back
          // to the raw agent id. The human path already sends fromName; the agent
          // path historically omitted it, so live agent posts rendered the id.
          fromName: agentName,
          text,
          mentions: humanMentions,
          parentId: null,
          seq: saved.seq,
          createdAt: saved.created_at,
        },
      });

      // Fan out a 'mention' activity row per mentioned HUMAN, mirroring the human
      // author path (handleChannelMessage): unread badges + OS notifications fire
      // for an agent @mention exactly as for a human one. NEVER routes to an agent
      // — an agent mention must not trigger a cybo invocation (the cybo-invoke path
      // is the human-author path only).
      if (humanMentions.length > 0) {
        const preview = text.slice(0, 140);
        for (const userId of humanMentions) {
          this.emitActivity(userId, {
            // Deterministic id keyed on (recipient, message, "mention") so this
            // daemon-side write and the relay's cloud-mirror write (a connected
            // daemon broadcasts to a relay sharing this same PG) dedup to ONE row
            // via the activity_events PK — no double badge/notify, no migration.
            id: mentionActivityId(userId, saved.id, "mention"),
            workspaceId,
            eventType: "mention",
            sourceId: saved.id,
            channelId,
            previewText: preview,
            actorId: fromId,
            actorName: agentName,
          });
        }
      }
    } else if (toId) {
      const dm = {
        type: "cyborg:dm_broadcast",
        payload: {
          id: saved.id,
          workspaceId,
          fromId: agentId,
          fromType: "agent",
          fromName: agentName,
          toId,
          text,
          seq: saved.seq,
          createdAt: saved.created_at,
        },
      };
      this.broadcast.toUser(toId, dm);
    }
  }

  // ─── History ──────────────────────────────────────────────────────

  handleFetchMessages(
    auth: CyborgAuthContext,
    msg: CyborgFetchMessagesRequest,
  ): { messages: StoredMessage[]; hasMore: boolean } {
    const { allowed } = this.workspaceManager.checkPermission(
      msg.workspaceId,
      auth.user.id,
      "view",
    );
    if (!allowed) return { messages: [], hasMore: false };

    const limit = msg.limit ?? 50;
    const messages = this.storage.getMessages({
      channelId: msg.channelId,
      before: msg.before,
      limit: limit + 1,
    });

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    // Attach thread metadata (reply count + last reply time) to top-level
    // messages so the client can render a "N replies" indicator.
    const threadMeta = this.storage.getThreadMeta(msg.channelId);
    if (threadMeta.size > 0) {
      for (const m of messages) {
        const meta = threadMeta.get(m.id);
        if (meta) {
          m.reply_count = meta.count;
          m.last_reply_at = meta.lastReplyAt;
        }
      }
    }

    return { messages, hasMore };
  }

  handleFetchThread(
    auth: CyborgAuthContext,
    msg: CyborgFetchThreadRequest,
  ): { messages: StoredMessage[] } {
    const { allowed } = this.workspaceManager.checkPermission(
      msg.workspaceId,
      auth.user.id,
      "view",
    );
    if (!allowed) return { messages: [] };
    // The parent must belong to this workspace — otherwise a member of one
    // workspace could read thread replies from another by guessing a parent id.
    const parent = this.storage.getMessageById(msg.parentId);
    if (!parent || parent.workspace_id !== msg.workspaceId) return { messages: [] };
    return { messages: this.storage.getThreadReplies(msg.parentId) };
  }

  handleSearch(auth: CyborgAuthContext, msg: CyborgSearch): { messages: StoredMessage[] } {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return { messages: [] };
    }
    return { messages: this.storage.searchMessages(msg.workspaceId, msg.query, msg.limit) };
  }

  handleSetNotificationPref(auth: CyborgAuthContext, msg: CyborgSetNotificationPref): void {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed)
      return;
    this.storage.setNotificationPref(msg.workspaceId, auth.user.id, msg.scopeId, msg.preference);
    // Cross-device: tell the user's other connections.
    this.broadcast.toUser(auth.user.id, {
      type: "cyborg:notification_pref_changed",
      payload: { workspaceId: msg.workspaceId, scopeId: msg.scopeId, preference: msg.preference },
    });
  }

  handleFetchNotificationPrefs(
    auth: CyborgAuthContext,
    msg: CyborgFetchNotificationPrefs,
  ): Record<string, string> {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return {};
    }
    return Object.fromEntries(this.storage.getNotificationPrefs(msg.workspaceId, auth.user.id));
  }

  // ─── Composer drafts (server-side draft sync, #610) ──────────────
  // Upsert the caller's draft for a (workspace, scope). Persists (SQLite + PG via
  // DualStorage) and tells the user's OTHER devices so the draft re-hydrates
  // live, mirroring handleSetNotificationPref's cross-device broadcast.
  handleDraftSet(auth: CyborgAuthContext, msg: CyborgDraftSet): void {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed)
      return;
    this.storage.setDraft(msg.workspaceId, auth.user.id, msg.scope, msg.text, msg.updatedAt);
    this.broadcast.toUser(auth.user.id, {
      type: "cyborg:draft_changed",
      payload: {
        workspaceId: msg.workspaceId,
        scope: msg.scope,
        text: msg.text,
        updatedAt: msg.updatedAt,
      },
    });
  }

  // Clear the caller's draft for a (workspace, scope) — on send or explicit
  // clear. text:null in the broadcast tells other devices to drop it.
  handleDraftClear(auth: CyborgAuthContext, msg: CyborgDraftClear): void {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed)
      return;
    this.storage.clearDraft(msg.workspaceId, auth.user.id, msg.scope);
    this.broadcast.toUser(auth.user.id, {
      type: "cyborg:draft_changed",
      payload: {
        workspaceId: msg.workspaceId,
        scope: msg.scope,
        text: null,
        updatedAt: Date.now(),
      },
    });
  }

  handleFetchDrafts(
    auth: CyborgAuthContext,
    msg: CyborgFetchDrafts,
  ): Array<{ scope: string; text: string; updatedAt: number }> {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return [];
    }
    return this.storage.getDrafts(msg.workspaceId, auth.user.id);
  }

  handleFetchActivity(
    auth: CyborgAuthContext,
    msg: CyborgFetchActivity,
  ): { items: StoredActivityEvent[]; unread: number } {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return { items: [], unread: 0 };
    }
    const items = this.storage.getActivity(msg.workspaceId, auth.user.id, {
      limit: msg.limit,
      before: msg.before,
      unreadOnly: msg.unreadOnly,
    });
    const unread = this.storage.getUnreadActivityCount(msg.workspaceId, auth.user.id);
    return { items, unread };
  }

  handleMarkActivityRead(auth: CyborgAuthContext, msg: CyborgMarkActivityRead): number {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return 0;
    }
    if (msg.eventId) this.storage.markActivityRead(msg.eventId, auth.user.id);
    else this.storage.markAllActivityRead(msg.workspaceId, auth.user.id);
    return this.storage.getUnreadActivityCount(msg.workspaceId, auth.user.id);
  }

  handleMarkRead(auth: CyborgAuthContext, msg: CyborgMarkRead): number {
    const lastReadAt = msg.lastReadAt ?? Date.now();
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return lastReadAt;
    }
    this.storage.markRead(msg.workspaceId, auth.user.id, msg.channelId, lastReadAt);
    // Cross-device sync: tell the user's other connections.
    this.broadcast.toUser(auth.user.id, {
      type: "cyborg:read_broadcast" as const,
      payload: { workspaceId: msg.workspaceId, channelId: msg.channelId, lastReadAt },
    });
    return lastReadAt;
  }

  // Mark-unread-from-post (N4): rewind last_read_at to just before the chosen
  // post so it (and later posts) count as unread. The channel analogue of
  // mark_thread_unread — same storage.markRead path (which overwrites, not just
  // advances, so rewinding works) and the same read_broadcast cross-device sync
  // as mark_read. Returns the new last_read_at (beforeAt - 1ms).
  handleMarkChannelUnread(auth: CyborgAuthContext, msg: CyborgMarkChannelUnread): number {
    const lastReadAt = msg.beforeAt - 1;
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return lastReadAt;
    }
    this.storage.markRead(msg.workspaceId, auth.user.id, msg.channelId, lastReadAt);
    this.broadcast.toUser(auth.user.id, {
      type: "cyborg:read_broadcast" as const,
      payload: { workspaceId: msg.workspaceId, channelId: msg.channelId, lastReadAt },
    });
    return lastReadAt;
  }

  handleFetchUnread(
    auth: CyborgAuthContext,
    msg: CyborgFetchUnread,
  ): { counts: Record<string, number>; reads: Record<string, number> } {
    if (!this.workspaceManager.checkPermission(msg.workspaceId, auth.user.id, "view").allowed) {
      return { counts: {}, reads: {} };
    }
    const counts = Object.fromEntries(this.storage.getUnreadCounts(msg.workspaceId, auth.user.id));
    const reads = Object.fromEntries(this.storage.getReadsForUser(msg.workspaceId, auth.user.id));
    return { counts, reads };
  }

  // Author-only edit. Returns false if not allowed / not found.
  handleEditMessage(auth: CyborgAuthContext, msg: CyborgEditMessage): boolean {
    const existing = this.storage.getMessageById(msg.messageId);
    if (!existing || existing.workspace_id !== msg.workspaceId) return false;
    if (existing.from_id !== auth.user.id) return false; // only the author may edit
    this.storage.updateMessageText(msg.messageId, msg.text);
    this.broadcast.toWorkspace(msg.workspaceId, {
      type: "cyborg:edit_message_broadcast" as const,
      payload: { workspaceId: msg.workspaceId, messageId: msg.messageId, text: msg.text },
    });
    // Outgoing webhooks: a channel message edit → message.updated. DMs (null
    // channel) have no webhook scope.
    if (existing.channel_id) {
      this.enqueueWebhook({
        eventType: "message.updated",
        workspaceId: msg.workspaceId,
        channelId: existing.channel_id,
        messageId: msg.messageId,
        text: msg.text,
        fromId: existing.from_id,
      });
    }
    return true;
  }

  // Author OR workspace admin/owner may delete.
  handleDeleteMessage(auth: CyborgAuthContext, msg: CyborgDeleteMessage): boolean {
    const existing = this.storage.getMessageById(msg.messageId);
    if (!existing || existing.workspace_id !== msg.workspaceId) return false;
    const role = this.workspaceManager.getMemberRole(msg.workspaceId, auth.user.id);
    const isAdmin = role === "owner" || role === "admin";
    if (existing.from_id !== auth.user.id && !isAdmin) return false;
    this.storage.deleteMessage(msg.messageId);
    this.broadcast.toWorkspace(msg.workspaceId, {
      type: "cyborg:delete_message_broadcast" as const,
      payload: { workspaceId: msg.workspaceId, messageId: msg.messageId },
    });
    // Outgoing webhooks: a channel message delete → message.deleted (ids only).
    if (existing.channel_id) {
      this.enqueueWebhook({
        eventType: "message.deleted",
        workspaceId: msg.workspaceId,
        channelId: existing.channel_id,
        messageId: msg.messageId,
      });
    }
    return true;
  }

  handlePinMessage(
    auth: CyborgAuthContext,
    msg: CyborgPinMessage,
  ): { pinnedAt: number | null; pinnedBy: string | null } | null {
    const { allowed } = this.workspaceManager.checkPermission(
      msg.workspaceId,
      auth.user.id,
      "send_message",
    );
    if (!allowed) return null;
    // The message must actually live in this workspace + channel — otherwise a
    // user with send rights in one workspace could pin an arbitrary message id.
    const existing = this.storage.getMessageById(msg.messageId);
    if (
      !existing ||
      existing.workspace_id !== msg.workspaceId ||
      existing.channel_id !== msg.channelId
    ) {
      return null;
    }
    const result = this.storage.setPinned(msg.messageId, msg.pinned ? auth.user.id : null);
    this.broadcast.toWorkspace(msg.workspaceId, {
      type: "cyborg:pin_message_broadcast" as const,
      payload: {
        workspaceId: msg.workspaceId,
        channelId: msg.channelId,
        messageId: msg.messageId,
        pinnedAt: result.pinnedAt,
        pinnedBy: result.pinnedBy,
      },
    });
    return result;
  }

  handleSync(
    auth: CyborgAuthContext,
    msg: CyborgSyncRequest,
  ): { mode: "delta" | "snapshot"; messages: StoredMessage[] } {
    const { allowed } = this.workspaceManager.checkPermission(
      msg.workspaceId,
      auth.user.id,
      "view",
    );
    if (!allowed) return { mode: "delta", messages: [] };

    const messages = this.storage.getMessagesSince(msg.workspaceId, msg.lastSeq);

    if (messages.length >= 500) {
      return { mode: "snapshot", messages: messages.slice(0, 100) };
    }
    return { mode: "delta", messages };
  }

  handleTyping(auth: CyborgAuthContext, workspaceId: string, channelId: string): void {
    this.broadcast.toWorkspace(workspaceId, {
      type: "cyborg:typing_broadcast",
      payload: {
        workspaceId,
        channelId,
        fromId: auth.user.id,
        fromName: auth.user.name ?? auth.user.email,
      },
    });
  }

  handleReaction(
    auth: CyborgAuthContext,
    workspaceId: string,
    messageId: string,
    emoji: string,
  ): void {
    this.broadcast.toWorkspace(workspaceId, {
      type: "cyborg:reaction_broadcast",
      payload: {
        workspaceId,
        messageId,
        fromId: auth.user.id,
        emoji,
      },
    });
  }

  // Agent (cybo) counterpart of handleReaction — attributes the reaction to the
  // cybo's agentId instead of a human auth context. Used by the cyborg7_react MCP
  // tool, mirroring handleAgentMessage.
  handleAgentReaction(
    agentId: string,
    workspaceId: string,
    messageId: string,
    emoji: string,
  ): void {
    this.broadcast.toWorkspace(workspaceId, {
      type: "cyborg:reaction_broadcast",
      payload: {
        workspaceId,
        messageId,
        fromId: agentId,
        emoji,
      },
    });
  }
}

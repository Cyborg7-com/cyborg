export interface Agent {
  agentId: string;
  provider: string;
  lifecycle: string;
  channelId?: string | null;
  cyboId?: string | null;
  cyboName?: string | null;
  cyboAvatar?: string | null;
  initiatedBy?: string | null;
  model?: string | null;
  modeId?: string | null;
  availableModes?: AgentMode[];
  thinkingOptionId?: string | null;
  cwd?: string | null;
  daemonLocal?: boolean;
  daemonId?: string | null;
  // Daemon-derived "needs attention" signal (#591), forwarded on the agent-list
  // snapshot (cyborg:list_agents). Edge-triggered server-side: set on
  // running→idle ("finished") and →error, cleared when the agent is viewed.
  // Optional + additive (older daemons omit it). The agents list reads this to
  // badge a finished/errored background agent; the live-derived equivalent for
  // agents already in view comes from the stream events (see attentionState).
  attention?: AgentAttention;
  // Daemon-owner audit badges (#993). Present ONLY on rows from the audit listing
  // (cyborg:list_daemon_sessions); ALWAYS absent on the scoped cyborg:list_agents
  // rows that feed the chat sidebar, so a slash/mention summon never appears there.
  // `ephemeral` = a one-turn slash/@mention summon; `internal` = the Paseo internal
  // flag (set on a live ephemeral). The audit SessionList badges rows where either
  // is true as "Ephemeral".
  ephemeral?: boolean;
  internal?: boolean;
}

// The agent-list row's attention projection. `reason` distinguishes a finished
// turn from an error so the badge can label them differently; "permission" is
// also possible (kept for completeness) though the pending-permission badge has
// its own, separate surface.
export interface AgentAttention {
  requiresAttention: boolean;
  reason?: AgentAttentionReason | null;
}

export type AgentAttentionReason = "finished" | "error" | "permission";

// Cybo runtime capability published by ≥this-build daemons (internal docs item 3):
// configured = the runtime lists ≥1 model (credentials PRESENT — not validated;
// an invalid key still lists models and only fails at session time);
// backends = per-backend model counts when the runtime exposes them. Absent on
// older daemons → consumers must degrade to the binary cyboInstalled signal.
export interface CyboRuntimeProfile {
  configured: boolean;
  modelCount: number;
  backends: { backend: string; modelCount: number }[];
}

export interface DaemonMeta {
  cpu?: number;
  memMb?: number;
  agents?: number;
  queueDepth?: number;
  host?: string;
  platform?: string;
  arch?: string;
  cyboInstalled?: boolean;
  // Running daemon CLI version (#663) — drives the "outdated → Update" UI.
  // Optional/back-compat: older daemons don't publish it.
  version?: string;
  cyboRuntime?: CyboRuntimeProfile;
}

export interface Daemon {
  id: string;
  label: string;
  ownerId: string;
  status: string;
  lastSeenAt: number | null;
  meta?: DaemonMeta | null;
}

export interface DaemonAccessEntry {
  daemonId: string;
  userId: string;
  grantedBy: string;
  grantedAt: number;
  // Capability scopes for this grant (#705): chat | spawn | terminal | admin.
  // Optional for back-compat with an older relay that omits the field — the UI
  // normalizes a missing/empty value to ['admin'] (legacy total access).
  scopes?: string[];
}

export interface Cybo {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  avatar?: string | null;
  role?: string | null;
  provider: string;
  model?: string | null;
  // First ~280 chars of the cybo's soul.md — a personality preview for the card.
  soulExcerpt?: string;
  llmAuthMode?: string;
  behaviorMode?: string;
  // Per-cybo autonomy dial (S2). One of "L0".."L5"; null/undefined → falls back
  // from behaviorMode. Set via the Autonomy tab → updateCybo({autonomyLevel}).
  autonomyLevel?: string | null;
  monthlySpendCap?: number | null;
  platformPermissions?: string[];
  // Personality. Omitted from the list (fetch_cybos); only the single-cybo
  // fetch (fetch_cybo) populates it for the editor / detail view.
  soul?: string | null;
  // The cybo's explicit "home" daemon — the machine it lives on / runs on,
  // chosen at creation and carried authoritatively across daemons. null/absent
  // for cybos created before this existed → spawn falls back to the
  // sponsor/selected daemon. Distinct from `daemonId` below (which is only the
  // provenance of a disk/local cybo).
  homeDaemonId?: string | null;
  // True for a disk cybo surfaced in the list but not yet in the workspace DB.
  isLocal?: boolean;
  // Home daemon of a LOCAL (disk) cybo — the only machine that can spawn it.
  // null/absent for workspace (DB) cybos, which any daemon can run via the
  // relay's resolvedCybo enrichment.
  daemonId?: string | null;
  isDefault: boolean;
  createdAt: number;
  // Provider readiness (#636), computed server-side from the workspace's live
  // daemon set: "ready" (a reachable daemon can run it), "needs-daemon" (created
  // fine but nothing reachable can run it yet — the UI shows a banner) or
  // "created" (indeterminate, e.g. a native harness whose host login the relay
  // can't observe). Absent on older payloads → treat as unknown, don't warn.
  readiness?: CyboReadiness;
  // epoch ms — last time this cybo was active, = max(agent_sessions.updated_at)
  // for this cybo, computed server-side (PG/relay path). Optional/additive;
  // absent on older relays and on the SQLite-only daemon path (no session
  // table to aggregate), so treat absence as "unknown" → render "—".
  lastActiveAt?: number;
}

export type CyboReadiness = "ready" | "needs-daemon" | "created";

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: string;
      content?: string;
      filePaths?: string[];
      numFiles?: number;
      numMatches?: number;
    }
  | { type: "fetch"; url: string; result?: string; code?: number; bytes?: number }
  | { type: "sub_agent"; subAgentType?: string; description?: string; log: string }
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "plan"; text: string }
  | { type: "worktree_setup"; worktreePath: string; branchName: string; log: string }
  | { type: "unknown"; input: unknown; output: unknown };

export interface ToolCallItem {
  type: "tool_call";
  callId: string;
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  detail: ToolCallDetail;
  error: unknown | null;
}

export interface CompactionItem {
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export type AgentTimelineItem =
  // messageId mirrors the server timeline item — the Paseo user-turn id used as
  // the 'rewind to here' anchor (#649). Optional: not every provider/item sets it.
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallItem
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string }
  | CompactionItem;

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
}

export interface AgentPermissionRequest {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: ToolCallDetail;
  actions?: AgentPermissionAction[];
}

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: Record<string, unknown>;
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export type AgentEvent =
  | { type: "thread_started"; sessionId: string; provider: string }
  | { type: "turn_started"; provider: string; turnId?: string }
  | { type: "turn_completed"; provider: string; usage?: AgentUsage; turnId?: string }
  | {
      type: "turn_failed";
      provider: string;
      error: string;
      code?: string;
      turnId?: string;
      // Classified by the daemon (cyborg/message-router → provider-error-classify)
      // when a turn-time provider failure is a known gate (usage_gated / auth /
      // expired / rate_limited). Optional + additive: older daemons omit them and
      // the UI falls back to the raw `error`. Drives the same `providerRemedy`
      // remedy the spawn path shows.
      reasonKind?: ProviderReasonKind | null;
      unavailableReason?: string | null;
    }
  | { type: "turn_canceled"; provider: string; reason: string; turnId?: string }
  | { type: "timeline"; item: AgentTimelineItem; provider: string; turnId?: string }
  | {
      type: "permission_requested";
      provider: string;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: string;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | { type: "usage_updated"; provider: string; usage: AgentUsage; turnId?: string }
  | { type: "attention_required"; provider: string; reason: string }
  | { type: "model_changed"; provider: string; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "mode_changed";
      provider: string;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "thinking_option_changed"; provider: string; thinkingOptionId: string | null };

export interface AgentStreamPayload {
  agentId: string;
  workspaceId?: string;
  event: AgentEvent;
}

export interface AgentStatus {
  agentId: string;
  workspaceId: string;
  status: "idle" | "running" | "error";
  error?: string;
}

// Why a provider that's CONNECTED can still be unusable. Mirrors the server
// classifier (cyborg/provider-error-classify.ts) — keep the unions in sync.
export type ProviderReasonKind =
  | "usage_gated" // authed, but the plan/subscription refuses requests (e.g. Claude "add usage")
  | "auth_invalid" // credentials present but rejected (401 / invalid)
  | "not_configured" // no credentials for this provider
  | "expired" // saved credentials expired — reconnect
  | "rate_limited" // temporarily throttled
  | "unknown"; // couldn't classify — show the raw text

export interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  available: boolean;
  models: { id: string; label?: string; isDefault?: boolean }[];
  modes: { id: string; label: string; description: string }[];
  defaultModeId: string | null;
  // Populated by the daemon when `available` is false (or when the runtime
  // probe errored): the EXACT, user-facing reason + its classified kind, so the
  // UI can show the right remedy instead of a generic "not connected".
  unavailableReason?: string | null;
  reasonKind?: ProviderReasonKind | null;
}

export interface AgentRuntimeInfo {
  provider: string;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: Record<string, unknown>;
}

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
}

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  // Marks a CLIENT-side Cyborg builtin (e.g. /status, /resume) injected into the
  // Claude agent-session palette. Optional + additive: provider-fetched commands
  // never set it, so the composer can tell a builtin (intercept, never send to
  // the agent) from a real provider slash command. Back-compat with the wire
  // shape (the relay only sends name/description/argumentHint).
  builtin?: "status" | "resume";
}

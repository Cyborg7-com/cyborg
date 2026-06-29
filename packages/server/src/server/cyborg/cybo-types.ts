import { z } from "zod";

// ─── MCP Server Config ─────────────────────────────────────────────────

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("sse"),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ─── Cybo capability vocabularies ───────────────────────────────────
// Canonical value sets for the cybo's power-source, behavior, and
// permission columns. Shared by the message schemas (validation) and
// the storage layer. UI mirrors these with its own labelled option lists.

// Cybo-facing power-source choice (persisted per cybo, set by the wizard). This is
// the DISCRIMINATOR that maps to the credential `type` in the per-daemon store
// (see cybo-credentials.ts credentialTypeForAuthMode, internal docs):
//   cli       → host login (no daemon-stored secret) — today's default, unchanged
//   api-key   → "api" credential (daemon-stored API key)
//   managed   → resolved by workspace (Phase 5, shared-PG) — not daemon-local
//   oauth     → "oauth" credential (subscription bearer + refresh) — opt-in
//   wellknown → "wellknown" credential (pre-shared key+token pair) — parity
// ADDITIVE: `api-key`/`managed` already shipped (column, migrations, relay, UI),
// so we EXTEND rather than rename — renaming a persisted column value is breaking.
export const LLM_AUTH_MODES = ["cli", "api-key", "managed", "oauth", "wellknown"] as const;
export type LlmAuthMode = (typeof LLM_AUTH_MODES)[number];

// DEPRECATED (kept for back-compat until S3 drops it — never rename a persisted
// column value). Superseded by the per-cybo autonomy_level dial below.
export const BEHAVIOR_MODES = ["responsive", "proactive"] as const;
export type BehaviorMode = (typeof BEHAVIOR_MODES)[number];

// ─── Cybo Autonomy — the per-cybo dial (S2, internal docs-2) ───────
// L0..L5 ranked levels; the cybo's disposition, travels with it across channels.
// The effective agency in a channel is min(cyboLevel, channelCeiling) — the channel
// side (regime/max_autonomy_level) lands in a later slice; this is the per-cybo half.
export const AUTONOMY_LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const AUTONOMY_RANK: Record<AutonomyLevel, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

// The 4 public presets surfaced in the UI (the single dial users actually set).
// Off = never wakes; Mention-only = wakes on @-mention; Active = may speak when
// relevant; Autonomous = self-initiates. (L2/L5 are power-user/advanced + swarm.)
export const AUTONOMY_PRESETS = [
  { id: "off", label: "Off", level: "L0" },
  { id: "mention", label: "Mention-only", level: "L1" },
  { id: "active", label: "Active", level: "L3" },
  { id: "autonomous", label: "Autonomous", level: "L4" },
] as const satisfies ReadonlyArray<{ id: string; label: string; level: AutonomyLevel }>;

// Migrate the deprecated behavior_mode → an autonomy level (responsive→L1,
// proactive→L3). Used as the fallback when autonomy_level is null (un-migrated row).
export function behaviorModeToLevel(mode: string | null | undefined): AutonomyLevel {
  return mode === "proactive" ? "L3" : "L1";
}

// ─── Codex approval policy (native codex harness) ───────────────────
// Cybos run UNATTENDED: one turn, then torn down, with no human watching
// a Codex approval prompt. The native Codex harness (codex-app-server)
// validates AgentSessionConfig.approvalPolicy against a STRICT enum:
//   untrusted | on-failure | on-request | granular | never
// The legacy literal "auto" is NOT a member, so the installed Codex
// rejected the first turn with `unknown variant "auto"`. (Only the Codex
// provider reads config.approvalPolicy — the Claude and Pi providers
// ignore it, so this value is effectively Codex-only.)
//
// We map the cybo's "Default Permissions" to `on-failure`: Codex runs
// commands inside its sandbox (the mode's default `workspace-write`)
// autonomously and only escalates when a sandboxed command actually
// fails — no per-action prompt to stall an unattended turn, while still
// keeping a safety valve. This is the closest valid match to the old
// "auto" (auto-proceed) intent.
export const CYBO_CODEX_APPROVAL_POLICY = "on-failure" as const;

export const PLATFORM_PERMISSIONS = [
  "send_message",
  "create_task",
  "manage_channels",
  "spawn_agents",
  // DEPRECATED (Phase 2 / #270): the channel read/interact tools
  // (cyborg7_read_channel / _react / _search) are now gated by CHANNEL MEMBERSHIP,
  // not by these grants — a cybo added to a channel can read/react/respond there.
  // These values are kept (not removed) only for backward compatibility: dropping
  // them from the enum would fail zod validation of cybos already saved with them
  // and break the WS create/update message schema. They are no longer read as tool
  // gates and should NOT be surfaced in the cybo create/edit form (UI follow-up).
  "read_messages",
  "react",
  "search",
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

// NOTE: off-platform capabilities (file edits / bash / network / git push) are
// POST-MVP. The earlier `off_platform_permissions` were UI-only — never enforced
// (cybos run on PI, whose provider doesn't honor allowedTools/disallowedTools), so
// they were a false security promise and were removed (remove-don't-disable). The
// physical `off_platform_permissions` column is left in the DB for back-compat but
// is no longer read or written. See internal docs

// ─── Cybo (customizable agent template) ─────────────────────────────

export const CyboSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/),

  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  avatar: z.string().optional(),
  role: z.string().max(100).optional(),

  soul: z.string().min(1).max(50000),

  provider: z.string(),
  model: z.string().optional(),
  mcpServers: z.record(z.string(), McpServerConfigSchema).optional(),
  llmAuthMode: z.enum(LLM_AUTH_MODES).default("cli"),
  behaviorMode: z.enum(BEHAVIOR_MODES).default("responsive"),
  // The cybo's explicit "home" daemon — the machine it lives on / runs on,
  // chosen at creation. Nullable: existing cybos (and disk cybos) have none, in
  // which case the spawn target falls back to the sponsor/selected daemon.
  homeDaemonId: z.string().nullable().optional(),
  autonomyLevel: z.enum(AUTONOMY_LEVELS).nullable().optional(),
  monthlySpendCap: z.number().int().nonnegative().nullable().optional(),
  platformPermissions: z.array(z.enum(PLATFORM_PERMISSIONS)).default([]),
  isDefault: z.boolean().default(false),

  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type Cybo = z.infer<typeof CyboSchema>;

// ─── Stored type (SQLite row shape, snake_case) ──────────────────────

export interface StoredCybo {
  id: string;
  workspace_id: string;
  slug: string;
  name: string;
  description: string | null;
  avatar: string | null;
  role: string | null;
  soul: string;
  provider: string;
  model: string | null;
  mcp_servers: string | null;
  llm_auth_mode: string;
  behavior_mode: string;
  // Explicit "home" daemon id (the machine the cybo lives on), or null.
  home_daemon_id: string | null;
  // Per-cybo autonomy dial (S2). Null on un-migrated rows → fall back via
  // behaviorModeToLevel(behavior_mode). One of AUTONOMY_LEVELS.
  autonomy_level: string | null;
  monthly_spend_cap: number | null;
  platform_permissions: string | null;
  is_default: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  // epoch ms — max(agent_sessions.updated_at) for this cybo. Computed at read
  // time (not a stored column): populated on the PG path (pg-sync.getCybos via
  // a LEFT JOIN), and defensively on the SQLite path when the local
  // agent_sessions table happens to carry cybo_id/updated_at. null when the
  // cybo has no sessions; absent/undefined on the SQLite path where it can't be
  // computed. Optional so neither store is forced to supply it.
  last_active_at?: number | null;
}

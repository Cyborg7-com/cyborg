// Daemon access scopes (#705). Replaces the binary daemon_access grant (one row =
// total access / RCE) with a small set of capability scopes. This module is the
// PURE, side-effect-free core of the access gate: the scope taxonomy, the
// type→scope mapping, and the allow decision. It has no DB/relay dependency so it
// can be unit-tested directly (CLI-first), and both the relay gate and the
// enforcement layer (pg-sync) import from here so there is a SINGLE source of
// truth for "which scope does this action need".
//
// The relay already partitions daemon actions into sets (DAEMON_*_TYPES in
// relay-standalone.ts); this just attaches each set to a scope. The mapping below
// is the canonical contract — keep it in lockstep with those sets.

// The four scopes. `admin` is a superset (implies chat+spawn+terminal+host) and is
// what every PRE-EXISTING grant migrates to, because a legacy grant WAS total
// access. The daemon owner is `admin` implicitly (resolved in pg-sync, not here).
export type DaemonScope = "chat" | "spawn" | "terminal" | "admin";

export const DAEMON_SCOPES: readonly DaemonScope[] = ["chat", "spawn", "terminal", "admin"];

export function isDaemonScope(value: unknown): value is DaemonScope {
  return value === "chat" || value === "spawn" || value === "terminal" || value === "admin";
}

// ─── Per-set scope assignment ────────────────────────────────────────
//
// These mirror the relay's DAEMON_*_TYPES sets. They are intentionally
// duplicated here (rather than imported from relay-standalone.ts, a 6k-line
// god-file that pulls in Hono/ws/etc.) so the pure gate stays dependency-free and
// trivially testable. The relay-standalone sets and these MUST agree; the test
// suite (daemon-scopes.test.ts) locks the mapping per type.

// chat: prompt/message EXISTING agents + all the read-only forwards (list_/fetch_)
// that let a member SEE a daemon they can't run code on. The relay's
// DAEMON_FORWARD_TYPES is the union of every forwarded type, so anything not
// claimed by a narrower (higher-privilege) set below falls through to `chat`.
//
// spawn: launch agents/cybos, run slash commands, manage schedules, and mutate an
// existing agent (set model/mode/thinking, rewind, archive, restore). NOTE:
// `start_terminal` is deliberately NOT here — it moved to `terminal` (a spawn-only
// user must not be able to open a host shell). This is an intentional hardening.
const SPAWN_TYPES = new Set<string>([
  "cyborg:create_agent",
  "cyborg:spawn_cybo",
  "cyborg:slash_command",
  // Schedule CRUD = configuring recurring code execution on a daemon.
  "cyborg:create_schedule",
  "cyborg:update_schedule",
  "cyborg:set_schedule_enabled",
  "cyborg:delete_schedule",
  "cyborg:run_schedule_once",
  // Built-in integrations (recipes): enabling provisions a cybo + schedules +
  // channel memberships, disabling deletes the cybo (cascade) — both configure
  // recurring code execution on a daemon, same authority tier as schedule CRUD
  // and spawn_cybo. add/remove cybo↔channel mutates daemon-owned cybo state.
  "cyborg:enable_recipe",
  "cyborg:disable_recipe",
  "cyborg:add_cybo_to_channel",
  "cyborg:remove_cybo_from_channel",
  // Agent-control (DAEMON_AGENT_CONTROL_TYPES) — mutating an existing agent folds
  // into `spawn` per the issue (a user who can spawn already controls what it
  // spawned; keeps the scope set small).
  "cyborg:set_agent_model",
  "cyborg:set_agent_mode",
  "cyborg:set_agent_thinking",
  "cyborg:rewind_agent",
  "cyborg:archive_agent",
  "cyborg:restore_session",
  // Importing a local provider transcript resumes a NEW live agent into the
  // workspace (it spawns), so it needs `spawn` — the SAME scope as
  // restore_session. Like restore_session it carries no agentId (provider +
  // handle + cwd, or a sessionId), so the relay routes both through its
  // special-case daemonId-resolution branch rather than the agentId-keyed gate.
  "cyborg:import_session",
]);

// terminal: open a shell on the host (start_terminal) + control an existing
// terminal session (input/resize/kill). High risk — direct host file access.
const TERMINAL_TYPES = new Set<string>([
  "cyborg:start_terminal",
  "cyborg:terminal_input",
  "cyborg:terminal_resize",
  "cyborg:kill_terminal",
  // Subscribe / unsubscribe to an existing session (internal docs): the
  // snapshot-on-(re)subscribe self-heal model. Control of an existing terminal, so
  // same scope as input/resize/kill.
  "cyborg:subscribe_terminal",
  "cyborg:unsubscribe_terminal",
]);

// admin: host-level control — update_daemon restarts the machine (RCE-grade), and
// the provider-credential RPCs write spend-capable auth to the host's encrypted
// store. Only `admin` (or owner) may do these; NOT covered by terminal/spawn. This
// set MUST match DAEMON_HOST_CONTROL_TYPES in the relay. NOTE daemon_update_latest is
// deliberately NOT here: it's a read-only npm-version probe (like cybo_cli_latest)
// that the relay forwards ungated, so it maps to `chat` and is never gated.
const ADMIN_TYPES = new Set<string>([
  "cyborg:update_daemon",
  // Provider credentials (internal docs): writing/removing a daemon's stored
  // provider auth grants spend-capable access on that host — admin-grade, same gate
  // as update_daemon. Listing is config disclosure, gated the same for consistency.
  "cyborg:set_cybo_credential",
  "cyborg:remove_cybo_credential",
  "cyborg:list_provider_auth",
  // Daemon-owner audit (#993): listing EVERY user's sessions (incl. ephemeral) on a
  // host is the same trust tier as host control — `admin` (owner implicit). Gated
  // here AND in the dispatcher (defense in depth).
  "cyborg:list_daemon_sessions",
]);

// Map a forwarded daemon action type to the scope required to perform it. Checked
// narrowest-first (admin → terminal → spawn → chat) because DAEMON_FORWARD_TYPES
// is a superset that contains the spawn/terminal/host types too. Anything not in a
// privileged set requires only `chat` (read-only forwards + prompting agents).
export function scopeForType(type: string): DaemonScope {
  if (ADMIN_TYPES.has(type)) return "admin";
  if (TERMINAL_TYPES.has(type)) return "terminal";
  if (SPAWN_TYPES.has(type)) return "spawn";
  return "chat";
}

// The allow decision: a caller may perform an action requiring `required` iff they
// hold that scope OR hold `admin` (the superset). Owner is mapped to all scopes
// upstream, so it satisfies every check here.
export function isScopeAllowed(scopes: ReadonlySet<DaemonScope>, required: DaemonScope): boolean {
  return scopes.has("admin") || scopes.has(required);
}

// Convenience for call-sites that have a type + a scope set: combines the mapping
// and the allow decision. `allowType(scopes, type)` answers "can this caller run
// this forwarded type on the daemon they hold `scopes` on?".
export function allowType(scopes: ReadonlySet<DaemonScope>, type: string): boolean {
  return isScopeAllowed(scopes, scopeForType(type));
}

// Normalize a raw scopes value read from PG (text[]). Defensive fail-safe: a
// null/undefined value OR an empty set from a row that somehow lost its scopes is
// treated as `admin`, preserving the legacy "a grant = total access" behavior.
// Note the DB column is `text[] NOT NULL DEFAULT '{admin}'`, so a stored row is
// never NULL (existing + old-relay INSERTs get the {admin} default); the null
// branch here only guards non-DB callers. Unknown strings are dropped. A row that
// genuinely has no access is represented by the ROW NOT EXISTING, never by an
// empty scopes array, so coercing empty→admin here is safe.
export function normalizeScopes(raw: readonly string[] | null | undefined): Set<DaemonScope> {
  if (raw == null) return new Set<DaemonScope>(["admin"]);
  const valid = raw.filter(isDaemonScope);
  if (valid.length === 0) return new Set<DaemonScope>(["admin"]);
  return new Set<DaemonScope>(valid);
}

// ─── UI role presets (#705 UX refinement) ────────────────────────────
//
// Shared so the relay/tests and the UI agree on what a role means. A role is a
// named, common bundle of scopes; the UI also offers a per-scope override
// ("custom"). Kept here (pure) so the preset→scopes mapping is unit-testable and
// the server can validate/label a stored set the same way the UI renders it.
export type DaemonRole = "viewer" | "operator" | "admin" | "custom";

export const ROLE_PRESETS: Record<Exclude<DaemonRole, "custom">, DaemonScope[]> = {
  // Viewer: prompt existing agents only (no spawning, no shell, no host control).
  viewer: ["chat"],
  // Operator: prompt + spawn/schedule/agent-control. No shell, no host control.
  operator: ["chat", "spawn"],
  // Admin: full access incl. host update (RCE). Stored as the single `admin` scope
  // (the superset) rather than the expanded list, so it stays the canonical
  // "total access" grant and matches owner semantics.
  admin: ["admin"],
};

// The scopes a preset selects (sorted, deduped). For `admin` this is `["admin"]`.
export function scopesForRole(role: Exclude<DaemonRole, "custom">): DaemonScope[] {
  return [...ROLE_PRESETS[role]];
}

// Classify an arbitrary stored scope set back to a role for display (collapsed
// badge). `admin` (or any set containing it) → "admin"; an exact match of a
// preset → that preset; anything else → "custom".
export function roleForScopes(raw: readonly string[] | null | undefined): DaemonRole {
  const scopes = normalizeScopes(raw);
  if (scopes.has("admin")) return "admin";
  const sorted = [...scopes].sort().join(",");
  if (sorted === [...ROLE_PRESETS.operator].sort().join(",")) return "operator";
  if (sorted === [...ROLE_PRESETS.viewer].sort().join(",")) return "viewer";
  return "custom";
}

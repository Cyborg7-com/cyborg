// Daemon access scopes — UI mirror of the server taxonomy (#705). The UI can't
// import server code (separate package), so the scope set, role presets, and
// human micro-copy live here as the single client-side source of truth. Keep in
// lockstep with packages/server/src/server/cyborg/daemon-scopes.ts.
//
// Pure + dependency-free so the preset↔scopes mapping is unit-testable and the
// matrix component stays declarative.

export type DaemonScope = "chat" | "spawn" | "terminal" | "admin";

// The scopes the role-preset matrix exposes as columns, in display order. `admin`
// is presented as a separate "full access" toggle (the role), not a column.
export const SCOPE_COLUMNS: readonly Exclude<DaemonScope, "admin">[] = [
  "chat",
  "spawn",
  "terminal",
];

// A role is a named bundle of scopes; `custom` = an arbitrary per-scope set.
export type DaemonRole = "viewer" | "operator" | "admin" | "custom";

// Preset → scopes. Admin is stored as the single `admin` superset scope (matches
// owner semantics + the server), the others as their explicit scope list.
export const ROLE_PRESETS: Record<Exclude<DaemonRole, "custom">, DaemonScope[]> = {
  viewer: ["chat"],
  operator: ["chat", "spawn"],
  admin: ["admin"],
};

export const ROLE_ORDER: readonly Exclude<DaemonRole, "custom">[] = ["viewer", "operator", "admin"];

export interface RoleMeta {
  label: string;
  blurb: string;
}

// Human labels for the role selector.
export const ROLE_META: Record<Exclude<DaemonRole, "custom">, RoleMeta> = {
  viewer: { label: "Viewer", blurb: "Message existing agents only" },
  operator: { label: "Operator", blurb: "Launch agents + schedule tasks" },
  admin: { label: "Admin", blurb: "Full access incl. host update (RCE)" },
};

export interface ScopeMeta {
  label: string;
  // Inline human micro-copy describing exactly what the scope permits.
  blurb: string;
  // RCE-adjacent scopes that must trigger the #35 confirmation when enabled.
  rce: boolean;
}

export const SCOPE_META: Record<DaemonScope, ScopeMeta> = {
  chat: { label: "Chat", blurb: "Message existing agents", rce: false },
  spawn: { label: "Spawn", blurb: "Launch agents/cybos + schedule tasks", rce: false },
  terminal: { label: "Terminal", blurb: "Open a shell (host file access)", rce: true },
  admin: {
    label: "Admin",
    blurb: "Everything + update/restart the host (runs code, RCE)",
    rce: true,
  },
};

export function isDaemonScope(value: unknown): value is DaemonScope {
  return value === "chat" || value === "spawn" || value === "terminal" || value === "admin";
}

// Normalize a raw scopes value (from the relay). Back-compat: null/empty/all-invalid
// → admin (legacy total-access fail-safe, mirrors the server). A no-access user has
// no access ENTRY at all, so this is only ever called on a present grant.
export function normalizeScopes(raw: readonly string[] | null | undefined): DaemonScope[] {
  if (raw == null) return ["admin"];
  const valid = raw.filter(isDaemonScope);
  return valid.length === 0 ? ["admin"] : [...new Set(valid)];
}

export function scopesForRole(role: Exclude<DaemonRole, "custom">): DaemonScope[] {
  return [...ROLE_PRESETS[role]];
}

// Classify a stored scope set to a role for the collapsed badge. admin (or any set
// containing it) → admin; exact preset match → that preset; else custom.
export function roleForScopes(raw: readonly string[] | null | undefined): DaemonRole {
  const scopes = normalizeScopes(raw);
  if (scopes.includes("admin")) return "admin";
  const key = [...scopes].sort().join(",");
  if (key === [...ROLE_PRESETS.operator].sort().join(",")) return "operator";
  if (key === [...ROLE_PRESETS.viewer].sort().join(",")) return "viewer";
  return "custom";
}

// Whether enabling/keeping this scope set requires the #35 RCE confirmation:
// true when it grants `terminal` or `admin` (a host shell or host control). Used
// to gate the confirm dialog when escalating a grant.
export function scopesRequireRceConfirm(scopes: readonly DaemonScope[]): boolean {
  return scopes.some((s) => SCOPE_META[s].rce);
}

// The RCE scopes newly introduced going from `prev` → `next` (for the confirm
// copy: "you're enabling Terminal / Admin"). Empty ⇒ no new RCE surface ⇒ no
// confirmation needed (e.g. de-escalating, or a chat/spawn-only change).
export function newlyEscalatedRceScopes(
  prev: readonly DaemonScope[],
  next: readonly DaemonScope[],
): DaemonScope[] {
  const before = new Set(prev);
  return next.filter((s) => SCOPE_META[s].rce && !before.has(s));
}

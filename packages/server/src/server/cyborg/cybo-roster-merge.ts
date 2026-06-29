// Workspace cybo roster merge + id resolution (the "Cybo not found on EDIT"
// fix, post-#413).
//
// THE BUG, traced with the real prod rows: apex exists in PG
// (id cybo_d46b…, workspace dae6aa9f…), but the roster the client sees is the
// answering DAEMON's fetch_cybos response merged with PG — and the old merge
// SKIPPED a PG row whenever the daemon already listed the same slug
// (`seenSlugs.has(c.slug) → continue`). A daemon-local duplicate of apex
// (a stale SQLite row from a failed PG mirror, or the disk copy `local:apex`)
// therefore SHADOWED the PG row, the Edit page navigated with the daemon-local
// id, and the relay's update_cybo — which resolves strictly by id against
// pg.getCybos — answered "Cybo not found" even though apex is right there.
//
// Two-part fix:
//   1. mergePgCybosIntoRoster: PG is AUTHORITATIVE for workspace cybos — on an
//      id OR slug collision the PG row REPLACES the daemon entry (so the roster
//      carries the PG id and Edit/Delete/token flows resolve). Daemon-only
//      entries (true local cybos with no PG counterpart) stay, with their
//      isLocal/daemonId provenance intact.
//   2. resolveWorkspaceCybo: tolerant id resolution for the mutation handlers —
//      exact id, else a `local:<slug>` id matches by slug, else the raw value
//      matches a slug. Covers clients holding a pre-fix roster.

export interface PgCyboRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  avatar: string | null;
  role: string | null;
  provider: string;
  model: string | null;
  llm_auth_mode: string;
  behavior_mode: string;
  home_daemon_id: string | null;
  autonomy_level?: string | null;
  monthly_spend_cap: number | null;
  platform_permissions: string | null;
  is_default: number;
  created_at: number;
  // epoch ms — max(agent_sessions.updated_at) for this cybo (PG read path).
  // Optional/nullable: null when the cybo has no sessions, absent on rows from
  // a store that doesn't compute it.
  last_active_at?: number | null;
}

export function pgCyboToRosterEntry(c: PgCyboRow): Record<string, unknown> {
  // Defensive parse: the column is JSON-text, but a valid-JSON non-array (or
  // an array with non-string members) must degrade to [] instead of polluting
  // the typed roster entry.
  let perms: string[] = [];
  try {
    const parsed: unknown = c.platform_permissions ? JSON.parse(c.platform_permissions) : null;
    if (Array.isArray(parsed)) perms = parsed.filter((v): v is string => typeof v === "string");
  } catch {
    perms = [];
  }
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    description: c.description,
    avatar: c.avatar,
    role: c.role,
    provider: c.provider,
    model: c.model,
    llmAuthMode: c.llm_auth_mode,
    behaviorMode: c.behavior_mode,
    // Carry the cybo's explicit home daemon so the roster/UI can show
    // "lives on X". null for cybos created before this column existed.
    homeDaemonId: c.home_daemon_id,
    autonomyLevel: c.autonomy_level ?? null,
    monthlySpendCap: c.monthly_spend_cap,
    platformPermissions: perms,
    isDefault: c.is_default === 1,
    createdAt: c.created_at,
    isLocal: false,
    daemonId: null,
    // Server-computed "last active" (epoch ms). null when no sessions yet.
    lastActiveAt: c.last_active_at ?? null,
  };
}

// Merge the PG (workspace-authoritative) cybos into a daemon's fetch_cybos
// list, IN PLACE (the relay forwards the same payload object). PG wins id and
// slug collisions.
//
// STRICT ISOLATION (decided 2026-06: "PG is the only truth" for the cloud
// workspace roster): after merging, any daemon-SQLite straggler that is NEITHER
// a PG row for THIS workspace NOR a disk (`local:`) cybo is DROPPED. Such an
// entry is a stale/leaked copy — e.g. a cybo whose canonical PG row lives in a
// DIFFERENT workspace but which a daemon's SQLite still scopes here — and must
// not leak into this workspace's roster. (Previously these survived; that let
// "Apex personal" from one workspace appear in another. The cloud invariant is
// that every real workspace cybo has a PG row, so a non-PG non-disk entry here
// is by definition stale.) Disk (`local:`) cybos are kept — they legitimately
// live only on their daemon's machine and have no PG counterpart.
export function mergePgCybosIntoRoster(
  list: Record<string, unknown>[],
  pgCybos: readonly PgCyboRow[],
): void {
  const pgIds = new Set(pgCybos.map((c) => c.id));
  for (const c of pgCybos) {
    const entry = pgCyboToRosterEntry(c);
    const collides = (e: Record<string, unknown>): boolean =>
      e.id === c.id || (typeof e.slug === "string" && e.slug === c.slug);
    const first = list.findIndex(collides);
    if (first >= 0) {
      // The daemon listed local duplicate(s) (stale SQLite row from a failed PG
      // mirror, and/or the disk copy) — the PG row is the workspace's real
      // cybo, so it replaces the first duplicate and any FURTHER duplicates are
      // dropped (a daemon can list both a SQLite copy and a local:<slug> disk
      // copy of the same slug). This is what puts the PG id in the roster.
      list[first] = entry;
      for (let i = list.length - 1; i > first; i--) {
        if (collides(list[i])) list.splice(i, 1);
      }
    } else {
      list.push(entry);
    }
  }
  // Strict-isolation sweep: keep only PG rows + disk (`local:`) cybos.
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    const isDisk = e.isLocal === true || (typeof e.id === "string" && e.id.startsWith("local:"));
    const isPg = typeof e.id === "string" && pgIds.has(e.id);
    if (!isDisk && !isPg) list.splice(i, 1);
  }
}

// Tolerant cybo resolution for the relay's mutation handlers (update/delete):
// exact id first, then `local:<slug>` by slug, then the raw value as a slug.
// Lets a client holding a pre-fix (shadowed) roster still hit the PG row.
export function resolveWorkspaceCybo<T extends { id: string; slug: string }>(
  cybos: readonly T[],
  cyboId: string,
): T | undefined {
  const byId = cybos.find((c) => c.id === cyboId);
  if (byId) return byId;
  const slug = cyboId.startsWith("local:") ? cyboId.slice("local:".length) : cyboId;
  return cybos.find((c) => c.slug === slug);
}

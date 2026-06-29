// ─── Live terminal sessions (client-only, additive) ────────────────────────
// Terminal sessions (#656) are DAEMON-scoped and NOT persisted to PostgreSQL,
// so — unlike agent sessions — they never appear in the sidebar's session list
// (`sessionState.list` = listArchivedSessions). After starting a terminal and
// switching tabs there was no way back to the live daemon pty (#701). We can't
// add a PG/protocol path for an ephemeral resource, so we track the open
// terminals CLIENT-side here and render a "Terminals" sidebar section from it.
//
// The list is persisted to localStorage so a tab switch OR a full reload still
// surfaces the entry (the daemon pty outlives the page; the entry is just the
// pointer back to it). Entries are removed on cyborg:terminal_exit (the daemon
// killed the pty) or when the user dismisses the row. localStorage access is
// guarded for SSR / adapter-static prerender exactly like FavoritesState.

const STORAGE_KEY = "cyborg7_terminal_sessions";
// Persisted dismissals (see _dismissed). Separate key so the list and the
// suppression set evolve independently.
const DISMISSED_STORAGE_KEY = "cyborg7_terminal_dismissed";
// Bound the persisted dismissed set so it can't grow without limit over the life
// of the install (terminalIds are unique UUIDs, so old ones never need recall).
const MAX_DISMISSED = 500;

export interface TerminalSessionEntry {
  // The daemon-issued session id (#657 start_terminal_response.terminalId). The
  // sidebar route + emulator are keyed by this.
  terminalId: string;
  // The daemon the pty runs on — carried so the row can rebuild the ?daemon=
  // link and the emulator targets the right daemon for input/resize/kill.
  daemonId: string;
  // Scopes the entry to a workspace so forWorkspace() can filter the sidebar.
  workspaceId: string;
  // Display label: the cwd basename ("Terminal" when unknown).
  title: string;
  // Epoch ms the session was opened (for stable ordering / future "Xm ago").
  startedAt: number;
}

// A daemon directory-feed entry as delivered over the wire (a subset of the
// ws-client TerminalDirectoryEntry). Kept structural so this state module stays
// decoupled from the client type. cwd drives the row title when the daemon omits one.
export interface TerminalDirectoryDelivery {
  terminalId: string;
  workspaceId: string;
  daemonId?: string | null;
  cwd?: string | null;
  title?: string;
  startedAt?: number;
}

// Derive a row label from a session cwd: the trailing path segment ("repo" for
// /home/me/repo), falling back to "Terminal" for an empty/root/unknown cwd.
// Handles both POSIX and Windows separators since the daemon may run on either.
export function terminalTitle(cwd: string | null | undefined): string {
  if (!cwd) return "Terminal";
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]+/);
  const last = parts[parts.length - 1]?.trim();
  return last && last !== "~" ? last : "Terminal";
}

// A localStorage shape guard: only accept well-formed entries when hydrating so
// a corrupt/partial blob (or a value written by an older build) can't poison the
// rune with `undefined` fields the sidebar then renders.
function isEntry(value: unknown): value is TerminalSessionEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.terminalId === "string" &&
    typeof e.daemonId === "string" &&
    typeof e.workspaceId === "string" &&
    typeof e.title === "string" &&
    typeof e.startedAt === "number"
  );
}

export class TerminalSessionsState {
  // Insertion-ordered list of open terminal sessions across all workspaces;
  // forWorkspace() filters it. Every mutation reassigns the array so Svelte's
  // runes observe the change (matches FavoritesState).
  private _sessions: TerminalSessionEntry[] = $state(hydrate());

  // terminalIds known to be tracked by the DAEMON directory feed (terminal CLI-UI
  // unification). A terminal in this set that DISAPPEARS from a later directory
  // snapshot was killed on the daemon (CLI kill, another client) and is removed from
  // the sidebar. Client-started rows that haven't yet appeared in a snapshot are NOT
  // in here, so a fresh local start is never pruned by a racing stale snapshot.
  private _directorySourced = new Set<string>();

  // terminalIds the user explicitly dismissed from the sidebar. The terminal
  // ROUTE re-add()s the session it's viewing on every mount/reactive pass (#701),
  // so a plain remove() of the currently-viewed terminal is instantly resurrected
  // by that $effect and the row can never be cleared — corrupted/dead sessions
  // the user keeps open are exactly this case. Recording the dismissal here makes
  // add() ignore that id, so removal sticks regardless of which view is mounted.
  // terminalIds are daemon-issued and unique per session, so this never blocks a
  // genuinely new terminal.
  //
  // PERSISTED (not just in-memory): the dismissal must survive a reload/app update.
  // A best-effort `cyborg:kill_terminal` that doesn't land (a cold/remote daemon, a
  // detached pty-host that misses the signal) leaves the pty ALIVE, so the daemon's
  // directory feed keeps reporting it and ingestDirectory re-add()s it on the next
  // launch — the "I closed it 5 times and it keeps coming back" bug. Persisting the
  // suppression makes the row stay gone from the user's view regardless of whether
  // the kill succeeded.
  private _dismissed = new Set<string>(hydrateDismissed());

  // All tracked terminals for a workspace, oldest first. Returns a plain array
  // so the sidebar can map it directly.
  forWorkspace(workspaceId: string): TerminalSessionEntry[] {
    return this._sessions.filter((s) => s.workspaceId === workspaceId);
  }

  // Track a newly opened terminal. Idempotent on terminalId — a direct nav /
  // reload that re-adds an already-tracked session is a no-op (the dialog adds
  // it on launch; the route re-adds it on mount), so neither path duplicates a
  // row. A terminalId the user explicitly dismissed is also ignored, so the
  // still-mounted terminal route can't resurrect a just-removed row.
  add(entry: TerminalSessionEntry): void {
    if (!entry.terminalId || !entry.workspaceId) return;
    if (this._dismissed.has(entry.terminalId)) return;
    if (this._sessions.some((s) => s.terminalId === entry.terminalId)) return;
    this._sessions = [...this._sessions, entry];
    this.persist();
  }

  // Merge a DAEMON directory snapshot for one workspace into the tracked list
  // (terminal CLI-UI unification). This is how a terminal opened out-of-band — via
  // the CLI `cyborg terminal create --workspace`, or by another of the user's
  // clients — appears in THIS client's sidebar without it having started the pty.
  //
  // Reconciliation, workspace-scoped:
  //  • Each snapshot entry is add()ed (idempotent on terminalId, skips dismissed),
  //    so a daemon-tracked terminal shows up as a row.
  //  • A terminalId previously seen in a snapshot for this workspace that is now
  //    ABSENT was killed on the daemon → remove it (so a CLI kill clears the row).
  //  • Client-started rows not yet in any snapshot are left untouched (a racing
  //    snapshot taken before the start landed must not prune a just-opened terminal).
  ingestDirectory(workspaceId: string, entries: TerminalDirectoryDelivery[]): void {
    const present = new Set<string>();
    for (const entry of entries) {
      if (!entry.terminalId || entry.workspaceId !== workspaceId) continue;
      present.add(entry.terminalId);
      this._directorySourced.add(entry.terminalId);
      this.add({
        terminalId: entry.terminalId,
        daemonId: entry.daemonId ?? "",
        workspaceId,
        title: entry.title || terminalTitle(entry.cwd),
        startedAt: entry.startedAt ?? Date.now(),
      });
    }
    // Drop directory-sourced rows for THIS workspace that vanished from the snapshot
    // (daemon-side kill). Snapshot first — remove() reassigns the array.
    const stale = this._sessions.filter(
      (s) =>
        s.workspaceId === workspaceId &&
        this._directorySourced.has(s.terminalId) &&
        !present.has(s.terminalId),
    );
    for (const s of stale) {
      this._directorySourced.delete(s.terminalId);
      this.remove(s.terminalId);
    }
  }

  // Stop tracking a terminal because the daemon killed its pty
  // (cyborg:terminal_exit). Removing one that isn't tracked is a no-op. Does NOT
  // mark the id dismissed — the session is genuinely gone and its unique id can
  // never recur, so there's nothing to suppress.
  remove(terminalId: string): void {
    if (!this._sessions.some((s) => s.terminalId === terminalId)) return;
    this._sessions = this._sessions.filter((s) => s.terminalId !== terminalId);
    this.persist();
  }

  // The user dismissed the row from the sidebar. Records the dismissal first so a
  // still-mounted terminal route can't re-add() it, then drops the entry. Always
  // succeeds whether or not the row was tracked — the route may not have add()ed
  // it yet, and removal must not depend on that (nor on the best-effort pty kill).
  dismiss(terminalId: string): void {
    if (!terminalId) return;
    this._dismissed.add(terminalId);
    this.persistDismissed();
    this.remove(terminalId);
  }

  private persist(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._sessions));
    } catch {
      // intentional: best-effort persistence of the terminal list; not user-facing.
    }
  }

  // Persist the dismissed set (bounded, newest-kept). Insertion order in a Set is
  // chronological, so the last MAX_DISMISSED entries are the most recent.
  private persistDismissed(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const ids = [...this._dismissed];
      const bounded = ids.length > MAX_DISMISSED ? ids.slice(ids.length - MAX_DISMISSED) : ids;
      if (bounded.length !== ids.length) this._dismissed = new Set(bounded);
      localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(bounded));
    } catch {
      // intentional: best-effort; a lost dismissal just risks the row reappearing.
    }
  }
}

// Hydrate-time cap (internal docs §#10 — RAM bound). The list is persisted across
// launches and only shrinks on cyborg:terminal_exit / dismiss — a daemon restart
// does NOT emit exit, so dead rows accumulate indefinitely. The keep-alive host
// already mounts only a small capped subset (so dead rows no longer spawn xterms
// on launch), but we ALSO bound the persisted/rehydrated list itself so it can't
// grow without limit. Keep the most recent MAX_HYDRATED_SESSIONS (newest first by
// startedAt) — a generous bound; the live xterm count is bounded far tighter at
// the host. The next persist() rewrites the trimmed list back.
const MAX_HYDRATED_SESSIONS = 30;

// Read the persisted list once at module init. Kept as a free function (not a
// method) so the field initializer above can seed the rune synchronously.
function hydrate(): TerminalSessionEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(isEntry);
    if (valid.length <= MAX_HYDRATED_SESSIONS) return valid;
    // Over the cap: keep the newest by startedAt, then restore insertion order so
    // the sidebar ordering is unchanged for the rows that survive.
    const keep = new Set(
      [...valid].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_HYDRATED_SESSIONS),
    );
    return valid.filter((e) => keep.has(e));
  } catch {
    // intentional: best-effort hydrate; falls back to an empty list.
    return [];
  }
}

// Read the persisted dismissed-id set once at module init (mirrors hydrate()).
// Tolerates a missing/corrupt blob and an over-cap list (keep the newest).
function hydrateDismissed(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((v): v is string => typeof v === "string");
    return ids.length > MAX_DISMISSED ? ids.slice(ids.length - MAX_DISMISSED) : ids;
  } catch {
    return [];
  }
}

export const terminalSessionsState = new TerminalSessionsState();

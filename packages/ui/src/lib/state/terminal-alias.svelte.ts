// Per-user, display-only aliases (local tags) for terminals, keyed by terminalId.
// Mirrors session-alias.svelte.ts (the "rename" affordance the user knows from
// sessions). Server-backed via the `cyborg:*_terminal_alias*` RPCs so a rename
// SYNCS across the user's devices: load() hydrates the mirror from the DB on
// connect (source of truth), set/clear apply OPTIMISTICALLY and persist
// best-effort, and a live `cyborg:terminal_alias_changed` broadcast keeps the
// user's other open clients in step without a reload.
//
// localStorage is kept as a FALLBACK so the feature still works offline and in
// solo/SQLite mode (no PG): the mirror is seeded from it on construction and
// every change is also written back, so a disconnected device keeps its aliases.
// Cosmetic only — the underlying pty title is unchanged, and aliases are never
// shown to other users (a terminal is private to whoever opened it).
const STORAGE_KEY = "cyborg7-terminal-aliases";

// Minimal client surface so this module doesn't depend on the concrete WS client.
interface TerminalAliasClient {
  setTerminalAlias(terminalId: string, alias: string, workspaceId?: string): Promise<void>;
  getTerminalAliases(): Promise<Record<string, string>>;
  onTerminalAliasChanged(
    handler: (payload: { terminalId: string; alias: string }) => void,
  ): () => void;
}

class TerminalAliasState {
  private aliases = $state<Record<string, string>>({});
  // Set by load(); used by set/clear to persist to the server. Null until
  // connected → local-only (localStorage fallback).
  private client: TerminalAliasClient | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.aliases = JSON.parse(raw) as Record<string, string>;
    } catch {
      // intentional: a blocked/corrupt store just means no aliases yet.
    }
  }

  // The alias for a terminal, or undefined when none is set (→ use the pty title).
  get(terminalId: string): string | undefined {
    return this.aliases[terminalId];
  }

  // Hydrate from the server for the current user and subscribe to live changes.
  // Call once on connect (global, not per-workspace). Stores the client so later
  // set/clear can persist. Best-effort: a failure leaves whatever is already in
  // the mirror (the localStorage-seeded map), so solo/offline mode still works.
  async load(client: TerminalAliasClient): Promise<void> {
    this.client = client;
    this.unsubscribe?.();
    this.unsubscribe = client.onTerminalAliasChanged((p) =>
      this.applyRemote(p.terminalId, p.alias),
    );
    try {
      this.aliases = await client.getTerminalAliases();
      this.persist();
    } catch {
      // intentional: persistence is best-effort; keep the localStorage-seeded mirror.
    }
  }

  // Set/replace the alias. An empty/whitespace value clears it (back to default).
  // workspaceId is an optional routing hint so the server can fan the change out
  // to the user's other clients live.
  set(terminalId: string, alias: string, workspaceId?: string): void {
    const trimmed = alias.trim();
    if (!trimmed) {
      this.clear(terminalId, workspaceId);
      return;
    }
    // Mutate the $state record in place so only this key's subscribers re-run.
    this.aliases[terminalId] = trimmed;
    this.persist();
    // intentional: optimistic alias persist; re-syncs from server truth on the next load.
    this.client?.setTerminalAlias(terminalId, trimmed, workspaceId).catch(() => {});
  }

  clear(terminalId: string, workspaceId?: string): void {
    if (!(terminalId in this.aliases)) return;
    delete this.aliases[terminalId];
    this.persist();
    // intentional: best-effort delete persist (empty alias = server delete); re-reconciled on the next load.
    this.client?.setTerminalAlias(terminalId, "", workspaceId).catch(() => {});
  }

  // Apply a change pushed from one of the user's OTHER devices. An empty alias
  // means it was cleared. Local-only (no RPC echo) — this IS the server truth.
  private applyRemote(terminalId: string, alias: string): void {
    const trimmed = alias.trim();
    if (trimmed) {
      this.aliases[terminalId] = trimmed;
    } else {
      if (!(terminalId in this.aliases)) return;
      delete this.aliases[terminalId];
    }
    this.persist();
  }

  private persist(): void {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.aliases));
    } catch {
      // intentional: best-effort persistence of the local alias map.
    }
  }
}

export const terminalAlias = new TerminalAliasState();

// Per-user, display-only aliases (local tags) for agent sessions, keyed by
// agentId. A purely cosmetic affordance so the user can spot a session — it has
// NO other function and is NEVER shown to other users.
//
// Persisted PER-USER in the isolated `session_aliases` table (relay-direct, via
// the RPCs below). The $state mirror updates OPTIMISTICALLY: set/clear apply
// locally first and fire the RPC best-effort, so a failed/absent connection
// still keeps the alias visible this session (it just won't persist). On
// connect, load() hydrates the mirror from the server (source of truth).

// Minimal client surface so this module doesn't depend on the concrete WS client.
interface AliasClient {
  setSessionAlias(agentId: string, alias: string): Promise<void>;
  getSessionAliases(): Promise<Record<string, string>>;
}

class SessionAliasState {
  private aliases = $state<Record<string, string>>({});
  // Set by load(); used by set/clear to persist. Null until connected → local-only.
  private client: AliasClient | null = null;

  // The alias for an agent, or undefined when none is set (→ use the default name).
  get(agentId: string): string | undefined {
    return this.aliases[agentId];
  }

  // Hydrate from the server for the current user. Call once on connect (global,
  // not per-workspace). Stores the client so later set/clear can persist.
  // Best-effort: a failure leaves whatever is already in the mirror.
  async load(client: AliasClient): Promise<void> {
    this.client = client;
    try {
      this.aliases = await client.getSessionAliases();
    } catch {
      // Persistence is best-effort; keep the current (possibly empty) mirror.
    }
  }

  // Set/replace the alias. An empty/whitespace value clears it (back to default).
  set(agentId: string, alias: string): void {
    const trimmed = alias.trim();
    if (!trimmed) {
      this.clear(agentId);
      return;
    }
    this.aliases = { ...this.aliases, [agentId]: trimmed };
    // intentional: optimistic alias persist; re-syncs from server truth on the next session load.
    this.client?.setSessionAlias(agentId, trimmed).catch(() => {});
  }

  clear(agentId: string): void {
    if (!(agentId in this.aliases)) return;
    const next = { ...this.aliases };
    delete next[agentId];
    this.aliases = next;
    // intentional: best-effort delete persist (empty alias = server delete); re-reconciled on the next session load.
    this.client?.setSessionAlias(agentId, "").catch(() => {});
  }
}

export const sessionAlias = new SessionAliasState();

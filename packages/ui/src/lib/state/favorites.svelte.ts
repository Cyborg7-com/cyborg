// ─── Channel / DM / agent favorites (client-only, additive) ─────────
// Slack/Mattermost parity: users can "star" any sidebar target (channel, DM
// peer, or agent session) to pin it to a dedicated "Favorites" section at the
// top of the sidebar. This is purely a CLIENT-SIDE convenience — favorites are
// persisted to localStorage (keyed by the bound user id, mirroring
// NotificationState / UnreadFlagState) and never sent to the relay, so the
// feature is fully additive and needs no server change.
//
// Stored shape: workspaceId → Set<targetId>. `targetId` is a channel id, a DM
// peer userId, or an agentId — the same identifier the sidebar already uses for
// notification counts, so a single Set covers every favoritable row type.

const FAVORITES_BASE = "cyborg7_favorites";

export class FavoritesState {
  // workspaceId → Set<targetId>. Held as a $state object of Sets; every mutation
  // reassigns the object so Svelte's runes observe the change (matches the
  // UnreadFlagState pattern in core/state.svelte.ts).
  private _favorites: Record<string, Set<string>> = $state({});
  private _boundUserId: string | null = null;

  private get storageKey(): string {
    return this._boundUserId ? `${FAVORITES_BASE}_${this._boundUserId}` : FAVORITES_BASE;
  }

  // Bind to the signed-in user and hydrate from localStorage. Called once at
  // login (alongside notificationState.bindUser / unreadFlagState.bindUser).
  bindUser(userId: string): void {
    this._boundUserId = userId;
    this._favorites = {};
    if (typeof localStorage === "undefined") return;
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const next: Record<string, Set<string>> = {};
          for (const [ws, ids] of Object.entries(parsed)) {
            if (Array.isArray(ids)) {
              next[ws] = new Set(ids.filter((id): id is string => typeof id === "string"));
            }
          }
          this._favorites = next;
        }
      }
    } catch {
      // intentional: best-effort hydrate of favorites; falls back to empty.
    }
  }

  clearLocal(): void {
    this._boundUserId = null;
    this._favorites = {};
  }

  isFavorite(workspaceId: string, targetId: string): boolean {
    return this._favorites[workspaceId]?.has(targetId) ?? false;
  }

  add(workspaceId: string, targetId: string): void {
    if (!workspaceId || !targetId) return;
    const ws = this._favorites[workspaceId] ?? new Set<string>();
    if (ws.has(targetId)) return;
    const next = new Set(ws);
    next.add(targetId);
    this._favorites = { ...this._favorites, [workspaceId]: next };
    this.persist();
  }

  remove(workspaceId: string, targetId: string): void {
    const ws = this._favorites[workspaceId];
    if (!ws?.has(targetId)) return;
    const next = new Set(ws);
    next.delete(targetId);
    this._favorites = { ...this._favorites, [workspaceId]: next };
    this.persist();
  }

  toggle(workspaceId: string, targetId: string): void {
    if (this.isFavorite(workspaceId, targetId)) this.remove(workspaceId, targetId);
    else this.add(workspaceId, targetId);
  }

  // The ordered (insertion-order) list of favorite ids for a workspace. Returns a
  // plain array so callers can map it to channels/members directly.
  list(workspaceId: string): string[] {
    const ws = this._favorites[workspaceId];
    return ws ? [...ws] : [];
  }

  // True when the workspace has at least one favorite — lets the sidebar hide the
  // Favorites section entirely when empty.
  hasAny(workspaceId: string): boolean {
    return (this._favorites[workspaceId]?.size ?? 0) > 0;
  }

  private persist(): void {
    if (typeof localStorage === "undefined") return;
    try {
      const serializable: Record<string, string[]> = {};
      for (const [ws, ids] of Object.entries(this._favorites)) serializable[ws] = [...ids];
      localStorage.setItem(this.storageKey, JSON.stringify(serializable));
    } catch {
      // intentional: best-effort persistence of favorites; not user-facing.
    }
  }
}

export const favoritesState = new FavoritesState();

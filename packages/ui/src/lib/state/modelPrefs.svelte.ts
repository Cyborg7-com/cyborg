// Favorite + recent model preferences, persisted to localStorage.
//
// Model ids are stored globally (provider-qualified strings such as
// "anthropic/claude-..."). The selector only ever shows ids that exist in the
// catalog it is handed, so stale ids for uninstalled providers simply never
// render — no cleanup needed.

const FAVORITES_KEY = "cyborg7-model-favorites";
const RECENTS_KEY = "cyborg7-model-recents";
const CUSTOM_KEY = "cyborg7-model-custom";
const MAX_RECENTS = 5;

function readStored(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

class ModelPrefsState {
  favorites: string[] = $state([]);
  recents: string[] = $state([]);
  // User-entered model ids that aren't in any provider catalog. The selector
  // merges these into its list so they can be picked again without retyping.
  customModels: string[] = $state([]);
  private initialized = false;

  // Deferred, idempotent load. Called from a component's onMount so module
  // evaluation during SSR/prerender never reads localStorage — the server and
  // the client both start from empty arrays, so hydration can't diverge.
  load(): void {
    if (this.initialized || typeof window === "undefined") return;
    this.initialized = true;
    this.favorites = readStored(FAVORITES_KEY);
    this.recents = readStored(RECENTS_KEY).slice(0, MAX_RECENTS);
    this.customModels = readStored(CUSTOM_KEY);
  }

  getCustomModels(): string[] {
    return this.customModels;
  }

  addCustomModel(id: string): void {
    const value = id.trim();
    if (!value || this.customModels.includes(value)) return;
    this.customModels = [...this.customModels, value];
    this.persist(CUSTOM_KEY, this.customModels);
  }

  removeCustomModel(id: string): void {
    if (!this.customModels.includes(id)) return;
    this.customModels = this.customModels.filter((m) => m !== id);
    this.persist(CUSTOM_KEY, this.customModels);
    // Drop any orphaned favorite/recent entry for the removed id.
    if (this.favorites.includes(id)) {
      this.favorites = this.favorites.filter((m) => m !== id);
      this.persist(FAVORITES_KEY, this.favorites);
    }
    if (this.recents.includes(id)) {
      this.recents = this.recents.filter((m) => m !== id);
      this.persist(RECENTS_KEY, this.recents);
    }
  }

  isFavorite(modelId: string): boolean {
    return this.favorites.includes(modelId);
  }

  toggleFavorite(modelId: string): void {
    if (!modelId) return;
    this.favorites = this.isFavorite(modelId)
      ? this.favorites.filter((id) => id !== modelId)
      : [...this.favorites, modelId];
    this.persist(FAVORITES_KEY, this.favorites);
  }

  // Most-recently-used first, capped at MAX_RECENTS.
  addRecent(modelId: string): void {
    if (!modelId) return;
    this.recents = [modelId, ...this.recents.filter((id) => id !== modelId)].slice(0, MAX_RECENTS);
    this.persist(RECENTS_KEY, this.recents);
  }

  private persist(key: string, value: string[]): void {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // intentional: best-effort persistence of model prefs; not user-facing.
    }
  }
}

export const modelPrefs = new ModelPrefsState();

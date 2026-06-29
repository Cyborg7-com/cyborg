import { afterEach, beforeEach, describe, expect, it } from "vitest";

// #619 — the Tasks-tab preference must survive a refresh. The bug: in dev (Vite
// SSR) the preferencesState singleton is first built server-side, where its
// constructor bails before reading localStorage, then reused on the client — so
// showTasksTab stayed at its default `false` and the toggle did not persist.
// The fix exposes hydrateFromStorage(), which +layout.svelte calls from onMount
// (client-only) to re-read the stored value after hydration.
//
// The vitest env is plain `node` (no DOM), so we install a minimal in-memory
// localStorage + window stand-in — the same seed-the-global approach the other
// localStorage-backed state tests use (see terminal-sessions.svelte.test.ts).

const STORAGE_KEY_SHOW_TASKS = "cyborg7-show-tasks-tab";
const STORAGE_KEY_THEME = "cyborg7-theme";

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

interface Globals {
  localStorage?: Storage;
  window?: unknown;
}

beforeEach(() => {
  (globalThis as Globals).localStorage = new MemoryStorage() as unknown as Storage;
  // A minimal window with matchMedia so setShowTasksTab()/setTheme()'s
  // `typeof window !== "undefined"` write path runs. matchMedia is only touched
  // by the constructor (already executed at import time), but provide it anyway.
  (globalThis as Globals).window = {
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    localStorage: (globalThis as Globals).localStorage,
  };
});

afterEach(() => {
  delete (globalThis as Globals).localStorage;
  delete (globalThis as Globals).window;
});

// Imported after the globals exist so any module-init touching them is safe.
const { preferencesState } = await import("./preferences.svelte.js");

describe("Tasks-tab preference persistence (#619)", () => {
  it("setShowTasksTab(true) writes 'true' to localStorage and updates state", () => {
    preferencesState.setShowTasksTab(true);
    expect(preferencesState.showTasksTab).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY_SHOW_TASKS)).toBe("true");
  });

  it("setShowTasksTab(false) writes 'false' and updates state", () => {
    preferencesState.setShowTasksTab(false);
    expect(preferencesState.showTasksTab).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY_SHOW_TASKS)).toBe("false");
  });

  it("toggleShowTasksTab() flips and persists in both directions", () => {
    preferencesState.setShowTasksTab(false);
    preferencesState.toggleShowTasksTab();
    expect(preferencesState.showTasksTab).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY_SHOW_TASKS)).toBe("true");
    preferencesState.toggleShowTasksTab();
    expect(preferencesState.showTasksTab).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY_SHOW_TASKS)).toBe("false");
  });

  // The core regression: an enabled tab survives a refresh. We simulate the SSR
  // bug by forcing the in-memory state to the stale default `false` (as if the
  // singleton had been built server-side and reused on the client), seeding the
  // persisted "true", then calling hydrateFromStorage() the way onMount does.
  it("hydrateFromStorage() restores an ENABLED tab on refresh (true survives)", () => {
    preferencesState.showTasksTab = false; // stale SSR default
    localStorage.setItem(STORAGE_KEY_SHOW_TASKS, "true"); // user had enabled it
    preferencesState.hydrateFromStorage();
    expect(preferencesState.showTasksTab).toBe(true);
  });

  it("hydrateFromStorage() restores a DISABLED tab on refresh (false survives)", () => {
    preferencesState.showTasksTab = true; // stale value
    localStorage.setItem(STORAGE_KEY_SHOW_TASKS, "false"); // user had disabled it
    preferencesState.hydrateFromStorage();
    expect(preferencesState.showTasksTab).toBe(false);
  });

  it("hydrateFromStorage() defaults the tab ON when nothing was ever stored", () => {
    preferencesState.showTasksTab = false; // pretend it was off
    localStorage.removeItem(STORAGE_KEY_SHOW_TASKS); // never persisted
    preferencesState.hydrateFromStorage();
    expect(preferencesState.showTasksTab).toBe(true); // on by default; only "false" opts out
  });

  it("write then hydrate round-trips (the real enable → refresh path)", () => {
    preferencesState.setShowTasksTab(true); // user toggles ON
    preferencesState.showTasksTab = false; // simulate the post-refresh SSR default
    preferencesState.hydrateFromStorage(); // onMount re-read
    expect(preferencesState.showTasksTab).toBe(true);
  });

  it("hydrateFromStorage() also restores a persisted theme", () => {
    localStorage.setItem(STORAGE_KEY_THEME, "light");
    preferencesState.hydrateFromStorage();
    expect(preferencesState.theme).toBe("light");
  });
});

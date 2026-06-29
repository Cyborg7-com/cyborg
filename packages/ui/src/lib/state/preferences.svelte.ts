import {
  DEFAULT_DISPLAY,
  DEFAULT_ORDER_BY,
  DEFAULT_ORDER_DIR,
  type DisplayKey,
  type OrderBy,
  type OrderDir,
} from "$lib/tasks/view.js";

type Theme = "dark" | "light" | "system";

const STORAGE_KEY = "cyborg7-theme";
// The Tasks tab (board + recurring-schedule) is ON by default; persisted
// device-globally like the theme, under its own key. Explicit opt-out = "false".
const STORAGE_KEY_SHOW_TASKS = "cyborg7-show-tasks-tab";

// Tasks view preferences (toolbar Ordering + Display menu, and the peek mode the
// task-detail surface opens in). Each persisted device-globally under its own
// key, like the theme — they are UI presentation choices, not workspace data.
const STORAGE_KEY_TASKS_ORDER_BY = "cyborg7-tasks-order-by";
const STORAGE_KEY_TASKS_ORDER_DIR = "cyborg7-tasks-order-dir";
const STORAGE_KEY_TASKS_DISPLAY = "cyborg7-tasks-display";
const STORAGE_KEY_TASKS_PEEK_MODE = "cyborg7-tasks-peek-mode";
// Per-column kanban collapse (Plane's collapse-to-rail). A flat list of the
// collapsed column GROUP KEYS (e.g. a state id, a priority bucket, an assignee
// id). Persisted device-globally so a collapsed column stays collapsed across
// reloads, mirroring Plane's persisted kanbanFilters.group_by list.
const STORAGE_KEY_TASKS_COLLAPSED_COLUMNS = "cyborg7-tasks-collapsed-columns";

// How the task-detail "peek" opens: a right-side slide-over, a centered modal, or
// a fullscreen page. Default is "full" — the WIDE work-item layout (Plane's full
// view) is the prominent reading experience; side/modal stay one click away in
// the detail header. Persisted so the choice survives reload.
export type TasksPeekMode = "side" | "modal" | "full";
const DEFAULT_PEEK_MODE: TasksPeekMode = "side";

function isOrderBy(v: string): v is OrderBy {
  return (
    v === "title" || v === "createdAt" || v === "updatedAt" || v === "dueAt" || v === "priority"
  );
}

function isPeekMode(v: string): v is TasksPeekMode {
  return v === "side" || v === "modal" || v === "full";
}

class PreferencesState {
  theme: Theme = $state("dark");

  // Whether the Tasks rail item / route is surfaced. Default TRUE (on by default):
  // the tab is safe-on — the board + manual cards work, and the agent/cost path
  // stays double-gated (per-channel auto_tasks_enabled + a cybo member in the
  // channel), so merely showing the tab never triggers any agent spend. Users can
  // still hide it from Settings (persisted as "false").
  showTasksTab: boolean = $state(true);

  // ── Tasks view preferences (toolbar Ordering / Display, detail peek mode) ──
  // Reactive so the toolbar menus and the board/list re-render the moment a
  // setter mutates them; persisted to localStorage by each setter and rehydrated
  // in hydrateFromStorage(). Defaults come from view.ts so there is a single
  // source of truth for the sensible-default ordering + display set.
  tasksOrderBy: OrderBy = $state(DEFAULT_ORDER_BY);
  tasksOrderDir: OrderDir = $state(DEFAULT_ORDER_DIR);
  // A fresh record copy (never the shared DEFAULT_DISPLAY object) so a toggle
  // mutates this instance, not the module-level default.
  tasksDisplay: Record<DisplayKey, boolean> = $state({ ...DEFAULT_DISPLAY });
  tasksPeekMode: TasksPeekMode = $state(DEFAULT_PEEK_MODE);

  // The board columns currently collapsed-to-rail, keyed by group key. A reactive
  // Set so the board re-renders the instant a column is collapsed/expanded;
  // persisted by each setter and rehydrated in hydrateFromStorage().
  tasksCollapsedColumns: Set<string> = $state(new Set());

  // Separate reactive state for the OS dark-mode signal so that Svelte's
  // reactivity can track it and re-derive `resolvedTheme` when the OS switches
  // while the preference is "system". Initialised to false (SSR-safe); the
  // constructor sets it from the real matchMedia result and installs the
  // change listener that keeps it in sync.
  #osDark: boolean = $state(false);

  readonly resolvedTheme: "dark" | "light" = $derived.by(() => {
    if (this.theme === "system") {
      return this.#osDark ? "dark" : "light";
    }
    return this.theme;
  });

  // Callbacks registered via `onResolvedChange`. Called whenever resolvedTheme
  // changes (OS switch while preference=system, or explicit setTheme call).
  // Used by MessageInput to re-push CSS tokens to the native pill.
  #resolvedListeners: Array<(resolved: "dark" | "light") => void> = [];

  // Retain the MediaQueryList so WebKit cannot GC it and silently drop the listener.
  // oxlint-disable-next-line no-unused-private-class-members -- intentional GC guard
  #mediaQueryList: MediaQueryList | null = null;

  constructor() {
    if (typeof window === "undefined") return;

    // Sync #osDark from the real OS state immediately so resolvedTheme is
    // correct before any Svelte $effect runs. This is the boot-time fix: the
    // constructor used to only set `this.theme` (the preference) but never
    // called applyTheme(), leaving data-theme at whatever the inline boot
    // script set (which itself could have been "system" before this fix).
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    this.#mediaQueryList = mq;
    this.#osDark = mq.matches;

    // Read the persisted preferences (theme + Tasks tab) from localStorage and
    // apply the resolved theme to the DOM on boot. The inline script in app.html
    // already resolves "system" correctly, but hydrateFromStorage()'s apply also
    // handles the case where the store is constructed after SvelteKit hydration
    // (e.g. SSR-prerendered HTML that had a different theme baked in) and ensures
    // data-theme is always the resolved value, never "system".
    this.hydrateFromStorage();

    // Live OS switch: update #osDark so resolvedTheme re-derives and the DOM
    // reflects the new OS appearance without a reload, but only when preference
    // is "system". Svelte's reactivity propagates the change automatically via
    // $derived — we only need to kick the DOM update via applyTheme().
    mq.addEventListener("change", (e) => {
      this.#osDark = e.matches;
      if (this.theme === "system") {
        this.#apply();
        this.#notifyListeners();
      }
    });

    // React to resolvedTheme changes inside the Svelte runtime so that
    // programmatic calls to setTheme() that don't go through an effect (e.g.
    // from the appearance page or ProfileMenu) also notify listeners.
    // We do this by watching resolvedTheme via $effect — this requires the
    // constructor to run in a reactive context (it does when the singleton is
    // created at module level inside a Svelte component tree), but if it runs
    // outside one the $effect is simply a no-op; the DOM apply + listener
    // notify in setTheme() cover that path.
    // NOTE: $effect in a class constructor only works when the instance is
    // created inside a component's <script>. For the singleton at module level
    // it is NOT inside a component, so we cannot use $effect here. The DOM
    // update in setTheme() and the mq change handler above are the two paths
    // that cover all cases — no $effect needed.
  }

  /**
   * Re-read the persisted preferences from localStorage and apply them. Safe to
   * call multiple times and a no-op when localStorage is unavailable (SSR).
   *
   * Why this exists separately from the constructor: in dev (Vite SSR) the
   * module-level singleton is first instantiated SERVER-side, where the
   * constructor bails out at `typeof window === "undefined"` before reading
   * localStorage — and that instance is then reused on the client. Without a
   * client-side re-read, `showTasksTab` would keep its default `false` and the
   * stored choice would never be restored on refresh. The theme dodges this via
   * the inline boot script in app.html; the Tasks tab has no such pre-read, so
   * +layout.svelte calls this from onMount (client-only) to restore it.
   */
  hydrateFromStorage(): void {
    if (typeof localStorage === "undefined") return;

    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      this.theme = stored;
    }

    // Tasks tab visibility: ON by default; only an explicit opt-out ("false")
    // hides it (was opt-in "=== true"; flipped to default-on).
    this.showTasksTab = localStorage.getItem(STORAGE_KEY_SHOW_TASKS) !== "false";

    // Tasks Ordering: validate against the known OrderBy union so a stale/garbage
    // value falls back to the default rather than breaking the sort.
    const orderBy = localStorage.getItem(STORAGE_KEY_TASKS_ORDER_BY);
    if (orderBy && isOrderBy(orderBy)) this.tasksOrderBy = orderBy;
    const orderDir = localStorage.getItem(STORAGE_KEY_TASKS_ORDER_DIR);
    if (orderDir === "asc" || orderDir === "desc") this.tasksOrderDir = orderDir;

    // Tasks peek mode.
    const peekMode = localStorage.getItem(STORAGE_KEY_TASKS_PEEK_MODE);
    if (peekMode && isPeekMode(peekMode)) this.tasksPeekMode = peekMode;

    // Tasks collapsed columns: a JSON array of group keys. Garbage / non-array
    // JSON falls back to the empty (all-expanded) default.
    const collapsedRaw = localStorage.getItem(STORAGE_KEY_TASKS_COLLAPSED_COLUMNS);
    if (collapsedRaw) {
      try {
        const parsed = JSON.parse(collapsedRaw) as unknown;
        if (Array.isArray(parsed)) {
          this.tasksCollapsedColumns = new Set(
            parsed.filter((v): v is string => typeof v === "string"),
          );
        }
      } catch {
        // Corrupt JSON → keep the empty default set above.
      }
    }

    // Tasks Display: merge the persisted record OVER the defaults, so a newly
    // added DisplayKey (absent from older persisted JSON) keeps its default-on
    // state instead of becoming undefined. Only boolean values are kept.
    const displayRaw = localStorage.getItem(STORAGE_KEY_TASKS_DISPLAY);
    if (displayRaw) {
      try {
        const parsed = JSON.parse(displayRaw) as Partial<Record<DisplayKey, boolean>>;
        const merged = { ...DEFAULT_DISPLAY };
        for (const k of Object.keys(merged) as DisplayKey[]) {
          if (typeof parsed[k] === "boolean") merged[k] = parsed[k];
        }
        this.tasksDisplay = merged;
      } catch {
        // Corrupt JSON → keep the defaults already set above.
      }
    }

    this.#apply();
  }

  #apply(): void {
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", this.resolvedTheme);
    }
  }

  #notifyListeners(): void {
    // Read the resolved value NOW (it is correct the instant setTheme/#apply
    // mutated the state), but FIRE the listeners only AFTER the browser has
    // recomputed styles for the just-written `data-theme` attribute. The native
    // iOS pill listener reads the live CSS custom properties via
    // getComputedStyle(); if it ran in the same task as `#apply()` it could read
    // the PREVIOUS theme's `--color-*` tokens (the attribute is set synchronously
    // but a style recompute is what actually swaps the variable values), pushing
    // a stale (e.g. dark) palette onto a freshly-light document. Deferring to the
    // next animation frame guarantees the style recompute has happened, so every
    // listener's getComputedStyle read matches the rendered theme. Falls back to a
    // microtask off-browser (tests / SSR) where rAF is unavailable.
    const resolved = this.resolvedTheme;
    const fire = () => {
      for (const fn of this.#resolvedListeners) {
        try {
          fn(resolved);
        } catch {
          // individual listener errors must not break the others
        }
      }
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(fire);
    } else {
      queueMicrotask(fire);
    }
  }

  /**
   * Register a callback that fires whenever `resolvedTheme` changes —
   * either from an explicit `setTheme()` call or from an OS media-query
   * change while preference is "system". Returns an unsubscribe function.
   * Used by MessageInput to re-push CSS tokens to the native iOS pill.
   */
  onResolvedChange(fn: (resolved: "dark" | "light") => void): () => void {
    this.#resolvedListeners.push(fn);
    return () => {
      const i = this.#resolvedListeners.indexOf(fn);
      if (i !== -1) this.#resolvedListeners.splice(i, 1);
    };
  }

  setTheme(value: Theme) {
    this.theme = value;
    this.#apply();
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY, value);
    }
    this.#notifyListeners();
  }

  // Show/hide the Tasks tab. Persisted so the choice survives reloads; the rail
  // item gating reads `showTasksTab` reactively (see routes/+layout.svelte).
  setShowTasksTab(value: boolean): void {
    this.showTasksTab = value;
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_SHOW_TASKS, String(value));
    }
  }

  toggleShowTasksTab(): void {
    this.setShowTasksTab(!this.showTasksTab);
  }

  // ── Tasks view-preference setters (persist + reactive) ─────────────────────

  // Set the active Ordering field. The toolbar's Ordering menu calls this.
  setTasksOrderBy(value: OrderBy): void {
    this.tasksOrderBy = value;
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_TASKS_ORDER_BY, value);
    }
  }

  // Set the Ordering direction (asc/desc). The toolbar's asc/desc toggle calls this.
  setTasksOrderDir(value: OrderDir): void {
    this.tasksOrderDir = value;
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_TASKS_ORDER_DIR, value);
    }
  }

  // Flip asc ↔ desc in one call (the toolbar's direction toggle button).
  toggleTasksOrderDir(): void {
    this.setTasksOrderDir(this.tasksOrderDir === "asc" ? "desc" : "asc");
  }

  // Toggle one Display property on/off. Writes a NEW record so Svelte's
  // fine-grained reactivity sees the change, then persists the whole map.
  toggleTasksDisplay(key: DisplayKey): void {
    this.tasksDisplay = { ...this.tasksDisplay, [key]: !this.tasksDisplay[key] };
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_TASKS_DISPLAY, JSON.stringify(this.tasksDisplay));
    }
  }

  // Set one Display property to an explicit value (for a checkbox bound surface).
  setTasksDisplay(key: DisplayKey, value: boolean): void {
    this.tasksDisplay = { ...this.tasksDisplay, [key]: value };
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_TASKS_DISPLAY, JSON.stringify(this.tasksDisplay));
    }
  }

  // Set how the task-detail peek opens (side / modal / full). The detail
  // surface's mode-toggle button group calls this.
  setTasksPeekMode(value: TasksPeekMode): void {
    this.tasksPeekMode = value;
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_TASKS_PEEK_MODE, value);
    }
  }

  // Collapse / expand one board column to its rail. Writes a NEW Set so Svelte's
  // fine-grained reactivity sees the change, then persists the whole list as a
  // JSON array. The board's per-column collapse button calls this.
  toggleTasksColumnCollapsed(key: string): void {
    const next = new Set(this.tasksCollapsedColumns);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.tasksCollapsedColumns = next;
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_TASKS_COLLAPSED_COLUMNS, JSON.stringify([...next]));
    }
  }
}

export const preferencesState = new PreferencesState();

// Per-(workspace, project) UI preferences for the Tasks surface, persisted to
// localStorage. These are DEVICE-LOCAL presentation choices — which layout a
// project's work items open in, and which Pages rows are collapsed — keyed by
// workspace + project so different projects keep independent state and never
// clobber each other.
//
// Unlike the device-global Tasks prefs on `preferencesState` (Ordering, Display,
// peek mode), these are intrinsically project-scoped, so they live here keyed
// rather than as flat singleton fields. Every accessor is SSR / no-window safe
// (this is adapter-static, but a load that runs before hydration must not throw)
// and tolerant of private-mode / quota / corrupt-JSON failures.
import type { GroupBy, Layout } from "./view.js";

const PAGES_COLLAPSED_PREFIX = "cyborg7-pages-collapsed";
const PROJECT_VIEW_PREFIX = "cyborg7-tasks-view";
const TASK_VIEWS_PREFIX = "cyborg7-tasks-views";

// The starting layout / group-by for a project view with no persisted choice.
// Colocated with the persistence layer (rather than view.ts) so this fix stays
// surgical; they mirror the page's prior literal defaults ("board" / "status").
export const DEFAULT_LAYOUT: Layout = "board";
export const DEFAULT_GROUP_BY: GroupBy = "status";

// Runtime guards so a stale / garbage persisted value falls back to the default
// instead of corrupting the view state.
function isLayout(v: unknown): v is Layout {
  return v === "board" || v === "list" || v === "calendar" || v === "spreadsheet" || v === "gantt";
}
function isGroupBy(v: unknown): v is GroupBy {
  return (
    v === "status" ||
    v === "assignee" ||
    v === "priority" ||
    v === "project" ||
    v === "label" ||
    v === "cycle" ||
    v === "module" ||
    v === "stateGroup"
  );
}

// The per-project view choice that survives reload. Both fields optional so a
// partially-written (or schema-evolved) blob still restores what it can.
export interface ProjectViewPrefs {
  layout?: Layout;
  groupBy?: GroupBy;
}

function hasStorage(): boolean {
  return typeof localStorage !== "undefined";
}

// Namespacing key: `<prefix>:<wsId>:<projectId>`. Both ids are required for a
// stable key; an empty id yields a benign "shared" bucket rather than throwing.
function keyFor(prefix: string, wsId: string, projectId: string): string {
  return `${prefix}:${wsId}:${projectId}`;
}

function readJson<T>(key: string): T | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as T);
  } catch {
    // missing storage / corrupt JSON → treat as "no stored value"
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // private mode / quota exceeded — the choice just won't persist this time
  }
}

// ── Pages disclosure (collapsed page ids) ──────────────────────────────────
// Stored as a JSON array of page ids that are COLLAPSED. A page absent from the
// set is expanded (default), so a brand-new page tree starts fully expanded.

export function readPagesCollapsed(wsId: string, projectId: string): string[] {
  const parsed = readJson<unknown>(keyFor(PAGES_COLLAPSED_PREFIX, wsId, projectId));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((v): v is string => typeof v === "string");
}

export function writePagesCollapsed(wsId: string, projectId: string, ids: Iterable<string>): void {
  writeJson(keyFor(PAGES_COLLAPSED_PREFIX, wsId, projectId), [...ids]);
}

// ── Tasks view (layout + group-by) ─────────────────────────────────────────
// The "favorite display" for a project's work items. Validated through the
// view.ts guards so a stale value can never corrupt the rendered layout.

export function readProjectView(wsId: string, projectId: string): ProjectViewPrefs {
  const parsed = readJson<Record<string, unknown>>(keyFor(PROJECT_VIEW_PREFIX, wsId, projectId));
  if (parsed == null || typeof parsed !== "object") return {};
  const out: ProjectViewPrefs = {};
  if (isLayout(parsed.layout)) out.layout = parsed.layout;
  if (isGroupBy(parsed.groupBy)) out.groupBy = parsed.groupBy;
  return out;
}

export function writeProjectView(wsId: string, projectId: string, view: ProjectViewPrefs): void {
  writeJson(keyFor(PROJECT_VIEW_PREFIX, wsId, projectId), view);
}

// ── Department views ("Views bar") ─────────────────────────────────────────
// A CLIENT-ONLY saved slice of the board: each view filters the board to tasks
// carrying any of its `labelIds` (a "department" IS a project label). Persisted
// per (workspace, project) so the tab strip + active tab survive a reload, keyed
// separately from ProjectViewPrefs so the two never clobber. `labelIds` may be
// empty — a brand-new department whose label doesn't exist yet (materialized by
// tagging the first task); filtering on [] falls back to "All" until it lights up.

export interface TaskView {
  id: string;
  name: string;
  labelIds: string[];
}

// The persisted blob: the saved views + which one is active (null = "All").
export interface TaskViewsState {
  views: TaskView[];
  activeId: string | null;
}

// Narrow a parsed value to a TaskView, dropping anything malformed so a corrupt
// entry can't crash the bar (mirrors the defensive reads above).
function isTaskView(v: unknown): v is TaskView {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    Array.isArray(o.labelIds) &&
    o.labelIds.every((x) => typeof x === "string")
  );
}

export function readTaskViews(wsId: string, projectId: string): TaskViewsState {
  const parsed = readJson<Record<string, unknown>>(keyFor(TASK_VIEWS_PREFIX, wsId, projectId));
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { views: [], activeId: null };
  }
  const views = Array.isArray(parsed.views) ? parsed.views.filter(isTaskView) : [];
  // Keep activeId only if it still points at a surviving view (a deleted view or
  // stale id resets the board to "All" rather than filtering by a ghost).
  const activeId =
    typeof parsed.activeId === "string" && views.some((v) => v.id === parsed.activeId)
      ? parsed.activeId
      : null;
  return { views, activeId };
}

export function writeTaskViews(wsId: string, projectId: string, state: TaskViewsState): void {
  writeJson(keyFor(TASK_VIEWS_PREFIX, wsId, projectId), state);
}

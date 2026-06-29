// Pure-data reference tables for the Plane-faithful Tasks model. NO DOM, NO
// component imports — just our own typed constants the toolbar / board / list /
// peek read from so labels, ordering, and grouping options live in ONE place
// instead of being re-hardcoded per surface.
//
// These mirror Plane's task SEMANTICS (the five state GROUPS, the five PRIORITY
// levels, and the Display-menu option lists) but every value is OUR OWN: our
// wording, our column keys (board.ts), our priority keys (priority.ts), and our
// app.css token names (the --state-* state-group scale + the --priority-* scale).
// Plane's colorimetry is adopted in the TOKEN DEFINITIONS in app.css; this file
// only references the token names. Nothing is copied from any external file.

import type { ColumnKey } from "./board.js";
import type { Priority } from "./priority.js";
import type { DisplayKey, GroupBy, OrderBy } from "./view.js";

// ── STATE GROUPS ─────────────────────────────────────────────────────────────
// Plane organises issue states into five GROUPS: backlog / unstarted / started /
// completed / cancelled. Our board (board.ts) renders four canonical columns
// (todo / in_progress / pending_review / done); this table maps each Plane state
// group to the board column it surfaces in, so a future "group by state group"
// view (view.ts) reads one self-documenting record instead of scattering the
// mapping. `seedColor` is an app.css token NAME (resolved at the call site as a
// theme utility, never a raw literal); `iconKey` is a stable lucide-ish glyph
// key the surface maps to its own icon component; `order` is the canonical
// left-to-right / top-to-bottom display order.
export interface StateGroup {
  // Stable key (Plane's state-group vocabulary, our own value).
  key: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
  // Human-facing label (our wording).
  label: string;
  // The board column this group surfaces in (board.ts ColumnKey). "cancelled"
  // has no dedicated board column today, so it folds into "done" — kept explicit
  // here so a future cancelled column is a one-line change.
  column: ColumnKey;
  // app.css token name for the group's seed/accent color. Resolved at the call
  // site (e.g. `text-[color:var(${seedColor})]`), never inlined as a literal.
  seedColor: string;
  // Stable glyph key the rendering surface maps to its own icon component.
  iconKey: "circle-dashed" | "circle" | "circle-dot" | "circle-check" | "circle-x";
  // Canonical display order.
  order: number;
}

export const STATE_GROUPS: StateGroup[] = [
  {
    key: "backlog",
    label: "Backlog",
    column: "todo",
    seedColor: "--state-backlog",
    iconKey: "circle-dashed",
    order: 0,
  },
  {
    key: "unstarted",
    label: "To Do",
    column: "todo",
    seedColor: "--state-unstarted",
    iconKey: "circle",
    order: 1,
  },
  {
    key: "started",
    label: "In Progress",
    column: "in_progress",
    seedColor: "--state-started",
    iconKey: "circle-dot",
    order: 2,
  },
  {
    key: "completed",
    label: "Done",
    column: "done",
    seedColor: "--state-completed",
    iconKey: "circle-check",
    order: 3,
  },
  {
    key: "cancelled",
    label: "Cancelled",
    column: "done",
    seedColor: "--state-cancelled",
    iconKey: "circle-x",
    order: 4,
  },
];

export type StateGroupKey = StateGroup["key"];

// Resolve a state group's seed color as a ready-to-use CSS color value
// (`var(--state-<group>)`), so a surface that only carries a bare state group
// (e.g. the calendar chip's stripe or the gantt bar's fill) can color itself
// token-only, with ZERO raw hex — exactly how StateGroupIcon tints its glyph.
// An unknown group falls back to the first group's token (backlog).
export function stateGroupColorVar(group: StateGroupKey): string {
  const meta = STATE_GROUPS.find((g) => g.key === group) ?? STATE_GROUPS[0];
  return `var(${meta.seedColor})`;
}

// ── PRIORITIES ───────────────────────────────────────────────────────────────
// The five priority levels (priority.ts Priority), paired with a label, a stable
// icon key, and the app.css priority token NAME. The token-name indirection
// keeps callers free of raw color literals: a priority dot reads
// `bg-priority-<key>`, a detail control reads `text-priority-<key>`, both driven
// off `token` here. Order mirrors PRIORITY_ORDER (urgent → low) then "none".
export interface PriorityMeta {
  key: Priority;
  label: string;
  // Lucide glyph keys, matched 1:1 to Plane's PriorityIcon (lucide-react):
  // urgent=AlertCircle, high=SignalHigh, medium=SignalMedium, low=SignalLow,
  // none=Ban. PriorityIcon maps each key to the corresponding @lucide/svelte icon.
  iconKey: "alert-circle" | "signal-high" | "signal-medium" | "signal-low" | "ban";
  // app.css token name for this priority (the --priority-* scale). Resolved at
  // the call site as a theme utility (bg-priority-<key> / text-priority-<key>).
  token: string;
}

export const PRIORITIES: PriorityMeta[] = [
  { key: "urgent", label: "Urgent", iconKey: "alert-circle", token: "--priority-urgent" },
  { key: "high", label: "High", iconKey: "signal-high", token: "--priority-high" },
  { key: "medium", label: "Medium", iconKey: "signal-medium", token: "--priority-medium" },
  { key: "low", label: "Low", iconKey: "signal-low", token: "--priority-low" },
  { key: "none", label: "No priority", iconKey: "ban", token: "--priority-none" },
];

// ── DISPLAY-MENU OPTION LISTS ────────────────────────────────────────────────
// The three option lists the work-items "Display" popover renders. Each is a
// {value,label} pair list so the menu never hardcodes its own labels. `value`
// references the matching view.ts union (GroupBy / OrderBy / DisplayKey) so the
// option lists can never drift from the functions that consume them — a new
// GroupBy that isn't listed here is a type error.

export interface DisplayOption<T extends string> {
  value: T;
  label: string;
}

// "Group by" options — how the board/list buckets work items. Mirrors the
// GroupBy union (status / assignee / priority) plus the additive facets view.ts
// now understands (project / label / cycle / module / state group).
export const GROUP_BY_OPTIONS: DisplayOption<GroupBy>[] = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "stateGroup", label: "State group" },
  { value: "project", label: "Project" },
  { value: "label", label: "Label" },
  { value: "cycle", label: "Cycle" },
  { value: "module", label: "Module" },
];

// "Order by" options — the sort field the Ordering radio list offers. Mirrors
// the OrderBy union (every value maps to a real Task field; see view.ts).
export const ORDER_BY_OPTIONS: DisplayOption<OrderBy>[] = [
  { value: "createdAt", label: "Created" },
  { value: "updatedAt", label: "Updated" },
  { value: "dueAt", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
];

// "Display properties" toggle list — which property chips a card/row renders.
// Mirrors the DisplayKey union (every key maps to a property the card can
// actually render; see view.ts DISPLAY_OPTIONS / DEFAULT_DISPLAY).
export const DISPLAY_PROPERTY_OPTIONS: DisplayOption<DisplayKey>[] = [
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "dueAt", label: "Due date" },
  { value: "taskId", label: "ID" },
];

// ── LABEL PALETTE ────────────────────────────────────────────────────────────
// The 8 functional label colors (matching the app.css --label-* palette). A
// label chip resolves its triad off one of these names via the Tailwind bridge:
// bg-label-<name>-bg text-label-<name>-text border-label-<name>-border. Exposed
// as data so a label picker / deterministic name→color hash reads one ordered
// list instead of re-listing the names per surface.
export const LABEL_COLORS = [
  "indigo",
  "emerald",
  "grey",
  "crimson",
  "yellow",
  "orange",
  "pink",
  "purple",
] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

// ── INBOX (synthetic per-workspace tasks project) ────────────────────────────
// Tasks created without a chat project — a cybo filing one from a DM, or from a
// channel with no linked project — land in the per-workspace synthetic "Inbox"
// tasks_project. Server contract (db/pg-sync.ts):
//   - getOrCreateInboxProject seeds a tasks_projects row with chat_project_id
//     NULL, identifier "INBOX", and the DETERMINISTIC id `tp_inbox_<workspaceId>`;
//   - mapTaskRow maps an Inbox task's OUTBOUND project_id to NULL (it has no chat
//     project), so the UI sees those tasks as `task.projectId == null`.
// Both are stable contracts, so the UI can surface AND open the Inbox using only
// the already-loaded tasks + the workspace id — no new endpoint. The same
// `tp_inbox_…` id is accepted verbatim by every existing tasks RPC
// (resolveTasksProjectId passes a "tp_…" id through by id), so routing the
// work-items board to it resolves the Inbox's real states/catalogs and files new
// work items back into the Inbox.
const INBOX_PROJECT_ID_PREFIX = "tp_inbox_";

// The Inbox's task-key prefix (its tasks_projects.identifier) and the display
// name the UI labels its synthetic project row with.
export const INBOX_IDENTIFIER = "INBOX";
export const INBOX_PROJECT_NAME = "Inbox";

// The deterministic Inbox tasks_project id for a workspace (mirrors the server's
// getOrCreateInboxProject). Used as the route projectId for the Inbox views.
export function inboxProjectId(workspaceId: string): string {
  return `${INBOX_PROJECT_ID_PREFIX}${workspaceId}`;
}

// Is this route/project id the synthetic workspace Inbox? Matched by the stable
// `tp_inbox_` prefix so it needs no workspace id at the call site.
export function isInboxProjectId(projectId: string | null | undefined): boolean {
  return !!projectId && projectId.startsWith(INBOX_PROJECT_ID_PREFIX);
}

// Narrow the workspace's tasks to one project's work items. For a chat-linked
// project that's an exact projectId match; for the Inbox it's every ORPHAN task
// (no chat project → projectId null/absent), since Inbox tasks carry a null
// outbound project_id. Generic so callers don't import the Task type.
export function tasksForProject<T extends { projectId?: string | null }>(
  tasks: readonly T[],
  projectId: string,
): T[] {
  if (isInboxProjectId(projectId)) return tasks.filter((t) => !t.projectId);
  return tasks.filter((t) => t.projectId === projectId);
}

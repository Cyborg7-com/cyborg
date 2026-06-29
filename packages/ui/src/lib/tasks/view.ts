// Pure, DOM-free view model for the Tasks tab toolbar: LAYOUT
// (board|list|calendar|spreadsheet|gantt), GROUP BY (status|assignee|priority),
// and FILTERS (assignee ids, assignee
// KINDS, priorities, statuses). All grouping + filtering lives here as pure,
// deterministic functions so the board / list components are a thin render over
// the result, and so "per user / per agent / overall" is unit-testable without
// mounting a component.
//
// The toolbar maps onto the user's three asks like this:
//   - "Overall"      → no filters active (the default); every task shows.
//   - "per user"     → GROUP BY assignee gives a section per identity, and the
//                      assignee KIND facet ("People") narrows to humans.
//   - "per agent"    → same group-by, with the KIND facet set to "Agents"
//                      (and/or "Cybos").
import type { Task, TaskState } from "$lib/core/types.js";
import { columnForStatus, COLUMNS, type ColumnKey } from "./board.js";
import { priorityForTask, type Priority, PRIORITY_ORDER } from "./priority.js";
import { resolveAssignee, type AssigneeKind, type AssigneePools } from "./assignee.js";

// The minimum a board column / list group needs off a project's workflow state to
// render data-driven columns: the state id (the task.stateId key + the drop
// target written back via client.updateTask), the human name, the editable color,
// and the canonical Plane phase `group` (drives the StateGroupIcon glyph). Mirror
// of the relevant TaskState fields, so callers can pass either a full TaskState[]
// (from client.fetchProjectStates) or a lighter projection. Ordered by the
// caller (the relay returns states by `sequence`), so grouping preserves input
// order — it does NOT re-sort.
export type StateLite = Pick<TaskState, "id" | "name" | "color" | "group">;

// Plane offers five issue layouts. Board + List are the two original Tasks
// surfaces; calendar / spreadsheet / gantt are the new Plane-faithful layouts.
// Grouping / sorting / filtering below stay layout-agnostic — they operate on
// the Task[] regardless of which layout renders the result, so adding a layout
// value here changes nothing about how tasks are grouped, filtered, or sorted.
// (Calendar + Gantt position tasks by their own date math and may ignore the
// active GROUP BY entirely; they still accept it for prop-shape parity.)
export type Layout = "board" | "list" | "calendar" | "spreadsheet" | "gantt";
// GROUP BY facets. status / assignee / priority are the original three; project,
// label, cycle, module, and stateGroup are the Plane-faithful additions. The
// extra facets read their value FORWARD-COMPATIBLY off the Task (the canonical
// Task type doesn't carry projectId/labels/cycleId/moduleId yet — see
// core/types.ts), exactly like priority.ts narrows an optional `priority`. A task
// with no project/labels/cycle/module groups into the "none" bucket rather than
// being dropped, so adding a facet never hides a task.
export type GroupBy =
  | "status"
  | "assignee"
  | "priority"
  | "project"
  | "label"
  | "cycle"
  | "module"
  | "stateGroup";

// A task MAY (forward-compatibly) carry project / label / cycle / module
// associations. Narrowed here without widening the canonical Task type or
// asserting `any` — mirrors priority.ts's MaybePrioritized pattern. `labels` is
// an id array (a task can carry many labels); the rest are single optional ids.
interface MaybeAssociated {
  projectId?: string | null;
  cycleId?: string | null;
  moduleId?: string | null;
  labels?: string[] | null;
  labelIds?: string[] | null;
}

// Read a task's project / cycle / module id (or null when absent/unset).
function projectOf(task: Task): string | null {
  return (task as MaybeAssociated).projectId ?? null;
}
function cycleOf(task: Task): string | null {
  return (task as MaybeAssociated).cycleId ?? null;
}
function moduleOf(task: Task): string | null {
  return (task as MaybeAssociated).moduleId ?? null;
}
// Read a task's label ids (tolerating either `labels` or `labelIds`), or [].
function labelsOf(task: Task): string[] {
  const m = task as MaybeAssociated;
  return m.labels ?? m.labelIds ?? [];
}
// Map a task's column to its canonical Plane state-group key (board column →
// state group). Keeps the state-group grouping/filtering honest against the four
// board columns we actually have (board.ts): todo → unstarted, in_progress →
// started, pending_review → started, done → completed.
type StateGroupKey = "backlog" | "unstarted" | "started" | "completed" | "cancelled";
const COLUMN_TO_STATE_GROUP: Record<ColumnKey, StateGroupKey> = {
  todo: "unstarted",
  in_progress: "started",
  pending_review: "started",
  done: "completed",
};
const STATE_GROUP_ORDER: StateGroupKey[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
];
const STATE_GROUP_LABELS: Record<StateGroupKey, string> = {
  backlog: "Backlog",
  unstarted: "To Do",
  started: "In Progress",
  completed: "Done",
  cancelled: "Cancelled",
};
function stateGroupOf(task: Task): StateGroupKey {
  return COLUMN_TO_STATE_GROUP[columnForStatus(task.status)];
}

// ── ORDER BY ───────────────────────────────────────────────────────────────
// Sort fields the toolbar's "Ordering" menu exposes. EVERY value here maps to a
// real field that exists on the Task type (core/types.ts) — we do NOT invent a
// sort key Plane shows but our data can't honor:
//   - "title"     → Task.title           (lexical A→Z)
//   - "createdAt" → Task.createdAt        (epoch ms)
//   - "updatedAt" → Task.updatedAt        (epoch ms)
//   - "dueAt"     → Task.dueAt            (epoch ms; null = "no due date")
//   - "priority"  → priorityForTask(task) (urgent→low→none via PRIORITY_ORDER)
// Plane's default ordering is most-recently-created first, so DEFAULT_ORDER_BY
// is "createdAt" + descending.
export type OrderBy = "title" | "createdAt" | "updatedAt" | "dueAt" | "priority";
export type OrderDir = "asc" | "desc";

export const DEFAULT_ORDER_BY: OrderBy = "createdAt";
export const DEFAULT_ORDER_DIR: OrderDir = "desc";

// Rank for the "priority" sort: urgent (highest) → none (lowest). Built off the
// canonical PRIORITY_ORDER so it never drifts from the board/group ordering.
const PRIORITY_RANK: Record<Priority, number> = (() => {
  const order: Priority[] = [...PRIORITY_ORDER, "none"];
  const rank = {} as Record<Priority, number>;
  // Higher number = higher priority, so "asc" puts low first and "desc" puts
  // urgent first — matching Plane (descending priority = urgent at the top).
  order.forEach((p, i) => {
    rank[p] = order.length - i;
  });
  return rank;
})();

// Stable comparator for one OrderBy field, ascending. Nulls (no due date) sort
// LAST in ascending order (Plane keeps undated issues at the bottom). Ties keep
// input order via a createdAt then id fallback so the sort is deterministic.
function compareBy(a: Task, b: Task, orderBy: OrderBy): number {
  switch (orderBy) {
    case "title":
      return a.title.localeCompare(b.title);
    case "priority":
      return PRIORITY_RANK[priorityForTask(a)] - PRIORITY_RANK[priorityForTask(b)];
    case "dueAt": {
      // null = no due date → always sort after any dated task in ascending order.
      const av = a.dueAt;
      const bv = b.dueAt;
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      return av - bv;
    }
    case "updatedAt":
      return a.updatedAt - b.updatedAt;
    default:
      return a.createdAt - b.createdAt;
  }
}

// Sort a COPY of `tasks` by `orderBy`/`dir`. Pure (never mutates the input) and
// deterministic: equal primary keys fall back to createdAt then id so the order
// is stable regardless of the engine's sort stability. The null-due rule is
// applied on the ascending comparator and the whole result is reversed for
// "desc" — except null-due rows, which we keep LAST in both directions to match
// Plane (undated issues never float to the top of a descending due sort).
export function sortTasks(tasks: Task[], orderBy: OrderBy, dir: OrderDir = "asc"): Task[] {
  const sign = dir === "desc" ? -1 : 1;
  return [...tasks].sort((a, b) => {
    // Keep null-due tasks last in BOTH directions (don't let "desc" flip them up).
    if (orderBy === "dueAt") {
      const an = a.dueAt === null;
      const bn = b.dueAt === null;
      if (an !== bn) return an ? 1 : -1;
    }
    const primary = compareBy(a, b, orderBy);
    if (primary !== 0) return sign * primary;
    // Deterministic tie-break: newest-created first, then id.
    const byCreated = a.createdAt - b.createdAt;
    if (byCreated !== 0) return sign * byCreated;
    return sign * a.id.localeCompare(b.id);
  });
}

// ── DISPLAY PROPERTIES ───────────────────────────────────────────────────────
// Which task properties a card / list row renders. Plane's "Display" menu has a
// "Display properties" section that toggles these chips on the card. Each key
// maps to a real Task field (or a derived value) we already render:
//   - "status"   → the status pill / board column membership
//   - "priority" → the priority dot (priorityForTask)
//   - "assignee" → the assignee avatar (resolveAssignee)
//   - "dueAt"    → the due chip (formatDue / dueChipClass)
//   - "scheduled"→ the per-task schedule cadence chip (cronToLabel), shown only
//                  when the task carries a bound schedule (default-hidden when not)
//   - "taskId"   → the short id chip on the card/row
// We do NOT add a display toggle for a property the card can't render.
export type DisplayKey = "status" | "priority" | "assignee" | "dueAt" | "scheduled" | "taskId";

// All display keys default ON — Plane shows every property by default and the
// user opts OUT. A record (not a Set) so it persists cleanly as JSON and reads
// reactively from the preferences store.
export const DEFAULT_DISPLAY: Record<DisplayKey, boolean> = {
  status: true,
  priority: true,
  assignee: true,
  dueAt: true,
  scheduled: true,
  taskId: true,
};

// The display keys in the order the "Display properties" menu lists them. Pairs
// each key with its human label so the menu never hardcodes the labels.
export const DISPLAY_OPTIONS: { key: DisplayKey; label: string }[] = [
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assignee" },
  { key: "dueAt", label: "Due date" },
  { key: "scheduled", label: "Schedule" },
  { key: "taskId", label: "ID" },
];

// Is property `key` currently displayed? Tolerates a partial/absent record
// (older persisted prefs that predate a new key) by defaulting to the
// DEFAULT_DISPLAY value for that key, so a new property shows by default.
export function isDisplayed(prefs: Partial<Record<DisplayKey, boolean>>, key: DisplayKey): boolean {
  return prefs?.[key] ?? DEFAULT_DISPLAY[key];
}

// The active filter set. Empty arrays everywhere = "Overall" (no filtering).
//  - assigneeIds: specific identities (member/cybo/agent ids) to keep.
//  - kinds: the People/Cybos/Agents facet — keep tasks whose assignee resolves
//    to one of these kinds ("user" = People). Unassigned tasks never match a
//    kind filter (nobody is assigned), so a kind filter implicitly hides them.
//  - priorities / statuses: keep tasks in these priority / column buckets.
export interface TaskFilters {
  assigneeIds: string[];
  kinds: AssigneeKind[];
  priorities: Priority[];
  statuses: ColumnKey[];
  // Plane-faithful additions. All OPTIONAL so an older persisted filter (or a
  // call site that only sets the original four facets) deserializes cleanly —
  // every reader below treats an absent facet as "no selection". projects /
  // cycles / modules / labels keep specific association ids; stateGroups keeps
  // state-group keys.
  projects?: string[];
  labels?: string[];
  cycles?: string[];
  modules?: string[];
  stateGroups?: StateGroupKey[];
}

export function emptyFilters(): TaskFilters {
  return {
    assigneeIds: [],
    kinds: [],
    priorities: [],
    statuses: [],
    projects: [],
    labels: [],
    cycles: [],
    modules: [],
    stateGroups: [],
  };
}

// True when no filter is active (the "Overall" default state). Reads the
// optional facets defensively so a filter object that predates them still
// resolves to Overall when the original four are empty.
export function isOverall(f: TaskFilters): boolean {
  return (
    f.assigneeIds.length === 0 &&
    f.kinds.length === 0 &&
    f.priorities.length === 0 &&
    f.statuses.length === 0 &&
    (f.projects?.length ?? 0) === 0 &&
    (f.labels?.length ?? 0) === 0 &&
    (f.cycles?.length ?? 0) === 0 &&
    (f.modules?.length ?? 0) === 0 &&
    (f.stateGroups?.length ?? 0) === 0
  );
}

// Total number of distinct active filter selections — drives the count badge on
// the Filters trigger. Optional facets are `?? 0` so a 4-facet-only object never
// throws and never inflates the count.
export function activeFilterCount(f: TaskFilters): number {
  return (
    f.assigneeIds.length +
    f.kinds.length +
    f.priorities.length +
    f.statuses.length +
    (f.projects?.length ?? 0) +
    (f.labels?.length ?? 0) +
    (f.cycles?.length ?? 0) +
    (f.modules?.length ?? 0) +
    (f.stateGroups?.length ?? 0)
  );
}

// Does a single task survive the active filters? AND across facets, OR within a
// facet. "Overall" (all-empty) passes everything. The optional facets are read
// defensively (absent = no selection) and labels match if ANY of the task's
// labels is in the selected set.
export function matchesFilters(task: Task, f: TaskFilters, pools: AssigneePools): boolean {
  if (f.statuses.length > 0 && !f.statuses.includes(columnForStatus(task.status))) return false;
  if (f.priorities.length > 0 && !f.priorities.includes(priorityForTask(task))) return false;

  const projects = f.projects ?? [];
  if (projects.length > 0) {
    const p = projectOf(task);
    if (!p || !projects.includes(p)) return false;
  }
  const cycles = f.cycles ?? [];
  if (cycles.length > 0) {
    const c = cycleOf(task);
    if (!c || !cycles.includes(c)) return false;
  }
  const modules = f.modules ?? [];
  if (modules.length > 0) {
    const m = moduleOf(task);
    if (!m || !modules.includes(m)) return false;
  }
  const labelFilter = f.labels ?? [];
  if (labelFilter.length > 0) {
    const taskLabels = labelsOf(task);
    if (!taskLabels.some((l) => labelFilter.includes(l))) return false;
  }
  const stateGroups = f.stateGroups ?? [];
  if (stateGroups.length > 0 && !stateGroups.includes(stateGroupOf(task))) return false;

  if (f.kinds.length > 0 || f.assigneeIds.length > 0) {
    const a = resolveAssignee(task.assigneeId, pools);
    if (f.kinds.length > 0) {
      // No assignee can't match a kind facet.
      if (!a || !f.kinds.includes(a.kind)) return false;
    }
    if (f.assigneeIds.length > 0) {
      if (!a || !f.assigneeIds.includes(a.id)) return false;
    }
  }
  return true;
}

export function filterTasks(tasks: Task[], f: TaskFilters, pools: AssigneePools): Task[] {
  if (isOverall(f)) return tasks;
  return tasks.filter((t) => matchesFilters(t, f, pools));
}

// A rendered group: a stable key, a human label, optional metadata for the
// header (priority bucket / resolved assignee kind), and the tasks in it.
export interface TaskGroup {
  key: string;
  label: string;
  // For assignee groups: the identity id (or null for the Unassigned group) so
  // the header can render an AssigneeAvatar. Absent for status/priority groups.
  assigneeId?: string | null;
  kind?: AssigneeKind | null;
  // For status groups: the column key (board uses it as the drop target).
  columnKey?: ColumnKey;
  // For DATA-DRIVEN state groups (group by the project's own task_states): the
  // workflow state id (the drop target written back as `stateId`), the editable
  // color the header swatch/icon tints with, and the canonical Plane phase the
  // StateGroupIcon glyph keys off. Absent for the legacy fixed-column status
  // grouping and every other facet.
  stateId?: string;
  stateColor?: string;
  statePhase?: TaskState["group"];
  // For priority groups: the priority bucket.
  priority?: Priority;
  // For project / label / cycle / module groups: the association id (or null for
  // the "No project / Unlabeled / …" catch-all group).
  associationId?: string | null;
  // For state-group groups: the Plane state-group key.
  stateGroup?: StateGroupKey;
  tasks: Task[];
}

// Group tasks by STATUS into the four fixed board columns, always returning all
// four (empty groups included) so the board renders every column.
export function groupByStatus(tasks: Task[]): TaskGroup[] {
  const groups: TaskGroup[] = COLUMNS.map((c) => ({
    key: c.key,
    label: c.label,
    columnKey: c.key,
    tasks: [] as Task[],
  }));
  const byKey = new Map(groups.map((g) => [g.key, g]));
  for (const task of tasks) {
    byKey.get(columnForStatus(task.status))!.tasks.push(task);
  }
  return groups;
}

// Group tasks by the project's OWN workflow states (data-driven columns) — the
// Plane-faithful board grouping. One group per state in the supplied order
// (the relay returns states by `sequence`), ALWAYS returning every state column
// (empty included) so the board renders the full workflow even before any task
// lands in a column. A task buckets by `stateId`; a task whose stateId is unset
// or references a state not in this list falls back to the FIRST state whose
// canonical phase matches its legacy `status` bucket (so legacy rows that predate
// stateId still land in a sensible column), and otherwise into the first state.
// Each group carries the state's id (drop target), editable color, and phase so
// the header renders the real swatch/icon + the board writes the right stateId.
export function groupByState(tasks: Task[], states: StateLite[]): TaskGroup[] {
  const groups: TaskGroup[] = states.map((s) => ({
    key: s.id,
    label: s.name,
    stateId: s.id,
    stateColor: s.color,
    statePhase: s.group,
    tasks: [] as Task[],
  }));
  const byId = new Map(groups.map((g) => [g.key, g]));
  // First state matching a phase, for legacy (stateId-less) fallback bucketing.
  const firstByPhase = new Map<TaskState["group"], TaskGroup>();
  for (const g of groups) {
    if (g.statePhase && !firstByPhase.has(g.statePhase)) firstByPhase.set(g.statePhase, g);
  }
  // Map a legacy board column to the Plane phase it represents (board.ts columns
  // → phases), so a stateId-less task can fall into a same-phase state column.
  const COLUMN_PHASE: Record<ColumnKey, TaskState["group"]> = {
    todo: "unstarted",
    in_progress: "started",
    pending_review: "started",
    done: "completed",
  };
  const fallback = groups[0];
  for (const task of tasks) {
    const direct = task.stateId ? byId.get(task.stateId) : undefined;
    if (direct) {
      direct.tasks.push(task);
      continue;
    }
    const phase = COLUMN_PHASE[columnForStatus(task.status)];
    (firstByPhase.get(phase) ?? fallback)?.tasks.push(task);
  }
  return groups;
}

// Group tasks by PRIORITY (urgent→low), then a "No priority" group LAST. Only
// non-empty groups are returned (a board/list with no urgent tasks shows no
// urgent column), except we keep at least the buckets that have tasks.
export function groupByPriority(tasks: Task[]): TaskGroup[] {
  const order: Priority[] = [...PRIORITY_ORDER, "none"];
  const labels: Record<Priority, string> = {
    urgent: "Urgent",
    high: "High",
    medium: "Medium",
    low: "Low",
    none: "No priority",
  };
  const byPriority = new Map<Priority, Task[]>();
  for (const p of order) byPriority.set(p, []);
  for (const task of tasks) byPriority.get(priorityForTask(task))!.push(task);
  return order
    .map((p) => ({ key: p, label: labels[p], priority: p, tasks: byPriority.get(p)! }))
    .filter((g) => g.tasks.length > 0);
}

// Group tasks by ASSIGNEE — the "per user / per agent" view. One group per
// resolved identity (members, cybos, agents, unknowns), with the UNASSIGNED
// group always LAST. Identity groups are ordered by first appearance in the
// input so the layout is stable and deterministic.
export function groupByAssignee(tasks: Task[], pools: AssigneePools): TaskGroup[] {
  const identity = new Map<string, TaskGroup>();
  const unassigned: Task[] = [];
  for (const task of tasks) {
    const a = resolveAssignee(task.assigneeId, pools);
    if (!a) {
      unassigned.push(task);
      continue;
    }
    let g = identity.get(a.id);
    if (!g) {
      g = { key: a.id, label: a.name, assigneeId: a.id, kind: a.kind, tasks: [] };
      identity.set(a.id, g);
    }
    g.tasks.push(task);
  }
  const groups = [...identity.values()];
  if (unassigned.length > 0) {
    groups.push({
      key: "__unassigned__",
      label: "Unassigned",
      assigneeId: null,
      kind: null,
      tasks: unassigned,
    });
  }
  return groups;
}

// Group tasks by STATE GROUP (Plane's five-group vocabulary), mapped from the
// board column each task resolves to. Returns the groups in canonical order
// (backlog → cancelled), dropping empty ones — backlog/cancelled have no source
// column today, so they only appear once tasks actually carry those states.
export function groupByStateGroup(tasks: Task[]): TaskGroup[] {
  const byGroup = new Map<StateGroupKey, Task[]>();
  for (const g of STATE_GROUP_ORDER) byGroup.set(g, []);
  for (const task of tasks) byGroup.get(stateGroupOf(task))!.push(task);
  return STATE_GROUP_ORDER.map((g) => ({
    key: g,
    label: STATE_GROUP_LABELS[g],
    stateGroup: g,
    tasks: byGroup.get(g)!,
  })).filter((grp) => grp.tasks.length > 0);
}

// Generic "group by an optional single-id association" (project / cycle /
// module). Buckets by the resolved id, keeping the "None" catch-all (tasks with
// no such association) LAST. Groups are ordered by first appearance so the
// layout is stable + deterministic, mirroring groupByAssignee. `label` resolves
// the id to a display name via `labelFor` (the caller supplies the lookup); the
// catch-all uses `noneLabel`.
function groupBySingleAssociation(
  tasks: Task[],
  idOf: (t: Task) => string | null,
  noneLabel: string,
  labelFor: (id: string) => string,
): TaskGroup[] {
  const byId = new Map<string, TaskGroup>();
  const none: Task[] = [];
  for (const task of tasks) {
    const id = idOf(task);
    if (!id) {
      none.push(task);
      continue;
    }
    let g = byId.get(id);
    if (!g) {
      g = { key: id, label: labelFor(id), associationId: id, tasks: [] };
      byId.set(id, g);
    }
    g.tasks.push(task);
  }
  const groups = [...byId.values()];
  if (none.length > 0) {
    groups.push({ key: "__none__", label: noneLabel, associationId: null, tasks: none });
  }
  return groups;
}

// Group by PROJECT (forward-compatible projectId). "No project" group LAST.
// `labelFor` resolves the project id to a human name; absent (no catalog) it
// falls back to the raw id.
export function groupByProject(
  tasks: Task[],
  labelFor: (id: string) => string = (id) => id,
): TaskGroup[] {
  return groupBySingleAssociation(tasks, projectOf, "No project", labelFor);
}

// Group by CYCLE (forward-compatible cycleId). "No cycle" group LAST. `labelFor`
// resolves the cycle id to a name; absent it falls back to the raw id.
export function groupByCycle(
  tasks: Task[],
  labelFor: (id: string) => string = (id) => id,
): TaskGroup[] {
  return groupBySingleAssociation(tasks, cycleOf, "No cycle", labelFor);
}

// Group by MODULE (forward-compatible moduleId). "No module" group LAST.
// `labelFor` resolves the module id to a name; absent it falls back to the id.
export function groupByModule(
  tasks: Task[],
  labelFor: (id: string) => string = (id) => id,
): TaskGroup[] {
  return groupBySingleAssociation(tasks, moduleOf, "No module", labelFor);
}

// Group by LABEL. A task with MANY labels appears in EVERY matching group (Plane
// behavior — a multi-labelled issue shows under each of its labels). Tasks with
// no labels collect in the "No label" group LAST. Label groups are ordered by
// first appearance for a stable, deterministic layout.
// `labelFor` resolves a label id to its human name; absent (no catalog) it falls
// back to the raw id.
export function groupByLabel(
  tasks: Task[],
  labelFor: (id: string) => string = (id) => id,
): TaskGroup[] {
  const byLabel = new Map<string, TaskGroup>();
  const none: Task[] = [];
  for (const task of tasks) {
    const labels = labelsOf(task);
    if (labels.length === 0) {
      none.push(task);
      continue;
    }
    for (const id of labels) {
      let g = byLabel.get(id);
      if (!g) {
        g = { key: id, label: labelFor(id), associationId: id, tasks: [] };
        byLabel.set(id, g);
      }
      g.tasks.push(task);
    }
  }
  const groups = [...byLabel.values()];
  if (none.length > 0) {
    groups.push({ key: "__none__", label: "No label", associationId: null, tasks: none });
  }
  return groups;
}

// The id→name catalogs the label/cycle/module group-by modes need to resolve a
// group's header to a HUMAN name instead of the raw association id. Each is the
// project's catalog (TasksBoard / TasksList already hold these as props); any
// omitted catalog (or an id missing from it) falls back to the raw id. There is
// no project catalog today, so project grouping still shows the raw projectId.
export interface GroupCatalogs {
  labels?: { id: string; name: string }[];
  cycles?: { id: string; name: string }[];
  modules?: { id: string; name: string }[];
}

// Build an id→name resolver over a catalog; falls back to the raw id for an
// absent catalog or an unknown id.
function nameResolver(catalog?: { id: string; name: string }[]): (id: string) => string {
  if (!catalog || catalog.length === 0) return (id) => id;
  const byId = new Map(catalog.map((c) => [c.id, c.name]));
  return (id) => byId.get(id) ?? id;
}

// Dispatch to the right grouping for the active GROUP BY. `states` is the
// project's workflow states (client.fetchProjectStates); when supplied, the
// "status" grouping becomes DATA-DRIVEN — one column per real project state
// (groupByState) instead of the four fixed legacy columns. Omitting `states`
// (or passing an empty list) keeps the legacy four-column fallback, so a caller
// with no catalog (or the unit tests) still gets a working board. `catalogs`
// supplies the label/cycle/module id→name maps so those group headers show human
// names; omitting it falls back to the raw id.
export function groupTasks(
  tasks: Task[],
  groupBy: GroupBy,
  pools: AssigneePools,
  states: StateLite[] = [],
  catalogs: GroupCatalogs = {},
): TaskGroup[] {
  switch (groupBy) {
    case "assignee":
      return groupByAssignee(tasks, pools);
    case "priority":
      return groupByPriority(tasks);
    case "stateGroup":
      return groupByStateGroup(tasks);
    case "project":
      return groupByProject(tasks);
    case "label":
      return groupByLabel(tasks, nameResolver(catalogs.labels));
    case "cycle":
      return groupByCycle(tasks, nameResolver(catalogs.cycles));
    case "module":
      return groupByModule(tasks, nameResolver(catalogs.modules));
    default:
      return states.length > 0 ? groupByState(tasks, states) : groupByStatus(tasks);
  }
}

// Build the deduped list of assignee identities present across the pools, for
// the Filters > Assignee multi-select. Ordered People → Cybos → Agents so the
// menu mirrors the KIND facet.
export interface AssigneeOption {
  id: string;
  name: string;
  kind: AssigneeKind;
}

export function assigneeOptions(pools: AssigneePools): AssigneeOption[] {
  const out: AssigneeOption[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: AssigneeKind) => {
    if (seen.has(id)) return;
    const a = resolveAssignee(id, pools);
    if (!a) return;
    seen.add(id);
    out.push({ id: a.id, name: a.name, kind });
  };
  for (const m of pools.members) push(m.userId, "user");
  for (const c of pools.cybos) push(c.id, "cybo");
  for (const a of pools.agents) push(a.agentId, "agent");
  return out;
}

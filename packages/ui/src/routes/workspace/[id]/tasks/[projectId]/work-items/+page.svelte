<script lang="ts">
  // Project-scoped Work Items — the rework of the old /tasks orchestrator, now
  // bound to one project. It owns the per-view toolbar state (layout + group-by +
  // filters) locally; because SvelteKit remounts this page per [projectId] route,
  // that local state is naturally project-scoped (switching projects starts each
  // with its own fresh toolbar). Display + Ordering still read the device-global
  // preferencesState, exactly as the old orchestrator did.
  //
  // ROWS ARE SCOPED TO THE PROJECT: we narrow workspaceState.tasks to this
  // project's tasks (task.projectId === projectId) BEFORE filtering / sorting /
  // grouping, so every layout renders only this project's work items.
  //
  // INLINE EDIT: the board card + list inline cells use the shared dropdown EDITORS
  // (StateDropdown / PriorityDropdown / AssigneeDropdown / DateRangeDropdown /
  // LabelDropdown / CycleSelect / ModuleSelect). Those editors are props-controlled,
  // so this page owns the option catalogs (states / labels / cycles / modules,
  // fetched once per project below) and threads them down; each card/row persists
  // its own onChange via client.updateTask. Drag-to-change-status still calls
  // client.updateTask directly inside TasksBoard.
  import { toast } from "svelte-sonner";
  import { page } from "$app/state";
  import { workspaceState, client, projectsCache } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/state/app.svelte.js";
  import TasksBoard from "$lib/components/tasks/TasksBoard.svelte";
  import TasksList from "$lib/components/tasks/TasksList.svelte";
  import TasksCalendar from "$lib/components/tasks/TasksCalendar.svelte";
  import TasksSpreadsheet from "$lib/components/tasks/TasksSpreadsheet.svelte";
  import TasksGantt from "$lib/components/tasks/TasksGantt.svelte";
  import WorkItemsHeader from "$lib/components/tasks/WorkItemsHeader.svelte";
  import WorkItemFiltersRow from "$lib/components/tasks/WorkItemFiltersRow.svelte";
  import TaskSearch from "$lib/components/tasks/TaskSearch.svelte";
  import CreateTaskDialog from "$lib/components/tasks/CreateTaskDialog.svelte";
  import TaskDetailDialog from "$lib/components/tasks/TaskDetailDialog.svelte";
  import TasksEmptyState from "$lib/components/tasks/TasksEmptyState.svelte";
  import LayoutListIcon from "@lucide/svelte/icons/layout-list";
  import SearchIcon from "@lucide/svelte/icons/search";
  import { type AssigneePools } from "$lib/tasks/assignee.js";
  import {
    emptyFilters,
    filterTasks,
    sortTasks,
    type GroupBy,
    type Layout,
    type TaskFilters,
  } from "$lib/tasks/view.js";
  import {
    DEFAULT_GROUP_BY,
    DEFAULT_LAYOUT,
    readProjectView,
    writeProjectView,
  } from "$lib/tasks/local-prefs.js";
  import { projectKeyPrefix } from "$lib/tasks/detail.js";
  import { INBOX_IDENTIFIER, isInboxProjectId, tasksForProject } from "$lib/tasks/constants.js";
  import { preferencesState } from "$lib/state/preferences.svelte.js";
  import type { TaskState, TaskLabel, Cycle, Module } from "$lib/core/types.js";
  import BulkActionToolbar from "$lib/components/tasks/BulkActionToolbar.svelte";
  import { clearSelection } from "$lib/tasks/selection.svelte.js";

  const wsId = $derived(page.params.id ?? "");
  const projectId = $derived(page.params.projectId ?? "");

  // Per-view toolbar state. layout + group-by are the "favorite display" — they
  // are persisted per (workspace, project) to localStorage so reopening a project
  // restores the view the user last chose (see the hydrate/persist effects
  // below). filters stay transient: they're a per-session search action, not a
  // saved display, so a reload should never silently hide tasks behind a filter.
  let layout = $state<Layout>(DEFAULT_LAYOUT);
  let groupBy = $state<GroupBy>(DEFAULT_GROUP_BY);
  let filters = $state<TaskFilters>(emptyFilters());
  // Whether the rich-filter pill row is shown (Plane's Filters toggle). Local per-
  // view state; the per-[projectId] remount resets it with the rest of the toolbar.
  let filtersOpen = $state(false);

  // Restore the saved layout + group-by for this workspace/project. Escape-hatch
  // $effect (syncing reactive state to an external localStorage store): it depends
  // ONLY on wsId/projectId, so switching projects re-hydrates without the persist
  // effect below ever feeding back into it. Declared BEFORE the persist effect so
  // on a project switch hydration runs first and persistence writes the freshly
  // restored value to the new key, never the previous project's value.
  $effect(() => {
    const saved = readProjectView(wsId, projectId);
    layout = saved.layout ?? DEFAULT_LAYOUT;
    groupBy = saved.groupBy ?? DEFAULT_GROUP_BY;
  });

  // Persist the user's chosen display whenever it changes (and write-through the
  // restored value on mount, an idempotent no-op). Keyed per (workspace, project).
  $effect(() => {
    writeProjectView(wsId, projectId, { layout, groupBy });
  });

  let taskDialogOpen = $state(false);

  // Create-dialog pre-population seed. A column's "Add issue" emits its group
  // value so a created task lands in that column; the header "New work item"
  // resets it so a top-level create is never seeded from a prior column add. The
  // project is always seeded so every work item created here belongs to it.
  let taskInitialValues = $state<
    | {
        status?: string;
        assigneeId?: string | null;
        priority?: string;
        dueAt?: number | null;
        stateId?: string;
      }
    | undefined
  >(undefined);

  // Per-project catalog (states / labels / cycles / modules), fetched once per
  // project and threaded into the board cards + list rows so their shared inline
  // editors (props-controlled) have their option lists without refetching per card.
  // Re-fetched when the project changes.
  let projectStates = $state<TaskState[]>([]);
  let projectLabels = $state<TaskLabel[]>([]);
  let projectCycles = $state<Cycle[]>([]);
  let projectModules = $state<Module[]>([]);

  $effect(() => {
    const id = projectId;
    if (!id) return;
    let active = true;
    void Promise.all([
      client.fetchProjectStates(id),
      client.fetchProjectLabels(id),
      client.fetchCycles(id),
      client.fetchModules(id),
    ])
      .then(([states, labels, cycles, modules]) => {
        if (!active) return;
        projectStates = states;
        projectLabels = labels;
        projectCycles = cycles;
        projectModules = modules;
        return undefined;
      })
      // catalog hydration is best-effort context; the board still renders from
      // workspaceState.tasks if a catalog fetch fails.
      // intentional: pending-server catalog fetch; board falls back to tasks state.
      .catch(() => {});
    return () => {
      active = false;
    };
  });

  // The pools every task row resolves its assignee against (members + cybos +
  // agents). Built once + shared so each row is a pure lookup.
  const assigneePools = $derived<AssigneePools>({
    members: workspaceState.members ?? [],
    cybos: cyboState.list ?? [],
    agents: workspaceState.agents ?? [],
  });

  // The project's task-key prefix ("ENG"). The client Project type carries no
  // `identifier` yet (ws-client.ts), so we derive an uppercase ≤4-char fallback
  // from the project name; SEAM: swap in the real identifier when it lands. The
  // synthetic Inbox isn't in the chat-project cache (it's no chat project), so it
  // carries its known "INBOX" identifier directly.
  const project = $derived(
    projectsCache.get(wsId)?.projects.find((p) => p.id === projectId) ?? null,
  );
  const projectIdentifier = $derived(
    isInboxProjectId(projectId) ? INBOX_IDENTIFIER : projectKeyPrefix(project?.name),
  );

  // Tasks narrowed to THIS project. For a chat-linked project that's an exact
  // projectId match; for the Inbox it's every orphan task (projectId null — a task
  // created with no chat project). tasksForProject encapsulates both cases.
  const projectTasks = $derived(tasksForProject(workspaceState.tasks, projectId));

  // Filter ("Overall" = no filter) → sort by the persisted Ordering → the layout
  // groups. Same pipeline as the old orchestrator, over the project-scoped rows.
  const filteredTasks = $derived(
    sortTasks(
      filterTasks(projectTasks, filters, assigneePools),
      preferencesState.tasksOrderBy,
      preferencesState.tasksOrderDir,
    ),
  );

  // The per-group / per-tile quick-add handler shared by every layout (board
  // column "Add issue", calendar day "+", spreadsheet/gantt new row). Seeds the
  // create dialog with the originating bucket's group value and opens it.
  function quickAdd(initialValues?: {
    status?: string;
    assigneeId?: string | null;
    priority?: string;
    dueAt?: number | null;
    stateId?: string;
  }): void {
    taskInitialValues = initialValues;
    taskDialogOpen = true;
  }

  // The board's column-foot INLINE quick-add create handler (Plane's
  // KanbanQuickAddIssue form). It files a work item straight through the SAME
  // create path the create modal uses (client.createTask + one follow-up
  // updateTask for priority / legacy status) — no second create flow — seeded with
  // the originating column's group value so the new item lands in that column. The
  // board owns the composer UI; this owns the RPC + project/state context. The new
  // row appears live via the cyborg:tasks_changed broadcast, so no manual refetch.
  async function createWorkItem(
    title: string,
    initialValues: {
      status?: string;
      assigneeId?: string | null;
      priority?: string;
      dueAt?: number | null;
      stateId?: string;
    },
  ): Promise<boolean> {
    const trimmed = title.trim();
    if (!trimmed) return false;
    // Data-driven status columns file straight into a workflow state — the seeded
    // column state, or the project's first/backlog state when none is seeded
    // (mirrors CreateTaskDialog.defaultStateId). assigneeId + dueAt also ride the
    // create RPC, which honors them directly.
    const hasStates = projectStates.length > 0;
    const stateId =
      (hasStates ? (initialValues.stateId ?? projectStates[0]?.id) : initialValues.stateId) ??
      undefined;
    try {
      const created = await client.createTask(wsId, trimmed, {
        assigneeId: initialValues.assigneeId ?? undefined,
        dueAt: initialValues.dueAt ?? undefined,
        projectId: projectId || undefined,
        stateId,
      });
      // priority (and legacy status, only when the project has NO state catalog)
      // aren't filed by create_task, so apply a non-default choice with ONE
      // follow-up update — mirroring CreateTaskDialog.confirm. A failed follow-up
      // must NOT fail the create (the work item already exists): log and move on.
      const updates: { status?: string; priority?: string } = {};
      if (initialValues.priority && initialValues.priority !== "none") {
        updates.priority = initialValues.priority;
      }
      if (!hasStates && initialValues.status && initialValues.status !== created.status) {
        updates.status = initialValues.status;
      }
      if (updates.status !== undefined || updates.priority !== undefined) {
        try {
          await client.updateTask(wsId, created.id, updates);
        } catch (err) {
          console.error("Failed to apply priority/status to the new work item", err);
        }
      }
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the work item.");
      return false;
    }
  }

  // Bulk selection is a LIST-layout affordance and is project-scoped: drop it when
  // the project changes or when the user leaves the list layout, so a stale toolbar
  // never floats over the board/calendar or carries another project's ids.
  $effect(() => {
    void projectId; // tracked dep: re-run (→ cleanup clears) on project change
    if (layout !== "list") clearSelection();
    return () => clearSelection();
  });
</script>

<div class="flex h-full w-full flex-col overflow-hidden">
  <!-- Plane work-items header: layout switch + Display popover + Filters toggle +
       count chip + New work item. Data-driven group-by/filters read the catalog. -->
  <WorkItemsHeader
    bind:layout
    bind:groupBy
    bind:filtersOpen
    {filters}
    count={filteredTasks.length}
    onnew={() => {
      taskInitialValues = undefined;
      taskDialogOpen = true;
    }}
  />

  <!-- Workspace-wide task search (title + description, enriched results). Lives in
       the board header region; matches span ALL projects and a result navigates to
       that task wherever it lives. Localized to the header — rows are untouched. -->
  <div class="flex items-center border-b border-edge px-4 py-1.5">
    <TaskSearch workspaceId={wsId} />
  </div>

  <!-- Rich filter pill row (shown when the header's Filters toggle is on). -->
  {#if filtersOpen}
    <WorkItemFiltersRow
      bind:filters
      pools={assigneePools}
      labels={projectLabels}
      cycles={projectCycles}
      modules={projectModules}
    />
  {/if}

  <!-- Content area: fills the full width + height of the view. The board/list are
       DATA-DRIVEN from the project's states (one column per real workflow state);
       calendar/spreadsheet/gantt position by date/row as before. -->
  <!-- min-w-0 lets the board's own overflow-x-auto scroller stay viewport-bounded:
       without it a flex child's default min-width:auto could let wide board content
       widen this cell and defeat the inner horizontal scroll on a narrow screen. -->
  <div class="min-h-0 min-w-0 flex-1">
    {#if projectTasks.length === 0}
      <!-- Zero work items in this project: the designed empty state with a CTA that
           opens the create dialog (the same path as the header's New work item). -->
      <TasksEmptyState
        icon={LayoutListIcon}
        heading="Create work items and assign them to your team"
        description="Work items are the issues, tasks, and bugs your team tracks. Capture work, set priorities and due dates, and move it across your project's workflow."
        ctaLabel="Create work item"
        onCta={() => {
          taskInitialValues = undefined;
          taskDialogOpen = true;
        }}
      />
    {:else if filteredTasks.length === 0}
      <!-- Work items exist but the active filters hide them all: the no-results
           variant (search glyph) with a Clear filters CTA. -->
      <TasksEmptyState
        icon={SearchIcon}
        heading="No matching results."
        description="No work items match the current filters. Try adjusting your search terms or clearing the filters."
        ctaLabel="Clear filters"
        onCta={() => (filters = emptyFilters())}
      />
    {:else if layout === "list"}
      <TasksList
        workspaceId={wsId}
        tasks={filteredTasks}
        pools={assigneePools}
        states={projectStates}
        labels={projectLabels}
        cycles={projectCycles}
        modules={projectModules}
        {projectIdentifier}
        {groupBy}
        oncreate={quickAdd}
      />
    {:else if layout === "calendar"}
      <TasksCalendar workspaceId={wsId} tasks={filteredTasks} pools={assigneePools} {groupBy} oncreate={quickAdd} />
    {:else if layout === "spreadsheet"}
      <TasksSpreadsheet
        workspaceId={wsId}
        tasks={filteredTasks}
        pools={assigneePools}
        states={projectStates}
        labels={projectLabels}
        {projectIdentifier}
        {groupBy}
        oncreate={quickAdd}
      />
    {:else if layout === "gantt"}
      <TasksGantt workspaceId={wsId} tasks={filteredTasks} pools={assigneePools} {groupBy} oncreate={quickAdd} />
    {:else}
      <TasksBoard
        workspaceId={wsId}
        tasks={filteredTasks}
        pools={assigneePools}
        states={projectStates}
        labels={projectLabels}
        cycles={projectCycles}
        modules={projectModules}
        {projectIdentifier}
        {groupBy}
        oncreate={quickAdd}
        onquickcreate={createWorkItem}
      />
    {/if}
  </div>

  <!-- Sticky-bottom BULK action bar — renders only while ≥1 list row is selected
       (the selection store gates it). Last child of the root column so it pins to
       the view foot, below the content area. -->
  <BulkActionToolbar workspaceId={wsId} />
</div>

<CreateTaskDialog
  bind:open={taskDialogOpen}
  workspaceId={wsId}
  initialValues={taskInitialValues}
  {projectId}
  states={projectStates}
/>
<!-- The in-board "peek" modal for the editable task detail card. -->
<TaskDetailDialog workspaceId={wsId} />

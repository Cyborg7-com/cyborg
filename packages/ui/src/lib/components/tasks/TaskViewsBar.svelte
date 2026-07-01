<script lang="ts">
  // "Department Views" bar — a VISIBLE horizontal tab strip above the board that
  // slices the work items by department. A department IS a project label; a view
  // filters the board to tasks carrying any of its label ids. Everything here is
  // CLIENT-ONLY and persisted in localStorage (readTaskViews/writeTaskViews),
  // keyed per (workspace, project) so each project keeps its own departments.
  //
  // Tabs: All (clears filters) · <department> · … · ＋ New. Clicking a tab sets it
  // active and hands the page a TaskFilters via `onapply` — the page owns the
  // board's `filters` state, so its `filteredTasks` re-derives automatically. The
  // bar never touches the board directly.
  //
  // Departments materialize on prod by TAGGING a task: there's no bare create-
  // label RPC, so a brand-new department name only becomes a real label once a
  // task carries it. The create dialog links EXISTING project labels for instant
  // filtering; a typed new name is stored on the view and lit up when the first
  // task is tagged with it (the page's empty-state CTA drives that — `onseed`).
  //
  // Token-only: reuse tabBar/tabActive/tabIdle + the app.css --label-* palette for
  // the department dot (same dotFill idiom as LabelDropdown). No raw color values.
  import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
  } from "$lib/components/ui/dropdown-menu/index.js";
  import LabelDropdown from "$lib/components/tasks/LabelDropdown.svelte";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import type { TaskLabel } from "$lib/core/types.js";
  import { emptyFilters, type TaskFilters } from "$lib/tasks/view.js";
  import {
    readTaskViews,
    writeTaskViews,
    type TaskView,
    type TaskViewsState,
  } from "$lib/tasks/local-prefs.js";
  import {
    tabBar,
    tabActive,
    tabIdle,
    modalPanel,
    modalHeader,
    modalBody,
    modalFooter,
    fieldLabel,
    titleInput,
    btnPrimary,
    btnSecondary,
    labelChipDot,
  } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";
  import { untrack } from "svelte";

  let {
    workspaceId,
    projectId,
    labels = [],
    onapply,
    onassigntask,
    workItemCount = 0,
    onassignall,
    activeDepartment = $bindable(null),
  }: {
    workspaceId: string;
    projectId: string;
    // The project's label catalog (from the page's fetchProjectLabels). Used both
    // for the create-dialog picker and to resolve a view's dot color + to relink a
    // new-name view to its label once it exists.
    labels?: TaskLabel[];
    // Apply a view's filter to the page. Called on tab click AND on mount (restore
    // the persisted active view). "All" applies emptyFilters().
    onapply: (filters: TaskFilters) => void;
    // Drag a task card onto a tab → move it into the department: the page owns the
    // task + updateTask; we hand it the target label name + the dragged task id.
    onassigntask: (labelName: string, taskId: string) => void;
    // How many work items the project has (for the create/edit dialog's opt-in
    // "add all N work items" checkbox — the one-time way to seed a department with
    // the legacy tasks that predate departments).
    workItemCount?: number;
    // Tag EVERY work item in the project with a label (the dialog's "add all" opt-in).
    onassignall: (labelName: string) => void;
    // The active department's name (or null for "All") — the page reads this to show
    // a department-aware empty state instead of the generic "no matching results".
    activeDepartment?: string | null;
  } = $props();

  // The persisted views + active id. Owned here; every mutation writes through.
  let viewsState = $state<TaskViewsState>({ views: [], activeId: null });

  // The app.css --label-* palette (mirrors LabelDropdown). A color name outside it
  // degrades to "grey" so a view dot never emits a missing class.
  const PALETTE = ["indigo", "emerald", "grey", "crimson", "yellow", "orange", "pink", "purple"];
  // A view's dot color = its first linked label's color; no linked label → no dot.
  function dotClassFor(view: TaskView): string | null {
    const first = view.labelIds.find((id) => labels.some((l) => l.id === id));
    const label = first ? labels.find((l) => l.id === first) : undefined;
    if (!label) return null;
    const c = PALETTE.includes(label.color) ? label.color : "grey";
    return `bg-label-${c}-text`;
  }

  // Does the active view resolve to a real label yet? A new-name department with no
  // linked label id (or whose ids aren't in the catalog) is "empty" — the board
  // shows the seed-the-first-task empty state instead of an all-hiding filter.
  const activeView = $derived(viewsState.views.find((v) => v.id === viewsState.activeId) ?? null);
  // Expose the active department's name (null for "All") so the page can render a
  // department-aware empty state (one message, not a banner + generic double).
  $effect(() => {
    activeDepartment = activeView ? activeView.name : null;
  });

  function persist(): void {
    writeTaskViews(workspaceId, projectId, viewsState);
  }

  // crypto.randomUUID needs a secure context (present on https/localhost, but not
  // guaranteed in every desktop/mobile shell) — fall back to a good-enough local id.
  function newViewId(): string {
    return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // The filter KEYS a department matches. The board's matchesFilters compares
  // f.labels against labelsOf(task), which returns label NAMES for freshly-tagged
  // tasks but IDS for others — so we include BOTH: every label id (stored links +
  // any catalog label whose NAME equals the department) AND those names + the
  // department name itself. Matching on id-or-name is robust to id/name drift and
  // duplicate labels, so anything tagged with the department name lands here.
  // A brand-new department (no matching label yet) still yields just its own name,
  // which no task carries → an empty board, driving the department empty state.
  function departmentKeys(view: TaskView): string[] {
    const target = view.name.trim().toLowerCase();
    const linkedIds = view.labelIds.filter((id) => labels.some((l) => l.id === id));
    const named = labels.filter((l) => l.name.trim().toLowerCase() === target);
    const linkedNames = linkedIds
      .map((id) => labels.find((l) => l.id === id)?.name)
      .filter((n): n is string => Boolean(n));
    return [
      ...new Set([
        ...linkedIds,
        ...named.map((l) => l.id),
        ...named.map((l) => l.name),
        ...linkedNames,
        view.name,
      ]),
    ];
  }

  function filtersFor(view: TaskView | null): TaskFilters {
    if (!view) return emptyFilters();
    return { ...emptyFilters(), labels: departmentKeys(view) };
  }

  // Signature of the currently-applied view = its id + its RESOLVED label ids. The
  // labels effect re-applies only when this changes (mount, or a department's label
  // just materialized), so a manual funnel filter set within a view isn't clobbered
  // by an unrelated label refetch.
  let appliedSig = "";
  function sigFor(view: TaskView | null): string {
    const keys = view ? departmentKeys(view).slice().sort() : [];
    return `${view ? view.id : "all"}|${keys.join(",")}`;
  }

  // Apply a view's filter to the page. A view OWNS the board filter — switching a
  // view REPLACES the filters; the funnel row still layers on top until you switch.
  function apply(view: TaskView | null): void {
    appliedSig = sigFor(view);
    onapply(filtersFor(view));
  }

  function selectAll(): void {
    viewsState.activeId = null;
    persist();
    apply(null);
  }

  function selectView(view: TaskView): void {
    viewsState.activeId = view.id;
    persist();
    apply(view);
  }

  // ── Create / edit department dialog ────────────────────────────────────────
  let dialogOpen = $state(false);
  // The view being edited, or null when creating a new one.
  let editing = $state<TaskView | null>(null);
  let draftName = $state("");
  let draftLabelIds = $state<string[]>([]);
  // A typed-but-not-yet-created label name (from LabelDropdown's onCreate). We
  // can't create a bare label on prod, so we stash the name and materialize the
  // department on save; the first tagged task lights it up.
  let pendingName = $state<string | null>(null);
  // Opt-in: on save, tag EVERY work item with this department (the one-time way to
  // move the legacy "All" tasks in). Reset each time the dialog opens.
  let draftAssignAll = $state(false);

  function openCreate(): void {
    editing = null;
    draftName = "";
    draftLabelIds = [];
    pendingName = null;
    draftAssignAll = false;
    dialogOpen = true;
  }

  function openEdit(view: TaskView): void {
    editing = view;
    draftName = view.name;
    draftLabelIds = [...view.labelIds];
    pendingName = null;
    draftAssignAll = false;
    dialogOpen = true;
  }

  const canSave = $derived(draftName.trim().length > 0 || pendingName !== null);

  function save(): void {
    // If the user typed a new label name but linked no existing label, use the
    // typed name as the department name (and try to link a label that already
    // matches it, so an existing label filters immediately).
    const name = (draftName.trim() || pendingName || "").trim();
    if (!name) return;
    const matched = labels.find((l) => l.name.toLowerCase() === name.toLowerCase());
    const labelIds = [...new Set([...draftLabelIds, ...(matched ? [matched.id] : [])])];

    if (editing) {
      editing.name = name;
      editing.labelIds = labelIds;
      // Re-apply if we're editing the active view so the board reflects new labels.
      if (viewsState.activeId === editing.id) apply(editing);
    } else {
      const view: TaskView = { id: newViewId(), name, labelIds };
      viewsState.views.push(view);
      viewsState.activeId = view.id;
      apply(view);
    }
    persist();
    // Opt-in bulk seed: tag every work item with the department's NAME (what the
    // department filters on — matching by name avoids the rename/link drift where
    // tasks got a stale label the renamed department no longer matches).
    if (draftAssignAll && workItemCount > 0) {
      onassignall(name);
    }
    dialogOpen = false;
  }

  function rename(view: TaskView): void {
    openEdit(view);
  }

  function remove(view: TaskView): void {
    // Deleting a view is localStorage-only — it never deletes the label. If the
    // deleted view was active, fall back to "All".
    viewsState.views = viewsState.views.filter((v) => v.id !== view.id);
    if (viewsState.activeId === view.id) {
      viewsState.activeId = null;
      apply(null);
    }
    persist();
  }

  // ── Drag: reorder tabs, and drop a task CARD onto a tab to move it there ────────
  // Two drag sources land on a department tab: another TAB (custom mime → reorder),
  // or a task CARD from the board (text/plain = task id, set by TasksBoard → tag the
  // task with this department's label). No buttons — pure drag.
  const VIEW_DND = "application/x-cyborg-view";
  let draggingViewId = $state<string | null>(null);
  let dropTargetId = $state<string | null>(null);

  // Tag with the department's NAME — that's what it filters on (departmentKeys),
  // so a card dropped on a tab always lands in the department, no id/name drift.
  function labelNameFor(view: TaskView): string {
    return view.name;
  }

  function startViewDrag(e: DragEvent, viewId: string): void {
    draggingViewId = viewId;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(VIEW_DND, viewId);
    }
  }
  function endDrag(): void {
    draggingViewId = null;
    dropTargetId = null;
  }
  function onTabDragOver(e: DragEvent, viewId: string): void {
    const types = e.dataTransfer?.types ?? [];
    // Accept a dragged tab (reorder) or a dragged card (task id).
    if (types.includes(VIEW_DND) || types.includes("text/plain")) {
      e.preventDefault();
      dropTargetId = viewId;
    }
  }
  function onTabDrop(e: DragEvent, view: TaskView): void {
    e.preventDefault();
    dropTargetId = null;
    const draggedView = e.dataTransfer?.getData(VIEW_DND);
    if (draggedView) {
      reorderView(draggedView, view.id);
      return;
    }
    const taskId = e.dataTransfer?.getData("text/plain");
    if (taskId) onassigntask(labelNameFor(view), taskId);
  }
  function reorderView(fromId: string, toId: string): void {
    if (fromId === toId) return;
    const arr = [...viewsState.views];
    const from = arr.findIndex((v) => v.id === fromId);
    const to = arr.findIndex((v) => v.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    viewsState.views = arr;
    persist();
  }

  // Hydrate views from localStorage on project switch. Applying the active view is
  // left to the labels effect below so it waits for the catalog to load.
  $effect(() => {
    const ws = workspaceId;
    const pj = projectId;
    viewsState = readTaskViews(ws, pj);
    appliedSig = ""; // force a fresh apply for the newly-loaded project
  });

  // React to the label catalog loading / changing (incl. a new department's first
  // task materializing its label): (1) relink new-name views to their label by
  // name, then (2) apply the active view IF its resolved shape changed (mount +
  // materialize) — never clobbering a manual filter on an unrelated refetch.
  // viewsState is read/written UNTRACKED so this effect depends only on the catalog
  // + project (no self-triggered loop).
  $effect(() => {
    const cat = labels;
    const pj = projectId;
    void pj;
    untrack(() => {
      let changed = false;
      for (const v of viewsState.views) {
        if (v.labelIds.some((id) => cat.some((l) => l.id === id))) continue;
        const match = cat.find((l) => l.name.toLowerCase() === v.name.toLowerCase());
        if (match) {
          v.labelIds = [...new Set([...v.labelIds, match.id])];
          changed = true;
        }
      }
      if (changed) persist();
      const active = viewsState.views.find((v) => v.id === viewsState.activeId) ?? null;
      if (sigFor(active) !== appliedSig) apply(active);
    });
  });
</script>

<div class="flex items-center justify-between border-b border-edge pr-2">
  <!-- Horizontal-scrolling tab strip. tabBar already carries the bottom border +
       px; we drop its border here (the wrapper owns it) so a long strip scrolls
       cleanly under the row. -->
  <div class={cn(tabBar, "min-w-0 flex-1 overflow-x-auto border-b-0")}>
    <button
      type="button"
      class={cn("shrink-0 whitespace-nowrap", viewsState.activeId === null ? tabActive : tabIdle)}
      onclick={selectAll}
    >
      All
    </button>

    {#each viewsState.views as view (view.id)}
      {@const dot = dotClassFor(view)}
      <!-- Each department tab: click to activate; a ⋯ menu renames / deletes it.
           DRAG the tab to reorder; DROP a task card on it to move the task here.
           A highlight ring marks the active drop target. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class={cn(
          "flex shrink-0 items-center gap-1 rounded-[6px]",
          dropTargetId === view.id && "ring-1 ring-accent ring-inset",
          draggingViewId === view.id && "opacity-50",
        )}
        role="group"
        ondragover={(e) => onTabDragOver(e, view.id)}
        ondragleave={() => {
          if (dropTargetId === view.id) dropTargetId = null;
        }}
        ondrop={(e) => onTabDrop(e, view)}
      >
        <button
          type="button"
          draggable="true"
          ondragstart={(e) => startViewDrag(e, view.id)}
          ondragend={endDrag}
          class={cn(
            "flex cursor-grab items-center gap-1.5 whitespace-nowrap active:cursor-grabbing",
            viewsState.activeId === view.id ? tabActive : tabIdle,
          )}
          onclick={() => selectView(view)}
        >
          {#if dot}
            <span class={cn(labelChipDot, dot)}></span>
          {/if}
          {view.name}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            class="grid size-5 place-items-center rounded-[4px] text-content-dim transition-colors hover:bg-hover-gray hover:text-content"
            aria-label={`Options for ${view.name}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="19" cy="12" r="1.6" />
            </svg>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => rename(view)}>Rename…</DropdownMenuItem>
            <DropdownMenuItem class="text-error" onSelect={() => remove(view)}>Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    {/each}

    <button
      type="button"
      class={cn(tabIdle, "flex shrink-0 items-center gap-1 whitespace-nowrap")}
      onclick={openCreate}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      New
    </button>
  </div>
</div>

<Dialog bind:open={dialogOpen}>
  <DialogContent class={cn(modalPanel, "p-0 sm:max-w-md")}>
    <div class={modalHeader}>
      <DialogTitle class="text-[15px] font-semibold text-content">
        {editing ? "Edit department" : "New department"}
      </DialogTitle>
      <DialogDescription class="sr-only">
        Name the department and pick the project labels it filters by.
      </DialogDescription>
    </div>

    <div class={modalBody}>
      <div class="flex flex-col gap-1.5">
        <label for="dept-name" class={fieldLabel}>Name</label>
        <input
          id="dept-name"
          bind:value={draftName}
          placeholder="Engineering"
          class={cn(titleInput, "text-[15px]")}
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <span class={fieldLabel}>Labels</span>
        <LabelDropdown
          value={draftLabelIds}
          options={labels}
          variant="row"
          placeholder="Pick labels to filter by"
          onChange={(next) => (draftLabelIds = next)}
          onCreate={(name) => {
            // No bare create-label RPC on prod: stash the typed name so save()
            // uses it as the department name; the first tagged task materializes
            // the label and relinks the view. If the name already matches an
            // existing label, save() links it for instant filtering.
            pendingName = name;
            if (!draftName.trim()) draftName = name;
          }}
        />
        <span class="text-[12px] text-content-muted">
          Filters the board to tasks with these labels. A new name links its label
          once the first task is tagged.
        </span>
      </div>

      {#if workItemCount > 0}
        <label class="flex cursor-pointer items-start gap-2 text-[13px] text-content">
          <input type="checkbox" bind:checked={draftAssignAll} class="mt-0.5" />
          <span>
            Add all {workItemCount} work items from All into this department.
            <span class="block text-[12px] text-content-muted">
              One-time way to move existing tasks in — drag cards onto the tab for the rest.
            </span>
          </span>
        </label>
      {/if}
    </div>

    <div class={modalFooter}>
      <button type="button" class={btnSecondary} onclick={() => (dialogOpen = false)}>Cancel</button>
      <button type="button" class={btnPrimary} onclick={save} disabled={!canSave}>
        {editing ? "Save" : "Create"}
      </button>
    </div>
  </DialogContent>
</Dialog>

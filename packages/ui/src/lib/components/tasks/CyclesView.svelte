<script lang="ts">
  // CyclesView — Plane's project Cycles surface. A master/detail: the LEFT is a
  // list of the project's cycles (name + date range + an active badge); selecting
  // one reveals its WORK-ITEMS BOARD on the right, REUSING TasksBoard over the
  // cycle's tasks (task.cycleId === cycle.id) so a cycle board behaves exactly like
  // the main board (group by the project's real states, drag-to-state, the same
  // card). The board is data-driven from the project's task_states — no hardcoded
  // columns. The catalog is editable: the empty-state CTA + the header "New cycle"
  // button open a create form (name + optional start/end dates) that calls
  // client.createCycle then refreshes the list; each row carries a hover-revealed
  // delete affordance gated behind a confirm dialog. Token-only.
  import { workspaceState, client, projectsCache } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/state/app.svelte.js";
  import TasksBoard from "$lib/components/tasks/TasksBoard.svelte";
  import TaskDetailDialog from "$lib/components/tasks/TaskDetailDialog.svelte";
  import TasksEmptyState from "$lib/components/tasks/TasksEmptyState.svelte";
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import LayoutListIcon from "@lucide/svelte/icons/layout-list";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { type AssigneePools } from "$lib/tasks/assignee.js";
  import { projectKeyPrefix } from "$lib/tasks/detail.js";
  import type { Cycle, TaskState, TaskLabel } from "$lib/core/types.js";
  import {
    subNavRow,
    subNavLabel,
    subNavCount,
    controlBtn,
    btnPrimary,
    btnSecondary,
    modalBody,
    modalFooter,
    modalHeader,
    modalPanel,
    fieldLabel,
  } from "$lib/tasks/ui.js";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";
  import { cn } from "$lib/utils.js";

  let { wsId, projectId }: { wsId: string; projectId: string } = $props();

  let cycles = $state<Cycle[]>([]);
  let states = $state<TaskState[]>([]);
  let labels = $state<TaskLabel[]>([]);
  let loading = $state(true);
  let selectedId = $state<string | null>(null);

  $effect(() => {
    const id = projectId;
    if (!id) return;
    let active = true;
    loading = true;
    selectedId = null;
    void Promise.all([
      client.fetchCycles(id),
      client.fetchProjectStates(id),
      client.fetchProjectLabels(id),
    ])
      .then(([c, s, l]) => {
        if (!active) return;
        cycles = c;
        states = s;
        labels = l;
        // Default to the first cycle so the board is visible immediately.
        selectedId = c[0]?.id ?? null;
        loading = false;
        return undefined;
      })
      .catch(() => {
        if (active) loading = false;
      });
    return () => {
      active = false;
    };
  });

  // ─── Create-cycle form ───────────────────────────────────────────
  // The create dialog is driven by both the empty-state CTA and the header
  // "New cycle" button. Dates are optional <input type="date"> values
  // (YYYY-MM-DD) converted to epoch ms on submit; on success we refetch the
  // catalog and select the freshly created cycle.
  let createOpen = $state(false);
  let formName = $state("");
  let formStart = $state("");
  let formEnd = $state("");
  let saving = $state(false);
  let formError = $state<string | null>(null);

  const canCreate = $derived(formName.trim().length > 0 && !saving);

  // Reset transient form state each time the dialog opens.
  $effect(() => {
    if (!createOpen) return;
    formName = "";
    formStart = "";
    formEnd = "";
    formError = null;
    saving = false;
  });

  // A YYYY-MM-DD date input → epoch ms (local midnight), or null when empty.
  function dateToEpoch(value: string): number | null {
    if (!value) return null;
    const ts = new Date(`${value}T00:00:00`).getTime();
    return Number.isNaN(ts) ? null : ts;
  }

  async function submitCreate(): Promise<void> {
    if (!canCreate) return;
    saving = true;
    formError = null;
    try {
      const created = await client.createCycle(projectId, {
        name: formName.trim(),
        startDate: dateToEpoch(formStart),
        endDate: dateToEpoch(formEnd),
      });
      // Refresh the catalog from the server so the list reflects server-side
      // ordering, then select the cycle we just made.
      cycles = await client.fetchCycles(projectId);
      selectedId = created.id;
      createOpen = false;
    } catch (err) {
      formError = err instanceof Error ? err.message : "Couldn't create the cycle.";
    } finally {
      saving = false;
    }
  }

  // ─── Delete-cycle confirm ────────────────────────────────────────
  let pendingDelete = $state<Cycle | null>(null);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  $effect(() => {
    if (!pendingDelete) return;
    deleteError = null;
    deleting = false;
  });

  async function confirmDelete(): Promise<void> {
    const target = pendingDelete;
    if (!target || deleting) return;
    deleting = true;
    deleteError = null;
    try {
      await client.deleteCycle(target.id);
      cycles = cycles.filter((c) => c.id !== target.id);
      if (selectedId === target.id) selectedId = cycles[0]?.id ?? null;
      pendingDelete = null;
    } catch (err) {
      deleteError = err instanceof Error ? err.message : "Couldn't delete the cycle.";
    } finally {
      deleting = false;
    }
  }

  const project = $derived(
    projectsCache.get(wsId)?.projects.find((p) => p.id === projectId) ?? null,
  );
  const projectIdentifier = $derived(projectKeyPrefix(project?.name));

  const assigneePools = $derived<AssigneePools>({
    members: workspaceState.members ?? [],
    cybos: cyboState.list ?? [],
    agents: workspaceState.agents ?? [],
  });

  const selected = $derived(cycles.find((c) => c.id === selectedId) ?? null);
  // The selected cycle's work items — narrowed off the already-loaded tasks.
  const cycleTasks = $derived(
    selectedId ? workspaceState.tasks.filter((t) => t.cycleId === selectedId) : [],
  );

  function isActive(c: Cycle): boolean {
    const now = Date.now();
    return c.startDate != null && c.endDate != null && c.startDate <= now && now <= c.endDate;
  }
  function fmt(ts: number | null): string {
    if (ts == null) return "—";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function countFor(c: Cycle): number {
    return workspaceState.tasks.filter((t) => t.cycleId === c.id).length;
  }
</script>

<div class="flex h-full w-full flex-col overflow-hidden">
  <header class="flex items-center gap-3 border-b border-edge px-6 py-4">
    <h1 class="text-base font-semibold text-content">Cycles</h1>
    {#if !loading && cycles.length > 0}
      <button type="button" class={cn(controlBtn, "ml-auto")} onclick={() => (createOpen = true)}>
        <PlusIcon class="size-3.5" />
        New cycle
      </button>
    {/if}
  </header>

  {#if loading}
    <p class="px-6 py-4 text-[13px] text-content-muted">Loading cycles…</p>
  {:else if cycles.length === 0}
    <div class="min-h-0 flex-1">
      <TasksEmptyState
        icon={RefreshCwIcon}
        heading="Group and timebox your work in Cycles."
        description="Break work down by timeboxed chunks, work backwards from your project deadline to set dates, and make tangible progress as a team."
        ctaLabel="Create cycle"
        onCta={() => (createOpen = true)}
      />
    </div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <!-- Cycle list (master) -->
      <aside class="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-edge bg-surface-alt p-2">
        {#each cycles as cycle (cycle.id)}
          <!-- A cycle row: the selecting button + a hover-revealed delete button
               sit side by side (a button can't nest inside another button). -->
          <div
            class={cn(
              "group flex items-center rounded-[4px]",
              selectedId === cycle.id && "bg-dropdown-selected",
            )}
          >
            <button
              type="button"
              onclick={() => (selectedId = cycle.id)}
              class={cn(subNavRow, "min-w-0 flex-1 bg-transparent hover:bg-transparent", selectedId === cycle.id && "text-content")}
            >
              <span class="flex min-w-0 flex-col items-start">
                <span class={cn(subNavLabel, "flex items-center gap-1.5")}>
                  {cycle.name}
                  {#if isActive(cycle)}
                    <span class="rounded-full bg-online/15 px-1.5 text-[10px] font-medium text-online">Active</span>
                  {/if}
                </span>
                <span class="text-[11px] text-content-muted">{fmt(cycle.startDate)} – {fmt(cycle.endDate)}</span>
              </span>
              <span class={subNavCount}>{countFor(cycle)}</span>
            </button>
            <button
              type="button"
              onclick={() => (pendingDelete = cycle)}
              class="mr-1 grid size-6 shrink-0 place-items-center rounded-[4px] text-content-muted opacity-0
                transition focus-ring hover:bg-hover-gray hover:text-error focus-visible:opacity-100
                group-hover:opacity-100"
              aria-label="Delete {cycle.name}"
            >
              <Trash2Icon class="size-3.5" />
            </button>
          </div>
        {/each}
      </aside>

      <!-- Selected cycle's work-items board (detail) -->
      <div class="min-w-0 flex-1">
        {#if selected}
          {#if cycleTasks.length === 0}
            <TasksEmptyState
              icon={LayoutListIcon}
              heading="No work items in {selected.name}"
              description="Assign a work item to this cycle to track its progress here."
            />
          {:else}
            <TasksBoard
              workspaceId={wsId}
              tasks={cycleTasks}
              pools={assigneePools}
              {states}
              {labels}
              {projectIdentifier}
              groupBy="status"
            />
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>

<TaskDetailDialog workspaceId={wsId} />

<!-- Create-cycle dialog: name (required) + optional start/end dates. -->
<Dialog bind:open={createOpen}>
  <DialogContent class={cn(modalPanel, "max-w-md p-0 sm:max-w-md")} showCloseButton={false}>
    <div class={modalHeader}>
      <DialogTitle class="text-[15px] font-semibold text-content">New cycle</DialogTitle>
    </div>

    <div class={modalBody}>
      <div class="flex flex-col gap-1.5">
        <label for="cycle-name" class={fieldLabel}>Name</label>
        <input
          id="cycle-name"
          type="text"
          bind:value={formName}
          placeholder="Cycle name"
          class={fieldInputClass}
          onkeydown={(e) => {
            if (e.key === "Enter") void submitCreate();
          }}
        />
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1.5">
          <label for="cycle-start" class={fieldLabel}>Start date</label>
          <input id="cycle-start" type="date" bind:value={formStart} class={fieldInputClass} />
        </div>
        <div class="flex flex-col gap-1.5">
          <label for="cycle-end" class={fieldLabel}>End date</label>
          <input id="cycle-end" type="date" bind:value={formEnd} class={fieldInputClass} />
        </div>
      </div>

      {#if formError}
        <p class="text-[12px] text-error" role="alert">{formError}</p>
      {/if}
    </div>

    <div class={modalFooter}>
      <button type="button" class={btnSecondary} disabled={saving} onclick={() => (createOpen = false)}>
        Cancel
      </button>
      <button type="button" class={btnPrimary} disabled={!canCreate} onclick={submitCreate}>
        {saving ? "Creating…" : "Create cycle"}
      </button>
    </div>
  </DialogContent>
</Dialog>

<!-- Delete-cycle confirm dialog. -->
<Dialog open={pendingDelete != null} onOpenChange={(v) => { if (!v) pendingDelete = null; }}>
  <DialogContent class={cn(modalPanel, "max-w-md p-0 sm:max-w-md")} showCloseButton={false}>
    <div class={modalHeader}>
      <DialogTitle class="flex items-center gap-2 text-[15px] font-semibold text-content">
        <TriangleAlertIcon class="size-4 text-error" />
        Delete cycle
      </DialogTitle>
    </div>

    <div class={modalBody}>
      <DialogDescription class="text-[13px] leading-relaxed text-content-dim">
        Are you sure you want to delete
        <span class="font-medium text-content">{pendingDelete?.name}</span>? This action is permanent
        and cannot be undone. Work items in this cycle are not deleted.
      </DialogDescription>

      {#if deleteError}
        <p class="text-[12px] text-error" role="alert">{deleteError}</p>
      {/if}
    </div>

    <div class={modalFooter}>
      <button type="button" class={btnSecondary} disabled={deleting} onclick={() => (pendingDelete = null)}>
        Cancel
      </button>
      <button
        type="button"
        class={cn(
          "inline-flex h-8 items-center rounded-md bg-error px-4 text-[13px] font-medium",
          "text-accent-foreground transition-colors hover:bg-error/80 disabled:opacity-50",
        )}
        disabled={deleting}
        onclick={confirmDelete}
      >
        {deleting ? "Deleting…" : "Delete"}
      </button>
    </div>
  </DialogContent>
</Dialog>

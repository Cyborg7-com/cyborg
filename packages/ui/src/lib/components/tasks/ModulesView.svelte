<script lang="ts">
  // ModulesView — Plane's project Modules surface. A master/detail mirroring
  // CyclesView: the LEFT lists the project's modules (name + status + target
  // date); selecting one reveals its WORK-ITEMS BOARD on the right, REUSING
  // TasksBoard over the module's tasks (task.moduleIds includes the module id — a
  // task can belong to many modules). The board is data-driven from the project's
  // task_states (no hardcoded columns), so a module board behaves exactly like the
  // main board. Read-only catalog (create/edit modules is a later phase).
  import { workspaceState, client, projectsCache } from "$lib/state/app.svelte.js";
  import { cyboState } from "$lib/state/app.svelte.js";
  import TasksBoard from "$lib/components/tasks/TasksBoard.svelte";
  import TaskDetailDialog from "$lib/components/tasks/TaskDetailDialog.svelte";
  import TasksEmptyState from "$lib/components/tasks/TasksEmptyState.svelte";
  import BoxIcon from "@lucide/svelte/icons/box";
  import LayoutListIcon from "@lucide/svelte/icons/layout-list";
  import PlusIcon from "@lucide/svelte/icons/plus";
  import Trash2Icon from "@lucide/svelte/icons/trash-2";
  import TriangleAlertIcon from "@lucide/svelte/icons/triangle-alert";
  import { type AssigneePools } from "$lib/tasks/assignee.js";
  import { projectKeyPrefix } from "$lib/tasks/detail.js";
  import type { Module, TaskState, TaskLabel } from "$lib/core/types.js";
  import {
    subNavRow,
    subNavLabel,
    subNavCount,
    btnPrimary,
    btnSecondary,
    modalPanel,
    modalHeader,
    modalBody,
    modalFooter,
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

  let modules = $state<Module[]>([]);
  let states = $state<TaskState[]>([]);
  let labels = $state<TaskLabel[]>([]);
  let loading = $state(true);
  let selectedId = $state<string | null>(null);

  function loadModules(id: string): Promise<Module[]> {
    return client.fetchModules(id);
  }

  $effect(() => {
    const id = projectId;
    if (!id) return;
    let active = true;
    loading = true;
    selectedId = null;
    void Promise.all([
      loadModules(id),
      client.fetchProjectStates(id),
      client.fetchProjectLabels(id),
    ])
      .then(([m, s, l]) => {
        if (!active) return;
        modules = m;
        states = s;
        labels = l;
        selectedId = m[0]?.id ?? null;
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

  // ─── Create / delete wiring ─────────────────────────────────────
  // Create opens a small native form (name + optional description) →
  // client.createModule → re-fetch the catalog and select the new module. Delete
  // confirms in a modal → client.deleteModule → re-fetch and re-select.

  let createOpen = $state(false);
  let createName = $state("");
  let createDescription = $state("");
  let creating = $state(false);
  let createError = $state<string | null>(null);

  let moduleToDelete = $state<Module | null>(null);
  let deleting = $state(false);
  let deleteError = $state<string | null>(null);

  const canCreate = $derived(createName.trim().length > 0 && !creating);

  function openCreate(): void {
    createName = "";
    createDescription = "";
    createError = null;
    creating = false;
    createOpen = true;
  }

  async function refresh(selectId?: string | null): Promise<void> {
    const id = projectId;
    if (!id) return;
    const next = await loadModules(id);
    modules = next;
    if (selectId !== undefined) {
      selectedId = selectId ?? next[0]?.id ?? null;
    } else if (!next.some((m) => m.id === selectedId)) {
      selectedId = next[0]?.id ?? null;
    }
  }

  async function confirmCreate(): Promise<void> {
    if (!canCreate) return;
    creating = true;
    createError = null;
    try {
      const desc = createDescription.trim();
      const created = await client.createModule(projectId, {
        name: createName.trim(),
        description: desc.length > 0 ? desc : null,
      });
      await refresh(created.id);
      createOpen = false;
    } catch (err) {
      createError = err instanceof Error ? err.message : "Couldn't create the module.";
    } finally {
      creating = false;
    }
  }

  async function confirmDelete(): Promise<void> {
    const target = moduleToDelete;
    if (!target || deleting) return;
    deleting = true;
    deleteError = null;
    try {
      await client.deleteModule(target.id);
      const nextSelected = selectedId === target.id ? null : selectedId;
      await refresh(nextSelected);
      moduleToDelete = null;
    } catch (err) {
      deleteError = err instanceof Error ? err.message : "Couldn't delete the module.";
    } finally {
      deleting = false;
    }
  }

  $effect(() => {
    if (!moduleToDelete) {
      deleteError = null;
      deleting = false;
    }
  });

  const project = $derived(
    projectsCache.get(wsId)?.projects.find((p) => p.id === projectId) ?? null,
  );
  const projectIdentifier = $derived(projectKeyPrefix(project?.name));

  const assigneePools = $derived<AssigneePools>({
    members: workspaceState.members ?? [],
    cybos: cyboState.list ?? [],
    agents: workspaceState.agents ?? [],
  });

  const selected = $derived(modules.find((m) => m.id === selectedId) ?? null);
  const moduleTasks = $derived.by(() => {
    const id = selectedId;
    if (!id) return [];
    return workspaceState.tasks.filter((t) => (t.moduleIds ?? []).includes(id));
  });

  function fmt(ts: number | null): string {
    if (ts == null) return "—";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function countFor(m: Module): number {
    return workspaceState.tasks.filter((t) => (t.moduleIds ?? []).includes(m.id)).length;
  }
</script>

<div class="flex h-full w-full flex-col overflow-hidden">
  <header class="flex items-center gap-3 border-b border-edge px-6 py-4">
    <h1 class="text-base font-semibold text-content">Modules</h1>
    {#if !loading && modules.length > 0}
      <button type="button" class={cn(btnPrimary, "ml-auto gap-1.5")} onclick={openCreate}>
        <PlusIcon class="size-4" />
        New module
      </button>
    {/if}
  </header>

  {#if loading}
    <p class="px-6 py-4 text-[13px] text-content-muted">Loading modules…</p>
  {:else if modules.length === 0}
    <div class="min-h-0 flex-1">
      <TasksEmptyState
        icon={BoxIcon}
        heading="Map your project goals to Modules and track easily."
        description="Modules are made up of interconnected work items. They assist in monitoring progress through project phases, each with specific deadlines and analytics to indicate how close you are to achieving those phases."
        ctaLabel="Create module"
        onCta={openCreate}
      />
    </div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <!-- Module list (master) -->
      <aside class="flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-edge bg-surface-alt p-2">
        {#each modules as mod (mod.id)}
          <div
            class={cn(
              subNavRow,
              "w-full",
              selectedId === mod.id && "bg-dropdown-selected text-content",
            )}
          >
            <button
              type="button"
              onclick={() => (selectedId = mod.id)}
              class="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span class="flex min-w-0 flex-col items-start">
                <span class={subNavLabel}>{mod.name}</span>
                <span class="text-[11px] text-content-muted">{mod.status} · {fmt(mod.targetDate)}</span>
              </span>
            </button>
            <span class={subNavCount}>{countFor(mod)}</span>
            <button
              type="button"
              onclick={() => (moduleToDelete = mod)}
              class="grid size-5 shrink-0 place-items-center rounded text-content-muted opacity-0 transition-colors hover:bg-hover-gray hover:text-error group-hover:opacity-100"
              aria-label="Delete module {mod.name}"
            >
              <Trash2Icon class="size-3.5" />
            </button>
          </div>
        {/each}
      </aside>

      <!-- Selected module's work-items board (detail) -->
      <div class="min-w-0 flex-1">
        {#if selected}
          {#if moduleTasks.length === 0}
            <TasksEmptyState
              icon={LayoutListIcon}
              heading="No work items in {selected.name}"
              description="Add a work item to this module to track its progress here."
            />
          {:else}
            <TasksBoard
              workspaceId={wsId}
              tasks={moduleTasks}
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

<!-- Create module — name + optional description. Mirrors the Tasks dialog look. -->
<Dialog bind:open={createOpen}>
  <DialogContent class={cn(modalPanel, "max-w-md p-0 sm:max-w-md")} showCloseButton={false}>
    <div class={modalHeader}>
      <DialogTitle class="text-[15px] font-semibold text-content">New module</DialogTitle>
    </div>

    <div class={modalBody}>
      <div class="flex flex-col gap-1.5">
        <label for="module-name" class="text-[13px] font-medium text-content">Name</label>
        <input
          id="module-name"
          type="text"
          bind:value={createName}
          placeholder="Module name"
          class={fieldInputClass}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void confirmCreate();
            }
          }}
        />
      </div>

      <div class="flex flex-col gap-1.5">
        <label for="module-description" class="text-[13px] font-medium text-content">
          Description <span class="text-content-muted">(optional)</span>
        </label>
        <textarea
          id="module-description"
          bind:value={createDescription}
          rows="3"
          placeholder="What is this module about?"
          class={cn(fieldInputClass, "h-auto resize-none py-2")}
        ></textarea>
      </div>

      {#if createError}
        <p class="text-[12px] text-error" role="alert">{createError}</p>
      {/if}
    </div>

    <div class={modalFooter}>
      <button type="button" class={btnSecondary} disabled={creating} onclick={() => (createOpen = false)}>
        Cancel
      </button>
      <button type="button" class={btnPrimary} disabled={!canCreate} onclick={confirmCreate}>
        {creating ? "Creating…" : "Create module"}
      </button>
    </div>
  </DialogContent>
</Dialog>

<!-- Delete module confirmation — destructive, names the module. -->
<Dialog
  open={moduleToDelete !== null}
  onOpenChange={(o) => {
    if (!o) moduleToDelete = null;
  }}
>
  <DialogContent class={cn(modalPanel, "max-w-md p-0 sm:max-w-md")} showCloseButton={false}>
    <div class={modalHeader}>
      <DialogTitle class="flex items-center gap-2 text-[15px] font-semibold text-content">
        <TriangleAlertIcon class="size-4 text-error" />
        Delete module
      </DialogTitle>
    </div>

    <div class={modalBody}>
      <DialogDescription class="text-[13px] leading-relaxed text-content-dim">
        Are you sure you want to delete
        <span class="font-medium text-content">{moduleToDelete?.name}</span>? This action is
        permanent and cannot be undone. Work items remain, but lose this module.
      </DialogDescription>

      {#if deleteError}
        <p class="text-[12px] text-error" role="alert">{deleteError}</p>
      {/if}
    </div>

    <div class={modalFooter}>
      <button type="button" class={btnSecondary} disabled={deleting} onclick={() => (moduleToDelete = null)}>
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

<TaskDetailDialog workspaceId={wsId} />

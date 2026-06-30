// Shared, NON-VISUAL task-detail hook (WS0 foundation, frozen). Extracted VERBATIM
// (behavior-only) from TaskDetailCard.svelte so both the desktop peek/route card
// AND the mobile MobileTaskDetail (WS3) share one source of truth for: live task
// read, project-catalog hydration (states/labels/cycles/modules), the optimistic
// commit() + every per-field saver, label id→name mapping, parent options, dates
// ms↔ISO, mark-read on open, approve/reject, and the in-flight `pendingIds`.
//
// The render layer (title/description drafts, tabs, peek-mode, delete/schedule
// dialogs, breadcrumb/key derives) stays in the consuming component — the hook
// owns DATA + RPC only, identical to the original card's logic.
//
// CONTRACT: useTaskDetail(taskId: () => string) — the taskId is a getter so the
// hook tracks route/peek changes. The workspaceId is resolved from
// workspaceState.current (the only workspace whose tasks are in state; equals the
// card's old `workspaceId` prop in every real mount), with the task's own
// workspaceId as a fallback.

import { workspaceState, activityState } from "$lib/state/app.svelte.js";
import { client } from "$lib/state/client.js";
import { cyboState } from "$lib/plugins/agents/state.svelte.js";
import { toast } from "svelte-sonner";
import { resolveAssignee, type AssigneePools } from "$lib/tasks/assignee.js";
import { priorityForTask, type Priority } from "$lib/tasks/priority.js";
import type { DateRange } from "$lib/components/tasks/DateRangeDropdown.svelte";
import type { Task, TaskState, TaskLabel, Cycle, Module } from "$lib/core/types.js";

// The DateRangeDropdown speaks ISO strings; tasks carry epoch-ms. Convert at this
// boundary so the editor renders and the commit stays in the task model's ms shape
// (matching client.updateTask's startDate/dueAt: number | null). Pure module
// helpers (unchanged from the original card).
function msToIso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}
function isoToMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function useTaskDetail(taskId: () => string) {
  // The live task is read straight from workspaceState so it tracks board moves
  // and incoming broadcasts; commit() patches that same array on every save.
  const task = $derived(workspaceState.tasks.find((t) => t.id === taskId()) ?? null);
  // The workspace every write carries (no visibility bypass). current.id is the
  // active workspace (== the old card prop); task.workspaceId is a fallback.
  const workspaceId = $derived(workspaceState.current?.id ?? task?.workspaceId ?? "");

  const pools = $derived<AssigneePools>({
    members: workspaceState.members ?? [],
    cybos: cyboState.list ?? [],
    agents: workspaceState.agents ?? [],
  });
  const assignee = $derived(task ? resolveAssignee(task.assigneeId, pools) : null);
  const priority = $derived<Priority>(task ? priorityForTask(task) : "none");

  // ── Project catalog (states / labels / cycles / modules) ───────────────────
  // Props-controlled editors need the option lists; hydrate them from the task's
  // project on open (keyed off projectId). Empty when no project / pending-server.
  let states = $state<TaskState[]>([]);
  let labels = $state<TaskLabel[]>([]);
  let cycles = $state<Cycle[]>([]);
  let modules = $state<Module[]>([]);
  // The set of fields with an in-flight save (drives the "Saving…" hint + per-row
  // spinners). Reassigned (new Set) on every change so the $state stays reactive.
  let pendingIds = $state<Set<string>>(new Set());

  // Opening a task clears its Activity notification + persists markTaskRead so the
  // row clears on the user's other devices. Keyed on taskId so reopening re-fires;
  // markTaskRead is idempotent.
  $effect(() => {
    const tid = taskId();
    const wsId = workspaceId;
    if (!tid || !wsId) return;
    activityState.markReadByTask(tid);
    client.markTaskRead(wsId, tid);
  });

  $effect(() => {
    const projectId = task?.projectId ?? null;
    if (!projectId) {
      states = [];
      labels = [];
      cycles = [];
      modules = [];
      return;
    }
    let active = true;
    void Promise.all([
      client.fetchProjectStates(projectId),
      client.fetchProjectLabels(projectId),
      client.fetchCycles(projectId),
      client.fetchModules(projectId),
    ])
      .then(([s, l, c, m]) => {
        if (!active) return;
        states = s;
        labels = l;
        cycles = c;
        modules = m;
        return undefined;
      })
      // intentional: pending-server catalog hydration; rows degrade to read-only.
      .catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
    return () => {
      active = false;
    };
  });

  // updateTask persists labels by NAME (auto-created), not id; map the editor's
  // chosen ids back through the loaded catalog for the commit.
  function labelIdsToNames(ids: string[]): string[] {
    return ids
      .map((id) => labels.find((l) => l.id === id)?.name)
      .filter((n): n is string => Boolean(n));
  }

  const dateRange = $derived<DateRange>({
    startDate: msToIso(task?.startDate),
    dueAt: msToIso(task?.dueAt),
  });

  // Parent candidates: the other tasks in this workspace, excluding self.
  const parentOptions = $derived(
    workspaceState.tasks
      .filter((t) => t.id !== taskId())
      .map((t) => ({
        id: t.id,
        sequenceId: t.sequenceId != null ? `#${t.sequenceId}` : `#${t.id.slice(0, 8)}`,
        title: t.title,
      })),
  );

  // Apply a partial update: optimistic patch, RPC, reconcile with the server's row
  // (or revert on failure). One path for every field so behavior is uniform.
  async function commit(
    field: string,
    updates: Parameters<typeof client.updateTask>[2],
    optimistic: Partial<Task>,
  ): Promise<void> {
    const current = task;
    const wsId = workspaceId;
    if (!current || !wsId) return;
    const prev = current;
    pendingIds = new Set(pendingIds).add(field);
    workspaceState.tasks = workspaceState.tasks.map((t) =>
      t.id === current.id ? { ...t, ...optimistic } : t,
    );
    try {
      const updated = await client.updateTask(wsId, current.id, updates);
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === updated.id ? updated : t));
    } catch (err) {
      workspaceState.tasks = workspaceState.tasks.map((t) => (t.id === prev.id ? prev : t));
      toast.error(err instanceof Error ? err.message : "Couldn't save the change");
      // Rethrow so approve/reject can tell success from failure (no success toast
      // on a failed save). The field savers swallow it (already reverted+toasted).
      throw err;
    } finally {
      const next = new Set(pendingIds);
      next.delete(field);
      pendingIds = next;
    }
  }

  // The field-level savers. commit() rethrows on failure, but it has already
  // reverted + toasted, so these swallow it — the rethrow only matters to
  // approve/reject. saveTitle/saveDescription take the draft value as an argument
  // (the draft lives in the render layer); the rest take their editor's value.
  async function saveTitle(next: string): Promise<void> {
    const current = task;
    const v = next.trim();
    if (!current || !v || v === current.title) return;
    await commit("title", { title: v }, { title: v }).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function saveDescription(next: string): Promise<void> {
    const current = task;
    const v = next.trim();
    if (!current || v === (current.description ?? "")) return;
    await commit("description", { description: v }, { description: v || null }).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function saveState(value: string): Promise<void> {
    const current = task;
    if (!current || value === current.stateId) return;
    await commit("state", { stateId: value }, { stateId: value } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function saveAssignee(value: string | null): Promise<void> {
    const current = task;
    if (!current || value === current.assigneeId) return;
    await commit("assignee", { assigneeId: value }, { assigneeId: value }).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function saveDates(range: DateRange): Promise<void> {
    const current = task;
    if (!current) return;
    const nextStart = isoToMs(range.startDate);
    const nextDue = isoToMs(range.dueAt);
    if (nextStart === (current.startDate ?? null) && nextDue === (current.dueAt ?? null)) return;
    await commit(
      "dates",
      { startDate: nextStart, dueAt: nextDue },
      { startDate: nextStart, dueAt: nextDue } as Partial<Task>,
    ).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function savePriority(value: Priority): Promise<void> {
    const current = task;
    if (!current || value === priority) return;
    await commit(
      "priority",
      { priority: value === "none" ? null : value },
      { priority: value === "none" ? null : value } as Partial<Task>,
    ).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function saveLabels(ids: string[]): Promise<void> {
    const current = task;
    if (!current) return;
    await commit("labels", { labels: labelIdsToNames(ids) }, { labelIds: ids } as Partial<Task>).catch(
      () => {},
    );
  }

  async function createLabel(name: string): Promise<void> {
    const current = task;
    if (!current) return;
    const projectId = current.projectId ?? null;
    const currentNames = labelIdsToNames(current.labelIds ?? []);
    await commit("labels", { labels: [...currentNames, name] }, {}).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
    if (projectId) {
      try {
        labels = await client.fetchProjectLabels(projectId);
      } catch {
        // Best-effort: a failed refetch just means the new chip resolves on reopen.
      }
    }
  }

  async function saveCycle(value: string | null): Promise<void> {
    const current = task;
    if (!current || value === (current.cycleId ?? null)) return;
    await commit("cycle", { cycleId: value }, { cycleId: value } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function saveModules(ids: string[]): Promise<void> {
    const current = task;
    if (!current) return;
    await commit("modules", { moduleIds: ids }, { moduleIds: ids } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  async function saveParent(value: string | null): Promise<void> {
    const current = task;
    if (!current || value === (current.parentId ?? null)) return;
    await commit("parent", { parentId: value }, { parentId: value } as Partial<Task>).catch(() => {}); // intentional: commit() already reverted + toasted (rethrow only matters to approve/reject)
  }

  // Approve / reject for a task awaiting review — same semantics the card had.
  async function approve(): Promise<void> {
    try {
      await commit("status", { status: "done" }, { status: "done" });
      toast.success("Task approved");
    } catch {
      // commit already reverted + toasted; don't show a success toast.
    }
  }
  async function reject(): Promise<void> {
    try {
      await commit("status", { status: "pending" }, { status: "pending" });
      toast.success("Task sent back to inbox");
    } catch {
      // commit already reverted + toasted; don't show a success toast.
    }
  }

  return {
    // Reactive reads (getters keep the consumer reactive).
    get task() {
      return task;
    },
    get states() {
      return states;
    },
    get labels() {
      return labels;
    },
    get cycles() {
      return cycles;
    },
    get modules() {
      return modules;
    },
    get pools() {
      return pools;
    },
    get assignee() {
      return assignee;
    },
    get priority() {
      return priority;
    },
    get dateRange() {
      return dateRange;
    },
    get parentOptions() {
      return parentOptions;
    },
    get pendingIds() {
      return pendingIds;
    },
    // Actions.
    commit,
    saveTitle,
    saveState,
    savePriority,
    saveAssignee,
    saveDates,
    saveLabels,
    createLabel,
    saveParent,
    saveCycle,
    saveModules,
    saveDescription,
    approve,
    reject,
    labelIdsToNames,
  };
}

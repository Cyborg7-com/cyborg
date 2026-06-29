<script lang="ts">
  // ProjectOverview — Plane's project landing summary. Composes, in one scroll:
  //   - a project HEADER (color swatch + name + optional description);
  //   - a COUNTS-BY-STATE-GROUP strip (the five Plane phases — backlog / unstarted
  //     / started / completed / cancelled — each with its StateGroupIcon + count),
  //     derived from the project's real states when the catalog loads, else the
  //     legacy board columns;
  //   - the ACTIVE CYCLE card (the cycle whose [start,end] spans now), if any;
  //   - a RECENT ACTIVITY list (the most-recently-updated work items — real
  //     task.updatedAt, no invented feed), each linking to its detail route.
  //
  // It derives from the already-loaded workspaceState.tasks + the warm project
  // cache, and best-effort fetches the project's states + cycles for the richer
  // summary, so it never blocks on a fetch. Token-only — dark + light both resolve.
  import { workspaceState, client } from "$lib/state/app.svelte.js";
  import { columnForStatus, COLUMNS } from "$lib/tasks/board.js";
  import { taskKey } from "$lib/tasks/detail.js";
  import {
    STATE_GROUPS,
    stateGroupColorVar,
    tasksForProject,
    type StateGroupKey,
  } from "$lib/tasks/constants.js";
  import StateGroupIcon from "$lib/components/tasks/StateGroupIcon.svelte";
  import ConnectGithubPanel from "$lib/components/tasks/ConnectGithubPanel.svelte";
  import type { TaskState, Cycle, Task } from "$lib/core/types.js";

  let {
    wsId,
    projectId,
    projectIdentifier = null,
  }: { wsId: string; projectId: string; projectIdentifier?: string | null } = $props();

  // Exact projectId match for a chat-linked project; orphan tasks (projectId null)
  // for the synthetic Inbox — tasksForProject covers both.
  const projectTasks = $derived(tasksForProject(workspaceState.tasks, projectId));

  // Best-effort catalog hydration (states + cycles) for the richer summary.
  let states = $state<TaskState[]>([]);
  let cycles = $state<Cycle[]>([]);

  $effect(() => {
    const id = projectId;
    if (!id) return;
    let active = true;
    void Promise.all([client.fetchProjectStates(id), client.fetchCycles(id)])
      .then(([s, c]) => {
        if (!active) return;
        states = s;
        cycles = c;
        return undefined;
      })
      // best-effort catalog hydration; the summary degrades to the legacy column
      // mapping (COLUMN_PHASE) if states/cycles fail to load.
      // intentional: pending-server catalog fetch; summary falls back to COLUMN_PHASE.
      .catch(() => {});
    return () => {
      active = false;
    };
  });

  // Map a board column to its canonical Plane phase (legacy fallback).
  const COLUMN_PHASE: Record<string, StateGroupKey> = {
    todo: "unstarted",
    in_progress: "started",
    pending_review: "started",
    done: "completed",
  };

  // Resolve a task's phase: prefer the real state's `group`, else map its legacy
  // column. Counts the work items per phase for the distribution strip.
  function phaseOf(task: Task): StateGroupKey {
    if (task.stateId) {
      const s = states.find((x) => x.id === task.stateId);
      if (s) return s.group;
    }
    return COLUMN_PHASE[columnForStatus(task.status)] ?? "unstarted";
  }

  // One {phase,count} per Plane state group (always all five, empty included), in
  // canonical order. When no catalog has loaded yet the counts still work off the
  // legacy column mapping, so the strip is never blank.
  const byPhase = $derived(
    STATE_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      count: projectTasks.filter((t) => phaseOf(t) === g.key).length,
    })),
  );

  // Total work items + the segmented status-distribution bar segments: each
  // non-empty phase becomes a segment whose width is its share of the total and
  // whose fill is the real state-group color token (var(--state-<group>)).
  const total = $derived(projectTasks.length);
  const segments = $derived(
    byPhase
      .filter((p) => p.count > 0)
      .map((p) => ({
        ...p,
        pct: total === 0 ? 0 : (p.count / total) * 100,
        colorVar: stateGroupColorVar(p.key),
      })),
  );

  // The active cycle: the cycle whose [startDate, endDate] window spans now.
  const activeCycle = $derived.by(() => {
    const now = Date.now();
    return (
      cycles.find(
        (c) => c.startDate != null && c.endDate != null && c.startDate <= now && now <= c.endDate,
      ) ?? null
    );
  });

  // Recent activity: the most-recently-updated work items (real updatedAt).
  const recent = $derived(
    [...projectTasks].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6),
  );

  function fmt(ts: number | null): string {
    if (ts == null) return "—";
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function fmtRel(ts: number): string {
    return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
</script>

<div class="flex h-full w-full flex-col overflow-y-auto bg-surface">
  <!-- Project identity lives in the top nav (TasksTopNav switcher); the Overview
       is a left-anchored dashboard (no centered column → no dead left gutter). -->
  <div class="w-full max-w-[1000px] px-6 py-6 sm:px-8">
    <!-- ── Work items ─────────────────────────────────────────────────────── -->
    <div class="mb-4 flex items-center gap-3">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.08em] text-content-muted">
        Work items
      </h2>
      <span class="h-px flex-1 bg-edge"></span>
    </div>

    {#if total > 0}
      <!-- Segmented status distribution: width = share of total, fill = state color. -->
      <div
        class="mb-4 flex h-2.5 w-full overflow-hidden rounded-full bg-deeper"
        role="img"
        aria-label="Work item status distribution"
      >
        {#each segments as s (s.key)}
          <div
            class="h-full first:rounded-l-full last:rounded-r-full"
            style={`width:${s.pct}%;background-color:${s.colorVar}`}
            title={`${s.label}: ${s.count}`}
          ></div>
        {/each}
      </div>
    {/if}

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {#each byPhase as p (p.key)}
        <a
          href={`/workspace/${wsId}/tasks/${projectId}/work-items`}
          class="group flex flex-col gap-2 rounded-lg border border-edge bg-surface-alt p-3 transition-colors hover:border-edge-light hover:bg-hover-gray"
        >
          <div class="flex items-center gap-2 text-[12px] text-content-dim">
            <StateGroupIcon group={p.key} size={15} />
            <span class="truncate">{p.label}</span>
          </div>
          <span class="text-2xl font-semibold tabular-nums leading-none text-content">{p.count}</span>
        </a>
      {/each}
    </div>

    <p class="mt-3 text-[13px] text-content-muted">
      {projectTasks.length}
      {projectTasks.length === 1 ? "work item" : "work items"} in this project.
      <a
        href={`/workspace/${wsId}/tasks/${projectId}/work-items`}
        class="font-medium text-accent hover:underline">Open Work Items →</a
      >
    </p>

    <!-- ── Active cycle ───────────────────────────────────────────────────── -->
    <div class="mb-4 mt-10 flex items-center gap-3">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.08em] text-content-muted">
        Active cycle
      </h2>
      <span class="h-px flex-1 bg-edge"></span>
    </div>
    {#if activeCycle}
      <a
        href={`/workspace/${wsId}/tasks/${projectId}/cycles`}
        class="flex items-center justify-between gap-3 rounded-lg border border-edge bg-surface-alt p-3.5 transition-colors hover:border-edge-light hover:bg-hover-gray"
      >
        <span class="flex min-w-0 items-center gap-2.5">
          <span class="size-2 shrink-0 rounded-full bg-accent"></span>
          <span class="truncate font-medium text-content">{activeCycle.name}</span>
        </span>
        <span class="shrink-0 text-[12px] tabular-nums text-content-muted">
          {fmt(activeCycle.startDate)} – {fmt(activeCycle.endDate)}
        </span>
      </a>
    {:else}
      <p
        class="rounded-lg border border-dashed border-edge-light px-3.5 py-3 text-[13px] text-content-muted"
      >
        No active cycle right now.
      </p>
    {/if}

    <!-- ── Recent activity ────────────────────────────────────────────────── -->
    <div class="mb-4 mt-10 flex items-center gap-3">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.08em] text-content-muted">
        Recent activity
      </h2>
      <span class="h-px flex-1 bg-edge"></span>
    </div>
    {#if recent.length === 0}
      <p
        class="rounded-lg border border-dashed border-edge-light px-3.5 py-3 text-[13px] text-content-muted"
      >
        No recent work items.
      </p>
    {:else}
      <div class="overflow-hidden rounded-lg border border-edge bg-surface-alt">
        {#each recent as task (task.id)}
          <a
            href={`/workspace/${wsId}/tasks/item/${task.id}`}
            class="flex min-h-11 items-center gap-3 border-b border-edge px-3.5 py-2.5 text-[13px] text-content transition-colors last:border-b-0 hover:bg-hover-gray"
          >
            <StateGroupIcon group={phaseOf(task)} size={14} class="shrink-0" />
            <span class="shrink-0 text-[12px] tabular-nums text-content-muted">
              {taskKey(task.sequenceId, task.id, projectIdentifier)}
            </span>
            <span class="min-w-0 flex-1 truncate">{task.title}</span>
            <span class="shrink-0 text-[12px] tabular-nums text-content-muted"
              >{fmtRel(task.updatedAt)}</span
            >
          </a>
        {/each}
      </div>
    {/if}

    <!-- GitHub integration: bind repositories so their issues sync in as work
         items. The panel accepts the chat project id (resolved server-side to the
         tasks_projects.id). -->
    <div class="mb-4 mt-10 flex items-center gap-3">
      <h2 class="text-[11px] font-semibold uppercase tracking-[0.08em] text-content-muted">
        Integrations
      </h2>
      <span class="h-px flex-1 bg-edge"></span>
    </div>
    <ConnectGithubPanel tasksProjectId={projectId} />
  </div>
</div>

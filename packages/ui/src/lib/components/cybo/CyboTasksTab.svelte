<script lang="ts">
  // Tasks tab for the agent (cybo) profile. Wires the profile's Tasks tab to REAL
  // data: the per-workspace tasks held in workspaceState.tasks, filtered to the
  // tasks this cybo CREATED.
  //
  // The cybo↔task link (verified against the server):
  //   - cyborg7_create_task stamps the task's `createdBy` with the live agent
  //     SESSION id (`ctx.agentId`) — see cyborg7-mcp-tools.ts (local write) and
  //     workspace-relay.ts handleCyboWrite (cloud/shared write), where
  //     `createdBy: msg.agentId ?? msg.cyboId`.
  //   - So a cybo-created task's `createdBy` is EITHER one of the cybo's live
  //     session agentIds, OR the cyboId itself (the relay's fallback when no live
  //     agentId is present).
  //   - The cybo's live sessions are workspaceState.agents where a.cyboId === cyboId;
  //     their agentIds are the set of possible `createdBy` values.
  //
  // Read-only surface (task CRUD lives in the Tasks board). Rendering reuses the
  // Tasks-board list helpers (listRow, statusPillClass, formatDue, priority) so it
  // stays visually in sync, and the empty state mirrors the profile page's
  // `emptyState` snippet (accent-tinted medallion + confident title + muted copy).
  import { client } from "$lib/state/client.js";
  import { workspaceState } from "$lib/state/app.svelte.js";
  import { statusLabel, statusPillClass } from "$lib/tasks/detail.js";
  import { formatDue, dueChipClass } from "$lib/tasks/due.js";
  import { priorityForTask, priorityStyle } from "$lib/tasks/priority.js";
  import { listRow, listRowTitle, listRowProps, dueChip, priorityDot } from "$lib/tasks/ui.js";
  import { cn } from "$lib/utils.js";

  let { cyboId, wsId }: { cyboId: string; wsId: string } = $props();

  // Local mount-fetch state. workspaceState.tasks has no dedicated loading/error
  // flag (tasks are loaded once at workspace-open), so this tab manages its own
  // for the best-effort catch-up fetch below.
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  // The set of ids that mark a task as "created by THIS cybo": every live session
  // agentId for the cybo, PLUS the cyboId itself (the relay's createdBy fallback).
  const cyboCreatorIds = $derived(
    new Set<string>([
      cyboId,
      ...workspaceState.agents.filter((a) => a.cyboId === cyboId).map((a) => a.agentId),
    ]),
  );

  // This cybo's tasks: every workspace task whose creator is this cybo (or one of
  // its sessions). Used by the list AND the profile's Tasks stat — count = tasks.length.
  const tasks = $derived(workspaceState.tasks.filter((t) => cyboCreatorIds.has(t.createdBy)));

  // Ensure the workspace's tasks are loaded for this wsId. The board normally
  // loads them at workspace-open, so this only fires on a cold open of the profile
  // (empty list). Guards a stale response if the workspace switches mid-flight.
  $effect(() => {
    const ws = wsId;
    if (workspaceState.tasks.length > 0) return;
    // `active` is flipped false by the cleanup when wsId changes mid-flight, so a
    // stale response can't clobber the new workspace's tasks or its loading flag.
    // (No `loading` guard here — that would wedge a ws-switch made during a fetch.)
    let active = true;
    loading = true;
    loadError = null;
    client
      .fetchTasks(ws)
      .then((fetched) => {
        // Only apply if this effect is still current AND we're on the same ws.
        if (active && workspaceState.current?.id === ws) workspaceState.tasks = fetched;
        return;
      })
      .catch((err: unknown) => {
        // Surface the failure rather than leaving a silent empty state — the
        // board may still succeed on its own, but this tab should say it tried.
        if (active) loadError = err instanceof Error ? err.message : "Couldn't load tasks";
      })
      .finally(() => {
        if (active) loading = false;
      });
    return () => {
      active = false;
    };
  });
</script>

{#if loading && tasks.length === 0}
  <p class="px-1 py-4 text-xs text-content-muted">Loading tasks…</p>
{:else if loadError && tasks.length === 0}
  <p class="px-1 py-4 text-xs text-error" role="alert">{loadError}</p>
{:else if tasks.length === 0}
  <!-- Empty state mirrored from the profile page's `emptyState` snippet: a softly
       accent-tinted icon medallion, confident title, restrained muted copy. The
       inline `var(--agent-accent, …)` fallback matches the profile exactly. -->
  <div class="flex flex-col items-center justify-center gap-4 rounded-xl border border-edge-light bg-surface-alt px-6 py-16 text-center">
    <div
      class="flex h-14 w-14 items-center justify-center rounded-2xl"
      style="background: color-mix(in srgb, var(--agent-accent, #6366f1) 10%, transparent); color: var(--agent-accent, #6366f1);"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    </div>
    <div>
      <div class="text-[15px] font-semibold tracking-[-0.01em] text-content">No tasks yet</div>
      <p class="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-content-muted">
        Tasks this agent creates will be listed here with their status, due date, and priority.
      </p>
    </div>
  </div>
{:else}
  <!-- A clean list of the cybo's tasks, reusing the Tasks-board list row styling.
       Read-only: each row is a non-interactive summary (title · priority · status ·
       due). The list semantics (ul/li) keep it accessible. -->
  <ul class="overflow-hidden rounded-xl border border-edge">
    {#each tasks as task (task.id)}
      {@const priority = priorityForTask(task)}
      {@const pStyle = priorityStyle(priority)}
      <li class={cn(listRow, "last:border-b-0")}>
        {#if pStyle}
          <span class={cn(priorityDot, pStyle.dot)} title={pStyle.label} aria-label={`Priority: ${pStyle.label}`}></span>
        {/if}
        <span class={listRowTitle}>{task.title}</span>
        <span class={listRowProps}>
          <span class={cn(dueChip, "bg-surface-alt", statusPillClass(task.status))}>{statusLabel(task.status)}</span>
          {#if task.dueAt}
            <span class={cn(dueChip, dueChipClass(task.dueAt))}>{formatDue(task.dueAt)}</span>
          {/if}
        </span>
      </li>
    {/each}
  </ul>
{/if}

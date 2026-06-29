<script lang="ts">
  // Cron / scheduled-jobs tab for the agent (cybo) profile. Wires the profile's
  // Cron tab to REAL data: the per-workspace recurring schedules from
  // schedulesState, filtered to this cybo. A schedule "belongs to a CYBO" and runs
  // it with a prompt on a cron cadence; the clock lives on the daemon. This is a
  // read-only surface — CRUD lives in the Tasks-tab SchedulesBoard. Rendering and
  // formatting mirror that board (describeCron + fmtTime) so the two stay in sync.
  import { schedulesState } from "$lib/state/app.svelte.js";
  import Badge from "$lib/components/ui/badge/badge.svelte";
  import { describeCron } from "$lib/schedule/recurrence.js";

  let { cyboId, wsId }: { cyboId: string; wsId: string } = $props();

  // Schedules for this cybo only. `cyboId` is the link field on ScheduleView.
  const schedules = $derived(schedulesState.list.filter((s) => s.cyboId === cyboId));
  const loading = $derived(schedulesState.loading);
  const loadError = $derived(schedulesState.error);

  // Ensure the workspace's schedules are loaded. schedulesState.load() is safe to
  // call repeatedly and guards stale responses; we only kick it when the list is
  // empty (covers first mount and a workspace switch). The board may already have
  // loaded them, in which case this is a cheap no-op refresh.
  $effect(() => {
    const ws = wsId;
    if (schedulesState.list.length === 0 && !schedulesState.loading) {
      void schedulesState.load(ws);
    }
  });

  function fmtTime(ts: number | null): string {
    if (!ts) return "—";
    return new Date(ts).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
</script>

{#if loading && schedules.length === 0}
  <p class="px-1 py-4 text-xs text-content-muted">Loading scheduled jobs…</p>
{:else if loadError}
  <p class="px-1 py-4 text-xs text-error" role="alert">{loadError}</p>
{:else if schedules.length === 0}
  <!-- Empty state mirrored from the profile page's `emptyState` snippet: a softly
       accent-tinted icon medallion, confident title, restrained muted copy. The
       inline `var(--agent-accent, …)` fallback matches the profile exactly. -->
  <div class="flex flex-col items-center justify-center gap-4 rounded-xl border border-edge-light bg-surface-alt px-6 py-16 text-center">
    <div
      class="flex h-14 w-14 items-center justify-center rounded-2xl"
      style="background: color-mix(in srgb, var(--agent-accent, #6366f1) 10%, transparent); color: var(--agent-accent, #6366f1);"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
      </svg>
    </div>
    <div>
      <div class="text-[15px] font-semibold tracking-[-0.01em] text-content">No scheduled jobs</div>
      <p class="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-content-muted">
        Recurring jobs you schedule for this agent will be listed here with their cadence and next run.
      </p>
    </div>
  </div>
{:else}
  <div class="space-y-2">
    {#each schedules as s (s.id)}
      <div class="rounded-lg border border-edge bg-raised px-4 py-3">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium text-content">{describeCron(s.cron)}</span>
              {#if !s.enabled}
                <Badge variant="outline" class="shrink-0 text-[10px] text-content-muted">paused</Badge>
              {/if}
              {#if s.stale}
                <Badge variant="outline" class="shrink-0 text-[10px] text-warning">stale daemon</Badge>
              {/if}
              {#if s.maxRuns === 1}
                <Badge variant="outline" class="shrink-0 text-[10px]">one-shot</Badge>
              {/if}
            </div>
            <p class="mt-0.5 line-clamp-2 text-xs text-content-muted">{s.prompt}</p>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted">
              <span class="font-mono">{s.cron}</span>
              <span>Next: {s.enabled ? fmtTime(s.nextRunAt) : "paused"}</span>
              {#if s.lastRunAt}
                <span>Last: {fmtTime(s.lastRunAt)}</span>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<script lang="ts">
  // #619 — the recurring-schedule board surfaced inside the Tasks tab. Lists the
  // workspace's schedules with enable/disable, run-now, delete, and an expandable
  // run-history drawer. Reads/writes through schedulesState (which wraps the 7
  // schedule RPCs). Loads on mount; stays live via the schedule_mutated broadcast
  // wired in app.svelte.ts.
  import { onMount } from "svelte";
  import { toast } from "svelte-sonner";
  import { schedulesState } from "$lib/state/app.svelte.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import Badge from "$lib/components/ui/badge/badge.svelte";
  import { describeCron } from "$lib/schedule/recurrence.js";
  import { cn } from "$lib/utils.js";

  let { workspaceId }: { workspaceId: string } = $props();

  const schedules = $derived(schedulesState.list);
  const loading = $derived(schedulesState.loading);
  const loadError = $derived(schedulesState.error);

  // Which schedule's run-history drawer is open (null = none).
  let openRunsFor = $state<string | null>(null);

  onMount(() => {
    void schedulesState.load(workspaceId);
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

  async function toggleEnabled(id: string, next: boolean): Promise<void> {
    const res = await schedulesState.setEnabled(workspaceId, id, next);
    if (!res.ok) toast.error(res.error ?? "Couldn't update the schedule");
  }

  async function runNow(id: string): Promise<void> {
    const res = await schedulesState.runOnce(workspaceId, id);
    if (res.ok) {
      toast.success("Run started");
      if (openRunsFor === id) void schedulesState.loadRuns(workspaceId, id);
    } else {
      toast.error(res.error ?? "Couldn't run the schedule");
    }
  }

  async function remove(id: string): Promise<void> {
    const res = await schedulesState.delete(workspaceId, id);
    if (!res.ok) toast.error(res.error ?? "Couldn't delete the schedule");
  }

  async function toggleRuns(id: string): Promise<void> {
    if (openRunsFor === id) {
      openRunsFor = null;
      return;
    }
    openRunsFor = id;
    const err = await schedulesState.loadRuns(workspaceId, id);
    if (err) toast.error(err);
  }

  function runStatusColor(status: string): string {
    switch (status) {
      case "succeeded":
        return "text-online";
      case "failed":
        return "text-error";
      case "skipped":
        return "text-content-muted";
      default:
        return "text-accent";
    }
  }
</script>

<div class="space-y-2">
  {#if loading && schedules.length === 0}
    <p class="px-1 py-4 text-xs text-content-muted">Loading schedules…</p>
  {:else if loadError}
    <p class="px-1 py-4 text-xs text-error" role="alert">{loadError}</p>
  {:else if schedules.length === 0}
    <p class="px-1 py-4 text-xs text-content-muted">No recurring tasks yet.</p>
  {:else}
    {#each schedules as s (s.id)}
      {@const runs = schedulesState.runsBySchedule[s.id] ?? []}
      <div class="rounded-lg border border-edge bg-raised">
        <div class="flex items-start gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate text-sm font-medium text-content">{s.cyboName ?? s.cyboId}</span>
              {#if s.stale}
                <Badge variant="outline" class="shrink-0 text-[10px] text-warning">stale daemon</Badge>
              {/if}
              {#if s.maxRuns === 1}
                <Badge variant="outline" class="shrink-0 text-[10px]">one-shot</Badge>
              {/if}
            </div>
            <p class="mt-0.5 line-clamp-2 text-xs text-content-muted">{s.prompt}</p>
            <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-content-muted">
              <span class="font-mono">{describeCron(s.cron)}</span>
              <span>Next: {s.enabled ? fmtTime(s.nextRunAt) : "paused"}</span>
              {#if s.lastRunAt}
                <span>Last: {fmtTime(s.lastRunAt)}</span>
              {/if}
            </div>
          </div>

          <Switch
            checked={s.enabled}
            onCheckedChange={(v) => toggleEnabled(s.id, v)}
            aria-label="Enable schedule"
          />
        </div>

        <div class="flex items-center gap-1 border-t border-edge px-3 py-1.5 text-xs">
          <button
            type="button"
            onclick={() => runNow(s.id)}
            class="rounded-md px-2 py-1 font-medium text-content-muted hover:bg-surface-alt hover:text-content"
          >Run now</button>
          <button
            type="button"
            onclick={() => toggleRuns(s.id)}
            class="rounded-md px-2 py-1 font-medium text-content-muted hover:bg-surface-alt hover:text-content"
            aria-expanded={openRunsFor === s.id}
          >{openRunsFor === s.id ? "Hide history" : "History"}</button>
          <button
            type="button"
            onclick={() => remove(s.id)}
            class="ml-auto rounded-md px-2 py-1 font-medium text-error hover:bg-error/10"
          >Delete</button>
        </div>

        {#if openRunsFor === s.id}
          <div class="border-t border-edge px-4 py-2">
            {#if runs.length === 0}
              <p class="py-2 text-[11px] text-content-muted">No runs yet.</p>
            {:else}
              <ul class="space-y-1">
                {#each runs as r (r.id)}
                  <li class="flex items-center gap-2 text-[11px]">
                    <span class={cn("font-medium capitalize", runStatusColor(r.status))}>{r.status}</span>
                    <span class="text-content-muted">{fmtTime(r.startedAt)}</span>
                    {#if r.skipReason}
                      <span class="text-content-muted">· {r.skipReason.replace("_", " ")}</span>
                    {/if}
                    {#if r.error}
                      <span class="truncate text-error">· {r.error}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

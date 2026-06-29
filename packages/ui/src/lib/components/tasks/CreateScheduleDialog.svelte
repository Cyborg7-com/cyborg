<script lang="ts">
  // Per-task SCHEDULE editor. A task can recur: it fires on a cron cadence, run by
  // the task's ASSIGNEE cybo, unattended (the task IS the prompt — no free-text).
  // This dialog is opened from a task's schedule chip / Properties row, pre-bound
  // to that task (cybo = its assignee cybo, channel = its channelId, taskId = its
  // id). It leads with friendly PRESETS (the rateToCron cadence builder), keeps a
  // raw 5-field cron behind an Advanced toggle, and offers a one-time "run once"
  // (maxRuns=1). Enable/disable + delete live here too. Only cybos execute, so a
  // task assigned to a HUMAN (or unassigned) shows a hint and disables scheduling.
  //
  // Reuses schedulesState + the existing create/update/setEnabled/delete RPCs
  // (which now thread taskId). The existing schedule for the task (if any) is found
  // by filtering schedulesState.list by taskId, so opening the dialog reflects the
  // live state and edits update it in place.
  import { schedulesState } from "$lib/state/app.svelte.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Select from "$lib/components/ui/select/index.js";
  import { fieldInputClass } from "$lib/components/Field.svelte";
  import { rateToCron, cronToLabel, type RateUnit } from "$lib/schedule/recurrence.js";
  import { cn } from "$lib/utils.js";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog/index.js";

  let {
    open = $bindable(false),
    workspaceId,
    taskId,
    // The cybo that runs the task. Null/absent → the task is unassigned or assigned
    // to a human, so scheduling is disabled with a hint (only cybos execute).
    cyboId = null,
    // The task's channel (where its run output posts). Forwarded so the scheduled
    // run lands in the same channel as the task's other activity.
    channelId = null,
    // Why scheduling is disabled, when it is — surfaced as the hint copy. Null when
    // a cybo is bound and scheduling is available.
    disabledReason = null,
  }: {
    open?: boolean;
    workspaceId: string;
    taskId: string;
    cyboId?: string | null;
    channelId?: string | null;
    disabledReason?: string | null;
  } = $props();

  // The schedule already bound to this task (if any), read live off the workspace
  // list so the dialog opens reflecting the current cadence + enabled state, and so
  // an edit/delete elsewhere keeps this in sync. A task carries at most one.
  const existing = $derived(schedulesState.list.find((s) => s.taskId === taskId) ?? null);

  // Scheduling is only possible when a cybo runs the task (humans don't execute).
  const canSchedule = $derived(Boolean(cyboId) && !disabledReason);

  // ── Recurrence form ─────────────────────────────────────────────────────────
  // Lead with PRESETS (the common cadences), Advanced exposes the raw cron field.
  type Preset = { id: string; label: string; cron: string };
  const PRESETS: Preset[] = [
    { id: "weekday-9", label: "Every weekday 9am", cron: "0 9 * * 1-5" },
    { id: "daily-9", label: "Every day", cron: rateToCron(1, "day") },
    { id: "hourly", label: "Every hour", cron: rateToCron(1, "hour") },
    { id: "weekly", label: "Every week", cron: rateToCron(1, "week") },
  ];

  // Recurrence input mode: a preset grid, a guided rate(N unit) builder, or raw cron.
  let mode = $state<"preset" | "rate" | "cron">("preset");
  let presetId = $state<string>(PRESETS[0].id);
  let rateN = $state(1);
  let rateUnit = $state<RateUnit>("day");
  let cronExpr = $state("0 9 * * *");
  // One-time: fire exactly once (maxRuns=1) then deactivate, instead of recurring.
  let runOnce = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);

  // The effective cron sent to the server (preset / rate(...) → cron, or raw).
  const effectiveCron = $derived.by(() => {
    if (mode === "cron") return cronExpr.trim();
    if (mode === "rate") return rateToCron(rateN, rateUnit);
    return PRESETS.find((p) => p.id === presetId)?.cron ?? PRESETS[0].cron;
  });

  // In "rate" mode the cadence is built from rateN — a cleared or non-numeric input
  // (bind:value on a number field yields NaN/undefined) would emit an invalid cron,
  // so require a finite integer >= 1 before the form can submit.
  const canSubmit = $derived(
    canSchedule &&
      !!effectiveCron &&
      !submitting &&
      (mode !== "rate" || (typeof rateN === "number" && Number.isFinite(rateN) && rateN >= 1)),
  );

  // Reset the form each time the dialog opens. If the task already has a schedule,
  // seed the raw-cron field with its expression (Advanced) so an edit starts from
  // the live cadence; otherwise default to the first preset.
  $effect(() => {
    if (!open) return;
    error = null;
    submitting = false;
    runOnce = existing ? (existing.maxRuns ?? null) === 1 : false;
    if (existing) {
      mode = "cron";
      cronExpr = existing.cron;
    } else {
      mode = "preset";
      presetId = PRESETS[0].id;
      rateN = 1;
      rateUnit = "day";
      cronExpr = "0 9 * * *";
    }
  });

  // Create (or update) the task's schedule with the chosen cadence.
  async function save(): Promise<void> {
    if (!canSubmit || !cyboId) return;
    submitting = true;
    error = null;
    const res = existing
      ? await schedulesState.update({
          workspaceId,
          scheduleId: existing.id,
          cron: effectiveCron,
          taskId,
        })
      : await schedulesState.create({
          workspaceId,
          cyboIdOrSlug: cyboId,
          cron: effectiveCron,
          // The task IS the prompt; the daemon dispatches the task by id, so the
          // prompt field is informational only for a per-task schedule.
          prompt: "",
          channelId,
          taskId,
          maxRuns: runOnce ? 1 : null,
        });
    submitting = false;
    if (res.ok) {
      open = false;
    } else {
      error = res.error ?? "Couldn't save the schedule.";
    }
  }

  async function toggleEnabled(): Promise<void> {
    if (!existing || submitting) return;
    submitting = true;
    error = null;
    const res = await schedulesState.setEnabled(workspaceId, existing.id, !existing.enabled);
    submitting = false;
    if (!res.ok) error = res.error ?? "Couldn't update the schedule.";
  }

  async function remove(): Promise<void> {
    if (!existing || submitting) return;
    submitting = true;
    error = null;
    const res = await schedulesState.delete(workspaceId, existing.id);
    submitting = false;
    if (res.ok) {
      open = false;
    } else {
      error = res.error ?? "Couldn't delete the schedule.";
    }
  }
</script>

<Dialog bind:open>
  <DialogContent class="sm:max-w-[460px]">
    <DialogHeader>
      <DialogTitle>{existing ? "Edit schedule" : "Schedule this task"}</DialogTitle>
      <DialogDescription>
        The task runs automatically on the cadence you pick, performed by its assigned agent.
      </DialogDescription>
    </DialogHeader>

    {#if !canSchedule}
      <!-- Only cybos execute: a human-assigned or unassigned task can't be scheduled. -->
      <p class="rounded-md bg-surface-alt px-3 py-2.5 text-[13px] text-content-muted" role="note">
        {disabledReason ?? "Assign this task to an agent to schedule it — only agents run on a cadence."}
      </p>
    {:else}
      <div class="flex flex-col gap-4">
        <!-- Recurrence -->
        <div class="flex flex-col gap-1.5">
          <span class="text-[13px] font-medium text-content">Cadence</span>
          <div class="flex gap-1 text-[12px]">
            <button
              type="button"
              onclick={() => (mode = "preset")}
              class={cn(
                "rounded-md px-2.5 py-1 font-medium transition-colors",
                mode === "preset" ? "bg-accent text-accent-foreground" : "bg-surface-alt text-content-muted hover:text-content",
              )}
            >Presets</button>
            <button
              type="button"
              onclick={() => (mode = "rate")}
              class={cn(
                "rounded-md px-2.5 py-1 font-medium transition-colors",
                mode === "rate" ? "bg-accent text-accent-foreground" : "bg-surface-alt text-content-muted hover:text-content",
              )}
            >Every…</button>
            <button
              type="button"
              onclick={() => (mode = "cron")}
              class={cn(
                "rounded-md px-2.5 py-1 font-medium transition-colors",
                mode === "cron" ? "bg-accent text-accent-foreground" : "bg-surface-alt text-content-muted hover:text-content",
              )}
            >Advanced</button>
          </div>

          {#if mode === "preset"}
            <div class="grid grid-cols-2 gap-1.5">
              {#each PRESETS as p (p.id)}
                <button
                  type="button"
                  onclick={() => (presetId = p.id)}
                  aria-pressed={presetId === p.id}
                  class={cn(
                    "rounded-md border px-2.5 py-2 text-left text-[13px] transition-colors",
                    presetId === p.id
                      ? "border-accent bg-dropdown-selected text-content"
                      : "border-edge bg-surface-alt text-content-dim hover:bg-hover-gray hover:text-content",
                  )}
                >{p.label}</button>
              {/each}
            </div>
          {:else if mode === "rate"}
            <div class="flex items-center gap-2">
              <input
                type="number"
                min="1"
                bind:value={rateN}
                class={cn(fieldInputClass, "w-20")}
                aria-label="Repeat every N units"
              />
              <Select.Root
                type="single"
                value={rateUnit}
                onValueChange={(v) => { if (v === "hour" || v === "day" || v === "week") rateUnit = v; }}
              >
                <Select.Trigger class="h-9 w-32 text-[13px]">
                  {rateUnit}{rateN === 1 ? "" : "s"}
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="hour" label="hours">hours</Select.Item>
                  <Select.Item value="day" label="days">days</Select.Item>
                  <Select.Item value="week" label="weeks">weeks</Select.Item>
                </Select.Content>
              </Select.Root>
            </div>
          {:else}
            <input
              type="text"
              bind:value={cronExpr}
              placeholder="0 9 * * *"
              class={cn(fieldInputClass, "font-mono")}
              aria-label="Cron expression"
            />
          {/if}

          {#if effectiveCron}
            <p class="text-[11px] text-content-muted">
              {cronToLabel(effectiveCron, existing?.timezone ?? null)}
              · <span class="font-mono">{effectiveCron}</span>
            </p>
          {/if}
        </div>

        <!-- Run once (one-time) — fires a single time then deactivates. -->
        <label class="flex cursor-pointer items-center gap-2 text-[13px] text-content">
          <input
            type="checkbox"
            bind:checked={runOnce}
            disabled={Boolean(existing)}
            class="size-3.5 accent-[var(--c7-accent)]"
          />
          <span>Run once, then stop</span>
        </label>

        {#if error}
          <p class="text-xs text-error" role="alert">{error}</p>
        {/if}
      </div>
    {/if}

    <DialogFooter class="gap-2 sm:justify-between">
      <!-- Destructive + pause live on the left when a schedule exists. -->
      <div class="flex items-center gap-2">
        {#if existing}
          <Button variant="ghost" onclick={toggleEnabled} disabled={submitting}>
            {existing.enabled ? "Pause" : "Resume"}
          </Button>
          <Button variant="ghost" onclick={remove} disabled={submitting} class="text-error hover:text-error">
            Delete
          </Button>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <Button variant="ghost" onclick={() => { open = false; }}>Cancel</Button>
        {#if canSchedule}
          <Button onclick={save} disabled={!canSubmit}>
            {submitting ? "Saving…" : existing ? "Save" : "Schedule"}
          </Button>
        {/if}
      </div>
    </DialogFooter>
  </DialogContent>
</Dialog>

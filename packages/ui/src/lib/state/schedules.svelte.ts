// ─── Recurring cybo schedules (#611/#613/#619) ───────────────────────────────
// Client state for the per-workspace list of recurring schedules (the Tasks-tab
// "Scheduled" board). A schedule belongs to a CYBO and runs it with a prompt on a
// cron cadence; the clock lives on the daemon (ScheduleRunner). This state only
// does CRUD + reads run history, and stays live via the `cyborg:schedule_mutated`
// broadcast (wired in app.svelte.ts, the single place client.on(...) handlers live).
//
// Rows are sorted soonest-next-run first (disabled/no-next sink to the bottom).

import { client } from "./client.js";
import type { ScheduleView, ScheduleRunView, ScheduleMutatedPayload } from "../ws-client.js";

function byNextRun(a: ScheduleView, b: ScheduleView): number {
  // Soonest next run first; schedules with no next run (disabled / exhausted)
  // sink below the active ones, then tie-break by creation order for stability.
  const an = a.nextRunAt ?? Number.POSITIVE_INFINITY;
  const bn = b.nextRunAt ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  return a.createdAt - b.createdAt;
}

export class SchedulesState {
  // The loaded schedules for `workspaceId`, soonest-next-run first. Reassigned on
  // every mutation so the runes observe the change.
  list: ScheduleView[] = $state([]);
  loading = $state(false);
  // Human-readable load error (null = none) — "the LIST couldn't load".
  error: string | null = $state(null);
  // Run history keyed by scheduleId (lazy-loaded when a row's drawer opens).
  runsBySchedule: Record<string, ScheduleRunView[]> = $state({});

  // Which workspace the current `list` belongs to — guards a late response from
  // landing in a workspace the user has since switched away from.
  private loadedWorkspaceId: string | null = null;

  get enabledCount(): number {
    return this.list.reduce((n, s) => n + (s.enabled ? 1 : 0), 0);
  }

  // Load (or reload) the workspace's schedules. Safe to call repeatedly.
  async load(workspaceId: string): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const { schedules } = await client.listSchedules(workspaceId);
      this.loadedWorkspaceId = workspaceId;
      this.list = [...schedules].sort(byNextRun);
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Couldn't load schedules";
      this.list = [];
    } finally {
      this.loading = false;
    }
  }

  // Insert/replace a row (from a create/update/set_enabled ack or a broadcast)
  // without a full reload. Scoped to the loaded workspace.
  upsert(schedule: ScheduleView): void {
    if (this.loadedWorkspaceId !== null && schedule.workspaceId !== this.loadedWorkspaceId) return;
    const next = this.list.filter((s) => s.id !== schedule.id);
    next.push(schedule);
    this.list = next.sort(byNextRun);
  }

  // Drop a row by id (from a delete ack or a broadcast).
  remove(scheduleId: string): void {
    this.list = this.list.filter((s) => s.id !== scheduleId);
    const { [scheduleId]: _dropped, ...rest } = this.runsBySchedule;
    this.runsBySchedule = rest;
  }

  // Apply a `cyborg:schedule_mutated` broadcast/ack to keep the board live. A
  // create/update/set_enabled carries the row; delete drops it; run_once leaves
  // the list shape unchanged (run history is reloaded on demand).
  applyMutation(payload: ScheduleMutatedPayload): void {
    if (!payload.ok) return;
    if (payload.op === "delete") {
      if (payload.scheduleId) this.remove(payload.scheduleId);
      return;
    }
    if (payload.schedule) this.upsert(payload.schedule);
  }

  // ── Mutations ──────────────────────────────────────────────────────────
  // Each resolves with the server's mutation ack; on success it patches `list`
  // locally so the UI updates without waiting for the broadcast round-trip.

  async create(params: {
    workspaceId: string;
    cyboIdOrSlug: string;
    cron: string;
    prompt: string;
    channelId?: string | null;
    taskId?: string | null;
    timezone?: string | null;
    maxRuns?: number | null;
  }): Promise<ScheduleMutatedPayload> {
    const res = await client.createSchedule(params);
    if (res.ok) this.applyMutation(res);
    return res;
  }

  async update(params: {
    workspaceId: string;
    scheduleId: string;
    cron?: string;
    prompt?: string;
    channelId?: string | null;
    taskId?: string | null;
    timezone?: string | null;
  }): Promise<ScheduleMutatedPayload> {
    const res = await client.updateSchedule(params);
    if (res.ok) this.applyMutation(res);
    return res;
  }

  async setEnabled(
    workspaceId: string,
    scheduleId: string,
    enabled: boolean,
  ): Promise<ScheduleMutatedPayload> {
    const res = await client.setScheduleEnabled(workspaceId, scheduleId, enabled);
    if (res.ok) this.applyMutation(res);
    return res;
  }

  async delete(workspaceId: string, scheduleId: string): Promise<ScheduleMutatedPayload> {
    const res = await client.deleteSchedule(workspaceId, scheduleId);
    if (res.ok) this.applyMutation(res);
    return res;
  }

  async runOnce(workspaceId: string, scheduleId: string): Promise<ScheduleMutatedPayload> {
    return client.runScheduleOnce(workspaceId, scheduleId);
  }

  // Load (or reload) a schedule's run history into runsBySchedule. Returns the
  // error string on failure so the caller can surface it inline.
  async loadRuns(workspaceId: string, scheduleId: string): Promise<string | null> {
    try {
      const { runs } = await client.listScheduleRuns(workspaceId, scheduleId, 20);
      this.runsBySchedule = { ...this.runsBySchedule, [scheduleId]: runs };
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Couldn't load run history";
    }
  }

  // Drop all state on logout / workspace teardown.
  clear(): void {
    this.list = [];
    this.loading = false;
    this.error = null;
    this.runsBySchedule = {};
    this.loadedWorkspaceId = null;
  }
}

export const schedulesState = new SchedulesState();

import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import { computeNextRunAt } from "../schedule/cron.js";
import { type ComposioDeps, createComposioDeps } from "./composio-deps.js";
import { spawnCybo } from "./cybo-manager.js";
import { CyboCredentialStore } from "./cybo-credentials.js";
import type { DualStorage } from "./dual-storage.js";
import type { ScheduleSkipReason, StoredSchedule, StoredTask } from "./storage.js";
import { dispatchTaskToAgent, type TaskEventEmitter } from "./task-dispatch.js";

// Tick once a minute — cron granularity is minutes, so a finer tick buys nothing.
const TICK_INTERVAL_MS = 60_000;

export interface ScheduleRunnerOptions {
  storage: DualStorage;
  agentManager: AgentManager;
  logger: Logger;
  serverId?: string;
  cyborg7McpBaseUrl?: string;
}

// Per-daemon cron runner for cybo schedules. Each tick reads due schedules from
// the local SQLite (which only holds this daemon's workspaces), spawns the cybo
// with the schedule's prompt into its channel, and advances next_run_at. Reuses
// the upstream cron math (schedule/cron.ts) for the cadence — agent/ untouched.
//
// This is the Paseo-derived scheduling primitive, not a reinvention: it fires on
// Paseo's cron engine via `computeNextRunAt` from ../schedule/cron.js — the SAME
// math Paseo's ScheduleService (schedule/service.ts) uses to advance a cadence.
// What we add on top of Paseo's file-based, per-daemon ScheduleService is the
// DualStorage (SQLite + Postgres) schedule/task store and the cross-daemon
// exactly-once `claimTaskDispatch` (an atomic PG claim) so a schedule is not
// double-fired across replicas — guarantees Paseo's single-daemon file store
// does not provide.
export class ScheduleRunner {
  private readonly storage: DualStorage;
  private readonly agentManager: AgentManager;
  private readonly logger: Logger;
  private readonly serverId?: string;
  // Set after the server binds (see bootstrap), mirroring the dispatcher — so a
  // scheduled cybo gets the cyborg7 MCP tools injected just like an interactive one.
  private cyborg7McpBaseUrl?: string;
  private onTaskEvent?: TaskEventEmitter;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  // An extra unit of work pumped on the SAME timer as the cybo cron tick, so the
  // daemon keeps a SINGLE scheduler timer (#607: the user "send later" runner
  // reuses this tick rather than starting a second setInterval).
  private additionalTick: (() => Promise<void>) | null = null;
  // Schedule ids whose run (spawn + cybo turn) is currently in flight. A due
  // schedule still in this set is skipped, so a per-minute cron whose run outlasts
  // the cadence can't pile up overlapping spawns and saturate the daemon (#209).
  private readonly inFlight = new Set<string>();
  // Tasks Phase 3 (internal docs): due agent-assigned tasks are
  // fired from THIS same tick after the cron pass — no second timer. A SEPARATE
  // overlap guard (mirroring the cron `inFlight` above) keeps a slow dispatch from
  // double-firing across ticks; the atomic claimTaskDispatch is the cross-process
  // guard, this Set is the in-process one.
  private readonly tasksInFlight = new Set<string>();
  // Phase 3 (internal docs): per-daemon credential store, lazily built. Consulted
  // by spawnCybo ONLY for openai-compatible api cybos; other scheduled spawns
  // ignore it (free for daemons that never run a raw-API cybo).
  private credentialStoreInstance: CyboCredentialStore | null = null;

  private get credentialStore(): CyboCredentialStore {
    if (!this.credentialStoreInstance) {
      this.credentialStoreInstance = new CyboCredentialStore({ logger: this.logger });
    }
    return this.credentialStoreInstance;
  }

  // Composio third-party tools — built once from COMPOSIO_API_KEY (knowledge:
  // composio-ownership-and-permissions). A scheduled run is autonomous, so caller
  // toolkits are dropped at spawn; only service-bound ones run. SHIPS DARK.
  private composioDepsResolved = false;
  private composioDepsInstance: ComposioDeps | undefined;

  private get composio(): ComposioDeps | undefined {
    if (!this.composioDepsResolved) {
      this.composioDepsInstance = createComposioDeps(this.storage);
      this.composioDepsResolved = true;
    }
    return this.composioDepsInstance;
  }

  constructor(options: ScheduleRunnerOptions) {
    this.storage = options.storage;
    this.agentManager = options.agentManager;
    this.logger = options.logger;
    this.serverId = options.serverId;
    this.cyborg7McpBaseUrl = options.cyborg7McpBaseUrl;
  }

  setCyborg7McpBaseUrl(url: string | undefined): void {
    this.cyborg7McpBaseUrl = url;
  }

  // Optional sink for task-processing Logs events. When set (bootstrap wires it to
  // the message-router's broadcastTaskEvent), due-tick / scheduled dispatches show
  // up in the Logs tab too — not just the immediate on-create/on-assign path.
  setOnTaskEvent(cb: TaskEventEmitter): void {
    this.onTaskEvent = cb;
  }

  // Register extra periodic work to run on this runner's existing timer (#607
  // scheduled-message firing), so the daemon doesn't spin up a second scheduler
  // timer. Pumped at the end of each tick; its own errors are isolated.
  setAdditionalTick(fn: () => Promise<void>): void {
    this.additionalTick = fn;
  }

  start(): void {
    if (this.timer) return;
    const timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // Don't keep the process alive solely for the scheduler (e.g. in tests).
    if (typeof timer.unref === "function") timer.unref();
    this.timer = timer;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Exposed for tests / manual triggering.
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow tick must not overlap the next
    this.ticking = true;
    try {
      const due = this.storage.getDueSchedules(Date.now());
      for (const schedule of due) {
        await this.processDue(schedule);
      }
    } catch (err) {
      this.logger.warn({ err }, "[schedule] tick failed");
    } finally {
      this.ticking = false;
    }
    // Tasks Phase 3: fire due agent-assigned tasks on the SAME tick, after the cron
    // pass. Isolated so a task-dispatch failure can't abort the cron pass or the
    // additional tick below.
    try {
      await this.dispatchDueTasks();
    } catch (err) {
      this.logger.warn({ err }, "[schedule] due-task dispatch failed");
    }
    // Pump the piggybacked work (#607 scheduled messages) on the same timer.
    // Isolated from the cybo tick above so neither aborts the other; the runner
    // has its own re-entrancy guard.
    if (this.additionalTick) {
      try {
        await this.additionalTick();
      } catch (err) {
        this.logger.warn({ err }, "[schedule] additional tick failed");
      }
    }
  }

  private async processDue(schedule: StoredSchedule): Promise<void> {
    // The slot this tick is firing against (for the run-history row). The schedule
    // is in getDueSchedules() precisely because next_run_at <= now.
    const scheduledFor = schedule.next_run_at;

    // Overlap guard: the previous run for THIS schedule is still in flight (its
    // cybo turn outran the cadence). Skip WITHOUT advancing next_run_at, so it
    // stays due and retries on a later tick once the run finishes — rather than
    // piling up overlapping spawns (#209). Recorded as a 'skipped'/overlap run so
    // the missed fire is visible, not silently lost (#619).
    if (this.inFlight.has(schedule.id)) {
      this.logger.warn(
        { scheduleId: schedule.id },
        "[schedule] previous run still in flight — skipping this tick",
      );
      this.recordSkip(schedule, scheduledFor, "overlap");
      return;
    }

    // Advance next_run_at BEFORE firing so a slow/failed run can't re-fire on the
    // next tick. A cron we can't parse anymore disables the schedule (no retry loop).
    let next: number;
    try {
      next = computeNextRunAt(
        { type: "cron", expression: schedule.cron_expr, timezone: schedule.timezone ?? undefined },
        new Date(),
      ).getTime();
    } catch (err) {
      this.logger.warn(
        { err, scheduleId: schedule.id, cron: schedule.cron_expr },
        "[schedule] invalid cron — disabling schedule",
      );
      this.storage.setScheduleEnabled(schedule.id, false);
      return;
    }

    // Catch-up policy (#619 §3.3): a schedule that's been due for more than one
    // whole cadence period (the daemon was offline across several slots) and has
    // catch_up=false skips straight to the next FUTURE occurrence WITHOUT firing —
    // a stale "every 5 min health check" is noise. catch_up=true (default) falls
    // through and fires the single catch-up run. Mirrors recoverInterruptedRuns.
    if (schedule.catch_up === 0 && this.isMoreThanOnePeriodLate(schedule, next)) {
      this.logger.info(
        { scheduleId: schedule.id },
        "[schedule] catch_up=false and >1 period late — skipping to next future run",
      );
      this.storage.markScheduleRun(schedule.id, Date.now(), next);
      return;
    }

    // Re-validate the CREATOR's access at fire time. Interactive spawns are gated
    // on membership + daemon access, but a schedule persists — a creator removed
    // from the workspace (or whose daemon access was revoked) must stop executing
    // code. Disable rather than keep running under stale authority (#209). Recorded
    // as a 'skipped'/unauthorized run before disabling, so the reason is visible.
    if (!(await this.isCreatorStillAuthorized(schedule))) {
      this.logger.warn(
        { scheduleId: schedule.id, userId: schedule.created_by },
        "[schedule] creator no longer authorized — disabling schedule",
      );
      this.recordSkip(schedule, scheduledFor, "unauthorized");
      this.storage.setScheduleEnabled(schedule.id, false);
      return;
    }

    // License gate: when the workspace trial has ended with no active subscription,
    // interactive spawns are hard-paused — scheduled ones must be too (no paywall
    // bypass). Skip the fire but advance past it so paused ticks don't accumulate (#209).
    // run_count is NOT bumped: a paused one-shot must not "complete" without ever
    // running. Recorded as a 'skipped'/license_paused run (#619).
    if (await this.isLicensePaused(schedule.workspace_id)) {
      this.logger.info(
        { scheduleId: schedule.id, workspaceId: schedule.workspace_id },
        "[schedule] workspace license paused — skipping run",
      );
      this.recordSkip(schedule, scheduledFor, "license_paused");
      this.storage.markScheduleRun(schedule.id, Date.now(), next);
      return;
    }

    // This tick consumes a slot, so bump run_count. One-shot completion (#619):
    // if this fire reaches max_runs, DEACTIVATE instead of advancing the cadence —
    // a one-shot ("remind me Friday") fires once and stops, never re-firing on the
    // recomputed next slot. run_count was just incremented, so compare against it+1.
    const completesOneShot =
      schedule.max_runs !== null && schedule.run_count + 1 >= schedule.max_runs;
    if (completesOneShot) {
      // Disable + clear next_run_at, and bump run_count in the same write path:
      // setScheduleEnabled doesn't touch run_count, so stamp it via markScheduleRun
      // first (advances next_run_at, but the disable below clears it), then disable.
      this.storage.markScheduleRun(schedule.id, Date.now(), null, true);
      this.storage.setScheduleEnabled(schedule.id, false, null);
    } else {
      this.storage.markScheduleRun(schedule.id, Date.now(), next, true);
    }

    // Cross-daemon exactly-once (#cron-dup). Everything ABOVE is per-daemon local
    // bookkeeping (each daemon advances its OWN next_run_at / run_count, so none
    // re-fires this slot). The FIRE itself must happen on exactly ONE daemon: the
    // raw-prompt path runs on EVERY daemon that holds this schedule, and the
    // in-process `inFlight` Set only dedupes within THIS process — nothing stopped
    // two daemons both spawning the cybo + posting (the per-task path has
    // claimTaskDispatch; this is its missing twin). Atomically claim THIS
    // (schedule, slot); the loser daemons already advanced past the slot above, so
    // they record a clean 'duplicate' skip and never post a second time. The slot is
    // non-null here (getDueSchedules filters next_run_at IS NOT NULL); the guard keeps
    // it type-safe and degrades to the in-process guard if a null ever slips through.
    if (scheduledFor !== null) {
      const claimed = await this.storage.claimScheduleDispatch(
        schedule.id,
        scheduledFor,
        this.serverId,
      );
      if (!claimed) {
        this.logger.info(
          { scheduleId: schedule.id, scheduledFor },
          "[schedule] dispatch slot already claimed by another daemon — skipping fire",
        );
        this.recordSkip(schedule, scheduledFor, "duplicate");
        return;
      }
    }

    // Open the run-history row, then fire-and-forget but TRACKED: inFlight spans
    // the whole spawn + cybo turn so the overlap guard above can skip the next tick
    // while this run is still going. The run row is closed in fire().
    const runId = this.storage.startScheduleRun({
      scheduleId: schedule.id,
      workspaceId: schedule.workspace_id,
      scheduledFor,
    });
    this.inFlight.add(schedule.id);
    void this.fire(schedule, runId).finally(() => this.inFlight.delete(schedule.id));
  }

  // Tasks Phase 3 (internal docs): fire due agent-assigned tasks. Reads the
  // due set from local storage (this daemon's workspaces), then dispatches each via
  // the shared task-dispatch path. The per-task atomic claim inside
  // dispatchTaskToAgent is the cross-process exactly-once guard; the tasksInFlight
  // Set here mirrors the cron path's overlap guard so a dispatch whose cybo turn
  // outlasts the tick can't be re-picked on the next tick (#209 pattern for tasks).
  private async dispatchDueTasks(): Promise<void> {
    const due: StoredTask[] = this.storage.getDueTasks(Date.now());
    for (const task of due) {
      if (this.tasksInFlight.has(task.id)) continue;
      this.tasksInFlight.add(task.id);
      void dispatchTaskToAgent({
        storage: this.storage,
        agentManager: this.agentManager,
        task,
        reason: "task_due",
        serverId: this.serverId,
        cyborg7McpBaseUrl: this.cyborg7McpBaseUrl,
        credentialStore: this.credentialStore,
        composio: this.composio,
        logger: this.logger,
        onEvent: this.onTaskEvent,
      })
        .catch((err) =>
          this.logger.warn({ err, taskId: task.id }, "[schedule] task dispatch failed"),
        )
        .finally(() => this.tasksInFlight.delete(task.id));
    }
  }

  // Record a 'skipped' run with a closed-set reason (best-effort — a history
  // write must never throw out of the tick / abort the schedule).
  private recordSkip(
    schedule: StoredSchedule,
    scheduledFor: number | null,
    skipReason: ScheduleSkipReason,
  ): void {
    try {
      this.storage.recordSkippedScheduleRun({
        scheduleId: schedule.id,
        workspaceId: schedule.workspace_id,
        scheduledFor,
        skipReason,
      });
    } catch (err) {
      this.logger.warn({ err, scheduleId: schedule.id }, "[schedule] failed to record skipped run");
    }
  }

  // True when the schedule's NEXT occurrence after its due slot is ALSO already in
  // the past — i.e. the daemon missed more than one whole cadence period. `next`
  // is the first future occurrence (computed from now), so the test is: is there a
  // slot strictly between the due slot and now? We recompute from the due slot and
  // check whether the following occurrence still precedes now.
  private isMoreThanOnePeriodLate(schedule: StoredSchedule, next: number): boolean {
    const dueSlot = schedule.next_run_at;
    if (dueSlot === null) return false;
    const now = Date.now();
    try {
      const afterDue = computeNextRunAt(
        {
          type: "cron",
          expression: schedule.cron_expr,
          timezone: schedule.timezone ?? undefined,
        },
        new Date(dueSlot),
      ).getTime();
      // The occurrence right after the missed slot is itself in the past → we're
      // more than one period behind. (afterDue < next means a slot was skipped.)
      return afterDue <= now && afterDue < next;
    } catch {
      return false;
    }
  }

  // The schedule keeps running under its CREATOR's identity, so re-check that
  // identity still has access: workspace membership (SQLite, authoritative for
  // removals) plus daemon access (only checkable when connected to PG, which owns
  // daemon_access). A solo daemon (no PG) is owner-only, so membership suffices.
  //
  // ID-SPACE RECONCILIATION (the connected-mode shared-cybo bug): `created_by` is
  // resolved from `agent_bindings.initiated_by`, a daemon-LOCAL SQLite id
  // (dispatcher.ts: "initiated_by is stored in the local id space"). But in
  // connected mode workspace membership AND daemon_access are keyed by the CLOUD
  // account id (dual-storage.addMember(pgId); pg-sync.canUserAccessDaemon), which
  // can differ from the local id for the SAME person. Without bridging, a shared
  // cybo's schedule created by member X carries X's local id, fails the cloud
  // daemon-access check, and is silently DISABLED on first fire. Bridge by EMAIL —
  // the exact idiom the dispatcher already uses ("only reject when it's genuinely
  // a different account", :5144) and cross-daemon-initiated-by.ts: distinct people
  // have distinct emails, so this can never widen access to another account.
  private async isCreatorStillAuthorized(schedule: StoredSchedule): Promise<boolean> {
    const ws = schedule.workspace_id;
    const localId = schedule.created_by;
    const cloudId = await this.resolveCreatorAccessId(localId);
    // Accept EITHER id for membership: connected mode keys it by the cloud id, but
    // a solo/legacy row may still be under the local id.
    const isMember =
      !!this.storage.getMembership(ws, localId) ||
      (cloudId !== localId && !!this.storage.getMembership(ws, cloudId));
    if (!isMember) return false;
    const pg = this.storage.pg;
    if (pg && this.serverId) {
      try {
        // daemon_access (PG) is keyed by the cloud account id.
        return await pg.canUserAccessDaemon(ws, this.serverId, cloudId);
      } catch (err) {
        // A transient PG error must not silently disable a schedule. Membership
        // already passed (authoritative), so treat as authorized; retry next tick.
        this.logger.warn(
          { err, scheduleId: schedule.id },
          "[schedule] daemon-access check failed — allowing this tick",
        );
        return true;
      }
    }
    return true;
  }

  // Bridge a schedule's `created_by` (a daemon-LOCAL SQLite id) to the CLOUD
  // account id by EMAIL, so authorization checks keyed on the cloud id resolve to
  // the right person. Returns the original id unchanged in solo mode, or when no
  // email / no matching cloud account exists — preserving correct behavior for
  // already-aligned id-spaces (the id may already BE the cloud id).
  private async resolveCreatorAccessId(localId: string): Promise<string> {
    const pg = this.storage.pg;
    if (!pg) return localId;
    const email = this.storage.getUserById(localId)?.email;
    if (!email) return localId;
    try {
      const cloud = await pg.getUserByEmail(email);
      return cloud?.id ?? localId;
    } catch (err) {
      this.logger.warn({ err, localId }, "[schedule] creator id-space bridge failed");
      return localId;
    }
  }

  // Resolve the schedule/task CREATOR's real email (daemon-local id -> users.email)
  // so an autonomous spawn stamps the initiator on its binding and the relay
  // owner-scopes agent_sessions to the scheduler (privacy: no owner-less sessions).
  // Never returns the synthetic "<id>@remote.local" placeholder — that can't match
  // a real cloud email, so return null and let the mirror's own fallback handle it.
  private resolveCreatorEmail(localId: string): string | null {
    const email = this.storage.getUserById(localId)?.email ?? null;
    if (email && email.toLowerCase().endsWith("@remote.local")) return null;
    return email;
  }

  private async isLicensePaused(workspaceId: string): Promise<boolean> {
    const pg = this.storage.pg;
    if (!pg) return false; // solo / unbilled daemon — no license to pause
    try {
      const license = await pg.getLicenseStatus(workspaceId);
      return license.state === "paused";
    } catch (err) {
      // Fail OPEN on a billing-check hiccup — don't block legitimate runs on a
      // transient PG error (the interactive path has the same backstop).
      this.logger.warn({ err, workspaceId }, "[schedule] license check failed — allowing run");
      return false;
    }
  }

  // Human "Run now" (the run_once RPC): fire the schedule immediately WITHOUT
  // touching its cadence — next_run_at is untouched so the regular cron run
  // still happens on time. Same authority + license gates as a scheduled tick
  // (a paused workspace or a deauthorized creator can't fire on demand either),
  // and the overlap guard so it can't double up with an in-flight cron run.
  // Returns the failure reason for the caller to surface (null = fired).
  async runOnce(scheduleId: string): Promise<string | null> {
    const schedule = this.storage.getSchedule(scheduleId);
    if (!schedule) return "Schedule not found";
    if (this.inFlight.has(schedule.id)) return "This schedule is already running";
    if (!(await this.isCreatorStillAuthorized(schedule))) {
      return "The schedule's creator no longer has access to run it";
    }
    if (await this.isLicensePaused(schedule.workspace_id)) {
      return "This workspace is paused — runs are disabled";
    }
    // A manual run is still a run worth recording, but off-cadence — scheduledFor
    // is null (no cron slot) and it never advances next_run_at or run_count (a
    // "Run now" must not consume a one-shot's single fire).
    const runId = this.storage.startScheduleRun({
      scheduleId: schedule.id,
      workspaceId: schedule.workspace_id,
      scheduledFor: null,
    });
    this.inFlight.add(schedule.id);
    void this.fire(schedule, runId).finally(() => this.inFlight.delete(schedule.id));
    return null;
  }

  // Fire a schedule's run, closing the run-history row with the outcome. runId is
  // the row opened by the caller at fire time.
  //
  // Two shapes:
  //   • PER-TASK (task_id set): run the BOUND TASK as its assignee cybo, unattended,
  //     via the shared task-dispatch path — gated on the workspace autonomy toggle
  //     (a cron fire is autonomous work; if the workspace turned autonomy OFF, the
  //     fire is suppressed). The channel auto_tasks gate is NOT consulted here.
  //   • RAW-PROMPT (task_id null): the original behaviour — spawn the schedule's
  //     cybo and deliver `prompt` as its first turn. Unaffected by the autonomy gate.
  private async fire(schedule: StoredSchedule, runId: string): Promise<void> {
    // `!= null` (loose) treats both null AND undefined as "no bound task": a
    // raw-prompt schedule's task_id is null in the store, but a partial in-memory
    // fixture may leave it undefined — both must take the spawnCybo path, not
    // fireTask. Only a real task id routes to the per-task fire.
    if (schedule.task_id != null) {
      await this.fireTask(schedule, runId, schedule.task_id);
      return;
    }
    try {
      // Item 3 (session singleton): reuse the cybo's live (cybo, channel) session
      // instead of spawning a fresh one on EVERY fire — a per-minute cron otherwise
      // piled up one visible "Rick" session per tick. Reuse only when the binding's
      // agent is still LOADED in this process (routeToAgent/runAgent can act on it);
      // a torn-down/never-loaded agent falls through to a fresh spawn (first run /
      // agent gone), preserving continuity without resurrecting a dead session.
      const reusedAgentId = this.reuseLiveCyboBinding(
        schedule.workspace_id,
        schedule.cybo_id,
        schedule.channel_id ?? null,
      );
      let agentId: string;
      if (reusedAgentId) {
        agentId = reusedAgentId;
        this.logger.info(
          { scheduleId: schedule.id, agentId, channelId: schedule.channel_id ?? null },
          "[schedule] reusing live cybo session (no new spawn)",
        );
      } else {
        const channel = schedule.channel_id
          ? this.storage.getChannel(schedule.channel_id)
          : undefined;
        const result = await spawnCybo({
          storage: this.storage,
          agentManager: this.agentManager,
          workspaceId: schedule.workspace_id,
          cyboIdOrSlug: schedule.cybo_id,
          userId: schedule.created_by,
          initiatedByEmail: this.resolveCreatorEmail(schedule.created_by),
          serverId: this.serverId,
          cyborg7McpBaseUrl: this.cyborg7McpBaseUrl,
          // A scheduled run is UNATTENDED — no human to answer a permission prompt —
          // so a claude cybo must bypass canUseTool or its post/tool calls hang
          // forever (the turn never settles, the inFlight guard never clears, and the
          // reminder is never posted). Stays a visible agent session (not ephemeral).
          unattended: true,
          context: {
            channelId: schedule.channel_id ?? undefined,
            channelName: channel?.name,
          },
          credentialStore: this.credentialStore,
          composio: this.composio,
          autonomous: true,
          logger: this.logger,
        });
        agentId = result.agentId;
      }
      // Deliver the schedule's prompt as the cybo's first turn. AWAIT the full turn
      // (runAgent resolves at turn end) so the inFlight overlap guard stays set for
      // the whole run, not just the spawn. The timeline persists independently.
      await this.agentManager.runAgent(agentId, schedule.prompt);
      // Closed-set 'succeeded' with the agent id so the UI can deep-link into the
      // Agents pane (#619).
      this.finishRun(runId, { status: "succeeded", agentId });
    } catch (err) {
      this.logger.warn({ err, scheduleId: schedule.id }, "[schedule] spawn/run failed");
      // Failures are SHOWN, never dropped (#619): record the error on the run row.
      this.finishRun(runId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Per-task fire (task_id set): run the BOUND TASK as its assignee cybo,
  // unattended, via the shared task-dispatch path. Two extra gates over the
  // raw-prompt path:
  //   1. AUTONOMY: a cron fire is autonomous work, so it respects the workspace
  //      agent_autonomy_enabled toggle (the SAME predicate the message-router's
  //      channel-watcher path uses). Autonomy OFF → SKIP the fire (don't dispatch),
  //      recorded as 'failed' with a clear reason so it's visible, never silent. We
  //      do NOT gate on the channel auto_tasks switch (that gates channel watchers,
  //      not scheduled task fires).
  //   2. The task must still exist (a deleted task cascades its schedule away, but
  //      a tick in flight at delete time could still reach here).
  // Exactly-once across replicas is the existing claimTaskDispatch inside
  // dispatchTaskToAgent; the runner's inFlight Set is the in-process overlap guard.
  private async fireTask(schedule: StoredSchedule, runId: string, taskId: string): Promise<void> {
    try {
      // Autonomy gate (same predicate as message-router). DEFAULT ON: a missing PG
      // (solo daemon) has no workspace-level toggle, so autonomy is ON there. A
      // transient PG read failure must not silently swallow a fire — treat it as a
      // failed run with the error surfaced, not a skip.
      const pg = this.storage.pg;
      if (pg) {
        let autonomyOn: boolean;
        try {
          autonomyOn = await pg.getWorkspaceAutonomyEnabled(schedule.workspace_id);
        } catch (err) {
          this.logger.warn(
            { err, scheduleId: schedule.id, workspaceId: schedule.workspace_id },
            "[schedule] autonomy check failed — skipping task fire this run",
          );
          this.finishRun(runId, {
            status: "failed",
            error: "autonomy check failed",
          });
          return;
        }
        if (!autonomyOn) {
          this.logger.info(
            { scheduleId: schedule.id, taskId, workspaceId: schedule.workspace_id },
            "[schedule] workspace autonomy OFF — suppressing scheduled task fire",
          );
          this.finishRun(runId, {
            status: "failed",
            error: "workspace autonomy disabled",
          });
          return;
        }
      }

      const task = this.storage.getTaskById(taskId);
      if (!task) {
        this.logger.warn(
          { scheduleId: schedule.id, taskId },
          "[schedule] bound task not found — skipping task fire",
        );
        this.finishRun(runId, { status: "failed", error: "bound task not found" });
        return;
      }

      const dispatched = await dispatchTaskToAgent({
        storage: this.storage,
        agentManager: this.agentManager,
        task,
        reason: "task_due",
        serverId: this.serverId,
        cyborg7McpBaseUrl: this.cyborg7McpBaseUrl,
        credentialStore: this.credentialStore,
        logger: this.logger,
        onEvent: this.onTaskEvent,
        // A cron fire has no human to answer a permission prompt.
        unattended: true,
      });
      // dispatchTaskToAgent returns false when it loses the atomic claim (another
      // path/replica already dispatched within the stale window), or the assignee
      // isn't a cybo on this daemon — both are correct no-ops, not failures. A true
      // spawn failure is logged inside dispatchTaskToAgent (and surfaced via onEvent)
      // and also returns false, so the run row records 'succeeded' only when THIS
      // call actually dispatched.
      this.finishRun(
        runId,
        dispatched
          ? { status: "succeeded" }
          : { status: "failed", error: "dispatch skipped (claim lost or non-cybo assignee)" },
      );
    } catch (err) {
      this.logger.warn({ err, scheduleId: schedule.id, taskId }, "[schedule] task fire failed");
      this.finishRun(runId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Item 3 (session singleton): return the agentId of the cybo's live (cybo, channel)
  // session to reuse, or null to spawn fresh. A binding qualifies only when its agent
  // is still LOADED in this process — a recurring cron fire then routes to the SAME
  // session instead of spawning a new visible "Rick" per tick. A stale binding whose
  // agent was torn down (or never loaded) returns null so the caller spawns fresh,
  // preserving continuity without resurrecting a dead session. channelId null = a
  // DM-scoped binding; a cron fire always targets the schedule's channel scope.
  private reuseLiveCyboBinding(
    workspaceId: string,
    cyboId: string,
    channelId: string | null,
  ): string | null {
    const binding = this.storage.getLiveCyboBinding(workspaceId, cyboId, channelId);
    if (!binding) return null;
    // Only reuse when the agent is loadable right now (in-memory). getAgent is a
    // cheap synchronous probe; routeToAgent/runAgent would lazy-restore from disk,
    // but for a cron fire we prefer a clean fresh spawn over reviving a cold session.
    return this.agentManager.getAgent(binding.agent_id) ? binding.agent_id : null;
  }

  // Best-effort close of a run row — a history write must never throw out of the
  // fire path (the run itself already happened; losing the record is non-fatal).
  private finishRun(
    runId: string,
    outcome: { status: "succeeded" | "failed"; agentId?: string | null; error?: string | null },
  ): void {
    try {
      this.storage.finishScheduleRun({ id: runId, ...outcome });
    } catch (err) {
      this.logger.warn({ err, runId }, "[schedule] failed to record run outcome");
    }
  }
}

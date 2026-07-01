import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { ComposioDeps } from "./composio-deps.js";
import type { CyboCredentialStore } from "./cybo-credentials.js";
import { spawnCybo } from "./cybo-manager.js";
import type { DualStorage } from "./dual-storage.js";
import type { StoredTask } from "./storage.js";
import type { TaskLogEvent } from "./task-event-log.js";

// Observability hook (#Logs tab): the caller (dispatcher) supplies this to fan a
// structured task-pipeline event out to the workspace. Optional + best-effort —
// dispatch/recurrence work exactly the same when it's absent (tests, solo daemon).
export type TaskEventEmitter = (event: TaskLogEvent) => void;

// Phase 3 execute-dispatch + recurrence. Ports v1's proven model
// (cyborg7-core/src/lib/tasks/recurrence.ts + dispatch.ts) onto the v2 daemon:
// the cybo runs natively on this daemon's provider, the platform-context prompt
// tells it to complete the task and report via the cyborg7_* MCP tools, and the
// foundation's atomic claims (claimTaskDispatch / spawnRecurrenceChild) make every
// firing path exactly-once (internal docs).

// Safety cap on a recurrence chain — v1 MAX_RECURRENCE_COUNT (dispatch.ts:203).
// rate(1 day) * 365 = a year of daily fires; beyond that a runaway chain is a bug,
// not intent.
export const MAX_RECURRENCE_COUNT = 365;

// ─── Recurrence math (pure, deterministic) ──────────────────────────────────
//
// Ported verbatim from v1 cyborg7-core/src/lib/tasks/recurrence.ts:15-119. The
// only behavioral change is that the caller supplies `nowMs` (no Date.now inside)
// so the next-run computation is fully deterministic and unit-testable.

const RATE_REGEX = /^rate\((\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)\)$/i;

type RecurrenceUnit = "minute" | "hour" | "day" | "week";

interface ParsedRate {
  amount: number;
  unit: RecurrenceUnit;
}

const MIN_AMOUNT = 1;
// Sanity cap — rate(10000 weeks) is ~192 years, beyond which nothing we do makes
// sense (v1 recurrence.ts:26).
const MAX_AMOUNT = 10_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// Loop cap is a safety net; with the O(1) fast path below, normal day/week
// advancement never approaches it (v1 recurrence.ts:97).
const MAX_ADVANCE_ITER = 100_000;

// Parse `rate(N unit)` into { amount, unit }. Returns null for anything
// unparseable (missing string, typo, unsupported unit, non-integer N, N < 1,
// N > MAX_AMOUNT). A null result means "not a recognized recurrence" — the caller
// treats the task as one-off (v1 recurrence.ts:34-42).
function parseRate(expr: string | null | undefined): ParsedRate | null {
  if (typeof expr !== "string") return null;
  const m = expr.trim().match(RATE_REGEX);
  if (!m) return null;
  const amount = Number.parseInt(m[1], 10);
  if (!Number.isFinite(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) return null;
  const unit = m[2].toLowerCase().replace(/s$/, "") as RecurrenceUnit;
  return { amount, unit };
}

function rateToMs(rate: ParsedRate): number {
  switch (rate.unit) {
    case "minute":
      return rate.amount * MINUTE_MS;
    case "hour":
      return rate.amount * HOUR_MS;
    case "day":
      return rate.amount * DAY_MS;
    case "week":
      return rate.amount * WEEK_MS;
  }
}

// Advance `from` by one rate interval. Uses the calendar-aware setX methods so a
// DST transition in the local zone doesn't drift a day/week occurrence by an hour
// — Date#setDate etc. operate on wall-clock units, which is what "every day"
// means (v1 recurrence.ts:65-74).
function addRate(from: Date, rate: ParsedRate): Date {
  const d = new Date(from);
  switch (rate.unit) {
    case "minute":
      d.setMinutes(d.getMinutes() + rate.amount);
      break;
    case "hour":
      d.setHours(d.getHours() + rate.amount);
      break;
    case "day":
      d.setDate(d.getDate() + rate.amount);
      break;
    case "week":
      d.setDate(d.getDate() + rate.amount * 7);
      break;
  }
  return d;
}

// Advance `from` by multiples of `rate` until the result is strictly after
// `threshold`.
//
// For minute/hour units the step count is computed directly (one multiplication,
// no iteration): a task stuck in the past for years + rate(1 minute) would need
// millions of loop hops otherwise, blowing the cap and returning a date that's
// still behind now — a silently-corrupted schedule (v1 recurrence.ts:99-110).
//
// For day/week units we keep the iterative calendar-aware path so each hop
// compensates for DST (a pure-arithmetic jump would drift ±1h per DST crossing,
// which matters for "every morning at 8am" cadences — v1 recurrence.ts:112-118).
function advanceToFuture(from: Date, rate: ParsedRate, threshold: Date): Date {
  if (rate.unit === "minute" || rate.unit === "hour") {
    const intervalMs = rateToMs(rate);
    const diffMs = threshold.getTime() - from.getTime();
    if (diffMs < 0) {
      // `from` is already past `threshold`; the contract is "strictly after
      // threshold", which `from` already satisfies — return it.
      return new Date(from);
    }
    const steps = Math.floor(diffMs / intervalMs) + 1;
    return new Date(from.getTime() + steps * intervalMs);
  }

  let d = new Date(from);
  let i = 0;
  while (d <= threshold && i < MAX_ADVANCE_ITER) {
    d = addRate(d, rate);
    i++;
  }
  return d;
}

/**
 * Compute the next fire time (ms epoch) for a recurring task.
 *
 * PURE + deterministic: the caller passes `nowMs` (never reads the clock here) so
 * the result is fully reproducible in tests (internal docs — boundary matrix).
 *
 * @param recurrence the task's `rate(N unit)` expression (or null/garbage)
 * @param fromMs the anchor to advance from (typically the parent's due_at; fall
 *   back to nowMs at the call site if the parent had no due_at)
 * @param nowMs the wall clock; the returned value is guaranteed strictly > nowMs
 * @returns the next due_at in ms, or null if `recurrence` is absent/unparseable
 *   (caller treats the task as one-off and does NOT spawn a child)
 */
export function computeNextRecurrence(
  recurrence: string | null | undefined,
  fromMs: number,
  nowMs: number,
): number | null {
  const rate = parseRate(recurrence);
  if (!rate) return null;
  // Advance from `fromMs` until strictly after `nowMs`. advanceToFuture's contract
  // already returns a value > threshold, but a from that's already future (a
  // not-yet-due parent) would advance off a future anchor; clamp the anchor to no
  // later than now so the next fire is "now + 1 interval", matching v1
  // spawnNextRecurrence's baseDate = parentDueAt > now ? now : parentDueAt.
  const anchor = fromMs > nowMs ? nowMs : fromMs;
  let next = advanceToFuture(new Date(anchor), rate, new Date(nowMs)).getTime();
  // Belt-and-suspenders: if math/DST/clock-skew ever lands the result at/behind
  // now, bump it one interval forward so a downstream due-scan doesn't fire it
  // instantly (v1 dispatch.ts:248-254, SPAWN_PAST_GRACE).
  if (next <= nowMs) next = nowMs + rateToMs(rate);
  return next;
}

// ─── Execute-dispatch (wake the assigned cybo) ──────────────────────────────

export type DispatchReason = "task_assigned" | "task_due" | "task_reminder";

export interface DispatchTaskOptions {
  storage: DualStorage;
  agentManager: AgentManager;
  task: StoredTask;
  reason: DispatchReason;
  serverId?: string;
  cyborg7McpBaseUrl?: string;
  credentialStore?: CyboCredentialStore;
  // Composio third-party tools. A task dispatch is AUTONOMOUS (the watcher fired
  // it — no human invoker), so caller-bound toolkits are dropped at spawn; only
  // service-bound ones run. `undefined` ⇒ Composio is off (feature dark).
  composio?: ComposioDeps;
  logger?: Logger;
  // Surface dispatch outcomes to the Logs tab (best-effort; see TaskEventEmitter).
  onEvent?: TaskEventEmitter;
  // Stale window for the atomic claim — defaults to the foundation's 30s.
  staleMs?: number;
  // Spawn the cybo UNATTENDED — no human to answer a permission prompt — so a
  // claude cybo bypasses canUseTool (else its post/tool calls hang forever).
  // Set by a CRON-fired task dispatch (the schedule runner); the interactive
  // on-create/on-assign path leaves it false. Default false.
  unattended?: boolean;
}

/**
 * Dispatch a task to its assigned cybo: claim it (exactly-once), build the v1
 * platform-context prompt, spawn the cybo on this daemon, and run one turn.
 *
 * Returns true iff THIS call won the claim and spawned the cybo. Skips silently
 * (returns false) when:
 *   - the task has no assignee, or the assignee is not a cybo on this daemon
 *     (a human assignee, or a cybo this daemon doesn't own — ownership is sticky);
 *   - the atomic claim was lost (another path/replica/tick already dispatched it
 * inside the 30s window — internal docs).
 *
 * The claim is taken FIRST so the create/update immediate path and the
 * schedule-runner tick can both call this without double-firing.
 */
function resolveTaskCreatorEmail(storage: DualStorage, createdBy: string): string | null {
  const email = storage.getUserById(createdBy)?.email ?? null;
  if (email && email.toLowerCase().endsWith("@remote.local")) return null;
  return email;
}

export async function dispatchTaskToAgent(opts: DispatchTaskOptions): Promise<boolean> {
  const { storage, agentManager, task, reason, logger } = opts;

  if (!task.assignee_id) return false;

  // Discriminate agent-assigned from human-assigned: a cybo resolves via getCybo;
  // a human assignee (workspace member) does not. Only cybos execute (internal docs
  // §4.1). resolvedCybo is threaded into spawnCybo so a daemon whose SQLite lacks
  // the cybo still spawns it.
  const cybo = storage.getCybo(task.assignee_id);
  if (!cybo) return false;

  // Atomic claim — at most one dispatch per task per `staleMs` window across the
  // immediate path, the tick, and the reconnect sweep (internal docs).
  const won = storage.claimTaskDispatch(task.id, opts.staleMs ?? 30_000);
  if (!won) return false;

  const channel = task.channel_id ? storage.getChannel(task.channel_id) : undefined;
  const prompt = buildTaskPrompt(task, channel?.name ?? null, reason);

  try {
    const result = await spawnCybo({
      storage,
      agentManager,
      workspaceId: task.workspace_id,
      cyboIdOrSlug: cybo.id,
      userId: task.created_by,
      // Stamp the task CREATOR's real email so this autonomous dispatch is
      // owner-scoped to whoever created the task (privacy: no owner-less sessions).
      // Skip the synthetic "<id>@remote.local" placeholder (never matches a real
      // cloud email) — let the binding mirror's fallback handle those.
      initiatedByEmail: resolveTaskCreatorEmail(opts.storage, task.created_by),
      serverId: opts.serverId,
      cyborg7McpBaseUrl: opts.cyborg7McpBaseUrl,
      context: {
        channelId: task.channel_id ?? undefined,
        channelName: channel?.name,
      },
      ephemeral: true,
      // A cron-fired task dispatch is unattended (no human to answer a permission
      // prompt), so a claude cybo must bypass canUseTool or the turn never settles
      // and the claim's stale window can't clear the next fire cleanly.
      unattended: opts.unattended ?? false,
      resolvedCybo: cybo,
      credentialStore: opts.credentialStore,
      composio: opts.composio,
      autonomous: true,
      logger,
    });
    // Await the full turn so callers that want to know the dispatch finished can;
    // the timeline persists independently of this promise.
    await agentManager.runAgent(result.agentId, prompt);
    logger?.info({ taskId: task.id, cyboId: cybo.id, reason }, "[tasks] dispatched task to cybo");
    opts.onEvent?.({
      kind: "task_dispatched",
      workspaceId: task.workspace_id,
      taskId: task.id,
      cyboId: cybo.id,
      channelId: task.channel_id ?? null,
      title: task.title,
      cyboName: cybo.name,
      reason,
    });
    return true;
  } catch (err) {
    // The claim already held (last_dispatched_at is fresh), so a failed spawn does
    // NOT re-fire this tick; the stale window (30s) lets a later tick retry. Surface
    // the failure, never throw out of a fire-and-forget caller.
    logger?.warn({ err, taskId: task.id, cyboId: cybo.id }, "[tasks] dispatch spawn/run failed");
    opts.onEvent?.({
      kind: "task_dispatch_failed",
      workspaceId: task.workspace_id,
      taskId: task.id,
      cyboId: cybo.id,
      channelId: task.channel_id ?? null,
      title: task.title,
      cyboName: cybo.name,
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Build the v1-style platform-context prompt (cyborg7-core dispatch.ts:115-146):
// tell the cybo this is a platform-scheduled task (not a human in conversation),
// where to post results, and how to report status via the cyborg7_* MCP tools.
function buildTaskPrompt(
  task: StoredTask,
  channelName: string | null,
  reason: DispatchReason,
): string {
  const priority = task.priority ? ` [${task.priority.toUpperCase()}]` : "";
  const dueStr = task.due_at ? ` — due ${new Date(task.due_at).toISOString().split("T")[0]}` : "";
  const recurrenceStr = task.recurrence ? ` (recurring: ${task.recurrence})` : "";

  // Channel instruction keys off the task's linked channel (v1 dispatch.ts:82-89):
  // post results there, or — with no channel — only update the task's status.
  const channelInstruction = channelName
    ? `Post your results to #${channelName} using cyborg7_send_message.`
    : `This task has no linked channel. Do NOT post to any public channel. Put your result in the task status update.`;

  const statusGuide =
    `Set status via cyborg7_update_task with task_id="${task.id}": ` +
    `"done" (completed successfully), "in_progress" (actively working on it), ` +
    `"pending_review" (blocked, failed, or needs human intervention — use this if you cannot ` +
    `fully complete it, e.g. an API errored or credentials are invalid). Always set ` +
    `"pending_review" rather than leaving it "in_progress" when you cannot resolve the issue yourself.`;

  const platformContext =
    `[PLATFORM CONTEXT: This task was assigned by the Cyborg7 platform, NOT by a human in a ` +
    `conversation. Use all your available tools to complete it. ${channelInstruction} ${statusGuide}]`;

  const headers: Record<DispatchReason, string> = {
    task_due: "[SYSTEM: Task Due]",
    task_reminder: "[SYSTEM: Task Reminder]",
    task_assigned: "[SYSTEM: New Task Assigned]",
  };
  const header = headers[reason];

  return (
    `${platformContext}\n\n` +
    `${header}\n\n` +
    `**${task.title}**${priority}${dueStr}${recurrenceStr}\n` +
    (task.description ? `Description: ${task.description}\n\n` : "\n") +
    `Complete this task, then report as instructed above.`
  );
}

// ─── Recurrence spawn-next ──────────────────────────────────────────────────

export interface SpawnNextRecurrenceOptions {
  storage: Pick<DualStorage, "spawnRecurrenceChild">;
  task: StoredTask;
  nowMs: number;
  logger?: Logger;
  // Surface the spawned recurrence to the Logs tab (best-effort).
  onEvent?: TaskEventEmitter;
}

/**
 * When a recurring task completes, spawn its next occurrence — exactly once.
 *
 * Computes the next due_at deterministically (computeNextRecurrence), then defers
 * the exactly-once guarantee + cap to the foundation's atomic spawnRecurrenceChild
 * (claims `recurrence_spawned_at IS NULL` under `recurrence_count < MAX` and
 * inserts the child in one transaction). Two concurrent callers → one child
 * (internal docs §6.8).
 *
 * Returns the new child task's id, or null when the task is not recurring, its
 * expression is unparseable, the chain hit MAX_RECURRENCE_COUNT, or another caller
 * already spawned.
 */
export function spawnNextRecurrence(opts: SpawnNextRecurrenceOptions): string | null {
  const { task, nowMs, logger } = opts;
  if (!task.recurrence) return null;

  // Anchor on the parent's due_at when present (preserves the cadence's wall-clock
  // slot); fall back to now for an ad-hoc recurring task with no due_at.
  const fromMs = task.due_at ?? nowMs;
  const nextDueAt = computeNextRecurrence(task.recurrence, fromMs, nowMs);
  if (nextDueAt === null) return null;

  const child = opts.storage.spawnRecurrenceChild(task.id, nextDueAt, MAX_RECURRENCE_COUNT);
  if (!child) {
    // Already spawned (race lost) or cap reached — both are correct no-ops.
    logger?.debug?.(
      { taskId: task.id },
      "[tasks] recurrence not spawned (already spawned or cap reached)",
    );
    return null;
  }
  logger?.info(
    { parentId: task.id, childId: child.id, nextDueAt },
    "[tasks] spawned next recurrence",
  );
  opts.onEvent?.({
    kind: "recurrence_spawned",
    workspaceId: task.workspace_id,
    taskId: task.id,
    channelId: task.channel_id ?? null,
    title: task.title,
    childTaskId: child.id,
    nextDueAt,
  });
  return child.id;
}

// ─── Catch-up on daemon reconnect (ownership is sticky) ─────────────────────

export interface CatchUpOwnedTasksOptions {
  storage: DualStorage;
  agentManager: AgentManager;
  workspaceId: string;
  // The reconnecting daemon's OWN cybo ids. Only tasks assigned to these are
  // dispatched — ownership does NOT fail over to another daemon (internal docs
  // Decision 5, §4.4).
  assigneeIds: readonly string[];
  serverId?: string;
  cyborg7McpBaseUrl?: string;
  credentialStore?: CyboCredentialStore;
  // Composio third-party tools. A task dispatch is AUTONOMOUS (the watcher fired
  // it — no human invoker), so caller-bound toolkits are dropped at spawn; only
  // service-bound ones run. `undefined` ⇒ Composio is off (feature dark).
  composio?: ComposioDeps;
  logger?: Logger;
  // Catch-up window: tasks undispatched (or last dispatched) longer ago than this
  // are swept. Defaults to 1h, matching the foundation getOwnedOpenTasks default.
  staleMs?: number;
}

/**
 * On daemon reconnect, re-dispatch the daemon's OWNED open/overdue tasks that went
 * undispatched while it was offline — once each, never a storm.
 *
 * Each dispatch goes through dispatchTaskToAgent, whose atomic claim makes the
 * whole sweep idempotent: a reconnect storm (the same daemon reconnecting several
 * times in quick succession) re-runs the sweep but the claim lets only the first
 * pass per task win (internal docs §6.9). Ownership is sticky — only this
 * daemon's cybos are passed in, so a task is never reassigned to another daemon.
 *
 * Returns the count of tasks actually dispatched by THIS sweep.
 */
export async function catchUpOwnedTasks(opts: CatchUpOwnedTasksOptions): Promise<number> {
  const { storage, agentManager, workspaceId, assigneeIds, logger } = opts;
  if (assigneeIds.length === 0) return 0;

  const owned = storage.getOwnedOpenTasks(workspaceId, assigneeIds, opts.staleMs ?? 3_600_000);
  if (owned.length === 0) return 0;

  let dispatched = 0;
  for (const task of owned) {
    const reason: DispatchReason = task.due_at ? "task_due" : "task_assigned";
    const won = await dispatchTaskToAgent({
      storage,
      agentManager,
      task,
      reason,
      serverId: opts.serverId,
      cyborg7McpBaseUrl: opts.cyborg7McpBaseUrl,
      credentialStore: opts.credentialStore,
      composio: opts.composio,
      logger,
    });
    if (won) dispatched++;
  }
  if (dispatched > 0) {
    logger?.info({ workspaceId, dispatched }, "[tasks] reconnect catch-up dispatched owned tasks");
  }
  return dispatched;
}

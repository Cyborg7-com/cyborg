// Provider-AGNOSTIC inbound sync engine for task integrations. Given a resolved
// TaskIntegrationAdapter + already-parsed NormalizedTaskEvent(s), it fans each event out
// to every Cyborg tasks-project bound to the external project, creates-or-refreshes the
// linked task, maps status/priority/labels/assignee/dates, appends inbound comments as
// Activity, and records the external↔task back-link. The generic counterpart of
// routes/github.ts's inbound flow.
//
// It is PURE of provider HTTP: it only calls adapter.provider (the discriminator) + PgSync
// + the existing task helpers. The adapter + PgSync are injected, so the engine is unit-
// testable without a network or a real provider.
//
// TENANT SCOPING: the ONLY payload key the engine trusts is (provider, externalProjectId,
// itemNumber) — and only to look up binding rows. workspaceId / tasksProjectId / createdBy
// are read from the resolved binding, never from the event.
//
// BEST-EFFORT: one event failing logs + continues; the engine never throws to the webhook
// ack (a throw would make the provider retry-storm).

import { createHash, randomUUID } from "node:crypto";
import type { PgSync, StoredProjectSync, StoredTaskItemSync } from "./db/pg-sync.js";
import type {
  NormalizedTaskEvent,
  TaskIntegrationAdapter,
  TaskPriority,
  TaskWorkItemType,
} from "./integrations/task-integration-adapter.js";

// ─── Provider-aware echo guard ───────────────────────────────────────────────
//
// Generalizes github-outbound's guard but KEYS ON (provider, taskId, action). A task
// linked to multiple providers must not cross-suppress: an inbound Jira change is marked
// under "jira", so a later OUTBOUND emit to ClickUp/GitHub for the SAME task still fires.
// The inbound apply MARKS; a wave-2 outbound emit CONSUMES. In-memory + TTL-bounded — the
// durable backstop (content hash on task_item_syncs) survives a relay restart, this does
// not.

// How long an inbound marker stays "fresh" — long enough to cover the inbound→broadcast
// round trip, short enough that an unrelated later human edit isn't mistaken for an echo.
const ECHO_TTL_MS = 30_000;

// The change kinds the guard / a future outbound writer distinguish. "status" = a
// workflow-state transition; "fields" = any content field patch (title/description/
// priority/labels/assignee/dates). Coarser than a per-field key on purpose — a generic
// provider write is one PATCH + an optional status transition.
export type TaskSyncAction = "status" | "fields";

// key (`<provider>:<taskId>:<action>`) → expiry epoch ms. Module-level so the inbound
// apply (marks) and a wave-2 outbound emit (consumes) share one registry in the process.
const echoMarks = new Map<string, number>();

/** The registry key for a (provider, task, action) echo marker. */
export function taskEchoKey(provider: string, taskId: string, action: TaskSyncAction): string {
  return `${provider}:${taskId}:${action}`;
}

// Drop expired markers so the Map can't grow unbounded across a long-lived relay.
function pruneEcho(now: number): void {
  for (const [k, exp] of echoMarks) {
    if (exp <= now) echoMarks.delete(k);
  }
}

/**
 * Mark a (provider, task, action) as having JUST originated from THIS provider's webhook,
 * so a subsequent outbound emit of the same change to the same provider is suppressed.
 * Called by the inbound apply after it applies a provider-driven task change.
 */
export function markTaskInbound(
  provider: string,
  taskId: string,
  action: TaskSyncAction,
  now = Date.now(),
): void {
  pruneEcho(now);
  echoMarks.set(taskEchoKey(provider, taskId, action), now + ECHO_TTL_MS);
}

/**
 * Was this (provider, task, action) recently driven by THIS provider's webhook? Consumes
 * the marker (a single inbound suppresses a single outbound) and returns true only when a
 * still-fresh marker existed. A DIFFERENT provider's key is never matched — cross-provider
 * fan-out is preserved.
 */
export function consumeTaskInbound(
  provider: string,
  taskId: string,
  action: TaskSyncAction,
  now = Date.now(),
): boolean {
  const key = taskEchoKey(provider, taskId, action);
  const exp = echoMarks.get(key);
  if (exp === undefined) return false;
  echoMarks.delete(key);
  return exp > now;
}

/** TEST-ONLY: clear the echo registry between cases. */
export function _resetTaskEchoGuardForTest(): void {
  echoMarks.clear();
}

// ─── Content hash (durable echo backstop) ────────────────────────────────────

/**
 * A stable content hash over the synced field set of an issue/task event. Stored on
 * task_item_syncs.last_synced_hash after a mirror; the engine skips a refresh whose hash
 * equals the stored one (the inbound bounce of our own write, or a genuine no-op), which
 * survives a relay restart unlike the in-memory TTL guard. PURE.
 */
export function contentHash(event: NormalizedTaskEvent): string {
  const canonical = {
    title: event.title ?? null,
    description: event.description ?? null,
    sourceStatusName: event.sourceStatusName ?? null,
    statusCategory: event.statusCategory ?? null,
    assigneeEmail: event.assigneeEmail ?? null,
    labels: event.labels ? [...event.labels].sort() : null,
    priority: event.priority ?? null,
    dueAt: event.dueAt ?? null,
    startAt: event.startAt ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ─── Pure field mappers ──────────────────────────────────────────────────────

// Map the normalized priority onto the free-text tasks.priority column: "none" clears it
// (null), every other token passes through. Returns undefined when the event carried no
// priority (so the field is left untouched on refresh).
function mapPriority(priority: TaskPriority | undefined): string | null | undefined {
  if (priority === undefined) return undefined;
  return priority === "none" ? null : priority;
}

// HTML-escape a provider-controlled string before it lands in a markdown-rendered
// task_activity.comment_html (parity with routes/github.ts escapeHtml — prevents stored
// XSS from an attacker's comment body / actor name). Ampersand first.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─── Status resolution ───────────────────────────────────────────────────────

// Resolve the Cyborg task-state id an inbound status lands in:
//   1. an explicit status_mappings row (by source status name) with a chosen taskStateId;
//   2. else the affinity fallback — map the event's statusCategory to the project's seeded
//      state in that group (every project is seeded with all five groups at creation);
//   3. else null → leave the state as-is on refresh / use the project default on create.
async function resolveTargetStateId(
  pg: PgSync,
  binding: StoredProjectSync,
  event: NormalizedTaskEvent,
): Promise<string | null> {
  if (event.sourceStatusName) {
    const mapping = await pg.getStatusMapping(binding.id, event.sourceStatusName);
    if (mapping?.taskStateId) return mapping.taskStateId;
  }
  if (event.statusCategory) {
    const states = await pg.getProjectStates(binding.tasksProjectId);
    const match = states.find((s) => s.group === event.statusCategory);
    if (match) return match.id;
  }
  return null;
}

// Resolve an assignee email to a Cyborg user id, but ONLY when that user is a member of
// the binding's workspace (tenant guard — an untrusted payload email must not assign a
// task to a user outside the workspace). Returns undefined when the field is absent, the
// email is unknown, or the user is not a member — so a refresh never clobbers an existing
// assignee based on an unresolved external user.
//
// SIDE EFFECT (best-effort): when resolution succeeds AND an external accountId is present,
// records the (workspace, provider, cyborg user → external account/email) row in
// provider_user_connections. That row is the personal-data SUBJECT the Atlassian Personal
// Data Reporting API reports + erases — this is the ONLY place we capture the Jira accountId.
async function resolveAssigneeId(
  pg: PgSync,
  workspaceId: string,
  email: string | null | undefined,
  provider: string,
  assigneeAccountId: string | null | undefined,
): Promise<string | undefined> {
  if (!email) return undefined;
  const user = await pg.getUserByEmail(email);
  if (!user) return undefined;
  if (!(await pg.isMember(workspaceId, user.id))) return undefined;
  if (assigneeAccountId) {
    await pg
      .upsertProviderUserConnection({
        workspaceId,
        provider,
        cyborgUserId: user.id,
        externalUserId: assigneeAccountId,
        externalEmail: email,
      })
      .catch((err: unknown) => {
        // intentional: personal-data-subject persistence is best-effort — a transient write
        // must not fail the inbound task apply; the next event re-records it.
        console.error("[task-sync] failed to record provider user connection", err);
      });
  }
  return user.id;
}

// ─── Link resolution ─────────────────────────────────────────────────────────

// Find the task an inbound event maps to within one binding. Issue/task events key by
// their own (itemType, itemNumber). Comment/deleted events reference a work item whose
// concrete type isn't on the discriminator, so try the two work-item types in turn.
async function findLinkedItem(
  pg: PgSync,
  binding: StoredProjectSync,
  event: NormalizedTaskEvent,
): Promise<StoredTaskItemSync | null> {
  if (event.itemType === "issue" || event.itemType === "task") {
    return pg.getTaskItemByExternal(binding.id, event.itemType, event.itemNumber);
  }
  const workItemTypes: TaskWorkItemType[] = ["task", "issue"];
  for (const t of workItemTypes) {
    const found = await pg.getTaskItemByExternal(binding.id, t, event.itemNumber);
    if (found) return found;
  }
  return null;
}

// ─── Per-binding apply ───────────────────────────────────────────────────────

// Create the Cyborg task for a first-seen work item + record the back-link + Activity +
// echo marker.
async function createLinkedTask(
  pg: PgSync,
  provider: string,
  binding: StoredProjectSync,
  event: NormalizedTaskEvent,
): Promise<void> {
  const taskId = `task_${randomUUID()}`;
  const stateId = await resolveTargetStateId(pg, binding, event);
  const assigneeId = await resolveAssigneeId(
    pg,
    binding.workspaceId,
    event.assigneeEmail,
    provider,
    event.assigneeAccountId,
  );
  await pg.createTask({
    id: taskId,
    workspaceId: binding.workspaceId,
    title: event.title && event.title.trim() ? event.title : "(untitled)",
    description: event.description ?? undefined,
    createdBy: binding.createdBy,
    projectId: binding.tasksProjectId,
    stateId,
    assigneeId,
    priority: mapPriority(event.priority) ?? undefined,
    dueAt: event.dueAt ?? undefined,
    startDate: event.startAt ?? undefined,
    labelNames: event.labels && event.labels.length > 0 ? event.labels : undefined,
  });
  await pg.upsertTaskItemSync({
    projectSyncId: binding.id,
    taskId,
    provider,
    itemType: event.itemType,
    itemNumber: event.itemNumber,
    providerItemId: event.providerItemId,
    itemUrl: event.itemUrl ?? null,
    lastSyncedHash: contentHash(event),
  });
  await recordActivity(pg, binding, taskId, event, "created");
  markChangeEcho(provider, taskId, event);
}

// Refresh an already-linked task's fields/state + back-link + Activity + echo marker.
// Skips entirely when the content hash is unchanged (the durable echo backstop / a no-op
// refresh).
async function refreshLinkedTask(
  pg: PgSync,
  provider: string,
  binding: StoredProjectSync,
  event: NormalizedTaskEvent,
  link: StoredTaskItemSync,
): Promise<void> {
  const hash = contentHash(event);
  if (link.lastSyncedHash !== null && link.lastSyncedHash === hash) return; // echo / no-op.

  const stateId = await resolveTargetStateId(pg, binding, event);
  const updates: Parameters<PgSync["updateTask"]>[1] = {};
  if (event.title !== undefined) updates.title = event.title;
  if (event.description !== undefined) updates.description = event.description ?? undefined;
  if (stateId !== null) updates.stateId = stateId; // leave as-is when unmapped.
  const priority = mapPriority(event.priority);
  if (priority !== undefined) updates.priority = priority;
  if (event.dueAt !== undefined) updates.dueAt = event.dueAt;
  if (event.startAt !== undefined) updates.startDate = event.startAt;
  const assigneeId = await resolveAssigneeId(
    pg,
    binding.workspaceId,
    event.assigneeEmail,
    provider,
    event.assigneeAccountId,
  );
  if (assigneeId !== undefined) updates.assigneeId = assigneeId;
  if (event.labels !== undefined) {
    updates.labelIds = await pg.resolveLabels(binding.tasksProjectId, event.labels);
  }
  await pg.updateTask(link.taskId, updates);

  await pg.upsertTaskItemSync({
    projectSyncId: binding.id,
    taskId: link.taskId,
    provider,
    itemType: link.itemType,
    itemNumber: event.itemNumber,
    providerItemId: event.providerItemId,
    itemUrl: event.itemUrl ?? null,
    lastSyncedHash: hash,
  });
  await recordActivity(pg, binding, link.taskId, event, "updated");
  markChangeEcho(provider, link.taskId, event);
}

// Append a normalized inbound comment as a task Activity row on the linked task.
async function applyComment(
  pg: PgSync,
  binding: StoredProjectSync,
  event: NormalizedTaskEvent,
  link: StoredTaskItemSync,
): Promise<void> {
  const who = event.actor ? `@${escapeHtml(event.actor)}` : "External";
  const body = escapeHtml(event.commentBody ?? "");
  await pg
    .recordTaskActivity({
      taskId: link.taskId,
      workspaceId: binding.workspaceId,
      actorId: null, // system-generated — an external user has no Cyborg id.
      verb: "updated",
      commentHtml: `${who} commented: ${body}`,
    })
    // intentional: best-effort feed row — must never fail the webhook ack.
    .catch(() => {});
}

// Note an upstream deletion on the linked task's Activity feed. Intentionally does NOT
// delete the Cyborg task — a destructive cross-tenant action driven by an untrusted
// payload is unsafe; the note keeps the divergence visible for a human to resolve.
async function applyDeleted(
  pg: PgSync,
  binding: StoredProjectSync,
  event: NormalizedTaskEvent,
  link: StoredTaskItemSync,
): Promise<void> {
  const who = event.actor ? `@${escapeHtml(event.actor)}` : "External";
  await pg
    .recordTaskActivity({
      taskId: link.taskId,
      workspaceId: binding.workspaceId,
      actorId: null,
      verb: "updated",
      commentHtml: `${who} deleted the linked external item #${escapeHtml(event.itemNumber)}`,
    })
    // intentional: best-effort feed row — must never fail the webhook ack.
    .catch(() => {});
}

// Append a task_activity row describing the synced change. Best-effort (a feed-write
// failure must never fail the sync — parity with routes/github.ts).
async function recordActivity(
  pg: PgSync,
  binding: StoredProjectSync,
  taskId: string,
  event: NormalizedTaskEvent,
  verb: "created" | "updated",
): Promise<void> {
  const who = event.actor ? `@${escapeHtml(event.actor)}` : "External";
  const action = verb === "created" ? "created" : "updated";
  await pg
    .recordTaskActivity({
      taskId,
      workspaceId: binding.workspaceId,
      actorId: null,
      verb,
      commentHtml: `${who} ${action} ${escapeHtml(binding.provider)} item #${escapeHtml(event.itemNumber)}`,
    })
    // intentional: best-effort feed row — must never fail the webhook ack.
    .catch(() => {});
}

// Mark the echo guard for the fields this event actually moved, so a wave-2 outbound emit
// to the SAME provider is suppressed while other providers still fan out. Status when the
// event carried a status; fields when it carried any content field.
function markChangeEcho(provider: string, taskId: string, event: NormalizedTaskEvent): void {
  if (event.sourceStatusName !== undefined || event.statusCategory !== undefined) {
    markTaskInbound(provider, taskId, "status");
  }
  const movedField =
    event.title !== undefined ||
    event.description !== undefined ||
    event.priority !== undefined ||
    event.labels !== undefined ||
    event.assigneeEmail !== undefined ||
    event.dueAt !== undefined ||
    event.startAt !== undefined;
  if (movedField) markTaskInbound(provider, taskId, "fields");
}

// Apply one event to one binding (skipping outbound-only bindings). Throws on error; the
// caller wraps per-binding + per-event so one failure never aborts the batch.
async function applyEventToBinding(
  pg: PgSync,
  provider: string,
  binding: StoredProjectSync,
  event: NormalizedTaskEvent,
): Promise<void> {
  if (binding.syncDirection === "outbound") return; // inbound disabled for this binding.

  if (event.itemType === "issue" || event.itemType === "task") {
    const link = await findLinkedItem(pg, binding, event);
    if (link) await refreshLinkedTask(pg, provider, binding, event, link);
    else await createLinkedTask(pg, provider, binding, event);
    return;
  }

  // comment / deleted: reference an existing work item. No link → nothing to attach.
  const link = await findLinkedItem(pg, binding, event);
  if (!link) return;
  if (event.itemType === "comment") await applyComment(pg, binding, event, link);
  else await applyDeleted(pg, binding, event, link);
}

// ─── Public entry points ─────────────────────────────────────────────────────

/**
 * Apply ONE normalized event: resolve every binding for (adapter.provider,
 * externalProjectId) via the plural lookup and fan the event out to each. Per-binding
 * best-effort — one binding failing logs + continues. Unmapped project → no-op.
 *
 * A provider webhook route calls this per parsed event (or dispatchInboundTaskEvents for
 * the whole batch). PURE of provider HTTP — reads only adapter.provider + PgSync.
 */
export async function applyInboundTaskEvent(
  pg: PgSync,
  adapter: TaskIntegrationAdapter,
  event: NormalizedTaskEvent,
): Promise<void> {
  const provider = adapter.provider;
  const bindings = await pg.getProjectSyncsByExternal(provider, event.externalProjectId);
  for (const binding of bindings) {
    try {
      await applyEventToBinding(pg, provider, binding, event);
    } catch (err) {
      // Best-effort: one binding's failure must not abort the fan-out or the batch.
      console.error(
        `[task-sync] ${provider} event (${event.itemType} #${event.itemNumber}) failed for ` +
          `binding ${binding.id}`,
        err,
      );
    }
  }
}

/**
 * Apply a batch of parsed events best-effort: each event is isolated so one bad event
 * logs + continues and the engine never throws to the webhook ack. The entry a provider
 * webhook route calls after adapter.parseInbound.
 */
export async function dispatchInboundTaskEvents(
  pg: PgSync,
  adapter: TaskIntegrationAdapter,
  events: NormalizedTaskEvent[],
): Promise<void> {
  for (const event of events) {
    try {
      await applyInboundTaskEvent(pg, adapter, event);
    } catch (err) {
      console.error(`[task-sync] ${adapter.provider} event failed`, err);
    }
  }
}

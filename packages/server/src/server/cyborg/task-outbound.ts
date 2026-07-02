// OUTBOUND write-back for the GENERIC task integrations (Jira / ClickUp / …): when a
// SYNCED Cyborg task changes, mirror the change onto every linked external work item —
// but ONLY for bindings whose project_syncs.sync_direction is "bidirectional" or
// "outbound" ("inbound" bindings never write back). The provider-agnostic parallel of
// github-outbound.ts (which handles the GitHub-issue link); the inbound direction is
// task-sync-engine.ts (external → task).
//
// It fans ONE task change out to all bound providers, best-effort:
//   1. resolve every task_item_syncs link for the task → its project_syncs binding;
//   2. group by provider + consume the shared echo guard (task-sync-engine's
//      markTaskInbound/consumeTaskInbound, keyed `${provider}:${taskId}:${action}`) so a
//      change that JUST arrived FROM a provider is never bounced straight back to it;
//   3. skip a durable no-op via the content-hash backstop on task_item_syncs.last_synced_hash;
//   4. decrypt the binding's install token and call the provider adapter's writeItem /
//      writeStatus.
// A single binding failing logs (`[task-outbound] …`) + continues; this NEVER throws to
// the caller (it is fired with `void … .catch()` from the relay, after the human's edit is
// already committed). The adapters + token decryptor are injected (`deps`) so the emit is
// unit-testable without a network — mirroring github-outbound's `writer` seam.

import type { PgSync, StoredProjectSync, StoredTaskItemSync } from "./db/pg-sync.js";
import type {
  TaskIntegrationAdapter,
  TaskItemWritePatch,
  TaskPriority,
  TaskStatusWriteArgs,
  TaskWorkItemType,
} from "./integrations/task-integration-adapter.js";
import { jiraAdapter } from "./integrations/jira-adapter.js";
import { clickUpAdapter } from "./integrations/clickup-adapter.js";
import { contentHash, consumeTaskInbound } from "./task-sync-engine.js";
import { decryptToken } from "./task-sync-crypto.js";

// ─── The change shape (before/after snapshot the emit mirrors) ────────────────

/**
 * A before/after snapshot of the task fields the outbound emit mirrors. `*StateId` +
 * `*Status` describe the workflow-state move (stateId is the precise task_states id the
 * reverse status map keys on; status is the group mirror used as the fallback bucket). The
 * remaining prev/next pairs are the content fields written via `writeItem`.
 */
export interface TaskProviderOutboundChange {
  taskId: string;
  prevTitle: string | null;
  nextTitle: string | null;
  prevDescription: string | null;
  nextDescription: string | null;
  prevPriority: string | null;
  nextPriority: string | null;
  prevDueAt: number | null;
  nextDueAt: number | null;
  prevStartAt: number | null;
  nextStartAt: number | null;
  prevStateId: string | null;
  nextStateId: string | null;
  prevStatus: string | null;
  nextStatus: string | null;
}

// ─── Injectable deps (test seam) ──────────────────────────────────────────────

/** The provider I/O + token decryptor, injected so the emit is unit-testable offline. */
export interface TaskOutboundDeps {
  /** Provider key ("jira" | "clickup" | …) → its stateless adapter singleton. */
  adapters: Record<string, TaskIntegrationAdapter>;
  /** Decrypt a stored (possibly-encrypted) install token before handing it to an adapter. */
  decrypt: (enc: string) => string;
}

// Production deps: the real adapter singletons + the AES-GCM token decryptor.
const defaultDeps: TaskOutboundDeps = {
  adapters: { jira: jiraAdapter, clickup: clickUpAdapter },
  decrypt: decryptToken,
};

// ─── Pure planning ────────────────────────────────────────────────────────────

/** The content-field patch a change implies (only fields that actually moved). */
interface PlannedFields {
  title: string | null | undefined;
  description: string | null | undefined;
  priority: TaskPriority | undefined;
  dueAt: number | null | undefined;
  startAt: number | null | undefined;
}

// Map the free-text tasks.priority column back onto the normalized vocabulary the write
// patch speaks: null → "none" (clear the provider field); a known token passes through;
// anything else → undefined (leave the provider field untouched rather than guess).
function toTaskPriority(value: string | null): TaskPriority | undefined {
  if (value === null) return "none";
  if (value === "urgent" || value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return undefined;
}

// Which content fields moved. Mirrors github-outbound's planOutbound: title/description
// compare with null-coalescing (a description edit to/from empty counts), priority/dates
// compare null-safe. `undefined` = "not part of this change, leave untouched".
function planFields(change: TaskProviderOutboundChange): PlannedFields {
  const title = change.nextTitle !== change.prevTitle ? change.nextTitle : undefined;
  const description =
    (change.nextDescription ?? "") !== (change.prevDescription ?? "")
      ? change.nextDescription
      : undefined;
  const priority =
    change.nextPriority !== change.prevPriority ? toTaskPriority(change.nextPriority) : undefined;
  const dueAt =
    (change.nextDueAt ?? null) !== (change.prevDueAt ?? null) ? change.nextDueAt : undefined;
  const startAt =
    (change.nextStartAt ?? null) !== (change.prevStartAt ?? null) ? change.nextStartAt : undefined;
  return { title, description, priority, dueAt, startAt };
}

// Did the workflow state move? Either the precise state id changed, or (for a task whose
// state id was never materialized) the group mirror changed.
function statusMoved(change: TaskProviderOutboundChange): boolean {
  return (
    (change.prevStateId ?? null) !== (change.nextStateId ?? null) ||
    (change.prevStatus ?? null) !== (change.nextStatus ?? null)
  );
}

// True when a planned-fields set has at least one field to write.
function hasFields(fields: PlannedFields): boolean {
  return (
    fields.title !== undefined ||
    fields.description !== undefined ||
    fields.priority !== undefined ||
    fields.dueAt !== undefined ||
    fields.startAt !== undefined
  );
}

// ─── Reverse status map (task state → provider source status) ─────────────────

/** The provider status a Cyborg state reverse-maps to, or null when none resolves. */
interface ResolvedProviderStatus {
  sourceStatusName: string;
  sourceStatusId: string | null;
}

/**
 * REVERSE-map the task's CURRENT workflow state to a provider source status via the
 * binding's status_mappings:
 *   1. the mapping row whose `taskStateId` === the task's current state id → its
 *      `sourceStatusName` (the precise, human-chosen mapping);
 *   2. else a deterministic group fallback — among the binding's mappings, the one whose
 *      target state shares the task's current status GROUP, chosen by sorted source name so
 *      the pick is stable.
 * Returns null when nothing resolves; the caller then SKIPS the status write (never guesses
 * a status that could corrupt the provider's board).
 */
async function resolveProviderStatus(
  pg: PgSync,
  binding: StoredProjectSync,
  nextStateId: string | null,
  nextGroup: string | null,
): Promise<ResolvedProviderStatus | null> {
  const mappings = await pg.listStatusMappings(binding.id);

  if (nextStateId) {
    const exact = mappings.find((m) => m.taskStateId === nextStateId);
    if (exact) {
      return { sourceStatusName: exact.sourceStatusName, sourceStatusId: exact.sourceStatusId };
    }
  }

  if (nextGroup) {
    const states = await pg.getProjectStates(binding.tasksProjectId);
    const groupByStateId = new Map(states.map((s) => [s.id, s.group]));
    const inGroup = mappings
      .filter((m) => m.taskStateId !== null && groupByStateId.get(m.taskStateId) === nextGroup)
      .sort((a, b) => a.sourceStatusName.localeCompare(b.sourceStatusName));
    const pick = inGroup[0];
    if (pick) {
      return { sourceStatusName: pick.sourceStatusName, sourceStatusId: pick.sourceStatusId };
    }
  }

  return null;
}

// ─── Content hash (durable no-op backstop) ────────────────────────────────────

// Hash the OUTBOUND snapshot with task-sync-engine.contentHash (one shared hash function),
// so a repeated emit of identical content is a durable no-op that survives a relay restart.
// Only the fields this emit can actually write are populated; the rest default to null in
// contentHash. The resolved provider status (when any) folds in as sourceStatusName.
function outboundHash(
  change: TaskProviderOutboundChange,
  item: StoredTaskItemSync,
  status: ResolvedProviderStatus | null,
  externalProjectId: string,
): string {
  const itemType: TaskWorkItemType = item.itemType === "issue" ? "issue" : "task";
  return contentHash({
    itemType,
    externalProjectId,
    itemNumber: item.itemNumber,
    providerItemId: item.providerItemId,
    title: change.nextTitle ?? undefined,
    description: change.nextDescription,
    sourceStatusName: status?.sourceStatusName ?? undefined,
    priority: toTaskPriority(change.nextPriority),
    dueAt: change.nextDueAt,
    startAt: change.nextStartAt,
  });
}

// ─── Per-binding write ────────────────────────────────────────────────────────

// The write-eligible actions for a provider group after the echo guard has vetted them.
interface VettedActions {
  fields: boolean;
  status: boolean;
}

// Build the writeItem patch for one link from the vetted field set.
function buildWritePatch(
  item: StoredTaskItemSync,
  externalProjectId: string,
  fields: PlannedFields,
): TaskItemWritePatch {
  const itemType: TaskWorkItemType = item.itemType === "issue" ? "issue" : "task";
  const patch: TaskItemWritePatch = {
    externalProjectId,
    itemType,
    itemNumber: item.itemNumber,
    providerItemId: item.providerItemId,
  };
  // A null title would clear the provider's summary (unsupported / destructive), so a
  // title write only carries a concrete value.
  if (fields.title !== undefined && fields.title !== null) patch.title = fields.title;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.priority !== undefined) patch.priority = fields.priority;
  if (fields.dueAt !== undefined) patch.dueAt = fields.dueAt;
  if (fields.startAt !== undefined) patch.startAt = fields.startAt;
  return patch;
}

// Apply the vetted actions to ONE link. Resolves the token, computes + checks the durable
// hash backstop, writes fields then status, and records the new hash. Throws on failure so
// the caller isolates it per binding.
async function writeToLink(
  pg: PgSync,
  deps: TaskOutboundDeps,
  change: TaskProviderOutboundChange,
  binding: StoredProjectSync,
  item: StoredTaskItemSync,
  actions: VettedActions,
  fields: PlannedFields,
): Promise<void> {
  const adapter = deps.adapters[binding.provider];
  if (!adapter) {
    console.error(
      `[task-outbound] no adapter for provider "${binding.provider}" ` +
        `(task ${change.taskId}, item ${item.id}) — skipping`,
    );
    return;
  }

  if (binding.installationId === null) {
    console.error(
      `[task-outbound] binding ${binding.id} has no installation (task ${change.taskId}) — skipping`,
    );
    return;
  }
  const install = await pg.getIntegrationInstallationById(binding.installationId);
  if (!install || install.accessToken === null) {
    console.error(
      `[task-outbound] no install token for binding ${binding.id} (task ${change.taskId}) — skipping`,
    );
    return;
  }
  const token = deps.decrypt(install.accessToken);

  // Resolve the target provider status FIRST (also needed to fold into the hash), so a
  // status move with no resolvable mapping is dropped before the no-op check.
  const status = actions.status
    ? await resolveProviderStatus(pg, binding, change.nextStateId, change.nextStatus)
    : null;
  if (actions.status && status === null) {
    console.warn(
      `[task-outbound] no status mapping resolves task ${change.taskId} state ` +
        `(${change.nextStateId ?? change.nextStatus ?? "none"}) → ${binding.provider}; skipping status`,
    );
  }

  // Durable backstop: skip the whole link when the outbound snapshot equals what we last
  // synced for it (a no-op / our own echo), survives a restart unlike the in-memory guard.
  const hash = outboundHash(change, item, status, binding.externalProjectId);
  if (item.lastSyncedHash !== null && item.lastSyncedHash === hash) return;

  const willWriteFields = actions.fields && hasFields(fields);
  if (willWriteFields) {
    await adapter.writeItem(token, buildWritePatch(item, binding.externalProjectId, fields));
  }
  if (status !== null) {
    const args: TaskStatusWriteArgs = {
      externalProjectId: binding.externalProjectId,
      itemType: item.itemType === "issue" ? "issue" : "task",
      itemNumber: item.itemNumber,
      providerItemId: item.providerItemId,
      sourceStatusName: status.sourceStatusName,
      sourceStatusId: status.sourceStatusId,
    };
    await adapter.writeStatus(token, args);
  }

  // Record the new synced hash only when something was actually written, so a pure
  // status-skip (unresolved mapping) with no field write doesn't stamp a hash that would
  // suppress a later legitimate retry.
  if (willWriteFields || status !== null) {
    await pg.setTaskItemLastSyncedHash(item.id, hash);
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Mirror a task change to every linked external work item, for bidirectional/outbound
 * bindings only. Best-effort + echo-guarded: each (fields|status) action is suppressed when
 * the SAME change just arrived from that provider (loop-breaker), and a durable content-hash
 * backstop drops a no-op. One binding failing logs + continues; this NEVER throws to the
 * caller. `deps` is injected for tests; production uses the real adapters + token decryptor.
 */
export async function emitTaskOutboundToProviders(
  pg: PgSync,
  change: TaskProviderOutboundChange,
  deps: TaskOutboundDeps = defaultDeps,
): Promise<void> {
  const fields = planFields(change);
  const fieldsChanged = hasFields(fields);
  const statusChanged = statusMoved(change);
  if (!fieldsChanged && !statusChanged) return; // nothing to mirror.

  const items = await pg.getTaskItemsForTask(change.taskId);
  if (items.length === 0) return; // no external link → no-op.

  // Resolve each link's binding, keeping only writable (bidirectional/outbound) ones, and
  // group by provider so the echo guard is consumed ONCE per (provider, action).
  const byProvider = new Map<
    string,
    Array<{ binding: StoredProjectSync; item: StoredTaskItemSync }>
  >();
  for (const item of items) {
    const binding = await pg.getProjectSyncById(item.projectSyncId);
    if (!binding) continue;
    if (binding.syncDirection === "inbound") continue; // inbound-only never writes back.
    const list = byProvider.get(binding.provider);
    if (list) list.push({ binding, item });
    else byProvider.set(binding.provider, [{ binding, item }]);
  }

  for (const [provider, links] of byProvider) {
    // Consume the echo guard ONCE per provider+action. A "fields"/"status" change that just
    // arrived from THIS provider's webhook is dropped so it can never bounce back out; a
    // DIFFERENT provider's marker is never matched, so cross-provider fan-out is preserved.
    const actions: VettedActions = {
      fields: fieldsChanged && !consumeTaskInbound(provider, change.taskId, "fields"),
      status: statusChanged && !consumeTaskInbound(provider, change.taskId, "status"),
    };
    if (!actions.fields && !actions.status) continue; // fully echo-suppressed for this provider.

    for (const { binding, item } of links) {
      try {
        await writeToLink(pg, deps, change, binding, item, actions, fields);
      } catch (err) {
        // Best-effort: a single link's write failing must not abort the rest or throw to the
        // task mutation. Logged (not silent) so a misconfigured binding is visible.
        console.error(
          `[task-outbound] failed to write back task ${change.taskId} → ${provider} ` +
            `item ${item.itemNumber} (binding ${binding.id})`,
          err,
        );
      }
    }
  }
}

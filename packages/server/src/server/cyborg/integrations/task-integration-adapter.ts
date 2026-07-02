// Provider-generic seam for TASK integrations (Jira / ClickUp / …), the task-side
// parallel of the message-side IntegrationAdapter in ./types.ts. Phase 0 LOCKS this
// contract: the sync ENGINE (../task-sync-engine.ts) and every provider webhook route
// consume it, and the Jira / ClickUp coders implement it. The adapter is STATELESS —
// tokens and signing secrets are passed in by the caller (route / engine), never read
// from env inside the adapter — so ONE adapter instance serves every workspace's
// installation. Provider HTTP lives ONLY in the adapter; the engine never talks to a
// provider directly.

// The kinds of external item the foundation tracks. 'issue' (Jira) and 'task'
// (ClickUp) are work items that map 1:1 to a Cyborg task; 'comment' is a comment ON a
// work item (appended to the task's Activity feed); 'deleted' announces a work item was
// removed upstream. The discriminator on NormalizedTaskEvent.
export type TaskItemType = "issue" | "task" | "comment" | "deleted";

// The two work-item kinds a task actually links to (excludes comment/deleted). Used by
// the import + write shapes, which only ever concern real work items.
export type TaskWorkItemType = "issue" | "task";

// The normalized priority vocabulary. Providers map their own scale onto these five;
// the engine mirrors them onto tasks.priority ("none" clears the column). Kept minimal
// to the locked scope — no numeric scales, no custom priority fields.
export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

// The normalized status CATEGORY vocabulary — deliberately the five canonical Cyborg
// task-state groups, so the engine's affinity fallback (no explicit status_mappings
// row) is a direct group match against a project's seeded states. The adapter maps a
// provider's native status category (Jira statusCategory, ClickUp status type) onto one
// of these.
export type StatusCategory = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

// One selectable source status for the mapping UI + auto-seed. `id` is the provider's
// stable status id; `name` is the human label the mapping row keys on
// (status_mappings.source_status_name); `category` drives the affinity fallback.
export interface SourceStatus {
  id: string;
  name: string;
  category: StatusCategory;
}

// The normalized, provider-agnostic shape of ONE inbound task event, produced by
// parseInbound from a provider's raw webhook payload. A FLAT interface discriminated by
// `itemType` (mirroring ParsedInboundMessage.kind) rather than a union, so provider
// authors populate one shape with only the fields an event carries. The engine reads
// the provider from the ADAPTER (adapter.provider), never from the event — the event
// stays provider-agnostic.
//
// Field meaning by itemType:
//   - "issue" | "task": a create/update of a work item. `itemNumber` + `providerItemId`
//     identify the item itself; the field bag (title … startAt) carries its state.
//   - "comment": a comment on a work item. `itemNumber` is the PARENT work item's number
//     (so the engine can find the linked task); `providerItemId` is the comment's id;
//     `commentBody` is the text. The field bag is ignored.
//   - "deleted": a work item was removed upstream. `itemNumber` + `providerItemId`
//     identify the removed item.
export interface NormalizedTaskEvent {
  // The event discriminator.
  itemType: TaskItemType;
  // The external project the event belongs to — the ONLY payload key the engine trusts,
  // and only to look up the binding row(s). Everything tenant-scoped (workspace, tasks
  // project, creator) is read from the resolved binding, never from the event.
  externalProjectId: string;
  // The external human key of the item (issue/task events) or its PARENT (comment
  // events). TEXT to match the provider's key space (e.g. "ENG-42", "86xy1"). Combined
  // with the binding + itemType it de-dups the linked task.
  itemNumber: string;
  // The provider's stable item id (issue/task/deleted) or comment id (comment events).
  providerItemId: string;
  // A deep link to the item, stored on the task_item_syncs back-link when present.
  itemUrl?: string | null;
  // Who caused the event (display name / login / email), for Activity attribution. Never
  // resolved to a Cyborg identity — display only, and HTML-escaped by the engine.
  actor?: string | null;

  // ── field bag (issue/task events; all optional so an "edited" event carries only the
  //    fields that moved, and an absent field is left UNTOUCHED on refresh) ──
  title?: string;
  description?: string | null;
  // The source status id/name. `sourceStatusName` is the status_mappings lookup key;
  // `statusCategory` is the affinity fallback when no explicit mapping row exists.
  sourceStatusId?: string | null;
  sourceStatusName?: string | null;
  statusCategory?: StatusCategory;
  // The assignee's email — the engine resolves it to a Cyborg user and applies it ONLY
  // when that user is a member of the binding's workspace (tenant guard).
  assigneeEmail?: string | null;
  // The assignee's external account id (e.g. Jira Atlassian accountId), persisted into
  // provider_user_connections so the Personal Data Reporting API has a subject to report +
  // erase. Display/erasure only — never a Cyborg identity.
  assigneeAccountId?: string | null;
  // Free-text label names, get-or-created in the task's project.
  labels?: string[];
  priority?: TaskPriority;
  // Planned start / due, epoch ms (or null to clear).
  dueAt?: number | null;
  startAt?: number | null;

  // ── comment events ──
  commentBody?: string | null;
}

// The normalized shape of ONE imported work item (the batch-import counterpart of an
// issue/task NormalizedTaskEvent). Always a concrete work item — never a comment/delete.
export interface NormalizedTaskItem {
  itemType: TaskWorkItemType;
  itemNumber: string;
  providerItemId: string;
  itemUrl?: string | null;
  title: string;
  description?: string | null;
  sourceStatusId?: string | null;
  sourceStatusName?: string | null;
  statusCategory?: StatusCategory;
  assigneeEmail?: string | null;
  // The assignee's external account id (e.g. Jira Atlassian accountId), persisted into
  // provider_user_connections so the Personal Data Reporting API has a subject to report +
  // erase. Display/erasure only — never a Cyborg identity.
  assigneeAccountId?: string | null;
  labels?: string[];
  priority?: TaskPriority;
  dueAt?: number | null;
  startAt?: number | null;
}

// The result of one importItems page: the batch plus an opaque cursor to resume from
// (absent when the last page has been returned).
export interface ImportItemsPage {
  items: NormalizedTaskItem[];
  nextCursor?: string;
}

// ── wave-2 OUTBOUND write shapes (declared now so the contract is stable; a provider
//    may throw "not implemented" for these in Phase 0) ──

// The fields to write back onto an external work item (Cyborg → provider). Identifies
// the target item + the subset of fields to patch (an absent field is left untouched).
export interface TaskItemWritePatch {
  externalProjectId: string;
  itemType: TaskWorkItemType;
  itemNumber: string;
  providerItemId: string;
  title?: string;
  description?: string | null;
  assigneeEmail?: string | null;
  labels?: string[];
  priority?: TaskPriority;
  dueAt?: number | null;
  startAt?: number | null;
}

// Move an external work item into a target source status (Cyborg state change → provider
// status transition). `sourceStatusName` is the target status; `sourceStatusId` is
// supplied when the provider transitions by id.
export interface TaskStatusWriteArgs {
  externalProjectId: string;
  itemType: TaskWorkItemType;
  itemNumber: string;
  providerItemId: string;
  sourceStatusId?: string | null;
  sourceStatusName: string;
}

// The seam every task-integration provider implements. STATELESS — the token/secret are
// arguments, never fields; parse/verify are pure. One instance serves all workspaces.
export interface TaskIntegrationAdapter {
  // The provider key stored in project_syncs.provider / task_item_syncs.provider /
  // status_mappings.provider (e.g. "jira", "clickup"). The engine's discriminator.
  readonly provider: string;

  // Verify a webhook request is authentic (HMAC over the EXACT raw body). Pure +
  // synchronous; MUST NOT throw — bad/missing input returns false. The secret is passed
  // in, never read from env here.
  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
    secret: string,
  ): boolean;

  // Parse an ALREADY-VERIFIED raw payload into zero or more normalized events. Pure;
  // MUST NOT throw — an unrecognized/irrelevant payload returns []. The engine iterates
  // the result best-effort.
  parseInbound(payload: unknown): NormalizedTaskEvent[];

  // The external project's selectable statuses (mapping UI + auto-seed). Throws on a
  // provider error so the caller can surface it.
  listStatuses(token: string, externalProjectId: string): Promise<SourceStatus[]>;

  // One page of the external project's work items (batch import / initial backfill).
  // `cursor` resumes a prior page. Throws on a provider error.
  importItems(token: string, externalProjectId: string, cursor?: string): Promise<ImportItemsPage>;

  // WAVE 2 — write a task change back to the external work item. A Phase-0 provider MAY
  // throw an Error("writeItem not implemented") until outbound lands.
  writeItem(token: string, patch: TaskItemWritePatch): Promise<void>;

  // WAVE 2 — move the external work item into a target status. A Phase-0 provider MAY
  // throw an Error("writeStatus not implemented") until outbound lands.
  writeStatus(token: string, args: TaskStatusWriteArgs): Promise<void>;
}

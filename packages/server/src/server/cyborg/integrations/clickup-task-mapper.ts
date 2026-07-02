// ClickUp (API v2) task + webhook payload → normalized task types (one-way: ClickUp →
// Cyborg7). This is the PURE, testable CORE of the ClickUp→Tasks sync — NO network, no
// relay/DB dependency — so it can be unit-tested against canned ClickUp payloads. The
// adapter (clickup-adapter.ts) calls these; the receiver route persists the result.
//
// It implements the committed provider-generic contract in ./task-integration-adapter.ts
// (NormalizedTaskEvent / NormalizedTaskItem / StatusCategory / TaskPriority) — those
// types are imported, never redefined.
//
// Locked field mapping (ClickUp → normalized):
//   name                       → title
//   description / text_content → description (markdown, passthrough; description wins)
//   status.status              → sourceStatusName        (the mapping lookup key)
//   status.id                  → sourceStatusId
//   status.type + name         → statusCategory (see mapClickUpStatusType)
//   priority (1/2/3/4 | null)  → priority (normal→medium, null→none)
//   assignees[0].email         → assigneeEmail (primary = first assignee)
//   tags[].name                → labels (de-duped, empty-stripped)
//   due_date (ms epoch string) → dueAt
//   start_date (ms epoch str)  → startAt   (ClickUp HAS a start date, unlike Jira)
//   id                         → itemNumber AND providerItemId
//   url                        → itemUrl
//   list.id                    → externalProjectId (the ClickUp List id — the binding key)
//
// Webhook events (mapClickUpWebhookToEvents) cover taskCreated / taskUpdated /
// taskStatusUpdated (itemType "task"), taskCommentPosted (itemType "comment", parent
// task id as itemNumber) and taskDeleted (itemType "deleted"). A native ClickUp webhook
// carries only `history_items` describing the CHANGE (not the whole task), so an
// update/status event surfaces the fields the payload actually contains — the contract's
// "an edited event carries only the fields that moved" shape. When a webhook embeds a
// full `task` object (an enriched form the receiver may pass after a re-fetch) the full
// field bag is mapped via the same extractor as the batch import.

import type {
  NormalizedTaskEvent,
  NormalizedTaskItem,
  StatusCategory,
  TaskPriority,
} from "./task-integration-adapter.js";

// ── permissive extraction helpers (same shape as github-issue-mapper.ts's privates) ──

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// Parse a ClickUp epoch value (due_date / start_date) into epoch-ms. ClickUp encodes
// these as a STRING of milliseconds (e.g. "1508369194377") but tolerate a raw number
// too. Returns null for absent / empty / non-finite values (ClickUp uses null when
// unset). No `null` sentinel like "0" is special-cased — a real 0 stays 0.
function epochMs(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Map a ClickUp status (native `type` + human `name`) to a normalized StatusCategory.
// The NAME check wins first: a status literally named "cancelled" / "won't do" is
// cancelled regardless of its ClickUp type. Otherwise the ClickUp status `type` decides:
//   open   → unstarted
//   custom → started
//   done   → completed
//   closed → completed   [decision: a ClickUp "closed" state is a done/completed state]
// An unknown/empty type defaults to unstarted (ClickUp only emits the four above).
export function mapClickUpStatusType(type: string, name: string): StatusCategory {
  const n = name.trim().toLowerCase();
  if (n === "cancelled" || n === "canceled" || n === "won't do" || n === "wont do") {
    return "cancelled";
  }
  switch (type.trim().toLowerCase()) {
    case "open":
      return "unstarted";
    case "custom":
      return "started";
    case "done":
      return "completed";
    case "closed":
      return "completed";
    default:
      return "unstarted";
  }
}

// Map a ClickUp priority to a normalized TaskPriority. ClickUp's scale is 1=Urgent,
// 2=High, 3=Normal, 4=Low, null=none; on a task the priority is an OBJECT
// ({ id:"1", priority:"urgent", … }) while a webhook history item may carry the raw
// number/string. Accept all forms — prefer the numeric id, fall back to the name.
// Normal (3 / "normal") maps to "medium"; anything unrecognized → "none".
export function mapClickUpPriority(raw: unknown): TaskPriority {
  if (raw === null || raw === undefined) return "none";

  let id: string | null = null;
  let name: string | null = null;
  if (typeof raw === "number") {
    id = String(raw);
  } else if (typeof raw === "string") {
    // A bare "1".."4" is an id; a word ("urgent") is a name.
    if (/^\d+$/.test(raw.trim())) id = raw.trim();
    else name = raw.trim().toLowerCase();
  } else {
    const record = obj(raw);
    if (record) {
      id = asString(record.id).trim() || null;
      name = asString(record.priority).trim().toLowerCase() || null;
    }
  }

  switch (id) {
    case "1":
      return "urgent";
    case "2":
      return "high";
    case "3":
      return "medium";
    case "4":
      return "low";
    default:
      break;
  }
  switch (name) {
    case "urgent":
      return "urgent";
    case "high":
      return "high";
    case "normal":
      return "medium";
    case "low":
      return "low";
    default:
      return "none";
  }
}

// The common field bag shared by an issue/task NormalizedTaskEvent and an imported
// NormalizedTaskItem. `statusCategory` is undefined only when the payload carries no
// status object at all.
interface ClickUpTaskFields {
  itemNumber: string;
  providerItemId: string;
  itemUrl: string | null;
  title: string;
  description: string | null;
  sourceStatusId: string | null;
  sourceStatusName: string | null;
  statusCategory: StatusCategory | undefined;
  assigneeEmail: string | null;
  labels: string[];
  priority: TaskPriority;
  dueAt: number | null;
  startAt: number | null;
}

// Extract the normalized field bag from a ClickUp task object. PURE. Absent fields yield
// null / [] / "none" so the caller can spread it directly onto an event or item.
function extractTaskFields(task: Record<string, unknown>): ClickUpTaskFields {
  const id = asString(task.id).trim();

  // Description prefers the markdown `description`, falling back to the plain
  // `text_content`, else null when both are empty. Passthrough (no re-formatting).
  const descriptionRaw = asString(task.description);
  const textContentRaw = asString(task.text_content);
  let description: string | null = null;
  if (descriptionRaw.trim()) description = descriptionRaw;
  else if (textContentRaw.trim()) description = textContentRaw;

  const status = obj(task.status);
  const sourceStatusName = status ? asString(status.status).trim() || null : null;
  const sourceStatusId = status ? asString(status.id).trim() || null : null;
  const statusCategory = status
    ? mapClickUpStatusType(asString(status.type), asString(status.status))
    : undefined;

  // Primary assignee = the first assignee that carries an email.
  let assigneeEmail: string | null = null;
  for (const a of arr(task.assignees)) {
    const email = asString(obj(a)?.email).trim();
    if (email) {
      assigneeEmail = email;
      break;
    }
  }

  const labels = Array.from(
    new Set(
      arr(task.tags)
        .map((t) => asString(obj(t)?.name).trim())
        .filter(Boolean),
    ),
  );

  return {
    itemNumber: id,
    providerItemId: id,
    itemUrl: asString(task.url).trim() || null,
    title: asString(task.name).trim(),
    description,
    sourceStatusId,
    sourceStatusName,
    statusCategory,
    assigneeEmail,
    labels,
    priority: mapClickUpPriority(task.priority ?? null),
    dueAt: epochMs(task.due_date),
    startAt: epochMs(task.start_date),
  };
}

// The actor (display attribution) a full task implies: its creator's username, then
// email. Webhook events override this with the history item's user.
function creatorActor(task: Record<string, unknown>): string | null {
  const creator = obj(task.creator);
  return asString(creator?.username).trim() || asString(creator?.email).trim() || null;
}

// The ClickUp List id a task belongs to = the normalized externalProjectId.
function listId(task: Record<string, unknown>): string {
  return asString(obj(task.list)?.id).trim();
}

// Build a NormalizedTaskEvent (itemType "task") from a full ClickUp task object. Absent
// optional fields are still populated (null / []) — the caller/engine leaves a field
// UNTOUCHED on refresh only when it is undefined, so a full task always sets its bag.
// PURE.
export function mapClickUpTaskToEvent(raw: unknown): NormalizedTaskEvent {
  const task = obj(raw) ?? {};
  const fields = extractTaskFields(task);
  return {
    itemType: "task",
    externalProjectId: listId(task),
    itemNumber: fields.itemNumber,
    providerItemId: fields.providerItemId,
    itemUrl: fields.itemUrl,
    actor: creatorActor(task),
    title: fields.title,
    description: fields.description,
    sourceStatusId: fields.sourceStatusId,
    sourceStatusName: fields.sourceStatusName,
    statusCategory: fields.statusCategory,
    assigneeEmail: fields.assigneeEmail,
    labels: fields.labels,
    priority: fields.priority,
    dueAt: fields.dueAt,
    startAt: fields.startAt,
  };
}

// Build a NormalizedTaskItem from a full ClickUp task object (the batch-import shape),
// or null when the payload has no id (nothing to link). PURE. Used by
// clickup-adapter.importItems for each task in a page.
export function mapClickUpTaskToItem(raw: unknown): NormalizedTaskItem | null {
  const task = obj(raw);
  if (!task) return null;
  const fields = extractTaskFields(task);
  if (!fields.itemNumber) return null;
  return {
    itemType: "task",
    itemNumber: fields.itemNumber,
    providerItemId: fields.providerItemId,
    itemUrl: fields.itemUrl,
    title: fields.title,
    description: fields.description,
    sourceStatusId: fields.sourceStatusId,
    sourceStatusName: fields.sourceStatusName,
    statusCategory: fields.statusCategory,
    assigneeEmail: fields.assigneeEmail,
    labels: fields.labels,
    priority: fields.priority,
    dueAt: fields.dueAt,
    startAt: fields.startAt,
  };
}

// The status a native webhook implies, read from the LAST `status` history item's
// `after` value ({ status, type, id? }). Returns null when no status change is present.
function statusFromHistory(
  body: Record<string, unknown>,
): { name: string | null; id: string | null; category: StatusCategory } | null {
  const items = arr(body.history_items);
  for (let i = items.length - 1; i >= 0; i--) {
    const hi = obj(items[i]);
    if (!hi || asString(hi.field) !== "status") continue;
    const after = obj(hi.after);
    if (!after) continue;
    const name = asString(after.status).trim();
    return {
      name: name || null,
      id: asString(after.id).trim() || null,
      category: mapClickUpStatusType(asString(after.type), name),
    };
  }
  return null;
}

// The actor a webhook implies: the first history item's user (username, then email).
function actorFromHistory(body: Record<string, unknown>): string | null {
  for (const it of arr(body.history_items)) {
    const user = obj(obj(it)?.user);
    const who = asString(user?.username).trim() || asString(user?.email).trim();
    if (who) return who;
  }
  return null;
}

// The comment a taskCommentPosted webhook implies: its id + text. ClickUp carries the
// comment under a `comment` history item; tolerate the text living on the comment object
// (comment_text / text_content) or the history item itself.
function commentFromHistory(body: Record<string, unknown>): { id: string; body: string | null } {
  for (const it of arr(body.history_items)) {
    const hi = obj(it);
    if (!hi) continue;
    const comment = obj(hi.comment);
    if (asString(hi.field) !== "comment" && !comment) continue;
    const id = asString(comment?.id).trim() || asString(hi.id).trim();
    const text =
      asString(comment?.comment_text).trim() ||
      asString(comment?.text_content).trim() ||
      asString(hi.comment_text).trim();
    return { id, body: text || null };
  }
  return { id: "", body: null };
}

// Map a ClickUp webhook body into zero or more NormalizedTaskEvents. PURE; never throws
// (an unrecognized/irrelevant body → []). The receiver has ALREADY verified the HMAC.
//
// externalProjectId (the List id) is read from an embedded task's `list.id`, else a
// top-level `list_id` the route may attach — a native ClickUp webhook may not echo the
// list id in its body, in which case the receiver resolves the binding from the webhook
// registration and this stays "".
export function mapClickUpWebhookToEvents(body: unknown): NormalizedTaskEvent[] {
  const b = obj(body);
  if (!b) return [];

  const event = asString(b.event).trim();
  if (!event) return [];

  const task = obj(b.task);
  const taskId = asString(b.task_id).trim() || (task ? asString(task.id).trim() : "");
  const externalProjectId = (task ? listId(task) : "") || asString(b.list_id).trim();
  const actor = actorFromHistory(b) ?? (task ? creatorActor(task) : null);

  switch (event) {
    case "taskDeleted": {
      return [
        {
          itemType: "deleted",
          externalProjectId,
          itemNumber: taskId,
          providerItemId: taskId,
          itemUrl: task ? asString(task.url).trim() || null : null,
          actor,
        },
      ];
    }

    case "taskCommentPosted": {
      const comment = commentFromHistory(b);
      return [
        {
          itemType: "comment",
          externalProjectId,
          // For a comment, itemNumber is the PARENT task's id so the engine finds the
          // linked task; providerItemId is the comment's own id.
          itemNumber: taskId,
          providerItemId: comment.id || taskId,
          actor,
          commentBody: comment.body,
        },
      ];
    }

    case "taskCreated":
    case "taskUpdated":
    case "taskStatusUpdated": {
      // Embedded full task → the complete field bag; native (history-only) webhook → the
      // fields the payload actually moved (currently: the status change).
      if (task) {
        const full = mapClickUpTaskToEvent(task);
        return [{ ...full, externalProjectId, itemNumber: taskId || full.itemNumber, actor }];
      }
      const status = statusFromHistory(b);
      const base: NormalizedTaskEvent = {
        itemType: "task",
        externalProjectId,
        itemNumber: taskId,
        providerItemId: taskId,
        actor,
      };
      if (status) {
        base.sourceStatusName = status.name;
        base.sourceStatusId = status.id;
        base.statusCategory = status.category;
      }
      return [base];
    }

    default:
      return [];
  }
}

import type Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { loadBetterSqlite3 } from "./native-module-path.js";
import type { StoredCybo } from "./cybo-types.js";
import type { Unfurl } from "./unfurl.js";
import type { MessageCard } from "./webhook-card.js";

// Fixed namespace for deriving a DETERMINISTIC user id from an email. Every
// SQLite store (and PG, via the same helper) maps a given email to the SAME id,
// so a daemon's local cache no longer mints a per-file random id that diverges
// from the cloud/PG account id. This is the root-cause fix for workspace
// visibility (the auth path used to bind the user to a store-local random id and
// then read THAT ghost id's empty workspace list). Random namespace, frozen —
// never change it or every existing email re-derives to a new id.
const CYBORG_USER_ID_NAMESPACE = "b3f9a1d2-7c4e-5a86-9e21-0f5c2d8a4b6e";

// RFC 4122 §4.3 name-based (v5, SHA-1) UUID, implemented on node:crypto so we
// pull in no `uuid` dependency. Same namespace + name always yields the same
// UUID — exactly the determinism the email→id mapping needs to agree across
// every SQLite file and PG.
export function uuidv5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  if (nsBytes.length !== 16) throw new Error("uuidv5: namespace must be a valid UUID");
  const hash = createHash("sha1").update(nsBytes).update(Buffer.from(name, "utf8")).digest();
  const bytes = hash.subarray(0, 16);
  // Set version (5) and the RFC 4122 variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// The canonical, store-independent user id for an email. Lowercased + trimmed so
// trivial casing differences map to one identity. Exported so PG-side code and
// any reconcile path derive the SAME id.
export function canonicalUserId(email: string): string {
  return uuidv5(email.trim().toLowerCase(), CYBORG_USER_ID_NAMESPACE);
}

// Tasks Redesign P0 — map a workflow state's canonical group to the legacy
// free-text `tasks.status` value, which the watcher/dispatch and older clients
// still read. The status column stays a back-compat mirror of state.group. This
// REPLICATES pg-sync's private mapStateGroupToStatus verbatim so both deployment
// modes agree; it lives here (not imported from pg-sync) because pg-sync already
// imports from storage.ts — importing back would form a cycle and pull
// better-sqlite3 into the Postgres-only relay's startup graph.
function mapStateGroupToStatus(group: string): string {
  switch (group) {
    case "backlog":
    case "unstarted":
      return "pending";
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}

export interface StoredMessage {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  from_id: string;
  from_type: "human" | "agent" | "system";
  from_name: string | null;
  to_id: string | null;
  text: string;
  mentions: string | null;
  parent_id: string | null;
  attachments?: string | null;
  reactions?: { userId: string; userName?: string; emoji: string; createdAt: number }[] | null;
  // URL link previews (Tier 2). Populated async after insert; null when absent.
  unfurls?: Unfurl[] | null;
  // Structured rich card (e.g. a GitHub release card from a webhook). Set at
  // insert time; null/absent for normal messages. PG-only.
  card?: MessageCard | null;
  pinned_at?: number | null;
  pinned_by?: string | null;
  // Message origin ("mcp" for MCP-tool posts); NULL/absent for organic
  // messages. PG-only — the daemon's SQLite never sets it.
  source?: string | null;
  seq: number;
  created_at: number;
  updated_at?: number | null;
  deleted_at?: number | null;
  // Transient thread metadata (not columns) — populated for top-level rows
  // returned by handleFetchMessages so the client can show a reply indicator.
  reply_count?: number;
  last_reply_at?: number | null;
}

export interface StoredChannel {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  is_private: number;
  instructions: string | null;
  // Per-channel slash-command model override (JSON {"provider","model"}); optional
  // so older SQLite rows/payloads that omit it deserialize as null.
  slash_command_model?: string | null;
  created_by: string;
  created_at: number;
  // Soft-delete / archive flag (P2 #3). Optional + 0/1 like is_private so
  // SQLite rows and older payloads that omit it deserialize as not-archived.
  is_archived?: number;
  // Channel kind (#608): 'regular' | 'group_dm'. Optional so older SQLite rows /
  // payloads that omit it deserialize as a regular channel.
  type?: string;
  // Hidden from the channel browser (#608). Optional + 0/1 like is_private so
  // older rows/payloads deserialize as not-hidden.
  is_hidden?: number;
  // Tasks Phase 2 (watcher) — per-channel auto-tasks switch. NULL/0 = OFF
  // (opt-in). Optional so older rows/payloads deserialize as OFF. Stored as
  // SQLite INTEGER (0/1) and as PG boolean.
  auto_tasks_enabled?: number | null;
}

export interface StoredWorkspace {
  id: string;
  name: string;
  owner_id: string;
  avatar_url?: string | null;
  settings: string | null;
  created_at: number;
}

export interface StoredMembership {
  workspace_id: string;
  user_id: string;
  role: string;
  membership_type: string;
  joined_at: number;
}

export interface StoredUser {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
}

export interface StoredTask {
  id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  status: string;
  assignee_id: string | null;
  created_by: string;
  due_at: number | null;
  recurrence: string | null;
  result: string | null;
  // Tasks Phase 2/3. channel_id: where execute-dispatch posts results;
  // priority: optional board priority (free text). Optional so older rows
  // deserialize as null.
  channel_id?: string | null;
  priority?: string | null;
  // Tasks Phase 3 — atomic dispatch claim + recurrence guards. last_dispatched_at:
  // ms epoch of the last dispatch claim (NULL/stale = claimable). recurrence_*:
  // double-spawn guard + cap. Optional so older rows deserialize as null/0.
  last_dispatched_at?: number | null;
  recurrence_spawned_at?: number | null;
  recurrence_count?: number;
  // Tasks Phase 0 (Plane plane UI) — manual lane ordering (drag-reorder),
  // planned start (Gantt left edge), soft-archive timestamp, draft flag. Optional
  // so older rows deserialize as null/0/false.
  sort_order?: number | null;
  start_date?: number | null;
  archived_at?: number | null;
  is_draft?: number; // 0 | 1 (SQLite has no boolean)
  // Tasks Redesign P0 (Plane-style) — Tasks-project membership (project_id), the
  // sub-task parent self-link (parent_id), the workflow state (state_id), the
  // per-project human sequence number (sequence_id, the N in "ENG-N"), and the
  // single cycle/sprint bucket (cycle_id). All nullable for back-compat; 0031
  // backfills project_id/state_id/sequence_id on PG, and provisionTasksProject /
  // the create path assign them on the SQLite side. The legacy free-text `status`
  // stays as the watcher/back-compat mirror of the state's group.
  project_id?: string | null;
  parent_id?: string | null;
  state_id?: string | null;
  sequence_id?: number | null;
  cycle_id?: string | null;
  // Denormalized many-to-many arrays surfaced on the task projection: the label
  // ids assigned via task_label_assignees and the module ids via task_modules.
  // Optional + default-empty so SQLite reads and older rows deserialize cleanly.
  label_ids?: string[];
  module_ids?: string[];
  created_at: number;
  updated_at: number;
}

// ─── Tasks Redesign P0 — projects, states, satellites (SQLite mirrors) ────────

// A Tasks-project (Plane-style): a 1:1 partner of a chat `projects` row, or a
// synthetic per-workspace "Inbox" (chat_project_id null) that holds orphan tasks.
// `identifier` is the task-key prefix (uppercase, <=8, unique per workspace) and
// `sequence_counter` is the high-water mark handed out as the next task's
// per-project sequence_id. Mirrors PG `tasks_projects`.
export interface StoredTasksProject {
  id: string;
  workspace_id: string;
  chat_project_id: string | null;
  identifier: string;
  sequence_counter: number;
  cycles_enabled: number; // 0 | 1
  modules_enabled: number; // 0 | 1
  pages_enabled: number; // 0 | 1
  color: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

// Raw SQLite rows for the cycles / modules catalogs (snake_case columns, dates
// already epoch ms). Used by the catalog CRUD write-backs to map to the client
// camelCase shapes.
interface RawCycleRow {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  start_date: number | null;
  end_date: number | null;
  owned_by: string | null;
  sort_order: number | null;
  archived_at: number | null;
  created_at: number;
}

interface RawPageRow {
  id: string;
  project_id: string;
  workspace_id: string;
  title: string;
  content: string;
  visibility: string;
  icon: string | null;
  parent_id: string | null;
  sort_order: number;
  owned_by: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

// Client `Page` shape (camelCase, dates → epoch ms). Shared by storage,
// DualStorage, and PgSync so the page CRUD returns one canonical type.
export interface PageShape {
  id: string;
  projectId: string;
  workspaceId: string;
  title: string;
  content: string;
  visibility: string;
  icon: string | null;
  // Self-referential parent for nesting; null = a root page.
  parentId: string | null;
  // Sibling ordering within a parent (lower first).
  sortOrder: number;
  ownedBy: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RawModuleRow {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  start_date: number | null;
  target_date: number | null;
  status: string;
  lead: string | null;
  sort_order: number | null;
  archived_at: number | null;
}

// SQLite raw row for a task link (external URL). Mirrors PG `task_links`.
interface RawTaskLinkRow {
  id: string;
  task_id: string;
  url: string;
  title: string | null;
  created_by: string;
  created_at: number;
}

// SQLite raw row for a task attachment (S3 asset). Mirrors PG `task_attachments`.
interface RawTaskAttachmentRow {
  id: string;
  task_id: string;
  asset_key: string;
  name: string;
  size: number;
  content_type: string | null;
  uploaded_by: string;
  created_at: number;
}

// A workflow state (board column) of a Tasks-project. `group` buckets it into one
// of Plane's five canonical phases so logic (and the legacy tasks.status mirror)
// can reason about progress. Mirrors PG `task_states`.
export interface StoredTaskState {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
  color: string;
  group: string; // backlog | unstarted | started | completed | cancelled
  sequence: number;
  is_default: number; // 0 | 1
}

// ─── Tasks Phase 0 — opaque cursor + reorder math (shared SQLite/PG) ──────────

// Task ordering/pagination helpers moved to ./task-ordering.ts (a dependency-free
// module) so the Postgres-only relay can import them via db/pg-sync.ts WITHOUT
// dragging this file's better-sqlite3 import into the relay's startup graph
// (that crash-looped the relay: ERR_MODULE_NOT_FOUND better-sqlite3). Re-exported
// here so existing `from "./storage.js"` importers keep resolving.
export {
  type TaskCursor,
  encodeTaskCursor,
  decodeTaskCursor,
  computeReorderSort,
} from "./task-ordering.js";

import { encodeTaskCursor, decodeTaskCursor, computeReorderSort } from "./task-ordering.js";
import { PageCycleError, isPageDescendant } from "./page-access.js";
import {
  encodeArchivedSessionCursor,
  decodeArchivedSessionCursor,
} from "./archived-session-ordering.js";

export interface StoredSchedule {
  id: string;
  workspace_id: string;
  cybo_id: string;
  channel_id: string | null;
  // Per-task scheduling: the task this schedule fires (run as its assignee cybo,
  // unattended). NULL = a raw-prompt cybo schedule (today's behaviour, unchanged).
  task_id: string | null;
  cron_expr: string;
  timezone: string | null;
  prompt: string;
  enabled: number; // 0 | 1
  last_run_at: number | null;
  next_run_at: number | null;
  // Phase 2 (#619) — one-shots + catch-up. max_runs: NULL = recurring, 1 =
  // one-shot. run_count: durable fire counter for one-shot completion. catch_up:
  // 1 = fire late after an offline window, 0 = skip to the next future slot.
  max_runs: number | null;
  run_count: number;
  catch_up: number; // 0 | 1
  created_by: string;
  created_at: number;
  updated_at: number;
}

// Built-in integrations (recipes): one row per recipe install in a workspace.
// Mirrors the PG `installed_recipes` table. `config` + `schedule_ids` are stored
// as JSON TEXT in SQLite (jsonb in PG) — parsed/serialized at the storage edge.
// enabled is 0|1 (SQLite has no boolean). cybo_id/schedule_ids carry the
// provisioned ids; null/[] until provisioned and again after a disable/teardown.
export interface StoredInstalledRecipe {
  id: string;
  workspace_id: string;
  recipe_id: string;
  enabled: number; // 0 | 1
  config: string; // JSON object
  cybo_id: string | null;
  schedule_ids: string; // JSON string[]
  created_by: string;
  created_at: number;
  updated_at: number;
}

// Closed-set reason a scheduled run was skipped (never fired). Mirrors the PG
// schedule_runs.skip_reason check — failures are shown, never dropped (#619).
export type ScheduleSkipReason = "license_paused" | "overlap" | "unauthorized" | "duplicate";
export type ScheduleRunStatus = "running" | "succeeded" | "failed" | "skipped";

export interface StoredScheduleRun {
  id: string;
  schedule_id: string;
  workspace_id: string;
  scheduled_for: number | null;
  started_at: number;
  ended_at: number | null;
  status: ScheduleRunStatus;
  skip_reason: ScheduleSkipReason | null;
  agent_id: string | null;
  error: string | null;
}

// User "send later" scheduled post (#607) — a single human message (channel OR DM)
// deferred to send_at. Distinct from StoredSchedule (recurring cybo cron). Mirrors
// the PG `scheduled_messages` table; SQLite is authoritative for the solo-daemon
// fire path (the cloud relay fires from PG when connected — see
// ScheduledMessageRunner). Closed-set error_code follows the Mattermost lesson.
export type ScheduledMessageErrorCode =
  | "channel_archived"
  | "no_permission"
  | "user_deleted"
  | "channel_not_found"
  | "unknown_error";

export interface StoredScheduledMessage {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  to_id: string | null;
  from_id: string;
  text: string;
  mentions: string | null; // JSON-encoded string[] | null
  send_at: number;
  processed_at: number | null;
  error_code: ScheduledMessageErrorCode | null;
  created_at: number;
}

// Reusable composer prompt template (#602). WORKSPACE-SCOPED, member-authored
// named message body, inserted from the composer's slash menu and expanded on
// SEND. Distinct from the scheduler's webhooks.prompt_template. created_by is
// nullable (the author may have been removed; the row is workspace-owned).
export interface StoredPromptTemplate {
  id: string;
  workspace_id: string;
  name: string;
  body: string;
  created_by: string | null;
  created_at: number;
}

export interface StoredAgentBinding {
  agent_id: string;
  workspace_id: string;
  channel_id: string | null;
  provider: string;
  model: string | null;
  system_prompt: string | null;
  daemon_id: string | null;
  cybo_id: string | null;
  initiated_by: string | null;
  // The initiator's REAL (canonical cloud) email — the OPENER on the cloud-
  // forwarded spawn path. initiated_by is a daemon-LOCAL id that resolves only to
  // a "<id>@remote.local" placeholder for a cloud opener, so this real email is
  // what agent_status.userEmail carries and the relay resolves to
  // agent_sessions.user_id. NULL for a truly autonomous spawn (no human opener)
  // or a binding created before this column existed.
  initiated_by_email: string | null;
  cwd: string | null;
  // Best-effort provider resume id. Paseo's on-disk JSON is the real resume
  // source; this is captured opportunistically (turn end) and mirrored to PG so
  // the two stores stay in lockstep. NULL until a turn reveals the session id.
  provider_session_id: string | null;
  // 1 = ephemeral summon (one turn, torn down on completion); 0 = persistent.
  ephemeral: number;
  // 1 = AUTONOMOUS spawn (cron / scheduled / webhook — no human invoker); 0 =
  // human-initiated. An autonomous channel-bound session is OWNER-SCOPED in the
  // session list (visible only to whoever scheduled it), unlike a human-spawned
  // interactive channel agent which stays shared. See agentBindingVisibleCore.
  autonomous: number;
  created_at: number;
}

// Captured injected context for an EPHEMERAL cybo session (sessions-readonly
// -viewer / #994). Survives teardown so the read-only viewer can show what
// context + tools a one-turn summon received. `mcp_servers_json` is the
// serialized list of servers MADE AVAILABLE at spawn ([{name,type,url?,toolkit?}])
// — NOT the provider's runtime-resolved tool enumeration.
export interface StoredEphemeralSessionContext {
  agent_id: string;
  workspace_id: string;
  channel_id: string | null;
  cybo_id: string | null;
  system_prompt: string | null;
  mcp_servers_json: string | null;
  routed_prompt: string | null;
  raw_prompt: string | null;
  created_at: number;
}

export interface StoredArchivedSession {
  id: string;
  workspace_id: string;
  provider: string;
  provider_handle_id: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  cybo_id: string | null;
  archived_at: number;
  // Set when this archived session was resumed into a live agent. While non-null
  // (and that agent's binding still exists) the row is hidden from history — the
  // session is reachable via the active list instead. Cleared when the agent is
  // re-archived. This prevents the resume → delete → permanent-loss data bug.
  resumed_agent_id: string | null;
  // Owner captured at archive/import time (the live binding's initiator). LOCAL
  // SQLite id; bridge to the caller via initiated_by_email across the local/cloud
  // id namespaces. NULL on rows archived before this column existed — those fall
  // through to the workspace owner/admin gate only (fail-closed for plain members).
  initiated_by: string | null;
  initiated_by_email: string | null;
}

export interface StoredProject {
  id: string;
  workspace_id: string;
  name: string;
  color: string;
  created_at: number;
}

export interface StoredChannelProject {
  channel_id: string;
  project_id: string;
}

export interface StoredActivityEvent {
  id: string;
  workspace_id: string;
  user_id: string;
  event_type: string;
  source_type: string;
  source_id: string;
  channel_id: string | null;
  // DM peer (the OTHER user) for dm-originated activity; null for channel events.
  dm_peer_id?: string | null;
  preview_text: string | null;
  actor_id: string | null;
  actor_name: string | null;
  is_read: number;
  created_at: number;
}

export class CyborgStorage {
  private readonly db: Database.Database;

  getDatabase(): Database.Database {
    return this.db;
  }
  private readonly seqStmt: Statement;
  private readonly upsertUserStmt: Statement;
  private readonly getUserByEmailStmt: Statement;
  private readonly insertWorkspaceStmt: Statement;
  private readonly getWorkspaceStmt: Statement;
  private readonly getWorkspacesForUserStmt: Statement;
  private readonly insertMembershipStmt: Statement;
  private readonly getMembershipStmt: Statement;
  private readonly getMembersStmt: Statement;
  private readonly insertChannelStmt: Statement;
  private readonly getChannelsStmt: Statement;
  private readonly getChannelStmt: Statement;
  private readonly insertMessageStmt: Statement;
  private readonly insertTaskStmt: Statement;
  private readonly getTaskStmt: Statement;
  private readonly insertAuditStmt: Statement;
  private readonly deleteMembershipStmt: Statement;
  private readonly updateMembershipStmt: Statement;
  private readonly insertAgentBindingStmt: Statement;
  private readonly getAgentBindingStmt: Statement;
  private readonly getAgentsByWorkspaceStmt: Statement;
  private readonly deleteAgentBindingStmt: Statement;
  private readonly updateAgentBindingModelStmt: Statement;
  private readonly updateAgentBindingSessionStmt: Statement;
  private readonly getCyboBindingsByWorkspaceStmt: Statement;
  private readonly insertEphemeralSessionContextStmt: Statement;
  private readonly updateEphemeralSessionContextPromptsStmt: Statement;
  private readonly getEphemeralSessionContextStmt: Statement;
  private readonly pruneEphemeralSessionContextStmt: Statement;
  private readonly deleteEphemeralSessionContextStmt: Statement;
  private readonly insertCyboStmt: Statement;
  private readonly getCyboStmt: Statement;
  private readonly getCyboBySlugStmt: Statement;
  private readonly getCybosByWorkspaceStmt: Statement;
  private readonly updateCyboStmt: Statement;
  private readonly deleteCyboStmt: Statement;
  private insertArchivedSessionStmt!: Statement;
  private getArchivedSessionsByWorkspaceStmt!: Statement;
  private getArchivedSessionByIdStmt!: Statement;
  private getArchivedSessionByIdInWorkspaceStmt!: Statement;
  private getArchivedSessionByResumedAgentStmt!: Statement;
  private markArchivedSessionResumedStmt!: Statement;
  private reviveArchivedSessionStmt!: Statement;
  private deleteArchivedSessionStmt!: Statement;
  private insertProjectStmt!: Statement;
  private getProjectsByWorkspaceStmt!: Statement;
  private updateProjectStmt!: Statement;
  private deleteProjectStmt!: Statement;
  private setChannelProjectStmt!: Statement;
  private clearChannelProjectStmt!: Statement;
  private getChannelProjectsStmt!: Statement;
  private clearProjectChannelsStmt!: Statement;
  // Tasks Redesign P0 (Plane-style) — Tasks-project + workflow-state mirrors.
  private insertTasksProjectStmt!: Statement;
  private getTasksProjectStmt!: Statement;
  private getTasksProjectByChatStmt!: Statement;
  private getTasksProjectInboxStmt!: Statement;
  private getTasksProjectsByWorkspaceStmt!: Statement;
  private bumpSequenceCounterStmt!: Statement;
  private insertTaskStateStmt!: Statement;
  private getTaskStatesByProjectStmt!: Statement;
  private getTaskStateGroupStmt!: Statement;
  // Tasks Redesign P0 — label catalog + many-to-many join writers (SQLite mirrors
  // of the PG task_label_assignees / task_modules tables).
  private getTaskLabelsTailSortStmt!: Statement;
  private insertTaskLabelStmt!: Statement;
  private getTaskLabelByLowerNameStmt!: Statement;
  private deleteTaskLabelAssigneesStmt!: Statement;
  private insertTaskLabelAssigneeStmt!: Statement;
  private deleteTaskModulesStmt!: Statement;
  private insertTaskModuleStmt!: Statement;
  // Tasks Redesign catalog reads (board/detail): full-column label list (the
  // get-or-create reader above selects only id/name), cycles, modules, and the
  // per-task activity feed.
  private getTaskLabelsFullByProjectStmt!: Statement;
  private getCyclesByProjectStmt!: Statement;
  private getModulesByProjectStmt!: Statement;
  private getTaskActivityByTaskStmt!: Statement;
  // Tasks Redesign catalog CRUD (cycles / modules) — single-row read-back after
  // a write so create/update can return the row in the client shape.
  private insertCycleStmt!: Statement;
  private getCycleStmt!: Statement;
  private deleteCycleStmt!: Statement;
  // Project pages catalog CRUD — single-row read-back after a write.
  private getPagesByProjectStmt!: Statement;
  private insertPageStmt!: Statement;
  private getPageStmt!: Statement;
  private deletePageStmt!: Statement;
  private insertModuleStmt!: Statement;
  private getModuleStmt!: Statement;
  private deleteModuleStmt!: Statement;
  // Tasks Redesign — task links + attachments (detail-card "Links"/"Attachments").
  private insertTaskLinkStmt!: Statement;
  private getTaskLinkStmt!: Statement;
  private getTaskLinksByTaskStmt!: Statement;
  private deleteTaskLinkStmt!: Statement;
  private insertTaskAttachmentStmt!: Statement;
  private getTaskAttachmentStmt!: Statement;
  private getTaskAttachmentsByTaskStmt!: Statement;
  private deleteTaskAttachmentStmt!: Statement;

  constructor(dbPath: string) {
    const BetterSqlite3 = loadBetterSqlite3();
    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
    this.initDeferredStatements();

    this.seqStmt = this.db.prepare(
      "SELECT COALESCE(MAX(seq), 0) as max_seq FROM messages WHERE workspace_id = ?",
    );
    this.upsertUserStmt = this.db.prepare(
      `INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = COALESCE(excluded.name, users.name)
       RETURNING *`,
    );
    this.getUserByEmailStmt = this.db.prepare("SELECT * FROM users WHERE email = ?");
    this.insertWorkspaceStmt = this.db.prepare(
      "INSERT INTO workspaces (id, name, owner_id, settings, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.getWorkspaceStmt = this.db.prepare("SELECT * FROM workspaces WHERE id = ?");
    this.getWorkspacesForUserStmt = this.db.prepare(
      `SELECT w.*, m.role FROM workspaces w
       INNER JOIN memberships m ON m.workspace_id = w.id
       WHERE m.user_id = ?`,
    );
    this.insertMembershipStmt = this.db.prepare(
      "INSERT OR IGNORE INTO memberships (workspace_id, user_id, role, membership_type, joined_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.getMembershipStmt = this.db.prepare(
      "SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?",
    );
    this.getMembersStmt = this.db.prepare(
      `SELECT m.*, u.email, u.name FROM memberships m
       INNER JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = ?`,
    );
    this.deleteMembershipStmt = this.db.prepare(
      "DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?",
    );
    this.updateMembershipStmt = this.db.prepare(
      "UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?",
    );
    this.insertChannelStmt = this.db.prepare(
      `INSERT INTO channels (id, workspace_id, name, description, is_private, instructions, type, is_hidden, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getChannelsStmt = this.db.prepare("SELECT * FROM channels WHERE workspace_id = ?");
    this.getChannelStmt = this.db.prepare("SELECT * FROM channels WHERE id = ?");
    // OR IGNORE: message id is the primary key and the only unique constraint.
    // Local sends generate a fresh UUID (never collides), but relay re-sync
    // (DaemonRelayClient.ingestMessage) can replay a message the daemon already
    // has — a plain INSERT threw an uncaught UNIQUE violation that crashed the
    // whole daemon. Ignoring the duplicate makes the sync idempotent.
    this.insertMessageStmt = this.db.prepare(
      `INSERT OR IGNORE INTO messages (id, workspace_id, channel_id, from_id, from_type, from_name, to_id, text, mentions, parent_id, attachments, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertTaskStmt = this.db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, description, status, assignee_id, created_by, due_at, recurrence, result, channel_id, priority, sort_order, start_date, is_draft, project_id, parent_id, state_id, sequence_id, cycle_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getTaskStmt = this.db.prepare("SELECT * FROM tasks WHERE id = ?");
    this.insertAuditStmt = this.db.prepare(
      `INSERT INTO audit_log (id, workspace_id, actor_id, actor_type, action, target_type, target_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.insertAgentBindingStmt = this.db.prepare(
      `INSERT INTO agent_bindings (agent_id, workspace_id, channel_id, provider, model, system_prompt, daemon_id, cybo_id, initiated_by, initiated_by_email, cwd, ephemeral, autonomous, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getAgentBindingStmt = this.db.prepare("SELECT * FROM agent_bindings WHERE agent_id = ?");
    this.getAgentsByWorkspaceStmt = this.db.prepare(
      "SELECT * FROM agent_bindings WHERE workspace_id = ?",
    );
    this.deleteAgentBindingStmt = this.db.prepare("DELETE FROM agent_bindings WHERE agent_id = ?");
    this.updateAgentBindingModelStmt = this.db.prepare(
      "UPDATE agent_bindings SET model = ? WHERE agent_id = ?",
    );
    this.updateAgentBindingSessionStmt = this.db.prepare(
      "UPDATE agent_bindings SET provider_session_id = ? WHERE agent_id = ?",
    );
    this.getCyboBindingsByWorkspaceStmt = this.db.prepare(
      "SELECT * FROM agent_bindings WHERE workspace_id = ? AND cybo_id IS NOT NULL",
    );

    // Ephemeral session context capture (#994). REPLACE on agent_id so a spawn
    // write is idempotent; prompt fields are filled in by a later UPDATE.
    this.insertEphemeralSessionContextStmt = this.db.prepare(
      `INSERT INTO ephemeral_session_context
         (agent_id, workspace_id, channel_id, cybo_id, system_prompt, mcp_servers_json, routed_prompt, raw_prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         channel_id = excluded.channel_id,
         cybo_id = excluded.cybo_id,
         system_prompt = excluded.system_prompt,
         mcp_servers_json = excluded.mcp_servers_json`,
    );
    this.updateEphemeralSessionContextPromptsStmt = this.db.prepare(
      "UPDATE ephemeral_session_context SET routed_prompt = ?, raw_prompt = ? WHERE agent_id = ?",
    );
    this.getEphemeralSessionContextStmt = this.db.prepare(
      "SELECT * FROM ephemeral_session_context WHERE agent_id = ?",
    );
    this.pruneEphemeralSessionContextStmt = this.db.prepare(
      "DELETE FROM ephemeral_session_context WHERE created_at < ?",
    );
    this.deleteEphemeralSessionContextStmt = this.db.prepare(
      "DELETE FROM ephemeral_session_context WHERE agent_id = ?",
    );

    this.insertCyboStmt = this.db.prepare(
      `INSERT INTO cybos (id, workspace_id, slug, name, description, avatar, role, soul, provider, model, mcp_servers, tool_grants, llm_auth_mode, behavior_mode, home_daemon_id, autonomy_level, monthly_spend_cap, platform_permissions, is_default, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getCyboStmt = this.db.prepare("SELECT * FROM cybos WHERE id = ?");
    this.getCyboBySlugStmt = this.db.prepare(
      "SELECT * FROM cybos WHERE workspace_id = ? AND slug = ?",
    );
    this.getCybosByWorkspaceStmt = this.db.prepare(
      "SELECT * FROM cybos WHERE workspace_id = ? ORDER BY is_default DESC, name ASC",
    );
    this.updateCyboStmt = this.db.prepare(
      `UPDATE cybos SET name = ?, description = ?, avatar = ?, role = ?, soul = ?,
       provider = ?, model = ?, mcp_servers = ?, tool_grants = ?, llm_auth_mode = ?, behavior_mode = ?,
       home_daemon_id = ?, autonomy_level = ?, monthly_spend_cap = ?, platform_permissions = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.deleteCyboStmt = this.db.prepare("DELETE FROM cybos WHERE id = ?");

    // Deferred: these tables are created in migrate(), so prepare after migrate() runs.
    // We use definite assignment (!) on the field declarations above.
  }

  private initDeferredStatements(): void {
    this.insertArchivedSessionStmt = this.db.prepare(
      `INSERT OR REPLACE INTO archived_sessions (id, workspace_id, provider, provider_handle_id, title, cwd, model, cybo_id, archived_at, initiated_by, initiated_by_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getArchivedSessionsByWorkspaceStmt = this.db.prepare(
      "SELECT * FROM archived_sessions WHERE workspace_id = ? ORDER BY archived_at DESC",
    );
    this.getArchivedSessionByIdStmt = this.db.prepare(
      "SELECT * FROM archived_sessions WHERE id = ?",
    );
    // Workspace-scoped lookup: a session can only be restored/read within its OWN
    // workspace, so callers that authorize by workspace pass it here — a row in a
    // different workspace returns undefined (can't be reached cross-workspace by id).
    this.getArchivedSessionByIdInWorkspaceStmt = this.db.prepare(
      "SELECT * FROM archived_sessions WHERE id = ? AND workspace_id = ?",
    );
    this.getArchivedSessionByResumedAgentStmt = this.db.prepare(
      "SELECT * FROM archived_sessions WHERE resumed_agent_id = ?",
    );
    this.markArchivedSessionResumedStmt = this.db.prepare(
      "UPDATE archived_sessions SET resumed_agent_id = ? WHERE id = ?",
    );
    // Re-archive an already-resumed session: clear the live link and refresh the
    // archived metadata + timestamp so it returns to the TOP of history.
    this.reviveArchivedSessionStmt = this.db.prepare(
      `UPDATE archived_sessions
         SET resumed_agent_id = NULL,
             provider_handle_id = ?,
             title = ?,
             cwd = ?,
             model = ?,
             cybo_id = ?,
             archived_at = ?
       WHERE id = ?`,
    );
    this.deleteArchivedSessionStmt = this.db.prepare("DELETE FROM archived_sessions WHERE id = ?");
    this.insertProjectStmt = this.db.prepare(
      "INSERT INTO projects (id, workspace_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.getProjectsByWorkspaceStmt = this.db.prepare(
      "SELECT * FROM projects WHERE workspace_id = ? ORDER BY created_at ASC",
    );
    this.updateProjectStmt = this.db.prepare(
      "UPDATE projects SET name = ?, color = ? WHERE id = ?",
    );
    this.deleteProjectStmt = this.db.prepare("DELETE FROM projects WHERE id = ?");
    this.setChannelProjectStmt = this.db.prepare(
      "INSERT OR REPLACE INTO channel_projects (channel_id, project_id) VALUES (?, ?)",
    );
    this.clearChannelProjectStmt = this.db.prepare(
      "DELETE FROM channel_projects WHERE channel_id = ?",
    );
    this.getChannelProjectsStmt = this.db.prepare(
      "SELECT * FROM channel_projects WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)",
    );
    this.clearProjectChannelsStmt = this.db.prepare(
      "DELETE FROM channel_projects WHERE project_id = ?",
    );
    // Tasks Redesign P0 (Plane-style) — Tasks-project + workflow-state mirrors.
    this.insertTasksProjectStmt = this.db.prepare(
      `INSERT INTO tasks_projects (id, workspace_id, chat_project_id, identifier, sequence_counter, cycles_enabled, modules_enabled, pages_enabled, color, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getTasksProjectStmt = this.db.prepare("SELECT * FROM tasks_projects WHERE id = ?");
    this.getTasksProjectByChatStmt = this.db.prepare(
      "SELECT * FROM tasks_projects WHERE chat_project_id = ?",
    );
    // The synthetic per-workspace Inbox is the one row with a NULL chat_project_id.
    this.getTasksProjectInboxStmt = this.db.prepare(
      "SELECT * FROM tasks_projects WHERE workspace_id = ? AND chat_project_id IS NULL",
    );
    this.getTasksProjectsByWorkspaceStmt = this.db.prepare(
      "SELECT * FROM tasks_projects WHERE workspace_id = ? ORDER BY created_at ASC",
    );
    // Sequence allocator: SQLite has no advisory lock, so allocate the next
    // per-project sequence number atomically via an UPDATE ... RETURNING (the new
    // counter value). Done inside the create txn so concurrent inserts never hand
    // out a colliding PROJ-### key. (better-sqlite3 supports RETURNING.)
    this.bumpSequenceCounterStmt = this.db.prepare(
      "UPDATE tasks_projects SET sequence_counter = sequence_counter + 1, updated_at = ? WHERE id = ? RETURNING sequence_counter",
    );
    this.insertTaskStateStmt = this.db.prepare(
      `INSERT INTO task_states (id, project_id, workspace_id, name, color, "group", sequence, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getTaskStatesByProjectStmt = this.db.prepare(
      "SELECT * FROM task_states WHERE project_id = ? ORDER BY sequence ASC",
    );
    // P0 — resolve a state's canonical group so create/update can mirror the
    // legacy free-text `status` column (mapStateGroupToStatus), exactly as the PG
    // path does. Missing state → undefined (caller keeps the prior/default status).
    this.getTaskStateGroupStmt = this.db.prepare(
      'SELECT "group" AS "group" FROM task_states WHERE id = ?',
    );
    // Tasks Redesign P0 — label name→id resolution (get-or-create per project) +
    // the task_label_assignees / task_modules replace-set join writers. Mirrors
    // pg-sync.resolveLabels / updateTask's delete-then-insert join semantics so the
    // solo/daemon SQLite path carries labels/modules identically to the cloud.
    this.getTaskLabelsTailSortStmt = this.db.prepare(
      "SELECT MAX(sort_order) AS maxSort FROM task_labels WHERE project_id = ?",
    );
    // Atomic get-or-create keyed by (project_id, lower(name)), race-safe against the
    // ux_task_labels_project_lower_name unique index. ON CONFLICT DO NOTHING never
    // overwrites, so the FIRST writer's casing is preserved; a duplicate returns no
    // row and we fall back to the case-insensitive lookup below.
    this.insertTaskLabelStmt = this.db.prepare(
      "INSERT INTO task_labels (id, project_id, workspace_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, lower(name)) DO NOTHING RETURNING id",
    );
    this.getTaskLabelByLowerNameStmt = this.db.prepare(
      "SELECT id FROM task_labels WHERE project_id = ? AND lower(name) = lower(?) LIMIT 1",
    );
    this.deleteTaskLabelAssigneesStmt = this.db.prepare(
      "DELETE FROM task_label_assignees WHERE task_id = ?",
    );
    // INSERT OR IGNORE: the (task_id, label_id) PK makes a duplicate id list safe,
    // mirroring PG's onConflictDoNothing.
    this.insertTaskLabelAssigneeStmt = this.db.prepare(
      "INSERT OR IGNORE INTO task_label_assignees (task_id, label_id) VALUES (?, ?)",
    );
    this.deleteTaskModulesStmt = this.db.prepare("DELETE FROM task_modules WHERE task_id = ?");
    this.insertTaskModuleStmt = this.db.prepare(
      "INSERT OR IGNORE INTO task_modules (task_id, module_id) VALUES (?, ?)",
    );
    // Tasks Redesign catalog reads — board columns / detail pickers / activity feed.
    this.getTaskLabelsFullByProjectStmt = this.db.prepare(
      "SELECT * FROM task_labels WHERE project_id = ? ORDER BY sort_order ASC",
    );
    this.getCyclesByProjectStmt = this.db.prepare(
      "SELECT * FROM cycles WHERE project_id = ? ORDER BY sort_order ASC",
    );
    this.getModulesByProjectStmt = this.db.prepare(
      "SELECT * FROM modules WHERE project_id = ? ORDER BY sort_order ASC",
    );
    this.getTaskActivityByTaskStmt = this.db.prepare(
      "SELECT * FROM task_activity WHERE task_id = ? ORDER BY epoch ASC",
    );
    // Tasks Redesign catalog CRUD (cycles / modules).
    this.insertCycleStmt = this.db.prepare(
      `INSERT INTO cycles (id, project_id, workspace_id, name, description, start_date, end_date, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getCycleStmt = this.db.prepare("SELECT * FROM cycles WHERE id = ?");
    this.deleteCycleStmt = this.db.prepare("DELETE FROM cycles WHERE id = ?");
    // Project pages catalog CRUD. Non-archived first, then newest-updated first.
    // Owner-filtered: a non-null-owner private page is returned ONLY to its owner
    // (2nd bind param); public + legacy null-owner pages go to every member. The
    // UI filters archived itself.
    this.getPagesByProjectStmt = this.db.prepare(
      "SELECT * FROM tasks_pages WHERE project_id = ? AND (visibility = 'public' OR owned_by IS NULL OR owned_by = ?) ORDER BY (archived_at IS NOT NULL) ASC, updated_at DESC",
    );
    this.insertPageStmt = this.db.prepare(
      `INSERT INTO tasks_pages (id, project_id, workspace_id, title, content, visibility, parent_id, owned_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getPageStmt = this.db.prepare("SELECT * FROM tasks_pages WHERE id = ?");
    this.deletePageStmt = this.db.prepare("DELETE FROM tasks_pages WHERE id = ?");
    this.insertModuleStmt = this.db.prepare(
      `INSERT INTO modules (id, project_id, workspace_id, name, description, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.getModuleStmt = this.db.prepare("SELECT * FROM modules WHERE id = ?");
    this.deleteModuleStmt = this.db.prepare("DELETE FROM modules WHERE id = ?");
    // Tasks Redesign — task links + attachments.
    this.insertTaskLinkStmt = this.db.prepare(
      `INSERT INTO task_links (id, task_id, url, title, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.getTaskLinkStmt = this.db.prepare("SELECT * FROM task_links WHERE id = ?");
    this.getTaskLinksByTaskStmt = this.db.prepare(
      "SELECT * FROM task_links WHERE task_id = ? ORDER BY created_at DESC",
    );
    this.deleteTaskLinkStmt = this.db.prepare("DELETE FROM task_links WHERE id = ?");
    this.insertTaskAttachmentStmt = this.db.prepare(
      `INSERT INTO task_attachments (id, task_id, asset_key, name, size, content_type, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getTaskAttachmentStmt = this.db.prepare("SELECT * FROM task_attachments WHERE id = ?");
    this.getTaskAttachmentsByTaskStmt = this.db.prepare(
      "SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at DESC",
    );
    this.deleteTaskAttachmentStmt = this.db.prepare("DELETE FROM task_attachments WHERE id = ?");
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const cols = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        password_hash TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        avatar_url TEXT,
        settings TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        description TEXT,
        is_private INTEGER DEFAULT 0,
        instructions TEXT,
        slash_command_model TEXT,
        type TEXT NOT NULL DEFAULT 'regular',
        is_hidden INTEGER NOT NULL DEFAULT 0,
        -- Tasks Phase 2 (watcher) — per-channel auto-tasks switch (NULL/0 = OFF).
        -- Additive on existing DBs (see addColumnIfMissing below).
        auto_tasks_enabled INTEGER,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT,
        from_id TEXT NOT NULL,
        from_type TEXT NOT NULL,
        from_name TEXT,
        to_id TEXT,
        text TEXT NOT NULL,
        mentions TEXT,
        parent_id TEXT,
        attachments TEXT,
        pinned_at INTEGER,
        pinned_by TEXT,
        seq INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_seq
        ON messages(channel_id, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_workspace_seq
        ON messages(workspace_id, seq);

      CREATE TABLE IF NOT EXISTS message_reads (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_reads_user_ws
        ON message_reads(user_id, workspace_id);

      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        channel_id TEXT,
        preview_text TEXT,
        actor_id TEXT,
        actor_name TEXT,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_user_ws_created
        ON activity_events(user_id, workspace_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS notification_prefs (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        preference TEXT NOT NULL,
        PRIMARY KEY (user_id, scope_id)
      );
      CREATE INDEX IF NOT EXISTS idx_notification_prefs_user_ws
        ON notification_prefs(user_id, workspace_id);

      -- Server-side draft sync (#610): per-(user, scope) composer draft so an
      -- unfinished message follows the user across devices. scope = the opaque
      -- conversation key (channel:<id> / dm:<peerId> / thread:<rootId>).
      -- updated_at is epoch ms (the reconcile tiebreaker: newest write wins).
      CREATE TABLE IF NOT EXISTS drafts (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        text TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, scope)
      );
      CREATE INDEX IF NOT EXISTS idx_drafts_user_ws
        ON drafts(user_id, workspace_id);

      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL DEFAULT 'member',
        membership_type TEXT NOT NULL DEFAULT 'active',
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'pending',
        assignee_id TEXT,
        created_by TEXT NOT NULL,
        due_at INTEGER,
        recurrence TEXT,
        result TEXT,
        -- Tasks Phase 2/3 — watcher channel binding + priority, dispatch claim,
        -- recurrence guards. Additive on existing DBs (see addColumnIfMissing
        -- guards below); base CREATE carries them for fresh ones.
        channel_id TEXT,
        priority TEXT,
        last_dispatched_at INTEGER,
        recurrence_spawned_at INTEGER,
        recurrence_count INTEGER NOT NULL DEFAULT 0,
        -- Tasks Phase 0 (Plane plane UI) — manual lane ordering, planned start,
        -- soft-archive, draft flag. Additive on existing DBs (see addColumnIfMissing
        -- guards below); base CREATE carries them for fresh ones.
        sort_order INTEGER,
        start_date INTEGER,
        archived_at INTEGER,
        is_draft INTEGER NOT NULL DEFAULT 0,
        -- Tasks Redesign P0 (Plane-style) — Tasks-project membership, sub-task
        -- parent self-link, workflow state, per-project sequence number, cycle
        -- bucket. Nullable for back-compat (see addColumnIfMissing below); base
        -- CREATE carries them for fresh DBs. The legacy status column above
        -- stays as the watcher/back-compat mirror of the state group.
        project_id TEXT,
        parent_id TEXT,
        state_id TEXT,
        sequence_id INTEGER,
        cycle_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        cybo_id TEXT NOT NULL,
        channel_id TEXT,
        -- Per-task scheduling: the task this schedule fires (run as its assignee
        -- cybo, unattended). NULL = a raw-prompt cybo schedule (unchanged).
        task_id TEXT,
        cron_expr TEXT NOT NULL,
        timezone TEXT,
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at INTEGER,
        next_run_at INTEGER,
        -- Phase 2 (#619): one-shots (max_runs/run_count) + catch-up policy.
        max_runs INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        catch_up INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- #207: getDueSchedules() filters enabled + next_run_at on every cron tick
      -- against THIS SQLite table (the authoritative read path), so index the hot
      -- query — the PG idx_schedules_due never covered this read.
      CREATE INDEX IF NOT EXISTS idx_schedules_due
        ON schedules(enabled, next_run_at);

      -- NOTE: idx_schedules_task (on the additive task_id column) is created later,
      -- AFTER addColumnIfMissing("schedules", "task_id", ...) — an inline CREATE
      -- INDEX here threw "no such column: task_id" on upgraded DBs (the schedules
      -- table predates task_id) and crash-looped the daemon migration.

      -- Built-in integrations (recipes). One row per recipe install in a workspace;
      -- mirrors the PG installed_recipes table. config + schedule_ids are JSON TEXT
      -- (jsonb in PG); enabled is 0|1. The partial UNIQUE index enforces "one ACTIVE
      -- install per (workspace, recipe)" — only enabled rows participate, so a
      -- disabled history row may sit alongside a fresh re-enable.
      CREATE TABLE IF NOT EXISTS installed_recipes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        recipe_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config TEXT NOT NULL DEFAULT '{}',
        cybo_id TEXT,
        schedule_ids TEXT DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_installed_recipes_active
        ON installed_recipes(workspace_id, recipe_id) WHERE enabled = 1;
      CREATE INDEX IF NOT EXISTS idx_installed_recipes_ws
        ON installed_recipes(workspace_id);

      -- Phase 2 (#619): per-schedule run history (the trust/visibility layer).
      -- The runner writes a row at fire/finish/skip; the UI reads "last runs".
      -- This SQLite copy is authoritative for solo daemons; PG mirrors it.
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scheduled_for INTEGER,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        skip_reason TEXT,
        agent_id TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule
        ON schedule_runs(schedule_id, started_at);

      -- Cross-daemon exactly-once claim for the RAW-PROMPT cron path (#cron-dup).
      -- The per-task fire path is guarded by claimTaskDispatch; the raw-prompt path
      -- (schedules.task_id NULL) had only the in-PROCESS inFlight Set, so the SAME
      -- due schedule on >1 daemon double-fired. A daemon claims a slot by INSERTing
      -- (schedule_id, scheduled_for); the PK makes it atomic, losers conflict and
      -- skip. In SOLO mode this single daemon always wins the (only) claim, so the
      -- in-process guard already suffices — the table just makes the path uniform.
      CREATE TABLE IF NOT EXISTS schedule_dispatch_claims (
        schedule_id TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        claimed_at INTEGER NOT NULL,
        claimed_by TEXT,
        PRIMARY KEY (schedule_id, scheduled_for)
      );

      -- Cross-daemon exactly-once claim for the @MENTION + channel-WATCHER paths
      -- (#16 mention-dup). Twin of schedule_dispatch_claims (the cron path): the
      -- mention/watch invocation guards were in-PROCESS only (a per-process Set), so
      -- the SAME channel message reaching two daemons — or the same daemon across a
      -- relay reconnect/replay or a worker restart that clears the Set — double-fired
      -- the cybo → duplicate ephemeral sessions. A daemon claims (claim_key) by
      -- INSERTing; the PK makes it atomic, losers conflict and skip. claim_key is the
      -- guard's own key: "<messageId>:<cyboId>" for a mention, "watch:<messageId>"
      -- for a watcher (disjoint namespaces, so both share one table). In SOLO mode
      -- the single daemon always wins; the table just makes the path cross-daemon.
      -- ponytail: unbounded (one row per invoked message, no parent to cascade);
      -- prune rows older than a few days on a periodic tick if it ever grows large.
      CREATE TABLE IF NOT EXISTS invocation_dispatch_claims (
        claim_key TEXT PRIMARY KEY,
        claimed_at INTEGER NOT NULL,
        claimed_by TEXT
      );

      -- User "send later" scheduled posts (#607). A single deferred human message
      -- (channel OR DM). The ScheduledMessageRunner tick fires due+unprocessed rows
      -- via the normal message path and stamps processed_at; a failed send sets a
      -- closed-set error_code (never silently dropped). SQLite is authoritative for
      -- the solo-daemon fire path; PG for cloud.
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT,
        to_id TEXT,
        from_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mentions TEXT,
        send_at INTEGER NOT NULL,
        processed_at INTEGER,
        error_code TEXT,
        created_at INTEGER NOT NULL
      );
      -- Hot due-row scan: unprocessed rows by send_at (partial index).
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
        ON scheduled_messages(send_at) WHERE processed_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_workspace
        ON scheduled_messages(workspace_id, send_at);

      -- Reusable composer prompt templates (#602). A workspace-scoped, named,
      -- member-authored reusable message body the composer's slash menu lists and
      -- inserts; expanded on SEND. One name per workspace (UNIQUE). Distinct from
      -- the scheduler's webhooks.prompt_template.
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_prompt_templates_workspace
        ON prompt_templates(workspace_id, name);

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_workspace
        ON audit_log(workspace_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_bindings (
        agent_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        channel_id TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        system_prompt TEXT,
        daemon_id TEXT,
        provider_session_id TEXT,
        autonomous INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_bindings_workspace
        ON agent_bindings(workspace_id);

      -- Durable capture of an EPHEMERAL cybo session's injected context
      -- (sessions-readonly-viewer / #994). Written at spawn (system prompt +
      -- the MCP servers made available) and updated when the prompt is routed
      -- (raw + framed). Unlike agent_bindings this row is intentionally NOT
      -- deleted on teardown — it's the only post-teardown record of what
      -- context a one-turn @mention/slash summon actually received. Bounded by
      -- a TTL/GC sweep (pruneEphemeralSessionContext) so it can't grow forever.
      CREATE TABLE IF NOT EXISTS ephemeral_session_context (
        agent_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel_id TEXT,
        cybo_id TEXT,
        system_prompt TEXT,
        mcp_servers_json TEXT,
        routed_prompt TEXT,
        raw_prompt TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ephemeral_session_context_created
        ON ephemeral_session_context(created_at);

      CREATE TABLE IF NOT EXISTS cybos (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        avatar TEXT,
        role TEXT,
        soul TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        mcp_servers TEXT,
        tool_grants TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(workspace_id, slug)
      );
    `);

    // Incremental migrations

    // Channel names are no longer unique within a workspace (the same name may
    // exist under different project tags). Older DBs created
    // idx_channels_workspace_name as a UNIQUE index — drop and recreate it as a
    // plain index so duplicate names can insert. Idempotent: only runs while the
    // existing index is still unique.
    const channelIdx = this.db.pragma("index_list(channels)") as Array<{
      name: string;
      unique: number;
    }>;
    if (channelIdx.some((i) => i.name === "idx_channels_workspace_name" && i.unique === 1)) {
      this.db.exec("DROP INDEX idx_channels_workspace_name");
      this.db.exec("CREATE INDEX idx_channels_workspace_name ON channels(workspace_id, name)");
    }

    const userCols = this.db.pragma("table_info(users)") as Array<{ name: string }>;
    if (userCols.length > 0 && !userCols.some((c) => c.name === "password_hash")) {
      this.db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
    }
    const workspaceCols = this.db.pragma("table_info(workspaces)") as Array<{ name: string }>;
    if (workspaceCols.length > 0 && !workspaceCols.some((c) => c.name === "avatar_url")) {
      this.db.exec("ALTER TABLE workspaces ADD COLUMN avatar_url TEXT");
    }
    const cols = this.db.pragma("table_info(agent_bindings)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "daemon_id")) {
      this.db.exec("ALTER TABLE agent_bindings ADD COLUMN daemon_id TEXT");
    }
    if (!cols.some((c) => c.name === "cybo_id")) {
      this.db.exec("ALTER TABLE agent_bindings ADD COLUMN cybo_id TEXT");
    }
    if (!cols.some((c) => c.name === "initiated_by")) {
      this.db.exec("ALTER TABLE agent_bindings ADD COLUMN initiated_by TEXT");
    }
    if (!cols.some((c) => c.name === "cwd")) {
      this.db.exec("ALTER TABLE agent_bindings ADD COLUMN cwd TEXT");
    }
    if (!cols.some((c) => c.name === "ephemeral")) {
      this.db.exec("ALTER TABLE agent_bindings ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.some((c) => c.name === "provider_session_id")) {
      this.db.exec("ALTER TABLE agent_bindings ADD COLUMN provider_session_id TEXT");
    }
    // AUTONOMOUS (cron/scheduled) marker — owner-scopes the session in list_agents.
    // Uses addColumnIfMissing (a method call, no extra branch) to stay within the
    // migrate() complexity budget.
    this.addColumnIfMissing("agent_bindings", "autonomous", "INTEGER NOT NULL DEFAULT 0");
    // The initiator's REAL (canonical cloud) email — the OPENER on the cloud-
    // forwarded spawn path. Without it agent_status.userEmail carries only the
    // daemon-local "<id>@remote.local" placeholder for a cloud opener, so the relay
    // resolves agent_sessions.user_id to NULL and the opener can't see their own
    // interactively-opened cybo session (privacy incident 2026-06-30).
    // addColumnIfMissing (a method call, no branch) keeps migrate() under the
    // complexity budget.
    this.addColumnIfMissing("agent_bindings", "initiated_by_email", "TEXT");
    this.addColumnIfMissing("messages", "from_name", "TEXT");
    this.addColumnIfMissing("messages", "attachments", "TEXT");
    this.addColumnIfMissing("messages", "pinned_at", "INTEGER");
    this.addColumnIfMissing("messages", "pinned_by", "TEXT");
    this.addColumnIfMissing("messages", "updated_at", "INTEGER");
    this.addColumnIfMissing("messages", "deleted_at", "INTEGER");
    this.addColumnIfMissing("channels", "slash_command_model", "TEXT");
    // #608: group-DM support — additive on existing DBs; the base CREATE TABLE
    // above carries them for fresh ones. Default ('regular', 0) keeps every
    // pre-existing channel a normal, visible channel.
    this.addColumnIfMissing("channels", "type", "TEXT NOT NULL DEFAULT 'regular'");
    this.addColumnIfMissing("channels", "is_hidden", "INTEGER NOT NULL DEFAULT 0");
    // Tasks Phase 2 (watcher) — per-channel auto-tasks switch (NULL/0 = OFF).
    this.addColumnIfMissing("channels", "auto_tasks_enabled", "INTEGER");
    // Phase 2 (#619) — schedule lifecycle (one-shots + catch-up). Additive on
    // existing DBs; the base CREATE TABLE above carries them for fresh ones.
    this.addColumnIfMissing("schedules", "max_runs", "INTEGER");
    this.addColumnIfMissing("schedules", "run_count", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("schedules", "catch_up", "INTEGER NOT NULL DEFAULT 1");
    // Per-task scheduling (mirrors PG 0034) — the bound task fire() runs as its
    // assignee cybo, unattended. Additive on existing DBs; base CREATE carries it
    // fresh. Index created AFTER the column is ensured (same crash-loop guard as
    // the task indexes below — an inline CREATE INDEX before the column throws
    // "no such column: task_id" on an existing DB).
    this.addColumnIfMissing("schedules", "task_id", "TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_schedules_task ON schedules(task_id)");
    // Cybo Autonomy S2 — per-cybo autonomy dial (L0..L5). Additive on existing DBs;
    // NULL → callers fall back via behaviorModeToLevel(behavior_mode). Mirrors PG 0041.
    this.addColumnIfMissing("cybos", "autonomy_level", "TEXT");
    // Tasks Phase 2/3 — watcher channel binding + priority, dispatch claim,
    // recurrence guards. Additive on existing DBs; base CREATE carries them fresh.
    this.addColumnIfMissing("tasks", "channel_id", "TEXT");
    this.addColumnIfMissing("tasks", "priority", "TEXT");
    this.addColumnIfMissing("tasks", "last_dispatched_at", "INTEGER");
    this.addColumnIfMissing("tasks", "recurrence_spawned_at", "INTEGER");
    this.addColumnIfMissing("tasks", "recurrence_count", "INTEGER NOT NULL DEFAULT 0");
    // Tasks Phase 0 (Plane plane UI) — manual ordering, planned start, archive, draft.
    this.addColumnIfMissing("tasks", "sort_order", "INTEGER");
    this.addColumnIfMissing("tasks", "start_date", "INTEGER");
    this.addColumnIfMissing("tasks", "archived_at", "INTEGER");
    this.addColumnIfMissing("tasks", "is_draft", "INTEGER NOT NULL DEFAULT 0");
    // Tasks Redesign P0 (Plane-style) — Tasks-project membership, sub-task parent
    // self-link, workflow state, per-project sequence number, cycle bucket.
    // Additive on existing DBs; base CREATE carries them fresh. Mirrors PG 0028
    // (project_id/parent_id/state_id/sequence_id) + 0030 (cycle_id).
    this.addColumnIfMissing("tasks", "project_id", "TEXT");
    this.addColumnIfMissing("tasks", "parent_id", "TEXT");
    this.addColumnIfMissing("tasks", "state_id", "TEXT");
    this.addColumnIfMissing("tasks", "sequence_id", "INTEGER");
    this.addColumnIfMissing("tasks", "cycle_id", "TEXT");
    // Create the sort_order index ONLY AFTER the column is ensured above. On an
    // existing DB the base CREATE TABLE is a no-op, so creating this index inline
    // (before the addColumnIfMissing) threw "no such column: sort_order" and
    // crash-looped the daemon migration on upgrade. Mirrors PG idx_tasks_workspace_sort.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_workspace_sort ON tasks(workspace_id, status, sort_order)",
    );
    // Board column fetch (a project's tasks grouped by state). Created AFTER the
    // project_id/state_id columns are ensured above (same crash-loop guard as the
    // sort index). Mirrors PG idx_tasks_project_state (0028).
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_tasks_project_state ON tasks(project_id, state_id)",
    );
    // Page icon (mirrors PG 0038) — optional emoji glyph. Additive on existing
    // DBs; the base CREATE TABLE above carries it fresh. NULL = no custom icon.
    this.addColumnIfMissing("tasks_pages", "icon", "TEXT");
    // Page nesting (mirrors PG 0042) — self-FK parent + sibling order. Additive
    // on existing DBs; the base CREATE TABLE block carries the columns + the
    // idx_tasks_pages_parent index fresh AND runs every boot, so existing DBs
    // get the index once these columns exist (no raw CREATE INDEX here — it would
    // throw on a fresh DB where tasks_pages isn't created until that later block).
    // SQLite ADD COLUMN can't add NOT NULL without a default, so sort_order
    // carries DEFAULT 0; parent_id stays NULL (root) on existing rows.
    this.addColumnIfMissing("tasks_pages", "parent_id", "TEXT");
    this.addColumnIfMissing("tasks_pages", "sort_order", "INTEGER NOT NULL DEFAULT 0");
    this.addColumnIfMissing("cybos", "home_daemon_id", "TEXT");
    const cyboCols = this.db.pragma("table_info(cybos)") as Array<{ name: string }>;
    if (cyboCols.length > 0 && !cyboCols.some((c) => c.name === "mcp_servers")) {
      this.db.exec("ALTER TABLE cybos ADD COLUMN mcp_servers TEXT");
    }
    // Composio third-party tool grants (knowledge: composio-ownership-and-permissions).
    // A JSON blob (CyboToolGrants) — same shape/treatment as mcp_servers. Additive.
    this.addColumnIfMissing("cybos", "tool_grants", "TEXT");
    if (cyboCols.length > 0 && !cyboCols.some((c) => c.name === "llm_auth_mode")) {
      this.db.exec("ALTER TABLE cybos ADD COLUMN llm_auth_mode TEXT NOT NULL DEFAULT 'cli'");
      this.db.exec("ALTER TABLE cybos ADD COLUMN behavior_mode TEXT NOT NULL DEFAULT 'responsive'");
      this.db.exec("ALTER TABLE cybos ADD COLUMN monthly_spend_cap INTEGER");
      this.db.exec("ALTER TABLE cybos ADD COLUMN platform_permissions TEXT DEFAULT '[]'");
      this.db.exec("ALTER TABLE cybos ADD COLUMN off_platform_permissions TEXT DEFAULT '[]'");
    }
    const memberCols = this.db.pragma("table_info(memberships)") as Array<{ name: string }>;
    if (memberCols.length > 0 && !memberCols.some((c) => c.name === "membership_type")) {
      this.db.exec(
        "ALTER TABLE memberships ADD COLUMN membership_type TEXT NOT NULL DEFAULT 'guest'",
      );
      this.db.exec("UPDATE memberships SET membership_type = 'owner' WHERE role = 'owner'");
    }
    if (memberCols.length > 0) {
      const needsMigration = this.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM memberships WHERE membership_type NOT IN ('active', 'invited')",
        )
        .get() as { cnt: number };
      if (needsMigration.cnt > 0) {
        this.db.exec(
          "UPDATE memberships SET membership_type = 'active' WHERE membership_type NOT IN ('active', 'invited')",
        );
      }
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS archived_sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        provider TEXT NOT NULL,
        provider_handle_id TEXT NOT NULL,
        title TEXT,
        cwd TEXT,
        model TEXT,
        cybo_id TEXT,
        archived_at INTEGER NOT NULL,
        resumed_agent_id TEXT,
        initiated_by TEXT,
        initiated_by_email TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_archived_sessions_workspace
        ON archived_sessions(workspace_id, archived_at);

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_projects_workspace
        ON projects(workspace_id);

      CREATE TABLE IF NOT EXISTS channel_projects (
        channel_id TEXT NOT NULL REFERENCES channels(id),
        project_id TEXT NOT NULL REFERENCES projects(id),
        PRIMARY KEY (channel_id)
      );

      -- ─── Tasks Redesign P0 (Plane-style) — SQLite mirrors of the PG tables in
      -- migrations 0028–0030. SQLite has no boolean (INTEGER 0/1), no
      -- "timestamptz" (epoch-ms INTEGER, like the rest of this file), and no
      -- enum/CHECK on group/verb/status (the writer is trusted). FK onDelete
      -- semantics mirror the PG DDL exactly so solo/daemon mode deletes behave
      -- like cloud (CASCADE = take dependents; SET NULL = un-link).

      -- One Tasks-project per chat project (1:1 via chat_project_id), plus a
      -- synthetic per-workspace "Inbox" (chat_project_id NULL). identifier is the
      -- task-key prefix (unique per workspace); sequence_counter is the high-water
      -- mark handed out as the next task's per-project sequence_id.
      CREATE TABLE IF NOT EXISTS tasks_projects (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        chat_project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        identifier TEXT NOT NULL,
        sequence_counter INTEGER NOT NULL DEFAULT 0,
        cycles_enabled INTEGER NOT NULL DEFAULT 1,
        modules_enabled INTEGER NOT NULL DEFAULT 1,
        pages_enabled INTEGER NOT NULL DEFAULT 1,
        color TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_projects_workspace
        ON tasks_projects(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_projects_workspace_identifier
        ON tasks_projects(workspace_id, identifier);

      -- Per-project workflow states (board columns). group buckets a state into
      -- one of Plane's five canonical phases so logic (and the legacy tasks.status
      -- mirror) can reason about progress.
      CREATE TABLE IF NOT EXISTS task_states (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES tasks_projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        "group" TEXT NOT NULL,
        sequence REAL NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_task_states_project
        ON task_states(project_id);

      -- Per-project labels (free-form tags), many-to-many with tasks via
      -- task_label_assignees. color is a hex pill color; sort_order is fractional.
      CREATE TABLE IF NOT EXISTS task_labels (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES tasks_projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        sort_order REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_labels_project
        ON task_labels(project_id);

      -- Join table: which labels are on which task.
      CREATE TABLE IF NOT EXISTS task_label_assignees (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL REFERENCES task_labels(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, label_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_label_assignees_label
        ON task_label_assignees(label_id);

      -- External links attached to a task.
      CREATE TABLE IF NOT EXISTS task_links (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        title TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_links_task
        ON task_links(task_id);

      -- File attachments on a task (S3 asset_key + metadata).
      CREATE TABLE IF NOT EXISTS task_attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        asset_key TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_type TEXT,
        uploaded_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_attachments_task
        ON task_attachments(task_id);

      -- Per-task activity feed: a row per attribute change (verb=created|updated)
      -- and per comment. field/old_value/new_value describe a change; comment_html
      -- is set for comment rows. epoch is a fractional sort key (ms since epoch).
      CREATE TABLE IF NOT EXISTS task_activity (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        actor_id TEXT,
        verb TEXT NOT NULL,
        field TEXT,
        old_value TEXT,
        new_value TEXT,
        comment_html TEXT,
        epoch REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_activity_task_epoch
        ON task_activity(task_id, epoch);

      -- Cycles (sprints): a time-boxed bucket of a project's tasks. A task is in at
      -- most one cycle (tasks.cycle_id), so this is a plain table, not a join.
      CREATE TABLE IF NOT EXISTS cycles (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES tasks_projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        start_date INTEGER,
        end_date INTEGER,
        owned_by TEXT,
        sort_order REAL,
        archived_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cycles_project
        ON cycles(project_id);

      -- Project pages (wiki/docs): a rich-text document scoped to a project, with
      -- public/private visibility + archive. content is the serialized editor doc
      -- (TipTap JSON) stored as text; empty string = a blank page.
      CREATE TABLE IF NOT EXISTS tasks_pages (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES tasks_projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'private',
        icon TEXT,
        parent_id TEXT REFERENCES tasks_pages(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        owned_by TEXT,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_pages_project
        ON tasks_pages(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_pages_parent
        ON tasks_pages(parent_id);

      -- Modules (feature groupings): a many-to-many bucket of a project's tasks
      -- (task_modules join), with its own lifecycle status.
      CREATE TABLE IF NOT EXISTS modules (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES tasks_projects(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT,
        start_date INTEGER,
        target_date INTEGER,
        status TEXT NOT NULL DEFAULT 'planned',
        lead TEXT,
        sort_order REAL,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_modules_project
        ON modules(project_id);

      -- Join table: which tasks belong to which modules (many-to-many).
      CREATE TABLE IF NOT EXISTS task_modules (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, module_id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_modules_module
        ON task_modules(module_id);

      -- GitHub App → Tasks one-way issue sync (GH issues → tasks). SQLite mirror of
      -- the PG github_installations / github_repo_syncs / github_issue_syncs tables.
      -- One row per authorized GitHub App installation.
      CREATE TABLE IF NOT EXISTS github_installations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'User',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_github_installations_workspace
        ON github_installations(workspace_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_installation
        ON github_installations(installation_id);

      -- One (repository ↔ Tasks-project) binding. ON DELETE CASCADE on
      -- tasks_project_id; installation_id is plain text (resolve-or-skip a stale one).
      CREATE TABLE IF NOT EXISTS github_repo_syncs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL,
        tasks_project_id TEXT NOT NULL REFERENCES tasks_projects(id) ON DELETE CASCADE,
        repo_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_github_repo_syncs_workspace
        ON github_repo_syncs(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_github_repo_syncs_installation
        ON github_repo_syncs(installation_id);
      CREATE INDEX IF NOT EXISTS idx_github_repo_syncs_project
        ON github_repo_syncs(tasks_project_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_github_repo_syncs_project_repo
        ON github_repo_syncs(tasks_project_id, repo_id);

      -- One synced GitHub issue ↔ task back-link. Hot path: (repo_sync_id, issue_number).
      CREATE TABLE IF NOT EXISTS github_issue_syncs (
        id TEXT PRIMARY KEY,
        repo_sync_id TEXT NOT NULL REFERENCES github_repo_syncs(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        issue_number INTEGER NOT NULL,
        github_issue_id TEXT NOT NULL,
        issue_url TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_syncs_reposync_task
        ON github_issue_syncs(repo_sync_id, task_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_github_issue_syncs_reposync_number
        ON github_issue_syncs(repo_sync_id, issue_number);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        channel_id TEXT REFERENCES channels(id),
        user_id TEXT REFERENCES users(id),
        provider_session_id TEXT,
        title TEXT,
        session_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        cwd TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent
        ON agent_sessions(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace
        ON agent_sessions(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_channel_date
        ON agent_sessions(channel_id, created_at);

      CREATE TABLE IF NOT EXISTS agent_channel_assignments (
        agent_id TEXT NOT NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id),
        assigned_by TEXT NOT NULL REFERENCES users(id),
        assigned_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_channel_channel
        ON agent_channel_assignments(channel_id);

      -- Channel names are NOT unique within a workspace: the same name (e.g.
      -- "general") may exist under different project tags. Channels are always
      -- addressed by id, never by name, so duplicates are safe. Kept as a plain
      -- index for lookup performance. (Existing DBs with the old UNIQUE index are
      -- migrated above.)
      CREATE INDEX IF NOT EXISTS idx_channels_workspace_name
        ON channels(workspace_id, name);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status
        ON tasks(workspace_id, status);
      CREATE INDEX IF NOT EXISTS idx_cybos_workspace
        ON cybos(workspace_id);
    `);

    // Resuming an archived session no longer hard-deletes its history row (that
    // caused permanent loss when the resumed live session died). Instead the row
    // is kept and linked to the live agent via resumed_agent_id; the listing
    // suppresses it only while that binding still exists. See handleRestoreSession.
    this.addColumnIfMissing("archived_sessions", "resumed_agent_id", "TEXT");
    // Owner of the archived session, captured at archive/import time from the live
    // binding's initiator (email-bridged across the local/cloud id namespaces).
    // Needed to gate restore/import/list to the owner OR a workspace owner/admin —
    // without it the row has no recorded owner and any spawn-scoped member could
    // restore it and read the full transcript (IDOR back-door). See
    // handleRestoreSession / canOwnArchivedSession.
    this.addColumnIfMissing("archived_sessions", "initiated_by", "TEXT");
    this.addColumnIfMissing("archived_sessions", "initiated_by_email", "TEXT");
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_archived_sessions_resumed_agent
         ON archived_sessions(resumed_agent_id)`,
    );

    // Task labels were previously created by a non-atomic "look up by name else
    // INSERT" with no unique constraint, so the same name could land many times in
    // one project. Enforce Django get_or_create semantics keyed by
    // (project_id, lower(name)) with a unique expression index. A plain unique index
    // FAILS while duplicates exist, so dedup first (canonical = earliest by
    // (sort_order, id), matching PG migration 0049): collapse duplicate assignee rows
    // to one per (task, canonical group) — a task on two dups of the same group with
    // no canonical assignment would otherwise self-collide on the (task_id, label_id)
    // PK when repointed — then repoint the survivors, then delete the orphaned dup
    // labels. Guarded on the index not existing yet, so the pass runs at most once.
    const labelIdx = this.db.pragma("index_list(task_labels)") as Array<{ name: string }>;
    if (!labelIdx.some((i) => i.name === "ux_task_labels_project_lower_name")) {
      const dedup = this.db.transaction((): void => {
        // Step 1 — keep one assignee per (task, canonical group); delete the rest
        // (prefer the one already on the canonical label, else the earliest-sorted).
        this.db.exec(`
          DELETE FROM task_label_assignees
           WHERE (task_id, label_id) IN (
             SELECT task_id, label_id FROM (
               SELECT
                 tla.task_id AS task_id,
                 tla.label_id AS label_id,
                 row_number() OVER (
                   PARTITION BY tla.task_id, c.canonical_id
                   ORDER BY (tla.label_id = c.canonical_id) DESC, c.sort_order, c.id
                 ) AS rn
               FROM task_label_assignees tla
               JOIN (
                 SELECT id, sort_order,
                        first_value(id) OVER (
                          PARTITION BY project_id, lower(name) ORDER BY sort_order, id
                        ) AS canonical_id
                 FROM task_labels
               ) c ON c.id = tla.label_id
             ) WHERE rn > 1
           )
        `);
        // Step 2 — repoint the surviving dup assignees to the canonical label id (at
        // most one survivor per (task, canonical group), so no PK self-collision).
        this.db.exec(`
          UPDATE task_label_assignees
             SET label_id = (
               SELECT c.canonical_id FROM (
                 SELECT id,
                        first_value(id) OVER (
                          PARTITION BY project_id, lower(name) ORDER BY sort_order, id
                        ) AS canonical_id
                 FROM task_labels
               ) c WHERE c.id = task_label_assignees.label_id
             )
           WHERE label_id IN (
             SELECT id FROM (
               SELECT id,
                      first_value(id) OVER (
                        PARTITION BY project_id, lower(name) ORDER BY sort_order, id
                      ) AS canonical_id
               FROM task_labels
             ) WHERE id <> canonical_id
           )
        `);
        // Step 3 — delete the now-unreferenced duplicate label rows.
        this.db.exec(`
          DELETE FROM task_labels
           WHERE id IN (
             SELECT id FROM (
               SELECT id,
                      first_value(id) OVER (
                        PARTITION BY project_id, lower(name) ORDER BY sort_order, id
                      ) AS canonical_id
               FROM task_labels
             ) WHERE id <> canonical_id
           )
        `);
        // Step 4 — the unique constraint (the resolver's ON CONFLICT target).
        this.db.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS ux_task_labels_project_lower_name
             ON task_labels(project_id, lower(name))`,
        );
      });
      dedup();
    }
  }

  // ─── Sequence ────────────────────────────────────────────────────

  nextSeq(workspaceId: string): number {
    const row = this.seqStmt.get(workspaceId) as { max_seq: number } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  // ─── Users ───────────────────────────────────────────────────────

  // Resolve a user to a DETERMINISTIC, store-independent id derived from the
  // email (canonicalUserId). Every SQLite file — and PG — agrees on this id, so
  // the auth path no longer binds the user to a per-file random id whose
  // workspace list is empty (the workspace-visibility bug). A pre-existing row
  // minted under the old random id is RECONCILED in place: its child rows are
  // re-pointed to the canonical id so no membership/read/draft data is stranded.
  upsertUser(email: string, name?: string | null): StoredUser {
    const canonicalId = canonicalUserId(email);
    // Look up by exact email first; if that misses (e.g. a different casing of
    // the same address, which maps to the SAME canonical id), fall back to the
    // canonical id so we never try to INSERT a duplicate id.
    const existing =
      (this.getUserByEmailStmt.get(email) as StoredUser | undefined) ??
      this.getUserById(canonicalId);

    if (existing && existing.id === canonicalId) {
      const nameChanged = name != null && name !== existing.name;
      const emailChanged = email !== existing.email;
      if (nameChanged || emailChanged) {
        this.db
          .prepare("UPDATE users SET name = COALESCE(?, name), email = ? WHERE id = ?")
          .run(name ?? null, email, canonicalId);
      }
      return this.getUserById(canonicalId)!;
    }

    if (existing) {
      // Legacy row minted under a random id. Adopt the canonical id and migrate
      // every child row so the user's memberships/reads/drafts survive the
      // re-key. Done in ONE transaction: create the canonical user row first (so
      // child FKs to users.id resolve), re-point children, then drop the old row.
      this.reassignUserId(existing.id, canonicalId, email, name ?? existing.name);
      return this.getUserById(canonicalId)!;
    }

    return this.upsertUserStmt.get(canonicalId, email, name ?? null, Date.now()) as StoredUser;
  }

  // Re-key a user row from `oldId` to `newId`, migrating every child reference.
  // Reconciles a legacy random-id row onto the canonical id — either the
  // email-derived one (solo) or the real PG account id (connected). Public so
  // DualStorage can call it once PG resolves the authoritative id.
  reassignUserId(oldId: string, newId: string, email: string, name: string | null): void {
    if (oldId === newId) return;
    const now = Date.now();
    this.db.transaction(() => {
      // Free the email from the legacy row BEFORE inserting the canonical row
      // (email is UNIQUE), then materialize the canonical user row so child FKs
      // resolve when we re-point them.
      this.db
        .prepare("UPDATE users SET email = ? WHERE id = ?")
        .run(`__migrating__${oldId}`, oldId);
      this.db
        .prepare(
          `INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET email = excluded.email,
             name = COALESCE(excluded.name, users.name)`,
        )
        .run(newId, email, name, now);

      // Re-point child rows. If the canonical id already owns a colliding row
      // (e.g. both ids had a membership in the same workspace) the UPDATE hits a
      // PK/unique conflict — drop the legacy duplicate instead.
      for (const table of [
        "memberships",
        "message_reads",
        "notification_prefs",
        "drafts",
        "activity_events",
      ]) {
        try {
          this.db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(newId, oldId);
        } catch {
          this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(oldId);
        }
      }
      // workspaces.owner_id and messages.from_id/to_id carry the user id by value
      // (no FK); re-point them so authorship/ownership follows the canonical id.
      this.db.prepare("UPDATE workspaces SET owner_id = ? WHERE owner_id = ?").run(newId, oldId);
      this.db.prepare("UPDATE messages SET from_id = ? WHERE from_id = ?").run(newId, oldId);
      this.db.prepare("UPDATE messages SET to_id = ? WHERE to_id = ?").run(newId, oldId);

      // Finally drop the legacy user row now that nothing references it.
      this.db.prepare("DELETE FROM users WHERE id = ?").run(oldId);
    })();
  }

  // Adopt an EXPLICIT canonical id (the real PG account id, resolved async by
  // DualStorage) for an email already present locally under a different id.
  // No-op when the local row already uses canonicalId. Returns the resolved row.
  adoptCanonicalUserId(email: string, canonicalId: string, name?: string | null): StoredUser {
    const existing = this.getUserByEmailStmt.get(email) as StoredUser | undefined;
    if (existing && existing.id !== canonicalId) {
      this.reassignUserId(existing.id, canonicalId, email, name ?? existing.name);
    } else if (!existing) {
      this.upsertUserStmt.get(canonicalId, email, name ?? null, Date.now());
    } else if (name != null && name !== existing.name) {
      this.db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, canonicalId);
    }
    return this.getUserById(canonicalId)!;
  }

  getUserByEmail(email: string): StoredUser | undefined {
    return this.getUserByEmailStmt.get(email) as StoredUser | undefined;
  }

  getUserById(id: string): StoredUser | undefined {
    return this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as StoredUser | undefined;
  }

  // Materialize a placeholder user row for a KNOWN id (e.g. a cloud guest the
  // relay forwards an RPC for) so downstream FKs (memberships.user_id → users.id)
  // resolve in solo SQLite. INSERT OR IGNORE is idempotent and never clobbers a
  // real user row that already carries the right email/name.
  ensureUser(id: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?, ?, NULL, ?)")
      .run(id, `${id}@remote.local`, Date.now());
  }

  // ─── Workspaces ──────────────────────────────────────────────────

  createWorkspace(
    name: string,
    ownerId: string,
    settings?: Record<string, unknown>,
  ): StoredWorkspace {
    const id = `ws_${randomUUID()}`;
    const now = Date.now();
    this.db.transaction(() => {
      this.insertWorkspaceStmt.run(
        id,
        name,
        ownerId,
        settings ? JSON.stringify(settings) : null,
        now,
      );
      this.insertMembershipStmt.run(id, ownerId, "owner", "active", now);
      this.insertChannelStmt.run(
        `ch_${randomUUID()}`,
        id,
        "general",
        "General discussion",
        0,
        null,
        "regular",
        0,
        ownerId,
        now,
      );
    })();
    return this.getWorkspaceStmt.get(id) as StoredWorkspace;
  }

  createWorkspaceWithId(id: string, name: string, ownerId: string): StoredWorkspace {
    const now = Date.now();
    this.insertWorkspaceStmt.run(id, name, ownerId, null, now);
    return this.getWorkspaceStmt.get(id) as StoredWorkspace;
  }

  // Correct a workspace's owner to the authoritative PG value. Used after a
  // relay-forward materializes a placeholder workspace owned by the caller —
  // the real owner (from PG) replaces the stub so local owner-only checks line up.
  reassignWorkspaceOwner(id: string, ownerId: string): void {
    this.db.prepare("UPDATE workspaces SET owner_id = ? WHERE id = ?").run(ownerId, id);
  }

  getWorkspacesForUser(userId: string): Array<StoredWorkspace & { role: string }> {
    return this.getWorkspacesForUserStmt.all(userId) as Array<StoredWorkspace & { role: string }>;
  }

  getWorkspace(workspaceId: string): StoredWorkspace | undefined {
    return this.getWorkspaceStmt.get(workspaceId) as StoredWorkspace | undefined;
  }

  getAllWorkspaceIds(): string[] {
    return (this.db.prepare("SELECT id FROM workspaces").all() as Array<{ id: string }>).map(
      (r) => r.id,
    );
  }

  updateWorkspace(
    workspaceId: string,
    updates: { name?: string; avatarUrl?: string | null; settings?: Record<string, unknown> },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (updates.name !== undefined) {
      sets.push("name = ?");
      values.push(updates.name);
    }
    if (updates.avatarUrl !== undefined) {
      sets.push("avatar_url = ?");
      values.push(updates.avatarUrl);
    }
    if (updates.settings !== undefined) {
      sets.push("settings = ?");
      values.push(JSON.stringify(updates.settings));
    }
    if (sets.length === 0) return;
    values.push(workspaceId);
    this.db.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  deleteWorkspace(workspaceId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM channel_projects WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = ?)",
        )
        .run(workspaceId);
      for (const table of [
        "messages",
        "channels",
        "memberships",
        "tasks",
        "cybos",
        "agent_bindings",
        "archived_sessions",
        "projects",
        "audit_log",
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
      }
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
    })();
  }

  // ─── Memberships ─────────────────────────────────────────────────

  addMember(workspaceId: string, userId: string, role = "member", membershipType = "active"): void {
    this.insertMembershipStmt.run(workspaceId, userId, role, membershipType, Date.now());
  }

  getMembership(workspaceId: string, userId: string): StoredMembership | undefined {
    return this.getMembershipStmt.get(workspaceId, userId) as StoredMembership | undefined;
  }

  getMembers(
    workspaceId: string,
  ): Array<StoredMembership & { email: string; name: string | null }> {
    return this.getMembersStmt.all(workspaceId) as Array<
      StoredMembership & { email: string; name: string | null }
    >;
  }

  deleteMembership(workspaceId: string, userId: string): void {
    this.deleteMembershipStmt.run(workspaceId, userId);
  }

  updateMembership(workspaceId: string, userId: string, role: string): void {
    this.updateMembershipStmt.run(role, workspaceId, userId);
  }

  // ─── Channels ────────────────────────────────────────────────────

  createChannel(
    workspaceId: string,
    name: string,
    createdBy: string,
    opts?: {
      description?: string;
      isPrivate?: boolean;
      instructions?: string;
      // #608: channel kind + browser visibility. Defaults keep every existing
      // caller byte-identical (a regular, visible channel).
      type?: string;
      isHidden?: boolean;
    },
  ): StoredChannel {
    const id = `ch_${randomUUID()}`;
    const now = Date.now();
    this.insertChannelStmt.run(
      id,
      workspaceId,
      name,
      opts?.description ?? null,
      opts?.isPrivate ? 1 : 0,
      opts?.instructions ?? null,
      opts?.type ?? "regular",
      opts?.isHidden ? 1 : 0,
      createdBy,
      now,
    );
    return this.getChannelStmt.get(id) as StoredChannel;
  }

  getChannels(workspaceId: string): StoredChannel[] {
    return this.getChannelsStmt.all(workspaceId) as StoredChannel[];
  }

  getChannel(channelId: string): StoredChannel | undefined {
    return this.getChannelStmt.get(channelId) as StoredChannel | undefined;
  }

  // ─── Messages ────────────────────────────────────────────────────

  insertMessage(msg: {
    workspaceId: string;
    channelId?: string | null;
    fromId: string;
    fromType: "human" | "agent" | "system";
    fromName?: string | null;
    toId?: string | null;
    text: string;
    mentions?: string[] | null;
    parentId?: string | null;
    attachments?: unknown[] | null;
  }): StoredMessage {
    const id = `msg_${randomUUID()}`;
    const seq = this.nextSeq(msg.workspaceId);
    const now = Date.now();
    const attachmentsJson =
      msg.attachments && msg.attachments.length > 0 ? JSON.stringify(msg.attachments) : null;
    this.insertMessageStmt.run(
      id,
      msg.workspaceId,
      msg.channelId ?? null,
      msg.fromId,
      msg.fromType,
      msg.fromName ?? null,
      msg.toId ?? null,
      msg.text,
      msg.mentions ? JSON.stringify(msg.mentions) : null,
      msg.parentId ?? null,
      attachmentsJson,
      seq,
      now,
    );
    return {
      id,
      workspace_id: msg.workspaceId,
      channel_id: msg.channelId ?? null,
      from_id: msg.fromId,
      from_type: msg.fromType,
      from_name: msg.fromName ?? null,
      to_id: msg.toId ?? null,
      text: msg.text,
      mentions: msg.mentions ? JSON.stringify(msg.mentions) : null,
      parent_id: msg.parentId ?? null,
      attachments: attachmentsJson,
      seq,
      created_at: now,
    };
  }

  insertMessageRaw(msg: {
    id: string;
    workspaceId: string;
    channelId?: string | null;
    fromId: string;
    fromType: "human" | "agent" | "system";
    fromName?: string | null;
    toId?: string | null;
    text: string;
    mentions?: string[] | null;
    parentId?: string | null;
    attachments?: unknown[] | null;
    seq: number;
    createdAt: number;
  }): void {
    // insertMessageStmt has 13 placeholders (attachments included); passing 12
    // values made better-sqlite3 throw "Too few parameter values were provided"
    // on every relay ingest, silently breaking local message sync.
    this.insertMessageStmt.run(
      msg.id,
      msg.workspaceId,
      msg.channelId ?? null,
      msg.fromId,
      msg.fromType,
      msg.fromName ?? null,
      msg.toId ?? null,
      msg.text,
      msg.mentions ? JSON.stringify(msg.mentions) : null,
      msg.parentId ?? null,
      msg.attachments && msg.attachments.length > 0 ? JSON.stringify(msg.attachments) : null,
      msg.seq,
      msg.createdAt,
    );
  }

  getMessages(opts: { channelId: string; before?: string; limit?: number }): StoredMessage[] {
    const limit = opts.limit ?? 50;
    // Order by created_at, not seq — seq resets per relay restart and isn't
    // chronologically monotonic (see pg-sync.getMessages).
    if (opts.before) {
      // Composite (created_at, seq) cursor — a plain created_at < would skip
      // every sibling sharing the cursor's millisecond.
      // parent_id IS NULL: the main channel view shows top-level messages only;
      // thread replies are fetched separately via getThreadReplies.
      const stmt = this.db.prepare(
        `SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND deleted_at IS NULL
           AND (created_at < (SELECT created_at FROM messages WHERE id = ?)
             OR (created_at = (SELECT created_at FROM messages WHERE id = ?)
                 AND seq < (SELECT seq FROM messages WHERE id = ?)))
         ORDER BY created_at DESC, seq DESC LIMIT ?`,
      );
      return stmt.all(
        opts.channelId,
        opts.before,
        opts.before,
        opts.before,
        limit,
      ) as StoredMessage[];
    }
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at DESC, seq DESC LIMIT ?",
    );
    return stmt.all(opts.channelId, limit) as StoredMessage[];
  }

  getMessageById(id: string): StoredMessage | undefined {
    return this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      | StoredMessage
      | undefined;
  }

  updateMessageText(id: string, text: string): number {
    const now = Date.now();
    this.db.prepare("UPDATE messages SET text = ?, updated_at = ? WHERE id = ?").run(text, now, id);
    return now;
  }

  // Soft-delete (tombstone) so reads filter it out.
  deleteMessage(id: string): void {
    // Cascade the soft-delete to thread replies so deleting a root doesn't orphan
    // them (matches the cloud pg-sync path).
    this.db
      .prepare("UPDATE messages SET deleted_at = ? WHERE id = ? OR parent_id = ?")
      .run(Date.now(), id, id);
  }

  // Replies in a thread (oldest → newest), for the thread panel.
  getThreadReplies(parentId: string): StoredMessage[] {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE parent_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, seq ASC",
    );
    return stmt.all(parentId) as StoredMessage[];
  }

  // Local-mode message search (SQLite). LIKE-based (case-insensitive for ASCII) —
  // the cloud path uses Postgres FTS (PgSync.searchMessages). Workspace-scoped;
  // the workspace "view" permission is checked by the caller (message-router).
  searchMessages(
    workspaceId: string,
    query: string,
    limit = 50,
    channelId?: string,
  ): StoredMessage[] {
    const q = query.trim();
    if (!q) return [];
    // Filter by channel in SQL (not in-memory after a capped fetch) so a channel's
    // matches can't be missed when they fall beyond the workspace-wide LIMIT.
    const params: (string | number)[] = [workspaceId, `%${q}%`];
    let channelClause = "";
    if (channelId) {
      channelClause = " AND channel_id = ?";
      params.push(channelId);
    }
    params.push(Math.min(limit, 100));
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE workspace_id = ? AND deleted_at IS NULL AND channel_id IS NOT NULL AND text LIKE ?${channelClause}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as StoredMessage[];
  }

  // Per-parent reply count + last reply time for every thread in a channel,
  // so the main view can show a "N replies" indicator.
  getThreadMeta(channelId: string): Map<string, { count: number; lastReplyAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT parent_id AS pid, COUNT(*) AS c, MAX(created_at) AS last
         FROM messages WHERE channel_id = ? AND parent_id IS NOT NULL AND deleted_at IS NULL GROUP BY parent_id`,
      )
      .all(channelId) as Array<{ pid: string; c: number; last: number }>;
    const map = new Map<string, { count: number; lastReplyAt: number }>();
    for (const r of rows) map.set(r.pid, { count: r.c, lastReplyAt: r.last });
    return map;
  }

  // Pin (pinnedBy = userId) or unpin (pinnedBy = null) a message.
  setPinned(
    messageId: string,
    pinnedBy: string | null,
  ): { pinnedAt: number | null; pinnedBy: string | null } {
    const pinnedAt = pinnedBy ? Date.now() : null;
    this.db
      .prepare("UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?")
      .run(pinnedAt, pinnedBy, messageId);
    return { pinnedAt, pinnedBy };
  }

  getPinnedMessages(channelId: string): StoredMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL AND deleted_at IS NULL ORDER BY pinned_at DESC",
      )
      .all(channelId) as StoredMessage[];
  }

  // ─── Read state ──────────────────────────────────────────────────

  markRead(workspaceId: string, userId: string, channelId: string, lastReadAt: number): void {
    this.db
      .prepare(
        `INSERT INTO message_reads (workspace_id, user_id, channel_id, last_read_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, channel_id)
           DO UPDATE SET last_read_at = excluded.last_read_at, workspace_id = excluded.workspace_id`,
      )
      .run(workspaceId, userId, channelId, lastReadAt);
  }

  // ─── Activity feed ───────────────────────────────────────────────

  insertActivityEvent(e: {
    // Optional deterministic id (agent-mention dedup across the daemon + relay
    // writers). When absent a random id is minted, the legacy behavior. OR IGNORE
    // makes a repeat of the same deterministic id a no-op instead of a throw.
    id?: string;
    workspaceId: string;
    userId: string;
    eventType: string;
    sourceType: string;
    sourceId: string;
    channelId?: string | null;
    previewText?: string | null;
    actorId?: string | null;
    actorName?: string | null;
  }): StoredActivityEvent {
    const id = e.id ?? `act_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO activity_events
         (id, workspace_id, user_id, event_type, source_type, source_id, channel_id, preview_text, actor_id, actor_name, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        e.workspaceId,
        e.userId,
        e.eventType,
        e.sourceType,
        e.sourceId,
        e.channelId ?? null,
        e.previewText ?? null,
        e.actorId ?? null,
        e.actorName ?? null,
        now,
      );
    return {
      id,
      workspace_id: e.workspaceId,
      user_id: e.userId,
      event_type: e.eventType,
      source_type: e.sourceType,
      source_id: e.sourceId,
      channel_id: e.channelId ?? null,
      preview_text: e.previewText ?? null,
      actor_id: e.actorId ?? null,
      actor_name: e.actorName ?? null,
      is_read: 0,
      created_at: now,
    };
  }

  getActivity(
    workspaceId: string,
    userId: string,
    opts?: { limit?: number; before?: number; unreadOnly?: boolean },
  ): StoredActivityEvent[] {
    const limit = Math.min(opts?.limit ?? 40, 100);
    const conds = ["workspace_id = ?", "user_id = ?"];
    const params: (string | number)[] = [workspaceId, userId];
    if (opts?.unreadOnly) conds.push("is_read = 0");
    if (opts?.before != null) {
      conds.push("created_at < ?");
      params.push(opts.before);
    }
    params.push(limit);
    return this.db
      .prepare(
        `SELECT * FROM activity_events WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as StoredActivityEvent[];
  }

  markActivityRead(eventId: string, userId: string): void {
    this.db
      .prepare("UPDATE activity_events SET is_read = 1 WHERE id = ? AND user_id = ?")
      .run(eventId, userId);
  }

  markAllActivityRead(workspaceId: string, userId: string): void {
    this.db
      .prepare("UPDATE activity_events SET is_read = 1 WHERE workspace_id = ? AND user_id = ?")
      .run(workspaceId, userId);
  }

  getUnreadActivityCount(workspaceId: string, userId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM activity_events WHERE workspace_id = ? AND user_id = ? AND is_read = 0",
      )
      .get(workspaceId, userId) as { c: number };
    return row.c;
  }

  // ─── Notification preferences ────────────────────────────────────

  setNotificationPref(
    workspaceId: string,
    userId: string,
    scopeId: string,
    preference: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO notification_prefs (workspace_id, user_id, scope_id, preference)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, scope_id)
           DO UPDATE SET preference = excluded.preference, workspace_id = excluded.workspace_id`,
      )
      .run(workspaceId, userId, scopeId, preference);
  }

  getNotificationPrefs(workspaceId: string, userId: string): Map<string, string> {
    const rows = this.db
      .prepare(
        "SELECT scope_id AS s, preference AS p FROM notification_prefs WHERE user_id = ? AND workspace_id = ?",
      )
      .all(userId, workspaceId) as Array<{ s: string; p: string }>;
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.s, r.p);
    return map;
  }

  getNotificationPref(userId: string, scopeId: string): string | null {
    const row = this.db
      .prepare("SELECT preference AS p FROM notification_prefs WHERE user_id = ? AND scope_id = ?")
      .get(userId, scopeId) as { p: string } | undefined;
    return row?.p ?? null;
  }

  // ─── Composer drafts (server-side draft sync, #610) ──────────────
  // Upsert the caller's draft for a (workspace, scope). One row per conversation
  // per user (PK user_id+scope); a re-save overwrites in place. updated_at is the
  // reconcile tiebreaker (newest wins) used by the client on workspace load.
  setDraft(
    workspaceId: string,
    userId: string,
    scope: string,
    text: string,
    updatedAt: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO drafts (workspace_id, user_id, scope, text, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, scope)
           DO UPDATE SET text = excluded.text, workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`,
      )
      .run(workspaceId, userId, scope, text, updatedAt);
  }

  // Delete the caller's draft for a (workspace, scope) — on send or explicit
  // clear. Idempotent (no-op if already gone).
  clearDraft(workspaceId: string, userId: string, scope: string): void {
    this.db
      .prepare("DELETE FROM drafts WHERE user_id = ? AND scope = ? AND workspace_id = ?")
      .run(userId, scope, workspaceId);
  }

  // All of a user's drafts in a workspace, for seeding a fresh device on
  // workspace load.
  getDrafts(
    workspaceId: string,
    userId: string,
  ): Array<{ scope: string; text: string; updatedAt: number }> {
    return this.db
      .prepare(
        "SELECT scope, text, updated_at AS updatedAt FROM drafts WHERE user_id = ? AND workspace_id = ?",
      )
      .all(userId, workspaceId) as Array<{ scope: string; text: string; updatedAt: number }>;
  }

  getReadsForUser(workspaceId: string, userId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT channel_id AS cid, last_read_at AS lr FROM message_reads WHERE user_id = ? AND workspace_id = ?",
      )
      .all(userId, workspaceId) as Array<{ cid: string; lr: number }>;
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.cid, r.lr);
    return map;
  }

  getLastRead(userId: string, channelId: string): number | null {
    const row = this.db
      .prepare("SELECT last_read_at FROM message_reads WHERE user_id = ? AND channel_id = ?")
      .get(userId, channelId) as { last_read_at: number } | undefined;
    return row?.last_read_at ?? null;
  }

  // Per-channel unread count for a user: top-level, non-deleted messages newer
  // than their last_read (or all, if never read), excluding their own.
  getUnreadCounts(workspaceId: string, userId: string): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT m.channel_id AS cid, COUNT(*) AS c
         FROM messages m
         LEFT JOIN message_reads r ON r.user_id = ? AND r.channel_id = m.channel_id
         WHERE m.workspace_id = ? AND m.channel_id IS NOT NULL AND m.parent_id IS NULL
           AND m.deleted_at IS NULL AND m.from_id != ?
           AND m.created_at > COALESCE(r.last_read_at, 0)
         GROUP BY m.channel_id`,
      )
      .all(userId, workspaceId, userId) as Array<{ cid: string; c: number }>;
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.cid, row.c);
    return map;
  }

  getMessagesSince(workspaceId: string, sinceSeq: number, limit = 500): StoredMessage[] {
    const stmt = this.db.prepare(
      "SELECT * FROM messages WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    );
    return stmt.all(workspaceId, sinceSeq, limit) as StoredMessage[];
  }

  // Top-level, non-deleted channel messages created AFTER `sinceMs` (the caller's
  // last_read_at), oldest-first — the unread slice /catchup digests. sinceMs=0
  // (never read) returns the channel from the start, capped at `limit`. Mirrors
  // PgSync.getChannelMessagesSince so solo + cloud daemons agree.
  getChannelMessagesSince(channelId: string, sinceMs: number, limit = 500): StoredMessage[] {
    const stmt = this.db.prepare(
      // ORDER BY (created_at, seq) — same tiebreak as PgSync.getChannelMessagesSince
      // so the solo + cloud paths agree on order when messages share a millisecond.
      `SELECT * FROM messages WHERE channel_id = ? AND parent_id IS NULL
       AND deleted_at IS NULL AND created_at > ? ORDER BY created_at, seq LIMIT ?`,
    );
    return stmt.all(channelId, sinceMs, limit) as StoredMessage[];
  }

  getDmMessages(workspaceId: string, userA: string, userB: string, limit = 50): StoredMessage[] {
    const stmt = this.db.prepare(
      `SELECT * FROM messages WHERE workspace_id = ? AND channel_id IS NULL
       AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))
       ORDER BY created_at DESC LIMIT ?`,
    );
    return stmt.all(workspaceId, userA, userB, userB, userA, limit) as StoredMessage[];
  }

  // ─── Tasks ───────────────────────────────────────────────────────

  createTask(opts: {
    workspaceId: string;
    title: string;
    createdBy: string;
    description?: string;
    assigneeId?: string;
    dueAt?: number;
    channelId?: string | null;
    priority?: string | null;
    // Tasks Phase 0 — planned start (Gantt left edge) + draft flag. Optional.
    startDate?: number | null;
    isDraft?: boolean;
    // Tasks Redesign P0 (Plane-style) — Tasks-project membership, sub-task parent
    // self-link, workflow state, cycle bucket. All optional and back-compat: an
    // unset projectId leaves the row project-less (legacy behavior); a set one
    // allocates the next per-project sequence_id atomically (PROJ-### key). A
    // caller wanting the default project/state resolves them first
    // (resolveDefaultTasksProject / default state) and passes the ids here.
    projectId?: string | null;
    parentId?: string | null;
    stateId?: string | null;
    cycleId?: string | null;
    // Redesign P0 — denormalized many-to-many sets, persisted to the SQLite join
    // tables (NOT task columns) in the SAME create txn, mirroring pg-sync.createTask.
    // `labels` are free-text NAMES (no client name→id resolver) resolved/created
    // against the task's FINAL project; `moduleIds` are already-resolved ids.
    labels?: string[];
    moduleIds?: string[];
    // Require-project opt-in (default false). When a create supplies NO
    // project/channel/parent context: false → fall back to the workspace Inbox
    // (the default for the 2nd-workspace MCP server, GitHub sync, internal
    // callers); true → throw "provide projectId or channelId" (set ONLY at the
    // user/cybo-facing create handlers: cybo create tool + CLI/relay/dispatcher).
    requireProjectContext?: boolean;
  }): StoredTask {
    const id = `task_${randomUUID()}`;
    const now = Date.now();
    // oxlint-disable-next-line eslint/complexity -- pre-existing over-budget task txn (unchanged by #994; disable lets this file lint clean when staged)
    const txn = this.db.transaction((): void => {
      // P0 parity with pg-sync.createTask — resolve the effective Tasks-project
      // (explicit > channel's chat-project's tasks_project > the workspace Inbox).
      // PG always lands a non-null project_id (and an allocated sequence), so the
      // SQLite mirror does too — otherwise a label name (which needs a project to
      // anchor) would be dropped solo while the cloud kept it. Extracted so
      // createTask stays under the complexity cap.
      const projectId = this.resolveCreateProject({
        projectId: opts.projectId ?? null,
        channelId: opts.channelId ?? null,
        parentId: opts.parentId ?? null,
        workspaceId: opts.workspaceId,
        requireProjectContext: opts.requireProjectContext ?? false,
      });
      // P0 — workflow state: explicit > the project's is_default state.
      const stateId = opts.stateId ?? this.getDefaultState(projectId)?.id ?? null;
      // P0 — mirror the legacy free-text `status` from the chosen state's group so
      // the watcher/back-compat reads (getDueTasks/getOwnedOpenTasks) stay correct,
      // exactly as pg-sync does (resolve state → group → mapStateGroupToStatus). No
      // state → "pending", matching PG when the chosen/defaulted stateId is null.
      const status = stateId ? this.resolveStatusForState(stateId) : "pending";
      // Phase 0 — append to the end of the (workspace, status) lane so a new card
      // lands last in its column. The reorder RPC + drag-drop later refine the
      // position fractionally.
      const sortOrder = this.nextSortOrder(opts.workspaceId, status);
      // P0 — allocate the per-project sequence number (the N in "PROJ-N") atomically
      // inside the same write txn so two concurrent creates never collide.
      // (resolveCreateProject always returns a real project, so this is always set.)
      const sequenceId = this.allocateSequenceId(projectId, now);
      this.insertTaskStmt.run(
        id,
        opts.workspaceId,
        opts.title,
        opts.description ?? null,
        status,
        opts.assigneeId ?? null,
        opts.createdBy,
        opts.dueAt ?? null,
        null,
        null,
        opts.channelId ?? null,
        opts.priority ?? null,
        sortOrder,
        opts.startDate ?? null,
        opts.isDraft ? 1 : 0,
        projectId,
        opts.parentId ?? null,
        stateId,
        sequenceId,
        opts.cycleId ?? null,
        now,
        now,
      );
      // Persist the denormalized sets into the join tables (same txn). labels are
      // NAMES → resolve/create against the just-resolved project; moduleIds are ids.
      if (opts.labels && opts.labels.length > 0 && projectId) {
        const labelIds = this.resolveLabels(projectId, opts.labels);
        if (labelIds.length > 0) this.setTaskLabels(id, labelIds);
      }
      if (opts.moduleIds && opts.moduleIds.length > 0) {
        this.setTaskModules(id, opts.moduleIds);
      }
    });
    txn();
    return this.enrichTaskSatellites(this.getTaskStmt.get(id) as StoredTask);
  }

  // Tasks Redesign — translate a WIRE projectId into the tasks_projects.id it
  // refers to (mirrors pg-sync.resolveTasksProjectId). The UI routes
  // /tasks/[projectId] and sends create/update with the CHAT project id
  // (cyborg:fetch_projects returns the chat `projects` rows), but every tasks
  // read/write keys off tasks_projects.id (a random "tproj_…" on SQLite). This
  // bridges the two 1:1-derived id spaces by DB lookup (NOT by string-prepending —
  // the SQLite id is a random uuid, never "tp_"+chatId):
  //   - a row already keyed by this id → return it as-is (back-compat / tp id),
  //   - else the 1:1 chat link (tasks_projects.chat_project_id = id) → that row's id,
  //   - else null (genuinely unknown).
  resolveTasksProjectId(projectId: string): string | null {
    const byId = this.getTasksProjectStmt.get(projectId) as StoredTasksProject | undefined;
    if (byId) return byId.id;
    const byChat = this.getTasksProjectByChatStmt.get(projectId) as StoredTasksProject | undefined;
    return byChat?.id ?? null;
  }

  // createTask's effective-project resolver — the require-one-of rule the product
  // owner decided, mirrored exactly in pg-sync.resolveCreateProjectTx so cybo / CLI
  // / UI behave identically. Precedence:
  //   1. explicit projectId → the Tasks-project it names (CHAT id or tp_ id; the UI
  //      routes /tasks/[projectId] off cyborg:fetch_projects, so it is translated to
  //      the local tasks_projects.id). Unknown id → throw "project not found" (fail
  //      closed rather than silently filing into Inbox).
  //   2. else channelId → the channel's chat-project's tasks_project, falling back to
  //      the workspace Inbox when the channel has no project (KEPT — a channel
  //      always lands a task somewhere).
  //   3. else parentId → INHERIT the parent task's Tasks-project (sub-tasks; the UI
  //      passes only parentId). Parent tasks always carry a project, so this
  //      resolves; a missing / project-less parent is a data anomaly and falls
  //      through to rule 4.
  //   4. else (no project/channel/parent context) → the require-project flag
  //      decides: requireProjectContext true → throw "provide projectId or
  //      channelId" (the user/cybo-facing create handlers: cybo create tool +
  //      CLI/relay/dispatcher); false (default) → fall back to the workspace
  //      Inbox (the 2nd-workspace MCP server, GitHub sync, internal callers).
  // Returns a non-null tasks_projects id, or throws.
  private resolveCreateProject(opts: {
    projectId: string | null;
    channelId: string | null;
    parentId?: string | null;
    workspaceId: string;
    requireProjectContext?: boolean;
  }): string {
    if (opts.projectId) {
      const resolved = this.resolveTasksProjectId(opts.projectId);
      if (!resolved) throw new Error("project not found");
      return resolved;
    }
    if (opts.channelId) {
      const fromChannel = this.resolveTasksProjectForChannel(opts.channelId);
      return fromChannel ?? this.getOrCreateInboxProject(opts.workspaceId).id;
    }
    if (opts.parentId) {
      const parent = this.getTaskStmt.get(opts.parentId) as StoredTask | undefined;
      const parentProjectId = parent?.project_id;
      if (parentProjectId) return parentProjectId;
    }
    if (opts.requireProjectContext) throw new Error("provide projectId or channelId");
    return this.getOrCreateInboxProject(opts.workspaceId).id;
  }

  // Tasks Redesign P0 — resolve the 1:1 Tasks-project for a chat CHANNEL: the
  // channel's chat-project (channel_projects) → that chat-project's tasks_project
  // (tasks_projects.chat_project_id). Mirrors pg-sync.createTask's channel_projects
  // join. Returns the tasks_project id, or null if the channel has no chat-project
  // or that chat-project has no tasks_project yet.
  private resolveTasksProjectForChannel(channelId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT tp.id AS id
           FROM channel_projects cp
           JOIN tasks_projects tp ON tp.chat_project_id = cp.project_id
          WHERE cp.channel_id = ?
          LIMIT 1`,
      )
      .get(channelId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  // Tasks Redesign P0 — resolve a list of label NAMES to ids within a project's
  // task_labels catalog, creating any that don't yet exist (idempotent get-or-
  // create). Mirrors pg-sync.resolveLabels exactly: case-insensitive match on the
  // trimmed name, blanks skipped, the returned ids preserve input order and dedupe,
  // and new labels get the neutral slate pill (#94a3b8) appended at the tail of the
  // project's sort order. Runs inside the caller's create/update txn (better-sqlite3
  // is synchronous, so a nested call shares the active transaction).
  resolveLabels(projectId: string, names: readonly string[]): string[] {
    const wanted: string[] = [];
    const seenKeys = new Set<string>();
    for (const raw of names) {
      const trimmed = (raw ?? "").trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      wanted.push(trimmed);
    }
    if (wanted.length === 0) return [];

    const proj = this.getTasksProjectStmt.get(projectId) as StoredTasksProject | undefined;
    // Unknown project → nothing to anchor labels to; resolve to no ids rather than
    // orphan-create (matches pg-sync). create/update only ever pass a real project.
    if (!proj) return [];

    const tail = this.getTaskLabelsTailSortStmt.get(projectId) as { maxSort: number | null };
    let nextSort = (tail?.maxSort ?? -1) + 1;

    const ids: string[] = [];
    for (const name of wanted) {
      // Atomic get-or-create: the upsert returns the new id, or nothing on conflict
      // (label already exists in this batch/project), in which case we look it up by
      // the same case-insensitive key. `wanted` is already lower-dedup'd, so this is
      // conflict-safe within the batch too.
      const inserted = this.insertTaskLabelStmt.get(
        randomUUID(),
        projectId,
        proj.workspace_id,
        name,
        "#94a3b8",
        nextSort,
      ) as { id: string } | undefined;
      if (inserted) {
        nextSort += 1;
        ids.push(inserted.id);
        continue;
      }
      const existing = this.getTaskLabelByLowerNameStmt.get(projectId, name) as
        | { id: string }
        | undefined;
      if (existing) ids.push(existing.id);
    }
    return ids;
  }

  // Tasks Redesign P0 — replace-set the task's labels (delete-then-insert), mirroring
  // pg-sync.updateTask's label join semantics. An empty list clears all labels.
  setTaskLabels(taskId: string, labelIds: readonly string[]): void {
    const txn = this.db.transaction((): void => {
      this.deleteTaskLabelAssigneesStmt.run(taskId);
      for (const labelId of labelIds) this.insertTaskLabelAssigneeStmt.run(taskId, labelId);
    });
    txn();
  }

  // Tasks Redesign P0 — replace-set the task's modules (delete-then-insert),
  // mirroring pg-sync.updateTask's module join semantics. Empty list clears all.
  setTaskModules(taskId: string, moduleIds: readonly string[]): void {
    const txn = this.db.transaction((): void => {
      this.deleteTaskModulesStmt.run(taskId);
      for (const moduleId of moduleIds) this.insertTaskModuleStmt.run(taskId, moduleId);
    });
    txn();
  }

  // Tasks Redesign P0 — batch-load the denormalized label/module id arrays for a set
  // of task ids in two grouped queries (no N+1), as per-task maps. Mirrors pg-sync.
  // loadTaskSatelliteIds so getTasksPage / create / update reads carry the same
  // shape on the solo/daemon path as the cloud.
  private loadTaskSatelliteIds(taskIds: readonly string[]): {
    labels: Map<string, string[]>;
    modules: Map<string, string[]>;
  } {
    const labels = new Map<string, string[]>();
    const modules = new Map<string, string[]>();
    if (taskIds.length === 0) return { labels, modules };
    const placeholders = taskIds.map(() => "?").join(", ");
    const labelRows = this.db
      .prepare(
        `SELECT task_id AS taskId, label_id AS labelId FROM task_label_assignees
          WHERE task_id IN (${placeholders})`,
      )
      .all(...taskIds) as Array<{ taskId: string; labelId: string }>;
    const moduleRows = this.db
      .prepare(
        `SELECT task_id AS taskId, module_id AS moduleId FROM task_modules
          WHERE task_id IN (${placeholders})`,
      )
      .all(...taskIds) as Array<{ taskId: string; moduleId: string }>;
    for (const row of labelRows) {
      const list = labels.get(row.taskId);
      if (list) list.push(row.labelId);
      else labels.set(row.taskId, [row.labelId]);
    }
    for (const row of moduleRows) {
      const list = modules.get(row.taskId);
      if (list) list.push(row.moduleId);
      else modules.set(row.taskId, [row.moduleId]);
    }
    return { labels, modules };
  }

  // OUTBOUND project_id translation (mirrors pg-sync.loadChatProjectIds) — batch-
  // resolve a set of tasks_projects.id ("tproj_…" on SQLite) to each one's
  // chat_project_id (the chat id the UI keys off), as a tpId → chatId|null map. A
  // tasks_project with no chat project (the synthetic Inbox) maps to null; a
  // null/empty input set is skipped. Used by the enrich passes so each StoredTask
  // exposes the chat id, not the internal tproj_ id.
  private loadChatProjectIds(
    taskProjectIds: readonly (string | null | undefined)[],
  ): Map<string, string | null> {
    const out = new Map<string, string | null>();
    const ids = [...new Set(taskProjectIds.filter((v): v is string => !!v))];
    if (ids.length === 0) return out;
    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, chat_project_id AS chatProjectId FROM tasks_projects
          WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{ id: string; chatProjectId: string | null }>;
    for (const row of rows) out.set(row.id, row.chatProjectId ?? null);
    return out;
  }

  // OUTBOUND project_id translation for a set of already-mapped StoredTasks: rewrite
  // each task.project_id from its stored tasks_projects.id (the tproj_ id) to that
  // project's chat_project_id (the chat id), so the SQLite/daemon readback exposes
  // the SAME id space as the UI (route /tasks/[projectId], fetch_projects, the board
  // filter), matching pg-sync. An Inbox/orphan project (chat_project_id null) → null.
  // Done in one batched lookup over the page; mutates in place like the satellite
  // enrich passes.
  private translateProjectIdsToChat(tasks: StoredTask[]): StoredTask[] {
    if (tasks.length === 0) return tasks;
    const chatProjectIds = this.loadChatProjectIds(tasks.map((t) => t.project_id));
    for (const t of tasks) {
      t.project_id = t.project_id ? (chatProjectIds.get(t.project_id) ?? null) : null;
    }
    return tasks;
  }

  // Attach the denormalized label_ids/module_ids arrays to a single task projection,
  // and translate its project_id from the stored tasks_projects.id to the chat id.
  private enrichTaskSatellites(task: StoredTask): StoredTask {
    const { labels, modules } = this.loadTaskSatelliteIds([task.id]);
    task.label_ids = labels.get(task.id) ?? [];
    task.module_ids = modules.get(task.id) ?? [];
    this.translateProjectIdsToChat([task]);
    return task;
  }

  // Attach the denormalized label_ids/module_ids arrays to a page of task rows via a
  // single batched satellite fetch (mirrors pg-sync.mapTaskRowsWithSatellites), and
  // translate each project_id from the stored tasks_projects.id to the chat id.
  private enrichTaskSatellitesMany(tasks: StoredTask[]): StoredTask[] {
    if (tasks.length === 0) return tasks;
    const { labels, modules } = this.loadTaskSatelliteIds(tasks.map((t) => t.id));
    for (const t of tasks) {
      t.label_ids = labels.get(t.id) ?? [];
      t.module_ids = modules.get(t.id) ?? [];
    }
    this.translateProjectIdsToChat(tasks);
    return tasks;
  }

  // Tasks Redesign P0 — resolve a workflow state's id to the legacy free-text
  // `status` mirror (state.group → mapStateGroupToStatus), the SAME mapping the PG
  // path uses. An unknown/missing state id falls back to "pending" (the default
  // bucket), matching pg-sync's "no state → pending" behavior.
  private resolveStatusForState(stateId: string): string {
    const row = this.getTaskStateGroupStmt.get(stateId) as { group: string } | undefined;
    return row ? mapStateGroupToStatus(row.group) : "pending";
  }

  // Tasks Redesign P0 — allocate the next per-project sequence number atomically.
  // SQLite has no advisory lock; the UPDATE ... RETURNING bumps and reads the
  // counter in one statement, and callers run it inside their create txn so two
  // concurrent inserts never hand out a colliding PROJ-### key. Returns the new
  // sequence value (1 for the first task of a fresh project).
  private allocateSequenceId(projectId: string, now: number): number {
    const row = this.bumpSequenceCounterStmt.get(now, projectId) as
      | { sequence_counter: number }
      | undefined;
    if (!row) {
      throw new Error(`allocateSequenceId: tasks_project ${projectId} not found`);
    }
    return row.sequence_counter;
  }

  // Phase 0 — next free integer sort_order at the tail of a (workspace, status)
  // lane. NULL-only / empty lane starts at 0. Reorder writes fractional values
  // BETWEEN neighbours; tail appends stay whole.
  private nextSortOrder(workspaceId: string, status: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(sort_order) AS maxSort FROM tasks
         WHERE workspace_id = ? AND status = ?`,
      )
      .get(workspaceId, status) as { maxSort: number | null };
    return (row?.maxSort ?? -1) + 1;
  }

  updateTask(taskId: string, updates: Record<string, unknown>): StoredTask | undefined {
    const task = this.getTaskStmt.get(taskId) as StoredTask | undefined;
    if (!task) return undefined;
    // Redesign P0 — labelIds/moduleIds are denormalized join sets, NOT task columns;
    // peel them off so the camelCase→snake_case column loop below never mis-maps them
    // (e.g. `labelIds` → `label_ids`, a non-existent column). undefined = leave the
    // set untouched; an explicit array (incl. []) replace-sets it (delete-then-insert),
    // mirroring pg-sync.updateTask.
    const {
      labelIds,
      moduleIds,
      labels: _labels,
      ...columnUpdates
    } = updates as Record<string, unknown> & {
      labelIds?: readonly string[];
      moduleIds?: readonly string[];
      // `labels` (NAMES) is resolved to ids upstream (DualStorage); peel any stray
      // one here so it never leaks into the column loop as a bogus `labels` column.
      labels?: readonly string[];
    };
    const txn = this.db.transaction((): void => {
      if (labelIds !== undefined) this.setTaskLabels(taskId, labelIds);
      if (moduleIds !== undefined) this.setTaskModules(taskId, moduleIds);
      this.applyTaskColumnUpdates(taskId, columnUpdates);
    });
    txn();
    return this.enrichTaskSatellites(this.getTaskStmt.get(taskId) as StoredTask);
  }

  // Scalar-column half of updateTask: maps camelCase keys → snake_case columns and
  // writes them, plus the state→status mirror. Split out so updateTask can wrap it
  // and the join replace-sets in one transaction.
  private applyTaskColumnUpdates(taskId: string, rawUpdates: Record<string, unknown>): void {
    // Re-parenting to a Tasks-project: the wire carries the CHAT project id (the UI
    // sends what cyborg:fetch_projects returned), so translate it to the local
    // tasks_projects.id before writing tasks.project_id; a tasks_projects id passes
    // through unchanged. A non-null id that resolves to nothing is unknown → fail
    // closed. Clearing the project (null) writes null untouched. Done on a shallow
    // copy so the caller's object is never mutated.
    const updates: Record<string, unknown> = { ...rawUpdates };
    if (typeof updates.projectId === "string") {
      const resolved = this.resolveTasksProjectId(updates.projectId);
      if (!resolved) throw new Error("project not found");
      updates.projectId = resolved;
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        fields.push(`${col} = ?`);
        values.push(value);
      }
    }
    // P0 — when the workflow state changes (and the caller didn't also pass an
    // explicit status override), re-mirror the legacy free-text `status` from the
    // new state's group so the watcher/back-compat reads stay correct — exactly as
    // pg-sync's updateTask does. Setting state to null (un-link) leaves the
    // existing status untouched; an explicit `status` in `updates` wins.
    if (
      updates.stateId !== undefined &&
      updates.status === undefined &&
      typeof updates.stateId === "string" &&
      updates.stateId
    ) {
      fields.push("status = ?");
      values.push(this.resolveStatusForState(updates.stateId));
    }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(taskId);
    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  // Read a workspace's tasks in a STABLE order — sort_order (NULLS LAST), then
  // created_at, then id — so cursor pagination is deterministic across pages.
  // When `limit` is given, returns at most `limit` rows; `nextCursor` (read via
  // getTasksPage) carries the keyset to fetch the next page. `cursor` is the opaque
  // token from a prior page. Backward-compatible: callers passing no limit/cursor
  // get the full list (the only behavior change is the order — formerly
  // created_at DESC — which no caller relies on; the board/list/view layer sorts
  // client-side, and the by-id `.find()` callers are order-agnostic).
  getTasks(
    workspaceId: string,
    filter?: {
      status?: string;
      assigneeId?: string;
      limit?: number;
      cursor?: string;
      projectId?: string;
    },
  ): StoredTask[] {
    return this.getTasksPage(workspaceId, filter).tasks;
  }

  // Single-task read by id, enriched with its denormalized label_ids/module_ids.
  // undefined if the id is unknown. Used by the dual-storage update path to anchor
  // label-name resolution to the task's current project.
  getTaskById(taskId: string): StoredTask | undefined {
    const task = this.getTaskStmt.get(taskId) as StoredTask | undefined;
    return task ? this.enrichTaskSatellites(task) : undefined;
  }

  // Paginated read: same filter/order as getTasks, plus an opaque `nextCursor`
  // (null when this is the last page). The cursor encodes the keyset tuple
  // (sort_order, created_at, id) of the last returned row; the next call resumes
  // strictly after it. Returns nextCursor only when `limit` was set AND a full
  // page came back (a short page is the tail).
  getTasksPage(
    workspaceId: string,
    filter?: {
      status?: string;
      assigneeId?: string;
      limit?: number;
      cursor?: string;
      // Tasks Redesign — optional single-project scope. Already the resolved
      // tasks_projects.id (the dispatcher resolves the wire CHAT/"tp_…" id via
      // resolveTasksProjectId before calling), mirroring the relay's pg.getTasksPage.
      projectId?: string;
    },
  ): { tasks: StoredTask[]; nextCursor: string | null } {
    let sql = "SELECT * FROM tasks WHERE workspace_id = ?";
    const params: unknown[] = [workspaceId];
    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    if (filter?.assigneeId) {
      sql += " AND assignee_id = ?";
      params.push(filter.assigneeId);
    }
    if (filter?.projectId) {
      sql += " AND project_id = ?";
      params.push(filter.projectId);
    }
    // Keyset predicate from the opaque cursor. The order key is
    // (sortNull, sort_order, created_at, id) ascending, where sortNull = (sort_order
    // IS NULL) puts NULLs LAST. The "strictly after the cursor" predicate is the
    // standard lexicographic keyset expansion of that 4-tuple.
    const cur = decodeTaskCursor(filter?.cursor);
    if (cur) {
      const sortNull = cur.sortOrder === null ? 1 : 0;
      // sortNull ASC, then sort_order ASC (only when same null-group), then
      // created_at ASC, then id ASC.
      sql += ` AND (
        ((sort_order IS NULL) > ?)
        OR ((sort_order IS NULL) = ? AND (
          ${cur.sortOrder === null ? "" : "(sort_order > ?) OR (sort_order = ? AND ("}
            created_at > ? OR (created_at = ? AND id > ?)
          ${cur.sortOrder === null ? "" : "))"}
        ))
      )`;
      if (cur.sortOrder === null) {
        params.push(sortNull, sortNull, cur.createdAt, cur.createdAt, cur.id);
      } else {
        params.push(
          sortNull,
          sortNull,
          cur.sortOrder,
          cur.sortOrder,
          cur.createdAt,
          cur.createdAt,
          cur.id,
        );
      }
    }
    sql += " ORDER BY (sort_order IS NULL) ASC, sort_order ASC, created_at ASC, id ASC";
    const limit = filter?.limit;
    if (limit !== undefined && limit > 0) {
      // Fetch one extra to know whether a further page exists without a second query.
      sql += " LIMIT ?";
      params.push(limit + 1);
    }
    const rows = this.db.prepare(sql).all(...params) as StoredTask[];
    if (limit !== undefined && limit > 0 && rows.length > limit) {
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      // Enrich BEFORE encoding the cursor — the cursor keys off (sort_order,
      // created_at, id), which enrichment doesn't touch, so order is preserved.
      return { tasks: this.enrichTaskSatellitesMany(page), nextCursor: encodeTaskCursor(last) };
    }
    return { tasks: this.enrichTaskSatellitesMany(rows), nextCursor: null };
  }

  // Phase 0 — drag-reorder within a (workspace, status) lane. Places `taskId`
  // between its named neighbours by computing a fractional sort_order strictly
  // between them; an edge drop (one neighbour absent) clamps to ±1 of the present
  // one. Both absent => the lane was empty, append at the tail. Mirrors the same
  // math the PG path uses. Returns the updated task (undefined if missing).
  reorderTask(
    taskId: string,
    opts: { beforeId?: string; afterId?: string },
  ): StoredTask | undefined {
    const task = this.getTaskStmt.get(taskId) as StoredTask | undefined;
    if (!task) return undefined;
    const before =
      opts.beforeId !== undefined
        ? (this.getTaskStmt.get(opts.beforeId) as StoredTask | undefined)
        : undefined;
    const after =
      opts.afterId !== undefined
        ? (this.getTaskStmt.get(opts.afterId) as StoredTask | undefined)
        : undefined;
    const newSort = computeReorderSort({
      beforeSort: before?.sort_order ?? null,
      afterSort: after?.sort_order ?? null,
      tailSort: this.nextSortOrder(task.workspace_id, task.status),
    });
    this.db
      .prepare("UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?")
      .run(newSort, Date.now(), taskId);
    return this.enrichTaskSatellites(this.getTaskStmt.get(taskId) as StoredTask);
  }

  // Phase 0 — apply one set of updates to many tasks in a single synchronous
  // transaction, returning the updated rows (skips ids that don't exist). Reuses
  // updateTask's camelCase→snake_case column mapping per row so a bulk edit and a
  // single edit write identical columns.
  bulkUpdateTasks(taskIds: readonly string[], updates: Record<string, unknown>): StoredTask[] {
    const txn = this.db.transaction((): StoredTask[] => {
      const out: StoredTask[] = [];
      for (const id of taskIds) {
        const updated = this.updateTask(id, updates);
        if (updated) out.push(updated);
      }
      return out;
    });
    return txn();
  }

  // Phase 0 — hard delete (irreversible). Returns true iff a row was removed.
  deleteTask(taskId: string): boolean {
    const res = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    return res.changes > 0;
  }

  // Phase 0 — soft archive / un-archive. Sets archived_at to now (archive) or NULL
  // (restore). Returns the updated task (undefined if missing).
  archiveTask(taskId: string, archived: boolean): StoredTask | undefined {
    const task = this.getTaskStmt.get(taskId) as StoredTask | undefined;
    if (!task) return undefined;
    this.db
      .prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? Date.now() : null, Date.now(), taskId);
    return this.enrichTaskSatellites(this.getTaskStmt.get(taskId) as StoredTask);
  }

  // Tasks Phase 3 — atomic dispatch claim (SQLite mirror of pg.claimTaskDispatch).
  // Wins the right to dispatch iff the task is currently unclaimed or its claim is
  // stale (older than staleMs, default 30s). better-sqlite3 runs synchronously, so
  // this single UPDATE is atomic against other in-process callers. Returns true if
  // THIS call claimed the task, false if it was already claimed within the window.
  claimTaskDispatch(taskId: string, staleMs = 30_000): boolean {
    const now = Date.now();
    const cutoff = now - staleMs;
    const res = this.db
      .prepare(
        `UPDATE tasks SET last_dispatched_at = ?, updated_at = ?
         WHERE id = ?
           AND (last_dispatched_at IS NULL OR last_dispatched_at <= ?)`,
      )
      .run(now, now, taskId, cutoff);
    return res.changes > 0;
  }

  // Tasks Phase 3 — due-task selection for the schedule-runner tick (SQLite mirror
  // of pg.getDueTasks). Open (not done/cancelled) tasks with a due_at at/under now,
  // an assignee set, and a claimable dispatch slot (NULL/stale).
  getDueTasks(now = Date.now(), staleMs = 30_000): StoredTask[] {
    const cutoff = now - staleMs;
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status NOT IN ('done', 'cancelled')
           AND assignee_id IS NOT NULL
           AND due_at IS NOT NULL AND due_at <= ?
           AND (last_dispatched_at IS NULL OR last_dispatched_at <= ?)
         ORDER BY due_at ASC`,
      )
      .all(now, cutoff) as StoredTask[];
    // Uniform StoredTask contract: surface project_id as the chat id (mirrors
    // pg.getDueTasks, which maps through mapTaskRowsWithSatellites).
    return this.translateProjectIdsToChat(rows);
  }

  // Tasks Phase 3 — owned-task catch-up on daemon reconnect (SQLite mirror of
  // pg.getOwnedOpenTasks). Open tasks for the given assignees that are claimable
  // (NULL/stale dispatch). Ordering is deterministic (created_at) for stable sweep.
  getOwnedOpenTasks(
    workspaceId: string,
    assigneeIds: readonly string[],
    staleMs = 3_600_000,
  ): StoredTask[] {
    if (assigneeIds.length === 0) return [];
    const cutoff = Date.now() - staleMs;
    const placeholders = assigneeIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE workspace_id = ?
           AND status IN ('todo', 'pending', 'in_progress')
           AND assignee_id IN (${placeholders})
           AND (last_dispatched_at IS NULL OR last_dispatched_at <= ?)
         ORDER BY created_at ASC`,
      )
      .all(workspaceId, ...assigneeIds, cutoff) as StoredTask[];
    // Uniform StoredTask contract: surface project_id as the chat id (mirrors
    // pg.getOwnedOpenTasks, which maps through mapTaskRowsWithSatellites).
    return this.translateProjectIdsToChat(rows);
  }

  // Tasks Phase 2 — read the per-channel auto-tasks watcher switch (SQLite mirror
  // of pg.getChannelAutoTasksEnabled). OPT-IN (default OFF): a channel watches ONLY
  // when auto_tasks_enabled is explicitly 1 (NULL/missing/0 => OFF), matching the
  // schema.ts contract. The safety brake against a cybo acting autonomously in a
  // channel nobody opted in.
  getChannelAutoTasksEnabled(channelId: string): boolean {
    const row = this.db
      .prepare("SELECT auto_tasks_enabled AS v FROM channels WHERE id = ?")
      .get(channelId) as { v: number | null } | undefined;
    return row?.v === 1;
  }

  // Setter for the per-channel auto-tasks opt-in switch (SQLite mirror of
  // pg.setChannelAutoTasksEnabled). Returns true when a row was updated.
  setChannelAutoTasksEnabled(channelId: string, enabled: boolean): boolean {
    const info = this.db
      .prepare("UPDATE channels SET auto_tasks_enabled = ? WHERE id = ?")
      .run(enabled ? 1 : 0, channelId);
    return info.changes > 0;
  }

  // Tasks Phase 3 — atomic recurrence spawn-next (SQLite mirror of
  // pg.spawnRecurrenceChild). Claims the parent's spawn slot
  // (recurrence_spawned_at IS NULL) under the cap, inserts the child carrying the
  // parent's recurrence/assignee/channel, and bumps the parent's recurrence_count.
  // Returns the new child task, or undefined if already spawned / cap reached /
  // parent missing. Runs in one synchronous transaction (atomic in-process).
  spawnRecurrenceChild(
    parentId: string,
    childDueAt: number | null,
    maxRecurrenceCount: number,
  ): StoredTask | undefined {
    const txn = this.db.transaction((): StoredTask | undefined => {
      const claimed = this.db
        .prepare(
          `UPDATE tasks
             SET recurrence_spawned_at = ?, recurrence_count = recurrence_count + 1
           WHERE id = ?
             AND recurrence_spawned_at IS NULL
             AND recurrence_count < ?`,
        )
        .run(Date.now(), parentId, maxRecurrenceCount);
      if (claimed.changes === 0) return undefined;
      const parent = this.getTaskStmt.get(parentId) as StoredTask | undefined;
      if (!parent) return undefined;
      const childId = `task_${randomUUID()}`;
      const now = Date.now();
      // Phase 0 — the child appends to the end of the "pending" lane (its initial
      // status), carrying the parent's start_date; it is never a draft.
      const childSortOrder = this.nextSortOrder(parent.workspace_id, "pending");
      // P0 — the child inherits the parent's Tasks-project + workflow state +
      // cycle, and (when in a project) gets its own freshly-allocated per-project
      // sequence_id. It is a top-level task, not a sub-task (parent_id NULL):
      // recurrence spawns a sibling occurrence, not a child of the template.
      const childProjectId = parent.project_id ?? null;
      const childSequenceId = childProjectId ? this.allocateSequenceId(childProjectId, now) : null;
      this.insertTaskStmt.run(
        childId,
        parent.workspace_id,
        parent.title,
        parent.description ?? null,
        "pending",
        parent.assignee_id ?? null,
        parent.created_by,
        childDueAt,
        parent.recurrence ?? null,
        null,
        parent.channel_id ?? null,
        parent.priority ?? null,
        childSortOrder,
        parent.start_date ?? null,
        0,
        childProjectId,
        null,
        parent.state_id ?? null,
        childSequenceId,
        parent.cycle_id ?? null,
        now,
        now,
      );
      return this.getTaskStmt.get(childId) as StoredTask;
    });
    return txn();
  }

  // ─── Schedules ───────────────────────────────────────────────────

  createSchedule(opts: {
    workspaceId: string;
    cyboId: string;
    cronExpr: string;
    prompt: string;
    createdBy: string;
    channelId?: string | null;
    // Per-task scheduling: bind this schedule to a task (run as its assignee cybo,
    // unattended). Omitted/null = a raw-prompt cybo schedule (unchanged).
    taskId?: string | null;
    timezone?: string | null;
    nextRunAt?: number | null;
    enabled?: boolean;
    // Phase 2 (#619): one-shot cap (1) / recurring (null), and catch-up policy.
    maxRuns?: number | null;
    catchUp?: boolean;
  }): StoredSchedule {
    const id = `sched_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO schedules (id, workspace_id, cybo_id, channel_id, task_id, cron_expr, timezone, prompt, enabled, last_run_at, next_run_at, max_runs, run_count, catch_up, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.workspaceId,
        opts.cyboId,
        opts.channelId ?? null,
        opts.taskId ?? null,
        opts.cronExpr,
        opts.timezone ?? null,
        opts.prompt,
        opts.enabled === false ? 0 : 1,
        null,
        opts.nextRunAt ?? null,
        opts.maxRuns ?? null,
        0,
        opts.catchUp === false ? 0 : 1,
        opts.createdBy,
        now,
        now,
      );
    return this.getSchedule(id) as StoredSchedule;
  }

  getSchedule(id: string): StoredSchedule | undefined {
    return this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as
      | StoredSchedule
      | undefined;
  }

  listSchedules(workspaceId: string): StoredSchedule[] {
    return this.db
      .prepare("SELECT * FROM schedules WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as StoredSchedule[];
  }

  // Enabled schedules whose next_run_at is due (<= now). Used by the runner tick.
  getDueSchedules(now: number): StoredSchedule[] {
    return this.db
      .prepare(
        "SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?",
      )
      .all(now) as StoredSchedule[];
  }

  // Record a fire: stamp last_run_at and advance next_run_at to the next slot.
  // incrementRunCount (#619) bumps the durable fire counter that drives one-shot
  // completion — set by the runner when a slot was actually consumed (a real fire
  // or a billing-paused skip), NOT for a no-op advance.
  markScheduleRun(
    id: string,
    lastRunAt: number,
    nextRunAt: number | null,
    incrementRunCount = false,
  ): void {
    const runCountSql = incrementRunCount ? ", run_count = run_count + 1" : "";
    this.db
      .prepare(
        `UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ?${runCountSql} WHERE id = ?`,
      )
      .run(lastRunAt, nextRunAt, Date.now(), id);
  }

  // Cross-daemon exactly-once claim for the RAW-PROMPT cron path (#cron-dup) — the
  // SQLite mirror of pg.claimScheduleDispatch, and the AUTHORITATIVE claim in solo
  // mode. Wins the right to fire (schedule, slot) iff no row exists for that pair.
  // better-sqlite3 is synchronous, so the INSERT OR IGNORE is atomic against other
  // in-process callers. Returns true iff THIS call inserted the claim (won the slot).
  claimScheduleDispatch(
    scheduleId: string,
    scheduledFor: number,
    claimedBy?: string | null,
  ): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO schedule_dispatch_claims (schedule_id, scheduled_for, claimed_at, claimed_by)
         VALUES (?, ?, ?, ?)`,
      )
      .run(scheduleId, scheduledFor, Date.now(), claimedBy ?? null);
    return res.changes > 0;
  }

  // Cross-daemon exactly-once claim for the @mention / channel-watch paths (#16) —
  // the SQLite mirror of pg.claimInvocationDispatch, and the AUTHORITATIVE claim in
  // solo mode. Twin of claimScheduleDispatch: wins the right to invoke a given
  // claim_key iff no row exists yet. INSERT OR IGNORE is atomic against other
  // in-process callers. Returns true iff THIS call inserted the claim (won it).
  claimInvocationDispatch(claimKey: string, claimedBy?: string | null): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO invocation_dispatch_claims (claim_key, claimed_at, claimed_by)
         VALUES (?, ?, ?)`,
      )
      .run(claimKey, Date.now(), claimedBy ?? null);
    return res.changes > 0;
  }

  setScheduleEnabled(id: string, enabled: boolean, nextRunAt?: number | null): void {
    if (nextRunAt === undefined) {
      this.db
        .prepare("UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, Date.now(), id);
    } else {
      this.db
        .prepare("UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
        .run(enabled ? 1 : 0, nextRunAt, Date.now(), id);
    }
  }

  // Edit a schedule's mutable fields (cron/prompt/channel/timezone) plus the
  // recomputed next_run_at when the cadence changed. Only provided fields are
  // touched; the caller computes nextRunAt from the new cron.
  updateSchedule(
    id: string,
    fields: {
      cronExpr?: string;
      prompt?: string;
      channelId?: string | null;
      taskId?: string | null;
      timezone?: string | null;
      nextRunAt?: number | null;
    },
  ): StoredSchedule | undefined {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (fields.cronExpr !== undefined) {
      sets.push("cron_expr = ?");
      values.push(fields.cronExpr);
    }
    if (fields.prompt !== undefined) {
      sets.push("prompt = ?");
      values.push(fields.prompt);
    }
    if (fields.channelId !== undefined) {
      sets.push("channel_id = ?");
      values.push(fields.channelId);
    }
    if (fields.taskId !== undefined) {
      sets.push("task_id = ?");
      values.push(fields.taskId);
    }
    if (fields.timezone !== undefined) {
      sets.push("timezone = ?");
      values.push(fields.timezone);
    }
    if (fields.nextRunAt !== undefined) {
      sets.push("next_run_at = ?");
      values.push(fields.nextRunAt);
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      values.push(Date.now());
      this.db.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.getSchedule(id);
  }

  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  // ─── Built-in integrations (recipes) ─────────────────────────────
  // Mirrors the PG installed_recipes table. SQLite is the authoritative copy on a
  // solo/local daemon; DualStorage writes here first then fire-and-forgets to PG.
  // config + schedule_ids are JSON TEXT here (jsonb in PG) — the JSON is
  // serialized on write, returned as raw TEXT (the caller/mapper parses it).

  // Enable (install) a recipe. Upsert on the partial UNIQUE (workspace, recipe)
  // WHERE enabled = 1: a re-enable reuses the existing active row (refreshing
  // config + enabled + updated_at). Returns the resulting row.
  enableRecipe(opts: {
    id: string;
    workspaceId: string;
    recipeId: string;
    config?: Record<string, unknown>;
    createdBy: string;
  }): StoredInstalledRecipe {
    const now = Date.now();
    const configJson = JSON.stringify(opts.config ?? {});
    this.db
      .prepare(
        `INSERT INTO installed_recipes (id, workspace_id, recipe_id, enabled, config, cybo_id, schedule_ids, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, NULL, '[]', ?, ?, ?)
         ON CONFLICT (workspace_id, recipe_id) WHERE enabled = 1
         DO UPDATE SET config = excluded.config, enabled = 1, updated_at = excluded.updated_at`,
      )
      .run(opts.id, opts.workspaceId, opts.recipeId, configJson, opts.createdBy, now, now);
    return this.getInstalledRecipe(opts.workspaceId, opts.recipeId) as StoredInstalledRecipe;
  }

  // Stamp the provisioned cybo + schedule ids onto the active install (called
  // after the daemon creates them). Scoped by id so a concurrent disable can't
  // resurrect ids onto a torn-down row.
  setRecipeProvisioned(id: string, cyboId: string, scheduleIds: string[]): void {
    this.db
      .prepare(
        "UPDATE installed_recipes SET cybo_id = ?, schedule_ids = ?, updated_at = ? WHERE id = ?",
      )
      .run(cyboId, JSON.stringify(scheduleIds), Date.now(), id);
  }

  // Disable the active install for (workspace, recipe): flip enabled=0 and clear
  // the provisioned ids (the cybo + its schedules/memberships are deleted by the
  // caller via the cybo FK cascade). The row is kept for history, never deleted.
  disableRecipe(workspaceId: string, recipeId: string): void {
    this.db
      .prepare(
        `UPDATE installed_recipes
         SET enabled = 0, cybo_id = NULL, schedule_ids = '[]', updated_at = ?
         WHERE workspace_id = ? AND recipe_id = ? AND enabled = 1`,
      )
      .run(Date.now(), workspaceId, recipeId);
  }

  listRecipesForWorkspace(workspaceId: string): StoredInstalledRecipe[] {
    return this.db
      .prepare("SELECT * FROM installed_recipes WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as StoredInstalledRecipe[];
  }

  // The ACTIVE install for (workspace, recipe), or null. Disabled history rows are
  // intentionally excluded so callers see at most one (the live install).
  getInstalledRecipe(workspaceId: string, recipeId: string): StoredInstalledRecipe | null {
    const row = this.db
      .prepare(
        "SELECT * FROM installed_recipes WHERE workspace_id = ? AND recipe_id = ? AND enabled = 1 LIMIT 1",
      )
      .get(workspaceId, recipeId) as StoredInstalledRecipe | undefined;
    return row ?? null;
  }

  // ─── Schedule runs (run history — #619) ──────────────────────────

  // Open a run row at fire time (status 'running'); the runner closes it later
  // with finishScheduleRun. Returns the row id so the caller can correlate.
  startScheduleRun(opts: {
    scheduleId: string;
    workspaceId: string;
    scheduledFor: number | null;
    startedAt?: number;
  }): string {
    const id = `schrun_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, workspace_id, scheduled_for, started_at, ended_at, status, skip_reason, agent_id, error)
         VALUES (?, ?, ?, ?, ?, NULL, 'running', NULL, NULL, NULL)`,
      )
      .run(id, opts.scheduleId, opts.workspaceId, opts.scheduledFor, opts.startedAt ?? Date.now());
    return id;
  }

  // Close a 'running' run with its terminal outcome (succeeded/failed).
  finishScheduleRun(opts: {
    id: string;
    status: "succeeded" | "failed";
    agentId?: string | null;
    error?: string | null;
    endedAt?: number;
  }): void {
    this.db
      .prepare(
        "UPDATE schedule_runs SET status = ?, agent_id = ?, error = ?, ended_at = ? WHERE id = ?",
      )
      .run(
        opts.status,
        opts.agentId ?? null,
        opts.error ?? null,
        opts.endedAt ?? Date.now(),
        opts.id,
      );
  }

  // Record a terminal 'skipped' run in one shot (no spawn happened, so it opens
  // and closes together). skip_reason is a closed set — failures are shown (#619).
  recordSkippedScheduleRun(opts: {
    scheduleId: string;
    workspaceId: string;
    scheduledFor: number | null;
    skipReason: ScheduleSkipReason;
    at?: number;
  }): string {
    const id = `schrun_${randomUUID()}`;
    const at = opts.at ?? Date.now();
    this.db
      .prepare(
        `INSERT INTO schedule_runs (id, schedule_id, workspace_id, scheduled_for, started_at, ended_at, status, skip_reason, agent_id, error)
         VALUES (?, ?, ?, ?, ?, ?, 'skipped', ?, NULL, NULL)`,
      )
      .run(id, opts.scheduleId, opts.workspaceId, opts.scheduledFor, at, at, opts.skipReason);
    return id;
  }

  // Most-recent run history for a schedule (the "Last runs" drawer). Newest first.
  listScheduleRuns(scheduleId: string, limit = 20): StoredScheduleRun[] {
    return this.db
      .prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY started_at DESC LIMIT ?")
      .all(scheduleId, limit) as StoredScheduleRun[];
  }

  // ─── Scheduled messages (user "send later", #607) ────────────────

  createScheduledMessage(opts: {
    workspaceId: string;
    fromId: string;
    text: string;
    sendAt: number;
    channelId?: string | null;
    toId?: string | null;
    mentions?: string[] | null;
    id?: string;
  }): StoredScheduledMessage {
    const id = opts.id ?? `schedmsg_${randomUUID()}`;
    const now = Date.now();
    const mentionsJson =
      opts.mentions && opts.mentions.length > 0 ? JSON.stringify(opts.mentions) : null;
    this.db
      .prepare(
        `INSERT INTO scheduled_messages (id, workspace_id, channel_id, to_id, from_id, text, mentions, send_at, processed_at, error_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        opts.workspaceId,
        opts.channelId ?? null,
        opts.toId ?? null,
        opts.fromId,
        opts.text,
        mentionsJson,
        opts.sendAt,
        now,
      );
    return this.getScheduledMessage(id) as StoredScheduledMessage;
  }

  getScheduledMessage(id: string): StoredScheduledMessage | undefined {
    return this.db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(id) as
      | StoredScheduledMessage
      | undefined;
  }

  // The author's pending + recently-fired scheduled messages for a workspace
  // (newest send_at first). Pending rows (processed_at IS NULL) are still
  // editable/cancelable; processed rows stay visible so a failed one shows its
  // error_code instead of vanishing.
  listScheduledMessages(workspaceId: string, fromId: string): StoredScheduledMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM scheduled_messages WHERE workspace_id = ? AND from_id = ? ORDER BY send_at DESC",
      )
      .all(workspaceId, fromId) as StoredScheduledMessage[];
  }

  // Due + unprocessed rows for the runner tick (send_at <= now AND not yet fired).
  getDueScheduledMessages(now: number): StoredScheduledMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM scheduled_messages WHERE processed_at IS NULL AND send_at <= ? ORDER BY send_at ASC",
      )
      .all(now) as StoredScheduledMessage[];
  }

  // Edit a pending scheduled message before it fires (text / send_at). Only
  // touches rows still pending (processed_at IS NULL) so a just-fired row can't be
  // resurrected. Returns the updated row, or undefined if it was missing/already
  // processed.
  updateScheduledMessage(
    id: string,
    fields: { text?: string; sendAt?: number; mentions?: string[] | null },
  ): StoredScheduledMessage | undefined {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (fields.text !== undefined) {
      sets.push("text = ?");
      values.push(fields.text);
    }
    if (fields.sendAt !== undefined) {
      sets.push("send_at = ?");
      values.push(fields.sendAt);
    }
    if (fields.mentions !== undefined) {
      sets.push("mentions = ?");
      values.push(
        fields.mentions && fields.mentions.length > 0 ? JSON.stringify(fields.mentions) : null,
      );
    }
    if (sets.length === 0) return this.getScheduledMessage(id);
    values.push(id);
    this.db
      .prepare(
        `UPDATE scheduled_messages SET ${sets.join(", ")} WHERE id = ? AND processed_at IS NULL`,
      )
      .run(...values);
    return this.getScheduledMessage(id);
  }

  // Mark a row terminal: success (error_code NULL) or permanent failure (closed-set
  // error_code). Idempotency guard `processed_at IS NULL` means a row already
  // claimed/fired by a concurrent tick is a no-op here — no double-send. Returns
  // true if THIS call did the stamp (i.e. it claimed the row).
  markScheduledMessageProcessed(
    id: string,
    at: number,
    errorCode: ScheduledMessageErrorCode | null = null,
  ): boolean {
    const res = this.db
      .prepare(
        "UPDATE scheduled_messages SET processed_at = ?, error_code = ? WHERE id = ? AND processed_at IS NULL",
      )
      .run(at, errorCode, id);
    return res.changes > 0;
  }

  // Stamp a failure reason on an ALREADY-CLAIMED row (processed_at already set).
  // Used by the runner when it claimed a row (stamped processed_at), began the
  // send, and the send itself threw — the row is no longer pending, so the
  // processed-guarded markScheduledMessageProcessed can't reach it. No guard here
  // (the caller owns the claim), so it just records the reason on that id.
  setScheduledMessageError(id: string, errorCode: ScheduledMessageErrorCode): void {
    this.db.prepare("UPDATE scheduled_messages SET error_code = ? WHERE id = ?").run(errorCode, id);
  }

  // Cancel (delete) a pending scheduled message before it fires. A processed row
  // can't be canceled (it already fired/failed) — guard on processed_at IS NULL.
  // Returns true if a pending row was actually removed.
  deleteScheduledMessage(id: string): boolean {
    const res = this.db
      .prepare("DELETE FROM scheduled_messages WHERE id = ? AND processed_at IS NULL")
      .run(id);
    return res.changes > 0;
  }

  // ─── Prompt templates (#602 — reusable composer snippets) ────────

  createPromptTemplate(opts: {
    workspaceId: string;
    name: string;
    body: string;
    createdBy: string | null;
    id?: string;
  }): StoredPromptTemplate {
    const id = opts.id ?? `ptmpl_${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO prompt_templates (id, workspace_id, name, body, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, opts.workspaceId, opts.name, opts.body, opts.createdBy ?? null, now);
    return this.getPromptTemplate(id) as StoredPromptTemplate;
  }

  getPromptTemplate(id: string): StoredPromptTemplate | undefined {
    return this.db.prepare("SELECT * FROM prompt_templates WHERE id = ?").get(id) as
      | StoredPromptTemplate
      | undefined;
  }

  // Lookup by the per-workspace unique name — used by the create/update handlers
  // to detect a name clash and return a friendly error before hitting the UNIQUE
  // constraint.
  getPromptTemplateByName(workspaceId: string, name: string): StoredPromptTemplate | undefined {
    return this.db
      .prepare("SELECT * FROM prompt_templates WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, name) as StoredPromptTemplate | undefined;
  }

  // All templates for a workspace, A→Z by name (the composer's slash-menu list).
  listPromptTemplates(workspaceId: string): StoredPromptTemplate[] {
    return this.db
      .prepare(
        "SELECT * FROM prompt_templates WHERE workspace_id = ? ORDER BY name COLLATE NOCASE ASC",
      )
      .all(workspaceId) as StoredPromptTemplate[];
  }

  // Patch a template's name and/or body. Empty patch → returns the row unchanged.
  // Returns the updated row (or undefined if the id was missing).
  updatePromptTemplate(
    id: string,
    fields: { name?: string; body?: string },
  ): StoredPromptTemplate | undefined {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (fields.name !== undefined) {
      sets.push("name = ?");
      values.push(fields.name);
    }
    if (fields.body !== undefined) {
      sets.push("body = ?");
      values.push(fields.body);
    }
    if (sets.length === 0) return this.getPromptTemplate(id);
    values.push(id);
    this.db.prepare(`UPDATE prompt_templates SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getPromptTemplate(id);
  }

  // Delete a template. Returns true if a row was actually removed.
  deletePromptTemplate(id: string): boolean {
    const res = this.db.prepare("DELETE FROM prompt_templates WHERE id = ?").run(id);
    return res.changes > 0;
  }

  // ─── Agent Bindings ──────────────────────────────────────────────

  createAgentBinding(opts: {
    agentId: string;
    workspaceId: string;
    channelId?: string | null;
    provider: string;
    model?: string | null;
    systemPrompt?: string | null;
    daemonId?: string | null;
    cyboId?: string | null;
    initiatedBy?: string | null;
    // The initiator's REAL (canonical cloud) email — the opener on the cloud-
    // forwarded path. Persisted so agent_status.userEmail carries it and the relay
    // resolves agent_sessions.user_id to the real account (not the daemon-local
    // "<id>@remote.local" placeholder → NULL). Null for a truly autonomous spawn.
    initiatedByEmail?: string | null;
    cwd?: string | null;
    ephemeral?: boolean;
    autonomous?: boolean;
  }): StoredAgentBinding {
    const now = Date.now();
    this.insertAgentBindingStmt.run(
      opts.agentId,
      opts.workspaceId,
      opts.channelId ?? null,
      opts.provider,
      opts.model ?? null,
      opts.systemPrompt ?? null,
      opts.daemonId ?? null,
      opts.cyboId ?? null,
      opts.initiatedBy ?? null,
      opts.initiatedByEmail ?? null,
      opts.cwd ?? null,
      opts.ephemeral ? 1 : 0,
      opts.autonomous ? 1 : 0,
      now,
    );
    return this.getAgentBindingStmt.get(opts.agentId) as StoredAgentBinding;
  }

  getAgentBinding(agentId: string): StoredAgentBinding | undefined {
    return this.getAgentBindingStmt.get(agentId) as StoredAgentBinding | undefined;
  }

  getAgentsByWorkspace(workspaceId: string): StoredAgentBinding[] {
    return this.getAgentsByWorkspaceStmt.all(workspaceId) as StoredAgentBinding[];
  }

  updateAgentBindingModel(agentId: string, model: string | null): void {
    this.updateAgentBindingModelStmt.run(model, agentId);
  }

  // Stamp the best-effort provider resume id on the binding (captured at turn end).
  // No-op if the agent has no binding (ephemerals are swept; non-bound agents skip).
  updateAgentBindingSession(agentId: string, providerSessionId: string | null): void {
    this.updateAgentBindingSessionStmt.run(providerSessionId, agentId);
  }

  getCyboBindingsByWorkspace(workspaceId: string): StoredAgentBinding[] {
    return this.getCyboBindingsByWorkspaceStmt.all(workspaceId) as StoredAgentBinding[];
  }

  // Item 3 (session singleton): the live, NON-ephemeral binding for a (cybo, scope)
  // so a recurring cron fire / DM reuses ONE session instead of spawning a fresh
  // "several Ricks" pile-up. Scope is the channel: a channelId selects the
  // channel-bound session; channelId = null selects the DM-scoped session (which has
  // no "Current channel" in its prompt, so its reply can't pick up #general). Returns
  // the most recently created match (a tie-breaker for legacy duplicate rows), or
  // undefined when none exists (first run / agent torn down → caller spawns fresh).
  getLiveCyboBinding(
    workspaceId: string,
    cyboId: string,
    channelId: string | null,
  ): StoredAgentBinding | undefined {
    const sql =
      channelId === null
        ? "SELECT * FROM agent_bindings WHERE workspace_id = ? AND cybo_id = ? AND channel_id IS NULL AND ephemeral = 0 ORDER BY created_at DESC LIMIT 1"
        : "SELECT * FROM agent_bindings WHERE workspace_id = ? AND cybo_id = ? AND channel_id = ? AND ephemeral = 0 ORDER BY created_at DESC LIMIT 1";
    const stmt = this.db.prepare(sql);
    const row =
      channelId === null ? stmt.get(workspaceId, cyboId) : stmt.get(workspaceId, cyboId, channelId);
    return row as StoredAgentBinding | undefined;
  }

  deleteAgentBinding(agentId: string): void {
    this.deleteAgentBindingStmt.run(agentId);
  }

  // Drop ALL ephemeral bindings. Called at boot: ephemeral agents are
  // in-process and never survive a restart, so any ephemeral binding found at
  // startup is a leak from a teardown that never ran (daemon killed mid-turn).
  // Without this sweep they accumulate forever as ghost "Agent sessions".
  deleteEphemeralAgentBindings(): number {
    return this.db.prepare("DELETE FROM agent_bindings WHERE ephemeral = 1").run().changes;
  }

  // ─── Ephemeral session context capture (#994) ────────────────────

  // Capture an ephemeral session's injected context at spawn (system prompt +
  // the MCP servers made available). Idempotent on agent_id; the routed/raw
  // prompt is threaded in later via updateEphemeralSessionContextPrompts. This
  // row deliberately OUTLIVES teardownEphemeralAgent (which drops the binding).
  saveEphemeralSessionContext(row: {
    agentId: string;
    workspaceId: string;
    channelId?: string | null;
    cyboId?: string | null;
    systemPrompt?: string | null;
    mcpServersJson?: string | null;
  }): void {
    this.insertEphemeralSessionContextStmt.run(
      row.agentId,
      row.workspaceId,
      row.channelId ?? null,
      row.cyboId ?? null,
      row.systemPrompt ?? null,
      row.mcpServersJson ?? null,
      null,
      null,
      Date.now(),
    );
  }

  // Fill in the routed (framed) + raw prompt once routeToAgent has them. No-op
  // when no capture row exists (non-ephemeral agents never get one).
  updateEphemeralSessionContextPrompts(
    agentId: string,
    routedPrompt: string | null,
    rawPrompt: string | null,
  ): void {
    this.updateEphemeralSessionContextPromptsStmt.run(routedPrompt, rawPrompt, agentId);
  }

  getEphemeralSessionContext(agentId: string): StoredEphemeralSessionContext | undefined {
    return this.getEphemeralSessionContextStmt.get(agentId) as
      | StoredEphemeralSessionContext
      | undefined;
  }

  // GC: drop capture rows older than `olderThanMs` (TTL bound) so the store
  // stays bounded. Returns the number of rows pruned.
  pruneEphemeralSessionContext(opts: { olderThanMs: number; now?: number }): number {
    const cutoff = (opts.now ?? Date.now()) - opts.olderThanMs;
    return this.pruneEphemeralSessionContextStmt.run(cutoff).changes;
  }

  deleteEphemeralSessionContext(agentId: string): void {
    this.deleteEphemeralSessionContextStmt.run(agentId);
  }

  // ─── Cybos ───────────────────────────────────────────────────────

  createCybo(opts: {
    workspaceId: string;
    slug: string;
    name: string;
    soul: string;
    provider: string;
    createdBy: string;
    description?: string | null;
    avatar?: string | null;
    role?: string | null;
    model?: string | null;
    mcpServers?: Record<string, unknown> | null;
    toolGrants?: Record<string, unknown> | null;
    llmAuthMode?: string;
    behaviorMode?: string;
    homeDaemonId?: string | null;
    autonomyLevel?: string | null;
    monthlySpendCap?: number | null;
    platformPermissions?: string[];
    isDefault?: boolean;
  }): StoredCybo {
    const id = `cybo_${randomUUID()}`;
    const now = Date.now();
    this.insertCyboStmt.run(
      id,
      opts.workspaceId,
      opts.slug,
      opts.name,
      opts.description ?? null,
      opts.avatar ?? null,
      opts.role ?? null,
      opts.soul,
      opts.provider,
      opts.model ?? null,
      opts.mcpServers ? JSON.stringify(opts.mcpServers) : null,
      opts.toolGrants ? JSON.stringify(opts.toolGrants) : null,
      opts.llmAuthMode ?? "cli",
      opts.behaviorMode ?? "responsive",
      opts.homeDaemonId ?? null,
      opts.autonomyLevel ?? null,
      opts.monthlySpendCap ?? null,
      JSON.stringify(opts.platformPermissions ?? []),
      opts.isDefault ? 1 : 0,
      opts.createdBy,
      now,
      now,
    );
    return this.getCyboStmt.get(id) as StoredCybo;
  }

  getCybo(id: string): StoredCybo | undefined {
    return this.getCyboStmt.get(id) as StoredCybo | undefined;
  }

  // Persist a workspace cybo that was resolved elsewhere (the relay enriches an
  // @-mention/spawn from PG) into local SQLite, so getCybo — and therefore the
  // cybo's display name/avatar on its messages — works for a cloud/disk cybo the
  // daemon never created locally. No-op when already present (cheap, idempotent).
  persistCybo(cybo: StoredCybo): void {
    // Disk-local cybos (`local:<slug>`) have no PG workspace row and must never
    // occupy a workspace cybos slot.
    if (cybo.id.startsWith("local:")) return;
    // Already cached under this exact id → nothing to do (cheap, idempotent).
    if (this.getCybo(cybo.id)) return;
    // The cybos table is UNIQUE(workspace_id, slug). Local SQLite can already hold
    // a STALE duplicate under the SAME (workspace_id, slug) but a DIFFERENT id — a
    // failed PG mirror or a pre-PG daemon-local row (see cybo-roster-merge.ts). PG
    // is authoritative for workspace cybos and the caller passes the PG-resolved
    // row, so drop the stale duplicate and converge on the canonical id. A plain
    // INSERT here threw "UNIQUE constraint failed: cybos.workspace_id, cybos.slug",
    // which aborted the whole @-mention spawn (the cybo never answered).
    const stale = this.getCyboBySlug(cybo.workspace_id, cybo.slug);
    // Converge + insert ATOMICALLY. Every other table stores cybo_id as a PLAIN
    // TEXT column, NOT a foreign key (no ON DELETE CASCADE) — so dropping the
    // stale row WITHOUT re-pointing them would ORPHAN those references and later
    // throw CyboNotFoundError when a schedule fires or an archived session
    // resumes. Re-point each cybo_id reference onto the canonical id, drop the
    // stale row, and insert the canonical row in ONE transaction so a mid-way
    // failure rolls back to the valid pre-state instead of leaving dangling refs.
    // The four tables below are the COMPLETE set with a cybo_id column (verified
    // against every CREATE TABLE / ALTER TABLE in this file); none has a UNIQUE
    // index on cybo_id, so the UPDATE can never hit a conflict.
    this.db.transaction(() => {
      if (stale && stale.id !== cybo.id) {
        for (const table of [
          "agent_bindings",
          "schedules",
          "archived_sessions",
          "ephemeral_session_context",
        ]) {
          this.db
            .prepare(`UPDATE ${table} SET cybo_id = ? WHERE cybo_id = ?`)
            .run(cybo.id, stale.id);
        }
        // messages carries the cybo id BY VALUE (no cybo_id column): a cybo's own
        // replies store from_id = cybo.id (workspace-relay.ts), and a human's DM
        // to a cybo stores the cybo as the to_id peer. The client renders the
        // author by matching cybo.id === message.from_id, so an un-repointed
        // from_id would render the stale cybo's history as an unknown author.
        // Mirror reassignUserId's from_id/to_id re-point. The match is on the
        // unique stale cybo id, so it can never touch a human/agent row (and is a
        // harmless no-op when no such message exists).
        this.db.prepare("UPDATE messages SET from_id = ? WHERE from_id = ?").run(cybo.id, stale.id);
        this.db.prepare("UPDATE messages SET to_id = ? WHERE to_id = ?").run(cybo.id, stale.id);
        this.deleteCyboStmt.run(stale.id);
      }
      this.insertCyboStmt.run(
        cybo.id,
        cybo.workspace_id,
        cybo.slug,
        cybo.name,
        cybo.description ?? null,
        cybo.avatar ?? null,
        cybo.role ?? null,
        cybo.soul,
        cybo.provider,
        cybo.model ?? null,
        cybo.mcp_servers ?? null,
        cybo.tool_grants ?? null,
        cybo.llm_auth_mode ?? "cli",
        cybo.behavior_mode ?? "responsive",
        cybo.home_daemon_id ?? null,
        cybo.autonomy_level ?? null,
        cybo.monthly_spend_cap ?? null,
        cybo.platform_permissions ?? JSON.stringify([]),
        cybo.is_default ? 1 : 0,
        cybo.created_by,
        cybo.created_at ?? Date.now(),
        cybo.updated_at ?? Date.now(),
      );
    })();
  }

  getCyboBySlug(workspaceId: string, slug: string): StoredCybo | undefined {
    return this.getCyboBySlugStmt.get(workspaceId, slug) as StoredCybo | undefined;
  }

  getCybos(workspaceId: string): StoredCybo[] {
    // NOTE: StoredCybo.last_active_at (= max(agent_sessions.updated_at) per cybo)
    // is intentionally LEFT ABSENT on this SQLite path. The local agent_sessions
    // table (see CREATE TABLE above) has NEITHER a cybo_id NOR an updated_at
    // column, and nothing ever writes rows to it on the daemon — agent-session
    // history is PG-only (DualStorage.recordAgentSessionStart → PG). A correlated
    // subquery here would throw "no such column" at prepare time and break the
    // whole daemon. So lastActiveAt is a CLOUD-ONLY field: it's computed in
    // pg-sync.getCybos and merged over these rows by mergePgCybosIntoRoster
    // (PG wins on id/slug collision), and the wire field is optional → the UI
    // renders "—" for daemon-only rows. Adding it here would require a SQLite
    // schema migration + a SQLite agent_sessions writer (out of scope).
    return this.getCybosByWorkspaceStmt.all(workspaceId) as StoredCybo[];
  }

  updateCybo(
    id: string,
    updates: {
      name?: string;
      description?: string | null;
      avatar?: string | null;
      role?: string | null;
      soul?: string;
      provider?: string;
      model?: string | null;
      mcpServers?: Record<string, unknown> | null;
      toolGrants?: Record<string, unknown> | null;
      llmAuthMode?: string;
      behaviorMode?: string;
      homeDaemonId?: string | null;
      autonomyLevel?: string | null;
      monthlySpendCap?: number | null;
      platformPermissions?: string[];
    },
  ): StoredCybo | undefined {
    const existing = this.getCybo(id);
    if (!existing) return undefined;
    let mcpServersStr = existing.mcp_servers;
    if (updates.mcpServers !== undefined) {
      mcpServersStr = updates.mcpServers ? JSON.stringify(updates.mcpServers) : null;
    }
    let toolGrantsStr = existing.tool_grants ?? null;
    if (updates.toolGrants !== undefined) {
      toolGrantsStr = updates.toolGrants ? JSON.stringify(updates.toolGrants) : null;
    }
    this.updateCyboStmt.run(
      updates.name ?? existing.name,
      updates.description !== undefined ? updates.description : existing.description,
      updates.avatar !== undefined ? updates.avatar : existing.avatar,
      updates.role !== undefined ? updates.role : existing.role,
      updates.soul ?? existing.soul,
      updates.provider ?? existing.provider,
      updates.model !== undefined ? updates.model : existing.model,
      mcpServersStr,
      toolGrantsStr,
      updates.llmAuthMode ?? existing.llm_auth_mode,
      updates.behaviorMode ?? existing.behavior_mode,
      updates.homeDaemonId !== undefined ? updates.homeDaemonId : existing.home_daemon_id,
      updates.autonomyLevel !== undefined ? updates.autonomyLevel : existing.autonomy_level,
      updates.monthlySpendCap !== undefined ? updates.monthlySpendCap : existing.monthly_spend_cap,
      updates.platformPermissions !== undefined
        ? JSON.stringify(updates.platformPermissions)
        : existing.platform_permissions,
      Date.now(),
      id,
    );
    return this.getCyboStmt.get(id) as StoredCybo;
  }

  deleteCybo(id: string): void {
    this.deleteCyboStmt.run(id);
  }

  // ─── Archived Sessions ───────────────────────────────────────────

  archiveSession(opts: {
    workspaceId: string;
    provider: string;
    providerHandleId: string;
    title?: string | null;
    cwd?: string | null;
    model?: string | null;
    cyboId?: string | null;
    initiatedBy?: string | null;
    initiatedByEmail?: string | null;
  }): StoredArchivedSession {
    const id = `as_${randomUUID()}`;
    const now = Date.now();
    this.insertArchivedSessionStmt.run(
      id,
      opts.workspaceId,
      opts.provider,
      opts.providerHandleId,
      opts.title ?? null,
      opts.cwd ?? null,
      opts.model ?? null,
      opts.cyboId ?? null,
      now,
      opts.initiatedBy ?? null,
      opts.initiatedByEmail ?? null,
    );
    return this.getArchivedSessionByIdStmt.get(id) as StoredArchivedSession;
  }

  getArchivedSessions(workspaceId: string): StoredArchivedSession[] {
    return this.getArchivedSessionsByWorkspaceStmt.all(workspaceId) as StoredArchivedSession[];
  }

  // Paginated read of the archived list, newest-first. Keyset pagination on
  // (archived_at DESC, id DESC): `cursor` is the opaque token from a prior page's
  // `nextCursor`; the next call resumes strictly AFTER the cursor row. Returns a
  // `nextCursor` only when `limit` was set AND a full page came back (a short page
  // is the tail). Back-compatible: no limit ⇒ the full list + nextCursor = null,
  // matching getArchivedSessions. Bounds the formerly-unbounded archived list query.
  getArchivedSessionsPage(
    workspaceId: string,
    filter?: { limit?: number; cursor?: string },
  ): { sessions: StoredArchivedSession[]; nextCursor: string | null } {
    let sql = "SELECT * FROM archived_sessions WHERE workspace_id = ?";
    const params: unknown[] = [workspaceId];
    const cur = decodeArchivedSessionCursor(filter?.cursor);
    if (cur) {
      // Strictly after the cursor in (archived_at DESC, id DESC) order.
      sql += " AND (archived_at < ? OR (archived_at = ? AND id < ?))";
      params.push(cur.archivedAt, cur.archivedAt, cur.id);
    }
    sql += " ORDER BY archived_at DESC, id DESC";
    const limit = filter?.limit;
    // Number.isFinite guards a crafted Infinity/NaN limit from reaching the query.
    if (limit !== undefined && Number.isFinite(limit) && limit > 0) {
      // Fetch one extra to know whether a further page exists without a 2nd query.
      sql += " LIMIT ?";
      params.push(limit + 1);
    }
    const rows = this.db.prepare(sql).all(...params) as StoredArchivedSession[];
    if (limit !== undefined && Number.isFinite(limit) && limit > 0 && rows.length > limit) {
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        sessions: page,
        nextCursor: encodeArchivedSessionCursor({ archivedAt: last.archived_at, id: last.id }),
      };
    }
    return { sessions: rows, nextCursor: null };
  }

  // Workspace-scoped by default: a session is only restorable/readable within its
  // OWN workspace, so a row in another workspace returns undefined (can't be
  // reached cross-workspace by id alone). The internal id-only lookup remains for
  // resumed-agent revival where the workspace is already established.
  getArchivedSession(id: string, workspaceId: string): StoredArchivedSession | undefined {
    return this.getArchivedSessionByIdInWorkspaceStmt.get(id, workspaceId) as
      | StoredArchivedSession
      | undefined;
  }

  // Look up the archived row that was resumed into a given live agent (if any),
  // so re-archiving that agent can REVIVE the original history row instead of
  // inserting a duplicate.
  getArchivedSessionByResumedAgent(agentId: string): StoredArchivedSession | undefined {
    return this.getArchivedSessionByResumedAgentStmt.get(agentId) as
      | StoredArchivedSession
      | undefined;
  }

  // Link an archived session to the live agent it was resumed into. The row is
  // kept (NOT deleted) so the session can never be lost: while the binding for
  // `agentId` exists it shows in the active list, and it returns to history when
  // re-archived (reviveArchivedSession) or when the binding is gone.
  markArchivedSessionResumed(id: string, agentId: string): void {
    this.markArchivedSessionResumedStmt.run(agentId, id);
  }

  // Send a resumed session back to history: clear the live link and refresh its
  // archived metadata/timestamp.
  reviveArchivedSession(opts: {
    id: string;
    providerHandleId: string;
    title?: string | null;
    cwd?: string | null;
    model?: string | null;
    cyboId?: string | null;
  }): StoredArchivedSession | undefined {
    this.reviveArchivedSessionStmt.run(
      opts.providerHandleId,
      opts.title ?? null,
      opts.cwd ?? null,
      opts.model ?? null,
      opts.cyboId ?? null,
      Date.now(),
      opts.id,
    );
    return this.getArchivedSessionByIdStmt.get(opts.id) as StoredArchivedSession | undefined;
  }

  deleteArchivedSession(id: string): void {
    this.deleteArchivedSessionStmt.run(id);
  }

  // ─── Projects ───────────────────────────────────────────────────

  createProject(workspaceId: string, name: string, color: string): StoredProject {
    const id = `proj_${randomUUID()}`;
    const now = Date.now();
    this.insertProjectStmt.run(id, workspaceId, name, color, now);
    return { id, workspace_id: workspaceId, name, color, created_at: now };
  }

  getProjects(workspaceId: string): StoredProject[] {
    return this.getProjectsByWorkspaceStmt.all(workspaceId) as StoredProject[];
  }

  updateProject(id: string, name: string, color: string): void {
    this.updateProjectStmt.run(name, color, id);
  }

  deleteProject(id: string): void {
    // Tasks Redesign P0 — code-level cascade that mirrors PG's FK chain when a
    // chat `projects` row is hard-deleted. On PG, projects → tasks_projects
    // (chat_project_id, ON DELETE CASCADE) → tasks/states/labels/cycles/modules
    // → the task satellites, all cascade in the DB. On SQLite the new satellite
    // tables DO carry FK cascade, BUT `tasks.project_id` is a plain TEXT column
    // with NO foreign key (tasks is created before tasks_projects, and SQLite
    // can't add an FK via ALTER ADD COLUMN), so a bare DELETE FROM projects would
    // leave orphaned tasks (and, transitively, their satellites). So replicate the
    // whole chain here in one transaction: delete children before parents, in the
    // same order PG would, so a daemon hard-delete removes the tasks too — no
    // orphans, matching cloud. Idempotent/best-effort: every DELETE is keyed off
    // the gathered ids and deleting already-gone rows is a no-op (re-runnable).
    const cascade = this.db.transaction((): void => {
      // 1. The tasks_projects for this chat project (1:1 via chat_project_id, but
      //    query as a set to stay correct if duplicates ever existed).
      const tpRows = this.db
        .prepare("SELECT id FROM tasks_projects WHERE chat_project_id = ?")
        .all(id) as Array<{ id: string }>;
      const projectIds = tpRows.map((r) => r.id);

      if (projectIds.length > 0) {
        // `projectIds` is the small tasks_projects set (1:1 with the chat project).
        // Every child delete is keyed off it via a SUBQUERY rather than fetching
        // task/label/module ids into an `IN (...)` list, which would bind one
        // variable per row and blow SQLite's 999-variable limit for >999 tasks.
        const tpPlaceholders = projectIds.map(() => "?").join(", ");
        const taskIdSubquery = `SELECT id FROM tasks WHERE project_id IN (${tpPlaceholders})`;

        // 2. Delete each task's satellites first, then the tasks. (These tables DO
        //    FK-cascade off tasks(id), but delete them explicitly so the cascade
        //    holds even if FK enforcement were off, and to mirror PG exactly.)
        for (const table of [
          "task_label_assignees",
          "task_links",
          "task_attachments",
          "task_activity",
          "task_modules",
        ]) {
          this.db
            .prepare(`DELETE FROM ${table} WHERE task_id IN (${taskIdSubquery})`)
            .run(...projectIds);
        }
        this.db
          .prepare(`DELETE FROM tasks WHERE project_id IN (${tpPlaceholders})`)
          .run(...projectIds);

        // 3. Per-project children: states, labels (+ their assignees), cycles,
        //    modules (+ their task_modules). Delete the label-/module-keyed join
        //    rows before their catalogs to honor the FK direction — keyed off the
        //    catalog's project_id via subquery, again to avoid an id `IN (...)`.
        this.db
          .prepare(
            `DELETE FROM task_label_assignees WHERE label_id IN (SELECT id FROM task_labels WHERE project_id IN (${tpPlaceholders}))`,
          )
          .run(...projectIds);
        this.db
          .prepare(
            `DELETE FROM task_modules WHERE module_id IN (SELECT id FROM modules WHERE project_id IN (${tpPlaceholders}))`,
          )
          .run(...projectIds);
        for (const table of ["task_states", "task_labels", "cycles", "modules"]) {
          this.db
            .prepare(`DELETE FROM ${table} WHERE project_id IN (${tpPlaceholders})`)
            .run(...projectIds);
        }

        // 4. Finally the tasks_projects rows themselves.
        this.db
          .prepare(`DELETE FROM tasks_projects WHERE id IN (${tpPlaceholders})`)
          .run(...projectIds);
      }

      // 6. The chat-project's channel links and the projects row (unchanged path).
      this.clearProjectChannelsStmt.run(id);
      this.deleteProjectStmt.run(id);
    });
    cascade();
  }

  setChannelProject(channelId: string, projectId: string): void {
    this.setChannelProjectStmt.run(channelId, projectId);
  }

  clearChannelProject(channelId: string): void {
    this.clearChannelProjectStmt.run(channelId);
  }

  getChannelProjects(workspaceId: string): StoredChannelProject[] {
    return this.getChannelProjectsStmt.all(workspaceId) as StoredChannelProject[];
  }

  // ─── Tasks Redesign P0 — Tasks-projects + workflow states (SQLite mirrors) ──

  // The five canonical default workflow states seeded into every new Tasks-project
  // (one per Plane phase, in board order). is_default marks the state a new task
  // starts in (the "unstarted" Todo). Colors are hex pills. Mirrors the same seed
  // the PG backfill (0031) and pg-sync provisioning use, so a project provisioned
  // on a solo daemon looks identical to one provisioned in the cloud.
  private static readonly DEFAULT_TASK_STATES: ReadonlyArray<{
    name: string;
    color: string;
    group: string;
    isDefault: boolean;
  }> = [
    { name: "Backlog", color: "#94a3b8", group: "backlog", isDefault: false },
    { name: "Todo", color: "#3b82f6", group: "unstarted", isDefault: true },
    { name: "In Progress", color: "#f59e0b", group: "started", isDefault: false },
    { name: "Done", color: "#22c55e", group: "completed", isDefault: false },
    { name: "Cancelled", color: "#ef4444", group: "cancelled", isDefault: false },
  ];

  // Derive a task-key prefix (uppercase, <=8, alnum) from a project name. Empty /
  // non-alnum names fall back to "TASK". The per-workspace uniqueness is enforced
  // by the caller (provisionTasksProject de-dupes against existing identifiers).
  private static deriveIdentifier(name: string): string {
    const base = name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    return base.length > 0 ? base : "TASK";
  }

  getTasksProject(id: string): StoredTasksProject | undefined {
    return this.getTasksProjectStmt.get(id) as StoredTasksProject | undefined;
  }

  getTasksProjects(workspaceId: string): StoredTasksProject[] {
    return this.getTasksProjectsByWorkspaceStmt.all(workspaceId) as StoredTasksProject[];
  }

  getTaskStates(projectId: string): StoredTaskState[] {
    return this.getTaskStatesByProjectStmt.all(projectId) as StoredTaskState[];
  }

  // ─── Tasks Redesign catalog reads (board/detail) ─────────────────────
  // Daemon/SQLite mirrors of the PG catalog fetches, returning the client's
  // camelCase shapes (packages/ui/src/lib/core/types.ts). SQLite stores date
  // columns as INTEGER ms already (no Date objects), and is_default as 0|1 — the
  // mappers below normalize those (number→boolean, missing→null). Each caller
  // resolves the wire projectId → tasks_projects.id before calling these (states
  // keys off the resolved id).

  // A project's workflow states (board columns), ordered by `sequence`.
  getProjectStates(projectId: string): Array<{
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    color: string;
    group: string;
    sequence: number;
    isDefault: boolean;
  }> {
    const rows = this.getTaskStatesByProjectStmt.all(projectId) as StoredTaskState[];
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      workspaceId: r.workspace_id,
      name: r.name,
      color: r.color,
      group: r.group,
      sequence: r.sequence,
      isDefault: r.is_default === 1,
    }));
  }

  // A project's label catalog (tags), ordered by `sortOrder`.
  getProjectLabels(projectId: string): Array<{
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    color: string;
    sortOrder: number;
  }> {
    const rows = this.getTaskLabelsFullByProjectStmt.all(projectId) as Array<{
      id: string;
      project_id: string;
      workspace_id: string;
      name: string;
      color: string;
      sort_order: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      workspaceId: r.workspace_id,
      name: r.name,
      color: r.color,
      sortOrder: r.sort_order,
    }));
  }

  // A project's cycles (sprints). Date columns are INTEGER ms (or null) in SQLite.
  getProjectCycles(projectId: string): Array<{
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    endDate: number | null;
    ownedBy: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
    createdAt: number;
  }> {
    const rows = this.getCyclesByProjectStmt.all(projectId) as Array<{
      id: string;
      project_id: string;
      workspace_id: string;
      name: string;
      description: string | null;
      start_date: number | null;
      end_date: number | null;
      owned_by: string | null;
      sort_order: number | null;
      archived_at: number | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description,
      startDate: r.start_date,
      endDate: r.end_date,
      ownedBy: r.owned_by,
      sortOrder: r.sort_order,
      archivedAt: r.archived_at,
      createdAt: r.created_at,
    }));
  }

  // A project's modules (feature groupings). Date columns are INTEGER ms (or null).
  getProjectModules(projectId: string): Array<{
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    targetDate: number | null;
    status: string;
    lead: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
  }> {
    const rows = this.getModulesByProjectStmt.all(projectId) as Array<{
      id: string;
      project_id: string;
      workspace_id: string;
      name: string;
      description: string | null;
      start_date: number | null;
      target_date: number | null;
      status: string;
      lead: string | null;
      sort_order: number | null;
      archived_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description,
      startDate: r.start_date,
      targetDate: r.target_date,
      status: r.status,
      lead: r.lead,
      sortOrder: r.sort_order,
      archivedAt: r.archived_at,
    }));
  }

  // ─── Cycles catalog CRUD ──────────────────────────────────────────
  // The wire `projectId` is the CHAT project id; it is resolved to the local
  // tasks_projects.id (and its workspace) before the row is written. Returns the
  // new row in the client `Cycle` shape (camelCase, dates already ms in SQLite).
  // Throws "project not found" for an unknown id (caller turns it into an error).
  createCycle(opts: {
    projectId: string;
    name: string;
    description?: string | null;
    startDate?: number | null;
    endDate?: number | null;
  }): {
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    endDate: number | null;
    ownedBy: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
    createdAt: number;
  } {
    const resolvedId = this.resolveTasksProjectId(opts.projectId);
    if (!resolvedId) throw new Error("project not found");
    const project = this.getTasksProject(resolvedId);
    if (!project) throw new Error("project not found");
    const id = `cyc_${randomUUID()}`;
    const now = Date.now();
    this.insertCycleStmt.run(
      id,
      resolvedId,
      project.workspace_id,
      opts.name,
      opts.description ?? null,
      opts.startDate ?? null,
      opts.endDate ?? null,
      now,
    );
    return this.mapCycleRow(this.getCycleStmt.get(id) as RawCycleRow);
  }

  // Update a cycle's editable fields (name/description/start/end). Only present
  // keys are written. Returns the updated row in the client `Cycle` shape, or null
  // when the cycle is missing.
  updateCycle(
    cycleId: string,
    updates: {
      name?: string;
      description?: string | null;
      startDate?: number | null;
      endDate?: number | null;
    },
  ): {
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    endDate: number | null;
    ownedBy: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
    createdAt: number;
  } | null {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (updates.name !== undefined) {
      sets.push("name = ?");
      args.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push("description = ?");
      args.push(updates.description);
    }
    if (updates.startDate !== undefined) {
      sets.push("start_date = ?");
      args.push(updates.startDate ?? null);
    }
    if (updates.endDate !== undefined) {
      sets.push("end_date = ?");
      args.push(updates.endDate ?? null);
    }
    if (sets.length > 0) {
      args.push(cycleId);
      this.db.prepare(`UPDATE cycles SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    }
    const row = this.getCycleStmt.get(cycleId) as RawCycleRow | undefined;
    return row ? this.mapCycleRow(row) : null;
  }

  // Hard-delete a cycle (tasks' cycle_id nulls via schema ON DELETE SET NULL).
  // Idempotent: a missing cycle is a no-op.
  deleteCycle(cycleId: string): void {
    this.deleteCycleStmt.run(cycleId);
  }

  private mapCycleRow(r: RawCycleRow): {
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    endDate: number | null;
    ownedBy: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
    createdAt: number;
  } {
    return {
      id: r.id,
      projectId: r.project_id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description,
      startDate: r.start_date,
      endDate: r.end_date,
      ownedBy: r.owned_by,
      sortOrder: r.sort_order,
      archivedAt: r.archived_at,
      createdAt: r.created_at,
    };
  }

  // ─── Project pages catalog CRUD ───────────────────────────────────
  // A project's pages (wiki/docs) VISIBLE to `userId`: public pages, legacy
  // null-owner pages, plus the user's own private pages. A non-null-owner private
  // page is hidden from everyone but its owner (mirrors Plane's list filter). The
  // UI filters archived itself; ordered non-archived first, then newest-updated.
  getProjectPages(projectId: string, userId: string): PageShape[] {
    const rows = this.getPagesByProjectStmt.all(projectId, userId) as RawPageRow[];
    return rows.map((r) => this.mapPageRow(r));
  }

  // A single page by id, or null when missing.
  getPage(pageId: string): PageShape | null {
    const row = this.getPageStmt.get(pageId) as RawPageRow | undefined;
    return row ? this.mapPageRow(row) : null;
  }

  // The wire `projectId` is the CHAT project id; it is resolved to the local
  // tasks_projects.id (and its workspace) before the row is written. Returns the
  // new row in the client `Page` shape. Throws "project not found" for an unknown
  // id (caller turns it into an error). ownedBy carries the creator.
  createPage(opts: {
    projectId: string;
    title?: string;
    ownedBy?: string | null;
    parentId?: string | null;
  }): PageShape {
    const resolvedId = this.resolveTasksProjectId(opts.projectId);
    if (!resolvedId) throw new Error("project not found");
    const project = this.getTasksProject(resolvedId);
    if (!project) throw new Error("project not found");
    // A nested page's parent must live in the SAME project (mirrors PgSync).
    if (opts.parentId) {
      const parent = this.db
        .prepare("SELECT project_id FROM tasks_pages WHERE id = ?")
        .get(opts.parentId) as { project_id: string } | undefined;
      if (!parent || parent.project_id !== resolvedId) {
        throw new Error("parent page not found in this project");
      }
    }
    const id = `page_${randomUUID()}`;
    const now = Date.now();
    this.insertPageStmt.run(
      id,
      resolvedId,
      project.workspace_id,
      opts.title ?? "",
      "",
      "private",
      opts.parentId ?? null,
      opts.ownedBy ?? null,
      now,
      now,
    );
    return this.mapPageRow(this.getPageStmt.get(id) as RawPageRow);
  }

  // Update a page's editable fields (title/content/visibility). Only present keys
  // are written; `updated_at` is always bumped. Returns the updated row in the
  // client `Page` shape, or null when the page is missing.
  updatePage(
    pageId: string,
    updates: {
      title?: string;
      content?: string;
      visibility?: string;
      icon?: string | null;
      parentId?: string | null;
      sortOrder?: number;
    },
  ): PageShape | null {
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    if (updates.title !== undefined) {
      sets.push("title = ?");
      args.push(updates.title);
    }
    if (updates.content !== undefined) {
      sets.push("content = ?");
      args.push(updates.content);
    }
    if (updates.visibility !== undefined) {
      sets.push("visibility = ?");
      args.push(updates.visibility);
    }
    if (updates.icon !== undefined) {
      sets.push("icon = ?");
      args.push(updates.icon);
    }
    if (updates.sortOrder !== undefined) {
      sets.push("sort_order = ?");
      args.push(updates.sortOrder);
    }
    const existing = this.getPageStmt.get(pageId) as RawPageRow | undefined;
    if (!existing) return null;
    if (updates.parentId !== undefined) {
      // Cycle guard (mirrors PgSync.updatePage): reject self-parent or parenting
      // under one of the page's own descendants. Fetch the project's pages flat
      // ONCE, walk in memory — no per-row queries.
      if (updates.parentId !== null) {
        if (updates.parentId === pageId) throw new PageCycleError(pageId, updates.parentId);
        const flat = this.db
          .prepare("SELECT id, parent_id FROM tasks_pages WHERE project_id = ?")
          .all(existing.project_id) as Array<{ id: string; parent_id: string | null }>;
        const tree = flat.map((r) => ({ id: r.id, parentId: r.parent_id }));
        if (!tree.some((p) => p.id === updates.parentId)) {
          throw new Error("parent page not found in this project");
        }
        if (isPageDescendant(tree, pageId, updates.parentId)) {
          throw new PageCycleError(pageId, updates.parentId);
        }
      }
      sets.push("parent_id = ?");
      args.push(updates.parentId);
    }
    // No updatable fields provided: skip a pointless write + updated_at bump and
    // return the existing row unchanged (mirrors the PG-sync updatePage guard).
    if (sets.length === 0) return this.mapPageRow(existing);
    sets.push("updated_at = ?");
    args.push(Date.now());
    args.push(pageId);
    this.db.prepare(`UPDATE tasks_pages SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    const row = this.getPageStmt.get(pageId) as RawPageRow | undefined;
    return row ? this.mapPageRow(row) : null;
  }

  // Toggle a page's soft-archive (archived_at). Reversible — pass archived=false
  // to restore. Bumps updated_at. Returns the updated row, or null when missing.
  setPageArchived(pageId: string, archived: boolean): PageShape | null {
    const existing = this.getPageStmt.get(pageId) as RawPageRow | undefined;
    if (!existing) return null;
    this.db
      .prepare("UPDATE tasks_pages SET archived_at = ?, updated_at = ? WHERE id = ?")
      .run(archived ? Date.now() : null, Date.now(), pageId);
    const row = this.getPageStmt.get(pageId) as RawPageRow | undefined;
    return row ? this.mapPageRow(row) : null;
  }

  // Hard-delete a page. Idempotent: a missing page is a no-op.
  deletePage(pageId: string): void {
    this.deletePageStmt.run(pageId);
  }

  // Resolve a page → its (tasks_projects) project id, so the dispatcher can gate
  // fetch/update/archive/delete via gateProjectView. Null when the page is missing.
  getPageProjectId(pageId: string): string | null {
    const row = this.getPageStmt.get(pageId) as RawPageRow | undefined;
    return row?.project_id ?? null;
  }

  private mapPageRow(r: RawPageRow): PageShape {
    return {
      id: r.id,
      projectId: r.project_id,
      workspaceId: r.workspace_id,
      title: r.title,
      content: r.content,
      visibility: r.visibility,
      icon: r.icon ?? null,
      parentId: r.parent_id ?? null,
      sortOrder: r.sort_order ?? 0,
      ownedBy: r.owned_by,
      archivedAt: r.archived_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  // ─── Modules catalog CRUD ─────────────────────────────────────────
  // Same wire-id resolution as createCycle. `status` is free text (Plane parity),
  // defaulting to the column's "planned" when unset. Returns the client `Module`.
  createModule(opts: {
    projectId: string;
    name: string;
    description?: string | null;
    status?: string | null;
  }): {
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    targetDate: number | null;
    status: string;
    lead: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
  } {
    const resolvedId = this.resolveTasksProjectId(opts.projectId);
    if (!resolvedId) throw new Error("project not found");
    const project = this.getTasksProject(resolvedId);
    if (!project) throw new Error("project not found");
    const id = `mod_${randomUUID()}`;
    this.insertModuleStmt.run(
      id,
      resolvedId,
      project.workspace_id,
      opts.name,
      opts.description ?? null,
      opts.status ?? "planned",
    );
    return this.mapModuleRow(this.getModuleStmt.get(id) as RawModuleRow);
  }

  // Update a module's editable fields (name/description/status). Returns the
  // updated row in the client `Module` shape, or null when the module is missing.
  updateModule(
    moduleId: string,
    updates: { name?: string; description?: string | null; status?: string },
  ): {
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    targetDate: number | null;
    status: string;
    lead: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
  } | null {
    const sets: string[] = [];
    const args: Array<string | null> = [];
    if (updates.name !== undefined) {
      sets.push("name = ?");
      args.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push("description = ?");
      args.push(updates.description);
    }
    if (updates.status !== undefined) {
      sets.push("status = ?");
      args.push(updates.status);
    }
    if (sets.length > 0) {
      args.push(moduleId);
      this.db.prepare(`UPDATE modules SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    }
    const row = this.getModuleStmt.get(moduleId) as RawModuleRow | undefined;
    return row ? this.mapModuleRow(row) : null;
  }

  // Hard-delete a module (its task_modules join rows cascade). Idempotent.
  deleteModule(moduleId: string): void {
    this.deleteModuleStmt.run(moduleId);
  }

  private mapModuleRow(r: RawModuleRow): {
    id: string;
    projectId: string;
    workspaceId: string;
    name: string;
    description: string | null;
    startDate: number | null;
    targetDate: number | null;
    status: string;
    lead: string | null;
    sortOrder: number | null;
    archivedAt: number | null;
  } {
    return {
      id: r.id,
      projectId: r.project_id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description,
      startDate: r.start_date,
      targetDate: r.target_date,
      status: r.status,
      lead: r.lead,
      sortOrder: r.sort_order,
      archivedAt: r.archived_at,
    };
  }

  // A single task's activity feed (history), ordered by `epoch` ascending.
  getTaskActivity(taskId: string): Array<{
    id: string;
    taskId: string;
    workspaceId: string;
    actorId: string | null;
    verb: string;
    field: string | null;
    oldValue: string | null;
    newValue: string | null;
    commentHtml: string | null;
    epoch: number;
  }> {
    const rows = this.getTaskActivityByTaskStmt.all(taskId) as Array<{
      id: string;
      task_id: string;
      workspace_id: string;
      actor_id: string | null;
      verb: string;
      field: string | null;
      old_value: string | null;
      new_value: string | null;
      comment_html: string | null;
      epoch: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      workspaceId: r.workspace_id,
      actorId: r.actor_id,
      verb: r.verb,
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      commentHtml: r.comment_html,
      epoch: r.epoch,
    }));
  }

  // Resolve a task → its (tasks_projects) project id, for the activity gate. The
  // dispatcher gates task_activity by resolving the task to its project, deriving
  // its workspace, then checkPermission. Returns null for a missing task.
  getTaskProjectId(taskId: string): string | null {
    const row = this.getTaskStmt.get(taskId) as StoredTask | undefined;
    return row?.project_id ?? null;
  }

  // Resolve a cycle → its (tasks_projects) project id, so the dispatcher can gate
  // update/delete via gateProjectView. Null when the cycle is missing.
  getCycleProjectId(cycleId: string): string | null {
    const row = this.getCycleStmt.get(cycleId) as RawCycleRow | undefined;
    return row?.project_id ?? null;
  }

  // Resolve a module → its (tasks_projects) project id, for the update/delete gate.
  getModuleProjectId(moduleId: string): string | null {
    const row = this.getModuleStmt.get(moduleId) as RawModuleRow | undefined;
    return row?.project_id ?? null;
  }

  // ─── Task links (external URLs) ───────────────────────────────────
  // The dispatcher resolves the task→project and gates visibility before calling
  // these. `createdBy` is the acting user. Returns the client `TaskLink` shape
  // (camelCase; dates already ms in SQLite).

  addTaskLink(opts: { taskId: string; url: string; title?: string | null; createdBy: string }): {
    id: string;
    taskId: string;
    url: string;
    title: string | null;
    createdBy: string;
    createdAt: number;
  } {
    const id = `tlink_${randomUUID()}`;
    const now = Date.now();
    this.insertTaskLinkStmt.run(id, opts.taskId, opts.url, opts.title ?? null, opts.createdBy, now);
    return this.mapTaskLinkRow(this.getTaskLinkStmt.get(id) as RawTaskLinkRow);
  }

  // Hard-delete a link. Idempotent: a missing link is a no-op.
  removeTaskLink(linkId: string): void {
    this.deleteTaskLinkStmt.run(linkId);
  }

  // A task's links, newest first.
  getTaskLinks(taskId: string): Array<{
    id: string;
    taskId: string;
    url: string;
    title: string | null;
    createdBy: string;
    createdAt: number;
  }> {
    const rows = this.getTaskLinksByTaskStmt.all(taskId) as RawTaskLinkRow[];
    return rows.map((r) => this.mapTaskLinkRow(r));
  }

  // Resolve a link → its task's (tasks_projects) project id, for the remove gate.
  getTaskLinkProjectId(linkId: string): string | null {
    const link = this.getTaskLinkStmt.get(linkId) as RawTaskLinkRow | undefined;
    if (!link) return null;
    return this.getTaskProjectId(link.task_id);
  }

  private mapTaskLinkRow(r: RawTaskLinkRow): {
    id: string;
    taskId: string;
    url: string;
    title: string | null;
    createdBy: string;
    createdAt: number;
  } {
    return {
      id: r.id,
      taskId: r.task_id,
      url: r.url,
      title: r.title,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  }

  // ─── Task attachments (S3 asset rows) ─────────────────────────────
  // The client uploads to the presigned URL first, then calls add with the key +
  // delivery url. The row persists asset_key + metadata; `url` is echoed for the
  // client (SQLite has no url column — the raw key doubles as the url where S3 is
  // disabled), matching the message-attachment contract.

  addTaskAttachment(opts: {
    taskId: string;
    key: string;
    url: string;
    name: string;
    size: number;
    contentType?: string | null;
    uploadedBy: string;
  }): {
    id: string;
    taskId: string;
    assetKey: string;
    url: string;
    name: string;
    size: number;
    contentType: string | null;
    uploadedBy: string;
    createdAt: number;
  } {
    const id = `tatt_${randomUUID()}`;
    const now = Date.now();
    this.insertTaskAttachmentStmt.run(
      id,
      opts.taskId,
      opts.key,
      opts.name,
      opts.size,
      opts.contentType ?? null,
      opts.uploadedBy,
      now,
    );
    return this.mapTaskAttachmentRow(
      this.getTaskAttachmentStmt.get(id) as RawTaskAttachmentRow,
      opts.url,
    );
  }

  // Hard-delete an attachment row (the S3 object lifecycle is separate).
  // Idempotent: a missing row is a no-op.
  removeTaskAttachment(attachmentId: string): void {
    this.deleteTaskAttachmentStmt.run(attachmentId);
  }

  // A task's attachments, newest first. The delivery `url` is derived from the
  // stored asset_key (S3 disabled locally → the raw key doubles as the url).
  getTaskAttachments(taskId: string): Array<{
    id: string;
    taskId: string;
    assetKey: string;
    url: string;
    name: string;
    size: number;
    contentType: string | null;
    uploadedBy: string;
    createdAt: number;
  }> {
    const rows = this.getTaskAttachmentsByTaskStmt.all(taskId) as RawTaskAttachmentRow[];
    return rows.map((r) => this.mapTaskAttachmentRow(r, r.asset_key));
  }

  // Resolve an attachment → its task's (tasks_projects) project id, for the remove
  // gate.
  getTaskAttachmentProjectId(attachmentId: string): string | null {
    const att = this.getTaskAttachmentStmt.get(attachmentId) as RawTaskAttachmentRow | undefined;
    if (!att) return null;
    return this.getTaskProjectId(att.task_id);
  }

  private mapTaskAttachmentRow(
    r: RawTaskAttachmentRow,
    url: string,
  ): {
    id: string;
    taskId: string;
    assetKey: string;
    url: string;
    name: string;
    size: number;
    contentType: string | null;
    uploadedBy: string;
    createdAt: number;
  } {
    return {
      id: r.id,
      taskId: r.task_id,
      assetKey: r.asset_key,
      url,
      name: r.name,
      size: r.size,
      contentType: r.content_type,
      uploadedBy: r.uploaded_by,
      createdAt: r.created_at,
    };
  }

  // Seed the five canonical default workflow states for a Tasks-project. Idempotent
  // per project: a no-op if the project already has states (so a re-provision after
  // a partial create doesn't duplicate columns). Returns the project's states.
  seedDefaultStates(projectId: string, workspaceId: string): StoredTaskState[] {
    const existing = this.getTaskStates(projectId);
    if (existing.length > 0) return existing;
    const txn = this.db.transaction((): void => {
      CyborgStorage.DEFAULT_TASK_STATES.forEach((s, i) => {
        this.insertTaskStateStmt.run(
          `tstate_${randomUUID()}`,
          projectId,
          workspaceId,
          s.name,
          s.color,
          s.group,
          i,
          s.isDefault ? 1 : 0,
        );
      });
    });
    txn();
    return this.getTaskStates(projectId);
  }

  // The default state a new task starts in (the is_default one, falling back to the
  // first by sequence). undefined only for a project with no states yet.
  getDefaultState(projectId: string): StoredTaskState | undefined {
    const states = this.getTaskStates(projectId);
    return states.find((s) => s.is_default === 1) ?? states[0];
  }

  // Provision (or fetch) the 1:1 Tasks-project for a chat project, seeding its
  // default states. Idempotent: if a Tasks-project already links this chat project,
  // it is returned unchanged (the UNIQUE chat_project_id makes the link 1:1). The
  // identifier is derived from `name` and de-duped against the workspace's existing
  // identifiers by appending a numeric suffix. Lets solo/daemon mode create
  // projects without the cloud.
  provisionTasksProject(opts: {
    workspaceId: string;
    chatProjectId: string;
    name: string;
    color?: string | null;
  }): StoredTasksProject {
    const existing = this.getTasksProjectByChatStmt.get(opts.chatProjectId) as
      | StoredTasksProject
      | undefined;
    if (existing) return existing;
    const id = `tproj_${randomUUID()}`;
    const now = Date.now();
    const identifier = this.uniqueIdentifier(
      opts.workspaceId,
      CyborgStorage.deriveIdentifier(opts.name),
    );
    const txn = this.db.transaction((): void => {
      this.insertTasksProjectStmt.run(
        id,
        opts.workspaceId,
        opts.chatProjectId,
        identifier,
        0,
        1,
        1,
        1,
        opts.color ?? null,
        null,
        now,
        now,
      );
      this.seedDefaultStates(id, opts.workspaceId);
    });
    txn();
    return this.getTasksProjectStmt.get(id) as StoredTasksProject;
  }

  // The synthetic per-workspace "Inbox" Tasks-project (chat_project_id NULL) that
  // holds orphan tasks (no channel/project). Created on first use with its default
  // states. Idempotent: returns the existing Inbox if present.
  getOrCreateInboxProject(workspaceId: string): StoredTasksProject {
    const existing = this.getTasksProjectInboxStmt.get(workspaceId) as
      | StoredTasksProject
      | undefined;
    if (existing) return existing;
    const id = `tproj_${randomUUID()}`;
    const now = Date.now();
    const identifier = this.uniqueIdentifier(workspaceId, "INBOX");
    const txn = this.db.transaction((): void => {
      this.insertTasksProjectStmt.run(
        id,
        workspaceId,
        null,
        identifier,
        0,
        1,
        1,
        1,
        null,
        null,
        now,
        now,
      );
      this.seedDefaultStates(id, workspaceId);
    });
    txn();
    return this.getTasksProjectStmt.get(id) as StoredTasksProject;
  }

  // De-dupe a candidate task-key prefix against the workspace's existing Tasks-
  // project identifiers (the UNIQUE (workspace_id, identifier) index). Appends a
  // numeric suffix (ENG, ENG1, ENG2, …), truncating the base so the result stays
  // <=8 chars. Returns the first free identifier.
  private uniqueIdentifier(workspaceId: string, base: string): string {
    const taken = new Set(
      (
        this.db
          .prepare("SELECT identifier FROM tasks_projects WHERE workspace_id = ?")
          .all(workspaceId) as Array<{ identifier: string }>
      ).map((r) => r.identifier),
    );
    if (!taken.has(base)) return base;
    for (let n = 1; ; n++) {
      const suffix = String(n);
      const candidate = base.slice(0, Math.max(0, 8 - suffix.length)) + suffix;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // ─── Audit ───────────────────────────────────────────────────────

  audit(opts: {
    workspaceId: string;
    actorId: string;
    actorType: "human" | "agent" | "system";
    action: string;
    targetType?: string;
    targetId?: string;
    details?: Record<string, unknown>;
  }): void {
    this.insertAuditStmt.run(
      randomUUID(),
      opts.workspaceId,
      opts.actorId,
      opts.actorType,
      opts.action,
      opts.targetType ?? null,
      opts.targetId ?? null,
      opts.details ? JSON.stringify(opts.details) : null,
      Date.now(),
    );
  }

  // ─── Lifecycle ───────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}

export function createCyborgStorage(paseoHome: string): CyborgStorage {
  const dbPath = path.join(paseoHome, "cyborg7.db");
  return new CyborgStorage(dbPath);
}

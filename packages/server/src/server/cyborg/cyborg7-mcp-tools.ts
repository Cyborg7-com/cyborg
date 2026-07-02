import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { computeNextRunAt, validateScheduleCadence } from "../schedule/cron.js";
import { getDoc, getNav, listDocs, searchDocs } from "./docs-index.js";
import { hasSourceAccess, listSource, readSource } from "./source-index.js";
import type { DualStorage } from "./dual-storage.js";
import type { MessageRouter } from "./message-router.js";
import type { WorkspaceManager } from "./workspace-manager.js";
import type { CyboSessionContext } from "./cybo-session-context.js";

export interface Cyborg7McpContext {
  workspaceId: string;
  agentId: string;
  // The cybo id behind this agent (agent_bindings.cybo_id), when the agent IS a
  // cybo. Phase 2 gates the channel tools (read/react/search/send) on channel
  // MEMBERSHIP rather than platform permissions: a cybo may act in a channel only
  // if it is a member (channel_members.member_type='cybo'). A non-cybo agent
  // leaves this undefined and keeps the legacy unrestricted behavior.
  cyboId?: string;
  // The SPAWNING USER behind a NON-cybo agent (agent_bindings.initiated_by). When
  // set (and cyboId is absent), task/schedule writes are attributed to this user
  // instead of the ephemeral agent UUID — the agent acts with the spawning user's
  // authority, and a schedule's created_by is a live workspace member so
  // ScheduleRunner.isCreatorStillAuthorized passes (an agent UUID is not a member,
  // so it would be deauthorized and never fire). Undefined for cybos (which keep
  // their own owner attribution) and for a legacy non-cybo agent with no binding.
  initiatedByUserId?: string;
  // The spawning cybo's granted platform permissions (platform_permissions). A
  // non-empty list restricts the cybo to those grants (a write tool whose
  // permission isn't listed is never registered). Read tools are always available.
  // Empty/undefined means "no explicit grants" — see `strictPermissions` for how
  // that is interpreted (legacy fail-open vs fail-safe deny).
  platformPermissions?: string[];
  // How to treat an empty/undefined permission set (issue #206):
  //  - false (default): UNRESTRICTED — backward-compatible, since every existing
  //    cybo's platform_permissions defaults to `[]`. Fail-OPEN.
  //  - true: DENY all gated write tools — fail-SAFE. Enable once existing cybos
  //    have been granted their intended capabilities (no forced DB backfill here).
  // Defaults from the CYBORG7_STRICT_TOOL_PERMISSIONS=1 env var when omitted.
  strictPermissions?: boolean;
  // The channel the cybo is bound to, for project auto-resolution: create_task
  // falls back to this when the caller passes no channelId, so a channel-bound
  // cybo's tasks file under that channel's Tasks-project instead of the Inbox.
  channelId?: string;
  // Whether the Tasks feature is provisioned for this workspace (the authoritative
  // signal is "the workspace has ≥1 tasks_projects row"; resolved in bootstrap.ts).
  // When false the task tools (list/create/update/archive/delete/bulk + list_projects)
  // AND the Page read tools (list_pages/read_page) are NOT registered, since pages
  // are part of Tasks. OMITTED defaults to ENABLED (bootstrap always passes the real
  // value, so the default only affects unit tests that don't exercise the gate).
  tasksEnabled?: boolean;
}

export interface Cyborg7McpDeps {
  storage: DualStorage;
  messageRouter: MessageRouter;
  workspaceManager: WorkspaceManager;
  // Relay round-trip for cloud-workspace reads (channels/membership/history) —
  // the daemon has no PG handle; the relay does (same source the UI uses).
  // Undefined in solo mode (local SQLite serves every read).
  cyboRead?: (req: {
    workspaceId: string;
    // A cybo read sends cyboId; a non-cybo (user-attributed) read sends userId. The
    // relay scopes a userId read to that user's task visibility (currently kind:"tasks").
    cyboId?: string;
    userId?: string;
    kind:
      | "channels"
      | "history"
      | "search"
      | "tasks"
      | "members"
      | "roster"
      | "projects"
      | "pages"
      | "page";
    channelId?: string;
    limit?: number;
    // kind:"page" — the page id to read.
    pageId?: string;
    query?: string;
    status?: string;
    assigneeId?: string;
    // Tasks Redesign — extra task-list filters (Plane-style). Additive + optional,
    // so an old relay simply ignores the unknown fields and returns the unfiltered
    // (status/assignee-only) set. `state` is a workflow-state id OR name; `label` is
    // a label name. The relay resolves them against the project catalog.
    projectId?: string;
    state?: string;
    priority?: string;
    label?: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    channels?: { id: string; name: string; isMember: boolean }[];
    messages?: {
      id: string;
      from_id: string;
      from_name?: string | null;
      text: string;
    }[];
    // Tasks Redesign — the richer task projection. The legacy fields (id/title/
    // status/assignee_id) stay required-shaped; the new Plane-style ids are all
    // optional so an old relay's thin response still satisfies the type.
    tasks?: {
      id: string;
      title: string;
      status: string;
      assignee_id?: string | null;
      sequence_id?: number | null;
      state_id?: string | null;
      priority?: string | null;
      project_id?: string | null;
      label_ids?: string[];
      module_ids?: string[];
    }[];
    // kind:"members" — the channel's roster (humans + cybos) from the shared PG.
    members?: {
      id: string;
      name?: string | null;
      role?: string | null;
      memberType: "user" | "cybo";
    }[];
    // kind:"projects" — the workspace's Tasks-projects from the shared PG (same
    // rows the UI/board see). `chatProjectId` is null for the synthetic Inbox
    // (`isInbox` true); `name` is the linked chat project's name, or "Inbox".
    projects?: {
      id: string;
      identifier: string;
      name: string;
      color: string | null;
      isInbox: boolean;
      chatProjectId: string | null;
    }[];
    // kind:"pages" — a Tasks-project's pages VISIBLE to the cybo's owner, as a
    // compact hierarchy projection (no body). `parentId` null = a root page.
    pages?: {
      id: string;
      title: string;
      parentId: string | null;
      icon: string | null;
    }[];
    // kind:"page" — a single page WITH its body content, owner-visibility gated.
    // null when missing/hidden.
    page?: {
      id: string;
      title: string;
      content: string;
      parentId: string | null;
      icon: string | null;
    } | null;
  } | null>;
  // Relay round-trip for cloud-workspace task WRITES — same rationale: a cloud
  // daemon's local task write never reaches the shared PG the UI reads. null =
  // relay unreachable OR an old relay without the handler (timeout) — the
  // caller falls back to the local write (today's behavior).
  cyboWrite?: (req: {
    workspaceId: string;
    // The cybo on whose behalf the write runs. OPTIONAL: a NON-cybo (plain) agent
    // writes with no cyboId and instead carries `createdBy` (its spawning user) —
    // the relay validates that user as a workspace member and records the task
    // under them. A cybo write still sends cyboId (unchanged).
    cyboId?: string;
    kind: "create_task" | "update_task" | "delete_task" | "update_self";
    agentId?: string;
    // Owner override for a NON-cybo (user-owned) write: the spawning user's id. When
    // present (and cyboId is absent) the relay attributes the task to this user. A
    // cybo write omits it and the relay derives created_by from agentId/cyboId.
    createdBy?: string;
    title?: string;
    description?: string;
    assigneeId?: string;
    dueAt?: number;
    taskId?: string;
    status?: string;
    result?: string;
    // Soft-archive toggle (cyborg7_archive_task rides the update_task kind): epoch ms
    // to archive, null to restore, undefined to leave unchanged.
    archivedAt?: number | null;
    // Tasks Phase 2 (watcher): a task can be bound to the channel it was
    // created/watched in, and carry a board priority. Both are optional and
    // additive — an old relay simply ignores the unknown fields.
    channelId?: string | null;
    priority?: string | null;
    // Tasks Redesign (Plane-style) — the additive task fields a cybo can now set on
    // create/update: the Tasks-project (defaults to the channel's tasks_project, or
    // the workspace Inbox), the sub-task parent, the workflow state (an id; the relay
    // resolves the project's default when absent), the planned start, the label NAMES
    // (auto-created in the project catalog), the single cycle, and the module ids. All
    // optional + nullish so an old relay ignores them and the create still works with
    // only title/description.
    projectId?: string | null;
    parentId?: string | null;
    stateId?: string | null;
    startDate?: number | null;
    labels?: string[];
    cycleId?: string | null;
    moduleIds?: string[];
    // update_self — the full soul the cybo wants to persist (already composed from
    // soul/append/traits by cyborg7_update_my_personality).
    soul?: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    task?: { id: string; title: string; status: string };
    // update_self — the persisted cybo (id + slug + saved soul).
    cybo?: { id: string; slug: string; soul: string };
  } | null>;
  // Relay round-trip for cloud-workspace documented-Page WRITES (create/update/nest)
  // — same rationale as cyboWrite for tasks: a cloud daemon has no PG handle, so a
  // local page write never reaches the shared store the UI reads. The relay validates
  // (the cybo's owner may see the target project; cycle-guards a nest) and mutates PG.
  // null = relay unreachable OR an old relay without the handler (timeout) → the
  // caller falls back to the local write.
  cyboPageWrite?: (req: {
    workspaceId: string;
    // The acting cybo (relay resolves its OWNER for the page-visibility ACL).
    cyboId?: string;
    // The spawning user for a NON-cybo agent (acts with that user's authority).
    createdBy?: string;
    agentId?: string;
    kind: "create_page" | "update_page" | "nest_page";
    // create_page
    projectId?: string;
    title?: string;
    content?: string;
    icon?: string | null;
    // create_page (nest at birth) + nest_page; null clears (move to root).
    parentId?: string | null;
    // update_page / nest_page
    pageId?: string;
  }) => Promise<{
    ok: boolean;
    error?: string;
    page?: { id: string; title: string; parentId: string | null; icon: string | null } | null;
  } | null>;
  // Cross-session context (cybo recall) — OWNER-SCOPED. Lets a cybo review the
  // OWNER's OTHER sessions with the SAME cybo (list by recency, read one session's
  // timeline, text-search for recall). Sessions + timelines live in THIS daemon's
  // local SQLite (agent_bindings + agent_timeline_rows; NOT PG), so this is wired
  // daemon-locally — not through the relay round-trip, which has no timelines. Owner
  // scoping is enforced inside CyboSessionContext at the data layer (the binding
  // set), so a cybo can never read a session it isn't entitled to. Undefined when the
  // daemon has no durable timeline store (the tools then report unavailability).
  sessionContext?: CyboSessionContext;
}

// Resolve a schedule's created_by — the AUTHORIZED HUMAN the run is attributed to,
// never the ephemeral agent UUID (ScheduleRunner.isCreatorStillAuthorized requires a
// live workspace MEMBER, so an agent UUID would be deauthorized and never fire).
// Precedence:
//   1. ctx.initiatedByUserId — the SPAWNING USER of a NON-cybo agent.
//   2. cyboInvoker — for a CYBO, the HUMAN who invoked it (the agent binding's
//      initiated_by). A SHARED cybo (owned by Y) that member X asks to schedule must
//      be attributed to X, NOT Y — otherwise the fired run's session (spawnCybo
//      userId = created_by → binding.initiated_by → UI isMine) renders in Y's sidebar
//      as if Y scheduled it ("a Rick session I never created appeared as mine"). The
//      invoker is a live member, so isCreatorStillAuthorized still passes.
//   3. cyboOwner (target.created_by) — when there's no resolvable invoker.
//   4. ctx.agentId — last-resort fallback.
function resolveScheduleCreatedBy(
  ctx: Cyborg7McpContext,
  storage: DualStorage,
  cyboOwner: string | undefined,
): string {
  if (ctx.initiatedByUserId) return ctx.initiatedByUserId;
  const cyboInvoker = storage.getAgentBinding?.(ctx.agentId)?.initiated_by ?? undefined;
  return cyboInvoker ?? cyboOwner ?? ctx.agentId;
}

// ── Task status taxonomy (the REAL `tasks.status` values) ──────────
//
// The free-text `tasks.status` column is the back-compat mirror of a task's
// workflow-state group (db/pg-sync.ts mapStateGroupToStatus): backlog/unstarted →
// "pending", started → "in_progress", completed → "done", cancelled → "cancelled".
// Legacy/imported rows also carry a literal "backlog" (and historically "todo")
// status, which the board's Backlog/Todo columns surface. So the authoritative
// status set a cybo can actually FILTER ON and SEE is the union below — NOT the
// invented `todo | in_progress | pending_review | done` the tool used to advertise.
// A cybo reasoning in the non-existent `pending_review`/`todo`-only buckets declared
// the backlog/pending tasks "empty" and only ever saw the in_progress sliver. The
// Plane workflow COLUMNS themselves live in task_states.group; filter by a column via
// the `state` arg (a state id OR name).
export const TASK_STATUSES = [
  "backlog",
  "todo",
  "pending",
  "in_progress",
  "done",
  "cancelled",
] as const;

// Stable display order for the grouped list output, so a cybo's summary mirrors the
// real board top-to-bottom.
const TASK_STATUS_ORDER: readonly string[] = TASK_STATUSES;

const TASK_STATUS_HELP = `Filter by status — the real values are: ${TASK_STATUSES.join(
  " | ",
)}. Omit to return EVERY status (the full board).`;

// Shape of a task row the formatter needs (a structural subset of TaskRow).
interface FormattableTask {
  id: string;
  title: string;
  status: string;
  assignee_id?: string | null;
  sequence_id?: number | null;
  priority?: string | null;
  label_ids?: string[];
  module_ids?: string[];
}

// One task → a single compact line (handle + title + metadata). Shared by both the
// flat and grouped renderers so they stay consistent.
function formatTaskLine(t: FormattableTask): string {
  // The addressable `id` leads every line — it is the token update_task/delete_task
  // resolve by. `#sequence` is a human-only reference and is NOT accepted by those
  // tools, so it can never be the primary handle.
  const handle = t.sequence_id != null ? `${t.id} (#${t.sequence_id})` : t.id;
  const meta: string[] = [];
  if (t.priority && t.priority !== "none") meta.push(`prio:${t.priority}`);
  if (t.assignee_id) meta.push(`-> ${t.assignee_id}`);
  if (t.label_ids && t.label_ids.length > 0) meta.push(`labels:${t.label_ids.join(",")}`);
  if (t.module_ids && t.module_ids.length > 0) meta.push(`modules:${t.module_ids.join(",")}`);
  const suffix = meta.length > 0 ? ` (${meta.join("; ")})` : "";
  return `${handle}: ${t.title}${suffix}`;
}

// Group a flat task list by status and render a board-shaped summary so the cybo
// sees the TRUE distribution across every status (incl. backlog/pending), not just
// the in_progress sliver. A row is NEVER dropped — an unknown status is rendered
// under its own section after the canonical ones. Pure (no IO) for unit-testing.
export function formatTasksByStatus(tasks: FormattableTask[]): string {
  if (tasks.length === 0) return "(no tasks)";
  const byStatus = new Map<string, FormattableTask[]>();
  for (const t of tasks) {
    const arr = byStatus.get(t.status) ?? [];
    arr.push(t);
    byStatus.set(t.status, arr);
  }
  const known = TASK_STATUS_ORDER.filter((s) => byStatus.has(s));
  const unknown = [...byStatus.keys()].filter((s) => !TASK_STATUS_ORDER.includes(s)).sort();
  const sections: string[] = [];
  for (const status of [...known, ...unknown]) {
    const rows = byStatus.get(status)!;
    const lines = rows.map((t) => `  ${formatTaskLine(t)}`);
    sections.push(`${status} (${rows.length}):\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

// The compact, agent-facing projection of a Tasks-project returned by
// cyborg7_list_projects. The agent uses `id` as create_task's projectId.
export interface TasksProjectListEntry {
  id: string;
  identifier: string;
  name: string;
  color: string | null;
  isInbox: boolean;
  chatProjectId: string | null;
}

// Pure projection for cyborg7_list_projects: map the raw tasks_projects rows to the
// compact entries, derive the display name from the linked chat project (or "Inbox"
// for the synthetic catch-all whose chat_project_id is null), and apply the archived
// filter. Kept pure (no DB/IO) so it's unit-testable; the handler supplies the rows
// and the chat-project name lookup. The row param is a structural subset of
// StoredTasksProject so the SQLite read result passes straight through.
export function buildTasksProjectList(
  projects: {
    id: string;
    identifier: string;
    chat_project_id: string | null;
    color: string | null;
    archived_at: number | null;
  }[],
  nameByChatProjectId: Map<string, string>,
  includeArchived: boolean,
): TasksProjectListEntry[] {
  return projects
    .filter((p) => includeArchived || p.archived_at == null)
    .map((p) => ({
      id: p.id,
      identifier: p.identifier,
      name:
        p.chat_project_id == null
          ? "Inbox"
          : (nameByChatProjectId.get(p.chat_project_id) ?? p.identifier),
      color: p.color,
      isInbox: p.chat_project_id == null,
      chatProjectId: p.chat_project_id,
    }));
}

// The cyborg7_update_my_personality trait vocabulary — mirrors the UI wizard's
// VOICE_OPTIONS (agent/new/+page.svelte) so a soul written by the tool round-trips
// into the editor's trait chips (it parses "- <Label> — <sub>" lines).
export const CYBO_VOICE_TRAITS: Record<string, { label: string; sub: string }> = {
  warm: { label: "Warm", sub: "a real person on a good day" },
  brief: { label: "Brief", sub: "says the thing, then stops" },
  thorough: { label: "Thorough", sub: "shows their work, every time" },
  direct: { label: "Direct", sub: "no hedging" },
  playful: { label: "Playful", sub: "a touch of humor" },
  formal: { label: "Formal", sub: "reads like a memo" },
};

// Pure soul-composition for cyborg7_update_my_personality. `soul` (full replace)
// wins as the base, else the current soul; `traits` rewrites the "Personality:"
// section (stripping any existing one so re-applying never stacks blocks); `append`
// adds a trailing paragraph last. Kept pure (no IO) so it is directly unit-testable.
export function composeCyboSoul(
  currentSoul: string,
  edit: { soul?: string; append?: string; traits?: string[] },
): string {
  let next = edit.soul !== undefined ? edit.soul : currentSoul;

  if (edit.traits !== undefined) {
    const out: string[] = [];
    let skipping = false;
    for (const line of next.split("\n")) {
      if (line.trim() === "Personality:") {
        skipping = true;
        continue;
      }
      if (skipping) {
        // The block is the heading plus contiguous "- " bullet lines.
        if (line.startsWith("- ") || line.trim() === "") continue;
        skipping = false;
      }
      out.push(line);
    }
    const rebuilt = out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    const block =
      edit.traits.length > 0
        ? [
            "Personality:",
            ...edit.traits.map(
              (t) => `- ${CYBO_VOICE_TRAITS[t].label} — ${CYBO_VOICE_TRAITS[t].sub}`,
            ),
          ].join("\n")
        : "";
    next = block ? `${rebuilt}\n\n${block}` : rebuilt;
  }

  if (edit.append !== undefined && edit.append.trim().length > 0) {
    next = `${next.trimEnd()}\n\n${edit.append.trim()}`;
  }

  return next.trim();
}

// Register the repo-scoped, read-only self-source tool (task CYBO-78) — but only
// when the daemon runs from a git checkout of the monorepo (hasSourceAccess()),
// so a packaged install never exposes it. Every path passes through the docs-lib
// guard that rejects `..` escapes, absolute paths outside the root, and symlink
// escapes. Module-scope (not inline) so it adds no branch to
// createCyborg7McpServer's cyclomatic complexity.
function registerReadSourceTool(server: McpServer): void {
  if (!hasSourceAccess()) return;
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
  server.tool(
    "cyborg7_read_source",
    "Read Cyborg7's OWN source code (repo-scoped, read-only). Use this only when the " +
      "published docs (cyborg7_read_docs) don't cover a deep implementation/config " +
      "question — e.g. how a specific behavior is actually coded. `list` a directory " +
      "then `get` a file. Access is HARD-restricted to files under the repository root; " +
      "paths that escape it are rejected.",
    {
      mode: z
        .enum(["list", "get"])
        .describe("'list' = directory entries; 'get' = file contents (size-capped)"),
      path: z
        .string()
        .optional()
        .describe(
          "Repo-relative path. For 'list' a directory ('' or omitted = repo root, e.g. " +
            "'packages/server/src/server/cyborg'); for 'get' a file, e.g. " +
            "'packages/server/src/server/cyborg/docs-index.ts'. `..` / absolute escapes rejected.",
        ),
      maxBytes: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("For 'get': byte cap on the returned file body (default 65536)."),
    },
    async ({ mode, path, maxBytes }) => {
      if (mode === "get") {
        if (!path) return text(JSON.stringify({ error: "mode 'get' requires a path" }));
        return text(JSON.stringify(readSource(path, maxBytes), null, 2));
      }
      return text(JSON.stringify(listSource(path ?? ""), null, 2));
    },
  );
}

export function createCyborg7McpServer(deps: Cyborg7McpDeps, ctx: Cyborg7McpContext): McpServer {
  const {
    storage,
    messageRouter,
    workspaceManager,
    cyboRead,
    cyboWrite,
    cyboPageWrite,
    sessionContext,
  } = deps;
  const server = new McpServer({ name: "cyborg7", version: "1.0.0" });

  // Platform-permission gate. A NON-EMPTY permission list restricts the cybo to
  // exactly those grants (write tools whose permission isn't listed aren't
  // registered); read tools are always available.
  //
  // An empty/undefined list = "no explicit grants". By default that is treated as
  // UNRESTRICTED (fail-open) so existing cybos — whose platform_permissions default
  // to `[]` — keep working. Set CYBORG7_STRICT_TOOL_PERMISSIONS=1 (or pass
  // ctx.strictPermissions) to flip the empty case to DENY-all (fail-safe), per
  // issue #206. The default stays fail-open deliberately: flipping it globally
  // without first backfilling existing cybos' capabilities would silently strip
  // every cybo's write tools, and the backfill is out of scope here (no schema /
  // migration changes — that's PR #225's territory).
  const strict = ctx.strictPermissions ?? process.env.CYBORG7_STRICT_TOOL_PERMISSIONS === "1";
  const granted =
    ctx.platformPermissions && ctx.platformPermissions.length > 0
      ? new Set(ctx.platformPermissions)
      : null;
  // granted set → only listed grants; no grants → unrestricted (lax) or deny (strict).
  const allows = (permission: string): boolean => (granted ? granted.has(permission) : !strict);

  // Tasks feature gate (see Cyborg7McpContext.tasksEnabled). Pages are part of Tasks,
  // so both the task tools and the Page read tools hang off this single flag, on top
  // of any `allows()` platform-permission check. Defaults to on.
  const tasksEnabled = ctx.tasksEnabled !== false;

  const mcpText = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  // Connected-mode reads. A cybo runs on a daemon, but a CLOUD workspace's
  // channels/membership/history live ONLY in the relay's PG — this daemon has no
  // DATABASE_URL, and the relay sync stream carries messages, not the channel
  // catalog, so `storage.getChannels` is EMPTY here (the 0.0.140 pg-direct fix
  // was a no-op for exactly that reason). Resolution order:
  //   1. deps.cyboRead — the relay round-trip (cloud daemons; same PG the UI reads)
  //   2. storage.pg    — direct PG (a daemon that does carry DATABASE_URL)
  //   3. storage       — local SQLite (solo mode)
  // A relay error surfaces as an explicit failure (never a silent "(no channels)").
  interface ChannelRow {
    id: string;
    name: string;
    description?: string | null;
  }
  const readChannels = async (): Promise<ChannelRow[]> => {
    if (cyboRead && ctx.cyboId) {
      const res = await cyboRead({
        workspaceId: ctx.workspaceId,
        cyboId: ctx.cyboId,
        kind: "channels",
      });
      if (res) {
        if (!res.ok) throw new Error(res.error ?? "relay read failed");
        return res.channels ?? [];
      }
      // null = relay unreachable right now — fall through to local stores.
    }
    if (storage.pg) return await storage.pg.getChannels(ctx.workspaceId);
    return storage.getChannels(ctx.workspaceId);
  };
  // Normalize a caller-supplied channel reference to its CANONICAL channel id.
  // Cybos (and prompts) routinely pass the channel NAME ("tasks-test") where an
  // id ("ch_tasks_test") is expected. schedules.channel_id has a PG FK, so a name
  // crashes the mirror insert; tasks.channel_id has no FK but a bad value breaks
  // channel-scoped filters. Reuse the relay-aware workspace-scoped channel catalog
  // (readChannels) and match on id OR name. Returns null when nothing resolves —
  // storing null beats storing a value that fails the FK / breaks filtering.
  const normalizeChannelId = async (raw: string | undefined): Promise<string | null> => {
    if (!raw) return null;
    try {
      const channels = await readChannels();
      const match = channels.find((c) => c.id === raw || c.name === raw);
      return match ? match.id : null;
    } catch {
      // Relay/PG read failed — don't risk persisting an unverified value behind
      // a FK; drop the binding rather than crash the insert.
      return null;
    }
  };
  interface MessageRow {
    id: string;
    from_id: string;
    from_name?: string | null;
    text: string;
  }
  const readMessages = async (opts: {
    channelId: string;
    limit?: number;
  }): Promise<MessageRow[]> => {
    if (cyboRead && ctx.cyboId) {
      const res = await cyboRead({
        workspaceId: ctx.workspaceId,
        cyboId: ctx.cyboId,
        kind: "history",
        channelId: opts.channelId,
        limit: opts.limit,
      });
      if (res) {
        if (!res.ok) throw new Error(res.error ?? "relay read failed");
        return res.messages ?? [];
      }
    }
    if (storage.pg) return await storage.pg.getMessages({ ...opts });
    return storage.getMessages({ ...opts });
  };
  // Tasks: same resolution order. A cloud workspace's tasks live in the
  // relay's PG (the UI writes them there); local SQLite only serves solo mode.
  // The row carries the legacy fields plus the Plane-style ids (optional, so an
  // old relay's thin response still satisfies it).
  interface TaskRow {
    id: string;
    title: string;
    status: string;
    assignee_id?: string | null;
    sequence_id?: number | null;
    state_id?: string | null;
    priority?: string | null;
    project_id?: string | null;
    label_ids?: string[];
    module_ids?: string[];
  }
  const readTasks = async (filter: {
    status?: string;
    assigneeId?: string;
    // Tasks Redesign — extra list filters. status/assigneeId are honored by both the
    // relay and the local stores today; projectId/state/priority/label are forwarded
    // to the relay (which gained the richer getTasks filter) and ignored by the
    // local-store fallback, which only filters on status/assignee.
    projectId?: string;
    state?: string;
    priority?: string;
    label?: string;
  }): Promise<TaskRow[]> => {
    // A non-cybo workspace session (no cyboId) reads with its spawning user's identity
    // so the relay scopes tasks to that user's visibility — without this a non-cybo
    // session fell through to the empty local store (cloud daemons have no PG) and saw
    // no tasks.
    if (cyboRead && (ctx.cyboId || ctx.initiatedByUserId)) {
      const res = await cyboRead({
        workspaceId: ctx.workspaceId,
        cyboId: ctx.cyboId,
        userId: ctx.cyboId ? undefined : ctx.initiatedByUserId,
        kind: "tasks",
        status: filter.status,
        assigneeId: filter.assigneeId,
        projectId: filter.projectId,
        state: filter.state,
        priority: filter.priority,
        label: filter.label,
      });
      if (res) {
        if (!res.ok) throw new Error(res.error ?? "relay read failed");
        return res.tasks ?? [];
      }
      // null = relay unreachable / old relay — fall through to local stores.
    }
    // Local stores only support the status/assignee filter shape.
    const localFilter = { status: filter.status, assigneeId: filter.assigneeId };
    // Direct-PG fallback (relay unreachable on a daemon that carries DATABASE_URL):
    // scope to the same user the relay path would, so a project-restricted task is
    // never leaked to a non-cybo session that runs this fallback UNSCOPED. A cybo's
    // owner isn't resolvable client-side, so cybo reads keep their prior fallback. The
    // SQLite path below is solo/local (single user), so no cross-user scoping applies.
    if (storage.pg) {
      return await storage.pg.getTasks(ctx.workspaceId, {
        ...localFilter,
        userId: ctx.cyboId ? undefined : ctx.initiatedByUserId,
      });
    }
    return storage.getTasks(ctx.workspaceId, localFilter);
  };

  // Channel members (humans + cybos). Same relay-aware resolution order as the
  // reads above:
  //   1. deps.cyboRead kind:"members" — the relay round-trip (cloud daemons; the
  //      shared PG the UI reads). Membership is re-gated relay-side.
  //   2. storage.pg — direct PG (a daemon that carries DATABASE_URL): union the
  //      HUMANS (getChannelMembers innerJoins users and DROPS cybos) with the cybo
  //      members (getChannelCyboMembers), each cybo resolved to its name/role.
  //   3. storage — local SQLite (solo): SQLite has no channel_members table
  //      (channels are workspace-visible locally), so the honest local roster is the
  //      WORKSPACE members + the WORKSPACE cybos.
  interface ChannelMemberRow {
    id: string;
    name?: string | null;
    role?: string | null;
    memberType: "user" | "cybo";
  }
  const readChannelMembers = async (channelId: string): Promise<ChannelMemberRow[]> => {
    if (cyboRead && ctx.cyboId) {
      const res = await cyboRead({
        workspaceId: ctx.workspaceId,
        cyboId: ctx.cyboId,
        kind: "members",
        channelId,
      });
      if (res) {
        if (!res.ok) throw new Error(res.error ?? "relay read failed");
        return res.members ?? [];
      }
      // null = relay unreachable right now — fall through to local stores.
    }
    if (storage.pg) {
      const [humans, cyboIds, cybos] = await Promise.all([
        storage.pg.getChannelMembers(channelId),
        storage.pg.getChannelCyboMembers(channelId),
        storage.pg.getCybos(ctx.workspaceId),
      ]);
      const cyboById = new Map(cybos.map((c) => [c.id, c]));
      return [
        ...humans.map((h) => ({
          id: h.userId,
          name: h.name,
          role: h.role,
          memberType: "user" as const,
        })),
        ...cyboIds.map((id) => ({
          id,
          name: cyboById.get(id)?.name ?? null,
          role: cyboById.get(id)?.role ?? null,
          memberType: "cybo" as const,
        })),
      ];
    }
    // Solo: no per-channel membership locally → the workspace roster.
    return [
      ...storage.getMembers(ctx.workspaceId).map((m) => ({
        id: m.user_id,
        name: m.name,
        role: m.role,
        memberType: "user" as const,
      })),
      ...storage.getCybos(ctx.workspaceId).map((c) => ({
        id: c.id,
        name: c.name,
        role: c.role,
        memberType: "cybo" as const,
      })),
    ];
  };

  // Channel-membership gate (Phase 2). The channel tools (read_channel / react /
  // search / send_message) are ALWAYS exposed; membership decides per-channel at
  // EXECUTION time. Adding a cybo to a channel (channel_members, member_type='cybo')
  // is itself the grant — membership = read+react+respond in that channel, so there
  // is no separate per-channel permission to manage.
  //
  // Returns null when the action is allowed, or an MCP error result when denied.
  // A non-cybo agent (no ctx.cyboId) keeps the legacy unrestricted behavior.
  // Membership lives in shared PG; without it we cannot verify a join, so a cybo is
  // denied (fail-safe) — channel membership is inherently a connected-mode feature.
  const requireChannelMembership = async (channel: {
    id: string;
    name?: string;
  }): Promise<ReturnType<typeof mcpText> | null> => {
    if (!ctx.cyboId) return null;
    const label = channel.name ? `#${channel.name}` : `channel '${channel.id}'`;
    let isMember = false;
    // Relay-aware: the channels read already carries the cybo's membership flag
    // (computed against the relay's PG — the same store this gate used to need a
    // local PG handle for). Honor it first so cloud daemons (no DATABASE_URL)
    // can verify a join; PG stays the source when this process has it.
    if (
      "isMember" in channel &&
      typeof (channel as { isMember?: boolean }).isMember === "boolean"
    ) {
      isMember = (channel as { isMember: boolean }).isMember;
    } else if (storage.pg) {
      try {
        isMember = await storage.pg.isCyboChannelMember(channel.id, ctx.cyboId);
      } catch {
        return mcpText(`Error: could not verify channel membership for ${label}`);
      }
    } else {
      return mcpText(
        `Error: channel membership is unavailable here; a cybo can only act in channels it has joined`,
      );
    }
    if (!isMember) {
      return mcpText(
        `Error: not a member of ${label} — ask a workspace admin to add this cybo to the channel`,
      );
    }
    return null;
  };

  if (allows("send_message")) {
    server.tool(
      "cyborg7_send_message",
      "Send a message to ANOTHER channel or user in the workspace (cross-context messaging — e.g. asked in a DM to post something to #general, or to DM a third person). Do NOT use it to answer the conversation you are currently in: your response text is delivered there automatically, so tool-sending it creates a duplicate. EXCEPTION: in an autonomous (scheduled/unattended) run your response text is NOT delivered anywhere, so there this tool IS how you post the result.",
      {
        channel: z.string().optional().describe("Channel name or ID to send to"),
        to: z.string().optional().describe("User or agent ID for DM"),
        text: z.string().describe("Message text"),
        mentions: z
          .array(z.string())
          .optional()
          .describe(
            "USER ids to @mention/notify on a CHANNEL post — they get an unread badge " +
              "and a notification. Pass EXPLICIT user ids ONLY (do NOT put @names in the " +
              "text and expect them to resolve): first call cyborg7_list_channel_members " +
              "to map a name to its id, then pass that id here. Only human members of the " +
              "channel are notified; cybo ids and unknown ids are ignored, and a mention " +
              "never invokes a cybo. Ignored for DMs.",
          ),
      },
      async ({ channel, to, text, mentions }) => {
        if (channel) {
          const channels = await readChannels();
          const target = channels.find((c) => c.name === channel || c.id === channel);
          if (!target)
            return {
              content: [{ type: "text" as const, text: `Error: channel '${channel}' not found` }],
            };
          // A cybo may only post to a channel it is a member of (Phase 2).
          const denied = await requireChannelMembership(target);
          if (denied) return denied;
          messageRouter.handleAgentMessage(
            ctx.agentId,
            ctx.workspaceId,
            target.id,
            null,
            text,
            mentions,
          );
        } else if (to) {
          messageRouter.handleAgentMessage(ctx.agentId, ctx.workspaceId, null, to, text);
        } else {
          return { content: [{ type: "text" as const, text: "Error: specify 'channel' or 'to'" }] };
        }

        return { content: [{ type: "text" as const, text: "Message sent" }] };
      },
    );
  }

  server.tool(
    "cyborg7_get_channel_history",
    "Get recent messages from a channel",
    {
      channel: z.string().describe("Channel name or ID"),
      limit: z.number().optional().describe("Max messages to return (default 30)"),
    },
    async ({ channel, limit }) => {
      const channels = await readChannels();
      const target = channels.find((c) => c.name === channel || c.id === channel);
      if (!target)
        return {
          content: [{ type: "text" as const, text: `Error: channel '${channel}' not found` }],
        };
      // Channel-membership gate, parity with cyborg7_read_channel — a cybo must not
      // read a private channel's history it isn't a member of (IDOR fix).
      const denied = await requireChannelMembership(target);
      if (denied) return denied;

      const messages = await readMessages({ channelId: target.id, limit: limit ?? 30 });
      const formatted = messages
        .toReversed()
        .map((m) => `[${m.from_name ?? m.from_id}] ${m.text}`)
        .join("\n");

      return { content: [{ type: "text" as const, text: formatted || "(no messages)" }] };
    },
  );

  // Channel read/interact tools. Always EXPOSED; channel MEMBERSHIP gates each at
  // execution (see requireChannelMembership). The platform permissions
  // read_messages/react/search are no longer used as gates — membership replaces
  // them (a cybo added to a channel can read/react/respond there).
  server.tool(
    "cyborg7_read_channel",
    "Read recent messages from a channel as a transcript. Each line is prefixed with the message ID so you can react or reply to a specific message.",
    {
      channel: z.string().describe("Channel name or ID"),
      limit: z.number().optional().describe("Max messages to read (default 30, max 200)"),
    },
    async ({ channel, limit }) => {
      const channels = await readChannels();
      const target = channels.find((c) => c.name === channel || c.id === channel);
      if (!target) return mcpText(`Error: channel '${channel}' not found`);
      const denied = await requireChannelMembership(target);
      if (denied) return denied;
      const n = Math.min(Math.max(1, limit ?? 30), 200);
      // getMessages returns newest-first; reverse to a chronological transcript.
      const transcript = (await readMessages({ channelId: target.id, limit: n }))
        .toReversed()
        .map((m) => `[${m.id}] ${m.from_name ?? m.from_id}: ${m.text}`)
        .join("\n");
      return mcpText(transcript || "(no messages)");
    },
  );

  server.tool(
    "cyborg7_react",
    "React to a message with an emoji",
    {
      messageId: z.string().describe("ID of the message to react to (from cyborg7_read_channel)"),
      emoji: z.string().describe("Emoji to react with, e.g. '👍' or ':thumbsup:'"),
    },
    async ({ messageId, emoji }) => {
      // Validate the target exists and is in THIS workspace — an agent must not
      // broadcast a reaction for an arbitrary or cross-workspace message id.
      const msg = storage.getMessageById(messageId);
      if (!msg || msg.workspace_id !== ctx.workspaceId) {
        return mcpText(`Error: message '${messageId}' not found in this workspace`);
      }
      // A channel message requires membership of its channel; a DM (no channel_id)
      // has no channel membership concept, so it falls through (workspace-scoped).
      // Channel lookup is RELAY-AWARE (readChannels): the message row itself IS
      // synced to local SQLite, but a cloud workspace's channel catalog (and the
      // cybo's membership flag) lives only in the relay's PG — storage.getChannels
      // is empty there, which used to skip the label AND feed the membership gate
      // a bare id it couldn't verify.
      if (msg.channel_id) {
        const channels = await readChannels();
        const ch = channels.find((c) => c.id === msg.channel_id);
        const denied = await requireChannelMembership(ch ?? { id: msg.channel_id });
        if (denied) return denied;
      }
      messageRouter.handleAgentReaction(ctx.agentId, ctx.workspaceId, messageId, emoji);
      return mcpText(`Reacted ${emoji}`);
    },
  );

  server.tool(
    "cyborg7_search",
    "Search messages by text within a channel you are a member of. On cloud " +
      "workspaces this searches the shared workspace store (via the relay); " +
      "otherwise it searches messages synced to this daemon.",
    {
      query: z.string().describe("Text to search for"),
      channel: z.string().optional().describe("Optional channel name or ID to scope the search"),
      limit: z.number().optional().describe("Max results (default 20, max 100)"),
    },
    async ({ query, channel, limit }) => {
      const n = Math.min(Math.max(1, limit ?? 20), 100);
      let channelId: string | undefined;
      if (channel) {
        const channels = await readChannels();
        const target = channels.find((c) => c.name === channel || c.id === channel);
        if (!target) return mcpText(`Error: channel '${channel}' not found`);
        const denied = await requireChannelMembership(target);
        if (denied) return denied;
        channelId = target.id;
      } else if (ctx.cyboId) {
        // A cybo can't run a workspace-wide search — that would surface channels it
        // is not a member of. Require an explicit (member) channel scope.
        return mcpText("Error: specify a 'channel' you are a member of to search");
      }
      const format = (
        rows: { id: string; from_id: string; from_name?: string | null; text: string }[],
      ) =>
        mcpText(
          rows.map((m) => `[${m.id}] ${m.from_name ?? m.from_id}: ${m.text}`).join("\n") ||
            "(no matches)",
        );
      // Cloud (relay-connected) + channel-scoped: search the SHARED workspace
      // store — the same PG the UI searches — membership re-gated relay-side.
      if (cyboRead && ctx.cyboId && channelId) {
        const res = await cyboRead({
          workspaceId: ctx.workspaceId,
          cyboId: ctx.cyboId,
          kind: "search",
          channelId,
          query,
          limit: n,
        });
        if (res) {
          if (!res.ok) return mcpText(`Error: ${res.error ?? "relay search failed"}`);
          return format(res.messages ?? []);
        }
        // null = relay unreachable right now — fall through to the local store.
      }
      // Solo / PG-less fallback: only messages synced to THIS daemon. Filter by
      // channel in the query (not in-memory) so in-channel matches beyond the
      // workspace-wide cap aren't dropped.
      return format(storage.searchMessages(ctx.workspaceId, query, n, channelId));
    },
  );

  if (tasksEnabled && allows("create_task")) {
    server.tool(
      "cyborg7_create_task",
      "Create a task in the workspace. Only title is required; every other field is " +
        "optional. Provide a project via `projectId`, or the task is filed under the " +
        "current channel's Tasks-project (resolved automatically), or it inherits the " +
        "parent's project when `parentId` is set. A bare task with no projectId, " +
        "channelId, or parentId is rejected.",
      {
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Task description"),
        assignee: z
          .string()
          .optional()
          .describe("Assignee: a human userId, or a cybo id (the bare-text assigneeId)"),
        dueAt: z.string().optional().describe("Due date ISO string"),
        channelId: z
          .string()
          .optional()
          .describe("Channel to scope the task to (e.g. the channel a watcher is watching)"),
        priority: z
          .enum(["urgent", "high", "medium", "low", "none"])
          .optional()
          .describe("Task priority. Defaults to 'none' when omitted."),
        // Tasks Redesign (Plane-style) — additive, all optional.
        projectId: z
          .string()
          .optional()
          .describe(
            "Tasks-project id to file the task under. Defaults to the channel's " +
              "tasks_project (when channelId is given) or the workspace Inbox.",
          ),
        parentId: z
          .string()
          .optional()
          .describe("Parent task id to create this task as a sub-task of"),
        stateId: z
          .string()
          .optional()
          .describe(
            "Workflow-state id within the project's state catalog. Defaults to the " +
              "project's default state when omitted.",
          ),
        startDate: z
          .string()
          .optional()
          .describe("Planned start date ISO string (the Gantt left edge)"),
        labels: z
          .array(z.string())
          .optional()
          .describe(
            "Label NAMES to tag the task with. Unknown names are auto-created in the " +
              "project's label catalog.",
          ),
        cycleId: z.string().optional().describe("Cycle (sprint) id to assign the task to"),
        moduleIds: z.array(z.string()).optional().describe("Module ids to associate the task with"),
      },
      async ({
        title,
        description,
        assignee,
        dueAt,
        channelId,
        priority,
        projectId,
        parentId,
        stateId,
        startDate,
        labels,
        cycleId,
        moduleIds,
      }) => {
        const due = dueAt ? new Date(dueAt).getTime() : undefined;
        if (due !== undefined && !Number.isFinite(due)) {
          return {
            content: [{ type: "text" as const, text: "Error: invalid dueAt date format" }],
          };
        }
        const start = startDate ? new Date(startDate).getTime() : undefined;
        if (start !== undefined && !Number.isFinite(start)) {
          return {
            content: [{ type: "text" as const, text: "Error: invalid startDate date format" }],
          };
        }
        // The cybo may pass the channel NAME ("tasks-test") where the canonical
        // id ("ch_tasks_test") is expected. tasks.channel_id has no FK, so a name
        // silently persists and breaks every channel-scoped task filter. Resolve
        // to the canonical id (or null) for BOTH the relay and local write paths.
        //
        // When the caller passes no channelId, fall back to the channel the cybo is
        // bound to (ctx.channelId) so a channel-bound cybo's task auto-resolves to
        // that channel's Tasks-project instead of dropping into the workspace Inbox.
        const effectiveChannelId = channelId ?? ctx.channelId;
        const resolvedChannelId = await normalizeChannelId(effectiveChannelId);
        // Cloud: write the SHARED tasks table via the relay (the rows the UI
        // sees). A relay-validated failure is surfaced; null (old relay /
        // disconnected) falls back to the local write — today's behavior. Fires for
        // a cybo (ctx.cyboId) AND for a NON-cybo agent that carries a spawning user
        // (ctx.initiatedByUserId) — the latter sends createdBy so the relay records
        // the task under the user (a no-PG cloud daemon's local write never reaches
        // the shared store, so the relay round-trip is the only path that does).
        if (cyboWrite && (ctx.cyboId || ctx.initiatedByUserId)) {
          const res = await cyboWrite({
            workspaceId: ctx.workspaceId,
            cyboId: ctx.cyboId,
            kind: "create_task",
            agentId: ctx.agentId,
            // Owner for a NON-cybo agent's task: the spawning user. The relay records
            // this as created_by (and the activity actor). Undefined for a cybo (the
            // relay keeps deriving created_by from agentId/cyboId).
            createdBy: ctx.initiatedByUserId,
            title,
            description,
            assigneeId: assignee,
            dueAt: due,
            channelId: resolvedChannelId,
            priority,
            // Tasks Redesign — forward the Plane-style fields the cybo set. The
            // relay resolves the effective project/state and the label NAMES; an
            // old relay ignores the unknown fields and creates the legacy shape.
            projectId,
            parentId,
            stateId,
            startDate: start,
            labels,
            cycleId,
            moduleIds,
          });
          if (res) {
            if (!res.ok || !res.task) {
              return mcpText(`Error: ${res.error ?? "task create failed"}`);
            }
            return mcpText(`Task created: ${res.task.id} — ${res.task.title}`);
          }
        }
        const task = storage.createTask({
          // Cybo-facing create tool — require an explicit project/channel/parent
          // context (no silent Inbox fallback). With none, resolveCreateProject
          // throws "provide projectId or channelId". (The cloud path above goes
          // through cyboWrite → the relay's cyborg:create_task handler, which sets
          // this flag itself; only THIS local/solo fallback sets it here.)
          requireProjectContext: true,
          workspaceId: ctx.workspaceId,
          title,
          description,
          assigneeId: assignee,
          // Owner: the spawning user for a NON-cybo agent (ctx.initiatedByUserId),
          // else the agent UUID — the cybo/legacy behavior is unchanged.
          createdBy: ctx.initiatedByUserId ?? ctx.agentId,
          dueAt: due,
          channelId: resolvedChannelId,
          priority,
          // Local (solo / PG-less) fallback — DualStorage resolves the project/
          // state the same way and writes the label/module joins from these inputs.
          projectId,
          parentId,
          stateId,
          startDate: start,
          labels,
          cycleId,
          moduleIds,
        });

        return {
          content: [{ type: "text" as const, text: `Task created: ${task.id} — ${task.title}` }],
        };
      },
    );
  }

  // Task READ tools — gated on the workspace having Tasks provisioned (a non-Tasks
  // workspace exposes neither the read nor the write task surface).
  if (tasksEnabled)
    server.tool(
      "cyborg7_list_tasks",
      "List tasks in the workspace. Filter by status, assignee, project, workflow " +
        "state, priority, or label. Each line STARTS WITH the task's id — that leading " +
        "token is what you pass to cyborg7_update_task / cyborg7_delete_task. The `#N` " +
        "shown after it is the per-project sequence, a human-facing reference only (NOT " +
        "accepted by those tools). Lines also carry state/priority and any label/module ids.",
      {
        status: z.string().optional().describe(TASK_STATUS_HELP),
        assignee: z
          .string()
          .optional()
          .describe("Filter by assignee ID (a human userId or a cybo id)"),
        // Tasks Redesign (Plane-style) — additive filters, all optional. Honored on
        // cloud workspaces (the relay's richer task read); the local fallback only
        // filters on status/assignee.
        projectId: z.string().optional().describe("Filter to a Tasks-project by id"),
        state: z
          .string()
          .optional()
          .describe("Filter by workflow-state id or name within the project's catalog"),
        priority: z
          .enum(["urgent", "high", "medium", "low", "none"])
          .optional()
          .describe("Filter by priority"),
        label: z.string().optional().describe("Filter by label NAME"),
      },
      async ({ status, assignee, projectId, state, priority, label }) => {
        let tasks: Awaited<ReturnType<typeof readTasks>>;
        try {
          tasks = await readTasks({
            status: status ?? undefined,
            assigneeId: assignee ?? undefined,
            projectId: projectId ?? undefined,
            state: state ?? undefined,
            priority: priority ?? undefined,
            label: label ?? undefined,
          });
        } catch (err) {
          return mcpText(`Error: ${err instanceof Error ? err.message : "could not list tasks"}`);
        }

        // Group by the REAL status so a cybo's summary reflects the TRUE board
        // (every status incl. backlog/pending), not a flat sliver. With NO status
        // filter readTasks returns ALL statuses (no implicit drop) — the bug was the
        // misadvertised enum, not the read.
        return mcpText(formatTasksByStatus(tasks));
      },
    );

  if (tasksEnabled)
    server.tool(
      "cyborg7_list_projects",
      "List the workspace's Tasks-projects — the buckets a task can be filed under. " +
        "Call this BEFORE cyborg7_create_task whenever you're unsure which project a task " +
        "belongs to: pick the entry whose work matches and pass its `id` as create_task's " +
        "`projectId`. The entry with `isInbox: true` is the workspace catch-all for tasks " +
        "with no channel or project. Each entry carries its short `identifier` (the task-" +
        "key prefix, e.g. ENG) and human `name`. Returns a JSON array of " +
        "{ id, identifier, name, color, isInbox, chatProjectId }.",
      {
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include archived projects. Defaults to false (active projects only)."),
      },
      async ({ includeArchived }) => {
        // Same connected-vs-solo resolution as cyborg7_list_tasks/readTasks: a CLOUD
        // workspace's Tasks-projects live ONLY in the relay's PG (this daemon has no
        // DATABASE_URL and its local SQLite catalog is near-empty), so a cybo on a
        // cloud daemon round-trips to the relay's cyboRead "projects" kind — which
        // returns the SAME enriched shape ({ id, identifier, name, color, isInbox,
        // chatProjectId }) the UI/board read from the shared PG. On a relay miss
        // (unreachable / old relay → null) we fall through cleanly to the local SQLite
        // catalog below (solo mode, or a seeded cache). NOTE: the relay's projects
        // read returns the workspace's full set (its response carries no archived
        // flag), so `includeArchived` narrows only the local fallback.
        try {
          // A non-cybo workspace session reads with its spawning user's identity —
          // same relay round-trip as readTasks, otherwise it only ever sees the
          // near-empty local catalog.
          if (cyboRead && (ctx.cyboId || ctx.initiatedByUserId)) {
            const res = await cyboRead({
              workspaceId: ctx.workspaceId,
              cyboId: ctx.cyboId,
              userId: ctx.cyboId ? undefined : ctx.initiatedByUserId,
              kind: "projects",
            });
            if (res) {
              if (!res.ok) throw new Error(res.error ?? "relay read failed");
              return mcpText(JSON.stringify(res.projects ?? []));
            }
            // null = relay unreachable / old relay — fall through to local SQLite.
          }
          // Local Tasks-project catalog. tasks_projects has no name column — the
          // display name is the linked chat project's name (chat_project_id ->
          // projects.name), or "Inbox" for the synthetic catch-all (chat_project_id
          // null). Build the lookup once.
          const nameById = new Map(
            storage.getProjects(ctx.workspaceId).map((p) => [p.id, p.name] as [string, string]),
          );
          const out = buildTasksProjectList(
            storage.sqlite.getTasksProjects(ctx.workspaceId),
            nameById,
            includeArchived ?? false,
          );
          return mcpText(JSON.stringify(out));
        } catch (err) {
          return mcpText(
            `Error: ${err instanceof Error ? err.message : "could not list projects"}`,
          );
        }
      },
    );

  // ─── Documented Pages (read-only) ───────────────────────────────────
  //
  // When Tasks is enabled a cybo can READ the workspace's Pages (docs): list a
  // project's page hierarchy and read a page's body. Resolution mirrors the task
  // reads — relay round-trip (cloud; owner-visibility gated relay-side) → direct PG
  // → local SQLite (solo). READ-ONLY: a cybo never creates/updates/deletes a page
  // through this MCP. Owner ACL: a cybo inherits its OWNER's page visibility, so a
  // private page owned by another member is never surfaced.
  if (tasksEnabled) {
    interface PageBrief {
      id: string;
      title: string;
      parentId: string | null;
      icon: string | null;
    }
    const briefOf = (p: {
      id: string;
      title: string;
      parentId: string | null;
      icon: string | null;
    }): PageBrief => ({ id: p.id, title: p.title, parentId: p.parentId, icon: p.icon });

    const readProjectPages = async (projectId: string): Promise<PageBrief[]> => {
      if (cyboRead && ctx.cyboId) {
        const res = await cyboRead({
          workspaceId: ctx.workspaceId,
          cyboId: ctx.cyboId,
          kind: "pages",
          projectId,
        });
        if (res) {
          if (!res.ok) throw new Error(res.error ?? "relay read failed");
          return res.pages ?? [];
        }
        // null = relay unreachable — fall through to local stores.
      }
      if (storage.pg) {
        // Direct-PG daemon: gate the project for the cybo, then return the public +
        // null-owner pages. A cybo owns no pages, so passing its id yields exactly
        // that safe subset (never another member's private page).
        if (ctx.cyboId && !(await storage.pg.assertProjectVisibleForCybo(projectId, ctx.cyboId))) {
          throw new Error("project not found");
        }
        const pages = await storage.pg.getProjectPages(projectId, ctx.cyboId ?? ctx.agentId);
        return pages.map(briefOf);
      }
      // Solo (local SQLite): channels are workspace-visible locally, so the read
      // applies only its public/null-owner/own-owner filter.
      return storage.getProjectPages(projectId, ctx.cyboId ?? ctx.agentId).map(briefOf);
    };

    server.tool(
      "cyborg7_list_pages",
      "List the documented Pages (docs/wiki) in a Tasks-project as a flat hierarchy. " +
        "Each entry is { id, title, parentId, icon } — parentId null means a root page; " +
        "follow parentId to reconstruct the tree. Pass a page id to cyborg7_read_page to " +
        "read its body. Use cyborg7_list_projects first to find the projectId.",
      {
        projectId: z.string().describe("The Tasks-project id whose pages to list"),
      },
      async ({ projectId }) => {
        try {
          return mcpText(JSON.stringify(await readProjectPages(projectId)));
        } catch (err) {
          return mcpText(`Error: ${err instanceof Error ? err.message : "could not list pages"}`);
        }
      },
    );

    interface PageFull extends PageBrief {
      content: string;
    }
    const readOnePage = async (pageId: string): Promise<PageFull | null> => {
      if (cyboRead && ctx.cyboId) {
        const res = await cyboRead({
          workspaceId: ctx.workspaceId,
          cyboId: ctx.cyboId,
          kind: "page",
          pageId,
        });
        if (res) {
          if (!res.ok) throw new Error(res.error ?? "relay read failed");
          return res.page ?? null;
        }
        // null = relay unreachable — fall through to local stores.
      }
      if (storage.pg) {
        const projectId = await storage.pg.getPageProjectId(pageId);
        if (!projectId) return null;
        if (ctx.cyboId && !(await storage.pg.assertProjectVisibleForCybo(projectId, ctx.cyboId))) {
          return null;
        }
        // getPageById applies no page-level visibility filter — resolve the page out
        // of the OWNER-VISIBLE set (one query, no N+1) so a private page never leaks.
        const visible = await storage.pg.getProjectPages(projectId, ctx.cyboId ?? ctx.agentId);
        const found = visible.find((p) => p.id === pageId);
        return found ? { ...briefOf(found), content: found.content } : null;
      }
      // Solo: anchor the page to this workspace.
      const page = storage.getPage(pageId);
      if (!page || page.workspaceId !== ctx.workspaceId) return null;
      return { ...briefOf(page), content: page.content };
    };

    server.tool(
      "cyborg7_read_page",
      "Read a single documented Page (doc) by id, including its body content. Get a " +
        "page id from cyborg7_list_pages. Returns { id, title, content, parentId, icon }.",
      {
        pageId: z.string().describe("The page id to read (from cyborg7_list_pages)"),
      },
      async ({ pageId }) => {
        try {
          const page = await readOnePage(pageId);
          if (!page) return mcpText(`Error: page '${pageId}' not found in this workspace`);
          return mcpText(JSON.stringify(page));
        } catch (err) {
          return mcpText(`Error: ${err instanceof Error ? err.message : "could not read page"}`);
        }
      },
    );

    // ─── Documented Page WRITES (create / update / nest) ──────────────
    //
    // Mirror the cybo TASK write surface: gated on the same create_task grant (pages
    // are part of Tasks), workspace-scoped, and resolved cloud → local. Cloud writes
    // go through cyboPageWrite (the relay validates the OWNER's project visibility and
    // applies the backend's cycle guard); the local fallback writes SQLite directly.
    // A page is created blank then its content/icon set, mirroring the UI create flow
    // (storage.createPage takes no body). parentId nests at birth (#1042); the backend
    // ON DELETE SET NULL parent_id + the cycle guard keep the hierarchy safe.
    if (allows("create_task")) {
      // Shared cloud-write helper. Returns the relay result, or null on a relay miss
      // (unreachable / old relay) so the caller falls back to the local write.
      const writePageViaRelay = async (req: {
        kind: "create_page" | "update_page" | "nest_page";
        projectId?: string;
        title?: string;
        content?: string;
        icon?: string | null;
        parentId?: string | null;
        pageId?: string;
      }) => {
        if (!cyboPageWrite || !(ctx.cyboId || ctx.initiatedByUserId)) return null;
        return cyboPageWrite({
          workspaceId: ctx.workspaceId,
          cyboId: ctx.cyboId,
          createdBy: ctx.initiatedByUserId,
          agentId: ctx.agentId,
          ...req,
        });
      };

      server.tool(
        "cyborg7_create_page",
        "Create a documented Page (doc) in a Tasks-project. Only title+projectId are " +
          "required. Pass `parentId` to NEST the new page under an existing page (a " +
          "subpage). `content` is the page body (markdown/plain text); `icon` is a single " +
          "emoji glyph. Use cyborg7_list_projects to find the projectId, and " +
          "cyborg7_list_pages to find a parent page id. Returns the created page JSON.",
        {
          title: z.string().describe("Page title"),
          projectId: z.string().describe("The Tasks-project id to create the page in"),
          content: z
            .string()
            .optional()
            .describe("Page body (markdown/plain text). Defaults blank."),
          icon: z.string().optional().describe("A single emoji glyph for the page icon"),
          parentId: z
            .string()
            .optional()
            .describe(
              "Parent page id to nest this new page under (a subpage). Omit for a root page.",
            ),
        },
        async ({ title, projectId, content, icon, parentId }) => {
          try {
            const cloud = await writePageViaRelay({
              kind: "create_page",
              projectId,
              title,
              content,
              icon,
              parentId: parentId ?? null,
            });
            if (cloud) {
              if (!cloud.ok || !cloud.page)
                return mcpText(`Error: ${cloud.error ?? "page create failed"}`);
              return mcpText(JSON.stringify(cloud.page));
            }
            // Solo / PG-less fallback — create blank, then set body/icon if given.
            const created = storage.createPage({
              projectId,
              title,
              ownedBy: ctx.initiatedByUserId ?? ctx.cyboId ?? ctx.agentId,
              parentId: parentId ?? null,
            });
            const page =
              content !== undefined || icon !== undefined
                ? (storage.updatePage(created.id, { content, icon }) ?? created)
                : created;
            return mcpText(
              JSON.stringify({
                id: page.id,
                title: page.title,
                parentId: page.parentId,
                icon: page.icon,
              }),
            );
          } catch (err) {
            return mcpText(
              `Error: ${err instanceof Error ? err.message : "could not create page"}`,
            );
          }
        },
      );

      server.tool(
        "cyborg7_update_page",
        "Update a documented Page's metadata/content: retitle it, replace its body " +
          "(`content`), or set/clear its `icon`. Every field except pageId is optional; " +
          "omitted fields are left unchanged. Use cyborg7_nest_page to (re)parent a page.",
        {
          pageId: z.string().describe("The page id to update (from cyborg7_list_pages)"),
          title: z.string().optional().describe("New page title"),
          content: z.string().optional().describe("Replace the page body (markdown/plain text)"),
          icon: z
            .string()
            .nullable()
            .optional()
            .describe("Set the emoji icon, or null to clear it. Omit to leave unchanged."),
        },
        async ({ pageId, title, content, icon }) => {
          try {
            const cloud = await writePageViaRelay({
              kind: "update_page",
              pageId,
              title,
              content,
              icon,
            });
            if (cloud) {
              if (!cloud.ok || !cloud.page)
                return mcpText(`Error: ${cloud.error ?? `page '${pageId}' not found`}`);
              return mcpText(JSON.stringify(cloud.page));
            }
            // Solo / PG-less fallback — anchor to this workspace before mutating.
            const existing = storage.getPage(pageId);
            if (!existing || existing.workspaceId !== ctx.workspaceId) {
              return mcpText(`Error: page '${pageId}' not found in this workspace`);
            }
            const page = storage.updatePage(pageId, { title, content, icon });
            if (!page) return mcpText(`Error: page '${pageId}' not found`);
            return mcpText(
              JSON.stringify({
                id: page.id,
                title: page.title,
                parentId: page.parentId,
                icon: page.icon,
              }),
            );
          } catch (err) {
            return mcpText(
              `Error: ${err instanceof Error ? err.message : "could not update page"}`,
            );
          }
        },
      );

      server.tool(
        "cyborg7_nest_page",
        "Nest (or un-nest) a documented Page: set its parent to another page in the SAME " +
          "project, or pass parentId=null to move it back to the root. Rejected if it " +
          "would create a cycle (a page can't become its own ancestor) or if the parent " +
          "is in another project.",
        {
          pageId: z.string().describe("The page id to (re)parent"),
          parentId: z
            .string()
            .nullable()
            .describe("Parent page id to nest under, or null to move the page to the root"),
        },
        async ({ pageId, parentId }) => {
          try {
            const cloud = await writePageViaRelay({ kind: "nest_page", pageId, parentId });
            if (cloud) {
              if (!cloud.ok || !cloud.page)
                return mcpText(`Error: ${cloud.error ?? `page '${pageId}' not found`}`);
              return mcpText(JSON.stringify(cloud.page));
            }
            // Solo / PG-less fallback — anchor to this workspace; storage.updatePage
            // applies the same cycle/cross-project guard as the backend.
            const existing = storage.getPage(pageId);
            if (!existing || existing.workspaceId !== ctx.workspaceId) {
              return mcpText(`Error: page '${pageId}' not found in this workspace`);
            }
            const page = storage.updatePage(pageId, { parentId });
            if (!page) return mcpText(`Error: page '${pageId}' not found`);
            return mcpText(
              JSON.stringify({
                id: page.id,
                title: page.title,
                parentId: page.parentId,
                icon: page.icon,
              }),
            );
          } catch (err) {
            // PageCycleError + "parent page not found in this project" are user input.
            return mcpText(`Error: ${err instanceof Error ? err.message : "could not nest page"}`);
          }
        },
      );
    }
  }

  // ─── Cross-session context (cybo recall) — OWNER-SCOPED reads ───────
  //
  // These let a cybo review the OWNER's OTHER sessions with the SAME cybo: explore by
  // recency, read one session's transcript, and search across them for recall. They
  // are READ tools — always exposed (like the other reads). Owner scoping is enforced
  // inside CyboSessionContext at the DATA layer (the agent_bindings set), so a cybo
  // can never reach a session it isn't entitled to, regardless of the args it passes.
  // Only registered for a CYBO (ctx.cyboId) on a daemon with a durable timeline store.
  if (ctx.cyboId && sessionContext) {
    const sc = sessionContext;
    const cyboId = ctx.cyboId;
    const ownerLocalId = sc.resolveOwnerLocalId(ctx.agentId, ctx.initiatedByUserId);

    server.tool(
      "cyborg7_list_my_sessions",
      "List the OWNER's other sessions with you (this cybo), most-recent first — the " +
        "human you're talking to, across their past conversations with you. Use this to " +
        "see what you've worked on together before. Returns a JSON array of " +
        "{ sessionId, title, channelId, lastActiveAt, preview, isCurrent }. The entry " +
        "with isCurrent:true is THIS conversation. Pass a sessionId to cyborg7_read_session " +
        "to read it, or use cyborg7_search_sessions to find a specific moment.",
      {
        limit: z
          .number()
          .optional()
          .describe("Max sessions to return (default 50, most-recent first)."),
        includeCurrent: z
          .boolean()
          .optional()
          .describe(
            "Include the current session in the list. Defaults to true (flagged isCurrent).",
          ),
      },
      async ({ limit, includeCurrent }) => {
        try {
          const sessions = await sc.listSessions({
            workspaceId: ctx.workspaceId,
            cyboId,
            ownerLocalId,
            currentAgentId: ctx.agentId,
            limit,
          });
          const visible =
            includeCurrent === false ? sessions.filter((s) => !s.isCurrent) : sessions;
          return mcpText(JSON.stringify(visible));
        } catch (err) {
          return mcpText(
            `Error: ${err instanceof Error ? err.message : "could not list sessions"}`,
          );
        }
      },
    );

    server.tool(
      "cyborg7_read_session",
      "Read the transcript (timeline) of one of the OWNER's sessions with you (this " +
        "cybo). Pass a sessionId from cyborg7_list_my_sessions or cyborg7_search_sessions. " +
        "Returns a JSON array of { seq, role, text, timestamp } in chronological order " +
        "(role: user = the human, assistant = you). Owner-checked: a session that isn't " +
        "the owner's is reported as not found.",
      {
        sessionId: z.string().describe("The session id (from cyborg7_list_my_sessions)."),
        limit: z
          .number()
          .optional()
          .describe("Max timeline entries to return (default 200, the tail of the session)."),
      },
      async ({ sessionId, limit }) => {
        try {
          const timeline = await sc.readSession({
            workspaceId: ctx.workspaceId,
            cyboId,
            ownerLocalId,
            sessionId,
            limit,
          });
          if (timeline === null) {
            return mcpText(`Error: session '${sessionId}' not found (or not the owner's).`);
          }
          return mcpText(JSON.stringify(timeline));
        } catch (err) {
          return mcpText(`Error: ${err instanceof Error ? err.message : "could not read session"}`);
        }
      },
    );

    server.tool(
      "cyborg7_search_sessions",
      "Search the OWNER's past sessions with you (this cybo) for a phrase — for recall " +
        '("what did I say in another conversation?"). Case-insensitive substring match ' +
        "over the messages in those sessions. Excludes the CURRENT session by default so " +
        "you don't match what was just said. Returns a JSON array of " +
        "{ sessionId, seq, role, snippet, timestamp }, ordered by session recency.",
      {
        query: z.string().describe("Text to search for across the owner's sessions."),
        limit: z.number().optional().describe("Max matches to return (default 25)."),
        includeCurrent: z
          .boolean()
          .optional()
          .describe("Also search the current session. Defaults to false."),
      },
      async ({ query, limit, includeCurrent }) => {
        try {
          const hits = await sc.searchSessions({
            workspaceId: ctx.workspaceId,
            cyboId,
            ownerLocalId,
            query,
            currentAgentId: ctx.agentId,
            includeCurrent,
            limit,
          });
          return mcpText(JSON.stringify(hits));
        } catch (err) {
          return mcpText(
            `Error: ${err instanceof Error ? err.message : "could not search sessions"}`,
          );
        }
      },
    );
  }

  if (tasksEnabled && allows("create_task")) {
    server.tool(
      "cyborg7_update_task",
      "Update a task: change its board status/state, (re)assign it, re-prioritize, " +
        "move it between projects/cycles, retag its labels/modules, or record a result. " +
        "Every field except taskId is optional; omitted fields are left unchanged.",
      {
        taskId: z
          .string()
          .describe(
            "The task's id (the leading `task…`/uuid token shown by cyborg7_list_tasks, " +
              "or the id returned by cyborg7_create_task). The `#N` sequence shown in lists " +
              "is NOT accepted.",
          ),
        status: z
          .string()
          .optional()
          .describe(
            "New status — one of: " +
              TASK_STATUSES.join(" | ") +
              ". Prefer `stateId` to move between board columns; status is the back-compat mirror.",
          ),
        assignee: z
          .string()
          .optional()
          .describe("(Re)assign the task: a human userId, or a cybo id (the bare-text assigneeId)"),
        result: z.string().optional().describe("Task result or output"),
        // Tasks Redesign (Plane-style) — additive, all optional.
        stateId: z
          .string()
          .optional()
          .describe(
            "Move the task to a workflow-state id in the project's catalog. The legacy " +
              "status is mirrored from the state's group.",
          ),
        priority: z
          .enum(["urgent", "high", "medium", "low", "none"])
          .optional()
          .describe("Re-prioritize the task"),
        projectId: z.string().optional().describe("Move the task to another Tasks-project"),
        parentId: z
          .string()
          .optional()
          .describe("Re-parent the task as a sub-task of this task id"),
        startDate: z.string().optional().describe("Planned start date ISO string"),
        dueAt: z.string().optional().describe("Due date ISO string"),
        labels: z
          .array(z.string())
          .optional()
          .describe(
            "Replace the task's labels with these NAMES (auto-created in the project " +
              "catalog). An empty array clears all labels.",
          ),
        cycleId: z.string().optional().describe("Move the task to this cycle (sprint) id"),
        moduleIds: z
          .array(z.string())
          .optional()
          .describe("Replace the task's module associations with these ids"),
      },
      async ({
        taskId,
        status,
        assignee,
        result,
        stateId,
        priority,
        projectId,
        parentId,
        startDate,
        dueAt,
        labels,
        cycleId,
        moduleIds,
      }) => {
        const due = dueAt ? new Date(dueAt).getTime() : undefined;
        if (due !== undefined && !Number.isFinite(due)) {
          return {
            content: [{ type: "text" as const, text: "Error: invalid dueAt date format" }],
          };
        }
        const start = startDate ? new Date(startDate).getTime() : undefined;
        if (start !== undefined && !Number.isFinite(start)) {
          return {
            content: [{ type: "text" as const, text: "Error: invalid startDate date format" }],
          };
        }
        // Cloud relay path — mirrors create_task: fires for a cybo (ctx.cyboId) AND
        // for a NON-cybo agent that carries a spawning user (ctx.initiatedByUserId).
        // The shared task lives in PG, not the no-PG cloud daemon's SQLite, so the
        // relay round-trip is the only path that can reach it; the user-owned actor
        // is resolved relay-side from createdBy (handleCyboWrite/resolveCyboWriteActor).
        if (cyboWrite && (ctx.cyboId || ctx.initiatedByUserId)) {
          const res = await cyboWrite({
            workspaceId: ctx.workspaceId,
            cyboId: ctx.cyboId,
            kind: "update_task",
            agentId: ctx.agentId,
            // Owner/actor for a NON-cybo agent: the spawning user (the relay resolves
            // and validates the user from this). Undefined for a cybo.
            createdBy: ctx.initiatedByUserId,
            taskId,
            status,
            assigneeId: assignee,
            result,
            // Tasks Redesign — forward the Plane-style updates; an old relay ignores
            // the unknown fields and applies only status/assignee/result.
            stateId,
            priority,
            projectId,
            parentId,
            startDate: start,
            dueAt: due,
            labels,
            cycleId,
            moduleIds,
          });
          if (res) {
            if (!res.ok || !res.task) {
              return mcpText(`Error: ${res.error ?? `task '${taskId}' not found`}`);
            }
            return mcpText(`Task updated: [${res.task.status}] ${res.task.title}`);
          }
        }
        // Local (solo / PG-less) fallback — DualStorage.updateTask resolves label
        // NAMES to ids and replace-sets the label/module joins; scalars pass through
        // as task columns. Only forward fields the caller set (undefined = unchanged).
        const task = storage.updateTask(taskId, {
          status,
          assigneeId: assignee,
          result,
          stateId,
          priority,
          projectId,
          parentId,
          startDate: start,
          dueAt: due,
          labels,
          cycleId,
          moduleIds,
        });
        if (!task)
          return {
            content: [{ type: "text" as const, text: `Error: task '${taskId}' not found` }],
          };

        return {
          content: [
            { type: "text" as const, text: `Task updated: [${task.status}] ${task.title}` },
          ],
        };
      },
    );
  }

  // Bulk-update helpers (kept out of the tool handler so it stays under the
  // cyclomatic-complexity cap). A `patch` shape with the absent (undefined) fields
  // dropped, and the cloud bulk write (one update_task relay round-trip per id).
  interface BulkFields {
    status?: string;
    assigneeId?: string;
    priority?: string;
    stateId?: string;
    dueAt?: number;
  }
  const buildTaskPatch = (f: BulkFields): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) if (v !== undefined) patch[k] = v;
    return patch;
  };
  // Returns the result text on the cloud path, or null when the relay didn't answer
  // (old relay / disconnected) so the caller falls back to the local write. A cross-
  // workspace id is rejected by the relay's per-task anchor and never mutated.
  const bulkUpdateViaRelay = async (ids: string[], fields: BulkFields): Promise<string | null> => {
    if (!cyboWrite || !(ctx.cyboId || ctx.initiatedByUserId)) return null;
    // Atomic IDOR pre-flight, matching the solo branch: when we can AUTHORITATIVELY
    // enumerate this workspace's tasks (the relay read for a cybo, or a direct PG
    // handle), reject the WHOLE op if ANY id is foreign so a mixed valid+foreign
    // batch mutates NOTHING — the same all-or-nothing contract the solo path gives,
    // instead of silently patching the valid ids and reporting the foreign one. When
    // no authoritative source exists (a PG-less non-cybo agent) the pre-flight is
    // skipped and the relay's per-task anchor still rejects each foreign id per-id.
    if ((cyboRead && ctx.cyboId) || storage.pg) {
      const known = new Set((await readTasks({})).map((t) => t.id));
      const foreign = ids.filter((id) => !known.has(id));
      if (foreign.length > 0) {
        return `Error: task(s) not found in this workspace: ${foreign.join(", ")}`;
      }
    }
    let probed = false;
    let updated = 0;
    const failed: string[] = [];
    let relayGone = false;
    // Bounded concurrency: fan the per-id update_task writes out in chunks of 5
    // (each still anchored + gated + activity-logged relay-side) instead of one
    // strictly-serial round-trip per id. Semantics preserved: if ANY write in a
    // chunk returns null the relay went away mid-op, so we abandon the cloud path
    // entirely and fall back to local — never reporting a partial cloud result.
    const CHUNK = 5;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const results = await Promise.all(
        chunk.map((taskId) =>
          cyboWrite({
            workspaceId: ctx.workspaceId,
            cyboId: ctx.cyboId,
            kind: "update_task",
            agentId: ctx.agentId,
            createdBy: ctx.initiatedByUserId,
            taskId,
            ...fields,
          }),
        ),
      );
      if (results.some((res) => !res)) {
        relayGone = true; // relay unreachable — abandon cloud, fall to local
        break;
      }
      probed = true;
      results.forEach((res, j) => {
        if (res?.ok) updated++;
        else failed.push(chunk[j]);
      });
    }
    if (relayGone || !probed) return null;
    const suffix = failed.length > 0 ? ` (not found: ${failed.join(", ")})` : "";
    return `Bulk update applied to ${updated}/${ids.length} task(s)${suffix}`;
  };

  // Tasks Phase 0 ops (archive / delete / bulk-update). Owner decision: REUSE the
  // existing create_task grant — no new permission. Each op is workspace-anchored
  // (IDOR guard, the #920 lesson) on BOTH paths: cloud via the relay's per-task
  // anchor in handleCyboWrite, solo via getTaskById + a workspace_id check.
  if (tasksEnabled && allows("create_task")) {
    server.tool(
      "cyborg7_archive_task",
      "Archive (or restore) a task. Archived tasks are hidden from the active board " +
        "but kept (reversible). Pass archived=false to restore.",
      {
        taskId: z
          .string()
          .describe(
            "The task's id (the leading `task…`/uuid token shown by cyborg7_list_tasks, " +
              "or the id returned by cyborg7_create_task). The `#N` sequence shown in lists " +
              "is NOT accepted.",
          ),
        archived: z
          .boolean()
          .optional()
          .describe("true = archive (default); false = restore to the active board"),
      },
      async ({ taskId, archived }) => {
        const doArchive = archived !== false;
        // Cloud: archive rides the update_task kind with archivedAt (epoch ms to
        // archive, null to restore). Mirrors create/update — fires for a cybo or a
        // spawning-user-owned non-cybo agent. null = old relay/disconnected → local.
        if (cyboWrite && (ctx.cyboId || ctx.initiatedByUserId)) {
          const res = await cyboWrite({
            workspaceId: ctx.workspaceId,
            cyboId: ctx.cyboId,
            kind: "update_task",
            agentId: ctx.agentId,
            createdBy: ctx.initiatedByUserId,
            taskId,
            archivedAt: doArchive ? Date.now() : null,
          });
          if (res) {
            if (!res.ok) return mcpText(`Error: ${res.error ?? `task '${taskId}' not found`}`);
            return mcpText(`Task ${doArchive ? "archived" : "restored"}: ${taskId}`);
          }
        }
        // Solo / PG-less fallback — anchor to this workspace before mutating.
        const existing = storage.getTaskById(taskId);
        if (!existing || existing.workspace_id !== ctx.workspaceId) {
          return mcpText(`Error: task '${taskId}' not found in this workspace`);
        }
        const task = storage.archiveTask(taskId, doArchive);
        if (!task) return mcpText(`Error: task '${taskId}' not found`);
        return mcpText(`Task ${doArchive ? "archived" : "restored"}: ${taskId}`);
      },
    );

    server.tool(
      "cyborg7_delete_task",
      "Permanently delete a task (irreversible). Prefer cyborg7_archive_task unless " +
        "the task must be removed entirely.",
      {
        taskId: z
          .string()
          .describe(
            "The task's id (the leading `task…`/uuid token shown by cyborg7_list_tasks, " +
              "or the id returned by cyborg7_create_task). The `#N` sequence shown in lists " +
              "is NOT accepted.",
          ),
      },
      async ({ taskId }) => {
        // Cloud: dedicated delete_task kind (workspace-anchored relay-side).
        if (cyboWrite && (ctx.cyboId || ctx.initiatedByUserId)) {
          const res = await cyboWrite({
            workspaceId: ctx.workspaceId,
            cyboId: ctx.cyboId,
            kind: "delete_task",
            agentId: ctx.agentId,
            createdBy: ctx.initiatedByUserId,
            taskId,
          });
          if (res) {
            if (!res.ok) return mcpText(`Error: ${res.error ?? `task '${taskId}' not found`}`);
            return mcpText(`Task deleted: ${taskId}`);
          }
        }
        // Solo / PG-less fallback — anchor to this workspace before deleting.
        const existing = storage.getTaskById(taskId);
        if (!existing || existing.workspace_id !== ctx.workspaceId) {
          return mcpText(`Error: task '${taskId}' not found in this workspace`);
        }
        const deleted = storage.deleteTask(taskId);
        if (!deleted) return mcpText(`Error: task '${taskId}' not found`);
        return mcpText(`Task deleted: ${taskId}`);
      },
    );

    server.tool(
      "cyborg7_bulk_update_tasks",
      "Apply the SAME field changes to many tasks at once (e.g. move several to done, " +
        "or reassign a batch). Every patch field except taskIds is optional; omitted " +
        "fields are left unchanged.",
      {
        taskIds: z
          .array(z.string())
          .min(1)
          .describe(
            "The ids of the tasks to update (each the leading `task…`/uuid token shown by " +
              "cyborg7_list_tasks, or an id returned by cyborg7_create_task). The `#N` sequence " +
              "shown in lists is NOT accepted.",
          ),
        status: z
          .string()
          .optional()
          .describe(
            "New status — one of: " +
              TASK_STATUSES.join(" | ") +
              ". Prefer `stateId` to move between board columns; status is the back-compat mirror.",
          ),
        assignee: z
          .string()
          .optional()
          .describe("(Re)assign: a human userId, or a cybo id (the bare-text assigneeId)"),
        priority: z
          .enum(["urgent", "high", "medium", "low", "none"])
          .optional()
          .describe("Re-prioritize"),
        stateId: z
          .string()
          .optional()
          .describe("Move to a workflow-state id in the project catalog"),
        dueAt: z.string().optional().describe("Due date ISO string"),
      },
      async ({ taskIds, status, assignee, priority, stateId, dueAt }) => {
        const due = dueAt ? new Date(dueAt).getTime() : undefined;
        if (due !== undefined && !Number.isFinite(due)) {
          return mcpText("Error: invalid dueAt date format");
        }
        const ids = [...new Set(taskIds)];
        const fields = { status, assigneeId: assignee, priority, stateId, dueAt: due };
        // Cloud first: REUSE the update_task kind once per id (each anchored + gated +
        // activity-logged relay-side) — no separate bulk kind. null = relay didn't
        // answer → fall through to the local write.
        const cloud = await bulkUpdateViaRelay(ids, fields);
        if (cloud !== null) return mcpText(cloud);
        // Solo / PG-less fallback. IDOR guard: reject the WHOLE op if ANY id is not
        // in this workspace, so a crafted cross-workspace id mutates nothing.
        const foreign = ids.filter((id) => {
          const t = storage.getTaskById(id);
          return !t || t.workspace_id !== ctx.workspaceId;
        });
        if (foreign.length > 0) {
          return mcpText(`Error: task(s) not found in this workspace: ${foreign.join(", ")}`);
        }
        const tasks = storage.bulkUpdateTasks(ids, buildTaskPatch(fields));
        return mcpText(`Bulk update applied to ${tasks.length}/${ids.length} task(s)`);
      },
    );
  }

  server.tool("cyborg7_list_channels", "List channels in the workspace", {}, async () => {
    try {
      const channels = await readChannels();
      const formatted = channels
        .map((c) => {
          const desc = "description" in c && c.description ? ` — ${c.description}` : "";
          const member =
            "isMember" in c && (c as { isMember?: boolean }).isMember ? " (member)" : "";
          return `#${c.name}${desc}${member}`;
        })
        .join("\n");
      return mcpText(formatted || "(no channels)");
    } catch (err) {
      return mcpText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  server.tool(
    "cyborg7_list_channel_members",
    "List the members of a channel — both human users and cybos. Use this to resolve " +
      "a person's name to their USER id before notifying them with the `mentions` " +
      "argument of cyborg7_send_message. Each row shows the member type (user|cybo), " +
      "display name, role, and the id to mention.",
    {
      channel: z.string().describe("Channel name or ID"),
    },
    async ({ channel }) => {
      const channels = await readChannels();
      const target = channels.find((c) => c.name === channel || c.id === channel);
      if (!target) return mcpText(`Error: channel '${channel}' not found`);
      // A cybo may only inspect a channel it is a member of (Phase 2 gate).
      const denied = await requireChannelMembership(target);
      if (denied) return denied;
      let members: Awaited<ReturnType<typeof readChannelMembers>>;
      try {
        members = await readChannelMembers(target.id);
      } catch (err) {
        return mcpText(
          `Error: ${err instanceof Error ? err.message : "could not list channel members"}`,
        );
      }
      const formatted = members
        .map((m) => `[${m.memberType}] ${m.name || m.id} (${m.role || "—"}) — ${m.id}`)
        .join("\n");
      return mcpText(formatted || "(no members)");
    },
  );

  server.tool(
    "cyborg7_get_workspace_roster",
    "Get all members and agents in the workspace",
    {},
    async () => {
      // Relay-aware (same order as cyborg7_list_channel_members). A CLOUD daemon
      // has NO PG handle, so its local SQLite holds only the owner + this cybo —
      // reading it under-reports the roster (the bug where a cybo saw 2 of 5
      // members). Read the SHARED PG the UI sees: relay round-trip (cloud), then a
      // direct PG handle (connected daemon), then local SQLite (solo).
      if (cyboRead && ctx.cyboId) {
        const res = await cyboRead({
          workspaceId: ctx.workspaceId,
          cyboId: ctx.cyboId,
          kind: "roster",
        });
        if (res) {
          if (!res.ok) throw new Error(res.error ?? "relay read failed");
          const text = (res.members ?? [])
            .map((m) =>
              m.memberType === "cybo"
                ? `[agent] ${m.name ?? m.id}`
                : `[human] ${m.name ?? m.id} (${m.role ?? "member"})`,
            )
            .join("\n");
          return { content: [{ type: "text" as const, text: text || "(empty workspace)" }] };
        }
        // null = relay unreachable — fall through to local stores.
      }
      if (storage.pg) {
        const [humans, cybos] = await Promise.all([
          storage.pg.getMembers(ctx.workspaceId),
          storage.pg.getCybos(ctx.workspaceId),
        ]);
        const text = [
          ...humans.map((h) => `[human] ${h.name ?? h.email} (${h.role})`),
          ...cybos.map((c) => `[agent] ${c.name ?? c.id}`),
        ].join("\n");
        return { content: [{ type: "text" as const, text: text || "(empty workspace)" }] };
      }
      // Solo (local SQLite): workspace members + local agent bindings.
      const members = workspaceManager.getMembers(ctx.workspaceId);
      const bindings = storage.getAgentsByWorkspace(ctx.workspaceId);
      const memberLines = members.map((m) => `[human] ${m.name ?? m.email} (${m.role})`);
      const agentLines = bindings.map((b) => {
        const cybo = b.cybo_id ? storage.getCybo(b.cybo_id) : null;
        const name = cybo?.name ?? b.agent_id;
        return `[agent] ${name} (${b.provider})`;
      });
      const formatted = [...memberLines, ...agentLines].join("\n");
      return { content: [{ type: "text" as const, text: formatted || "(empty workspace)" }] };
    },
  );

  server.tool(
    "cyborg7_read_docs",
    "Read the Cyborg7 end-user documentation (the same docs published at " +
      'docs.cyborg7.com). Use this to answer a user\'s "how do I…?" question: first ' +
      "`nav` (browse the doc hierarchy) or `search` (keyword) to find the relevant guide, " +
      "then `get` its slug to read the full step-by-step content, and relay the user-facing " +
      "steps back to them. Read-only; covers the WHOLE corpus — getting started, how-to " +
      "guides, cybos, architecture, self-hosting, contributing, and per-integration connect " +
      "guides (Composio, Slack, Google/Gmail, Jira, ClickUp).",
    {
      mode: z
        .enum(["list", "nav", "get", "search"])
        .describe(
          "'nav' = ordered section→doc tree (browse the hierarchy); 'list' = flat index of " +
            "every doc; 'get' = one doc by slug; 'search' = keyword match",
        ),
      slug: z
        .string()
        .optional()
        .describe(
          "For mode='get': the doc slug, e.g. 'how-to/schedule-a-recurring-job' or " +
            "'integrations/gmail'; also accepts 'integration:<id>' (e.g. 'integration:slack')",
        ),
      query: z
        .string()
        .optional()
        .describe(
          "For mode='search': keywords matched against doc titles, summaries, and headings",
        ),
    },
    async ({ mode, slug, query }) => {
      if (mode === "get") {
        if (!slug) return mcpText(JSON.stringify({ error: "mode 'get' requires a slug" }));
        // Convenience: 'integration:<id>' → the integrations/<id> connect guide.
        const normalized = slug.startsWith("integration:")
          ? `integrations/${slug.slice("integration:".length).trim()}`
          : slug;
        const doc = getDoc(normalized);
        // Unknown slug → a graceful result object, never a throw.
        return mcpText(JSON.stringify(doc ?? { slug: normalized, found: false }, null, 2));
      }
      if (mode === "search") {
        if (!query) return mcpText(JSON.stringify({ error: "mode 'search' requires a query" }));
        return mcpText(JSON.stringify({ results: searchDocs(query) }, null, 2));
      }
      if (mode === "nav") {
        return mcpText(JSON.stringify({ nav: getNav() }, null, 2));
      }
      return mcpText(JSON.stringify({ docs: listDocs() }, null, 2));
    },
  );

  // Self-source access (task CYBO-78): registered only when running from a git
  // checkout. Extracted to a module-scope helper so this function gains no extra
  // branch (keeps createCyborg7McpServer's cyclomatic complexity in budget).
  registerReadSourceTool(server);

  // ─── Schedules (recurring cybo runs) ────────────────────────────

  // Scheduling a cybo is a recurring agent spawn (code execution), so the whole
  // schedule surface is gated on spawn_agents — without it a restricted cybo could
  // escalate past its own permission set by scheduling recurring runs (#204).
  if (allows("spawn_agents")) {
    server.tool(
      "cyborg7_schedule_create",
      "Schedule a cybo to run a prompt on a recurring cron cadence (e.g. every morning summarize a channel), or a one-shot (maxRuns=1) that fires once and deactivates (e.g. remind me Friday 17:00)",
      {
        cybo: z.string().describe("Cybo id or slug to run on the schedule"),
        cron: z.string().describe("Cron expression, e.g. '0 9 * * *' for 09:00 daily"),
        prompt: z.string().describe("The prompt to send the cybo each run"),
        channelId: z.string().optional().describe("Channel to run the cybo in"),
        taskId: z
          .string()
          .optional()
          .describe(
            "Bind this schedule to a task: each fire dispatches the task to its assignee cybo " +
              "(unattended). Omit for a raw-prompt cybo schedule.",
          ),
        timezone: z.string().optional().describe("IANA timezone for the cron, e.g. 'America/Lima'"),
        maxRuns: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Cap on total fires; 1 = a one-shot that deactivates after running. Omit for recurring.",
          ),
        catchUp: z
          .boolean()
          .optional()
          .describe(
            "If false, a schedule that fell >1 period behind (daemon offline) skips to its next future slot instead of firing late. Default true.",
          ),
      },
      async ({ cybo, cron, prompt, channelId, taskId, timezone, maxRuns, catchUp }) => {
        // Resolve by id or slug, but the cybo MUST belong to the caller's
        // workspace (issue #206). getCybo(id) is GLOBAL (WHERE id = ?), so we only
        // accept its result when it's in-workspace; otherwise fall back to the
        // workspace-scoped slug lookup. Checking workspace at resolution (rather
        // than rejecting after a global match) avoids a foreign id shadowing a
        // local cybo whose slug happens to equal that id.
        const cyboById = storage.getCybo(cybo);
        const target =
          (cyboById && cyboById.workspace_id === ctx.workspaceId ? cyboById : null) ??
          storage.getCyboBySlug(ctx.workspaceId, cybo) ??
          null;
        if (!target) {
          return {
            content: [
              { type: "text" as const, text: `No cybo found for "${cybo}" in this workspace` },
            ],
          };
        }
        // When binding to a task, the task MUST belong to the caller's workspace
        // (same isolation rule as the cybo above) — otherwise an agent could
        // schedule a foreign workspace's task to fire.
        if (taskId !== undefined) {
          const task = storage.getTaskById(taskId);
          if (!task || task.workspace_id !== ctx.workspaceId) {
            return {
              content: [
                { type: "text" as const, text: `No task found for "${taskId}" in this workspace` },
              ],
            };
          }
        }
        const cadence = { type: "cron" as const, expression: cron, timezone };
        try {
          validateScheduleCadence(cadence);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "invalid cron expression";
          return { content: [{ type: "text" as const, text: `Invalid cron: ${msg}` }] };
        }
        const nextRunAt = computeNextRunAt(cadence, new Date()).getTime();
        const createdBy = resolveScheduleCreatedBy(ctx, storage, target.created_by);
        // The cybo may pass the channel NAME; persist the canonical id (or null)
        // so the PG FK on schedules.channel_id accepts the mirror insert.
        const resolvedChannelId = await normalizeChannelId(channelId);
        const schedule = storage.createSchedule({
          workspaceId: ctx.workspaceId,
          cyboId: target.id,
          cronExpr: cron,
          prompt,
          createdBy,
          channelId: resolvedChannelId,
          taskId: taskId ?? null,
          timezone: timezone ?? null,
          nextRunAt,
          // Phase 2 (#619): one-shot cap + catch-up policy.
          maxRuns: maxRuns ?? null,
          catchUp,
        });
        const kind = maxRuns === 1 ? "One-shot" : "Schedule";
        return {
          content: [
            {
              type: "text" as const,
              text: `${kind} created: ${schedule.id} — ${target.name} on '${cron}', next run ${new Date(nextRunAt).toISOString()}`,
            },
          ],
        };
      },
    );

    server.tool(
      "cyborg7_schedule_list",
      "List recurring cybo schedules in the workspace",
      {},
      async () => {
        const schedules = storage.listSchedules(ctx.workspaceId);
        const formatted = schedules
          .map((s) => {
            const cyboName = storage.getCybo(s.cybo_id)?.name ?? s.cybo_id;
            const state = s.enabled ? "on" : "off";
            const next = s.next_run_at ? new Date(s.next_run_at).toISOString() : "—";
            const task = s.task_id ? ` task ${s.task_id}` : "";
            return `[${state}] ${s.id}: ${cyboName} '${s.cron_expr}'${task} → next ${next}`;
          })
          .join("\n");
        return { content: [{ type: "text" as const, text: formatted || "(no schedules)" }] };
      },
    );

    server.tool(
      "cyborg7_schedule_delete",
      "Delete a recurring cybo schedule by id",
      { scheduleId: z.string().describe("Schedule id to delete") },
      async ({ scheduleId }) => {
        const schedule = storage.getSchedule(scheduleId);
        if (!schedule || schedule.workspace_id !== ctx.workspaceId) {
          return {
            content: [{ type: "text" as const, text: `Schedule not found: ${scheduleId}` }],
          };
        }
        storage.deleteSchedule(scheduleId);
        return { content: [{ type: "text" as const, text: `Schedule deleted: ${scheduleId}` }] };
      },
    );
  }

  // ── Self-personality editor (cybo-only) ──────────────
  // Lets a cybo edit its OWN soul/personality — the "openclaw-like" self-edit. It
  // is STRICTLY scoped to the calling cybo (ctx.cyboId): there is no cyboId param,
  // so a cybo can NEVER target another. Registered only for a real cybo (a non-cybo
  // agent has no ctx.cyboId) that holds the `manage_self` grant (or, legacy, an
  // empty grant list under the fail-open default). Persistence takes the SAME path
  // as a UI update_cybo: the relay round-trip (cyboWrite "update_self") writes the
  // SHARED PG `cybos` row, and the daemon-local SQLite is updated too so solo mode
  // and this daemon's cache stay in sync. Changes apply to the NEXT launch/turn —
  // an in-flight session keeps the persona it was spawned with (the system prompt
  // is baked at spawn via buildCyboPrompt), exactly like the editor's "applies to
  // new launches" behavior.
  if (ctx.cyboId && allows("manage_self")) {
    const selfCyboId = ctx.cyboId;

    server.tool(
      "cyborg7_update_my_personality",
      "Edit YOUR OWN personality/soul (and nothing else — you can only ever change " +
        "yourself). Provide at least one of: `soul` (replace your entire soul text), " +
        "`append` (add a paragraph to the end of your current soul), or `traits` (up to " +
        "3 personality traits, encoded the same way the workspace UI does). Changes are " +
        "saved to the workspace and take effect on your NEXT launch — your current " +
        "conversation keeps the personality it started with.",
      {
        soul: z
          .string()
          .optional()
          .describe("Replace your ENTIRE soul/personality text with this."),
        append: z
          .string()
          .optional()
          .describe("Append this paragraph to the end of your current soul."),
        traits: z
          .array(z.enum(["warm", "brief", "thorough", "direct", "playful", "formal"]))
          .max(3)
          .optional()
          .describe(
            "Up to 3 personality traits to (re)apply. Rewrites the 'Personality:' " +
              "section of your soul; other text is preserved.",
          ),
      },
      async ({ soul, append, traits }) => {
        if (soul === undefined && append === undefined && traits === undefined) {
          return mcpText(
            "Error: provide at least one of soul, append, or traits to change your personality.",
          );
        }
        // Read the cybo's CURRENT soul (daemon-local SQLite) as the base for
        // append/traits edits. A self-edit can only run for a cybo this daemon
        // spawned, so the row is local.
        const current = storage.getCybo(selfCyboId);
        if (!current) {
          return mcpText("Error: couldn't load your own cybo record to edit.");
        }

        // Build the next soul (pure helper, unit-tested) and refuse an empty result.
        const next = composeCyboSoul(current.soul, { soul, append, traits });
        if (next.length === 0) {
          return mcpText("Error: the resulting soul would be empty — nothing was saved.");
        }

        // Persist via the SAME path as update_cybo: relay round-trip → shared PG
        // (cloud), and the daemon-local SQLite (solo + this daemon's cache). The
        // relay write is the authoritative one for a cloud workspace; the local
        // write keeps a PG-less / solo daemon consistent and updates the cache so
        // a subsequent fetch_cybo here reflects the change immediately.
        let persisted = false;
        if (cyboWrite) {
          const res = await cyboWrite({
            workspaceId: ctx.workspaceId,
            cyboId: selfCyboId,
            kind: "update_self",
            agentId: ctx.agentId,
            soul: next,
          });
          // res === null: old relay / disconnected → fall through to the local
          // write (today's behavior for the task path). res.ok === false: the
          // relay rejected it (e.g. missing grant) — surface that, do NOT silently
          // local-write a change the workspace refused.
          if (res && !res.ok) {
            return mcpText(`Error: couldn't save your personality — ${res.error ?? "rejected"}.`);
          }
          if (res?.ok) persisted = true;
        }
        // Local SQLite (idempotent with the PG write under the same id). Returns
        // undefined when the row isn't on this daemon — the relay write above may
        // already have persisted it, so only the combined "neither path wrote"
        // case below is an error.
        if (storage.updateCybo(selfCyboId, { soul: next })) persisted = true;
        if (!persisted) {
          return mcpText("Error: couldn't save your personality (no writable store reachable).");
        }
        return mcpText(
          "Saved. Your updated personality takes effect the next time you launch — " +
            "this conversation keeps the personality it started with.",
        );
      },
    );
  }

  return server;
}

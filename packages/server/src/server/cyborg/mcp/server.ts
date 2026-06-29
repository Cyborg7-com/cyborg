import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logError } from "@cyborg7/observability/node";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { marked } from "marked";
import type { PgSync } from "../db/pg-sync.js";
import { PageCycleError } from "../page-access.js";

// Page bodies uploaded via MCP are MARKDOWN (the natural format for agents), but the
// Page editor (TipTap) stores/renders HTML — raw markdown would show as one plain
// paragraph. Convert md→HTML on the way in so an agent's doc renders with headings,
// lists, code, tables, etc. GFM on; no hard line breaks (CommonMark paragraph rules).
function pageMarkdownToHtml(md: string): string {
  return marked.parse(md, { gfm: true, breaks: false, async: false });
}

// The identity an MCP token acts as, resolved per request from the token row.
// `displayName` is resolved once at auth time (http.ts) so write tools can
// attribute messages without re-querying or trusting client-supplied identity.
export interface McpAuthContext {
  tokenId: string;
  workspaceId: string;
  identityType: "cybo" | "user";
  identityId: string;
  displayName: string | null;
  scopes: string[];
}

// Minimal surface of WorkspaceRelay the MCP server needs — injecting a message
// persists it AND broadcasts it to guests + daemon subscribers. Kept structural
// so the server stays decoupled and unit-testable.
export interface McpRelay {
  injectMessage(workspaceId: string, message: Record<string, unknown>, fromId?: string): number;
}

export interface McpDeps {
  pg: PgSync;
  relay: McpRelay;
  // Whether the Tasks feature is provisioned for this workspace — the authoritative
  // server-side signal is "the workspace has ≥1 tasks_projects row" (provisioned on
  // workspace/project creation; resolved in http.ts). When false the task-management
  // AND page tools are NOT registered (the preferred "tools don't appear" gate),
  // since pages are part of Tasks; the non-task tools (whoami, channels, post_message,
  // …) stay available regardless. OMITTED defaults to ENABLED — the only production
  // caller (http.ts) always passes the real value, so the default only affects the
  // in-memory test fakes that don't exercise the gate.
  tasksEnabled?: boolean;
  // Best-effort live fan-out of a task mutation to the workspace's guests/daemon
  // (the relay's `cyborg:tasks_changed` broadcast). Optional so the server stays
  // unit-testable without the relay's broadcast plumbing; when absent, a task
  // created/updated via MCP simply lands in PG and shows on the client's next
  // fetch instead of live.
  broadcastTasksChanged?: (workspaceId: string, payload: unknown) => void;
}

// Compact task projection returned by the task tools — the fields an agent needs
// to reason about a task, without the Plane-style denormalized sets.
function mapTaskBrief(t: {
  id: string;
  title: string;
  status: string;
  description: string | null;
  assignee_id: string | null;
  created_by: string;
  priority?: string | null;
  project_id?: string | null;
  due_at?: number | null;
}) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    description: t.description,
    assigneeId: t.assignee_id,
    createdBy: t.created_by,
    priority: t.priority ?? null,
    projectId: t.project_id ?? null,
    dueAt: t.due_at ?? null,
  };
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const WRITE_SCOPE = "write";

// True for a code point that must be stripped from tool input: control/format
// characters that don't render but can corrupt logs, smuggle hidden payloads, or
// reorder text. KEEP every legitimately printable code point (accents, emoji,
// CJK, …) — this only targets the invisible/dangerous classes below.
function isNonPrintable(cp: number): boolean {
  // C0 controls (U+0000–U+001F) EXCEPT tab / newline / carriage-return, which are
  // legitimate whitespace in message text.
  if (cp <= 0x1f) return cp !== 0x09 && cp !== 0x0a && cp !== 0x0d;
  if (cp === 0x7f) return true; // DEL
  if (cp >= 0x80 && cp <= 0x9f) return true; // C1 controls
  // BOM / zero-width no-break space (U+FEFF) — never legitimate in message text.
  // NOTE: ZWSP/ZWNJ/ZWJ (U+200B–U+200D) are deliberately KEPT — ZWJ joins
  // multi-glyph emoji (e.g. 👨‍👩‍👧), ZWNJ is required for Persian/Arabic
  // orthography, and ZWSP marks word boundaries for Thai/Lao line-wrapping.
  if (cp === 0xfeff) return true;
  // Bidi overrides + isolates (U+202A–U+202E, U+2066–U+2069) — can visually
  // reorder text to spoof what a human reviewer sees.
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2066 && cp <= 0x2069) return true;
  return false;
}

/**
 * Remove non-printable / format-control characters from a string while keeping
 * all genuinely printable Unicode (accents, emoji, CJK) and the layout/script
 * zero-width joiners ZWSP/ZWNJ/ZWJ. Strips: C0 controls except \t \n \r, DEL,
 * C1 controls, BOM (U+FEFF), and bidi overrides/isolates.
 *
 * Returns the input unchanged (same reference) when there is nothing to strip, so
 * it is a true no-op on clean ASCII / already-clean text. Iterates by code point
 * (`for…of`) so astral characters like emoji survive intact.
 */
export function stripNonPrintable(s: string): string {
  let dirty = false;
  for (const ch of s) {
    if (isNonPrintable(ch.codePointAt(0) ?? 0)) {
      dirty = true;
      break;
    }
  }
  if (!dirty) return s;
  let out = "";
  for (const ch of s) {
    if (!isNonPrintable(ch.codePointAt(0) ?? 0)) out += ch;
  }
  return out;
}

/**
 * Recursively sanitize a tool's input: every string value (in objects and arrays,
 * at any depth) is run through {@link stripNonPrintable}; non-string values are
 * left untouched. The argument's shape/type is preserved, so callers can destructure
 * the result exactly as before. A no-op on clean ASCII input.
 */
export function sanitizeToolArgs<T>(value: T): T {
  if (typeof value === "string") return stripNonPrintable(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeToolArgs(v)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeToolArgs(v);
    return out as T;
  }
  return value;
}

// A message authored by the token's identity. A cybo posts as an agent, a user
// as a human — matching how the relay persists `fromType` (workspace-relay.ts
// buildMessageRecord). Pure + exported for unit testing.
export function buildChannelMessage(
  ctx: McpAuthContext,
  opts: { id: string; channelId: string; text: string; parentId: string | null },
): { type: "cyborg:channel_message_broadcast"; payload: Record<string, unknown> } {
  return {
    type: "cyborg:channel_message_broadcast",
    payload: {
      id: opts.id,
      workspaceId: ctx.workspaceId,
      channelId: opts.channelId,
      fromId: ctx.identityId,
      fromType: ctx.identityType === "cybo" ? "agent" : "human",
      fromName: ctx.displayName,
      toId: null,
      text: opts.text,
      mentions: null,
      parentId: opts.parentId,
      attachments: null,
      // Marks the message as an automation for persistence + the UI badge.
      source: "mcp",
      createdAt: Date.now(),
    },
  };
}

/**
 * Build a fresh MCP server over ONE workspace, scoped to the identity carried by
 * the token. Every tool proxies to the permission-aware `PgSync`/relay layer
 * with the token's identityId — the LLM never supplies identity.
 *
 * Read tools (whoami, list_workspaces, list_channels, read_channel) require the
 * `read` scope. Write tools (post_message, reply_in_thread) require the `write`
 * scope and route through `relay.injectMessage`, so a post is persisted AND
 * broadcast to humans + agents, then recorded in the audit log.
 *
 * SECURITY — bound params vs. tool inputs:
 *   `workspaceId`, `identityId`, and `displayName` are BOUND PARAMETERS taken from
 *   the authenticated `McpAuthContext` (resolved from the token row in http.ts).
 *   They are the server's source of truth for *who is acting and where*, and MUST
 *   NEVER appear in any tool's `inputSchema` — a tool must not let the LLM supply,
 *   override, or spoof its own identity/workspace. Tool inputs are limited to the
 *   data a caller legitimately chooses (channel ids, message text, paging cursors),
 *   and every such input is passed through `sanitizeToolArgs` before use.
 */
export function buildWorkspaceMcpServer(ctx: McpAuthContext, deps: McpDeps): McpServer {
  const { pg, relay } = deps;
  // Tasks feature gate (see McpDeps.tasksEnabled). Pages are part of Tasks, so both
  // the task- and page-management tools hang off this single flag. Defaults to on.
  const tasksEnabled = deps.tasksEnabled !== false;
  const server = new McpServer({
    name: "cyborg7-workspace",
    version: "0.2.0",
  });

  server.registerTool(
    "whoami",
    {
      description:
        "Return the identity, workspace, and scopes this MCP token is acting as. Use this first to confirm what you can do.",
      inputSchema: {},
    },
    async () =>
      json({
        workspaceId: ctx.workspaceId,
        identityType: ctx.identityType,
        identityId: ctx.identityId,
        displayName: ctx.displayName,
        scopes: ctx.scopes,
      }),
  );

  // Data tools require the `read` scope — a token minted with only `write` or
  // an empty scope list must not be able to list/read workspace data. whoami
  // stays available regardless (it only reports the token's own identity).
  if (ctx.scopes.includes("read")) {
    server.registerTool(
      "list_workspaces",
      {
        description:
          "List the workspace this token can access (an MCP token is scoped to a single Cyborg7 workspace).",
        inputSchema: {},
      },
      async () => {
        const ws = await pg.getWorkspaceById(ctx.workspaceId);
        return json(ws ? [{ id: ws.id, name: ws.name }] : []);
      },
    );

    server.registerTool(
      "list_channels",
      {
        description:
          "List channels in the workspace visible to this identity. Private channels appear only if the identity is a member.",
        inputSchema: {},
      },
      async () => {
        const channels = await pg.getChannelsWithMembership(ctx.workspaceId, ctx.identityId);
        return json(
          channels.map((c) => ({
            id: c.id,
            name: c.name,
            description: c.description,
            isPrivate: !!c.is_private,
            isMember: c.is_member,
          })),
        );
      },
    );

    server.registerTool(
      "read_channel",
      {
        description:
          "Read recent top-level messages from a channel in this workspace, newest last. Use `before` (a message id) to page backwards.",
        inputSchema: {
          channelId: z.string().describe("The channel id to read from."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(100)
            .default(20)
            .describe("How many messages (max 100)."),
          before: z.string().optional().describe("Return messages older than this message id."),
        },
      },
      async (rawArgs) => {
        // Strip non-printable/format-control chars from caller-supplied input
        // before any use (logging, lookup, paging). Identity/workspace are bound
        // params and never come from here.
        const { channelId, limit, before } = sanitizeToolArgs(rawArgs);
        // Enforce the channel belongs to the token's workspace before reading.
        const channel = await pg.getChannel(channelId);
        if (!channel || channel.workspace_id !== ctx.workspaceId) {
          return json({ error: "channel not found in this workspace" });
        }
        // Private channels require membership — otherwise any token for the
        // workspace could read a private channel just by knowing/guessing its id.
        if (channel.is_private && !(await pg.getChannelMemberRole(channelId, ctx.identityId))) {
          return json({ error: "channel not found in this workspace" });
        }
        const messages = await pg.getMessages({ channelId, limit, before });
        return json(
          messages.map((m) => ({
            id: m.id,
            from: m.from_name ?? m.from_id,
            fromType: m.from_type,
            text: m.text,
            createdAt: m.created_at,
          })),
        );
      },
    );

    // Task + Page tools are gated on the workspace having Tasks provisioned (pages
    // are part of Tasks). When Tasks is off these never register — a token for a
    // non-Tasks workspace simply doesn't see them.
    if (tasksEnabled) {
      server.registerTool(
        "list_tasks",
        {
          description:
            "List tasks in this workspace, newest first. Optionally filter by status. Returns each task's id, title, status, priority, assignee, description and project.",
          inputSchema: {
            status: z.string().optional().describe("Only return tasks with this status."),
            limit: z
              .number()
              .int()
              .min(1)
              .max(200)
              .default(50)
              .describe("How many tasks (max 200)."),
          },
        },
        async (rawArgs) => {
          const { status, limit } = sanitizeToolArgs(rawArgs);
          const tasks = await pg.getTasks(ctx.workspaceId, { status, limit });
          return json(tasks.map(mapTaskBrief));
        },
      );

      server.registerTool(
        "list_pages",
        {
          description:
            "List the pages (docs) in a Tasks-project in this workspace. Returns each page's id, title and icon.",
          inputSchema: {
            projectId: z.string().describe("The Tasks-project id whose pages to list."),
          },
        },
        async (rawArgs) => {
          const { projectId } = sanitizeToolArgs(rawArgs);
          if (!(await pg.assertProjectVisible(projectId, ctx.identityId))) {
            return json({ error: "project not found" });
          }
          return json(await pg.getProjectPages(projectId, ctx.identityId));
        },
      );

      server.registerTool(
        "read_page",
        {
          description: "Read a single page (doc) by id, including its markdown content.",
          inputSchema: {
            pageId: z.string().describe("The page id to read."),
          },
        },
        async (rawArgs) => {
          const { pageId } = sanitizeToolArgs(rawArgs);
          const projectId = await pg.getPageProjectId(pageId);
          if (!projectId || !(await pg.assertProjectVisible(projectId, ctx.identityId))) {
            return json({ error: "page not found in this workspace" });
          }
          return json(await pg.getPageById(pageId));
        },
      );
    }
  }

  // Validate the channel is writable by this identity, then post + audit.
  // Returns the new message id, or an `{ error }` object the LLM can read.
  async function postToChannel(opts: {
    channelId: string;
    text: string;
    parentId: string | null;
    action: "post_message" | "reply_in_thread";
  }): Promise<{ content: { type: "text"; text: string }[] }> {
    // Workspace posting permission. For a user identity, enforce the same gate
    // as the relay's cyborg:channel_message path: a viewer (or a member removed
    // after the token was minted) cannot post. Cybos have no membership role —
    // their existence in the workspace was validated at auth time — so they pass.
    if (ctx.identityType === "user") {
      const role = await pg.getMemberRole(ctx.workspaceId, ctx.identityId);
      if (!role || role === "viewer") {
        return json({ error: "this identity cannot post in this workspace" });
      }
    }
    const channel = await pg.getChannel(opts.channelId);
    if (!channel || channel.workspace_id !== ctx.workspaceId) {
      return json({ error: "channel not found in this workspace" });
    }
    // Private channels require the acting identity to be a channel member.
    if (channel.is_private) {
      const role = await pg.getChannelMemberRole(opts.channelId, ctx.identityId);
      if (!role) return json({ error: "not a member of this private channel" });
    }
    if (opts.parentId) {
      const parent = await pg.getMessageById(opts.parentId);
      if (!parent || parent.workspaceId !== ctx.workspaceId) {
        return json({ error: "parent message not found in this workspace" });
      }
      // The parent MUST live in the same channel — otherwise a caller could thread
      // a reply onto a message in another (possibly private) channel, corrupting
      // thread membership/visibility (getThreadReplies fetches by parentId alone).
      if (parent.channelId !== opts.channelId) {
        return json({ error: "parent message is not in this channel" });
      }
    }

    const id = randomUUID();
    relay.injectMessage(
      ctx.workspaceId,
      buildChannelMessage(ctx, {
        id,
        channelId: opts.channelId,
        text: opts.text,
        parentId: opts.parentId,
      }),
      "mcp",
    );
    // Keep thread aggregates + per-follower unread in sync, exactly like the
    // relay's human reply path. Fire-and-forget — never blocks the tool result.
    if (opts.parentId) {
      void pg
        .maintainThreadOnReply({
          rootId: opts.parentId,
          workspaceId: ctx.workspaceId,
          channelId: opts.channelId,
          authorId: ctx.identityId,
          mentionedUserIds: [],
          replyAt: Date.now(),
        })
        .catch((err) =>
          logError("mcp.maintainThreadOnReply", err, {
            workspaceId: ctx.workspaceId,
            channelId: opts.channelId,
            rootId: opts.parentId,
          }),
        );
    }
    void pg
      .audit({
        id: randomUUID(),
        workspaceId: ctx.workspaceId,
        actorId: ctx.identityId,
        actorType: ctx.identityType,
        action: opts.action,
        targetType: "channel",
        targetId: opts.channelId,
        details: { messageId: id, via: "mcp", tokenId: ctx.tokenId },
      })
      .catch((err) =>
        logError("mcp.audit", err, {
          workspaceId: ctx.workspaceId,
          action: opts.action,
          channelId: opts.channelId,
          messageId: id,
        }),
      );

    return json({ ok: true, messageId: id });
  }

  // Write tools require the `write` scope — registered only when granted, so a
  // read-only token never even advertises them.
  if (ctx.scopes.includes(WRITE_SCOPE)) {
    server.registerTool(
      "post_message",
      {
        description:
          "Post a new top-level message to a channel in this workspace. The message is attributed to this token's identity and is visible to all channel members.",
        inputSchema: {
          channelId: z.string().describe("The channel id to post in."),
          text: z.string().min(1).describe("The message text."),
        },
      },
      async (rawArgs) => {
        const { channelId, text } = sanitizeToolArgs(rawArgs);
        return postToChannel({ channelId, text, parentId: null, action: "post_message" });
      },
    );

    server.registerTool(
      "reply_in_thread",
      {
        description: "Reply to an existing message, creating or continuing its thread.",
        inputSchema: {
          channelId: z.string().describe("The channel id the parent message is in."),
          parentId: z.string().describe("The id of the message to reply to (the thread root)."),
          text: z.string().min(1).describe("The reply text."),
        },
      },
      async (rawArgs) => {
        const { channelId, parentId, text } = sanitizeToolArgs(rawArgs);
        return postToChannel({ channelId, text, parentId, action: "reply_in_thread" });
      },
    );

    // Task + Page WRITE tools are gated on the workspace having Tasks provisioned
    // (pages are part of Tasks). post_message / reply_in_thread above stay available
    // regardless — only the task/page mutations and their helpers are withheld.
    if (tasksEnabled) {
      // For a user identity, mirror the relay's task-write gate: a viewer (or a
      // member removed after the token was minted) cannot mutate tasks. A cybo
      // identity has no membership role — its workspace membership was validated at
      // auth time — so it passes.
      const assertTaskWriter = async (): Promise<{
        content: { type: "text"; text: string }[];
      } | null> => {
        if (ctx.identityType === "user") {
          const role = await pg.getMemberRole(ctx.workspaceId, ctx.identityId);
          if (!role || role === "viewer") {
            return json({ error: "this identity cannot manage tasks in this workspace" });
          }
        }
        return null;
      };

      // Load a task BY ID anchored to this workspace, enforcing project visibility
      // (fail-closed) exactly like the relay's update/delete handlers. Returns the
      // task row, or an `{ error }` response the caller returns as-is.
      const loadOwnTask = async (
        taskId: string,
      ): Promise<
        | { ok: true; task: Awaited<ReturnType<typeof pg.getTasks>>[number] }
        | { ok: false; res: { content: { type: "text"; text: string }[] } }
      > => {
        const tasks = await pg.getTasks(ctx.workspaceId);
        const task = tasks.find((t) => t.id === taskId);
        if (!task) return { ok: false, res: json({ error: "task not found in this workspace" }) };
        if (task.project_id && !(await pg.assertProjectVisible(task.project_id, ctx.identityId))) {
          return { ok: false, res: json({ error: "task not found in this workspace" }) };
        }
        return { ok: true, task };
      };

      const auditTask = (action: string, taskId: string): void => {
        void pg
          .audit({
            id: randomUUID(),
            workspaceId: ctx.workspaceId,
            actorId: ctx.identityId,
            actorType: ctx.identityType,
            action,
            targetType: "task",
            targetId: taskId,
            details: { via: "mcp", tokenId: ctx.tokenId },
          })
          .catch((err) =>
            logError("mcp.audit", err, { workspaceId: ctx.workspaceId, action, taskId }),
          );
      };

      server.registerTool(
        "create_task",
        {
          description:
            "Create a task in this workspace. Only `title` is required. Omit `projectId` and the task lands in the workspace Inbox.",
          inputSchema: {
            title: z.string().min(1).describe("Task title."),
            description: z.string().optional().describe("Task description / details."),
            assignee: z
              .string()
              .optional()
              .describe("Assignee: a workspace member userId or a cybo id."),
            priority: z
              .enum(["urgent", "high", "medium", "low", "none"])
              .optional()
              .describe("Task priority (defaults to none)."),
            projectId: z
              .string()
              .optional()
              .describe("Tasks-project id to file the task under (else the workspace Inbox)."),
            dueAt: z.number().optional().describe("Due date as an epoch-ms timestamp."),
          },
        },
        async (rawArgs) => {
          const gate = await assertTaskWriter();
          if (gate) return gate;
          const { title, description, assignee, priority, projectId, dueAt } =
            sanitizeToolArgs(rawArgs);
          if (projectId && !(await pg.assertProjectVisible(projectId, ctx.identityId))) {
            return json({ error: "project not found" });
          }
          const id = randomUUID();
          await pg.createTask({
            id,
            workspaceId: ctx.workspaceId,
            title,
            createdBy: ctx.identityId,
            description,
            assigneeId: assignee,
            priority,
            projectId,
            dueAt,
          });
          deps.broadcastTasksChanged?.(ctx.workspaceId, {
            workspaceId: ctx.workspaceId,
            op: "created",
            task: { id },
          });
          auditTask("create_task", id);
          const created = (await pg.getTasks(ctx.workspaceId)).find((t) => t.id === id);
          return json({ ok: true, task: created ? mapTaskBrief(created) : { id } });
        },
      );

      server.registerTool(
        "update_task",
        {
          description:
            "Update a task in this workspace by id. Only the fields you pass change; the rest are left as-is.",
          inputSchema: {
            taskId: z.string().describe("The id of the task to update."),
            title: z.string().min(1).optional().describe("New title."),
            description: z.string().optional().describe("New description."),
            status: z.string().optional().describe("New workflow status."),
            assignee: z.string().optional().describe("New assignee userId / cybo id."),
            priority: z
              .enum(["urgent", "high", "medium", "low", "none"])
              .optional()
              .describe("New priority."),
            projectId: z.string().optional().describe("Move the task to this Tasks-project id."),
          },
        },
        async (rawArgs) => {
          const gate = await assertTaskWriter();
          if (gate) return gate;
          const { taskId, title, description, status, assignee, priority, projectId } =
            sanitizeToolArgs(rawArgs);
          const found = await loadOwnTask(taskId);
          if (!found.ok) return found.res;
          if (projectId && !(await pg.assertProjectVisible(projectId, ctx.identityId))) {
            return json({ error: "project not found" });
          }
          await pg.updateTask(taskId, {
            title,
            description,
            status,
            assigneeId: assignee,
            priority,
            projectId,
          });
          deps.broadcastTasksChanged?.(ctx.workspaceId, {
            workspaceId: ctx.workspaceId,
            op: "updated",
            task: { id: taskId },
          });
          auditTask("update_task", taskId);
          const updated = (await pg.getTasks(ctx.workspaceId)).find((t) => t.id === taskId);
          return json({ ok: true, task: updated ? mapTaskBrief(updated) : { id: taskId } });
        },
      );

      server.registerTool(
        "delete_task",
        {
          description: "Delete a task in this workspace by id.",
          inputSchema: {
            taskId: z.string().describe("The id of the task to delete."),
          },
        },
        async (rawArgs) => {
          const gate = await assertTaskWriter();
          if (gate) return gate;
          const { taskId } = sanitizeToolArgs(rawArgs);
          const found = await loadOwnTask(taskId);
          if (!found.ok) return found.res;
          await pg.deleteTask(taskId);
          deps.broadcastTasksChanged?.(ctx.workspaceId, {
            workspaceId: ctx.workspaceId,
            op: "deleted",
            task: { id: taskId },
          });
          auditTask("delete_task", taskId);
          return json({ ok: true, taskId, deleted: true });
        },
      );

      const auditPage = (action: string, pageId: string): void => {
        void pg
          .audit({
            id: randomUUID(),
            workspaceId: ctx.workspaceId,
            actorId: ctx.identityId,
            actorType: ctx.identityType,
            action,
            targetType: "page",
            targetId: pageId,
            details: { via: "mcp", tokenId: ctx.tokenId },
          })
          .catch((err) =>
            logError("mcp.audit", err, { workspaceId: ctx.workspaceId, action, pageId }),
          );
      };

      // Load a page anchored to this workspace via its project (fail-closed on
      // visibility), so update/delete can't touch a page in another project.
      const loadOwnPage = async (
        pageId: string,
      ): Promise<
        { ok: true } | { ok: false; res: { content: { type: "text"; text: string }[] } }
      > => {
        const projectId = await pg.getPageProjectId(pageId);
        if (!projectId || !(await pg.assertProjectVisible(projectId, ctx.identityId))) {
          return { ok: false, res: json({ error: "page not found in this workspace" }) };
        }
        return { ok: true };
      };

      server.registerTool(
        "create_page",
        {
          description:
            "Create a page (doc) under a Tasks-project. Pass markdown `content` to fill the body. Pass `parentId` to nest it as a subpage under an existing page in the SAME project (omit for a root page).",
          inputSchema: {
            projectId: z.string().describe("The Tasks-project id to create the page under."),
            title: z.string().min(1).describe("Page title."),
            content: z.string().optional().describe("Page body as markdown."),
            parentId: z
              .string()
              .nullable()
              .optional()
              .describe("Parent page id to nest under (same project). Omit/null = a root page."),
          },
        },
        async (rawArgs) => {
          const gate = await assertTaskWriter();
          if (gate) return gate;
          const { projectId, title, content, parentId } = sanitizeToolArgs(rawArgs);
          if (!(await pg.assertProjectVisible(projectId, ctx.identityId))) {
            return json({ error: "project not found" });
          }
          let page;
          try {
            page = await pg.insertPage({
              projectId,
              title,
              ownedBy: ctx.identityId,
              parentId: parentId ?? null,
            });
          } catch (err) {
            // A bad parent (cross-project / nonexistent) is user-input, not a bug —
            // return a readable error the LLM can act on instead of throwing.
            if (err instanceof Error && err.message === "parent page not found in this project") {
              return json({ error: err.message });
            }
            throw err;
          }
          if (content) await pg.updatePage(page.id, { content: pageMarkdownToHtml(content) });
          auditPage("create_page", page.id);
          return json({ ok: true, page: (await pg.getPageById(page.id)) ?? page });
        },
      );

      server.registerTool(
        "update_page",
        {
          description:
            "Update a page (doc) by id. Pass `title` and/or `content` (markdown); only what you pass changes. Pass `parentId` to re-nest the page under another page in the SAME project (null = move to root); `sortOrder` sets its position among siblings. Re-parenting a page under itself or one of its own descendants is rejected.",
          inputSchema: {
            pageId: z.string().describe("The page id to update."),
            title: z.string().min(1).optional().describe("New title."),
            content: z.string().optional().describe("New markdown body."),
            parentId: z
              .string()
              .nullable()
              .optional()
              .describe("New parent page id (same project) to nest under; null = move to root."),
            sortOrder: z
              .number()
              .int()
              .optional()
              .describe("Position among sibling pages (lower sorts first)."),
          },
        },
        async (rawArgs) => {
          const gate = await assertTaskWriter();
          if (gate) return gate;
          const { pageId, title, content, parentId, sortOrder } = sanitizeToolArgs(rawArgs);
          const found = await loadOwnPage(pageId);
          if (!found.ok) return found.res;
          let page;
          try {
            page = await pg.updatePage(pageId, {
              title,
              content: content === undefined ? undefined : pageMarkdownToHtml(content),
              parentId,
              sortOrder,
            });
          } catch (err) {
            // Re-parent rejections (cycle or cross-project parent) are user-input —
            // surface them readably instead of throwing an opaque tool error.
            if (
              err instanceof PageCycleError ||
              (err instanceof Error && err.message === "parent page not found in this project")
            ) {
              return json({ error: err.message });
            }
            throw err;
          }
          auditPage("update_page", pageId);
          return json({ ok: true, page });
        },
      );

      server.registerTool(
        "delete_page",
        {
          description: "Delete a page (doc) by id.",
          inputSchema: {
            pageId: z.string().describe("The page id to delete."),
          },
        },
        async (rawArgs) => {
          const gate = await assertTaskWriter();
          if (gate) return gate;
          const { pageId } = sanitizeToolArgs(rawArgs);
          const found = await loadOwnPage(pageId);
          if (!found.ok) return found.res;
          await pg.deletePage(pageId);
          auditPage("delete_page", pageId);
          return json({ ok: true, pageId, deleted: true });
        },
      );
    }
  }

  return server;
}

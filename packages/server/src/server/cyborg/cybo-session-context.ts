// Cross-session context for a cybo — OWNER-SCOPED at the data layer.
//
// A cybo inherits its OWNER's access: it may review the OWNER's OTHER sessions with
// the SAME cybo (explore by recency, read one session's timeline, and text-search
// for recall — "what did I say in another session?"), and NEVER another user's
// sessions. Sessions live as `agent_bindings` in the daemon's local SQLite (one
// binding == one session == one timeline keyed by agent_id); timelines live in the
// daemon's `agent_timeline_rows` (NOT PG). So this resolves entirely against the
// daemon's local stores — the daemon IS the data layer that owns these rows.
//
// Owner scoping reuses agentBindingVisibleCore (the SAME rule the agents sidebar +
// the relay offline list use, #1022): a session is visible to the owner iff it is
// the owner's own session, OR a non-ephemeral channel session (shared). An
// ephemeral summon owned by someone else is never returned — enforced here, on the
// binding set, BEFORE any timeline row is touched, so cross-owner leakage is
// impossible regardless of the tool description.
import type { DualStorage } from "./dual-storage.js";
import type { StoredAgentBinding } from "./storage.js";
import type { AgentTimelineStore } from "../agent/agent-timeline-store-types.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { agentBindingVisibleCore } from "./relay-offline-agent-rows.js";

export interface CyboSessionSummary {
  // The session id == the agent id (one binding == one session == one timeline).
  sessionId: string;
  title: string | null;
  channelId: string | null;
  ephemeral: boolean;
  createdAt: number;
  // Last activity epoch ms (the timeline's last row timestamp, or createdAt when the
  // session has no committed rows yet). Drives the recency sort.
  lastActiveAt: number;
  // First ~160 chars of the last assistant/user message, for a glanceable preview.
  preview: string | null;
  // True for the cybo's CURRENT session (so the caller can exclude/label it).
  isCurrent: boolean;
}

export interface CyboSessionTimelineEntry {
  seq: number;
  // "user" (the human's message) | "assistant" (the cybo's reply) | other item types.
  role: "user" | "assistant" | "reasoning" | "tool" | "todo" | "error" | "other";
  text: string;
  timestamp: string;
}

export interface CyboSessionSearchHit {
  sessionId: string;
  title: string | null;
  seq: number;
  role: CyboSessionTimelineEntry["role"];
  // A snippet of the matching message centered on the first match.
  snippet: string;
  timestamp: string;
}

// Map a timeline item to a (role, text) pair. Tool/todo/error items carry no plain
// "text" the cybo authored, so they are flattened to a best-effort string and tagged
// by role — search/read still surface them, labeled, without crashing on the union.
function itemRoleText(item: AgentTimelineItem): {
  role: CyboSessionTimelineEntry["role"];
  text: string;
} {
  switch (item.type) {
    case "user_message":
      return { role: "user", text: item.text };
    case "assistant_message":
      return { role: "assistant", text: item.text };
    case "reasoning":
      return { role: "reasoning", text: item.text };
    case "todo":
      return {
        role: "todo",
        text: item.items.map((i) => `${i.completed ? "[x]" : "[ ]"} ${i.text}`).join("\n"),
      };
    case "error":
      return { role: "error", text: item.message };
    default:
      // tool calls + compaction markers — no authored text; label by type.
      return { role: item.type.startsWith("tool") ? "tool" : "other", text: "" };
  }
}

function previewOf(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// Center a snippet on the first case-insensitive match of `query` within `text`.
function snippetAround(text: string, query: string, radius = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const idx = clean.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return previewOf(clean, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(clean.length, idx + query.length + radius);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

export class CyboSessionContext {
  constructor(
    private readonly storage: DualStorage,
    private readonly timeline: AgentTimelineStore,
  ) {}

  // The owner-visible bindings for `cyboId` in `workspaceId`, owner-scoped via
  // agentBindingVisibleCore against the owner's LOCAL id (initiated_by id space).
  // This is the single choke point every read flows through, so owner scope is
  // enforced once, at the data layer.
  private ownerBindings(
    workspaceId: string,
    cyboId: string,
    ownerLocalId: string | undefined,
  ): StoredAgentBinding[] {
    return this.storage
      .getCyboBindingsByWorkspace(workspaceId)
      .filter((b) => b.cybo_id === cyboId)
      .filter((b) =>
        agentBindingVisibleCore(
          {
            channelId: b.channel_id,
            initiatedBy: b.initiated_by,
            ephemeral: b.ephemeral === 1,
            autonomous: b.autonomous === 1,
          },
          () => !!ownerLocalId && b.initiated_by === ownerLocalId,
        ),
      );
  }

  // Resolve the OWNER of the cybo's current session: the binding's initiated_by (the
  // human who is talking to the cybo). Falls back to the explicit initiatedByUserId
  // the caller carries. Returns undefined when neither resolves — in which case the
  // owner-scope predicate admits only legacy/system (initiated_by null) sessions.
  resolveOwnerLocalId(currentAgentId: string, initiatedByUserId?: string): string | undefined {
    const fromBinding = this.storage.getAgentBinding(currentAgentId)?.initiated_by ?? undefined;
    return fromBinding ?? initiatedByUserId ?? undefined;
  }

  // List the owner's sessions with this cybo, most-recent first. `currentAgentId` is
  // flagged isCurrent so the caller can exclude or label it.
  async listSessions(opts: {
    workspaceId: string;
    cyboId: string;
    ownerLocalId: string | undefined;
    currentAgentId: string;
    limit?: number;
  }): Promise<CyboSessionSummary[]> {
    const bindings = this.ownerBindings(opts.workspaceId, opts.cyboId, opts.ownerLocalId);
    // Per session, fetch only the TAIL (the last rows) — not the whole timeline — so
    // a member with many long sessions doesn't load every row into memory; and run
    // the fetches in parallel. The tail is enough for lastActive + the preview (the
    // last authored message); full-text search uses its own full read.
    const summaries = await Promise.all(
      bindings.map(async (b): Promise<CyboSessionSummary> => {
        const { rows } = await this.timeline.fetchCommitted(b.agent_id, {
          direction: "tail",
          limit: 20,
        });
        const last = rows.length > 0 ? rows[rows.length - 1] : null;
        const lastActiveAt = last ? Date.parse(last.timestamp) || b.created_at : b.created_at;
        // Preview: the last authored (assistant/user) message in the tail.
        let preview: string | null = null;
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const { role, text } = itemRoleText(rows[i].item);
          if ((role === "assistant" || role === "user") && text.trim()) {
            preview = previewOf(text);
            break;
          }
        }
        return {
          sessionId: b.agent_id,
          // agent_bindings carries no title; left null (no title column).
          title: null,
          channelId: b.channel_id,
          ephemeral: b.ephemeral === 1,
          createdAt: b.created_at,
          lastActiveAt,
          preview,
          isCurrent: b.agent_id === opts.currentAgentId,
        };
      }),
    );
    summaries.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
    return summaries.slice(0, limit);
  }

  // Read one session's timeline — owner-checked: the session must be in the owner's
  // visible binding set, else null (the caller surfaces "not found / not yours").
  async readSession(opts: {
    workspaceId: string;
    cyboId: string;
    ownerLocalId: string | undefined;
    sessionId: string;
    limit?: number;
  }): Promise<CyboSessionTimelineEntry[] | null> {
    const visible = this.ownerBindings(opts.workspaceId, opts.cyboId, opts.ownerLocalId).some(
      (b) => b.agent_id === opts.sessionId,
    );
    if (!visible) return null;
    const result = await this.timeline.fetchCommitted(opts.sessionId, {
      direction: "tail",
      limit: opts.limit && opts.limit > 0 ? opts.limit : 200,
    });
    return result.rows.map((r) => {
      const { role, text } = itemRoleText(r.item);
      return { seq: r.seq, role, text, timestamp: r.timestamp };
    });
  }

  // Text-search across the OWNER's sessions with this cybo (for recall). Excludes the
  // current session by default so the cybo doesn't "find" what it just said. Matches
  // are case-insensitive substring over authored (user/assistant/reasoning) text.
  async searchSessions(opts: {
    workspaceId: string;
    cyboId: string;
    ownerLocalId: string | undefined;
    query: string;
    currentAgentId: string;
    includeCurrent?: boolean;
    limit?: number;
  }): Promise<CyboSessionSearchHit[]> {
    const q = opts.query.trim().toLowerCase();
    if (!q) return [];
    const bindings = this.ownerBindings(opts.workspaceId, opts.cyboId, opts.ownerLocalId).filter(
      (b) => opts.includeCurrent || b.agent_id !== opts.currentAgentId,
    );
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 25;
    // Read each owner session's timeline in parallel (search needs the full text, so
    // the whole timeline is read), collect per-session hits, then flatten + cap.
    const perSession = await Promise.all(
      bindings.map(async (b) => {
        const rows = await this.timeline.getCommittedRows(b.agent_id);
        const sessionHits: CyboSessionSearchHit[] = [];
        for (const row of rows) {
          const { role, text } = itemRoleText(row.item);
          if (!text) continue;
          if (text.toLowerCase().includes(q)) {
            sessionHits.push({
              sessionId: b.agent_id,
              title: null,
              seq: row.seq,
              role,
              snippet: snippetAround(text, opts.query),
              timestamp: row.timestamp,
            });
          }
        }
        return sessionHits;
      }),
    );
    const hits: CyboSessionSearchHit[] = [];
    for (const sessionHits of perSession) {
      for (const hit of sessionHits) {
        hits.push(hit);
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }
}

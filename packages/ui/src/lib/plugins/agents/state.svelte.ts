import { toast } from "svelte-sonner";
import { reportClientError } from "@cyborg7/observability/web";
import { authState, workspaceState } from "../../core/state.svelte.js";
import { curateLastActivity, type CuratedActivity } from "./activity-curator.js";
import type { Attachment } from "../../types.js";
import { accessibleOnlineDaemons, pickDefaultDaemon } from "./daemon-select.js";
import type {
  AgentEvent,
  AgentAttention,
  AgentAttentionReason,
  AgentTimelineItem,
  AgentUsage,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentRuntimeInfo,
  AgentMode,
  AgentSlashCommand,
  ProviderInfo,
  Cybo,
  Daemon,
  DaemonMeta,
  DaemonAccessEntry,
} from "./types.js";
import {
  attentionReasonForTurnEvent,
  badgeForReason,
  reconcileAttentionFromSnapshot,
  type AgentTurnEventType,
  type AttentionBadge,
} from "./attention-badge.js";

const DM_PREFIX_RE = /^\[DM from [^\]]+\]:\s*/;
function stripDmPrefix(text: string): string {
  return text.replace(DM_PREFIX_RE, "");
}

// Tail window for the curated "last activity" line (#594). The glanceable line
// only ever surfaces the latest curated entry, so we cap the curation scan to
// the most recent N raw timeline entries — bounding the per-update cost on long
// (up to 500-entry) streams while still capturing the current turn's head.
const MAX_ACTIVITY_SCAN = 40;

// ─── Stream types ─────────────────────────────────────────────────

// Every entry carries a STABLE `id`, assigned once at creation and preserved
// across in-place merges (the live text/reasoning entry mutates token-by-token
// yet keeps its id). The timeline `{#each}` is keyed by this id so expand/collapse
// toggles (thinking, tool-calls) stay pinned to the correct entry while the agent
// streams, instead of being reused-by-position and jumping to the wrong row.
export type StreamEntry = (
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | {
      kind: "tool_call";
      callId: string;
      name: string;
      status: string;
      detail?: import("./types.js").ToolCallDetail;
      error?: unknown;
    }
  | {
      kind: "error";
      content: string;
      code?: string;
      // Carried from a classified turn_failed so the renderer can show the polished
      // provider remedy (Add usage / Reconnect / Use an API key) the same way the
      // spawn path does, while keeping `content` as the raw error for debugging.
      reasonKind?: import("./types.js").ProviderReasonKind | null;
      unavailableReason?: string | null;
      provider?: string;
    }
  | { kind: "todo"; items: { text: string; completed: boolean }[] }
  | { kind: "compaction"; status: string }
  // messageId is the Paseo timeline user-message id (when the server provided
  // one) — the anchor for 'rewind to here' (#649). Absent for optimistic local
  // echoes that haven't round-tripped through the timeline yet.
  | { kind: "user_message"; content: string; messageId?: string }
  | { kind: "turn_boundary" }
) & { id: string };

export type TurnStatus = "idle" | "running" | "error" | "canceled";

export interface QueuedPrompt {
  id: string;
  text: string;
  // Attachments queued alongside the text (#579) — carried through the FIFO
  // flush so an image attached while the agent is busy isn't silently dropped.
  attachments?: Attachment[];
}

interface AgentStream {
  entries: StreamEntry[];
  turnStatus: TurnStatus;
  usage: AgentUsage | null;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  currentModel: string | null;
  currentModeId: string | null;
  availableModes: AgentMode[];
  thinkingOptionId: string | null;
  runtimeInfo: AgentRuntimeInfo | null;
  // Whether this stream instance was rebuilt from the server timeline. Lets the
  // mount-time fetch hydrate reliably even when a live event created the stream
  // first, without re-hydrating a healthy live stream on every remount. Reset to
  // false whenever the stream is recreated (e.g. after a workspace switch wipes
  // the map).
  hydrated: boolean;
  // Scroll-up lazy-load of older history. `olderCursor` pages further back;
  // `hasOlder` is whether any older entries remain; `loadingOlder` guards against
  // re-firing while a fetch is in flight.
  hasOlder: boolean;
  olderCursor: string | null;
  loadingOlder: boolean;
}

// ─── State Classes ────────────────────────────────────────────────

export class AgentStreamState {
  streams: Map<string, AgentStream> = $state(new Map());

  // ─── Client-side prompt queue ───────────────────────────────────
  // Prompts submitted while a turn is running are parked here per agent and
  // flushed FIFO when the turn completes (never on failure/cancel).
  queued: Map<string, QueuedPrompt[]> = $state(new Map());
  private queueSeq = 0;
  // Monotonic source for stable StreamEntry ids. Global (across agents) is fine —
  // ids only need to be unique within one agent's entry array; a fresh id per
  // newly-created entry, preserved through merges, guarantees that.
  private entrySeq = 0;
  // Per-agent memo for the curated "last activity" line (#594). Keyed on the
  // entries-array identity: `s.entries` is replaced (new reference) on every
  // mutation, so a cache hit means nothing changed → skip re-curation. This is
  // the throttle the AgentLastActivityCommitter provides in Paseo — here we
  // bound the work (cap the curation window) and reuse the last result instead
  // of re-walking the timeline on every streamed token.
  private lastActivityCache = new WeakMap<StreamEntry[], CuratedActivity | null>();
  private promptSender:
    | ((agentId: string, text: string, attachments?: Attachment[]) => void)
    | null = null;

  // Hard cap on a single agent's live stream entry array (RAM bound). A long
  // session (hours of streamed tokens + tool calls) otherwise grows `entries`
  // without limit — every append is an O(n) spread, and each StreamEntry pins
  // its text/detail in the renderer's keyed {#each}, so an uncapped stream is a
  // steady renderer-RAM leak (the "kills the Mac" path's cheaper sibling).
  // Mirrors LogState (cap 500) / ActivityState (cap 200): keep the most recent
  // MAX_ENTRIES, trimming to 80% on overflow so we don't reslice on every append
  // once the cap is hit. Reconnect/workspace-switch already resets to [] via
  // hydrate, so only live growth within one session matters here.
  private static readonly MAX_ENTRIES = 1000;

  // Trim s.entries to the cap in place (reassigns so runes observe it). A no-op
  // until the array exceeds MAX_ENTRIES. Trimming from the head drops the oldest
  // turns first — the visible "right now" tail is always preserved.
  private capEntries(s: AgentStream): void {
    if (s.entries.length <= AgentStreamState.MAX_ENTRIES) return;
    const keep = Math.floor(AgentStreamState.MAX_ENTRIES * 0.8);
    s.entries = s.entries.slice(-keep);
  }

  private nextEntryId(): string {
    return `e${++this.entrySeq}`;
  }

  // Wired once by the app layer (which holds the WS client) so a dequeued
  // prompt can be sent through the normal send path.
  setPromptSender(fn: (agentId: string, text: string, attachments?: Attachment[]) => void): void {
    this.promptSender = fn;
  }

  enqueue(agentId: string, text: string, attachments?: Attachment[]): QueuedPrompt {
    const item: QueuedPrompt = {
      id: `q${++this.queueSeq}`,
      text,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    const list = this.queued.get(agentId) ?? [];
    this.queued.set(agentId, [...list, item]);
    this.queued = new Map(this.queued);
    return item;
  }

  dequeue(agentId: string): QueuedPrompt | null {
    const list = this.queued.get(agentId);
    if (!list || list.length === 0) return null;
    const [next, ...rest] = list;
    if (rest.length > 0) this.queued.set(agentId, rest);
    else this.queued.delete(agentId);
    this.queued = new Map(this.queued);
    return next;
  }

  getQueue(agentId: string): QueuedPrompt[] {
    return this.queued.get(agentId) ?? [];
  }

  removeFromQueue(agentId: string, id: string): QueuedPrompt | null {
    const list = this.queued.get(agentId);
    if (!list) return null;
    const idx = list.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const removed = list[idx];
    const rest = [...list.slice(0, idx), ...list.slice(idx + 1)];
    if (rest.length > 0) this.queued.set(agentId, rest);
    else this.queued.delete(agentId);
    this.queued = new Map(this.queued);
    return removed;
  }

  private ensure(agentId: string): AgentStream {
    let s = this.streams.get(agentId);
    if (!s) {
      s = {
        entries: [],
        turnStatus: "idle",
        usage: null,
        pendingPermissions: new Map(),
        currentModel: null,
        currentModeId: null,
        availableModes: [],
        thinkingOptionId: null,
        runtimeInfo: null,
        hydrated: false,
        hasOlder: false,
        olderCursor: null,
        loadingOlder: false,
      };
      this.streams.set(agentId, s);
    }
    return s;
  }

  private touch(): void {
    this.streams = new Map(this.streams);
  }

  private turnTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  private clearTurnTimeout(agentId: string): void {
    const t = this.turnTimeouts.get(agentId);
    if (t) {
      clearTimeout(t);
      this.turnTimeouts.delete(agentId);
    }
  }

  private startTurnTimeout(agentId: string): void {
    this.clearTurnTimeout(agentId);
    this.turnTimeouts.set(
      agentId,
      setTimeout(
        () => {
          const s = this.streams.get(agentId);
          if (s && s.turnStatus === "running") {
            s.turnStatus = "error";
            s.entries = [
              ...s.entries,
              {
                id: this.nextEntryId(),
                kind: "error",
                content: "Turn timed out — no response from agent",
              },
            ];
            this.capEntries(s);
            s.pendingPermissions = new Map();
            this.touch();
          }
        },
        5 * 60 * 1000,
      ),
    );
  }

  private finalizeTurn(s: AgentStream): void {
    s.pendingPermissions = new Map();
  }

  // oxlint-disable-next-line eslint/complexity -- event type dispatch
  handleEvent(agentId: string, event: AgentEvent): void {
    switch (event.type) {
      case "timeline":
        this.handleTimeline(agentId, event.item);
        break;
      case "turn_started": {
        const s = this.ensure(agentId);
        s.turnStatus = "running";
        this.startTurnTimeout(agentId);
        this.touch();
        break;
      }
      case "turn_completed": {
        const s = this.ensure(agentId);
        s.turnStatus = "idle";
        if (event.usage) s.usage = event.usage;
        s.entries = [...s.entries, { id: this.nextEntryId(), kind: "turn_boundary" }];
        this.capEntries(s);
        this.finalizeTurn(s);
        this.clearTurnTimeout(agentId);
        this.touch();
        // Flush the next queued prompt (FIFO). Only on success — never after
        // turn_failed / turn_canceled, so prompts don't chain onto an error.
        const next = this.dequeue(agentId);
        if (next) this.promptSender?.(agentId, next.text, next.attachments);
        break;
      }
      case "turn_failed": {
        const s = this.ensure(agentId);
        s.turnStatus = "error";
        s.entries = [
          ...s.entries,
          {
            id: this.nextEntryId(),
            kind: "error",
            content: event.error,
            code: event.code,
            // Thread the daemon's classification (when present) so the renderer
            // can swap the raw 400 for the polished remedy. Absent on older
            // daemons / non-provider failures → renderer shows the raw error.
            reasonKind: event.reasonKind ?? null,
            unavailableReason: event.unavailableReason ?? null,
            provider: event.provider,
          },
        ];
        this.capEntries(s);
        this.finalizeTurn(s);
        this.clearTurnTimeout(agentId);
        this.touch();
        break;
      }
      case "turn_canceled": {
        const s = this.ensure(agentId);
        s.turnStatus = "canceled";
        s.entries = [
          ...s.entries,
          { id: this.nextEntryId(), kind: "error", content: `Canceled: ${event.reason}` },
        ];
        this.capEntries(s);
        this.finalizeTurn(s);
        this.clearTurnTimeout(agentId);
        this.touch();
        break;
      }
      case "permission_requested": {
        const s = this.ensure(agentId);
        s.pendingPermissions.set(event.request.id, event.request);
        this.touch();
        break;
      }
      case "permission_resolved": {
        const s = this.ensure(agentId);
        s.pendingPermissions.delete(event.requestId);
        this.touch();
        break;
      }
      case "usage_updated": {
        this.ensure(agentId).usage = event.usage;
        this.touch();
        break;
      }
      case "model_changed": {
        const s = this.ensure(agentId);
        s.runtimeInfo = event.runtimeInfo;
        s.currentModel = event.runtimeInfo.model ?? null;
        if (event.runtimeInfo.thinkingOptionId !== undefined) {
          s.thinkingOptionId = event.runtimeInfo.thinkingOptionId ?? null;
        }
        if (event.runtimeInfo.modeId !== undefined) {
          s.currentModeId = event.runtimeInfo.modeId ?? null;
        }
        this.touch();
        break;
      }
      case "mode_changed": {
        const s = this.ensure(agentId);
        s.currentModeId = event.currentModeId;
        s.availableModes = event.availableModes;
        this.touch();
        break;
      }
      case "thinking_option_changed": {
        const s = this.ensure(agentId);
        s.thinkingOptionId = event.thinkingOptionId;
        this.touch();
        break;
      }
      case "thread_started": {
        const s = this.ensure(agentId);
        s.runtimeInfo = {
          ...s.runtimeInfo,
          sessionId: event.sessionId,
        } as typeof s.runtimeInfo;
        this.touch();
        break;
      }
      case "attention_required": {
        this.ensure(agentId);
        this.touch();
        break;
      }
    }
  }

  private mergeText(existing: string, incoming: string): string {
    if (incoming.length === 0) return existing;
    if (existing.length === 0) return incoming;
    if (existing === incoming) return existing;
    if (existing.endsWith(incoming)) return existing;
    if (incoming.startsWith(existing)) return incoming;

    const probeLen = Math.min(16, incoming.length, existing.length);
    if (probeLen < 4) return existing + incoming;

    const probe = incoming.substring(0, probeLen);
    const earliest = Math.max(0, existing.length - incoming.length);

    let pos = existing.indexOf(probe, earliest);
    while (pos >= 0) {
      const overlapLen = existing.length - pos;
      if (overlapLen <= incoming.length) {
        const tail = existing.substring(pos);
        const head = incoming.substring(0, overlapLen);
        if (tail === head) {
          return existing + incoming.substring(overlapLen);
        }
      }
      pos = existing.indexOf(probe, pos + 1);
    }

    return existing + incoming;
  }

  private findLastTextInTurn(entries: StreamEntry[]): number {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.kind === "text") return i;
      if (e.kind === "thinking") continue;
      break;
    }
    return -1;
  }

  // One compaction emits TWO timeline items — a "compacting" status
  // (status:"loading" → "Compressing context...") then a "compact_boundary"
  // (status:"completed" → "Context compressed"). Coalesce them into ONE entry that
  // transitions loading→done, mirroring how tool_call updates in place; otherwise
  // the compaction renders as two separate cards (the duplicate). Update the most
  // recent still-loading compaction in the current turn, else append.
  private applyCompaction(s: AgentStream, status: "loading" | "completed"): void {
    if (status !== "loading") {
      for (let i = s.entries.length - 1; i >= 0; i--) {
        const e = s.entries[i];
        if (e.kind === "turn_boundary") break;
        if (e.kind === "compaction" && e.status === "loading") {
          s.entries = [
            ...s.entries.slice(0, i),
            { id: e.id, kind: "compaction", status },
            ...s.entries.slice(i + 1),
          ];
          return;
        }
      }
    }
    s.entries = [...s.entries, { id: this.nextEntryId(), kind: "compaction", status }];
  }

  private handleTimeline(agentId: string, item: AgentTimelineItem, _hydrating = false): void {
    const s = this.ensure(agentId);
    switch (item.type) {
      case "assistant_message": {
        const lastTextIdx = this.findLastTextInTurn(s.entries);
        if (lastTextIdx >= 0) {
          const prev = s.entries[lastTextIdx] as StreamEntry & { kind: "text" };
          // Preserve the entry's id across the in-place token merge so its key
          // (and any toggle state) stays stable as it streams.
          s.entries = [
            ...s.entries.slice(0, lastTextIdx),
            { id: prev.id, kind: "text", content: this.mergeText(prev.content, item.text) },
            ...s.entries.slice(lastTextIdx + 1),
          ];
        } else {
          s.entries = [...s.entries, { id: this.nextEntryId(), kind: "text", content: item.text }];
        }
        break;
      }
      case "reasoning": {
        const last = s.entries[s.entries.length - 1];
        if (last && last.kind === "thinking") {
          s.entries = [
            ...s.entries.slice(0, -1),
            { id: last.id, kind: "thinking", content: this.mergeText(last.content, item.text) },
          ];
        } else {
          s.entries = [
            ...s.entries,
            { id: this.nextEntryId(), kind: "thinking", content: item.text },
          ];
        }
        break;
      }
      case "tool_call": {
        const idx = s.entries.findIndex((e) => e.kind === "tool_call" && e.callId === item.callId);
        // Reuse the existing entry's id when updating in place (status/detail
        // changes) so its key — and the expand/collapse toggle keyed on callId —
        // survives; a brand-new tool_call gets a fresh id.
        const updated = {
          id: idx >= 0 ? s.entries[idx].id : this.nextEntryId(),
          kind: "tool_call" as const,
          callId: item.callId,
          name: item.name,
          status: item.status,
          detail: item.detail,
          error: item.error,
        };
        if (idx >= 0) {
          s.entries = [...s.entries.slice(0, idx), updated, ...s.entries.slice(idx + 1)];
        } else {
          s.entries = [...s.entries, updated];
        }
        break;
      }
      case "todo":
        s.entries = [...s.entries, { id: this.nextEntryId(), kind: "todo", items: item.items }];
        break;
      case "error":
        s.entries = [
          ...s.entries,
          { id: this.nextEntryId(), kind: "error", content: item.message },
        ];
        break;
      case "compaction":
        this.applyCompaction(s, item.status);
        break;
      case "user_message": {
        const text = stripDmPrefix(item.text);
        // Dedup the echoed prompt against the current turn (back to the last
        // boundary), not just the last entry — the agent often appends text before
        // the server echo arrives, so the optimistic prompt isn't `last` anymore
        // and the prompt would otherwise be duplicated below the reply.
        //
        // RACE FIX (boss double-bubble: "hey you alive?" shown twice with a
        // hairline between): the server's user_message echo can arrive AFTER
        // `turn_completed` already appended a turn_boundary. The old scan stopped
        // at that trailing boundary and never reached the optimistic message
        // sitting just before it — so the echo was appended as a duplicate, and
        // the boundary in between rendered as the "stray hairline". When the most
        // recent entry IS a turn_boundary, the just-completed turn is exactly the
        // one this echo belongs to, so we step past that single trailing boundary
        // and keep scanning the prior turn for the matching optimistic prompt.
        // (Cross-turn dedup is unaffected: a genuinely new prompt won't match an
        // optimistic entry immediately before the trailing boundary unless it's
        // the very text we just sent — i.e. the echo we want to drop.)
        let crossedTrailingBoundary = false;
        for (let i = s.entries.length - 1; i >= 0; i--) {
          const e = s.entries[i];
          if (e.kind === "turn_boundary") {
            if (i === s.entries.length - 1 && !crossedTrailingBoundary) {
              crossedTrailingBoundary = true;
              continue;
            }
            break;
          }
          if (e.kind === "user_message" && e.content === text) return;
        }
        s.entries = [
          ...s.entries,
          // Carry the timeline messageId (the 'rewind to here' anchor, #649) when
          // the server provided one. Optimistic echoes have none until they
          // round-trip; a later hydrate replaces them with the id-bearing item.
          {
            id: this.nextEntryId(),
            kind: "user_message",
            content: text,
            messageId: item.messageId,
          },
        ];
        break;
      }
    }
    this.capEntries(s);
    this.touch();
  }

  addUserMessage(agentId: string, text: string): void {
    const s = this.ensure(agentId);
    s.entries = [...s.entries, { id: this.nextEntryId(), kind: "user_message", content: text }];
    this.capEntries(s);
    this.touch();
  }

  hydrateFromTimeline(
    agentId: string,
    items: Record<string, unknown>[],
    meta?: { hasOlder?: boolean; olderCursor?: string | null },
  ): void {
    const s = this.ensure(agentId);
    s.entries = [];
    // Replay through the SAME merge logic as the live stream (handleTimeline):
    // the daemon persists a reply as many delta items (one per chunk), so a naive
    // 1:1 mapping rendered the text split across dozens of lines and produced
    // several "thinking" blocks per turn. handleTimeline merges consecutive text
    // (mergeText) and reasoning, and dedups tool_calls / the echoed prompt, so
    // reloaded history matches what was shown live.
    for (const raw of items) {
      const item = raw as unknown as AgentTimelineItem;
      // The persisted timeline has no turn_boundary; synthesize one when a new
      // user_message starts a turn so multi-turn history doesn't fuse into one
      // block.
      if (item.type === "user_message" && s.entries.length > 0) {
        s.entries = [...s.entries, { id: this.nextEntryId(), kind: "turn_boundary" }];
      }
      this.handleTimeline(agentId, item);
    }
    s.hydrated = true;
    if (meta) {
      s.hasOlder = meta.hasOlder ?? false;
      s.olderCursor = meta.olderCursor ?? null;
    }
    this.touch();
  }

  // Prepend an OLDER page of timeline history (scroll-up lazy-load). The page is
  // replayed through the SAME merge logic in ISOLATION (a throwaway state) so it
  // never clobbers this stream's current turn status / usage; the resulting entries
  // are re-id'd with this stream's counter (so keys stay unique) and spliced at the
  // FRONT, with a turn boundary between the old tail and the existing head.
  prependTimeline(
    agentId: string,
    items: Record<string, unknown>[],
    meta: { hasOlder: boolean; olderCursor: string | null },
  ): void {
    const s = this.ensure(agentId);
    s.hasOlder = meta.hasOlder;
    s.olderCursor = meta.olderCursor;
    if (items.length === 0) {
      this.touch();
      return;
    }
    const temp = new AgentStreamState();
    temp.hydrateFromTimeline(agentId, items);
    // Re-id with THIS stream's counter so keys stay unique. The temp instance is
    // throwaway, so mutate its entries in place.
    const olderEntries = temp.getEntries(agentId);
    for (const e of olderEntries) e.id = this.nextEntryId();
    if (olderEntries.length > 0) {
      // Bridge the old tail and the existing head with a turn boundary — but only
      // if one isn't already there. After capEntries() trims from the head, the
      // current head's first entry can itself be a turn_boundary; an unconditional
      // bridge would then render two consecutive dividers.
      const headIsBoundary = s.entries[0]?.kind === "turn_boundary";
      const olderTailIsBoundary = olderEntries[olderEntries.length - 1]?.kind === "turn_boundary";
      const bridge =
        s.entries.length > 0 && !headIsBoundary && !olderTailIsBoundary
          ? [{ id: this.nextEntryId(), kind: "turn_boundary" as const }]
          : [];
      s.entries = [...olderEntries, ...bridge, ...s.entries];
    }
    this.touch();
  }

  setLoadingOlder(agentId: string, loading: boolean): void {
    const s = this.streams.get(agentId);
    if (s) {
      s.loadingOlder = loading;
      this.touch();
    }
  }

  hasOlder(agentId: string): boolean {
    return this.streams.get(agentId)?.hasOlder ?? false;
  }

  olderCursor(agentId: string): string | null {
    return this.streams.get(agentId)?.olderCursor ?? null;
  }

  isLoadingOlder(agentId: string): boolean {
    return this.streams.get(agentId)?.loadingOlder ?? false;
  }

  clearStream(agentId: string): void {
    const s = this.streams.get(agentId);
    if (s) {
      s.entries = [];
      this.touch();
    }
  }

  clear(agentId: string): void {
    this.clearTurnTimeout(agentId);
    this.streams.delete(agentId);
    if (this.queued.delete(agentId)) this.queued = new Map(this.queued);
    this.touch();
  }

  // Drop all live streams (e.g. on workspace switch) so re-entering rebuilds from
  // the server timeline. Deliberately does NOT clear `queued`: a queued prompt is
  // unsent user input, keyed by agentId (globally unique), so it must survive a
  // workspace round-trip instead of being silently discarded.
  clearAll(): void {
    for (const id of this.turnTimeouts.keys()) {
      this.clearTurnTimeout(id);
    }
    this.streams = new Map();
  }

  getEntries(agentId: string): StreamEntry[] {
    return this.streams.get(agentId)?.entries ?? [];
  }

  // Curated, glanceable "what is this agent doing right now" line (#594):
  // `[Shell] pnpm test`, `[Assistant] Done — 42 passing`, `[Error] …`. Derived
  // from the live timeline via the pure curator, so it advances as the stream
  // does. Reactive: reading `s.entries` inside a `$derived`/`$effect` (the agent
  // row) re-runs when the stream mutates. Only the last `MAX_ACTIVITY_SCAN`
  // entries are curated — the head is all the "right now" line needs, and it
  // keeps the per-update cost bounded on long timelines. Returns null when there
  // is no activity yet (renderer falls back to the generic status line).
  getLastActivity(agentId: string): CuratedActivity | null {
    const entries = this.streams.get(agentId)?.entries;
    if (!entries || entries.length === 0) {
      return null;
    }
    const cached = this.lastActivityCache.get(entries);
    if (cached !== undefined) {
      return cached;
    }
    const curated = curateLastActivity(entries, { maxItems: MAX_ACTIVITY_SCAN });
    this.lastActivityCache.set(entries, curated);
    return curated;
  }

  // Whether this agent's stream was already rebuilt from the server timeline in
  // its current instance — the mount-time fetch guards on this (not entry count)
  // so a live event arriving first can't suppress the history hydrate.
  isHydrated(agentId: string): boolean {
    return this.streams.get(agentId)?.hydrated ?? false;
  }

  getTurnStatus(agentId: string): TurnStatus {
    return this.streams.get(agentId)?.turnStatus ?? "idle";
  }

  getUsage(agentId: string): AgentUsage | null {
    return this.streams.get(agentId)?.usage ?? null;
  }

  getPendingPermissions(agentId: string): AgentPermissionRequest[] {
    return Array.from(this.streams.get(agentId)?.pendingPermissions.values() ?? []);
  }

  getModel(agentId: string): string | null {
    return this.streams.get(agentId)?.currentModel ?? null;
  }

  // Optimistically reflect a model switch right away. The server's model_changed
  // event doesn't reliably reach cloud guests, so without this the selector stays
  // stale (shows the old/binding model) even though the switch took effect.
  setModel(agentId: string, model: string | null): void {
    this.ensure(agentId).currentModel = model;
    this.touch();
  }

  // Same optimistic reflection for thinking/mode switches — their
  // thinking_option_changed / mode_changed events share model_changed's
  // cloud-guest unreliability, so without this the pills stay stale after a user
  // switch (the reported "effort stays on the old value" / bypass-not-updating).
  setThinkingOption(agentId: string, thinkingOptionId: string | null): void {
    this.ensure(agentId).thinkingOptionId = thinkingOptionId;
    this.touch();
  }

  setModeId(agentId: string, modeId: string | null): void {
    this.ensure(agentId).currentModeId = modeId;
    this.touch();
  }

  // Seed mode/thinking from the agent's INITIAL snapshot (roster / agent state),
  // not just from the *_changed stream events. Non-ACP providers (Claude, Codex,
  // Pi, OpenCode) never emit mode_changed/thinking_option_changed, so without
  // this the composer falls back to the generic default/bypass mode list and a
  // blank thinking value. Fills gaps only — a live event already received is
  // never clobbered.
  hydrateFromSnapshot(
    agentId: string,
    snapshot: {
      availableModes?: AgentMode[] | null;
      currentModeId?: string | null;
      thinkingOptionId?: string | null;
    },
  ): void {
    const s = this.ensure(agentId);
    let changed = false;
    if (
      s.availableModes.length === 0 &&
      snapshot.availableModes &&
      snapshot.availableModes.length > 0
    ) {
      s.availableModes = snapshot.availableModes;
      changed = true;
    }
    if (s.currentModeId == null && snapshot.currentModeId != null) {
      s.currentModeId = snapshot.currentModeId;
      changed = true;
    }
    if (s.thinkingOptionId == null && snapshot.thinkingOptionId != null) {
      s.thinkingOptionId = snapshot.thinkingOptionId;
      changed = true;
    }
    if (changed) this.touch();
  }

  getModeId(agentId: string): string | null {
    return this.streams.get(agentId)?.currentModeId ?? null;
  }

  getAvailableModes(agentId: string): AgentMode[] {
    return this.streams.get(agentId)?.availableModes ?? [];
  }

  getThinkingOptionId(agentId: string): string | null {
    return this.streams.get(agentId)?.thinkingOptionId ?? null;
  }

  getRuntimeInfo(agentId: string): AgentRuntimeInfo | null {
    return this.streams.get(agentId)?.runtimeInfo ?? null;
  }
}

// ─── Agent attention (#591: derived finished/error "needs attention") ─────────
//
// Holds the per-agent derived attention reason for the agents-LIST badge, kept
// separate from AgentStreamState so the change is additive (no refactor of the
// shared stream structures; #594 edits the same file in parallel). Two inputs
// feed it:
//   1. The list snapshot (cyborg:list_agents) — authoritative for agents the
//      client isn't actively streaming; seeded via seedFromSnapshot on each
//      listAgents.
//   2. Live turn events — for an agent already streaming, a turn that completes
//      ("finished") or fails ("error") raises attention without a refetch,
//      mirroring the daemon's edge rule (noteTurnEvent).
// The flag is CLEARED when the agent is viewed (clearForView), the issue's
// falsifiable DONE. A viewed-this-session guard (`cleared`) stops an in-flight
// snapshot from resurrecting a badge the user just dismissed.
export class AttentionState {
  // agentId → the reason a badge should show. Absent = no attention badge.
  private reasons: Map<string, AgentAttentionReason> = $state(new Map());
  // agentIds the user opened this session — suppresses snapshot re-raise until a
  // genuinely new edge (a fresh turn) occurs.
  private cleared: Set<string> = new Set();

  private raise(agentId: string, reason: AgentAttentionReason): void {
    // Only the rendered reasons matter; "permission" has its own surface.
    if (reason !== "finished" && reason !== "error") return;
    if (this.reasons.get(agentId) === reason) return;
    // `reasons` is a Svelte 5 reactive Map proxy ($state(new Map())): a `.set()`
    // here surgically triggers only the effects reading THIS key — no manual
    // reassignment (the old `touch()`) which would re-run every observer.
    this.reasons.set(agentId, reason);
  }

  // Seed/refresh from a list snapshot row's attention projection. Adopts a fresh
  // server-set flag (unless the user already cleared it this session), and
  // clears when the server reports it no longer requires attention (e.g. another
  // device viewed it).
  seedFromSnapshot(agentId: string, attention: AgentAttention | null | undefined): void {
    const reason = reconcileAttentionFromSnapshot({
      snapshot: attention,
      locallyCleared: this.cleared.has(agentId),
    });
    if (reason) {
      this.raise(agentId, reason);
    } else {
      // `.delete()` on the reactive Map is itself reactive (and a no-op when the
      // key is absent), so no guard / reassignment needed.
      this.reasons.delete(agentId);
    }
  }

  // Bulk seed from a full agents list (each row may carry `attention`).
  seedFromAgents(agents: Array<{ agentId: string; attention?: AgentAttention | null }>): void {
    for (const a of agents) this.seedFromSnapshot(a.agentId, a.attention);
  }

  // Live turn edge for an agent already streaming. A new turn STARTING means the
  // agent is active again — drop any stale "finished/error" and un-suppress so a
  // future completion/failure re-raises (the user is clearly back working on it).
  noteTurnEvent(agentId: string, eventType: AgentTurnEventType): void {
    if (eventType === "turn_started") {
      this.cleared.delete(agentId);
      this.reasons.delete(agentId);
      return;
    }
    const reason = attentionReasonForTurnEvent(eventType);
    if (reason) this.raise(agentId, reason);
  }

  // Viewing the agent clears its attention badge (the falsifiable DONE). Marks it
  // cleared-this-session so an in-flight snapshot can't immediately re-raise it.
  clearForView(agentId: string): void {
    this.cleared.add(agentId);
    this.reasons.delete(agentId);
  }

  getReason(agentId: string): AgentAttentionReason | null {
    return this.reasons.get(agentId) ?? null;
  }

  // The badge to render for a row (label/tone/description), or null.
  badgeFor(agentId: string): AttentionBadge | null {
    return badgeForReason(this.reasons.get(agentId) ?? null);
  }

  requiresAttention(agentId: string): boolean {
    return this.reasons.has(agentId);
  }

  // Drop everything (workspace switch / disconnect).
  clearAll(): void {
    this.reasons.clear();
    this.cleared.clear();
  }
}

export class ProviderState {
  list: ProviderInfo[] = $state([]);
  loading = $state(false);
  // Per-daemon catalogs. In multi-daemon workspaces the un-targeted
  // cyborg:list_providers lands on an arbitrary daemon, so the flat `list` can
  // be ANOTHER daemon's catalog — looking up an agent's provider there misses
  // and the model menu silently degrades to a static label. Surfaces that know
  // their daemon must read through forDaemon() instead.
  byDaemon: Record<string, ProviderInfo[]> = $state({});
  // Per-daemon in-flight flags: several composers can mount at once (and for
  // DIFFERENT daemons) — a single global `loading` would either dedupe wrongly
  // or serialize unrelated fetches.
  loadingDaemons: Record<string, boolean> = $state({});

  get available(): ProviderInfo[] {
    return this.list.filter((p) => p.available);
  }

  /** Catalog for a specific daemon, falling back to the last global fetch. */
  forDaemon(daemonId: string | null | undefined): ProviderInfo[] {
    if (daemonId && this.byDaemon[daemonId]) return this.byDaemon[daemonId];
    return this.list;
  }
}

export class CyboState {
  list: Cybo[] = $state([]);
  loading = $state(false);
}

// ─── Daemon state (global selector + per-workspace daemon list) ──────
//
// Makes daemons first-class: the full workspace daemon list, per-user access
// grants, and a single globally-selected daemon id. Live online/offline status
// is merged from the `daemon_status` WS handler so dots stay realtime without
// re-fetching. All getters fall back gracefully so single-daemon users keep the
// default behavior (the one daemon is auto-loaded).

export class DaemonState {
  list: Daemon[] = $state([]);
  access: DaemonAccessEntry[] = $state([]);
  loading = $state(false);
  // Explicit user/route selection. `null` means "use the auto-loaded default".
  // Backed by a private rune + per-workspace localStorage so the choice is
  // STICKY across reloads/navigation (issue #34). Assigning `selectedId` from
  // anywhere persists it; `load()` restores + validates it against the current
  // (present + accessible) daemon list.
  //
  // BLAST RADIUS of the global daemon selector (issue #38) — what `selectedId`
  // re-scopes, v1 (intentionally narrow to avoid scope creep):
  //   1. NEW SESSIONS: agent/new + the create-agent dialog seed their target
  //      daemon from `effectiveId()` (selectedId → fallbacks). Selecting a daemon
  //      sets where the next agent/cybo spawns.
  //   2. DETAIL VIEW: the Agents pane's Daemon sub-tab shows the selected daemon's
  //      DaemonDetail (providers, access, cybos, slash default).
  // It does NOT (yet) filter the Agents list, Logs, or existing sessions by
  // daemon — that's a deliberate later step, not implied by the selector today.
  private _selectedId = $state<string | null>(null);
  // The user's configured default daemon for slash commands (null = unset).
  defaultSlashDaemonId: string | null = $state(null);
  // The user's preferred model for channel AI commands (null = auto-resolve).
  slashCommandModel: { provider: string; model: string } | null = $state(null);
  // Realtime overrides keyed by daemon id, fed by the daemon_status handler.
  private liveStatus = $state<Record<string, "online" | "offline">>({});

  get selectedId(): string | null {
    return this._selectedId;
  }
  set selectedId(id: string | null) {
    this._selectedId = id;
    if (id) this.writeStoredSelection(id);
    else this.clearStoredSelection();
  }

  load(daemons: Daemon[], access: DaemonAccessEntry[]): void {
    this.list = daemons;
    this.access = access;
    this.reconcileSelection();
  }

  // Refresh just the per-user access grants (e.g. after a daemon-access request is
  // approved) without touching the daemon list / selection.
  setAccess(access: DaemonAccessEntry[]): void {
    this.access = access;
  }

  // Restore the persisted per-workspace selection, then keep it only if the
  // daemon is still PRESENT and ACCESSIBLE. A removed daemon or a revoked grant
  // drops the stale pointer (issues #33, #34); an offline-but-accessible daemon
  // stays selected so the detail view can surface its offline state (#33).
  private reconcileSelection(): void {
    const candidate = this.readStoredSelection() ?? this._selectedId;
    if (candidate && this.isSelectable(candidate)) {
      this._selectedId = candidate;
      this.writeStoredSelection(candidate);
    } else {
      this._selectedId = null;
      this.clearStoredSelection();
    }
  }

  // Present in the list AND accessible to the current user (online not required).
  private isSelectable(daemonId: string): boolean {
    const daemon = this.byId(daemonId);
    return !!daemon && this.hasAccess(daemon, authState.user?.id);
  }

  private selectionStorageKey(): string | null {
    const wsId = workspaceState.current?.id;
    return wsId ? `cyborg.daemon.selected.${wsId}` : null;
  }
  private readStoredSelection(): string | null {
    const key = this.selectionStorageKey();
    if (!key) return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  private writeStoredSelection(daemonId: string): void {
    const key = this.selectionStorageKey();
    if (!key) return;
    try {
      localStorage.setItem(key, daemonId);
    } catch {
      // intentional: best-effort daemon-selection persistence; not user-facing.
    }
  }
  private clearStoredSelection(): void {
    const key = this.selectionStorageKey();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // intentional: best-effort daemon-selection cleanup; not user-facing.
    }
  }

  setDefaultSlashDaemon(daemonId: string | null): void {
    this.defaultSlashDaemonId = daemonId;
  }

  setSlashCommandModel(model: { provider: string; model: string } | null): void {
    this.slashCommandModel = model;
  }

  setStatus(daemonId: string, status: "online" | "offline"): void {
    this.liveStatus = { ...this.liveStatus, [daemonId]: status };
  }

  clear(): void {
    this.list = [];
    this.access = [];
    this.selectedId = null;
    this.defaultSlashDaemonId = null;
    this.slashCommandModel = null;
    this.liveStatus = {};
  }

  byId(daemonId: string): Daemon | undefined {
    return this.list.find((d) => d.id === daemonId);
  }

  isOnline(daemonId: string): boolean {
    const live = this.liveStatus[daemonId];
    if (live) return live === "online";
    return this.byId(daemonId)?.status === "online";
  }

  get online(): Daemon[] {
    return this.list.filter((d) => this.isOnline(d.id));
  }

  // Online daemons the current user may run code on (owner OR daemon_access
  // grant) — what capability/provider rows must enumerate instead of `online`,
  // so foreign daemons are never offered as setup/spawn targets. $derived (not
  // a getter): capability rows read this per render row, memoization keeps the
  // filter from re-running on every read.
  accessibleOnline: Daemon[] = $derived(
    accessibleOnlineDaemons(
      this.list,
      (d) => this.isOnline(d.id),
      (d) => this.hasAccess(d, authState.user?.id),
    ),
  );

  // Human-readable machine location, e.g. "macbook · darwin/arm64".
  locationLabel(meta?: DaemonMeta | null): string | null {
    if (!meta) return null;
    const host = meta.host?.trim();
    const os = [meta.platform, meta.arch].filter(Boolean).join("/");
    if (host && os) return `${host} · ${os}`;
    return host || os || null;
  }

  // Users with access to a daemon: its owner is always implicitly included.
  accessUserIds(daemonId: string): string[] {
    const owner = this.byId(daemonId)?.ownerId;
    const ids = new Set<string>(owner ? [owner] : []);
    for (const a of this.access) {
      if (a.daemonId === daemonId) ids.add(a.userId);
    }
    return [...ids];
  }

  // The raw scopes a non-owner user holds on a daemon (#705), as stored in the
  // access list. Returns null if there is no grant ROW for them (no access).
  // The owner is handled by the caller (owner = implicit admin, not a row). A
  // present row with a missing/empty scopes field is normalized to ['admin']
  // (legacy total-access fail-safe) by the matrix via normalizeScopes.
  accessScopesFor(daemonId: string, userId: string): string[] | null {
    const entry = this.access.find((a) => a.daemonId === daemonId && a.userId === userId);
    return entry ? (entry.scopes ?? null) : null;
  }

  // Public access-matrix check by id (owner OR daemon_access grant) — mirrors
  // the server gate (pg-sync.canUserAccessDaemon). Drives selectors that must
  // only offer daemons the user may run code on (e.g. the slash-daemon config).
  canAccess(daemonId: string, currentUserId: string | undefined): boolean {
    const daemon = this.byId(daemonId);
    return !!daemon && this.hasAccess(daemon, currentUserId);
  }

  private hasAccess(daemon: Daemon, currentUserId: string | undefined): boolean {
    if (!currentUserId) return false;
    if (daemon.ownerId === currentUserId) return true;
    return this.access.some((a) => a.daemonId === daemon.id && a.userId === currentUserId);
  }

  // The daemon a new session should target by default — never a foreign one.
  // Priority lives in pickDefaultDaemon (pure + unit-tested in daemon-select.ts).
  loadedId(currentUserId: string | undefined): string | null {
    return pickDefaultDaemon(
      this.list,
      currentUserId,
      (d) => this.isOnline(d.id),
      (d) => this.hasAccess(d, currentUserId),
    );
  }

  // The effective selected daemon: an explicit selection wins, else the default.
  effectiveId(currentUserId: string | undefined): string | null {
    // Only honor the explicit selection if it's still usable — online AND
    // accessible. A selected daemon that went offline or had its access revoked
    // must NOT be returned, or launch defaults would target an unreachable
    // daemon and fail; fall back to the auto-select default instead.
    const sel = this.selectedId ? this.byId(this.selectedId) : undefined;
    if (sel && this.isOnline(sel.id) && this.hasAccess(sel, currentUserId)) return sel.id;
    return this.loadedId(currentUserId);
  }

  // ── No-daemon / cloud-only + selected-daemon health (issues #32, #33) ──

  // True when the workspace has zero daemons at all (cloud-only / none connected).
  get isEmpty(): boolean {
    return this.list.length === 0;
  }

  // Any daemon the user can actually launch on right now (online + accessible).
  // Drives the new-session guard + the sidebar empty-state CTA (#32).
  hasUsableDaemon(currentUserId: string | undefined): boolean {
    return this.list.some((d) => this.isOnline(d.id) && this.hasAccess(d, currentUserId));
  }

  // The EXPLICITLY selected daemon is present + accessible but currently OFFLINE.
  // The detail view shows an offline state and blocks new sessions rather than
  // silently auto-switching (#33).
  get selectionOffline(): boolean {
    const id = this._selectedId;
    return !!id && !!this.byId(id) && !this.isOnline(id);
  }

  // One-line "why this daemon is loaded" hint for the detail view (#33).
  loadedReason(currentUserId: string | undefined): string {
    const id = this.effectiveId(currentUserId);
    if (!id) {
      return this.isEmpty ? "No daemons in this workspace" : "No daemon you can use right now";
    }
    const daemon = this.byId(id);
    if (!daemon) return "";
    if (this._selectedId === id) return "Selected by you";
    if (daemon.ownerId === currentUserId) return "Your online daemon";
    return "The only online daemon you can access";
  }
}

// ─── Log State (workspace-level event log) ───────────────────────

export type LogLevel = "error" | "warn" | "info" | "debug";
export type LogCategory =
  | "agent"
  | "task"
  | "channel"
  | "system"
  | "tool_use"
  | "permission"
  | "dm"
  // #995 audit-trace categories (the cybo context/tool/spawn/daemon traces).
  | "context_injection"
  | "tool_injection"
  | "spawn_lifecycle"
  | "invocation_decision"
  | "daemon_operation"
  | "failure";

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  category: LogCategory;
  // #995 structured audit ids — present only on audit_event entries (the existing
  // task-event ingest drops these; the audit ingest retains them so the Logs tab
  // can slice by session / cybo / daemon / kind). Optional, so every other entry
  // is unaffected.
  daemonId?: string | null;
  agentId?: string | null;
  cyboId?: string | null;
  kind?: string | null;
  payload?: Record<string, unknown> | null;
}

// The structured input retained by pushAudit (#995) — the full redacted audit
// line off the wire, minus the client-assigned id/timestamp.
export interface AuditLogInput {
  level: LogLevel;
  category: LogCategory;
  source: string;
  message: string;
  kind: string;
  daemonId?: string | null;
  agentId?: string | null;
  cyboId?: string | null;
  payload?: Record<string, unknown> | null;
}

let logSeq = 0;

export class LogState {
  entries: LogEntry[] = $state([]);
  maxEntries = 500;

  bindWorkspace(_workspaceId: string): void {
    this.entries = [];
  }

  hydrateFromMessages(
    messages: Array<{
      id: string;
      fromType: "human" | "agent" | "system";
      fromName?: string;
      fromId: string;
      channelId: string | null;
      text: string;
      createdAt: number;
    }>,
  ): void {
    const hydrated: LogEntry[] = messages.map((m) => ({
      id: `log-${++logSeq}`,
      timestamp: new Date(m.createdAt).toISOString(),
      level: "info" as const,
      source: m.fromName ?? m.fromId.slice(0, 8),
      message: m.text.length > 200 ? m.text.slice(0, 200) + "..." : m.text,
      category: m.channelId ? ("channel" as const) : ("dm" as const),
    }));
    this.entries = hydrated;
  }

  push(level: LogLevel, category: LogCategory, source: string, message: string): void {
    const entry: LogEntry = {
      id: `log-${++logSeq}`,
      timestamp: new Date().toISOString(),
      level,
      source,
      message,
      category,
    };
    if (this.entries.length >= this.maxEntries) {
      this.entries = [...this.entries.slice(-Math.floor(this.maxEntries * 0.8)), entry];
    } else {
      this.entries = [...this.entries, entry];
    }
  }

  // #995: push a structured audit line, RETAINING the audit ids (agentId/cyboId/
  // daemonId/kind/payload) that plain `push` drops. Shares the same 500-entry FIFO
  // cap so memory stays bounded.
  pushAudit(input: AuditLogInput): void {
    const entry: LogEntry = {
      id: `log-${++logSeq}`,
      timestamp: new Date().toISOString(),
      level: input.level,
      source: input.source,
      message: input.message,
      category: input.category,
      kind: input.kind,
      daemonId: input.daemonId ?? null,
      agentId: input.agentId ?? null,
      cyboId: input.cyboId ?? null,
      payload: input.payload ?? null,
    };
    if (this.entries.length >= this.maxEntries) {
      this.entries = [...this.entries.slice(-Math.floor(this.maxEntries * 0.8)), entry];
    } else {
      this.entries = [...this.entries, entry];
    }
  }

  pushAgentEvent(agentId: string, event: AgentEvent): void {
    const agentName = this.resolveAgentName(agentId);

    switch (event.type) {
      case "turn_started":
        this.push("info", "agent", agentName, "Turn started");
        break;
      case "turn_completed":
        if (event.usage?.totalCostUsd) {
          this.push(
            "info",
            "agent",
            agentName,
            `Turn completed ($${event.usage.totalCostUsd.toFixed(4)})`,
          );
        } else {
          this.push("info", "agent", agentName, "Turn completed");
        }
        break;
      case "turn_failed":
        this.push("error", "agent", agentName, event.error);
        break;
      case "turn_canceled":
        this.push("warn", "agent", agentName, `Canceled: ${event.reason}`);
        break;
      case "permission_requested":
        this.push(
          "warn",
          "permission",
          agentName,
          `Permission requested: ${event.request.title ?? event.request.name}`,
        );
        break;
      case "permission_resolved":
        this.push("info", "permission", agentName, "Permission resolved");
        break;
      case "model_changed":
        this.push(
          "info",
          "system",
          agentName,
          `Model changed → ${event.runtimeInfo.model ?? "default"}`,
        );
        break;
      case "mode_changed":
        this.push(
          "info",
          "system",
          agentName,
          `Mode changed → ${event.currentModeId ?? "default"}`,
        );
        break;
      case "timeline":
        this.pushTimelineItem(agentName, event.item);
        break;
      default:
        break;
    }
  }

  private pushTimelineItem(source: string, item: AgentTimelineItem): void {
    switch (item.type) {
      case "tool_call":
        if (item.status === "completed") {
          this.push("debug", "tool_use", source, `Tool: ${item.name}`);
        } else if (item.status === "failed") {
          this.push("warn", "tool_use", source, `Tool failed: ${item.name}`);
        }
        break;
      case "error":
        this.push("error", "agent", source, item.message);
        break;
      default:
        break;
    }
  }

  private resolveAgentName(agentId: string): string {
    const agent = workspaceState.agents.find((a) => a.agentId === agentId);
    if (!agent) return agentId.slice(0, 8);
    return agent.provider;
  }

  clear(): void {
    this.entries = [];
  }
}

// ─── Activity state (user-facing notification inbox) ─────────────

export type ActivityEventType =
  | "mention"
  | "dm_received"
  | "task_assigned"
  // A task the human is assigned to moved to a new status/state. Emitted by the
  // relay task handlers via taskActivityEvents; task_review_requested has no
  // emitter yet (kept for the render label).
  | "task_status_changed"
  | "task_review_requested"
  | "thread_reply"
  | "reaction"
  | "permission_request"
  // #705: a non-owner asked a daemon owner for access → the owner sees an
  // approvable inbox row (mirrors permission_request, with Approve/Deny actions).
  | "daemon_access_request"
  | "agent_error";

export interface ActivityItem {
  id: string;
  // Stable source id (e.g. the originating message id) for items that can be
  // rebuilt from history, so reload/reconnect dedupes and read-state persists.
  sourceId?: string;
  eventType: ActivityEventType;
  actorName: string;
  actorId: string | null;
  actorType: "human" | "agent" | "system";
  preview: string;
  channelId: string | null;
  channelName: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface MentionInput {
  sourceId: string;
  actorName: string;
  actorId: string | null;
  actorType: "human" | "agent" | "system";
  preview: string;
  channelId: string | null;
  channelName: string | null;
  createdAt: string;
}

// One server-side activity_events row (the relay's cyborg:fetch_activity items),
// snake-cased as it comes off the wire. Used to seed the feed authoritatively.
export interface ServerActivityItem {
  id: string;
  event_type: string;
  // 'message' | 'task' | 'daemon' (free text). Task rows carry no channel/dm
  // scope, so source_type is what keys them as `task:<sourceId>` (read-on-open).
  // Optional: older/seed rows that predate the field default to a message item.
  source_type?: string | null;
  source_id: string | null;
  channel_id: string | null;
  dm_peer_id?: string | null;
  preview_text: string | null;
  actor_id: string | null;
  actor_name: string | null;
  is_read: number | boolean;
  created_at: number;
}

let activitySeq = 0;

const ACTIVITY_READ_BASE = "cyborg7_activity_read";

export class ActivityState {
  items: ActivityItem[] = $state([]);
  maxItems = 200;
  private readIds: Set<string> = new Set();
  private _boundUserId: string | null = null;
  // P2 Item 9 (server-authoritative badge): the relay returns an authoritative
  // unread total alongside the activity items (it counts ALL unread
  // activity_events, not just the page we fetched). The rail badge reads this so
  // it never under-counts when there are more unread events than fetched items.
  // Null = not seeded yet → fall back to counting unread items locally. Kept in
  // lockstep with the local read/add paths (markRead etc. decrement; a fresh
  // live mention increments).
  private _serverUnread: number | null = $state(null);

  private get readKey(): string {
    return this._boundUserId ? `${ACTIVITY_READ_BASE}_${this._boundUserId}` : ACTIVITY_READ_BASE;
  }

  bindUser(userId: string): void {
    this._boundUserId = userId;
    this.readIds = new Set();
    try {
      const raw = localStorage.getItem(this.readKey);
      if (raw) this.readIds = new Set(JSON.parse(raw));
    } catch {
      // intentional: best-effort restore of read activity ids; falls back to empty.
    }
  }

  get unreadCount(): number {
    if (this._serverUnread !== null) return Math.max(0, this._serverUnread);
    return this.items.filter((i) => !i.isRead).length;
  }

  push(
    eventType: ActivityEventType,
    actorName: string,
    actorId: string | null,
    actorType: "human" | "agent" | "system",
    preview: string,
    channelId: string | null = null,
    channelName: string | null = null,
  ): void {
    const id = `activity-${++activitySeq}`;
    const item: ActivityItem = {
      id,
      // Stamp DM items with a stable per-peer key so the on-load server seed
      // (serverItemToActivity uses the same `dm:<peer>` key) can reconcile read-
      // state via seedReadFromServer after a reload. Other live pushes have no
      // stable source id.
      sourceId: eventType === "dm_received" && actorId ? `dm:${actorId}` : undefined,
      eventType,
      actorName,
      actorId,
      actorType,
      preview,
      channelId,
      channelName,
      isRead: this.readIds.has(id),
      createdAt: new Date().toISOString(),
    };
    if (this.items.length >= this.maxItems) {
      this.items = [...this.items.slice(-Math.floor(this.maxItems * 0.8)), item];
    } else {
      this.items = [...this.items, item];
    }
    // A live push (dm_received, agent permission/error) that lands unread bumps
    // the server-authoritative badge so the rail count stays in sync.
    if (!item.isRead && this._serverUnread !== null) this._serverUnread += 1;
  }

  // #705: add a daemon-access-request inbox row (owner view), keyed by the request
  // id so it dedupes against the server activity_new seed (same `activity:`/source
  // scheme — sourceId carries the request id the Approve/Deny actions resolve by).
  // Idempotent: a re-push for the same request id is ignored.
  pushDaemonAccessRequest(
    requestId: string,
    requesterName: string,
    requesterId: string | null,
    preview: string,
  ): void {
    const id = `daemon_access_request:${requestId}`;
    if (this.items.some((i) => i.id === id)) return;
    const item: ActivityItem = {
      id,
      sourceId: requestId,
      eventType: "daemon_access_request",
      actorName: requesterName,
      actorId: requesterId,
      actorType: "human",
      preview,
      channelId: null,
      channelName: null,
      isRead: this.readIds.has(id),
      createdAt: new Date().toISOString(),
    };
    this.items =
      this.items.length >= this.maxItems
        ? [...this.items.slice(-Math.floor(this.maxItems * 0.8)), item]
        : [...this.items, item];
    if (!item.isRead && this._serverUnread !== null) this._serverUnread += 1;
  }

  // Task notification (assignment / status change), keyed by `task:<taskId>` so it
  // dedupes against the on-load server seed (serverItemToActivity uses the same
  // id) and the read-on-open clear (markReadByTask). Idempotent: a re-push for the
  // same taskId is ignored. sourceId carries the taskId so handleClick deep-links.
  pushTask(
    taskId: string,
    eventType: "task_assigned" | "task_status_changed",
    actorName: string,
    actorId: string | null,
    preview: string,
  ): void {
    const id = `task:${taskId}`;
    if (this.items.some((i) => i.id === id)) return;
    const item: ActivityItem = {
      id,
      sourceId: taskId,
      eventType,
      actorName,
      actorId,
      actorType: "human",
      preview,
      channelId: null,
      channelName: null,
      isRead: this.readIds.has(id),
      createdAt: new Date().toISOString(),
    };
    this.items =
      this.items.length >= this.maxItems
        ? [...this.items.slice(-Math.floor(this.maxItems * 0.8)), item]
        : [...this.items, item];
    if (!item.isRead && this._serverUnread !== null) this._serverUnread += 1;
  }

  // Add (or backfill) an @mention keyed by its source message id. Idempotent —
  // safe to call from both the live broadcast and the on-load history backfill.
  addMention(opts: MentionInput): void {
    this.addMentions([opts]);
  }

  // Batch variant: one array copy + sort + reactivity update for the whole set
  // (the on-load backfill can add many at once). Dedupes against existing items
  // and within the batch.
  addMentions(optsList: MentionInput[]): void {
    const fresh: ActivityItem[] = [];
    const pending = new Set<string>();
    for (const opts of optsList) {
      const id = `mention:${opts.sourceId}`;
      if (pending.has(id) || this.items.some((i) => i.id === id)) continue;
      pending.add(id);
      fresh.push({
        id,
        sourceId: opts.sourceId,
        eventType: "mention",
        actorName: opts.actorName,
        actorId: opts.actorId,
        actorType: opts.actorType,
        preview: opts.preview,
        channelId: opts.channelId,
        channelName: opts.channelName,
        isRead: this.readIds.has(id),
        createdAt: opts.createdAt,
      });
    }
    if (fresh.length === 0) return;
    // ISO timestamps are lexicographically ordered; ActivityPane reverses for
    // newest-first display.
    const next = [...this.items, ...fresh].sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return 0;
    });
    this.items = next.length > this.maxItems ? next.slice(-this.maxItems) : next;
    // Keep the server-authoritative badge in lockstep: a freshly added (live)
    // mention that isn't already read bumps the count. Seeded items already
    // counted toward the baseline (seedFromServer sets it from the server total),
    // so this only fires for the live path, never for the on-load seed.
    if (this._serverUnread !== null) {
      const newUnread = fresh.filter((i) => !i.isRead).length;
      if (newUnread > 0) this._serverUnread += newUnread;
    }
  }

  // P2 Item 9 (server-authoritative): seed the Activity feed AND the rail-badge
  // unread baseline from the relay's cyborg:fetch_activity response — the real
  // activity_events, not a reconstruction from the last ~200 workspace messages.
  // The server `unread` is the authoritative total (counts every unread row, not
  // just this page), so the badge no longer under-counts on a fresh session.
  // Items are mapped to the same `mention:<sourceId>` id scheme as addMentions so
  // the live mention handler dedupes against them (no double-count). thread_reply
  // rows reuse the mention id scheme too (both keyed by the source message id).
  seedFromServer(serverItems: ServerActivityItem[], unread: number): void {
    const channelNames = new Map(workspaceState.channels.map((c) => [c.id, c.name]));
    const fresh: ActivityItem[] = [];
    const pending = new Set<string>();
    for (const s of serverItems) {
      const item = this.serverItemToActivity(s, channelNames);
      // Dedupe within the batch only — we REPLACE the feed below, so a stale
      // entry from a previously-selected workspace must not suppress it.
      if (pending.has(item.id)) continue;
      pending.add(item.id);
      fresh.push(item);
    }
    // REPLACE, don't append: the server query is `WHERE workspace_id = ?`, so this
    // set is the authoritative feed for the CURRENT workspace. Appending (the old
    // behavior) accumulated the previous workspace's items on every switch — the
    // "Activity shows items from another workspace" bug. Replacing scopes the feed
    // to the current workspace and clears it atomically (no flicker, read-state in
    // `readIds` is untouched so per-item read status persists).
    const next = fresh.sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return 0;
    });
    this.items = next.length > this.maxItems ? next.slice(-this.maxItems) : next;
    // Authoritative baseline from the server (NOT a count of seeded items, which
    // is capped by the fetch limit). The rail badge reads unreadCount → this.
    this._serverUnread = Math.max(0, unread);
  }

  // Map one server activity_events row to a client ActivityItem. mention /
  // Stable activity-row id by event type. Extracted from serverItemToActivity to
  // keep it under the cyclomatic-complexity cap (the daemon_access_request branch
  // pushed it to 21): mention/thread_reply dedupe by source id, daemon_access_request
  // (#705) by request id so the live push dedupes against the seed, else the row id.
  private activityRowId(s: ServerActivityItem, sourceId: string | null): string {
    if (sourceId && (s.event_type === "mention" || s.event_type === "thread_reply")) {
      return `mention:${sourceId}`;
    }
    if (sourceId && s.event_type === "daemon_access_request") {
      return `daemon_access_request:${sourceId}`;
    }
    // Task rows key by task:<taskId> (sourceType="task", sourceId=taskId) so the
    // live activity_new push (pushTask) and the read-on-open clear dedupe against
    // the seed by the same id, and one task never produces two feed rows.
    if (sourceId && s.source_type === "task") {
      return `task:${sourceId}`;
    }
    return `activity:${s.id}`;
  }

  // thread_reply rows reuse the `mention:<sourceId>` id scheme (keyed by the
  // source message id) so the live mention handler dedupes against the seed;
  // other event types fall back to the row id.
  private serverItemToActivity(
    s: ServerActivityItem,
    channelNames: Map<string, string>,
  ): ActivityItem {
    const dmPeer = s.dm_peer_id ?? null;
    // DM rows reconcile by peer: stamp the same `dm:<peer>` key that push() uses
    // so seedReadFromServer clears all of a peer's items on reload. Non-DM rows
    // keep the message source id. (Inert if the relay seed never returns
    // dm_peer_id for dm_received rows — harmless; the live fix in handleClick
    // does not depend on it.)
    const sourceId =
      s.event_type === "dm_received" && dmPeer ? `dm:${dmPeer}` : (s.source_id ?? null);
    const id = this.activityRowId(s, sourceId);
    const isRead = s.is_read === 1 || s.is_read === true || this.readIds.has(id);
    return {
      id,
      sourceId: sourceId ?? undefined,
      eventType: this.normalizeEventType(s.event_type),
      // Resolve a human name: server-provided name first, then the member map
      // (repairs older rows persisted before the server populated actor_name),
      // never the raw actor_id UUID.
      actorName:
        s.actor_name ?? (s.actor_id ? authState.getMemberName(s.actor_id) : null) ?? "Someone",
      // DM rows carry no channel; the peer (actor) drives markReadByDmPeer.
      actorId: s.actor_id ?? s.dm_peer_id ?? null,
      // The server row doesn't store actor type; default to human (agents
      // surface their own activity types). Avatars degrade to initials.
      actorType: "human",
      preview: s.preview_text ?? "",
      channelId: s.channel_id ?? null,
      channelName: s.channel_id ? (channelNames.get(s.channel_id) ?? null) : null,
      isRead,
      createdAt: new Date(s.created_at).toISOString(),
    };
  }

  // Map a server event_type string onto the client union, defaulting unknown
  // values to "mention" so a new server type never breaks the feed render.
  private normalizeEventType(t: string): ActivityEventType {
    switch (t) {
      case "mention":
      case "dm_received":
      case "task_assigned":
      case "task_status_changed":
      case "task_review_requested":
      case "thread_reply":
      case "reaction":
      case "permission_request":
      case "daemon_access_request":
      case "agent_error":
        return t;
      default:
        return "mention";
    }
  }

  markRead(id: string): void {
    const wasUnread = this.items.some((i) => i.id === id && !i.isRead);
    this.items = this.items.map((i) => (i.id === id ? { ...i, isRead: true } : i));
    this.readIds.add(id);
    if (wasUnread && this._serverUnread !== null) {
      this._serverUnread = Math.max(0, this._serverUnread - 1);
    }
    this.persistRead();
  }

  markAllRead(): void {
    this.items = this.items.map((i) => ({ ...i, isRead: true }));
    for (const item of this.items) this.readIds.add(item.id);
    // Mark-all clears the whole inbox — the authoritative count goes to zero.
    if (this._serverUnread !== null) this._serverUnread = 0;
    this.persistRead();
  }

  // P2 Item 9: reading a channel clears its activity items (mentions / thread-
  // replies). Reconciles the local feed when the server broadcasts that a read
  // also cleared activity (cross-device), and on the local read path.
  markReadByChannel(channelId: string): void {
    let cleared = 0;
    const next = this.items.map((i) => {
      if (i.channelId === channelId && !i.isRead) {
        cleared++;
        this.readIds.add(i.id);
        return { ...i, isRead: true };
      }
      return i;
    });
    // Only reassign the $state array when something actually changed. An
    // unconditional `this.items = this.items.map(...)` mints a NEW array
    // reference on every call — and because this runs synchronously inside
    // selectChannel (itself inside the channel page's $effect), that read +
    // write of `items` retriggered the effect forever
    // (effect_update_depth_exceeded → messages never rendered).
    if (cleared > 0) {
      this.items = next;
      if (this._serverUnread !== null) {
        this._serverUnread = Math.max(0, this._serverUnread - cleared);
      }
      this.persistRead();
    }
  }

  // DM counterpart: DM activity items carry no channelId, so match on the peer
  // (the item's actor — the other party in the DM).
  markReadByDmPeer(peerId: string): void {
    let cleared = 0;
    const next = this.items.map((i) => {
      if (i.channelId === null && i.actorId === peerId && !i.isRead) {
        cleared++;
        this.readIds.add(i.id);
        return { ...i, isRead: true };
      }
      return i;
    });
    // Guard the reassignment (same effect-loop hazard as markReadByChannel).
    if (cleared > 0) {
      this.items = next;
      if (this._serverUnread !== null) {
        this._serverUnread = Math.max(0, this._serverUnread - cleared);
      }
      this.persistRead();
    }
  }

  // Task counterpart: a task's activity rows (task_assigned / task_status_changed)
  // are keyed by `task:<taskId>` (their sourceId is the taskId). Opening the task
  // detail clears them — match by sourceId so every row for that task clears at
  // once, mirroring markReadByChannel/markReadByDmPeer (guarded reassignment to
  // avoid the effect-loop hazard; idempotent for the duplicate-clear path).
  markReadByTask(taskId: string): void {
    let cleared = 0;
    const next = this.items.map((i) => {
      if (i.sourceId === taskId && i.id.startsWith("task:") && !i.isRead) {
        cleared++;
        this.readIds.add(i.id);
        return { ...i, isRead: true };
      }
      return i;
    });
    if (cleared > 0) {
      this.items = next;
      if (this._serverUnread !== null) {
        this._serverUnread = Math.max(0, this._serverUnread - cleared);
      }
      this.persistRead();
    }
  }

  // P2 Item 9: hydrate read-state from the server's activity_events on load, so a
  // conversation read on another device is reflected here (not just the local
  // localStorage readIds). Server items are keyed by their source message id;
  // mention items here use `mention:<sourceId>`, so reconcile on sourceId.
  seedReadFromServer(serverItems: Array<{ sourceId: string | null; isRead: boolean }>): void {
    const readSources = new Set<string>();
    for (const s of serverItems) {
      if (s.isRead && s.sourceId) readSources.add(s.sourceId);
    }
    if (readSources.size === 0) return;
    let cleared = 0;
    const next = this.items.map((i) => {
      if (!i.isRead && i.sourceId && readSources.has(i.sourceId)) {
        cleared++;
        this.readIds.add(i.id);
        return { ...i, isRead: true };
      }
      return i;
    });
    // Guard the reassignment (same effect-loop hazard as markReadByChannel).
    if (cleared > 0) {
      this.items = next;
      if (this._serverUnread !== null) {
        this._serverUnread = Math.max(0, this._serverUnread - cleared);
      }
      this.persistRead();
    }
  }

  clear(): void {
    this.items = [];
    this._serverUnread = null;
  }

  clearLocal(): void {
    this._boundUserId = null;
    this.items = [];
    this.readIds = new Set();
    this._serverUnread = null;
  }

  private persistRead(): void {
    try {
      const ids = [...this.readIds].slice(-500);
      localStorage.setItem(this.readKey, JSON.stringify(ids));
    } catch {
      // intentional: best-effort persistence of read activity ids; not user-facing.
    }
  }
}

// ─── Session state ───────────────────────────────────────────────

export interface RecentSession {
  providerId: string;
  providerLabel: string;
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: string;
}

export interface ArchivedSession {
  id: string;
  provider: string;
  providerHandleId: string;
  title: string | null;
  cwd: string | null;
  model: string | null;
  cyboId: string | null;
  cyboName: string | null;
  cyboAvatar: string | null;
  archivedAt: number;
  // Owning daemon, stamped by the relay's archived-session fan-out aggregator
  // (#593). Sent back on restore so the relay scopes + routes the restore to the
  // daemon that holds it. Absent in solo/single-daemon flows.
  daemonId?: string | null;
}

// Optional config overrides applied when RESUMING an archived session (#593).
// All optional — omitting them resumes on the archived model/mode/thinking.
export interface ResumeOverrides {
  model?: string;
  modeId?: string;
  thinkingOptionId?: string | null;
}

// Page size for the archived-sessions list. Keeps the panes from rendering an
// unbounded archive; older pages load on demand via "Show more" (server-side
// keyset pagination, not a client DOM slice).
export const ARCHIVED_SESSIONS_PAGE_SIZE = 30;

export class SessionState {
  list: ArchivedSession[] = $state([]);
  loading = $state(false);
  fetched = $state(false);
  // Keyset pagination: opaque cursor for the NEXT (older) page, or null when the
  // loaded list is the tail. Drives the "Show more" affordance so the panes never
  // render the full unbounded archive at once.
  nextCursor = $state<string | null>(null);
  loadingMore = $state(false);
}

// ─── Daemon access requests (#705 REQUEST → NOTIFY → APPROVE) ──────
//
// Client mirror of the wire row (DaemonAccessRequestView in core/client.ts —
// Dates already serialized to epoch-ms). Defined locally so this module stays
// decoupled from the transport layer; the shape is kept in lockstep.
export interface DaemonAccessRequest {
  id: string;
  workspaceId: string;
  daemonId: string;
  requesterId: string;
  requesterName: string | null;
  scopes: Array<"chat" | "spawn" | "terminal" | "admin">;
  status: "pending" | "approved" | "denied";
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
}

// The owner inbox (pending requests for daemons I own) + my own outbox (requests
// I sent). Seeded on workspace open via client.fetchDaemonAccessRequests and kept
// live via the daemon_access_request_changed push (upsert created/resolved). The
// REQUEST affordance reads `hasPendingOutgoing` to disable a re-request; the owner
// surfaces read `pendingForDaemon` / `byId`.
export class DaemonAccessRequestsState {
  // All requests the server returns for the caller (owner inbox + own outbox),
  // keyed by id so the live push upserts in place.
  requests: DaemonAccessRequest[] = $state([]);

  load(requests: DaemonAccessRequest[]): void {
    this.requests = requests;
  }

  // Upsert one row (live push). Replaces an existing row with the same id,
  // appends otherwise — so a resolve (pending → approved/denied) updates in place.
  upsert(request: DaemonAccessRequest): void {
    const idx = this.requests.findIndex((r) => r.id === request.id);
    if (idx === -1) {
      this.requests = [...this.requests, request];
    } else {
      const next = this.requests.slice();
      next[idx] = request;
      this.requests = next;
    }
  }

  byId(id: string): DaemonAccessRequest | undefined {
    return this.requests.find((r) => r.id === id);
  }

  // Pending requests for one daemon (owner view, surfaced atop its Access section).
  pendingForDaemon(daemonId: string): DaemonAccessRequest[] {
    return this.requests.filter((r) => r.daemonId === daemonId && r.status === "pending");
  }

  // Pending requests awaiting THIS owner's action: the server returns the caller's
  // owner-inbox + own-outbox, so a pending request whose requester is NOT me is an
  // INCOMING request on a daemon I own. Drives the mobile owner notification (the
  // Projects banner count + the Daemons-page approve/deny inbox) so the owner sees
  // requests without an Activity tab. #705.
  pendingIncoming(ownerUserId: string | undefined): DaemonAccessRequest[] {
    if (!ownerUserId) return [];
    return this.requests.filter((r) => r.status === "pending" && r.requesterId !== ownerUserId);
  }

  // Does the given user already have a PENDING outgoing request for this daemon?
  // Drives the disabled "Requested" state on the request affordance.
  hasPendingOutgoing(daemonId: string, userId: string | undefined): boolean {
    if (!userId) return false;
    return this.requests.some(
      (r) => r.daemonId === daemonId && r.requesterId === userId && r.status === "pending",
    );
  }

  clear(): void {
    this.requests = [];
  }
}

// ─── Singleton instances ──────────────────────────────────────────

export const agentStreamState = new AgentStreamState();
export const attentionState = new AttentionState();
export const providerState = new ProviderState();
export const cyboState = new CyboState();
export const daemonState = new DaemonState();
export const logState = new LogState();
export const activityState = new ActivityState();
export const sessionState = new SessionState();
export const daemonAccessRequestsState = new DaemonAccessRequestsState();

// ─── Agent-specific actions ───────────────────────────────────────

export async function sendAgentPrompt(
  client: {
    sendAgentPrompt(workspaceId: string, agentId: string, prompt: string): Promise<void>;
  },
  agentId: string,
  prompt: string,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  agentStreamState.addUserMessage(agentId, prompt);
  try {
    await client.sendAgentPrompt(workspaceState.current.id, agentId, prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send";
    agentStreamState.handleEvent(agentId, {
      type: "turn_failed",
      provider: "unknown",
      error: msg,
    } as AgentEvent);
    throw err;
  }
}

export function respondToPermission(
  client: {
    respondToPermission(
      workspaceId: string,
      agentId: string,
      permissionRequestId: string,
      response: AgentPermissionResponse,
    ): void;
  },
  agentId: string,
  permissionRequestId: string,
  response: AgentPermissionResponse,
): void {
  if (!workspaceState.current) return;
  client.respondToPermission(workspaceState.current.id, agentId, permissionRequestId, response);
}

export function cancelAgent(
  client: { cancelAgent(workspaceId: string, agentId: string): void },
  agentId: string,
): void {
  if (!workspaceState.current) return;
  client.cancelAgent(workspaceState.current.id, agentId);
}

export async function setAgentModel(
  client: {
    setAgentModel(workspaceId: string, agentId: string, modelId: string | null): Promise<void>;
  },
  agentId: string,
  modelId: string | null,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.setAgentModel(workspaceState.current.id, agentId, modelId);
}

export async function setAgentMode(
  client: {
    setAgentMode(workspaceId: string, agentId: string, modeId: string): Promise<void>;
  },
  agentId: string,
  modeId: string,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.setAgentMode(workspaceState.current.id, agentId, modeId);
}

export async function setAgentThinking(
  client: {
    setAgentThinking(
      workspaceId: string,
      agentId: string,
      thinkingOptionId: string | null,
    ): Promise<void>;
  },
  agentId: string,
  thinkingOptionId: string | null,
): Promise<void> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  await client.setAgentThinking(workspaceState.current.id, agentId, thinkingOptionId);
}

interface TimelineFetchClient {
  fetchAgentTimeline(
    workspaceId: string,
    agentId: string,
    opts?: { cursor?: string; limit?: number; direction?: "older" | "newer" },
  ): Promise<{
    items: Record<string, unknown>[];
    nextCursor: string | null;
    hasMore: boolean;
    olderCursor: string | null;
    hasOlder: boolean;
  }>;
}

export async function fetchAgentTimeline(
  client: TimelineFetchClient,
  agentId: string,
): Promise<void> {
  if (!workspaceState.current) return;
  // Guard on HYDRATION, not entry count. A live event can create the stream (and
  // its first entries) before this mount-time fetch runs; guarding on
  // entries.length then skipped the history fetch entirely, so a workspace
  // round-trip showed only the live chunk and lost the history. hydrateFromTimeline
  // rebuilds from server truth and the live stream appends after (same as the
  // reconnect catch-up). Once hydrated we skip, so a healthy live stream is never
  // re-wiped on a plain remount.
  if (agentStreamState.isHydrated(agentId)) return;
  const wsId = workspaceState.current.id;
  try {
    const { items, hasOlder, olderCursor } = await client.fetchAgentTimeline(wsId, agentId);
    // Bail if the user switched workspace mid-fetch, or another call already
    // hydrated this stream — don't double-hydrate / hydrate into a stale context.
    if (workspaceState.current?.id !== wsId || agentStreamState.isHydrated(agentId)) return;
    agentStreamState.hydrateFromTimeline(agentId, items, { hasOlder, olderCursor });
  } catch (err) {
    // History hydration failed → the conversation renders blank (only the live
    // chunk, if any). Surface it instead of showing an empty stream silently.
    reportClientError({
      source: "agents.fetchAgentTimeline",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      platform: "web",
    });
    toast.error("Couldn't load conversation history");
  }
}

// Scroll-up lazy-load: fetch the page of history OLDER than what's currently loaded
// and prepend it (the daemon pages backward from `olderCursor`). Re-entry-guarded;
// a no-op when nothing older remains.
export async function loadOlderAgentTimeline(
  client: TimelineFetchClient,
  agentId: string,
): Promise<void> {
  if (!workspaceState.current) return;
  if (!agentStreamState.hasOlder(agentId) || agentStreamState.isLoadingOlder(agentId)) return;
  const cursor = agentStreamState.olderCursor(agentId);
  if (!cursor) return;
  const wsId = workspaceState.current.id;
  agentStreamState.setLoadingOlder(agentId, true);
  try {
    const { items, hasOlder, olderCursor } = await client.fetchAgentTimeline(wsId, agentId, {
      cursor,
      direction: "older",
    });
    if (workspaceState.current?.id !== wsId) return;
    agentStreamState.prependTimeline(agentId, items, { hasOlder, olderCursor });
  } catch (err) {
    reportClientError({
      source: "agents.loadOlderAgentTimeline",
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      platform: "web",
    });
    toast.error("Couldn't load older history");
  } finally {
    agentStreamState.setLoadingOlder(agentId, false);
  }
}

export async function fetchAgentCommands(
  client: {
    listAgentCommands(workspaceId: string, agentId: string): Promise<AgentSlashCommand[]>;
  },
  agentId: string,
): Promise<AgentSlashCommand[]> {
  if (!workspaceState.current) throw new Error("No workspace selected");
  return client.listAgentCommands(workspaceState.current.id, agentId);
}

export async function fetchSessions(client: {
  listArchivedSessions(
    workspaceId: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<{ sessions: ArchivedSession[]; nextCursor: string | null }>;
}): Promise<void> {
  if (!workspaceState.current) return;
  const wsId = workspaceState.current.id;
  sessionState.loading = true;
  // Reset paging state for the new fetch so a stale "load more" in flight can't
  // leave the affordance stuck.
  sessionState.loadingMore = false;
  try {
    const page = await client.listArchivedSessions(wsId, {
      limit: ARCHIVED_SESSIONS_PAGE_SIZE,
    });
    // Workspace-switch race: a switch mid-fetch must not overwrite the new
    // workspace's list with this (now stale) response.
    if (workspaceState.current?.id !== wsId) return;
    sessionState.list = page.sessions;
    sessionState.nextCursor = page.nextCursor;
    sessionState.fetched = true;
  } catch {
    if (workspaceState.current?.id !== wsId) return;
    sessionState.list = [];
    sessionState.nextCursor = null;
    sessionState.fetched = true;
  } finally {
    sessionState.loading = false;
  }
}

// Pure, DOM-free, dependency-free curator that turns an agent's raw stream
// timeline into a single glanceable "last activity" line (#594).
//
// Ported from Paseo's `packages/server/src/server/agent/activity-curator.ts`
// (`curateAgentActivityEntries`), adapted to operate on OUR `StreamEntry[]`
// (plugins/agents/state.svelte.ts) instead of Paseo's `AgentTimelineItem[]`.
// We must NOT import Paseo's `agent/` code (fork boundary), so the coalescing,
// tool-call display, and external-tool detection logic are ported inline here.
//
// What it reproduces from Paseo:
//   - coalesce contiguous assistant text → one `[Assistant] …` line
//   - coalesce contiguous reasoning → one `[Thought] …` line
//   - dedup a tool call by status: our state already merges running→done by
//     callId in place, so the latest status is what we render (one line)
//   - collapse external-tool (namespaced/MCP) inputs to the raw JSON input
//   - `[Error] …` labeling, `[Tasks]` for todos, `[Compacted]` for compaction
//   - truncation limits: tool input ≤ 400 chars, tool summary ≤ 200 chars
//   - `maxItems` cap (tail window) over the curated entries
//
// Unlike Paseo, our `StreamEntry[]` is ALREADY projected (text/reasoning merged
// token-by-token by `mergeText`, tool calls deduped by callId with the latest
// status). We still coalesce defensively so the algorithm is faithful and robust
// to any non-merged input, and so it stays unit-testable in isolation.

import type { StreamEntry } from "./state.svelte.js";
import type { ToolCallDetail } from "./types.js";

export const MAX_TOOL_INPUT_CHARS = 400;
export const MAX_TOOL_SUMMARY_CHARS = 200;
const DEFAULT_MAX_ITEMS = 0;

export type CuratedActivityLabel =
  | "Assistant"
  | "Thought"
  | "User"
  | "Error"
  | "Tasks"
  | "Compacted"
  | "Tool";

export interface CuratedActivity {
  /** Semantic label (`Assistant`, `Thought`, `Error`, or the tool display name). */
  label: string;
  /** The human-readable summary text (already truncated). */
  text: string;
  /** Bracketed one-liner exactly as Paseo emits it, e.g. `[bash] running tests`. */
  line: string;
  /** Coarse kind so the renderer can pick an icon/tone without parsing the label. */
  kind: CuratedActivityLabel;
}

export interface CurateActivityOptions {
  /**
   * Tail cap over curated entries (mirrors Paseo's `maxItems`). `0`/omitted =
   * keep all. We only ever surface the last entry, but the cap is honored so the
   * dedup/window semantics match Paseo and the tests are falsifiable.
   */
  maxItems?: number;
  /** Label assistant messages with `[Assistant]` (Paseo default for curation). */
  labelAssistantMessages?: boolean;
}

interface CuratedEntry {
  text: string;
  kind: CuratedActivityLabel;
  label: string;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function appendText(buffer: string, text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return buffer;
  }
  if (!buffer) {
    return normalized;
  }
  return `${buffer}\n${normalized}`;
}

function curatedEntry(text: string, kind: CuratedActivityLabel, label: string): CuratedEntry {
  return { text, kind, label };
}

function flushBuffers(
  entries: CuratedEntry[],
  buffers: { message: string; thought: string },
  options: CurateActivityOptions | undefined,
): void {
  if (buffers.message.trim()) {
    const text = buffers.message.trim();
    entries.push(
      curatedEntry(
        options?.labelAssistantMessages === false ? text : `[Assistant] ${text}`,
        "Assistant",
        "Assistant",
      ),
    );
  }
  if (buffers.thought.trim()) {
    const text = buffers.thought.trim();
    entries.push(curatedEntry(`[Thought] ${text}`, "Thought", "Thought"));
  }
  buffers.message = "";
  buffers.thought = "";
}

function formatToolInputJson(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  try {
    const encoded = JSON.stringify(input);
    if (!encoded) {
      return null;
    }
    if (encoded.length <= MAX_TOOL_INPUT_CHARS) {
      return encoded;
    }
    return `${encoded.slice(0, MAX_TOOL_INPUT_CHARS)}...`;
  } catch {
    return null;
  }
}

function formatToolSummary(summary: string | undefined): string | null {
  if (typeof summary !== "string") {
    return null;
  }
  const normalized = normalizeWhitespace(summary);
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_TOOL_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_SUMMARY_CHARS - 3)}...`;
}

// ─── Tool name / display (ported from @cyborg7/protocol so this stays
// dependency-free and keyed to OUR ToolCallDetail union). ──────────────────

const TOOL_TOKEN_REGEX = /[a-z0-9]+/g;
const NAMESPACE_SEPARATOR_REGEX = /[.:/]/;

function tokenizeToolName(name: string): string[] {
  return name.trim().toLowerCase().match(TOOL_TOKEN_REGEX) ?? [];
}

function getToolLeafName(name: string): string | null {
  const tokens = tokenizeToolName(name);
  return tokens.length > 0 ? tokens[tokens.length - 1] : null;
}

function isLikelyNamespacedToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (NAMESPACE_SEPARATOR_REGEX.test(normalized)) {
    return true;
  }
  if (!normalized.includes("__")) {
    return false;
  }
  const segments = normalized.split("__").filter((segment) => segment.length > 0);
  if (segments.length >= 3) {
    return true;
  }
  return segments.length === 2 && segments[1].includes("_");
}

/** External = MCP/namespaced tool whose raw input is more useful than a summary. */
function isLikelyExternalToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (getToolLeafName(normalized) === "speak") {
    return true;
  }
  return isLikelyNamespacedToolName(normalized);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return name;
  }
  if (/[:./]/.test(trimmed) || trimmed.includes("__")) {
    return trimmed;
  }
  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

function lastPathSegment(filePath: string): string {
  // Split on both POSIX (`/`) and Windows (`\`) separators so a daemon running
  // on Windows surfaces the basename, not the full `C:\…\foo.ts` path.
  const cleaned = filePath.replace(/[/\\]+$/, "");
  const segment = cleaned.split(/[/\\]/).pop();
  return segment && segment.length > 0 ? segment : filePath;
}

interface ToolDisplay {
  displayName: string;
  summary?: string;
}

/** Derive a display name + summary from OUR ToolCallDetail (ports the protocol's
 * `buildToolCallDisplayModel` for the detail shapes our timeline carries). */
function buildToolDisplay(name: string, detail: ToolCallDetail): ToolDisplay {
  switch (detail.type) {
    case "shell":
      return { displayName: "Shell", summary: detail.command };
    case "read":
      return { displayName: "Read", summary: lastPathSegment(detail.filePath) };
    case "edit":
      return { displayName: "Edit", summary: lastPathSegment(detail.filePath) };
    case "write":
      return { displayName: "Write", summary: lastPathSegment(detail.filePath) };
    case "search":
      return { displayName: "Search", summary: detail.query };
    case "fetch":
      return { displayName: "Fetch", summary: detail.url };
    case "worktree_setup":
      return { displayName: "Worktree Setup", summary: detail.branchName };
    case "sub_agent":
      return {
        displayName: readString(detail.subAgentType) ?? "Task",
        summary: readString(detail.description),
      };
    case "plain_text":
      return { displayName: humanizeToolName(name), summary: detail.label };
    case "plan":
      return { displayName: "Plan" };
    case "unknown": {
      const lower = name.trim().toLowerCase();
      if (lower === "task") {
        return { displayName: "Task" };
      }
      if (lower === "thinking") {
        return { displayName: "Thinking" };
      }
      return { displayName: humanizeToolName(name) };
    }
    default:
      return { displayName: humanizeToolName(name) };
  }
}

function inputFromUnknownDetail(detail: ToolCallDetail): unknown {
  // Return `undefined` (not `null`) for typed details so `formatToolInputJson`
  // treats the input as absent and returns null. Returning `null` would
  // `JSON.stringify` to the truthy string "null", making the external-tool
  // branch render `[Name] null` for a namespaced/MCP tool that carries a typed
  // detail (e.g. read/shell), instead of falling back to the tool summary.
  return detail.type === "unknown" ? detail.input : undefined;
}

const UNKNOWN_DETAIL: ToolCallDetail = { type: "unknown", input: undefined, output: undefined };

/** Curate a tool-call entry into one labeled line (external→raw input, else summary). */
function curateToolCall(name: string, detail: ToolCallDetail): CuratedEntry {
  const display = buildToolDisplay(name, detail);
  const displayName = display.displayName;
  const inputJson = formatToolInputJson(inputFromUnknownDetail(detail));
  if (isLikelyExternalToolName(name) && inputJson) {
    return curatedEntry(`[${displayName}] ${inputJson}`, "Tool", displayName);
  }
  const summary = formatToolSummary(display.summary);
  if (summary) {
    return curatedEntry(`[${displayName}] ${summary}`, "Tool", displayName);
  }
  return curatedEntry(`[${displayName}]`, "Tool", displayName);
}

/** Glanceable one-liner for a todo list: the active task + progress, else done/total. */
function curateTodo(items: readonly { text: string; completed: boolean }[]): CuratedEntry {
  const total = items.length;
  const done = items.filter((t) => t.completed).length;
  // The active task (first incomplete) is a far more glanceable summary than
  // Paseo's full checklist dump for a one-liner.
  const active = items.find((t) => !t.completed);
  let summary = "";
  if (active) {
    summary = `${active.text} (${done}/${total})`;
  } else if (total > 0) {
    summary = `${done}/${total} done`;
  }
  return curatedEntry(summary ? `[Tasks] ${summary}` : "[Tasks]", "Tasks", "Tasks");
}

/**
 * Walk the raw stream timeline and produce the curated, labeled one-liners in
 * order — faithful port of Paseo's `curateAgentActivityEntries`.
 */
function curateAgentActivityEntries(
  entries: readonly StreamEntry[],
  options?: CurateActivityOptions,
): CuratedEntry[] {
  if (entries.length === 0) {
    return [];
  }

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const windowed = maxItems > 0 && entries.length > maxItems ? entries.slice(-maxItems) : entries;

  const out: CuratedEntry[] = [];
  const buffers = { message: "", thought: "" };

  for (const entry of windowed) {
    switch (entry.kind) {
      case "turn_boundary":
        // Not a user-visible activity; flush any pending text so the next turn's
        // first item is what surfaces, but emit nothing for the boundary itself.
        flushBuffers(out, buffers, options);
        break;
      case "user_message":
        flushBuffers(out, buffers, options);
        out.push(curatedEntry(`[User] ${entry.content.trim()}`, "User", "User"));
        break;
      case "text":
        buffers.message = appendText(buffers.message, entry.content);
        break;
      case "thinking":
        buffers.thought = appendText(buffers.thought, entry.content);
        break;
      case "tool_call": {
        flushBuffers(out, buffers, options);
        out.push(curateToolCall(entry.name, entry.detail ?? UNKNOWN_DETAIL));
        break;
      }
      case "todo": {
        flushBuffers(out, buffers, options);
        out.push(curateTodo(entry.items));
        break;
      }
      case "error":
        flushBuffers(out, buffers, options);
        out.push(curatedEntry(`[Error] ${entry.content.trim()}`, "Error", "Error"));
        break;
      case "compaction":
        flushBuffers(out, buffers, options);
        out.push(curatedEntry("[Compacted]", "Compacted", "Compacted"));
        break;
    }
  }

  flushBuffers(out, buffers, options);

  return out;
}

function toCurated(entry: CuratedEntry): CuratedActivity {
  // `entry.text` is the full bracketed line; split the label off for the
  // structured `{ label, text }` consumers can render separately.
  const match = /^\[([^\]]+)\]\s?([\s\S]*)$/.exec(entry.text);
  const text = match ? match[2].trim() : entry.text.trim();
  return {
    label: entry.label,
    text,
    line: entry.text,
    kind: entry.kind,
  };
}

/**
 * Curate the whole timeline into ordered labeled lines. Exposed for tests and
 * any future "recent activity" surface; the row only needs {@link curateLastActivity}.
 */
export function curateAgentActivity(
  entries: readonly StreamEntry[],
  options?: CurateActivityOptions,
): CuratedActivity[] {
  return curateAgentActivityEntries(entries, options).map(toCurated);
}

/**
 * The single glanceable "what is this agent doing right now" line — the LAST
 * curated entry, or `null` for an empty/no-activity timeline. This is what the
 * agents list / sidebar row renders (#594).
 */
export function curateLastActivity(
  entries: readonly StreamEntry[],
  options?: CurateActivityOptions,
): CuratedActivity | null {
  const curated = curateAgentActivityEntries(entries, options);
  const last = curated[curated.length - 1];
  return last ? toCurated(last) : null;
}

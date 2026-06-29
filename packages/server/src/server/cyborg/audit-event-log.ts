// Audit-trace observability — the structured, human-readable events the Logs tab
// shows so an owner can answer the two questions the pane should answer:
//   (a) what CONTEXT (system/platform prompt + tools) did this cybo session get?
//   (b) what OPERATIONS did the daemon perform (spawns, teardowns, reaper kills,
//       credential changes, gate decisions)?
//
// Today almost all of that lives only in `$PASEO_HOME/daemon.log` (pino) and is
// invisible in the UI. This module is the sibling of `task-event-log.ts`: a
// discriminated `AuditEvent` shape + a PURE formatter that maps each event to the
// wire line the Logs pane renders, plus the `cyborg:audit_event` envelope fanned
// out through the SAME two seams task events already use (daemon
// `broadcast.toWorkspace`, relay `broadcastToGuests`).
//
// PURE (no I/O, no clock): the timestamp is assigned downstream at `logState.push`
// (identical to task events), so the formatter is unit-testable in isolation and
// identical on the daemon and relay transports.
//
// SECRETS NEVER REACH THE WIRE: every payload is run through `redactPayload`
// before it becomes a line — api keys, Composio `ck_` consumer keys, scoped MCP
// tokens, bearer tokens, and the query string of any MCP URL are stripped. The
// payload is also size-capped. The redaction allow-list lives here and is
// unit-tested.

// Level mirrors the UI's LogLevel so the Logs pane's level filter just works.
export type AuditLevel = "debug" | "info" | "warn" | "error";

// The six themes the owner instrumented, grouped for the Logs-tab category filter.
export type AuditCategory =
  | "context_injection"
  | "tool_injection"
  | "spawn_lifecycle"
  | "invocation_decision"
  | "daemon_operation"
  | "failure";

// The structured audit event an emission seam builds. `kind` is a fine-grained
// discriminant (e.g. "spawn.context", "reaper.kill"); the common envelope
// (workspaceId + the optional structured ids) lets the transport route + the UI
// display every variant the same way. `agentId` == the provider `sessionId` for a
// cybo session — the field the read-only session viewer deep-links on.
export interface AuditEvent {
  kind: string;
  category: AuditCategory;
  level: AuditLevel;
  workspaceId: string;
  daemonId?: string | null;
  agentId?: string | null;
  cyboId?: string | null;
  userId?: string | null;
  channelId?: string | null;
  // Optional human copy the emitter supplies; falls back to a humanized `kind`.
  source?: string;
  message?: string;
  // Redacted + capped before broadcast (see redactPayload).
  payload?: Record<string, unknown>;
}

// The wire shape consumed by the Logs pane (mirrors the UI's LogEntry inputs,
// minus the client-assigned id/timestamp).
export interface AuditEventLine {
  level: AuditLevel;
  source: string;
  message: string;
  category: AuditCategory;
  kind: string;
  workspaceId: string;
  daemonId?: string | null;
  agentId?: string | null;
  cyboId?: string | null;
  userId?: string | null;
  channelId?: string | null;
  // Redacted, capped — safe to render inline in the expand-row.
  payload: Record<string, unknown>;
}

// JSON-serialized payload cap (bytes). Same spirit as the client-log message/stack
// caps — bounds a single event's wire + RAM cost.
export const AUDIT_PAYLOAD_MAX_BYTES = 4096;

// The default human Source-column label per category when the emitter gives none.
const CATEGORY_SOURCE: Record<AuditCategory, string> = {
  context_injection: "spawn",
  tool_injection: "spawn",
  spawn_lifecycle: "spawn",
  invocation_decision: "router",
  daemon_operation: "daemon",
  failure: "daemon",
};

// Field names whose VALUE is a secret regardless of content — redacted wholesale.
const SECRET_KEY_RE = /(api[_-]?key|apikey|authorization|secret|password|token|bearer)/i;

// A Composio consumer key (`ck_…`) anywhere in a string.
const CK_KEY_RE = /ck_[A-Za-z0-9_-]+/g;
// An OpenAI-style / generic provider key (`sk-…`) anywhere in a string.
const SK_KEY_RE = /sk-[A-Za-z0-9_-]{8,}/g;
// A `Bearer <token>` fragment anywhere in a string.
const BEARER_RE = /bearer\s+[A-Za-z0-9._-]+/gi;

const REDACTED = "[redacted]";

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

// Reduce an http(s) URL to host + path — drops the `?query` (where scoped MCP
// tokens / agentId secrets ride) AND any embedded credentials.
function stripUrlQuery(value: string): string {
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    // Not a parseable URL — fall back to a naive cut at the first `?`.
    const q = value.indexOf("?");
    return q >= 0 ? value.slice(0, q) : value;
  }
}

// Scrub secret substrings from a free string value: URL query strings, ck_/sk_
// keys, bearer tokens.
function redactString(value: string): string {
  let out = looksLikeUrl(value) ? stripUrlQuery(value) : value;
  out = out.replace(CK_KEY_RE, "ck_[redacted]");
  out = out.replace(SK_KEY_RE, "sk-[redacted]");
  out = out.replace(BEARER_RE, "Bearer [redacted]");
  return out;
}

// Recursively redact a value: secret-named keys → wholesale; strings → scrubbed.
function redactValue(value: unknown, keyIsSecret: boolean): unknown {
  if (keyIsSecret) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, false));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, SECRET_KEY_RE.test(k));
    }
    return out;
  }
  return value;
}

/**
 * Redact + size-cap a payload before it is broadcast. PURE. Strips api keys,
 * Composio `ck_` keys, `sk-` keys, bearer tokens, and the query string of any URL,
 * then truncates to AUDIT_PAYLOAD_MAX_BYTES (replacing the payload with a
 * `{ _truncated, _bytes }` marker when the serialized form is over the cap).
 */
export function redactPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!payload) return {};
  const redacted = redactValue(payload, false) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  if (serialized.length > AUDIT_PAYLOAD_MAX_BYTES) {
    return {
      _truncated: true,
      _bytes: serialized.length,
      _preview: serialized.slice(0, AUDIT_PAYLOAD_MAX_BYTES),
    };
  }
  return redacted;
}

// "spawn.context" → "spawn context"; a humanized fallback when no message given.
function humanizeKind(kind: string): string {
  return kind.replace(/[._]+/g, " ").trim();
}

/**
 * Map an AuditEvent to the Logs-pane line (level + human message + structured ids
 * + redacted payload). PURE: same input → same output, no clock, no I/O.
 */
export function formatAuditEvent(event: AuditEvent): AuditEventLine {
  return {
    level: event.level,
    category: event.category,
    kind: event.kind,
    source: event.source ?? CATEGORY_SOURCE[event.category],
    message: event.message ?? humanizeKind(event.kind),
    workspaceId: event.workspaceId,
    daemonId: event.daemonId ?? null,
    agentId: event.agentId ?? null,
    cyboId: event.cyboId ?? null,
    userId: event.userId ?? null,
    channelId: event.channelId ?? null,
    payload: redactPayload(event.payload),
  };
}

// The `cyborg:audit_event` broadcast envelope. The payload IS the formatted line,
// so the client transport emits it straight through and app.svelte pushes it into
// logState without re-deriving copy — exactly like `cyborg:task_event`.
export interface AuditEventBroadcast {
  type: "cyborg:audit_event";
  payload: AuditEventLine;
}

/**
 * Wrap an AuditEvent in the workspace broadcast envelope. The seams call this and
 * hand the result to their workspace fan-out (`broadcast.toWorkspace` on the
 * daemon, `broadcastToGuests` on the relay).
 */
export function auditEventBroadcast(event: AuditEvent): AuditEventBroadcast {
  return { type: "cyborg:audit_event", payload: formatAuditEvent(event) };
}

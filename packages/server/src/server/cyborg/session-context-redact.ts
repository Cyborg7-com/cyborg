// Secret redaction for the read-only session-context viewer (#994).
//
// The captured ephemeral context (system prompt, routed/raw prompt, MCP server
// URLs) is faithful at capture time but served to an AUDITOR — so any embedded
// credential must be scrubbed before it leaves the daemon. We redact the secret
// SHAPES we know can appear: cybo consumer-router keys (`ck_…`), provider api
// keys (`sk-…` / `sk-ant-…`), bearer tokens, and the `token`/`key`/`secret`/
// `apiKey` query params on scoped MCP URLs (composio et al.). Conservative by
// design: over-redaction is safe; leaking a key is not.

import type { CyborgSessionContextMcpServer } from "./cyborg-messages.js";
import type { StoredEphemeralSessionContext } from "./storage.js";

const REDACTED = "[redacted]";

// Token-shaped secrets anywhere in free text. Ordered most-specific-first so the
// `sk-ant-` prefix is consumed before the generic `sk-` rule.
const TOKEN_PATTERNS: RegExp[] = [
  /\bck_[A-Za-z0-9_-]{6,}/g, // cybo consumer-router key
  /\bsk-ant-[A-Za-z0-9_-]{6,}/g, // anthropic api key
  /\bsk-[A-Za-z0-9_-]{12,}/g, // openai-style api key
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // slack token
  /\bgh[pousr]_[A-Za-z0-9]{12,}/g, // github token
];

// Sensitive URL/query/header param names → redact their value (keep the key so
// the auditor still sees that a token WAS present, just not its value).
const SENSITIVE_PARAM =
  /([?&#](?:token|key|api[_-]?key|secret|password|access[_-]?token)=)[^&\s]+/gi;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi;

export function redactSecrets(text: string | null): string | null {
  if (text === null) return null;
  let out = text;
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  out = out.replace(SENSITIVE_PARAM, `$1${REDACTED}`);
  out = out.replace(BEARER, `$1${REDACTED}`);
  return out;
}

// Redact a captured MCP server entry's URL (scoped composio/consumer-router URLs
// carry the token in their path/query).
function redactMcpServer(server: CyborgSessionContextMcpServer): CyborgSessionContextMcpServer {
  return {
    ...server,
    ...(server.url !== undefined ? { url: redactSecrets(server.url) ?? server.url } : {}),
  };
}

export interface RedactedSessionContext {
  systemPrompt: string | null;
  mcpServers: CyborgSessionContextMcpServer[];
  routedPrompt: string | null;
  rawPrompt: string | null;
  cyboId: string | null;
  channelId: string | null;
  createdAt: number;
}

// Project a stored capture row into the wire bundle with every secret scrubbed.
export function toRedactedSessionContext(
  row: StoredEphemeralSessionContext,
): RedactedSessionContext {
  let mcpServers: CyborgSessionContextMcpServer[] = [];
  if (row.mcp_servers_json) {
    try {
      const parsed = JSON.parse(row.mcp_servers_json) as CyborgSessionContextMcpServer[];
      if (Array.isArray(parsed)) mcpServers = parsed.map(redactMcpServer);
    } catch {
      mcpServers = [];
    }
  }
  return {
    systemPrompt: redactSecrets(row.system_prompt),
    mcpServers,
    routedPrompt: redactSecrets(row.routed_prompt),
    rawPrompt: redactSecrets(row.raw_prompt),
    cyboId: row.cybo_id,
    channelId: row.channel_id,
    createdAt: row.created_at,
  };
}

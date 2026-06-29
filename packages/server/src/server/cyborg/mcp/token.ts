import { createHash, randomBytes, randomUUID } from "node:crypto";

// MCP Personal Access Tokens.
//
// The raw token is an opaque secret shown ONCE at creation. We persist only its
// SHA-256 hash, so the database never holds anything that can be replayed and a
// token can be revoked by deleting its row. The workspace id is encoded into the
// token so the relay's `/mcp` URL stays constant — the secret carries the scope.

export const MCP_SCOPES = ["read", "write"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export interface GeneratedMcpToken {
  /** The opaque secret to hand to the external agent. Shown once. */
  raw: string;
  /** SHA-256 hash of `raw`, stored in `mcp_tokens.token_hash`. */
  hash: string;
}

const PREFIX = "cybo_mcp";

/**
 * Mint a new MCP token bound to a workspace. The workspace id is embedded so the
 * connection URL never changes; the trailing secret is the unguessable part.
 */
export function generateMcpToken(workspaceId: string): GeneratedMcpToken {
  const secret = randomBytes(32).toString("base64url");
  const raw = `${PREFIX}_${workspaceId}_${secret}`;
  return { raw, hash: hashMcpToken(raw) };
}

/** Stable SHA-256 of a raw token, used for both storage and lookup. */
export function hashMcpToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Best-effort extraction of the workspace id embedded in a raw token. */
export function workspaceIdFromToken(raw: string): string | null {
  if (!raw.startsWith(`${PREFIX}_`)) return null;
  const rest = raw.slice(PREFIX.length + 1);
  const lastSep = rest.lastIndexOf("_");
  if (lastSep <= 0) return null;
  return rest.slice(0, lastSep);
}

export function newMcpTokenId(): string {
  return `mcp_${randomUUID()}`;
}

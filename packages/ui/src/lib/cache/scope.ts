/**
 * Scope-key conventions — keep all message kinds in one IDB store keyed by a
 * string scope. Channels and DMs each get their own prefix so eviction, sync
 * metadata, and reads target them uniformly.
 *
 * Scope key formats:
 *   - Channel: `<wsId>:ch:<channelId>`
 *   - DM:      `<wsId>:dm:<peerId>`     (the other party's user id)
 *
 * NOTE vs v1: v1 had a third `dma:<remoteAgentId>` scope for agent DMs. The
 * rewrite routes agent conversations through `agentStreamState` (live SDK
 * streaming, not selectDm), so there is no agent-DM scope here — channel + DM
 * only. If the rewrite ever persists agent-conversation history through the
 * same fetch path, add an `agentScope()` here keyed by `<wsId>:ag:<agentId>`.
 */

export type ScopeKind = "ch" | "dm";

export function channelScope(workspaceId: string, channelId: string): string {
  return `${workspaceId}:ch:${channelId}`;
}

export function dmScope(workspaceId: string, peerId: string): string {
  return `${workspaceId}:dm:${peerId}`;
}

export function parseScope(
  scopeKey: string,
): { workspaceId: string; kind: ScopeKind; id: string } | null {
  const idx1 = scopeKey.indexOf(":");
  if (idx1 < 0) return null;
  const idx2 = scopeKey.indexOf(":", idx1 + 1);
  if (idx2 < 0) return null;
  const workspaceId = scopeKey.slice(0, idx1);
  const kind = scopeKey.slice(idx1 + 1, idx2);
  const id = scopeKey.slice(idx2 + 1);
  if (kind !== "ch" && kind !== "dm") return null;
  return { workspaceId, kind, id };
}

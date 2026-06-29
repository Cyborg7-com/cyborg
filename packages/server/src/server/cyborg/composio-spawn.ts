// Spawn-time glue: turn a cybo's persisted `tool_grants` + the run's invoker into
// the Composio MCP servers to inject. One call for cybo-manager — parse → build the
// run context from the connection store → resolve bindings → mint scoped MCP URLs.
// Returns empty (and never throws on absent/garbled grants) so the spawn path stays
// a strict no-op for every cybo without Composio grants.

import { resolveComposioTools } from "./composio-binding.js";
import type { ComposioConnectionStore } from "./composio-connection-store.js";
import {
  type ComposioApprovalAction,
  buildComposioMcpServers,
  type ComposioMcpFailure,
  composioApprovalActions,
} from "./composio-mcp.js";
import {
  type ComposioClient,
  type ComposioRunContext,
  type CyboToolGrants,
  CyboToolGrantsSchema,
} from "./composio-types.js";
import type { McpServerConfig } from "./cybo-types.js";

// Parse + validate the persisted tool_grants JSON. Returns an empty grant set on
// null/blank/garbled input (a bad blob must not break a spawn) rather than throwing.
export function parseCyboToolGrants(raw: string | null | undefined): CyboToolGrants {
  if (!raw) return { composio: [] };
  try {
    return CyboToolGrantsSchema.parse(JSON.parse(raw));
  } catch {
    return { composio: [] };
  }
}

// Build a run context by reading the workspace's connections ONCE, then exposing a
// synchronous membership check to the pure resolver. invokerUserId === null marks an
// autonomous run (scheduled/webhook), which makes every `caller`-bound toolkit
// unavailable (no human identity to act as).
export async function buildCyboRunContext(input: {
  connections: ComposioConnectionStore;
  workspaceId: string;
  cyboId: string;
  invokerUserId: string | null;
}): Promise<ComposioRunContext> {
  const conns = await input.connections.list({ workspaceId: input.workspaceId });
  const active = new Set(
    conns
      .filter((c) => c.status === "active")
      .map((c) => `${c.ownerKind}:${c.ownerId}:${c.toolkit}`),
  );
  return {
    workspaceId: input.workspaceId,
    cyboId: input.cyboId,
    invokerUserId: input.invokerUserId,
    hasConnection: (q) => active.has(`${q.ownerKind}:${q.ownerId}:${q.toolkit}`),
  };
}

export interface ComposioSpawnResult {
  servers: Record<string, McpServerConfig>;
  failures: ComposioMcpFailure[];
  // Tier-2 actions to register on the mediated approval proxy for this run.
  approvalActions: ComposioApprovalAction[];
}

// The single entry point cybo-manager calls. A no-op (empty result) when the cybo
// has no Composio grants — so a spawn without grants is byte-identical.
export async function composioMcpForSpawn(input: {
  toolGrantsRaw: string | null | undefined;
  connections: ComposioConnectionStore;
  client: ComposioClient;
  workspaceId: string;
  cyboId: string;
  // null ⇒ autonomous run (no human invoker) ⇒ caller-bound toolkits are dropped.
  invokerUserId: string | null;
}): Promise<ComposioSpawnResult> {
  const grants = parseCyboToolGrants(input.toolGrantsRaw);
  if (grants.composio.length === 0) {
    return { servers: {}, failures: [], approvalActions: [] };
  }
  const ctx = await buildCyboRunContext({
    connections: input.connections,
    workspaceId: input.workspaceId,
    cyboId: input.cyboId,
    invokerUserId: input.invokerUserId,
  });
  const resolution = resolveComposioTools(grants.composio, ctx);
  const { servers, failures } = await buildComposioMcpServers(resolution, input.client);
  return { servers, failures, approvalActions: composioApprovalActions(resolution) };
}

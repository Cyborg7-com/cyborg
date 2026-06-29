// Composio → MCP injection at spawn time.
//
// Turns a resolved set of toolkits (see composio-binding.ts) into the MCP server
// configs that get injected when a cybo is spawned. ONLY Tier-1 `directActions` are
// minted into an MCP URL here — Tier-2 `approvalActions` are deliberately withheld
// and routed through the mediated approval proxy instead, so an approval-gated action
// can never be directly callable by the agent. See composio-types.ts for the model.

import type { McpServerConfig } from "./cybo-types.js";
import type { ComposioClient, ComposioResolution } from "./composio-types.js";
import type { ComposioRouterConfig } from "./composio-deps.js";

// Transport B default router endpoint (internal docs). Kept here (and in
// composio-router-client.ts) so the injection has no dependency on the client.
const DEFAULT_ROUTER_URL = "https://connect.composio.dev/mcp";

// Transport B (consumer router): inject the router as a SINGLE `http` MCP server.
// The cybo's agent then gets the router's meta-tools (search / get-schemas /
// multi-execute / manage-connections); Composio restricts execution to the toolkits
// the consumer has an ACTIVE connection for (toolkit-level native restriction — no
// per-action minting, no daemon-side gateway). v1 uses one workspace `service` key.
export function buildComposioRouterMcpServer(
  router: ComposioRouterConfig,
): Record<string, McpServerConfig> {
  return {
    "composio:router": {
      type: "http",
      url: router.routerUrl ?? DEFAULT_ROUTER_URL,
      headers: { "x-consumer-api-key": router.consumerKey },
    },
  };
}

// One toolkit whose MCP mint failed — excluded from the spawn, surfaced to the caller.
export interface ComposioMcpFailure {
  toolkit: string;
  error: string;
}

export interface ComposioMcpServers {
  // Keyed `composio:<toolkit>` → an `http` MCP server config to inject at spawn.
  servers: Record<string, McpServerConfig>;
  // Toolkits whose mint threw — excluded but NOT fatal (the spawn still proceeds).
  failures: ComposioMcpFailure[];
}

// Build the MCP server configs to inject for a resolved set of toolkits.
//
// For each AVAILABLE toolkit with at least one `directAction`, mint a per-entity MCP
// URL scoped to exactly those direct actions and produce a `composio:<toolkit>` entry.
// A toolkit whose directActions is empty (everything needs approval) yields NO entry.
// Mints run concurrently; a single failing mint excludes that toolkit and is collected
// in `failures` instead of failing the whole spawn.
export async function buildComposioMcpServers(
  resolution: ComposioResolution,
  client: ComposioClient,
): Promise<ComposioMcpServers> {
  const minted = await Promise.all(
    resolution.available
      .filter((toolkit) => toolkit.directActions.length > 0)
      .map(async (toolkit) => {
        try {
          const { url, headers } = await client.mintScopedMcpUrl({
            entity: toolkit.entity,
            toolkit: toolkit.toolkit,
            allowedActions: toolkit.directActions,
          });
          return { ok: true, toolkit: toolkit.toolkit, url, headers } as const;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { ok: false, toolkit: toolkit.toolkit, error } as const;
        }
      }),
  );

  const servers: Record<string, McpServerConfig> = {};
  const failures: ComposioMcpFailure[] = [];

  for (const entry of minted) {
    if (!entry.ok) {
      failures.push({ toolkit: entry.toolkit, error: entry.error });
      continue;
    }
    servers[`composio:${entry.toolkit}`] = {
      type: "http",
      url: entry.url,
      headers: entry.headers,
    };
  }

  return { servers, failures };
}

// One Tier-2 (approval-gated) action the mediated proxy will offer.
export interface ComposioApprovalAction {
  toolkit: string;
  entity: string;
  action: string;
}

// Flatten the Tier-2 approval actions across all available toolkits. The mediated
// proxy offers EXACTLY these — they are never placed in an MCP URL.
export function composioApprovalActions(resolution: ComposioResolution): ComposioApprovalAction[] {
  const actions: ComposioApprovalAction[] = [];
  for (const toolkit of resolution.available) {
    for (const action of toolkit.approvalActions) {
      actions.push({ toolkit: toolkit.toolkit, entity: toolkit.entity, action });
    }
  }
  return actions;
}

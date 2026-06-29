// Composio connection readiness overlay — the per-(viewer, cybo) UI projection.
//
// Reuses the pure resolver (composio-binding.ts) to tell the VIEWING user which of a
// cybo's toolkits are ready vs blocked, so a banner can render "Connect Gmail to use
// this cybo's tools". It is PURE (no Composio calls, no DB) — the run context carries
// the connection lookup. See composio-types.ts for the model.

import { resolveComposioTools } from "./composio-binding.js";
import type {
  BlockedReason,
  ComposioBinding,
  ComposioRunContext,
  ComposioToolGrant,
} from "./composio-types.js";

export interface ComposioConnectionStatus {
  toolkit: string;
  binding: ComposioBinding;
  connected: boolean;
  // Present only when not connected — why, and how the viewer fixes it.
  blockedReason?: BlockedReason;
  remedy?: string;
}

// Project the cybo's grants into a per-toolkit connection overlay for the viewer.
// Available toolkits map to connected:true; blocked ones to connected:false plus the
// reason + remedy the banner surfaces.
export function composioConnectionStatus(
  grants: ComposioToolGrant[],
  ctx: ComposioRunContext,
): ComposioConnectionStatus[] {
  const resolution = resolveComposioTools(grants, ctx);

  const statuses: ComposioConnectionStatus[] = [];
  for (const available of resolution.available) {
    statuses.push({
      toolkit: available.toolkit,
      binding: available.binding,
      connected: true,
    });
  }
  for (const blocked of resolution.blocked) {
    statuses.push({
      toolkit: blocked.toolkit,
      binding: blocked.binding,
      connected: false,
      blockedReason: blocked.reason,
      remedy: blocked.remedy,
    });
  }
  return statuses;
}

// True if any grant is blocked specifically on `no-connection` — i.e. the viewer can
// unblock the cybo by connecting an account. Drives the readiness badge.
export function cyboNeedsConnection(grants: ComposioToolGrant[], ctx: ComposioRunContext): boolean {
  const resolution = resolveComposioTools(grants, ctx);
  return resolution.blocked.some((blocked) => blocked.reason === "no-connection");
}

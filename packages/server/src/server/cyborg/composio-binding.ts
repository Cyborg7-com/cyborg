// Composio binding resolution + permission matrix — the pure ownership engine.
//
// This is where "the cybo is workspace-owned but the auth is personal" is actually
// resolved. Given a cybo's capability grants + a run context, it decides which
// toolkits are available, AS WHOM (the Composio entity), and which actions need a
// human approval card. It is PURE (no Composio calls, no DB) so the whole ownership
// model is unit-testable end to end. See composio-types.ts for the model.

import {
  type BlockedToolkit,
  type ComposioBinding,
  type ComposioResolution,
  type ComposioRunContext,
  type ComposioToolGrant,
  type ConnectionOwnerKind,
  composioEntityId,
  type ResolvedToolkit,
} from "./composio-types.js";

// Resolve the owner identity a toolkit grant binds to for THIS run.
//   caller  → the invoking human (null when the run is autonomous).
//   service → the workspace-owned shared account.
function resolveOwner(
  binding: ComposioBinding,
  ctx: ComposioRunContext,
): { ownerKind: ConnectionOwnerKind; ownerId: string } | null {
  if (binding === "caller") {
    if (!ctx.invokerUserId) return null; // autonomous run — no human to act as
    return { ownerKind: "user", ownerId: ctx.invokerUserId };
  }
  return { ownerKind: "service", ownerId: ctx.workspaceId };
}

function remedyFor(binding: ComposioBinding, toolkit: string, reason: string): string {
  if (reason === "no-actions") {
    return `No actions are enabled for ${toolkit} — pick at least one in the cybo's integrations.`;
  }
  if (reason === "autonomous-caller") {
    return `${toolkit} is set to act as the invoking user, so it can't run unattended (scheduled/webhook). Switch it to a shared service account to use it autonomously.`;
  }
  // no-connection
  return binding === "caller"
    ? `Connect your ${toolkit} account to let this cybo use ${toolkit} on your behalf.`
    : `An admin must connect a shared ${toolkit} account for this workspace before the cybo can use it.`;
}

// The core resolver. Each grant independently becomes either available (with the
// entity to mint its MCP for + the direct/approval action split) or blocked (with a
// reason the UI can surface). A blocked toolkit never silently disappears.
export function resolveComposioTools(
  grants: readonly ComposioToolGrant[],
  ctx: ComposioRunContext,
): ComposioResolution {
  const available: ResolvedToolkit[] = [];
  const blocked: BlockedToolkit[] = [];

  for (const grant of grants) {
    const block = (reason: BlockedToolkit["reason"]) =>
      blocked.push({
        toolkit: grant.toolkit,
        binding: grant.binding,
        reason,
        remedy: remedyFor(grant.binding, grant.toolkit, reason),
      });

    if (grant.allowedActions.length === 0) {
      block("no-actions");
      continue;
    }

    const owner = resolveOwner(grant.binding, ctx);
    if (!owner) {
      block("autonomous-caller");
      continue;
    }

    if (!ctx.hasConnection({ ...owner, toolkit: grant.toolkit })) {
      block("no-connection");
      continue;
    }

    // Split allowed actions: approval-gated ones go to the mediated proxy (Tier-2),
    // the rest into the scoped MCP URL (Tier-1). An action only counts if it's
    // allowed in the first place (requireApproval is intersected with allowedActions).
    const allowed = new Set(grant.allowedActions);
    const approvalSet = new Set(grant.requireApproval.filter((a) => allowed.has(a)));
    const directActions = grant.allowedActions.filter((a) => !approvalSet.has(a));
    const approvalActions = grant.allowedActions.filter((a) => approvalSet.has(a));

    available.push({
      toolkit: grant.toolkit,
      entity: composioEntityId(owner.ownerKind, owner.ownerId, ctx.workspaceId),
      binding: grant.binding,
      ownerKind: owner.ownerKind,
      ownerId: owner.ownerId,
      directActions,
      approvalActions,
    });
  }

  return { available, blocked };
}

// ─── Permission matrix ──────────────────────────────────────────────
// Separate authority for the two distinct operations on a cybo's tools.

const PRIVILEGED_ROLES = new Set(["owner", "admin"]);

// Who may CONFIGURE a cybo's tool grants (add/remove toolkits, actions, binding,
// approval). Capability is workspace-shared state → admin/owner only. (The relay
// already gates update_cybo this way; this keeps the rule colocated + testable.)
export function canConfigureToolGrants(role: string | null): boolean {
  return role !== null && PRIVILEGED_ROLES.has(role);
}

// Who may CONNECT an account for use with a cybo, by binding:
//   caller  → any non-viewer member, but ONLY for THEMSELVES (a personal account is
//             never connected on behalf of someone else).
//   service → admin/owner only (a shared account everyone-who-invokes acts as is a
//             privileged, workspace-level grant).
export function canConnectAccount(input: {
  binding: ComposioBinding;
  role: string | null;
  // For a caller connection: is the account being connected the caller's OWN?
  isSelf: boolean;
}): { allowed: boolean; reason?: string } {
  const { binding, role, isSelf } = input;
  if (role === null) return { allowed: false, reason: "not a member of this workspace" };
  if (role === "viewer") return { allowed: false, reason: "viewers cannot connect tool accounts" };

  if (binding === "service") {
    return PRIVILEGED_ROLES.has(role)
      ? { allowed: true }
      : { allowed: false, reason: "only an admin can connect a shared service account" };
  }
  // caller
  return isSelf
    ? { allowed: true }
    : { allowed: false, reason: "a personal account can only be connected by its own user" };
}

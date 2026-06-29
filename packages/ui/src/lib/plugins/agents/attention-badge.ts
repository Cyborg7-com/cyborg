// ─── Derived "needs attention" badge (#591) ──────────────────────────────────
//
// Pure helpers for the agents-list attention badge. The daemon edge-triggers an
// attention flag when a background agent finishes a turn (running→idle) or errors
// (→error) and forwards it on the agent-list snapshot (cyborg:list_agents). This
// module turns that flag — and the equivalent live turn transitions for agents
// already streaming in the client — into a badge label/tone, and models the
// clear-on-view transition. Kept DOM-free so it's unit-testable in isolation.
//
// DISTINCT from the pending-permission badge: a permission prompt ("Waiting for
// your approval") is a separate, already-existing surface driven by
// agentStreamState.getPendingPermissions(). This badge is the "done — review me"
// / "errored — review me" signal. `reason: "permission"` is accepted (the daemon
// can emit it) but deliberately NOT rendered here, so the two never double-count:
// a permission prompt shows the permission badge only.

import type { AgentAttention, AgentAttentionReason } from "./types.js";

// The badge a row should show. `null` = no attention badge for this agent.
export interface AttentionBadge {
  reason: "finished" | "error";
  label: string;
  // Theme tone the renderer maps to tokens (no hardcoded colors here):
  // - "error"  → destructive/error tokens (a failed turn needs you NOW)
  // - "done"   → success/positive tokens (finished cleanly — review the result)
  tone: "error" | "done";
  // Tooltip / aria copy.
  description: string;
}

const FINISHED_BADGE: AttentionBadge = {
  reason: "finished",
  label: "Done",
  tone: "done",
  description: "Finished its turn — review the result",
};

const ERROR_BADGE: AttentionBadge = {
  reason: "error",
  label: "Error",
  tone: "error",
  description: "The agent errored — review it",
};

// Map a raw attention projection (from the list snapshot OR a client-side
// derivation) to the badge to render, or null when nothing should show.
// Only "finished" and "error" surface a badge; "permission" (and an unset/false
// flag) yield null so the dedicated permission badge owns that state.
export function attentionBadgeFor(
  attention: AgentAttention | null | undefined,
): AttentionBadge | null {
  if (!attention || !attention.requiresAttention) return null;
  return badgeForReason(attention.reason ?? null);
}

export function badgeForReason(
  reason: AgentAttentionReason | null | undefined,
): AttentionBadge | null {
  switch (reason) {
    case "finished":
      return FINISHED_BADGE;
    case "error":
      return ERROR_BADGE;
    default:
      // "permission" or unknown → no derived badge (permission has its own UI).
      return null;
  }
}

// ─── Live transition derivation ──────────────────────────────────────────────
//
// For an agent already in view, the snapshot is only fetched on load — the live
// signal arrives as stream turn events. This mirrors the daemon's edge rule
// (agent-manager.checkAndSetAttention) on the client so the badge appears without
// a refetch: a turn that COMPLETES marks "finished"; a turn that FAILS marks
// "error". turn_canceled / turn_started clear nothing and raise nothing (a cancel
// is user-initiated, not a "review me" event). Returns the reason to RAISE, or
// null when the event isn't an attention edge.
export type AgentTurnEventType =
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "turn_canceled";

export function attentionReasonForTurnEvent(
  eventType: AgentTurnEventType,
): AgentAttentionReason | null {
  switch (eventType) {
    case "turn_completed":
      return "finished";
    case "turn_failed":
      return "error";
    default:
      return null;
  }
}

// ─── Snapshot reconciliation ─────────────────────────────────────────────────
//
// When the list snapshot is (re)fetched, reconcile a single agent's attention.
// The snapshot is authoritative for whether the flag is currently SET, but the
// client must not resurrect a flag the user already cleared locally (opened the
// agent) before the server learned of the clear. Rules:
//   - snapshot says requiresAttention → adopt the snapshot reason (it's fresh).
//   - snapshot says NOT requiresAttention → clear (the server cleared it too,
//     e.g. another device viewed it).
// `locallyCleared` lets a caller suppress re-raising for an agent the user just
// opened this session (defense-in-depth against a stale in-flight snapshot).
export function reconcileAttentionFromSnapshot(opts: {
  snapshot: AgentAttention | null | undefined;
  locallyCleared: boolean;
}): AgentAttentionReason | null {
  const { snapshot, locallyCleared } = opts;
  if (!snapshot || !snapshot.requiresAttention) return null;
  if (locallyCleared) return null;
  const reason = snapshot.reason ?? null;
  // Only adopt a reason we actually badge; "permission"/unknown → no raise.
  if (reason === "finished" || reason === "error") return reason;
  return null;
}

// Pure, DOM-free resolver that turns a task's raw `assigneeId` into a display
// identity (name + avatar + initials) by looking it up across the three pools a
// task can be assigned to: workspace members (humans), cybos, and live agents.
// Kept pure so the Tasks board / dialog render a real name+face instead of the
// truncated id, and so the lookup is unit-testable without mounting a component.
//
// Resolution order is members → cybos → agents. The three id spaces don't
// overlap in practice (a member is a userId, a cybo is its db id, an agent is an
// agentId), so order only matters for the unreachable collision case; members
// win there because a human assignee is the most common, most authoritative one.
import { getInitials } from "$lib/utils.js";
import { agentDisplayName } from "$lib/agent-display.js";
import type { WorkspaceMember } from "$lib/core/types.js";
import type { Agent, Cybo } from "$lib/plugins/agents/types.js";

export type AssigneeKind = "user" | "cybo" | "agent" | "unknown";

export interface ResolvedAssignee {
  kind: AssigneeKind;
  id: string;
  name: string;
  // An image URL OR a raw avatar string (a cybo avatar may be a single emoji).
  // Pass straight to <Avatar avatar={...} /> which resolves image|emoji|initials.
  avatarUrl?: string | null;
  initials: string;
}

export interface AssigneePools {
  members: WorkspaceMember[];
  cybos: Cybo[];
  agents: Agent[];
}

// Resolve `id` to a display identity, or null when there is no assignee.
// An id that matches no pool resolves to kind "unknown" with the id as its name
// (the board then falls back to showing the id), never null — null is reserved
// for "no one is assigned".
export function resolveAssignee(id: string | null, pools: AssigneePools): ResolvedAssignee | null {
  // Guard `id` (no assignee) and a null/partial `pools` (the rune-backed pools can
  // be transiently undefined during a workspace switch). A missing pool is read as
  // empty so the lookup falls through to "unknown" instead of throwing.
  if (!id || !pools) return null;

  const member = (pools.members ?? []).find((m) => m.userId === id);
  if (member) {
    const name = member.name ?? member.email;
    return {
      kind: "user",
      id,
      name,
      avatarUrl: member.imageUrl ?? member.image ?? null,
      initials: getInitials(name),
    };
  }

  const cybo = (pools.cybos ?? []).find((c) => c.id === id);
  if (cybo) {
    return {
      kind: "cybo",
      id,
      name: cybo.name,
      avatarUrl: cybo.avatar ?? null,
      initials: getInitials(cybo.name),
    };
  }

  const agent = (pools.agents ?? []).find((a) => a.agentId === id);
  if (agent) {
    // Use the shared agent display resolver (cyboName -> provider label -> id
    // prefix) rather than a local cyboName fallback chain — see agent-display.ts
    // and its single-resolver guard test.
    const name = agentDisplayName(agent);
    return {
      kind: "agent",
      id,
      name,
      avatarUrl: agent.cyboAvatar ?? null,
      initials: getInitials(name),
    };
  }

  return {
    kind: "unknown",
    id,
    name: id,
    avatarUrl: null,
    initials: getInitials(id),
  };
}

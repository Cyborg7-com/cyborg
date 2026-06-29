// Pure, dependency-free permission helpers shared by the cloud relay
// (relay-standalone.ts) and the daemon (workspace-manager.ts) so the
// "may this role create agents/cybos?" rule has ONE source of truth.
//
// Why this exists: create_cybo/create_agent used to be enforced ONLY on the
// daemon, against its local SQLite role + settings — which a cloud workspace
// never syncs. The relay (which has the authoritative role + settings in PG)
// now enforces the same rule, so the `allowMemberAgentCreation` toggle is real.

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

export const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

// An unknown/missing role maps to 0 — below every threshold, so it is denied.
export function roleLevel(role: string | null | undefined): number {
  return ROLE_HIERARCHY[(role ?? "") as WorkspaceRole] ?? 0;
}

// Whether `role` may create agents/cybos given the workspace's
// `allowMemberAgentCreation` setting. MUST mirror
// WorkspaceManager.canPerformWithSettings' "create_agent" case:
//   - members may create ONLY when the workspace opts in;
//   - otherwise admin+ is required (owner/admin always may).
export function canCreateAgent(
  role: string | null | undefined,
  allowMemberAgentCreation: boolean | undefined,
): boolean {
  const level = roleLevel(role);
  if (allowMemberAgentCreation === true) {
    return level >= ROLE_HIERARCHY.member;
  }
  return level >= ROLE_HIERARCHY.admin;
}

// Whether `userId` (with workspace `role`) may EDIT or DELETE an EXISTING cybo.
// owner/admin manage any cybo in the workspace; a member who can create cybos may
// manage ONLY the ones they created. This prevents one member from editing or
// deleting a teammate's cybo (object-level authorization) once member creation is
// enabled — the create capability alone must not grant workspace-wide cybo control.
export function canManageCybo(
  role: string | null | undefined,
  allowMemberAgentCreation: boolean | undefined,
  cyboCreatedBy: string,
  userId: string,
): boolean {
  if (roleLevel(role) >= ROLE_HIERARCHY.admin) return true;
  return canCreateAgent(role, allowMemberAgentCreation) && cyboCreatedBy === userId;
}

import type { DualStorage } from "./dual-storage.js";
import type { StoredWorkspace, StoredChannel, StoredMembership } from "./storage.js";
import { deriveGroupDmName, validateGroupDmParticipants } from "./group-dm.js";

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";

type ChannelCreatePolicy = "everyone" | "admins" | "owner";

interface WorkspaceSettings {
  allowMemberAgentCreation?: boolean;
  agentPermissionMode?: "ask" | "auto";
  maxAgents?: number;
  defaultAgentModel?: string;
  agentWorkspaceContext?: string;
  publicChannelCreatePolicy?: ChannelCreatePolicy;
  privateChannelCreatePolicy?: ChannelCreatePolicy;
}

const ROLE_HIERARCHY: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

export class WorkspaceManager {
  constructor(private storage: DualStorage) {}

  createWorkspace(
    name: string,
    ownerId: string,
    settings?: Record<string, unknown>,
  ): StoredWorkspace {
    const workspace = this.storage.createWorkspace(name, ownerId, settings);
    this.storage.audit({
      workspaceId: workspace.id,
      actorId: ownerId,
      actorType: "human",
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspace.id,
    });
    return workspace;
  }

  getWorkspacesForUser(userId: string): Array<StoredWorkspace & { role: string }> {
    return this.storage.getWorkspacesForUser(userId);
  }

  getWorkspaceSettings(workspaceId: string): WorkspaceSettings {
    const ws = this.storage.getWorkspace(workspaceId);
    if (!ws?.settings) return {};
    try {
      return JSON.parse(ws.settings) as WorkspaceSettings;
    } catch {
      return {};
    }
  }

  getMemberRole(workspaceId: string, userId: string): WorkspaceRole | null {
    const membership = this.storage.getMembership(workspaceId, userId);
    return (membership?.role as WorkspaceRole | undefined) ?? null;
  }

  updateWorkspace(
    workspaceId: string,
    actorId: string,
    updates: { name?: string; avatarUrl?: string | null; settings?: Record<string, unknown> },
  ): void {
    this.storage.updateWorkspace(workspaceId, updates);
    this.storage.audit({
      workspaceId,
      actorId,
      actorType: "human",
      action: "workspace.updated",
      targetType: "workspace",
      targetId: workspaceId,
    });
  }

  deleteWorkspace(workspaceId: string): void {
    // Workspace-scoped rows (including this workspace's audit log) are removed by
    // deleteWorkspace's cascade, so a deletion audit entry would be wiped anyway.
    this.storage.deleteWorkspace(workspaceId);
  }

  // ─── Members ─────────────────────────────────────────────────────

  inviteMember(
    workspaceId: string,
    inviterId: string,
    email: string,
    role: WorkspaceRole = "member",
  ): StoredMembership | null {
    const inviterMembership = this.storage.getMembership(workspaceId, inviterId);
    if (!inviterMembership) return null;
    if (!this.canPerform(inviterMembership.role as WorkspaceRole, "invite")) return null;

    const user = this.storage.upsertUser(email);
    const existing = this.storage.getMembership(workspaceId, user.id);
    if (existing) return existing;

    this.storage.addMember(workspaceId, user.id, role);
    this.storage.audit({
      workspaceId,
      actorId: inviterId,
      actorType: "human",
      action: "member.invited",
      targetType: "user",
      targetId: user.id,
      details: { email, role },
    });
    return this.storage.getMembership(workspaceId, user.id) ?? null;
  }

  removeMember(workspaceId: string, actorId: string, targetUserId: string): boolean {
    const actorMembership = this.storage.getMembership(workspaceId, actorId);
    if (!actorMembership) return false;
    if (!this.canPerform(actorMembership.role as WorkspaceRole, "remove_member")) return false;

    const targetMembership = this.storage.getMembership(workspaceId, targetUserId);
    if (!targetMembership) return false;

    if (targetMembership.role === "owner") return false;

    this.storage.deleteMembership(workspaceId, targetUserId);
    this.storage.audit({
      workspaceId,
      actorId,
      actorType: "human",
      action: "member.removed",
      targetType: "user",
      targetId: targetUserId,
    });
    return true;
  }

  updateMemberRole(
    workspaceId: string,
    actorId: string,
    targetUserId: string,
    newRole: WorkspaceRole,
  ): boolean {
    const actorMembership = this.storage.getMembership(workspaceId, actorId);
    if (!actorMembership) return false;

    if (actorMembership.role !== "owner") return false;

    const targetMembership = this.storage.getMembership(workspaceId, targetUserId);
    if (!targetMembership) return false;

    if (newRole === "owner") return false;

    this.storage.updateMembership(workspaceId, targetUserId, newRole);
    this.storage.audit({
      workspaceId,
      actorId,
      actorType: "human",
      action: "member.role_updated",
      targetType: "user",
      targetId: targetUserId,
      details: { oldRole: targetMembership.role, newRole },
    });
    return true;
  }

  getMembers(workspaceId: string) {
    return this.storage.getMembers(workspaceId);
  }

  getMembership(workspaceId: string, userId: string) {
    return this.storage.getMembership(workspaceId, userId);
  }

  // ─── Channels ────────────────────────────────────────────────────

  createChannel(
    workspaceId: string,
    userId: string,
    name: string,
    opts?: { description?: string; isPrivate?: boolean; instructions?: string },
  ): StoredChannel | null {
    const membership = this.storage.getMembership(workspaceId, userId);
    if (!membership) return null;
    if (!this.canPerform(membership.role as WorkspaceRole, "create_channel")) return null;

    const channel = this.storage.createChannel(workspaceId, name, userId, opts);
    this.storage.audit({
      workspaceId,
      actorId: userId,
      actorType: "human",
      action: "channel.created",
      targetType: "channel",
      targetId: channel.id,
      details: { name },
    });
    return channel;
  }

  // #608: create a group DM (hidden type='group_dm' channel) with its members
  // set at creation. Mirrors createChannel's authz (a non-viewer member may start
  // one — it's a conversation, not a workspace channel, so it's gated on `view`,
  // not create_channel). Validates every participant is a workspace member and
  // enforces the ≤ 8-others cap via the shared validator, then writes the channel
  // + membership atomically (DualStorage → PG). Returns a discriminated result so
  // the caller can surface the precise validation error.
  createGroupDm(
    workspaceId: string,
    userId: string,
    participants: string[],
  ):
    | { ok: true; channel: StoredChannel }
    | { ok: false; code: "forbidden" | "invalid"; message: string } {
    const membership = this.storage.getMembership(workspaceId, userId);
    if (!membership) return { ok: false, code: "forbidden", message: "Not a workspace member" };
    if ((membership.role as WorkspaceRole) === "viewer") {
      return { ok: false, code: "forbidden", message: "Viewers can't start group DMs" };
    }
    const members = this.storage.getMembers(workspaceId);
    const memberIds = new Set(members.map((m) => m.user_id));
    const validation = validateGroupDmParticipants({
      creatorId: userId,
      participants,
      memberIds,
    });
    if (!validation.ok) return { ok: false, code: "invalid", message: validation.error };

    const memberSet = new Set([userId, ...validation.participantIds]);
    const name = deriveGroupDmName(
      members
        .filter((m) => memberSet.has(m.user_id))
        .map((m) => ({ userId: m.user_id, name: m.name, email: m.email })),
    );
    const channel = this.storage.createGroupDm({
      workspaceId,
      name,
      createdBy: userId,
      participantIds: validation.participantIds,
    });
    this.storage.audit({
      workspaceId,
      actorId: userId,
      actorType: "human",
      action: "channel.created",
      targetType: "channel",
      targetId: channel.id,
      details: { name, type: "group_dm", memberCount: memberSet.size },
    });
    return { ok: true, channel };
  }

  getChannels(workspaceId: string): StoredChannel[] {
    return this.storage.getChannels(workspaceId);
  }

  getChannel(channelId: string): StoredChannel | undefined {
    return this.storage.getChannel(channelId);
  }

  // ─── Authorization ───────────────────────────────────────────────

  checkPermission(
    workspaceId: string,
    userId: string,
    action: string,
  ): { allowed: boolean; role: WorkspaceRole | null } {
    const membership = this.storage.getMembership(workspaceId, userId);
    if (!membership) return { allowed: false, role: null };
    const role = membership.role as WorkspaceRole;
    const settings = this.getWorkspaceSettings(workspaceId);
    return { allowed: this.canPerformWithSettings(role, action, settings), role };
  }

  private canPerform(role: WorkspaceRole, action: string): boolean {
    return this.canPerformWithSettings(role, action, {});
  }

  private canPerformWithSettings(
    role: WorkspaceRole,
    action: string,
    settings: WorkspaceSettings,
  ): boolean {
    const level = ROLE_HIERARCHY[role] ?? 0;
    switch (action) {
      case "send_message":
      case "create_task":
      case "create_channel":
      case "assign_task":
        return level >= ROLE_HIERARCHY.member;

      case "create_agent":
        if (settings.allowMemberAgentCreation === true) {
          return level >= ROLE_HIERARCHY.member;
        }
        return level >= ROLE_HIERARCHY.admin;

      case "manage_agents":
        return level >= ROLE_HIERARCHY.admin;

      case "send_agent_prompt":
        return level >= ROLE_HIERARCHY.member;

      case "approve_agent_permission":
        return level >= ROLE_HIERARCHY.member;

      case "invite":
      case "remove_member":
        return level >= ROLE_HIERARCHY.admin;

      case "update_role":
        return level >= ROLE_HIERARCHY.owner;

      case "delete_workspace":
        return level >= ROLE_HIERARCHY.owner;

      case "view":
      case "view_agent_stream":
        return level >= ROLE_HIERARCHY.viewer;

      default:
        return level >= ROLE_HIERARCHY.member;
    }
  }
}

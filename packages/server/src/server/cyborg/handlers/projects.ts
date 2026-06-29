import { randomUUID } from "node:crypto";

import type { GuestHandlerCtx } from "./guest-context.js";

// Project guest WS handlers, extracted verbatim from relay-standalone.ts (#53).
// Behaviour-identical to the inline switch cases — `break` became `return`.

export async function handleCreateProject(
  ctx: GuestHandlerCtx,
  inner: Record<string, unknown>,
): Promise<void> {
  const { pg, userId, workspaceId, respond, respondError } = ctx;
  if (!workspaceId) return;
  const projName = inner.name as string;
  const projColor = inner.color as string;
  if (!projName || !projColor) {
    respondError("name and color required");
    return;
  }
  // Creation requires a writer role (viewers/non-members can't create).
  const cpRole = await pg.getMemberRole(workspaceId, userId);
  if (!cpRole || cpRole === "viewer") {
    respondError("you can't create projects in this workspace");
    return;
  }
  const proj = await pg.createProject(randomUUID(), workspaceId, projName, projColor);
  // Auto-provision the partner Tasks-project (+ default states) so the Tasks side
  // is never lazily missing. Best-effort + idempotent: a failure here must not
  // fail the chat-project create — log and continue.
  try {
    await pg.provisionTasksProject(workspaceId, proj.id, projName);
  } catch (err) {
    console.error("[create_project] tasks-project provisioning failed (continuing)", {
      workspaceId,
      chatProjectId: proj.id,
      err,
    });
  }
  respond("cyborg:create_project_response", { project: proj });
}

export async function handleUpdateProject(
  ctx: GuestHandlerCtx,
  inner: Record<string, unknown>,
): Promise<void> {
  const { pg, userId, workspaceId, respond, respondError } = ctx;
  if (!workspaceId) {
    respondError("workspaceId required");
    return;
  }
  const projId = inner.projectId as string;
  const updName = inner.name as string;
  const updColor = inner.color as string;
  if (!projId || !updName || !updColor) {
    respondError("projectId, name, and color required");
    return;
  }
  // Anchor: project must belong to the asserted workspace, caller a writer.
  const upRole = await pg.getMemberRole(workspaceId, userId);
  if (!upRole || upRole === "viewer") {
    respondError("forbidden");
    return;
  }
  const wsProjects = await pg.getProjects(workspaceId);
  if (!wsProjects.some((p) => p.id === projId)) {
    respondError("project not found");
    return;
  }
  await pg.updateProject(projId, updName, updColor);
  respond("cyborg:update_project_response", { updated: true });
}

export async function handleDeleteProject(
  ctx: GuestHandlerCtx,
  inner: Record<string, unknown>,
): Promise<void> {
  const { pg, userId, workspaceId, respond, respondError } = ctx;
  if (!workspaceId) {
    respondError("workspaceId required");
    return;
  }
  const delProjId = inner.projectId as string;
  if (!delProjId) {
    respondError("projectId required");
    return;
  }
  const dpRole = await pg.getMemberRole(workspaceId, userId);
  if (!dpRole || dpRole === "viewer") {
    respondError("forbidden");
    return;
  }
  const dpProjects = await pg.getProjects(workspaceId);
  if (!dpProjects.some((p) => p.id === delProjId)) {
    respondError("project not found");
    return;
  }
  await pg.deleteProject(delProjId);
  respond("cyborg:delete_project_response", { deleted: true });
}

export async function handleSetChannelProject(
  ctx: GuestHandlerCtx,
  inner: Record<string, unknown>,
): Promise<void> {
  const { pg, userId, workspaceId, respond, respondError } = ctx;
  if (!workspaceId) {
    respondError("workspaceId required");
    return;
  }
  const cpChannelId = inner.channelId as string;
  const cpProjectId = (inner.projectId as string) ?? null;
  if (!cpChannelId) {
    respondError("channelId required");
    return;
  }
  const scpRole = await pg.getMemberRole(workspaceId, userId);
  if (!scpRole || scpRole === "viewer") {
    respondError("forbidden");
    return;
  }
  // Anchor BOTH the channel and (if set) the project to this workspace.
  const scpChannel = await pg.getChannel(cpChannelId);
  if (!scpChannel || scpChannel.workspace_id !== workspaceId) {
    respondError("channel not found");
    return;
  }
  if (cpProjectId) {
    const scpProjects = await pg.getProjects(workspaceId);
    if (!scpProjects.some((p) => p.id === cpProjectId)) {
      respondError("project not found");
      return;
    }
  }
  await pg.setChannelProject(cpChannelId, cpProjectId);
  respond("cyborg:set_channel_project_response", { updated: true });
}

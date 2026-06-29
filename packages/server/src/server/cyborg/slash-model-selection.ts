// Resolves which model a slash AI command (/summarize, /action-items, …) runs on.
//
// Precedence: per-CHANNEL override > WORKSPACE default > auto-resolve. The tricky
// part is CLOUD: a PG-blind daemon can't read channels.slash_command_model /
// workspaces.slash_command_model itself, so the relay forwards both in the
// payload (the channel override on resolvedChannel, the workspace default as
// workspaceSlashModel). A daemon WITH PG reads them directly. Extracted from the
// dispatcher so the precedence is unit-testable.

export interface SlashModel {
  provider: string;
  model: string;
}

// channels/workspaces persist the slash model as a JSON {provider,model} string;
// a missing/corrupt value degrades to null ("inherit / auto-resolve").
export function parseSlashModel(raw: string | null | undefined): SlashModel | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as { provider?: unknown; model?: unknown };
    if (typeof p.provider === "string" && typeof p.model === "string") {
      return { provider: p.provider, model: p.model };
    }
  } catch {
    // fall through — corrupt value behaves as "no override"
  }
  return null;
}

export type SlashSelectionSource = "channel" | "workspace" | "auto";

export interface SlashModelInputs {
  // True when this daemon has shared PG and read the rows itself.
  hasPg: boolean;
  // PG path (raw JSON string from channels.slash_command_model + the already-parsed
  // workspace default from getWorkspaceSlashConfig().model).
  pgChannelModel?: string | null;
  pgWorkspaceModel?: SlashModel | null;
  // Cloud (PG-blind) path: the relay forwards the channel override on
  // resolvedChannel; fall back to the local SQLite row for solo/no-relay. The
  // workspace default arrives pre-parsed in the payload.
  resolvedChannelModel?: string | null;
  localChannelModel?: string | null;
  forwardedWorkspaceModel?: SlashModel | null;
}

export interface SlashModelResolution {
  channelSelection: SlashModel | null;
  workspaceSelection: SlashModel | null;
  selection: SlashModel | null;
  source: SlashSelectionSource;
}

// Precedence: channel override > workspace default > auto.
export function resolveSlashModelSelection(input: SlashModelInputs): SlashModelResolution {
  let channelSelection: SlashModel | null;
  let workspaceSelection: SlashModel | null;
  if (input.hasPg) {
    channelSelection = parseSlashModel(input.pgChannelModel);
    workspaceSelection = input.pgWorkspaceModel ?? null;
  } else {
    // Cloud: prefer the relay-forwarded channel override; fall back to the local row.
    channelSelection = parseSlashModel(input.resolvedChannelModel ?? input.localChannelModel);
    workspaceSelection = input.forwardedWorkspaceModel ?? null;
  }
  const selection = channelSelection ?? workspaceSelection;
  let source: SlashSelectionSource = "auto";
  if (channelSelection) source = "channel";
  else if (workspaceSelection) source = "workspace";
  return { channelSelection, workspaceSelection, selection, source };
}

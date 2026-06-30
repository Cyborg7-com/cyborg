// Role presets over the flat platform-permission toggles (#444, internal docs).
// Pure presentation: each preset maps to the EXISTING cybos.platform_permissions
// array — the data model and the server's enforcement semantics are unchanged
// ("a non-empty list restricts the cybo to those grants; read tools are always
// available", cyborg7-mcp-tools.ts).
//
// Observer needs "deny all gated writes", which an EMPTY list cannot express:
// empty is legacy fail-open (unrestricted) until CYBORG7_STRICT_TOOL_PERMISSIONS
// flips (#206). The sentinel leans on the existing semantics instead — a
// non-empty list that contains no WRITE-gating permission id denies every gated
// write tool while read tools and reactions stay available.
//
// The sentinel value must come from the server's PLATFORM_PERMISSIONS enum
// (create/update messages validate with z.enum, cyborg-messages.ts:8).
// "read_messages" is ideal: kept in the enum for backward compatibility but no
// longer read as a tool gate (#270 moved read/react gating to channel
// membership, cybo-types.ts:37-51) — so it restricts without granting.

export const READ_ONLY_SENTINEL = "read_messages";

export interface PlatformPermissionOption {
  id: string;
  label: string;
  sub: string;
}

export const PLATFORM_PERMISSION_OPTIONS: PlatformPermissionOption[] = [
  { id: "send_message", label: "Post messages", sub: "Send messages in channels and DMs" },
  { id: "create_task", label: "Manage tasks", sub: "Create and update tasks" },
  { id: "manage_channels", label: "Manage channels", sub: "Create channels and edit membership" },
  { id: "spawn_agents", label: "Spawn agents", sub: "Delegate work to other agents" },
  { id: "manage_self", label: "Edit own personality", sub: "Let this cybo rewrite its own soul" },
];

export type PermissionPresetId = "observer" | "collaborator" | "operator";

export interface PermissionPreset {
  id: PermissionPresetId;
  label: string;
  sub: string;
  permissions: string[];
}

export const PERMISSION_PRESETS: PermissionPreset[] = [
  {
    id: "observer",
    label: "Observer",
    sub: "Reads and reacts — never posts or changes anything",
    permissions: [READ_ONLY_SENTINEL],
  },
  {
    id: "collaborator",
    label: "Collaborator",
    sub: "Posts messages and manages tasks",
    permissions: ["send_message", "create_task"],
  },
  {
    id: "operator",
    label: "Operator",
    sub: "Everything — posts, tasks, channels, spawning agents",
    permissions: PLATFORM_PERMISSION_OPTIONS.map((o) => o.id),
  },
];

export function presetPermissions(id: PermissionPresetId): string[] {
  const preset = PERMISSION_PRESETS.find((p) => p.id === id);
  return preset ? [...preset.permissions] : [];
}

// Which preset does a stored grant list correspond to? "custom" when it matches
// none — including the legacy empty list, which is fail-open (unrestricted)
// rather than Observer, so it must surface as Customize, never as a preset.
export function derivePreset(permissions: readonly string[]): PermissionPresetId | "custom" {
  const set = new Set(permissions);
  for (const preset of PERMISSION_PRESETS) {
    if (set.size === preset.permissions.length && preset.permissions.every((p) => set.has(p))) {
      return preset.id;
    }
  }
  return "custom";
}

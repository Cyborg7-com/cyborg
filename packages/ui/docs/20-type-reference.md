# Type Reference

All TypeScript types exported from the UI package.

## Core types (`lib/core/types.ts`)

### CyborgUser

```typescript
interface CyborgUser {
  id: string;
  email: string;
  name: string | null;
}
```

### Workspace

```typescript
interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  role: "owner" | "admin" | "member" | "viewer";
  settings: WorkspaceSettings;
  createdAt: number;
}

interface WorkspaceSettings {
  defaultAgentModel?: string;
  maxAgents?: number;
  allowMemberAgentCreation?: boolean;
  agentPermissionMode?: "ask" | "auto";
}
```

### Channel

```typescript
interface Channel {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  instructions: string | null;
  createdBy: string;
  createdAt: number;
}
```

### Message

```typescript
interface Message {
  id: string;
  channelId: string | null;
  fromId: string;
  fromType: "human" | "agent";
  fromName?: string;
  toId?: string | null;
  text: string;
  mentions?: string[] | null;
  parentId?: string | null;
  seq: number;
  createdAt: number;
}
```

### Task

```typescript
interface Task {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  status: string;
  assigneeId: string | null;
  createdBy: string;
  dueAt: number | null;
  result?: string | null;
  createdAt: number;
  updatedAt: number;
}
```

### Membership / WorkspaceMember

```typescript
interface Membership {
  workspaceId: string;
  userId: string;
  role: string;
  joinedAt: number;
}

interface WorkspaceMember {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  joinedAt: number;
}
```

### Events

```typescript
interface TypingEvent {
  workspaceId: string;
  channelId: string;
  fromId: string;
  fromName?: string;
}

interface ReactionEvent {
  workspaceId: string;
  messageId: string;
  fromId: string;
  emoji: string;
}
```

## Plugin types (`lib/core/plugin.svelte.ts`)

### RailItem

```typescript
interface RailItem {
  id: string;
  label: string;
  icon: string;
  activeIcon?: string;
  path: string;
  pathMatch?: string[];
  position: "nav" | "bottom";
  order: number;
  badge?: number;
}
```

### SlackShellConfig

```typescript
interface SlackShellConfig {
  appName: string;
  rail: { showLabels: boolean };
  sidebar: {
    channels: boolean;
    privateChannels: boolean;
    members: boolean;
    settings: boolean;
  };
  features: { tasks: boolean; agents: boolean };
  railItems: RailItem[];
  toolbar: ToolbarItem[];
  settingsTabs: SettingsTab[];
}
```

### SidebarSection / SidebarItem / SidebarAction

```typescript
interface SidebarSection {
  id: string;
  label: string;
  items: SidebarItem[];
  actions?: SidebarAction[];
}

interface SidebarItem {
  id: string;
  label: string;
  href?: string;
  icon?: Component;
  badge?: string | number;
  status?: "online" | "idle" | "error" | "offline";
  active?: boolean;
  onclick?: () => void;
}

interface SidebarAction {
  label: string;
  icon?: string;
  onclick: () => void;
}
```

### ToolbarItem / SettingsTab

```typescript
interface ToolbarItem {
  id: string;
  label: string;
  icon?: string;
  badge?: string | number;
  variant?: "default" | "success" | "warning" | "error";
  tooltip?: string;
  onclick?: () => void;
}

interface SettingsTab {
  id: string;
  label: string;
  href: string;
  icon?: string;
}
```

### SlackPlugin

```typescript
interface SlackPlugin {
  id: string;
  name: string;
  railItems?: RailItem[];
  sidebarSections?: () => SidebarSection[];
  settingsTabs?: SettingsTab[];
  onRegister?: () => void;
}
```

## Agent types (`lib/plugins/agents/types.ts`)

### Agent

```typescript
interface Agent {
  agentId: string;
  provider: string;
  lifecycle: string;
  channelId?: string | null;
  model?: string | null;
  modeId?: string | null;
  cwd?: string | null;
  daemonLocal?: boolean;
}
```

### AgentUsage

```typescript
interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}
```

### ToolCallDetail

```typescript
type ToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: "edit"; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: string;
      content?: string;
      filePaths?: string[];
      numFiles?: number;
      numMatches?: number;
    }
  | { type: "fetch"; url: string; result?: string; code?: number; bytes?: number }
  | { type: "sub_agent"; subAgentType?: string; description?: string; log: string }
  | { type: "plain_text"; label?: string; text?: string }
  | { type: "plan"; text: string }
  | { type: "worktree_setup"; worktreePath: string; branchName: string; log: string }
  | { type: "unknown"; input: unknown; output: unknown };
```

### AgentTimelineItem

```typescript
type AgentTimelineItem =
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string }
  | ToolCallItem
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string }
  | CompactionItem;
```

### Permission types

```typescript
interface AgentPermissionRequest {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  detail?: ToolCallDetail;
  actions?: AgentPermissionAction[];
}

interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
}

type AgentPermissionResponse =
  | { behavior: "allow"; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; selectedActionId?: string; message?: string; interrupt?: boolean };
```

### AgentEvent

```typescript
type AgentEvent =
  | { type: "thread_started"; sessionId: string; provider: string }
  | { type: "turn_started"; provider: string; turnId?: string }
  | { type: "turn_completed"; provider: string; usage?: AgentUsage; turnId?: string }
  | {
      type: "turn_failed";
      provider: string;
      error: string;
      code?: string;
      turnId?: string;
      // Optional: daemon-classified provider gate (usage_gated / auth_invalid /
      // expired / rate_limited) so the chat shows the same remedy as the spawn path.
      reasonKind?: ProviderReasonKind | null;
      unavailableReason?: string | null;
    }
  | { type: "turn_canceled"; provider: string; reason: string; turnId?: string }
  | { type: "timeline"; item: AgentTimelineItem; provider: string; turnId?: string }
  | {
      type: "permission_requested";
      provider: string;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: string;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | { type: "usage_updated"; provider: string; usage: AgentUsage; turnId?: string }
  | { type: "attention_required"; provider: string; reason: string }
  | { type: "model_changed"; provider: string; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "mode_changed";
      provider: string;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "thinking_option_changed"; provider: string; thinkingOptionId: string | null };
```

### Provider types

```typescript
interface ProviderInfo {
  id: string;
  label: string;
  description: string;
  available: boolean;
  models: { id: string; label?: string; isDefault?: boolean }[];
  modes: { id: string; label: string; description: string }[];
  defaultModeId: string | null;
}

interface AgentRuntimeInfo {
  provider: string;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: Record<string, unknown>;
}

interface AgentMode {
  id: string;
  label: string;
  description?: string;
}

interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}
```

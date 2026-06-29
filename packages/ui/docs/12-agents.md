# Agents

Agents are AI assistants that run as child processes of the daemon. The UI provides a rich streaming interface to create agents, send prompts, view their work in real-time, and manage permissions.

## Agent lifecycle

```
create → idle → running → idle
                  │
                  ├─ permission_requested → waiting → running
                  ├─ turn_failed → error
                  └─ canceled → idle
```

### Creating an agent

```typescript
import { createAgent } from "$lib/plugins/agents/state.svelte.js";

const agent = await createAgent("claude", "/path/to/workspace", {
  model: "claude-sonnet-4-6",
  title: "Code reviewer",
});
```

This sends a `cyborg:create_agent` message to the daemon, which spawns the agent process and returns the agent metadata.

### Sending prompts

```typescript
import { sendAgentPrompt } from "$lib/plugins/agents/state.svelte.js";

await sendAgentPrompt(agentId, "Review the latest changes in src/");
```

### Agent type

```typescript
interface Agent {
  agentId: string;
  provider: string; // "claude", "codex", "qwen", etc.
  lifecycle: string; // "running", "idle", "error"
  channelId?: string | null;
  model?: string | null;
  modeId?: string | null;
  cwd?: string | null;
  daemonLocal?: boolean; // Whether the agent runs on this daemon
}
```

## Streaming events

Agent activity streams to the UI via the `agent_stream` event on `CyborgClient`:

```typescript
interface AgentStreamPayload {
  agentId: string;
  workspaceId?: string;
  event: AgentEvent;
}
```

### Event types

| Event                     | Description                             |
| ------------------------- | --------------------------------------- |
| `thread_started`          | Agent session initialized               |
| `turn_started`            | Agent begins processing a prompt        |
| `turn_completed`          | Agent finishes (includes usage stats)   |
| `turn_failed`             | Agent encountered an error              |
| `turn_canceled`           | User or system canceled the turn        |
| `timeline`                | A new item in the agent's activity feed |
| `permission_requested`    | Agent needs user approval for an action |
| `permission_resolved`     | A permission request was answered       |
| `usage_updated`           | Token/cost counters updated             |
| `attention_required`      | Agent needs user attention              |
| `model_changed`           | Agent switched models                   |
| `mode_changed`            | Agent switched modes                    |
| `thinking_option_changed` | Thinking/reasoning level changed        |

### Timeline items

The `timeline` event carries an `AgentTimelineItem`:

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

### Tool calls

Tool calls are the richest timeline item:

```typescript
interface ToolCallItem {
  type: "tool_call";
  callId: string;
  name: string;
  status: "running" | "completed" | "failed" | "canceled";
  detail: ToolCallDetail;
  error: unknown | null;
}
```

Tool call details are discriminated by type:

| Type             | Description             | Key fields                                          |
| ---------------- | ----------------------- | --------------------------------------------------- |
| `shell`          | Shell command execution | `command`, `cwd`, `output`, `exitCode`              |
| `read`           | File read               | `filePath`, `content`, `offset`, `limit`            |
| `edit`           | File edit               | `filePath`, `oldString`, `newString`, `unifiedDiff` |
| `write`          | File write              | `filePath`, `content`                               |
| `search`         | Code search             | `query`, `filePaths`, `numMatches`                  |
| `fetch`          | HTTP fetch              | `url`, `result`, `code`, `bytes`                    |
| `sub_agent`      | Sub-agent delegation    | `subAgentType`, `description`, `log`                |
| `plan`           | Plan output             | `text`                                              |
| `worktree_setup` | Git worktree            | `worktreePath`, `branchName`, `log`                 |
| `plain_text`     | Generic text            | `label`, `text`                                     |
| `unknown`        | Unrecognized tool       | `input`, `output`                                   |

## Permissions

When an agent needs to perform a sensitive action (run a shell command, edit a file, etc.), it sends a permission request:

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
```

The UI renders this as a `PermissionCard` with approve/deny buttons. The user responds:

```typescript
import { respondToPermission } from "$lib/plugins/agents/state.svelte.js";

respondToPermission(agentId, requestId, {
  behavior: "allow",
  selectedActionId: "allow_once",
});
```

## Agent controls

```typescript
cancelAgent(agentId: string): void
// Cancels the current turn

setAgentModel(agentId: string, modelId: string | null): Promise<void>
// Changes the agent's model (e.g., switch from sonnet to opus)

setAgentMode(agentId: string, modeId: string): Promise<void>
// Changes the agent's mode (e.g., "plan" vs "code")

setAgentThinking(agentId: string, thinkingOptionId: string | null): Promise<void>
// Changes the reasoning/thinking level

fetchAgentCommands(agentId: string): Promise<AgentSlashCommand[]>
// Gets available slash commands for the agent
```

## Provider discovery

```typescript
import { fetchProviders, providerState } from "$lib/plugins/agents/state.svelte.js";

await fetchProviders();
// providerState.providers now contains available AI providers

interface ProviderInfo {
  id: string; // "claude", "codex", "qwen"
  label: string;
  description: string;
  available: boolean;
  models: { id: string; label?: string; isDefault?: boolean }[];
  modes: { id: string; label: string; description: string }[];
  defaultModeId: string | null;
}
```

## Agent state

```typescript
class AgentStreamState {
  getTimeline(agentId: string): AgentTimelineItem[];
  getTurnStatus(agentId: string): TurnStatus;
  getPendingPermissions(agentId: string): AgentPermissionRequest[];
  getUsage(agentId: string): AgentUsage | undefined;
  getRuntimeInfo(agentId: string): AgentRuntimeInfo | undefined;
}
```

## Usage tracking

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

## UI components

| Component             | Purpose                                              |
| --------------------- | ---------------------------------------------------- |
| `AgentStreamView`     | Full timeline view with all item types               |
| `AgentComposer`       | Chat input with slash commands, model/mode selectors |
| `PermissionCard`      | Permission request with approve/deny                 |
| `ToolCallDetail`      | Formatted tool call output                           |
| `AgentModeSelector`   | Mode dropdown                                        |
| `AgentModelSelector`  | Model dropdown                                       |
| `SlashCommandPalette` | Autocomplete for `/` commands                        |

## Next steps

- [Tasks](./13-tasks.md) — Task management that agents interact with
- [WebSocket client](./08-websocket-client.md) — Transport layer for agent messages

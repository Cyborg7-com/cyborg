# API Methods

Complete method reference for `SlackClient` and `CyborgClient`.

## SlackClient

### Connection

| Method                | Returns                         | Description                                |
| --------------------- | ------------------------------- | ------------------------------------------ |
| `connect(url, token)` | `Promise<void>`                 | Opens WebSocket, sends hello frame         |
| `disconnect()`        | `void`                          | Closes WebSocket, rejects pending requests |
| `connected`           | `boolean` (getter)              | Whether the WebSocket is open              |
| `authenticate()`      | `Promise<{ user, workspaces }>` | Authenticates with JWT token               |

### Workspaces

| Method                             | Returns                | Description                      |
| ---------------------------------- | ---------------------- | -------------------------------- |
| `fetchWorkspaces()`                | `Promise<Workspace[]>` | List all workspaces for the user |
| `createWorkspace(name, settings?)` | `Promise<Workspace>`   | Create a new workspace           |

### Channels

| Method                                    | Returns              | Description                  |
| ----------------------------------------- | -------------------- | ---------------------------- |
| `fetchChannels(workspaceId)`              | `Promise<Channel[]>` | List channels in a workspace |
| `createChannel(workspaceId, name, opts?)` | `Promise<Channel>`   | Create a channel             |

`opts`: `{ description?: string, isPrivate?: boolean, instructions?: string }`

### Messages

| Method                                                 | Returns                          | Description            |
| ------------------------------------------------------ | -------------------------------- | ---------------------- |
| `fetchMessages(workspaceId, channelId, opts?)`         | `Promise<{ messages, hasMore }>` | Fetch message history  |
| `sync(workspaceId, lastSeq)`                           | `Promise<{ mode, messages }>`    | Sync missed messages   |
| `sendMessage(workspaceId, channelId, text, mentions?)` | `void`                           | Send a channel message |
| `sendDm(workspaceId, toId, text)`                      | `void`                           | Send a direct message  |
| `sendTyping(workspaceId, channelId)`                   | `void`                           | Send typing indicator  |
| `sendReaction(workspaceId, messageId, emoji)`          | `void`                           | React to a message     |

`fetchMessages opts`: `{ before?: string, limit?: number }`

### Members

| Method                                    | Returns                      | Description            |
| ----------------------------------------- | ---------------------------- | ---------------------- |
| `listMembers(workspaceId)`                | `Promise<WorkspaceMember[]>` | List workspace members |
| `inviteMember(workspaceId, email, role?)` | `Promise<Membership>`        | Invite by email        |
| `removeMember(workspaceId, userId)`       | `Promise<boolean>`           | Remove a member        |
| `updateRole(workspaceId, userId, role)`   | `Promise<boolean>`           | Change member role     |

### Tasks

| Method                                     | Returns           | Description   |
| ------------------------------------------ | ----------------- | ------------- |
| `fetchTasks(workspaceId, opts?)`           | `Promise<Task[]>` | List tasks    |
| `createTask(workspaceId, title, opts?)`    | `Promise<Task>`   | Create a task |
| `updateTask(workspaceId, taskId, updates)` | `Promise<Task>`   | Update a task |

`fetchTasks opts`: `{ status?: string, assigneeId?: string }`
`createTask opts`: `{ description?: string, assigneeId?: string, dueAt?: number }`
`updateTask updates`: `{ status?, title?, description?, assigneeId?, result? }`

### Events

| Method               | Returns      | Description                              |
| -------------------- | ------------ | ---------------------------------------- |
| `on(event, handler)` | `() => void` | Subscribe (returns unsubscribe function) |

## CyborgClient

Extends `SlackClient` with all methods above, plus:

### Agent lifecycle

| Method                                           | Returns            | Description         |
| ------------------------------------------------ | ------------------ | ------------------- |
| `createAgent(workspaceId, provider, cwd, opts?)` | `Promise<Agent>`   | Spawn an agent      |
| `listAgents(workspaceId)`                        | `Promise<Agent[]>` | List active agents  |
| `cancelAgent(workspaceId, agentId)`              | `void`             | Cancel current turn |

`createAgent opts`: `{ model?: string, systemPrompt?: string, channelId?: string, title?: string }`

### Agent interaction

| Method                                                           | Returns                        | Description               |
| ---------------------------------------------------------------- | ------------------------------ | ------------------------- |
| `sendAgentPrompt(workspaceId, agentId, prompt)`                  | `Promise<void>`                | Send a prompt             |
| `respondToPermission(workspaceId, agentId, requestId, response)` | `void`                         | Answer permission request |
| `listAgentCommands(workspaceId, agentId)`                        | `Promise<AgentSlashCommand[]>` | Get available commands    |

### Agent configuration

| Method                                                     | Returns         | Description           |
| ---------------------------------------------------------- | --------------- | --------------------- |
| `setAgentModel(workspaceId, agentId, modelId)`             | `Promise<void>` | Change model          |
| `setAgentMode(workspaceId, agentId, modeId)`               | `Promise<void>` | Change mode           |
| `setAgentThinking(workspaceId, agentId, thinkingOptionId)` | `Promise<void>` | Change thinking level |

### Provider discovery

| Method            | Returns                   | Description                 |
| ----------------- | ------------------------- | --------------------------- |
| `listProviders()` | `Promise<ProviderInfo[]>` | List available AI providers |

### Additional events

| Event          | Payload              | Description           |
| -------------- | -------------------- | --------------------- |
| `agent_stream` | `AgentStreamPayload` | Agent streaming event |

## State actions

High-level actions exported from `$lib/state/app.svelte.js`:

| Action                           | Returns                | Description                           |
| -------------------------------- | ---------------------- | ------------------------------------- |
| `connectToServer(url, token)`    | `Promise<void>`        | Connect + authenticate + save session |
| `disconnectFromServer()`         | `void`                 | Disconnect + clear all state          |
| `getSavedSession()`              | `SavedSession \| null` | Restore from localStorage             |
| `clearSavedSession()`            | `void`                 | Remove saved session                  |
| `selectWorkspace(workspace)`     | `Promise<void>`        | Load workspace data                   |
| `selectChannel(channelId)`       | `Promise<void>`        | Load channel messages                 |
| `loadMoreMessages()`             | `Promise<void>`        | Paginate older messages               |
| `sendMessage(text, mentions?)`   | `void`                 | Send to active channel                |
| `sendTypingIndicator()`          | `void`                 | Send typing to active channel         |
| `inviteMember(email, role?)`     | `Promise<void>`        | Invite + refresh members              |
| `removeMember(userId)`           | `Promise<void>`        | Remove + update local state           |
| `updateMemberRole(userId, role)` | `Promise<void>`        | Update + refresh local                |

Agent-specific actions from `$lib/plugins/agents/state.svelte.js`:

| Action                                              | Returns                        | Description               |
| --------------------------------------------------- | ------------------------------ | ------------------------- |
| `createAgent(provider, cwd, opts?)`                 | `Promise<Agent>`               | Create + add to workspace |
| `sendAgentPrompt(agentId, prompt)`                  | `Promise<void>`                | Send prompt               |
| `respondToPermission(agentId, requestId, response)` | `void`                         | Answer permission         |
| `cancelAgent(agentId)`                              | `void`                         | Cancel turn               |
| `setAgentModel(agentId, modelId)`                   | `Promise<void>`                | Change model              |
| `setAgentMode(agentId, modeId)`                     | `Promise<void>`                | Change mode               |
| `setAgentThinking(agentId, thinkingOptionId)`       | `Promise<void>`                | Change thinking           |
| `fetchProviders()`                                  | `Promise<void>`                | Load available providers  |
| `fetchAgentCommands(agentId)`                       | `Promise<AgentSlashCommand[]>` | Get commands              |

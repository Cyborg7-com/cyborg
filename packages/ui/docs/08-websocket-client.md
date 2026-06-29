# WebSocket Client

The UI communicates with the daemon through a typed WebSocket client. There are two classes:

- **`SlackClient`** — Base client with workspace, channel, message, member, and task operations
- **`CyborgClient`** — Extends `SlackClient` with agent-specific methods and streaming

## SlackClient

The base transport layer (`lib/core/client.ts`).

### Connection

```typescript
const client = new SlackClient();

await client.connect("ws://localhost:3000", token);
// Opens WebSocket, sends hello frame, resolves on open

client.disconnect();
// Closes WebSocket, rejects pending requests, stops reconnection
```

### Protocol

All messages are wrapped in a session envelope:

```json
{
  "type": "session",
  "message": {
    "type": "cyborg:fetch_channels",
    "requestId": "req_1_1716580000000",
    "workspaceId": "ws_123"
  }
}
```

The `hello` frame is sent unwrapped on connection:

```json
{
  "type": "hello",
  "clientId": "cyborg-ui-1716580000000",
  "clientType": "browser",
  "protocolVersion": 1
}
```

### Request/response

Methods that need a response use `request<T>(type, params)`, which:

1. Generates a unique `requestId`
2. Sends the message
3. Returns a `Promise<T>` that resolves when the daemon responds with the same `requestId`
4. Times out after 15 seconds if no response arrives

### Fire-and-forget

Methods like `sendMessage()` and `sendTyping()` use `send()` — no `requestId`, no response expected.

### Methods

#### Authentication

```typescript
authenticate(): Promise<{
  user: { id: string; email: string; name: string | null };
  workspaces: { id: string; name: string; role: string }[];
}>
```

#### Workspaces

```typescript
fetchWorkspaces(): Promise<Workspace[]>
createWorkspace(name: string, settings?: Record<string, unknown>): Promise<Workspace>
```

#### Channels

```typescript
fetchChannels(workspaceId: string): Promise<Channel[]>
createChannel(workspaceId: string, name: string, opts?: {
  description?: string;
  isPrivate?: boolean;
  instructions?: string;
}): Promise<Channel>
```

#### Messages

```typescript
fetchMessages(workspaceId: string, channelId: string, opts?: {
  before?: string;
  limit?: number;
}): Promise<{ messages: Message[]; hasMore: boolean }>

sync(workspaceId: string, lastSeq: number): Promise<{
  mode: "delta" | "snapshot";
  messages: Message[];
}>
```

#### Real-time messaging (fire-and-forget)

```typescript
sendMessage(workspaceId: string, channelId: string, text: string, mentions?: string[]): void
sendDm(workspaceId: string, toId: string, text: string): void
sendTyping(workspaceId: string, channelId: string): void
sendReaction(workspaceId: string, messageId: string, emoji: string): void
```

#### Members

```typescript
inviteMember(workspaceId: string, email: string, role?: string): Promise<Membership>
removeMember(workspaceId: string, userId: string): Promise<boolean>
updateRole(workspaceId: string, userId: string, role: string): Promise<boolean>
listMembers(workspaceId: string): Promise<WorkspaceMember[]>
```

#### Tasks

```typescript
createTask(workspaceId: string, title: string, opts?: {
  description?: string;
  assigneeId?: string;
  dueAt?: number;
}): Promise<Task>

updateTask(workspaceId: string, taskId: string, updates: {
  status?: string;
  title?: string;
  description?: string;
  assigneeId?: string | null;
  result?: string;
}): Promise<Task>

fetchTasks(workspaceId: string, opts?: {
  status?: string;
  assigneeId?: string;
}): Promise<Task[]>
```

### Events

Subscribe to real-time events:

```typescript
const unsub = client.on("channel_message", (msg: Message) => {
  console.log("New message:", msg.text);
});

// Later:
unsub(); // Unsubscribe
```

Available events:

| Event             | Payload             | Trigger                     |
| ----------------- | ------------------- | --------------------------- |
| `channel_message` | `Message`           | Someone sends a message     |
| `dm`              | `Message`           | Someone sends a DM          |
| `typing`          | `TypingEvent`       | Someone starts typing       |
| `reaction`        | `ReactionEvent`     | Someone reacts to a message |
| `error`           | `{ code, message }` | Server error                |
| `connection`      | `{ status }`        | Connection state change     |

### Reconnection

If the WebSocket closes unexpectedly:

1. Client emits `connection: "reconnecting"`
2. Waits with exponential backoff: 1s, 2s, 4s, 8s, ... up to 30s
3. Attempts reconnection up to 10 times
4. After 10 failures, emits `connection: "disconnected"` and stops

Intentional disconnections (calling `disconnect()`) do not trigger reconnection.

## CyborgClient

Extends `SlackClient` with agent operations (`lib/ws-client.ts`).

### Agent methods

```typescript
createAgent(workspaceId: string, provider: string, cwd: string, opts?: {
  model?: string;
  systemPrompt?: string;
  channelId?: string;
  title?: string;
}): Promise<Agent>

listAgents(workspaceId: string): Promise<Agent[]>
listProviders(): Promise<ProviderInfo[]>

sendAgentPrompt(workspaceId: string, agentId: string, prompt: string): Promise<void>
respondToPermission(workspaceId: string, agentId: string, requestId: string, response: AgentPermissionResponse): void
cancelAgent(workspaceId: string, agentId: string): void

setAgentModel(workspaceId: string, agentId: string, modelId: string | null): Promise<void>
setAgentMode(workspaceId: string, agentId: string, modeId: string): Promise<void>
setAgentThinking(workspaceId: string, agentId: string, thinkingOptionId: string | null): Promise<void>
listAgentCommands(workspaceId: string, agentId: string): Promise<AgentSlashCommand[]>
```

### Agent streaming

`CyborgClient` overrides `handleExtensionMessage()` to catch `agent_stream` and `cyborg:agent_stream` messages, emitting them as `agent_stream` events:

```typescript
client.on("agent_stream", (payload: AgentStreamPayload) => {
  // payload.agentId — which agent
  // payload.event — the event (timeline, permission_requested, usage_updated, etc.)
});
```

### Extending further

To add custom message types:

```typescript
class MyClient extends CyborgClient {
  protected override handleExtensionMessage(
    type: string,
    payload: Record<string, unknown> | undefined,
  ): boolean {
    if (type === "my_custom_event") {
      this.emit("my_custom", payload);
      return true; // handled
    }
    return super.handleExtensionMessage(type, payload);
  }
}
```

## Next steps

- [State management](./07-state-management.md) — How client events feed into reactive state
- [Agents](./12-agents.md) — Agent streaming protocol in detail

# State Management

All state is managed with Svelte 5 reactive classes — no stores, no external state library. Each state domain is a class with `$state` fields and `$derived` getters, exported as singleton instances.

## Core state classes

### AuthState

Tracks the authenticated user and their token.

```typescript
class AuthState {
  user: CyborgUser | null; // { id, email, name }
  token: string | null;

  get authenticated(): boolean; // true when both user and token are set
}

export const authState: AuthState;
```

### ConnectionState

Tracks the WebSocket connection status.

```typescript
class ConnectionState {
  status: "disconnected" | "connected" | "reconnecting";
  error: string | null;
}

export const connectionState: ConnectionState;
```

### WorkspaceState

Tracks the current workspace and its data.

```typescript
class WorkspaceState {
  current: Workspace | null; // Currently selected workspace
  list: Workspace[]; // All workspaces the user belongs to
  channels: Channel[]; // Channels in the current workspace
  tasks: Task[]; // Tasks in the current workspace
  agents: Agent[]; // Active agents (typed by consumer plugin)
  members: WorkspaceMember[]; // Members of the current workspace

  get activeChannel(): Channel | null; // Derived from channelState.activeId
}

export const workspaceState: WorkspaceState;
```

### ChannelState

Tracks the active channel's messages and typing indicators.

```typescript
class ChannelState {
  activeId: string | null; // Currently selected channel ID
  messages: Message[]; // Messages sorted by sequence number
  hasMore: boolean; // Whether older messages exist
  loading: boolean; // Whether messages are being fetched
  typing: TypingEvent[]; // Active typing indicators

  addMessage(msg: Message): void; // Deduplicates + sorts
  prependMessages(msgs: Message[], hasMore: boolean): void;
  addTyping(event: TypingEvent): void; // Auto-expires after 3 seconds
  clear(): void;
}

export const channelState: ChannelState;
```

## State actions

State actions are standalone functions that orchestrate client calls and state mutations.

### Connection

```typescript
connectToServer(url: string, token: string): Promise<void>
// Opens WebSocket, authenticates, populates authState + workspaceState.list
// Saves session to localStorage for auto-restore on reload

getSavedSession(): SavedSession | null
// Returns { url, token } from localStorage, or null

clearSavedSession(): void
// Removes saved session from localStorage

disconnectFromServer(): void
// Closes WebSocket, clears all state, removes saved session
```

### Workspace

```typescript
selectWorkspace(workspace: Workspace): Promise<void>
// Sets workspaceState.current
// Fetches channels + tasks in parallel
// Fetches members async (non-blocking)
// Auto-selects the first channel
```

### Channel

```typescript
selectChannel(channelId: string): Promise<void>
// Sets channelState.activeId
// Fetches last 50 messages

loadMoreMessages(): Promise<void>
// Fetches older messages (before the oldest current message)
// Prepends to channelState.messages, updates hasMore
```

### Messaging

```typescript
sendMessage(text: string, mentions?: string[]): void
// Sends a channel message via WebSocket (fire-and-forget)

sendTypingIndicator(): void
// Sends a typing event for the current channel
```

### Members

```typescript
inviteMember(email: string, role?: "admin" | "member" | "viewer"): Promise<void>
removeMember(userId: string): Promise<void>
updateMemberRole(userId: string, role: "admin" | "member" | "viewer"): Promise<void>
```

## Event wiring

The core client emits events that automatically update state:

```
coreClient "channel_message" → channelState.addMessage()
coreClient "typing"          → channelState.addTyping()
coreClient "connection"      → connectionState.status
coreClient "error"           → connectionState.error
```

This wiring happens at module initialization — no manual subscription needed.

## Plugin state: AgentStreamState

The agents plugin adds its own state class:

```typescript
class AgentStreamState {
  entries: Map<string, StreamEntry>; // agentId → stream data

  getTimeline(agentId: string): AgentTimelineItem[];
  getTurnStatus(agentId: string): TurnStatus;
  getPendingPermissions(agentId: string): AgentPermissionRequest[];
  getUsage(agentId: string): AgentUsage | undefined;
  getRuntimeInfo(agentId: string): AgentRuntimeInfo | undefined;
}

export const agentStreamState: AgentStreamState;
```

## Preferences

Theme preferences are managed separately:

```typescript
class PreferencesState {
  theme: "dark" | "light" | "system";
  readonly resolvedTheme: "dark" | "light"; // Resolves "system" to actual

  setTheme(value: "dark" | "light" | "system"): void;
}

export const preferencesState: PreferencesState;
```

Theme changes persist to `localStorage` and apply the `data-theme` attribute to `<html>`.

## Why classes, not stores

Svelte 5 runes make classes reactive without wrapping. A `$state` field on a class instance triggers re-renders in any component that reads it. This gives us:

- Encapsulated state with methods (e.g., `channelState.addMessage()`)
- Derived values that update automatically (e.g., `workspaceState.activeChannel`)
- No subscription boilerplate — just read the property in a template

## Next steps

- [WebSocket client](./08-websocket-client.md) — The transport layer that feeds state
- [Agents](./12-agents.md) — Agent-specific state and events

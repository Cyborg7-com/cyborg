# Messaging

Messaging is the core interaction in the collaboration shell. Messages flow between humans and agents in channels, persisted by the daemon and distributed via the relay.

## Message type

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
  parentId?: string | null; // Thread parent (future)
  seq: number; // Sequence number for ordering
  createdAt: number; // Unix timestamp
}
```

Messages are ordered by `seq` (sequence number), not by timestamp. This ensures consistent ordering across distributed daemons even if clocks drift.

## Sending messages

From any component:

```typescript
import { sendMessage } from "$lib/state/app.svelte.js";

sendMessage("Hello, world!");
sendMessage("Hey @alice", ["user_alice_id"]);
```

`sendMessage()` is a fire-and-forget operation — it sends the message via WebSocket and doesn't wait for confirmation. The message appears in the UI when the daemon broadcasts it back.

Under the hood, this calls `coreClient.sendMessage(workspaceId, channelId, text, mentions)`.

## Receiving messages

New messages arrive via the `channel_message` event on the WebSocket client. The core state module handles this automatically:

```typescript
coreClient.on("channel_message", (msg) => {
  if (msg.channelId === channelState.activeId) {
    channelState.addMessage(msg);
  }
});
```

`addMessage()` deduplicates (by `id`) and sorts (by `seq`) before updating the reactive array.

## Message history

When a channel is selected, the last 50 messages are fetched:

```typescript
const { messages, hasMore } = await coreClient.fetchMessages(workspaceId, channelId, { limit: 50 });
```

The `hasMore` flag indicates whether older messages exist.

## Pagination

Older messages are loaded on scroll-to-top:

```typescript
import { loadMoreMessages } from "$lib/state/app.svelte.js";

await loadMoreMessages();
// Fetches 50 messages before the oldest current message
// Prepends to channelState.messages
// Updates channelState.hasMore
```

This is guarded: it won't fire if there are no more messages, if a load is already in progress, or if no channel is selected.

## Typing indicators

### Sending

```typescript
import { sendTypingIndicator } from "$lib/state/app.svelte.js";

sendTypingIndicator();
```

The `MessageInput` component calls this on keydown (debounced). It sends a `cyborg:typing` event to the daemon, which broadcasts it to all workspace members.

### Receiving

Incoming typing events update `channelState.typing`:

```typescript
coreClient.on("typing", (event) => {
  if (event.channelId === channelState.activeId && event.fromId !== authState.user?.id) {
    channelState.addTyping(event);
  }
});
```

Each typing indicator auto-expires after 3 seconds. The `TypingEvent` includes:

```typescript
interface TypingEvent {
  workspaceId: string;
  channelId: string;
  fromId: string;
  fromName?: string;
}
```

## Reactions

```typescript
coreClient.sendReaction(workspaceId, messageId, emoji);
```

Reactions are fire-and-forget. Incoming reactions arrive via the `reaction` event.

## Sync

For reconnection scenarios, the client can sync missed messages:

```typescript
const { mode, messages } = await coreClient.sync(workspaceId, lastSeq);
// mode: "delta" (only new messages) or "snapshot" (full history)
```

## UI components

| Component       | Responsibility                                                |
| --------------- | ------------------------------------------------------------- |
| `MessageList`   | Scrollable message container, infinite scroll, loading states |
| `MessageBubble` | Individual message with avatar, name, time, text              |
| `MessageInput`  | Text input with send-on-enter, typing indicators              |

## Next steps

- [Agents](./12-agents.md) — Agent messages and streaming events
- [Component catalog](./09-component-catalog.md) — Message component details

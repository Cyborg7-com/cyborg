# Extending the Client

The WebSocket client is designed for extension. `SlackClient` provides the base transport; `CyborgClient` extends it with agent operations. You can extend further for custom features.

## Extension pattern

### Subclassing

```typescript
import { CyborgClient } from "$lib/ws-client.js";

interface MyEventMap extends CyborgEventMap {
  my_event: { data: string };
}

class MyClient extends CyborgClient {
  // Add custom methods
  async fetchAnalytics(workspaceId: string): Promise<AnalyticsData> {
    return this.request<AnalyticsData>("my:fetch_analytics", { workspaceId });
  }

  // Handle custom incoming messages
  protected override handleExtensionMessage(
    type: string,
    payload: Record<string, unknown> | undefined,
  ): boolean {
    if (type === "my:analytics_update") {
      this.emit("my_event", payload as unknown as { data: string });
      return true; // consumed
    }
    return super.handleExtensionMessage(type, payload);
  }
}
```

### Using the subclass

Replace the client singleton in your app initialization:

```typescript
// In your app setup
const myClient = new MyClient();

// Subscribe to custom events
myClient.on("my_event", (data) => {
  console.log("Analytics update:", data);
});
```

## Adding custom message types

The daemon protocol uses typed messages with a `type` field. To add a new message type:

### Client side

1. Define the request/response types
2. Add a method to your client subclass
3. Override `handleExtensionMessage()` for incoming events

### Daemon side

1. Add a handler in `packages/server/src/server/cyborg/` (NOT in Paseo's code)
2. Register the handler in `session.ts` for the `cyborg:*` namespace

### Protocol convention

Custom message types should use a namespace prefix:

```
cyborg:fetch_analytics      → Cyborg7 core
my_plugin:custom_event      → Plugin-specific
```

All messages are wrapped in the session envelope:

```json
{
  "type": "session",
  "message": {
    "type": "my_plugin:custom_event",
    "requestId": "req_42_1716580000000",
    "workspaceId": "ws_123",
    "data": { ... }
  }
}
```

## Adding custom state

Follow the pattern from the agents plugin:

```typescript
// my-plugin/state.svelte.ts
class MyPluginState {
  data: MyData[] = $state([]);
  loading = $state(false);

  update(newData: MyData[]) {
    this.data = newData;
  }
}

export const myPluginState = new MyPluginState();
```

Wire it to client events:

```typescript
myClient.on("my_event", (payload) => {
  myPluginState.update(payload.data);
});
```

## Adding custom components

Register a plugin to add UI elements:

```typescript
import { pluginRegistry } from "$lib/core/plugin.svelte.js";

pluginRegistry.register({
  id: "my-plugin",
  name: "My Plugin",
  railItems: [
    {
      id: "analytics",
      label: "Analytics",
      icon: `<svg>...</svg>`,
      path: "/analytics",
      position: "nav",
      order: 7,
    },
  ],
  sidebarSections: () => [
    {
      id: "my-section",
      label: "Analytics",
      items: myPluginState.data.map((d) => ({
        id: d.id,
        label: d.name,
        status: d.healthy ? "online" : "error",
      })),
    },
  ],
});
```

Then create the route:

```
src/routes/workspace/[id]/analytics/+page.svelte
```

## Next steps

- [Plugin system](./06-plugin-system.md) — Registration API
- [WebSocket client](./08-websocket-client.md) — Base client reference

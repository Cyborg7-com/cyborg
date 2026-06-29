# Connecting to a Daemon

The UI connects to a Cyborg7 daemon — a local process that manages agents, caches data, and relays messages. The connection uses a single WebSocket with JWT authentication.

## Auth flow

```
1. User enters daemon URL + token on /login
2. connectToServer(url, token) opens WebSocket
3. Client sends "hello" frame
4. Client sends "cyborg:auth" with JWT token
5. Daemon validates token, returns user profile + workspace list
6. Session saved to localStorage for auto-restore
```

### Step 1: Login page

The login page (`/login`) collects:

- **Daemon URL**: `ws://localhost:3000` for local, `wss://relay.example.com` for remote
- **Auth token**: JWT issued by the daemon or an external auth provider

### Step 2: Connection

```typescript
import { connectToServer } from "$lib/state/app.svelte.js";

await connectToServer("ws://localhost:3000", jwtToken);
// Opens WebSocket
// Sends hello frame: { type: "hello", clientId: "...", clientType: "browser", protocolVersion: 1 }
// Authenticates: sends cyborg:auth { token }
// Receives: { user: {...}, workspaces: [...] }
// Populates authState and workspaceState
```

### Step 3: Session persistence

After successful connection, the session is saved:

```typescript
localStorage.setItem("cyborg7-session", JSON.stringify({ url, token }));
```

On page reload, the workspace layout automatically restores the session:

```typescript
const saved = getSavedSession(); // { url, token } from localStorage
if (saved) {
  await connectToServer(saved.url, saved.token);
}
```

### Step 4: Disconnect

```typescript
import { disconnectFromServer } from "$lib/state/app.svelte.js";

disconnectFromServer();
// Closes WebSocket
// Clears all state (auth, workspace, channels, agents)
// Removes session from localStorage
```

## JWT tokens

### Development mode

The daemon uses HMAC-SHA256 with a static secret (`cyborg7-dev-secret-change-in-production`). Tests mint tokens locally:

```typescript
import { createDevToken } from "$lib/test-utils.js";

const token = createDevToken({ userId: "user_1", email: "dev@test.com" });
```

### Production

JWTs should be issued by your auth provider (Auth0, Clerk, custom). The daemon validates the signature and extracts the user identity. Token payload must include `userId` and `email`.

## Reconnection

If the WebSocket closes unexpectedly (network drop, daemon restart), the client reconnects automatically:

1. Emits `connection: "reconnecting"`
2. Exponential backoff: 1s → 2s → 4s → 8s → ... → 30s (max)
3. Up to 10 attempts
4. After 10 failures: emits `connection: "disconnected"` and stops

The `ConnectionStatus` component shows the current state to the user.

## Session restoration in the workspace layout

The workspace layout (`/workspace/[id]/+layout.svelte`) handles direct URL navigation:

```typescript
// If user navigates directly to /workspace/abc123/channel/general
// but isn't connected yet:

const saved = getSavedSession();
if (saved) {
  await connectToServer(saved.url, saved.token);
  const ws = workspaceState.list.find((w) => w.id === wsId);
  if (ws) await selectWorkspace(ws);
}
```

This means bookmarks and shared URLs work — the UI reconnects and navigates to the right place.

## Next steps

- [WebSocket client](./08-websocket-client.md) — Client API reference
- [Shell wrappers](./18-shell-wrappers.md) — Running in Electron, Tauri, or browser

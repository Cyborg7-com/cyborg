# @cyborg7/server

Daemon and cloud relay for Cyborg7. Manages agent processes, WebSocket connections, workspace state, and multi-daemon coordination.

## Structure

```
src/server/
  agent/              # Paseo upstream — agent lifecycle, providers (DO NOT MODIFY)
  cyborg/             # Cyborg7-specific code
    db/
      schema.ts       # Drizzle ORM schema (users, workspaces, channels, messages, etc.)
      pg-sync.ts      # PgSync class — all PostgreSQL CRUD operations
    relay-standalone.ts   # Cloud relay server (Hono HTTP + WS, auth, S3 presign)
    relay-redis.ts        # Redis pub/sub for multi-instance relay
    relay-protocol.ts     # Zod schemas for relay messages
    workspace-relay.ts    # Workspace-aware WebSocket relay
    daemon-relay-client.ts # Outbound relay connection from daemon
    message-router.ts     # Routes messages to local agents or relay
    dispatcher.ts         # CyborgDispatcher — local daemon message handler
    storage.ts            # SQLite local storage (DualStorage wrapper)
    auth.ts               # JWT auth (HMAC-SHA256), scrypt password hashing
    workspace-manager.ts  # Workspace lifecycle and member management
    cyborg-messages.ts    # Zod schemas for cyborg:* message types
  bootstrap.ts        # Daemon initialization (extended for Cyborg7)
  session.ts          # Per-client session state (extended for cyborg:* handlers)
  websocket-server.ts # WebSocket connection management
```

## Two Modes

### Local Daemon

Full Paseo server with SQLite + optional PostgreSQL. Agents run locally. Messages go through `CyborgDispatcher`.

```bash
pnpm dev    # starts on port 6781
```

### Cloud Relay

`relay-standalone.ts` runs on EC2 via tsx (no build). Handles all cloud-mode UI messages by querying PG directly.

```bash
# On the relay host
tsx src/server/cyborg/relay-standalone.ts
# Or via systemd: sudo systemctl restart cyborg7-relay
```

Port 9100. Env vars: `DATABASE_URL`, `RELAY_PORT`, `RELAY_HOST`, `REDIS_URL`, `S3_ASSETS_*`.

## Routing in relay-standalone.ts

Three categories:

1. **`DAEMON_FORWARD_TYPES`** — forwarded to the connected local daemon (agent prompts, cybo CRUD, etc.)
2. **Switch statement** — handled directly via PgSync (channels, members, tasks, daemons, workspaces)
3. **Default** — error ("Unhandled Paseo RPC")

## Database

- **PostgreSQL** (shared): Drizzle ORM schema in `db/schema.ts`. Tables: users, workspaces, workspace_memberships, channels, messages, agents, daemons, projects, tasks.
- **SQLite** (local): Agent metadata, timeline data, offline cache. Via `DualStorage` class.
- **DualStorage**: Auto-detected from `DATABASE_URL`. Solo mode = SQLite only. Connected mode = SQLite cache + PG shared.

## Auth

- JWT tokens (HMAC-SHA256) for both users and daemons
- Password hashing with scrypt (N=16384, r=8, p=1)
- Invited users have `password_hash = NULL` — register endpoint completes registration by setting the password
- Dev secret: `cyborg7-dev-secret-change-in-production`

## Deploy

```bash
scp relay-standalone.ts <relay-host>:/opt/cyborg7/packages/server/src/server/cyborg/
ssh <relay-host> "sudo systemctl restart cyborg7-relay"
```

No build step — tsx reads TypeScript source directly.

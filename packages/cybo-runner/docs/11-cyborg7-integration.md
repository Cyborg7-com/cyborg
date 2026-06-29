# Running Inside Cyborg7

A Cybo can run in two modes. Standalone mode (covered in the rest of this documentation) spawns PI directly. Daemon mode runs inside a Cyborg7 workspace, gaining collaborative capabilities.

## Two execution modes

|               | Standalone          | Daemon (Cyborg7)                                 |
| ------------- | ------------------- | ------------------------------------------------ |
| Command       | `cybo "prompt"`     | `cyborg cybo:spawn --workspace ws_123 --cybo pi` |
| Runtime       | PI via RPC          | Cyborg7 daemon + PI                              |
| Network       | None                | WebSocket relay                                  |
| Storage       | Local (PI sessions) | SQLite + PostgreSQL                              |
| MCP tools     | PI's built-in tools | PI tools + workspace tools                       |
| Collaboration | Single user         | Multi-user, multi-agent                          |

## What the daemon adds

When spawned inside Cyborg7, the daemon:

1. **Resolves the Cybo** — reads `cybo.json` + `soul.md` from storage or registry
2. **Builds the prompt** — combines soul with workspace context
3. **Injects MCP tools** — adds 7 workspace-aware tools the agent can use
4. **Creates an agent** — registers it in the workspace with a unique ID
5. **Bridges streams** — routes agent output to workspace members via WebSocket

## Workspace MCP tools

These tools are injected via `cyborg7-mcp-tools.ts` and are only available in daemon mode:

| Tool              | Description                                         |
| ----------------- | --------------------------------------------------- |
| `send_message`    | Send a message to any channel in the workspace      |
| `channel_history` | Read message history from a channel                 |
| `create_task`     | Create a task in the workspace                      |
| `list_tasks`      | List tasks with optional filters                    |
| `update_task`     | Update task status, assignee, or details            |
| `list_channels`   | List all channels in the workspace                  |
| `roster`          | List all members (humans + agents) in the workspace |

The agent doesn't know about these tools in standalone mode. In daemon mode, they appear as available MCP tools alongside PI's built-in tools.

## Spawning via CLI

```bash
cyborg cybo:spawn --workspace ws_123 --cybo pi
cyborg cybo:spawn --workspace ws_123 --cybo reviewer
```

## Spawning via WebSocket

Send a `cyborg:cybo_spawn` message to the daemon:

```json
{
  "type": "cyborg:cybo_spawn",
  "workspaceId": "ws_123",
  "cyboSlug": "pi"
}
```

## What stays the same

The Cybo's identity (`cybo.json`) and personality (`soul.md`) are identical in both modes. The same agent, the same personality — just with more tools when running inside a workspace.

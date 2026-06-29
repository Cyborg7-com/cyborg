# CLI reference

Cyborg7 ships two command-line tools:

- **`cyborg`** — the workspace and daemon CLI. It talks to a local (or remote) daemon over WebSocket/HTTP to manage daemons, workspaces, channels, messages, agents, [Cybos](./cybos.md), and terminals.
- **`cybo`** — the standalone [Cybo](./cybos.md) runner. It runs a single Cybo persona on your machine, with or without a workspace.

Both are part of this repo (`packages/cli` and `packages/cybo-runner`). This page enumerates the real commands and flags from those packages.

---

## The `cyborg` CLI

`cyborg` is the terminal client for a daemon. The binary is `cyborg` (a `paseo` alias is also installed). Run `cyborg --help` for the live list, or `cyborg <command> --help` for a single command.

### Global options

These apply to most commands:

| Option                  | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `-v, --version`         | Print the CLI version.                                       |
| `-o, --format <format>` | Output format: `table`, `json`, or `yaml` (default `table`). |
| `--json`                | Output in JSON format.                                       |
| `-q, --quiet`           | Minimal output (IDs only).                                   |
| `--no-headers`          | Omit table headers.                                          |
| `--no-color`            | Disable colored output.                                      |

Most workspace-scoped commands also accept daemon-host and auth options:

| Option            | Description                |
| ----------------- | -------------------------- |
| `--host <host>`   | Daemon host to connect to. |
| `--email <email>` | Auth email (dev mode).     |
| `--token <token>` | Auth token.                |

### Auth and status

| Command         | Description                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cyborg login`  | Authenticate to a relay and save credentials locally. Options: `--url <url>` (relay URL), `--email <email>`, `--password <password>` (or set `CYBORG_PASSWORD`), `--token <token>` with `--user-id <id>` to use an existing token. |
| `cyborg whoami` | Show the currently logged-in user (email, userId, relay).                                                                                                                                                                          |
| `cyborg status` | Show auth status and local daemon reachability.                                                                                                                                                                                    |

> Self-hosting note: pass your own relay to `login`, e.g. `cyborg login --url https://relay.example.com`. Credentials are written to `~/.cyborg/auth.json` (override the directory with `CYBORG_HOME`).

### Daemon

`cyborg daemon` manages the local daemon (also reachable as `paseo daemon`). A headless server can run `cyborg daemon start --foreground` as an agent host.

| Command                      | Description                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cyborg daemon start`        | Start the local daemon. Options: `--listen <target>` (host:port, port, or unix socket), `--port <port>`, `--home <path>`, `--foreground`, `--no-relay`, `--relay-use-tls`, `--no-mcp`, `--no-inject-mcp`, `--hostnames <hosts>`. |
| `cyborg daemon status`       | Show local daemon status.                                                                                                                                                                                                        |
| `cyborg daemon doctor`       | Diagnose the daemon: version, relay, online state, update availability.                                                                                                                                                          |
| `cyborg daemon stop`         | Stop the local daemon. Options: `--timeout <seconds>`, `--force`, `--kill-timeout <seconds>`.                                                                                                                                    |
| `cyborg daemon restart`      | Restart the local daemon. Options include `--listen`, `--port`, `--no-relay`, `--no-mcp`, `--no-inject-mcp`, `--hostnames`, `--timeout`, `--force`.                                                                              |
| `cyborg daemon update`       | Update the daemon to the latest code/package and restart it. Options: `--no-build`, `--force`, `--verify-timeout <seconds>`, `--timeout <seconds>`, `--port`, `--listen`.                                                        |
| `cyborg daemon claim`        | Claim this daemon for your logged-in account. Option: `--force` to reassign.                                                                                                                                                     |
| `cyborg daemon set-password` | Prompt for and save a hashed daemon password to `config.json`.                                                                                                                                                                   |
| `cyborg daemon pair`         | Pair this daemon with another device.                                                                                                                                                                                            |

All `daemon` subcommands accept `--home <path>` to point at a non-default daemon home directory.

### Workspaces

| Command                       | Description         |
| ----------------------------- | ------------------- |
| `cyborg ws:list` (alias `ws`) | List workspaces.    |
| `cyborg ws:create <name>`     | Create a workspace. |

### Channels

| Command                                                          | Description                                                                                                       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `cyborg ch:list <workspace-id>` (alias `ch`)                     | List channels in a workspace.                                                                                     |
| `cyborg ch:create <workspace-id> <name>`                         | Create a channel. Options: `--description <text>`, `--private`.                                                   |
| `cyborg ch:model <workspace-id> <channel-id> [provider] [model]` | Set or clear a channel's model override for AI commands (e.g. `/summarize`). `--clear` inherits the user default. |

### Messaging

| Command                                                        | Description                                                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cyborg send <workspace-id> <channel-id> <text>`               | Send a message to a channel. `--mention <id>` mentions a user or agent (repeatable).                                                                       |
| `cyborg listen <workspace-id> <channel-id>`                    | Stream messages from a channel live.                                                                                                                       |
| `cyborg slash <workspace-id> <channel-id> <trigger> [args...]` | Run a channel slash command (e.g. `summarize`) and wait for the result. Options: `--daemon <daemon-id>`, `--no-wait`, `--timeout <seconds>` (default 120). |
| `cyborg slash:model <workspace-id> [provider] [model]`         | Set or clear your preferred model for channel AI commands. `--clear` resets to auto-resolve.                                                               |

### Agents

| Command                                                  | Description                                                                                                                                                                 |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cyborg agent:create <workspace-id>`                     | Create an agent in a workspace. Options: `--provider <provider>` (default `claude`), `--model <model>`, `--channel <channel-id>`, `--system-prompt <text>`, `--cwd <path>`. |
| `cyborg agent:list <workspace-id>` (alias `agents`)      | List agents in a workspace.                                                                                                                                                 |
| `cyborg agent:prompt <workspace-id> <agent-id> <prompt>` | Send a prompt to an agent.                                                                                                                                                  |
| `cyborg agent:stop <workspace-id> <agent-id>`            | Interrupt an agent's active run (clears a stuck or zombie turn).                                                                                                            |
| `cyborg agent:mode <workspace-id> <agent-id> <mode>`     | Set an agent's permission mode (`default`, `plan`, `acceptEdits`, `bypassPermissions`).                                                                                     |
| `cyborg agent:model <workspace-id> <agent-id> <model>`   | Set an agent's model (`default` clears the override).                                                                                                                       |

### Cybos

A [Cybo](./cybos.md) is a reusable agent template (identity + personality + model). These commands manage Cybos inside a workspace:

| Command                                           | Description                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cyborg cybo:create <workspace-id> <slug> <name>` | Create a Cybo (agent template). Personality via `--soul <text>` or `--soul-file <path>`. Options: `--provider <provider>` (default `claude`), `--model <model>`, `--description <text>`, `--avatar <emoji-or-url>`, `--role <role>`. |
| `cyborg cybo:list <workspace-id>` (alias `cybos`) | List Cybos in a workspace.                                                                                                                                                                                                           |
| `cyborg cybo:spawn <workspace-id> <cybo>`         | Spawn an agent from a Cybo (by ID or slug). Options: `--channel <channel-id>`, `--cwd <path>`.                                                                                                                                       |

To run a Cybo outside a workspace, use the `cybo` CLI below. See [Cybos](./cybos.md) for the file format.

### Terminals

`cyborg terminal` manages workspace terminals on a daemon.

| Command                                             | Description                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cyborg terminal ls`                                | List terminals. Options: `--all` (across all workspaces), `--cwd <path>`.                                                                                      |
| `cyborg terminal create`                            | Create a terminal. Options: `--cwd <path>`, `--name <name>`, `--workspace <id>` (binds it to a workspace so it shows in that workspace's UI), `--daemon <id>`. |
| `cyborg terminal capture <terminal-id>`             | Capture terminal output. Options: `--start <n>`, `--end <n>`, `-S, --scrollback`, `--ansi` (preserve escape codes).                                            |
| `cyborg terminal send-keys <terminal-id> <keys...>` | Send keys to a terminal. `-l, --literal` sends raw keys without interpreting special tokens.                                                                   |
| `cyborg terminal kill <terminal-id>`                | Kill a terminal (accepts an ID, ID prefix, or name).                                                                                                           |

---

## The `cybo` CLI

`cybo` runs a single [Cybo](./cybos.md) persona standalone — a `cybo.json` (identity + provider/model) plus a `soul.md` (personality / system prompt). It is a thin layer over [PI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent), which ships bundled inside `cybo`, so the only prerequisite is Node.js.

### Modes

```sh
cybo [@agent] [options] [prompt]   # one-shot: print the response and exit
cybo [@agent] [options]            # interactive REPL (PI's TUI)
```

With a prompt argument, `cybo` runs once and streams the answer. With no prompt, it opens an interactive session.

### Setup and diagnostics

| Command                  | Description                                                                    |
| ------------------------ | ------------------------------------------------------------------------------ |
| `cybo config`            | Open PI's config TUI (sign in once, manage extensions and tools).              |
| `cybo doctor`            | Check the PI binary, auth, and model availability.                             |
| `cybo login [provider]`  | Connect the Cybo runtime to a model provider (subscription OAuth or API keys). |
| `cybo logout [provider]` | Disconnect a provider from the Cybo runtime.                                   |

### Authoring Cybos

| Command              | Description                                                                           |
| -------------------- | ------------------------------------------------------------------------------------- |
| `cybo init`          | Scaffold `cybo.json` + `soul.md` in the current directory.                            |
| `cybo link`          | Register the current cybo in `~/.cybo/agents/` for discovery.                         |
| `cybo unlink [slug]` | Remove a cybo from `~/.cybo/agents/` (defaults to the cybo in the current directory). |
| `cybo list`          | List all registered cybos.                                                            |

### Models

| Command                           | Description                              |
| --------------------------------- | ---------------------------------------- |
| `cybo model`                      | Show the current model from `cybo.json`. |
| `cybo model list`                 | List all available models (via PI).      |
| `cybo model set <provider/model>` | Set the model in `cybo.json`.            |

### Running a Cybo

```sh
cybo @pi "what can you do?"          # invoke a registered cybo by slug
cybo "summarize this repo"           # auto-detect cybo from cwd / default
cybo --thinking high "solve this"    # deeper reasoning
cybo --continue                      # resume the last session
```

Agent selection:

| Form             | Description                                                                       |
| ---------------- | --------------------------------------------------------------------------------- |
| `@slug`          | Use a registered cybo by slug (e.g. `cybo @pi "hello"`).                          |
| `--agent <name>` | Use a registered cybo by slug.                                                    |
| _(none)_         | Auto-detect: the cybo in the current directory, then the default in the registry. |

Run options:

| Option                     | Description                                                             |
| -------------------------- | ----------------------------------------------------------------------- |
| `--model <provider/model>` | Override the model for this run.                                        |
| `--thinking <level>`       | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.     |
| `-c, --continue`           | Continue the previous session.                                          |
| `-r, --resume`             | Select a session to resume.                                             |
| `--session <id>`           | Use a specific session.                                                 |
| `--no-session`             | Ephemeral mode — don't save the session.                                |
| `--pi-command <cmd>`       | Path to the PI binary (default: `PI_COMMAND` env, then the bundled PI). |

Inside an interactive session, `/clear` restarts the session (clears history) and `/exit` or `/quit` exits.

### Maintenance

| Command                         | Description                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `cybo upgrade` (alias `update`) | Update `cybo` to the latest version (re-runs the installer, or `npm i -g @cyborg7/cybo@latest` for npm installs). |
| `cybo uninstall`                | Remove the cybo launcher and app (leaves your `~/.cybo/` agents in place).                                        |
| `cybo --version`, `-v`          | Print the cybo version.                                                                                           |
| `cybo --help`, `-h`             | Show the full command and flag reference.                                                                         |

For the Cybo file format and end-to-end authoring guide, see [Cybos](./cybos.md).

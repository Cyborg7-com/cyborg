# CLI Reference

## Usage

```
cybo [@agent] [options] [prompt]    One-shot mode
cybo [@agent] [options]             Interactive REPL
```

## Commands

### `cybo init`

Create `cybo.json` and `soul.md` interactively in the current directory.

```bash
mkdir my-agent && cd my-agent
cybo init
```

Prompts for: name, slug, role, provider/model. Shows available models via PI.

### `cybo doctor`

Run diagnostics. Checks PI binary, auth, manifest, and model availability.

```bash
cybo doctor
cybo doctor @reviewer
```

### `cybo model`

Show current model from `cybo.json`.

```bash
cybo model
cybo model --agent reviewer
```

### `cybo model list`

List all available providers and models (passthrough to PI).

```bash
cybo model list
```

### `cybo model set <provider/model>`

Update the provider and model in `cybo.json`.

```bash
cybo model set opencode-go/glm-5.1
cybo model set opencode/claude-sonnet-4-6 --agent reviewer
```

### `cybo config`

Open PI's configuration TUI for extensions, tools, and settings.

```bash
cybo config
```

### `cybo link`

Register the current directory's cybo in `~/.cybo/agents/`.

```bash
cd my-agent
cybo link
```

### `cybo unlink [slug]`

Remove a cybo from the registry.

```bash
cybo unlink reviewer
```

Or from inside the agent's directory:

```bash
cybo unlink
```

### `cybo list`

Show all registered agents.

```bash
cybo list
```

## Agent selection

| Method           | Example                        | Use case                          |
| ---------------- | ------------------------------ | --------------------------------- |
| `@slug`          | `cybo @pi "hello"`             | Quick interactive use             |
| `--agent <slug>` | `cybo --agent pi "hello"`      | Scripts, automation               |
| Auto-detect      | `cybo "hello"` (from cybo dir) | Working inside a cybo project     |
| Default          | `cybo "hello"` (from anywhere) | Uses agent with `isDefault: true` |

## Options

| Flag                       | Short | Description                                                        |
| -------------------------- | ----- | ------------------------------------------------------------------ |
| `--agent <slug>`           |       | Select agent by registry name                                      |
| `--model <provider/model>` |       | Override model for this invocation                                 |
| `--pi-command <cmd>`       |       | Path to PI binary (default: `PI_COMMAND` env or `pi`)              |
| `--continue`               | `-c`  | Continue the last session                                          |
| `--resume`                 | `-r`  | Select a session to resume                                         |
| `--session <id>`           |       | Use a specific session                                             |
| `--no-session`             |       | Ephemeral mode (don't persist)                                     |
| `--thinking <level>`       |       | Thinking depth: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--help`                   | `-h`  | Show help                                                          |

## REPL commands

When running interactively (no prompt argument):

| Command  | Description                          |
| -------- | ------------------------------------ |
| `/clear` | Restart the session (clears history) |
| `/exit`  | Exit the REPL                        |
| `/quit`  | Exit the REPL                        |

## Environment variables

| Variable     | Description                          |
| ------------ | ------------------------------------ |
| `PI_COMMAND` | Path to the PI binary. Default: `pi` |

## Examples

```bash
# Create and register an agent
cybo init && cybo link

# One-shot with default agent
cybo "explain this error"

# Invoke a specific agent
cybo @reviewer "check this function"

# Override model temporarily
cybo --model opencode/claude-opus-4-6 "solve this hard problem"

# Deep reasoning
cybo --thinking high "prove this theorem"

# Continue previous conversation
cybo -c "what was the last thing we discussed?"

# Quick ephemeral query
cybo --no-session "what's 2+2"

# Interactive session
cybo @pi
```

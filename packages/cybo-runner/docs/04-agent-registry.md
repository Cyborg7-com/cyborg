# Agent Registry

The registry at `~/.cybo/agents/` lets you invoke any agent by name from anywhere on your system.

## Structure

```
~/.cybo/
  agents/
    pi/          # directory with cybo.json + soul.md
    reviewer/    → /path/to/my-cybos/reviewer/        (symlink)
    writer/      → /home/user/agents/writer/           (symlink)
```

Each entry is a directory or symlink containing `cybo.json` + `soul.md`.

## Registering an agent

From inside a cybo directory:

```bash
cybo link
```

This creates `~/.cybo/agents/<slug>` → `<current directory>`.

## Removing an agent

```bash
cybo unlink reviewer
```

Or from inside the agent's directory:

```bash
cybo unlink
```

## Listing agents

```bash
cybo list
```

Output:

```
SLUG      NAME             MODEL                PATH
pi        PI               opencode-go/glm-5.1  ~/.cybo/agents/pi
reviewer  Code Reviewer    opencode/claude-sonnet-4-6  /path/to/my-cybos/reviewer
```

## Invoking by name

Once registered, use `@slug` or `--agent` from anywhere:

```bash
cybo @pi "what can you do?"
cybo --agent reviewer "check this function"
```

Both are equivalent. `@slug` is shorter for interactive use; `--agent` is clearer for scripts.

## Default agent

If you run `cybo` without specifying an agent and there's no `cybo.json` in the current directory, the registry is checked for an agent with `"isDefault": true` in its `cybo.json`.

```json
{
  "slug": "pi",
  "name": "PI",
  "isDefault": true,
  ...
}
```

This means you can type `cybo "hello"` from any directory and get your default agent.

Only one agent should have `isDefault: true`. If multiple do, the first one found wins.

## Resolution order

When you run `cybo`, the agent is resolved in this order:

1. `--agent <slug>` — explicit flag
2. `@slug` — shorthand in args
3. Current directory — walks up looking for `cybo.json`
4. Default agent — `isDefault: true` in registry
5. Error — no agent found

See [Agent Resolution](./09-agent-resolution.md) for details.

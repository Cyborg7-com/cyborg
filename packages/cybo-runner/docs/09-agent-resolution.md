# Agent Resolution

When you run `cybo`, it needs to find which agent to load. The resolution follows a strict priority chain.

## Resolution order

```
1. --agent <slug>        Explicit flag, highest priority
        ↓ (not set)
2. @slug                 Shorthand in arguments
        ↓ (not found)
3. findCyboDir(cwd)      Walk up from current directory looking for cybo.json
        ↓ (not found)
4. resolveDefaultAgent() Scan registry for isDefault: true
        ↓ (not found)
5. Error                 No agent found
```

## Step 1: `--agent` flag

```bash
cybo --agent reviewer "check this"
```

Looks up `reviewer` in `~/.cybo/agents/`. If not found, exits with an error immediately — does not fall through.

## Step 2: `@slug` shorthand

```bash
cybo @reviewer "check this"
```

Equivalent to `--agent`. Looks up in the registry. Fails immediately if not found.

## Step 3: Current directory

```bash
cd ~/my-agents/reviewer
cybo "check this"
```

Walks up the directory tree from `cwd` looking for `cybo.json`. This lets you work inside a cybo project without specifying the name.

## Step 4: Default agent

```bash
cybo "hello"    # from a directory without cybo.json
```

Scans `~/.cybo/agents/` for any agent whose `cybo.json` has `"isDefault": true`. Returns the first match.

This is what makes `cybo` work as a zero-config command from anywhere — as long as you have a default agent registered.

## Step 5: Error

If none of the above found an agent:

```
No cybo found. Run `cybo init`, use `cybo @slug`, or `cybo --agent <name>`.
```

## Subcommand resolution

Some subcommands also resolve agents:

- `cybo doctor` — uses `--agent` or `@slug` fallback, then cwd
- `cybo model` / `cybo model set` — same resolution
- `cybo link` / `cybo unlink` — always uses cwd (you're registering the current directory)

## Practical examples

```bash
# Explicit — "I want this specific agent"
cybo --agent pi "hello"

# Contextual — "I'm working in this agent's directory"
cd ~/agents/reviewer && cybo "hello"

# Ambient — "just use my default"
cybo "hello"
```

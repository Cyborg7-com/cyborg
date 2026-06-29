# Creating Distributable Agents

A Cybo is a directory with two files. This makes distribution straightforward.

## What to distribute

```
my-agent/
  cybo.json    # identity + config
  soul.md      # personality
```

That's the minimum. Optionally include:

```
my-agent/
  cybo.json
  soul.md
  README.md           # usage instructions
  examples/           # example prompts or workflows
  src/                # MCP tools (for daemon mode)
    mcp-server.ts
    tools.ts
```

## Sharing methods

### Git repository

The simplest approach. Push the cybo directory to a repo:

```bash
cd my-agent
git init && git add -A && git commit -m "init"
git remote add origin git@github.com:user/my-agent.git
git push -u origin main
```

Recipients clone and link:

```bash
git clone git@github.com:user/my-agent.git
cd my-agent
cybo link
cybo doctor
```

### Copy

Copy the directory. It's self-contained.

```bash
cp -r my-agent/ /path/to/destination/
cd /path/to/destination/my-agent
cybo link
```

### Local registry

Place agents in `~/.cybo/agents/`:

```
~/.cybo/agents/
  pi/              # PI agent
  reviewer/        # reviewer agent
  writer/          # writer agent
```

Each is a standalone directory with `cybo.json` + `soul.md`. Agents don't belong in project repos — they're personal and local.

## Provider portability

The `provider` and `model` fields in `cybo.json` depend on what the recipient has available. Consider:

- Using widely available providers (e.g., `opencode` or `opencode-go`)
- Documenting which providers work in the README
- Recipients can always override: `cybo model set <their-provider/model>`

## MCP tools (daemon mode)

If your agent includes MCP tools for Cyborg7 workspace integration, include them in `src/`:

```
my-agent/
  cybo.json
  soul.md
  src/
    mcp-server.ts    # MCP server factory
    tools.ts         # tool definitions
  package.json       # dependencies for MCP tools only
```

The MCP tools are only used when the agent runs inside a Cyborg7 workspace (`cyborg cybo:spawn`). In standalone mode, they're ignored.

## Checklist before sharing

1. `cybo doctor` passes all checks
2. `cybo "hello"` responds with the expected personality
3. `soul.md` doesn't contain sensitive information (API keys, internal URLs)
4. `cybo.json` uses a provider the recipients will have access to
5. README explains what the agent does and how to use it

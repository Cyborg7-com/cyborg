# Cybo — What it is and how it works

## What is a Cybo?

A Cybo is a customized PI agent. Two files define it:

- **`cybo.json`** — identity (name, slug, role) + runtime config (provider, model)
- **`soul.md`** — personality and instructions (the system prompt)

That's it. A Cybo is not a framework, not an SDK, not a new runtime. It's a thin persona layer on top of PI.

## How it works

The `cybo` CLI reads `cybo.json` + `soul.md` from the current directory and spawns PI in RPC mode:

```
pi --mode rpc --model <provider/model> --append-system-prompt <soul.md contents>
```

PI handles everything else: providers, models, tools, sessions, auth, extensions. The Cybo CLI is a launcher, not a runtime.

## Design philosophy

**Delegate, don't reimplement.** PI already supports 60+ models across multiple providers (OpenCode, Google Vertex, Anthropic, etc.), session persistence, tool execution, extension management, and auth. Cybo adds zero runtime logic — it only adds identity and personality.

This follows the same pattern as:

- **Feynman** — a customized PI with research-oriented personality and packages
- **Hermes** — a standalone agent with its own runtime (heavier approach)
- **AionUI** — a launcher that auto-detects CLI agents and delegates everything to them

Cybo chose the Feynman/AionUI path: minimal wrapper, maximum delegation.

### What Cybo owns

- `cybo.json` manifest format
- `soul.md` personality loading
- `cybo init` — interactive creation of new Cybos
- `cybo doctor` — diagnostics (checks PI, auth, model availability)
- `cybo model` — read/write provider/model in `cybo.json`

### What PI owns (delegated)

- Provider/model selection and API calls
- Tool execution and MCP servers
- Session persistence and resume
- Auth and API key management
- Extensions and skills
- Config TUI (`cybo config` → `pi config`)

### Rules for contributors

1. **Don't add runtime deps.** The package has zero runtime dependencies. PI is spawned as a child process, not imported as a library.
2. **Don't reimplement PI features.** If PI has a flag for it, pass it through. If PI has a command for it, spawn it.
3. **Don't create global config.** Each Cybo is self-contained in its directory. No `~/.cybo/`, no global state.
4. **Keep the CLI under 200 lines.** If a subcommand needs more than 50 lines, it probably belongs in PI.
5. **Test with real inference.** `cybo doctor` + `cybo "hello"` must both work before shipping.

## Two execution modes

A Cybo can run in two ways:

### Standalone (`cybo`)

Direct PI spawn. No daemon, no workspace, no network. For local development and testing.

```
cybo "explain this codebase"
```

### Inside Cyborg7 (`cyborg cybo:spawn`)

The daemon resolves the Cybo, assembles the prompt, injects workspace MCP tools (messages, tasks, channels), and creates an agent. The Cybo gains collaborative capabilities it doesn't have standalone.

```
cyborg cybo:spawn --workspace ws_123 --cybo pi
```

## Agent registry (`~/.cybo/`)

Cybos are self-contained in their directories, but `~/.cybo/` provides global discovery:

```
~/.cybo/
  agents/           # directories or symlinks to cybo directories
    pi/             # cybo.json + soul.md (default agent)
    reviewer/       → /path/to/my-cybos/reviewer/
    writer/         → /path/to/my-cybos/writer/
  (config.json)     # (future) global defaults
```

`cybo link` creates a symlink from `~/.cybo/agents/<slug>` to the current directory. This lets you invoke any cybo by name from anywhere:

```bash
cybo @pi "hello"                   # invoke PI
cybo @reviewer "check this code"   # invoke reviewer
cybo list                          # see all registered cybos
```

The `agents/` subdirectory isolates registered cybos from future top-level additions (global config, cache, templates).

## Creating a new Cybo

```bash
mkdir my-agent && cd my-agent
cybo init        # interactive wizard
cybo link        # register in ~/.cybo/agents/
cybo doctor      # verify everything works
cybo "hello"     # test it
```

Or manually create two files:

**cybo.json**

```json
{
  "slug": "my-agent",
  "name": "My Agent",
  "role": "Code Reviewer",
  "provider": "opencode",
  "model": "claude-sonnet-4-6",
  "soul": "soul.md"
}
```

**soul.md**

```markdown
You are a meticulous code reviewer. You focus on correctness, security, and clarity.
You prefer short, actionable feedback over lengthy explanations.
```

## Package structure

```
packages/cybo-runner/       # The CLI + runtime (this package)
  cli.ts                    # Subcommand dispatch + @slug resolution + REPL
  runner.ts                 # CyboRunner — spawns PI via RPC, streams responses
  manifest.ts               # Reads cybo.json + soul.md
  home.ts                   # ~/.cybo/ management — link, unlink, list, resolve
  doctor.ts                 # cybo doctor
  model-cmd.ts              # cybo model show/list/set
  init-cmd.ts               # cybo init wizard
  index.ts                  # Library exports (CyboRunner, loadCybo)

~/.cybo/agents/pi/          # Agents live locally, not in the repo
  cybo.json                 # Identity + provider/model
  soul.md                   # PI personality
```

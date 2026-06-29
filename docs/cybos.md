# Cybos

A **Cybo** is a custom AI personality you can run on its own or drop into a
Cyborg7 workspace as a teammate. It is not a framework, an SDK, or a new runtime
— it is a thin persona layer over a provider harness. A Cybo is defined by just
two files:

- **`cybo.json`** — identity (name, slug, role) plus runtime config (provider, model)
- **`soul.md`** — the personality and instructions (the system prompt)

The `cybo` CLI reads those two files and launches the harness with the
personality injected. The harness — [PI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
which ships bundled inside `cybo` — handles everything else: providers, models,
tools, sessions, and auth. Cybo adds identity and personality; the provider does
the work.

Standalone, `cybo` spawns the agent directly on your machine. Inside Cyborg7, the
daemon resolves the Cybo, injects the workspace's MCP tools (messages, tasks,
channels), and spawns it as a workspace member alongside the humans and other
agents.

> For how the workspace-level agent providers (Claude Code, Codex, Copilot,
> OpenCode, Pi) fit together, see [providers](./providers.md). For the full
> command-line surface, see the [CLI reference](./cli.md).

---

## What a Cybo is made of

### `cybo.json` — identity and runtime config

`cybo.json` is plain JSON (no comments). Only a few fields are required:

```json
{
  "slug": "reviewer",
  "name": "Code Reviewer",
  "description": "Reviews diffs for correctness, security, and clarity",
  "role": "Senior Engineer",
  "avatar": "🔍",
  "provider": "opencode",
  "model": "claude-sonnet-4-6",
  "soul": "soul.md",
  "isDefault": false
}
```

| Field         | Required | What it does                                                                                                                                                                                    |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slug`        | yes      | Unique identifier (lowercase, hyphens allowed, no spaces). Used by `@slug` invocation, the `--agent` flag, and the registry path `~/.cybo/agents/<slug>/`.                                      |
| `name`        | yes      | Human-readable display name, shown in `cybo list` and the interactive header.                                                                                                                   |
| `provider`    | yes      | The provider identifier passed to the harness (for example `opencode`, `opencode-go`, `google-vertex`). Run `cybo model list` to see what is available.                                         |
| `soul`        | yes      | Path to the soul file (relative to the Cybo directory) or an inline prompt string. Anything ending in `.md` is read from disk; any other string is used as the prompt verbatim.                 |
| `description` | no       | One-line summary of what the Cybo does.                                                                                                                                                         |
| `role`        | no       | A short role label stored in the manifest. When you scaffold with `cybo init`, it is baked into the generated `soul.md` (`You are <name>, a <role>.`); it is not otherwise rendered by the CLI. |
| `avatar`      | no       | Emoji or short string for UI display (used in the Cyborg7 workspace UI, not the CLI).                                                                                                           |
| `model`       | no       | Model ID within the provider. Combined with `provider` to form the full spec `provider/model`. If omitted, the provider's default model is used.                                                |
| `isDefault`   | no       | If `true`, this Cybo is used when no Cybo is named and there is no `cybo.json` in the current directory. Set it on at most one registered Cybo.                                                 |

The smallest valid manifest is just four fields, with the personality inlined:

```json
{
  "slug": "helper",
  "name": "Helper",
  "provider": "opencode",
  "soul": "You are a concise, helpful assistant."
}
```

### `soul.md` — the personality

`soul.md` is the system prompt. It is injected into the harness with
`--append-system-prompt`, so write it as direct instructions to the agent:

```markdown
# Code Reviewer

You are a meticulous code reviewer. You focus on correctness, security, and
clarity. You prefer short, actionable feedback over lengthy explanations, and
you always point to the specific line or function you are commenting on.
```

That is the whole definition. A Cybo is portable: a directory containing
`cybo.json` and `soul.md` is everything needed to run it.

---

## Creating a Cybo

### Scaffold with `cybo init`

From an empty directory, `cybo init` walks you through name, slug, optional role,
and model, then writes `cybo.json` and a starter `soul.md`:

```bash
mkdir reviewer && cd reviewer
cybo init        # interactive: name, slug, role, model
```

`init` prints the available models (via the harness) and defaults the model to
`opencode/claude-sonnet-4-6` if you press enter. It writes both files and fails
fast if a `cybo.json` already exists in the directory.

You can also create the two files by hand — there is nothing magic about them.

### Choosing a model

The model lives in `cybo.json` as a `provider` plus optional `model`, combined
into a `provider/model` spec:

```bash
cybo model                              # show the current model
cybo model list                         # list all available models (via the harness)
cybo model set opencode/claude-sonnet-4-6   # write provider + model into cybo.json
```

Specs are written as `provider/model` (for example `opencode/claude-sonnet-4-6`).
Provider-only (for example `opencode`) is valid and falls back to that provider's
default model. See [providers](./providers.md) for the provider landscape.

---

## Registering a Cybo

A Cybo runs fine from its own directory, but registering it makes it callable by
name from anywhere. The registry lives at `~/.cybo/agents/`, where each entry is
a symlink (or directory) pointing at a Cybo directory.

```bash
cybo link             # register the Cybo in the current directory under its slug
cybo list             # list registered Cybos (slug, name, model, path)
cybo unlink <slug>    # remove a Cybo from the registry
```

`cybo link` creates `~/.cybo/agents/<slug>` pointing at the current directory, so
you can then invoke the Cybo by slug from any working directory:

```bash
cybo @reviewer "check this diff for security issues"
```

Each Cybo stays self-contained in its own directory; the registry only provides
discovery.

---

## Running a Cybo standalone

Standalone, `cybo` spawns the harness directly on your machine — no daemon, no
workspace, no network. It is the fast path for local development and testing.

```bash
cybo "summarize this repo"          # one-shot: auto-detect the Cybo from cwd or the default
cybo @reviewer "review this PR"     # one-shot against a registered Cybo by slug
cybo --agent reviewer "review this" # same, via the --agent flag
cybo                                # no prompt → interactive session
```

How the Cybo is resolved, in order: an explicit `--agent <slug>`, then a
`@slug` argument, then a `cybo.json` found by walking up from the current
directory, then the registered Cybo marked `isDefault`.

### Sessions and reasoning

A few flags control session continuity and reasoning depth:

```bash
cybo --continue                         # resume the previous session
cybo --resume                           # pick a session to resume
cybo --no-session "throwaway question"  # ephemeral — do not save the session
cybo --thinking high "design the migration plan"
```

`--thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. The
short forms `-c` (`--continue`) and `-r` (`--resume`) also work. The full set of
flags is in the [CLI reference](./cli.md).

---

## Running a Cybo inside a Cyborg7 workspace

Inside Cyborg7, a Cybo becomes a collaborative teammate. The daemon spawns it on
your machine, but wires it into the shared workspace so it can read channels,
post messages, and work on tasks like any other member.

When a Cybo is spawned in a workspace, the daemon:

1. **Resolves the Cybo** — reads its `cybo.json` + `soul.md` from the registry or storage.
2. **Builds the prompt** — combines the soul with the current workspace context.
3. **Injects workspace MCP tools** — adds the workspace-aware tools (see below) on top of the harness's built-in tools.
4. **Creates an agent** — registers it as a workspace member with its own ID.
5. **Bridges streams** — routes the agent's streamed output to workspace members over the relay.

The identity (`cybo.json`) and personality (`soul.md`) are identical in both
modes. The only difference is that, inside a workspace, the Cybo gains tools for
collaborating with the rest of the team:

| Tool                           | Description                                                               |
| ------------------------------ | ------------------------------------------------------------------------- |
| `cyborg7_send_message`         | Send a message to a channel or DM in the workspace                        |
| `cyborg7_get_channel_history`  | Get recent messages from a channel                                        |
| `cyborg7_read_channel`         | Read a channel as a transcript, with message IDs for replying or reacting |
| `cyborg7_react`                | React to a message with an emoji                                          |
| `cyborg7_search`               | Search messages by text within a channel the Cybo is a member of          |
| `cyborg7_list_channels`        | List the workspace's channels                                             |
| `cyborg7_get_workspace_roster` | List all members — humans and agents — in the workspace                   |
| `cyborg7_create_task`          | Create a task in the workspace                                            |
| `cyborg7_list_tasks`           | List tasks, with optional filters                                         |
| `cyborg7_update_task`          | Update a task's status or details                                         |
| `cyborg7_schedule_create`      | Schedule a Cybo to run a prompt on a recurring (or one-shot) cron cadence |
| `cyborg7_schedule_list`        | List recurring Cybo schedules in the workspace                            |
| `cyborg7_schedule_delete`      | Delete a recurring Cybo schedule by ID                                    |

Every workspace tool is namespaced with the `cyborg7_` prefix. Which tools are
actually registered depends on the Cybo's granted platform permissions: the read
tools are always available, while the write and schedule tools are gated. These
tools are only present in workspace mode — standalone, the Cybo has the harness's
built-in tools and nothing else.

---

## The provider is the harness

Cybos deliberately add zero runtime logic. The `cybo` CLI is a launcher: it reads
the two files and starts the provider harness with the personality and model
applied, then gets out of the way.

- **Provider and model selection, API calls** — handled by the harness.
- **Tool execution and MCP servers** — handled by the harness (plus the workspace MCP tools above when running inside Cyborg7).
- **Session persistence and resume** — handled by the harness; `cybo`'s session flags pass straight through.
- **Auth and credentials** — handled by the harness. Sign in once and every Cybo shares the same credentials.

That is why the same `cybo.json` + `soul.md` runs unchanged on the command line
and inside a workspace: the personality is yours, and the heavy lifting belongs
to the provider. To understand the providers a Cybo can target, read
[providers](./providers.md); for every command and flag, see the
[CLI reference](./cli.md).

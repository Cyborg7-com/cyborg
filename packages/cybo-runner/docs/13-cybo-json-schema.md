# cybo.json Schema

Complete reference for the `cybo.json` manifest file.

## Full example

```json
{
  "slug": "pi",
  "name": "PI",
  "description": "Personal Intelligence — research, project coordination, and task management",
  "role": "Research & Project Assistant",
  "avatar": "🧠",
  "provider": "opencode-go",
  "model": "glm-5.1",
  "soul": "soul.md",
  "isDefault": true
}
```

## Fields

### `slug` (required)

- **Type**: `string`
- **Pattern**: lowercase, hyphens allowed, no spaces
- **Examples**: `"pi"`, `"code-reviewer"`, `"my-agent"`

Unique identifier for the agent. Used in:

- `@slug` invocation: `cybo @pi "hello"`
- `--agent` flag: `cybo --agent pi "hello"`
- Registry path: `~/.cybo/agents/<slug>/`
- REPL prompt: `pi> `

### `name` (required)

- **Type**: `string`
- **Examples**: `"PI"`, `"Code Reviewer"`, `"My Agent"`

Human-readable display name. Shown in:

- REPL header
- `cybo list` output

### `provider` (required)

- **Type**: `string`
- **Examples**: `"opencode-go"`, `"opencode"`, `"google-vertex"`

PI provider identifier. Run `cybo model list` to see all available providers.

### `soul` (required)

- **Type**: `string`
- **Examples**: `"soul.md"`, `"You are a helpful assistant."`

Path to the soul file (relative to the cybo directory) or inline prompt text. Files ending in `.md` are read from disk; anything else is used as-is.

### `description` (optional)

- **Type**: `string`
- **Default**: none

One-line description of what the agent does. Shown in the REPL header below the name.

### `role` (optional)

- **Type**: `string`
- **Default**: none
- **Examples**: `"Senior Engineer"`, `"Research & Project Assistant"`

Role label. Shown in the REPL header next to the name: `PI — Research & Project Assistant`.

### `avatar` (optional)

- **Type**: `string`
- **Default**: none
- **Examples**: `"🧠"`, `"🔍"`, `"✍️"`

Emoji or short string for UI display. Used in Cyborg7 workspace UI, not in the CLI.

### `model` (optional)

- **Type**: `string`
- **Default**: provider's default model
- **Examples**: `"glm-5.1"`, `"claude-sonnet-4-6"`, `"gemini-2.5-pro"`

Model ID within the provider. Combined with `provider` to form the full model spec: `opencode-go/glm-5.1`.

If omitted, PI uses the provider's default model.

### `isDefault` (optional)

- **Type**: `boolean`
- **Default**: `false`

If `true`, this agent is used when no agent is specified and no `cybo.json` exists in the current directory. Only one registered agent should have this set to `true`.

## Minimal valid manifest

```json
{
  "slug": "helper",
  "name": "Helper",
  "provider": "opencode-go",
  "soul": "You are a helpful assistant."
}
```

## Notes

- The file must be valid JSON (not JSONC — no comments).
- All paths are relative to the directory containing `cybo.json`.
- Unknown fields are ignored (forward-compatible).

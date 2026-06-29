# Agent Anatomy

Every Cybo is defined by two files in a directory.

```
my-agent/
  cybo.json    # identity + runtime config
  soul.md      # personality (system prompt)
```

## cybo.json

The manifest. Tells cybo who the agent is and how to run it.

```json
{
  "slug": "reviewer",
  "name": "Code Reviewer",
  "description": "Reviews PRs for correctness and security",
  "role": "Senior Engineer",
  "avatar": "🔍",
  "provider": "opencode-go",
  "model": "glm-5.1",
  "soul": "soul.md",
  "isDefault": false
}
```

### Required fields

| Field      | Type     | Description                                                        |
| ---------- | -------- | ------------------------------------------------------------------ |
| `slug`     | `string` | URL-safe identifier. Used for `@slug` invocation and registry.     |
| `name`     | `string` | Display name shown in REPL header and `cybo list`.                 |
| `provider` | `string` | PI provider ID (e.g., `opencode-go`, `opencode`, `google-vertex`). |
| `soul`     | `string` | Path to soul file (relative to cybo dir) or inline prompt text.    |

### Optional fields

| Field         | Type      | Default | Description                                                                         |
| ------------- | --------- | ------- | ----------------------------------------------------------------------------------- |
| `description` | `string`  | —       | One-line description. Shown in REPL header.                                         |
| `role`        | `string`  | —       | Role label (e.g., "Research Assistant"). Shown in REPL.                             |
| `avatar`      | `string`  | —       | Emoji or short string for UI display.                                               |
| `model`       | `string`  | —       | Model ID within the provider. If omitted, provider's default is used.               |
| `isDefault`   | `boolean` | `false` | If `true`, this agent loads when no agent is specified. Only one should be default. |

See [cybo.json Schema](./13-cybo-json-schema.md) for the complete reference.

## soul.md

The personality. This is injected as a system prompt via PI's `--append-system-prompt` flag.

```markdown
You are a meticulous code reviewer working at a fast-paced startup.

## Guidelines

- Focus on correctness first, style second
- Flag security issues with HIGH priority
- Keep feedback concise — one sentence per issue
- Suggest fixes, don't just point out problems

## Tone

Professional but not formal. Direct. No filler.
```

### Tips for writing soul files

- **Be specific.** "You are helpful" is useless. "You are a senior Go engineer who reviews for concurrency bugs" is useful.
- **Include constraints.** What should the agent avoid? What format should responses follow?
- **Keep it focused.** A soul file is not a knowledge base. It's a behavioral guide.
- **Use markdown structure.** Headings and lists make the prompt easier for the model to parse.

## Soul file reference

The `soul` field in `cybo.json` supports two formats:

1. **File path** (recommended): `"soul": "soul.md"` — reads the file relative to the cybo directory. Any `.md` extension triggers file reading.
2. **Inline text**: `"soul": "You are a helpful assistant."` — used directly as the prompt. For simple, single-line personalities.

## Directory is the boundary

A Cybo is self-contained in its directory. No external config files, no global state (besides the optional registry). You can:

- Copy the directory to share an agent
- Version it with git
- Symlink it into the registry for global access

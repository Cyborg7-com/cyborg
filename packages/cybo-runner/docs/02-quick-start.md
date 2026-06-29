# Quick Start

## Prerequisites

- Node.js 22+
- [PI](https://github.com/earendil-works/pi) installed and authenticated (`pi` available in PATH)

Verify with:

```bash
pi --version
```

## Create your first agent

```bash
mkdir my-agent && cd my-agent
cybo init
```

The wizard asks for a name, slug, role, and model. It creates `cybo.json` and `soul.md`.

Or create the files manually:

**cybo.json**

```json
{
  "slug": "my-agent",
  "name": "My Agent",
  "role": "Code Reviewer",
  "provider": "opencode-go",
  "model": "glm-5.1",
  "soul": "soul.md"
}
```

**soul.md**

```markdown
You are a meticulous code reviewer. You focus on correctness, security, and clarity.
You prefer short, actionable feedback over lengthy explanations.
```

## Run it

One-shot:

```bash
cybo "review this function for security issues"
```

Interactive REPL:

```bash
cybo
```

## Register it globally

```bash
cybo link
```

Now invoke it from anywhere:

```bash
cybo @my-agent "hello"
```

## Verify everything works

```bash
cybo doctor
```

Output:

```
✓ PI binary     v0.75.5
✓ Auth config   ~/.pi/agent/auth.json
✓ cybo.json     my-agent (opencode-go/glm-5.1)
✓ Model avail.  opencode-go/glm-5.1 found in 64 models
```

## Next steps

- [Agent Anatomy](./03-agent-anatomy.md) — understand `cybo.json` and `soul.md` in depth
- [Agent Registry](./04-agent-registry.md) — manage multiple agents
- [CLI Reference](./07-cli-reference.md) — all commands and flags

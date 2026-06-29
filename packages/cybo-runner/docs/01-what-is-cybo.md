# What is Cybo

A Cybo is a customized AI agent. Two files define it:

- **`cybo.json`** — identity (name, slug, role) + runtime config (provider, model)
- **`soul.md`** — personality and instructions (the system prompt)

That's it. No framework, no SDK, no new runtime. A Cybo is a thin persona layer on top of [PI](https://github.com/earendil-works/pi), a multi-provider coding agent that supports 60+ models.

## The idea

Most agent frameworks make you build everything: provider abstractions, tool execution, session management, auth. PI already does all of that. Cybo adds only what PI doesn't have — persistent identity and personality.

Think of it like a character sheet for an AI. The agent's capabilities come from PI. The agent's personality comes from you.

## How it works

The `cybo` CLI reads your two files and spawns PI in RPC mode:

```
pi --mode rpc --model <provider/model> --append-system-prompt <soul.md contents>
```

PI handles everything else: providers, models, tools, sessions, auth, extensions.

## Comparison

| Approach        | What you build                                                   | What you get                              |
| --------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| From scratch    | Provider adapters, tool execution, session management, auth, CLI | Full control, full maintenance burden     |
| Agent framework | Plugins, configuration, middleware                               | Flexible, but heavy                       |
| **Cybo**        | `cybo.json` + `soul.md`                                          | PI's full capabilities + your personality |

## Prior art

Cybo follows the same pattern as other PI-based agents:

- **Feynman** — a research-oriented PI with specialized personality and packages
- **Hermes** — a standalone agent with its own runtime (heavier approach)
- **AionUI** — a launcher that auto-detects CLI agents and delegates everything to them

Cybo chose the Feynman/AionUI path: minimal wrapper, maximum delegation.

## Design principles

1. **Delegate, don't reimplement.** If PI has a feature, pass through to it. Don't rebuild it.
2. **Zero runtime dependencies.** The package has no `node_modules` at runtime. PI is spawned as a child process, not imported as a library.
3. **Two files, one agent.** Everything about a Cybo lives in `cybo.json` and `soul.md`. No hidden config, no global state beyond the optional registry.
4. **Any provider, any model.** PI supports OpenCode, Google Vertex, Anthropic, and more. Cybo inherits all of them automatically.

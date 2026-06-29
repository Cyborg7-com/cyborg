# Providers and Models

Cybo supports every provider and model that PI supports. No configuration needed — PI handles all provider logic, auth, and API calls.

## Available providers

List all available models:

```bash
cybo model list
```

This passes through to `pi --list-models`, showing all providers and their models (60+).

Common providers:

| Provider        | Examples                                          |
| --------------- | ------------------------------------------------- |
| `opencode`      | `claude-sonnet-4-6`, `claude-opus-4-6`, `gpt-4.1` |
| `opencode-go`   | `glm-5.1`, `claude-sonnet-4-6`                    |
| `google-vertex` | `gemini-2.5-pro`, `gemini-2.5-flash`              |

## Setting the model

### In cybo.json (persistent)

```json
{
  "provider": "opencode-go",
  "model": "glm-5.1"
}
```

Or via CLI:

```bash
cybo model set opencode-go/glm-5.1
```

### At runtime (temporary)

```bash
cybo --model opencode/claude-sonnet-4-6 "explain this code"
```

The `--model` flag overrides the `cybo.json` value for that invocation only.

## Checking current model

```bash
cybo model
```

Output:

```
opencode-go/glm-5.1
```

## Model format

Models are specified as `provider/model`:

```
opencode-go/glm-5.1
opencode/claude-sonnet-4-6
google-vertex/gemini-2.5-pro
```

If no model is specified (only provider), PI uses that provider's default model.

## How it works

Cybo combines `provider` and `model` from `cybo.json` into a single string and passes it to PI:

```
pi --mode rpc --model opencode-go/glm-5.1 ...
```

PI resolves the provider, authenticates, and makes the API call. Cybo never touches provider logic directly.

## Auth

Authentication is managed entirely by PI. Run PI's login flow to set up credentials:

```bash
pi
> /login
```

Credentials are stored in `~/.pi/agent/auth.json`. All cybos share the same auth.

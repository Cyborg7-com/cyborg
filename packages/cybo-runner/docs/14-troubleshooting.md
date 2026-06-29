# Troubleshooting

## `cybo doctor`

The first step for any issue. Run diagnostics:

```bash
cybo doctor
```

```
✓ PI binary     v0.75.5
✓ Auth config   ~/.pi/agent/auth.json
✓ cybo.json     pi (opencode-go/glm-5.1)
✓ Model avail.  opencode-go/glm-5.1 found in 64 models
```

You can also check a specific agent:

```bash
cybo doctor @reviewer
```

## Common issues

### "pi" not found

```
✗ PI binary     "pi" not found — npm i -g @earendil-works/pi-coding-agent
```

PI is not installed or not in PATH. Solutions:

1. Install PI: `npm i -g @earendil-works/pi-coding-agent`
2. If installed elsewhere, set `PI_COMMAND`: `export PI_COMMAND=/path/to/pi`
3. Or pass it directly: `cybo --pi-command /path/to/pi "hello"`

### Auth not found

```
✗ Auth config   not found — run pi and use /login
```

PI needs authentication. Start PI and log in:

```bash
pi
> /login
```

### Model not available

```
✗ Model avail.  opencode-go/glm-5.1 not found (64 models available — run cybo model list)
```

The model in `cybo.json` isn't available with your current PI installation. Solutions:

1. List available models: `cybo model list`
2. Change the model: `cybo model set <provider/model>`

### No cybo.json found

```
No cybo found. Run `cybo init`, use `cybo @slug`, or `cybo --agent <name>`.
```

Cybo couldn't find an agent. This means:

1. No `--agent` flag was provided
2. No `@slug` was used
3. No `cybo.json` exists in the current directory (or any parent)
4. No default agent is registered

Solutions:

- Create one: `cybo init && cybo link`
- Use a registered agent: `cybo @pi "hello"`
- Check registered agents: `cybo list`

### Agent "X" not found

```
Agent "reviewer" not found. Run `cybo list` to see registered agents.
```

The slug doesn't match any registered agent. Check:

```bash
cybo list                    # see what's registered
cd /path/to/agent && cybo link    # register it
```

### PI exits unexpectedly

If PI crashes during inference, the error includes stderr output:

```
Error: PI exited (code=1, signal=null)
API error: insufficient credits
```

Common causes:

- API credits exhausted
- Network connectivity issues
- Invalid API key (re-authenticate with `pi` → `/login`)
- Model-specific errors (try a different model with `--model`)

### Slow first response

The first message in a REPL session is slower because PI needs to spin up. Subsequent messages reuse the running PI process and are faster.

In one-shot mode, every invocation pays this startup cost. For interactive work, prefer the REPL.

## Debug tips

- **Test with ephemeral mode**: `cybo --no-session "test"` avoids session-related issues
- **Override model**: `cybo --model opencode/claude-sonnet-4-6 "test"` to isolate model issues
- **Check PI directly**: `pi --version` and `pi --list-models` to verify PI works outside cybo
- **Check the registry**: `ls -la ~/.cybo/agents/` to see symlinks and their targets

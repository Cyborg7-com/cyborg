# Sessions

Sessions let you continue conversations across invocations. Cybo delegates all session management to PI.

## Default behavior

By default, each `cybo` invocation creates a new session that PI persists automatically. You can return to it later.

## Continue last session

```bash
cybo --continue "what were we talking about?"
cybo -c "what were we talking about?"
```

Picks up the most recent session for that agent.

## Resume a specific session

```bash
cybo --resume
cybo -r
```

Opens PI's interactive session selector, showing all past sessions with timestamps and preview.

## Use a specific session ID

```bash
cybo --session sess_abc123 "continue from here"
```

## Ephemeral mode

```bash
cybo --no-session "one-off question"
```

The conversation is not saved. Useful for quick queries and testing.

## In the REPL

When running interactively, the session persists for the duration of the REPL. Use `/clear` to restart:

```
pi> /clear
(session restarted)
pi>
```

## How it works

Session flags are passed directly to PI:

| Cybo flag          | PI flag          |
| ------------------ | ---------------- |
| `--continue`, `-c` | `--continue`     |
| `--resume`, `-r`   | `--resume`       |
| `--session <id>`   | `--session <id>` |
| `--no-session`     | `--no-session`   |

PI stores sessions in its own data directory (`~/.pi/`). Cybo doesn't manage session storage.

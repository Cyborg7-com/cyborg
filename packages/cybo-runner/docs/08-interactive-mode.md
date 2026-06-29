# Interactive Mode

When you run `cybo` without a prompt, it starts an interactive REPL.

## Starting a session

```bash
cybo                    # default agent
cybo @reviewer          # specific agent
cybo --agent writer     # by flag
```

The REPL shows the agent's identity and model:

```
Code Reviewer — Senior Engineer
Reviews PRs for correctness and security
Model: opencode-go/glm-5.1

reviewer>
```

## Conversing

Type your message and press Enter. The response streams in real-time:

```
reviewer> what should I look for in a Go HTTP handler?
Focus on these areas:

1. Input validation — check Content-Type, body size limits
2. Error handling — don't leak internal details in responses
3. Context propagation — pass ctx through, respect cancellation
...

reviewer>
```

## Session commands

| Command  | Description                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| `/clear` | Restart the session. Kills the current PI process and starts fresh. History is lost. |
| `/exit`  | Exit the REPL gracefully.                                                            |
| `/quit`  | Same as `/exit`.                                                                     |

## Session persistence

By default, sessions are persisted by PI. When you exit and come back:

```bash
cybo -c @reviewer       # continue last session with this agent
cybo -r                 # pick from all past sessions
```

To start without persistence:

```bash
cybo --no-session @reviewer
```

## Tips

- **Empty lines are ignored.** Press Enter on an empty line to get a new prompt without sending a message.
- **Multi-line input is not supported.** Each Enter sends the line. For long prompts, use one-shot mode or pipe from a file.
- **Ctrl+C** interrupts the current response. **Ctrl+D** exits the REPL.
- **The model stays loaded.** Within a REPL session, the PI process stays running between messages, so subsequent messages are faster than separate one-shot invocations.

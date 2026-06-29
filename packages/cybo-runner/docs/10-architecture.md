# Architecture

Cybo is a launcher, not a runtime. Understanding this distinction is key.

## What Cybo does

```
┌──────────────┐     spawn      ┌─────────────────────────┐
│   cybo CLI   │ ──────────────→│          PI             │
│              │   stdin/stdout │                         │
│  reads:      │ ←─────────────→│  handles:               │
│  cybo.json   │    JSON-RPC    │  - providers (60+)      │
│  soul.md     │                │  - model inference      │
│              │                │  - tool execution       │
│  provides:   │                │  - session persistence  │
│  --model     │                │  - auth                 │
│  --append-   │                │  - extensions           │
│  system-     │                │                         │
│  prompt      │                │                         │
└──────────────┘                └─────────────────────────┘
```

Cybo reads two files, assembles the flags, and spawns PI as a child process. Everything after that is PI.

## PI RPC protocol

Cybo communicates with PI via JSON-RPC over stdin/stdout.

### Sending a prompt

```json
{ "type": "prompt", "message": "hello", "id": "req_1" }
```

### Receiving responses

PI emits newline-delimited JSON events:

```json
{"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "Hello"}}
{"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "!"}}
{"type": "agent_end"}
```

The runner yields each `text_delta` as it arrives, enabling real-time streaming.

### RPC responses

For command-type requests, PI returns:

```json
{ "type": "response", "id": "req_1", "command": "prompt", "success": true }
```

## Zero dependencies

The `package.json` has zero runtime dependencies:

```json
{
  "dependencies": {}
}
```

PI is not imported — it's spawned via `child_process.spawn()`. This means:

- No version conflicts
- No node_modules bloat
- PI can update independently
- Cybo works with any PI version that supports `--mode rpc`

## Process lifecycle

1. **First message**: PI process spawns on demand (lazy)
2. **REPL**: PI stays running between messages (faster subsequent responses)
3. **One-shot**: PI spawns, responds, cybo calls `close()`
4. **`/clear`**: PI process is killed and re-spawned fresh
5. **Exit**: PI process receives SIGTERM

## Error handling

- **PI not found**: ENOENT on spawn → clear error message with install instructions
- **PI exits unexpectedly**: stderr buffer (last 4KB) is included in the error
- **RPC timeout**: pending requests have timers, rejected on timeout
- **Model not available**: PI reports the error; `cybo doctor` can pre-check

## File structure

```
packages/cybo-runner/
  cli.ts          Subcommand dispatch, @slug resolution, REPL
  runner.ts       CyboRunner — spawns PI via RPC, streams responses
  manifest.ts     Reads cybo.json + soul.md, walks directory tree
  home.ts         ~/.cybo/ management — link, unlink, list, resolve
  doctor.ts       Diagnostics — PI binary, auth, manifest, model checks
  model-cmd.ts    Model show/list/set
  init-cmd.ts     Interactive agent creation wizard
  index.ts        Library exports (CyboRunner, loadCybo)
```

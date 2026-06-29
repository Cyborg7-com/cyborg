# Configuration

Cyborg7 is configured entirely through environment variables. There is no
required config file — copy the example env file, set what you need, and the
daemon reads the rest from sensible defaults.

```bash
cp packages/server/.env.example packages/server/.env
```

The daemon auto-detects its run mode from the environment. With no
`DATABASE_URL` it runs **solo** (SQLite only); set `DATABASE_URL` and it runs
**connected** (SQLite cache plus a shared PostgreSQL, with the relay brokering
between daemons). Nothing here turns the relay on or off by itself — the relay is
a separate process that several daemons point at; see
[Architecture](../README.md#architecture).

> [!NOTE]
> Cyborg7 uses `PASEO_*` variable names for the parts inherited from
> [Paseo](https://github.com/getpaseo/paseo) and `CYBORG7_*` names for the
> additions. Both are read from the process environment.

## Environment variables

| Variable                | Required      | Default          | What it does                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | No            | _(unset)_        | PostgreSQL connection string for shared state (workspaces, channels, messages, tasks). When set, the daemon runs in **connected** mode: it keeps its local SQLite cache and writes through to PostgreSQL. When unset, the daemon runs **solo** on SQLite only. See [DATABASE_URL and connected mode](#database_url-and-connected-mode) below. |
| `CYBORG7_JWT_SECRET`    | In production | dev default      | HMAC-SHA256 secret used to sign and verify Cyborg7 tokens and signed message actions. Outside production a built-in development default is used automatically. In production the daemon **refuses to boot** if this is unset or left at the public dev default — set it to a strong, unique secret.                                           |
| `PASEO_HOME`            | No            | `~/.cyborg7`     | Directory for runtime state — agent metadata, the local SQLite database, credentials, and logs. Isolated from a stock Paseo install (`~/.paseo`) so the two can coexist on one machine.                                                                                                                                                       |
| `PASEO_LISTEN`          | No            | `127.0.0.1:6780` | Address the daemon listens on. Accepts `host:port`, a `/path/to/socket`, or `unix:///path/to/socket`. The shipped `.env.example` sets `127.0.0.1:6767` to avoid clashing with a stock Paseo daemon on `6780`; if you do not set the variable, the daemon's built-in default is `127.0.0.1:6780`.                                              |
| `PASEO_CORS_ORIGINS`    | No            | _(none)_         | Comma-separated list of allowed browser origins for WebSocket/HTTP access (for example a UI dev server at `http://localhost:5173`).                                                                                                                                                                                                           |
| `CYBORG7_PTY_HOST`      | No            | enabled          | Controls terminal persistence. Live PTYs run in a detached, long-lived host so terminals survive a daemon restart or update. **On by default** — set `CYBORG7_PTY_HOST=0` (also accepts `false` or `off`, case-insensitive) to disable it and fall back to the inherited in-daemon worker.                                                    |
| `ANTHROPIC_API_KEY`     | No            | _(unset)_        | API key for the Claude provider. At least one provider must be installed and authenticated on the daemon machine for agents to run.                                                                                                                                                                                                           |
| `OPENAI_API_KEY`        | No            | _(unset)_        | API key used for OpenAI-backed features, including speech-to-text and text-to-speech.                                                                                                                                                                                                                                                         |
| `TTS_VOICE`             | No            | `alloy`          | Text-to-speech voice. One of `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`.                                                                                                                                                                                                                                                             |
| `TTS_MODEL`             | No            | `tts-1`          | Text-to-speech model. `tts-1` (faster) or `tts-1-hd` (higher quality).                                                                                                                                                                                                                                                                        |
| `PASEO_DICTATION_DEBUG` | No            | off              | When set, saves debug recordings (dictation, STT input, TTS output) under `${cwd}/.debug/recordings/`. Development aid only.                                                                                                                                                                                                                  |
| `PASEO_CLAUDE_DEBUG`    | No            | off              | When set, enables verbose Claude SDK stream logging (trace-level, per-token). Development aid only.                                                                                                                                                                                                                                           |

Set only what you need. Solo mode is fully functional with no variables set at
all — the daemon falls back to every default above.

## DATABASE_URL and connected mode

`DATABASE_URL` is the single switch between solo and connected mode. Leave it
unset and the daemon never opens a PostgreSQL connection; set it and the daemon
connects on first use, runs pending migrations, and writes shared state through
to PostgreSQL while still serving fast reads from its local SQLite cache.

The connection string is standard PostgreSQL, for example:

```bash
DATABASE_URL=postgresql://user:password@host:5432/cyborg7
```

### TLS for managed PostgreSQL

Managed PostgreSQL providers generally require TLS. Cyborg7 negotiates SSL
automatically when the connection string asks for it (`sslmode=require`) or when
the host is recognized as a managed provider that requires TLS. If your provider
needs TLS but you have not made that explicit, add `sslmode=require` to the
connection string so the connection and the migrator negotiate SSL correctly:

```bash
DATABASE_URL=postgresql://user:password@your-db-host:5432/cyborg7?sslmode=require
```

For a self-managed PostgreSQL on a trusted network, plain (non-TLS) connections
work without `sslmode`.

## Production checklist

Before exposing a daemon or relay beyond your own machine:

- Set a strong, unique `CYBORG7_JWT_SECRET`. With `NODE_ENV=production` the
  daemon refuses to boot on the dev default — that is intentional.
- Set `DATABASE_URL` (with `sslmode=require` for a managed provider) so teammates
  share state through PostgreSQL.
- Scope `PASEO_CORS_ORIGINS` to the exact origins that should reach the daemon
  instead of leaving it open.
- Make sure at least one provider CLI is installed and authenticated on the
  daemon machine.

For full deployment guidance — running the relay, PostgreSQL, and the daemon as
services — see [Self-hosting](./self-hosting.md).

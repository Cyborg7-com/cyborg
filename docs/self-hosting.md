# Self-hosting Cyborg7

Cyborg7 is self-host first. There is no SaaS to sign up for and no cloud that
runs your agents — you run the whole thing on your own machines. This guide is
for operators standing up Cyborg7 for themselves or a team.

The same codebase produces two deployment shapes:

- **Local daemon** — the full daemon a person runs on their own machine. Agents
  execute locally as child processes with access to that machine's tools, configs,
  and credentials. In **solo** mode it needs nothing but SQLite.
- **Cloud relay** — `relay-standalone.ts`, a Hono HTTP + WebSocket broker that
  connects daemons across networks. It queries shared PostgreSQL directly and
  brokers messages between daemons, but it **runs no agents** — agents always
  stay on each user's own daemon.

For how these pieces fit together, see [`./architecture.md`](./architecture.md).
For the full list of environment variables and defaults, see
[`./configuration.md`](./configuration.md).

---

## Pick your shape

### Individual or single machine — local daemon, solo

If you are working alone, you do not need PostgreSQL or a relay at all. Leave
`DATABASE_URL` unset and the daemon runs in **solo** mode against a local SQLite
cache:

```bash
git clone https://github.com/Cyborg7-com/cyborg.git
cd cyborg
pnpm install
pnpm dev
```

The daemon listens on `127.0.0.1:6767` by default (`PASEO_LISTEN`) and keeps its
runtime state under `~/.cyborg7` (`PASEO_HOME`). That is the whole deployment.

### Distributed team — shared PostgreSQL + a relay

For a team whose members run daemons on different machines, you stand up two
shared services:

1. **A PostgreSQL database** that holds the state every teammate sees —
   workspaces, channels, messages, and tasks.
2. **A cloud relay** that brokers messages between the daemons and queries that
   PostgreSQL directly.

Each person still runs their own daemon. They point it at the shared database
with `DATABASE_URL`, which flips the daemon into **connected** mode: it keeps its
fast local SQLite cache and writes through to PostgreSQL so everyone shares the
same state. The relay carries prompts, shared context, and streamed agent output
between daemons. Agents never leave the machine they were spawned on.

---

## Stand up PostgreSQL

The relay and every connected daemon talk to one PostgreSQL database. Use a
managed PostgreSQL service or a host you back up — this database is your shared
source of truth.

Point services at it with a standard connection string:

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/cyborg
```

How the value is interpreted:

- **On a daemon** — setting `DATABASE_URL` switches it from solo to **connected**
  mode. The daemon writes through to PostgreSQL in addition to its SQLite cache.
  If the connection cannot be established at startup, the daemon falls back to
  solo mode on SQLite rather than failing to boot.
- **On the relay** — the relay reads `DATABASE_URL` to query shared state
  directly.

Schema migrations are applied against this database; run them before pointing
production traffic at it. See [`./configuration.md`](./configuration.md) for
details.

---

## Run the relay broker

`relay-standalone.ts` is the broker for distributed teams. It is a single Hono
HTTP + WebSocket process. It serves the UI, queries PostgreSQL, and brokers
messages between connected daemons — and it does **not** run agents. Every agent
turn happens on a user's own daemon; the relay only moves messages.

The relay runs the TypeScript source directly. From the repo root, with the
shared environment configured:

```bash
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/cyborg \
CYBORG7_JWT_SECRET=<a-strong-random-secret> \
NODE_ENV=production \
pnpm tsx packages/server/src/server/cyborg/relay-standalone.ts
```

Relay listen address:

| Variable     | Default   | What it does                   |
| ------------ | --------- | ------------------------------ |
| `RELAY_PORT` | `9100`    | TCP port the relay listens on. |
| `RELAY_HOST` | `0.0.0.0` | Bind address.                  |

Each teammate's daemon then connects to the relay over WebSocket. Use a
placeholder host such as `https://relay.example.com` in your own configuration —
substitute the public address where you expose the relay.

### Cross-origin callers

If browsers on other origins (for example a desktop shell or a separately hosted
web UI) connect to the relay, list their origins in `CYBORG_CORS_ORIGINS`
(comma-separated):

```bash
CYBORG_CORS_ORIGINS=https://app.example.com,https://relay.example.com
```

A relay that serves its own UI same-origin needs no CORS configuration. When
`CYBORG_CORS_ORIGINS` is unset the relay allows all origins, which is convenient
for local development but should be tightened in production.

---

## Production checklist

Before you put a relay in front of a team, confirm each of these.

- **Set a strong `CYBORG7_JWT_SECRET`.** This is the JWT signing secret. With
  `NODE_ENV=production`, the relay and daemon **refuse to boot** if the secret is
  missing or left at the source-visible development default — running with that
  default would let anyone forge tokens. Generate a long random value and supply
  it through your secrets manager, not in source control.

- **Use a managed or backed-up PostgreSQL.** This database is the shared source
  of truth for every workspace, channel, message, and task. Treat it as
  production data: backups, point-in-time recovery, and monitoring.

- **Terminate TLS in front of the relay.** The relay speaks plain HTTP +
  WebSocket. Put it behind a reverse proxy or load balancer that terminates TLS,
  and expose only the HTTPS/WSS endpoint to daemons and browsers.

- **(Optional) Redis for relay scale-out.** A single relay process works for most
  teams. To run more than one relay instance, set `REDIS_URL` so instances share
  pub/sub and deliver messages to daemons connected to any instance.

- **(Optional) S3 for assets.** To store workspace assets in S3, set
  `S3_ASSETS_BUCKET` (and `S3_ASSETS_REGION`, default `us-east-1`) together with
  `S3_ASSETS_ACCESS_KEY_ID` and `S3_ASSETS_SECRET_ACCESS_KEY`. Uploads use
  presigned URLs. Leave these unset if you do not need shared asset storage.

- **Have a provider CLI on each daemon machine.** Agents run on daemons, so every
  machine that runs agents needs at least one supported provider (Claude Code,
  Codex, Copilot, OpenCode, or Pi) installed and authenticated. The relay needs
  none — it runs no agents.

---

## What runs where

| Component                | Where it runs             | Runs agents? | Needs PostgreSQL?                |
| ------------------------ | ------------------------- | ------------ | -------------------------------- |
| Local daemon (solo)      | Each user's machine       | Yes          | No — SQLite only                 |
| Local daemon (connected) | Each user's machine       | Yes          | Yes — shared, via `DATABASE_URL` |
| Cloud relay              | A shared host you operate | **No**       | Yes                              |

Agents always run on the daemon that spawned them, never on the relay. The relay
is a stateless message broker in front of shared PostgreSQL — keep that boundary
in mind when sizing and securing your deployment.

For the complete environment reference, see
[`./configuration.md`](./configuration.md); for the request and message flow, see
[`./architecture.md`](./architecture.md).

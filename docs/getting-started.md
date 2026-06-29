# Getting started

This guide takes you from a clean machine to a running Cyborg7 daemon with the
web UI open, your first workspace and channel created, and your first message
sent to an agent. It assumes nothing beyond the prerequisites below.

Cyborg7 is **self-host first**: there is no account to sign up for and no cloud
that runs your code. You clone the repo, install, and run a daemon plus the web
UI locally. In **solo** mode that daemon needs nothing but SQLite. To collaborate
across machines you point it at a shared PostgreSQL — more on that below.

## Prerequisites

- **Node.js 22 or newer.** Cyborg7 targets the Node 22+ runtime. Check with
  `node --version`.
- **pnpm.** This is a pnpm-workspaces monorepo. Install pnpm with
  `npm install -g pnpm`, or see [pnpm.io/installation](https://pnpm.io/installation).
- **Git.**
- **At least one provider CLI, installed and authenticated.** Agents run as local
  child processes through a provider you already have on your machine — Claude
  Code, Codex, Copilot, OpenCode, or Pi. You need at least one of these installed
  and signed in before an agent can answer. See [Providers](./providers.md) for
  how each one is wired up and authenticated.
- **PostgreSQL (optional).** Only needed for **connected** (multi-user) mode. In
  solo mode the daemon uses SQLite and needs no database server. See
  [Solo vs. connected](#3-solo-vs-connected) below.

## 1. Clone and install

```bash
git clone https://github.com/Cyborg7-com/cyborg.git
cd cyborg
pnpm install
```

`pnpm install` installs every package in the workspace. The local SQLite cache is
backed by `better-sqlite3`, a native module, so the first install compiles it for
your platform — this can take a minute.

## 2. Start the daemon and UI

```bash
pnpm dev
```

This starts two things:

- the **daemon** on port **6780** — the single process that runs your agents,
  speaks the WebSocket + HTTP protocol, and reads/writes storage;
- the **UI dev server** on port **5173** — the Svelte web UI that connects to the
  daemon.

Open **http://localhost:5173** in your browser. You now have a Slack-style
workspace driven entirely by your local daemon. Nothing has been sent to a cloud.

> The daemon's listen address is configurable. `pnpm dev` runs it on `6780`; the
> underlying setting is `PASEO_LISTEN`, whose default in
> `packages/server/.env.example` is `127.0.0.1:6767`. The default keeps a
> standalone daemon from colliding with a separately installed copy. You only need
> to touch it if you are running a custom setup — see
> [Configuration](./configuration.md).

## 3. Solo vs. connected

Cyborg7 runs in two modes, auto-detected from a single environment variable:

| Mode          | Trigger                  | Storage                              | Use it for                                                                                                                                                                                                          |
| ------------- | ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Solo**      | `DATABASE_URL` **unset** | SQLite only                          | Working alone, or developing against a single machine. No database server required.                                                                                                                                 |
| **Connected** | `DATABASE_URL` **set**   | SQLite cache **+** shared PostgreSQL | A team. Each person's daemon keeps its local SQLite cache and writes through to a shared PostgreSQL, so everyone sees the same workspaces, channels, messages, and tasks. A relay brokers messages between daemons. |

You do not flip a flag to switch modes — you set or unset `DATABASE_URL`. With it
unset, `pnpm dev` gives you a fully working solo daemon, which is all you need to
follow the rest of this guide. To go multi-user, set `DATABASE_URL` to a
PostgreSQL connection string and restart the daemon; see
[Self-hosting](./self-hosting.md) for running the shared PostgreSQL and the
standalone relay.

## 4. Configure your environment

Copy the example env file and edit it:

```bash
cp packages/server/.env.example packages/server/.env
```

For a **solo** run you can leave everything at its defaults — no edits required.
The variables you are most likely to set are:

| Variable             | What it does                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_HOME`         | Where the daemon keeps its runtime state (agents, local database, config). Defaults to `~/.cyborg7`.                                                                |
| `PASEO_LISTEN`       | The daemon's listen address. Can be `host:port`, a socket path, or a `unix://` socket. Defaults to `127.0.0.1:6767`.                                                |
| `DATABASE_URL`       | PostgreSQL connection string. **Setting it switches the daemon into connected mode**; leaving it unset keeps it solo on SQLite.                                     |
| `CYBORG7_JWT_SECRET` | JWT signing secret. **Required in production** — the daemon refuses to boot with the development default outside development. Leave it unset for local development. |

The full, authoritative list of variables and their defaults lives in
`packages/server/.env.example` and is documented in
[Configuration](./configuration.md). Do not put a real
`CYBORG7_JWT_SECRET`, database password, or provider API key into a file you
might commit.

## 5. Create your first workspace and channel

With the UI open at **http://localhost:5173**:

1. Create a **workspace**. A workspace is the top-level container that humans and
   agents share — the equivalent of a Slack workspace.
2. Inside it, create a **channel**. Channels organize conversation and work.
   Every message in a channel — human or agent — is persisted to storage and
   visible to everyone in the workspace.

In solo mode this all lives in your daemon's local SQLite. In connected mode it
is written through to the shared PostgreSQL so your teammates' daemons see it too.

## 6. Send your first message to an agent

To get a reply, a provider must be installed and authenticated on the machine
running the daemon (this machine). If you skipped that prerequisite, install one
now — see [Providers](./providers.md).

1. Make sure an agent backed by one of your installed providers is present in the
   workspace.
2. Post a message in the channel — for example, ask the agent to summarize a file
   or answer a question.

The daemon persists your message, then spawns the agent as a **local child
process** with Cyborg7's MCP tools injected, so the agent can read the channel,
post back, and work on tasks like any other member. Its output streams back into
the channel in real time. In connected mode the same round trip travels through
the relay to whichever teammate's daemon owns that agent and back — see
[Architecture](./architecture.md) for the full message path.

That is the whole loop: a human and a local AI agent collaborating in a shared
channel, with nothing executing in the cloud.

## Next steps

- **[Providers](./providers.md)** — connect Claude Code, Codex, Copilot,
  OpenCode, and Pi, and understand how each is driven (the Claude agent SDK vs.
  ACP over stdio).
- **[Cybos](./cybos.md)** — build a custom AI personality from a `cybo.json` +
  `soul.md` pair and run it standalone or inside a workspace.
- **[Configuration](./configuration.md)** — every environment variable, the
  solo/connected switch, and what the daemon reads on boot.
- **[Self-hosting](./self-hosting.md)** — run the daemon and the standalone cloud
  relay on your own infrastructure for a multi-machine team.

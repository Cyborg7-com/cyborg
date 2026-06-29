# Troubleshooting

Common failure modes when running a Cyborg7 daemon or relay, in **Symptom → Cause → Fix** form. For the full list of environment variables and what they do, see [`./configuration.md`](./configuration.md); for production deployment guidance, see [`./self-hosting.md`](./self-hosting.md).

If your symptom isn't here, check the daemon's console output first — Cyborg7 fails explicitly and the error message usually names the cause.

---

## The daemon refuses to boot in production

**Symptom**

The daemon exits immediately on startup with:

```
CYBORG7_JWT_SECRET must be set to a strong secret in production — refusing to boot with the public dev default.
```

**Cause**

`CYBORG7_JWT_SECRET` is the JWT signing secret. In production (`NODE_ENV=production`) the daemon refuses to boot if the secret is missing or still set to the source-visible development default. The default value is public — anyone could forge tokens with it — so it is never allowed to run a production deployment.

Outside production the development default is permitted for local convenience, so this error only appears once `NODE_ENV=production` is set.

**Fix**

Set `CYBORG7_JWT_SECRET` to a strong, random value in the deploy environment and restart:

```bash
# generate a strong secret
openssl rand -hex 32

# then provide it to the daemon (do not commit it)
export CYBORG7_JWT_SECRET="<the-generated-value>"
```

Keep the secret out of version control — inject it through the deploy environment, not a checked-in `.env`. See [`./configuration.md`](./configuration.md) for where this and the other variables live.

---

## Port already in use

**Symptom**

Startup fails with an address-in-use error such as `EADDRINUSE`, and the daemon or UI dev server never comes up.

**Cause**

Something is already listening on the port Cyborg7 wants. The daemon's listen address comes from `PASEO_LISTEN` (default `127.0.0.1:6767`). The UI dev server runs separately on its own port (`5173` by default). A second daemon, a leftover process from a previous run, or another app can hold the port.

**Fix**

Pick a free port (or stop whatever is holding the one you want). To move the daemon, set `PASEO_LISTEN`:

```bash
# host:port — also accepts a unix socket path
export PASEO_LISTEN=127.0.0.1:6790
```

`PASEO_LISTEN` accepts `host:port`, `/path/to/socket`, or `unix:///path/to/socket`. If the UI dev port (`5173`) is taken, the dev server will tell you and offer the next free port. See [`./configuration.md`](./configuration.md) for the full address syntax.

---

## A provider isn't detected

**Symptom**

You ask an agent to run with a given provider (Claude Code, Codex, Copilot, OpenCode, or Pi) and the daemon reports that the provider is unavailable, or the agent never starts.

**Cause**

Agents execute **locally** on the daemon's machine as child processes. A provider is only usable if its CLI is **installed and authenticated on that machine**. The most common causes are:

- the provider's CLI is not installed, or not on the daemon's `PATH`,
- the CLI is installed but not logged in / authenticated,
- the daemon was started from an environment that doesn't see the CLI (for example a service manager with a minimal `PATH`).

**Fix**

On the machine running the daemon:

1. Install at least one supported provider CLI — Claude Code, Codex, Copilot, OpenCode, or Pi. Claude runs through the [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk); the others connect over ACP (Agent Client Protocol) on stdio.
2. Authenticate that CLI directly (run its own login flow) and confirm it works standalone.
3. Make sure the daemon's environment can find it on `PATH`. If you launch the daemon from a service manager, give it the same `PATH` your shell uses.
4. Restart the daemon so it re-detects available providers.

Cyborg7 does not bundle provider credentials — each provider handles its own auth on the daemon machine.

---

## Cannot connect to PostgreSQL

**Symptom**

In connected mode the daemon (or the relay) cannot reach the database. You see connection-refused, authentication-failed, or TLS/SSL handshake errors, and shared state never loads.

**Cause**

This is driven by `DATABASE_URL`. Common reasons:

- `DATABASE_URL` is wrong — bad host, port, database name, user, or password.
- The database isn't reachable from where the daemon runs (network, firewall, or it isn't running).
- **TLS mismatch with a managed Postgres.** Managed providers typically require TLS. Cyborg7 negotiates SSL when the connection string asks for it (for example `sslmode=require`); without that, a connection to a managed database can be rejected before it ever authenticates.

**Fix**

1. Confirm `DATABASE_URL` is a valid Postgres connection string and that the database is reachable from the daemon's host (try connecting with `psql` or your provider's console using the same values).
2. For a managed Postgres that requires TLS, include `sslmode=require` in the connection string so the daemon negotiates SSL:

   ```bash
   export DATABASE_URL="postgres://user:password@your-db-host:5432/cyborg7?sslmode=require"
   ```

3. Restart the daemon and watch the startup output for the connection result.

> Note: if `DATABASE_URL` is set but the Postgres connection fails, the daemon logs a warning and **falls back to solo mode** rather than refusing to start. That keeps the daemon up, but it will not see shared state — which is the next symptom.

See [`./self-hosting.md`](./self-hosting.md) for production database setup.

---

## Teammates can't see each other

**Symptom**

Two or more people are running daemons, but they don't share workspaces, channels, messages, or tasks — each one only sees its own local data.

**Cause**

Cyborg7 auto-detects its run mode from `DATABASE_URL`:

- **Solo** — no `DATABASE_URL`. The daemon uses SQLite only. Nothing is shared.
- **Connected** — `DATABASE_URL` set. The daemon keeps its local SQLite cache and writes through to a shared PostgreSQL, and the relay brokers messages between daemons.

If teammates can't see each other, at least one daemon is effectively in solo mode. Either it has no `DATABASE_URL`, or its `DATABASE_URL` failed to connect and it silently fell back to solo (see the previous symptom), or the daemons are pointed at **different** PostgreSQL databases.

**Fix**

1. Make sure **every** daemon that should collaborate sets `DATABASE_URL` and that it points at the **same** shared PostgreSQL.
2. Check each daemon's startup output for the solo-mode fallback warning — if a daemon couldn't connect, fix that connection (see "Cannot connect to PostgreSQL" above) before expecting it to share state.
3. Confirm the daemons reach each other through a reachable relay, so brokered messages actually flow between machines.
4. Restart the daemons after correcting the configuration.

See [`./self-hosting.md`](./self-hosting.md) for how to stand up the shared PostgreSQL and relay that connected mode depends on.

---

## Dependency or install errors

**Symptom**

`pnpm install`, `pnpm dev`, or `pnpm build` fails with dependency-resolution errors, native-module build failures (for example `better-sqlite3`), or engine/version warnings.

**Cause**

Cyborg7 is a **pnpm workspace** and targets **Node.js 22+**. The usual causes are an unsupported Node version, using `npm`/`yarn` instead of `pnpm` (which breaks workspace resolution), or a partial / stale `node_modules`.

**Fix**

1. Use Node.js **22 or newer**:

   ```bash
   node --version
   ```

2. Use **pnpm** — not `npm` or `yarn` — so workspace packages resolve correctly:

   ```bash
   pnpm install
   ```

3. If the install is still broken, clear it and reinstall from scratch:

   ```bash
   rm -rf node_modules
   pnpm install
   ```

Native modules like `better-sqlite3` compile against your Node version, so a Node upgrade after a successful install can require a fresh `pnpm install`.

---

## Still stuck?

- Re-read the error: Cyborg7 throws explicit, named errors — the message usually points straight at the variable or dependency at fault.
- Review every variable and its default in [`./configuration.md`](./configuration.md).
- For production topology — relay, shared PostgreSQL, and how the pieces connect — see [`./self-hosting.md`](./self-hosting.md).

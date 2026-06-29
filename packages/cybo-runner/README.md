# cybo

Run any **Cybo** agent standalone — a lightweight persona layer on top of [PI](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). A Cybo is just a `cybo.json` (identity + provider/model) and a `soul.md` (personality / system prompt); `cybo` spawns PI with that personality injected. PI ships **inside** cybo, so the only prerequisite is Node 20+.

## Install

### curl (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/Cyborg7-com/cyborg7-releases/main/cybo/install.sh | sh
```

Installs the launcher to `~/.local/bin/cybo` and the app to `~/.local/share/cybo`, and adds `~/.local/bin` to your PATH. Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Cyborg7-com/cyborg7-releases/main/cybo/install.ps1 | iex
```

### npm

```sh
npm i -g @cyborg7/cybo
```

### First run

PI needs a one-time login (cybo bundles PI but not your credentials):

```sh
cybo config        # opens PI config; sign in once
cybo doctor        # verify PI, auth, and your model
```

## Usage

```sh
cybo init                          # create cybo.json + soul.md in this dir
cybo link                          # register it in ~/.cybo/agents/
cybo list                          # list registered cybos
cybo @pi "what can you do?"        # invoke a registered cybo by slug
cybo "summarize this repo"         # auto-detect cybo from cwd / default
cybo --thinking high "solve this"  # deep reasoning
cybo --continue                    # resume the last session
cybo upgrade                       # update cybo to the latest version
```

Run `cybo --help` for the full command and flag reference, or see [`docs/`](./docs).

## Updates

cybo checks for a newer release at most once a day (cached, fetched in the background, printed on stderr) and shows a one-line notice when one is available. It never blocks a command. Update with:

```sh
cybo upgrade   # re-runs the curl installer, or `npm i -g @cyborg7/cybo@latest` if installed via npm
```

Opt out with `CYBO_NO_UPDATE_CHECK=1` (also skipped under `CI`).

## How PI is resolved

`cybo` resolves PI in this order: `--pi-command` flag → `PI_COMMAND` env → **the PI bundled inside cybo** (invoked via the current Node, so it never depends on your PATH or a `.proto`/alias shim) → `pi` on PATH. This is why `cybo` works even when `pi` isn't on your PATH.

## Uninstall

```sh
cybo uninstall          # removes the curl-installed launcher + app (keeps your ~/.cybo agents)
# or, if installed via npm:
npm rm -g @cyborg7/cybo
```

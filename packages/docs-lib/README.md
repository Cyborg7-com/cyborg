# @cyborg7/docs-lib

Dependency-free parser / index / search / nav for the Cyborg7 Markdown docs
corpus. Single source of truth shared by:

- the cybo **`cyborg7_read_docs` MCP tool** (`packages/server/.../docs-index.ts`)
  — reads the corpus at runtime to answer a user's "how do I…?";
- the **docs site** (`packages/docs`, Astro Starlight) — publishes the same tree.

`resolveDocsDir()` finds the corpus dir (`packages/docs/src/content/docs`) in this
order: explicit `override` → `CYBORG7_DOCS_DIR` env → walk **up** from this lib's
own module dir for the first ancestor that contains `packages/docs/src/content/docs`.
It is fail-soft (missing dir → `null` → the tool returns "no docs", never throws).

## The corpus-bundling contract (release-time)

The library resolves the corpus; it does **not** ship it. Every service that runs
the daemon/MCP must ship the corpus at release time so `resolveDocsDir()` finds it
in prod. Mirrors OpenClaw, which ships its `docs/` inside the distributable.

| Service | Corpus lands at | Resolves via |
| --- | --- | --- |
| **Relay** (`.github/workflows/relay-deploy.yml`) | `/opt/cyborg7/packages/docs/src/content/docs/` (rsynced, always, outside the change-gate — static Markdown, no restart) | walk-up **and** `CYBORG7_DOCS_DIR` (set in the managed-env block). The `packages/docs-lib/` member dir is **also** rsynced — it's a `workspace:*` dep of `packages/server`, so the host `pnpm install` aborts (`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`) without it. |
| **Desktop** (`packages/desktop-cyborg/`) | `Contents/Resources/docs` via `electron-builder.yml` `extraResources` (`from: ../docs/src/content/docs`, `to: docs`) | `CYBORG7_DOCS_DIR` — `daemon-manager.ts` sets it to `path.join(process.resourcesPath, "docs")` when `app.isPackaged` (the daemon bundle has no `packages/docs/` tree, so walk-up can't reach it). |
| **Headless CLI** (`packages/cli/scripts/build-bundle.mjs`) | `app/packages/docs/src/content/docs` (copied into the tarball) | walk-up (from `app/node_modules/@cyborg7/docs-lib`) **and** `CYBORG7_DOCS_DIR` (exported by the `install.sh` launcher). |

`@cyborg7/docs-lib` itself already ships to desktop + CLI as a normal `workspace:*`
prod dep of `@getpaseo/server` (collected by `pnpm deploy --prod`); only the
**corpus content** needs the extra wiring above.

**Corpus content is owned by the docs agent** — the release/bundle wiring only
mirrors the files; do not edit the corpus here.

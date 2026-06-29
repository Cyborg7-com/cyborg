# Shell Wrappers

Open Slack Headless is shell-agnostic — the same SvelteKit build runs in Electron, Tauri, or a standalone browser. The shell only provides the window and native APIs.

## How it works

The UI is built with `adapter-static`, producing a set of static HTML/JS/CSS files that any shell can serve:

```bash
pnpm build
# Output: packages/ui/build/
```

Each shell wrapper:

1. Serves the static build from a local file server or embedded assets
2. Opens a window (native or browser tab)
3. Optionally provides native APIs (file system, notifications, system tray)

## Electron (temporary)

`packages/desktop-electron/` — Current desktop shell.

Electron wraps the static build in a Chromium window:

```
Electron main process
  └── BrowserWindow
        └── loads file:///build/index.html
              └── SvelteKit app
                    └── WebSocket → local daemon
```

Electron is marked as "temporary" — it works but has high memory overhead (~300MB per window). It will be replaced by Tauri for production.

## Tauri 2 (progressive)

`packages/desktop-tauri/` — Target desktop and mobile shell.

Tauri uses the OS webview instead of bundling Chromium:

```
Tauri main process (Rust)
  └── OS WebView (WebKit on macOS, WebView2 on Windows)
        └── loads tauri://localhost/index.html
              └── SvelteKit app
                    └── WebSocket → local daemon
```

Benefits over Electron:

- ~10MB binary vs ~300MB
- Native performance
- Android/iOS support via Tauri 2 mobile targets
- Rust backend for native operations

## Standalone browser

No wrapper needed. Start a daemon and point your browser at the UI dev server:

```bash
# Terminal 1: start daemon
cd packages/server && pnpm dev

# Terminal 2: start UI
cd packages/ui && pnpm dev
# Open http://localhost:5173
```

For production, serve the static build from any web server (Nginx, Caddy, S3 + CloudFront).

## Shell-agnostic rules

To keep the UI portable across shells:

1. **No `window.require()`** — Don't import Electron or Tauri APIs directly in UI components
2. **No filesystem access** — All file operations go through the daemon via WebSocket
3. **No native notifications** — Use the daemon's notification system or web notifications
4. **WebSocket only** — No HTTP, no `fetch()` for data, no SSE
5. **`adapter-static`** — No server-side rendering, no `+page.server.ts` files
6. **Relative paths** — No hardcoded localhost URLs (the daemon URL is configured at login)

## When you need native APIs

If a feature needs native capabilities (e.g., system tray, file drag-and-drop, native menus):

1. Define an interface in the UI (e.g., `NativeBridge`)
2. Implement it in each shell wrapper
3. Inject it via a global or Svelte context
4. The UI calls the interface — the shell provides the implementation

This keeps the UI testable and shell-independent.

## Next steps

- [Connecting to a daemon](./17-connecting-to-daemon.md) — Auth flow for any shell
- [Architecture overview](./03-architecture.md) — System context

# @cyborg7/desktop-cyborg

Electron desktop app for Cyborg7. Cloud-only — connects to the EC2 relay, no embedded daemon.

## How It Works

The Electron shell loads the static SvelteKit UI from `packages/ui/build/` and provides:

- Window management (title bar, dock icon)
- `electron-log` for logging
- `ws` for WebSocket connectivity (Node.js WebSocket, not browser)
- `preload.cts` bridge for IPC

No business logic lives here. All workspace/channel/agent logic is in the UI package and the relay.

## Build

```bash
# 1. Build the UI
cd packages/ui && pnpm build

# 2. Compile TypeScript
cd packages/desktop-cyborg && npx tsc -p tsconfig.json

# 3. Build DMG
npx electron-builder --config electron-builder.yml --mac
```

Output: `release/Cyborg-0.0.1-arm64.dmg`

## Release

```bash
gh release create v0.0.X-alpha \
  --title "Cyborg7 v0.0.X-alpha" \
  --notes "Release notes here" \
  --prerelease \
  release/Cyborg-0.0.1-arm64.dmg#Cyborg-vX-arm64.dmg
```

The DMG filename stays `Cyborg-0.0.1-arm64.dmg` regardless of release number. The `#` suffix renames the asset in GitHub Releases.

## Notes

- **Not code-signed** — users need right-click > Open on first launch (macOS Gatekeeper)
- **arm64 only** (Apple Silicon)
- `after-pack.cjs` injects `electron-log` and `ws` into the asar, prunes native modules (onnxruntime, node-pty, sharp) if present
- `asarUnpack` only includes `dist/daemon-entrypoint-runner.js`
- After removing a dependency, always check `electron-builder.yml` for stale `asarUnpack` entries
- Version in `package.json` is `0.0.1` — doesn't change per release

## Files

| File                          | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `main.ts`                     | Electron main process entry                        |
| `preload.cts`                 | Context bridge for renderer                        |
| `after-pack.cjs`              | Post-build hook: inject deps, prune native modules |
| `electron-builder.yml`        | Build config (DMG, asar, signing)                  |
| `daemon-entrypoint-runner.ts` | Cloud-mode daemon bootstrap (minimal)              |
| `daemon-manager.ts`           | Daemon process lifecycle                           |

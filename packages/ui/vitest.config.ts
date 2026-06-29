import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Standalone config so `pnpm --filter @cyborg7/ui test` (and the root
// `npm run test --workspaces --if-present`) runs the ui unit tests. Plain node
// environment: these are pure-TS helpers (agent-display, notify-policy,
// render-markdown), no DOM needed.
//
// The svelte() plugin is here to COMPILE `*.svelte.ts` rune modules (e.g. the
// terminal-sessions store, #701) so a test can import them and `$state` resolves
// to the compiled signal instead of throwing "$state is not defined". It only
// transforms `.svelte` / `.svelte.(ts|js)` files — plain `.ts` helpers pass
// through untouched, so the existing node-env tests are unaffected.
//
// `$lib` alias: SvelteKit resolves `$lib` via its generated tsconfig, but this
// standalone vitest config doesn't inherit that, so a test importing a runtime
// module that itself imports `$lib/...` (e.g. media/clipboard.ts → $lib/utils.js)
// would otherwise fail to resolve. Map it to src/lib so those tests run.
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL("./src/lib", import.meta.url)),
    },
    // Prefer svelte's BROWSER build so a test can mount() a real component (the
    // server build throws "mount(...) is not available on the server"). The rune-
    // module tests (.svelte.ts) are unaffected — they import compiled signals, not
    // the lifecycle runtime.
    conditions: ["browser"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Component lifecycle tests (*.lifecycle.test.ts) mount real .svelte components
    // and need a DOM; everything else stays node-env (pure helpers / rune modules).
    environmentMatchGlobs: [["**/*.lifecycle.test.ts", "jsdom"]],
  },
});

import type { Env, Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Returns a reader for a text file that re-reads it from disk ONLY when its
 * mtime changes, and serves the last good copy if the file is briefly missing
 * (e.g. mid-rsync). Cheap (one stat per call) and, crucially, correct across
 * deploys: the content tracks whatever is on disk now, not what existed at boot.
 */
export function createFreshFileReader(filePath: string): () => string {
  let cached = readFileSync(filePath, "utf-8");
  let cachedMtimeMs = statSync(filePath).mtimeMs;
  return () => {
    try {
      const { mtimeMs } = statSync(filePath);
      if (mtimeMs !== cachedMtimeMs) {
        cached = readFileSync(filePath, "utf-8");
        cachedMtimeMs = mtimeMs;
      }
    } catch {
      // File briefly absent (a UI rsync deletes+rewrites) — keep serving the
      // last good shell rather than throwing on the request.
    }
    return cached;
  };
}

/**
 * Mount the SvelteKit (adapter-static) web UI from `uiDist` on `app`: hashed
 * assets via serveStatic, plus an SPA fallback for client-side routes (deep
 * links / reloads). Returns true if a build was found and mounted.
 *
 * The fallback shell (index.html) is re-read from disk when it CHANGES on deploy
 * — never cached for the process lifetime. The relay deploy rsyncs a new UI
 * build with `--delete` and intentionally skips the relay restart for UI-only
 * releases (see cyborg-desktop-release.yml `deploy-relay`). Caching the shell at
 * boot made the relay keep serving an old index.html that referenced chunk
 * hashes the rsync had already deleted: every chunk request fell through to this
 * SPA fallback and returned index.html as text/html, so the browser refused to
 * execute it as a module ("Failed to load module script") → blank app until a
 * manual restart. Reading fresh-per-change makes a UI-only deploy land live, as
 * the deploy's no-restart path assumes.
 */
export function mountWebUi<E extends Env>(app: Hono<E>, uiDist: string): boolean {
  // adapter-static is configured with `fallback: "index.html"` (svelte.config.js),
  // so the SPA fallback page is build/index.html. Prefer 200.html if a project
  // ever switches the adapter to that convention.
  const spaFallbackFile = existsSync(join(uiDist, "200.html"))
    ? join(uiDist, "200.html")
    : join(uiDist, "index.html");

  if (!existsSync(spaFallbackFile)) {
    console.log(
      `[server] No web UI build at ${uiDist} (set CYBORG_UI_DIST) — running as API/WS backend only`,
    );
    return false;
  }

  // serveStatic resolves `root` relative to process.cwd(); make our (possibly
  // absolute) dist dir cwd-relative so assets resolve regardless of where the
  // relay was launched from.
  const staticRoot = relative(process.cwd(), uiDist) || ".";
  const readShell = createFreshFileReader(spaFallbackFile);

  // 1) Real assets (js/css/images/index.html). Anything not found here falls
  //    through to the SPA fallback below. The `/api/*` + WS routes are already
  //    registered above, so this never sees them.
  app.use("/*", serveStatic({ root: staticRoot }));
  // 2) SPA fallback: a GET for a client-side route (no matching file) gets the
  //    shell so deep links / reloads work. Scoped away from /api/*, /mcp, /relay
  //    so a missing API path still returns a real 404, not HTML. `no-cache` so a
  //    browser reload always revalidates the entry point and never pins a stale
  //    shell that points at chunk hashes a later deploy has removed.
  app.get("*", (c) => {
    const p = c.req.path;
    if (p.startsWith("/api/") || p === "/mcp" || p === "/relay") return c.notFound();
    c.header("Cache-Control", "no-cache");
    return c.html(readShell());
  });
  console.log(`[server] Serving web UI from ${uiDist}`);
  return true;
}

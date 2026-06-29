import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFreshFileReader, mountWebUi } from "./web-ui.js";

// A SvelteKit adapter-static shell references content-hashed module chunks.
// Each release produces NEW hashes; a `--delete` rsync removes the old files.
function shellHtml(chunk: string): string {
  return `<!doctype html><html><head><script type="module" src="/_app/immutable/entry/${chunk}"></script></head><body></body></html>`;
}

// Force a strictly-later mtime so the reader's mtime check fires deterministically
// (two writes in the same millisecond could otherwise collide).
function bumpMtime(file: string): void {
  const future = new Date(Date.now() + 10_000);
  utimesSync(file, future, future);
}

describe("mountWebUi", () => {
  let dist: string;

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), "cyborg-ui-"));
    mkdirSync(join(dist, "_app", "immutable", "entry"), { recursive: true });
  });
  afterEach(() => rmSync(dist, { recursive: true, force: true }));

  function writeShell(chunk: string): void {
    writeFileSync(join(dist, "index.html"), shellHtml(chunk));
  }

  it("serves the SPA shell (as html) for a deep-link client route", async () => {
    writeShell("start.AAA.js");
    const app = new Hono();
    expect(mountWebUi(app, dist)).toBe(true);

    const res = await app.request("/invite/da1603ca532e3a9d");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    expect(await res.text()).toContain("start.AAA.js");
  });

  it("serves a real hashed asset from disk, not the fallback shell", async () => {
    writeShell("start.AAA.js");
    writeFileSync(
      join(dist, "_app", "immutable", "entry", "start.AAA.js"),
      "export const ok = 1;\n",
    );
    const app = new Hono();
    mountWebUi(app, dist);

    const res = await app.request("/_app/immutable/entry/start.AAA.js");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("export const ok = 1;");
    expect(body).not.toContain("<!doctype html>");
  });

  it("returns a real 404 (not HTML) for a missing /api/* path", async () => {
    writeShell("start.AAA.js");
    const app = new Hono();
    mountWebUi(app, dist);

    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("<!doctype html>");
  });

  // The exact prod failure: a UI-only release rsyncs a new build (new chunk
  // hashes) and SKIPS the relay restart. The served shell MUST reflect the new
  // build, or its module requests 404 into this fallback (text/html) → blank app.
  it("live-reloads the shell after a UI redeploy WITHOUT a process restart", async () => {
    writeShell("start.OLD.js");
    const app = new Hono();
    mountWebUi(app, dist);

    const before = await (await app.request("/invite/x")).text();
    expect(before).toContain("start.OLD.js");

    // Simulate the deploy: overwrite the shell in place with new hashes, new mtime.
    writeShell("start.NEW.js");
    bumpMtime(join(dist, "index.html"));

    const after = await (await app.request("/invite/x")).text();
    expect(after).toContain("start.NEW.js");
    expect(after).not.toContain("start.OLD.js");
  });

  it("sends Cache-Control: no-cache on the shell so reloads revalidate", async () => {
    writeShell("start.AAA.js");
    const app = new Hono();
    mountWebUi(app, dist);

    const res = await app.request("/invite/x");
    expect(res.headers.get("cache-control") ?? "").toContain("no-cache");
  });

  it("returns false and mounts nothing when no build dir exists", () => {
    const app = new Hono();
    expect(mountWebUi(app, join(dist, "does-not-exist"))).toBe(false);
  });
});

describe("createFreshFileReader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cyborg-reader-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("re-reads only on mtime change and serves the last good copy if the file vanishes", () => {
    const f = join(dir, "index.html");
    writeFileSync(f, "v1");
    const read = createFreshFileReader(f);
    expect(read()).toBe("v1");

    // Same content+mtime → no surprise; new content+mtime → reload.
    writeFileSync(f, "v2");
    bumpMtime(f);
    expect(read()).toBe("v2");

    // Briefly missing (mid-rsync) → last good copy, no throw.
    rmSync(f);
    expect(read()).toBe("v2");
  });
});

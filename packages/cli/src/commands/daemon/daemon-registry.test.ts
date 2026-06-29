import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerDaemonHome,
  unregisterDaemonHome,
  listRunningDaemonHomes,
  resolveTargetHome,
} from "./daemon-registry.js";

describe("resolveTargetHome (#665 multi-home inference)", () => {
  const defaultHome = "/home/u/.cyborg7";

  it("explicit --home always wins", () => {
    expect(
      resolveTargetHome({ explicitHome: "/custom", defaultHome, runningHomes: [defaultHome] }),
    ).toEqual({ home: "/custom", reason: "explicit", candidates: [] });
  });

  it("uses the default home when it's the one running", () => {
    const r = resolveTargetHome({ defaultHome, runningHomes: [defaultHome] });
    expect(r.home).toBe(defaultHome);
    expect(r.reason).toBe("default-running");
  });

  it("INFERS the sole running daemon when the default isn't running (the fix)", () => {
    const r = resolveTargetHome({ defaultHome, runningHomes: ["/home/u/.cyborg7-dev"] });
    expect(r).toEqual({
      home: "/home/u/.cyborg7-dev",
      reason: "inferred",
      candidates: ["/home/u/.cyborg7-dev"],
    });
  });

  it("is ambiguous when several non-default daemons run (caller must pick)", () => {
    const r = resolveTargetHome({ defaultHome, runningHomes: ["/a", "/b"] });
    expect(r.home).toBeNull();
    expect(r.reason).toBe("ambiguous");
    expect(r.candidates.sort()).toEqual(["/a", "/b"]);
  });

  it("falls back to the default when nothing is running", () => {
    const r = resolveTargetHome({ defaultHome, runningHomes: [] });
    expect(r).toEqual({ home: defaultHome, reason: "default-fallback", candidates: [] });
  });

  it("prefers the default even if other daemons also run", () => {
    const r = resolveTargetHome({ defaultHome, runningHomes: [defaultHome, "/other"] });
    expect(r.home).toBe(defaultHome);
    expect(r.reason).toBe("default-running");
  });
});

describe("registry file round-trip + prune", () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cyborg-reg-"));
    env = { CYBORG_DAEMON_REGISTRY: join(dir, "daemons.json") } as NodeJS.ProcessEnv;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("register/unregister persists homes", () => {
    registerDaemonHome("/a", env);
    registerDaemonHome("/b", env);
    registerDaemonHome("/a", env); // de-duped
    const file = JSON.parse(readFileSync(env.CYBORG_DAEMON_REGISTRY!, "utf8"));
    expect(file.homes.sort()).toEqual(["/a", "/b"]);
    unregisterDaemonHome("/a", env);
    expect(JSON.parse(readFileSync(env.CYBORG_DAEMON_REGISTRY!, "utf8")).homes).toEqual(["/b"]);
  });

  it("listRunningDaemonHomes prunes dead entries from the file", () => {
    registerDaemonHome("/alive", env);
    registerDaemonHome("/dead", env);
    const running = listRunningDaemonHomes((home) => home === "/alive", env);
    expect(running).toEqual(["/alive"]);
    // /dead was pruned from disk.
    expect(JSON.parse(readFileSync(env.CYBORG_DAEMON_REGISTRY!, "utf8")).homes).toEqual(["/alive"]);
  });

  it("missing registry → empty list, no throw", () => {
    expect(listRunningDaemonHomes(() => true, env)).toEqual([]);
    expect(existsSync(env.CYBORG_DAEMON_REGISTRY!)).toBe(false);
  });
});

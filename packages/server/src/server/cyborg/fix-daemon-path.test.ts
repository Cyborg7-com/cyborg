import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { augmentDaemonPath } from "./fix-daemon-path.js";

// Minimal logger stub (pino-shaped) — the helper only calls info/debug.
const logger = {
  info: () => {},
  debug: () => {},
} as unknown as Parameters<typeof augmentDaemonPath>[0];

describe("augmentDaemonPath", () => {
  let savedPath: string | undefined;
  beforeEach(() => {
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  // The bug: GUI-launched macOS daemon gets the minimal PATH and can't find cybo/pi/npm.
  const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

  it("adds Homebrew/npm-global dirs to a GUI-minimal PATH (darwin)", async () => {
    process.env.PATH = MINIMAL_PATH;
    const r = await augmentDaemonPath(logger, {
      platform: "darwin",
      homeDir: "/Users/test",
      probeLoginShellPath: async () => [], // simulate a failed/empty shell probe
    });

    expect(r.changed).toBe(true);
    // Homebrew (where cybo/pi/npm live) is now present + prepended (wins).
    expect(process.env.PATH).toContain("/opt/homebrew/bin");
    expect(process.env.PATH?.startsWith("/opt/homebrew/bin")).toBe(true);
    expect(r.added).toContain("/opt/homebrew/bin");
    expect(r.added).toContain("/Users/test/.npm-global/bin");
    // The original minimal dirs are preserved (appended after the new ones).
    expect(process.env.PATH).toContain("/usr/bin");
    expect(process.env.PATH).toContain("/bin");
  });

  it("merges the login-shell PATH (where the user's package manager added dirs)", async () => {
    process.env.PATH = MINIMAL_PATH;
    const r = await augmentDaemonPath(logger, {
      platform: "darwin",
      homeDir: "/Users/test",
      probeLoginShellPath: async () => ["/Users/test/.cargo/bin", "/opt/homebrew/bin"],
    });
    expect(r.added).toContain("/Users/test/.cargo/bin"); // from the shell
    expect(r.added).toContain("/opt/homebrew/bin"); // shell or fallback (deduped once)
    // No duplicates even though /opt/homebrew/bin came from BOTH shell + well-known.
    expect(process.env.PATH?.split(":").filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  it("is idempotent — a second run on the already-augmented PATH changes nothing", async () => {
    process.env.PATH = MINIMAL_PATH;
    await augmentDaemonPath(logger, {
      platform: "darwin",
      homeDir: "/Users/test",
      probeLoginShellPath: async () => [],
    });
    const afterFirst = process.env.PATH;
    const r2 = await augmentDaemonPath(logger, {
      platform: "darwin",
      homeDir: "/Users/test",
      probeLoginShellPath: async () => [],
    });
    expect(r2.changed).toBe(false);
    expect(r2.added).toEqual([]);
    expect(process.env.PATH).toBe(afterFirst); // unchanged
  });

  it("does not duplicate a dir already in PATH (terminal-launched daemon stays intact)", async () => {
    process.env.PATH = `/opt/homebrew/bin:${MINIMAL_PATH}`;
    const r = await augmentDaemonPath(logger, {
      platform: "darwin",
      homeDir: "/Users/test",
      probeLoginShellPath: async () => [],
    });
    expect(r.added).not.toContain("/opt/homebrew/bin"); // already present
    expect(process.env.PATH?.split(":").filter((d) => d === "/opt/homebrew/bin")).toHaveLength(1);
  });

  // Windows: a GUI-launched (explorer.exe) daemon misses the per-user package-manager
  // global-bin dirs. The Windows branch splits/joins PATH with ";" and only adds dirs
  // that exist on disk, so we back the env vars with real temp dirs and disable the
  // npm-prefix probe (no real spawn in a unit test).
  describe("win32", () => {
    // npm-prefix probe stubbed off so the unit test never spawns npm.cmd.
    const noNpmPrefix = async () => null;
    let pnpmHome: string;
    let appData: string;
    let tmpRoots: string[];

    beforeEach(() => {
      pnpmHome = mkdtempSync(join(tmpdir(), "cyborg7-pnpm-"));
      appData = mkdtempSync(join(tmpdir(), "cyborg7-appdata-"));
      tmpRoots = [pnpmHome, appData];
    });
    afterEach(() => {
      for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
    });

    it("prepends existing pnpm + npm global-bin dirs to a GUI PATH", async () => {
      process.env.PATH = "C:\\Windows\\System32";
      // npm Windows default lives at %APPDATA%\npm — create it so it exists on disk.
      const npmDir = mkdtempSync(join(appData, "npm-"));
      const r = await augmentDaemonPath(logger, {
        platform: "win32",
        env: { PNPM_HOME: pnpmHome, APPDATA: appData },
        probeNpmPrefix: noNpmPrefix,
        // Stand in the real %APPDATA%\npm path so the env-derived dir resolves to ours.
        dirExists: (dir) => dir === pnpmHome || dir === join(appData, "npm") || dir === npmDir,
      });

      expect(r.changed).toBe(true);
      // pnpm bin (where a freshly-installed cybo/pi lands) is prepended and wins.
      expect(r.added).toContain(pnpmHome);
      expect(r.added).toContain(join(appData, "npm"));
      expect(process.env.PATH?.startsWith(pnpmHome)).toBe(true);
      // Original PATH entries are preserved after the new ones, joined with ";".
      expect(process.env.PATH).toContain("C:\\Windows\\System32");
      expect(process.env.PATH?.split(";")).toContain("C:\\Windows\\System32");
    });

    it("uses %LOCALAPPDATA%\\pnpm when PNPM_HOME is unset", async () => {
      process.env.PATH = "C:\\Windows\\System32";
      const localAppData = mkdtempSync(join(tmpdir(), "cyborg7-localappdata-"));
      tmpRoots.push(localAppData);
      const r = await augmentDaemonPath(logger, {
        platform: "win32",
        env: { LOCALAPPDATA: localAppData, APPDATA: appData },
        probeNpmPrefix: noNpmPrefix,
        dirExists: (dir) => dir === join(localAppData, "pnpm"),
      });
      expect(r.added).toContain(join(localAppData, "pnpm"));
    });

    it("does not add a well-known dir that does not exist on disk", async () => {
      process.env.PATH = "C:\\Windows\\System32";
      const r = await augmentDaemonPath(logger, {
        platform: "win32",
        // These point at dirs that don't exist; with the real existsSync nothing is added.
        env: { PNPM_HOME: "C:\\nope\\pnpm", APPDATA: "C:\\nope\\appdata" },
        probeNpmPrefix: noNpmPrefix,
      });
      expect(r.changed).toBe(false);
      expect(r.added).toEqual([]);
      expect(process.env.PATH).toBe("C:\\Windows\\System32");
    });

    it("adds no relative path when PNPM_HOME/LOCALAPPDATA/APPDATA are all unset", async () => {
      // CWE-426 guard: with no env vars set, the default dirs must be SKIPPED, not built
      // as the relative "pnpm"/"npm" (which a same-named folder in cwd could make pass the
      // existence check and get prepended to PATH — a search-path hijack).
      process.env.PATH = "C:\\Windows\\System32";
      const r = await augmentDaemonPath(logger, {
        platform: "win32",
        env: {}, // PNPM_HOME, LOCALAPPDATA, APPDATA all absent
        probeNpmPrefix: async () => null,
        // If a relative "pnpm"/"npm" ever reached here, this would let it pass — proving
        // the bug. It must never be called with a bare relative entry.
        dirExists: (dir) => dir === "pnpm" || dir === "npm",
      });
      expect(r.changed).toBe(false);
      expect(r.added).toEqual([]);
      expect(process.env.PATH).toBe("C:\\Windows\\System32");
      // No bare relative package-manager entry leaked into PATH.
      const entries = process.env.PATH?.split(";");
      expect(entries).not.toContain("pnpm");
      expect(entries).not.toContain("npm");
    });

    it("is idempotent — dirs already on PATH are not re-added", async () => {
      process.env.PATH = `${pnpmHome};C:\\Windows\\System32`;
      const r = await augmentDaemonPath(logger, {
        platform: "win32",
        env: { PNPM_HOME: pnpmHome, APPDATA: appData },
        probeNpmPrefix: noNpmPrefix,
        dirExists: (dir) => dir === pnpmHome, // only pnpm exists, and it's already on PATH
      });
      expect(r.changed).toBe(false);
      expect(r.added).toEqual([]);
      expect(process.env.PATH).toBe(`${pnpmHome};C:\\Windows\\System32`);
    });

    it("adds the npm prefix dir when the probe returns an existing path", async () => {
      process.env.PATH = "C:\\Windows\\System32";
      const npmPrefix = mkdtempSync(join(tmpdir(), "cyborg7-npm-prefix-"));
      tmpRoots.push(npmPrefix);
      const r = await augmentDaemonPath(logger, {
        platform: "win32",
        env: {}, // no pnpm/npm env dirs
        probeNpmPrefix: async () => npmPrefix, // probe yields the npm global prefix
        dirExists: (dir) => dir === npmPrefix, // only the probed prefix exists
      });
      expect(r.added).toEqual([npmPrefix]); // bin shims live directly in the prefix on Windows
      expect(process.env.PATH?.startsWith(npmPrefix)).toBe(true);
    });
  });
});

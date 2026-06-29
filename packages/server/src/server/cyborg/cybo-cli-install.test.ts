import { describe, it, expect } from "vitest";
import { updateCyboCli } from "./dispatcher.js";

// Reproduces the real npm EEXIST failure the Update button hit: cybo 0.2.5 ships a
// `pi` bin (a shim to its bundled Pi) and npm refuses to overwrite a pre-existing
// `pi` link, printing the conflicting path + "run npm with --force to overwrite".
const PI_PATH = "/Users/rodri/.proto/tools/node/25.6.1/bin/pi";
function eexistError(): Error {
  const e = new Error("Command failed: npm install -g @cyborg7/cybo@latest");
  (e as unknown as { stderr: string }).stderr = [
    "npm error code EEXIST",
    `npm error path ${PI_PATH}`,
    "npm error EEXIST: file already exists",
    `npm error File exists: ${PI_PATH}`,
    "npm error Remove the existing file and try again, or run npm with --force to overwrite",
  ].join("\n");
  return e;
}

// Stubs that disable the multi-prefix machinery so the EEXIST tests stay focused:
// no cybo found on PATH (→ plain `npm`), no global-bin dir (→ skip verification).
const NO_PREFIXES = {
  locate: async () => [] as string[],
  globalBinDir: async () => null,
} as const;

describe("updateCyboCli — pi-bin EEXIST handling", () => {
  it("retries with --force on EEXIST and succeeds (2nd run carries --force)", async () => {
    const calls: string[][] = [];
    const result = await updateCyboCli({
      ...NO_PREFIXES,
      run: async (_npmBin, args) => {
        calls.push([...args]);
        if (calls.length === 1) throw eexistError(); // first install hits the conflict
        return { stdout: "", stderr: "" }; // --force install succeeds
      },
      detect: async () => ({ installed: true, version: "0.2.5", path: "cybo" }),
      log: () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.version).toBe("0.2.5");
    expect(result.error).toBeNull();
    expect(calls.length).toBe(2);
    expect(calls[0]).not.toContain("--force"); // first attempt is plain
    expect(calls[1]).toContain("--force"); // retry forces the overwrite
  });

  it("returns a SHORT readable error (not the npm wall) when --force also fails", async () => {
    let n = 0;
    const result = await updateCyboCli({
      ...NO_PREFIXES,
      run: async () => {
        n += 1;
        throw eexistError(); // both the plain and the --force install conflict
      },
      detect: async () => ({ installed: false, version: null }),
      log: () => {},
    });

    expect(n).toBe(2); // tried plain, then --force
    expect(result.ok).toBe(false);
    expect(result.error).toBe(
      `Install conflict: another Cybo runtime binary already exists at ${PI_PATH}. ` +
        "Remove it or run: npm i -g --force @cyborg7/cybo@latest",
    );
    expect(result.error).not.toMatch(/npm error/i); // no wall of npm output
  });

  it("does NOT retry a non-EEXIST failure and surfaces the original message", async () => {
    let n = 0;
    const result = await updateCyboCli({
      ...NO_PREFIXES,
      run: async () => {
        n += 1;
        throw new Error("npm error code ENOTFOUND — request to registry failed");
      },
      detect: async () => ({ installed: false, version: null }),
      log: () => {},
    });

    expect(n).toBe(1); // no --force retry for a non-conflict error
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });
});

// Rodrigo's worst case: multiple node prefixes (proto + homebrew). `npm i -g`
// installs into the running npm's prefix while detection probes whatever `cybo`
// the PATH resolves — when those differ, the install "succeeds" but the version
// never changes → "update available" forever with ok:true and no error.
const PROTO_BIN = "/Users/rodri/.proto/tools/node/25.6.1/bin";
const BREW_CYBO = "/opt/homebrew/bin/cybo";

describe("updateCyboCli — multi-prefix (proto vs homebrew) handling", () => {
  it("reports a CLEAR prefix-mismatch error instead of silently returning the stale version", async () => {
    const result = await updateCyboCli({
      run: async () => ({ stdout: "", stderr: "" }), // npm i -g succeeds (into proto)
      // PATH resolves the stale homebrew copy…
      locate: async (bin) => (bin === "cybo" ? [BREW_CYBO] : []),
      // …whose bin dir has no sibling npm (the PATH npm is proto's) → npmBin "npm".
      fileExists: async (p) => p === `${PROTO_BIN}/cybo`,
      // The npm that ran installs into the proto prefix…
      globalBinDir: async () => PROTO_BIN,
      // …where the fresh 0.2.5 actually landed.
      probe: async () => "0.2.5",
      // But detection (PATH) still sees the old homebrew 0.2.4.
      detect: async () => ({ installed: true, version: "0.2.4", path: "cybo" }),
      log: () => {},
    });

    expect(result.ok).toBe(false); // NOT a silent ok:true with the stale version
    expect(result.installed).toBe(true);
    expect(result.version).toBe("0.2.4");
    expect(result.error).toContain(`Installed 0.2.5 at ${PROTO_BIN}/cybo`);
    expect(result.error).toContain(`PATH resolves a different cybo at ${BREW_CYBO} (0.2.4)`);
    expect(result.error).toMatch(/Fix your PATH order or remove the old copy/);
  });

  it("prefers the npm NEXT TO the PATH-resolved cybo so the install lands in the detected prefix", async () => {
    const npmsUsed: string[] = [];
    const result = await updateCyboCli({
      run: async (npmBin) => {
        npmsUsed.push(npmBin);
        return { stdout: "", stderr: "" };
      },
      locate: async (bin) => (bin === "cybo" ? ["/opt/homebrew/bin/cybo"] : []),
      fileExists: async () => true, // /opt/homebrew/bin/npm exists
      globalBinDir: async () => "/opt/homebrew/bin",
      probe: async () => "0.2.5",
      detect: async () => ({ installed: true, version: "0.2.5", path: "cybo" }),
      log: () => {},
    });

    expect(npmsUsed).toEqual(["/opt/homebrew/bin/npm"]); // same prefix as the detected cybo
    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.2.5");
    expect(result.error).toBeNull();
  });

  it("says WHERE the install landed when the global-bin dir isn't on PATH at all", async () => {
    const result = await updateCyboCli({
      run: async () => ({ stdout: "", stderr: "" }),
      locate: async () => [], // no cybo anywhere on PATH (fresh install, prefix not on PATH)
      fileExists: async (p) => p === `${PROTO_BIN}/cybo`,
      globalBinDir: async () => PROTO_BIN,
      probe: async () => "0.2.5",
      detect: async () => ({ installed: false, version: null }),
      log: () => {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(`Installed 0.2.5 at ${PROTO_BIN}/cybo`);
    expect(result.error).toContain(`add ${PROTO_BIN} to PATH`);
    // NOT the old generic "Install ran but the CLI wasn't detected afterwards."
    expect(result.error).not.toMatch(/wasn't detected afterwards/);
  });

  it("does not flag a mismatch when detection fell back to the `pi` bin (different program)", async () => {
    const result = await updateCyboCli({
      run: async () => ({ stdout: "", stderr: "" }),
      locate: async () => [],
      fileExists: async (p) => p === `${PROTO_BIN}/cybo`,
      globalBinDir: async () => PROTO_BIN,
      probe: async () => "0.2.5",
      // `cybo` didn't answer; `pi` did — its version is pi's, not cybo's.
      detect: async () => ({ installed: true, version: "0.0.123", path: "pi" }),
      log: () => {},
    });

    expect(result.ok).toBe(true); // no apples-to-oranges version comparison
    expect(result.error).toBeNull();
  });

  it("single-prefix happy path: versions agree → plain success", async () => {
    const result = await updateCyboCli({
      run: async () => ({ stdout: "", stderr: "" }),
      locate: async (bin) => (bin === "cybo" ? ["/opt/homebrew/bin/cybo"] : []),
      fileExists: async () => true,
      globalBinDir: async () => "/opt/homebrew/bin",
      probe: async () => "0.2.5",
      detect: async () => ({ installed: true, version: "0.2.5", path: "cybo" }),
      log: () => {},
    });

    expect(result).toEqual({ ok: true, installed: true, version: "0.2.5", error: null });
  });
});

// ─── Owning-package-manager routing (the pnpm/proto dead-end fix) ────────────
//
// Rodrigo's real loop: npm installed 0.2.6 into the proto prefix, but the PATH
// resolves ~/Library/pnpm/cybo (0.2.5) — pnpm owns the winning copy, so every
// npm update lost. The update must run via the OWNER manager.
import { detectBinaryManager, managerInstallCommand } from "./dispatcher.js";

describe("detectBinaryManager", () => {
  const NO_ENV = {} as { PNPM_HOME?: string; BUN_INSTALL?: string };

  it("pnpm: conventional homes + PNPM_HOME", () => {
    expect(detectBinaryManager("/Users/rodrigo/Library/pnpm/cybo", NO_ENV)).toBe("pnpm");
    expect(detectBinaryManager("/home/r/.local/share/pnpm/cybo", NO_ENV)).toBe("pnpm");
    expect(
      detectBinaryManager("/custom/pnpm-home/cybo", { PNPM_HOME: "/custom/pnpm-home" }),
    ).toBe("pnpm");
  });

  it("bun: ~/.bun + BUN_INSTALL", () => {
    expect(detectBinaryManager("/Users/x/.bun/bin/cybo", NO_ENV)).toBe("bun");
    expect(detectBinaryManager("/opt/bunhome/bin/cybo", { BUN_INSTALL: "/opt/bunhome" })).toBe(
      "bun",
    );
  });

  it("npm/proto/homebrew paths stay on npm (today's behavior)", () => {
    expect(
      detectBinaryManager("/Users/rodri/.proto/tools/node/25.6.1/bin/cybo", NO_ENV),
    ).toBe("npm");
    expect(detectBinaryManager("/opt/homebrew/bin/cybo", NO_ENV)).toBe("npm");
    expect(detectBinaryManager("/usr/local/lib/node_modules/.bin/cybo", NO_ENV)).toBe("npm");
  });

  it("managerInstallCommand renders the exact remedial command", () => {
    expect(managerInstallCommand("pnpm")).toBe("pnpm add -g @cyborg7/cybo@latest");
    expect(managerInstallCommand("bun")).toBe("bun add -g @cyborg7/cybo@latest");
    expect(managerInstallCommand("npm")).toBe("npm install -g @cyborg7/cybo@latest");
  });
});

describe("updateCyboCli — owner-manager routing", () => {
  it("RODRIGO'S CASE resolves: pnpm-owned PATH cybo updates via `pnpm add -g` (npm never runs)", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    let installed = false;
    const result = await updateCyboCli({
      locate: async (bin) =>
        bin === "cybo"
          ? ["/Users/rodrigo/Library/pnpm/cybo"]
          : bin === "pnpm"
            ? ["/Users/rodrigo/Library/pnpm/pnpm"]
            : [],
      realpath: async (p) => p,
      probe: async () => "0.2.5", // pre-install PATH-resolved version
      run: async (bin, args) => {
        calls.push({ bin, args: [...args] });
        installed = true;
        return { stdout: "", stderr: "" };
      },
      // Post-install re-detect: the PATH copy (pnpm's) now answers 0.2.6 — the
      // #368 verification bar, met via the owner manager.
      detect: async () => ({
        installed,
        version: installed ? "0.2.6" : "0.2.5",
        path: "cybo",
      }),
      globalBinDir: async () => null,
      log: () => {},
    });

    expect(calls).toEqual([
      { bin: "pnpm", args: ["add", "-g", "@cyborg7/cybo@latest"] },
    ]);
    expect(result).toMatchObject({ ok: true, installed: true, version: "0.2.6", error: null });
  });

  it("owner manager missing from the daemon's PATH → error names the EXACT pnpm command, nothing runs", async () => {
    let ran = 0;
    const result = await updateCyboCli({
      locate: async (bin) => (bin === "cybo" ? ["/Users/rodrigo/Library/pnpm/cybo"] : []),
      realpath: async (p) => p,
      probe: async () => "0.2.5",
      run: async () => {
        ran += 1;
        return {};
      },
      detect: async () => ({ installed: true, version: "0.2.5", path: "cybo" }),
      globalBinDir: async () => null,
      log: () => {},
    });

    expect(ran).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("managed by pnpm");
    expect(result.error).toContain("pnpm add -g @cyborg7/cybo@latest");
    expect(result.command).toBe("pnpm add -g @cyborg7/cybo@latest");
    expect(result.version).toBe("0.2.5"); // current PATH version, not a lie
  });

  it("a failed pnpm run reports the pnpm command (not npm's)", async () => {
    const result = await updateCyboCli({
      locate: async (bin) =>
        bin === "cybo"
          ? ["/Users/rodrigo/Library/pnpm/cybo"]
          : bin === "pnpm"
            ? ["/usr/local/bin/pnpm"]
            : [],
      realpath: async (p) => p,
      probe: async () => "0.2.5",
      run: async () => {
        throw new Error("ERR_PNPM_NO_GLOBAL_BIN_DIR");
      },
      detect: async () => ({ installed: true, version: "0.2.5", path: "cybo" }),
      globalBinDir: async () => null,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.command).toBe("pnpm add -g @cyborg7/cybo@latest");
    expect(result.error).toContain("pnpm add -g @cyborg7/cybo@latest");
  });

  it("symlinked shim: realpath decides the owner (PATH shim → pnpm store)", async () => {
    const calls: string[] = [];
    await updateCyboCli({
      locate: async (bin) =>
        bin === "cybo" ? ["/usr/local/bin/cybo"] : bin === "pnpm" ? ["/usr/local/bin/pnpm"] : [],
      // The PATH entry is a symlink into pnpm's home.
      realpath: async () => "/Users/rodrigo/Library/pnpm/global/5/node_modules/.bin/cybo",
      probe: async () => "0.2.5",
      run: async (bin) => {
        calls.push(bin);
        return {};
      },
      detect: async () => ({ installed: true, version: "0.2.6", path: "cybo" }),
      globalBinDir: async () => null,
      log: () => {},
    });
    expect(calls).toEqual(["pnpm"]);
  });

  it("npm-owned installs keep TODAY'S flow (EEXIST retry intact, npm bin chosen)", async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const result = await updateCyboCli({
      locate: async (bin) =>
        bin === "cybo" ? ["/Users/rodri/.proto/tools/node/25.6.1/bin/cybo"] : [],
      realpath: async (p) => p,
      fileExists: async () => false, // no sibling npm → plain `npm`
      run: async (bin, args) => {
        calls.push({ bin, args: [...args] });
        return {};
      },
      detect: async () => ({ installed: true, version: "0.2.6", path: "cybo" }),
      globalBinDir: async () => null,
      probe: async () => "0.2.6",
      log: () => {},
    });
    expect(calls).toEqual([{ bin: "npm", args: ["install", "-g", "@cyborg7/cybo@latest"] }]);
    expect(result.ok).toBe(true);
  });
});

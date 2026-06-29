import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureInternalCodexHome, resolveRealCodexHome } from "./codex-internal-home.js";

describe("ensureInternalCodexHome", () => {
  let root: string;
  let realHome: string;
  let base: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codex-isolate-test-"));
    realHome = join(root, "real-codex");
    base = join(root, "base");
    // A real Codex home: auth + GLOBAL config (mcp_servers/instructions) + AGENTS.md.
    mkdirSync(realHome, { recursive: true });
    writeFileSync(join(realHome, "auth.json"), '{"OPENAI_API_KEY":"DUMMY-KEY"}');
    writeFileSync(
      join(realHome, "config.toml"),
      '[mcp_servers.design_studio]\ncommand = "node"\n\ninstructions = "be a design studio"\n',
    );
    writeFileSync(join(realHome, "AGENTS.md"), "# global instructions\n");
    writeFileSync(join(realHome, "installation_id"), "abc");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("mirrors auth via symlink but OMITS config.toml/AGENTS.md (the fix)", () => {
    const isolated = ensureInternalCodexHome({
      baseDir: base,
      realCodexHome: realHome,
      platform: "darwin",
    });
    expect(isolated).toBe(join(base, "codex-internal-home"));

    // auth survives (symlinked) → the user's Codex creds still authenticate.
    expect(existsSync(join(isolated!, "auth.json"))).toBe(true);
    expect(lstatSync(join(isolated!, "auth.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(isolated!, "auth.json"), "utf8")).toContain("OPENAI_API_KEY");
    // Non-contaminating entries are mirrored too.
    expect(existsSync(join(isolated!, "installation_id"))).toBe(true);

    // The contaminating global config is NOT present → no mcp_servers/instructions.
    expect(existsSync(join(isolated!, "config.toml"))).toBe(false);
    expect(existsSync(join(isolated!, "AGENTS.md"))).toBe(false);
  });

  it("is idempotent (re-run keeps the same dir + omissions, no throw)", () => {
    const a = ensureInternalCodexHome({
      baseDir: base,
      realCodexHome: realHome,
      platform: "darwin",
    });
    const b = ensureInternalCodexHome({
      baseDir: base,
      realCodexHome: realHome,
      platform: "darwin",
    });
    expect(b).toBe(a);
    expect(existsSync(join(b!, "auth.json"))).toBe(true);
    expect(existsSync(join(b!, "config.toml"))).toBe(false);
  });

  it("removes a stray config.toml that leaked into the isolated home", () => {
    const isolated = join(base, "codex-internal-home");
    mkdirSync(isolated, { recursive: true });
    writeFileSync(join(isolated, "config.toml"), "leaked = true");
    const out = ensureInternalCodexHome({
      baseDir: base,
      realCodexHome: realHome,
      platform: "darwin",
    });
    expect(existsSync(join(out!, "config.toml"))).toBe(false);
  });

  it("returns null on win32 (leave CODEX_HOME unset)", () => {
    expect(
      ensureInternalCodexHome({ baseDir: base, realCodexHome: realHome, platform: "win32" }),
    ).toBeNull();
  });

  it("resolveRealCodexHome honors CODEX_HOME then falls back to ~/.codex", () => {
    expect(resolveRealCodexHome({ CODEX_HOME: "/custom/codex" } as NodeJS.ProcessEnv)).toBe(
      "/custom/codex",
    );
    expect(resolveRealCodexHome({} as NodeJS.ProcessEnv)).toMatch(/\.codex$/);
  });
});

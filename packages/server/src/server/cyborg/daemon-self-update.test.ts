import { describe, it, expect, vi } from "vitest";
import {
  runDaemonSelfUpdate,
  latestDaemonVersion,
  DAEMON_UPDATE_COMMAND,
} from "./daemon-self-update.js";

describe("runDaemonSelfUpdate", () => {
  it("launches the detached self-update and ACKs restarting", () => {
    const launchDetached = vi.fn();
    const result = runDaemonSelfUpdate({
      resolveCyborgBin: () => "/usr/local/bin/cyborg",
      launchDetached,
    });
    expect(launchDetached).toHaveBeenCalledWith("/usr/local/bin/cyborg");
    expect(result).toEqual({ ok: true, restarting: true });
  });

  it("returns the manual command when the cyborg binary isn't found", () => {
    const launchDetached = vi.fn();
    const result = runDaemonSelfUpdate({
      resolveCyborgBin: () => null,
      launchDetached,
    });
    expect(launchDetached).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("cyborg"),
      command: DAEMON_UPDATE_COMMAND,
    });
  });

  it("treats a throwing resolver as 'not found' (never throws into the handler)", () => {
    const result = runDaemonSelfUpdate({
      resolveCyborgBin: () => {
        throw new Error("which exploded");
      },
      launchDetached: vi.fn(),
    });
    expect(result.ok).toBe(false);
    expect(result.command).toBe(DAEMON_UPDATE_COMMAND);
  });

  it("surfaces a launch failure with the manual fallback", () => {
    const result = runDaemonSelfUpdate({
      resolveCyborgBin: () => "/usr/local/bin/cyborg",
      launchDetached: () => {
        throw new Error("spawn EACCES");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("EACCES");
    expect(result.command).toBe(DAEMON_UPDATE_COMMAND);
  });
});

describe("latestDaemonVersion", () => {
  it("returns the trimmed npm version on success", async () => {
    const exec = vi.fn(async () => ({ stdout: "1.2.3\n" }));
    const r = await latestDaemonVersion(exec);
    expect(exec).toHaveBeenCalledWith("npm", ["view", "@getpaseo/cli@latest", "version"]);
    expect(r).toEqual({ ok: true, latest: "1.2.3", error: null });
  });

  it("reports an error when npm returns nothing", async () => {
    const r = await latestDaemonVersion(async () => ({ stdout: "   " }));
    expect(r).toEqual({ ok: false, latest: null, error: "npm returned no version" });
  });

  it("reports the exec error", async () => {
    const r = await latestDaemonVersion(async () => {
      throw new Error("network down");
    });
    expect(r).toEqual({ ok: false, latest: null, error: "network down" });
  });
});

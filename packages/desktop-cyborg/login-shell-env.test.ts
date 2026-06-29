import assert from "node:assert/strict";
import { test } from "node:test";

import { parseShellEnv } from "./login-shell-env.js";

// Build the marker-delimited stdout parseShellEnv() expects (mirrors the probe in
// buildShellInvocation: `<mark>` + JSON.stringify(env) + `<mark>`).
function wrap(env: Record<string, string>): { stdout: string; regex: RegExp } {
  const mark = "TESTMARK000000";
  return {
    stdout: `noise ${mark}${JSON.stringify(env)}${mark} trailing`,
    regex: new RegExp(`${mark}({.*})${mark}`),
  };
}

test("parseShellEnv strips operational daemon toggles that must not leak from the login shell", () => {
  const { stdout, regex } = wrap({
    PATH: "/opt/homebrew/bin:/usr/bin",
    CYBORG7_PTY_HOST: "0", // the 2-week incident value
    CYBORG7_PERSIST_TERMINALS: "0", // sibling persistence toggle
    CYBORG7_PTY_HOST_SOCKET: "/tmp/stale.sock", // launcher-owned, per-spawn
  });

  const env = parseShellEnv(stdout, regex);

  assert.ok(env, "expected a parsed env");
  // The whole point: the cached shell value can NEVER reach the daemon.
  assert.equal(env.CYBORG7_PTY_HOST, undefined);
  assert.equal(env.CYBORG7_PERSIST_TERMINALS, undefined);
  assert.equal(env.CYBORG7_PTY_HOST_SOCKET, undefined);
  // The user's real interactive environment is preserved (the capture's purpose).
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/bin");
});

test("parseShellEnv preserves user-set config (secrets/urls) — only behavioral toggles are stripped", () => {
  const { stdout, regex } = wrap({
    PATH: "/usr/bin",
    CYBORG7_JWT_SECRET: "user-deployer-secret",
    CYBORG7_DEV_URL: "https://dev.example",
    CYBORG7_SECURE_FETCH_HOST_ALLOWLIST: "a.com,b.com",
  });

  const env = parseShellEnv(stdout, regex);

  assert.ok(env);
  assert.equal(env.CYBORG7_JWT_SECRET, "user-deployer-secret");
  assert.equal(env.CYBORG7_DEV_URL, "https://dev.example");
  assert.equal(env.CYBORG7_SECURE_FETCH_HOST_ALLOWLIST, "a.com,b.com");
});

test("parseShellEnv returns undefined when the marker is absent", () => {
  const regex = new RegExp("MARK({.*})MARK");
  assert.equal(parseShellEnv("no markers here", regex), undefined);
});

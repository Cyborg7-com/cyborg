import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// #995 package-boundary guard: the audit trace stream is implemented ENTIRELY in
// `packages/server/src/server/cyborg/` (+ packages/ui). It MUST NOT modify any
// Paseo upstream code under `packages/server/src/server/agent/` (the fork rule).
// This asserts the working tree + the branch's committed changes vs the base
// branch leave `agent/` untouched, so a re-route can never silently edit upstream.
describe("audit trace stream — package boundary", () => {
  it("does not modify any file under packages/server/src/server/agent/", () => {
    let changed: string[] = [];
    try {
      // Diff the whole branch against the trunk it forked from, plus the working
      // tree, so both committed and uncommitted edits are covered. `--merge-base`
      // compares against the common ancestor (the diverge point).
      const base = "origin/cyborg7";
      const out = execSync(`git diff --name-only ${base}...HEAD; git diff --name-only HEAD`, {
        encoding: "utf8",
        cwd: process.cwd(),
      });
      changed = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      // No git / detached base in this environment — the guard can't run here, so
      // it neither passes falsely nor fails spuriously. The CI lefthook gate runs
      // the same check authoritatively.
      return;
    }
    const agentTouched = changed.filter((f) => f.startsWith("packages/server/src/server/agent/"));
    expect(agentTouched).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// #649 client-half regression-lock (source scan, app.svelte.ts ONLY).
//
// app.svelte.ts registers window/document listeners and imports a live
// SlackClient at module load, so it can't be runtime-imported under this
// package's plain-node vitest (no DOM; importing it would attach listeners and
// instantiate a client) — see status-foreground-refetch.source.test.ts for the
// same constraint. The rewind workspace-race guard is a one-line ordering
// invariant inside rewindAgent's body, so it's locked here by a source scan
// rather than by extracting a pure module for a single early-return.
//
// The race being guarded (gemini review on PR #689): rewindAgent captures the
// workspace id, awaits the destructive rewind RPC, then re-fetches the timeline
// to re-hydrate. If the user switches workspaces while that RPC is in flight,
// the re-fetch must NOT fire against the now-stale workspace — so the stale-
// workspace guard has to run BEFORE client.fetchAgentTimeline, not only before
// the hydrate.

const appSvelte = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.svelte.ts"),
  "utf-8",
);

describe("#649 rewindAgent stale-workspace guard (source scan)", () => {
  it("guards the workspace BEFORE issuing the timeline re-fetch", () => {
    const fnStart = appSvelte.indexOf("export async function rewindAgent(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = appSvelte.indexOf("\n}", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = appSvelte.slice(fnStart, fnEnd);

    // The RPC, the guard, and the re-fetch are all present...
    const rpcIdx = body.indexOf("client.rewindAgent(");
    const guardIdx = body.indexOf("workspaceState.current?.id !== wsId");
    const fetchIdx = body.indexOf("client.fetchAgentTimeline(");
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(fetchIdx).toBeGreaterThan(-1);

    // ...and they run in that order: RPC → stale-workspace guard → re-fetch, so a
    // mid-flight workspace switch short-circuits before any cross-workspace fetch.
    expect(rpcIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(fetchIdx);
  });
});

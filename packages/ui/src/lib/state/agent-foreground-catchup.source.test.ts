import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Interactive-session-persistence regression-lock (source scan, app.svelte.ts
// ONLY) — sibling of the #671 status-foreground-refetch lock.
//
// app.svelte.ts registers window/document listeners and imports a live
// SlackClient at module load, so it can't be runtime-imported under this
// package's plain-node vitest (no DOM). The wiring invariant below lives inside
// that module's import-time-side-effecting body, so it is locked by a source
// scan. The PURE catch-up logic (catchUpAgentTimelines re-hydrates open streams
// from server truth) is exercised by agent-catchup-scope.test.ts.
//
// The bug being guarded: on a BRIEF background (away < 30s) the OS freezes the
// WebSocket, so `agent_stream` events the daemon emitted mid-freeze are dropped
// (no replay on an already-open socket). Because the agent-timeline catch-up
// only ran on the >=30s `handleReconnect` path, a quick tab-switch / few seconds
// of inactivity left an INTERACTIVE Claude session frozen on its last turn — the
// agent's reply and `turn_completed` were lost, so the chat read as "closed".
// The fix re-hydrates open agent timelines on EVERY live foreground.

const appSvelte = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.svelte.ts"),
  "utf-8",
);

describe("interactive-session foreground catch-up (source scan)", () => {
  it("onForeground catches up open agent timelines on the brief-foreground path", () => {
    const fnStart = appSvelte.indexOf("async function onForeground()");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = appSvelte.indexOf("\n}", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = appSvelte.slice(fnStart, fnEnd);

    // The catch-up call must be present in onForeground...
    const catchUpIdx = body.indexOf("catchUpAgentTimelines(");
    expect(catchUpIdx).toBeGreaterThan(-1);

    // ...and run on the brief path (after the unread reconcile), i.e. LEXICALLY
    // AFTER the `awayMs >= FOREGROUND_RESYNC_AWAY_MS` early-return gate — so it
    // also covers the < 30s window the user actually hits (the >=30s path
    // already catches up via handleReconnect and returns before reaching here).
    const awayGateIdx = body.indexOf("awayMs >= FOREGROUND_RESYNC_AWAY_MS");
    expect(awayGateIdx).toBeGreaterThan(-1);
    expect(catchUpIdx).toBeGreaterThan(awayGateIdx);
  });

  it("catchUpAgentTimelines only re-hydrates already-open streams (never resurrects a closed session)", () => {
    // Defensive lock on the helper the foreground path reuses: it filters to
    // streams that exist AND have entries, and bails if the stream vanished
    // mid-fetch — so a quick foreground can't recreate an archived/closed chat.
    const fnStart = appSvelte.indexOf("async function catchUpAgentTimelines(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = appSvelte.indexOf("\n}", fnStart);
    const body = appSvelte.slice(fnStart, fnEnd);
    expect(body).toContain("agentStreamState.getEntries(id).length > 0");
    expect(body).toContain("agentStreamState.streams.has(agentId)");
  });
});

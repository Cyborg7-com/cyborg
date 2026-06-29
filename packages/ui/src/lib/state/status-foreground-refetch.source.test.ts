import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// #671 client-half regression-lock (source scan, app.svelte.ts ONLY).
//
// app.svelte.ts registers window/document listeners and imports a live
// SlackClient at module load, so it can't be runtime-imported under this
// package's plain-node vitest (no DOM; importing it would attach listeners and
// instantiate a client). The two wiring invariants below live entirely inside
// that module's import-time-side-effecting body, so they are locked by a source
// scan. The PURE reconcile logic they depend on — seed REPLACES the map and a
// cleared status DROPS its entry — is NOT scanned here; it was extracted to
// core/status-reconcile.ts and is exercised by a real unit test
// (status-reconcile.test.ts). The behavioral proof of the live-clear path is the
// E2E plan in the PR.
//
// The bug being guarded: a frozen mobile WebView that foregrounds < 30s after a
// server-side status sweep MISSES the `user_status_changed` clear broadcast and,
// because the status re-fetch was gated behind the 30s away threshold, never
// reconciles — so a status that expired while it was backgrounded lingers.

const appSvelte = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.svelte.ts"),
  "utf-8",
);

function sliceFrom(text: string, from: string, len: number): string {
  const i = text.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  return text.slice(i, i + len);
}

describe("#671 app.svelte.ts status wiring (source scan)", () => {
  it("the live broadcast handler routes user_status_changed through the status state", () => {
    const handler = sliceFrom(appSvelte, 'client.on("user_status_changed"', 180);
    expect(handler).toContain("workspaceUserStatusesState.set(");
  });

  it("onForeground re-fetches statuses on EVERY foreground, before the 30s away gate", () => {
    // The fix: status re-fetch is UNCONDITIONAL on a live foreground, not gated
    // behind FOREGROUND_RESYNC_AWAY_MS like the channel/DM delta resync. We
    // assert the seedUserStatuses call appears in onForeground and lexically
    // BEFORE the `awayMs >= FOREGROUND_RESYNC_AWAY_MS` handleReconnect gate.
    const fnStart = appSvelte.indexOf("async function onForeground()");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = appSvelte.indexOf("\n}", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const body = appSvelte.slice(fnStart, fnEnd);

    const seedIdx = body.indexOf("seedUserStatuses(");
    const awayGateIdx = body.indexOf("awayMs >= FOREGROUND_RESYNC_AWAY_MS");
    expect(seedIdx).toBeGreaterThan(-1); // re-fetch is present in onForeground
    expect(awayGateIdx).toBeGreaterThan(-1); // the 30s gate still exists (for the delta resync)
    expect(seedIdx).toBeLessThan(awayGateIdx); // ...and the status re-fetch runs BEFORE it
  });
});

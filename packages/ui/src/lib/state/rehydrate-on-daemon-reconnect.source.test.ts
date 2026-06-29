import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// #518 wiring regression-lock (source scan, app.svelte.ts ONLY).
//
// app.svelte.ts registers window/document listeners and instantiates a live
// SlackClient at module load, so it can't be runtime-imported under this
// package's plain-node vitest. The fix's WIRING — the daemon offline→online
// self-heal also re-hydrates the open timelines, scoped to the reconnecting
// daemon — lives inside that import-time-side-effecting body, so it's locked
// here by a source scan. The PURE scoping decision is unit-tested separately
// (agent-catchup-scope.test.ts).
//
// The bug: when the OWNER daemon drops + reconnects while the client stays
// connected, the live agent_stream only resumes "from now", so output streamed
// during the gap is lost; the daemon self-heal refetched the agent/cybo LISTS
// but never the open session timelines, so the open session showed a gap until
// a manual reopen.

const appSvelte = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "app.svelte.ts"),
  "utf-8",
);

describe("#518 app.svelte.ts daemon-reconnect rehydrate wiring (source scan)", () => {
  it("the daemon_status offline→online self-heal re-hydrates open timelines", () => {
    const handlerIdx = appSvelte.indexOf('client.on("daemon_status"');
    expect(handlerIdx).toBeGreaterThan(-1);
    // Bound the scan to the daemon_status handler so we don't match the client's
    // own handleReconnect catch-up.
    const handler = appSvelte.slice(handlerIdx, handlerIdx + 2000);
    expect(handler).toContain("catchUpAgentTimelines(wsId, daemonId)");
  });

  it("the rehydrate is scoped to the reconnecting daemon (not unconditional)", () => {
    // catchUpAgentTimelines takes an optional daemonId, and the daemon handler
    // passes it — so we don't re-fetch sessions whose daemon never dropped.
    const fnIdx = appSvelte.indexOf("async function catchUpAgentTimelines(");
    expect(fnIdx).toBeGreaterThan(-1);
    const signature = appSvelte.slice(fnIdx, fnIdx + 80);
    expect(signature).toContain("wsId: string, daemonId?: string");
    // …and it routes the open ids through the pure scoping helper.
    const body = appSvelte.slice(fnIdx, fnIdx + 600);
    expect(body).toContain("agentIdsForDaemonCatchUp(");
  });
});

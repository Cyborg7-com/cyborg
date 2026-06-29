import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Phantom-cybo prune regression-lock (source scan).
//
// THE BUG: a cybo hard-deleted server-side (storage.deleteCybo) lingered in the
// UI's "Your cybos" roster (cyboState.list) — the local list was never pruned on
// the delete RESPONSE, and nothing re-fetched the authoritative roster when the
// cybo view reopened or the socket reconnected, so the deleted cybo rendered as a
// phantom until a hard reload.
//
// app.svelte.ts attaches window/document listeners and instantiates a live client
// at module load, so it can't be runtime-imported under this package's plain-node
// vitest. The prune wiring lives inside that import-time-side-effecting body, so
// the invariants are locked by a source scan (same approach as
// status-foreground-refetch.source.test.ts). The pure list mutation is covered by
// a real unit test in plugins/agents/cybo-roster-ops.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const appSvelte = readFileSync(join(here, "app.svelte.ts"), "utf-8");
const agentsPane = readFileSync(join(here, "../components/panes/AgentsPane.svelte"), "utf-8");

function fnBody(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, `expected to find ${signature}`).toBeGreaterThan(-1);
  // Body of an `export async function … { … }` up to the first top-level close.
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated body for ${signature}`);
}

describe("cybo phantom prune (source scan)", () => {
  it("the delete action prunes cyboState.list locally after the delete RPC resolves", () => {
    const body = fnBody(appSvelte, "export async function deleteCybo(");
    // The RPC is awaited…
    expect(body).toContain("client.deleteCybo(");
    // …then the deleted id is dropped from the shared roster so the actor's
    // "Your cybos" updates even if the prune broadcast never reaches this socket.
    expect(body).toMatch(/cyboState\.list\s*=\s*cyboState\.list\.filter\(/);
    expect(body).toContain("c.id !== cyboId");
  });

  it("the cybo_deleted broadcast handler prunes the roster (delete-elsewhere path)", () => {
    const handlerIdx = appSvelte.indexOf('client.on("cybo_deleted"');
    expect(handlerIdx).toBeGreaterThan(-1);
    const handler = appSvelte.slice(handlerIdx, handlerIdx + 200);
    expect(handler).toContain("removeCybo(cyboState.list, cyboId)");
  });

  it("reconnect reconcile re-fetches the authoritative roster", () => {
    const body = fnBody(appSvelte, "async function reconcileWorkspacePanels(");
    // A fresh socket missed any delete broadcasts while disconnected — refetch so
    // phantoms can't survive a reconnect.
    expect(body).toContain("fetchCybos()");
  });

  it("AgentsPane re-fetches the roster when the cybo view (re)opens", () => {
    // Opening "Your cybos" must pull the authoritative list so a cybo deleted
    // elsewhere (other device / CLI) can't linger as a phantom until reload.
    expect(agentsPane).toContain("fetchCybos");
    // Inside a reactive effect keyed on the active workspace.
    expect(agentsPane).toMatch(/\$effect\(\(\)\s*=>\s*\{\s*if\s*\(wsId\)\s*void fetchCybos\(\);/);
  });
});

// Pure reconcile logic for server-side draft sync (#610). No DB / no browser —
// reconcileDrafts is a pure function, so these assert the newest-updatedAt-wins
// merge between a device's local cache and the server's drafts on workspace load.
//
// Importing reconcileDrafts from drafts.svelte.ts is safe in vitest: the module's
// top-level is just function/class declarations + a `new DraftsState()` whose
// `$state` field compiles to a plain assignment under the svelte vitest plugin —
// no reactive runtime needed for the pure export.

import { describe, expect, it } from "vitest";
import { reconcileDrafts, type ReconcileLocalEntry, type ServerDraft } from "./drafts.svelte.js";

describe("reconcileDrafts (newest updatedAt wins)", () => {
  it("adopts a server draft for a scope this device never had", () => {
    const server: ServerDraft[] = [
      { scope: "channel:a", text: "from other device", updatedAt: 100 },
    ];
    const local: ReconcileLocalEntry[] = [];

    const { apply, pushBack } = reconcileDrafts(server, local);

    expect(apply.get("channel:a")).toBe("from other device");
    expect(pushBack).toEqual([]);
  });

  it("keeps the local draft and pushes it back for a scope only present locally", () => {
    const server: ServerDraft[] = [];
    const local: ReconcileLocalEntry[] = [
      { scope: "dm:bob", text: "offline note", updatedAt: 200 },
    ];

    const { apply, pushBack } = reconcileDrafts(server, local);

    expect(apply.get("dm:bob")).toBe("offline note");
    expect(pushBack).toEqual([{ scope: "dm:bob", text: "offline note", updatedAt: 200 }]);
  });

  it("takes the SERVER text when the server is newer", () => {
    const server: ServerDraft[] = [{ scope: "channel:a", text: "newer server", updatedAt: 300 }];
    const local: ReconcileLocalEntry[] = [
      { scope: "channel:a", text: "stale local", updatedAt: 100 },
    ];

    const { apply, pushBack } = reconcileDrafts(server, local);

    expect(apply.get("channel:a")).toBe("newer server");
    // server won → nothing to push back
    expect(pushBack).toEqual([]);
  });

  it("keeps the LOCAL text AND pushes back when the local edit is newer", () => {
    const server: ServerDraft[] = [{ scope: "channel:a", text: "stale server", updatedAt: 100 }];
    const local: ReconcileLocalEntry[] = [
      { scope: "channel:a", text: "fresh offline edit", updatedAt: 500 },
    ];

    const { apply, pushBack } = reconcileDrafts(server, local);

    expect(apply.get("channel:a")).toBe("fresh offline edit");
    expect(pushBack).toEqual([{ scope: "channel:a", text: "fresh offline edit", updatedAt: 500 }]);
  });

  it("prefers the server on an exact updatedAt tie (deterministic, no double-write)", () => {
    const server: ServerDraft[] = [{ scope: "channel:a", text: "server copy", updatedAt: 250 }];
    const local: ReconcileLocalEntry[] = [
      { scope: "channel:a", text: "local copy", updatedAt: 250 },
    ];

    const { apply, pushBack } = reconcileDrafts(server, local);

    expect(apply.get("channel:a")).toBe("server copy");
    expect(pushBack).toEqual([]);
  });

  it("reconciles a mixed set per scope independently", () => {
    const server: ServerDraft[] = [
      { scope: "channel:a", text: "S-a newer", updatedAt: 900 }, // server wins
      { scope: "dm:bob", text: "S-bob stale", updatedAt: 100 }, // local wins
      { scope: "thread:x", text: "S-x only", updatedAt: 400 }, // server-only
    ];
    const local: ReconcileLocalEntry[] = [
      { scope: "channel:a", text: "L-a stale", updatedAt: 200 },
      { scope: "dm:bob", text: "L-bob newer", updatedAt: 800 },
      { scope: "channel:z", text: "L-z only", updatedAt: 700 }, // local-only
    ];

    const { apply, pushBack } = reconcileDrafts(server, local);

    expect(apply.get("channel:a")).toBe("S-a newer");
    expect(apply.get("dm:bob")).toBe("L-bob newer");
    expect(apply.get("thread:x")).toBe("S-x only");
    expect(apply.get("channel:z")).toBe("L-z only");

    // push back exactly the locally-newer (dm:bob) and local-only (channel:z) ones.
    const pushedScopes = pushBack.map((p) => p.scope).sort();
    expect(pushedScopes).toEqual(["channel:z", "dm:bob"]);
  });

  it("returns empty results for empty inputs", () => {
    const { apply, pushBack } = reconcileDrafts([], []);
    expect(apply.size).toBe(0);
    expect(pushBack).toEqual([]);
  });
});

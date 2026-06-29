import { describe, expect, it } from "vitest";
import { buildExpiredStatusClears } from "./status-sweep.js";

// #671: the periodic sweep deletes expired user_statuses and must broadcast a
// `user_status_changed` clear per cleared row, or a status that expires while a
// client is connected lingers until the next full resync. The DELETE returning
// the cleared rows is proven by db/expired-statuses.test.ts; THIS exercises the
// pure mapping the sweep applies to those rows before broadcasting.
describe("buildExpiredStatusClears (#671)", () => {
  it("emits one clear per cleared row, preserving (workspaceId, userId)", () => {
    const clears = buildExpiredStatusClears([
      { workspaceId: "ws-a", userId: "u-1" },
      { workspaceId: "ws-b", userId: "u-2" },
    ]);
    expect(clears).toEqual([
      { workspaceId: "ws-a", userId: "u-1", emoji: null, text: null, expiresAt: null },
      { workspaceId: "ws-b", userId: "u-2", emoji: null, text: null, expiresAt: null },
    ]);
  });

  it("uses the empty-status clear shape (emoji/text/expiresAt all null) for every row", () => {
    // This is the same payload cyborg:set_user_status emits when a user clears
    // their own status, so the live client handler drops the chip identically.
    // A regression that omitted any field (e.g. kept a stale emoji) would leave
    // the chip on screen.
    for (const clear of buildExpiredStatusClears([{ workspaceId: "ws", userId: "u" }])) {
      expect(clear.emoji).toBeNull();
      expect(clear.text).toBeNull();
      expect(clear.expiresAt).toBeNull();
    }
  });

  it("produces no broadcasts when nothing was cleared (no spurious clears)", () => {
    expect(buildExpiredStatusClears([])).toEqual([]);
  });
});

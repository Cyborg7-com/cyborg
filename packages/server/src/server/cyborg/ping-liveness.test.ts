import { describe, it, expect } from "vitest";
import { buildPingResponse } from "./ping-liveness.js";

// Presence auto-heal (Part A). The relay's `cyborg:ping` handler answers BEFORE
// the `if (!pg)` guard and BEFORE the workspace-membership gate, so its core
// logic must be a pure round-trip with no Postgres and no workspace dependency.
// That logic lives in buildPingResponse — a function with NO access to `pg`,
// storage, or a workspace id — so these tests prove the contract directly:
// pong type, same requestId, and structurally DB-free.
describe("cyborg:ping → cyborg:pong liveness", () => {
  it("responds with cyborg:pong echoing the same requestId", () => {
    const resp = buildPingResponse("req_42_1700000000000");
    expect(resp.type).toBe("cyborg:pong");
    expect(resp.payload.requestId).toBe("req_42_1700000000000");
  });

  it("echoes the requestId verbatim (the client matches on it)", () => {
    for (const id of ["ping_1_1", "ping_2_2", "abc-XYZ-123"]) {
      expect(buildPingResponse(id).payload.requestId).toBe(id);
    }
  });

  it("passes through an undefined requestId without inventing one", () => {
    const resp = buildPingResponse(undefined);
    expect(resp.type).toBe("cyborg:pong");
    expect(resp.payload.requestId).toBeUndefined();
  });

  it("needs no Postgres and no workspace: builds a pong from the requestId alone", () => {
    // The signature takes ONLY a requestId — there is no `pg`, no storage, and no
    // workspaceId parameter, so the handler structurally cannot touch the DB or
    // require a subscription. A pong is producible with nothing but the id.
    expect(buildPingResponse.length).toBe(1);
    const resp = buildPingResponse("standalone");
    expect(resp).toEqual({ type: "cyborg:pong", payload: { requestId: "standalone" } });
  });
});

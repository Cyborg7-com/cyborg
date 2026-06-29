import { describe, it, expect } from "vitest";
import { DaemonMetaSchema, CyboWriteRequestSchema } from "./relay-protocol.js";

// Usage-metrics heartbeat (round 1, relay-receive side). DaemonMetaSchema is a
// STRICT (non-passthrough) z.object, so any field NOT declared is silently
// stripped — that is exactly why the daemon's `cybos` map never reaches
// daemons.meta. These tests prove the three new usage fields ARE declared and
// therefore SURVIVE a parse (so they persist into the jsonb), and that the
// strict-strip behavior is otherwise intact (an undeclared field is dropped).
describe("DaemonMetaSchema usage-metrics fields", () => {
  it("retains activeSessionCount, activeCyboCount and edition", () => {
    const parsed = DaemonMetaSchema.parse({
      host: "Sebs-MacBook.local",
      activeSessionCount: 3,
      activeCyboCount: 7,
      edition: "saas",
    });
    expect(parsed.activeSessionCount).toBe(3);
    expect(parsed.activeCyboCount).toBe(7);
    expect(parsed.edition).toBe("saas");
  });

  it("accepts all three edition values", () => {
    for (const edition of ["saas", "selfhost", "opensource"] as const) {
      expect(DaemonMetaSchema.parse({ edition }).edition).toBe(edition);
    }
  });

  it("rejects a negative or non-integer count, and an unknown edition", () => {
    expect(() => DaemonMetaSchema.parse({ activeSessionCount: -1 })).toThrow();
    expect(() => DaemonMetaSchema.parse({ activeCyboCount: 1.5 })).toThrow();
    expect(() => DaemonMetaSchema.parse({ edition: "enterprise" })).toThrow();
  });

  it("still strips an undeclared field (strict, non-passthrough)", () => {
    const parsed = DaemonMetaSchema.parse({ activeSessionCount: 2, cybos: { a: 1 } });
    expect(parsed.activeSessionCount).toBe(2);
    expect("cybos" in parsed).toBe(false);
  });
});

// Tasks Phase 2 (watcher): a cybo's cyborg7_create_task sets a channel binding +
// board priority. The MCP tool already forwards them into cyboWrite, but a
// z.object() strips any field it does NOT declare — so before these two fields
// were added to the schema, the relay never saw them and handleCyboWrite wrote
// the task without a channel/priority. These prove the fields SURVIVE the parse.
describe("CyboWriteRequestSchema create_task fields", () => {
  it("retains channelId + priority through a create_task parse", () => {
    const parsed = CyboWriteRequestSchema.parse({
      type: "cybo_write_request",
      requestId: "cw_1",
      workspaceId: "ws_1",
      cyboId: "cybo_1",
      kind: "create_task",
      title: "Watch this",
      channelId: "ch_watch",
      priority: "high",
    });
    expect(parsed.channelId).toBe("ch_watch");
    expect(parsed.priority).toBe("high");
  });

  it("treats channelId + priority as optional (back-compat with old daemons)", () => {
    const parsed = CyboWriteRequestSchema.parse({
      type: "cybo_write_request",
      requestId: "cw_2",
      workspaceId: "ws_1",
      cyboId: "cybo_1",
      kind: "create_task",
      title: "No channel",
    });
    expect(parsed.channelId).toBeUndefined();
    expect(parsed.priority).toBeUndefined();
  });
});

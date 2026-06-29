import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { CyborgStorage } from "./storage.js";
import { DualStorage } from "./dual-storage.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { MessageRouter, type BroadcastFn } from "./message-router.js";
import type { AuditEvent } from "./audit-event-log.js";

// #995: the daemon broadcast seam — broadcastAuditEvent fans a structured event
// out to its workspace ONLY, mirroring broadcastTaskEvent. The sink getter wraps
// it (debug-gated, never-throws).
describe("MessageRouter.broadcastAuditEvent", () => {
  let storage: DualStorage;
  let router: MessageRouter;
  let sent: Array<{ workspaceId: string; message: unknown }>;

  beforeEach(() => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "mr-audit-"));
    storage = new DualStorage(new CyborgStorage(path.join(tmpDir, "t.db")), null);
    const workspaceManager = new WorkspaceManager(storage);
    sent = [];
    const broadcast: BroadcastFn = {
      toWorkspace: (workspaceId, message) => sent.push({ workspaceId, message }),
      toUser: () => {},
    };
    router = new MessageRouter(storage, workspaceManager, broadcast);
  });

  function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
    return {
      kind: "spawn.context",
      category: "context_injection",
      level: "info",
      workspaceId: "ws1",
      ...overrides,
    };
  }

  it("fans an audit event to its workspace only as cyborg:audit_event", () => {
    router.broadcastAuditEvent(event({ workspaceId: "ws-target" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].workspaceId).toBe("ws-target");
    expect((sent[0].message as { type: string }).type).toBe("cyborg:audit_event");
  });

  it("never throws when the underlying broadcast throws", () => {
    const wm = new WorkspaceManager(storage);
    const throwingRouter = new MessageRouter(storage, wm, {
      toWorkspace: () => {
        throw new Error("boom");
      },
      toUser: () => {},
    });
    expect(() => throwingRouter.broadcastAuditEvent(event())).not.toThrow();
  });

  it("auditSink getter drops debug events by default (verbose off)", () => {
    router.auditSink.emit(event({ level: "debug", kind: "gate.skip" }));
    expect(sent).toHaveLength(0);
    router.auditSink.emit(event({ level: "info" }));
    expect(sent).toHaveLength(1);
  });
});

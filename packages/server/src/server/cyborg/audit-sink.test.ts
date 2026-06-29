import { describe, expect, it } from "vitest";

import { createAuditSink, isAuditVerbose, type AuditBroadcastFn } from "./audit-sink.js";
import type { AuditEvent } from "./audit-event-log.js";

function infoEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    kind: "daemon.op",
    category: "daemon_operation",
    level: "info",
    workspaceId: "ws1",
    ...overrides,
  };
}

describe("isAuditVerbose", () => {
  it("is off when unset", () => {
    expect(isAuditVerbose({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is on for truthy values", () => {
    for (const v of ["1", "true", "ON", "yes"]) {
      expect(isAuditVerbose({ CYBORG7_AUDIT_VERBOSE: v } as NodeJS.ProcessEnv)).toBe(true);
    }
  });
  it("is off for other values", () => {
    expect(isAuditVerbose({ CYBORG7_AUDIT_VERBOSE: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isAuditVerbose({ CYBORG7_AUDIT_VERBOSE: "off" } as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("createAuditSink", () => {
  it("forwards info events to the broadcast", () => {
    const seen: AuditEvent[] = [];
    const sink = createAuditSink((e) => seen.push(e));
    sink.emit(infoEvent());
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("daemon.op");
  });

  it("never throws when the broadcast throws", () => {
    const throwing: AuditBroadcastFn = () => {
      throw new Error("broadcast boom");
    };
    const sink = createAuditSink(throwing);
    expect(() => sink.emit(infoEvent())).not.toThrow();
  });

  it("suppresses debug events when verbose is off", () => {
    const seen: AuditEvent[] = [];
    const sink = createAuditSink((e) => seen.push(e), { verbose: false });
    sink.emit(infoEvent({ level: "debug", kind: "gate.skip" }));
    expect(seen).toHaveLength(0);
  });

  it("emits debug events when verbose is on", () => {
    const seen: AuditEvent[] = [];
    const sink = createAuditSink((e) => seen.push(e), { verbose: true });
    sink.emit(infoEvent({ level: "debug", kind: "gate.skip" }));
    expect(seen).toHaveLength(1);
  });

  it("still emits info/warn/error when verbose is off", () => {
    const seen: AuditEvent[] = [];
    const sink = createAuditSink((e) => seen.push(e), { verbose: false });
    sink.emit(infoEvent({ level: "warn" }));
    sink.emit(infoEvent({ level: "error" }));
    expect(seen).toHaveLength(2);
  });
});

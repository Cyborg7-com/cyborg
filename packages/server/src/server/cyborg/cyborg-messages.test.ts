import { describe, expect, it } from "vitest";
import {
  CyborgListDaemonSessionsRequestSchema,
  CyborgListDaemonSessionsResponseSchema,
  DaemonSessionAuditRowSchema,
} from "./cyborg-messages.js";

// Protocol schemas for the daemon-owner audit listing (#993). These lock the wire
// contract: the request requires a daemonId, and each row carries the ephemeral /
// internal badges on top of the agent-list row shape.
describe("cyborg:list_daemon_sessions schemas", () => {
  it("parses a valid request", () => {
    const parsed = CyborgListDaemonSessionsRequestSchema.parse({
      type: "cyborg:list_daemon_sessions",
      requestId: "r1",
      workspaceId: "ws1",
      daemonId: "daemon-A",
    });
    expect(parsed.daemonId).toBe("daemon-A");
  });

  it("rejects a request missing daemonId", () => {
    expect(() =>
      CyborgListDaemonSessionsRequestSchema.parse({
        type: "cyborg:list_daemon_sessions",
        requestId: "r1",
        workspaceId: "ws1",
      }),
    ).toThrow();
  });

  it("parses a valid response with an ephemeral + internal row", () => {
    const parsed = CyborgListDaemonSessionsResponseSchema.parse({
      type: "cyborg:list_daemon_sessions_response",
      payload: {
        requestId: "r1",
        daemonId: "daemon-A",
        sessions: [
          {
            agentId: "a1",
            provider: "claude",
            lifecycle: "running",
            ephemeral: true,
            internal: true,
          },
        ],
      },
    });
    expect(parsed.payload.sessions[0].ephemeral).toBe(true);
    expect(parsed.payload.sessions[0].internal).toBe(true);
  });

  it("requires ephemeral and internal on a row", () => {
    expect(() =>
      DaemonSessionAuditRowSchema.parse({
        agentId: "a1",
        provider: "claude",
        lifecycle: "running",
      }),
    ).toThrow();
  });
});

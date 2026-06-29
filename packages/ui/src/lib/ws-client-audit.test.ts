import { describe, expect, it } from "vitest";

import { CyborgClient, type AuditEventPayload } from "./ws-client.js";

// #995: the client wire branch — a `cyborg:audit_event` frame must emit the typed
// `audit_event` event with its structured ids (agentId/cyboId/daemonId/kind/payload)
// intact, so app.svelte's pushAudit can retain them in logState. Expose the
// protected extension-message handler via a tiny subclass to drive it headless
// (no socket needed).
class TestClient extends CyborgClient {
  feed(type: string, payload: Record<string, unknown>): boolean {
    return this.handleExtensionMessage(type, payload);
  }
}

describe("CyborgClient — cyborg:audit_event wire branch", () => {
  it("emits a typed audit_event with structured fields intact", () => {
    const client = new TestClient();
    const received: AuditEventPayload[] = [];
    client.on("audit_event", (p) => received.push(p));

    const frame = {
      level: "info" as const,
      source: "spawn",
      message: "Context injected for Apex",
      category: "context_injection" as const,
      kind: "spawn.context",
      workspaceId: "ws1",
      daemonId: "srv1",
      agentId: "agent-1",
      cyboId: "cybo-1",
      payload: { promptLength: 42, promptSha256: "abc123" },
    };

    const handled = client.feed("cyborg:audit_event", frame);
    expect(handled).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].agentId).toBe("agent-1");
    expect(received[0].cyboId).toBe("cybo-1");
    expect(received[0].daemonId).toBe("srv1");
    expect(received[0].kind).toBe("spawn.context");
    expect((received[0].payload as { promptLength: number }).promptLength).toBe(42);
  });
});

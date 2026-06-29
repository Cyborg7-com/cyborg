import { describe, expect, it } from "vitest";

import {
  AUDIT_PAYLOAD_MAX_BYTES,
  auditEventBroadcast,
  formatAuditEvent,
  redactPayload,
  type AuditEvent,
} from "./audit-event-log.js";

function baseEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    kind: "spawn.context",
    category: "context_injection",
    level: "info",
    workspaceId: "ws1",
    agentId: "agent1",
    cyboId: "cybo1",
    ...overrides,
  };
}

describe("formatAuditEvent", () => {
  it("is pure — same input → identical output", () => {
    const event = baseEvent({ payload: { promptLength: 42 } });
    expect(formatAuditEvent(event)).toEqual(formatAuditEvent(event));
  });

  it("carries the structured ids and category through", () => {
    const line = formatAuditEvent(baseEvent({ daemonId: "srv1", userId: "u1", channelId: "ch1" }));
    expect(line.category).toBe("context_injection");
    expect(line.kind).toBe("spawn.context");
    expect(line.workspaceId).toBe("ws1");
    expect(line.agentId).toBe("agent1");
    expect(line.cyboId).toBe("cybo1");
    expect(line.daemonId).toBe("srv1");
    expect(line.userId).toBe("u1");
    expect(line.channelId).toBe("ch1");
  });

  it("derives source from category and message from kind when none supplied", () => {
    const line = formatAuditEvent(baseEvent());
    expect(line.source).toBe("spawn");
    expect(line.message).toBe("spawn context");
  });

  it("honors an explicit source + message", () => {
    const line = formatAuditEvent(baseEvent({ source: "reaper", message: "killed 3 orphans" }));
    expect(line.source).toBe("reaper");
    expect(line.message).toBe("killed 3 orphans");
  });

  it("defaults optional ids to null and payload to {}", () => {
    const line = formatAuditEvent({
      kind: "reaper.kill",
      category: "daemon_operation",
      level: "warn",
      workspaceId: "ws1",
    });
    expect(line.agentId).toBeNull();
    expect(line.cyboId).toBeNull();
    expect(line.daemonId).toBeNull();
    expect(line.payload).toEqual({});
  });
});

describe("auditEventBroadcast", () => {
  it("wraps the formatted line in the cyborg:audit_event envelope", () => {
    const env = auditEventBroadcast(baseEvent());
    expect(env.type).toBe("cyborg:audit_event");
    expect(env.payload.kind).toBe("spawn.context");
    expect(env.payload.category).toBe("context_injection");
  });
});

describe("redaction", () => {
  it("strips the query string of an MCP URL to host + path", () => {
    const line = formatAuditEvent(
      baseEvent({
        category: "tool_injection",
        kind: "spawn.tools",
        payload: {
          cyborg7Url:
            "http://localhost:6767/mcp/cyborg7?workspaceId=ws1&agentId=secret-agent-token-123",
        },
      }),
    );
    const serialized = JSON.stringify(line.payload);
    expect(line.payload.cyborg7Url).toBe("http://localhost:6767/mcp/cyborg7");
    expect(serialized).not.toContain("secret-agent-token-123");
    expect(serialized).not.toContain("workspaceId=ws1");
  });

  it("redacts api-key, token, and password fields wholesale", () => {
    const line = formatAuditEvent(
      baseEvent({
        payload: {
          apiKey: "super-secret-key-value",
          api_key: "another-secret",
          token: "scoped-mcp-token-xyz",
          password: "hunter2",
          authorization: "Bearer abc.def.ghi",
        },
      }),
    );
    const serialized = JSON.stringify(line.payload);
    expect(serialized).not.toContain("super-secret-key-value");
    expect(serialized).not.toContain("another-secret");
    expect(serialized).not.toContain("scoped-mcp-token-xyz");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("abc.def.ghi");
  });

  it("scrubs ck_ consumer keys and sk- keys embedded in strings", () => {
    const line = formatAuditEvent(
      baseEvent({
        payload: {
          note: "consumer ck_live_abc123DEF and provider sk-proj-ABCdef123456 used",
        },
      }),
    );
    const serialized = JSON.stringify(line.payload);
    expect(serialized).not.toContain("ck_live_abc123DEF");
    expect(serialized).not.toContain("sk-proj-ABCdef123456");
    expect(serialized).toContain("ck_[redacted]");
    expect(serialized).toContain("sk-[redacted]");
  });

  it("redacts secrets nested in arrays and objects", () => {
    const line = formatAuditEvent(
      baseEvent({
        payload: {
          servers: [
            { name: "cyborg7", url: "https://relay.example.com/mcp?token=leak-me-please" },
            { name: "composio", apiKey: "ck_live_nested_secret" },
          ],
        },
      }),
    );
    const serialized = JSON.stringify(line.payload);
    expect(serialized).not.toContain("leak-me-please");
    expect(serialized).not.toContain("ck_live_nested_secret");
  });

  it("never carries the full prompt — only preview + length + hash", () => {
    const fullPrompt = "SECRET SOUL ".repeat(200);
    const line = formatAuditEvent(
      baseEvent({
        payload: {
          promptPreview: fullPrompt.slice(0, 280),
          promptLength: fullPrompt.length,
          promptSha256: "abc123def456",
        },
      }),
    );
    expect(line.payload.promptPreview).toHaveLength(280);
    expect(line.payload.promptLength).toBe(fullPrompt.length);
    expect(line.payload.promptSha256).toBe("abc123def456");
  });

  it("caps an oversized payload", () => {
    const huge = "x".repeat(AUDIT_PAYLOAD_MAX_BYTES * 2);
    const out = redactPayload({ blob: huge });
    expect(out._truncated).toBe(true);
    expect((out._preview as string).length).toBeLessThanOrEqual(AUDIT_PAYLOAD_MAX_BYTES);
  });
});

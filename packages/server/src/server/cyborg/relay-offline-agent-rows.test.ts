import { describe, it, expect } from "vitest";
import {
  buildOfflineAgentRow,
  offlineBindingVisible,
  offlineAgentRows,
  auditAgentRows,
  type OfflineAgentBinding,
} from "./relay-offline-agent-rows.js";

function binding(overrides: Partial<OfflineAgentBinding> = {}): OfflineAgentBinding {
  return {
    agentId: "agent-1",
    workspaceId: "ws-1",
    channelId: null,
    provider: "claude",
    model: "claude-sonnet-4",
    systemPrompt: null,
    daemonId: "daemon-A",
    cyboId: null,
    initiatedBy: "local-user-1",
    initiatedByEmail: "owner@test.dev",
    cwd: "/home/owner/project",
    providerSessionId: "sess-abc",
    ...overrides,
  };
}

describe("relay-offline-agent-rows", () => {
  it("buildOfflineAgentRow renders a non-live row (daemon offline) matching the daemon shape", () => {
    const row = buildOfflineAgentRow(binding());
    expect(row).toMatchObject({
      agentId: "agent-1",
      provider: "claude",
      channelId: null,
      cyboId: null,
      cyboName: null,
      cyboAvatar: null,
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
      // Same projection as the daemon's liveAgentFields no-live branch.
      lifecycle: "unknown",
      model: "claude-sonnet-4",
      modeId: null,
      thinkingOptionId: null,
      cwd: "/home/owner/project",
      // The owning daemon is offline — this is the whole point of the fallback.
      daemonLocal: false,
      daemonId: "daemon-A",
    });
    expect(row.availableModes).toEqual([]);
  });

  it("offlineBindingVisible: channel-bound sessions are visible to anyone", () => {
    const b = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
    };
    expect(offlineBindingVisible(b, "someone-else@test.dev")).toBe(true);
    expect(offlineBindingVisible(b, null)).toBe(true);
  });

  it("offlineBindingVisible: a channel-bound EPHEMERAL session is owner-scoped (NOT shared)", () => {
    // The ephemeral mention-session ownership leak: a channel-bound ephemeral summon
    // belongs to the user who triggered it and must NOT leak to other members the way
    // a (non-ephemeral) shared channel agent does.
    const b = {
      channelId: "chan-1",
      initiatedBy: "local-user-1",
      initiatedByEmail: "owner@test.dev",
      ephemeral: true,
    };
    expect(offlineBindingVisible(b, "owner@test.dev")).toBe(true); // the owner sees it
    expect(offlineBindingVisible(b, "someone-else@test.dev")).toBe(false); // others do NOT
    expect(offlineBindingVisible(b, null)).toBe(false);
  });

  it("offlineBindingVisible: a session with no initiator is visible", () => {
    const b = { channelId: null, initiatedBy: null, initiatedByEmail: null };
    expect(offlineBindingVisible(b, "anyone@test.dev")).toBe(true);
  });

  it("offlineBindingVisible: a PRIVATE session shows only to its initiator (case-insensitive)", () => {
    const b = { channelId: null, initiatedBy: "local-1", initiatedByEmail: "Owner@Test.dev" };
    expect(offlineBindingVisible(b, "owner@test.dev")).toBe(true);
    expect(offlineBindingVisible(b, "intruder@test.dev")).toBe(false);
    // No identity to compare against → not visible (never leak a private session).
    expect(offlineBindingVisible(b, null)).toBe(false);
  });

  it("lists a workspace's sessions from PG when the owning daemon is offline (no live agent)", () => {
    const bindings = [
      binding({ agentId: "a-own", initiatedByEmail: "owner@test.dev", channelId: null }),
      binding({ agentId: "a-channel", channelId: "chan-1", initiatedByEmail: "x@test.dev" }),
      binding({ agentId: "a-other", channelId: null, initiatedByEmail: "other@test.dev" }),
    ];
    // No live daemon answered (empty live set) — the relay falls back entirely to PG.
    const rows = offlineAgentRows(bindings, "owner@test.dev", new Set());
    const ids = rows.map((r) => r.agentId);
    expect(ids).toContain("a-own"); // own private session
    expect(ids).toContain("a-channel"); // channel-bound, everyone sees it
    expect(ids).not.toContain("a-other"); // someone else's private session stays hidden
  });

  it("dedupes against the live fan-out — a live agent's daemon row wins", () => {
    const bindings = [
      binding({ agentId: "a-live", initiatedByEmail: "owner@test.dev" }),
      binding({ agentId: "a-offline", initiatedByEmail: "owner@test.dev" }),
    ];
    const rows = offlineAgentRows(bindings, "owner@test.dev", new Set(["a-live"]));
    const ids = rows.map((r) => r.agentId);
    expect(ids).toEqual(["a-offline"]);
  });

  // ─── Daemon-owner audit offline fallback (#993) ──────────────────────
  it("auditAgentRows returns ALL sessions on the daemon — incl. other users' — with NO guestEmail scoping", () => {
    const bindings = [
      binding({ agentId: "a-own", initiatedByEmail: "owner@test.dev", daemonId: "daemon-A" }),
      binding({ agentId: "a-other", initiatedByEmail: "other@test.dev", daemonId: "daemon-A" }),
    ];
    const rows = auditAgentRows(bindings, "daemon-A");
    const ids = rows.map((r) => r.agentId).sort();
    // Both — the per-user offlineBindingVisible filter is NOT applied here.
    expect(ids).toEqual(["a-other", "a-own"]);
    for (const r of rows) {
      expect(r.ephemeral).toBe(false);
      expect(r.internal).toBe(false);
    }
  });

  it("auditAgentRows surfaces the ephemeral badge when a binding carries it", () => {
    const bindings = [binding({ agentId: "a-eph", daemonId: "daemon-A", ephemeral: true })];
    const rows = auditAgentRows(bindings, "daemon-A");
    expect(rows[0].ephemeral).toBe(true);
  });

  it("auditAgentRows filters to the target daemon only", () => {
    const bindings = [
      binding({ agentId: "on-A", daemonId: "daemon-A" }),
      binding({ agentId: "on-B", daemonId: "daemon-B" }),
    ];
    const rows = auditAgentRows(bindings, "daemon-A");
    const ids = rows.map((r) => r.agentId);
    expect(ids).toEqual(["on-A"]);
  });
});

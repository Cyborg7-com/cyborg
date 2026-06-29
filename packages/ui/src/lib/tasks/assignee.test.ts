// Unit tests for the PURE assignee resolver. No DOM — it only does pool lookups
// and initials, so it runs in the node-env vitest pass.
import { describe, expect, it } from "vitest";
import type { WorkspaceMember } from "$lib/core/types.js";
import type { Agent, Cybo } from "$lib/plugins/agents/types.js";
import { resolveAssignee, type AssigneePools } from "./assignee.js";

function member(overrides: Partial<WorkspaceMember>): WorkspaceMember {
  return {
    userId: "u1",
    email: "ada@example.com",
    name: "Ada Lovelace",
    role: "member",
    membershipType: "active",
    joinedAt: 0,
    ...overrides,
  };
}

function cybo(overrides: Partial<Cybo>): Cybo {
  return {
    id: "cybo-1",
    slug: "apex",
    name: "Apex",
    provider: "claude",
    isDefault: false,
    createdAt: 0,
    ...overrides,
  };
}

function agent(overrides: Partial<Agent>): Agent {
  return {
    agentId: "agent-1",
    provider: "claude",
    lifecycle: "running",
    ...overrides,
  };
}

const empty: AssigneePools = { members: [], cybos: [], agents: [] };

describe("resolveAssignee", () => {
  it("returns null for a null id (no assignee)", () => {
    expect(resolveAssignee(null, empty)).toBeNull();
  });

  it("resolves a workspace member to a user identity with image + initials", () => {
    const pools: AssigneePools = {
      members: [member({ userId: "u1", name: "Ada Lovelace", imageUrl: "https://img/ada.png" })],
      cybos: [],
      agents: [],
    };
    expect(resolveAssignee("u1", pools)).toEqual({
      kind: "user",
      id: "u1",
      name: "Ada Lovelace",
      avatarUrl: "https://img/ada.png",
      initials: "AL",
    });
  });

  it("falls back to a member's email when the name is null", () => {
    const pools: AssigneePools = {
      members: [member({ userId: "u2", name: null, email: "grace@example.com", imageUrl: null })],
      cybos: [],
      agents: [],
    };
    const r = resolveAssignee("u2", pools);
    expect(r?.kind).toBe("user");
    expect(r?.name).toBe("grace@example.com");
    expect(r?.avatarUrl).toBeNull();
  });

  it("resolves a cybo to a cybo identity, carrying the raw avatar (may be an emoji)", () => {
    const pools: AssigneePools = {
      members: [],
      cybos: [cybo({ id: "cybo-9", name: "Nova Bot", avatar: "🤖" })],
      agents: [],
    };
    expect(resolveAssignee("cybo-9", pools)).toEqual({
      kind: "cybo",
      id: "cybo-9",
      name: "Nova Bot",
      avatarUrl: "🤖",
      initials: "NB",
    });
  });

  it("resolves an agent by agentId, using its cyboName + cyboAvatar", () => {
    const pools: AssigneePools = {
      members: [],
      cybos: [],
      agents: [agent({ agentId: "agent-7", cyboName: "Helper", cyboAvatar: "https://img/h.png" })],
    };
    expect(resolveAssignee("agent-7", pools)).toEqual({
      kind: "agent",
      id: "agent-7",
      name: "Helper",
      avatarUrl: "https://img/h.png",
      initials: "H",
    });
  });

  it("uses the shared resolver (provider label) for an agent with no cyboName", () => {
    // resolveAssignee delegates agent naming to agentDisplayName(), so a
    // cyboName-less agent shows its pretty provider label, not the raw id.
    const pools: AssigneePools = {
      members: [],
      cybos: [],
      agents: [agent({ agentId: "agent-8", cyboName: null, provider: "claude" })],
    };
    const r = resolveAssignee("agent-8", pools);
    expect(r?.kind).toBe("agent");
    expect(r?.name).toBe("Claude");
  });

  it("resolves an unmatched id to kind 'unknown' with the id as the name", () => {
    const pools: AssigneePools = {
      members: [member({ userId: "u1" })],
      cybos: [cybo({ id: "cybo-1" })],
      agents: [agent({ agentId: "agent-1" })],
    };
    const r = resolveAssignee("nope-123", pools);
    expect(r).not.toBeNull();
    expect(r?.kind).toBe("unknown");
    expect(r?.id).toBe("nope-123");
    expect(r?.name).toBe("nope-123");
    expect(r?.avatarUrl).toBeNull();
  });

  it("prefers a member over a cybo/agent that share the same id", () => {
    const pools: AssigneePools = {
      members: [member({ userId: "dup", name: "Human Dup" })],
      cybos: [cybo({ id: "dup", name: "Cybo Dup" })],
      agents: [agent({ agentId: "dup", cyboName: "Agent Dup" })],
    };
    expect(resolveAssignee("dup", pools)?.kind).toBe("user");
  });
});

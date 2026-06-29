import { describe, expect, it } from "vitest";
import {
  applyMentionCap,
  channelMentionCandidates,
  type ChannelMentionScope,
} from "./channel-mention-candidates.js";

// The owner's repro: workspace "Jex", channel #general. Members tab shows cybo
// "Apex test" (a channel member). The workspace also has cybos "Apex" and
// "Apex 2" that are NOT in #general.
const APEX = { id: "c_apex", name: "Apex", role: "claude" };
const APEX2 = { id: "c_apex2", name: "Apex 2", role: "claude" };
const APEX_TEST = { id: "c_apex_test", name: "Apex test", role: "claude" };
const ALL_CYBOS = [APEX, APEX2, APEX_TEST];

const ALICE = {
  userId: "u_alice",
  name: "Alice",
  email: "alice@jex.com",
  membershipType: "active",
};
const BOB = { userId: "u_bob", name: "Bob", email: "bob@jex.com", membershipType: "active" };
const INVITED = {
  userId: "u_inv",
  name: "Pending",
  email: "p@jex.com",
  membershipType: "invited",
};

// #general scope: Alice + Apex test only.
const GENERAL: ChannelMentionScope = {
  userIds: new Set(["u_alice"]),
  cyboIds: new Set(["c_apex_test"]),
};

describe("channelMentionCandidates — channel scoping (the Jex/#general repro)", () => {
  it("ARTIFACT: @ in #general suggests 'Apex test'; 'Apex'/'Apex 2' do NOT appear", () => {
    const { agents } = channelMentionCandidates({
      query: "apex",
      members: [],
      cybos: ALL_CYBOS,
      scope: GENERAL,
    });
    const labels = agents.map((a) => a.label);
    expect(labels).toEqual(["Apex test"]);
    expect(labels).not.toContain("Apex");
    expect(labels).not.toContain("Apex 2");
    expect(agents[0].id).toBe("cybo:c_apex_test");
  });

  it("humans are channel-scoped too (Bob, a workspace member NOT in #general, is hidden)", () => {
    const { humans } = channelMentionCandidates({
      query: "",
      members: [ALICE, BOB],
      cybos: [],
      scope: GENERAL,
    });
    expect(humans.map((h) => h.label)).toEqual(["Alice"]);
  });

  it("still honors the typed query within the channel members", () => {
    const scope: ChannelMentionScope = {
      userIds: new Set(),
      cyboIds: new Set(["c_apex", "c_apex_test"]),
    };
    const { agents } = channelMentionCandidates({
      query: "test",
      members: [],
      cybos: ALL_CYBOS,
      scope,
    });
    expect(agents.map((a) => a.label)).toEqual(["Apex test"]);
  });

  it("invited (non-active) humans are excluded even if listed in the channel scope", () => {
    const { humans } = channelMentionCandidates({
      query: "",
      members: [ALICE, INVITED],
      cybos: [],
      scope: { userIds: new Set(["u_alice", "u_inv"]), cyboIds: new Set() },
    });
    expect(humans.map((h) => h.label)).toEqual(["Alice"]);
  });

  it("empty scope (channel with no cybo members) suggests no cybos — not the whole workspace", () => {
    const { agents } = channelMentionCandidates({
      query: "apex",
      members: [],
      cybos: ALL_CYBOS,
      scope: { userIds: new Set(), cyboIds: new Set() },
    });
    expect(agents).toEqual([]);
  });
});

describe("#630: adding a cybo to the channel makes it appear in @-autocomplete", () => {
  // Repro: owner adds cybo 'Apex' to #general. BEFORE the roster refreshes, the
  // scope doesn't include it, so @ doesn't offer it. AFTER the live refresh
  // (channel_cybo_added → roster re-fetch updates the scope), it IS offered —
  // no reload. This pins the outcome the live wiring produces.
  it("BEFORE add: cybo not yet in the channel scope is NOT offered", () => {
    const { agents } = channelMentionCandidates({
      query: "apex",
      members: [],
      cybos: ALL_CYBOS,
      scope: { userIds: new Set(["u_alice"]), cyboIds: new Set(["c_apex_test"]) },
    });
    expect(agents.map((a) => a.label)).not.toContain("Apex");
  });

  it("AFTER add (roster refreshed → scope gains the cybo): it IS offered live", () => {
    const { agents } = channelMentionCandidates({
      query: "apex",
      members: [],
      cybos: ALL_CYBOS,
      // Same channel, scope now includes the newly-added cybo (what the
      // channel_cybo_added bump → fetch_channel_cybos produces).
      scope: { userIds: new Set(["u_alice"]), cyboIds: new Set(["c_apex_test", "c_apex"]) },
    });
    expect(agents.map((a) => a.label)).toContain("Apex");
  });
});

// The composer (MessageInput) applies the SHARED applyMentionCap() over the
// builder's output so agents always survive when humans fill the list: total cap
// 12, up to 3 slots reserved for agents, order everyone → humans → agents. These
// tests import the REAL helper (not a copy) so the "agents missing from mentions"
// regression stays pinned to the shipped code path.
const EVERYONE = { label: "everyone" };

describe("split mention cap — agents survive when humans exceed the list", () => {
  it("with 15 channel humans + 2 agents, both agents still appear (order: humans → agents)", () => {
    const manyHumans = Array.from({ length: 15 }, (_, i) => ({
      userId: `u${i}`,
      name: `Human ${i}`,
      email: `h${i}@jex.com`,
      membershipType: "active",
    }));
    const twoAgents = [APEX, APEX_TEST];
    const scope: ChannelMentionScope = {
      userIds: new Set(manyHumans.map((h) => h.userId)),
      cyboIds: new Set(twoAgents.map((a) => a.id)),
    };
    const { humans, agents } = channelMentionCandidates({
      query: "",
      members: manyHumans,
      cybos: twoAgents,
      scope,
    });
    // everyone pinned first (1 slot), so humanCap = 12 - 1 - min(2,3) = 9.
    const labels = applyMentionCap<{ label: string }>([EVERYONE], humans, agents).map(
      (c) => c.label,
    );
    expect(labels.length).toBe(12); // everyone + 9 humans + 2 agents
    expect(labels[0]).toBe("everyone");
    expect(labels).toContain("Apex");
    expect(labels).toContain("Apex test");
    // Order: all humans come before the first agent.
    expect(labels.indexOf("Apex")).toBeGreaterThan(labels.indexOf("Human 8"));
  });

  it("reserves at most 3 agent slots even when many agents match", () => {
    const manyHumans = Array.from({ length: 20 }, (_, i) => ({
      userId: `u${i}`,
      name: `Human ${i}`,
      email: `h${i}@jex.com`,
      membershipType: "active",
    }));
    const manyAgents = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: `Agent ${i}`,
      role: "claude",
    }));
    const scope: ChannelMentionScope = {
      userIds: new Set(manyHumans.map((h) => h.userId)),
      cyboIds: new Set(manyAgents.map((a) => a.id)),
    };
    const { humans, agents } = channelMentionCandidates({
      query: "",
      members: manyHumans,
      cybos: manyAgents,
      scope,
    });
    const labels = applyMentionCap<{ label: string }>([], humans, agents).map((c) => c.label);
    const agentLabels = labels.filter((l) => l.startsWith("Agent "));
    expect(agentLabels.length).toBe(3); // capped at the 3-slot reserve
    expect(labels.length).toBe(12); // 9 humans + 3 agents
  });
});

describe("channelMentionCandidates — unscoped fallback (DM / roster not loaded)", () => {
  it("scope=null keeps today's workspace-wide behavior (mentions never break)", () => {
    const { humans, agents } = channelMentionCandidates({
      query: "apex",
      members: [ALICE, BOB],
      cybos: ALL_CYBOS,
      scope: null,
    });
    expect(agents.map((a) => a.label)).toEqual(["Apex", "Apex 2", "Apex test"]);
    // humans filtered by query only (none match "apex") but not by channel.
    expect(humans).toEqual([]);
  });

  it("scope=null with an empty query lists all active workspace members + cybos", () => {
    const { humans, agents } = channelMentionCandidates({
      query: "",
      members: [ALICE, BOB, INVITED],
      cybos: ALL_CYBOS,
      scope: null,
    });
    expect(humans.map((h) => h.label)).toEqual(["Alice", "Bob"]); // invited still excluded
    expect(agents.map((a) => a.label)).toEqual(["Apex", "Apex 2", "Apex test"]);
  });
});

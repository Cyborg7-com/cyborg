import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_DM_OTHERS,
  deriveGroupDmName,
  groupDmMemberLabel,
  validateGroupDmParticipants,
} from "./group-dm.js";

describe("groupDmMemberLabel", () => {
  it("prefers the real name", () => {
    expect(groupDmMemberLabel({ userId: "u1", name: "Alice", email: "a@x.com" })).toBe("Alice");
  });

  it("falls back to the email local-part when there is no name", () => {
    expect(groupDmMemberLabel({ userId: "u1", name: null, email: "bob@x.com" })).toBe("bob");
    expect(groupDmMemberLabel({ userId: "u1", name: "  ", email: "carol@x.com" })).toBe("carol");
  });

  it("falls back to a generic label when name and email are both empty", () => {
    expect(groupDmMemberLabel({ userId: "u1", name: null, email: null })).toBe("Someone");
    expect(groupDmMemberLabel({ userId: "u1", name: "", email: "" })).toBe("Someone");
  });
});

describe("deriveGroupDmName", () => {
  it("sorts display names case-insensitively and comma-joins them", () => {
    const name = deriveGroupDmName([
      { userId: "u1", name: "charlie", email: null },
      { userId: "u2", name: "Alice", email: null },
      { userId: "u3", name: "bob", email: null },
    ]);
    expect(name).toBe("Alice, bob, charlie");
  });

  it("is deterministic regardless of input order", () => {
    const a = deriveGroupDmName([
      { userId: "u1", name: "Zoe", email: null },
      { userId: "u2", name: "Amy", email: null },
    ]);
    const b = deriveGroupDmName([
      { userId: "u2", name: "Amy", email: null },
      { userId: "u1", name: "Zoe", email: null },
    ]);
    expect(a).toBe(b);
    expect(a).toBe("Amy, Zoe");
  });

  it("uses the email fallback for nameless members in the title", () => {
    expect(
      deriveGroupDmName([
        { userId: "u1", name: "Alice", email: "alice@x.com" },
        { userId: "u2", name: null, email: "zeb@x.com" },
      ]),
    ).toBe("Alice, zeb");
  });
});

describe("validateGroupDmParticipants", () => {
  const memberIds = new Set(["creator", "a", "b", "c"]);

  it("returns the de-duped OTHERS list, dropping the creator", () => {
    const r = validateGroupDmParticipants({
      creatorId: "creator",
      participants: ["a", "b", "a", "creator"],
      memberIds,
    });
    expect(r).toEqual({ ok: true, participantIds: ["a", "b"] });
  });

  it("rejects when there are no other members", () => {
    const r = validateGroupDmParticipants({
      creatorId: "creator",
      participants: ["creator"],
      memberIds,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a participant who is not a workspace member", () => {
    const r = validateGroupDmParticipants({
      creatorId: "creator",
      participants: ["a", "ghost"],
      memberIds,
    });
    expect(r).toEqual({ ok: false, error: "all participants must be members of this workspace" });
  });

  it("rejects more than MAX_GROUP_DM_OTHERS others", () => {
    const big = new Set(["creator"]);
    const participants: string[] = [];
    for (let i = 0; i <= MAX_GROUP_DM_OTHERS; i += 1) {
      const id = `m${i}`;
      big.add(id);
      participants.push(id);
    }
    expect(participants.length).toBe(MAX_GROUP_DM_OTHERS + 1);
    const r = validateGroupDmParticipants({ creatorId: "creator", participants, memberIds: big });
    expect(r.ok).toBe(false);
  });

  it("accepts exactly MAX_GROUP_DM_OTHERS others", () => {
    const big = new Set(["creator"]);
    const participants: string[] = [];
    for (let i = 0; i < MAX_GROUP_DM_OTHERS; i += 1) {
      const id = `m${i}`;
      big.add(id);
      participants.push(id);
    }
    const r = validateGroupDmParticipants({ creatorId: "creator", participants, memberIds: big });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.participantIds.length).toBe(MAX_GROUP_DM_OTHERS);
  });
});

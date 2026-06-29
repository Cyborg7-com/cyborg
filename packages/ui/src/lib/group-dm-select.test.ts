import { describe, expect, it } from "vitest";
import {
  MAX_GROUP_DM_OTHERS,
  canCreateGroupDm,
  groupDmCandidates,
  type GroupDmCandidate,
} from "./group-dm-select.js";

describe("canCreateGroupDm", () => {
  it("requires at least one other member", () => {
    expect(canCreateGroupDm(0)).toBe(false);
    expect(canCreateGroupDm(1)).toBe(true);
  });

  it("rejects more than the max", () => {
    expect(canCreateGroupDm(MAX_GROUP_DM_OTHERS)).toBe(true);
    expect(canCreateGroupDm(MAX_GROUP_DM_OTHERS + 1)).toBe(false);
  });
});

const members: GroupDmCandidate[] = [
  { userId: "me", name: "Me", email: "me@x.com", membershipType: "active" },
  { userId: "a", name: "Alice", email: "alice@x.com", membershipType: "active" },
  { userId: "b", name: "Bob", email: "bob@x.com", membershipType: "active" },
  { userId: "inv", name: "Invitee", email: "inv@x.com", membershipType: "invited" },
];

describe("groupDmCandidates", () => {
  it("excludes self, already-selected, and invited members", () => {
    const out = groupDmCandidates({
      members,
      selfId: "me",
      selectedIds: new Set(["a"]),
      query: "",
    });
    expect(out.map((m) => m.userId)).toEqual(["b"]);
  });

  it("matches the query against name and email", () => {
    const byName = groupDmCandidates({
      members,
      selfId: "me",
      selectedIds: new Set(),
      query: "ali",
    });
    expect(byName.map((m) => m.userId)).toEqual(["a"]);

    const byEmail = groupDmCandidates({
      members,
      selfId: "me",
      selectedIds: new Set(),
      query: "bob@x",
    });
    expect(byEmail.map((m) => m.userId)).toEqual(["b"]);
  });

  it("returns all active non-self members when the query is blank", () => {
    const out = groupDmCandidates({
      members,
      selfId: "me",
      selectedIds: new Set(),
      query: "  ",
    });
    expect(out.map((m) => m.userId)).toEqual(["a", "b"]);
  });
});

import { describe, it, expect } from "vitest";
import { AuthState } from "./state.svelte.js";
import type { WorkspaceMember } from "./types.js";

// External Slack participants (id `slack:<team>:<user>`) are NOT workspace
// members — they never enter workspaceState.members. They flow only into the
// name/avatar caches (`setMemberImagesFromMembers`) so the profile panel + chat
// can render their real Slack display name + avatar. These lock:
//  1. the cache is populated from an ExternalParticipant-shaped row, and
//  2. the exact ProfilePanel name-resolution fallback chain for a human target
//     with no member row still surfaces the cached (external) name.

describe("external Slack participants — identity cache", () => {
  it("populates name + avatar from an external participant row", () => {
    const auth = new AuthState();
    auth.setMemberImagesFromMembers([
      { userId: "slack:T1:U1", name: "Alice Slack", imageUrl: "https://img/alice.png" },
    ]);
    expect(auth.getMemberName("slack:T1:U1")).toBe("Alice Slack");
    expect(auth.getMemberImage("slack:T1:U1")).toBe("https://img/alice.png");
  });

  it("ProfilePanel name resolution surfaces the cached external name when no member row exists", () => {
    const auth = new AuthState();
    auth.setMemberImagesFromMembers([
      { userId: "slack:T1:U1", name: "Alice Slack", imageUrl: "https://img/alice.png" },
    ]);
    // No roster row for a slack guest — mirrors ProfilePanel's `member` being
    // undefined. `find` on an empty roster yields `WorkspaceMember | undefined`
    // (not narrowed to `never`), matching ProfilePanel's real lookup.
    const roster: WorkspaceMember[] = [];
    const member = roster.find((m) => m.userId === "slack:T1:U1");
    const target = { id: "slack:T1:U1" };
    const name =
      member?.name ?? auth.getMemberName(target.id) ?? member?.email?.split("@")[0] ?? "User";
    expect(name).toBe("Alice Slack");
  });

  it("a real member still resolves via the roster (member found), unchanged", () => {
    const auth = new AuthState();
    const member: WorkspaceMember = {
      userId: "u-real",
      email: "real@example.com",
      name: "Real Member",
      role: "member",
      membershipType: "active",
      joinedAt: 0,
    };
    const target = { id: "u-real" };
    // Roster hit wins before the cache/email/"User" fallbacks are ever consulted.
    const name =
      member?.name ?? auth.getMemberName(target.id) ?? member?.email?.split("@")[0] ?? "User";
    expect(name).toBe("Real Member");
  });
});

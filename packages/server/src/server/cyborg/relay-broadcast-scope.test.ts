// FIX 1 (internal docs #1): a cybo mention/capability notice must reach ONLY the
// mention author, not the whole workspace. The relay's broadcast scoping had no
// case for cyborg:cybo_mention_notice → allowedUsers stayed null → the notice
// ("Rick can't reply here — run `claude login`…") fanned to every member.
//
// computeBroadcastScope is the single scoping unit broadcastToGuestsLocal uses
// for both the local and the Redis re-broadcast path; these tests pin the
// author-only contract and the workspace-wide default.
import { describe, it, expect } from "vitest";
import { computeBroadcastScope } from "./relay-broadcast-scope.js";

// Mirrors broadcastToGuestsLocal's per-guest filter: a guest receives the message
// iff it passes both the allowedUsers and allowedEmail gates.
function deliveredTo(
  scope: ReturnType<typeof computeBroadcastScope>,
  guests: { userId: string; email: string }[],
): string[] {
  return guests
    .filter((g) => !scope.allowedUsers || scope.allowedUsers.has(g.userId))
    .filter((g) => !scope.allowedEmail || g.email === scope.allowedEmail)
    .map((g) => g.userId);
}

describe("computeBroadcastScope — cybo mention notice is author-only (internal docs #1)", () => {
  const members = [
    { userId: "author", email: "author@test.dev" },
    { userId: "bystander-1", email: "b1@test.dev" },
    { userId: "bystander-2", email: "b2@test.dev" },
  ];

  it("a cybo_mention_notice reaches ONLY the author (payload.toUserId), not other members", () => {
    const scope = computeBroadcastScope({
      type: "cyborg:cybo_mention_notice",
      payload: {
        toUserId: "author",
        workspaceId: "ws-1",
        channelId: "ch-1",
        text: "Rick can't reply here — run `claude login` on that machine.",
      },
    });

    expect(scope.allowedUsers).not.toBeNull();
    expect(deliveredTo(scope, members)).toEqual(["author"]);
  });

  it("a channel message (no scoping case) still fans out to EVERY member", () => {
    const scope = computeBroadcastScope({
      type: "cyborg:channel_message_broadcast",
      payload: { id: "m1", text: "hi all" },
    });

    expect(scope.allowedUsers).toBeNull();
    expect(scope.allowedEmail).toBeNull();
    expect(deliveredTo(scope, members)).toEqual(["author", "bystander-1", "bystander-2"]);
  });

  it("an untagged notice (no toUserId) fails open — does not silently drop to no one", () => {
    const scope = computeBroadcastScope({
      type: "cyborg:cybo_mention_notice",
      payload: { workspaceId: "ws-1", text: "gap" },
    });

    expect(scope.allowedUsers).toBeNull();
    expect(deliveredTo(scope, members)).toEqual(["author", "bystander-1", "bystander-2"]);
  });

  it("regression: the existing private types stay scoped (dm, thread, terminal, catchup)", () => {
    expect(
      deliveredTo(
        computeBroadcastScope({
          type: "cyborg:dm_broadcast",
          payload: { fromId: "author", toId: "bystander-1" },
        }),
        members,
      ),
    ).toEqual(["author", "bystander-1"]);

    expect(
      deliveredTo(
        computeBroadcastScope({
          type: "cyborg:thread_updated",
          payload: { toUserId: "bystander-2" },
        }),
        members,
      ),
    ).toEqual(["bystander-2"]);

    expect(
      deliveredTo(
        computeBroadcastScope({
          type: "cyborg:terminal_output",
          payload: { toUserId: "author" },
        }),
        members,
      ),
    ).toEqual(["author"]);

    expect(
      deliveredTo(
        computeBroadcastScope({
          type: "cyborg:catchup_result",
          payload: { toUserId: "bystander-1" },
        }),
        members,
      ),
    ).toEqual(["bystander-1"]);
  });

  it("the terminal DIRECTORY feed is owner-scoped (terminal CLI-UI unification)", () => {
    // A terminals_changed snapshot lists the owner's sessions + cwds — it must
    // reach ONLY the owner (payload.toUserId), never other workspace members.
    expect(
      deliveredTo(
        computeBroadcastScope({
          type: "cyborg:terminals_changed",
          payload: { workspaceId: "ws-1", toUserId: "author", terminals: [] },
        }),
        members,
      ),
    ).toEqual(["author"]);
  });

  it("a terminal alias change is per-user — reaches ONLY the owner's other clients", () => {
    // A rename is a personal cosmetic label (a terminal is private to its owner),
    // so the live cross-device broadcast must reach ONLY that user (payload.toUserId),
    // never other workspace members.
    expect(
      deliveredTo(
        computeBroadcastScope({
          type: "cyborg:terminal_alias_changed",
          payload: { terminalId: "t-1", alias: "deploy box", toUserId: "author" },
        }),
        members,
      ),
    ).toEqual(["author"]);
  });

  it("a private agent stream scopes by email (allowedEmail), not userId", () => {
    const scope = computeBroadcastScope({
      type: "cyborg:agent_stream",
      payload: { privateToEmail: "b2@test.dev", event: { type: "text" } },
    });

    expect(scope.allowedEmail).toBe("b2@test.dev");
    expect(deliveredTo(scope, members)).toEqual(["bystander-2"]);
  });
});

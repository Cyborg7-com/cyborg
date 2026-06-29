import { describe, it, expect } from "vitest";
import { MessageCardSchema } from "./cyborg-messages.js";

// Locks the discriminatedUnion("kind") build (#600 review): the EventCard enum
// discriminator must coexist with the release/approval literals, and the
// approval variant (with signed actions) must parse.
describe("MessageCardSchema discriminated union", () => {
  it("parses an approval card with signed actions", () => {
    const card = {
      kind: "approval",
      title: "Apex wants to run a tool",
      toolName: "bash",
      detail: "ls -la",
      agentName: "Apex",
      actions: [
        { id: "approve", label: "Approve", style: "primary", token: "t.s", forActor: "u1" },
      ],
    };
    expect(MessageCardSchema.parse(card)).toMatchObject({ kind: "approval" });
  });

  it("still parses release and event cards (enum discriminator intact)", () => {
    expect(
      MessageCardSchema.parse({
        kind: "release",
        repo: "o/r",
        repoUrl: "https://x",
        tag: "v1",
        name: null,
        body: null,
        url: "https://x/r",
        prerelease: false,
        draft: false,
        author: null,
        publishedAt: null,
      }),
    ).toMatchObject({ kind: "release" });
    expect(
      MessageCardSchema.parse({
        kind: "workflow_run",
        repo: "o/r",
        repoUrl: "https://x",
        icon: "ci",
        eventLabel: "CI",
        accent: "success",
        badge: null,
        title: "build",
        url: "https://x/run",
        body: null,
        fields: [],
        author: null,
        timestamp: null,
      }),
    ).toMatchObject({ kind: "workflow_run" });
  });

  it("rejects an unknown card kind", () => {
    expect(() => MessageCardSchema.parse({ kind: "nope" })).toThrow();
  });
});

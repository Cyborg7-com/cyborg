import { describe, expect, it } from "vitest";
import { mentionToken, resolveMentions } from "./resolve-mentions.js";

const MEMBERS = [
  { userId: "u_ana", name: "Ana", email: "ana@x.dev" },
  { userId: "u_rick", name: "Rick", email: "rick.h@x.dev" },
];
const CYBOS = [
  { id: "cy_1", name: "Rickmaster", slug: "rickmaster" },
  { id: "cy_2", name: "Apex Bot", slug: "apex" },
  // Collision shape: a cybo named exactly like a human member.
  { id: "cy_3", name: "Ana", slug: "ana-cybo" },
  // #631: a MULTI-WORD cybo name. The repro from the issue ("@Apex personal").
  { id: "cy_4", name: "Apex personal", slug: "apex-personal" },
];

function resolve(input: string, selected: { userId: string; label: string }[] = []) {
  return resolveMentions(input, { selectedMentions: selected, members: MEMBERS, cybos: CYBOS });
}

describe("resolveMentions — members (existing behavior)", () => {
  it("explicit picks resolve while their token is still in the text", () => {
    const picks = [{ userId: "u_ana", label: "Ana" }];
    expect(resolve("hey @Ana!", picks)).toEqual(["u_ana"]);
    expect(resolve("hey nobody", picks)).toEqual([]);
  });

  it("hand-typed member handles match name / email / email local-part", () => {
    expect(resolve("ping @ana")).toEqual(["u_ana"]);
    expect(resolve("ping @rick.h")).toContain("u_rick");
  });
});

describe("resolveMentions — cybos (P1: hand-typed, not just autocomplete picks)", () => {
  it("matches a cybo by NAME, case-insensitive → cybo:<id>", () => {
    expect(resolve("yo @rickmaster check this")).toEqual(["cybo:cy_1"]);
    expect(resolve("yo @RICKMASTER")).toEqual(["cybo:cy_1"]);
  });

  it("matches a cybo by SLUG", () => {
    expect(resolve("ask @apex about it")).toEqual(["cybo:cy_2"]);
  });

  it("bracketed multi-word cybo names resolve too", () => {
    expect(resolve("ask @[Apex Bot] about it")).toEqual(["cybo:cy_2"]);
  });

  it("members WIN a name collision — a cybo never shadows a human", () => {
    expect(resolve("ping @ana")).toEqual(["u_ana"]);
    // The colliding cybo is still reachable by its own slug.
    expect(resolve("ping @ana-cybo")).toEqual(["cybo:cy_3"]);
  });

  it("an explicit cybo pick is not double-matched by name", () => {
    const picks = [{ userId: "cybo:cy_1", label: "Rickmaster" }];
    expect(resolve("yo @Rickmaster", picks)).toEqual(["cybo:cy_1"]);
  });

  it("mixed humans + cybos dedupe into one list", () => {
    expect(resolve("ping @ana and @rickmaster and @apex").sort()).toEqual(
      ["cybo:cy_1", "cybo:cy_2", "u_ana"].sort(),
    );
  });
});

describe("resolveMentions — #631: hand-typed MULTI-WORD names (greedy match)", () => {
  it("the repro: '@Apex personal' typed by hand resolves to the multi-word cybo", () => {
    expect(resolve("@Apex personal Hola")).toEqual(["cybo:cy_4"]);
  });

  it("multi-word match is case-insensitive and ignores trailing text", () => {
    expect(resolve("yo @apex personal please")).toEqual(["cybo:cy_4"]);
    expect(resolve("@APEX PERSONAL!!")).toEqual(["cybo:cy_4"]);
  });

  it("matches the multi-word slug too", () => {
    expect(resolve("@apex-personal ping")).toEqual(["cybo:cy_4"]);
  });

  it("greedy picks the LONGEST name — single-word '@apex' still resolves the short cybo", () => {
    // "Apex personal" must NOT swallow a bare "@apex" (boundary after "apex").
    expect(resolve("@apex about it")).toEqual(["cybo:cy_2"]);
  });

  it("does NOT break single-word matches that are a prefix of a longer name", () => {
    // "@rickmaster" must resolve the cybo, not the member "rick".
    expect(resolve("@rickmaster go")).toEqual(["cybo:cy_1"]);
  });

  it("an unknown multi-word handle resolves to nothing", () => {
    expect(resolve("@Totally Unknown person")).toEqual([]);
  });

  it("members still win a collision in the greedy path", () => {
    expect(resolve("ping @ana now")).toEqual(["u_ana"]);
  });

  it("multi-word in the MIDDLE of a sentence resolves", () => {
    expect(resolve("hey @Apex personal can you help").sort()).toEqual(["cybo:cy_4"]);
  });
});

describe("mentionToken", () => {
  it("brackets labels with whitespace", () => {
    expect(mentionToken("Ana")).toBe("@Ana");
    expect(mentionToken("Apex Bot")).toBe("@[Apex Bot]");
  });
});

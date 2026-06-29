import { describe, expect, it } from "vitest";
import { matchPromptTemplates, MAX_TEMPLATE_SUGGESTIONS } from "./prompt-templates.js";
import type { PromptTemplate } from "$lib/core/types.js";

// #602 — the composer's secondary "Templates" autocomplete group. matchPromptTemplates
// ranks a workspace's templates against the typed query like the channel slash
// commands do (prefix first, then fuzzy near-misses), capped to a small list.

function tmpl(name: string, body = `body for ${name}`): PromptTemplate {
  return {
    id: `pt_${name}`,
    workspaceId: "ws1",
    name,
    body,
    createdBy: "u1",
    createdAt: 0,
  };
}

describe("matchPromptTemplates", () => {
  const templates = [tmpl("Standup"), tmpl("Summary"), tmpl("Welcome"), tmpl("Release Notes")];

  it("returns the first N templates (in given order) for an empty query", () => {
    const out = matchPromptTemplates("", templates);
    expect(out.map((t) => t.name)).toEqual(["Standup", "Summary", "Welcome", "Release Notes"]);
  });

  it("prefix-matches a name (case-insensitive)", () => {
    expect(matchPromptTemplates("stand", templates).map((t) => t.name)).toEqual(["Standup"]);
    expect(matchPromptTemplates("STAND", templates).map((t) => t.name)).toEqual(["Standup"]);
  });

  it("ranks a prefix match ahead of a fuzzy near-miss", () => {
    // "sum" prefixes Summary (score 0); "standup" is not close → excluded.
    const out = matchPromptTemplates("sum", templates);
    expect(out[0].name).toBe("Summary");
  });

  it("fuzzy-matches a single typo for a longer query", () => {
    // "standap" (typo of "standup") is within edit distance for a 3+ char query.
    expect(matchPromptTemplates("standap", templates).map((t) => t.name)).toContain("Standup");
  });

  it("returns nothing when no name is close enough", () => {
    expect(matchPromptTemplates("zzzzzz", templates)).toEqual([]);
  });

  it("caps the result at MAX_TEMPLATE_SUGGESTIONS", () => {
    const many = Array.from({ length: MAX_TEMPLATE_SUGGESTIONS + 5 }, (_, i) => tmpl(`T${i}`));
    expect(matchPromptTemplates("", many)).toHaveLength(MAX_TEMPLATE_SUGGESTIONS);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(matchPromptTemplates("  stand  ", templates).map((t) => t.name)).toEqual(["Standup"]);
  });
});

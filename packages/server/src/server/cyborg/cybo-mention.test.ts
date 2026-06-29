import { describe, it, expect } from "vitest";
import { resolveMentionedCyboIds } from "./message-router.js";

// The selection logic behind "@-mention a cybo channel member → invoke it":
// which mentions resolve to which cybo MEMBERS (parts 2/3 of the feature).
const cybos = [
  { id: "cy_atlas", slug: "atlas", name: "Atlas Reed" },
  { id: "cy_mira", slug: "mira", name: "Mira" },
  { id: "cy_other", slug: "other", name: "Other" }, // not a channel member below
];

describe("resolveMentionedCyboIds", () => {
  it("matches a raw cybo id that is a member", () => {
    expect(resolveMentionedCyboIds(["cy_atlas"], ["cy_atlas", "cy_mira"], cybos)).toEqual([
      "cy_atlas",
    ]);
  });

  it("matches the cybo:<id> mention form", () => {
    expect(resolveMentionedCyboIds(["cybo:cy_mira"], ["cy_mira"], cybos)).toEqual(["cy_mira"]);
  });

  it("matches by slug and by name, case-insensitively", () => {
    expect(resolveMentionedCyboIds(["atlas"], ["cy_atlas"], cybos)).toEqual(["cy_atlas"]);
    expect(resolveMentionedCyboIds(["Mira"], ["cy_mira"], cybos)).toEqual(["cy_mira"]);
  });

  it("tolerates a leading @ on slug/name mentions", () => {
    expect(resolveMentionedCyboIds(["@atlas"], ["cy_atlas"], cybos)).toEqual(["cy_atlas"]);
    expect(resolveMentionedCyboIds(["@cybo:cy_mira"], ["cy_mira"], cybos)).toEqual(["cy_mira"]);
  });

  it("ignores a cybo that is NOT a member of the channel", () => {
    expect(resolveMentionedCyboIds(["cy_other", "other"], ["cy_atlas"], cybos)).toEqual([]);
  });

  it("ignores human / unknown mentions (loop & noise prevention)", () => {
    expect(resolveMentionedCyboIds(["user_123", "nobody"], ["cy_atlas"], cybos)).toEqual([]);
  });

  it("de-duplicates when the same cybo is mentioned several ways", () => {
    expect(
      resolveMentionedCyboIds(["cy_atlas", "atlas", "cybo:cy_atlas"], ["cy_atlas"], cybos),
    ).toEqual(["cy_atlas"]);
  });

  it("returns empty when the channel has no cybo members", () => {
    expect(resolveMentionedCyboIds(["cy_atlas"], [], cybos)).toEqual([]);
  });

  it("resolves several distinct members in one message", () => {
    expect(
      resolveMentionedCyboIds(["atlas", "cybo:cy_mira"], ["cy_atlas", "cy_mira"], cybos).sort(),
    ).toEqual(["cy_atlas", "cy_mira"]);
  });
});

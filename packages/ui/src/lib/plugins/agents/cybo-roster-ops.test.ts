import { describe, expect, it } from "vitest";
import { appendCybo, removeCybo } from "./cybo-roster-ops.js";
import type { Cybo } from "./types.js";

const cybo = (over: Partial<Cybo> & Pick<Cybo, "id">): Cybo => ({
  slug: "apex",
  name: "Apex",
  provider: "claude",
  model: "claude-sonnet-4-6",
  description: null,
  avatar: null,
  role: null,
  isDefault: false,
  createdAt: 0,
  ...over,
});

describe("appendCybo (in-place)", () => {
  it("appends a cybo whose id isn't present", () => {
    const list = [cybo({ id: "cy_1" })];
    appendCybo(list, cybo({ id: "cy_2", name: "Mira" }));
    expect(list.map((c) => c.id)).toEqual(["cy_1", "cy_2"]);
  });

  it("is idempotent — skips a duplicate id (creator already refetched)", () => {
    const list = [cybo({ id: "cy_1" })];
    appendCybo(list, cybo({ id: "cy_1", name: "Renamed" }));
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Apex"); // unchanged — append only, no replace
  });

  it("mutates the SAME array reference", () => {
    const list = [cybo({ id: "cy_1" })];
    const before = list;
    appendCybo(list, cybo({ id: "cy_2" }));
    expect(list).toBe(before);
  });
});

describe("removeCybo (in-place)", () => {
  it("removes the matching cybo", () => {
    const list = [cybo({ id: "cy_1" }), cybo({ id: "cy_2" })];
    removeCybo(list, "cy_1");
    expect(list.map((c) => c.id)).toEqual(["cy_2"]);
  });

  it("no-ops when the id isn't present (deleter already filtered)", () => {
    const list = [cybo({ id: "cy_1" })];
    removeCybo(list, "cy_missing");
    expect(list.map((c) => c.id)).toEqual(["cy_1"]);
  });

  it("removes only the matching cybo, preserves the rest (same refs)", () => {
    const a = cybo({ id: "cy_1" });
    const b = cybo({ id: "cy_2" });
    const list = [a, b];
    removeCybo(list, "cy_1");
    expect(list).toEqual([b]);
    expect(list[0]).toBe(b);
  });

  it("prunes a deleted cybo so it can't render as a phantom in 'Your cybos'", () => {
    // Repro of the phantom bug: a deleted cybo (cy_apex) sits in the roster next
    // to the survivors; pruning it on the delete broadcast/response leaves only
    // the live cybos — the same set the DB holds.
    const list = [
      cybo({ id: "cy_rick", slug: "rick" }),
      cybo({ id: "cy_apex", slug: "apex" }),
      cybo({ id: "cy_sprite", slug: "sprite" }),
    ];
    removeCybo(list, "cy_apex");
    expect(list.map((c) => c.slug)).toEqual(["rick", "sprite"]);
  });
});

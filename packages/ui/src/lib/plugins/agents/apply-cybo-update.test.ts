import { describe, expect, it } from "vitest";
import { applyCyboUpdate, type CyboUpdateBroadcast } from "./apply-cybo-update.js";
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

const upd = (
  over: Partial<CyboUpdateBroadcast> & Pick<CyboUpdateBroadcast, "id">,
): CyboUpdateBroadcast => ({
  slug: "apex",
  name: "Apex",
  description: null,
  avatar: null,
  role: null,
  provider: "claude",
  model: "claude-sonnet-4-6",
  ...over,
});

describe("applyCyboUpdate (in-place)", () => {
  it("mutates name / model / avatar on the target", () => {
    const c = cybo({ id: "cy_1" });
    applyCyboUpdate(
      c,
      upd({ id: "cy_1", name: "Apex II", model: "claude-opus-4-8", avatar: "https://x/a.png" }),
    );
    expect(c).toMatchObject({
      name: "Apex II",
      model: "claude-opus-4-8",
      avatar: "https://x/a.png",
    });
  });

  it("mutates the SAME object reference (surgical reactivity)", () => {
    const c = cybo({ id: "cy_1" });
    const before = c;
    applyCyboUpdate(c, upd({ id: "cy_1", name: "Changed" }));
    expect(c).toBe(before);
    expect(c.name).toBe("Changed");
  });

  it("applies explicit nulls (clearing avatar/role/model)", () => {
    const c = cybo({ id: "cy_1", avatar: "old", role: "Dev", model: "m" });
    applyCyboUpdate(c, upd({ id: "cy_1", avatar: null, role: null, model: null }));
    expect(c).toMatchObject({ avatar: null, role: null, model: null });
  });

  it("preserves non-broadcast fields (soul, isDefault, createdAt, id, slug)", () => {
    const c = cybo({ id: "cy_1", slug: "apex", soul: "secret", isDefault: true, createdAt: 99 });
    applyCyboUpdate(c, upd({ id: "cy_1", name: "New" }));
    expect(c).toMatchObject({
      id: "cy_1",
      slug: "apex",
      soul: "secret",
      isDefault: true,
      createdAt: 99,
      name: "New",
    });
  });
});

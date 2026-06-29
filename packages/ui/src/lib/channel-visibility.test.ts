import { describe, expect, it } from "vitest";
import { groupDmChannels, isGroupDm, visibleChannels } from "./channel-visibility.js";

// Minimal channel-ish rows — the helpers only read `type` / `isHidden`. Typed
// to the same Pick the helpers accept so excess-property checks stay honest.
interface Row {
  id: string;
  type?: "regular" | "group_dm";
  isHidden?: boolean;
}
const regular: Row = { id: "c1", type: "regular", isHidden: false };
const groupDm: Row = { id: "c2", type: "group_dm", isHidden: true };
const legacyNoType: Row = { id: "c3" }; // older payload: no type/isHidden → regular
const hiddenOnly: Row = { id: "c4", isHidden: true }; // hidden flag without a type

describe("isGroupDm", () => {
  it("is true for a group_dm channel", () => {
    expect(isGroupDm(groupDm)).toBe(true);
  });

  it("is true when only isHidden is set (defense-in-depth)", () => {
    expect(isGroupDm(hiddenOnly)).toBe(true);
  });

  it("is false for a regular channel and for legacy rows without type", () => {
    expect(isGroupDm(regular)).toBe(false);
    expect(isGroupDm(legacyNoType)).toBe(false);
  });
});

describe("visibleChannels", () => {
  it("drops group DMs and keeps regular + legacy channels", () => {
    const out = visibleChannels([regular, groupDm, legacyNoType, hiddenOnly]);
    expect(out.map((c) => c.id)).toEqual(["c1", "c3"]);
  });
});

describe("groupDmChannels", () => {
  it("keeps only the group DMs", () => {
    const out = groupDmChannels([regular, groupDm, legacyNoType, hiddenOnly]);
    expect(out.map((c) => c.id)).toEqual(["c2", "c4"]);
  });

  it("is the exact complement of visibleChannels", () => {
    const all = [regular, groupDm, legacyNoType, hiddenOnly];
    expect(visibleChannels(all).length + groupDmChannels(all).length).toBe(all.length);
  });
});

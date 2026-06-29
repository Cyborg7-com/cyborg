import { describe, it, expect } from "vitest";
import { canCreateAgent, canManageCybo, roleLevel } from "./permissions.js";

const ME = "user-me";
const OTHER = "user-other";

describe("canCreateAgent — relay-authoritative create-agent/cybo rule", () => {
  it("owner and admin may always create (setting irrelevant)", () => {
    for (const allow of [undefined, false, true]) {
      expect(canCreateAgent("owner", allow)).toBe(true);
      expect(canCreateAgent("admin", allow)).toBe(true);
    }
  });

  it("member may create ONLY when allowMemberAgentCreation is true", () => {
    expect(canCreateAgent("member", true)).toBe(true);
    expect(canCreateAgent("member", false)).toBe(false);
    expect(canCreateAgent("member", undefined)).toBe(false);
  });

  it("viewer may never create", () => {
    expect(canCreateAgent("viewer", true)).toBe(false);
    expect(canCreateAgent("viewer", false)).toBe(false);
  });

  it("unknown / null role is denied (level 0)", () => {
    expect(canCreateAgent(null, true)).toBe(false);
    expect(canCreateAgent(undefined, true)).toBe(false);
    expect(canCreateAgent("bogus", true)).toBe(false);
    expect(roleLevel("bogus")).toBe(0);
  });
});

describe("canManageCybo — edit/delete an existing cybo (object-level auth)", () => {
  it("owner/admin may manage ANY cybo (even another member's)", () => {
    expect(canManageCybo("owner", false, OTHER, ME)).toBe(true);
    expect(canManageCybo("admin", false, OTHER, ME)).toBe(true);
    // setting irrelevant for owner/admin
    expect(canManageCybo("admin", undefined, OTHER, ME)).toBe(true);
  });

  it("a member may manage ONLY their OWN cybo, and only when creation is allowed", () => {
    expect(canManageCybo("member", true, ME, ME)).toBe(true); // own + allowed
    expect(canManageCybo("member", true, OTHER, ME)).toBe(false); // teammate's cybo — BOLA blocked
    expect(canManageCybo("member", false, ME, ME)).toBe(false); // own but creation disabled
  });

  it("viewer may never manage a cybo, even their own", () => {
    expect(canManageCybo("viewer", true, ME, ME)).toBe(false);
  });
});

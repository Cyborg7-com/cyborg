import { describe, it, expect } from "vitest";
import {
  scopesForRole,
  roleForScopes,
  normalizeScopes,
  scopesRequireRceConfirm,
  newlyEscalatedRceScopes,
  isDaemonScope,
  SCOPE_META,
} from "./daemon-scopes.js";

// Pure UI mapping tests (#705) — the matrix's preset↔scopes logic + the #35
// confirmation trigger. No DOM, no client.
describe("scopesForRole / roleForScopes — preset round-trip", () => {
  it("each preset maps to its scope bundle", () => {
    expect(scopesForRole("viewer")).toEqual(["chat"]);
    expect(scopesForRole("operator")).toEqual(["chat", "spawn"]);
    expect(scopesForRole("admin")).toEqual(["admin"]);
  });

  it("classifies a stored set back to a role (order-insensitive)", () => {
    expect(roleForScopes(["chat"])).toBe("viewer");
    expect(roleForScopes(["spawn", "chat"])).toBe("operator");
    expect(roleForScopes(["admin"])).toBe("admin");
    expect(roleForScopes(["admin", "chat", "terminal"])).toBe("admin"); // superset wins
  });

  it("non-preset combos are custom", () => {
    expect(roleForScopes(["chat", "terminal"])).toBe("custom");
    expect(roleForScopes(["spawn"])).toBe("custom");
    expect(roleForScopes(["terminal"])).toBe("custom");
  });

  it("null/empty (legacy) → admin", () => {
    expect(roleForScopes(null)).toBe("admin");
    expect(roleForScopes([])).toBe("admin");
  });
});

describe("normalizeScopes — back-compat fail-safe to admin", () => {
  it("null/empty/all-invalid → admin", () => {
    expect(normalizeScopes(null)).toEqual(["admin"]);
    expect(normalizeScopes([])).toEqual(["admin"]);
    expect(normalizeScopes(["nope"])).toEqual(["admin"]);
  });
  it("keeps valid scopes, drops unknown", () => {
    expect(normalizeScopes(["chat", "bogus", "spawn"]).sort()).toEqual(["chat", "spawn"]);
  });
});

describe("#35 RCE confirmation triggers", () => {
  it("terminal and admin are RCE scopes; chat and spawn are not", () => {
    expect(SCOPE_META.terminal.rce).toBe(true);
    expect(SCOPE_META.admin.rce).toBe(true);
    expect(SCOPE_META.chat.rce).toBe(false);
    expect(SCOPE_META.spawn.rce).toBe(false);
  });

  it("scopesRequireRceConfirm is true iff terminal/admin present", () => {
    expect(scopesRequireRceConfirm(["chat"])).toBe(false);
    expect(scopesRequireRceConfirm(["chat", "spawn"])).toBe(false);
    expect(scopesRequireRceConfirm(["chat", "spawn", "terminal"])).toBe(true);
    expect(scopesRequireRceConfirm(["admin"])).toBe(true);
  });

  it("newlyEscalatedRceScopes flags only NEWLY-added RCE scopes", () => {
    // chat → operator: no RCE introduced.
    expect(newlyEscalatedRceScopes(["chat"], ["chat", "spawn"])).toEqual([]);
    // operator → +terminal: terminal is newly escalated → confirm.
    expect(newlyEscalatedRceScopes(["chat", "spawn"], ["chat", "spawn", "terminal"])).toEqual([
      "terminal",
    ]);
    // operator → admin: admin newly escalated → confirm.
    expect(newlyEscalatedRceScopes(["chat", "spawn"], ["admin"])).toEqual(["admin"]);
    // already had terminal, keep it: NOT newly escalated (no re-confirm).
    expect(newlyEscalatedRceScopes(["chat", "spawn", "terminal"], ["chat", "terminal"])).toEqual(
      [],
    );
    // de-escalate admin → operator: no new RCE.
    expect(newlyEscalatedRceScopes(["admin"], ["chat", "spawn"])).toEqual([]);
  });
});

describe("isDaemonScope guard", () => {
  it("accepts the 4 scopes only", () => {
    for (const s of ["chat", "spawn", "terminal", "admin"]) expect(isDaemonScope(s)).toBe(true);
    for (const s of ["owner", "", null, 1]) expect(isDaemonScope(s)).toBe(false);
  });
});

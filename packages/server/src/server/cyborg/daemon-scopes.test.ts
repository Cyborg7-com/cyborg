import { describe, it, expect } from "vitest";
import {
  scopeForType,
  isScopeAllowed,
  allowType,
  normalizeScopes,
  scopesForRole,
  roleForScopes,
  isDaemonScope,
  type DaemonScope,
} from "./daemon-scopes.js";

function set(...s: DaemonScope[]): Set<DaemonScope> {
  return new Set(s);
}

// CLI-first gate (#705): these are pure, no DB. They lock the type→scope mapping
// for all 5 relay sets and the allow logic, so the relay gate can be trusted
// before any UI exists.
describe("scopeForType — maps each relay action set to its required scope", () => {
  it("chat: prompting/messaging existing agents + read-only forwards", () => {
    // DAEMON_FORWARD_TYPES remainder (anything not claimed by a privileged set).
    for (const t of [
      "cyborg:list_agents",
      "cyborg:list_providers",
      "cyborg:fetch_agent_state",
      "cyborg:fetch_agent_timeline",
      "cyborg:list_commands",
      "cyborg:fetch_cybos",
      "cyborg:get_pairing_info",
      "cyborg:list_archived_sessions",
    ]) {
      expect(scopeForType(t)).toBe("chat");
    }
  });

  it("spawn: create_agent, spawn_cybo, slash_command, schedule CRUD, agent-control", () => {
    for (const t of [
      "cyborg:create_agent",
      "cyborg:spawn_cybo",
      "cyborg:slash_command",
      "cyborg:create_schedule",
      "cyborg:update_schedule",
      "cyborg:set_schedule_enabled",
      "cyborg:delete_schedule",
      "cyborg:run_schedule_once",
      // DAEMON_AGENT_CONTROL_TYPES fold into spawn
      "cyborg:set_agent_model",
      "cyborg:set_agent_mode",
      "cyborg:set_agent_thinking",
      "cyborg:rewind_agent",
      "cyborg:archive_agent",
      "cyborg:restore_session",
      // import_session resumes a NEW live agent (a spawn) — same scope as restore.
      "cyborg:import_session",
      // Built-in integrations (recipes) provision/destroy daemon-owned cybos +
      // schedules + channel memberships — same authority tier as schedule CRUD.
      "cyborg:enable_recipe",
      "cyborg:disable_recipe",
      "cyborg:add_cybo_to_channel",
      "cyborg:remove_cybo_from_channel",
    ]) {
      expect(scopeForType(t)).toBe("spawn");
    }
  });

  it("terminal: terminal control ops + start_terminal", () => {
    for (const t of [
      "cyborg:terminal_input",
      "cyborg:terminal_resize",
      "cyborg:kill_terminal",
      "cyborg:start_terminal",
    ]) {
      expect(scopeForType(t)).toBe("terminal");
    }
  });

  it("admin: host control (update_daemon / RCE) — matches DAEMON_HOST_CONTROL_TYPES", () => {
    expect(scopeForType("cyborg:update_daemon")).toBe("admin");
    // daemon_update_latest is a read-only version probe the relay forwards
    // ungated → maps to chat, NOT admin (mirrors the relay's actual enforcement).
    expect(scopeForType("cyborg:daemon_update_latest")).toBe("chat");
  });

  it("admin: provider-credential RPCs (internal docs) require `admin`", () => {
    expect(scopeForType("cyborg:set_cybo_credential")).toBe("admin");
    expect(scopeForType("cyborg:remove_cybo_credential")).toBe("admin");
    expect(scopeForType("cyborg:list_provider_auth")).toBe("admin");
  });

  it("admin: daemon-owner session audit (#993) requires `admin`", () => {
    // Listing every user's sessions (incl. ephemeral) on a host is host-control
    // tier — the relay gate uses exactly this mapping to reject a non-admin guest
    // before forwarding to any daemon.
    expect(scopeForType("cyborg:list_daemon_sessions")).toBe("admin");
    const nonAdmin = [set("chat"), set("spawn"), set("terminal")];
    for (const scopes of nonAdmin) {
      expect(isScopeAllowed(scopes, scopeForType("cyborg:list_daemon_sessions"))).toBe(false);
    }
    expect(isScopeAllowed(set("admin"), scopeForType("cyborg:list_daemon_sessions"))).toBe(true);
  });

  it("RECLASSIFICATION (#705): start_terminal requires `terminal`, NOT `spawn`", () => {
    // The single most security-relevant assertion: a spawn-only user must not be
    // able to open a shell. start_terminal used to live in DAEMON_SPAWN_TYPES.
    expect(scopeForType("cyborg:start_terminal")).toBe("terminal");
    expect(scopeForType("cyborg:start_terminal")).not.toBe("spawn");
  });

  it("unknown / unmapped types fall through to chat (least privilege forward)", () => {
    expect(scopeForType("cyborg:list_recent_cwds")).toBe("chat");
    expect(scopeForType("cyborg:totally_unknown")).toBe("chat");
  });
});

describe("isScopeAllowed — admin is a superset; otherwise exact scope required", () => {
  it("admin scope allows every required scope", () => {
    const admin = set("admin");
    for (const req of ["chat", "spawn", "terminal", "admin"] as DaemonScope[]) {
      expect(isScopeAllowed(admin, req)).toBe(true);
    }
  });

  it("chat-only canNOT spawn, open a terminal, or do host control", () => {
    const chat = set("chat");
    expect(isScopeAllowed(chat, "chat")).toBe(true);
    expect(isScopeAllowed(chat, "spawn")).toBe(false);
    expect(isScopeAllowed(chat, "terminal")).toBe(false);
    expect(isScopeAllowed(chat, "admin")).toBe(false);
  });

  it("spawn-only canNOT open a terminal or do host control", () => {
    const spawn = set("chat", "spawn");
    expect(isScopeAllowed(spawn, "spawn")).toBe(true);
    expect(isScopeAllowed(spawn, "terminal")).toBe(false);
    expect(isScopeAllowed(spawn, "admin")).toBe(false);
  });

  it("terminal scope does NOT imply admin (host control)", () => {
    const term = set("chat", "spawn", "terminal");
    expect(isScopeAllowed(term, "terminal")).toBe(true);
    expect(isScopeAllowed(term, "admin")).toBe(false);
  });

  it("empty scope set allows nothing", () => {
    const none = set();
    for (const req of ["chat", "spawn", "terminal", "admin"] as DaemonScope[]) {
      expect(isScopeAllowed(none, req)).toBe(false);
    }
  });
});

describe("allowType — end-to-end gate decision (mapping + allow)", () => {
  it("chat-only: can prompt agents, cannot create/spawn/terminal/update", () => {
    const chat = set("chat");
    expect(allowType(chat, "cyborg:list_agents")).toBe(true);
    expect(allowType(chat, "cyborg:create_agent")).toBe(false);
    expect(allowType(chat, "cyborg:start_terminal")).toBe(false);
    expect(allowType(chat, "cyborg:terminal_input")).toBe(false);
    expect(allowType(chat, "cyborg:update_daemon")).toBe(false);
  });

  it("operator (chat+spawn): can spawn but cannot open a terminal or update host", () => {
    const op = set("chat", "spawn");
    expect(allowType(op, "cyborg:create_agent")).toBe(true);
    expect(allowType(op, "cyborg:run_schedule_once")).toBe(true);
    expect(allowType(op, "cyborg:set_agent_model")).toBe(true);
    expect(allowType(op, "cyborg:start_terminal")).toBe(false);
    expect(allowType(op, "cyborg:kill_terminal")).toBe(false);
    expect(allowType(op, "cyborg:update_daemon")).toBe(false);
  });

  it("terminal role (chat+spawn+terminal): can open/control terminal, not update host", () => {
    const t = set("chat", "spawn", "terminal");
    expect(allowType(t, "cyborg:start_terminal")).toBe(true);
    expect(allowType(t, "cyborg:terminal_input")).toBe(true);
    expect(allowType(t, "cyborg:create_agent")).toBe(true);
    expect(allowType(t, "cyborg:update_daemon")).toBe(false);
  });

  it("admin/owner: can do everything", () => {
    const admin = set("admin");
    for (const t of [
      "cyborg:list_agents",
      "cyborg:create_agent",
      "cyborg:start_terminal",
      "cyborg:terminal_input",
      "cyborg:update_daemon",
    ]) {
      expect(allowType(admin, t)).toBe(true);
    }
  });
});

describe("normalizeScopes — back-compat fail-safe to admin", () => {
  it("null/undefined (old relay, missing column) → admin", () => {
    expect([...normalizeScopes(null)]).toEqual(["admin"]);
    expect([...normalizeScopes(undefined)]).toEqual(["admin"]);
  });

  it("empty array → admin (a no-access row never exists; empty means legacy)", () => {
    expect([...normalizeScopes([])]).toEqual(["admin"]);
  });

  it("keeps valid scopes and drops unknown strings", () => {
    expect([...normalizeScopes(["chat", "spawn"])].sort()).toEqual(["chat", "spawn"]);
    expect([...normalizeScopes(["chat", "bogus", "terminal"])].sort()).toEqual([
      "chat",
      "terminal",
    ]);
  });

  it("a row that only had unknown scopes degrades to admin (fail-safe, never open)", () => {
    expect([...normalizeScopes(["bogus", "nope"])]).toEqual(["admin"]);
  });
});

describe("isDaemonScope — guard", () => {
  it("accepts the 4 scopes, rejects everything else", () => {
    for (const s of ["chat", "spawn", "terminal", "admin"]) expect(isDaemonScope(s)).toBe(true);
    for (const s of ["", "owner", "host", "viewer", null, undefined, 1, {}])
      expect(isDaemonScope(s)).toBe(false);
  });
});

describe("role presets (#705 UX) — preset↔scopes round-trip", () => {
  it("scopesForRole maps each role to its bundle", () => {
    expect(scopesForRole("viewer")).toEqual(["chat"]);
    expect(scopesForRole("operator")).toEqual(["chat", "spawn"]);
    expect(scopesForRole("admin")).toEqual(["admin"]);
  });

  it("roleForScopes classifies a stored set back to a role", () => {
    expect(roleForScopes(["chat"])).toBe("viewer");
    expect(roleForScopes(["chat", "spawn"])).toBe("operator");
    expect(roleForScopes(["spawn", "chat"])).toBe("operator"); // order-insensitive
    expect(roleForScopes(["admin"])).toBe("admin");
    // legacy/null → admin (matches normalizeScopes fail-safe)
    expect(roleForScopes(null)).toBe("admin");
    expect(roleForScopes([])).toBe("admin");
  });

  it("a non-preset combo is `custom`", () => {
    expect(roleForScopes(["chat", "terminal"])).toBe("custom"); // skips spawn
    expect(roleForScopes(["spawn"])).toBe("custom"); // chat omitted
    expect(roleForScopes(["terminal"])).toBe("custom");
  });

  it("any set that includes admin collapses to admin (superset wins)", () => {
    expect(roleForScopes(["admin", "chat"])).toBe("admin");
    expect(roleForScopes(["chat", "spawn", "terminal", "admin"])).toBe("admin");
  });
});

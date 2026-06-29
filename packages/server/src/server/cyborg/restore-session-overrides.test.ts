import { describe, it, expect } from "vitest";
import {
  CyborgRestoreSessionRequestSchema,
  CyborgResumeOverridesSchema,
  CyborgListArchivedSessionsResponseSchema,
} from "./cyborg-messages.js";
import { scopeForType, isScopeAllowed, allowType } from "./daemon-scopes.js";
import {
  buildResumeOverrides,
  hasResumeConfigOverrides,
  type RestoreSessionOverrides,
} from "./resume-overrides.js";

// #593: restoring an archived session can carry optional model/mode/thinking
// overrides so the resumed agent boots on the chosen config instead of the
// archived one. These lock (a) the extended protocol shape + back-compat, (b)
// the gate is still `spawn` (no auth weakening), and (c) the pure override-merge.

describe("CyborgRestoreSessionRequestSchema — optional overrides (#593)", () => {
  const base = {
    type: "cyborg:restore_session" as const,
    requestId: "req-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
  };

  it("BACK-COMPAT: parses the legacy shape with NO daemonId and NO overrides", () => {
    const parsed = CyborgRestoreSessionRequestSchema.parse(base);
    expect(parsed.overrides).toBeUndefined();
    expect(parsed.daemonId).toBeUndefined();
    expect(parsed).toMatchObject({ sessionId: "sess-1", workspaceId: "ws-1" });
  });

  it("accepts a full override set + daemonId", () => {
    const parsed = CyborgRestoreSessionRequestSchema.parse({
      ...base,
      daemonId: "daemon-7",
      overrides: { model: "claude-opus-4", modeId: "bypassPermissions", thinkingOptionId: "high" },
    });
    expect(parsed.daemonId).toBe("daemon-7");
    expect(parsed.overrides).toEqual({
      model: "claude-opus-4",
      modeId: "bypassPermissions",
      thinkingOptionId: "high",
    });
  });

  it("accepts a PARTIAL override (model only)", () => {
    const parsed = CyborgRestoreSessionRequestSchema.parse({
      ...base,
      overrides: { model: "claude-haiku-4" },
    });
    expect(parsed.overrides).toEqual({ model: "claude-haiku-4" });
  });

  it("accepts a null thinkingOptionId (disable thinking on resume)", () => {
    const parsed = CyborgRestoreSessionRequestSchema.parse({
      ...base,
      overrides: { thinkingOptionId: null },
    });
    expect(parsed.overrides).toEqual({ thinkingOptionId: null });
  });

  it("accepts an EMPTY overrides object (resumes as archived)", () => {
    const parsed = CyborgRestoreSessionRequestSchema.parse({ ...base, overrides: {} });
    expect(parsed.overrides).toEqual({});
  });

  it("rejects a non-string model override (no `any` slipping through)", () => {
    expect(() =>
      CyborgRestoreSessionRequestSchema.parse({ ...base, overrides: { model: 123 } }),
    ).toThrow();
  });
});

describe("CyborgResumeOverridesSchema — standalone shape", () => {
  it("is fully optional (the empty object parses)", () => {
    expect(CyborgResumeOverridesSchema.parse({})).toEqual({});
  });

  it("strips nothing it knows and keeps the three documented fields", () => {
    const v = { model: "m", modeId: "default", thinkingOptionId: "low" };
    expect(CyborgResumeOverridesSchema.parse(v)).toEqual(v);
  });
});

describe("CyborgListArchivedSessionsResponseSchema — optional owning daemonId (#593)", () => {
  const session = {
    id: "s1",
    provider: "claude",
    providerHandleId: "h1",
    title: null,
    cwd: null,
    model: null,
    cyboId: null,
    archivedAt: 1,
  };

  it("BACK-COMPAT: a session WITHOUT daemonId still parses", () => {
    const parsed = CyborgListArchivedSessionsResponseSchema.parse({
      type: "cyborg:list_archived_sessions_response",
      payload: { requestId: "r", sessions: [session] },
    });
    expect(parsed.payload.sessions[0].daemonId).toBeUndefined();
  });

  it("carries a stamped daemonId when present", () => {
    const parsed = CyborgListArchivedSessionsResponseSchema.parse({
      type: "cyborg:list_archived_sessions_response",
      payload: { requestId: "r", sessions: [{ ...session, daemonId: "daemon-7" }] },
    });
    expect(parsed.payload.sessions[0].daemonId).toBe("daemon-7");
  });
});

describe("restore_session gate is unchanged: requires `spawn` (no auth weakening, #705)", () => {
  it("restore_session maps to the `spawn` scope (same as archive/rewind/set_model)", () => {
    expect(scopeForType("cyborg:restore_session")).toBe("spawn");
    // Symmetric with the other agent-control ops it shares the gate with.
    expect(scopeForType("cyborg:archive_agent")).toBe("spawn");
    expect(scopeForType("cyborg:rewind_agent")).toBe("spawn");
  });

  it("chat-only canNOT restore; operator/admin CAN (threading overrides changes nothing here)", () => {
    expect(allowType(new Set(["chat"]), "cyborg:restore_session")).toBe(false);
    expect(allowType(new Set(["chat", "spawn"]), "cyborg:restore_session")).toBe(true);
    expect(allowType(new Set(["admin"]), "cyborg:restore_session")).toBe(true);
    // The decision is exactly isScopeAllowed(scopes, "spawn").
    expect(isScopeAllowed(new Set(["spawn"]), scopeForType("cyborg:restore_session"))).toBe(true);
  });
});

describe("buildResumeOverrides / hasResumeConfigOverrides — pure merge (#593)", () => {
  it("no overrides + a cwd ⇒ ONLY the cwd pin (legacy resume), and NOT a config override", () => {
    expect(buildResumeOverrides({ cwd: "/repo" })).toEqual({ cwd: "/repo" });
    expect(hasResumeConfigOverrides(undefined)).toBe(false);
    expect(hasResumeConfigOverrides({})).toBe(false);
  });

  it("no overrides + no cwd ⇒ empty (nothing forwarded)", () => {
    expect(buildResumeOverrides({})).toEqual({});
  });

  it("merges only the SET fields alongside the cwd pin", () => {
    expect(buildResumeOverrides({ cwd: "/repo", overrides: { model: "claude-opus-4" } })).toEqual({
      cwd: "/repo",
      model: "claude-opus-4",
    });
    expect(buildResumeOverrides({ overrides: { modeId: "default" } })).toEqual({
      modeId: "default",
    });
  });

  it("drops an explicit null thinkingOptionId to undefined (stays AgentSessionConfig-assignable)", () => {
    const merged = buildResumeOverrides({ overrides: { thinkingOptionId: null } });
    expect(merged.thinkingOptionId).toBeUndefined();
    expect("thinkingOptionId" in merged).toBe(false);
  });

  it("keeps a real thinkingOptionId", () => {
    expect(buildResumeOverrides({ overrides: { thinkingOptionId: "high" } })).toEqual({
      thinkingOptionId: "high",
    });
  });

  it("hasResumeConfigOverrides is true iff a field the resume APPLIES is set", () => {
    const cases: [RestoreSessionOverrides | undefined, boolean][] = [
      [undefined, false],
      [{}, false],
      [{ model: "m" }, true],
      [{ modeId: "default" }, true],
      [{ thinkingOptionId: "low" }, true],
      // null thinking can't be forwarded (AgentSessionConfig has no null), so it's
      // "no change" — kept in lockstep with buildResumeOverrides dropping it.
      [{ thinkingOptionId: null }, false],
    ];
    for (const [input, expected] of cases) {
      expect(hasResumeConfigOverrides(input)).toBe(expected);
    }
  });
});

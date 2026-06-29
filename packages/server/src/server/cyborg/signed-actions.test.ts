import { afterEach, describe, expect, it } from "vitest";
import {
  getActionHandler,
  registerActionKind,
  signAction,
  unregisterActionKind,
  verifyAction,
  type SignedActionPayload,
} from "./signed-actions.js";

const SECRET = "test-secret-not-the-dev-default";
const NOW = 1_700_000_000; // fixed clock — no Date.now() flakiness

function makePayload(over: Partial<SignedActionPayload> = {}): SignedActionPayload {
  return {
    v: 1,
    k: "agent_permission",
    mid: "msg_1",
    aid: "approve",
    act: "user_alice",
    exp: NOW + 3600,
    p: { agentId: "a1", requestId: "r1", behavior: "allow" },
    ...over,
  };
}

describe("signAction / verifyAction (#600)", () => {
  it("round-trips a valid token for the bound actor", () => {
    const token = signAction(makePayload(), SECRET);
    const out = verifyAction(token, { now: NOW, expectActor: "user_alice", secret: SECRET });
    expect(out).not.toBeNull();
    expect(out!.k).toBe("agent_permission");
    expect(out!.p).toEqual({ agentId: "a1", requestId: "r1", behavior: "allow" });
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const token = signAction(makePayload(), SECRET);
    const [body, sig] = token.split(".");
    // Flip the last base64url char of the body.
    const flipped = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
    expect(
      verifyAction(`${flipped}.${sig}`, { now: NOW, expectActor: "user_alice", secret: SECRET }),
    ).toBeNull();
  });

  it("rejects a token signed with a different secret (forgery)", () => {
    const token = signAction(makePayload(), "attacker-secret");
    expect(verifyAction(token, { now: NOW, expectActor: "user_alice", secret: SECRET })).toBeNull();
  });

  it("rejects an expired token (exp <= now)", () => {
    const token = signAction(makePayload({ exp: NOW - 1 }), SECRET);
    expect(verifyAction(token, { now: NOW, expectActor: "user_alice", secret: SECRET })).toBeNull();
    // exp exactly == now is also rejected (no last-second window).
    const exact = signAction(makePayload({ exp: NOW }), SECRET);
    expect(verifyAction(exact, { now: NOW, expectActor: "user_alice", secret: SECRET })).toBeNull();
  });

  it("rejects when the caller is not the bound actor", () => {
    const token = signAction(makePayload({ act: "user_alice" }), SECRET);
    expect(verifyAction(token, { now: NOW, expectActor: "user_bob", secret: SECRET })).toBeNull();
  });

  it("rejects malformed / garbage tokens defensively", () => {
    const opts = { now: NOW, expectActor: "user_alice", secret: SECRET };
    expect(verifyAction("", opts)).toBeNull();
    expect(verifyAction("only-one-part", opts)).toBeNull();
    expect(verifyAction("a.b.c", opts)).toBeNull(); // 3 parts (a JWT, not ours)
    expect(verifyAction("$$$.%%%", opts)).toBeNull();
    // Well-signed but structurally invalid payload (missing fields) → null.
    const bad = signAction({ ...makePayload(), act: "" } as SignedActionPayload, SECRET);
    expect(verifyAction(bad, opts)).toBeNull();
  });

  it("a token with v != 1 is rejected", () => {
    const bad = signAction({ ...makePayload(), v: 2 as unknown as 1 }, SECRET);
    expect(verifyAction(bad, { now: NOW, expectActor: "user_alice", secret: SECRET })).toBeNull();
  });
});

describe("action-kind registry", () => {
  afterEach(() => unregisterActionKind("test_kind"));

  it("register → getActionHandler returns the handler; unknown kind is undefined", () => {
    expect(getActionHandler("test_kind")).toBeUndefined();
    const handler = async () => ({ ok: true });
    registerActionKind("test_kind", handler);
    expect(getActionHandler("test_kind")).toBe(handler);
    unregisterActionKind("test_kind");
    expect(getActionHandler("test_kind")).toBeUndefined();
  });
});

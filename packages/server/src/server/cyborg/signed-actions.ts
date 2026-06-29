// Signed interactive message actions (#600, PR1 — the primitive).
//
// A card button carries an opaque token the client echoes back verbatim; the
// server verifies it before executing. The token binds the action to a specific
// message, button, ACTOR, and expiry — so it can't be forged, tampered, replayed
// past expiry, invoked by anyone but the bound actor, or pasted onto a different
// button. Mirrors the JWT primitives in auth.ts (HMAC-SHA256 over the SAME
// CYBORG7_JWT_SECRET + timing-safe compare); deliberately HMAC (integrity, not
// secrecy — the client already knows agentId/requestId) and symmetric (one
// trusted server boundary per mode, no third-party verifier).
import { createHmac } from "node:crypto";
import { resolveCyborgJwtSecret, timingSafeEqualStr } from "./auth.js";
import type { MessageCard } from "./webhook-card.js";

export interface SignedActionPayload {
  v: 1; // schema version
  k: string; // action kind — registry key (e.g. "agent_permission")
  mid: string; // message id the button lives on
  aid: string; // action/button id
  act: string; // the ONLY userId allowed to invoke (server-bound actor lock)
  exp: number; // expiry, unix SECONDS
  p: Record<string, unknown>; // kind-specific payload (opaque to the envelope)
}

// Per-kind token lifetime. Approval cards live 1h (the design's default); the
// future webhook-button kind (#598) will use a shorter window.
export const ACTION_KIND_TTL_SEC: Record<string, number> = {
  agent_permission: 60 * 60,
};
export const DEFAULT_ACTION_TTL_SEC = 60 * 60;

function b64urlEncode(s: string): string {
  return Buffer.from(s).toString("base64url");
}
function b64urlDecode(s: string): string {
  return Buffer.from(s, "base64url").toString("utf-8");
}

// token = base64url(JSON(payload)) "." base64url(HMAC_SHA256(secret, part1)).
// Two parts, no JWT header (this isn't a JWT — it's a self-describing action
// envelope verified only by us).
export function signAction(payload: SignedActionPayload, secret?: string): string {
  const key = secret ?? resolveCyborgJwtSecret();
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

// Defensive structural parse — NEVER trust the decoded JSON shape. A field of
// the wrong type makes the whole token invalid (returns null), so downstream
// code can rely on the typed payload.
function parsePayload(json: string): SignedActionPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.k !== "string" || o.k.length === 0) return null;
  if (typeof o.mid !== "string" || typeof o.aid !== "string") return null;
  if (typeof o.act !== "string" || o.act.length === 0) return null;
  if (typeof o.exp !== "number" || !Number.isFinite(o.exp)) return null;
  // typeof [] is "object" too — require a plain object so an array `p` can't slip through.
  if (!o.p || typeof o.p !== "object" || Array.isArray(o.p)) return null;
  return {
    v: 1,
    k: o.k,
    mid: o.mid,
    aid: o.aid,
    act: o.act,
    exp: o.exp,
    p: o.p as Record<string, unknown>,
  };
}

export interface VerifyActionOptions {
  // Unix SECONDS — injected (never Date.now() here) so callers control the clock
  // and tests are deterministic.
  now: number;
  // The authenticated caller. The token's `act` must equal this exactly — ONE
  // check covers forgery + tamper + wrong-actor + expiry.
  expectActor: string;
  secret?: string;
}

// Returns the validated payload, or null for ANY failure (bad signature,
// tamper, malformed, expired, wrong actor). A single null-or-payload contract
// keeps the call sites simple and fail-closed.
export function verifyAction(token: string, opts: VerifyActionOptions): SignedActionPayload | null {
  const key = opts.secret ?? resolveCyborgJwtSecret();
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac("sha256", key).update(body).digest("base64url");
  if (!timingSafeEqualStr(expected, sig)) return null;
  const payload = parsePayload(b64urlDecode(body));
  if (!payload) return null;
  if (payload.exp <= opts.now) return null; // expired (also rejects exp===now)
  if (payload.act !== opts.expectActor) return null; // actor lock
  return payload;
}

// ─── Action-kind registry ───────────────────────────────────────────────────
// Each kind owns its side effect (e.g. resolving a Paseo permission) and returns
// the resolved card to broadcast. The dual-routed handler (dispatcher + relay)
// verifies the token, then dispatches here by `payload.k`. Handlers are
// registered by the consumer feature (PR2 registers "agent_permission") so this
// primitive carries no consumer-specific logic.

export interface ActionContext {
  actorId: string;
  workspaceId: string;
  messageId: string;
  // Consumer-specific collaborators are injected per call (the dispatcher and
  // relay wire different resolvers for the same kind). Kept loose on purpose —
  // each handler reads what it needs.
  deps: Record<string, unknown>;
}

export interface ActionOutcome {
  ok: boolean;
  error?: string;
  // When present, the handler resolved the card — broadcast it (buttons cleared,
  // resolution set) so every client re-renders the settled state.
  card?: MessageCard;
}

export type ActionHandler = (
  payload: SignedActionPayload,
  ctx: ActionContext,
) => Promise<ActionOutcome>;

const registry = new Map<string, ActionHandler>();

export function registerActionKind(kind: string, handler: ActionHandler): void {
  registry.set(kind, handler);
}

export function getActionHandler(kind: string): ActionHandler | undefined {
  return registry.get(kind);
}

// Test-only: drop a registration so suites don't leak handlers into each other.
export function unregisterActionKind(kind: string): void {
  registry.delete(kind);
}

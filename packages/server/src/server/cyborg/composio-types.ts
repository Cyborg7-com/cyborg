// Composio third-party tool integration for cybos — the shared contract.
//
// THE OWNERSHIP MODEL (knowledge: composio-ownership-and-permissions):
// A cybo belongs to the WORKSPACE; a Composio OAuth account is PERSONAL. To keep
// those from leaking into each other we split CAPABILITY from IDENTITY:
//   • Capability  — which toolkits/actions the cybo MAY use + approval policy.
//                   Workspace-owned, lives on the cybo (`tool_grants`), admin-set.
//                   Carries NO credentials.
//   • Identity    — whose account a run acts AS. Bound at RUN time per `binding`:
//                   `caller`  → the invoking human's own connection (default; safe
//                               for personal accounts; never another user's).
//                   `service` → a shared workspace-owned connection (opt-in; admin
//                               connects once; required for autonomous runs).
// The cybo is a capability TEMPLATE; the auth binds to an identity at spawn time.

import { z } from "zod";

// ─── Binding mode ───────────────────────────────────────────────────
// Who the cybo acts AS for a given toolkit.
export const COMPOSIO_BINDINGS = ["caller", "service"] as const;
export type ComposioBinding = (typeof COMPOSIO_BINDINGS)[number];

// ─── Per-cybo capability grant (workspace-owned, admin-set) ─────────
// One toolkit the cybo may use. NO credentials here — the auth binds at run time.
export const ComposioToolGrantSchema = z.object({
  toolkit: z.string().min(1), // "gmail" | "slack" | "github" | …
  binding: z.enum(COMPOSIO_BINDINGS).default("caller"),
  // Allow-list of Composio action slugs (e.g. "GMAIL_FETCH_EMAILS"). The ENFORCED
  // capability: only these are ever exposed. Empty ⇒ the grant does nothing.
  allowedActions: z.array(z.string()).default([]),
  // Subset of allowedActions that needs a human approval card before executing
  // (Tier-2). These are NOT placed in the always-on MCP URL — they route through a
  // mediated proxy tool so approval doesn't depend on the provider honoring it.
  requireApproval: z.array(z.string()).default([]),
});
export type ComposioToolGrant = z.infer<typeof ComposioToolGrantSchema>;

// The full `tool_grants` blob persisted on a cybo (room for non-Composio providers later).
export const CyboToolGrantsSchema = z.object({
  composio: z.array(ComposioToolGrantSchema).default([]),
});
export type CyboToolGrants = z.infer<typeof CyboToolGrantsSchema>;

// ─── Connection ownership ───────────────────────────────────────────
// A connected account = an OAuth'd identity for one toolkit. The Composio
// `connectedAccountId` references tokens that live in COMPOSIO's vault — we store
// only the reference + who owns it, never the tokens themselves.
export type ConnectionOwnerKind = "user" | "service";

export interface ComposioConnection {
  workspaceId: string;
  // user   → a personal account (ownerId = userId), used by `caller` bindings.
  // service→ a shared account (ownerId = workspaceId), used by `service` bindings.
  ownerKind: ConnectionOwnerKind;
  ownerId: string;
  toolkit: string;
  connectedAccountId: string;
  status: "active" | "pending" | "expired";
  createdAt: number;
}

// ─── Composio "entity" (the per-identity scope key) ─────────────────
// Composio scopes connections + MCP URLs by an opaque `user_id` it calls the
// entity. We derive it deterministically so the same identity always maps to the
// same entity. Identity is per (USER × WORKSPACE) for `caller` (DECIDED) — a user's
// Gmail connected in workspace A must NOT carry into workspace B — and per WORKSPACE
// for a `service` account. Namespaced (`u:`/`ws:`) to avoid id collisions.
export function composioEntityId(
  ownerKind: ConnectionOwnerKind,
  ownerId: string,
  workspaceId: string,
): string {
  // caller: ownerId = userId, scoped to the workspace. service: ownerId = workspaceId.
  return ownerKind === "user" ? `u:${workspaceId}:${ownerId}` : `ws:${workspaceId}`;
}

// ─── Adapter to Composio (the ONLY surface that talks to Composio) ──
// Real impl = a thin HTTP wrapper over Composio's Platform API; tests use a fake.
// Isolating it here means a Composio API change touches exactly one file.
export interface ComposioClient {
  // Hosted OAuth (Composio-managed): returns a redirect URL the user opens to
  // authorize `toolkit` for `entity`. (`connectedAccounts.link` — `initiate()` is
  // retired for managed OAuth as of 2026-07-03.)
  startLink(input: {
    entity: string;
    toolkit: string;
  }): Promise<{ redirectUrl: string; connectionRequestId: string }>;
  // After the user authorizes, resolve the request → the connected account ref.
  resolveConnection(input: {
    connectionRequestId: string;
  }): Promise<{ connectedAccountId: string; status: "active" | "pending" | "expired" }>;
  // Mint a per-entity MCP URL scoped to EXACTLY `allowedActions` (`mcp.create` +
  // `allowed_tools` + `mcp.generate(user_id=entity)`). This is the enforcement point.
  mintScopedMcpUrl(input: {
    entity: string;
    toolkit: string;
    allowedActions: string[];
  }): Promise<{ url: string; headers: Record<string, string> }>;
  // Execute one action directly (Tier-2 writes, AFTER human approval) — bypasses
  // the MCP so an approval-gated action is never directly callable by the agent.
  executeAction(input: {
    entity: string;
    action: string;
    args: unknown;
  }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

// ─── Run context (what binding resolution needs) ────────────────────
export interface ComposioRunContext {
  workspaceId: string;
  cyboId: string;
  // The human who invoked this run (mention author / DM sender). NULL for an
  // AUTONOMOUS run (scheduled / webhook) — there is no human identity to bind a
  // `caller` toolkit to, so caller-bound toolkits are unavailable in that case.
  invokerUserId: string | null;
  // Injected pure lookup: is there an ACTIVE connection for this owner+toolkit?
  hasConnection: (q: {
    ownerKind: ConnectionOwnerKind;
    ownerId: string;
    toolkit: string;
  }) => boolean;
}

// ─── Resolution result ──────────────────────────────────────────────
export interface ResolvedToolkit {
  toolkit: string;
  entity: string; // the Composio entity the MCP URL is minted for
  binding: ComposioBinding;
  ownerKind: ConnectionOwnerKind;
  ownerId: string;
  // Allowed AND no-approval → placed directly in the scoped MCP URL.
  directActions: string[];
  // Allowed AND require-approval → exposed only via the mediated proxy tool (Tier-2).
  approvalActions: string[];
}

export type BlockedReason =
  | "no-actions" // grant has an empty allow-list
  | "autonomous-caller" // caller binding but no human invoker (scheduled/webhook)
  | "no-connection"; // no active connection for the resolved owner

export interface BlockedToolkit {
  toolkit: string;
  binding: ComposioBinding;
  reason: BlockedReason;
  remedy: string; // human-facing hint for the readiness overlay / banner
}

export interface ComposioResolution {
  available: ResolvedToolkit[];
  blocked: BlockedToolkit[];
}

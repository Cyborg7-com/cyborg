// In-memory, deterministic ComposioClient for tests.
//
// The fake is what the rest of the system tests against, so it must faithfully honor the
// ComposioClient contract (see composio-types.ts) while staying free of network/IO. It is
// deterministic: the same inputs always produce the same outputs, and `mintScopedMcpUrl`
// encodes the entity + SORTED allowedActions into the URL so tests can assert scoping.

import type { ComposioClient } from "./composio-types.js";

export interface FakeExecuteCall {
  entity: string;
  action: string;
  args: unknown;
}

export interface FakeStartLinkCall {
  entity: string;
  toolkit: string;
}

type ConnectionStatus = "active" | "pending" | "expired";

interface FakeConnectionState {
  connectedAccountId: string;
  status: ConnectionStatus;
}

interface FakeExecuteResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class FakeComposioClient implements ComposioClient {
  // Public recordings — tests assert against these.
  readonly startLinkCalls: FakeStartLinkCall[] = [];
  readonly executeCalls: FakeExecuteCall[] = [];
  readonly mintCalls: Array<{ entity: string; toolkit: string; allowedActions: string[] }> = [];

  // Configurable response state.
  private readonly connectionsByRequestId = new Map<string, FakeConnectionState>();
  private defaultResolve: FakeConnectionState = {
    connectedAccountId: "fake-account",
    status: "active",
  };
  private defaultExecuteResult: FakeExecuteResult = { ok: true, result: { ok: true } };
  private executeResultByAction = new Map<string, FakeExecuteResult>();
  private linkCounter = 0;

  // ── Preconfiguration helpers ─────────────────────────────────────

  // Set the default connected-account/status that resolveConnection returns for any
  // request id without a specific override.
  setDefaultConnection(state: { connectedAccountId: string; status: ConnectionStatus }): this {
    this.defaultResolve = { ...state };
    return this;
  }

  // Override resolveConnection for one specific request id.
  setConnectionForRequest(
    connectionRequestId: string,
    state: { connectedAccountId: string; status: ConnectionStatus },
  ): this {
    this.connectionsByRequestId.set(connectionRequestId, { ...state });
    return this;
  }

  // Set the default result executeAction returns for any action without an override.
  setDefaultExecuteResult(result: FakeExecuteResult): this {
    this.defaultExecuteResult = { ...result };
    return this;
  }

  // Override executeAction's result for one specific action slug.
  setExecuteResultForAction(action: string, result: FakeExecuteResult): this {
    this.executeResultByAction.set(action, { ...result });
    return this;
  }

  // ── ComposioClient contract ──────────────────────────────────────

  async startLink(input: {
    entity: string;
    toolkit: string;
  }): Promise<{ redirectUrl: string; connectionRequestId: string }> {
    this.startLinkCalls.push({ entity: input.entity, toolkit: input.toolkit });
    this.linkCounter += 1;
    const connectionRequestId = `req-${input.toolkit}-${input.entity}-${this.linkCounter}`;
    const redirectUrl = `https://fake.composio.test/oauth/${encodeURIComponent(connectionRequestId)}`;
    // Remember the request so resolveConnection has something to resolve, unless a test
    // has already configured a specific override for this id.
    if (!this.connectionsByRequestId.has(connectionRequestId)) {
      this.connectionsByRequestId.set(connectionRequestId, { ...this.defaultResolve });
    }
    return { redirectUrl, connectionRequestId };
  }

  async resolveConnection(input: {
    connectionRequestId: string;
  }): Promise<{ connectedAccountId: string; status: ConnectionStatus }> {
    const state = this.connectionsByRequestId.get(input.connectionRequestId) ?? this.defaultResolve;
    return { connectedAccountId: state.connectedAccountId, status: state.status };
  }

  async mintScopedMcpUrl(input: {
    entity: string;
    toolkit: string;
    allowedActions: string[];
  }): Promise<{ url: string; headers: Record<string, string> }> {
    this.mintCalls.push({
      entity: input.entity,
      toolkit: input.toolkit,
      allowedActions: [...input.allowedActions],
    });
    // Deterministic URL embedding the entity + SORTED allowedActions so tests can assert
    // exactly which actions were scoped, independent of input ordering.
    const sorted = [...input.allowedActions].sort();
    const actions = sorted.map((a) => encodeURIComponent(a)).join(",");
    const url =
      `https://fake.composio.test/mcp/${encodeURIComponent(input.toolkit)}` +
      `?entity=${encodeURIComponent(input.entity)}&actions=${actions}`;
    return { url, headers: { "x-api-key": "fake-mcp-key" } };
  }

  async executeAction(input: {
    entity: string;
    action: string;
    args: unknown;
  }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    this.executeCalls.push({ entity: input.entity, action: input.action, args: input.args });
    const result = this.executeResultByAction.get(input.action) ?? this.defaultExecuteResult;
    return { ...result };
  }
}

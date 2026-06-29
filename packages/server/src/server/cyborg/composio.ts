// HttpComposioClient — the real ComposioClient (internal docs), a thin fetch
// wrapper over the Composio PLATFORM API v3 (https://backend.composio.dev/api/v3,
// header `x-api-key`). Built against the documented v3 shape; the FakeComposioClient
// (composio-fake.ts) is what the test suite exercises, so this concrete client is
// only constructed when COMPOSIO_API_KEY is set (composio-deps.ts).
//
// ⚠️ LIVE-UNVALIDATED: the exact v3 request/response payloads below follow the
// documented Platform-API shapes but have NOT been run against live Composio yet
// (it needs a platform `x-api-key` — the consumer-router `ck_` key is a DIFFERENT
// transport: an MCP meta-tool router at connect.composio.dev/mcp, not these REST
// endpoints). Validate each call against the live API before relying on it.

import type { ComposioClient } from "./composio-types.js";

const DEFAULT_BASE_URL = "https://backend.composio.dev/api/v3";

interface HttpComposioClientOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class HttpComposioClient implements ComposioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpComposioClientOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { _raw: text };
    }
    if (!res.ok) {
      const msg =
        (parsed as { error?: string; message?: string })?.error ??
        (parsed as { message?: string })?.message ??
        `HTTP ${res.status}`;
      throw new Error(`Composio ${method} ${path} failed: ${msg}`);
    }
    return parsed as T;
  }

  // Hosted OAuth: create a connection link the user opens to authorize `toolkit`
  // for `entity` (user_id). `connectedAccounts.link` (initiate() retired 2026-07-03).
  async startLink(input: {
    entity: string;
    toolkit: string;
  }): Promise<{ redirectUrl: string; connectionRequestId: string }> {
    const out = await this.request<{
      redirect_url?: string;
      redirectUrl?: string;
      id?: string;
      connection_request_id?: string;
      connectionRequestId?: string;
    }>("POST", "/connected_accounts/link", {
      user_id: input.entity,
      toolkit: input.toolkit,
    });
    const redirectUrl = out.redirect_url ?? out.redirectUrl ?? "";
    const connectionRequestId =
      out.connection_request_id ?? out.connectionRequestId ?? out.id ?? "";
    if (!redirectUrl || !connectionRequestId) {
      throw new Error("Composio startLink: missing redirect_url / connection id in response");
    }
    return { redirectUrl, connectionRequestId };
  }

  async resolveConnection(input: {
    connectionRequestId: string;
  }): Promise<{ connectedAccountId: string; status: "active" | "pending" | "expired" }> {
    const out = await this.request<{
      id?: string;
      connected_account_id?: string;
      status?: string;
    }>("GET", `/connected_accounts/${encodeURIComponent(input.connectionRequestId)}`);
    const connectedAccountId = out.connected_account_id ?? out.id ?? "";
    const raw = (out.status ?? "").toLowerCase();
    // Normalize Composio's status vocabulary to our 3-state contract.
    let status: "active" | "pending" | "expired";
    if (raw === "active" || raw === "connected") status = "active";
    else if (raw === "expired" || raw === "failed" || raw === "revoked") status = "expired";
    else status = "pending";
    return { connectedAccountId, status };
  }

  // Mint a per-entity, ACTION-scoped MCP URL: create a custom MCP server bound to
  // exactly `allowedActions`, then generate the per-user URL. The URL itself is the
  // Tier-1 enforcement point (a tool that isn't minted doesn't exist for the cybo).
  async mintScopedMcpUrl(input: {
    entity: string;
    toolkit: string;
    allowedActions: string[];
  }): Promise<{ url: string; headers: Record<string, string> }> {
    const created = await this.request<{ id?: string; mcp_id?: string }>("POST", "/mcp", {
      name: `cybo-${input.toolkit}-${input.entity}`,
      toolkits: [input.toolkit],
      allowed_tools: input.allowedActions,
    });
    const mcpId = created.mcp_id ?? created.id;
    if (!mcpId) throw new Error("Composio mintScopedMcpUrl: mcp create returned no id");
    const generated = await this.request<{ mcp_url?: string; url?: string }>(
      "POST",
      `/mcp/${encodeURIComponent(mcpId)}/generate`,
      { user_ids: [input.entity] },
    );
    const url = generated.mcp_url ?? generated.url ?? "";
    if (!url) throw new Error("Composio mintScopedMcpUrl: generate returned no url");
    // The scoped URL is bearer-auth'd by the URL itself; no extra header needed for
    // the daemon→MCP hop, but pass the api key for any server-side mediation.
    return { url, headers: { "x-api-key": this.apiKey } };
  }

  // Direct execution (Tier-2 writes, AFTER human approval) — bypasses the MCP so an
  // approval-gated action is never directly callable by the agent.
  async executeAction(input: {
    entity: string;
    action: string;
    args: unknown;
  }): Promise<{ ok: boolean; result?: unknown; error?: string }> {
    try {
      const out = await this.request<{
        successful?: boolean;
        success?: boolean;
        data?: unknown;
        error?: string;
      }>("POST", `/tools/execute/${encodeURIComponent(input.action)}`, {
        user_id: input.entity,
        arguments: input.args ?? {},
      });
      const ok = out.successful ?? out.success ?? false;
      return ok
        ? { ok: true, result: out.data }
        : { ok: false, error: out.error ?? "execution reported not successful" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// Consumer-router client (internal docs transport B). Talks to Composio's MCP
// META-TOOL router (https://connect.composio.dev/mcp + header
// `x-consumer-api-key: ck_…`) over Streamable-HTTP MCP. The router exposes ~7
// meta-tools (search/get-schemas/multi-execute/manage-connections/…), NOT 250 flat
// tools.
//
// RESTRICTION MODEL (decided 2026-06-25, verified live): the consumer router has NO
// native per-ACTION restriction — its meta-tools expose no allow-list / approval /
// deny capability, and the `ck_` key is rejected by the Platform API (so it can't
// mint per-action-scoped URLs either). Composio therefore restricts only at the
// TOOLKIT level: a cybo can execute a slug only for a toolkit with an ACTIVE
// connection. v1 uses exactly that native granularity — NO daemon-side per-action
// gateway (the rejected "composio-proxy" complexity). Per-action scoping / approval
// would require the Platform-API path (transport A, x-api-key) instead.
//
// One consumer key === one IDENTITY (entity): v1 uses a single workspace `service`
// key; per-user `caller` keys later.
//
// Validated live 2026-06-25 (init → tools/list → search → manage-connections list).

const DEFAULT_ROUTER_URL = "https://connect.composio.dev/mcp";

export interface ComposioRouterClientOpts {
  consumerKey: string;
  routerUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ComposioExecuteResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ComposioConnectInfo {
  // The OAuth redirect the user opens to authorize a toolkit (when not connected).
  redirectUrl?: string;
  // Raw router payload (status / accounts list), surfaced for the caller to read.
  raw: unknown;
}

// A thin Streamable-HTTP MCP client: each call does initialize → (notify) →
// tools/call within one short-lived session. Simpler + stateless-friendly than
// holding a long session; the router is fast and these are infrequent.
export class ComposioRouterClient {
  private readonly consumerKey: string;
  private readonly routerUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ComposioRouterClientOpts) {
    this.consumerKey = opts.consumerKey;
    this.routerUrl = opts.routerUrl ?? DEFAULT_ROUTER_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(sessionId?: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-consumer-api-key": this.consumerKey,
    };
    if (sessionId) h["Mcp-Session-Id"] = sessionId;
    return h;
  }

  // A Streamable-HTTP MCP body is either JSON or an SSE stream; return the JSON-RPC
  // payload from whichever shape arrived.
  private async readBody(res: Response): Promise<{ result?: unknown; error?: unknown }> {
    const ct = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (ct.includes("text/event-stream")) {
      const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
      const last = dataLines[dataLines.length - 1];
      return last ? JSON.parse(last.slice(5).trim()) : {};
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return { error: { message: text.slice(0, 300) } };
    }
  }

  private async post(
    method: string,
    params: unknown,
    sessionId?: string,
  ): Promise<{ sessionId: string | null; result?: unknown; error?: unknown }> {
    const res = await this.fetchImpl(this.routerUrl, {
      method: "POST",
      headers: this.headers(sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await this.readBody(res);
    return { sessionId: res.headers.get("mcp-session-id"), result: body.result, error: body.error };
  }

  // Open a session (initialize + initialized notification). Returns the session id.
  private async openSession(): Promise<string | null> {
    const init = await this.post("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cyborg-daemon", version: "0.0.1" },
    });
    if (init.error)
      throw new Error(`Composio router initialize failed: ${stringifyErr(init.error)}`);
    const sid = init.sessionId;
    if (sid) {
      await this.fetchImpl(this.routerUrl, {
        method: "POST",
        headers: this.headers(sid),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }).catch(() => {
        // intentional: `notifications/initialized` is a fire-and-forget MCP notice;
        // a failed POST must not fail session init — the session id is already set.
      });
    }
    return sid;
  }

  // List the router's meta-tools (validation / capability probe).
  async listMetaTools(): Promise<Array<{ name: string; description?: string }>> {
    const sid = await this.openSession();
    const out = await this.post("tools/list", {}, sid ?? undefined);
    if (out.error) throw new Error(`Composio router tools/list failed: ${stringifyErr(out.error)}`);
    return (out.result as { tools?: Array<{ name: string; description?: string }> })?.tools ?? [];
  }

  // Call one meta-tool, returning its first text-content payload parsed as JSON
  // when possible (the router wraps results in {content:[{type:"text",text}]}).
  private async callMeta(name: string, args: unknown): Promise<unknown> {
    const sid = await this.openSession();
    const out = await this.post("tools/call", { name, arguments: args }, sid ?? undefined);
    if (out.error) throw new Error(`Composio ${name} failed: ${stringifyErr(out.error)}`);
    const content = (out.result as { content?: Array<{ type: string; text?: string }> })?.content;
    const textPart = content?.find((c) => c.type === "text")?.text;
    if (typeof textPart !== "string") return out.result;
    try {
      return JSON.parse(textPart);
    } catch {
      return textPart;
    }
  }

  // Discovery: find tool slugs + a recommended plan for a natural-language use case.
  async search(useCase: string): Promise<unknown> {
    return this.callMeta("COMPOSIO_SEARCH_TOOLS", { use_case: useCase });
  }

  // Fetch exact input schemas for slugs (so the agent passes correct args).
  async getSchemas(slugs: string[]): Promise<unknown> {
    return this.callMeta("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: slugs });
  }

  // Execute ONE action slug via the router. Restriction is at the toolkit level
  // (Composio runs a slug only for a connected toolkit) — there is no per-action
  // gate here by design (see the RESTRICTION MODEL note at the top of this file).
  async execute(slug: string, args: unknown): Promise<ComposioExecuteResult> {
    try {
      const res = (await this.callMeta("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: slug, arguments: args ?? {} }],
      })) as {
        data?: { results?: Array<{ successful?: boolean; data?: unknown; error?: string }> };
      };
      const first = res?.data?.results?.[0];
      if (!first) return { ok: false, error: "router returned no result" };
      return first.successful
        ? { ok: true, result: first.data }
        : { ok: false, error: first.error ?? "execution reported not successful" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // List connected accounts for ONE toolkit (the router's `list` action validates
  // `name` ≥ 1 char, so it's per-toolkit). Returns the raw payload; `isConnected`
  // derives a boolean for the run-context membership check.
  async listConnections(toolkit: string): Promise<unknown> {
    return this.callMeta("COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: toolkit, action: "list" }],
    });
  }

  // True when the consumer has at least one ACTIVE connected account for `toolkit`.
  async isConnected(toolkit: string): Promise<boolean> {
    const raw = await this.listConnections(toolkit);
    const text = JSON.stringify(raw).toLowerCase();
    // The list payload embeds account entries with a status; treat an "active"/
    // "connected" account as connected. Conservative: false on an empty/no-account
    // payload (the JIT connect-card then fires).
    return /"status"\s*:\s*"(active|connected)"/.test(text);
  }

  // Start a JIT OAuth connect for `toolkit` — returns the redirect_url the user
  // opens (surfaced as an in-chat connect-card). The router handles the OAuth flow.
  async startConnect(toolkit: string): Promise<ComposioConnectInfo> {
    const raw = await this.callMeta("COMPOSIO_MANAGE_CONNECTIONS", {
      toolkits: [{ name: toolkit, action: "add" }],
    });
    const redirectUrl = findRedirectUrl(raw);
    return { redirectUrl, raw };
  }
}

function stringifyErr(err: unknown): string {
  if (err && typeof err === "object" && "message" in err)
    return String((err as { message: unknown }).message);
  return JSON.stringify(err).slice(0, 200);
}

// Pull an OAuth redirect URL out of the router's manage-connections payload
// (shape varies: redirect_url / redirectUrl / nested under data/connections).
function findRedirectUrl(payload: unknown): string | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [payload];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "redirect_url" || k === "redirectUrl") && typeof v === "string") return v;
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return undefined;
}

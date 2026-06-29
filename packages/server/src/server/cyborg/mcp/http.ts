import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { PgSync } from "../db/pg-sync.js";
import type { RateLimiter } from "../rate-limiter.js";
import { buildWorkspaceMcpServer, type McpAuthContext, type McpRelay } from "./server.js";
import { hashMcpToken } from "./token.js";

// Mounts the workspace MCP server at the relay's `/mcp` endpoint.
//
// Stateless: every POST authenticates a Personal Access Token, resolves the
// acting identity, re-checks workspace membership, then spins up a one-shot MCP
// server + transport for that request. No session map to leak across identities.

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  // readBody destroys the socket on an oversized body; writing then would throw.
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB — cap the request body to avoid OOM/DoS

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on("data", (c: Buffer) => {
      length += c.length;
      if (length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export interface McpHttpDeps {
  pg: PgSync;
  relay: McpRelay;
  // Per-token request limiter (keyed by token id, action "mcp"). In-memory per
  // relay instance — consistent with the relay's other inbound limiters.
  rateLimiter: RateLimiter;
  // Optional live `cyborg:tasks_changed` fan-out for task mutations made via the
  // MCP task tools (threaded into the per-request workspace server).
  broadcastTasksChanged?: (workspaceId: string, payload: unknown) => void;
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: McpHttpDeps,
): Promise<void> {
  // Streamable HTTP carries every JSON-RPC call (including initialize) over POST.
  if (req.method !== "POST") {
    return sendJsonRpcError(res, 405, "MCP endpoint expects POST");
  }

  const auth = req.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) {
    return sendJsonRpcError(res, 401, "missing bearer token");
  }
  const rawToken = auth.slice(7).trim();
  const token = await deps.pg.getMcpTokenByHash(hashMcpToken(rawToken));
  if (!token) {
    return sendJsonRpcError(res, 401, "invalid, disabled, or expired token");
  }

  // Per-token rate limit. Checked before the workspace/membership PG lookups so a
  // flood from one token is rejected cheaply (and can't amplify into DB load).
  const limit = deps.rateLimiter.check(token.id, "mcp");
  if (!limit.allowed) {
    if (limit.retryAfterMs !== undefined && !res.headersSent && !res.destroyed) {
      res.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
    }
    return sendJsonRpcError(res, 429, "rate limit exceeded for this token");
  }

  // Workspace master switch (off by default). Even a valid token is refused while
  // MCP access is disabled for the workspace, so an owner can cut off all external
  // agents instantly without revoking individual tokens.
  if (!(await deps.pg.getMcpEnabled(token.workspaceId))) {
    return sendJsonRpcError(res, 403, "MCP access is disabled for this workspace");
  }

  // Re-check identity at request time (a cybo or user can be removed after the
  // token was minted). The identity lives in a DIFFERENT table per type — a
  // cybo id is in `cybos`, a user id in `memberships`. Using isMember for both
  // both rejected a correctly-minted cybo token AND let a cybo-labeled token
  // whose id happened to be the owner's user id read with the owner's perms.
  // `displayName` is captured here so write tools can attribute messages.
  let displayName: string | null = null;
  if (token.identityType === "cybo") {
    const cybo = (await deps.pg.getCybos(token.workspaceId)).find((c) => c.id === token.identityId);
    if (!cybo) {
      return sendJsonRpcError(res, 403, "identity is no longer a member of this workspace");
    }
    displayName = cybo.name;
  } else {
    if (!(await deps.pg.isMember(token.workspaceId, token.identityId))) {
      return sendJsonRpcError(res, 403, "identity is no longer a member of this workspace");
    }
    const user = await deps.pg.getUserById(token.identityId);
    displayName = user?.name ?? null;
  }

  const ctx: McpAuthContext = {
    tokenId: token.id,
    workspaceId: token.workspaceId,
    identityType: token.identityType,
    identityId: token.identityId,
    displayName,
    scopes: token.scopes,
  };

  let body: unknown;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof Error && err.message === "request body too large") {
      return sendJsonRpcError(res, 413, "request body too large");
    }
    return sendJsonRpcError(res, 400, "invalid JSON body");
  }

  // Tasks feature gate: the authoritative server-side signal is "the workspace has
  // ≥1 tasks_projects row" (provisioned on workspace/project creation). When Tasks
  // has never been provisioned for this workspace the task- and page-management
  // tools are withheld entirely. Fail-closed: a read failure disables them (a
  // workspace with no resolvable Tasks state shouldn't advertise Tasks tools).
  let tasksEnabled = false;
  try {
    tasksEnabled = (await deps.pg.getTasksProjects(token.workspaceId)).length > 0;
  } catch {
    tasksEnabled = false;
  }

  const server = buildWorkspaceMcpServer(ctx, {
    pg: deps.pg,
    relay: deps.relay,
    tasksEnabled,
    broadcastTasksChanged: deps.broadcastTasksChanged,
  });
  const transport = new StreamableHTTPServerTransport({
    // Stateless mode: no server-assigned session id.
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    // Host allowlist is enforced at the relay layer; the transport's exact-match
    // Host check would reject reverse-proxied requests.
    enableDnsRebindingProtection: false,
  });

  // Clean up on whichever fires first. With HTTP Keep-Alive, `close` may not
  // fire until the (reused) connection ends, so also clean up on `finish`.
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    void transport.close();
    void server.close();
  };
  res.on("finish", cleanup);
  res.on("close", cleanup);

  await server.connect(transport);
  // Best-effort: record usage. Never blocks the response.
  // intentional: last-used timestamp is cosmetic — a failed touch changes nothing.
  void deps.pg.touchMcpToken(token.id).catch(() => {});
  await transport.handleRequest(req, res, body);
}

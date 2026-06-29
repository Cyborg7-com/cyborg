import { WebSocket } from "ws";
import { getDaemonHost, resolveDaemonTarget, resolveDaemonPassword } from "../../utils/client.js";
import { getOrCreateCliClientId } from "../../utils/client-id.js";
import { resolveCliVersion } from "../../version.js";

export interface CyborgCliClientOptions {
  host?: string;
  token?: string;
  email?: string;
  name?: string;
}

export type BroadcastHandler = (type: string, payload: Record<string, unknown>) => void;

export class CyborgCliClient {
  private ws: WebSocket | null = null;
  private requestCounter = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private token = "";
  private broadcastHandlers: BroadcastHandler[] = [];

  async connect(
    options: CyborgCliClientOptions,
  ): Promise<{ user: Record<string, unknown>; workspaces: unknown[] }> {
    const host = options.host ?? getDaemonHost({ host: options.host });
    const target = resolveDaemonTarget(host);
    const password = resolveDaemonPassword(host);
    const clientId = await getOrCreateCliClientId();

    const headers: Record<string, string> = {};
    if (password) {
      headers["Authorization"] = `Bearer ${password}`;
    }

    this.ws = new WebSocket(target.url, { headers });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10_000);
      this.ws!.on("open", () => {
        clearTimeout(timeout);
        this.ws!.send(
          JSON.stringify({
            type: "hello",
            clientId: `cyborg-cli-${clientId}`,
            clientType: "cli",
            protocolVersion: 1,
            appVersion: resolveCliVersion(),
          }),
        );
        resolve();
      });
      this.ws!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    // Wait briefly for server_info
    await new Promise((r) => setTimeout(r, 200));

    if (options.token) {
      this.token = options.token;
    } else if (options.email) {
      const httpBase = `http://${host}`;
      const resp = await fetch(`${httpBase}/api/cyborg/dev-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: options.email, name: options.name ?? options.email }),
      });
      if (!resp.ok) throw new Error(`Failed to get dev token: ${resp.status}`);
      const body = (await resp.json()) as { token: string };
      this.token = body.token;
    }

    const auth = await this.request<{ user: Record<string, unknown>; workspaces: unknown[] }>(
      "cyborg:auth",
      { token: this.token },
    );
    return auth;
  }

  async request<T>(type: string, params?: Record<string, unknown>): Promise<T> {
    const requestId = `creq_${++this.requestCounter}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${type} timed out`));
      }, 15_000);
      this.pendingRequests.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send({ type, requestId, ...params });
    });
  }

  fire(type: string, params?: Record<string, unknown>): void {
    this.send({ type, ...params });
  }

  onBroadcast(handler: BroadcastHandler): () => void {
    this.broadcastHandlers.push(handler);
    return () => {
      this.broadcastHandlers = this.broadcastHandlers.filter((h) => h !== handler);
    };
  }

  close(): void {
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error("Client closed"));
    }
    this.pendingRequests.clear();
    this.ws?.close();
    this.ws = null;
  }

  private send(data: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    this.ws.send(JSON.stringify({ type: "session", message: data }));
  }

  private handleMessage(raw: string): void {
    let outer: { type?: string; message?: Record<string, unknown> };
    try {
      outer = JSON.parse(raw);
    } catch {
      return;
    }

    const msg = outer.type === "session" && outer.message ? outer.message : outer;
    const type = msg.type as string | undefined;
    if (!type?.startsWith("cyborg:")) return;

    const payload = (msg as { payload?: Record<string, unknown> }).payload;

    if (payload && "requestId" in payload) {
      const pending = this.pendingRequests.get(payload.requestId as string);
      if (pending) {
        this.pendingRequests.delete(payload.requestId as string);
        clearTimeout(pending.timer);
        if (type === "cyborg:error") {
          pending.reject(new Error((payload as { message: string }).message));
        } else {
          pending.resolve(payload);
        }
        return;
      }
    }

    if (payload && this.broadcastHandlers.length > 0) {
      for (const handler of this.broadcastHandlers) {
        handler(type, payload);
      }
    }
  }
}

export async function connectCyborg(options: CyborgCliClientOptions): Promise<CyborgCliClient> {
  const client = new CyborgCliClient();
  await client.connect(options);
  return client;
}

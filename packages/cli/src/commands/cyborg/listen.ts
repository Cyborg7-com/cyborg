import { WebSocket } from "ws";
import { getDaemonHost, resolveDaemonTarget, resolveDaemonPassword } from "../../utils/client.js";
import { getOrCreateCliClientId } from "../../utils/client-id.js";
import { resolveCliVersion } from "../../version.js";

interface ListenOptions {
  host?: string;
  email?: string;
  token?: string;
}

function formatTime(ts?: number): string {
  return ts ? new Date(ts).toLocaleTimeString() : new Date().toLocaleTimeString();
}

function handleListenMessage(
  type: string,
  payload: Record<string, unknown> | undefined,
  channelId: string,
): void {
  if (!payload) return;

  switch (type) {
    case "cyborg:fetch_messages_response": {
      const messages = payload.messages as Array<{
        fromId: string;
        text: string;
        createdAt: number;
      }>;
      for (const m of messages) {
        console.log(`[${formatTime(m.createdAt)}] ${m.fromId}: ${m.text}`);
      }
      if (messages.length > 0) console.log("--- end of history ---\n");
      break;
    }
    case "cyborg:channel_message_broadcast": {
      const p = payload as {
        fromId?: string;
        text?: string;
        channelId?: string;
        createdAt?: number;
      };
      if (p.channelId === channelId) {
        console.log(`[${formatTime(p.createdAt)}] ${p.fromId}: ${p.text}`);
      }
      break;
    }
    case "cyborg:dm_broadcast": {
      const p = payload as { fromId?: string; text?: string; createdAt?: number };
      console.log(`[${formatTime(p.createdAt)}] DM from ${p.fromId}: ${p.text}`);
      break;
    }
    case "cyborg:agent_stream": {
      const p = payload as { kind?: string; text?: string };
      if (p.kind === "text" && p.text) process.stdout.write(p.text);
      break;
    }
    case "cyborg:agent_status": {
      const p = payload as { agentId?: string; status?: string };
      console.log(`\n[agent:${p.agentId}] status: ${p.status}`);
      break;
    }
  }
}

export async function runListenCommand(
  workspaceId: string,
  channelId: string,
  options: ListenOptions,
): Promise<void> {
  const host = options.host ?? getDaemonHost({ host: options.host });
  const target = resolveDaemonTarget(host);
  const password = resolveDaemonPassword(host);
  const clientId = await getOrCreateCliClientId();

  const headers: Record<string, string> = {};
  if (password) {
    headers["Authorization"] = `Bearer ${password}`;
  }

  const ws = new WebSocket(target.url, { headers });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10_000);
    ws.on("open", () => {
      clearTimeout(timeout);
      ws.send(
        JSON.stringify({
          type: "hello",
          clientId: `cyborg-cli-listen-${clientId}`,
          clientType: "cli",
          protocolVersion: 1,
          appVersion: resolveCliVersion(),
        }),
      );
      resolve();
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Get auth token
  let token = options.token ?? "";
  if (!token && options.email) {
    const httpBase = `http://${host}`;
    const resp = await fetch(`${httpBase}/api/cyborg/dev-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: options.email, name: options.email }),
    });
    if (!resp.ok) throw new Error(`Failed to get dev token: ${resp.status}`);
    const body = (await resp.json()) as { token: string };
    token = body.token;
  }

  // Authenticate
  const authRequestId = `creq_auth_${Date.now()}`;
  const sendMsg = (data: Record<string, unknown>) => {
    ws.send(JSON.stringify({ type: "session", message: data }));
  };

  // Wait briefly for server_info
  await new Promise((r) => setTimeout(r, 200));

  sendMsg({ type: "cyborg:auth", token, requestId: authRequestId });

  // Wait for auth response
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Auth timeout")), 10_000);
    const handler = (data: { toString(): string }) => {
      let outer: { type?: string; message?: Record<string, unknown> };
      try {
        outer = JSON.parse(data.toString());
      } catch {
        return;
      }
      const msg = outer.type === "session" && outer.message ? outer.message : outer;
      const type = msg.type as string | undefined;
      if (type === "cyborg:auth_response" || type === "cyborg:error") {
        clearTimeout(timeout);
        ws.off("message", handler);
        if (type === "cyborg:error") {
          reject(
            new Error(
              (msg as { payload?: { message?: string } }).payload?.message ?? "Auth failed",
            ),
          );
        } else {
          resolve();
        }
      }
    };
    ws.on("message", handler);
  });

  console.log(`Listening on workspace=${workspaceId} channel=${channelId}...`);
  console.log("Press Ctrl+C to stop.\n");

  // Subscribe by fetching initial messages, then listen for new ones
  sendMsg({
    type: "cyborg:fetch_messages",
    workspaceId,
    channelId,
    limit: 20,
    requestId: `creq_fetch_${Date.now()}`,
  });

  ws.on("message", (data) => {
    let outer: { type?: string; message?: Record<string, unknown> };
    try {
      outer = JSON.parse(data.toString());
    } catch {
      return;
    }
    const msg = outer.type === "session" && outer.message ? outer.message : outer;
    const type = msg.type as string | undefined;
    const payload = (msg as { payload?: Record<string, unknown> }).payload;

    if (!type) return;
    handleListenMessage(type, payload, channelId);
  });

  // Keep alive until Ctrl+C
  await new Promise<void>((resolve) => {
    ws.on("close", resolve);
    process.on("SIGINT", () => {
      console.log("\nDisconnecting...");
      ws.close();
      resolve();
    });
  });
}

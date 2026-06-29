import { createHmac } from "node:crypto";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess, spawn } from "node:child_process";

const DEV_JWT_SECRET = "cyborg7-dev-secret-change-in-production";

function base64UrlEncode(str: string): string {
  return Buffer.from(str).toString("base64url");
}

export function createDevToken(email: string, name?: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    email,
    name: name ?? email,
    exp: Math.floor(Date.now() / 1000) + 86400,
    iat: Math.floor(Date.now() / 1000),
  };
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac("sha256", DEV_JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");
  return `${headerB64}.${payloadB64}.${signature}`;
}

export interface TestDaemon {
  port: number;
  wsUrl: string;
  paseoHome: string;
  process: ChildProcess;
  stop: () => Promise<void>;
}

async function getAvailablePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function startTestDaemon(): Promise<TestDaemon> {
  const port = await getAvailablePort();
  const paseoHome = await mkdtemp(join(tmpdir(), "cyborg-e2e-"));
  await mkdir(join(paseoHome, "agents"), { recursive: true });

  const cliDir = join(import.meta.dirname, "..", "..", "..", "cli");
  const tsxBin = join(cliDir, "node_modules", ".bin", "tsx");
  const cliEntry = join(cliDir, "src", "index.ts");

  const proc = spawn(tsxBin, [cliEntry, "daemon", "start", "--foreground"], {
    env: {
      ...process.env,
      PASEO_HOME: paseoHome,
      PASEO_LISTEN: `127.0.0.1:${port}`,
      PASEO_RELAY_ENABLED: "false",
      PASEO_NODE_ENV: "development",
      PASEO_CORS_ORIGINS: `http://localhost:${process.env.VITE_PORT ?? 5173}`,
      CI: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const cleanup = async () => {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // intentional: test-daemon cleanup; the process group may already be gone.
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    if (existsSync(paseoHome)) {
      await rm(paseoHome, { recursive: true, force: true }).catch(() => {});
    }
  };

  // Wait for daemon ready by polling with agent ls
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const { WebSocket } = await import("ws");
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          ws.close();
          reject(new Error("timeout"));
        }, 3000);
        ws.on("open", () => {
          clearTimeout(t);
          ws.send(
            JSON.stringify({
              type: "hello",
              clientId: "probe",
              clientType: "cli",
              protocolVersion: 1,
            }),
          );
        });
        ws.on("message", () => {
          clearTimeout(t);
          ws.close();
          resolve();
        });
        ws.on("error", () => {
          clearTimeout(t);
          reject(new Error("ws error"));
        });
      });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (Date.now() >= deadline) {
    await cleanup();
    throw new Error(`Daemon failed to start on port ${port}. stderr: ${stderr}`);
  }

  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    paseoHome,
    process: proc,
    stop: cleanup,
  };
}

import { join } from "node:path";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import type { TestDaemonContext } from "./test-daemon.ts";

const CLI_DIR = join(import.meta.dirname, "..", "..");
const CYBORG_ENTRY = join(CLI_DIR, "src", "cyborg.ts");
const TSX_BIN = join(CLI_DIR, "node_modules", ".bin", "tsx");
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

export async function runCyborg(
  ctx: TestDaemonContext,
  args: string[],
  options?: { timeout?: number; env?: Record<string, string> },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const timeout = options?.timeout ?? 30000;
  const host = `127.0.0.1:${ctx.port}`;

  const resolvedArgs = resolveEmailToToken(args);

  return new Promise((resolve, reject) => {
    const proc = spawn(TSX_BIN, [CYBORG_ENTRY, ...resolvedArgs, "--host", host], {
      env: {
        ...process.env,
        PASEO_HOME: ctx.paseoHome,
        PASEO_NODE_ENV: "development",
        ...options?.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`cyborg command timed out after ${timeout}ms: cyborg ${args.join(" ")}`));
    }, timeout);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function resolveEmailToToken(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && i + 1 < args.length) {
      const email = args[i + 1]!;
      result.push("--token", createDevToken(email));
      i++;
    } else {
      result.push(args[i]!);
    }
  }
  return result;
}

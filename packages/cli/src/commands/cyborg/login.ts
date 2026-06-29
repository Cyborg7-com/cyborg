import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";

const DEFAULT_URL = "https://relay.cyborg7.com";

export function authConfigPath(): string {
  return join(process.env.CYBORG_HOME ?? join(homedir(), ".cyborg"), "auth.json");
}

/** Saved credentials shape written by `cyborg login`. */
export interface SavedAuth {
  /** HTTP relay base the user logged into (e.g. https://relay.cyborg7.com). */
  url: string;
  /** Derived daemon relay WebSocket endpoint (wss://host/relay). */
  relayWs: string;
  /** Bearer token for the relay. */
  token: string;
  /** Logged-in user id. */
  userId: string;
  /** Logged-in user email. */
  email: string;
}

/**
 * Read the saved credentials, or null if not logged in / unreadable.
 * Shared by whoami, status and daemon claim so "who am I" has one source.
 */
export function readSavedAuth(): SavedAuth | null {
  const cfgPath = authConfigPath();
  if (!existsSync(cfgPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Partial<SavedAuth>;
    if (!parsed || typeof parsed.token !== "string" || !parsed.token) return null;
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      relayWs: typeof parsed.relayWs === "string" ? parsed.relayWs : "",
      token: parsed.token,
      userId: typeof parsed.userId === "string" ? parsed.userId : "",
      email: typeof parsed.email === "string" ? parsed.email : "",
    };
  } catch {
    // Malformed creds file — treat as not-logged-in rather than crashing callers.
    return null;
  }
}

// Derive the daemon relay (wss /relay) from the HTTP base the user logs into.
export function deriveRelayWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  const proto = u.protocol === "http:" ? "ws:" : "wss:";
  return `${proto}//${u.host}/relay`;
}

interface LoginOptions {
  url?: string;
  email?: string;
  password?: string;
  token?: string;
  userId?: string;
}

function prompt(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // Mute echo: overwrite each keystroke as it's written.
      const out = process.stdout;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rl as any)._writeToOutput = (s: string) => {
        if (s.includes(question)) out.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

export async function runLoginCommand(options: LoginOptions, _command: Command): Promise<void> {
  const url = (options.url ?? DEFAULT_URL).replace(/\/+$/, "");
  let token = options.token ?? "";
  let userId: string;
  let email = options.email ?? "";

  if (!token) {
    if (!email) email = await prompt("Email: ", false);
    let password = options.password ?? process.env.CYBORG_PASSWORD ?? "";
    if (!password) password = await prompt("Password: ", true);
    if (!email || !password) throw new Error("email and password (or --token) are required");
    const resp = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Login failed (${resp.status}): ${text || resp.statusText}`);
    }
    const body = (await resp.json()) as { token: string; user: { id: string; email: string } };
    token = body.token;
    userId = body.user.id;
    email = body.user.email;
  } else {
    // Token provided directly — the caller must also pass --user-id (the daemon
    // owner the relay will register the daemon under).
    if (!options.userId) throw new Error("--token requires --user-id <id>");
    userId = options.userId;
  }

  const cfgPath = authConfigPath();
  mkdirSync(join(cfgPath, ".."), { recursive: true });
  writeFileSync(
    cfgPath,
    JSON.stringify({ url, relayWs: deriveRelayWsUrl(url), token, userId, email }, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(`Logged in as ${email} (${userId})\nSaved to ${cfgPath}\n`);
}

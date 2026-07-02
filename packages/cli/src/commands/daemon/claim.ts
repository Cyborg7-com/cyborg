import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { resolvePaseoHome, getOrCreateServerId } from "@getpaseo/server";
import { authConfigPath } from "../cyborg/login.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";

interface ClaimResult {
  action: "claimed" | "already-owned";
  home: string;
  ownerId: string;
  relay: string;
  message: string;
}

const claimResultSchema: OutputSchema<ClaimResult> = {
  idField: "action",
  columns: [
    { header: "STATUS", field: "action", color: () => "green" },
    { header: "HOME", field: "home" },
    { header: "OWNER", field: "ownerId" },
    { header: "MESSAGE", field: "message" },
  ],
};

export type ClaimCommandResult = SingleResult<ClaimResult>;

function resolveHome(options: CommandOptions): string {
  if (typeof options.home === "string" && options.home) return options.home;
  return resolvePaseoHome();
}

// CYBORG-58 enrollment: POST the user's bearer token to the relay, which mints a
// daemon token bound to (this daemon's serverId, the authenticated user) and returns
// it. Persist it as `cyborg-relay-token` (0600) — bootstrap prefers it over
// self-minting. Best-effort + fully guarded: no throw escapes (a claim must never
// fail because enrollment couldn't reach the relay).
async function enrollDaemonToken(
  home: string,
  auth: { token?: string; url?: string },
): Promise<void> {
  if (!auth.token || !auth.url) return;
  try {
    const serverId = getOrCreateServerId(home);
    const base = auth.url.replace(/\/$/, "");
    const resp = await fetch(`${base}/api/cyborg/daemon/enroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ daemonId: serverId }),
    });
    if (!resp.ok) return;
    const data = (await resp.json()) as { token?: unknown };
    if (typeof data.token === "string" && data.token) {
      writeFileSync(join(home, "cyborg-relay-token"), data.token + "\n", { mode: 0o600 });
    }
  } catch {
    // best-effort; never fail the claim on an enrollment error
  }
}

export async function runDaemonClaimCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ClaimCommandResult> {
  const cfgPath = authConfigPath();
  if (!existsSync(cfgPath)) {
    const e: CommandError = {
      code: "NOT_LOGGED_IN",
      message: "Not logged in — run `cyborg login` first",
    };
    throw e;
  }
  const auth = JSON.parse(readFileSync(cfgPath, "utf8")) as {
    userId?: string;
    relayWs?: string;
    email?: string;
    token?: string;
    url?: string;
  };
  if (!auth.userId) {
    const e: CommandError = {
      code: "BAD_AUTH",
      message: `No userId in ${cfgPath}; re-run cyborg login`,
    };
    throw e;
  }

  const home = resolveHome(options);
  mkdirSync(home, { recursive: true });
  const ownerPath = join(home, "daemon-owner");
  const existing = existsSync(ownerPath) ? readFileSync(ownerPath, "utf8").trim() : "";

  // First-claim semantics mirror the daemon (bootstrap.ts): an existing owner is
  // not overwritten unless --force, since the relay binds the daemon to it.
  if (existing && existing !== auth.userId && options.force !== true) {
    const e: CommandError = {
      code: "ALREADY_OWNED",
      message: `Daemon home ${home} is already claimed by ${existing}. Use --force to reassign.`,
    };
    throw e;
  }

  if (existing === auth.userId) {
    return {
      type: "single",
      data: {
        action: "already-owned",
        home,
        ownerId: auth.userId,
        relay: auth.relayWs ?? "",
        message: `Already claimed by ${auth.email ?? auth.userId}`,
      },
      schema: claimResultSchema,
    };
  }

  writeFileSync(ownerPath, auth.userId + "\n", { mode: 0o600 });
  if (auth.relayWs)
    writeFileSync(join(home, "cyborg-relay-url"), auth.relayWs + "\n", { mode: 0o600 });

  // CYBORG-58: exchange the user token for a RELAY-SIGNED daemon token so the daemon
  // stops self-minting with a shared secret (the coupling that orphaned the fleet on
  // a user-secret rotation). Best-effort — a failure never fails the claim; the daemon
  // still boots and re-enrolls on the next claim/login.
  await enrollDaemonToken(home, auth);

  return {
    type: "single",
    data: {
      action: "claimed",
      home,
      ownerId: auth.userId,
      relay: auth.relayWs ?? "",
      message: `Claimed for ${auth.email ?? auth.userId} → ${auth.relayWs ?? "(no relay url)"}. Start: cyborg daemon start --foreground --home ${home}`,
    },
    schema: claimResultSchema,
  };
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { resolvePaseoHome } from "@getpaseo/server";
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

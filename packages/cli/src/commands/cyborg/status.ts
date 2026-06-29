import type { Command } from "commander";
import { authConfigPath, readSavedAuth, type SavedAuth } from "./login.js";
import {
  getDaemonHost,
  tryConnectToDaemon,
  type ConnectOptions,
} from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";

interface StatusFacts {
  auth: SavedAuth | null;
  configPath: string;
  daemonHost: string;
  daemonReachable: boolean;
}

interface StatusRow {
  key: string;
  value: string;
}

function createStatusSchema(): OutputSchema<StatusRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key" },
      {
        header: "VALUE",
        field: "value",
        color: (_v, item) => {
          if (item.key === "Logged in") return item.value === "yes" ? "green" : "red";
          if (item.key === "Daemon") return item.value.startsWith("reachable") ? "green" : "red";
          return undefined;
        },
      },
    ],
  };
}

export type StatusCommandResult = ListResult<StatusRow>;

/**
 * Build the status rows from already-gathered facts. Pure (no I/O) so the
 * reporting logic can be unit-tested without a daemon or creds file.
 */
export function buildCyborgStatus(facts: StatusFacts): StatusCommandResult {
  const { auth, configPath, daemonHost, daemonReachable } = facts;
  const loggedIn = auth !== null;

  const rows: StatusRow[] = [
    { key: "Logged in", value: loggedIn ? "yes" : "no" },
    { key: "Email", value: auth?.email || "-" },
    { key: "User ID", value: auth?.userId || "-" },
    { key: "Relay", value: auth?.url || auth?.relayWs || "-" },
    { key: "Config", value: configPath },
    {
      key: "Daemon",
      value: daemonReachable ? `reachable (${daemonHost})` : `unreachable (${daemonHost})`,
    },
  ];

  return { type: "list", data: rows, schema: createStatusSchema() };
}

export async function runCyborgStatusCommand(
  options: CommandOptions,
  _command: Command,
): Promise<StatusCommandResult> {
  const connectOptions: ConnectOptions = {
    host: typeof options.host === "string" ? options.host : undefined,
    // Keep the probe short so `status` never hangs when nothing is reachable.
    timeout: 2000,
  };
  const daemonHost = getDaemonHost(connectOptions);

  const client = await tryConnectToDaemon(connectOptions);
  const daemonReachable = client !== null;
  if (client) {
    await client.close().catch(() => {}); // intentional: best-effort teardown of the reachability probe
  }

  return buildCyborgStatus({
    auth: readSavedAuth(),
    configPath: authConfigPath(),
    daemonHost,
    daemonReachable,
  });
}

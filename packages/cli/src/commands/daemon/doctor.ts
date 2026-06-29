import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrCreateServerId } from "@getpaseo/server";
import { tryConnectToDaemon } from "../../utils/client.js";
import { resolveLocalDaemonState, resolveTcpHostFromListen } from "./local-daemon.js";
import { resolveTargetHomeForCommand } from "./multi-home.js";
import { npmViewLatest } from "./update.js";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";

// `cyborg daemon doctor` (#665): a one-glance health readout — version installed,
// relay configured + (best-effort) connected, server-id, online state, and
// whether a newer version is published. Surfaces a daemon that quietly fell
// behind without the user diffing versions by hand.

interface DoctorRow {
  check: string;
  value: string;
}

// Pure assembler — takes the resolved facts and produces the readout + flags, so
// the version/online classification is unit-testable without a daemon or npm.
export interface DoctorFacts {
  home: string;
  running: boolean; // pidfile pid is alive
  reachable: boolean; // websocket answered
  serverId: string | null;
  installedVersion: string; // CLI version
  daemonVersion: string | null; // version the live daemon reported
  latestVersion: string | null; // latest published (null = couldn't resolve)
  relayConfigured: boolean;
  relayEndpoint: string | null;
}

export interface DoctorReport {
  rows: DoctorRow[];
  updateAvailable: boolean;
  online: boolean;
}

export function buildDoctorReport(facts: DoctorFacts): DoctorReport {
  const online = facts.running && facts.reachable;
  const updateAvailable =
    facts.latestVersion !== null && facts.latestVersion !== facts.installedVersion;

  let status: string;
  if (online) status = "online";
  else if (facts.running) status = "running but unreachable (websocket down)";
  else status = "stopped";

  let updateValue: string;
  if (facts.latestVersion === null) updateValue = "unknown (couldn't resolve latest)";
  else if (updateAvailable)
    updateValue = `yes — ${facts.installedVersion} → ${facts.latestVersion}`;
  else updateValue = "no (up to date)";

  // Relay "connected" is reported honestly: a live daemon with relay configured
  // is treated as connected; offline → unknown (can't confirm without the daemon).
  let relayValue: string;
  if (!facts.relayConfigured) relayValue = "not configured";
  else if (online) relayValue = `configured (${facts.relayEndpoint}) — daemon online`;
  else relayValue = `configured (${facts.relayEndpoint}) — daemon offline, connection unknown`;

  const installedValue =
    facts.daemonVersion && facts.daemonVersion !== facts.installedVersion
      ? `${facts.installedVersion} (CLI) / ${facts.daemonVersion} (running daemon)`
      : facts.installedVersion;

  return {
    rows: [
      { check: "Home", value: facts.home },
      { check: "Status", value: status },
      { check: "Version", value: installedValue },
      { check: "Update available", value: updateValue },
      { check: "Server ID", value: facts.serverId ?? "(none)" },
      { check: "Relay", value: relayValue },
    ],
    updateAvailable,
    online,
  };
}

const doctorSchema: OutputSchema<DoctorRow> = {
  idField: "check",
  columns: [
    { header: "CHECK", field: "check" },
    {
      header: "VALUE",
      field: "value",
      color: (_value, item) => {
        if (item.check === "Status") return item.value === "online" ? "green" : "yellow";
        if (item.check === "Update available")
          return item.value.startsWith("yes") ? "yellow" : undefined;
        return undefined;
      },
    },
  ],
};

// Walk up from this module to the @getpaseo/cli package.json — robust from both
// the source tree (tests/dev) and dist/ (production), unlike a fixed relative
// require that only resolves from one of them.
function resolveCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const pkg = JSON.parse(readFileSync(pj, "utf8")) as { name?: unknown; version?: unknown };
        if (pkg.name === "@getpaseo/cli" && typeof pkg.version === "string" && pkg.version.trim()) {
          return pkg.version.trim();
        }
      } catch {
        // keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "unknown";
}

export async function runDoctorCommand(
  options: CommandOptions,
  _command: Command,
): Promise<ListResult<DoctorRow>> {
  const explicitHome = typeof options.home === "string" ? options.home : undefined;
  const target = resolveTargetHomeForCommand(explicitHome);
  const home = target.home;
  const state = resolveLocalDaemonState({ home });

  let reachable = false;
  let daemonVersion: string | null = null;
  const host = resolveTcpHostFromListen(state.listen);
  if (host) {
    const client = await tryConnectToDaemon({ host, timeout: 1500 });
    if (client) {
      try {
        reachable = true;
        daemonVersion = client.getLastServerInfoMessage()?.version ?? null;
      } finally {
        await client.close().catch(() => {}); // intentional: best-effort teardown of the reachability probe connection
      }
    }
  }

  let serverId: string | null = null;
  try {
    serverId = getOrCreateServerId(state.home);
  } catch {
    serverId = null;
  }

  const report = buildDoctorReport({
    home: state.home,
    running: state.running,
    reachable,
    serverId,
    installedVersion: resolveCliVersion(),
    daemonVersion,
    latestVersion: npmViewLatest(),
    relayConfigured: state.relayEnabled,
    relayEndpoint: state.relayEnabled ? state.relayEndpoint : null,
  });

  const rows = [...report.rows];
  if (target.note) rows.push({ check: "Note", value: target.note });

  return { type: "list", data: rows, schema: doctorSchema };
}

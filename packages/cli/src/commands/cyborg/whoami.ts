import type { Command } from "commander";
import { authConfigPath, readSavedAuth, type SavedAuth } from "./login.js";
import type { CommandError, CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

interface WhoamiResult {
  email: string;
  userId: string;
  relayUrl: string;
  configPath: string;
}

const whoamiSchema: OutputSchema<WhoamiResult> = {
  idField: "userId",
  columns: [
    { header: "EMAIL", field: "email" },
    { header: "USER ID", field: "userId" },
    { header: "RELAY", field: "relayUrl" },
    { header: "CONFIG", field: "configPath" },
  ],
};

export type WhoamiCommandResult = SingleResult<WhoamiResult>;

/**
 * Build the whoami result from saved credentials, or throw a clear
 * not-logged-in error. Pure (no I/O) so it can be unit-tested.
 */
export function buildWhoamiResult(auth: SavedAuth | null, configPath: string): WhoamiCommandResult {
  if (!auth) {
    const e: CommandError = {
      code: "NOT_LOGGED_IN",
      message: "Not logged in — run `cyborg login`",
    };
    throw e;
  }
  return {
    type: "single",
    data: {
      email: auth.email || "(unknown)",
      userId: auth.userId || "(unknown)",
      relayUrl: auth.url || auth.relayWs || "(unknown)",
      configPath,
    },
    schema: whoamiSchema,
  };
}

export async function runWhoamiCommand(
  _options: CommandOptions,
  _command: Command,
): Promise<WhoamiCommandResult> {
  return buildWhoamiResult(readSavedAuth(), authConfigPath());
}

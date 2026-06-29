import type { CommandError, CommandOptions } from "../../output/index.js";
import { connectCyborg, type CyborgCliClientOptions } from "./client.js";

export interface CyborgCommandOptions extends CommandOptions {
  host?: string;
  email?: string;
  token?: string;
  // Target a specific daemon by id. Threaded into daemon-forwarded RPCs (agent +
  // cybo ops) so multi-daemon workspaces don't misroute to an arbitrary daemon.
  daemon?: string;
}

export async function connectCyborgClient(options: CyborgCommandOptions) {
  try {
    const clientOpts: CyborgCliClientOptions = {
      host: options.host,
      token: options.token,
      email: options.email,
    };
    const client = await connectCyborg(clientOpts);
    return client;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "CYBORG_CONNECT_FAILED",
      message: `Cannot connect to Cyborg7 daemon: ${message}`,
      details: "Start the daemon with: npm run dev:cyborg",
    };
    throw error;
  }
}

export function toCyborgError(code: string, action: string, err: unknown): CommandError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as CommandError;
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    code,
    message: `Failed to ${action}: ${message}`,
  };
}

import os from "node:os";
import path from "node:path";
import { chmodSync, mkdirSync } from "node:fs";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  if (input === "~") return os.homedir();
  return input;
}

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PASEO_HOME ?? "~/.paseo";
  const resolved = path.resolve(expandHomeDir(raw));
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  try {
    if (process.platform !== "win32") chmodSync(resolved, 0o700);
  } catch {
    // intentional: best-effort permission tightening; mkdirSync already created
    // the dir with mode 0o700, so a chmod failure is non-fatal.
  }
  return resolved;
}

export interface SpawnProcessOptions extends Omit<SpawnOptions, "env"> {
  baseEnv?: Record<string, string | undefined>;
  envMode?: "external" | "internal";
  env?: Record<string, string | undefined>;
  envOverlay?: Record<string, string | undefined>;
}

export function spawnProcess(
  command: string,
  args: string[],
  options?: SpawnProcessOptions,
): ChildProcess {
  const { baseEnv, env, envOverlay, ...spawnOptions } = options ?? {};
  const resolvedBaseEnv = env ?? baseEnv ?? process.env;
  const childEnv = { ...resolvedBaseEnv, ...envOverlay } as NodeJS.ProcessEnv;
  return spawn(command, args, { ...spawnOptions, env: childEnv, windowsHide: true });
}

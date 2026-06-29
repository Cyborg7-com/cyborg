import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { findCyboDir } from "./manifest.js";
import { describePi, type PiExec } from "./pi-path.js";

export function showModel(cyboPath?: string): void {
  const dir = cyboPath ?? findCyboDir(process.cwd());
  if (!dir) {
    console.error("No cybo.json found.");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(resolve(dir, "cybo.json"), "utf-8"));
  const model = raw.model ? `${raw.provider}/${raw.model}` : raw.provider;
  console.log(model);
}

export function listModels(pi: PiExec): void {
  const result = spawnSync(pi.cmd, [...pi.pre, "--list-models"], {
    stdio: "inherit",
    timeout: 15000,
  });
  if (result.error) {
    console.error(`Failed to run PI ("${describePi(pi)}").`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

export function setModel(modelSpec: string, cyboPath?: string): void {
  const dir = cyboPath ?? findCyboDir(process.cwd());
  if (!dir) {
    console.error("No cybo.json found.");
    process.exit(1);
  }

  let provider: string;
  let model: string | undefined;

  if (modelSpec.includes("/")) {
    [provider, model] = modelSpec.split("/", 2);
  } else {
    provider = modelSpec;
    model = undefined;
  }

  const filePath = resolve(dir, "cybo.json");
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  raw.provider = provider;
  if (model) {
    raw.model = model;
  } else {
    delete raw.model;
  }
  writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(`Model set to ${modelSpec}`);
}

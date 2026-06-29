import { createInterface } from "node:readline/promises";
import { existsSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { PiExec } from "./pi-path.js";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function runInit(pi: PiExec): Promise<void> {
  const cwd = process.cwd();

  if (existsSync(resolve(cwd, "cybo.json"))) {
    console.error("cybo.json already exists in this directory.");
    process.exit(1);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    const defaultName = basename(cwd);
    const name = (await rl.question(`Name [${defaultName}]: `)) || defaultName;
    const slug = (await rl.question(`Slug [${toSlug(name)}]: `)) || toSlug(name);
    const role = await rl.question("Role (optional): ");

    console.log("\nAvailable models:");
    spawnSync(pi.cmd, [...pi.pre, "--list-models"], { stdio: "inherit", timeout: 15000 });

    const modelInput = await rl.question("\nModel [opencode/claude-sonnet-4-6]: ");
    const modelSpec = modelInput || "opencode/claude-sonnet-4-6";

    let provider: string;
    let model: string | undefined;
    if (modelSpec.includes("/")) {
      [provider, model] = modelSpec.split("/", 2);
    } else {
      provider = modelSpec;
    }

    const manifest: Record<string, unknown> = {
      slug,
      name,
      ...(role ? { role } : {}),
      provider,
      ...(model ? { model } : {}),
      soul: "soul.md",
    };

    writeFileSync(resolve(cwd, "cybo.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const soulContent = `# ${name}\n\nYou are ${name}${role ? `, a ${role}` : ""}.\n`;
    writeFileSync(resolve(cwd, "soul.md"), soulContent);

    console.log(`\nCreated cybo.json + soul.md`);
  } finally {
    rl.close();
  }
}

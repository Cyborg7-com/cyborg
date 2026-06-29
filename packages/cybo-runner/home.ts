import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ~/.cybo/
//   agents/        symlinks or dirs, each with cybo.json + soul.md
//   config.json    (future) global defaults — model, thinking, pi-command
const CYBO_HOME = join(homedir(), ".cybo");
const AGENTS_DIR = join(CYBO_HOME, "agents");

export function getCyboHome(): string {
  return CYBO_HOME;
}

export function getAgentsDir(): string {
  return AGENTS_DIR;
}

function ensureAgentsDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

export function resolveAgentBySlug(slug: string): string | null {
  const candidate = join(AGENTS_DIR, slug);
  const real = safeRealpath(candidate);
  if (real && existsSync(join(real, "cybo.json"))) {
    return real;
  }
  return null;
}

export function linkAgent(slug: string, targetDir: string): void {
  ensureAgentsDir();
  const linkPath = join(AGENTS_DIR, slug);
  if (existsSync(linkPath)) {
    const existing = safeRealpath(linkPath) ?? linkPath;
    throw new Error(`"${slug}" already linked → ${existing}\nRun: cybo unlink ${slug}`);
  }
  symlinkSync(resolve(targetDir), linkPath);
}

export function unlinkAgent(slug: string): void {
  const linkPath = join(AGENTS_DIR, slug);
  if (!existsSync(linkPath) && !lstatSync(linkPath).isSymbolicLink()) {
    throw new Error(`"${slug}" is not linked.`);
  }
  unlinkSync(linkPath);
}

export interface RegisteredAgent {
  slug: string;
  name: string;
  model: string;
  target: string;
  symlink: boolean;
}

export function listAgents(): RegisteredAgent[] {
  if (!existsSync(AGENTS_DIR)) return [];

  const entries = readdirSync(AGENTS_DIR).filter((n) => !n.startsWith("."));
  const agents: RegisteredAgent[] = [];

  for (const entry of entries) {
    const entryPath = join(AGENTS_DIR, entry);
    const stat = lstatSync(entryPath);
    const isSymlink = stat.isSymbolicLink();
    const realPath = isSymlink ? safeRealpath(entryPath) : entryPath;
    if (!realPath) continue;

    const manifestPath = join(realPath, "cybo.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      const model = raw.model ? `${raw.provider}/${raw.model}` : (raw.provider ?? "?");
      agents.push({
        slug: entry,
        name: raw.name ?? entry,
        model,
        target: realPath,
        symlink: isSymlink,
      });
    } catch {
      // skip malformed
    }
  }

  return agents;
}

export function resolveDefaultAgent(): string | null {
  if (!existsSync(AGENTS_DIR)) return null;

  const entries = readdirSync(AGENTS_DIR).filter((n) => !n.startsWith("."));
  for (const entry of entries) {
    const entryPath = join(AGENTS_DIR, entry);
    const realPath = safeRealpath(entryPath);
    if (!realPath) continue;

    const manifestPath = join(realPath, "cybo.json");
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (raw.isDefault) return realPath;
    } catch {
      // skip malformed
    }
  }
  return null;
}

function safeRealpath(p: string): string | null {
  try {
    if (lstatSync(p).isSymbolicLink()) {
      const target = readlinkSync(p);
      const resolved = resolve(AGENTS_DIR, target);
      return existsSync(resolved) ? resolved : null;
    }
    return p;
  } catch {
    return null;
  }
}

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

export interface CyboManifest {
  slug: string;
  name: string;
  description?: string;
  role?: string;
  avatar?: string;
  provider: string;
  model?: string;
  soul: string;
  isDefault?: boolean;
}

export interface ResolvedCybo {
  manifest: CyboManifest;
  systemPrompt: string;
  dir: string;
}

export function loadCybo(dir: string): ResolvedCybo {
  const manifestPath = resolve(dir, "cybo.json");
  const raw = readFileSync(manifestPath, "utf-8");
  const manifest: CyboManifest = JSON.parse(raw);

  let systemPrompt: string;
  if (manifest.soul.endsWith(".md")) {
    systemPrompt = readFileSync(resolve(dir, manifest.soul), "utf-8");
  } else {
    systemPrompt = manifest.soul;
  }

  return { manifest, systemPrompt, dir };
}

export function findCyboDir(startDir: string): string | null {
  let current = startDir;
  while (true) {
    try {
      readFileSync(resolve(current, "cybo.json"));
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

// Runtime, repo-scoped, READ-ONLY access to Cyborg7's OWN source tree — the
// self-source companion to docs-index.ts. Mirrors OpenClaw's source-path support:
// when a cybo runs from a git checkout of the monorepo it can inspect the real
// implementation/config/tests to answer deep "how does Cyborg7 do X?" questions
// the published how-to guides don't cover.
//
// All the resolution + the hard path guard live in the shared, dep-free
// @cyborg7/docs-lib package. This file is a thin, cwd-independent wrapper that:
//   1. resolves the repo root once (git-checkout-gated — null for a packaged
//      install, so the cyborg7_read_source MCP tool never registers there), and
//   2. re-exposes a no-arg surface for the MCP tool.
//
// Resolution degrades to a graceful error object and never throws.

import * as docsLib from "@cyborg7/docs-lib";
import type { SourceError, SourceFile, SourceListing } from "@cyborg7/docs-lib";

export type { SourceError, SourceFile, SourceListing };
export { DEFAULT_SOURCE_MAX_BYTES } from "@cyborg7/docs-lib";

// Cache only a successful (non-null) resolution.
let resolvedRoot: string | null = null;
function repoRoot(): string | null {
  if (resolvedRoot) return resolvedRoot;
  const dir = docsLib.resolveCyborg7SourcePath();
  if (dir) resolvedRoot = dir;
  return dir;
}

/** Repo root when running from a git checkout of the monorepo, else null. */
export function resolveSourceDir(): string | null {
  return repoRoot();
}

/** True when the self-source tree is available (git checkout). */
export function hasSourceAccess(): boolean {
  return repoRoot() !== null;
}

/** List a directory under the repo root ("" = root). Repo-scoped; never throws. */
export function listSource(path = ""): SourceListing | SourceError {
  return docsLib.listSource(repoRoot(), path);
}

/** Read one file under the repo root, size-capped. Repo-scoped; never throws. */
export function readSource(path: string, maxBytes?: number): SourceFile | SourceError {
  return docsLib.readSourceFile(repoRoot(), path, maxBytes);
}

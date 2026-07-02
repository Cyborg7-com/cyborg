// Runtime access to the end-user docs corpus that ships in packages/docs
// (Astro Starlight). The docs site is the SINGLE SOURCE OF TRUTH; this module
// reads the SAME markdown files at runtime so the cyborg7_read_docs MCP tool can
// answer a user's "how do I…?" from the published guides — no duplicated copy,
// no build step, no extra dependency.
//
// All the parsing/indexing/search/nav logic now lives in the shared, dep-free
// @cyborg7/docs-lib package (consumed by BOTH this MCP tool AND the docs site).
// This file is a thin, cwd-independent wrapper that:
//   1. resolves the corpus dir once (env CYBORG7_DOCS_DIR override → walk up from
//      the lib module for packages/docs/src/content/docs), and
//   2. re-exposes the same no-arg function surface the MCP tool + tests use.
//
// Resolution degrades to an empty result and never throws — a daemon without the
// docs tree returns "no docs".

import * as docsLib from "@cyborg7/docs-lib";
import type { DocContent, DocSummary, NavSection } from "@cyborg7/docs-lib";

export type { DocContent, DocSummary, NavSection };

// Cache only a successful (non-null) resolution, so a daemon that gains the docs
// tree later still recovers on a subsequent call.
let resolvedDir: string | null = null;
function corpusDir(): string | null {
  if (resolvedDir) return resolvedDir;
  const dir = docsLib.resolveDocsDir();
  if (dir) resolvedDir = dir;
  return dir;
}

/** Resolve the docs corpus directory (packages/docs/src/content/docs), or null. */
export function resolveDocsDir(): string | null {
  return corpusDir();
}

/** Index of every doc: slug + title + summary. Empty when no docs dir. */
export function listDocs(): DocSummary[] {
  return docsLib.listDocs(corpusDir());
}

/** Full markdown body of one doc by slug ("how-to/foo" or bare "foo"), or null. */
export function getDoc(slug: string): DocContent | null {
  return docsLib.getDoc(corpusDir(), slug);
}

/** Keyword search over title, summary, and headings (case-insensitive substring). */
export function searchDocs(query: string): DocSummary[] {
  return docsLib.searchDocs(corpusDir(), query);
}

/** Ordered navigation tree for the corpus (manifest-driven, fail-soft). */
export function getNav(): NavSection[] {
  return docsLib.getNav(corpusDir());
}

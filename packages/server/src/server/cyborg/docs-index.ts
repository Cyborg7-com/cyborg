// Runtime access to the end-user how-to docs that ship in packages/docs
// (Astro Starlight). The docs site is the SINGLE SOURCE OF TRUTH; this module
// reads the SAME markdown files at runtime so the cyborg7_read_docs MCP tool can
// answer a user's "how do I…?" from the published guides — no duplicated copy,
// no build step, no extra dependency.
//
// Access path (the simplest robust approach):
//   1. CYBORG7_DOCS_DIR env var, if set and present — an explicit override that
//      points at the how-to content dir (for deployments that relocate docs).
//   2. Otherwise walk UP from this module's own location (import.meta.url, so it
//      is cwd-independent) for the first ancestor containing
//      `packages/docs/src/content/docs/how-to`. Works from the source tree
//      (relay via tsx, dev daemon) AND a compiled dist/ layout, and across git
//      worktrees.
//   3. If no docs dir is found, every function degrades to an empty result and
//      never throws — a daemon without the docs tree returns "no docs".
//
// Pure + dep-free (node builtins only): safe to import anywhere.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocSummary {
  slug: string;
  title: string;
  summary: string;
}

export interface DocContent extends DocSummary {
  // The how-to body (markdown after the frontmatter) — the user-facing steps.
  markdown: string;
}

const REL_HOW_TO = join("packages", "docs", "src", "content", "docs", "how-to");

// Resolve the how-to docs directory, or null when it can't be found.
export function resolveDocsDir(): string | null {
  const override = process.env.CYBORG7_DOCS_DIR;
  if (override && existsSync(override)) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, REL_HOW_TO);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

interface ParsedDoc {
  title: string;
  description: string;
  body: string;
  headings: string[];
}

// Minimal frontmatter reader: pulls `title` / `description` from a leading
// `---` block (these seed docs use simple `key: value` lines) and returns the
// body after it. Not a general YAML parser — intentionally tiny + dep-free.
function parseDoc(raw: string): ParsedDoc {
  // Strip a leading UTF-8 BOM (some Windows editors add one) so the "---"
  // frontmatter check below still matches.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let title = "";
  let description = "";
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const fm = raw.slice(3, end);
      body = raw.slice(end + 4).replace(/^\r?\n/, "");
      for (const line of fm.split(/\r?\n/)) {
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key === "title") title = value;
        else if (key === "description") description = value;
      }
    }
  }
  const headings: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) headings.push(m[1]);
  }
  return { title, description, body, headings };
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (text && !text.startsWith("#")) return text.replace(/\s+/g, " ");
  }
  return "";
}

// The how-to docs are static at runtime; parse them once and reuse. Only a
// successful read is cached, so a daemon that gains the docs tree later recovers.
let cachedDocs: Array<{ slug: string } & ParsedDoc> | null = null;

function readAll(): Array<{ slug: string } & ParsedDoc> {
  if (cachedDocs) return cachedDocs;
  const dir = resolveDocsDir();
  if (!dir) return [];
  const out: Array<{ slug: string } & ParsedDoc> = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const slugBase = file.slice(0, -3);
    let raw: string;
    try {
      raw = readFileSync(join(dir, file), "utf8");
    } catch {
      continue; // unreadable file — skip rather than fail the whole list
    }
    out.push({ slug: `how-to/${slugBase}`, ...parseDoc(raw) });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  cachedDocs = out;
  return out;
}

function toSummary(d: { slug: string } & ParsedDoc): DocSummary {
  return {
    slug: d.slug,
    title: d.title || d.slug,
    summary: d.description || firstParagraph(d.body),
  };
}

// Index of every how-to doc: slug + title + summary. Empty when no docs dir.
export function listDocs(): DocSummary[] {
  return readAll().map(toSummary);
}

// Full markdown body of one doc by slug ("how-to/foo" or bare "foo"), or null.
export function getDoc(slug: string): DocContent | null {
  // Internal doc links carry a trailing slash ("/how-to/foo/"); normalize so an
  // agent that pastes a link back into getDoc still resolves it.
  const cleanSlug = slug.replace(/\/+$/, "");
  const want = cleanSlug.startsWith("how-to/") ? cleanSlug : `how-to/${cleanSlug}`;
  const found = readAll().find((d) => d.slug === want);
  if (!found) return null;
  return { ...toSummary(found), markdown: found.body.trim() };
}

// Keyword search over title, summary, and headings (case-insensitive substring).
export function searchDocs(query: string): DocSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return readAll()
    .filter((d) => {
      const hay = [d.title, d.description, firstParagraph(d.body), ...d.headings, d.slug]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    })
    .map(toSummary);
}

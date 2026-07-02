// @cyborg7/docs-lib — the single source of truth for the Cyborg7 Markdown docs
// corpus. Both consumers read the SAME files through this library:
//   (a) the cybo MCP introspection tool (`cyborg7_read_docs`) — reads the corpus
//       at runtime to answer a user's "how do I…?" from the published guides;
//   (b) the docs site (packages/docs, Astro Starlight) — publishes the same tree.
//
// This mirrors OpenClaw, whose `docs/` corpus is read at runtime by the agent AND
// published as a site — no duplicated copy, no build step, no extra dependency.
//
// Pure + dependency-free (node builtins only): safe to import anywhere. Every
// function is fail-soft (missing dir / unreadable file → empty result, never a
// throw) and cwd-independent (resolution walks up from this module's own URL).

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Public types ───────────────────────────────────────────────

export interface DocSummary {
  /** Stable corpus slug: "<category>/<file>" (e.g. "how-to/sign-up"), POSIX "/". */
  slug: string;
  title: string;
  summary: string;
}

export interface DocContent extends DocSummary {
  /** The doc body (markdown after the frontmatter) — the user-facing content. */
  markdown: string;
}

export interface NavItem {
  slug: string;
  title: string;
}

export interface NavSection {
  label: string;
  /** Corpus category folder this section maps to, when derivable. */
  category?: string;
  items: NavItem[];
}

export interface ResolveDocsDirOptions {
  /** Explicit corpus dir; wins if it exists. Bypasses the env var + upward walk. */
  override?: string;
  /** Env var consulted for an override path. Default: "CYBORG7_DOCS_DIR". */
  envVar?: string;
  /** Where the upward walk starts. Default: this module's own directory. */
  startDir?: string;
  /** How many ancestors to probe before giving up. Default: 12. */
  maxDepth?: number;
}

// The canonical corpus location inside the monorepo. Both the source tree
// (relay via tsx, dev daemon) and a compiled dist/ layout sit under an ancestor
// that contains this relative path, and it survives git worktrees.
const REL_CORPUS = join("packages", "docs", "src", "content", "docs");

const DOC_EXTENSIONS = [".md", ".mdx"];

// ─── Resolution ─────────────────────────────────────────────────

/**
 * Resolve the docs corpus directory (packages/docs/src/content/docs), or null
 * when it can't be found. Order: explicit override → env var → walk UP from this
 * module for the first ancestor containing the corpus. Never throws.
 */
export function resolveDocsDir(opts: ResolveDocsDirOptions = {}): string | null {
  const envVar = opts.envVar ?? "CYBORG7_DOCS_DIR";
  const override = opts.override ?? process.env[envVar];
  if (override && existsSync(override)) return override;

  let dir = opts.startDir ?? dirname(fileURLToPath(import.meta.url));
  const maxDepth = opts.maxDepth ?? 12;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = join(dir, REL_CORPUS);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return null;
}

// ─── Frontmatter + parsing ──────────────────────────────────────

interface ParsedDoc {
  title: string;
  description: string;
  /** Optional explicit ordinal from frontmatter `order:` — nav sort hint. */
  order: number | null;
  /** Optional explicit `category:` from frontmatter (else the folder is used). */
  categoryHint: string | null;
  body: string;
  headings: string[];
}

interface DocEntry extends ParsedDoc {
  slug: string;
  /** Top-level corpus folder ("" for a root-level doc). */
  category: string;
}

// Minimal frontmatter reader: pulls flat `key: value` lines from a leading `---`
// block (title / description / order / category) and returns the body after it.
// Not a general YAML parser — intentionally tiny + dep-free.
// Apply one `key: value` frontmatter line to the accumulating fields (mutates).
function applyFrontmatterLine(fields: Omit<ParsedDoc, "body" | "headings">, line: string): void {
  const idx = line.indexOf(":");
  if (idx === -1) return;
  const key = line.slice(0, idx).trim();
  let value = line.slice(idx + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (key === "title") fields.title = value;
  else if (key === "description") fields.description = value;
  else if (key === "category") fields.categoryHint = value;
  else if (key === "order" || key === "sidebar_order") {
    const n = Number(value);
    fields.order = Number.isFinite(n) ? n : fields.order;
  }
}

function parseDoc(input: string): ParsedDoc {
  let raw = input;
  // Strip a leading UTF-8 BOM (some editors add one) so the "---" check matches.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const fields = { title: "", description: "", order: null, categoryHint: null } as Omit<
    ParsedDoc,
    "body" | "headings"
  >;
  let body = raw;

  const end = raw.startsWith("---") ? raw.indexOf("\n---", 3) : -1;
  if (end !== -1) {
    const fm = raw.slice(3, end);
    body = raw.slice(end + 4).replace(/^\r?\n/, "");
    for (const line of fm.split(/\r?\n/)) applyFrontmatterLine(fields, line);
  }

  const headings: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) headings.push(m[1]);
  }
  return { ...fields, body, headings };
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (text && !text.startsWith("#") && !text.startsWith("import ")) {
      return text.replace(/\s+/g, " ");
    }
  }
  return "";
}

// ─── Corpus walk (cached per baseDir) ───────────────────────────

const corpusCache = new Map<string, DocEntry[]>();

function isDocFile(name: string): boolean {
  return DOC_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function stripExt(name: string): string {
  for (const ext of DOC_EXTENSIONS) {
    if (name.endsWith(ext)) return name.slice(0, -ext.length);
  }
  return name;
}

// Recursively collect every markdown doc under baseDir. Unreadable files/dirs are
// skipped (fail-soft) rather than aborting the whole walk.
function walk(baseDir: string, dir: string, out: DocEntry[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue; // skip dotfiles/dirs
    const full = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(baseDir, full, out);
      continue;
    }
    if (!stat.isFile() || !isDocFile(name)) continue;
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const rel = relative(baseDir, full);
    const slug = stripExt(rel).split(sep).join("/");
    const category = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "";
    out.push({ slug, category, ...parseDoc(raw) });
  }
}

function readAll(baseDir: string): DocEntry[] {
  const cached = corpusCache.get(baseDir);
  if (cached) return cached;
  const out: DocEntry[] = [];
  walk(baseDir, baseDir, out);
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  // Only a non-empty (successful) read is cached, so a daemon that gains the docs
  // tree later still recovers on a subsequent call.
  if (out.length > 0) corpusCache.set(baseDir, out);
  return out;
}

/** Clear the in-memory corpus cache (mainly for tests / hot content reloads). */
export function clearDocsCache(): void {
  corpusCache.clear();
}

function toSummary(d: DocEntry): DocSummary {
  return {
    slug: d.slug,
    title: d.title || d.slug,
    summary: d.description || firstParagraph(d.body),
  };
}

// ─── Public API ─────────────────────────────────────────────────

/** Index of every doc in the corpus: slug + title + summary. Empty on no corpus. */
export function listDocs(baseDir: string | null): DocSummary[] {
  if (!baseDir) return [];
  return readAll(baseDir).map(toSummary);
}

/**
 * Full body of one doc by slug. Accepts an exact slug ("how-to/foo"), a bare
 * filename ("foo" — resolved anywhere in the tree, preferring how-to/ for
 * backward compat), and tolerates a trailing slash (as internal doc links carry).
 * Returns null when nothing matches.
 */
export function getDoc(baseDir: string | null, slug: string): DocContent | null {
  if (!baseDir) return null;
  const clean = slug.replace(/\/+$/, "");
  const all = readAll(baseDir);
  let found = all.find((d) => d.slug === clean);
  if (!found && !clean.includes("/")) {
    // Bare slug: prefer a how-to guide (legacy MCP contract), else any doc whose
    // filename matches under any category.
    found =
      all.find((d) => d.slug === `how-to/${clean}`) ??
      all.find((d) => d.slug.endsWith(`/${clean}`));
  }
  if (!found) return null;
  return { ...toSummary(found), markdown: found.body.trim() };
}

/** Keyword search over title, summary, headings, and slug (case-insensitive). */
export function searchDocs(baseDir: string | null, query: string): DocSummary[] {
  if (!baseDir) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return readAll(baseDir)
    .filter((d) => {
      const hay = [d.title, d.description, firstParagraph(d.body), ...d.headings, d.slug]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    })
    .map(toSummary);
}

// ─── Navigation / hierarchy ─────────────────────────────────────

interface ManifestSection {
  label: string;
  category?: string;
  items?: string[];
}
interface Manifest {
  nav?: ManifestSection[];
}

function titleCase(category: string): string {
  if (!category) return "General";
  return category
    .split(/[-_/]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Group the leftover docs (not referenced by the manifest) by category so the nav
// stays complete even when the manifest omits a new doc. Root-level docs (empty
// category, e.g. a splash index page) are intentionally omitted from nav.
function appendLeftovers(all: DocEntry[], used: Set<string>, sections: NavSection[]): void {
  const byCategory = new Map<string, DocEntry[]>();
  for (const d of all) {
    if (used.has(d.slug) || d.category === "") continue;
    const bucket = byCategory.get(d.category) ?? [];
    bucket.push(d);
    byCategory.set(d.category, bucket);
  }
  for (const category of [...byCategory.keys()].sort()) {
    const items = sortEntries(byCategory.get(category) ?? []).map((d) => ({
      slug: d.slug,
      title: d.title || d.slug,
    }));
    if (items.length) sections.push({ label: titleCase(category), category, items });
  }
}

function sortEntries(entries: DocEntry[]): DocEntry[] {
  return [...entries].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY;
    const bo = b.order ?? Number.POSITIVE_INFINITY;
    if (ao !== bo) return ao - bo;
    return (a.title || a.slug).localeCompare(b.title || b.slug);
  });
}

// Derive nav purely from the filesystem when there's no manifest: one section per
// top-level category folder, ordered alphabetically, docs ordered by frontmatter
// `order:` then title.
function deriveNav(all: DocEntry[]): NavSection[] {
  const byCategory = new Map<string, DocEntry[]>();
  for (const d of all) {
    if (d.category === "") continue; // omit root-level docs from nav
    const bucket = byCategory.get(d.category) ?? [];
    bucket.push(d);
    byCategory.set(d.category, bucket);
  }
  const sections: NavSection[] = [];
  for (const category of [...byCategory.keys()].sort()) {
    const items = sortEntries(byCategory.get(category) ?? []).map((d) => ({
      slug: d.slug,
      title: d.title || d.slug,
    }));
    sections.push({ label: titleCase(category), category, items });
  }
  return sections;
}

/**
 * Ordered navigation tree for the corpus. If `manifest.json` exists at the corpus
 * root it drives section order/labels/membership (see the corpus README); any doc
 * it omits is appended, grouped by category, so nav is never lossy. With no
 * manifest, nav is derived from the folder structure + frontmatter. Fail-soft:
 * a malformed manifest falls back to the derived nav.
 */
// Build nav sections from a parsed manifest against the corpus. Slugs that don't
// resolve to a real doc are skipped (fail-soft); `used` records every doc that a
// section claimed so leftovers can be appended afterward.
function buildManifestSections(
  manifest: Manifest,
  bySlug: Map<string, DocEntry>,
  used: Set<string>,
): NavSection[] {
  const sections: NavSection[] = [];
  for (const sec of manifest.nav ?? []) {
    const items: NavItem[] = [];
    for (const slug of sec.items ?? []) {
      const d = bySlug.get(slug);
      if (!d) continue; // missing doc → skip (fail-soft), don't throw
      items.push({ slug: d.slug, title: d.title || d.slug });
      used.add(d.slug);
    }
    if (items.length) sections.push({ label: sec.label, category: sec.category, items });
  }
  return sections;
}

export function getNav(baseDir: string | null): NavSection[] {
  if (!baseDir) return [];
  const all = readAll(baseDir);
  if (all.length === 0) return [];

  const manifestPath = join(baseDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      const bySlug = new Map(all.map((d) => [d.slug, d]));
      const used = new Set<string>();
      const sections = buildManifestSections(manifest, bySlug, used);
      appendLeftovers(all, used, sections);
      return sections;
    } catch {
      // Malformed manifest — fall through to the derived nav.
    }
  }
  return deriveNav(all);
}

// ─── Self-source access (repo-scoped, read-only) ────────────────
//
// Mirrors OpenClaw's resolveOpenClawSourcePath: when a cybo runs from a git
// checkout of the monorepo, expose the repo root so it can read its OWN source
// (implementation, config, tests) to answer deep "how does Cyborg7 do X?"
// questions the published how-to guides don't cover. Returns null for a packaged
// (non-checkout) install so the source tool is never registered there.
//
// Everything here is a HARD repo-scoped, read-only guard: a requested path is
// resolved against the repo root and rejected if it escapes it (`..`, absolute
// paths outside, or a symlink that points out of the tree). Never throws.

// The monorepo root is the pnpm workspace root; `.git` (a dir in a normal clone,
// a FILE in a git worktree — existsSync covers both) marks a real checkout.
const REPO_ROOT_MARKER = "pnpm-workspace.yaml";

export interface ResolveSourcePathOptions {
  /** Explicit repo root; wins if it exists. Bypasses env var + upward walk. */
  override?: string;
  /** Env var consulted for an override path. Default: "CYBORG7_SOURCE_DIR". */
  envVar?: string;
  /** Where the upward walk starts. Default: this module's own directory. */
  startDir?: string;
  /** How many ancestors to probe before giving up. Default: 12. */
  maxDepth?: number;
}

/**
 * Walk UP for the monorepo root (the dir holding pnpm-workspace.yaml). Returns
 * the root even without a `.git` — use resolveCyborg7SourcePath for the
 * git-checkout-gated variant. Never throws.
 */
export function resolveRepoRoot(opts: ResolveSourcePathOptions = {}): string | null {
  const envVar = opts.envVar ?? "CYBORG7_SOURCE_DIR";
  const override = opts.override ?? process.env[envVar];
  if (override && existsSync(override)) return override;

  let dir = opts.startDir ?? dirname(fileURLToPath(import.meta.url));
  const maxDepth = opts.maxDepth ?? 12;
  for (let i = 0; i < maxDepth; i++) {
    if (existsSync(join(dir, REPO_ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Repo root when running from a git checkout of the monorepo, else null (mirrors
 * OpenClaw's resolveOpenClawSourcePath). A packaged/npm install returns null, so
 * the self-source MCP tool stays unregistered outside a checkout.
 */
export function resolveCyborg7SourcePath(opts: ResolveSourcePathOptions = {}): string | null {
  const root = resolveRepoRoot(opts);
  if (!root) return null;
  return existsSync(join(root, ".git")) ? root : null;
}

// The read-only guard. Resolve `requested` against `rootDir` and return the
// absolute path ONLY when it stays inside the root; null on any escape. This is
// the single chokepoint every source read/list passes through.
//   - absolute paths outside the root  → resolve() keeps them absolute → relative
//     starts with ".."               → rejected
//   - "../" traversal                  → relative starts with ".."      → rejected
//   - symlink pointing outside         → realpath re-check              → rejected
function resolveWithinRoot(rootDir: string, requested: string): string | null {
  const root = resolve(rootDir);
  const req = requested.trim();
  // Empty / "." → the root itself.
  if (req === "" || req === ".") return root;
  // Absolute paths are rejected outright — this tool is strictly repo-relative, so
  // anything absolute (even "/foo") is treated as an escape rather than reinterpreted.
  if (isAbsolute(req)) return null;
  const target = resolve(root, req);
  const rel = relative(root, target);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
  // Defeat symlink escapes: if the target (or its nearest existing ancestor)
  // realpaths outside the root, reject.
  const realRoot = safeRealpath(root);
  const realTarget = safeRealpath(target);
  if (realRoot && realTarget) {
    const realRel = relative(realRoot, realTarget);
    if (realRel !== "" && (realRel.startsWith("..") || isAbsolute(realRel))) return null;
  }
  return target;
}

// realpath the deepest existing ancestor of `p` (so a not-yet-existing leaf under
// a real dir still resolves its parent). Returns null if nothing resolves.
function safeRealpath(p: string): string | null {
  let cur = p;
  for (let i = 0; i < 64; i++) {
    try {
      return realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
  return null;
}

export interface SourceEntry {
  name: string;
  type: "file" | "dir";
  /** File size in bytes (files only). */
  size?: number;
}
export interface SourceListing {
  /** POSIX-relative dir path from the repo root ("" = root). */
  dir: string;
  entries: SourceEntry[];
}
export interface SourceFile {
  /** POSIX-relative file path from the repo root. */
  path: string;
  size: number;
  /** True when the body was cut at the byte cap. */
  truncated: boolean;
  content: string;
}
export interface SourceError {
  error: string;
}

// Listings hide these noisy/irrelevant trees (still readable via an explicit
// `get` if a caller really targets one — the guard, not this list, is security).
const SOURCE_LIST_SKIP = new Set([".git", "node_modules", "dist", ".turbo", ".astro"]);

// Files whose CONTENTS commonly hold secrets. Even though they live INSIDE the
// repo (so the path guard admits them), they are never readable via the source
// tool and are hidden from listings — the guard stops filesystem escapes, this
// stops in-repo secret exfiltration to a cybo. Matched on the basename,
// case-insensitively.
const SECRET_FILE_RE =
  /^\.env(\..+)?$|\.(pem|key|p12|pfx|keystore)$|^id_(rsa|ed25519|ecdsa)$|^\.npmrc$|(^|\.)secrets?(\.|$)|^credentials(\.json)?$|^\.git-credentials$/i;

/** True when a basename looks like a secret-bearing file (denied by the source tool). */
export function isSecretFileName(name: string): boolean {
  return SECRET_FILE_RE.test(name);
}

/** Default byte cap for a single source file read (64 KiB). */
export const DEFAULT_SOURCE_MAX_BYTES = 64 * 1024;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** List a directory UNDER the repo root. Repo-scoped; never throws. */
export function listSource(rootDir: string | null, requested = ""): SourceListing | SourceError {
  if (!rootDir) return { error: "source tree unavailable (not a git checkout)" };
  const target = resolveWithinRoot(rootDir, requested);
  if (!target) return { error: `path escapes the repository root: ${requested}` };
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(target);
  } catch {
    return { error: `no such path: ${requested}` };
  }
  if (!stat.isDirectory()) return { error: `not a directory: ${requested}` };
  let names: string[];
  try {
    names = readdirSync(target);
  } catch {
    return { error: `cannot read directory: ${requested}` };
  }
  const entries: SourceEntry[] = [];
  for (const name of names.sort()) {
    if (SOURCE_LIST_SKIP.has(name)) continue;
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(join(target, name));
    } catch {
      continue;
    }
    if (s.isDirectory()) entries.push({ name, type: "dir" });
    else if (s.isFile() && !isSecretFileName(name))
      entries.push({ name, type: "file", size: s.size });
  }
  return { dir: toPosix(relative(resolve(rootDir), target)), entries };
}

/** Read one file UNDER the repo root, size-capped. Repo-scoped; never throws. */
export function readSourceFile(
  rootDir: string | null,
  requested: string,
  maxBytes = DEFAULT_SOURCE_MAX_BYTES,
): SourceFile | SourceError {
  if (!rootDir) return { error: "source tree unavailable (not a git checkout)" };
  if (!requested || !requested.trim()) return { error: "a file path is required" };
  const target = resolveWithinRoot(rootDir, requested);
  if (!target) return { error: `path escapes the repository root: ${requested}` };
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(target);
  } catch {
    return { error: `no such file: ${requested}` };
  }
  if (stat.isDirectory()) return { error: `is a directory, not a file: ${requested}` };
  if (!stat.isFile()) return { error: `not a regular file: ${requested}` };
  if (isSecretFileName(basename(target))) {
    return { error: `reading this file is not permitted (potential secret): ${requested}` };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(target);
  } catch {
    return { error: `cannot read file: ${requested}` };
  }
  const truncated = buf.length > maxBytes;
  const content = (truncated ? buf.subarray(0, maxBytes) : buf).toString("utf8");
  return {
    path: toPosix(relative(resolve(rootDir), target)),
    size: stat.size,
    truncated,
    content,
  };
}

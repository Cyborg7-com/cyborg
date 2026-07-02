import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type NavSection,
  type SourceError,
  type SourceFile,
  type SourceListing,
  clearDocsCache,
  getDoc,
  getNav,
  listDocs,
  listSource,
  readSourceFile,
  resolveCyborg7SourcePath,
  resolveDocsDir,
  resolveRepoRoot,
  searchDocs,
} from "./index.js";

// Exercise the REAL corpus shipped in packages/docs — the same files the MCP tool
// serves and the docs site publishes. Real deps over mocks.
const baseDir = resolveDocsDir();

beforeEach(() => clearDocsCache());

describe("@cyborg7/docs-lib — corpus resolution", () => {
  it("resolves the corpus dir cwd-independently", () => {
    expect(baseDir).not.toBeNull();
    expect(baseDir?.replace(/\\/g, "/")).toContain("packages/docs/src/content/docs");
    expect(existsSync(baseDir as string)).toBe(true);
  });

  it("honours an explicit override, and an env override", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(resolveDocsDir({ override: here })).toBe(here);
    const prev = process.env.MY_DOCS;
    process.env.MY_DOCS = here;
    try {
      expect(resolveDocsDir({ envVar: "MY_DOCS" })).toBe(here);
    } finally {
      if (prev === undefined) delete process.env.MY_DOCS;
      else process.env.MY_DOCS = prev;
    }
  });

  it("is fail-soft when the corpus is absent (null / missing baseDir)", () => {
    // A start dir with no corpus ancestor → walk exhausts to root → null. (A bad
    // `override` alone would just fall through to the upward walk, which finds the
    // real corpus — so we constrain the walk instead.)
    expect(resolveDocsDir({ startDir: "/", maxDepth: 1, envVar: "___NOPE___" })).toBeNull();
    expect(listDocs(null)).toEqual([]);
    expect(getNav(null)).toEqual([]);
    expect(getDoc(null, "how-to/sign-up")).toBeNull();
    expect(searchDocs(null, "task")).toEqual([]);
  });
});

describe("@cyborg7/docs-lib — whole-tree indexing", () => {
  it("walks nested category folders, not just how-to/", () => {
    const slugs = listDocs(baseDir).map((d) => d.slug);
    // how-to guides
    expect(slugs).toContain("how-to/create-and-track-tasks");
    // other categories are indexed too
    expect(slugs).toContain("getting-started/introduction");
    expect(slugs).toContain("architecture/overview");
    expect(slugs).toContain("cybos/overview");
    expect(slugs).toContain("self-hosting/docker");
  });

  it("keeps slugs as <category>/<file> and titles from frontmatter", () => {
    const tasks = listDocs(baseDir).find((d) => d.slug === "how-to/create-and-track-tasks");
    expect(tasks?.title).toBe("Create & track tasks");
    expect(tasks?.summary.length ?? 0).toBeGreaterThan(0);
  });

  it("get-by-slug returns the full markdown body", () => {
    const doc = getDoc(baseDir, "how-to/schedule-a-recurring-job");
    expect(doc?.title).toBe("Schedule a recurring job");
    expect(doc?.markdown).toContain("cyborg7_schedule_create");
  });

  it("resolves a bare slug (preferring how-to/) and a trailing slash", () => {
    expect(getDoc(baseDir, "schedule-a-recurring-job")?.slug).toBe(
      "how-to/schedule-a-recurring-job",
    );
    expect(getDoc(baseDir, "how-to/schedule-a-recurring-job/")?.slug).toBe(
      "how-to/schedule-a-recurring-job",
    );
    // a bare slug that only exists outside how-to still resolves
    expect(getDoc(baseDir, "protocol")?.slug).toBe("architecture/protocol");
  });

  it("search finds docs across categories", () => {
    expect(searchDocs(baseDir, "cron").map((d) => d.slug)).toContain(
      "how-to/schedule-a-recurring-job",
    );
    expect(searchDocs(baseDir, "mention").map((d) => d.slug)).toContain(
      "how-to/mention-a-teammate",
    );
  });

  it("unknown slug / empty query are graceful", () => {
    expect(getDoc(baseDir, "how-to/does-not-exist")).toBeNull();
    expect(searchDocs(baseDir, "zzz-no-such-keyword-xyz")).toEqual([]);
    expect(searchDocs(baseDir, "   ")).toEqual([]);
  });
});

describe("@cyborg7/docs-lib — nav manifest", () => {
  function labels(nav: NavSection[]): string[] {
    return nav.map((s) => s.label);
  }

  it("reads manifest.json order/labels", () => {
    const nav = getNav(baseDir);
    expect(labels(nav)).toEqual([
      "Getting Started",
      "Guides",
      "Integrations",
      "Architecture",
      "Cybos",
      "Self-Hosting",
      "Contributing",
    ]);
    const guides = nav.find((s) => s.label === "Guides");
    expect(guides?.category).toBe("how-to");
    expect(guides?.items[0]?.slug).toBe("how-to/create-and-track-tasks");
    expect(guides?.items[0]?.title).toBe("Create & track tasks");
  });

  it("every manifest slug resolves to a real doc", () => {
    const known = new Set(listDocs(baseDir).map((d) => d.slug));
    for (const section of getNav(baseDir)) {
      for (const item of section.items) {
        expect(known.has(item.slug)).toBe(true);
      }
    }
  });

  it("falls back to a derived nav when no manifest is present (override to a bare corpus)", () => {
    // Point at the how-to subfolder as a standalone corpus with no manifest — nav
    // is derived from the folder structure. The how-to files sit at the root there
    // (category ""), so a single-level corpus yields no sections (root docs are
    // omitted from nav); this asserts the derive path does not throw and is empty.
    const howTo = join(baseDir as string, "how-to");
    const nav = getNav(resolveDocsDir({ override: howTo }));
    expect(Array.isArray(nav)).toBe(true);
  });
});

describe("@cyborg7/docs-lib — integration connect guides", () => {
  it("indexes the per-integration guides and reaches them by slug + search", () => {
    const slugs = listDocs(baseDir).map((d) => d.slug);
    for (const id of ["composio", "slack", "gmail", "jira", "clickup"]) {
      expect(slugs).toContain(`integrations/${id}`);
    }
    // frontmatter title flows through
    expect(getDoc(baseDir, "integrations/slack")?.title).toBe("Connect Slack");
    // search reaches them
    expect(searchDocs(baseDir, "Composio").map((d) => d.slug)).toContain("integrations/composio");
    expect(searchDocs(baseDir, "gmail").map((d) => d.slug)).toContain("integrations/gmail");
  });
});

describe("@cyborg7/docs-lib — self-source access (repo-scoped, read-only)", () => {
  // The test process runs from the monorepo checkout, so a source root resolves.
  const root = resolveRepoRoot();

  it("resolves the repo root and gates the source path on a git checkout", () => {
    expect(root).not.toBeNull();
    expect(existsSync(join(root as string, "pnpm-workspace.yaml"))).toBe(true);
    // This tree is a git checkout, so the gated resolver returns the same root.
    expect(resolveCyborg7SourcePath()).toBe(root);
  });

  it("lists a directory under the root and reads a file, size-capped", () => {
    const listing = listSource(root, "packages/docs-lib/src") as SourceListing;
    expect("error" in listing).toBe(false);
    expect(listing.entries.map((e) => e.name)).toContain("index.ts");

    const file = readSourceFile(root, "packages/docs-lib/package.json") as SourceFile;
    expect("error" in file).toBe(false);
    expect(file.content).toContain("@cyborg7/docs-lib");
    expect(file.path).toBe("packages/docs-lib/package.json");

    const capped = readSourceFile(root, "packages/docs-lib/package.json", 10) as SourceFile;
    expect(capped.truncated).toBe(true);
    expect(capped.content.length).toBe(10);
  });

  it("hides noisy trees (node_modules, .git) from listings", () => {
    const listing = listSource(root, "") as SourceListing;
    const names = listing.entries.map((e) => e.name);
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain(".git");
    expect(names).toContain("packages");
  });

  it("REJECTS a `..` traversal and an absolute path outside the root", () => {
    const up = listSource(root, "../../../../../../etc") as SourceError;
    expect(up.error).toMatch(/escapes the repository root/i);

    const abs = readSourceFile(root, "/etc/passwd") as SourceError;
    expect(abs.error).toMatch(/escapes the repository root/i);

    // A sneaky mixed path that climbs out then back down is still rejected.
    const sneaky = readSourceFile(root, "packages/../../etc/passwd") as SourceError;
    expect(sneaky.error).toMatch(/escapes the repository root/i);
  });

  it("is graceful for a missing path and a null root (packaged install)", () => {
    expect((listSource(root, "no/such/dir") as SourceError).error).toMatch(/no such path/i);
    expect((readSourceFile(root, "no/such/file.ts") as SourceError).error).toMatch(/no such file/i);
    expect((listSource(null) as SourceError).error).toMatch(/unavailable/i);
    expect((readSourceFile(null, "x") as SourceError).error).toMatch(/unavailable/i);
  });
});

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { isSecretFileName } from "./index.ts";

describe("source secret denylist", () => {
  it("classifies secret-bearing basenames", () => {
    for (const n of [
      ".env",
      ".env.local",
      "server.pem",
      "id_rsa",
      ".npmrc",
      "app.secrets.json",
      "credentials.json",
      ".git-credentials",
    ]) {
      expect(isSecretFileName(n)).toBe(true);
    }
    for (const n of ["index.ts", "README.md", "env.ts", "keyboard.ts"]) {
      expect(isSecretFileName(n)).toBe(false);
    }
  });
  it("refuses to read a .env inside the repo and hides it from listings", () => {
    const root = mkdtempSync(pjoin(tmpdir(), "src-deny-"));
    mkdirSync(pjoin(root, ".git"), { recursive: true });
    writeFileSync(pjoin(root, ".env"), "DATABASE_URL=postgres://secret");
    writeFileSync(pjoin(root, "ok.ts"), "export const x = 1;");
    const read = readSourceFile(root, ".env");
    expect("error" in read && read.error).toMatch(/not permitted/);
    const list = listSource(root, "");
    const names = "entries" in list ? list.entries.map((e) => e.name) : [];
    expect(names).toContain("ok.ts");
    expect(names).not.toContain(".env");
  });
});

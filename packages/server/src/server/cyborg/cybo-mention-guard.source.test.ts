import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Anti-recurrence guard for the mention-invocation bug family (ghost sessions,
// double responses — 2026-06-12 incident). The family's shape: a NEW code path
// resolves/invokes cybo mentions on its own, skipping the shared resolver, the
// shared prompt, or the per-message invocation dedup. The literal regression
// tests protect the known instances; THIS test fails when instance N+1 is
// written. If it fails: route the new path through cybo-mention-invoke.ts
// (resolveMentionedCybos / buildMentionPrompt / mentionInvocationGuard).

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESOLVER_FILE = "server/cyborg/cybo-mention-invoke.ts";

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

const files = listSourceFiles(SRC_ROOT).map((f) => ({
  rel: relative(SRC_ROOT, f),
  text: readFileSync(f, "utf-8"),
}));

describe("mention-invocation bug-family guard (source scan)", () => {
  it("the mention→cybo resolver is declared ONLY in cybo-mention-invoke.ts", () => {
    const offenders = files
      .filter((f) => /function resolveMentionedCybo|const resolveMentionedCybo/.test(f.text))
      .map((f) => f.rel)
      .filter((rel) => rel !== RESOLVER_FILE);
    expect(offenders).toEqual([]);
  });

  it("the mention prompt is built ONLY by buildMentionPrompt (no inline copies)", () => {
    // The prompt's signature literal. A surface that re-declares it has forked
    // the prompt — the exact drift that made the two 2026-06-12 responders
    // behave differently.
    const offenders = files
      .filter((f) => f.text.includes("You were @-mentioned"))
      .map((f) => f.rel)
      .filter((rel) => rel !== RESOLVER_FILE);
    expect(offenders).toEqual([]);
  });

  it("every mention-invocation path consults the shared invocation dedup guard", () => {
    // A file participates in mention invocation if it handles the forwarded
    // invoke or calls the local-mode invoker. Each one must reference the
    // process-wide mentionInvocationGuard — otherwise the same message can
    // summon the same cybo twice (the double-response incident).
    const invokers = files.filter(
      (f) =>
        f.rel !== RESOLVER_FILE &&
        (f.text.includes('"cyborg:invoke_cybo_mention"') ||
          /\binvokeMentionedCybos\(/.test(f.text)),
    );
    expect(invokers.length).toBeGreaterThan(0); // the scan itself must see the known paths
    const missingGuard = invokers
      .filter((f) => !f.text.includes("mentionInvocationGuard.shouldInvoke("))
      .map((f) => f.rel)
      // cyborg-messages.ts only DECLARES the schema literal; it routes nothing.
      // relay-standalone.ts BUILDS the forwarded invoke but runs in a different
      // process — it can't share the daemon's in-process guard. Its dedup is
      // delegated to the receiving daemon via the messageId it forwards.
      .filter(
        (rel) =>
          rel !== "server/cyborg/cyborg-messages.ts" && rel !== "server/cyborg/relay-standalone.ts",
      );
    expect(missingGuard).toEqual([]);
  });

  it("#637: every path that resolves mentions handles unresolvableMembers (no silent cross-workspace drop)", () => {
    // The #637 regression shape: a channel cybo MEMBER that lives in another
    // workspace falls out of the workspace-scoped roster, so it can be neither
    // named nor routed here. The resolver surfaces it as `unresolvableMembers`;
    // a path that destructures the resolver result but ignores that bucket
    // re-introduces the silent no-op. Each orchestration path (the relay
    // orchestrator and the daemon's local-mode invoker) MUST reference it.
    const orchestrators = files.filter(
      (f) =>
        f.rel !== RESOLVER_FILE &&
        // A path that drives invocation off the rich resolver result.
        f.text.includes("resolveMentionedCybos(") &&
        /\binvoke\b/.test(f.text),
    );
    expect(orchestrators.length).toBeGreaterThan(0); // the scan must see the known paths
    const dropsCrossWorkspace = orchestrators
      .filter((f) => !f.text.includes("unresolvableMembers"))
      .map((f) => f.rel);
    expect(dropsCrossWorkspace).toEqual([]);
  });

  it("ephemeral spawns are invisible: spawnCybo marks them internal + non-persisted", () => {
    // The visibility contract lives in ONE place (cybo-manager.spawnCybo). If
    // these markers disappear, mention/slash sessions become joinable sidebar
    // sessions again on every member's client.
    const manager = files.find((f) => f.rel === "server/cyborg/cybo-manager.ts");
    expect(manager).toBeDefined();
    expect(manager!.text).toContain("...(ephemeral ? { internal: true } : {})");
    expect(manager!.text).toContain("...(ephemeral ? { persistSession: false } : {})");
  });
});

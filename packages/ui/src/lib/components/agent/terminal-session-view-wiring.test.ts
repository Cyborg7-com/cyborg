import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for #673: TerminalSessionView lazy-globbed "./TerminalView.svelte"
// but the emulator lives in ../terminal/, so the glob no-matched and the view
// rendered EMPTY. This asserts the wiring resolves — the import path TerminalSessionView
// uses for the emulator (and the transport) must point at files that actually exist.
// It fails the moment the emulator is moved or the path is broken again, without
// needing a Svelte runtime (the UI unit harness is node-only).

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_VIEW = resolve(HERE, "TerminalSessionView.svelte");

function importedPaths(source: string): string[] {
  // Capture every `import ... from "<path>"` / `import("<path>")` specifier.
  const out: string[] = [];
  const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

// Resolve a relative .svelte/.ts import specifier (with or without extension)
// to an on-disk file, mirroring how the bundler resolves it.
function resolvesOnDisk(fromFile: string, spec: string): boolean {
  if (!spec.startsWith(".")) return true; // bare/alias — not our concern here
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base];
  if (base.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"));
  else candidates.push(`${base}.ts`, `${base}.svelte`, `${base}/index.ts`);
  return candidates.some((c) => existsSync(c));
}

describe("TerminalSessionView wiring (#673)", () => {
  const source = readFileSync(SESSION_VIEW, "utf8");
  const specs = importedPaths(source);

  it("imports the emulator TerminalView from a path that EXISTS on disk", () => {
    const terminalViewSpec = specs.find((s) => /(^|\/)TerminalView(\.svelte)?$/.test(s));
    expect(terminalViewSpec, "TerminalSessionView must import TerminalView").toBeTruthy();
    expect(
      resolvesOnDisk(SESSION_VIEW, terminalViewSpec!),
      `TerminalView import "${terminalViewSpec}" does not resolve to a file — the #673 empty-render bug`,
    ).toBe(true);
  });

  it("imports relayTerminalTransport from a resolvable module", () => {
    const transportSpec = specs.find((s) => /terminal-transport/.test(s));
    expect(transportSpec, "TerminalSessionView must wire the relay transport").toBeTruthy();
    expect(resolvesOnDisk(SESSION_VIEW, transportSpec!)).toBe(true);
  });

  it("does NOT silently lazy-glob a sibling path that can no-match (the original bug)", () => {
    // The bug was import.meta.glob("./TerminalView.svelte") matching nothing.
    // A static import (or a glob pointed at the real ../terminal path) is the fix;
    // a bare "./TerminalView.svelte" glob must not reappear.
    expect(source.includes('glob("./TerminalView.svelte")')).toBe(false);
  });
});

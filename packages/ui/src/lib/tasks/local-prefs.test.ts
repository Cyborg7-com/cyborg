// Unit tests for the per-(workspace, project) localStorage helpers. The node-env
// vitest pass has no DOM, so each test that needs storage installs a minimal
// Map-backed localStorage on globalThis; the SSR-safety test runs with it absent.
import { afterEach, describe, expect, it } from "vitest";
import {
  readPagesCollapsed,
  readProjectView,
  writePagesCollapsed,
  writeProjectView,
} from "./local-prefs.js";

// Minimal localStorage stand-in — only the methods the helper touches.
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  return map;
}

function uninstallStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

afterEach(uninstallStorage);

describe("local-prefs SSR / no-window safety", () => {
  it("returns defaults and never throws when localStorage is absent", () => {
    uninstallStorage();
    expect(readPagesCollapsed("w", "p")).toEqual([]);
    expect(readProjectView("w", "p")).toEqual({});
    expect(() => writePagesCollapsed("w", "p", ["a"])).not.toThrow();
    expect(() => writeProjectView("w", "p", { layout: "gantt" })).not.toThrow();
  });
});

describe("pages collapsed set", () => {
  it("round-trips the collapsed ids", () => {
    installStorage();
    writePagesCollapsed("w1", "p1", new Set(["a", "b"]));
    expect(readPagesCollapsed("w1", "p1").sort()).toEqual(["a", "b"]);
  });

  it("defaults to empty (all expanded) when nothing stored", () => {
    installStorage();
    expect(readPagesCollapsed("w1", "p1")).toEqual([]);
  });

  it("keys per workspace+project so projects don't clobber each other", () => {
    installStorage();
    writePagesCollapsed("w1", "p1", ["a"]);
    writePagesCollapsed("w1", "p2", ["b"]);
    expect(readPagesCollapsed("w1", "p1")).toEqual(["a"]);
    expect(readPagesCollapsed("w1", "p2")).toEqual(["b"]);
  });

  it("drops non-string and corrupt entries", () => {
    const map = installStorage();
    const key = "cyborg7-pages-collapsed:w1:p1";
    map.set(key, JSON.stringify(["a", 1, null, "b"]));
    expect(readPagesCollapsed("w1", "p1")).toEqual(["a", "b"]);
    map.set(key, "{not json");
    expect(readPagesCollapsed("w1", "p1")).toEqual([]);
    map.set(key, JSON.stringify({ not: "an array" }));
    expect(readPagesCollapsed("w1", "p1")).toEqual([]);
  });
});

describe("project view (layout + group-by)", () => {
  it("round-trips a valid view", () => {
    installStorage();
    writeProjectView("w1", "p1", { layout: "gantt", groupBy: "priority" });
    expect(readProjectView("w1", "p1")).toEqual({ layout: "gantt", groupBy: "priority" });
  });

  it("keys per workspace+project", () => {
    installStorage();
    writeProjectView("w1", "p1", { layout: "list" });
    writeProjectView("w2", "p1", { layout: "calendar" });
    expect(readProjectView("w1", "p1")).toEqual({ layout: "list" });
    expect(readProjectView("w2", "p1")).toEqual({ layout: "calendar" });
  });

  it("ignores invalid layout / group-by values", () => {
    const map = installStorage();
    map.set("cyborg7-tasks-view:w1:p1", JSON.stringify({ layout: "nope", groupBy: "bogus" }));
    expect(readProjectView("w1", "p1")).toEqual({});
  });

  it("returns the valid half when only one field is bad", () => {
    const map = installStorage();
    map.set("cyborg7-tasks-view:w1:p1", JSON.stringify({ layout: "board", groupBy: "x" }));
    expect(readProjectView("w1", "p1")).toEqual({ layout: "board" });
  });

  it("returns {} on corrupt JSON or empty store", () => {
    const map = installStorage();
    expect(readProjectView("w1", "p1")).toEqual({});
    map.set("cyborg7-tasks-view:w1:p1", "{broken");
    expect(readProjectView("w1", "p1")).toEqual({});
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression guard for the "Couldn't copy image" desktop bug: the desktop relied
// SOLELY on the web ClipboardItem path, which is fragile in the Electron shell.
// `copyImageToClipboard` is now the ONE routing point — Electron → native
// main-process IPC, web → ClipboardItem — and iOS keeps its own native path
// gated at the callers. These tests pin each route so it can't silently drift.

// `isDesktopApp` is the routing switch; mock it per test. The module also
// imports the real ClipboardItem/navigator paths, exercised via globals below.
const isDesktopApp = vi.fn<() => boolean>();
vi.mock("$lib/utils.js", () => ({ isDesktopApp: () => isDesktopApp() }));

import { copyImageToClipboard, copyImageToClipboardNativeDesktop } from "./clipboard.js";

interface Win {
  cyborg7Desktop?: { invoke: ReturnType<typeof vi.fn> };
}

// Minimal ClipboardItem stub — the web path only needs the global to exist and
// be `new`-able with a data record. A named class with a field (not an empty
// class) satisfies the lint rules.
class FakeClipboardItem {
  data: Record<string, unknown>;
  constructor(data: Record<string, unknown> = {}) {
    this.data = data;
  }
}

beforeEach(() => {
  isDesktopApp.mockReset();
  vi.restoreAllMocks();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
});

describe("copyImageToClipboard routing", () => {
  it("Electron desktop → native IPC (copy_image_to_clipboard), NOT the web ClipboardItem path", async () => {
    isDesktopApp.mockReturnValue(true);
    const invoke = vi.fn().mockResolvedValue({ copied: true });
    (globalThis as unknown as { window: Win }).window = { cyborg7Desktop: { invoke } };
    // Web path must NOT be touched on desktop — if it were, this would throw.
    const clipboardWrite = vi.fn();
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write: clipboardWrite } });

    await expect(copyImageToClipboard("https://cdn.example/a.png")).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith("copy_image_to_clipboard", {
      url: "https://cdn.example/a.png",
    });
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it("Electron desktop → throws when the native copy reports failure (preserves throw-on-failure contract)", async () => {
    isDesktopApp.mockReturnValue(true);
    const invoke = vi.fn().mockResolvedValue({ copied: false });
    (globalThis as unknown as { window: Win }).window = { cyborg7Desktop: { invoke } };

    await expect(copyImageToClipboard("https://cdn.example/a.png")).rejects.toThrow();
  });

  it("web (non-desktop) → uses navigator.clipboard.write([ClipboardItem]), NOT the native IPC", async () => {
    isDesktopApp.mockReturnValue(false);
    const invoke = vi.fn();
    (globalThis as unknown as { window: Win }).window = { cyborg7Desktop: { invoke } };

    const items: unknown[] = [];
    const clipboardWrite = vi.fn().mockImplementation((arr: unknown[]) => {
      items.push(...arr);
      return Promise.resolve();
    });
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    vi.stubGlobal("navigator", { clipboard: { write: clipboardWrite } });
    // Already-PNG blob so no canvas re-encode is needed in the node env.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ blob: () => Promise.resolve({ type: "image/png" }) }),
    );

    await expect(copyImageToClipboard("https://cdn.example/a.png")).resolves.toBeUndefined();

    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("web → throws when the ClipboardItem API is unavailable", async () => {
    isDesktopApp.mockReturnValue(false);
    (globalThis as unknown as { window: Win }).window = {};
    // No ClipboardItem global, no navigator.clipboard.write.
    vi.stubGlobal("navigator", {});

    await expect(copyImageToClipboard("https://cdn.example/a.png")).rejects.toThrow(
      /Clipboard image API unavailable/,
    );
  });
});

describe("copyImageToClipboardNativeDesktop", () => {
  it("returns false (no throw) when the desktop bridge is absent", async () => {
    (globalThis as unknown as { window: Win }).window = {};
    await expect(copyImageToClipboardNativeDesktop("https://x/a.png")).resolves.toBe(false);
  });

  it("returns true when main reports { copied: true }", async () => {
    const invoke = vi.fn().mockResolvedValue({ copied: true });
    (globalThis as unknown as { window: Win }).window = { cyborg7Desktop: { invoke } };
    await expect(copyImageToClipboardNativeDesktop("https://x/a.png")).resolves.toBe(true);
  });

  it("returns false (swallows) when the IPC throws", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("boom"));
    (globalThis as unknown as { window: Win }).window = { cyborg7Desktop: { invoke } };
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(copyImageToClipboardNativeDesktop("https://x/a.png")).resolves.toBe(false);
  });
});

describe("a failing desktop copy logs the real error (behavior, not source-parsing)", () => {
  it("console.errors when the native IPC rejects", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("boom"));
    (globalThis as unknown as { window: Win }).window = { cyborg7Desktop: { invoke } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(copyImageToClipboardNativeDesktop("https://x/a.png")).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[0]).toContain("copy_image_to_clipboard failed");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { nativeSaveNoun, saveResultLabel } from "./image-actions.js";

// #537: the image-action layer (save/copy + state machine + native gate) was
// hand-duplicated across ImagePreviewModal + ImageViewerModal and had drifted
// (the viewer skipped the Android native save; the two showed different result
// copy). It now lives in one composable (image-actions.svelte.ts) backed by
// these pure helpers. The composable uses Svelte runes (not importable in this
// plain-node vitest), so we unit-test the pure label/gate logic + assert (via a
// source contract) that both modals consume the shared layer and no longer
// hand-roll the state machine.

describe("nativeSaveNoun", () => {
  it("is Photos on iOS, gallery elsewhere (Android)", () => {
    expect(nativeSaveNoun(true)).toBe("Photos");
    expect(nativeSaveNoun(false)).toBe("gallery");
  });
});

describe("saveResultLabel — unified copy for both modals", () => {
  it("saved → 'Saved to <noun>'", () => {
    expect(saveResultLabel("saved", "Photos")).toBe("Saved to Photos");
    expect(saveResultLabel("saved", "gallery")).toBe("Saved to gallery");
  });
  it('failed → "Couldn\'t save"', () => {
    expect(saveResultLabel("failed", "Photos")).toBe("Couldn't save");
  });
  it("null → empty (nothing shown)", () => {
    expect(saveResultLabel(null, "Photos")).toBe("");
  });
});

describe("both image modals consume the shared layer (source contract)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const components = resolve(here, "../components/message");
  const read = (f: string) => readFileSync(resolve(components, f), "utf8");

  for (const file of ["ImagePreviewModal.svelte", "ImageViewerModal.svelte"]) {
    it(`${file} imports + calls createImageActions`, () => {
      const src = read(file);
      expect(src).toMatch(/import \{ createImageActions \} from/);
      expect(src).toContain("createImageActions(() => image)");
    });

    it(`${file} no longer hand-rolls the save state machine`, () => {
      const src = read(file);
      // The old local copies — gone now that the composable owns them.
      expect(src).not.toContain("saveImageToPhotos");
      expect(src).not.toContain("let saveResult");
      expect(src).not.toContain("saveResultTimer");
    });
  }
});

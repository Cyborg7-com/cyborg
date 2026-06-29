import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// #531: the channel "#" glyph was inlined (as the stroked `M3 6h10…` SVG) across
// list rows, search, switcher and browse. It now lives in <ChannelGlyph kind="hash">.
// Components are .svelte (not importable in this plain-node vitest), so this is a
// contract guard: (a) ChannelGlyph owns the hash path + exposes the API, and
// (b) the path appears in NO other component (0 inline) while every converted
// surface imports + uses ChannelGlyph.

const lib = dirname(fileURLToPath(import.meta.url));
const components = resolve(lib, "components");
const read = (rel: string) => readFileSync(resolve(components, rel), "utf8");

const HASH_PATH = "M3 6h10M3 10h10M6.5 3L5 13M11 3L9.5 13";

const SURFACES = [
  "channel/BrowseChannelsModal.svelte",
  "channel/MessageSearch.svelte",
  "channel/ConversationRow.svelte",
  "channel/ChannelSidebar.svelte",
  "MobileSearchOverlay.svelte",
  "QuickSwitcher.svelte",
];

describe("ChannelGlyph hash glyph (contract)", () => {
  it("ChannelGlyph owns the hash path and exposes kind=hash + strokeWidth", () => {
    const src = read("channel/ChannelGlyph.svelte");
    expect(src).toContain(HASH_PATH);
    expect(src).toMatch(/kind === "hash"/);
    expect(src).toContain("strokeWidth");
  });

  it("the inline hash SVG path lives in NO surface (0 inline)", () => {
    for (const rel of SURFACES) {
      expect(read(rel)).not.toContain(HASH_PATH);
    }
  });

  it("every converted surface imports + uses ChannelGlyph", () => {
    for (const rel of SURFACES) {
      const src = read(rel);
      expect(src).toMatch(/import ChannelGlyph from ["'].*ChannelGlyph\.svelte["']/);
      expect(src).toContain('<ChannelGlyph kind="hash"');
    }
  });
});

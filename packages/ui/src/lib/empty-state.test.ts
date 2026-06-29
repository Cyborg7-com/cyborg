import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// #526: every "nothing here" surface routes through the shared <EmptyState>
// primitive instead of hand-rolling a centered icon/title/subtitle scaffold.
// The component is a .svelte file (not importable in this plain-node vitest), so
// this is a CONTRACT guard: (a) EmptyState exposes the shared API + a11y role,
// and (b) each converted surface imports it and no longer hand-rolls the
// centered-empty scaffold. A future edit re-introducing inline empty markup
// fails here instead of silently re-duplicating.

const here = dirname(fileURLToPath(import.meta.url));
const lib = resolve(here, ".");
const read = (rel: string) => readFileSync(resolve(lib, rel), "utf8");

describe("EmptyState primitive (app contract)", () => {
  const src = read("components/EmptyState.svelte");

  it("renders one centered container (no live-region role — it can hold an action)", () => {
    expect(src).toContain("flex flex-col items-center justify-center text-center");
    // role="status" would wrap the interactive action button → ARIA anti-pattern.
    expect(src).not.toMatch(/role="status"/);
  });

  it("exposes the flexible API the panes rely on", () => {
    for (const prop of ["iconWrap", "noIcon", "titleClass", "descriptionClass"]) {
      expect(src).toContain(prop);
    }
  });
});

describe("empty-state surfaces route through <EmptyState>", () => {
  const surfaces = [
    "components/panes/ActivityPane.svelte",
    "components/panes/LogsPane.svelte",
    "components/panes/MemoryPane.svelte",
    "components/panes/SkillsPane.svelte",
    "components/channel/ChannelDetailsDialog.svelte",
    "components/channel/PinnedPanel.svelte",
  ];

  for (const rel of surfaces) {
    it(`${rel} imports + uses EmptyState`, () => {
      const src = read(rel);
      expect(src).toMatch(/import EmptyState from ["'].*EmptyState\.svelte["']/);
      expect(src).toContain("<EmptyState");
    });
  }
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Regression guard for #491: mobile-reachable controls keep a ≥44px effective
// tap target. The visual sizing is CSS (no DOM harness), so this asserts (a) the
// app.css util CONTRACT — the 44px minimum is enforced under the mobile media
// query and a no-op on desktop — and (b) each control patched in this PR still
// references one of the touch utilities. A future edit dropping the class fails
// here instead of silently shipping a sub-44 target.

const here = dirname(fileURLToPath(import.meta.url));
const ui = resolve(here, "..");
const read = (rel: string) => readFileSync(resolve(ui, rel), "utf8");

describe("touch-target utilities (app.css contract)", () => {
  const css = read("app.css");

  it("enforces 44px min on .touch-target ONLY under the mobile media query (desktop untouched)", () => {
    // The 44px rule lives inside `@media (pointer: coarse), (max-width: 640px)`.
    const mq = css.slice(css.indexOf("@media (pointer: coarse), (max-width: 640px)"));
    expect(mq).toMatch(/\.touch-target\s*\{[^}]*min-height:\s*44px/);
    expect(mq).toMatch(/\.touch-target\s*\{[^}]*min-width:\s*44px/);
    // Full-width rows only lift height (min-width would break their flex layout).
    expect(mq).toMatch(/\.touch-target-row\s*\{[^}]*min-height:\s*44px/);
  });

  it("tap-expand adds an invisible 44px ::after hit area on mobile, keeping the visual box", () => {
    // Guarded so it never overrides an element's own absolute/fixed/sticky.
    expect(css).toMatch(/\.tap-expand:not\(\.absolute\)[^{]*\{[^}]*position:\s*relative/);
    const mq = css.slice(css.lastIndexOf("@media (pointer: coarse), (max-width: 640px)"));
    expect(mq).toMatch(/\.tap-expand::after\s*\{[\s\S]*?width:\s*44px/);
    expect(mq).toMatch(/\.tap-expand::after\s*\{[\s\S]*?height:\s*44px/);
  });
});

describe("mobile-reachable controls reference a touch utility", () => {
  const cases: Array<[string, string]> = [
    ["components/MobileTopBar.svelte", "touch-target"],
    ["components/ProfileMenu.svelte", "touch-target"],
    ["components/IapPaywall.svelte", "touch-target"],
    ["components/SetStatusModal.svelte", "touch-target"],
    ["components/channel/ChannelHeader.svelte", "touch-target"],
    ["components/message/VoicePlayer.svelte", "touch-target"],
    ["components/message/MessageInput.svelte", "touch-target"],
    ["components/composer/ComposerToolbar.svelte", "touch-target"],
    ["components/composer/ComposerVoiceRecorder.svelte", "touch-target"],
    ["components/composer/EmojiPicker.svelte", "touch-target"],
    ["components/composer/ComposerAttachments.svelte", "tap-expand"],
    ["components/settings/SettingsNav.svelte", "touch-target-row"],
    ["components/daemon/DaemonSidebar.svelte", "touch-target-row"],
  ];
  for (const [rel, cls] of cases) {
    it(`${rel} uses ${cls}`, () => {
      expect(read(`lib/${rel}`)).toContain(cls);
    });
  }
});

import { expect, test } from "./helpers/fixtures.js";

// Covers the fix/ui-dialog-trial-channels changes:
// 1. TrialBar can be dismissed per-workspace (settings.trialDismissed jsonb).
// 2. "Add channels" (Slack-style) menu replaces the fake "Browse channels" row.
test.describe("trial bar + channel sidebar", () => {
  test("dismissing the trial bar hides it, and Add channels opens the menu", async ({
    page,
    loginAs,
  }) => {
    test.setTimeout(60_000);
    await loginAs(page, "trial@e2e.dev", "Trial Tester");

    // Reach the channel view. The post-login flow genuinely branches (workspace
    // picker and/or first-run onboarding may or may not appear), so each branch
    // is awaited with a short visibility probe rather than a fixed sleep.
    const wsCard = page.getByText("My Workspace", { exact: true }).first();
    if (await wsCard.isVisible({ timeout: 4000 }).catch(() => false)) {
      await wsCard.click();
    }
    const skip = page.getByText("Skip for now").first();
    if (await skip.isVisible({ timeout: 4000 }).catch(() => false)) {
      await skip.click();
      const wsCard2 = page.getByText("My Workspace", { exact: true }).first();
      if (await wsCard2.isVisible({ timeout: 4000 }).catch(() => false)) {
        await wsCard2.click();
      }
    }
    await page.getByText("Chat", { exact: true }).first().click();
    // Positive anchor: the sidebar's channel list is rendered.
    await expect(page.getByText("#", { exact: true }).first()).toBeVisible({ timeout: 10_000 });

    // ── Add channels menu (sidebar) ──
    await page.getByText("Add channels", { exact: true }).click();
    await expect(page.getByText("Create a new channel")).toBeVisible();
    await expect(page.getByText("Browse channels")).toBeVisible();
    await page.keyboard.press("Escape");

    // ── Trial bar dismiss persists via workspace settings ──
    const trialText = page.getByText("You're on a free trial");
    await expect(trialText).toBeVisible();
    await page.getByRole("button", { name: "Dismiss trial bar" }).click();
    await expect(trialText).toBeHidden({ timeout: 10_000 });

    // Survives a reload (flag persisted in workspaces.settings, not local state).
    // Anchor on the app being fully re-rendered FIRST — asserting toBeHidden on a
    // still-blank page would pass vacuously before hydration.
    await page.reload();
    await expect(page.getByText("Add channels", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("You're on a free trial")).toBeHidden();
  });
});

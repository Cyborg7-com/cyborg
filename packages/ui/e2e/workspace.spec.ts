import { test, expect } from "./helpers/fixtures.ts";

test.describe("Workspace flow", () => {
  test("auto-creates workspace and shows workspace list", async ({ page, loginAs }) => {
    await loginAs(page, "ws@e2e.dev", "WS Tester");
    await expect(page.locator("h1")).toContainText("Your Workspaces");
    await expect(page.locator("button").filter({ hasText: "My Workspace" })).toBeVisible();
  });

  test("selecting workspace navigates to workspace view with sidebar", async ({
    page,
    loginAs,
  }) => {
    await loginAs(page, "nav@e2e.dev", "Nav Tester");
    const wsButton = page.locator("button").filter({ hasText: "My Workspace" });
    await wsButton.click();
    await page.waitForURL(/\/workspace\//, { timeout: 10_000 });

    await expect(page.locator("aside")).toBeVisible();
    await expect(page.locator("aside h2")).toContainText("My Workspace");
  });

  test("workspace view shows default #general channel in sidebar", async ({ page, loginAs }) => {
    await loginAs(page, "chan@e2e.dev", "Chan Tester");
    await page.locator("button").filter({ hasText: "My Workspace" }).click();
    await page.waitForURL(/\/workspace\//, { timeout: 10_000 });

    const channelButton = page.locator("aside button", { hasText: "general" });
    await expect(channelButton).toBeVisible({ timeout: 10_000 });
  });

  test("channel view shows empty state message", async ({ page, loginAs }) => {
    await loginAs(page, "empty@e2e.dev", "Empty Tester");
    await page.locator("button").filter({ hasText: "My Workspace" }).click();
    await page.waitForURL(/\/workspace\//, { timeout: 10_000 });

    await expect(page.getByText("No messages yet. Start the conversation.")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("sending a message shows it in the message list", async ({ page, loginAs }) => {
    await loginAs(page, "msg@e2e.dev", "Msg Tester");
    await page.locator("button").filter({ hasText: "My Workspace" }).click();
    await page.waitForURL(/\/workspace\//, { timeout: 10_000 });

    await expect(page.getByText("No messages yet. Start the conversation.")).toBeVisible({
      timeout: 10_000,
    });

    const textarea = page.locator("textarea");
    await textarea.fill("Hello from Playwright!");
    await page.locator("button", { hasText: "Send" }).click();

    await expect(page.getByText("Hello from Playwright!")).toBeVisible({ timeout: 10_000 });
  });
});
